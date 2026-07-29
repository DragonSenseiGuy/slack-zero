/**
 * A `fetch` that Next.js will not cache.
 *
 * Next patches `globalThis.fetch` in the App Router and, by default, writes
 * successful responses into its on-disk data cache
 * (`.next/cache/fetch-cache`). Every outbound call this app makes goes through
 * that patched fetch: `@slack/web-api` v8 dropped axios and uses global fetch,
 * and so do `openai` and the LLM ping.
 *
 * That default is wrong for us twice over:
 *
 * 1. **Privacy.** The cached bodies are Slack API responses — message text,
 *    user profiles, conversation lists — and the OAuth token exchange, whose
 *    body contains the plaintext `xoxp-` token. Phase 9 went to real trouble to
 *    keep Slack content out of Postgres and to encrypt tokens at rest; silently
 *    spooling both to disk in the container undoes it. See PRIVACY_MIGRATION.md.
 * 2. **Correctness.** These are per-request, token-bearing calls against a
 *    mutable workspace. A replayed response is a stale inbox.
 *
 * `cache: 'no-store'` makes Next skip the cache read *and* the write, so no
 * entry is created and nothing lands on disk.
 */

/** Matches the `fetch` shape `@slack/web-api` and `openai` accept. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const noStoreFetch: FetchLike = (input, init) =>
  fetch(input, { ...init, cache: 'no-store' });
