import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  SESSION_COOKIE_NAME,
  verifySession,
  type SessionPayload,
} from '@/lib/auth/session';
import { getEnv } from '@/lib/env';
import { getOwnerIdentity } from '@/lib/slack/installation';

/**
 * The authorization boundary. Every page, route handler, and server action
 * that reads Slack data or acts with the stored token must go through here.
 *
 * `src/middleware.ts` also turns anonymous requests away, but it runs on the
 * edge and cannot reach the database, so it can only check that a cookie is
 * present. The authoritative check — signature, expiry, and "is this still the
 * owner" — happens here, in the Node runtime, at the point of use. Treat the
 * middleware as a redirect for humans, not as the gate.
 */

export class UnauthorizedError extends Error {
  constructor(readonly reason: string) {
    super(`Not signed in as the SlackZero owner (${reason}).`);
    this.name = 'UnauthorizedError';
  }
}

/** The signed-in owner, or null. Never throws on an anonymous request. */
export async function getOwnerSession(): Promise<SessionPayload | null> {
  const secret = getEnv().SLACK_STATE_SECRET;
  if (!secret) return null;

  const token = cookies().get(SESSION_COOKIE_NAME)?.value;
  const result = await verifySession({ token, secret });
  if (!result.valid) return null;

  // A valid signature is not enough: the owner can change (SLACK_OWNER_USER_ID
  // is edited, the installation is wiped and reconnected), and an old cookie
  // must not outlive that.
  const owner = await getOwnerIdentity();
  if (!owner || owner.authedUserId !== result.session.userId) {
    return null;
  }

  return result.session;
}

/**
 * Guard for server actions and route handlers.
 *
 * @throws {UnauthorizedError}
 */
export async function requireOwnerSession(): Promise<SessionPayload> {
  const session = await getOwnerSession();
  if (!session) {
    throw new UnauthorizedError('no valid session');
  }
  return session;
}

/** Guard for pages: bounce anonymous visitors to the connect screen. */
export async function requireOwnerPage(): Promise<SessionPayload> {
  const session = await getOwnerSession();
  if (!session) {
    redirect('/?signed_out=1');
  }
  return session;
}
