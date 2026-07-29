import type { WebClient } from '@slack/web-api';

import {
  ensureConversationFromReference,
  markConversationSynced,
  upsertConversation,
  upsertMessage,
  upsertUser,
  type UpsertOutcome,
} from '@/lib/slack/ingest';
import {
  NormalizationError,
  normalizeConversation,
  normalizeMessage,
  normalizeUser,
  type NormalizedConversation,
} from '@/lib/slack/normalize';
import { getSlackContext } from '@/lib/slack/client';
import type { RawSlackConversation, RawSlackMessage } from '@/lib/slack/raw';

export type ConversationSyncError = {
  conversationId: string;
  error: string;
};

export type BackfillCounts = {
  created: number;
  updated: number;
};

export type BackfillStats = {
  teamId: string;
  authedUserId: string;
  users: BackfillCounts;
  conversations: BackfillCounts & {
    byKind: Record<string, number>;
    historyRead: number;
  };
  messages: BackfillCounts & {
    skipped: number;
  };
  threads: { parents: number; repliesFetched: number };
  mentions: { searchTotal: number; ingested: number };
  errors: ConversationSyncError[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type BackfillOptions = {
  oldestTs?: string;
  includeMentions?: boolean;
  includeThreads?: boolean;
  onProgress?: (message: string) => void;
};

const DM_BACKFILL_LIMIT = 10;
const SLACK_PAGE_SIZE = 200;

function slackErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const data = (error as { data?: { error?: unknown } }).data;
    if (data && typeof data.error === 'string') return data.error;
  }
  return error instanceof Error ? error.message : String(error);
}

function tally(counts: BackfillCounts, outcome: UpsertOutcome): void {
  if (outcome === 'created') counts.created += 1;
  else counts.updated += 1;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function backfillUsers(
  client: WebClient,
  stats: BackfillStats,
  log: (message: string) => void,
): Promise<void> {
  let cursor: string | undefined;

  do {
    const page = await client.users.list({ limit: SLACK_PAGE_SIZE, cursor });
    for (const member of page.members ?? []) {
      tally(stats.users, await upsertUser(normalizeUser(member)));
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  log(`users: ${stats.users.created} new, ${stats.users.updated} refreshed`);
}

async function backfillConversationList(
  client: WebClient,
  stats: BackfillStats,
  log: (message: string) => void,
): Promise<NormalizedConversation[]> {
  const all: NormalizedConversation[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.conversations.list({
      types: 'im,mpim,private_channel,public_channel',
      exclude_archived: true,
      limit: SLACK_PAGE_SIZE,
      cursor,
    });

    for (const raw of page.channels ?? []) {
      const conversation = normalizeConversation(raw);
      tally(stats.conversations, await upsertConversation(conversation));
      stats.conversations.byKind[conversation.kind] =
        (stats.conversations.byKind[conversation.kind] ?? 0) + 1;
      all.push(conversation);
    }

    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  log(
    `conversations: ${all.length} total (` +
      Object.entries(stats.conversations.byKind)
        .map(([kind, count]) => `${kind}=${count}`)
        .join(', ') +
      ')',
  );
  return all;
}

async function backfillHistory(
  client: WebClient,
  conversationId: string,
  authedUserId: string,
  stats: BackfillStats,
  options: BackfillOptions,
): Promise<{ messages: RawSlackMessage[]; lastRead?: string }> {
  const unread: RawSlackMessage[] = [];
  let lastRead: string | undefined;

  try {
    const info = await client.conversations.info({ channel: conversationId });
    const conversation = info.channel as RawSlackConversation | undefined;
    lastRead = conversation?.last_read;
    const latestTs = conversation?.latest?.ts;
    const latestFromMe = conversation?.latest?.user === authedUserId;
    const hasUnread = latestFromMe
      ? false
      : conversation?.unread_count !== undefined
        ? conversation.unread_count > 0
        : latestTs && lastRead
          ? Number(latestTs) > Number(lastRead)
          : undefined;

    // `conversations.info` is Tier 3 and includes unread metadata for DMs.
    // Screen here so the much tighter `conversations.history` method is called
    // only for conversations that can actually add something to the inbox. A
    // latest message from the authed user means that conversation was already
    // answered, even when Slack leaves its unread_count above zero.
    if (hasUnread === false) return { messages: unread, lastRead };

    const page = await client.conversations.history({
      channel: conversationId,
      limit: DM_BACKFILL_LIMIT,
      oldest: options.oldestTs,
    });

    for (const raw of page.messages ?? []) {
      if (!raw.ts || (lastRead && Number(raw.ts) <= Number(lastRead))) continue;
      unread.push(raw);
      await ingestOne(raw, conversationId, stats, authedUserId);
    }

    await markConversationSynced(conversationId);
    stats.conversations.historyRead += 1;
  } catch (error) {
    stats.errors.push({
      conversationId,
      error: slackErrorCode(error),
    });
  }

  return { messages: unread, lastRead };
}

async function ingestOne(
  raw: RawSlackMessage,
  conversationId: string,
  stats: BackfillStats,
  authedUserId: string,
): Promise<void> {
  try {
    const message = normalizeMessage(raw, conversationId);
    tally(stats.messages, await upsertMessage(message, 'BACKFILL', authedUserId));
  } catch (error) {
    if (error instanceof NormalizationError) {
      stats.messages.skipped += 1;
      return;
    }
    throw error;
  }
}

async function backfillMentions(
  client: WebClient,
  authedUserId: string,
  stats: BackfillStats,
  log: (message: string) => void,
): Promise<void> {
  let page = 1;

  for (;;) {
    const result = await client.search.messages({
      query: `<@${authedUserId}>`,
      count: 100,
      page,
    });

    stats.mentions.searchTotal = result.messages?.total ?? 0;
    const matches = result.messages?.matches ?? [];

    for (const match of matches) {
      const rawChannel = match.channel as RawSlackConversation | undefined;
      const channelId = rawChannel?.id;
      const ts = match.ts;
      if (!channelId || !ts) continue;

      if (rawChannel) {
        tally(
          stats.conversations,
          await ensureConversationFromReference(normalizeConversation(rawChannel)),
        );
      }

      const full = await fetchSingleMessage(client, channelId, ts);
      await ingestOne(full ?? (match as RawSlackMessage), channelId, stats, authedUserId);
      stats.mentions.ingested += 1;
    }

    const pagination = result.messages?.pagination;
    if (!pagination || page >= (pagination.page_count ?? 1)) break;
    page += 1;
  }

  log(
    `mentions: ${stats.mentions.ingested} ingested of ${stats.mentions.searchTotal} reported by search`,
  );
}

async function fetchSingleMessage(
  client: WebClient,
  conversationId: string,
  ts: string,
): Promise<RawSlackMessage | null> {
  try {
    const result = await client.conversations.history({
      channel: conversationId,
      latest: ts,
      oldest: ts,
      inclusive: true,
      limit: 1,
    });
    return result.messages?.[0] ?? null;
  } catch {
    return null;
  }
}

async function backfillThreads(
  client: WebClient,
  parents: Array<{ conversationId: string; ts: string; oldestTs?: string }>,
  stats: BackfillStats,
  authedUserId: string,
  log: (message: string) => void,
): Promise<void> {
  for (const parent of parents) {
    stats.threads.parents += 1;
    let cursor: string | undefined;

    try {
      do {
        const page = await client.conversations.replies({
          channel: parent.conversationId,
          ts: parent.ts,
          oldest: parent.oldestTs,
          limit: SLACK_PAGE_SIZE,
          cursor,
        });

        for (const raw of page.messages ?? []) {
          await ingestOne(raw, parent.conversationId, stats, authedUserId);
          stats.threads.repliesFetched += 1;
        }

        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (error) {
      stats.errors.push({
        conversationId: parent.conversationId,
        error: `replies(${parent.ts}): ${slackErrorCode(error)}`,
      });
    }
  }

  if (parents.length > 0) {
    log(
      `threads: ${stats.threads.parents} parents, ${stats.threads.repliesFetched} messages fetched`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runBackfill(
  options: BackfillOptions = {},
): Promise<BackfillStats> {
  const log = options.onProgress ?? (() => {});
  const startedAt = new Date();
  const { client, authedUserId, teamId, teamName } = await getSlackContext();

  log(`backfilling as ${authedUserId} in ${teamName} (${teamId})`);

  const stats: BackfillStats = {
    teamId,
    authedUserId,
    users: { created: 0, updated: 0 },
    conversations: { created: 0, updated: 0, byKind: {}, historyRead: 0 },
    messages: { created: 0, updated: 0, skipped: 0 },
    threads: { parents: 0, repliesFetched: 0 },
    mentions: { searchTotal: 0, ingested: 0 },
    errors: [],
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
  };

  await backfillUsers(client, stats, log);
  const conversations = await backfillConversationList(client, stats, log);

  const direct = conversations.filter(
    (conversation) =>
      conversation.kind === 'IM' || conversation.kind === 'MPIM',
  );

  const threadParents: Array<{
    conversationId: string;
    ts: string;
    oldestTs?: string;
  }> = [];

  for (const conversation of direct) {
    const history = await backfillHistory(
      client,
      conversation.id,
      authedUserId,
      stats,
      options,
    );
    for (const raw of history.messages) {
      if (raw.thread_ts && raw.thread_ts === raw.ts && (raw.reply_count ?? 0) > 0) {
        threadParents.push({
          conversationId: conversation.id,
          ts: raw.ts,
          oldestTs: history.lastRead,
        });
      }
    }
  }

  log(
    `dm history: ${stats.messages.created} new, ${stats.messages.updated} refreshed, ` +
      `${stats.conversations.historyRead} unread conversations read`,
  );

  if (options.includeMentions !== false) {
    await backfillMentions(client, authedUserId, stats, log);
  }

  if (options.includeThreads !== false) {
    await backfillThreads(client, threadParents, stats, authedUserId, log);
  }

  const finishedAt = new Date();
  stats.finishedAt = finishedAt.toISOString();
  stats.durationMs = finishedAt.getTime() - startedAt.getTime();

  for (const failure of stats.errors) {
    log(`skipped ${failure.conversationId}: ${failure.error}`);
  }

  return stats;
}
