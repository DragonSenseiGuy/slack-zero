import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `sendReply` is the first thing in SlackZero that writes to Slack, so its
 * guard rails are worth pinning down: refuse the ambiguous cases loudly rather
 * than posting something visible to other people in the wrong place.
 *
 * The Slack client is mocked — CLAUDE.md forbids unit tests that hit the API.
 */

const postMessage = vi.fn();

vi.mock('@/lib/slack/client', () => ({
  getSlackContext: async () => ({
    client: { chat: { postMessage: (...args: unknown[]) => postMessage(...args) } },
    authedUserId: 'U0BK9FR4Y1M',
    teamId: 'T0BEJLG8H1U',
    teamName: 'BOOM',
  }),
}));

const { sendReply, replyTargetThreadTs, EmptyReplyError, MAX_REPLY_LENGTH } =
  await import('@/lib/reply/send');

beforeEach(() => {
  postMessage.mockReset();
  postMessage.mockResolvedValue({ ok: true, ts: '1784994600.000100' });
});

describe('sendReply', () => {
  it('posts to the conversation and returns Slack’s ts', async () => {
    const sent = await sendReply({
      conversationId: 'D0BKMJLRRNH',
      text: 'On it.',
    });

    expect(sent).toEqual({
      ts: '1784994600.000100',
      conversationId: 'D0BKMJLRRNH',
      threadTs: null,
      text: 'On it.',
    });
    expect(postMessage).toHaveBeenCalledWith({
      channel: 'D0BKMJLRRNH',
      text: 'On it.',
    });
  });

  it('includes thread_ts only when replying in a thread', async () => {
    await sendReply({
      conversationId: 'C1',
      text: 'in thread',
      threadTs: '1784994500.000100',
    });

    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      text: 'in thread',
      thread_ts: '1784994500.000100',
    });
  });

  it('omits thread_ts for a null or undefined thread', async () => {
    await sendReply({ conversationId: 'C1', text: 'top level', threadTs: null });
    expect(postMessage.mock.calls[0][0]).not.toHaveProperty('thread_ts');
  });

  it('trims the text before sending', async () => {
    await sendReply({ conversationId: 'C1', text: '  On it.  ' });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'On it.' }),
    );
  });

  it('refuses an empty reply', async () => {
    await expect(
      sendReply({ conversationId: 'C1', text: '   ' }),
    ).rejects.toThrow(EmptyReplyError);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('refuses a missing conversation id', async () => {
    await expect(sendReply({ conversationId: '', text: 'hi' })).rejects.toThrow(
      /conversation id is required/,
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('refuses an absurdly long reply before Slack does', async () => {
    await expect(
      sendReply({ conversationId: 'C1', text: 'x'.repeat(MAX_REPLY_LENGTH + 1) }),
    ).rejects.toThrow(/keep it under/);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('treats ok:false as a failure, with the reason', async () => {
    postMessage.mockResolvedValue({ ok: false, error: 'not_in_channel' });

    await expect(
      sendReply({ conversationId: 'C1', text: 'hi' }),
    ).rejects.toThrow(/not_in_channel/);
  });

  it('treats a missing ts as a failure even when ok is true', async () => {
    // Silently accepting this would mean the caller marks an item done for a
    // message that was never delivered.
    postMessage.mockResolvedValue({ ok: true });

    await expect(
      sendReply({ conversationId: 'C1', text: 'hi' }),
    ).rejects.toThrow(/without giving a reason|rejected/);
  });

  it('propagates a thrown transport error', async () => {
    postMessage.mockRejectedValue(new Error('ratelimited'));

    await expect(
      sendReply({ conversationId: 'C1', text: 'hi' }),
    ).rejects.toThrow(/ratelimited/);
  });
});

describe('replyTargetThreadTs', () => {
  const base = {
    threadTs: null as string | null,
    isThreadReply: false,
    isThreadParent: false,
    ts: '1784994576.623619',
  };

  it('is null for an ordinary top-level message', () => {
    expect(replyTargetThreadTs(base)).toBeNull();
  });

  it('continues the thread for a reply inside one', () => {
    expect(
      replyTargetThreadTs({
        ...base,
        threadTs: '1784994500.000100',
        isThreadReply: true,
      }),
    ).toBe('1784994500.000100');
  });

  it('replies into the thread of a thread parent, not the channel', () => {
    // Answering in the channel when the conversation has visibly moved into a
    // thread reads as a mistake to everyone watching.
    expect(replyTargetThreadTs({ ...base, isThreadParent: true })).toBe(base.ts);
  });

  it('prefers an explicit threadTs over the parent heuristic', () => {
    expect(
      replyTargetThreadTs({
        ...base,
        threadTs: '1784994400.000100',
        isThreadParent: true,
      }),
    ).toBe('1784994400.000100');
  });
});
