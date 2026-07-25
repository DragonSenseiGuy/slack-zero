import { describe, expect, it } from 'vitest';

import {
  createState,
  DEFAULT_STATE_TTL_MS,
  verifyState,
} from '@/lib/slack/oauth-state';

const SECRET = 'test-state-secret';

describe('createState', () => {
  it('produces a three-part nonce.issuedAt.signature value', () => {
    const state = createState(SECRET, { now: 1_700_000_000_000 });
    const parts = state.split('.');

    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe('1700000000000');
    expect(parts[0]!.length).toBeGreaterThan(20);
    expect(parts[2]!.length).toBeGreaterThan(20);
  });

  it('is unguessable — two calls at the same instant differ', () => {
    const now = 1_700_000_000_000;
    expect(createState(SECRET, { now })).not.toBe(createState(SECRET, { now }));
  });

  it('refuses to sign with an empty secret', () => {
    expect(() => createState('')).toThrow(/state secret/);
  });
});

describe('verifyState', () => {
  it('accepts a freshly minted state', () => {
    const now = 1_700_000_000_000;
    const state = createState(SECRET, { now });

    expect(
      verifyState({ received: state, expected: state, secret: SECRET, now }),
    ).toEqual({ valid: true, issuedAt: now });
  });

  it('rejects a missing state from either side', () => {
    const state = createState(SECRET);

    expect(
      verifyState({ received: null, expected: state, secret: SECRET }),
    ).toEqual({ valid: false, reason: 'missing' });

    expect(
      verifyState({ received: state, expected: undefined, secret: SECRET }),
    ).toEqual({ valid: false, reason: 'missing' });

    expect(
      verifyState({ received: '', expected: '', secret: SECRET }),
    ).toEqual({ valid: false, reason: 'missing' });
  });

  it('rejects a state that does not match the cookie (CSRF)', () => {
    const fromAttacker = createState(SECRET);
    const fromCookie = createState(SECRET);

    expect(
      verifyState({
        received: fromAttacker,
        expected: fromCookie,
        secret: SECRET,
      }),
    ).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rejects a malformed state', () => {
    expect(
      verifyState({
        received: 'not-a-state',
        expected: 'not-a-state',
        secret: SECRET,
      }),
    ).toEqual({ valid: false, reason: 'malformed' });

    expect(
      verifyState({
        received: 'nonce.notanumber.sig',
        expected: 'nonce.notanumber.sig',
        secret: SECRET,
      }),
    ).toEqual({ valid: false, reason: 'malformed' });
  });

  it('rejects a tampered signature', () => {
    const now = 1_700_000_000_000;
    const [nonce, issuedAt] = createState(SECRET, { now }).split('.');
    const forged = `${nonce}.${issuedAt}.${'a'.repeat(43)}`;

    expect(
      verifyState({ received: forged, expected: forged, secret: SECRET, now }),
    ).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a state signed with a different secret', () => {
    const now = 1_700_000_000_000;
    const state = createState('some-other-secret', { now });

    expect(
      verifyState({ received: state, expected: state, secret: SECRET, now }),
    ).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a state older than the TTL', () => {
    const issuedAt = 1_700_000_000_000;
    const state = createState(SECRET, { now: issuedAt });

    expect(
      verifyState({
        received: state,
        expected: state,
        secret: SECRET,
        now: issuedAt + DEFAULT_STATE_TTL_MS + 1,
      }),
    ).toEqual({ valid: false, reason: 'expired' });
  });

  it('still accepts a state right at the TTL boundary', () => {
    const issuedAt = 1_700_000_000_000;
    const state = createState(SECRET, { now: issuedAt });

    expect(
      verifyState({
        received: state,
        expected: state,
        secret: SECRET,
        now: issuedAt + DEFAULT_STATE_TTL_MS,
      }).valid,
    ).toBe(true);
  });

  it('rejects a state issued implausibly far in the future', () => {
    const issuedAt = 1_700_000_000_000;
    const state = createState(SECRET, { now: issuedAt });

    expect(
      verifyState({
        received: state,
        expected: state,
        secret: SECRET,
        now: issuedAt - DEFAULT_STATE_TTL_MS - 1,
      }),
    ).toEqual({ valid: false, reason: 'expired' });
  });

  it('honours a custom TTL', () => {
    const issuedAt = 1_700_000_000_000;
    const state = createState(SECRET, { now: issuedAt });

    expect(
      verifyState({
        received: state,
        expected: state,
        secret: SECRET,
        now: issuedAt + 2_000,
        ttlMs: 1_000,
      }),
    ).toEqual({ valid: false, reason: 'expired' });
  });
});
