import { describe, expect, it } from 'vitest';

import { describeSlackError } from '@/lib/slack/errors';

/**
 * plan.md, Phase 8: rate-limit handling and error surfacing.
 *
 * The classification matters more than it looks: `retryable` decides whether
 * the UI offers "try again" or tells the user to go fix something, and getting
 * that backwards wastes their time in both directions.
 */

/** Shaped like a real `@slack/web-api` error. */
function slackError(
  code: string,
  extras: Record<string, unknown> = {},
): unknown {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    data: { ok: false, error: code },
    ...extras,
  });
}

describe('describeSlackError — rate limiting', () => {
  it('recognizes a rate limit and marks it retryable', () => {
    const failure = describeSlackError(slackError('ratelimited'));

    expect(failure.kind).toBe('rate_limited');
    expect(failure.retryable).toBe(true);
    expect(failure.message).toMatch(/rate limiting/i);
  });

  it('includes the wait when Slack says how long', () => {
    const failure = describeSlackError(
      slackError('ratelimited', { retryAfter: 30 }),
    );

    expect(failure.retryAfterSeconds).toBe(30);
    expect(failure.message).toContain('30s');
  });

  it('reads Retry-After from headers too', () => {
    const failure = describeSlackError(
      slackError('ratelimited', { headers: { 'retry-after': '12' } }),
    );

    expect(failure.retryAfterSeconds).toBe(12);
  });

  it('rounds a fractional wait up rather than saying 0s', () => {
    const failure = describeSlackError(
      slackError('ratelimited', { retryAfter: 0.4 }),
    );
    expect(failure.message).toContain('1s');
  });
});

describe('describeSlackError — permanent failures', () => {
  it('treats a permission problem as not retryable', () => {
    // Offering "try again" here would make the user click forever.
    for (const code of ['not_in_channel', 'is_archived', 'restricted_action']) {
      const failure = describeSlackError(slackError(code));
      expect(failure.kind, code).toBe('permission');
      expect(failure.retryable, code).toBe(false);
    }
  });

  it('tells the user to re-connect when a scope is missing', () => {
    const failure = describeSlackError(slackError('missing_scope'));
    expect(failure.kind).toBe('permission');
    expect(failure.message).toMatch(/re-connect/i);
  });

  it('treats a revoked token as an auth problem, not a transient one', () => {
    for (const code of ['invalid_auth', 'token_revoked', 'account_inactive']) {
      const failure = describeSlackError(slackError(code));
      expect(failure.kind, code).toBe('auth');
      expect(failure.retryable, code).toBe(false);
      expect(failure.message, code).toMatch(/re-connect/i);
    }
  });

  it('points at the backfill when something no longer exists', () => {
    const failure = describeSlackError(slackError('channel_not_found'));
    expect(failure.kind).toBe('not_found');
    expect(failure.retryable).toBe(false);
    expect(failure.message).toMatch(/backfill/i);
  });
});

describe('describeSlackError — transport', () => {
  it('recognizes network failures as retryable', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'fetch failed']) {
      const failure = describeSlackError(new Error(code));
      expect(failure.kind, code).toBe('network');
      expect(failure.retryable, code).toBe(true);
    }
  });
});

describe('describeSlackError — fallbacks', () => {
  it('defaults to retryable for an unrecognised code', () => {
    // An unknown code is more likely transient than permanent, and telling the
    // user "this will never work" when it might is the worse mistake.
    const failure = describeSlackError(slackError('some_new_slack_code'));

    expect(failure.kind).toBe('unknown');
    expect(failure.retryable).toBe(true);
    expect(failure.message).toContain('some_new_slack_code');
  });

  it('handles a bare string code', () => {
    expect(describeSlackError('ratelimited').kind).toBe('rate_limited');
  });

  it('handles null, undefined and an empty object without throwing', () => {
    for (const value of [null, undefined, {}, 0]) {
      const failure = describeSlackError(value);
      expect(failure.kind).toBe('unknown');
      expect(failure.message.length).toBeGreaterThan(0);
    }
  });

  it('never returns an empty message', () => {
    for (const value of [null, new Error(''), slackError('')]) {
      expect(describeSlackError(value).message.trim()).not.toBe('');
    }
  });
});
