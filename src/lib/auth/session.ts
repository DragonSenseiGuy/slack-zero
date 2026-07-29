/**
 * Signed session tokens proving "this browser is the Slack user who installed
 * the app".
 *
 * Until now the app had no notion of a caller at all: every page and action
 * resolved identity as `getInstallation()` — the most recently updated row —
 * so anyone who could reach the URL acted with the stored user token. That was
 * survivable for a localhost tool and stopped being survivable once the app
 * shipped in a production image.
 *
 * The token is `v1.<teamId>.<userId>.<issuedAtMs>.<hmac>`, HMAC-SHA256 over
 * the payload with a `session:` domain prefix so a session value can never be
 * confused with an OAuth `state` value signed by the same secret.
 *
 * Web Crypto rather than `node:crypto` on purpose: `src/middleware.ts` runs on
 * the edge runtime and cannot import Node builtins. That makes sign/verify
 * async, which is why every caller awaits.
 */

/** Sessions are long-lived; this is a personal tool, not a bank. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME = 'slackzero_session';

const VERSION = 'v1';

/** Keeps session HMACs disjoint from OAuth-state HMACs under one secret. */
const DOMAIN = 'session:';

export type SessionPayload = {
  teamId: string;
  userId: string;
};

export type CreateSessionOptions = {
  /** Injectable clock, for tests. */
  now?: number;
};

/** Mint a signed session token for an authenticated Slack user. */
export async function createSession(
  payload: SessionPayload,
  secret: string,
  options: CreateSessionOptions = {},
): Promise<string> {
  if (!secret) {
    throw new Error('createSession: a non-empty session secret is required');
  }
  if (!payload.teamId || !payload.userId) {
    throw new Error('createSession: teamId and userId are required');
  }
  // Slack ids are `[A-Z0-9]`, so a separator collision cannot happen — but an
  // unchecked one would let a crafted id forge a different payload split.
  if (payload.teamId.includes('.') || payload.userId.includes('.')) {
    throw new Error('createSession: Slack ids must not contain "."');
  }

  const issuedAt = options.now ?? Date.now();
  const body = `${VERSION}.${payload.teamId}.${payload.userId}.${issuedAt}`;

  return `${body}.${await sign(secret, body)}`;
}

export type SessionVerificationFailure =
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'expired';

export type SessionVerificationResult =
  | { valid: true; session: SessionPayload; issuedAt: number }
  | { valid: false; reason: SessionVerificationFailure };

export type VerifySessionOptions = {
  token: string | null | undefined;
  secret: string;
  now?: number;
  ttlMs?: number;
};

/**
 * Validate a session cookie value.
 *
 * This proves only that *we* minted the token and it hasn't expired. It does
 * not prove the user is still the owner — that check reads the database and
 * lives in `requireOwnerSession()`, which cannot run on the edge.
 */
export async function verifySession(
  options: VerifySessionOptions,
): Promise<SessionVerificationResult> {
  const { token, secret } = options;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;

  if (!token || !secret) {
    return { valid: false, reason: 'missing' };
  }

  const parts = token.split('.');
  if (parts.length !== 5) {
    return { valid: false, reason: 'malformed' };
  }

  const [version, teamId, userId, issuedAtRaw, signature] = parts;
  if (version !== VERSION || !teamId || !userId || !issuedAtRaw || !signature) {
    return { valid: false, reason: 'malformed' };
  }

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) {
    return { valid: false, reason: 'malformed' };
  }

  const body = `${version}.${teamId}.${userId}.${issuedAtRaw}`;
  const expected = await sign(secret, body);
  if (!constantTimeEquals(signature, expected)) {
    return { valid: false, reason: 'bad_signature' };
  }

  // Reject stale tokens and ones minted "in the future" beyond clock skew.
  const age = now - issuedAt;
  if (age > ttlMs || age < -ttlMs) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, session: { teamId, userId }, issuedAt };
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${DOMAIN}${payload}`),
  );
  return base64url(new Uint8Array(mac));
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Length-independent equality; no `node:crypto` on the edge runtime. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
