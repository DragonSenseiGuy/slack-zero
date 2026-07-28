import { NextResponse, type NextRequest } from 'next/server';

import { EnvValidationError, requireSlackEnv } from '@/lib/env';
import { saveInstallation } from '@/lib/slack/installation';
import { exchangeCodeForToken } from '@/lib/slack/oauth';
import {
  STATE_COOKIE_NAME,
  verifyState,
} from '@/lib/slack/oauth-state';

export const dynamic = 'force-dynamic';

/**
 * GET /api/slack/oauth/callback
 *
 * Validates the CSRF state, exchanges the code for a user token, persists the
 * installation, and bounces back to `/`.
 *
 * Failures redirect to `/?slack_error=<code>` with a short machine-readable
 * code. Token values are never logged and never put in a URL.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  let slack;
  try {
    slack = requireSlackEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return failure(request, 'slack_not_configured');
    }
    throw error;
  }

  const params = request.nextUrl.searchParams;

  // Slack reports user-facing denials via `error` (e.g. access_denied).
  const slackError = params.get('error');
  if (slackError) {
    return failure(request, slackError, slack.appBaseUrl);
  }

  const stateCheck = verifyState({
    received: params.get('state'),
    expected: request.cookies.get(STATE_COOKIE_NAME)?.value ?? null,
    secret: slack.stateSecret,
  });

  if (!stateCheck.valid) {
    return failure(request, `invalid_state_${stateCheck.reason}`, slack.appBaseUrl);
  }

  const code = params.get('code');
  if (!code) {
    return failure(request, 'missing_code', slack.appBaseUrl);
  }

  const exchange = await exchangeCodeForToken({
    code,
    clientId: slack.clientId,
    clientSecret: slack.clientSecret,
    redirectUri: slack.redirectUri,
  });

  if (!exchange.ok) {
    return failure(request, exchange.error, slack.appBaseUrl);
  }

  await saveInstallation(exchange.installation);

  const response = NextResponse.redirect(
    resolveUrl(request, '/?slack_connected=1', slack.appBaseUrl),
  );
  clearStateCookie(response);
  return response;
}

function failure(
  request: NextRequest,
  code: string,
  appBaseUrl?: string,
): NextResponse {
  const target = resolveUrl(
    request,
    `/?slack_error=${encodeURIComponent(code)}`,
    appBaseUrl,
  );
  const response = NextResponse.redirect(target);
  clearStateCookie(response);
  return response;
}

/** Single-use cookie */
function clearStateCookie(response: NextResponse): void {
  response.cookies.set({
    name: STATE_COOKIE_NAME,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: 0,
  });
}

function resolveUrl(
  request: NextRequest,
  path: string,
  appBaseUrl?: string,
): URL {
  try {
    return new URL(path, appBaseUrl ?? request.nextUrl.origin);
  } catch {
    return new URL(path, request.nextUrl.origin);
  }
}
