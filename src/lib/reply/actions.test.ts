import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * plan.md, Phase 5 verification: "Failure-path test: simulate Slack API error on
 * send, confirm UI shows error and does not falsely mark done".
 *
 * That is the whole point of this file. A triage tool that removes an item from
 * the queue for a reply that never reached Slack is worse than one that refuses
 * to send: the user moves on believing they answered, and nothing ever surfaces
 * the message again.
 *
 * Everything with a side effect is mocked — no database, no Slack, no LLM
 * (CLAUDE.md).
 */

const sendReply = vi.fn();
const messageStateUpsert = vi.fn();
const messageFindUnique = vi.fn();
const revalidatePath = vi.fn();

vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    message: {
      findUnique: (...args: unknown[]) => messageFindUnique(...args),
      findMany: vi.fn(),
    },
    messageState: {
      upsert: (...args: unknown[]) => messageStateUpsert(...args),
    },
  },
}));

vi.mock('@/lib/reply/send', async () => {
  const actual = await import('@/lib/reply/send');
  return {
    ...actual,
    sendReply: (...args: unknown[]) => sendReply(...args),
  };
});

vi.mock('@/lib/env', () => ({ isLlmConfigured: () => false }));
vi.mock('@/lib/reply/generate', () => ({ generateDrafts: vi.fn() }));
vi.mock('@/lib/slack/installation', () => ({ getInstallation: vi.fn() }));

const { sendReplyToMessage, draftReplies } = await import(
  '@/lib/reply/actions'
);

const MESSAGE = {
  id: 'm1',
  conversationId: 'D0BKMJLRRNH',
  ts: '1784994576.623619',
  threadTs: null,
  isThreadReply: false,
  isThreadParent: false,
};

beforeEach(() => {
  sendReply.mockReset();
  messageStateUpsert.mockReset();
  messageFindUnique.mockReset();
  revalidatePath.mockReset();
  messageFindUnique.mockResolvedValue(MESSAGE);
});

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

describe('sendReplyToMessage on success', () => {
  it('sends the reply and reports the Slack ts', async () => {
    sendReply.mockResolvedValue({ ts: '1784994600.000100' });

    const result = await sendReplyToMessage('m1', 'On it.');

    expect(result).toEqual({
      ok: true,
      messageId: 'm1',
      ts: '1784994600.000100',
      markedDone: false,
    });
    expect(sendReply).toHaveBeenCalledWith({
      conversationId: 'D0BKMJLRRNH',
      text: 'On it.',
      threadTs: null,
    });
  });

  it('marks the item done when asked', async () => {
    sendReply.mockResolvedValue({ ts: '1784994600.000100' });

    const result = await sendReplyToMessage('m1', 'On it.', { markDone: true });

    expect(result.ok && result.markedDone).toBe(true);
    expect(messageStateUpsert).toHaveBeenCalledTimes(1);
    const call = messageStateUpsert.mock.calls[0][0] as {
      create: { isDone: boolean };
    };
    expect(call.create.isDone).toBe(true);
  });

  it('does not mark done unless asked — auto-done is configurable', () => {
    sendReply.mockResolvedValue({ ts: '1' });
    return sendReplyToMessage('m1', 'On it.').then(() => {
      expect(messageStateUpsert).not.toHaveBeenCalled();
    });
  });

  it('routes a reply into the thread when the message is in one', async () => {
    messageFindUnique.mockResolvedValue({
      ...MESSAGE,
      threadTs: '1784994500.000100',
      isThreadReply: true,
    });
    sendReply.mockResolvedValue({ ts: '1' });

    await sendReplyToMessage('m1', 'Replying in thread.');

    expect(sendReply).toHaveBeenCalledWith(
      expect.objectContaining({ threadTs: '1784994500.000100' }),
    );
  });

  it('replies into the thread of a thread parent, not the channel', async () => {
    messageFindUnique.mockResolvedValue({
      ...MESSAGE,
      isThreadParent: true,
    });
    sendReply.mockResolvedValue({ ts: '1' });

    await sendReplyToMessage('m1', 'Answering.');

    expect(sendReply).toHaveBeenCalledWith(
      expect.objectContaining({ threadTs: MESSAGE.ts }),
    );
  });
});

// ---------------------------------------------------------------------------
// The failure path — plan.md's explicit verification bullet
// ---------------------------------------------------------------------------

describe('sendReplyToMessage when Slack rejects the send', () => {
  it('reports the error and does NOT mark the item done', async () => {
    sendReply.mockRejectedValue(new Error('channel_not_found'));

    const result = await sendReplyToMessage('m1', 'On it.', { markDone: true });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/channel_not_found/);

    // The assertion this whole file exists for.
    expect(messageStateUpsert).not.toHaveBeenCalled();
  });

  it('does not revalidate on failure — nothing changed', async () => {
    sendReply.mockRejectedValue(new Error('not_in_channel'));

    await sendReplyToMessage('m1', 'On it.', { markDone: true });

    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('surfaces a rate-limit failure rather than appearing to succeed', async () => {
    sendReply.mockRejectedValue(new Error('ratelimited'));

    const result = await sendReplyToMessage('m1', 'On it.', { markDone: true });

    expect(result.ok).toBe(false);
    expect(messageStateUpsert).not.toHaveBeenCalled();
  });

  it('refuses an empty reply without calling Slack at all', async () => {
    const result = await sendReplyToMessage('m1', '   ');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/needs some text/);
    expect(sendReply).not.toHaveBeenCalled();
    expect(messageStateUpsert).not.toHaveBeenCalled();
  });

  it('refuses a missing message id', async () => {
    const result = await sendReplyToMessage('', 'On it.');
    expect(result.ok).toBe(false);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('reports a message that has since been deleted', async () => {
    messageFindUnique.mockResolvedValue(null);

    const result = await sendReplyToMessage('m1', 'On it.');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no longer exists/);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('reports a database failure before sending anything', async () => {
    messageFindUnique.mockRejectedValue(new Error('connection refused'));

    const result = await sendReplyToMessage('m1', 'On it.');

    expect(result.ok).toBe(false);
    expect(sendReply).not.toHaveBeenCalled();
  });
});

/**
 * The mirror of the above: once the reply is really in Slack, nothing may turn
 * the result back into a failure. A missing done flag is recoverable — the item
 * is still in the queue. Telling the user the send failed when it did not means
 * they send it twice.
 */
describe('sendReplyToMessage when the send worked but the done write did not', () => {
  it('still reports success, with markedDone false', async () => {
    sendReply.mockResolvedValue({ ts: '1784994600.000100' });
    messageStateUpsert.mockRejectedValue(new Error('deadlock detected'));

    const result = await sendReplyToMessage('m1', 'On it.', { markDone: true });

    expect(result.ok).toBe(true);
    expect(result.ok && result.markedDone).toBe(false);
    expect(result.ok && result.ts).toBe('1784994600.000100');
  });
});

// ---------------------------------------------------------------------------
// Drafts degrade rather than break replying
// ---------------------------------------------------------------------------

describe('draftReplies', () => {
  it('reports unavailability instead of throwing when no LLM key is set', async () => {
    // Drafts are a convenience layered on replying, never a dependency of it —
    // the compose box must work with no key configured.
    const result = await draftReplies('m1');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/No LLM key/);
  });

  it('refuses a missing message id', async () => {
    const result = await draftReplies('');
    expect(result.ok).toBe(false);
  });
});
