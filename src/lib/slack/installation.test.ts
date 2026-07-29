import type { SlackInstallation } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decryptInstallation,
  saveInstallation,
  toPublicInstallation,
} from '@/lib/slack/installation';
import { decryptSlackToken } from '@/lib/slack/token-crypto';

const { upsert } = vi.hoisted(() => ({ upsert: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: { slackInstallation: { upsert } },
}));

const installation: SlackInstallation = {
  id: 'installation-synthetic',
  teamId: 'T-SYNTHETIC',
  authedUserId: 'U-SYNTHETIC',
  encryptedUserAccessToken: '',
  encryptedBotAccessToken: null,
  scopes: 'channels:history,users:read',
  installedAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

describe('Slack installation token privacy', () => {
  beforeEach(() => {
    process.env.SLACK_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    upsert.mockReset().mockResolvedValue(installation);
  });

  afterEach(() => delete process.env.SLACK_TOKEN_ENCRYPTION_KEY);

  it('persists randomized encrypted envelopes rather than plaintext tokens', async () => {
    const userToken = 'xoxp-synthetic-user-token';
    const botToken = 'xoxb-synthetic-bot-token';

    await saveInstallation({
      teamId: 'T-SYNTHETIC',
      teamName: 'Synthetic Workspace',
      authedUserId: 'U-SYNTHETIC',
      userAccessToken: userToken,
      botAccessToken: botToken,
      scopes: 'channels:history,users:read',
    });

    const argument = upsert.mock.calls[0]?.[0];
    expect(argument).toBeDefined();
    for (const persistence of [argument.create, argument.update]) {
      expect(persistence.encryptedUserAccessToken).toMatch(/^enc:v1:/);
      expect(persistence.encryptedBotAccessToken).toMatch(/^enc:v1:/);
      expect(JSON.stringify(persistence)).not.toContain(userToken);
      expect(JSON.stringify(persistence)).not.toContain(botToken);
      expect(decryptSlackToken(persistence.encryptedUserAccessToken)).toBe(userToken);
      expect(decryptSlackToken(persistence.encryptedBotAccessToken)).toBe(botToken);
    }
    expect(argument.create.encryptedUserAccessToken).not.toBe(
      argument.update.encryptedUserAccessToken,
    );
    expect(argument.create.encryptedBotAccessToken).not.toBe(
      argument.update.encryptedBotAccessToken,
    );
  });

  it('decrypts user and bot ciphertext only at the server boundary', () => {
    const encrypted = {
      ...installation,
      encryptedUserAccessToken: 'enc:v1:ignored',
      encryptedBotAccessToken: 'enc:v1:ignored',
    };
    const create = upsert;
    create.mockClear();
    return saveInstallation({
      teamId: installation.teamId,
      teamName: 'Synthetic Workspace',
      authedUserId: installation.authedUserId,
      userAccessToken: 'synthetic-user-secret',
      botAccessToken: 'synthetic-bot-secret',
      scopes: installation.scopes,
    }).then(() => {
      const data = create.mock.calls[0]?.[0].create;
      const decrypted = decryptInstallation({
        ...encrypted,
        encryptedUserAccessToken: data.encryptedUserAccessToken,
        encryptedBotAccessToken: data.encryptedBotAccessToken,
      });
      expect(decrypted.userAccessToken).toBe('synthetic-user-secret');
      expect(decrypted.botAccessToken).toBe('synthetic-bot-secret');
    });
  });

  it('never exposes decrypted token properties in the public shape', () => {
    const publicInstallation = toPublicInstallation({
      ...installation,
      encryptedUserAccessToken: 'enc:v1:synthetic',
      encryptedBotAccessToken: 'enc:v1:synthetic',
    });

    expect(publicInstallation).not.toHaveProperty('userAccessToken');
    expect(publicInstallation).not.toHaveProperty('botAccessToken');
    expect(publicInstallation).not.toHaveProperty('encryptedUserAccessToken');
    expect(publicInstallation).not.toHaveProperty('encryptedBotAccessToken');
  });
});
