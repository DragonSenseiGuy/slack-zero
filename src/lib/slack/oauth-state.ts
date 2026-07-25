import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * CSRF protection for the Slack OAuth round-trip.
 *
 * The `state` we hand to Slack is `<nonce>.<issuedAtMs>.<hmac>`, where the HMAC
 * covers `<nonce>.<issuedAtMs>` keyed by SLACK_STATE_SECRET. On callback we
 * re-derive the HMAC, compare in constant time, and enforce a short TTL.
 *
 * The same value is also set in an httpOnly cookie and must match on the way
 * back, so a valid-but-stolen state from another browser is still rejected.
 */

/** Slack allows a large state; keep ours well inside any limit. */
const NONCE_BYTES = 24;

/** OAuth round-trips are interactive and quick. 10 minutes is generous. */
export const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

export const STATE_COOKIE_NAME = 'slackzero_oauth_state';

export type CreateStateOptions = {
  /** Injectable clock, for tests. */
  now?: number;
};

/** Mint a fresh signed state value. */
export function createState(
  secret: string,
  options: CreateStateOptions = {},
): string {
  if (!secret) {
    throw new Error('createState: a non-empty state secret is required');
  }

  const nonce = randomBytes(NONCE_BYTES).toString('base64url');
  const issuedAt = options.now ?? Date.now();
  const payload = `${nonce}.${issuedAt}`;

  return `${payload}.${sign(secret, payload)}`;
}

export type StateVerificationFailure =
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'mismatch';

export type StateVerificationResult =
  | { valid: true; issuedAt: number }
  | { valid: false; reason: StateVerificationFailure };

export type VerifyStateOptions = {
  /** State echoed back by Slack in the query string. */
  received: string | null | undefined;
  /** State we stashed in the httpOnly cookie when the flow started. */
  expected: string | null | undefined;
  secret: string;
  now?: number;
  ttlMs?: number;
};

/**
 * Validate a state value from the OAuth callback.
 *
 * Checks, in order: both values present, they match each other, the format is
 * right, the HMAC verifies, and it hasn't expired.
 */
export function verifyState(
  options: VerifyStateOptions,
): StateVerificationResult {
  const { received, expected, secret } = options;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_STATE_TTL_MS;

  if (!received || !expected) {
    return { valid: false, reason: 'missing' };
  }

  if (!constantTimeEquals(received, expected)) {
    return { valid: false, reason: 'mismatch' };
  }

  const parts = received.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed' };
  }

  const [nonce, issuedAtRaw, signature] = parts;
  if (!nonce || !issuedAtRaw || !signature) {
    return { valid: false, reason: 'malformed' };
  }

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) {
    return { valid: false, reason: 'malformed' };
  }

  const expectedSignature = sign(secret, `${nonce}.${issuedAtRaw}`);
  if (!constantTimeEquals(signature, expectedSignature)) {
    return { valid: false, reason: 'bad_signature' };
  }

  // Reject both stale states and ones minted "in the future" beyond clock skew.
  const age = now - issuedAt;
  if (age > ttlMs || age < -ttlMs) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, issuedAt };
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
