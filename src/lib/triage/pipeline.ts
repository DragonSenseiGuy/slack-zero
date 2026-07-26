import { prisma } from '@/lib/db';
import {
  createRateLimiter,
  runPooled,
  withRateLimitRetry,
  type RateLimiter,
} from '@/lib/llm/ratelimit';
import { contextLabelFor, HIDDEN_SUBTYPES, type QueueUser } from '@/lib/queue/queue';
import { renderSlackText, type LabelLookup } from '@/lib/queue/text';
import { getInstallation } from '@/lib/slack/installation';
import { classifyMessage, type ClassificationResult } from '@/lib/triage/classify';
import {
  PREVIOUS_MESSAGE_WINDOW,
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

  const hidden = [...HIDDEN_SUBTYPES];

  const rows = await prisma.message.findMany({
    where: {
      isDeleted: false,
      classification: { is: null },
      AND: [
        { OR: [{ subtype: null }, { subtype: { notIn: hidden } }] },
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
  const [users, conversations, installation] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        username: true,
        realName: true,
        displayName: true,
        avatarUrl: true,
        isBot: true,
        isVip: true,
      },
    }),
    prisma.conversation.findMany({ select: { id: true, name: true } }),
    authedUserId === undefined ? getInstallation() : Promise.resolve(null),
  ]);

  const userMap = new Map<string, QueueUser>(users.map((user) => [user.id, user]));

  const userLabels = new Map<string, string>();
  for (const user of users) {
    const label = user.displayName || user.realName || user.username;
    if (label) userLabels.set(user.id, label);
  }

  const channelLabels = new Map<string, string>();
  for (const conversation of conversations) {
    if (conversation.name) channelLabels.set(conversation.id, conversation.name);
  }

  return {
    users: userMap,
    labels: { users: userLabels, channels: channelLabels },
    authedUserId:
      authedUserId === undefined
        ? (installation?.authedUserId ?? null)
        : authedUserId,
  };
}

function senderLabel(
  userId: string | null,
  authorName: string | null,
  botId: string | null,
  users: ReadonlyMap<string, QueueUser>,
): string {
  const user = userId ? users.get(userId) : undefined;
  const fromDirectory = user
    ? user.displayName || user.realName || user.username || user.id
    : null;
  if (fromDirectory) return fromDirectory;
  if (authorName) return authorName;
  if (userId) return userId;
  if (botId) return `Bot ${botId}`;
  return 'Unknown sender';
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
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      conversationId: true,
      ts: true,
      sentAt: true,
      threadTs: true,
      isThreadReply: true,
      userId: true,
      authorName: true,
      botId: true,
      text: true,
      mentionedUserIds: true,
      conversation: {
        select: { id: true, kind: true, name: true, peerUserId: true },
      },
    },
  });

  if (!message || message.text.trim() === '') return null;

  // Earlier messages from the *same sender*, so a chase can be matched to the
  // ask it chases. Scoped to the thread when there is one: a follow-up inside a
  // thread is about that thread, not about whatever else was said in the
  // channel.
  const previousRows = await prisma.message.findMany({
    where: {
      conversationId: message.conversationId,
      isDeleted: false,
      ts: { lt: message.ts },
      ...(message.userId ? { userId: message.userId } : {}),
      ...(message.threadTs ? { threadTs: message.threadTs } : {}),
    },
    orderBy: [{ sentAt: 'desc' }, { ts: 'desc' }],
    take: PREVIOUS_MESSAGE_WINDOW,
    select: { id: true, text: true, sentAt: true },
  });

  const previous: PromptPreviousMessage[] = previousRows
    .slice()
    .reverse()
    .map((row) => ({
      id: row.id,
      text: renderSlackText(row.text, lookup.labels),
      sentAtIso: row.sentAt.toISOString(),
    }));

  const kind = message.conversation.kind;

  return {
    text: renderSlackText(message.text, lookup.labels),
    senderLabel: senderLabel(
      message.userId,
      message.authorName,
      message.botId,
      lookup.users,
    ),
    contextLabel: contextLabelFor(message.conversation, lookup.users),
    isDirectMessage: kind === 'IM' || kind === 'MPIM',
    mentionsMe:
      lookup.authedUserId !== null &&
      message.mentionedUserIds.includes(lookup.authedUserId),
    isThreadReply: message.isThreadReply,
    sentAtIso: message.sentAt.toISOString(),
    nowIso: now.toISOString(),
    previous,
  };
}

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

export async function saveClassification(
  messageId: string,
  result: ClassificationResult,
): Promise<void> {
  const data = {
    urgencyScore: result.urgencyScore,
    category: toDbCategory(result.category),
    isBump: result.isBump,
    bumpOfMessageId: result.bumpOfMessageId,
    reason: result.reason,
    model: result.model,
  };

  await prisma.classification.upsert({
    where: { messageId },
    create: { messageId, ...data },
    update: data,
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

  await saveClassification(messageId, result);
  return result;
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
    const error = describeError(outcome.error);
    summary.failed += 1;
    summary.failures.push({ messageId, error });
    onProgress?.({ kind: 'failed', messageId, error });
  });

  return summary;
}
