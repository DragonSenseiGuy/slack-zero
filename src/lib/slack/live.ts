import type { WebClient } from '@slack/web-api';

import { prisma } from '@/lib/db';
import { messageCacheKey, slackConversationCache, slackMessageCache, slackUserCache } from '@/lib/slack/cache';
import type { RawSlackConversation, RawSlackMessage, RawSlackUser } from '@/lib/slack/raw';

const pending = new Map<string, Promise<unknown>>();
export const SLACK_HYDRATION_CONCURRENCY = 4;
const MAX_BATCH_PAGES = 10;
export const DEFAULT_INBOX_SLACK_REQUEST_BUDGET = 100;

export type SlackRequestBudget = { remaining: number };
export function createSlackRequestBudget(maximum = DEFAULT_INBOX_SLACK_REQUEST_BUDGET): SlackRequestBudget {
  return { remaining: Math.max(0, maximum) };
}
function spend(budget?: SlackRequestBudget): boolean {
  if (!budget) return true;
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

export type MessageHydrationIdentity = {
  id: string;
  conversationId: string;
  ts: string;
  threadTs: string | null;
  isDeleted: boolean;
  conversation: { kind: string };
};

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await work(values[index]);
    }
  }));
  return results;
}

const E2E_CHANNEL = 'CE2ESEED001';
const E2E_DM = 'DE2ESEED001';
const E2E_SENDER = 'UE2ESEED001';
const E2E_BYSTANDER = 'UE2EGAP0001';
const E2E_MESSAGES: Record<string, string> = {
  ...Object.fromEntries(['alpha — first fixture message', 'bravo — second fixture message', 'charlie — third fixture message', 'delta — fourth fixture message', 'echo — fifth fixture message', 'foxtrot — sixth fixture message'].map((text, index) => [`me2e-msg-${index}`, `E2E ${text}`])),
  ...Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`me2e-gap-${index}`, `E2E bystander chatter ${index + 1}`])),
  'me2e-thread-parent': 'E2E golf — thread parent',
  'me2e-thread-reply-0': 'E2E thread reply one',
  'me2e-thread-reply-1': 'E2E thread reply two',
  'me2e-burst-gap': 'E2E bystander chatter burst gap',
  'me2e-burst-0': 'E2E burst one — hey, are you around?',
  'me2e-burst-1': 'E2E burst two — following up on the migration',
  'me2e-burst-2': 'E2E burst three — need this before the release',
  'me2e-late': 'E2E hotel — arrived after the page loaded',
  ...Object.fromEntries(['one — did the migration land?', 'two — not yet, reviewing it now', 'three — any blockers?', 'four — just the index rebuild', 'five — how long does that take?', 'six — twenty minutes or so', 'seven — fine, ship it after', 'eight — will do', 'nine — thanks', 'ten — no problem', 'eleven — one more thing', 'twelve — go on', 'thirteen — sounds good, go ahead'].map((text, index) => [`me2e-dm-${index}`, `E2E dm ${text}`])),
};

type SyntheticIdentity = { id: string; ts: string; threadTs: string | null; userId: string | null; isDeleted: boolean };

function e2eEnabled(): boolean { return process.env.SLACKZERO_E2E === '1'; }
function isE2eConversation(id: string): boolean { return id === E2E_CHANNEL || id === E2E_DM; }

async function syntheticMessage(conversationId: string, identity: SyntheticIdentity): Promise<RawSlackMessage | null> {
  if (identity.isDeleted) return null;
  const fixtureText = E2E_MESSAGES[identity.id];
  if (!fixtureText) return null;
  let text = fixtureText;
  const mentions =
    conversationId === E2E_CHANNEL &&
    (/^me2e-msg-\d+$|^me2e-burst-\d+$|^me2e-thread-parent$|^me2e-late$/.test(
      identity.id,
    ));
  if (mentions) {
    const installation = await prisma.slackInstallation.findFirst({ orderBy: { updatedAt: 'desc' }, select: { authedUserId: true } });
    if (installation) text = `<@${installation.authedUserId}> ${text}`;
  }
  const replyCount = identity.id === 'me2e-thread-parent' ? 2 : undefined;
  return { type: 'message', ts: identity.ts, text, user: identity.userId ?? undefined, thread_ts: identity.threadTs ?? undefined, reply_count: replyCount };
}

async function dedupe<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = pending.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = work().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

export async function hydrateExactMessage(client: WebClient, conversationId: string, ts: string, budget?: SlackRequestBudget): Promise<RawSlackMessage | null> {
  const key = messageCacheKey(conversationId, ts);
  const identity = await prisma.message.findUnique({
    where: { conversationId_ts: { conversationId, ts } },
    select: { isDeleted: true, threadTs: true, updatedAt: true },
  });
  if (!identity || identity.isDeleted) {
    slackMessageCache.delete(key);
    return null;
  }
  const cached = slackMessageCache.get(key);
  if (cached?.revisionMs === identity.updatedAt.getTime()) return cached.raw;
  if (cached) slackMessageCache.delete(key);
  return dedupe(`message:${key}`, async () => {
    const current = await prisma.message.findUnique({ where: { conversationId_ts: { conversationId, ts } }, select: { id: true, ts: true, threadTs: true, userId: true, isDeleted: true, updatedAt: true } });
    if (!current || current.isDeleted) return null;
    if (e2eEnabled() && isE2eConversation(conversationId) && current) {
      const message = await syntheticMessage(conversationId, current);
      if (message) slackMessageCache.set(key, { raw: message, revisionMs: current.updatedAt.getTime() });
      return message;
    }
    if (!spend(budget)) return null;
    const result = current.threadTs && current.threadTs !== current.ts
      ? await client.conversations.replies({ channel: conversationId, ts: current.threadTs, oldest: ts, latest: ts, inclusive: true, limit: 1 })
      : await client.conversations.history({ channel: conversationId, latest: ts, inclusive: true, limit: 1 });
    const message = ((result.messages as RawSlackMessage[] | undefined) ?? []).find((row) => row.ts === ts) ?? null;
    const afterFetch = await prisma.message.findUnique({ where: { id: current.id }, select: { isDeleted: true, updatedAt: true } });
    if (!afterFetch || afterFetch.isDeleted || afterFetch.updatedAt.getTime() !== current.updatedAt.getTime()) {
      slackMessageCache.delete(key);
      return null;
    }
    if (message) slackMessageCache.set(key, { raw: message, revisionMs: current.updatedAt.getTime() });
    return message;
  });
}

/** Hydrate a selected identity set while coalescing Slack calls by DM/thread. */
export async function hydrateMessageBatch(
  client: WebClient,
  identities: readonly MessageHydrationIdentity[],
  budget?: SlackRequestBudget,
): Promise<void> {
  const revisions = await prisma.message.findMany({
    where: { id: { in: identities.map((row) => row.id) } },
    select: { id: true, updatedAt: true },
  });
  const initialRevision = new Map(revisions.map((row) => [row.id, row.updatedAt.getTime()]));
  const requested = identities.filter((row) => {
    if (row.isDeleted) return false;
    const key = messageCacheKey(row.conversationId, row.ts);
    const cached = slackMessageCache.get(key);
    if (cached?.revisionMs === initialRevision.get(row.id)) return false;
    if (cached) slackMessageCache.delete(key);
    return true;
  });
  const staged = new Map<string, { row: MessageHydrationIdentity; raw: RawSlackMessage }>();
  const dmGroups = new Map<string, MessageHydrationIdentity[]>();
  const threadGroups = new Map<string, MessageHydrationIdentity[]>();
  const exact: MessageHydrationIdentity[] = [];
  for (const row of requested) {
    if (e2eEnabled() && isE2eConversation(row.conversationId)) {
      exact.push(row);
    } else if (row.threadTs && row.threadTs !== row.ts) {
      const key = `${row.conversationId}:${row.threadTs}`;
      threadGroups.set(key, [...(threadGroups.get(key) ?? []), row]);
    } else if (row.conversation.kind === 'IM' || row.conversation.kind === 'MPIM') {
      dmGroups.set(row.conversationId, [...(dmGroups.get(row.conversationId) ?? []), row]);
    } else exact.push(row);
  }

  const jobs: Array<() => Promise<void>> = [];
  for (const [conversationId, rows] of dmGroups) jobs.push(async () => {
    const targets = new Set(rows.map((row) => row.ts));
    const rowsByTs = new Map(rows.map((row) => [row.ts, row]));
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (!spend(budget)) break;
      const response = await client.conversations.history({ channel: conversationId,
        oldest: rows.reduce((min, row) => row.ts < min ? row.ts : min, rows[0].ts),
        latest: rows.reduce((max, row) => row.ts > max ? row.ts : max, rows[0].ts),
        inclusive: true, limit: 200, cursor });
      for (const raw of (response.messages as RawSlackMessage[] | undefined) ?? []) {
        const row = raw.ts ? rowsByTs.get(raw.ts) : undefined;
        if (raw.ts && row && targets.delete(raw.ts)) staged.set(row.id, { row, raw });
      }
      cursor = response.response_metadata?.next_cursor || undefined;
      pages += 1;
    } while (targets.size > 0 && cursor && pages < MAX_BATCH_PAGES);
  });
  for (const [key, rows] of threadGroups) jobs.push(async () => {
    const conversationId = rows[0].conversationId;
    const threadTs = rows[0].threadTs!;
    const targets = new Set(rows.map((row) => row.ts));
    const rowsByTs = new Map(rows.map((row) => [row.ts, row]));
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (!spend(budget)) break;
      const oldest = rows.reduce((min, row) => row.ts < min ? row.ts : min, rows[0].ts);
      const latest = rows.reduce((max, row) => row.ts > max ? row.ts : max, rows[0].ts);
      const response = await client.conversations.replies({ channel: conversationId, ts: threadTs, oldest, latest, inclusive: true, limit: 200, cursor });
      for (const raw of (response.messages as RawSlackMessage[] | undefined) ?? []) {
        const row = raw.ts ? rowsByTs.get(raw.ts) : undefined;
        if (raw.ts && row && targets.delete(raw.ts)) staged.set(row.id, { row, raw });
      }
      cursor = response.response_metadata?.next_cursor || undefined;
      pages += 1;
    } while (targets.size > 0 && cursor && pages < MAX_BATCH_PAGES);
    void key;
  });
  exact.forEach((row) => jobs.push(async () => { await hydrateExactMessage(client, row.conversationId, row.ts, budget); }));
  await mapWithConcurrency(jobs, SLACK_HYDRATION_CONCURRENCY, (job) => job());

  // A delete may race any network request. Never publish content until every
  // requested identity has had its tombstone rechecked.
  const live = await prisma.message.findMany({ where: { id: { in: requested.map((row) => row.id) } }, select: { id: true, isDeleted: true, updatedAt: true } });
  const current = new Map(live.map((row) => [row.id, row]));
  requested.forEach((row) => {
    const now = current.get(row.id);
    const unchanged = now && !now.isDeleted && now.updatedAt.getTime() === initialRevision.get(row.id);
    const fetched = staged.get(row.id);
    if (unchanged && fetched) slackMessageCache.set(messageCacheKey(row.conversationId, row.ts), {
      raw: fetched.raw,
      revisionMs: now.updatedAt.getTime(),
    });
    else if (!unchanged) slackMessageCache.delete(messageCacheKey(row.conversationId, row.ts));
  });
}

export async function hydrateHistory(client: WebClient, conversationId: string, before: string, limit: number, budget?: SlackRequestBudget) {
  if (e2eEnabled() && isE2eConversation(conversationId)) {
    const identities = await prisma.message.findMany({ where: { conversationId, ts: { lt: before }, isDeleted: false }, orderBy: { sentAt: 'desc' }, take: limit, select: { id: true, ts: true, threadTs: true, userId: true, isDeleted: true } });
    return { messages: (await Promise.all(identities.map((identity) => syntheticMessage(conversationId, identity)))).filter(Boolean) };
  }
  if (!spend(budget)) return { messages: [], unavailable: true };
  return client.conversations.history({ channel: conversationId, latest: before, inclusive: false, limit });
}

export async function hydrateThread(client: WebClient, conversationId: string, threadTs: string, budget?: SlackRequestBudget) {
  if (e2eEnabled() && conversationId === E2E_CHANNEL) {
    const identities = await prisma.message.findMany({ where: { conversationId, threadTs, isDeleted: false }, orderBy: { sentAt: 'asc' }, select: { id: true, ts: true, threadTs: true, userId: true, isDeleted: true } });
    return { messages: (await Promise.all(identities.map((identity) => syntheticMessage(conversationId, identity)))).filter(Boolean) };
  }
  if (!spend(budget)) return { messages: [], unavailable: true };
  return client.conversations.replies({ channel: conversationId, ts: threadTs });
}

export async function hydrateUser(client: WebClient, userId: string, budget?: SlackRequestBudget): Promise<RawSlackUser | null> {
  const cached = slackUserCache.get(userId) as RawSlackUser | undefined;
  if (cached) return cached;
  return dedupe(`user:${userId}`, async () => {
    if (e2eEnabled() && (userId === E2E_SENDER || userId === E2E_BYSTANDER)) {
      const exists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      const user = exists ? { id: userId, name: userId === E2E_SENDER ? 'e2e-fixture-sender' : 'e2e-bystander', profile: { display_name: userId === E2E_SENDER ? 'E2E Fixture Sender' : 'E2E Bystander' } } : null;
      if (user) slackUserCache.set(userId, user);
      return user;
    }
    if (!spend(budget)) return null;
    const result = await client.users.info({ user: userId });
    const user = (result.user as RawSlackUser | undefined) ?? null;
    if (user) slackUserCache.set(userId, user);
    return user;
  });
}

export async function hydrateConversation(client: WebClient, conversationId: string, budget?: SlackRequestBudget): Promise<RawSlackConversation | null> {
  const cached = slackConversationCache.get(conversationId) as RawSlackConversation | undefined;
  if (cached) return cached;
  return dedupe(`conversation:${conversationId}`, async () => {
    if (e2eEnabled() && isE2eConversation(conversationId)) {
      const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, peerUserId: true } });
      const raw = conversation ? (conversationId === E2E_CHANNEL ? { id: conversationId, name: 'e2e-seed', is_channel: true } : { id: conversationId, is_im: true, user: conversation.peerUserId ?? undefined }) : null;
      if (raw) slackConversationCache.set(conversationId, raw);
      return raw;
    }
    if (!spend(budget)) return null;
    const result = await client.conversations.info({ channel: conversationId });
    const conversation = (result.channel as RawSlackConversation | undefined) ?? null;
    if (conversation) slackConversationCache.set(conversationId, conversation);
    return conversation;
  });
}
