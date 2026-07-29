import { afterEach, describe, expect, it } from 'vitest';
import { decryptSlackToken, encryptSlackToken } from './token-crypto';

describe('Slack token encryption', () => {
  afterEach(() => delete process.env.SLACK_TOKEN_ENCRYPTION_KEY);
  it('uses a randomized authenticated versioned envelope', () => {
    process.env.SLACK_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const first = encryptSlackToken('synthetic-token');
    const second = encryptSlackToken('synthetic-token');
    expect(first).toMatch(/^enc:v1:/);
    expect(first).not.toBe(second);
    expect(decryptSlackToken(first)).toBe('synthetic-token');
  });
});
