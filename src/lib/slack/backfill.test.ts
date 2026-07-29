import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runBackfill } from '@/lib/slack/backfill';

const mocks = vi.hoisted(() => ({
  getSlackContext: vi.fn(),
  markConversationSynced: vi.fn(),
  upsertConversation: vi.fn(),
  upsertMessage: vi.fn(),
  upsertUser: vi.fn(),
}));

vi.mock('@/lib/slack/client', () => ({
  getSlackContext: mocks.getSlackContext,
}));

vi.mock('@/lib/slack/ingest', () => ({
  ensureConversationFromReference: vi.fn(),
  markConversationSynced: mocks.markConversationSynced,
  upsertConversation: mocks.upsertConversation,
  upsertMessage: mocks.upsertMessage,
  upsertUser: mocks.upsertUser,
}));

describe('runBackfill DM history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markConversationSynced.mockResolvedValue(undefined);
    mocks.upsertConversation.mockResolvedValue('created');
    mocks.upsertMessage.mockResolvedValue('created');
    mocks.upsertUser.mockResolvedValue('created');
  });

  it('requests ten recent messages and persists only those after last_read', async () => {
    const client = {
      users: { list: vi.fn().mockResolvedValue({ members: [] }) },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [{ id: 'D123', is_im: true, user: 'UPEER' }],
        }),
        info: vi.fn().mockResolvedValue({
          channel: { id: 'D123', is_im: true, last_read: '2.000000' },
        }),
        history: vi.fn().mockResolvedValue({
          messages: [
            { ts: '4.000000', user: 'UPEER', text: 'newest unread' },
            { ts: '3.000000', user: 'UPEER', text: 'older unread' },
            { ts: '2.000000', user: 'UPEER', text: 'already read' },
            { ts: '1.000000', user: 'UPEER', text: 'oldest read' },
          ],
        }),
      },
    };
    mocks.getSlackContext.mockResolvedValue({
      client,
      authedUserId: 'UME',
      teamId: 'T123',
      teamName: 'Test',
    });

    await runBackfill({ includeMentions: false, includeThreads: false });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: 'D123',
      limit: 10,
      oldest: undefined,
    });
    expect(mocks.upsertMessage).toHaveBeenCalledTimes(2);
    expect(mocks.upsertMessage.mock.calls.map(([message]) => message.ts)).toEqual([
      '4.000000',
      '3.000000',
    ]);
    expect(mocks.markConversationSynced).toHaveBeenCalledWith('D123');
  });

  it('does not persist anything when the DM has no unread messages', async () => {
    const client = {
      users: { list: vi.fn().mockResolvedValue({ members: [] }) },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [{ id: 'D123', is_im: true, user: 'UPEER' }],
        }),
        info: vi.fn().mockResolvedValue({
          channel: { id: 'D123', is_im: true, last_read: '4.000000' },
        }),
        history: vi.fn().mockResolvedValue({
          messages: [{ ts: '4.000000', user: 'UPEER', text: 'read' }],
        }),
      },
    };
    mocks.getSlackContext.mockResolvedValue({
      client,
      authedUserId: 'UME',
      teamId: 'T123',
      teamName: 'Test',
    });

    await runBackfill({ includeMentions: false, includeThreads: false });

    expect(mocks.upsertMessage).not.toHaveBeenCalled();
  });
});
