'use server';

import { revalidatePath } from 'next/cache';

import { prisma } from '@/lib/db';

/**
 * Server actions for SlackZero's own triage state.
 *
 * "Done" lives in `MessageState` and is deliberately *not* Slack's read/unread
 * flag (plan.md, Phase 2). Marking something done here never writes to Slack,
 * so triaging in SlackZero cannot surprise the user by changing what their
 * Slack client shows.
 *
 * These are server actions rather than client fetches, per CLAUDE.md: nothing
 * touching the database or Slack runs in the browser.
 */

export type SetDoneResult =
  | { ok: true; messageId: string; isDone: boolean; doneAtIso: string | null }
  | { ok: false; error: string };

/**
 * Set (or clear) the done flag on one message.
 *
 * Idempotent by construction — an upsert on the unique `messageId`, so a
 * double-tap of `e` or a retried action converges instead of erroring.
 * `doneAt` is cleared on un-done so Phase 7's response-time stats never see a
 * completion timestamp for something still open.
 */
export async function setMessageDone(
  messageId: string,
  isDone: boolean,
): Promise<SetDoneResult> {
  if (!messageId) {
    return { ok: false, error: 'A message id is required.' };
  }

  try {
    const doneAt = isDone ? new Date() : null;

    const state = await prisma.messageState.upsert({
      where: { messageId },
      create: { messageId, isDone, doneAt },
      update: { isDone, doneAt },
      select: { isDone: true, doneAt: true },
    });

    revalidatePath('/inbox');

    return {
      ok: true,
      messageId,
      isDone: state.isDone,
      doneAtIso: state.doneAt ? state.doneAt.toISOString() : null,
    };
  } catch (error) {
    // The most likely cause by far is a stale message id — the queue was
    // rendered, then the row was removed. Report it instead of throwing, so
    // the UI can roll its optimistic update back and say why.
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Could not save done state: ${detail}`,
    };
  }
}
