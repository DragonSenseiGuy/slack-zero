import {
  buildPreview,
  collapseWhitespace,
  renderSlackText,
  type LabelLookup,
} from '@/lib/queue/text';
import { categoryRank, type MessageTriage } from '@/lib/triage/types';

export type QueueConversationKind =
  | 'IM'
  | 'MPIM'
  | 'PRIVATE_CHANNEL'
  | 'PUBLIC_CHANNEL'
  | 'UNKNOWN';

/** Why a message is in the queue at all. Shown as a badge on the row. */
export type QueueReason = 'dm' | 'mention' | 'thread';

export type QueueReaction = {
  name: string;
  count: number;
};

export type QueueUser = {
  id: string;
  username: string | null;
  realName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isBot: boolean;
  /** Marked important by the user. Drives Phase 4's VIP filter and sort. */
  isVip: boolean;
};

export type QueueConversation = {
  id: string;
  kind: QueueConversationKind;
  name: string | null;
  peerUserId: string | null;
};

/** One stored message, as the queue needs to see it. */
export type QueueMessageRow = {
  id: string;
  conversationId: string;
  ts: string;
  sentAt: Date;

  threadTs: string | null;
  isThreadReply: boolean;
  isThreadParent: boolean;
  replyCount: number;

  userId: string | null;
  authorName: string | null;
  botId: string | null;

  subtype: string | null;
  text: string;

  isEdited: boolean;
  isDeleted: boolean;
  hasFiles: boolean;
  reactions: QueueReaction[] | null;
  mentionedUserIds: string[];

  conversation: QueueConversation;

  /** SlackZero's own triage state — deliberately separate from Slack's read
   * /unread. Absent `MessageState` row means "not done". */
  isDone: boolean;
  doneAt: Date | null;
  /** Phase 6. Null when never snoozed. */
  snoozedUntil?: Date | null;
  snoozedAt?: Date | null;
  /** What the last snooze was set for, kept after the snooze ends. */
  lastSnoozedUntil?: Date | null;
  /** When the item rejoined the queue, if it ever was snoozed. */
  unsnoozedAt?: Date | null;
  /** "time" | "activity" | "manual" — why it came back. */
  unsnoozeReason?: string | null;
  isWaitingOn?: boolean;
  waitingOnSince?: Date | null;

  /** AI triage result, or null when this message has not been classified yet
   * (classification is async and must never block ingestion). */
  triage: MessageTriage | null;
};

// ---------------------------------------------------------------------------
// Output shape (serializable: this crosses the server → client boundary)
// ---------------------------------------------------------------------------

export type QueueThreadReply = {
  id: string;
  ts: string;
  sentAtIso: string;
  senderLabel: string;
  senderAvatarUrl: string | null;
  body: string;
};

/**
 * What a collapsed bump chain says about itself.
 *
 * Present only on a row that absorbed follow-ups. The whole point is that a
 * chase must not make an item look new: the row keeps the *original* ask's
 * timestamp and states how long it has been sitting there instead.
 */
export type QueueBumpSummary = {
  /** How many follow-up messages were folded into this row. */
  bumpCount: number;
  /** ISO timestamp of the original ask (this row's own `sentAtIso`). */
  firstAskedAtIso: string;
  /** ISO timestamp of the most recent chase. */
  lastBumpedAtIso: string;
  /** Ids of the folded follow-ups, oldest first. */
  bumpMessageIds: string[];
  /** Highest urgency anywhere in the chain, null if none were classified. */
  peakUrgencyScore: number | null;
};

/** One message folded into a burst row, for the reading pane's transcript. */
export type QueueGroupMessage = {
  id: string;
  ts: string;
  sentAtIso: string;
  body: string;
  isDone: boolean;
};

/**
 * What a collapsed burst says about itself.
 *
 * Present only on a row that stands for more than one message. A person firing
 * off "hey" / "quick q" / "wdyt?" is one thing to deal with, not three, so the
 * row reports the run as a whole: how many messages, when it started, and the
 * highest urgency anywhere in it.
 */
export type QueueGroupSummary = {
  /** Messages this row stands for, including the representative. */
  messageCount: number;
  /** Every folded message id, oldest first, representative included. */
  messageIds: string[];
  /** ISO timestamp of the first message in the run. */
  firstMessageAtIso: string;
  /** ISO timestamp of the last — which is the row's own `sentAtIso`. */
  latestMessageAtIso: string;
  /** Highest urgency anywhere in the run, null if none were classified. */
  peakUrgencyScore: number | null;
  /** The earlier messages, oldest first, excluding the representative. */
  earlier: QueueGroupMessage[];
};

/** Why a snoozed item is back in the queue. */
export type QueueUnsnoozeReason = 'time' | 'activity' | 'manual';

/**
 * A snooze, seen from the queue: either still running, or finished and the
 * reason it finished.
 */
export type QueueSnooze = {
  /** `pending` while hidden; `returned` once it is back in the queue. */
  state: 'pending' | 'returned';
  /** What the snooze was set for. */
  untilIso: string;
  /** When it rejoined the queue. Null while `state` is `pending`. */
  returnedAtIso: string | null;
  /** Null while `state` is `pending`, or if the reason was not recorded. */
  returnedReason: QueueUnsnoozeReason | null;
};

export type QueueItem = {
  id: string;
  conversationId: string;
  ts: string;
  /** ISO-8601. A `Date` cannot be handed to a client component as-is. */
  sentAtIso: string;

  /**
   * Which uninterrupted run of messages from one sender this belongs to. Rows
   * sharing a key are one task; see `assignBurstKeys`.
   */
  burstKey: string;

  reason: QueueReason;

  senderId: string | null;
  senderLabel: string;
  senderAvatarUrl: string | null;
  isBotSender: boolean;
  /** Sender is a VIP (Phase 4). Resolved here so filters stay pure. */
  isVipSender: boolean;

  /** "#general", "Direct message", "Group DM" — the channel/DM context. */
  contextLabel: string;
  contextKind: QueueConversationKind;

  /** One-line, truncated, for the list row. */
  preview: string;
  /** Full rendered text, for the reading pane. */
  body: string;

  isDone: boolean;
  doneAtIso: string | null;

  /** Phase 6: set while the item is hidden by a snooze. */
  snoozedUntilIso: string | null;
  /**
   * The snooze this row is living under, or came back from.
   *
   * Separate from `snoozedUntilIso`, which the sweeps clear the moment an item
   * wakes: without this the reminder you set for yourself would rejoin the
   * queue indistinguishable from a message that just arrived.
   */
  snooze: QueueSnooze | null;
  /** Phase 6: the user asked something here and is awaiting a reply. */
  isWaitingOn: boolean;
  waitingSinceIso: string | null;

  threadTs: string | null;
  isThreadReply: boolean;
  isThreadParent: boolean;
  replyCount: number;

  hasFiles: boolean;
  isEdited: boolean;
  reactions: QueueReaction[];

  /** Populated for thread parents so the pane can show the thread inline. */
  threadReplies: QueueThreadReply[];

  /** AI triage result. Null until the async classifier has seen it. */
  triage: MessageTriage | null;

  /** Set by `collapseBursts` on a row that absorbed the sender's other
   * consecutive messages. Null on a row that stands for exactly one message. */
  group: QueueGroupSummary | null;

  /** Set by `collapseBumpChains` on a row that absorbed follow-ups. */
  bumps: QueueBumpSummary | null;
};

// ---------------------------------------------------------------------------
// Inclusion
// ---------------------------------------------------------------------------

/**
 * Subtypes that are membership/administrative noise. Phase 1 ingests them so
 * row counts reconcile with Slack; the queue must not show them.
 */
export const HIDDEN_SUBTYPES: ReadonlySet<string> = new Set([
  'channel_join',
  'channel_leave',
  'group_join',
  'group_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'bot_add',
  'bot_remove',
  'pinned_item',
  'unpinned_item',
]);

/** Stable key for "this thread, in this conversation". */
export function threadKey(conversationId: string, threadTs: string): string {
  return `${conversationId}:${threadTs}`;
}

export type QueueContext = {
  /** The Slack id of the person using SlackZero. Null before OAuth. */
  authedUserId: string | null;
  /**
   * `threadKey()` values for threads the authed user is part of (started, or
   * replied in). Computed by the loader; supplied here so this stays pure.
   */
  participatingThreadKeys?: ReadonlySet<string>;
};

/**
 * Decide whether a message belongs in the unified queue, and why.
 *
 * The rules, in plain terms:
 *  - never show deleted messages or membership noise;
 *  - never show the user their own messages (you do not triage yourself —
 *    Phase 6's "waiting on others" view is where sent messages resurface);
 *  - show everything in a DM or group DM;
 *  - show channel messages that @-mention the user;
 *  - show replies in threads the user is part of.
 *
 * Returns null when the message is not queue material.
 */
export function queueReasonFor(
  row: QueueMessageRow,
  context: QueueContext,
): QueueReason | null {
  if (row.isDeleted) return null;
  if (row.subtype !== null && HIDDEN_SUBTYPES.has(row.subtype)) return null;

  const { authedUserId } = context;
  if (authedUserId !== null && row.userId === authedUserId) return null;

  const kind = row.conversation.kind;
  const isDm = kind === 'IM' || kind === 'MPIM';
  const mentionsMe =
    authedUserId !== null && row.mentionedUserIds.includes(authedUserId);
  const inMyThread =
    row.threadTs !== null &&
    (context.participatingThreadKeys?.has(
      threadKey(row.conversationId, row.threadTs),
    ) ??
      false);

  if (!isDm && !mentionsMe && !inMyThread) return null;

  // A reply is reported as a thread item even in a DM: "someone replied in a
  // thread" is a different thing to triage than "someone sent you a DM", and
  // the badge is the only place that distinction shows up in Phase 2.
  if (row.isThreadReply) return 'thread';
  if (isDm) return 'dm';
  if (mentionsMe) return 'mention';
  return 'thread';
}

// ---------------------------------------------------------------------------
// Bursts: one person's uninterrupted run of messages is one task
// ---------------------------------------------------------------------------

/**
 * The conversation "stream" a message sits in for burst purposes.
 *
 * Root-level messages and each thread are separate streams, because a thread
 * reply and a top-level DM are different places to answer even when they come
 * from the same person seconds apart.
 */
function burstStreamKey(row: {
  conversationId: string;
  threadTs: string | null;
}): string {
  return `${row.conversationId} ${row.threadTs ?? 'root'}`;
}

/** Who sent it, for run-boundary purposes. Bots without a user id count too. */
function senderKeyFor(row: QueueMessageRow): string {
  return row.userId ?? row.botId ?? 'unknown';
}

function compareRowsOldestFirst(a: QueueMessageRow, b: QueueMessageRow): number {
  const timeA = a.sentAt.getTime();
  const timeB = b.sentAt.getTime();
  if (timeA !== timeB) return timeA - timeB;
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Group each stream into runs: consecutive messages from the same sender that
 * nobody else interrupted.
 *
 * This is the deterministic half of "one person, one row". A DM burst is not a
 * classification problem — "the same person messaged three times and I have not
 * answered yet" is a fact about the transcript — so it is decided here, from the
 * stored rows, and never sent to the model. `collapseBumpChains` stays for the
 * cases only the model can see: a chase that arrives *after* you replied, or in
 * a different conversation entirely.
 *
 * Two things end a run:
 *  - anyone else speaking, **including the user** — once you have replied, what
 *    comes next is a new task, not more of the old one;
 *  - a thread parent, which always stands alone: it already shows its replies
 *    inline in the reading pane, so folding a reply into it would render the
 *    same message twice.
 *
 * Deliberately *not* a boundary: elapsed time. A run only ever breaks on
 * someone speaking, so two messages from one person with nothing in between are
 * one row no matter how far apart they are — a week-old unanswered ask and
 * today's follow-up are the same outstanding thing, and the row says how long it
 * has been waiting. Any time cap would put those back on separate rows, which is
 * exactly the symptom this function exists to remove.
 *
 * Takes *every* row, not just queue-worthy ones: the user's own messages never
 * appear in the queue but are the most important boundary there is. Deleted
 * messages and membership noise are skipped entirely — they neither join a run
 * nor split one, because "Bob joined the channel" between two of Bob's messages
 * is not a change of subject.
 *
 * Returns message id → burst key. Ids absent from the map (skipped rows) have
 * no burst.
 */
export function assignBurstKeys(
  rows: readonly QueueMessageRow[],
): Map<string, string> {
  const keys = new Map<string, string>();
  const runs = new Map<string, { senderKey: string; key: string }>();
  let counter = 0;

  for (const row of [...rows].sort(compareRowsOldestFirst)) {
    if (row.isDeleted) continue;
    if (row.subtype !== null && HIDDEN_SUBTYPES.has(row.subtype)) continue;

    const stream = burstStreamKey(row);

    if (row.isThreadParent) {
      counter += 1;
      keys.set(row.id, `${stream}#${counter}`);
      // Reset, so the first reply starts its own run rather than continuing the
      // parent's even when the same person wrote both.
      runs.delete(stream);
      continue;
    }

    const senderKey = senderKeyFor(row);
    const open = runs.get(stream);

    if (!open || open.senderKey !== senderKey) {
      counter += 1;
      const started = { senderKey, key: `${stream}#${counter}` };
      runs.set(stream, started);
      keys.set(row.id, started.key);
      continue;
    }

    keys.set(row.id, open.key);
  }

  return keys;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Best human-facing name for a user, in Slack's own order of preference. */
export function userLabel(user: QueueUser | undefined | null): string | null {
  if (!user) return null;
  return user.displayName || user.realName || user.username || user.id;
}

/** Just enough of a stored row to name its author. */
export type SenderFields = Pick<
  QueueMessageRow,
  'userId' | 'authorName' | 'botId'
>;

export function senderLabelFor(
  row: SenderFields,
  users: ReadonlyMap<string, QueueUser>,
): string {
  const fromDirectory = row.userId ? userLabel(users.get(row.userId)) : null;
  if (fromDirectory) return fromDirectory;
  if (row.authorName) return row.authorName;
  if (row.userId) return row.userId;
  if (row.botId) return `Bot ${row.botId}`;
  return 'Unknown sender';
}

/**
 * The channel/DM context line. IMs have no name in Slack, so the peer's name
 * is used; group DMs get a generic label because Slack's mpim names
 * (`mpdm-a--b--c-1`) are not meant to be read by humans.
 */
export function contextLabelFor(
  conversation: QueueConversation,
  users: ReadonlyMap<string, QueueUser>,
): string {
  switch (conversation.kind) {
    case 'IM': {
      const peer = conversation.peerUserId
        ? userLabel(users.get(conversation.peerUserId))
        : null;
      return peer ? `DM · ${peer}` : 'Direct message';
    }
    case 'MPIM':
      return 'Group DM';
    case 'PUBLIC_CHANNEL':
    case 'PRIVATE_CHANNEL':
      return `#${conversation.name ?? conversation.id}`;
    default:
      return conversation.name ? `#${conversation.name}` : conversation.id;
  }
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export function lookupFrom(
  users: ReadonlyMap<string, QueueUser>,
  conversations: ReadonlyMap<string, QueueConversation>,
): LabelLookup {
  const userLabels = new Map<string, string>();
  users.forEach((user, id) => {
    const label = userLabel(user);
    if (label) userLabels.set(id, label);
  });

  const channelLabels = new Map<string, string>();
  conversations.forEach((conversation, id) => {
    if (conversation.name) channelLabels.set(id, conversation.name);
  });

  return { users: userLabels, channels: channelLabels };
}

/**
 * Placeholder text for a message whose whole content is an attachment. Better
 * than an empty row, which reads as a rendering failure.
 */
function emptyBodyFallback(row: QueueMessageRow): string {
  if (row.hasFiles) return '(file attachment)';
  return '(no text)';
}

const UNSNOOZE_REASONS: ReadonlySet<string> = new Set([
  'time',
  'activity',
  'manual',
]);

/**
 * Collapse the four stored snooze columns into the one thing the UI asks:
 * "is this a reminder, and where is it in its life?".
 *
 * A pending snooze wins over a recorded return, because re-snoozing is how a
 * user pushes a woken reminder further out and the row must then read as
 * hidden-again rather than as back.
 */
export function toQueueSnooze(row: {
  snoozedUntil?: Date | null;
  lastSnoozedUntil?: Date | null;
  unsnoozedAt?: Date | null;
  unsnoozeReason?: string | null;
}): QueueSnooze | null {
  if (row.snoozedUntil) {
    return {
      state: 'pending',
      untilIso: row.snoozedUntil.toISOString(),
      returnedAtIso: null,
      returnedReason: null,
    };
  }

  // `unsnoozedAt` is the one that must be present: it is what makes the row a
  // returned snooze rather than a message that was never snoozed at all.
  if (!row.unsnoozedAt) return null;

  const reason = row.unsnoozeReason ?? '';

  return {
    state: 'returned',
    untilIso: (row.lastSnoozedUntil ?? row.unsnoozedAt).toISOString(),
    returnedAtIso: row.unsnoozedAt.toISOString(),
    returnedReason: UNSNOOZE_REASONS.has(reason)
      ? (reason as QueueUnsnoozeReason)
      : null,
  };
}

export function toQueueItem(
  row: QueueMessageRow,
  reason: QueueReason,
  users: ReadonlyMap<string, QueueUser>,
  conversations: ReadonlyMap<string, QueueConversation>,
  /** From `assignBurstKeys`. Defaults to a key of its own — a row that groups
   * with nothing, which is the right answer when the caller has no wider view
   * of the conversation than this single message. */
  burstKey: string = `${row.conversationId} solo#${row.id}`,
): QueueItem {
  const lookup = lookupFrom(users, conversations);
  const rendered = renderSlackText(row.text, lookup);
  const body = collapseWhitespace(rendered) ? rendered : emptyBodyFallback(row);

  const sender = row.userId ? users.get(row.userId) : undefined;

  return {
    id: row.id,
    conversationId: row.conversationId,
    ts: row.ts,
    sentAtIso: row.sentAt.toISOString(),

    burstKey,

    reason,

    senderId: row.userId,
    senderLabel: senderLabelFor(row, users),
    senderAvatarUrl: sender?.avatarUrl ?? null,
    isBotSender: sender?.isBot ?? row.botId !== null,
    isVipSender: sender?.isVip ?? false,

    contextLabel: contextLabelFor(row.conversation, users),
    contextKind: row.conversation.kind,

    preview: buildPreview(row.text, {
      lookup,
      fallback: emptyBodyFallback(row),
    }),
    body,

    isDone: row.isDone,
    doneAtIso: row.doneAt ? row.doneAt.toISOString() : null,
    snoozedUntilIso: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
    snooze: toQueueSnooze(row),
    isWaitingOn: row.isWaitingOn ?? false,
    waitingSinceIso: row.waitingOnSince ? row.waitingOnSince.toISOString() : null,

    threadTs: row.threadTs,
    isThreadReply: row.isThreadReply,
    isThreadParent: row.isThreadParent,
    replyCount: row.replyCount,

    hasFiles: row.hasFiles,
    isEdited: row.isEdited,
    reactions: row.reactions ?? [],

    threadReplies: [],

    triage: row.triage,
    group: null,
    bumps: null,
  };
}

/**
 * Newest first. Slack's `ts` is the tiebreaker because two messages can share
 * a millisecond after `sentAt` rounding, and `id` breaks the remaining tie so
 * the order is total and stable — an unstable queue order would make `j`/`k`
 * navigation jump around between renders.
 */
export function compareByRecency(a: QueueItem, b: QueueItem): number {
  if (a.sentAtIso !== b.sentAtIso) return a.sentAtIso < b.sentAtIso ? 1 : -1;
  if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type BuildQueueOptions = QueueContext & {
  users?: ReadonlyMap<string, QueueUser>;
  conversations?: ReadonlyMap<string, QueueConversation>;
};

/**
 * The whole queue: every message that qualifies, newest first.
 *
 * Done items are *included* — filtering them out is a display concern handled
 * by `applyQueueFilters`, so the client can toggle "show done" without another
 * round trip.
 */
export function buildQueue(
  rows: readonly QueueMessageRow[],
  options: BuildQueueOptions,
): QueueItem[] {
  const users = options.users ?? new Map<string, QueueUser>();
  const conversations =
    options.conversations ?? new Map<string, QueueConversation>();

  // Computed over *all* rows before anything is filtered out: the user's own
  // replies are what end a run, and they never survive `queueReasonFor`.
  const burstKeys = assignBurstKeys(rows);

  const items: QueueItem[] = [];
  for (const row of rows) {
    const reason = queueReasonFor(row, options);
    if (reason === null) continue;
    items.push(
      toQueueItem(row, reason, users, conversations, burstKeys.get(row.id)),
    );
  }

  return items.sort(compareByRecency);
}

/**
 * Attach thread replies to their parent items. Replies are ordered oldest
 * first, because a thread reads top to bottom even though the queue does not.
 */
export function attachThreadReplies(
  items: readonly QueueItem[],
  replies: readonly QueueMessageRow[],
  users: ReadonlyMap<string, QueueUser>,
  conversations: ReadonlyMap<string, QueueConversation> = new Map(),
): QueueItem[] {
  if (replies.length === 0) return [...items];

  const lookup = lookupFrom(users, conversations);
  const byParent = new Map<string, QueueThreadReply[]>();

  const ordered = [...replies].sort((a, b) =>
    a.ts === b.ts ? 0 : a.ts < b.ts ? -1 : 1,
  );

  for (const reply of ordered) {
    if (reply.threadTs === null || reply.isDeleted) continue;
    const key = threadKey(reply.conversationId, reply.threadTs);
    const bucket = byParent.get(key) ?? [];
    const sender = reply.userId ? users.get(reply.userId) : undefined;
    bucket.push({
      id: reply.id,
      ts: reply.ts,
      sentAtIso: reply.sentAt.toISOString(),
      senderLabel: senderLabelFor(reply, users),
      senderAvatarUrl: sender?.avatarUrl ?? null,
      body:
        renderSlackText(reply.text, lookup) || emptyBodyFallback(reply),
    });
    byParent.set(key, bucket);
  }

  return items.map((item) => {
    if (item.threadTs === null) return item;
    const found = byParent.get(threadKey(item.conversationId, item.threadTs));
    // Only hang the thread off the parent; a reply already sits in the queue
    // in its own right and would otherwise duplicate its siblings.
    if (!found || item.isThreadReply) return item;
    return {
      ...item,
      threadReplies: found.filter((reply) => reply.ts !== item.ts),
    };
  });
}

// ---------------------------------------------------------------------------
// Display filters (client-side; no refetch)
// ---------------------------------------------------------------------------

/**
 * What the queue is currently narrowed to. Set by the command palette —
 * "jump to a channel/person" (plan.md, Phase 2). Saved views are Phase 4.
 */
export type QueueScope =
  | { kind: 'conversation'; id: string; label: string }
  | { kind: 'user'; id: string; label: string };

export type QueueFilters = {
  /** False (the default) is inbox-zero behaviour: done items leave the list. */
  includeDone?: boolean;
  scope?: QueueScope | null;
};

export function matchesScope(
  item: QueueItem,
  scope: QueueScope | null | undefined,
): boolean {
  if (!scope) return true;
  if (scope.kind === 'conversation') return item.conversationId === scope.id;
  return item.senderId === scope.id;
}

export function applyQueueFilters(
  items: readonly QueueItem[],
  filters: QueueFilters = {},
): QueueItem[] {
  const { includeDone = false, scope = null } = filters;

  return items.filter((item) => {
    if (!includeDone && item.isDone) return false;
    return matchesScope(item, scope);
  });
}

/** Counts for the header, computed over the *scoped* set. */
export function queueCounts(
  items: readonly QueueItem[],
  scope: QueueScope | null = null,
): { open: number; done: number; total: number } {
  let open = 0;
  let done = 0;

  for (const item of items) {
    if (!matchesScope(item, scope)) continue;
    if (item.isDone) done += 1;
    else open += 1;
  }

  return { open, done, total: open + done };
}

// ---------------------------------------------------------------------------
// Sorting: urgency, and recency with bumps collapsed (Phase 3)
// ---------------------------------------------------------------------------

export type QueueSortMode = 'urgency' | 'recency';

export const QUEUE_SORT_MODES: readonly QueueSortMode[] = [
  'urgency',
  'recency',
] as const;

export const SORT_MODE_LABEL: Record<QueueSortMode, string> = {
  urgency: 'Urgency',
  recency: 'Recent',
};

export function nextSortMode(mode: QueueSortMode): QueueSortMode {
  return mode === 'urgency' ? 'recency' : 'urgency';
}

/**
 * The urgency a row should be *sorted* by.
 *
 * For a plain row that is its own score. For a collapsed bump chain it is the
 * highest score anywhere in the chain: if the original ask read as a routine
 * 45 and the third chase says the release is now blocked, the chain has to
 * surface at the chase's urgency, not the ask's.
 *
 * Null means "not classified yet" — a real state, because classification is
 * async and deliberately never blocks ingestion.
 */
export function effectiveUrgency(item: QueueItem): number | null {
  const scores = [
    item.triage?.urgencyScore ?? null,
    item.group?.peakUrgencyScore ?? null,
    item.bumps?.peakUrgencyScore ?? null,
  ].filter((score): score is number => score !== null);

  return scores.length === 0 ? null : Math.max(...scores);
}

/**
 * Every stored message a row stands for.
 *
 * A collapsed row is one *task* but several rows in the database, and every
 * action has to apply to all of them. Marking a three-message burst done and
 * writing only the newest would put the other two straight back in the queue on
 * the next load — the item would visibly refuse to leave.
 */
export function itemMessageIds(item: QueueItem): string[] {
  const ids = new Set<string>([item.id]);
  for (const id of item.group?.messageIds ?? []) ids.add(id);
  for (const id of item.bumps?.bumpMessageIds ?? []) ids.add(id);
  return [...ids];
}

/** When the oldest message a row stands for arrived. */
export function firstAskedIso(item: QueueItem): string {
  return item.group?.firstMessageAtIso ?? item.sentAtIso;
}

/** Unclassified items rank after every category, never between them. */
const UNCLASSIFIED_RANK = 99;

/**
 * Most urgent first.
 *
 * Unclassified items go to the *bottom* rather than being given an invented
 * middling score. Putting a fabricated number into the sort would be
 * indistinguishable, from the outside, from the model having actually judged
 * the message — and the queue's whole claim is that its order is explainable.
 * The UI says how many are still pending instead.
 */
export function compareByUrgency(a: QueueItem, b: QueueItem): number {
  const urgencyA = effectiveUrgency(a);
  const urgencyB = effectiveUrgency(b);

  if (urgencyA === null && urgencyB !== null) return 1;
  if (urgencyB === null && urgencyA !== null) return -1;
  if (urgencyA !== null && urgencyB !== null && urgencyA !== urgencyB) {
    return urgencyB - urgencyA;
  }

  const rankA = a.triage ? categoryRank(a.triage.category) : UNCLASSIFIED_RANK;
  const rankB = b.triage ? categoryRank(b.triage.category) : UNCLASSIFIED_RANK;
  if (rankA !== rankB) return rankA - rankB;

  return compareByRecency(a, b);
}

/**
 * Which member's triage speaks for a whole burst: the most actionable one.
 *
 * Not the newest. "ok cool" arriving after "the deploy is broken, can you look?"
 * would otherwise rate the row `misc` and drop it out of the Needs Reply view —
 * the burst is still an outstanding ask, and it is the ask that has to be
 * visible. Ties break on the higher urgency score.
 */
function leadingTriage(members: readonly QueueItem[]): MessageTriage | null {
  let best: MessageTriage | null = null;

  for (const member of members) {
    const triage = member.triage;
    if (!triage) continue;
    if (best === null) {
      best = triage;
      continue;
    }
    const rank = categoryRank(triage.category) - categoryRank(best.category);
    if (rank < 0 || (rank === 0 && triage.urgencyScore > best.urgencyScore)) {
      best = triage;
    }
  }

  return best;
}

/** The later of two ISO timestamps, tolerating nulls. */
function laterIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function earlierIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/**
 * Fold each burst — one sender's uninterrupted run in one conversation — into a
 * single row.
 *
 * The survivor is the **newest** message, which is the opposite of
 * `collapseBumpChains` and deliberately so. A bump chain is one question asked
 * repeatedly, so it keeps the original's timestamp to expose staleness. A burst
 * is a running conversation whose latest line is the one you are answering, so
 * the row shows and sorts by the latest message and reports how long the run has
 * been going in `group.firstMessageAtIso` instead. What the burst must not do is
 * bury the newest message behind an older preview — that is how an "the prod DB
 * is down" lands under a three-day-old "hey".
 *
 * Rows the run does not agree on are merged rather than taken from the
 * representative: the row is done only when every message in it is done, it
 * carries files if any message did, and it is rated by its most actionable
 * message (see `leadingTriage`).
 */
export function collapseBursts(items: readonly QueueItem[]): QueueItem[] {
  const groups = new Map<string, QueueItem[]>();
  const order: string[] = [];

  for (const item of items) {
    const bucket = groups.get(item.burstKey);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(item.burstKey, [item]);
      order.push(item.burstKey);
    }
  }

  const collapsed: QueueItem[] = [];

  for (const key of order) {
    const members = (groups.get(key) as QueueItem[]).slice().sort(olderFirst);

    if (members.length === 1) {
      collapsed.push({ ...members[0], group: null });
      continue;
    }

    const representative = members[members.length - 1];
    const earlier = members.slice(0, -1);

    let peakUrgencyScore: number | null = null;
    let allDone = true;
    let doneAtIso: string | null = null;
    let hasFiles = false;
    let isWaitingOn = false;
    let waitingSinceIso: string | null = null;

    for (const member of members) {
      const score = member.triage?.urgencyScore ?? null;
      if (score !== null) {
        peakUrgencyScore =
          peakUrgencyScore === null ? score : Math.max(peakUrgencyScore, score);
      }
      if (member.isDone) doneAtIso = laterIso(doneAtIso, member.doneAtIso);
      else allDone = false;
      if (member.hasFiles) hasFiles = true;
      if (member.isWaitingOn) {
        isWaitingOn = true;
        waitingSinceIso = earlierIso(waitingSinceIso, member.waitingSinceIso);
      }
    }

    collapsed.push({
      ...representative,
      // A part-done run is still open work: the unanswered messages in it have
      // not gone anywhere, and hiding the row would hide them with it.
      isDone: allDone,
      doneAtIso: allDone ? doneAtIso : null,
      hasFiles,
      isWaitingOn,
      waitingSinceIso,
      triage: leadingTriage(members) ?? representative.triage,
      group: {
        messageCount: members.length,
        messageIds: members.map((member) => member.id),
        firstMessageAtIso: members[0].sentAtIso,
        latestMessageAtIso: representative.sentAtIso,
        peakUrgencyScore,
        earlier: earlier.map((member) => ({
          id: member.id,
          ts: member.ts,
          sentAtIso: member.sentAtIso,
          body: member.body,
          isDone: member.isDone,
        })),
      },
    });
  }

  return collapsed;
}

/** Guard against a `bumpOf` cycle the model could produce. */
export const MAX_BUMP_CHAIN_DEPTH = 32;

/**
 * Walk a bump chain back to the message that was originally asked.
 *
 * `links` maps a follow-up's id to the id it chases. A chase of a chase is
 * normal ("bump" -> "any update?" -> the real question), so this is transitive.
 * Returns the last id reachable, which may be an id we do not hold — the
 * caller decides what to do about that.
 */
export function resolveBumpRoot(
  id: string,
  links: ReadonlyMap<string, string>,
): string {
  let current = id;
  const seen = new Set<string>([id]);

  for (let depth = 0; depth < MAX_BUMP_CHAIN_DEPTH; depth += 1) {
    const next = links.get(current);
    if (next === undefined || next === current || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }

  return current;
}

function olderFirst(a: QueueItem, b: QueueItem): number {
  return -compareByRecency(a, b);
}

/**
 * Fold each bump chain into a single row (plan.md, Phase 3: "a 3-message bump
 * chain should appear as 1 item showing 'first asked X days ago'").
 *
 * The survivor is the *original ask*, keeping its own timestamp — which is what
 * makes the recency sort surface staleness instead of treating a chase as new
 * activity. The follow-ups do not disappear from the data; they are summarized
 * onto the row as a count and a "last bumped" time.
 *
 * When the original is not in the list (it was marked done, or filtered out by
 * a scope), the oldest surviving member of the chain stands in for it rather
 * than the whole chain vanishing.
 */
export function collapseBumpChains(items: readonly QueueItem[]): QueueItem[] {
  // A bump's target may already have been folded into a burst, in which case the
  // id the model gave us is no longer a row. Resolve through the row that now
  // stands for it, or the link would dangle and the chain would not collapse.
  const ownerOf = new Map<string, string>();
  for (const item of items) {
    for (const id of itemMessageIds(item)) ownerOf.set(id, item.id);
  }

  const links = new Map<string, string>();
  for (const item of items) {
    const triage = item.triage;
    if (triage?.isBump && triage.bumpOfMessageId) {
      const target = ownerOf.get(triage.bumpOfMessageId) ?? triage.bumpOfMessageId;
      // The chase and what it chases are already the same row — a burst got
      // there first. Nothing left to link.
      if (target !== item.id) links.set(item.id, target);
    }
  }

  if (links.size === 0) return items.map((item) => ({ ...item, bumps: null }));

  const present = new Set(items.map((item) => item.id));
  const groups = new Map<string, QueueItem[]>();
  const order: string[] = [];

  for (const item of items) {
    const rootId = resolveBumpRoot(item.id, links);
    // A chain whose root we do not hold still has to group together, so key on
    // the resolved root either way.
    const key = present.has(rootId) ? rootId : `missing:${rootId}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(key, [item]);
      order.push(key);
    }
  }

  const collapsed: QueueItem[] = [];

  for (const key of order) {
    const members = (groups.get(key) as QueueItem[]).slice().sort(olderFirst);

    if (members.length === 1) {
      collapsed.push({ ...members[0], bumps: null });
      continue;
    }

    const rootId = key.startsWith('missing:') ? null : key;
    const representative =
      (rootId !== null
        ? members.find((member) => member.id === rootId)
        : undefined) ?? members[0];

    const followers = members.filter(
      (member) => member.id !== representative.id,
    );

    // `effectiveUrgency`, not the raw score: a follower may itself be a
    // collapsed burst whose peak sits on a message other than its newest.
    let peakUrgencyScore: number | null = effectiveUrgency(representative);
    for (const follower of followers) {
      const score = effectiveUrgency(follower);
      if (score === null) continue;
      peakUrgencyScore =
        peakUrgencyScore === null ? score : Math.max(peakUrgencyScore, score);
    }

    collapsed.push({
      ...representative,
      bumps: {
        bumpCount: followers.length,
        firstAskedAtIso: firstAskedIso(representative),
        lastBumpedAtIso: followers[followers.length - 1].sentAtIso,
        // Flattened, so a burst folded into a chain still hands every one of its
        // message ids to whatever acts on the row.
        bumpMessageIds: followers.flatMap(itemMessageIds),
        peakUrgencyScore,
      },
    });
  }

  return collapsed;
}

export type SortQueueOptions = {
  mode: QueueSortMode;
  /**
   * Collapsing is on in both modes. plan.md names it as part of the recency
   * mode, but a chain that shows as three rows in the urgency mode is the same
   * inbox-clutter bug the feature exists to fix — the modes differ in *order*,
   * not in how many rows a conversation is worth.
   */
  collapseBumps?: boolean;
  /** Same reasoning, for same-sender bursts. Off only for tests and debugging. */
  groupBursts?: boolean;
};

/**
 * The queue, in the order the user asked for.
 *
 * Burst grouping runs first and bump collapsing second, because the burst pass
 * is the one that can be decided from the transcript alone. Anything it folds is
 * a chain the model never has to be right about; what reaches
 * `collapseBumpChains` is the residue — chases separated by your own reply, or
 * sitting in another conversation.
 */
export function sortQueue(
  items: readonly QueueItem[],
  options: SortQueueOptions,
): QueueItem[] {
  const grouped =
    options.groupBursts === false
      ? items.map((item) => ({ ...item }))
      : collapseBursts(items);

  const rows =
    options.collapseBumps === false ? grouped : collapseBumpChains(grouped);

  return rows.sort(
    options.mode === 'urgency' ? compareByUrgency : compareByRecency,
  );
}

/** How many rows are still waiting on the async classifier. */
export function unclassifiedCount(items: readonly QueueItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.triage === null) count += 1;
  }
  return count;
}

/**
 * Where the selection should land after the item at `index` leaves the list.
 *
 * Marking done should feel like a stack: the next item slides up under the
 * cursor and stays selected, so a run of triage is `e e e` with no `j` in
 * between. At the end of the list, step back rather than off it.
 */
export function nextSelectionAfterRemoval(
  index: number,
  remainingCount: number,
): number {
  if (remainingCount <= 0) return 0;
  return Math.min(Math.max(index, 0), remainingCount - 1);
}

/** Clamp a selection index into a list, tolerating an empty list. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

/**
 * Move the selection by `delta`, stopping at the ends rather than wrapping.
 * Wrapping in a triage queue is disorienting: `j` at the bottom should mean
 * "you are done", not "start over".
 */
export function moveSelection(
  index: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) return 0;
  return clampIndex(index + delta, length);
}
