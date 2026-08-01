/**
 * Demo mode: a fake Slack workspace, so the app can be run without Slack.
 *
 * Why it exists. SlackZero is a Slack client, so "try it" normally means
 * "create a Slack app, grant eight scopes, run OAuth". That is a fair ask of
 * someone adopting the tool and an unfair one of someone who just wants to see
 * what it does for two minutes. Demo mode seeds a workspace's worth of
 * plausible triage — DMs, mentions, a bump chain, a thread, snoozes, a week of
 * completions — and serves the message text from this file instead of Slack.
 *
 * What it is not. It is not a second way into a real install. Demo mode is off
 * unless `SLACKZERO_DEMO=1`, it refuses to start when the database holds a real
 * Slack installation (`src/lib/demo/guard.ts`), and every id below is in a
 * `DEMO` namespace that Slack's own ids cannot collide with. Nothing here can
 * reach Slack: the demo owner has no token, so there is nothing to send with.
 *
 * Times are relative to when the seed runs, so a freshly seeded demo always
 * reads as "25m ago" rather than as a museum of July 2026.
 */

export const DEMO_TEAM_ID = 'TDEMO00001';
export const DEMO_TEAM_NAME = 'Northwind (demo)';
export const DEMO_OWNER_USER_ID = 'UDEMOOWNER0';

export function isDemoMode(): boolean {
  return process.env.SLACKZERO_DEMO === '1';
}

// --- People ----------------------------------------------------------------

export const DEMO_USERS = {
  UDEMOPRIYA0: { name: 'priya', displayName: 'Priya Raman' },
  UDEMOMARCO0: { name: 'marco', displayName: 'Marco Silva' },
  UDEMODANA00: { name: 'dana', displayName: 'Dana Okafor' },
  UDEMOKEN000: { name: 'ken', displayName: 'Ken Ito' },
  UDEMOSAM000: { name: 'sam', displayName: 'Sam Whitfield' },
  [DEMO_OWNER_USER_ID]: { name: 'you', displayName: 'You' },
} as const;

/** Marked important, so the VIP sort and filter have something to show. */
export const DEMO_VIP_USER_IDS = ['UDEMOPRIYA0'] as const;

// --- Conversations ---------------------------------------------------------

export type DemoConversationKind =
  | 'IM'
  | 'MPIM'
  | 'PUBLIC_CHANNEL'
  | 'PRIVATE_CHANNEL';

export type DemoConversation = {
  id: string;
  kind: DemoConversationKind;
  /** Channel name, for anything that is not a one-to-one DM. */
  name?: string;
  /** The other person, for an IM. */
  peerUserId?: string;
};

export const DEMO_CONVERSATIONS: readonly DemoConversation[] = [
  { id: 'DDEMOPRIYA0', kind: 'IM', peerUserId: 'UDEMOPRIYA0' },
  { id: 'DDEMOMARCO0', kind: 'IM', peerUserId: 'UDEMOMARCO0' },
  { id: 'DDEMOSAM000', kind: 'IM', peerUserId: 'UDEMOSAM000' },
  { id: 'GDEMOSTANDUP', kind: 'MPIM', name: 'dana-ken-you' },
  { id: 'CDEMORELEASE', kind: 'PUBLIC_CHANNEL', name: 'eng-releases' },
  { id: 'CDEMODESIGN0', kind: 'PUBLIC_CHANNEL', name: 'design-review' },
  { id: 'CDEMOINCIDNT', kind: 'PUBLIC_CHANNEL', name: 'incidents' },
];

// --- Messages --------------------------------------------------------------

export type DemoCategory = 'ACTION_NEEDED' | 'FYI' | 'MISC';

export type DemoReasonCode =
  | 'DIRECT_REQUEST'
  | 'QUESTION'
  | 'APPROVAL_NEEDED'
  | 'BLOCKED'
  | 'DEADLINE'
  | 'INCIDENT'
  | 'FOLLOW_UP'
  | 'INFORMATIONAL'
  | 'AUTOMATED_NOTICE'
  | 'SOCIAL'
  | 'OTHER';

export type DemoMessage = {
  id: string;
  conversationId: string;
  userId: string;
  /** How long ago it was sent, in minutes. */
  minutesAgo: number;
  text: string;
  /** Addresses the owner by name. Required for a channel message to be queued. */
  mentionsOwner?: boolean;
  /** Thread parent id, when this message belongs to a thread. */
  threadOf?: string;
  triage?: {
    urgencyScore: number;
    category: DemoCategory;
    reasonCode: DemoReasonCode;
    isBump?: boolean;
    bumpOf?: string;
  };
  state?: {
    isDone?: boolean;
    /** Minutes after `minutesAgo` that it was completed. */
    doneAfterMinutes?: number;
    /** Snoozed until this many minutes from now. */
    snoozedInMinutes?: number;
    /** The owner is waiting on a reply to this one. */
    isWaitingOn?: boolean;
  };
};

const HOUR = 60;
const DAY = 24 * HOUR;

/**
 * The queue, newest first. Roughly a working day's worth: two things that
 * genuinely need an answer, a chase, a thread, some noise, and a week of
 * already-handled messages behind it so the stats page is not empty.
 */
export const DEMO_MESSAGES: readonly DemoMessage[] = [
  {
    id: 'mdemo-incident-1',
    conversationId: 'CDEMOINCIDNT',
    userId: 'UDEMOSAM000',
    minutesAgo: 12,
    text: 'checkout latency is at 4s p95 and climbing, page went out. can you look at the cache layer?',
    mentionsOwner: true,
    triage: { urgencyScore: 96, category: 'ACTION_NEEDED', reasonCode: 'INCIDENT' },
  },
  {
    id: 'mdemo-priya-1',
    conversationId: 'DDEMOPRIYA0',
    userId: 'UDEMOPRIYA0',
    minutesAgo: 26,
    text: "can you review the auth PR before standup? it's the last thing blocking 2.4",
    triage: { urgencyScore: 88, category: 'ACTION_NEEDED', reasonCode: 'DIRECT_REQUEST' },
  },
  {
    id: 'mdemo-marco-2',
    conversationId: 'DDEMOMARCO0',
    userId: 'UDEMOMARCO0',
    minutesAgo: 41,
    text: 'any update on this?',
    triage: {
      urgencyScore: 64,
      category: 'ACTION_NEEDED',
      reasonCode: 'FOLLOW_UP',
      isBump: true,
      bumpOf: 'mdemo-marco-1',
    },
  },
  {
    id: 'mdemo-release-1',
    conversationId: 'CDEMORELEASE',
    userId: 'UDEMODANA00',
    minutesAgo: 70,
    text: '2.4 is cut and staged. need a sign-off on the changelog before I promote it',
    mentionsOwner: true,
    triage: { urgencyScore: 74, category: 'ACTION_NEEDED', reasonCode: 'APPROVAL_NEEDED' },
  },
  {
    id: 'mdemo-release-1-r1',
    conversationId: 'CDEMORELEASE',
    userId: 'UDEMOKEN000',
    minutesAgo: 66,
    text: "I diffed it against 2.3 — the migration note is the only thing I'd add",
    threadOf: 'mdemo-release-1',
  },
  {
    id: 'mdemo-release-1-r2',
    conversationId: 'CDEMORELEASE',
    userId: 'UDEMODANA00',
    minutesAgo: 62,
    text: 'good catch, added. holding the promote until someone signs off',
    threadOf: 'mdemo-release-1',
  },
  {
    id: 'mdemo-standup-1',
    conversationId: 'GDEMOSTANDUP',
    userId: 'UDEMODANA00',
    minutesAgo: 2 * HOUR,
    text: "standup moves to 10:30 tomorrow, I'm on the airport run",
    triage: { urgencyScore: 30, category: 'FYI', reasonCode: 'INFORMATIONAL' },
  },
  {
    id: 'mdemo-standup-2',
    conversationId: 'GDEMOSTANDUP',
    userId: 'UDEMOKEN000',
    minutesAgo: 2 * HOUR - 18,
    text: 'works for me 👍',
    triage: { urgencyScore: 6, category: 'MISC', reasonCode: 'SOCIAL' },
  },
  {
    id: 'mdemo-marco-1',
    conversationId: 'DDEMOMARCO0',
    userId: 'UDEMOMARCO0',
    minutesAgo: 3 * HOUR,
    text: 'do you have the migration runbook from last quarter? I want to copy the rollback section',
    triage: { urgencyScore: 52, category: 'ACTION_NEEDED', reasonCode: 'QUESTION' },
  },
  {
    id: 'mdemo-design-1',
    conversationId: 'CDEMODESIGN0',
    userId: 'UDEMOPRIYA0',
    minutesAgo: 5 * HOUR,
    text: 'the empty state you sketched is in the build now, looks great at 320px too',
    mentionsOwner: true,
    triage: { urgencyScore: 18, category: 'FYI', reasonCode: 'INFORMATIONAL' },
  },
  {
    id: 'mdemo-sam-1',
    conversationId: 'DDEMOSAM000',
    userId: 'UDEMOSAM000',
    minutesAgo: 7 * HOUR,
    text: 'lunch thursday? there is a new place by the office',
    triage: { urgencyScore: 8, category: 'MISC', reasonCode: 'SOCIAL' },
    state: { snoozedInMinutes: 20 * HOUR },
  },
  {
    id: 'mdemo-release-2',
    conversationId: 'CDEMORELEASE',
    userId: 'UDEMOKEN000',
    minutesAgo: 9 * HOUR,
    text: 'nightly build failed on main — the flaky snapshot test again, logs in the thread',
    mentionsOwner: true,
    triage: { urgencyScore: 44, category: 'FYI', reasonCode: 'AUTOMATED_NOTICE' },
  },

  // --- The owner's own asks, still unanswered: the Waiting on Others view ---
  {
    id: 'mdemo-waiting-1',
    conversationId: 'DDEMOMARCO0',
    userId: DEMO_OWNER_USER_ID,
    minutesAgo: 2 * DAY,
    text: 'can you confirm the staging credentials rotated? I need it before I hand the runbook over',
    state: { isWaitingOn: true },
  },
  {
    id: 'mdemo-waiting-2',
    conversationId: 'CDEMODESIGN0',
    userId: DEMO_OWNER_USER_ID,
    minutesAgo: 4 * DAY,
    text: 'who owns the icon set now that the brand refresh landed?',
    state: { isWaitingOn: true },
  },

  // --- Already triaged, for the stats page ---------------------------------
  ...buildHandledHistory(),
];

/**
 * A week of completed triage behind the live queue.
 *
 * The stats page measures median response time, triaged-per-day and a streak,
 * all of which read as broken on an empty history — a demo that shows "0
 * messages, no streak" undersells the one screen whose entire job is to show a
 * trend. Deterministic on purpose: same seed, same chart.
 */
function buildHandledHistory(): DemoMessage[] {
  const perDay = [7, 5, 9, 4, 8, 6, 5];
  const senders = ['UDEMOPRIYA0', 'UDEMOMARCO0', 'UDEMODANA00', 'UDEMOKEN000', 'UDEMOSAM000'];
  const lines = [
    'bumping this one — did the invoice go out?',
    'approved, thanks for turning it around',
    'can you take the on-call handoff this week?',
    'the staging deploy is green again',
    'reminder: expense reports are due friday',
    'quick question about the retry budget',
    'moved the doc into the shared drive',
    'do we still need the legacy webhook?',
    'ship it',
  ];
  const responseMinutes = [12, 34, 6, 95, 21, 48, 15, 62, 8];

  const messages: DemoMessage[] = [];
  perDay.forEach((count, dayIndex) => {
    for (let index = 0; index < count; index += 1) {
      const seed = dayIndex * 7 + index;
      messages.push({
        id: `mdemo-handled-${dayIndex}-${index}`,
        conversationId: dayIndex % 2 === 0 ? 'DDEMOPRIYA0' : 'GDEMOSTANDUP',
        userId: senders[seed % senders.length],
        // Spread through the working day so the per-day counts are honest.
        minutesAgo: (dayIndex + 1) * DAY - 9 * HOUR + index * 37,
        text: lines[seed % lines.length],
        triage: {
          urgencyScore: 20 + ((seed * 13) % 60),
          category: seed % 3 === 0 ? 'ACTION_NEEDED' : seed % 3 === 1 ? 'FYI' : 'MISC',
          reasonCode: seed % 3 === 0 ? 'DIRECT_REQUEST' : 'INFORMATIONAL',
        },
        state: {
          isDone: true,
          doneAfterMinutes: responseMinutes[seed % responseMinutes.length],
        },
      });
    }
  });
  return messages;
}

// --- The synthetic-content adapter ------------------------------------------

const DEMO_MESSAGE_TEXT: Record<string, string> = Object.fromEntries(
  DEMO_MESSAGES.map((message) => [message.id, message.text]),
);

const DEMO_MENTION_IDS = new Set(
  DEMO_MESSAGES.filter((message) => message.mentionsOwner).map((message) => message.id),
);

const DEMO_REPLY_COUNTS: Record<string, number> = DEMO_MESSAGES.reduce<
  Record<string, number>
>((counts, message) => {
  if (message.threadOf) counts[message.threadOf] = (counts[message.threadOf] ?? 0) + 1;
  return counts;
}, {});

/** Implements `SyntheticWorkspace` from src/lib/slack/synthetic.ts. */
export const DEMO_WORKSPACE = {
  kind: 'demo' as const,
  conversationIds: new Set(DEMO_CONVERSATIONS.map((conversation) => conversation.id)),
  threadedConversationIds: new Set(
    DEMO_CONVERSATIONS.filter((conversation) => conversation.kind !== 'IM').map(
      (conversation) => conversation.id,
    ),
  ),
  channelNames: Object.fromEntries(
    DEMO_CONVERSATIONS.filter((conversation) => conversation.name).map((conversation) => [
      conversation.id,
      conversation.name as string,
    ]),
  ),
  users: DEMO_USERS as Readonly<Record<string, { name: string; displayName: string }>>,
  messageText: DEMO_MESSAGE_TEXT,
  mentionsOwner(_conversationId: string, messageId: string): boolean {
    return DEMO_MENTION_IDS.has(messageId);
  },
  replyCount(messageId: string): number | undefined {
    return DEMO_REPLY_COUNTS[messageId];
  },
  async ownerUserId(): Promise<string | null> {
    return DEMO_OWNER_USER_ID;
  },
};
