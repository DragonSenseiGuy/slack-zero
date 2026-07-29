import { getSlackContext } from '@/lib/slack/client';

export class EmptyReplyError extends Error {
  constructor() {
    super('A reply needs some text.');
    this.name = 'EmptyReplyError';
  }
}

export const MAX_REPLY_LENGTH = 4000;

export type SendReplyInput = {
  conversationId: string;
  text: string;
  threadTs?: string | null;
};

export type SentReply = {
  ts: string;
  conversationId: string;
  threadTs: string | null;
  text: string;
};

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
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
  });

  if (!response.ok || !response.ts) {
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

export function replyTargetThreadTs(message: {
  threadTs: string | null;
  ts: string;
}): string | null {
  if (message.threadTs) return message.threadTs;
  return null;
}
