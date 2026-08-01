import { PrismaClient } from '@prisma/client';

import {
  DEMO_CONVERSATIONS,
  DEMO_MESSAGES,
  DEMO_OWNER_USER_ID,
  DEMO_USERS,
  DEMO_VIP_USER_IDS,
  type DemoMessage,
} from '@/lib/demo/workspace';

/**
 * Write the demo workspace into the database.
 *
 * Everything here is keyed on an id in the `DEMO` namespace, and cleanup
 * deletes by explicit id — never by an unscoped `where` — so pointing this at
 * the wrong database costs you nothing but seven rows of fiction. It still
 * refuses to run where a real installation exists; see src/lib/demo/guard.ts.
 *
 * Message *text* is not written: this app never persists Slack content (see
 * PRIVACY_MIGRATION.md). Rows here are identities and triage state, and the
 * text is served from src/lib/demo/workspace.ts at render time, exactly where
 * a live install would call Slack.
 */

export type DemoSeedSummary = {
  conversations: number;
  messages: number;
  classifications: number;
  states: number;
};

function tsFor(sentAt: Date): string {
  return `${Math.floor(sentAt.getTime() / 1000)}.000100`;
}

function sentAtFor(message: DemoMessage, now: Date): Date {
  return new Date(now.getTime() - message.minutesAgo * 60_000);
}

export function demoMessageIds(): string[] {
  return DEMO_MESSAGES.map((message) => message.id);
}

export async function clearDemoWorkspace(prisma: PrismaClient): Promise<void> {
  await prisma.message.deleteMany({ where: { id: { in: demoMessageIds() } } });
  await prisma.conversation.deleteMany({
    where: { id: { in: DEMO_CONVERSATIONS.map((conversation) => conversation.id) } },
  });
  await prisma.user.deleteMany({ where: { id: { in: Object.keys(DEMO_USERS) } } });
}

/** Idempotent: clears the demo rows first, so re-seeding refreshes timestamps. */
export async function seedDemoWorkspace(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<DemoSeedSummary> {
  await clearDemoWorkspace(prisma);

  await prisma.user.createMany({
    data: Object.keys(DEMO_USERS).map((id) => ({
      id,
      isVip: (DEMO_VIP_USER_IDS as readonly string[]).includes(id),
    })),
  });

  await prisma.conversation.createMany({
    data: DEMO_CONVERSATIONS.map((conversation) => ({
      id: conversation.id,
      kind: conversation.kind,
      peerUserId: conversation.peerUserId ?? null,
      lastSyncedAt: now,
    })),
  });

  // Thread replies need the parent's `ts`, so resolve every timestamp first.
  const sentAt = new Map(
    DEMO_MESSAGES.map((message) => [message.id, sentAtFor(message, now)]),
  );
  const tsById = new Map(
    DEMO_MESSAGES.map((message) => [message.id, tsFor(sentAt.get(message.id)!)]),
  );

  await prisma.message.createMany({
    data: DEMO_MESSAGES.map((message) => {
      const parentTs = message.threadOf ? tsById.get(message.threadOf) : undefined;
      const ownTs = tsById.get(message.id)!;
      const isThreadParent = DEMO_MESSAGES.some(
        (other) => other.threadOf === message.id,
      );
      return {
        id: message.id,
        conversationId: message.conversationId,
        userId: message.userId,
        ts: ownTs,
        sentAt: sentAt.get(message.id)!,
        threadTs: parentTs ?? (isThreadParent ? ownTs : null),
        source: 'BACKFILL' as const,
        isContent: true,
        // The owner's own messages are not addressed to the owner; everything
        // else in a channel needs this or the queue will not route it.
        mentionsAuthedUser: Boolean(message.mentionsOwner),
      };
    }),
  });

  const classifications = DEMO_MESSAGES.filter((message) => message.triage);
  await prisma.classification.createMany({
    data: classifications.map((message) => ({
      messageId: message.id,
      urgencyScore: message.triage!.urgencyScore,
      category: message.triage!.category,
      isBump: message.triage!.isBump ?? false,
      bumpOfMessageId: message.triage!.bumpOf ?? null,
      reasonCode: message.triage!.reasonCode,
      model: 'qwen/qwen3-32b',
    })),
  });

  const stated = DEMO_MESSAGES.filter((message) => message.state);
  await prisma.messageState.createMany({
    data: stated.map((message) => {
      const state = message.state!;
      const sent = sentAt.get(message.id)!;
      const doneAt =
        state.isDone && state.doneAfterMinutes !== undefined
          ? new Date(sent.getTime() + state.doneAfterMinutes * 60_000)
          : null;
      return {
        messageId: message.id,
        isDone: Boolean(state.isDone),
        doneAt,
        snoozedUntil:
          state.snoozedInMinutes !== undefined
            ? new Date(now.getTime() + state.snoozedInMinutes * 60_000)
            : null,
        snoozedAt: state.snoozedInMinutes !== undefined ? now : null,
        isWaitingOn: Boolean(state.isWaitingOn),
        waitingOnSince: state.isWaitingOn ? sent : null,
      };
    }),
  });

  return {
    conversations: DEMO_CONVERSATIONS.length,
    messages: DEMO_MESSAGES.length,
    classifications: classifications.length,
    states: stated.length,
  };
}

/** The owner id the seeded data is addressed to. Exported for scripts. */
export const DEMO_SEED_OWNER = DEMO_OWNER_USER_ID;
