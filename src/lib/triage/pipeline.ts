import { prisma } from '@/lib/db';
import {
  createRateLimiter,
  runPooled,
  withRateLimitRetry,
  type RateLimiter,
} from '@/lib/llm/ratelimit';
import type { QueueUser } from '@/lib/queue/queue';
import type { LabelLookup } from '@/lib/queue/text';
import { getSlackContext } from '@/lib/slack/client';
import { hydrateConversation, hydrateExactMessage, hydrateHistory, hydrateMessageBatch, hydrateThread, hydrateUser } from '@/lib/slack/live';
import { normalizeConversation, normalizeMessage, normalizeUser, userDisplayLabel } from '@/lib/slack/normalize';
import type { RawSlackMessage } from '@/lib/slack/raw';
import { getInstallation } from '@/lib/slack/installation';
import { classifyMessage, type ClassificationResult } from '@/lib/triage/classify';
import {
  PREVIOUS_MESSAGE_WINDOW,
  looksLikeBump,
  type ClassificationContext,
  type PromptPreviousMessage,
} from '@/lib/triage/prompt';
import { toDbCategory } from '@/lib/triage/types';

/**
 * The classification pipeline: pick unclassified messages, build a prompt
 * context for each, call the model, store the result.
 *
 * Two constraints from CLAUDE.md shape everything here.
 *
 * 1. **Classification never blocks ingestion.** Nothing in `slack/ingest.ts`
 *    calls into this module. Work is picked up afterwards — by the
 *    `npm run classify` batch job, or by the fire-and-forget scheduler that the
 *    Socket Mode listener nudges once a message is already committed.
 * 2. **Stay inside the rate limit.** 450 requests / 30 minutes, 429 beyond. The
 *    limiter below is shared across a whole batch, so a backfill of thousands
 *    of messages paces itself instead of being cut off partway through with no
 *    record of where it stopped. Every message either has a stored
 *    classification or does not, so an interrupted run resumes correctly.
 */

// ---------------------------------------------------------------------------
// Selecting work
// ---------------------------------------------------------------------------

/** Default batch size. Well under the 30-minute budget for a single run. */
export const DEFAULT_BATCH_LIMIT = 200;
/** Concurrent in-flight calls. The limiter, not this, is what caps throughput. */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Ids of messages worth classifying, newest first.
 *
 * Filtered to roughly what the queue can ever show: not deleted, not
 * membership noise, not the user's own messages. Classifying a `channel_join`
 * would burn a request from a hard-capped budget to learn nothing.
 *
 * Newest first because the top of the queue is what the user is looking at; a
 * batch that runs out of budget should have classified the messages that
 * matter.
 */
export async function selectPendingMessageIds(
  options: { limit?: number; authedUserId?: string | null } = {},
): Promise<string[]> {
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const authedUserId =
    options.authedUserId === undefined
      ? ((await getInstallation())?.authedUserId ?? null)
      : options.authedUserId;
  if (authedUserId) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT m.id FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
      LEFT JOIN "Classification" cl ON cl."messageId" = m.id
      WHERE NOT m."isDeleted" AND m."isContent" AND cl."messageId" IS NULL
        AND (m."userId" IS NULL OR m."userId" <> ${authedUserId}) AND (
          c.kind IN ('IM', 'MPIM') OR m."mentionsAuthedUser" OR EXISTS (
            SELECT 1 FROM "Message" authored WHERE authored."conversationId" = m."conversationId"
              AND authored."userId" = ${authedUserId} AND NOT authored."isDeleted"
              AND COALESCE(authored."threadTs", authored.ts) = COALESCE(m."threadTs", m.ts)))
      ORDER BY m."sentAt" DESC, m.ts DESC LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  const rows = await prisma.message.findMany({
    where: {
      isDeleted: false,
      isContent: true,
      classification: { is: null },
      OR: [
        { conversation: { kind: { in: ['IM', 'MPIM'] } } },
        { mentionsAuthedUser: true },
      ],
      AND: [
        ...(authedUserId
          ? [{ OR: [{ userId: null }, { userId: { not: authedUserId } }] }]
          : []),
      ],
    },
    orderBy: [{ sentAt: 'desc' }, { ts: 'desc' }],
    take: limit,
    select: { id: true },
  });

  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Building a prompt context
// ---------------------------------------------------------------------------

/**
 * Directory data the prompt builder needs, loaded once per batch rather than
 * once per message. Small workspaces make this cheap; a big one still only pays
 * for it once.
 */
export type TriageLookup = {
  users: Map<string, QueueUser>;
  labels: LabelLookup;
  authedUserId: string | null;
};

export async function loadTriageLookup(
  authedUserId?: string | null,
): Promise<TriageLookup> {
  const installation = authedUserId === undefined ? await getInstallation() : null;
  return {
    users: new Map(),
    labels: { users: new Map(), channels: new Map() },
    authedUserId:
      authedUserId === undefined
        ? (installation?.authedUserId ?? null)
        : authedUserId,
  };
}

/**
 * Everything the model is told about one message.
 *
 * The text is rendered through `renderSlackText` first, so the model sees
 * "@adi" rather than "<@U0BK9FR4Y1M>". Raw Slack encodings would otherwise
 * leak past the ingestion boundary into the prompt, and "who is U0BK9FR4Y1M"
 * is not something a classifier should have to guess at.
 *
 * Returns null when the message is gone — a delete can land between selecting
 * a batch and working through it.
 */
export async function loadClassificationContext(
  messageId: string,
  lookup: TriageLookup,
  now: Date = new Date(),
): Promise<ClassificationContext | null> {
  const identity = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      conversationId: true,
      ts: true,
      sentAt: true,
      threadTs: true,
      userId: true,
      updatedAt: true,
      conversation: {
        select: { id: true, kind: true, peerUserId: true },
      },
    },
  });

  if (!identity) return null;
  const slack = await getSlackContext();
  const raw = await hydrateExactMessage(slack.client, identity.conversationId, identity.ts);
  if (!raw) return null;
  const message = normalizeMessage(raw, identity.conversationId);
  if (!message.text.trim()) return null;
  const bumpLike = looksLikeBump(message.text);
  const [rawUser, rawConversation, history] = await Promise.all([
    message.userId ? hydrateUser(slack.client, message.userId) : Promise.resolve(null),
    hydrateConversation(slack.client, identity.conversationId),
    !bumpLike
      ? Promise.resolve({ messages: [] })
      : identity.threadTs
      ? hydrateThread(slack.client, identity.conversationId, identity.threadTs)
      : hydrateHistory(slack.client, identity.conversationId, identity.ts, PREVIOUS_MESSAGE_WINDOW * 3),
  ]);
  const user = rawUser ? normalizeUser(rawUser) : null;
  const conversation = rawConversation ? normalizeConversation(rawConversation) : { ...identity.conversation, name: null };

  // Earlier messages from the *same sender*, so a chase can be matched to the
  // ask it chases. Scoped to the thread when there is one: a follow-up inside a
  // thread is about that thread, not about whatever else was said in the
  // channel.
  const previousRaw = ((history.messages as RawSlackMessage[] | undefined) ?? [])
    .filter((row) => Boolean(row.ts) && row.ts! < identity.ts)
    .filter((row) => !message.userId || row.user === message.userId)
    .sort((a, b) => a.ts!.localeCompare(b.ts!))
    .slice(-PREVIOUS_MESSAGE_WINDOW);
  const priorIdentities = await prisma.message.findMany({
    where: { conversationId: identity.conversationId, ts: { in: previousRaw.map((row) => row.ts!) }, isDeleted: false },
    select: { id: true, ts: true },
  });
  const idsByTs = new Map(priorIdentities.map((row) => [row.ts, row.id]));
  const previous: PromptPreviousMessage[] = previousRaw
    .filter((row) => idsByTs.has(row.ts!))
    .map((row) => ({
      id: idsByTs.get(row.ts!)!,
      text: row.text ?? '',
      sentAtIso: normalizeMessage(row, identity.conversationId).sentAt.toISOString(),
    }));
  const kind = conversation.kind;

  return {
    text: message.text,
    senderLabel: user ? userDisplayLabel(user) : message.authorName ?? 'Unknown sender',
    contextLabel: conversation.name ? `#${conversation.name}` : kind === 'IM' ? 'Direct message' : 'Group DM',
    isDirectMessage: kind === 'IM' || kind === 'MPIM',
    mentionsMe:
      lookup.authedUserId !== null &&
      message.mentionedUserIds.includes(lookup.authedUserId),
    isThreadReply: message.isThreadReply,
    sentAtIso: message.sentAt.toISOString(),
    nowIso: now.toISOString(),
    previous,
    sourceUpdatedAtIso: identity.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

export async function saveClassification(
  messageId: string,
  result: ClassificationResult,
  expectedUpdatedAt?: Date,
): Promise<boolean> {
  const data = {
    urgencyScore: result.urgencyScore,
    category: toDbCategory(result.category),
    isBump: result.isBump,
    bumpOfMessageId: result.bumpOfMessageId,
    reasonCode: result.reasonCode,
    model: result.model,
  };

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Message" WHERE id = ${messageId} FOR UPDATE`;
    const message = await tx.message.findUnique({ where: { id: messageId }, select: { isDeleted: true, updatedAt: true } });
    if (!message || message.isDeleted || (expectedUpdatedAt && message.updatedAt.getTime() !== expectedUpdatedAt.getTime())) return false;
    await tx.classification.upsert({
      where: { messageId },
      create: { messageId, ...data },
      update: data,
    });
    return true;
  });
}

// ---------------------------------------------------------------------------
// Running a batch
// ---------------------------------------------------------------------------

export type ClassifyProgress =
  | { kind: 'classified'; messageId: string; result: ClassificationResult }
  | { kind: 'skipped'; messageId: string; reason: string }
  | { kind: 'failed'; messageId: string; error: string };

export type ClassifyBatchResult = {
  attempted: number;
  classified: number;
  skipped: number;
  failed: number;
  failures: Array<{ messageId: string; error: string }>;
};

export type ClassifyBatchOptions = {
  limit?: number;
  concurrency?: number;
  /** Share one limiter across several batches to keep the budget honest. */
  rateLimiter?: RateLimiter;
  now?: Date;
  signal?: AbortSignal;
  onProgress?: (event: ClassifyProgress) => void;
};

const SAFE_CLASSIFICATION_FAILURE = 'CLASSIFICATION_FAILED';

/** Classify one already-selected message. Throws on failure. */
export async function classifyOne(
  messageId: string,
  lookup: TriageLookup,
  options: {
    now?: Date;
    rateLimiter?: RateLimiter;
    signal?: AbortSignal;
  } = {},
): Promise<ClassificationResult | null> {
  const context = await loadClassificationContext(
    messageId,
    lookup,
    options.now ?? new Date(),
  );
  if (context === null) return null;

  await options.rateLimiter?.acquire();

  const result = await withRateLimitRetry(() =>
    classifyMessage(context, { signal: options.signal }),
  );

  const expectedUpdatedAt = context.sourceUpdatedAtIso ? new Date(context.sourceUpdatedAtIso) : undefined;
  return (await saveClassification(messageId, result, expectedUpdatedAt)) ? result : null;
}

/**
 * Classify everything that has not been classified yet, up to `limit`.
 *
 * A single bad response does not poison the batch: failures are collected and
 * reported, and the message simply stays unclassified so the next run retries
 * it. That matters because `parseClassificationResponse` deliberately throws
 * rather than inventing a category.
 */
export async function classifyPendingMessages(
  options: ClassifyBatchOptions = {},
): Promise<ClassifyBatchResult> {
  const {
    limit = DEFAULT_BATCH_LIMIT,
    concurrency = DEFAULT_CONCURRENCY,
    rateLimiter = createRateLimiter(),
    now = new Date(),
    signal,
    onProgress,
  } = options;

  const lookup = await loadTriageLookup();
  const ids = await selectPendingMessageIds({
    limit,
    authedUserId: lookup.authedUserId,
  });
  if (ids.length > 0) {
    const identities = await prisma.message.findMany({
      where: { id: { in: ids }, isDeleted: false },
      select: { id: true, conversationId: true, ts: true, threadTs: true, isDeleted: true, conversation: { select: { kind: true } } },
    });
    const slack = await getSlackContext();
    await hydrateMessageBatch(slack.client, identities);
  }

  const outcomes = await runPooled(ids, concurrency, async (messageId) => {
    if (signal?.aborted) {
      return { kind: 'skipped' as const, messageId, reason: 'aborted' };
    }

    const result = await classifyOne(messageId, lookup, {
      now,
      rateLimiter,
      signal,
    });

    return result === null
      ? {
          kind: 'skipped' as const,
          messageId,
          reason: 'message is gone or has no text',
        }
      : { kind: 'classified' as const, messageId, result };
  });

  const summary: ClassifyBatchResult = {
    attempted: ids.length,
    classified: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };

  outcomes.forEach((outcome, index) => {
    if (outcome.ok) {
      if (outcome.value.kind === 'classified') summary.classified += 1;
      else summary.skipped += 1;
      onProgress?.(outcome.value);
      return;
    }

    const messageId = ids[index];
    const error = SAFE_CLASSIFICATION_FAILURE;
    summary.failed += 1;
    summary.failures.push({ messageId, error });
    onProgress?.({ kind: 'failed', messageId, error });
  });

  return summary;
}
