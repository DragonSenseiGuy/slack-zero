'use server';

import { revalidatePath } from 'next/cache';

import { prisma } from '@/lib/db';
import { isLlmConfigured } from '@/lib/env';
import { renderSlackText } from '@/lib/queue/text';
import { generateDrafts } from '@/lib/reply/generate';
import { replyTargetThreadTs, sendReply } from '@/lib/reply/send';
import { describeSlackError } from '@/lib/slack/errors';
import type { ReplyDraft } from '@/lib/reply/draft';
import { getSlackContext } from '@/lib/slack/client';
import { hydrateConversation, hydrateExactMessage, hydrateHistory, hydrateUser } from '@/lib/slack/live';
import { normalizeConversation, normalizeMessage, normalizeUser } from '@/lib/slack/normalize';
import type { RawSlackMessage } from '@/lib/slack/raw';

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
        isDeleted: true,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not read the message: ${detail}` };
  }

  if (!message || message.isDeleted) {
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
        ts: true,
        sentAt: true,
        threadTs: true,
        conversationId: true,
        userId: true,
      },
    });

    if (!message) return { ok: false, error: 'That message no longer exists.' };

    const slack = await getSlackContext();
    const [rawMessage, rawConversation, historyResponse] = await Promise.all([
      hydrateExactMessage(slack.client, message.conversationId, message.ts),
      hydrateConversation(slack.client, message.conversationId),
      hydrateHistory(slack.client, message.conversationId, message.ts, 6),
    ]);
    if (!rawMessage) return { ok: false, error: 'That message is unavailable.' };
    const liveMessage = normalizeMessage(rawMessage, message.conversationId);
    const conversation = rawConversation ? normalizeConversation(rawConversation) : null;
    const history = ((historyResponse.messages as RawSlackMessage[] | undefined) ?? [])
      .map((raw) => normalizeMessage(raw, message.conversationId))
      .reverse();
    const userIds = [...new Set([liveMessage.userId, ...history.map((entry) => entry.userId)].filter((id): id is string => Boolean(id)))];
    const userEntries = await Promise.all(userIds.map(async (id) => {
      const raw = await hydrateUser(slack.client, id);
      const user = raw ? normalizeUser(raw) : null;
      return [id, user?.displayName || user?.realName || user?.username || 'them'] as const;
    }));
    const userLabels = new Map(userEntries);

    const users = new Map<string, string>();
    const channels = new Map<string, string>();
    const lookup = { users, channels };

    const senderLabel =
      (liveMessage.userId ? userLabels.get(liveMessage.userId) : liveMessage.authorName) || 'them';

    const isDirectMessage =
      conversation?.kind === 'IM' || conversation?.kind === 'MPIM';

    const result = await generateDrafts({
      text: renderSlackText(liveMessage.text, lookup),
      senderLabel,
      selfLabel: 'me',
      contextLabel: isDirectMessage
        ? `DM · ${senderLabel}`
        : `#${conversation?.name ?? message.conversationId}`,
      isDirectMessage,
      isThread: message.threadTs !== null,
      sentAtIso: liveMessage.sentAt.toISOString(),
      nowIso: new Date().toISOString(),
      history: history.map((entry) => ({
          author:
            entry.userId && entry.userId === slack.authedUserId
              ? 'me'
              : (entry.userId ? userLabels.get(entry.userId) : entry.authorName) || 'them',
          text: renderSlackText(entry.text, lookup),
        })),
    });

    return { ok: true, drafts: result.drafts, model: result.model };
  } catch {
    return { ok: false, error: 'Could not draft a reply right now. Please try again.' };
  }
}
