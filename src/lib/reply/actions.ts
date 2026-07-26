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

/**
 * Server actions for replying (plan.md, Phase 5).
 *
 * Both actions return a result object rather than throwing, so the UI can roll
 * an optimistic update back and say *why*. That matters more here than anywhere
 * else in the app: this is the only code path that writes to Slack, and
 * "appeared to send but didn't" is the worst possible failure mode for a triage
 * tool — the user moves on believing they replied.
 */

export type SendReplyResult =
  | {
      ok: true;
      messageId: string;
      ts: string;
      /** Whether the item was also marked done, per the caller's request. */
      markedDone: boolean;
    }
  | { ok: false; error: string };

export type DraftRepliesResult =
  | { ok: true; drafts: ReplyDraft[]; model: string }
  | { ok: false; error: string };

/**
 * Send a reply to the Slack message identified by our internal id, and
 * optionally mark it done.
 *
 * Order is deliberate: **send first, then mark done.** If the send fails there
 * is nothing to undo, and the item stays in the queue where the user can see it
 * still needs handling. Marking done first would mean a failed send silently
 * removed the item — plan.md calls this out as its own verification bullet
 * ("confirm UI shows error and does not falsely mark done").
 */
export async function sendReplyToMessage(
  messageId: string,
  text: string,
  options: { markDone?: boolean } = {},
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
    // Slack's raw codes ("not_in_channel", "ratelimited") tell the user nothing
    // about whether to retry or go fix a permission (Phase 8).
    const failure = describeSlackError(error);
    return {
      ok: false,
      error: failure.retryable
        ? `${failure.message}`
        : `${failure.message} (Retrying will not help.)`,
    };
  }

  // Sent. From here on nothing may turn this into a failure result — the
  // message is really in Slack, and telling the user it failed would be worse
  // than a missing done flag.
  let markedDone = false;
  if (options.markDone) {
    try {
      await prisma.messageState.upsert({
        where: { messageId },
        create: { messageId, isDone: true, doneAt: new Date() },
        update: { isDone: true, doneAt: new Date() },
      });
      markedDone = true;
    } catch {
      // Swallowed on purpose, and reported as `markedDone: false` rather than as
      // an error: the reply landed, so the UI should show success and simply
      // leave the item in the queue.
      markedDone = false;
    }
  }

  revalidatePath('/inbox');

  return { ok: true, messageId, ts: sentTs, markedDone };
}

/**
 * Ask the model for reply suggestions.
 *
 * Never throws into the UI and never blocks sending: if drafting is unavailable
 * (no key, rate limited, unparseable response) the user still has a compose box.
 * Drafts are a convenience layered on top of replying, not a dependency of it.
 */
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

    // Recent context from the same conversation, for tone and continuity.
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
      // Rendered, not raw: the model should see "@Ada", not "<@U123>".
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
