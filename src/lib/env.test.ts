import { describe, expect, it } from 'vitest';

import {
  EnvValidationError,
  isLlmConfigured,
  isSlackConfigured,
  parseEnv,
  requireLlmEnv,
  requireSlackEnv,
} from '@/lib/env';

const MINIMAL = {
  DATABASE_URL: 'postgresql://slackzero:slackzero@localhost:5433/slackzero',
};

describe('parseEnv', () => {
  it('accepts an environment with only the required vars', () => {
    const env = parseEnv(MINIMAL);
    expect(env.DATABASE_URL).toBe(MINIMAL.DATABASE_URL);
  });

  it('throws EnvValidationError naming the missing required var', () => {
    expect(() => parseEnv({})).toThrow(EnvValidationError);
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('mentions .env.example in the error so the fix is obvious', () => {
    expect(() => parseEnv({})).toThrow(/\.env\.example/);
  });

  it('rejects an empty DATABASE_URL rather than silently accepting it', () => {
    expect(() => parseEnv({ DATABASE_URL: '' })).toThrow(EnvValidationError);
  });

  it('applies defaults for the optional non-secret vars', () => {
    const env = parseEnv(MINIMAL);
    expect(env.HACKCLUB_AI_BASE_URL).toBe('https://ai.hackclub.com/proxy/v1');
    expect(env.LLM_MODEL).toBe('qwen/qwen3-32b');
    expect(env.APP_BASE_URL).toBe('https://localhost:3000');
    expect(env.SLACK_REDIRECT_URI).toBe(
      'https://localhost:3000/api/slack/oauth/callback',
    );
  });

  it('treats an empty string the same as unset (so FOO="" in .env works)', () => {
    const env = parseEnv({
      ...MINIMAL,
      SLACK_CLIENT_ID: '',
      HACKCLUB_AI_API_KEY: '   ',
      LLM_MODEL: '',
    });

    expect(env.SLACK_CLIENT_ID).toBeUndefined();
    expect(env.HACKCLUB_AI_API_KEY).toBeUndefined();
    // ...and the default still wins for vars that have one.
    expect(env.LLM_MODEL).toBe('qwen/qwen3-32b');
  });

  it('keeps values that are provided', () => {
    const env = parseEnv({
      ...MINIMAL,
      SLACK_CLIENT_ID: '123.456',
      LLM_MODEL: 'google/gemini-2.5-flash',
    });

    expect(env.SLACK_CLIENT_ID).toBe('123.456');
    expect(env.LLM_MODEL).toBe('google/gemini-2.5-flash');
  });
});

describe('requireSlackEnv', () => {
  const configured = {
    ...MINIMAL,
    SLACK_CLIENT_ID: '123.456',
    SLACK_CLIENT_SECRET: 'shh',
    SLACK_STATE_SECRET: 'state-secret',
  };

  it('reports not configured when Slack vars are blank', () => {
    expect(isSlackConfigured(parseEnv(MINIMAL))).toBe(false);
  });

  it('reports configured once the three OAuth vars are present', () => {
    expect(isSlackConfigured(parseEnv(configured))).toBe(true);
  });

  it('returns the normalized Slack config', () => {
    const slack = requireSlackEnv(parseEnv(configured));
    expect(slack).toEqual({
      clientId: '123.456',
      clientSecret: 'shh',
      stateSecret: 'state-secret',
      redirectUri: 'https://localhost:3000/api/slack/oauth/callback',
      appBaseUrl: 'https://localhost:3000',
    });
  });

  it('lists exactly which Slack vars are missing', () => {
    const env = parseEnv({ ...MINIMAL, SLACK_CLIENT_ID: '123.456' });

    expect(() => requireSlackEnv(env)).toThrow(EnvValidationError);
    try {
      requireSlackEnv(env);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('SLACK_CLIENT_SECRET');
      expect(message).toContain('SLACK_STATE_SECRET');
      expect(message).not.toContain('SLACK_CLIENT_ID,');
    }
  });
});

describe('requireLlmEnv', () => {
  it('reports not configured without an API key', () => {
    expect(isLlmConfigured(parseEnv(MINIMAL))).toBe(false);
    expect(() => requireLlmEnv(parseEnv(MINIMAL))).toThrow(
      /HACKCLUB_AI_API_KEY/,
    );
  });

  it('returns base url, key and model when configured', () => {
    const env = parseEnv({ ...MINIMAL, HACKCLUB_AI_API_KEY: 'hc-key' });

    expect(isLlmConfigured(env)).toBe(true);
    expect(requireLlmEnv(env)).toEqual({
      baseUrl: 'https://ai.hackclub.com/proxy/v1',
      apiKey: 'hc-key',
      model: 'qwen/qwen3-32b',
    });
  });
});
