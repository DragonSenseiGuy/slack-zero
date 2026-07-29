import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEnvCache } from '@/lib/env';
import { createState, STATE_COOKIE_NAME } from '@/lib/slack/oauth-state';

import { GET } from './route';

/**
 * Unit tests for GET /api/slack/oauth/callback.
 *
 * Slack is mocked at the `@slack/web-api` boundary rather than at our own
 * `exchangeCodeForToken`, so the real response-normalization logic is exercised
 * against realistic `oauth.v2.access` payloads. Persistence is mocked so these
 * stay pure unit tests with no database.
 */

// vi.hoisted so these exist before the hoisted vi.mock factories run.
const { mockAccess, mockSaveInstallation, mockRunBackfill } = vi.hoisted(() => ({
  mockAccess: vi.fn(),
  mockSaveInstallation: vi.fn(),
  mockRunBackfill: vi.fn(),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: class {
    oauth = { v2: { access: mockAccess } };
  },
}));

vi.mock('@/lib/slack/installation', () => ({
  saveInstallation: mockSaveInstallation,
}));

vi.mock('@/lib/slack/backfill', () => ({
  runBackfill: mockRunBackfill,
}));

const STATE_SECRET = 'unit-test-state-secret';
const BASE_URL = 'https://localhost:3000'; // TODO: change to a universal base_url

/** A realistic successful `oauth.v2.access` response for a user-token app. */
const SLACK_SUCCESS = {
  ok: true,
  app_id: 'A0000000000',
  authed_user: {
    id: 'U123USER',
    scope: 'im:history,im:read,chat:write',
    access_token: 'xoxp-fake-user-token',
    token_type: 'user',
  },
  access_token: 'xoxb-fake-bot-token',
  token_type: 'bot',
  scope: 'users:read',
  bot_user_id: 'U000BOT',
  team: { id: 'T123TEAM', name: 'Test Workspace' },
  enterprise: null,
  is_enterprise_install: false,
};

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5433/slackzero';
  process.env.SLACK_CLIENT_ID = '111.222';
  process.env.SLACK_CLIENT_SECRET = 'client-secret';
  process.env.SLACK_STATE_SECRET = STATE_SECRET;
  process.env.SLACK_REDIRECT_URI = `${BASE_URL}/api/slack/oauth/callback`;
  process.env.APP_BASE_URL = BASE_URL;
  resetEnvCache();

  mockAccess.mockReset();
  mockSaveInstallation.mockReset();
  mockSaveInstallation.mockResolvedValue({ id: 'inst_1' });
  mockRunBackfill.mockReset();
  mockRunBackfill.mockResolvedValue({ messages: { created: 3 } });
});

afterEach(() => {
  resetEnvCache();
});

type RequestOptions = {
  code?: string | null;
  state?: string | null;
  cookieState?: string | null;
  error?: string;
};

function buildRequest(options: RequestOptions): NextRequest {
  const url = new URL(`${BASE_URL}/api/slack/oauth/callback`);
  if (options.code !== null && options.code !== undefined) {
    url.searchParams.set('code', options.code);
  }
  if (options.state !== null && options.state !== undefined) {
    url.searchParams.set('state', options.state);
  }
  if (options.error) {
    url.searchParams.set('error', options.error);
  }

  const headers = new Headers();
  if (options.cookieState) {
    headers.set('cookie', `${STATE_COOKIE_NAME}=${options.cookieState}`);
  }

  return new NextRequest(url, { headers });
}

function redirectParams(location: string | null): URLSearchParams {
  expect(location).toBeTruthy();
  return new URL(location as string).searchParams;
}

describe('GET /api/slack/oauth/callback — success path', () => {
  it('persists the installation, imports history, and redirects home', async () => {
    mockAccess.mockResolvedValue(SLACK_SUCCESS);
    const state = createState(STATE_SECRET);

    const response = await GET(
      buildRequest({ code: 'slack-code', state, cookieState: state }),
    );

    expect(response.status).toBe(307);
    const params = redirectParams(response.headers.get('location'));
    expect(params.get('slack_connected')).toBe('1');
    expect(params.get('slack_error')).toBeNull();

    expect(mockSaveInstallation).toHaveBeenCalledTimes(1);
    expect(mockSaveInstallation).toHaveBeenCalledWith({
      teamId: 'T123TEAM',
      teamName: 'Test Workspace',
      authedUserId: 'U123USER',
      userAccessToken: 'xoxp-fake-user-token',
      botAccessToken: 'xoxb-fake-bot-token',
      scopes: 'im:history,im:read,chat:write',
    });
    expect(mockRunBackfill).toHaveBeenCalledTimes(1);
    expect(mockSaveInstallation.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunBackfill.mock.invocationCallOrder[0],
    );
  });

  it('keeps the connection and reports when the initial history import fails', async () => {
    mockAccess.mockResolvedValue(SLACK_SUCCESS);
    mockRunBackfill.mockRejectedValue(new Error('Slack unavailable'));
    const state = createState(STATE_SECRET);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await GET(
      buildRequest({ code: 'slack-code', state, cookieState: state }),
    );

    const params = redirectParams(response.headers.get('location'));
    expect(params.get('slack_connected')).toBe('1');
    expect(params.get('backfill_error')).toBe('1');
    expect(mockSaveInstallation).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it('sends the code and redirect_uri Slack expects', async () => {
    mockAccess.mockResolvedValue(SLACK_SUCCESS);
    const state = createState(STATE_SECRET);

    await GET(buildRequest({ code: 'slack-code', state, cookieState: state }));

    expect(mockAccess).toHaveBeenCalledWith({
      code: 'slack-code',
      client_id: '111.222',
      client_secret: 'client-secret',
      redirect_uri: `${BASE_URL}/api/slack/oauth/callback`,
    });
  });

  it('clears the single-use state cookie', async () => {
    mockAccess.mockResolvedValue(SLACK_SUCCESS);
    const state = createState(STATE_SECRET);

    const response = await GET(
      buildRequest({ code: 'slack-code', state, cookieState: state }),
    );

    const cookie = response.cookies.get(STATE_COOKIE_NAME);
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
  });

  it('never puts a token in the redirect URL', async () => {
    mockAccess.mockResolvedValue(SLACK_SUCCESS);
    const state = createState(STATE_SECRET);

    const response = await GET(
      buildRequest({ code: 'slack-code', state, cookieState: state }),
    );

    expect(response.headers.get('location')).not.toContain('xoxp-');
    expect(response.headers.get('location')).not.toContain('xoxb-');
  });

  it('stores a null bot token when only a user token was granted', async () => {
    mockAccess.mockResolvedValue({
      ...SLACK_SUCCESS,
      access_token: undefined,
    });
    const state = createState(STATE_SECRET);

    await GET(buildRequest({ code: 'slack-code', state, cookieState: state }));

    expect(mockSaveInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ botAccessToken: null }),
    );
  });
});

describe('GET /api/slack/oauth/callback — failure paths', () => {
  it('rejects a missing state and does not persist', async () => {
    const response = await GET(buildRequest({ code: 'slack-code' }));

    expect(redirectParams(response.headers.get('location')).get('slack_error')).toBe(
      'invalid_state_missing',
    );
    expect(mockSaveInstallation).not.toHaveBeenCalled();
    expect(mockAccess).not.toHaveBeenCalled();
  });

  it('rejects a state with no matching cookie and does not persist', async () => {
    const state = createState(STATE_SECRET);

    const response = await GET(buildRequest({ code: 'slack-code', state }));

    expect(redirectParams(response.headers.get('location')).get('slack_error')).toBe(
      'invalid_state_missing',
    );
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it('rejects a state that does not match the cookie (CSRF) and does not persist', async () => {
    const response = await GET(
      buildRequest({
        code: 'slack-code',
        state: createState(STATE_SECRET),
        cookieState: createState(STATE_SECRET),
      }),
    );

    expect(redirectParams(response.headers.get('location')).get('slack_error')).toBe(
      'invalid_state_mismatch',
    );
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it('rejects a forged state signed with the wrong secret and does not persist', async () => {
    const forged = createState('attacker-secret');

    const response = await GET(
      buildRequest({ code: 'slack-code', state: forged, cookieState: forged }),
    );

    expect(redirectParams(response.headers.get('location')).get('slack_error')).toBe(
      'invalid_state_bad_signature',
    );
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it('rejects an expired state and does not persist', async () => {
    const stale = createState(STATE_SECRET, { now: Date.now() - 60 * 60 * 1000 });

    const response = await GET(
      buildRequest({ code: 'slack-code', state: stale, cookieState: stale }),
    );

    expect(redirectParams(response.headers.get('location')).get('slack_error')).toBe(
      'invalid_state_expired',
    );
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it('rejects a missing code and does not call Slack or persist', async () => {
    const state = createState(STATE_SECRET);

    const response = await GET(buildRequest({ state, cookieState: state }));

    expect(redirectParams(response.headers.get('location')).get('slack_error')).toBe(
      'missing_code',
    );
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it('surfaces a user denial from Slack without persisting', async () => {
    const state = createState(STATE_SECRET);

    const response = await GET(
      buildRequest({ state, cookieState: state, error: 'access_denied' }),
    );

    expect(redirectParams(response.headers.get('location')).get('slack_error')).toBe(
      'access_denied',
    );
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it('handles Slack replying ok:false and does not persist', async () => {
    // WebClient throws on ok:false, carrying the code on `error.data.error`.
    mockAccess.mockRejectedValue(
      Object.assign(new Error('An API error occurred: invalid_code'), {
        code: 'slack_webapi_platform_error',
        data: { ok: false, error: 'invalid_code' },
      }),
    );
    const state = createState(STATE_SECRET);

    const response = await GET(
      buildRequest({ code: 'bad-code', state, cookieState: state }),
    );

    expect(redirectParams(response.headers.get('location')).get('slack_error')).toBe(
      'invalid_code',
    );
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it('handles a plain ok:false object response and does not persist', async () => {
    mockAccess.mockResolvedValue({ ok: false, error: 'invalid_client_id' });
    const state = createState(STATE_SECRET);

    const response = await GET(
      buildRequest({ code: 'slack-code', state, cookieState: state }),
    );

    expect(redirectParams(response.headers.get('location')).get('slack_error')).toBe(
      'invalid_client_id',
    );
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it('handles a success response that is missing the user token', async () => {
    mockAccess.mockResolvedValue({
      ...SLACK_SUCCESS,
      authed_user: { id: 'U123USER' },
    });
    const state = createState(STATE_SECRET);

    const response = await GET(
      buildRequest({ code: 'slack-code', state, cookieState: state }),
    );

    expect(redirectParams(response.headers.get('location')).get('slack_error')).toBe(
      'missing_user_token',
    );
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it('handles a success response that is missing the team', async () => {
    mockAccess.mockResolvedValue({ ...SLACK_SUCCESS, team: undefined });
    const state = createState(STATE_SECRET);

    const response = await GET(
      buildRequest({ code: 'slack-code', state, cookieState: state }),
    );

    expect(redirectParams(response.headers.get('location')).get('slack_error')).toBe(
      'missing_team',
    );
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it('handles a network failure talking to Slack', async () => {
    mockAccess.mockRejectedValue(new Error('socket hang up'));
    const state = createState(STATE_SECRET);

    const response = await GET(
      buildRequest({ code: 'slack-code', state, cookieState: state }),
    );

    expect(redirectParams(response.headers.get('location')).get('slack_error')).toBe(
      'slack_request_failed',
    );
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });

  it('fails cleanly when Slack credentials are not configured', async () => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    delete process.env.SLACK_STATE_SECRET;
    resetEnvCache();

    const response = await GET(buildRequest({ code: 'slack-code' }));

    expect(redirectParams(response.headers.get('location')).get('slack_error')).toBe(
      'slack_not_configured',
    );
    expect(mockSaveInstallation).not.toHaveBeenCalled();
  });
});

// TODO: this file feels too big lol, try to make it smaller somehow
