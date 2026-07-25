import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetEnvCache } from '@/lib/env';
import {
  STATE_COOKIE_NAME,
  verifyState,
} from '@/lib/slack/oauth-state';
import { SLACK_USER_SCOPES } from '@/lib/slack/scopes';

import { GET } from './route';

/** Unit tests for GET /api/slack/oauth/start. No network, no database. */

const STATE_SECRET = 'unit-test-state-secret';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5433/slackzero';
  process.env.SLACK_CLIENT_ID = '111.222';
  process.env.SLACK_CLIENT_SECRET = 'client-secret';
  process.env.SLACK_STATE_SECRET = STATE_SECRET;
  process.env.SLACK_REDIRECT_URI =
    'https://localhost:3000/api/slack/oauth/callback';
  process.env.APP_BASE_URL = 'https://localhost:3000';
  resetEnvCache();
});

afterEach(() => {
  resetEnvCache();
});

describe('GET /api/slack/oauth/start', () => {
  it('redirects to Slack with user_scope and our redirect_uri', async () => {
    const response = await GET();

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location') as string);

    expect(location.origin + location.pathname).toBe(
      'https://slack.com/oauth/v2/authorize',
    );
    expect(location.searchParams.get('client_id')).toBe('111.222');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://localhost:3000/api/slack/oauth/callback',
    );

    // User-token flow: the scopes we care about ride on `user_scope`.
    const userScopes =
      location.searchParams.get('user_scope')?.split(',') ?? [];
    for (const scope of SLACK_USER_SCOPES) {
      expect(userScopes).toContain(scope);
    }

    // Phase 1 additions beyond plan.md's stated minimum.
    expect(userScopes).toContain('channels:read');
    expect(userScopes).toContain('groups:read');
    expect(userScopes).toContain('mpim:read');
    expect(userScopes).toContain('search:read');
  });

  it('sets a signed state that verifies against the cookie', async () => {
    const response = await GET();

    const location = new URL(response.headers.get('location') as string);
    const stateParam = location.searchParams.get('state');
    const cookie = response.cookies.get(STATE_COOKIE_NAME);

    expect(stateParam).toBeTruthy();
    expect(cookie?.value).toBe(stateParam);

    expect(
      verifyState({
        received: stateParam,
        expected: cookie?.value,
        secret: STATE_SECRET,
      }).valid,
    ).toBe(true);
  });

  it('sets the state cookie httpOnly and secure so it cannot be read by JS', async () => {
    const response = await GET();
    const cookie = response.cookies.get(STATE_COOKIE_NAME);

    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.maxAge).toBeGreaterThan(0);
  });

  it('never leaks the client secret into the redirect URL', async () => {
    const response = await GET();
    expect(response.headers.get('location')).not.toContain('client-secret');
  });

  it('returns a clear 500 when Slack credentials are not configured', async () => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    delete process.env.SLACK_STATE_SECRET;
    resetEnvCache();

    const response = await GET();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('slack_not_configured');
    expect(body.message).toContain('SLACK_CLIENT_ID');
  });
});
