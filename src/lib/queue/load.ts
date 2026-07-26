import { prisma } from '@/lib/db';
import { getInstallation } from '@/lib/slack/installation';
import {
  attachThreadReplies,
  buildQueue,
  contextLabelFor,
  threadKey,
  type QueueConversation,
  type QueueItem,
  type QueueMessageRow,
  type QueueReaction,
  type QueueUser,
} from '@/lib/queue/queue';
import type { PaletteEntry } from '@/lib/palette/search';
import {
  fromDbCategory,
  type DbMessageCategory,
  type MessageTriage,
} from '@/lib/triage/types';

/**
 * The IO half of the queue: read Postgres, hand plain rows to the pure
 * functions in `queue.ts`, return something serializable.
 *
 * Server-side only: it imports the Prisma client and `getInstallation()`,
 * which reads Slack tokens. Nothing here may be imported from a `'use client'`
 * module — the return type is deliberately narrow (`InboxData`) so that even
 * if it were, no token could travel with it. The pure `queue.ts` is what the
 * client component imports.
 */

/** Cap on how far back the queue reaches. Phase 4's views will make this a
 * per-view concern; for now it just keeps the page bounded. */
const DEFAULT_MESSAGE_LIMIT = 500;

export type InboxData = {
  items: QueueItem[];
  paletteEntries: PaletteEntry[];
  /** Null when Slack has never been connected — the page shows a setup CTA. */
  authedUserId: string | null;
  workspaceName: string | null;
};

/**
 * Prisma hands back `Prisma.JsonValue` for the reactions column. Phase 1 wrote
 * it as `[{ name, count, userIds }]`, but the database cannot promise that, so
 * re-validate rather than casting and hoping.
 */
function readReactions(value: unknown): QueueReaction[] | null {
  if (!Array.isArray(value)) return null;

  const reactions: QueueReaction[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const candidate = entry as { name?: unknown; count?: unknown };
    if (typeof candidate.name !== 'string') continue;
    reactions.push({
      name: candidate.name,
      count: typeof candidate.count === 'number' ? candidate.count : 0,
    });
  }

  return reactions.length > 0 ? reactions : null;
}

/** The exact selection the queue needs. Keeping it explicit stops the page
 * from accidentally shipping a Slack token or a whole Block Kit payload to the
 * client just because the model grew a column. */
const MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  ts: true,
  sentAt: true,
  threadTs: true,
  isThreadReply: true,
  isThreadParent: true,
  replyCount: true,
  userId: true,
  authorName: true,
  botId: true,
  subtype: true,
  text: true,
  isEdited: true,
  isDeleted: true,
  hasFiles: true,
  reactions: true,
  mentionedUserIds: true,
  conversation: {
    select: {
      id: true,
      kind: true,
      name: true,
      peerUserId: true,
    },
  },
  state: { select: { isDone: true, doneAt: true } },
  classification: {
    select: {
      urgencyScore: true,
      category: true,
      isBump: true,
      bumpOfMessageId: true,
      // `reason` is selected deliberately: CLAUDE.md requires the model's
      // reasoning travel with the score so the sort order is arguable rather
      // than a black box. The reading pane renders it.
      reason: true,
      model: true,
      updatedAt: true,
    },
  },
} as const;

type DbMessage = {
  id: string;
  conversationId: string;
  ts: string;
  sentAt: Date;
  threadTs: string | null;
  isThreadReply: boolean;
  isThreadParent: boolean;
  replyCount: number;
  userId: string | null;
  authorName: string | null;
  botId: string | null;
  subtype: string | null;
  text: string;
  isEdited: boolean;
  isDeleted: boolean;
  hasFiles: boolean;
  reactions: unknown;
  mentionedUserIds: string[];
  conversation: {
    id: string;
    kind: QueueConversation['kind'];
    name: string | null;
    peerUserId: string | null;
  };
  state: { isDone: boolean; doneAt: Date | null } | null;
  classification: {
    urgencyScore: number;
    category: DbMessageCategory;
    isBump: boolean;
    bumpOfMessageId: string | null;
    reason: string;
    model: string;
    updatedAt: Date;
  } | null;
};

function toTriage(
  classification: DbMessage['classification'],
): MessageTriage | null {
  if (!classification) return null;
  return {
    urgencyScore: classification.urgencyScore,
    category: fromDbCategory(classification.category),
    isBump: classification.isBump,
    bumpOfMessageId: classification.bumpOfMessageId,
    reason: classification.reason,
    model: classification.model,
    classifiedAtIso: classification.updatedAt.toISOString(),
  };
}

function toQueueMessageRow(message: DbMessage): QueueMessageRow {
  return {
    id: message.id,
    conversationId: message.conversationId,
    ts: message.ts,
    sentAt: message.sentAt,
    threadTs: message.threadTs,
    isThreadReply: message.isThreadReply,
    isThreadParent: message.isThreadParent,
    replyCount: message.replyCount,
    userId: message.userId,
    authorName: message.authorName,
    botId: message.botId,
    subtype: message.subtype,
    text: message.text,
    isEdited: message.isEdited,
    isDeleted: message.isDeleted,
    hasFiles: message.hasFiles,
    reactions: readReactions(message.reactions),
    mentionedUserIds: message.mentionedUserIds,
    conversation: message.conversation,
    isDone: message.state?.isDone ?? false,
    doneAt: message.state?.doneAt ?? null,
    triage: toTriage(message.classification),
  };
}

/**
 * Threads the authed user is part of: ones they started, and ones they have
 * replied in. Computed as a set of `conversationId:threadTs` keys so
 * `queueReasonFor` can stay a pure predicate.
 */
async function loadParticipatingThreadKeys(
  authedUserId: string | null,
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!authedUserId) return keys;

  const rows = await prisma.message.findMany({
    where: { userId: authedUserId, threadTs: { not: null } },
    select: { conversationId: true, threadTs: true },
  });

  for (const row of rows) {
    if (row.threadTs) keys.add(threadKey(row.conversationId, row.threadTs));
  }
  return keys;
}

function paletteEntriesFrom(
  conversations: readonly QueueConversation[],
  users: readonly QueueUser[],
  items: readonly QueueItem[],
): PaletteEntry[] {
  const openByConversation = new Map<string, number>();
  const openByUser = new Map<string, number>();

  for (const item of items) {
    if (item.isDone) continue;
    openByConversation.set(
      item.conversationId,
      (openByConversation.get(item.conversationId) ?? 0) + 1,
    );
    if (item.senderId) {
      openByUser.set(item.senderId, (openByUser.get(item.senderId) ?? 0) + 1);
    }
  }

  const openHint = (count: number, fallback: string) =>
    count > 0 ? `${count} open` : fallback;

  const usersById = new Map(users.map((user) => [user.id, user]));

  const conversationEntries: PaletteEntry[] = conversations.map(
    (conversation) => {
      const isDm = conversation.kind === 'IM' || conversation.kind === 'MPIM';
      // Every IM would otherwise read "Direct message" — indistinguishable in
      // a list, which defeats the point of a jump-to palette. Reuse the same
      // labelling rule the queue rows use.
      const label = conversation.name
        ? `#${conversation.name}`
        : isDm
          ? contextLabelFor(conversation, usersById)
          : conversation.id;
      const open = openByConversation.get(conversation.id) ?? 0;
      return {
        id: `conversation:${conversation.id}`,
        kind: 'conversation',
        label,
        hint: openHint(open, isDm ? 'Direct message' : 'Channel'),
        keywords: [conversation.id],
        // Conversations with unread work outrank empty ones on a tie.
        weight: open,
      };
    },
  );

  const userEntries: PaletteEntry[] = users.map((user) => {
    const label =
      user.displayName || user.realName || user.username || user.id;
    const open = openByUser.get(user.id) ?? 0;
    return {
      id: `person:${user.id}`,
      kind: 'person',
      label,
      hint: openHint(open, user.isBot ? 'App' : 'Person'),
      keywords: [user.id, user.username ?? '', user.realName ?? ''].filter(
        Boolean,
      ),
      weight: open,
    };
  });

  return [...conversationEntries, ...userEntries];
}

/** Everything the inbox page renders, in one round trip. */
export async function loadInbox(
  options: { limit?: number } = {},
): Promise<InboxData> {
  const limit = options.limit ?? DEFAULT_MESSAGE_LIMIT;

  const installation = await getInstallation();
  const authedUserId = installation?.authedUserId ?? null;

  const [messages, conversations, users, threadKeys] = await Promise.all([
    prisma.message.findMany({
      where: { isDeleted: false },
      orderBy: { sentAt: 'desc' },
      take: limit,
      select: MESSAGE_SELECT,
    }),
    prisma.conversation.findMany({
      select: { id: true, kind: true, name: true, peerUserId: true },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    }),
    prisma.user.findMany({
      where: { isDeleted: false },
      select: {
        id: true,
        username: true,
        realName: true,
        displayName: true,
        avatarUrl: true,
        isBot: true,
        isVip: true,
      },
      orderBy: { id: 'asc' },
    }),
    loadParticipatingThreadKeys(authedUserId),
  ]);

  const userMap = new Map<string, QueueUser>(
    users.map((user) => [user.id, user]),
  );
  const conversationMap = new Map<string, QueueConversation>(
    conversations.map((conversation) => [conversation.id, conversation]),
  );

  const rows = messages.map(toQueueMessageRow);

  let items = buildQueue(rows, {
    authedUserId,
    participatingThreadKeys: threadKeys,
    users: userMap,
    conversations: conversationMap,
  });

  // Thread replies for the parents in the queue, so the reading pane can show
  // a thread without a second round trip when the user hits Enter. Speed is
  // the whole point of this phase.
  const parentKeys = items
    .filter((item) => item.isThreadParent && item.replyCount > 0)
    .map((item) => ({ conversationId: item.conversationId, ts: item.ts }));

  if (parentKeys.length > 0) {
    const replies = await prisma.message.findMany({
      where: {
        isDeleted: false,
        OR: parentKeys.map((parent) => ({
          conversationId: parent.conversationId,
          threadTs: parent.ts,
        })),
      },
      select: MESSAGE_SELECT,
      orderBy: { ts: 'asc' },
    });

    items = attachThreadReplies(
      items,
      replies.map(toQueueMessageRow),
      userMap,
      conversationMap,
    );
  }

  return {
    items,
    paletteEntries: paletteEntriesFrom(conversations, users, items),
    authedUserId,
    workspaceName: installation?.teamName ?? null,
  };
}
