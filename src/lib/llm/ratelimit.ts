import { LlmError } from '@/lib/llm/client';

/**
 * Request pacing for Hack Club AI.
 *
 * The proxy allows **450 chat/embedding requests per 30 minutes** and answers
 * HTTP 429 past that (CLAUDE.md). Classification is per-message, so a real
 * backfill of a busy workspace would blow through that in under a minute if
 * nothing paced it — the connected workspace only has 8 messages today, but the
 * pipeline has to be written for the case where it does not.
 *
 * Two independent protections, because they fail differently:
 *  - a sliding-window limiter that refuses to *make* the 451st call, and
 *  - retry-with-backoff for the 429s that arrive anyway (another process
 *    sharing the key, or a window boundary we mis-estimated).
 *
 * `now`/`sleep` are injectable so the tests run in microseconds rather than
 * half an hour.
 */

export const HACKCLUB_REQUEST_LIMIT = 450;
export const HACKCLUB_WINDOW_MS = 30 * 60_000;

export type RateLimiterOptions = {
  maxRequests?: number;
  windowMs?: number;
  /**
   * Fraction of the published budget to actually spend. Leaves room for the
   * health check, a second process, and any request already in flight when the
   * window rolls.
   */
  safetyMargin?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type RateLimiter = {
  /** Resolves when it is safe to make one request. Records it as spent. */
  acquire: () => Promise<void>;
  /** Requests recorded inside the current window. */
  used: () => number;
  /** Requests still available in the current window. */
  remaining: () => number;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function createRateLimiter(
  options: RateLimiterOptions = {},
): RateLimiter {
  const {
    maxRequests = HACKCLUB_REQUEST_LIMIT,
    windowMs = HACKCLUB_WINDOW_MS,
    safetyMargin = 0.9,
    now = Date.now,
    sleep = defaultSleep,
  } = options;

  const capacity = Math.max(1, Math.floor(maxRequests * safetyMargin));
  /** Timestamps of recorded requests, oldest first. */
  const spent: number[] = [];

  function prune(at: number): void {
    while (spent.length > 0 && at - spent[0] >= windowMs) spent.shift();
  }

  return {
    async acquire() {
      // A loop, not an `if`: after sleeping, another caller may have taken the
      // slot we were waiting for.
      for (;;) {
        const at = now();
        prune(at);

        if (spent.length < capacity) {
          spent.push(at);
          return;
        }

        // +1ms so the oldest entry is strictly outside the window on waking.
        const waitMs = windowMs - (at - spent[0]) + 1;
        await sleep(Math.max(waitMs, 1));
      }
    },
    used() {
      prune(now());
      return spent.length;
    },
    remaining() {
      prune(now());
      return Math.max(0, capacity - spent.length);
    },
  };
}

export type RetryOptions = {
  /** Extra attempts after the first. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
};

/** Only a 429 is worth waiting out; a 400 will be a 400 again in ten seconds. */
function isRetryable(error: unknown): boolean {
  return error instanceof LlmError && error.isRateLimit;
}

/**
 * Run `fn`, backing off exponentially on rate-limit errors.
 *
 * Deliberately does not retry parse failures or 4xx — a malformed response is
 * a bug to see, not a transient to paper over.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    retries = 3,
    baseDelayMs = 2_000,
    maxDelayMs = 60_000,
    sleep = defaultSleep,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === retries) throw error;

      const delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      onRetry?.(attempt + 1, delayMs, error);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Run `tasks` with at most `concurrency` in flight, preserving input order in
 * the results. Each task's failure is captured rather than thrown, so one bad
 * response cannot poison a batch (the whole point of classifying in bulk).
 */
export async function runPooled<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<
    { ok: true; value: R } | { ok: false; error: unknown }
  > = new Array(items.length);
  let cursor = 0;

  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;

      try {
        results[index] = { ok: true, value: await task(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
