import { PrismaClient } from '@prisma/client';

import 'dotenv/config';

/**
 * Deterministic fixtures for the inbox e2e spec.
 *
 * Why seed at all: the connected workspace has a handful of real messages, no
 * threads, and no guarantee of staying that way. An e2e test that asserts on
 * whatever Slack happens to contain is a test that fails for reasons unrelated
 * to the code.
 *
 * Why it is safe: every row this module writes or deletes is keyed on an id in
 * the `E2E` namespace below. Real Slack ids in this workspace look like
 * `U0BK9FR4Y1M` / `C0BFRLH0SDU` and cannot collide. Nothing here issues an
 * unscoped delete, and nothing touches `SlackInstallation`, so the real
 * ingested rows from Phase 1 are never at risk.
 */

export const FIXTURE_CHANNEL_ID = 'CE2ESEED001';
export const FIXTURE_CHANNEL_NAME = 'e2e-seed';
export const FIXTURE_USER_ID = 'UE2ESEED001';
export const FIXTURE_USER_LABEL = 'E2E Fixture Sender';

/** Base instant for the fixtures: fixed, so `ts` values never drift. */
const BASE_EPOCH_SECONDS = Math.floor(
  Date.UTC(2026, 6, 20, 12, 0, 0) / 1000,
);

function fixtureTs(offsetSeconds: number): string {
  return `${BASE_EPOCH_SECONDS + offsetSeconds}.000100`;
}

/** Top-level queue items, oldest first. The list renders them newest first. */
export const FIXTURE_MESSAGES = [
  { offset: 10, text: 'E2E alpha — first fixture message' },
  { offset: 20, text: 'E2E bravo — second fixture message' },
  { offset: 30, text: 'E2E charlie — third fixture message' },
  { offset: 40, text: 'E2E delta — fourth fixture message' },
  { offset: 50, text: 'E2E echo — fifth fixture message' },
  { offset: 60, text: 'E2E foxtrot — sixth fixture message' },
] as const;

export const FIXTURE_THREAD_PARENT = {
  offset: 70,
  text: 'E2E golf — thread parent',
} as const;

export const FIXTURE_THREAD_REPLIES = [
  { offset: 71, text: 'E2E thread reply one' },
  { offset: 72, text: 'E2E thread reply two' },
] as const;

/** Total number of *top-level* queue items the fixtures produce. */
export const FIXTURE_ITEM_COUNT = FIXTURE_MESSAGES.length + 1;

/** The newest fixture item — the one the queue puts first under the scope. */
export const FIXTURE_NEWEST_TEXT = FIXTURE_THREAD_PARENT.text;
export const FIXTURE_SECOND_TEXT =
  FIXTURE_MESSAGES[FIXTURE_MESSAGES.length - 1].text;

const prisma = new PrismaClient();

/** Every message id this module owns. Used for both writes and cleanup. */
function fixtureMessageIds(): string[] {
  return [
    ...FIXTURE_MESSAGES.map((_, index) => `me2e-msg-${index}`),
    'me2e-thread-parent',
    ...FIXTURE_THREAD_REPLIES.map((_, index) => `me2e-thread-reply-${index}`),
  ];
}

/**
 * The Slack id of the connected user. Fixture messages @-mention them, which
 * is what puts a channel message in the queue at all.
 *
 * Returns null when Slack has never been connected — the spec skips rather
 * than inventing an installation, because writing a fake one would corrupt the
 * app's single source of truth for which account is being triaged.
 */
export async function getAuthedUserId(): Promise<string | null> {
  const installation = await prisma.slackInstallation.findFirst({
    orderBy: { updatedAt: 'desc' },
    select: { authedUserId: true },
  });
  return installation?.authedUserId ?? null;
}

/**
 * Remove every fixture row. Scoped to the `E2E` id namespace by explicit id —
 * never by a `where` clause that could match real data.
 */
export async function clearInboxFixtures(): Promise<void> {
  await prisma.message.deleteMany({ where: { id: { in: fixtureMessageIds() } } });
  await prisma.conversation.deleteMany({
    where: { id: FIXTURE_CHANNEL_ID },
  });
  await prisma.user.deleteMany({ where: { id: FIXTURE_USER_ID } });
  // Views the Phase 4 suite creates. Built-ins are left alone: they are
  // re-seeded by `listViews()` and deleting them is refused anyway.
  await prisma.viewDefinition.deleteMany({
    where: { name: { startsWith: E2E_VIEW_PREFIX }, isBuiltIn: false },
  });
}

/**
 * Names for views created by the e2e suite. Prefixed so cleanup can delete
 * exactly the suite's own rows and never a view the user made by hand.
 */
export const E2E_VIEW_PREFIX = 'E2E ';

/**
 * Triage results for the fixtures, written straight to the database.
 *
 * Deliberately not produced by calling the model: a Playwright run must not
 * depend on the live proxy, and Phase 4 is about whether *filters* select the
 * right subset, which needs the categories to be known and fixed. Model quality
 * is Phase 3's problem and is measured in `src/lib/triage/fixtures.test.ts`.
 *
 * alpha/bravo are action_needed, charlie/delta are fyi, echo/foxtrot are misc,
 * and the thread parent is left unclassified so the suite also covers "a view
 * that filters on category excludes rows the classifier has not reached".
 */
export const FIXTURE_CATEGORIES = {
  'me2e-msg-0': { category: 'ACTION_NEEDED' as const, urgencyScore: 90 },
  'me2e-msg-1': { category: 'ACTION_NEEDED' as const, urgencyScore: 55 },
  'me2e-msg-2': { category: 'FYI' as const, urgencyScore: 25 },
  'me2e-msg-3': { category: 'FYI' as const, urgencyScore: 20 },
  'me2e-msg-4': { category: 'MISC' as const, urgencyScore: 10 },
  'me2e-msg-5': { category: 'MISC' as const, urgencyScore: 5 },
} as const;

export const FIXTURE_ACTION_NEEDED_COUNT = 2;
export const FIXTURE_FYI_MISC_COUNT = 4;
/** The one row deliberately left without a Classification. */
export const FIXTURE_UNCLASSIFIED_COUNT = 1;

/** Mark the fixture sender VIP (or not), for the VIP filter and sort. */
export async function setFixtureSenderVip(isVip: boolean): Promise<void> {
  await prisma.user.update({
    where: { id: FIXTURE_USER_ID },
    data: { isVip },
  });
}

/** Idempotent: clears first, so a crashed run cannot poison the next one. */
export async function seedInboxFixtures(authedUserId: string): Promise<void> {
  await clearInboxFixtures();

  await prisma.user.create({
    data: {
      id: FIXTURE_USER_ID,
      username: 'e2e-fixture',
      realName: FIXTURE_USER_LABEL,
      displayName: FIXTURE_USER_LABEL,
      isBot: false,
    },
  });

  await prisma.conversation.create({
    data: {
      id: FIXTURE_CHANNEL_ID,
      kind: 'PUBLIC_CHANNEL',
      name: FIXTURE_CHANNEL_NAME,
      isMember: true,
    },
  });

  const common = {
    conversationId: FIXTURE_CHANNEL_ID,
    userId: FIXTURE_USER_ID,
    source: 'BACKFILL' as const,
  };

  await prisma.message.createMany({
    data: [
      ...FIXTURE_MESSAGES.map((message, index) => ({
        ...common,
        id: `me2e-msg-${index}`,
        ts: fixtureTs(message.offset),
        sentAt: new Date((BASE_EPOCH_SECONDS + message.offset) * 1000),
        text: `<@${authedUserId}> ${message.text}`,
        mentionedUserIds: [authedUserId],
      })),
      {
        ...common,
        id: 'me2e-thread-parent',
        ts: fixtureTs(FIXTURE_THREAD_PARENT.offset),
        sentAt: new Date(
          (BASE_EPOCH_SECONDS + FIXTURE_THREAD_PARENT.offset) * 1000,
        ),
        text: `<@${authedUserId}> ${FIXTURE_THREAD_PARENT.text}`,
        mentionedUserIds: [authedUserId],
        threadTs: fixtureTs(FIXTURE_THREAD_PARENT.offset),
        isThreadParent: true,
        replyCount: FIXTURE_THREAD_REPLIES.length,
      },
      ...FIXTURE_THREAD_REPLIES.map((reply, index) => ({
        ...common,
        id: `me2e-thread-reply-${index}`,
        ts: fixtureTs(reply.offset),
        sentAt: new Date((BASE_EPOCH_SECONDS + reply.offset) * 1000),
        // No mention: these must appear *inside* the thread in the reading
        // pane, not as separate rows in the queue.
        text: reply.text,
        threadTs: fixtureTs(FIXTURE_THREAD_PARENT.offset),
        isThreadReply: true,
      })),
    ],
  });

  await prisma.classification.createMany({
    data: Object.entries(FIXTURE_CATEGORIES).map(([messageId, result]) => ({
      messageId,
      category: result.category,
      urgencyScore: result.urgencyScore,
      isBump: false,
      reason: 'seeded by the e2e fixtures, not by the model',
      model: 'e2e-fixture',
    })),
  });
}

export async function disconnectFixtures(): Promise<void> {
  await prisma.$disconnect();
}
