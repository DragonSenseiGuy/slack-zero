export class BoundedTtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  constructor(
    private readonly maximum: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maximum) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: K): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}

import type { RawSlackConversation, RawSlackMessage, RawSlackUser } from '@/lib/slack/raw';

export type SlackMessageCacheEntry = {
  raw: RawSlackMessage;
  /** Database message revision validated when this Slack payload was fetched. */
  revisionMs: number;
};

export const slackMessageCache = new BoundedTtlCache<string, SlackMessageCacheEntry>(1000, 60_000);
export const slackUserCache = new BoundedTtlCache<string, RawSlackUser>(500, 60_000);
export const slackConversationCache = new BoundedTtlCache<string, RawSlackConversation>(500, 60_000);
export const messageCacheKey = (conversationId: string, ts: string): string => `${conversationId}:${ts}`;
