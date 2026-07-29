import { prisma } from '@/lib/db';
import { buildContextPage, type ContextPage, type ContextRequest } from '@/lib/queue/context';
import {
  attachThreadReplies,
  buildQueue,
  contextLabelFor,
  threadKey,
  type QueueConversation,
  type QueueItem,
  type QueueMessageRow,
  type QueueScope,
  type QueueUser,
} from '@/lib/queue/queue';
import { getSlackContext } from '@/lib/slack/client';
import { createSlackRequestBudget, hydrateConversation, hydrateExactMessage, hydrateHistory, hydrateMessageBatch, hydrateThread, hydrateUser, mapWithConcurrency, SLACK_HYDRATION_CONCURRENCY, type SlackRequestBudget } from '@/lib/slack/live';
import { normalizeConversation, normalizeMessage, normalizeUser } from '@/lib/slack/normalize';
import type { RawSlackConversation, RawSlackMessage } from '@/lib/slack/raw';
import { fromDbCategory, type DbMessageCategory, type MessageTriage } from '@/lib/triage/types';

const DEFAULT_MESSAGE_LIMIT = 500;
export const MAX_ROUTING_BOUNDARY_ROWS = 2_000;
export const MAX_INBOX_THREAD_PARENTS = 40;
export type InboxData = { items: QueueItem[]; authedUserId: string | null; workspaceName: string | null };

const MESSAGE_SELECT = {
  id: true, conversationId: true, ts: true, sentAt: true, threadTs: true,
  userId: true, isDeleted: true,
  isContent: true, mentionsAuthedUser: true,
  conversation: { select: { id: true, kind: true, peerUserId: true } },
  state: { select: { isDone: true, doneAt: true, snoozedUntil: true, snoozedAt: true, lastSnoozedUntil: true, unsnoozedAt: true, unsnoozeReason: true, isWaitingOn: true, waitingOnSince: true } },
  classification: { select: { urgencyScore: true, category: true, isBump: true, bumpOfMessageId: true, reasonCode: true, model: true, updatedAt: true } },
} as const;

type DbMessage = Awaited<ReturnType<typeof loadIdentities>>[number];
async function loadIdentities(limit: number, authedUserId: string | null) {
  const routed = authedUserId ? await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT m.id FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
    WHERE NOT m."isDeleted" AND m."isContent" AND (
      c.kind IN ('IM', 'MPIM') OR m."mentionsAuthedUser" OR EXISTS (
        SELECT 1 FROM "Message" authored WHERE authored."conversationId" = m."conversationId"
          AND authored."userId" = ${authedUserId} AND NOT authored."isDeleted"
          AND COALESCE(authored."threadTs", authored.ts) = COALESCE(m."threadTs", m.ts)))
    ORDER BY m."sentAt" DESC, m.ts DESC LIMIT ${limit}` : null;
  const candidates = await prisma.message.findMany({
    where: routed ? { id: { in: routed.map((row) => row.id) } } : { isDeleted: false, isContent: true, OR: [
      { conversation: { kind: { in: ['IM', 'MPIM'] } } },
      { mentionsAuthedUser: true },
    ] },
    orderBy: { sentAt: 'desc' }, take: limit, select: MESSAGE_SELECT,
  });
  const channelGroups = new Map<string, typeof candidates>();
  candidates.forEach((row) => {
    if (row.conversation.kind !== 'IM' && row.conversation.kind !== 'MPIM')
      channelGroups.set(row.conversationId, [...(channelGroups.get(row.conversationId) ?? []), row]);
  });
  if (!channelGroups.size) return candidates.map((row) => ({ ...row, isCandidate: true, disableBurstGrouping: false }));
  const boundaries = await prisma.message.findMany({
    where: { isDeleted: false, OR: [...channelGroups].map(([conversationId, rows]) => ({
      conversationId,
      sentAt: { gte: rows.reduce((min, row) => row.sentAt < min ? row.sentAt : min, rows[0].sentAt), lte: rows.reduce((max, row) => row.sentAt > max ? row.sentAt : max, rows[0].sentAt) },
    })) },
    orderBy: { sentAt: 'desc' }, take: MAX_ROUTING_BOUNDARY_ROWS + 1, select: MESSAGE_SELECT,
  });
  const boundaryTruncated = boundaries.length > MAX_ROUTING_BOUNDARY_ROWS;
  const unsafeChannels = boundaryTruncated ? new Set(channelGroups.keys()) : new Set<string>();
  const byId = new Map(candidates.map((row) => [row.id, { ...row, isCandidate: true, disableBurstGrouping: false }]));
  boundaries.slice(0, MAX_ROUTING_BOUNDARY_ROWS).forEach((row) => { if (!byId.has(row.id)) byId.set(row.id, { ...row, isCandidate: false, disableBurstGrouping: false }); });
  unsafeChannels.forEach((channel) => channelGroups.get(channel)?.forEach((row) => byId.set(row.id, { ...byId.get(row.id)!, disableBurstGrouping: true })));
  return [...byId.values()].sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
}

function triage(value: DbMessage['classification']): MessageTriage | null {
  return value ? { urgencyScore: value.urgencyScore, category: fromDbCategory(value.category as DbMessageCategory), isBump: value.isBump, bumpOfMessageId: value.bumpOfMessageId, reasonCode: value.reasonCode, model: value.model, classifiedAtIso: value.updatedAt.toISOString() } : null;
}

function unavailable(db: DbMessage, isRoutingBoundary = false): QueueMessageRow {
  return {
    id: db.id, conversationId: db.conversationId, ts: db.ts, sentAt: db.sentAt,
    threadTs: db.threadTs, isThreadReply: Boolean(db.threadTs && db.threadTs !== db.ts),
    isThreadParent: db.threadTs === db.ts, replyCount: 0, userId: db.userId,
    authorName: null, botId: null, subtype: null, text: '', isRoutingBoundary, disableBurstGrouping: db.disableBurstGrouping,
    isEdited: false, isDeleted: db.isDeleted, hasFiles: false, reactions: null,
    mentionedUserIds: [], mentionsAuthedUser: db.mentionsAuthedUser,
    conversation: { ...db.conversation, name: null },
    isDone: db.state?.isDone ?? false, doneAt: db.state?.doneAt ?? null,
    snoozedUntil: db.state?.snoozedUntil ?? null, snoozedAt: db.state?.snoozedAt ?? null,
    lastSnoozedUntil: db.state?.lastSnoozedUntil ?? null, unsnoozedAt: db.state?.unsnoozedAt ?? null,
    unsnoozeReason: db.state?.unsnoozeReason ?? null, isWaitingOn: db.state?.isWaitingOn ?? false,
    waitingOnSince: db.state?.waitingOnSince ?? null, triage: triage(db.classification),
  };
}

function liveRow(db: DbMessage, raw: RawSlackMessage | null, conversation: QueueConversation): QueueMessageRow {
  if (!raw) return { ...unavailable(db), conversation };
  const message = normalizeMessage(raw, db.conversationId);
  return { ...unavailable(db), sentAt: message.sentAt, threadTs: message.threadTs, isThreadReply: message.isThreadReply,
    isThreadParent: message.isThreadParent, replyCount: message.replyCount, userId: message.userId,
    authorName: message.authorName, botId: message.botId, subtype: message.subtype, text: message.text,
    isEdited: message.isEdited, hasFiles: message.hasFiles,
    reactions: message.reactions?.map(({ name, count }) => ({ name, count })) ?? null,
    mentionedUserIds: message.mentionedUserIds, conversation };
}

async function directories(client: Awaited<ReturnType<typeof getSlackContext>>['client'], db: readonly DbMessage[], budget?: SlackRequestBudget) {
  const conversationIds = [...new Set(db.map((row) => row.conversationId))];
  const rawConversations = await mapWithConcurrency(conversationIds, SLACK_HYDRATION_CONCURRENCY, (id) => hydrateConversation(client, id, budget).catch(() => null));
  const conversations = new Map<string, QueueConversation>();
  rawConversations.forEach((raw, index) => {
    const stored = db.find((row) => row.conversationId === conversationIds[index])?.conversation;
    if (!stored) return;
    const normalized = raw ? normalizeConversation(raw) : null;
    conversations.set(stored.id, { id: stored.id, kind: stored.kind, peerUserId: stored.peerUserId, name: normalized?.name ?? null });
  });
  const userIds = [...new Set(db.map((row) => row.userId).filter((id): id is string => Boolean(id)))];
  const vip = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, isVip: true } });
  const vipMap = new Map(vip.map((row) => [row.id, row.isVip]));
  const users = new Map<string, QueueUser>();
  await mapWithConcurrency(userIds, SLACK_HYDRATION_CONCURRENCY, async (id) => {
    const raw = await hydrateUser(client, id, budget).catch(() => null); const user = raw ? normalizeUser(raw) : null;
    users.set(id, { id, username: user?.username ?? null, realName: user?.realName ?? null, displayName: user?.displayName ?? null, avatarUrl: user?.avatarUrl ?? null, isBot: user?.isBot ?? false, isVip: vipMap.get(id) ?? false });
  });
  return { conversations, users };
}

export async function resolveConversationScope(nameOrId: string): Promise<QueueScope | null> {
  const wanted = nameOrId.trim().replace(/^#/, ''); if (!wanted) return null;
  const context = await getSlackContext();
  let raw: RawSlackConversation | null = null;
  const stored = await prisma.conversation.findUnique({ where: { id: wanted }, select: { id: true } });
  if (stored) raw = await hydrateConversation(context.client, stored.id);
  else {
    const result = await context.client.conversations.list({ limit: 200, exclude_archived: true });
    raw = ((result.channels as RawSlackConversation[] | undefined) ?? []).find((item) => item.name === wanted) ?? null;
  }
  if (!raw?.id) return null;
  const conversation = normalizeConversation(raw);
  return { kind: 'conversation', id: conversation.id, label: conversation.name ? `#${conversation.name}` : contextLabelFor(conversation, new Map()) };
}

export async function loadConversationContext(conversationId: string, request: ContextRequest): Promise<ContextPage | null> {
  const stored = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, kind: true, peerUserId: true } });
  if (!stored) return null;
  const context = await getSlackContext();
  const result = await hydrateHistory(context.client, conversationId, request.before, request.limit + 1);
  const raw = (result.messages as RawSlackMessage[] | undefined) ?? [];
  const ids = raw.map((message) => message.user).filter((id): id is string => Boolean(id));
  const fakeDb = raw.filter((message): message is RawSlackMessage & { ts: string } => Boolean(message.ts)).map((message) => ({ id: `${conversationId}:${message.ts}`, conversationId, ts: message.ts, sentAt: normalizeMessage(message, conversationId).sentAt, threadTs: message.thread_ts ?? null, userId: message.user ?? null, isDeleted: false, isContent: true, mentionsAuthedUser: false, isCandidate: true, disableBurstGrouping: false, conversation: stored, state: null, classification: null }));
  const { users, conversations } = await directories(context.client, fakeDb);
  const conversation = conversations.get(conversationId) ?? { ...stored, name: null };
  const rows = fakeDb.map((identity, index) => liveRow(identity, raw[index] ?? null, conversation));
  void ids;
  return buildContextPage(rows, request.limit, users, conversations, context.authedUserId);
}

export async function loadInbox(options: { limit?: number } = {}): Promise<InboxData> {
  const context = await getSlackContext(); const messages = await loadIdentities(options.limit ?? DEFAULT_MESSAGE_LIMIT, context.authedUserId);
  const budget = createSlackRequestBudget();
  const candidateIds = new Set(messages.filter((row) => row.isCandidate).map((row) => row.id));
  const candidates = messages.filter((row) => candidateIds.has(row.id));
  await hydrateMessageBatch(context.client, candidates, budget);
  // Routing-only boundary rows need sender ids for burst termination, not
  // profile hydration or any other Slack-owned directory data.
  const { users, conversations } = await directories(context.client, candidates, budget);
  const rows = await mapWithConcurrency(messages, SLACK_HYDRATION_CONCURRENCY, async (db) => candidateIds.has(db.id)
    ? liveRow(db, await hydrateExactMessage(context.client, db.conversationId, db.ts, budget).catch(() => null), conversations.get(db.conversationId) ?? { ...db.conversation, name: null })
    : { ...unavailable(db, true), conversation: conversations.get(db.conversationId) ?? { ...db.conversation, name: null } });
  const participation = new Set<string>(); messages.filter((row) => context.authedUserId && row.userId === context.authedUserId).forEach((row) => participation.add(threadKey(row.conversationId, row.threadTs ?? row.ts)));
  messages.filter((row) => row.isCandidate && row.conversation.kind !== 'IM' && row.conversation.kind !== 'MPIM').forEach((row) => participation.add(threadKey(row.conversationId, row.threadTs ?? row.ts)));
  let items = buildQueue(rows, { authedUserId: context.authedUserId, participatingThreadKeys: participation, users, conversations });
  const parents = items.filter((item) => item.isThreadParent && item.replyCount > 0).slice(0, MAX_INBOX_THREAD_PARENTS);
  const replies: QueueMessageRow[] = [];
  await mapWithConcurrency(parents, SLACK_HYDRATION_CONCURRENCY, async (parent) => {
    const result = await hydrateThread(context.client, parent.conversationId, parent.ts, budget).catch(() => ({ messages: [] }));
    for (const raw of ((result.messages as RawSlackMessage[] | undefined) ?? []).slice(1)) {
      const normalized = normalizeMessage(raw, parent.conversationId);
      const identity = messages.find((row) => row.id === parent.id);
      const conversation = conversations.get(parent.conversationId);
      if (!identity || !conversation) continue;
      replies.push(liveRow({ ...identity, id: `${parent.conversationId}:${normalized.ts}`, ts: normalized.ts, sentAt: normalized.sentAt, threadTs: normalized.threadTs, userId: normalized.userId, state: null, classification: null }, raw, conversation));
    }
  });
  const surviving = await prisma.message.findMany({ where: { id: { in: candidateIds.size ? [...candidateIds] : ['__none__'] }, isDeleted: false }, select: { id: true } });
  const survivingIds = new Set(surviving.map((row) => row.id));
  items = items.filter((item) => survivingIds.has(item.id));
  if (replies.length) items = attachThreadReplies(items, replies, users, conversations);
  return { items, authedUserId: context.authedUserId, workspaceName: context.teamName };
}
