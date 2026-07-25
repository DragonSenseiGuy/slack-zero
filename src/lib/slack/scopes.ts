/**
 * Single source of truth for the OAuth scopes SlackZero requests.
 *
 * Keep this in sync with the manifest in SLACK_APP_SETUP.md — Slack will reject
 * the authorize request if we ask for a scope the app isn't configured for.
 */

/**
 * User-token scopes. SlackZero acts as the user (reading their DMs, replying as
 * them), so nearly everything lives here rather than on a bot token.
 *
 * Beyond plan.md's stated minimum, this adds `channels:read`, `groups:read`,
 * `mpim:read` (needed by `conversations.list` to enumerate channels) and
 * `search:read` (needed for mention lookup in Phase 1). User decision,
 * 2026-07-24.
 */
export const SLACK_USER_SCOPES = [
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'mpim:read',
  'groups:history',
  'groups:read',
  'channels:history',
  'channels:read',
  'users:read',
  'chat:write',
  'reactions:read',
  'search:read',
] as const;

/**
 * Bot-token scopes. Minimal on purpose: the bot user exists mainly so the app
 * has a stable identity in the workspace, not to do work.
 */
export const SLACK_BOT_SCOPES = ['users:read'] as const;

export const SLACK_USER_SCOPE_STRING = SLACK_USER_SCOPES.join(',');
export const SLACK_BOT_SCOPE_STRING = SLACK_BOT_SCOPES.join(',');
