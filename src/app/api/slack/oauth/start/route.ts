import { NextResponse } from 'next/server';

import { EnvValidationError, requireSlackEnv } from '@/lib/env';
import {
  createState,
  DEFAULT_STATE_TTL_MS,
  STATE_COOKIE_NAME,
} from '@/lib/slack/oauth-state';
import { buildAuthorizeUrl } from '@/lib/slack/oauth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/slack/oauth/start
 *
 * Kicks off the OAuth round-trip: mint a signed state, stash it in an httpOnly
 * cookie, and redirect to Slack's authorize page.
 */
export async function GET(): Promise<NextResponse> {
  let slack;
  try {
    slack = requireSlackEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return NextResponse.json(
        { error: 'slack_not_configured', message: error.message },
        { status: 500 },
      );
    }
    throw error;
  }

  const state = createState(slack.stateSecret);

  const response = NextResponse.redirect(
    buildAuthorizeUrl({
      clientId: slack.clientId,
      redirectUri: slack.redirectUri,
      state,
    }),
  );

  response.cookies.set({
    name: STATE_COOKIE_NAME,
    value: state,
    httpOnly: true,
    sameSite: 'lax',
    // Slack requires an https redirect URL, so the cookie can always be secure.
    secure: true,
    path: '/',
    maxAge: Math.floor(DEFAULT_STATE_TTL_MS / 1000),
  });

  return response;
}
