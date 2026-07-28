import { LlmError } from '@/lib/llm/client';

export const HACKCLUB_REQUEST_LIMIT = 450;
export const HACKCLUB_WINDOW_MS = 30 * 60_000;

export type RateLimiterOptions = {
  maxRequests?: number;
  windowMs?: number;
  safetyMargin?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type RateLimiter = {
  acquire: () => Promise<void>;
  used: () => number;
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
  const spent: number[] = [];

  function prune(at: number): void {
    while (spent.length > 0 && at - spent[0] >= windowMs) spent.shift();
  }

  return {
    async acquire() {
      for (;;) {
        const at = now();
        prune(at);

        if (spent.length < capacity) {
          spent.push(at);
          return;
        }

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
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
};

function isRetryable(error: unknown): boolean {
  return error instanceof LlmError && error.isRateLimit;
}

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
