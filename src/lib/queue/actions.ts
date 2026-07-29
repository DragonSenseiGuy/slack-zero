'use server';

import { revalidatePath } from 'next/cache';

import { requireOwnerSession } from '@/lib/auth/require';
import { prisma } from '@/lib/db';

export type SetDoneResult =
  | {
      ok: true;
      messageIds: string[];
      isDone: boolean;
      doneAtIso: string | null;
    }
  | { ok: false; error: string };

export async function setMessageDone(
  messageId: string,
  isDone: boolean,
): Promise<SetDoneResult> {
  return setMessagesDone([messageId], isDone);
}

export async function setMessagesDone(
  messageIds: readonly string[],
  isDone: boolean,
): Promise<SetDoneResult> {
  await requireOwnerSession();

  const ids = [...new Set(messageIds.filter((id) => id !== ''))];

  if (ids.length === 0) {
    return { ok: false, error: 'A message id is required.' };
  }

  try {
    const doneAt = isDone ? new Date() : null;

    await prisma.$transaction(
      ids.map((messageId) =>
        prisma.messageState.upsert({
          where: { messageId },
          create: { messageId, isDone, doneAt },
          update: { isDone, doneAt },
          select: { messageId: true },
        }),
      ),
    );

    revalidatePath('/inbox');

    return {
      ok: true,
      messageIds: ids,
      isDone,
      doneAtIso: doneAt ? doneAt.toISOString() : null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Could not save done state: ${detail}`,
    };
  }
}
