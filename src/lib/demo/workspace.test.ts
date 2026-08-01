import { afterEach, describe, expect, it } from 'vitest';

import {
  DEMO_CONVERSATIONS,
  DEMO_MESSAGES,
  DEMO_OWNER_USER_ID,
  DEMO_USERS,
  DEMO_WORKSPACE,
  isDemoMode,
} from '@/lib/demo/workspace';

afterEach(() => {
  delete process.env.SLACKZERO_DEMO;
});

describe('demo mode gate', () => {
  it('is off unless the flag is exactly "1"', () => {
    expect(isDemoMode()).toBe(false);

    process.env.SLACKZERO_DEMO = 'true';
    expect(isDemoMode()).toBe(false);

    process.env.SLACKZERO_DEMO = '1';
    expect(isDemoMode()).toBe(true);
  });
});

describe('demo fixture integrity', () => {
  it('keeps every id inside the DEMO namespace', () => {
    // Real Slack ids are shorter and never contain "DEMO". This is what makes
    // seeding and cleanup incapable of touching real rows.
    DEMO_CONVERSATIONS.forEach((conversation) => {
      expect(conversation.id).toMatch(/DEMO/);
    });
    Object.keys(DEMO_USERS).forEach((id) => expect(id).toMatch(/DEMO/));
    DEMO_MESSAGES.forEach((message) => {
      expect(message.id.startsWith('mdemo-')).toBe(true);
    });
  });

  it('gives every message a known conversation and sender', () => {
    const conversationIds = new Set(DEMO_CONVERSATIONS.map((row) => row.id));
    const userIds = new Set(Object.keys(DEMO_USERS));

    DEMO_MESSAGES.forEach((message) => {
      expect(conversationIds.has(message.conversationId)).toBe(true);
      expect(userIds.has(message.userId)).toBe(true);
    });
  });

  it('has unique message ids', () => {
    const ids = DEMO_MESSAGES.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('points every bump and thread reply at a message that exists', () => {
    const ids = new Set(DEMO_MESSAGES.map((message) => message.id));

    DEMO_MESSAGES.forEach((message) => {
      if (message.threadOf) expect(ids.has(message.threadOf)).toBe(true);
      if (message.triage?.bumpOf) expect(ids.has(message.triage.bumpOf)).toBe(true);
    });
  });

  it('only mentions the owner from messages the owner did not send', () => {
    DEMO_MESSAGES.filter((message) => message.mentionsOwner).forEach((message) => {
      expect(message.userId).not.toBe(DEMO_OWNER_USER_ID);
    });
  });

  it('routes channel messages into the queue or leaves them out deliberately', () => {
    const kinds = new Map(DEMO_CONVERSATIONS.map((row) => [row.id, row.kind]));

    // A channel message with no mention and no thread parent would be seeded
    // and then never appear anywhere — dead fixture data.
    DEMO_MESSAGES.forEach((message) => {
      const kind = kinds.get(message.conversationId);
      if (kind !== 'PUBLIC_CHANNEL' && kind !== 'PRIVATE_CHANNEL') return;
      const reachable =
        message.mentionsOwner ||
        Boolean(message.threadOf) ||
        message.userId === DEMO_OWNER_USER_ID;
      expect(reachable).toBe(true);
    });
  });
});

describe('DEMO_WORKSPACE as a synthetic content source', () => {
  it('serves text for every seeded message', () => {
    DEMO_MESSAGES.forEach((message) => {
      expect(DEMO_WORKSPACE.messageText[message.id]).toBe(message.text);
    });
  });

  it('reports reply counts from the thread structure', async () => {
    const parentIds = new Set(
      DEMO_MESSAGES.filter((message) => message.threadOf).map(
        (message) => message.threadOf as string,
      ),
    );
    expect(parentIds.size).toBeGreaterThan(0);
    parentIds.forEach((id) => {
      expect(DEMO_WORKSPACE.replyCount(id)).toBeGreaterThan(0);
    });
    expect(DEMO_WORKSPACE.replyCount('mdemo-priya-1')).toBeUndefined();
  });

  it('names the demo owner in mentions, never a real Slack user', async () => {
    await expect(DEMO_WORKSPACE.ownerUserId()).resolves.toBe(DEMO_OWNER_USER_ID);
  });
});
