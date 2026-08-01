import { NextResponse, type NextRequest } from 'next/server';

import {
  createSession,
  DEFAULT_SESSION_TTL_MS,
  SESSION_COOKIE_NAME,
} from '@/lib/auth/session';
import { DemoUnavailableError, requireDemoAvailable } from '@/lib/demo/guard';
import { DEMO_OWNER_USER_ID, DEMO_TEAM_ID } from '@/lib/demo/workspace';
import { getEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/demo/signin
 *
 * Signs the visitor in as the demo owner, so the seeded fake workspace can be
 * browsed without a Slack app. This is the one door into the app that Slack
 * does not guard, so it is bolted shut in three ways: `SLACKZERO_DEMO=1` must
 * be set, the database must hold no real Slack installation
 * (`src/lib/demo/guard.ts`), and the session it mints names the demo owner —
 * an id no real workspace can issue.
 *
 * POST-only, so a prefetch or link preview cannot silently start a session.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await requireDemoAvailable();
  } catch (error) {
    if (error instanceof DemoUnavailableError) {
      return NextResponse.json(
        { error: 'demo_unavailable', reason: error.reason, message: error.message },
        { status: 404 },
      );
    }
    throw error;
  }

  const secret = getEnv().SLACK_STATE_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        error: 'missing_session_secret',
        message:
          'SLACK_STATE_SECRET must be set — it signs the session cookie. ' +
          'Any random string will do for a demo; `npm run demo` sets one.',
      },
      { status: 500 },
    );
  }

  const response = NextResponse.redirect(
    new URL('/inbox', request.nextUrl.origin),
    // 303 so the browser follows with GET rather than re-POSTing.
    { status: 303 },
  );

  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: await createSession(
      { teamId: DEMO_TEAM_ID, userId: DEMO_OWNER_USER_ID },
      secret,
    ),
    httpOnly: true,
    sameSite: 'lax',
    // The demo runs on plain http://localhost by design (no certificate to
    // click through). A Secure cookie would never be sent back.
    secure: request.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: Math.floor(DEFAULT_SESSION_TTL_MS / 1000),
  });

  return response;
}
