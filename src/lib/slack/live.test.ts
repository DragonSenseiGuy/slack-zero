import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { slackConversationCache, slackMessageCache, slackUserCache } from '@/lib/slack/cache';
import { createSlackRequestBudget, hydrateExactMessage, hydrateMessageBatch, SLACK_HYDRATION_CONCURRENCY } from '@/lib/slack/live';

const { findUnique, findMany, findFirst } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    message: { findUnique, findMany },
    slackInstallation: { findFirst },
  },
}));

describe('synthetic E2E live hydration', () => {
  const history = vi.fn();
  const client = { conversations: { history } } as never;

  beforeEach(() => {
    delete process.env.SLACKZERO_E2E;
    slackMessageCache.clear();
    slackUserCache.clear();
    slackConversationCache.clear();
    findUnique.mockReset();
    findFirst.mockReset();
    findMany.mockReset().mockResolvedValue([]);
    history.mockReset();
    findUnique.mockResolvedValue({
      id: 'me2e-msg-0',
      ts: '1784548810.000100',
      threadTs: null,
      userId: 'UE2ESEED001',
      isDeleted: false,
      updatedAt: new Date(0),
    });
  });

  afterEach(() => delete process.env.SLACKZERO_E2E);

  it('is unavailable unless the exact production-inert gate is enabled', async () => {
    history.mockResolvedValue({ messages: [] });

    await hydrateExactMessage(client, 'CE2ESEED001', '1784548810.000100');

    expect(history).toHaveBeenCalledOnce();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('hydrates fixture text and the current user mention under the gate', async () => {
    process.env.SLACKZERO_E2E = '1';
    findFirst.mockResolvedValue({ authedUserId: 'U-AUTHED' });

    const message = await hydrateExactMessage(
      client,
      'CE2ESEED001',
      '1784548810.000100',
    );

    expect(message?.text).toBe(
      '<@U-AUTHED> E2E alpha — first fixture message',
    );
    expect(history).not.toHaveBeenCalled();
  });

  it('checks the database tombstone before returning a cached message', async () => {
    const channel = 'C-SYNTHETIC';
    const ts = '1785000000.000100';
    slackMessageCache.set(`${channel}:${ts}`, {
      raw: { type: 'message', ts, text: 'synthetic cached private content' },
      revisionMs: 0,
    });
    findUnique.mockResolvedValue({ isDeleted: true });

    await expect(hydrateExactMessage(client, channel, ts)).resolves.toBeNull();

    expect(findUnique).toHaveBeenCalledWith({
      where: { conversationId_ts: { conversationId: channel, ts } },
      select: { isDeleted: true, threadTs: true, updatedAt: true },
    });
    expect(slackMessageCache.get(`${channel}:${ts}`)).toBeUndefined();
    expect(history).not.toHaveBeenCalled();
  });

  it('rejects a cache entry from an older database revision', async () => {
    const channel = 'C-EDITED';
    const ts = '1785000001.000100';
    slackMessageCache.set(`${channel}:${ts}`, {
      raw: { type: 'message', ts, text: 'old body' },
      revisionMs: 0,
    });
    findUnique.mockResolvedValue({
      id: 'edited-message', ts, threadTs: null, userId: 'U1', isDeleted: false,
      updatedAt: new Date(1),
    });
    history.mockResolvedValue({ messages: [{ type: 'message', ts, text: 'new body' }] });

    await expect(hydrateExactMessage(client, channel, ts)).resolves.toMatchObject({ text: 'new body' });
    expect(history).toHaveBeenCalledOnce();
    expect(slackMessageCache.get(`${channel}:${ts}`)).toMatchObject({
      raw: { text: 'new body' },
      revisionMs: 1,
    });
  });
});

describe('batch live hydration', () => {
  beforeEach(() => {
    slackMessageCache.clear();
    findMany.mockReset().mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ id, isDeleted: false, updatedAt: new Date(0) })),
    );
  });

  it('coalesces multiple DM messages and one thread into two Slack calls', async () => {
    const history = vi.fn().mockResolvedValue({ messages: [
      { ts: '1.0', text: 'one' }, { ts: '2.0', text: 'two' }, { ts: '3.0', text: 'three' },
    ] });
    const replies = vi.fn().mockResolvedValue({ messages: [
      { ts: '9.0', text: 'parent' }, { ts: '10.0', thread_ts: '9.0', text: 'a' }, { ts: '11.0', thread_ts: '9.0', text: 'b' },
    ] });
    const client = { conversations: { history, replies } } as never;
    const dm = ['1.0', '2.0', '3.0'].map((ts) => ({ id: `d${ts}`, conversationId: 'D1', ts, threadTs: null, isDeleted: false, conversation: { kind: 'IM' } }));
    const thread = ['10.0', '11.0'].map((ts) => ({ id: `t${ts}`, conversationId: 'C1', ts, threadTs: '9.0', isDeleted: false, conversation: { kind: 'PUBLIC_CHANNEL' } }));

    await hydrateMessageBatch(client, [...dm, ...thread]);

    expect(history).toHaveBeenCalledOnce();
    expect(replies).toHaveBeenCalledOnce();
    expect(slackMessageCache.get('D1:2.0')?.raw.text).toBe('two');
    expect(slackMessageCache.get('C1:11.0')?.raw.text).toBe('b');
  });

  it('bounds sparse exact channel requests', async () => {
    let active = 0; let maximum = 0;
    const history = vi.fn(async ({ latest }: { latest: string }) => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { messages: [{ ts: latest, text: latest }] };
    });
    findUnique.mockImplementation(async ({ where }: { where: { conversationId_ts?: { ts: string } } }) => ({
      id: `id-${where.conversationId_ts?.ts ?? 'x'}`, ts: where.conversationId_ts?.ts ?? 'x', threadTs: null, userId: 'U1', isDeleted: false,
      updatedAt: new Date(0),
    }));
    const rows = Array.from({ length: 12 }, (_, index) => ({ id: `id-${index}`, conversationId: 'C1', ts: `${index}.0`, threadTs: null, isDeleted: false, conversation: { kind: 'PUBLIC_CHANNEL' } }));

    await hydrateMessageBatch({ conversations: { history } } as never, rows);

    expect(history).toHaveBeenCalledTimes(12);
    expect(maximum).toBeLessThanOrEqual(SLACK_HYDRATION_CONCURRENCY);
  });

  it('shares one request budget across a batch and returns unavailable when exhausted', async () => {
    const history = vi.fn().mockResolvedValue({ messages: [] });
    findUnique.mockImplementation(async ({ where }: { where: { conversationId_ts?: { ts: string } } }) => ({
      id: `id-${where.conversationId_ts?.ts ?? 'x'}`, ts: where.conversationId_ts?.ts ?? 'x', threadTs: null, userId: 'U1', isDeleted: false,
      updatedAt: new Date(0),
    }));
    const rows = ['1.0', '2.0'].map((ts) => ({ id: `id-${ts}`, conversationId: 'C1', ts, threadTs: null, isDeleted: false, conversation: { kind: 'PUBLIC_CHANNEL' } }));

    await hydrateMessageBatch({ conversations: { history } } as never, rows, createSlackRequestBudget(1));

    expect(history).toHaveBeenCalledTimes(1);
  });
});
