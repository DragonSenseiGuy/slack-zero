import { WebClient } from '@slack/web-api';

import type { SaveInstallationInput } from '@/lib/slack/installation';
import {
  SLACK_BOT_SCOPE_STRING,
  SLACK_USER_SCOPE_STRING,
} from '@/lib/slack/scopes';

/**
 * Slack OAuth v2, user-token flow.
 *
 * We normalize Slack's response into our own `SaveInstallationInput` right
 * here, at the ingestion boundary, so raw Slack payload shapes never travel
 * further into the app (see CLAUDE.md).
 */

const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';

export type BuildAuthorizeUrlOptions = {
  clientId: string;
  redirectUri: string;
  state: string;
};

/**
 * Authorize URL for the "Connect Slack" button.
 *
 * `user_scope` carries the scopes we actually need; `scope` (bot) is kept
 * minimal. Slack decides which token types to issue based on which of these
 * two params are present.
 */
export function buildAuthorizeUrl(options: BuildAuthorizeUrlOptions): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('user_scope', SLACK_USER_SCOPE_STRING);
  url.searchParams.set('scope', SLACK_BOT_SCOPE_STRING);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('state', options.state);
  return url.toString();
}

export type ExchangeCodeOptions = {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type ExchangeCodeResult =
  | { ok: true; installation: SaveInstallationInput }
  | { ok: false; error: string };

/**
 * Trade an OAuth `code` for tokens via `oauth.v2.access`.
 *
 * Never throws for expected failures — returns `{ ok: false, error }` so the
 * callback route can render a message without leaking anything sensitive.
 * Error strings here are Slack's machine codes (`invalid_code`, ...), never
 * token values.
 */
export async function exchangeCodeForToken(
  options: ExchangeCodeOptions,
): Promise<ExchangeCodeResult> {
  const client = new WebClient();

  let response;
  try {
    response = await client.oauth.v2.access({
      code: options.code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
    });
  } catch (error) {
    // WebClient throws on `ok: false` and on transport failures alike.
    return { ok: false, error: slackErrorCode(error) };
  }

  if (!response || response.ok === false) {
    return { ok: false, error: stringOr(response?.error, 'slack_error') };
  }

  const authedUser = response.authed_user;
  if (!authedUser?.id || !authedUser.access_token) {
    // Almost always means `user_scope` was omitted from the authorize URL.
    return { ok: false, error: 'missing_user_token' };
  }

  const teamId = response.team?.id;
  if (!teamId) {
    return { ok: false, error: 'missing_team' };
  }

  return {
    ok: true,
    installation: {
      teamId,
      teamName: stringOr(response.team?.name, teamId),
      authedUserId: authedUser.id,
      userAccessToken: authedUser.access_token,
      botAccessToken: response.access_token ?? null,
      scopes: stringOr(authedUser.scope, ''),
    },
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Pull Slack's machine-readable error code out of a thrown WebClient error. */
function slackErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const data = (error as { data?: { error?: unknown } }).data;
    if (data && typeof data.error === 'string') {
      return data.error;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return 'slack_request_failed';
}
