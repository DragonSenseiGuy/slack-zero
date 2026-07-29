import type { WebClient } from '@slack/web-api';

import { normalizeMessage } from '@/lib/slack/normalize';
import type { RawSlackMessage } from '@/lib/slack/raw';
import type { WaitingCandidate } from '@/lib/waiting/detect';

export type WaitingIdentity = {
  id: string;
  conversationId: string;
  ts: string;
  threadTs: string | null;
  isDeleted: boolean;
};

export type WaitingScanResult = {
  candidates: WaitingCandidate[];
  complete: boolean;
  errors: string[];
};
export const MAX_WAITING_SCAN_REQUESTS = 100;

/** Read every cursor in the requested history window and every known/relevant thread. */
export async function scanWaitingWindow(
  client: WebClient,
  rows: readonly WaitingIdentity[],
  since: Date,
): Promise<WaitingScanResult> {
  const identities = new Map(rows.map((row) => [`${row.conversationId}:${row.ts}`, row]));
  const rawByKey = new Map<string, RawSlackMessage>();
  const errors: string[] = [];
  const threadKeys = new Set(rows.filter((row) => row.threadTs).map((row) => `${row.conversationId}:${row.threadTs}`));
  let requests = 0;

  for (const conversationId of new Set(rows.map((row) => row.conversationId))) {
    let cursor: string | undefined;
    try {
      do {
        if (requests >= MAX_WAITING_SCAN_REQUESTS) { errors.push('WAITING_SCAN_BUDGET_EXHAUSTED'); break; }
        requests += 1;
        const page = await client.conversations.history({ channel: conversationId,
          oldest: String(since.getTime() / 1000), limit: 200, cursor });
        for (const raw of (page.messages as RawSlackMessage[] | undefined) ?? []) {
          if (!raw.ts) continue;
          rawByKey.set(`${conversationId}:${raw.ts}`, raw);
          if ((raw.reply_count ?? 0) > 0) threadKeys.add(`${conversationId}:${raw.thread_ts ?? raw.ts}`);
        }
        cursor = page.response_metadata?.next_cursor || undefined;
        if ((page as { has_more?: boolean }).has_more && !cursor) {
          errors.push(`history:${conversationId}:truncated without cursor`);
        }
      } while (cursor);
    } catch {
      errors.push(`history:${conversationId}:SLACK_READ_FAILED`);
    }
  }

  for (const key of threadKeys) {
    const separator = key.indexOf(':');
    const conversationId = key.slice(0, separator);
    const threadTs = key.slice(separator + 1);
    let cursor: string | undefined;
    try {
      do {
        if (requests >= MAX_WAITING_SCAN_REQUESTS) { errors.push('WAITING_SCAN_BUDGET_EXHAUSTED'); break; }
        requests += 1;
        const page = await client.conversations.replies({ channel: conversationId, ts: threadTs, limit: 200, cursor });
        for (const raw of (page.messages as RawSlackMessage[] | undefined) ?? []) {
          if (raw.ts) rawByKey.set(`${conversationId}:${raw.ts}`, raw);
        }
        cursor = page.response_metadata?.next_cursor || undefined;
        if ((page as { has_more?: boolean }).has_more && !cursor) {
          errors.push(`replies:${key}:truncated without cursor`);
        }
      } while (cursor);
    } catch {
      errors.push(`replies:${key}:SLACK_READ_FAILED`);
    }
  }

  const candidates: WaitingCandidate[] = [];
  for (const [key, raw] of rawByKey) {
    const identity = identities.get(key);
    if (!identity) continue;
    const live = normalizeMessage(raw, identity.conversationId);
    candidates.push({ id: identity.id, conversationId: identity.conversationId,
      userId: live.userId, text: live.text, sentAt: live.sentAt,
      threadTs: live.threadTs, isDeleted: identity.isDeleted,
      hasReactions: (live.reactions?.length ?? 0) > 0 });
  }
  candidates.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  return { candidates, complete: errors.length === 0, errors };
}
