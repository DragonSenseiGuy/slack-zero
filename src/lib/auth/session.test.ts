import { describe, expect, it } from 'vitest';

import {
  createSession,
  DEFAULT_SESSION_TTL_MS,
  verifySession,
} from '@/lib/auth/session';

const SECRET = 'test-session-secret';
const NOW = 1_700_000_000_000;

async function token(overrides: { now?: number } = {}) {
  return createSession(
    { teamId: 'T123', userId: 'U456' },
    SECRET,
    { now: overrides.now ?? NOW },
  );
}

describe('createSession', () => {
  it('round-trips the Slack identity', async () => {
    const result = await verifySession({
      token: await token(),
      secret: SECRET,
      now: NOW,
    });

    expect(result).toEqual({
      valid: true,
      session: { teamId: 'T123', userId: 'U456' },
      issuedAt: NOW,
    });
  });

  it('is deterministic for the same payload and secret', async () => {
    expect(await token()).toBe(await token());
  });

  it('refuses an empty secret', async () => {
    await expect(
      createSession({ teamId: 'T1', userId: 'U1' }, ''),
    ).rejects.toThrow(/secret is required/);
  });

  it('refuses ids containing the field separator', async () => {
    await expect(
      createSession({ teamId: 'T1.T2', userId: 'U1' }, SECRET),
    ).rejects.toThrow(/must not contain/);
  });
});

describe('verifySession', () => {
  it('rejects a missing token', async () => {
    const result = await verifySession({ token: null, secret: SECRET });
    expect(result).toEqual({ valid: false, reason: 'missing' });
  });

  it('rejects a token signed with a different secret', async () => {
    const result = await verifySession({
      token: await token(),
      secret: 'some-other-secret',
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a tampered user id', async () => {
    const parts = (await token()).split('.');
    parts[2] = 'UEVIL';

    const result = await verifySession({
      token: parts.join('.'),
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a token past its TTL', async () => {
    const result = await verifySession({
      token: await token(),
      secret: SECRET,
      now: NOW + DEFAULT_SESSION_TTL_MS + 1,
    });
    expect(result).toEqual({ valid: false, reason: 'expired' });
  });

  it('rejects a token from beyond clock skew in the future', async () => {
    const result = await verifySession({
      token: await token({ now: NOW + DEFAULT_SESSION_TTL_MS + 1 }),
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: 'expired' });
  });

  it.each([
    ['not-a-token'],
    ['v1.T1.U1.123'],
    ['v2.T1.U1.123.sig'],
    ['v1..U1.123.sig'],
    ['v1.T1.U1.notanumber.sig'],
  ])('rejects malformed token %s', async (value) => {
    const result = await verifySession({
      token: value,
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(false);
  });

  it('does not accept an OAuth state signed with the same secret', async () => {
    // The `session:` domain prefix is what makes this true; without it a state
    // value and a session value would be interchangeable.
    const { createState } = await import('@/lib/slack/oauth-state');
    const state = createState(SECRET, { now: NOW });

    const result = await verifySession({
      token: state,
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(false);
  });
});
