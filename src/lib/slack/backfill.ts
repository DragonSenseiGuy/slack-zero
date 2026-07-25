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

/**
 * Initial backfill: pull the authed user's DMs, group DMs, and channel
 * mentions into the DB.
 *
 * Scope is exactly plan.md's Phase 1 wording — "recent DMs, mpims, and channel
 * mentions for the authed user" — *not* the full history of every channel in
 * the workspace. Concretely:
 *
 *   1. `users.list`           → a `User` row per workspace member
 *   2. `conversations.list`   → a `Conversation` row per DM/mpim/channel
 *   3. `conversations.history`→ messages, for IMs and mpims only
 *   4. `search.messages`      → channel messages that mention the authed user
 *   5. `conversations.replies`→ replies under any thread parent we ingested
 *
 * Classification is not called from here, per CLAUDE.md: ingestion must never
 * block on the LLM. That is Phase 3's job.
 */

/** A conversation Slack refused to give us; recorded rather than thrown. */
export type ConversationSyncError = {
  conversationId: string;
  /** Slack's error code, e.g. "channel_not_found". */
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
    /** Payloads that could not be normalized (no `ts`); counted, not fatal. */
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
  /**
   * Max messages to pull per conversation. Slack caps a single page at 1000;
   * this bounds the total across pages.
   */
  messagesPerConversation?: number;
  /** Oldest Slack ts to fetch. Omit for "everything available". */
  oldestTs?: string;
  /** Include the `search.messages` mention pass. */
  includeMentions?: boolean;
  /** Include the `conversations.replies` thread pass. */
  includeThreads?: boolean;
  /** Progress sink. Defaults to a no-op so library use stays silent. */
  onProgress?: (message: string) => void;
};

const DEFAULT_MESSAGES_PER_CONVERSATION = 500;
const SLACK_PAGE_SIZE = 200;

/** Slack error code from a thrown `WebAPIPlatformError`, if it has one. */
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

/**
 * Pull one conversation's history.
 *
 * A Slack failure here is recorded and skipped, not rethrown: the Slackbot DM,
 * for instance, is returned by `conversations.list` but answers
 * `channel_not_found` to `conversations.history`, and one such quirk must not
 * abort the whole backfill.
 */
async function backfillHistory(
  client: WebClient,
  conversationId: string,
  stats: BackfillStats,
  options: BackfillOptions,
): Promise<RawSlackMessage[]> {
  const limit =
    options.messagesPerConversation ?? DEFAULT_MESSAGES_PER_CONVERSATION;
  const collected: RawSlackMessage[] = [];
  let cursor: string | undefined;

  try {
    do {
      const page = await client.conversations.history({
        channel: conversationId,
        limit: Math.min(SLACK_PAGE_SIZE, limit - collected.length),
        cursor,
        oldest: options.oldestTs,
      });

      for (const raw of page.messages ?? []) {
        collected.push(raw);
        await ingestOne(raw, conversationId, stats);
      }

      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor && collected.length < limit);

    await markConversationSynced(conversationId);
    stats.conversations.historyRead += 1;
  } catch (error) {
    stats.errors.push({
      conversationId,
      error: slackErrorCode(error),
    });
  }

  return collected;
}

/** Normalize + persist one raw message, counting the outcome. */
async function ingestOne(
  raw: RawSlackMessage,
  conversationId: string,
  stats: BackfillStats,
): Promise<void> {
  try {
    const message = normalizeMessage(raw, conversationId);
    tally(stats.messages, await upsertMessage(message, 'BACKFILL'));
  } catch (error) {
    if (error instanceof NormalizationError) {
      stats.messages.skipped += 1;
      return;
    }
    throw error;
  }
}

/**
 * Channel messages that mention the authed user.
 *
 * `search.messages` is user-token only (hence the `search:read` scope) and
 * returns a thinner message object than `conversations.history` — no blocks,
 * no reactions. So each hit is re-fetched from history at its exact `ts` to get
 * the full record, falling back to the search hit if that read is not allowed.
 */
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
        // `ensure...FromReference`, not `upsert...`: `search.messages` omits
        // `is_member`/`is_archived`/topic, so a plain upsert would overwrite
        // what `conversations.list` already established with defaults.
        tally(
          stats.conversations,
          await ensureConversationFromReference(normalizeConversation(rawChannel)),
        );
      }

      const full = await fetchSingleMessage(client, channelId, ts);
      await ingestOne(full ?? (match as RawSlackMessage), channelId, stats);
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

/** One message by exact ts, or null if it cannot be read. */
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

/** Fetch replies for every thread parent we saw. */
async function backfillThreads(
  client: WebClient,
  parents: Array<{ conversationId: string; ts: string }>,
  stats: BackfillStats,
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
          limit: SLACK_PAGE_SIZE,
          cursor,
        });

        for (const raw of page.messages ?? []) {
          // The parent comes back in this list too; the upsert makes that a
          // no-op refresh rather than a duplicate.
          await ingestOne(raw, parent.conversationId, stats);
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

  // DMs and group DMs only — see the scope note at the top of this file.
  const direct = conversations.filter(
    (conversation) =>
      conversation.kind === 'IM' || conversation.kind === 'MPIM',
  );

  const threadParents: Array<{ conversationId: string; ts: string }> = [];

  for (const conversation of direct) {
    const messages = await backfillHistory(
      client,
      conversation.id,
      stats,
      options,
    );
    for (const raw of messages) {
      if (raw.thread_ts && raw.thread_ts === raw.ts && (raw.reply_count ?? 0) > 0) {
        threadParents.push({ conversationId: conversation.id, ts: raw.ts });
      }
    }
  }

  log(
    `dm history: ${stats.messages.created} new, ${stats.messages.updated} refreshed, ` +
      `${stats.conversations.historyRead}/${direct.length} conversations read`,
  );

  if (options.includeMentions !== false) {
    await backfillMentions(client, authedUserId, stats, log);
  }

  if (options.includeThreads !== false) {
    await backfillThreads(client, threadParents, stats, log);
  }

  const finishedAt = new Date();
  stats.finishedAt = finishedAt.toISOString();
  stats.durationMs = finishedAt.getTime() - startedAt.getTime();

  for (const failure of stats.errors) {
    log(`skipped ${failure.conversationId}: ${failure.error}`);
  }

  return stats;
}
