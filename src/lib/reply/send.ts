import { getSlackContext } from '@/lib/slack/client';

/**
 * Sending a reply to Slack (plan.md, Phase 5).
 *
 * This is the first thing in SlackZero that *writes* to Slack. Everything up to
 * now has been read-only, or has written only to our own state (`MessageState`),
 * so nothing the app did could be seen by anyone else. That is no longer true,
 * which is why this module is small, explicit, and refuses anything ambiguous
 * rather than guessing where a message should go.
 */

export class EmptyReplyError extends Error {
  constructor() {
    super('A reply needs some text.');
    this.name = 'EmptyReplyError';
  }
}

/** Slack rejects a `text` above 40k; anything near it is a bug, not a reply. */
export const MAX_REPLY_LENGTH = 4000;

export type SendReplyInput = {
  conversationId: string;
  text: string;
  /**
   * Reply inside a thread when set. For a message that is itself a thread reply
   * this is the parent's `ts`; for a thread parent it is the parent's own `ts`.
   * Undefined sends to the conversation top level.
   */
  threadTs?: string | null;
};

export type SentReply = {
  /** Slack's `ts` for the message we just created. */
  ts: string;
  conversationId: string;
  threadTs: string | null;
  text: string;
};

/**
 * Post a reply.
 *
 * `chat.postMessage` with a user token posts *as the user*, which is what makes
 * this a real reply rather than a bot message in the same channel.
 */
export async function sendReply(input: SendReplyInput): Promise<SentReply> {
  const text = input.text.trim();

  if (text === '') throw new EmptyReplyError();
  if (text.length > MAX_REPLY_LENGTH) {
    throw new Error(
      `Reply is ${text.length} characters; keep it under ${MAX_REPLY_LENGTH}.`,
    );
  }
  if (!input.conversationId) {
    throw new Error('A conversation id is required to send a reply.');
  }

  const { client } = await getSlackContext();

  const response = await client.chat.postMessage({
    channel: input.conversationId,
    text,
    // Never let a reply fan out as a new top-level message when it was meant for
    // a thread; that is a visible, embarrassing failure in a shared channel.
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
  });

  if (!response.ok || !response.ts) {
    // `WebClient` throws on most failures, but an `ok: false` with no error
    // string is possible, and silently treating that as success would mean the
    // UI marks an item done for a message that was never delivered.
    throw new Error(
      `Slack rejected the message${
        response.error ? `: ${response.error}` : ' without giving a reason.'
      }`,
    );
  }

  return {
    ts: response.ts,
    conversationId: input.conversationId,
    threadTs: input.threadTs ?? null,
    text,
  };
}

/**
 * Where a reply to this message should go.
 *
 * Replying to anything already in a thread continues that thread. Replying to a
 * thread *parent* also goes into the thread — answering in the channel when the
 * conversation has visibly moved into a thread is the wrong place, and Slack
 * users read it as a mistake.
 */
export function replyTargetThreadTs(message: {
  threadTs: string | null;
  isThreadReply: boolean;
  isThreadParent: boolean;
  ts: string;
}): string | null {
  if (message.threadTs) return message.threadTs;
  if (message.isThreadParent) return message.ts;
  return null;
}
