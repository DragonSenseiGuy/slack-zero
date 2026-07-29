import { isLlmConfigured } from '@/lib/env';
import { prisma } from '@/lib/db';
import { createRateLimiter, type RateLimiter } from '@/lib/llm/ratelimit';
import { classifyOne, loadTriageLookup, type TriageLookup } from '@/lib/triage/pipeline';

/**
 * Fire-and-forget classification for messages that have just been ingested.
 *
 * CLAUDE.md is explicit that classification must never block ingestion, so this
 * is the only shape it can take at the ingest boundary: `scheduleClassification`
 * returns immediately, never throws, and never awaits anything. A message is
 * committed to Postgres first and classified afterwards; if the classifier is
 * down, misconfigured, or rate limited, ingestion is unaffected and the message
 * is simply picked up later by `npm run classify`.
 *
 * The drain loop is serial on purpose. Live traffic arrives a message at a time
 * and the limiter is a shared 450-per-30-minutes budget — there is nothing to
 * gain from parallelism here, and a serial loop makes the ordering predictable
 * (a bump is classified after the message it bumps, so its context is complete).
 */

const pending = new Set<string>();
let draining = false;
let lookup: TriageLookup | null = null;
let limiter: RateLimiter | null = null;

export type SchedulerOptions = {
  onLog?: (message: string) => void;
};

let log: (message: string) => void = () => {};

export function configureClassificationScheduler(
  options: SchedulerOptions,
): void {
  log = options.onLog ?? (() => {});
}

/** Test/dev helper: drop queued work and the memoized directory lookup. */
export function resetClassificationScheduler(): void {
  pending.clear();
  draining = false;
  lookup = null;
  limiter = null;
}

export function pendingClassificationCount(): number {
  return pending.size;
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;

  try {
    while (pending.size > 0) {
      const [messageId] = pending;
      pending.delete(messageId);

      try {
        // Refreshed lazily: a new sender's name should be usable without a
        // process restart, but re-reading the directory per message would be
        // a query per ingested message for no benefit.
        lookup ??= await loadTriageLookup();
        limiter ??= createRateLimiter();

        const result = await classifyOne(messageId, lookup, {
          rateLimiter: limiter,
        });

        log(
          result === null
            ? `classify skipped ${messageId} (gone or empty)`
            : `classified ${messageId}: ${result.category} ${result.urgencyScore} (${result.reasonCode})`,
        );
      } catch {
        // Never rethrow: this runs detached from any request, so an unhandled
        // rejection here would take the socket listener down with it.
        log(`CLASSIFICATION_FAILED message=${messageId}`);
        // Drop it rather than retrying in a tight loop. The row still has no
        // Classification, so the next `npm run classify` picks it up.
        lookup = null;
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Queue a message for classification. Returns synchronously, always.
 *
 * No-ops when no LLM key is configured, so the app (and the e2e suite) runs
 * fine without one.
 */
export function scheduleClassification(messageId: string): void {
  if (!messageId) return;

  try {
    if (!isLlmConfigured()) return;
  } catch {
    // A malformed environment must not break ingestion either.
    return;
  }

  pending.add(messageId);
  void drain();
}

/**
 * Same, addressed the way an ingest result is: by Slack identity rather than
 * by our internal id. Resolves the id in the background.
 */
export function scheduleClassificationForSlackMessage(
  conversationId: string,
  ts: string,
): void {
  try {
    if (!isLlmConfigured()) return;
  } catch {
    return;
  }

  void prisma.message
    .findUnique({
      where: { conversationId_ts: { conversationId, ts } },
      select: { id: true },
    })
    .then((message) => {
      if (message) scheduleClassification(message.id);
    })
    .catch(() => {
      log(`CLASSIFICATION_FAILED conversation=${conversationId} ts=${ts}`);
    });
}

/** Await the in-flight queue. For scripts and tests only. */
export async function drainClassificationQueue(): Promise<void> {
  await drain();
}
