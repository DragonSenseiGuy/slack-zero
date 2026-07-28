'use server';

import { revalidatePath } from 'next/cache';

import { prisma } from '@/lib/db';
import { isLlmConfigured } from '@/lib/env';
import { renderSlackText } from '@/lib/queue/text';
import { generateDrafts } from '@/lib/reply/generate';
import { replyTargetThreadTs, sendReply } from '@/lib/reply/send';
import { describeSlackError } from '@/lib/slack/errors';
import type { ReplyDraft } from '@/lib/reply/draft';
import { getInstallation } from '@/lib/slack/installation';

export type SendReplyResult =
  | {
      ok: true;
      messageId: string;
      ts: string;
      markedDone: boolean;
    }
  | { ok: false; error: string };

export type DraftRepliesResult =
  | { ok: true; drafts: ReplyDraft[]; model: string }
  | { ok: false; error: string };

export async function sendReplyToMessage(
  messageId: string,
  text: string,
  options: {
    markDone?: boolean;
    alsoMarkDone?: readonly string[];
  } = {},
): Promise<SendReplyResult> {
  if (!messageId) return { ok: false, error: 'A message id is required.' };
  if (text.trim() === '') return { ok: false, error: 'A reply needs some text.' };

  let message;
  try {
    message = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        conversationId: true,
        ts: true,
        threadTs: true,
        isThreadReply: true,
        isThreadParent: true,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not read the message: ${detail}` };
  }

  if (!message) {
    return { ok: false, error: 'That message no longer exists.' };
  }

  let sentTs: string;
  try {
    const sent = await sendReply({
      conversationId: message.conversationId,
      text,
      threadTs: replyTargetThreadTs(message),
    });
    sentTs = sent.ts;
  } catch (error) {
    const failure = describeSlackError(error);
    return {
      ok: false,
      error: failure.retryable
        ? `${failure.message}`
        : `${failure.message} (Retrying will not help.)`,
    };
  }

  let markedDone = false;
  if (options.markDone) {
    try {
      const doneAt = new Date();
      const ids = [
        ...new Set([messageId, ...(options.alsoMarkDone ?? [])]),
      ].filter((id) => id !== '');

      await prisma.$transaction(
        ids.map((id) =>
          prisma.messageState.upsert({
            where: { messageId: id },
            create: { messageId: id, isDone: true, doneAt },
            update: { isDone: true, doneAt },
            select: { messageId: true },
          }),
        ),
      );
      markedDone = true;
    } catch {
      markedDone = false;
    }
  }

  revalidatePath('/inbox');

  return { ok: true, messageId, ts: sentTs, markedDone };
}

export async function draftReplies(
  messageId: string,
): Promise<DraftRepliesResult> {
  if (!messageId) return { ok: false, error: 'A message id is required.' };

  try {
    if (!isLlmConfigured()) {
      return {
        ok: false,
        error: 'No LLM key configured, so reply drafts are unavailable.',
      };
    }
  } catch {
    return { ok: false, error: 'Reply drafts are unavailable.' };
  }

  try {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        text: true,
        sentAt: true,
        threadTs: true,
        conversationId: true,
        user: { select: { displayName: true, realName: true, username: true } },
        conversation: { select: { kind: true, name: true } },
      },
    });

    if (!message) return { ok: false, error: 'That message no longer exists.' };

    const installation = await getInstallation();

    const history = await prisma.message.findMany({
      where: {
        conversationId: message.conversationId,
        sentAt: { lt: message.sentAt },
        isDeleted: false,
      },
      orderBy: { sentAt: 'desc' },
      take: 6,
      select: {
        text: true,
        userId: true,
        user: { select: { displayName: true, realName: true, username: true } },
      },
    });

    const users = new Map<string, string>();
    const channels = new Map<string, string>();
    const lookup = { users, channels };

    const senderLabel =
      message.user?.displayName ||
      message.user?.realName ||
      message.user?.username ||
      'them';

    const isDirectMessage =
      message.conversation.kind === 'IM' || message.conversation.kind === 'MPIM';

    const result = await generateDrafts({
      text: renderSlackText(message.text, lookup),
      senderLabel,
      selfLabel: 'me',
      contextLabel: isDirectMessage
        ? `DM · ${senderLabel}`
        : `#${message.conversation.name ?? message.conversationId}`,
      isDirectMessage,
      isThread: message.threadTs !== null,
      sentAtIso: message.sentAt.toISOString(),
      nowIso: new Date().toISOString(),
      history: history
        .slice()
        .reverse()
        .map((entry) => ({
          author:
            entry.userId && entry.userId === installation?.authedUserId
              ? 'me'
              : entry.user?.displayName ||
                entry.user?.realName ||
                entry.user?.username ||
                'them',
          text: renderSlackText(entry.text, lookup),
        })),
    });

    return { ok: true, drafts: result.drafts, model: result.model };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not draft a reply: ${detail}` };
  }
}
