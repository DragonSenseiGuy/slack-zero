import { describe, expect, it, vi } from 'vitest';

import { MAX_WAITING_SCAN_REQUESTS, scanWaitingWindow } from '@/lib/waiting/scan';

describe('scanWaitingWindow', () => {
  const since = new Date('2026-07-01T00:00:00Z');
  const rows = [
    { id: 'parent', conversationId: 'C1', ts: '1.0', threadTs: '1.0', isDeleted: false },
    { id: 'reply', conversationId: 'C1', ts: '2.0', threadTs: '1.0', isDeleted: false },
  ];

  it('paginates history and replies through their final cursors', async () => {
    const history = vi.fn()
      .mockResolvedValueOnce({ messages: [{ ts: '1.0', user: 'U0', text: 'can you review?', thread_ts: '1.0', reply_count: 1 }], response_metadata: { next_cursor: 'h2' } })
      .mockResolvedValueOnce({ messages: [], response_metadata: { next_cursor: '' } });
    const replies = vi.fn()
      .mockResolvedValueOnce({ messages: [{ ts: '1.0', user: 'U0', text: 'can you review?', thread_ts: '1.0' }], response_metadata: { next_cursor: 'r2' } })
      .mockResolvedValueOnce({ messages: [{ ts: '2.0', user: 'U1', text: 'yes', thread_ts: '1.0' }], response_metadata: { next_cursor: '' } });

    const result = await scanWaitingWindow({ conversations: { history, replies } } as never, rows, since);

    expect(result.complete).toBe(true);
    expect(result.candidates.map((row) => row.id)).toEqual(['parent', 'reply']);
    expect(history).toHaveBeenCalledTimes(2);
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it('reports an incomplete scope when any thread fails', async () => {
    const history = vi.fn().mockResolvedValue({ messages: [], response_metadata: { next_cursor: '' } });
    const replies = vi.fn().mockRejectedValue(new Error('not_allowed'));
    const result = await scanWaitingWindow({ conversations: { history, replies } } as never, rows, since);
    expect(result.complete).toBe(false);
    expect(result.errors[0]).toBe('replies:C1:1.0:SLACK_READ_FAILED');
  });

  it('marks a cursor scan incomplete when its request budget is exhausted', async () => {
    const history = vi.fn().mockResolvedValue({ messages: [], response_metadata: { next_cursor: 'more' } });
    const replies = vi.fn();
    const result = await scanWaitingWindow({ conversations: { history, replies } } as never, rows, since);
    expect(result.complete).toBe(false);
    expect(result.errors).toContain('WAITING_SCAN_BUDGET_EXHAUSTED');
    expect(history).toHaveBeenCalledTimes(MAX_WAITING_SCAN_REQUESTS);
    expect(replies).not.toHaveBeenCalled();
  });
});
