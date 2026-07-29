import type { IngestSource } from '@prisma/client';

import { prisma } from '@/lib/db';
import type {
  NormalizedConversation,
  NormalizedMessage,
  NormalizedReaction,
  NormalizedUser,
} from '@/lib/slack/normalize';
import { isNonContentMessage, parseSlackTs } from '@/lib/slack/normalize';
import { messageCacheKey, slackMessageCache } from '@/lib/slack/cache';

export type UpsertOutcome = 'created' | 'updated';

/**
 * Prisma distinguishes JSON `null` from SQL `NULL`; we always want the latter
 * for "Slack sent nothing here", so absence stays absence.
 */
// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function upsertUser(user: NormalizedUser): Promise<UpsertOutcome> {
  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { id: true },
  });

  if (existing) {
    return 'updated';
  }

  await prisma.user.create({ data: { id: user.id } });
  return 'created';
}

/**
 * Guarantee a `User` row exists for `userId` so a message can reference it.
 *
 * Needed because message authors are not always in `users.list`: Slack Connect
 * guests, deactivated accounts, and users added since the last backfill all
 * show up as authors first. A stub row (id only) is created and left for the
 * next `users.list` pass to fill in — dropping the message instead would put a
 * hole in the queue.
 */
async function ensureUserExists(userId: string): Promise<void> {
  await prisma.user.upsert({
    where: { id: userId },
    create: { id: userId },
    update: {},
  });
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function upsertConversation(
  conversation: NormalizedConversation,
): Promise<UpsertOutcome> {
  const existing = await prisma.conversation.findUnique({
    where: { id: conversation.id },
    select: { id: true },
  });

  const data = { kind: conversation.kind, peerUserId: conversation.peerUserId };

  if (existing) {
    await prisma.conversation.update({ where: { id: conversation.id }, data });
    return 'updated';
  }

  await prisma.conversation.create({ data: { id: conversation.id, ...data } });
  return 'created';
}

/**
 * Create a `Conversation` from a *reference* to it — a `search.messages` hit,
 * or a live event in a channel we have not listed — without touching a row
 * that already exists.
 *
 * The distinction from `upsertConversation` matters: `conversations.list` is
 * the authority for metadata, and the channel object embedded in a search
 * result is much thinner (no `is_member`, no `is_archived`, no topic). Letting
 * a mention hit take the normal upsert path silently downgraded
 * `isMember: true` to `false` on every channel the authed user was mentioned
 * in.
 */
export async function ensureConversationFromReference(
  conversation: NormalizedConversation,
): Promise<UpsertOutcome> {
  const existing = await prisma.conversation.findUnique({
    where: { id: conversation.id },
    select: { id: true },
  });

  if (existing) return 'updated';

  await prisma.conversation.create({
    data: {
      id: conversation.id,
      kind: conversation.kind,
      peerUserId: conversation.peerUserId,
    },
  });
  return 'created';
}

/** Stamp a successful history read, so gaps are visible in the data. */
export async function markConversationSynced(
  conversationId: string,
  at: Date = new Date(),
): Promise<void> {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastSyncedAt: at },
  });
}

/**
 * Minimal `Conversation` row for a channel we learned about from a message
 * rather than from `conversations.list` (a mention search hit, or a live event
 * in a channel joined since the last backfill). `kind` is inferred from the id
 * prefix by the caller's normalization.
 */
async function ensureConversationExists(
  conversationId: string,
  kind: NormalizedConversation['kind'],
): Promise<void> {
  await prisma.conversation.upsert({
    where: { id: conversationId },
    create: { id: conversationId, kind },
    update: {},
  });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Infer a conversation kind from the Slack id prefix alone. */
function kindFromId(conversationId: string): NormalizedConversation['kind'] {
  switch (conversationId[0]) {
    case 'D':
      return 'IM';
    case 'C':
      return 'PUBLIC_CHANNEL';
    case 'G':
      return 'PRIVATE_CHANNEL';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Insert or refresh one message, keyed on `(conversationId, ts)`.
 *
 * Deliberately *not* a blind `update`: `isDeleted`/`deletedAt` are ours, not
 * Slack's, so a re-ingest of a message we already know was deleted must not
 * resurrect it.
 */
export async function upsertMessage(
  message: NormalizedMessage,
  source: IngestSource = 'BACKFILL',
  authedUserId?: string | null,
  options: { clearClassification?: boolean } = {},
): Promise<UpsertOutcome> {
  await ensureConversationExists(
    message.conversationId,
    kindFromId(message.conversationId),
  );
  if (message.userId) {
    await ensureUserExists(message.userId);
  }

  const data = {
    sentAt: message.sentAt,
    threadTs: message.threadTs,
    userId: message.userId,
    isContent: !isNonContentMessage(message),
    mentionsAuthedUser:
      Boolean(authedUserId) && message.mentionedUserIds.includes(authedUserId!),
  };

  const existing = await prisma.message.findUnique({
    where: {
      conversationId_ts: {
        conversationId: message.conversationId,
        ts: message.ts,
      },
    },
    select: { id: true },
  });

  if (existing) {
    // `source` is deliberately absent from the update: it records how we
    // *first* saw a message. A later backfill re-reading a message that
    // arrived live would otherwise flip it EVENT -> BACKFILL and erase the
    // evidence that the Socket Mode path ever worked.
    if (options.clearClassification) {
      const key = messageCacheKey(message.conversationId, message.ts);
      slackMessageCache.delete(key);
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Message" WHERE id = ${existing.id} FOR UPDATE`;
        await tx.message.update({ where: { id: existing.id }, data });
        await tx.classification.deleteMany({ where: { messageId: existing.id } });
      });
      slackMessageCache.delete(key);
    } else {
      await prisma.message.update({ where: { id: existing.id }, data });
    }
    return 'updated';
  }

  await prisma.message.create({
    data: {
      conversationId: message.conversationId,
      ts: message.ts,
      source,
      ...data,
    },
  });
  return 'created';
}

/**
 * Soft-delete a message. The row survives so any classification or triage
 * state attached to it is not orphaned; the queue filters on `isDeleted`.
 *
 * Returns false when we never had the message (a deletion for something
 * outside our backfill window is normal, not an error).
 */
export async function markMessageDeleted(
  conversationId: string,
  ts: string,
  deletedAt: Date = new Date(),
): Promise<boolean> {
  slackMessageCache.delete(messageCacheKey(conversationId, ts));
  const existed = await prisma.$transaction(async (tx) => {
    await tx.conversation.upsert({
      where: { id: conversationId },
      create: { id: conversationId, kind: kindFromId(conversationId) },
      update: {},
    });
    const prior = await tx.message.findUnique({
      where: { conversationId_ts: { conversationId, ts } },
      select: { id: true, isDeleted: true },
    });
    const message = await tx.message.upsert({
      where: { conversationId_ts: { conversationId, ts } },
      create: { conversationId, ts, sentAt: parseSlackTs(ts), source: 'EVENT', isDeleted: true, deletedAt },
      update: { isDeleted: true, deletedAt },
      select: { id: true },
    });
    await tx.$queryRaw`SELECT id FROM "Message" WHERE id = ${message.id} FOR UPDATE`;
    await tx.classification.deleteMany({ where: { messageId: message.id } });
    await tx.messageState.updateMany({
      where: { messageId: message.id },
      data: { isWaitingOn: false, waitingOnSince: null },
    });
    return Boolean(prior && !prior.isDeleted);
  });
  // A fetch that began before the tombstone may have populated the cache
  // while the transaction waited. Evict again after commit.
  slackMessageCache.delete(messageCacheKey(conversationId, ts));
  return existed;
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * Apply a `reaction_added`/`reaction_removed` delta to a stored message.
 *
 * Pure so it can be unit tested; `applyReactionEvent` below does the IO.
 */
export function mergeReaction(
  current: NormalizedReaction[] | null,
  change: { name: string; userId: string; added: boolean },
): NormalizedReaction[] | null {
  const next = (current ?? []).map((reaction) => ({
    ...reaction,
    userIds: [...reaction.userIds],
  }));

  const existing = next.find((reaction) => reaction.name === change.name);

  if (change.added) {
    if (!existing) {
      next.push({ name: change.name, count: 1, userIds: [change.userId] });
    } else if (!existing.userIds.includes(change.userId)) {
      existing.userIds.push(change.userId);
      existing.count = existing.userIds.length;
    }
    // Already recorded: a duplicate delivery is a no-op, not a double count.
  } else if (existing) {
    existing.userIds = existing.userIds.filter((id) => id !== change.userId);
    existing.count = existing.userIds.length;
  }

  const pruned = next
    .filter((reaction) => reaction.count > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return pruned.length > 0 ? pruned : null;
}

/** Read-modify-write of one message's reactions. Returns false if unknown. */
export async function applyReactionEvent(change: {
  conversationId: string;
  ts: string;
  name: string;
  userId: string;
  added: boolean;
}): Promise<boolean> {
  slackMessageCache.delete(messageCacheKey(change.conversationId, change.ts));
  const message = await prisma.message.findUnique({
    where: {
      conversationId_ts: {
        conversationId: change.conversationId,
        ts: change.ts,
      },
    },
    select: { id: true },
  });

  if (!message) return false;

  return true;
}
