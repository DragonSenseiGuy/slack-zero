'use server';

import { revalidatePath } from 'next/cache';

import { prisma } from '@/lib/db';
import {
  InvalidSnoozeTimeError,
  resolveSnoozePreset,
  validateSnoozeTime,
  type SnoozePreset,
} from '@/lib/snooze/schedule';

/**
 * Server actions for snoozing (plan.md, Phase 6).
 *
 * Snooze lives in `MessageState` alongside done — both are our own triage state,
 * never written back to Slack. Snoozing here does not mark anything read in the
 * user's Slack client.
 */

export type SnoozeResult =
  | { ok: true; messageId: string; snoozedUntilIso: string }
  | { ok: false; error: string };

export type UnsnoozeResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

/**
 * Snooze a message until a preset or an explicit time.
 *
 * `snoozedAt` is stored as well as `snoozedUntil`, and it is not decoration: the
 * early-unsnooze check compares thread activity against *when the snooze was
 * set*. Without it, the message that prompted the snooze would immediately wake
 * the item back up.
 */
export async function snoozeMessage(
  messageId: string,
  input: { preset: SnoozePreset; customIso?: string },
): Promise<SnoozeResult> {
  if (!messageId) return { ok: false, error: 'A message id is required.' };

  const now = new Date();

  let until: Date | null;
  if (input.preset === 'custom') {
    if (!input.customIso) {
      return { ok: false, error: 'Pick a time to snooze until.' };
    }
    until = new Date(input.customIso);
  } else {
    until = resolveSnoozePreset(input.preset, now);
  }

  if (until === null) {
    return { ok: false, error: 'Could not work out a snooze time.' };
  }

  try {
    validateSnoozeTime(until, now);
  } catch (error) {
    if (error instanceof InvalidSnoozeTimeError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }

  try {
    await prisma.messageState.upsert({
      where: { messageId },
      create: {
        messageId,
        snoozedUntil: until,
        snoozedAt: now,
        // Snoozing something already done would be contradictory; snoozing is a
        // way of saying "not now", which implies not done.
        isDone: false,
        doneAt: null,
      },
      update: {
        snoozedUntil: until,
        snoozedAt: now,
        isDone: false,
        doneAt: null,
      },
    });

    revalidatePath('/inbox');
    return { ok: true, messageId, snoozedUntilIso: until.toISOString() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not snooze: ${detail}` };
  }
}

/** Bring a snoozed message back immediately. */
export async function unsnoozeMessage(
  messageId: string,
): Promise<UnsnoozeResult> {
  if (!messageId) return { ok: false, error: 'A message id is required.' };

  try {
    await prisma.messageState.upsert({
      where: { messageId },
      create: { messageId },
      update: { snoozedUntil: null, snoozedAt: null },
    });

    revalidatePath('/inbox');
    return { ok: true, messageId };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not unsnooze: ${detail}` };
  }
}

/**
 * Clear snoozes that are due, so the items rejoin the queue.
 *
 * Called by the background sweep and on inbox load. Idempotent: a second run
 * finds nothing to do, so a missed sweep costs latency rather than correctness.
 * That is why this is a sweep and not a timer per message — a timer would not
 * survive the app being closed overnight, which is exactly when a "tomorrow
 * morning" snooze elapses.
 *
 * Returns how many rows were woken, for logging.
 */
export async function sweepDueSnoozes(): Promise<number> {
  const now = new Date();

  const result = await prisma.messageState.updateMany({
    where: { snoozedUntil: { not: null, lte: now } },
    data: { snoozedUntil: null, snoozedAt: null },
  });

  if (result.count > 0) revalidatePath('/inbox');
  return result.count;
}

/**
 * Wake anything snoozed whose thread has seen activity since the snooze was set.
 *
 * Done in SQL rather than by loading every snoozed row, because the comparison
 * is between two columns across a join and the set is unbounded. The equivalent
 * pure logic — and the tests that pin its semantics down — is
 * `hasNewActivitySinceSnooze` in `schedule.ts`.
 */
export async function sweepActivityWakeups(): Promise<number> {
  const woken = await prisma.$executeRaw`
    UPDATE "MessageState" ms
    SET "snoozedUntil" = NULL, "snoozedAt" = NULL
    FROM "Message" m
    WHERE ms."messageId" = m.id
      AND ms."snoozedUntil" IS NOT NULL
      AND ms."snoozedAt" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "Message" other
        WHERE other."conversationId" = m."conversationId"
          AND other."isDeleted" = false
          AND other."sentAt" > ms."snoozedAt"
          AND (
            m."threadTs" IS NULL
            OR other."threadTs" = m."threadTs"
          )
      )
  `;

  if (woken > 0) revalidatePath('/inbox');
  return woken;
}

/** Both sweeps, as the background job and the inbox loader run them. */
export async function runSnoozeSweeps(): Promise<{
  byTime: number;
  byActivity: number;
}> {
  // Activity first: an item woken by a reply should report that as the reason,
  // and clearing by time first would erase the evidence.
  const byActivity = await sweepActivityWakeups();
  const byTime = await sweepDueSnoozes();
  return { byTime, byActivity };
}
