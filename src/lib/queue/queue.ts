import {
  buildPreview,
  collapseWhitespace,
  renderSlackText,
  type LabelLookup,
} from '@/lib/queue/text';
import { categoryRank, type MessageTriage } from '@/lib/triage/types';

/**
 * The queue model: which stored messages belong in the unified inbox, in what
 * order, and what each row says.
 *
 * Everything here is pure — it takes plain row objects and lookup maps, never
 * a Prisma client, a network call, or the clock. `load.ts` does the IO and
 * hands the results in. That split is what lets the inclusion rules and the
 * sort be unit tested against fixtures with no live Slack and no database
 * (CLAUDE.md, "Unit test pure logic ... with fixture data").
 *
 * Phase 3 adds the smart half: each item carries its `triage` result, and
 * `sortQueue` implements the two modes plan.md asks for — sort-by-urgency, and
 * sort-by-recency-with-bumps-collapsed. Both are still pure. Saved views and
 * filters remain Phase 4.
 */

// ---------------------------------------------------------------------------
// Input shapes (our internal model — no Slack payload types here)
// ---------------------------------------------------------------------------

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

export type QueueItem = {
  id: string;
  conversationId: string;
  ts: string;
  /** ISO-8601. A `Date` cannot be handed to a client component as-is. */
  sentAtIso: string;

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
// Labels
// ---------------------------------------------------------------------------

/** Best human-facing name for a user, in Slack's own order of preference. */
export function userLabel(user: QueueUser | undefined | null): string | null {
  if (!user) return null;
  return user.displayName || user.realName || user.username || user.id;
}

export function senderLabelFor(
  row: QueueMessageRow,
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

function lookupFrom(
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

export function toQueueItem(
  row: QueueMessageRow,
  reason: QueueReason,
  users: ReadonlyMap<string, QueueUser>,
  conversations: ReadonlyMap<string, QueueConversation>,
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

  const items: QueueItem[] = [];
  for (const row of rows) {
    const reason = queueReasonFor(row, options);
    if (reason === null) continue;
    items.push(toQueueItem(row, reason, users, conversations));
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
  const own = item.triage?.urgencyScore ?? null;
  const peak = item.bumps?.peakUrgencyScore ?? null;
  if (own === null) return peak;
  if (peak === null) return own;
  return Math.max(own, peak);
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
  const links = new Map<string, string>();
  for (const item of items) {
    const triage = item.triage;
    if (triage?.isBump && triage.bumpOfMessageId) {
      links.set(item.id, triage.bumpOfMessageId);
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

    let peakUrgencyScore: number | null =
      representative.triage?.urgencyScore ?? null;
    for (const follower of followers) {
      const score = follower.triage?.urgencyScore ?? null;
      if (score === null) continue;
      peakUrgencyScore =
        peakUrgencyScore === null ? score : Math.max(peakUrgencyScore, score);
    }

    collapsed.push({
      ...representative,
      bumps: {
        bumpCount: followers.length,
        firstAskedAtIso: representative.sentAtIso,
        lastBumpedAtIso: followers[followers.length - 1].sentAtIso,
        bumpMessageIds: followers.map((follower) => follower.id),
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
};

/** The queue, in the order the user asked for. */
export function sortQueue(
  items: readonly QueueItem[],
  options: SortQueueOptions,
): QueueItem[] {
  const rows =
    options.collapseBumps === false
      ? items.map((item) => ({ ...item }))
      : collapseBumpChains(items);

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
