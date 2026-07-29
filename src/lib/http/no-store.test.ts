import { afterEach, describe, expect, it, vi } from 'vitest';

import { noStoreFetch } from '@/lib/http/no-store';

/**
 * Cheap, but it guards a real production incident: Next was trying to spool
 * every Slack response — and the OAuth token exchange — into
 * `.next/cache/fetch-cache`, and only a filesystem permission error stopped it.
 */
describe('noStoreFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forces cache: no-store', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', spy);

    await noStoreFetch('https://slack.com/api/auth.test');

    expect(spy).toHaveBeenCalledWith('https://slack.com/api/auth.test', {
      cache: 'no-store',
    });
  });

  it('keeps the caller’s init and cannot be overridden back to a cached mode', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', spy);

    await noStoreFetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: 'Bearer xoxp-redacted' },
      cache: 'force-cache',
    });

    expect(spy).toHaveBeenCalledWith('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: 'Bearer xoxp-redacted' },
      cache: 'no-store',
    });
  });
});
