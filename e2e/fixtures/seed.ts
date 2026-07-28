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

/**
 * A second voice in the fixture channel, whose messages never mention the user
 * and so never enter the queue.
 *
 * They are not decoration. Consecutive messages from one sender are one queue
 * row now — a person talking at you is one task, not six — so six fixture
 * messages from one sender with nothing in between would render as a single
 * item and take the filter and navigation suites with it. Interleaving someone
 * else restores what the fixtures always assumed: six separate things to
 * triage.
 */
export const FIXTURE_BYSTANDER_ID = 'UE2EGAP0001';
export const FIXTURE_BYSTANDER_LABEL = 'E2E Bystander';

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

/**
 * Channel chatter from someone else, sitting between each pair of fixture
 * messages. No mention, so none of these reach the queue — their only job is to
 * end the sender's run, keeping the six fixture messages six rows.
 */
const FIXTURE_GAP_MESSAGES = FIXTURE_MESSAGES.slice(1).map((message, index) => ({
  offset: message.offset - 5,
  text: `E2E bystander chatter ${index + 1}`,
}));

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
    ...FIXTURE_GAP_MESSAGES.map((_, index) => `me2e-gap-${index}`),
    ...BURST_MESSAGES.map((_, index) => `me2e-burst-${index}`),
    'me2e-burst-gap',
    'me2e-thread-parent',
    ...FIXTURE_THREAD_REPLIES.map((_, index) => `me2e-thread-reply-${index}`),
    ...FIXTURE_DM_MESSAGE_IDS,
    LATE_MESSAGE_ID,
  ];
}

/** A message that "arrives" after the page has already rendered. */
export const LATE_MESSAGE_ID = 'me2e-late';
export const LATE_MESSAGE_TEXT = 'E2E hotel — arrived after the page loaded';

/**
 * Write a new mention into the fixture channel, as Socket Mode would.
 *
 * Deliberately writes to the database rather than replaying a Slack event: the
 * listener is a separate process, and what an open tab actually watches is the
 * database. This is the same path a real incoming DM takes on its last hop.
 *
 * Sent by the *bystander*, unlike every other fixture: a message from the usual
 * sender would land next to their last one with nothing in between and collapse
 * into that burst — one person talking at you is one row — so the arrival would
 * be real but invisible as a new item.
 */
export async function deliverLateMessage(authedUserId: string): Promise<void> {
  const sentAt = new Date();
  await prisma.message.create({
    data: {
      id: LATE_MESSAGE_ID,
      conversationId: FIXTURE_CHANNEL_ID,
      userId: FIXTURE_BYSTANDER_ID,
      source: 'EVENT',
      ts: `${Math.floor(sentAt.getTime() / 1000)}.000200`,
      sentAt,
      text: `<@${authedUserId}> ${LATE_MESSAGE_TEXT}`,
      mentionedUserIds: [authedUserId],
    },
  });
}

/**
 * Backdate a snooze so its wake-up is due now.
 *
 * The alternative — snoozing for the shortest real preset and waiting — would
 * make the test take hours. What is under test is that the sweep runs on its
 * own and the tab hears about it, not the arithmetic of the presets (which has
 * its own unit tests).
 */
export async function expireSnooze(messageId: string): Promise<void> {
  await prisma.messageState.update({
    where: { messageId },
    data: { snoozedUntil: new Date(Date.now() - 60_000) },
  });
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
    where: { id: { in: [FIXTURE_CHANNEL_ID, FIXTURE_DM_ID] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [FIXTURE_USER_ID, FIXTURE_BYSTANDER_ID] } },
  });
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

/**
 * Three messages in a row from the fixture sender, seeded *after* the ordinary
 * fixtures so nothing interrupts them. They are the burst: one task, one row.
 *
 * Opt-in via `seedBurstFixture` rather than part of the standard seed, so the
 * suites that count rows do not have to know about them.
 */
export const BURST_MESSAGES = [
  { offset: 100, text: 'E2E burst one — hey, are you around?' },
  { offset: 101, text: 'E2E burst two — following up on the migration' },
  { offset: 102, text: 'E2E burst three — need this before the release' },
] as const;

export const BURST_NEWEST_TEXT = BURST_MESSAGES[BURST_MESSAGES.length - 1].text;

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

  await prisma.user.createMany({
    data: [
      {
        id: FIXTURE_USER_ID,
        username: 'e2e-fixture',
        realName: FIXTURE_USER_LABEL,
        displayName: FIXTURE_USER_LABEL,
        isBot: false,
      },
      {
        id: FIXTURE_BYSTANDER_ID,
        username: 'e2e-bystander',
        realName: FIXTURE_BYSTANDER_LABEL,
        displayName: FIXTURE_BYSTANDER_LABEL,
        isBot: false,
      },
    ],
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
      ...FIXTURE_GAP_MESSAGES.map((message, index) => ({
        ...common,
        userId: FIXTURE_BYSTANDER_ID,
        id: `me2e-gap-${index}`,
        ts: fixtureTs(message.offset),
        sentAt: new Date((BASE_EPOCH_SECONDS + message.offset) * 1000),
        text: message.text,
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

/**
 * Add the burst: three consecutive messages from the fixture sender.
 *
 * Left unclassified on purpose — grouping is decided from the transcript, never
 * by the model, so the row has to collapse with no `Classification` rows in
 * sight.
 */
export async function seedBurstFixture(authedUserId: string): Promise<void> {
  await prisma.message.createMany({
    data: [
      // Someone else speaks first, so the burst is a run of its own rather than
      // a continuation of the last ordinary fixture message — which is itself
      // from this sender, with nothing in between.
      {
        conversationId: FIXTURE_CHANNEL_ID,
        userId: FIXTURE_BYSTANDER_ID,
        source: 'BACKFILL' as const,
        id: 'me2e-burst-gap',
        ts: fixtureTs(BURST_MESSAGES[0].offset - 5),
        sentAt: new Date(
          (BASE_EPOCH_SECONDS + BURST_MESSAGES[0].offset - 5) * 1000,
        ),
        text: 'E2E bystander chatter before the burst',
      },
      ...BURST_MESSAGES.map((message, index) => ({
        conversationId: FIXTURE_CHANNEL_ID,
        userId: FIXTURE_USER_ID,
        source: 'BACKFILL' as const,
        id: `me2e-burst-${index}`,
        ts: fixtureTs(message.offset),
        sentAt: new Date((BASE_EPOCH_SECONDS + message.offset) * 1000),
        text: `<@${authedUserId}> ${message.text}`,
        mentionedUserIds: [authedUserId],
      })),
    ],
  });
}

/** How many of our own rows the burst messages have state for. */
export async function countDoneStates(messageIds: string[]): Promise<number> {
  return prisma.messageState.count({
    where: { messageId: { in: messageIds }, isDone: true },
  });
}

export const BURST_MESSAGE_IDS = BURST_MESSAGES.map(
  (_, index) => `me2e-burst-${index}`,
);

/**
 * A real (non-fixture) DM that already has a message in it, or null.
 *
 * Only the live-send reply test uses this. Every other suite asserts against
 * seeded fixtures, but "confirm the message appears in the actual Slack
 * workspace" cannot be done against a synthetic conversation id — Slack would
 * reject the post with `channel_not_found`.
 */
export async function findRealDirectMessage(): Promise<{
  messageId: string;
  conversationId: string;
} | null> {
  const message = await prisma.message.findFirst({
    where: {
      isDeleted: false,
      conversation: { kind: 'IM', id: { not: { startsWith: 'DE2E' } } },
      id: { not: { startsWith: 'me2e' } },
    },
    orderBy: { sentAt: 'desc' },
    select: { id: true, conversationId: true },
  });

  return message
    ? { messageId: message.id, conversationId: message.conversationId }
    : null;
}

// ---------------------------------------------------------------------------
// A DM with history, for the reading pane's conversation context
// ---------------------------------------------------------------------------

/**
 * A one-to-one DM carrying a back-and-forth, not just inbound messages.
 *
 * The context transcript is only useful if it shows *both* halves — a thread of
 * the sender's messages with the user's replies missing is a monologue, and
 * "sounds good, go ahead" would still be unreadable. So these alternate.
 *
 * Alternating also keeps each inbound message its own queue row: consecutive
 * messages from one sender collapse into a single burst.
 *
 * Opt-in (like the burst fixture) so the suites that count rows in the fixture
 * channel never see it.
 */
export const FIXTURE_DM_ID = 'DE2ESEED001';

/** Messages in the DM, oldest first. `fromMe` ones are the authed user's. */
export const FIXTURE_DM_MESSAGES = [
  { offset: 200, fromMe: false, text: 'E2E dm one — did the migration land?' },
  { offset: 201, fromMe: true, text: 'E2E dm two — not yet, reviewing it now' },
  { offset: 202, fromMe: false, text: 'E2E dm three — any blockers?' },
  { offset: 203, fromMe: true, text: 'E2E dm four — just the index rebuild' },
  { offset: 204, fromMe: false, text: 'E2E dm five — how long does that take?' },
  { offset: 205, fromMe: true, text: 'E2E dm six — twenty minutes or so' },
  { offset: 206, fromMe: false, text: 'E2E dm seven — fine, ship it after' },
  { offset: 207, fromMe: true, text: 'E2E dm eight — will do' },
  { offset: 208, fromMe: false, text: 'E2E dm nine — thanks' },
  { offset: 209, fromMe: true, text: 'E2E dm ten — no problem' },
  { offset: 210, fromMe: false, text: 'E2E dm eleven — one more thing' },
  { offset: 211, fromMe: true, text: 'E2E dm twelve — go on' },
  { offset: 212, fromMe: false, text: 'E2E dm thirteen — sounds good, go ahead' },
] as const;

export const FIXTURE_DM_NEWEST_TEXT =
  FIXTURE_DM_MESSAGES[FIXTURE_DM_MESSAGES.length - 1].text;

/** How many messages sit before the newest one — what context can page through. */
export const FIXTURE_DM_HISTORY_COUNT = FIXTURE_DM_MESSAGES.length - 1;

const FIXTURE_DM_MESSAGE_IDS = FIXTURE_DM_MESSAGES.map(
  (_, index) => `me2e-dm-${index}`,
);

export async function seedDirectMessageFixture(
  authedUserId: string,
): Promise<void> {
  // The authed user's own rows need a `User` to point at. Backfill will
  // normally have created it; `update: {}` makes this a no-op when it has, so
  // the fixture can never overwrite real directory data.
  await prisma.user.upsert({
    where: { id: authedUserId },
    create: { id: authedUserId, username: 'authed-user' },
    update: {},
  });

  await prisma.conversation.upsert({
    where: { id: FIXTURE_DM_ID },
    create: {
      id: FIXTURE_DM_ID,
      kind: 'IM',
      peerUserId: FIXTURE_USER_ID,
      isMember: true,
    },
    update: { peerUserId: FIXTURE_USER_ID },
  });

  await prisma.message.createMany({
    data: FIXTURE_DM_MESSAGES.map((message, index) => ({
      conversationId: FIXTURE_DM_ID,
      source: 'BACKFILL' as const,
      id: `me2e-dm-${index}`,
      userId: message.fromMe ? authedUserId : FIXTURE_USER_ID,
      ts: fixtureTs(message.offset),
      sentAt: new Date((BASE_EPOCH_SECONDS + message.offset) * 1000),
      text: message.text,
    })),
  });
}

/** Clear our done flag for one message, so a live test starts from a known state. */
export async function clearDoneState(messageId: string): Promise<void> {
  await prisma.messageState.deleteMany({ where: { messageId } });
}

export async function disconnectFixtures(): Promise<void> {
  await prisma.$disconnect();
}
