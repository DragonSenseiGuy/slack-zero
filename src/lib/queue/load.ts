import { prisma } from '@/lib/db';
import { getInstallation } from '@/lib/slack/installation';
import {
  buildContextPage,
  type ContextPage,
  type ContextRequest,
} from '@/lib/queue/context';
import {
  attachThreadReplies,
  buildQueue,
  contextLabelFor,
  HIDDEN_SUBTYPES,
  threadKey,
  type QueueConversation,
  type QueueItem,
  type QueueMessageRow,
  type QueueReaction,
  type QueueScope,
  type QueueUser,
} from '@/lib/queue/queue';
import {
  fromDbCategory,
  type DbMessageCategory,
  type MessageTriage,
} from '@/lib/triage/types';

const DEFAULT_MESSAGE_LIMIT = 500;

export type InboxData = {
  items: QueueItem[];
  authedUserId: string | null;
  workspaceName: string | null;
};

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
  state: {
    select: {
      isDone: true,
      doneAt: true,
      snoozedUntil: true,
      snoozedAt: true,
      lastSnoozedUntil: true,
      unsnoozedAt: true,
      unsnoozeReason: true,
      isWaitingOn: true,
      waitingOnSince: true,
    },
  },
  classification: {
    select: {
      urgencyScore: true,
      category: true,
      isBump: true,
      bumpOfMessageId: true,
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
  state: {
    isDone: boolean;
    doneAt: Date | null;
    snoozedUntil: Date | null;
    snoozedAt: Date | null;
    lastSnoozedUntil: Date | null;
    unsnoozedAt: Date | null;
    unsnoozeReason: string | null;
    isWaitingOn: boolean;
    waitingOnSince: Date | null;
  } | null;
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
    snoozedUntil: message.state?.snoozedUntil ?? null,
    snoozedAt: message.state?.snoozedAt ?? null,
    lastSnoozedUntil: message.state?.lastSnoozedUntil ?? null,
    unsnoozedAt: message.state?.unsnoozedAt ?? null,
    unsnoozeReason: message.state?.unsnoozeReason ?? null,
    isWaitingOn: message.state?.isWaitingOn ?? false,
    waitingOnSince: message.state?.waitingOnSince ?? null,
    triage: toTriage(message.classification),
  };
}

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

export async function resolveConversationScope(
  nameOrId: string,
): Promise<QueueScope | null> {
  const wanted = nameOrId.trim().replace(/^#/, '');
  if (wanted === '') return null;

  const conversation = await prisma.conversation.findFirst({
    where: { OR: [{ id: wanted }, { name: wanted }] },
    select: { id: true, kind: true, name: true, peerUserId: true },
  });
  if (!conversation) return null;

  let label: string;
  if (conversation.name) {
    label = `#${conversation.name}`;
  } else {
    const peer = conversation.peerUserId
      ? await prisma.user.findUnique({
          where: { id: conversation.peerUserId },
          select: {
            id: true,
            username: true,
            realName: true,
            displayName: true,
            avatarUrl: true,
            isBot: true,
            isVip: true,
          },
        })
      : null;
    label = contextLabelFor(
      conversation,
      new Map<string, QueueUser>(peer ? [[peer.id, peer]] : []),
    );
  }

  return { kind: 'conversation', id: conversation.id, label };
}

/**
 * The messages immediately before `before` in one conversation.
 *
 * Reads backwards from a `ts` cursor rather than by offset, so history arriving
 * underneath the cursor (which backfill does routinely) cannot make a page skip
 * or repeat. Ordering and comparison are on `ts`, matching how the rest of the
 * queue orders messages: Slack's timestamps are fixed-width for any date this
 * app will see, so string order is time order.
 *
 * Over-fetches by one to answer `hasMore` without a second COUNT query.
 */
export async function loadConversationContext(
  conversationId: string,
  request: ContextRequest,
): Promise<ContextPage | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, kind: true, name: true, peerUserId: true },
  });
  if (!conversation) return null;

  const installation = await getInstallation();
  const authedUserId = installation?.authedUserId ?? null;

  const [rows, users] = await Promise.all([
    prisma.message.findMany({
      where: {
        conversationId,
        isDeleted: false,
        ts: { lt: request.before },
        // Excluded here as well as in `isContextWorthy`, so the over-fetched
        // row that decides `hasMore` is a real message rather than a join
        // notice that gets filtered out afterwards.
        OR: [
          { subtype: null },
          { subtype: { notIn: [...HIDDEN_SUBTYPES] } },
        ],
      },
      orderBy: { ts: 'desc' },
      take: request.limit + 1,
      select: {
        id: true,
        ts: true,
        sentAt: true,
        userId: true,
        authorName: true,
        botId: true,
        subtype: true,
        text: true,
        isEdited: true,
        isDeleted: true,
        hasFiles: true,
      },
    }),
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
  ]);

  return buildContextPage(
    rows,
    request.limit,
    new Map<string, QueueUser>(users.map((user) => [user.id, user])),
    new Map<string, QueueConversation>([[conversation.id, conversation]]),
    authedUserId,
  );
}

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
    authedUserId,
    workspaceName: installation?.teamName ?? null,
  };
}
