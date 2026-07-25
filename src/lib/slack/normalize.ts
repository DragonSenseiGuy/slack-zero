import type {
  RawReaction,
  RawSlackConversation,
  RawSlackMessage,
  RawSlackUser,
} from '@/lib/slack/raw';

/**
 * The ingestion boundary.
 *
 * Everything Slack-shaped goes in; only the types declared here come out.
 * These functions are deliberately pure — no DB, no network, no clock — which
 * is what makes them unit-testable against fixtures with no live Slack
 * (plan.md, Phase 1 verification #2).
 */

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

export type ConversationKind =
  | 'IM'
  | 'MPIM'
  | 'PRIVATE_CHANNEL'
  | 'PUBLIC_CHANNEL'
  | 'UNKNOWN';

/** One reaction, with a stable field name (`userIds`, not Slack's `users`). */
export type NormalizedReaction = {
  name: string;
  count: number;
  userIds: string[];
};

export type NormalizedMessage = {
  conversationId: string;
  /** Slack's per-conversation message id. */
  ts: string;
  /** `ts` as an instant. */
  sentAt: Date;

  threadTs: string | null;
  isThreadReply: boolean;
  isThreadParent: boolean;
  replyCount: number;

  userId: string | null;
  botId: string | null;
  authorName: string | null;

  subtype: string | null;
  text: string;
  blocks: unknown[] | null;

  isEdited: boolean;
  editedAt: Date | null;

  hasFiles: boolean;
  /** Sorted by name so re-ingesting identical data produces an identical row. */
  reactions: NormalizedReaction[] | null;
  /** Slack ids found in `<@U...>` mentions, deduped, in order of appearance. */
  mentionedUserIds: string[];

  teamId: string | null;
};

export type NormalizedConversation = {
  id: string;
  kind: ConversationKind;
  name: string | null;
  peerUserId: string | null;
  topic: string | null;
  purpose: string | null;
  isArchived: boolean;
  isMember: boolean;
  teamId: string | null;
};

export type NormalizedUser = {
  id: string;
  teamId: string | null;
  username: string | null;
  realName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  timezone: string | null;
  isBot: boolean;
  isDeleted: boolean;
};

/**
 * Raised when a payload cannot be normalized at all (no `ts`, no channel).
 * Callers are expected to count and skip rather than abort a whole backfill —
 * one malformed message must not cost the rest of the run.
 */
export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalizationError';
  }
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * Parse a Slack `ts` ("1784938592.138359" — seconds.microseconds) into a Date.
 *
 * Done by string split rather than `Number(ts) * 1000` on purpose: the float
 * form lands at the edge of double precision, so the millisecond can come out
 * one off. Splitting keeps it exact.
 */
export function parseSlackTs(ts: string): Date {
  const [secondsPart, fractionPart = ''] = ts.split('.');
  const seconds = Number(secondsPart);

  if (!Number.isFinite(seconds)) {
    throw new NormalizationError(`Unparseable Slack ts: ${JSON.stringify(ts)}`);
  }

  // Pad/truncate the fraction to exactly 3 digits (milliseconds).
  const millis = Number(fractionPart.padEnd(3, '0').slice(0, 3)) || 0;
  return new Date(seconds * 1000 + millis);
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

/**
 * Slack encodes a user mention as `<@U012ABC>` or `<@U012ABC|display>`.
 * Enterprise Grid ids start with `W`, hence the `[UW]`. `<!here>`/`<!channel>`
 * are broadcasts, not user mentions, and are intentionally not matched.
 */
const MENTION_PATTERN = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

export function extractMentionedUserIds(text: string | undefined): string[] {
  if (!text) return [];

  const found: string[] = [];
  // `exec` in a loop rather than `matchAll`, because the project's tsconfig
  // sets no `target` (so ES5) and iterating a RegExp iterator would need
  // downlevelIteration. Reset `lastIndex` first: the pattern is /g and shared.
  MENTION_PATTERN.lastIndex = 0;
  let match = MENTION_PATTERN.exec(text);
  while (match !== null) {
    const id = match[1];
    if (id && found.indexOf(id) === -1) found.push(id);
    match = MENTION_PATTERN.exec(text);
  }
  return found;
}

/** True when `text` mentions `userId` directly. */
export function mentionsUser(
  text: string | undefined,
  userId: string,
): boolean {
  return extractMentionedUserIds(text).includes(userId);
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

function normalizeReactions(
  raw: readonly RawReaction[] | undefined,
): NormalizedReaction[] | null {
  if (!raw || raw.length === 0) return null;

  const normalized = raw
    .filter((reaction): reaction is RawReaction & { name: string } =>
      Boolean(reaction.name),
    )
    .map((reaction) => {
      const userIds = (reaction.users ?? []).filter(
        (id, index, all) => all.indexOf(id) === index,
      );
      return {
        name: reaction.name,
        // Trust Slack's `count` when present (it can exceed the truncated
        // `users` list on very popular reactions); fall back to the list.
        count: reaction.count ?? userIds.length,
        userIds,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return normalized.length > 0 ? normalized : null;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Slack subtypes that are membership/administrative noise rather than content
 * a human would triage. Ingested anyway (so counts reconcile with Slack and so
 * a thread parent is never missing), but flagged for the queue to filter out.
 */
export const NON_CONTENT_SUBTYPES: ReadonlySet<string> = new Set([
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

export function isNonContentMessage(message: NormalizedMessage): boolean {
  return message.subtype !== null && NON_CONTENT_SUBTYPES.has(message.subtype);
}

/**
 * Normalize one Slack message into our `Message` shape.
 *
 * @param raw          message from `conversations.history`/`.replies`/an event
 * @param conversationId Slack conversation id — history responses do not repeat
 *                       it per message, so it must be supplied by the caller
 * @throws {NormalizationError} when `ts` is absent, which makes the message
 *         unidentifiable and therefore un-dedupable
 */
export function normalizeMessage(
  raw: RawSlackMessage,
  conversationId: string,
): NormalizedMessage {
  if (!raw.ts) {
    throw new NormalizationError(
      `Slack message in ${conversationId} has no ts; cannot ingest`,
    );
  }
  if (!conversationId) {
    throw new NormalizationError('normalizeMessage requires a conversationId');
  }

  const ts = raw.ts;
  const threadTs = raw.thread_ts ?? null;

  // Slack sets `thread_ts` on both ends of a thread. The parent's equals its
  // own `ts`; a reply's points back at the parent. That single comparison is
  // the whole thread model.
  const isThreadParent = threadTs !== null && threadTs === ts;
  const isThreadReply = threadTs !== null && threadTs !== ts;

  const edited = raw.edited;
  // Slack has been observed to send `edited: {}`; treat that as edited with an
  // unknown time rather than silently dropping the flag.
  const isEdited = Boolean(edited);
  const editedAt = edited?.ts ? parseSlackTs(edited.ts) : null;

  return {
    conversationId,
    ts,
    sentAt: parseSlackTs(ts),

    threadTs,
    isThreadReply,
    isThreadParent,
    // Only meaningful on a parent; a reply's `reply_count` is not reliable.
    replyCount: isThreadParent ? (raw.reply_count ?? 0) : 0,

    userId: raw.user ?? null,
    botId: raw.bot_id ?? raw.bot_profile?.id ?? null,
    authorName: raw.username ?? raw.bot_profile?.name ?? null,

    subtype: raw.subtype ?? null,
    text: raw.text ?? '',
    blocks: raw.blocks ? [...raw.blocks] : null,

    isEdited,
    editedAt,

    hasFiles: Array.isArray(raw.files) && raw.files.length > 0,
    reactions: normalizeReactions(raw.reactions),
    mentionedUserIds: extractMentionedUserIds(raw.text),

    teamId: raw.team ?? null,
  };
}

// ---------------------------------------------------------------------------
// Message events (Socket Mode)
// ---------------------------------------------------------------------------

/**
 * A `message` event is really three different events wearing one name, so
 * normalization returns a tagged union instead of pretending otherwise:
 * a new/updated message, a deletion, or something we deliberately skip.
 */
export type NormalizedMessageEvent =
  | { kind: 'upsert'; message: NormalizedMessage }
  | { kind: 'delete'; conversationId: string; ts: string }
  | { kind: 'ignore'; reason: string };

export function normalizeMessageEvent(
  event: RawSlackMessage,
): NormalizedMessageEvent {
  const conversationId = event.channel;
  if (!conversationId) {
    return { kind: 'ignore', reason: 'event has no channel' };
  }

  switch (event.subtype) {
    case 'message_deleted': {
      const ts = event.deleted_ts ?? event.previous_message?.ts;
      if (!ts) {
        return { kind: 'ignore', reason: 'message_deleted without a ts' };
      }
      return { kind: 'delete', conversationId, ts };
    }

    // `message_changed` carries the *new* message nested under `message`; the
    // outer envelope's own `ts` is the event time, not the message's, so using
    // the envelope directly would create a duplicate row under a wrong ts.
    // `message_replied` is the same shape, sent when a thread's reply_count
    // changes.
    case 'message_changed':
    case 'message_replied': {
      const inner = event.message;
      if (!inner?.ts) {
        return {
          kind: 'ignore',
          reason: `${event.subtype} without a nested message`,
        };
      }
      // A tombstone arrives as `message_changed` with the nested message
      // flagged hidden/deleted rather than as `message_deleted`.
      if (inner.subtype === 'tombstone') {
        return { kind: 'delete', conversationId, ts: inner.ts };
      }
      return {
        kind: 'upsert',
        message: normalizeMessage(inner, conversationId),
      };
    }

    default: {
      if (!event.ts) {
        return { kind: 'ignore', reason: 'message event without a ts' };
      }
      return {
        kind: 'upsert',
        message: normalizeMessage(event, conversationId),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/**
 * Work out the conversation kind. Slack's booleans are the primary signal but
 * are not all present on every endpoint (`search.messages` in particular ships
 * a thinner `channel` object), so the id prefix is the fallback: `D` = DM,
 * `C` = channel, `G` = legacy private channel / group DM.
 */
export function conversationKindFrom(
  raw: RawSlackConversation,
): ConversationKind {
  if (raw.is_im) return 'IM';
  if (raw.is_mpim) return 'MPIM';
  if (raw.is_channel || raw.is_group) {
    return raw.is_private ? 'PRIVATE_CHANNEL' : 'PUBLIC_CHANNEL';
  }

  switch (raw.id?.[0]) {
    case 'D':
      return 'IM';
    case 'C':
      return 'PUBLIC_CHANNEL';
    case 'G':
      return 'PRIVATE_CHANNEL';
    default:
      return 'UNKNOWN';
  }
}

export function normalizeConversation(
  raw: RawSlackConversation,
): NormalizedConversation {
  if (!raw.id) {
    throw new NormalizationError('Slack conversation has no id');
  }

  const kind = conversationKindFrom(raw);

  return {
    id: raw.id,
    kind,
    // IMs have no name; Slack sometimes sends "" rather than omitting it.
    name: raw.name ? raw.name : null,
    // `channel.user` is only the peer on a 1:1 DM. On other conversation kinds
    // it means something else entirely (e.g. the creator), so don't store it.
    peerUserId: kind === 'IM' ? (raw.user ?? null) : null,
    topic: raw.topic?.value ? raw.topic.value : null,
    purpose: raw.purpose?.value ? raw.purpose.value : null,
    isArchived: Boolean(raw.is_archived),
    isMember: Boolean(raw.is_member),
    teamId: raw.context_team_id ?? raw.shared_team_ids?.[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function normalizeUser(raw: RawSlackUser): NormalizedUser {
  if (!raw.id) {
    throw new NormalizationError('Slack user has no id');
  }

  const profile = raw.profile;

  return {
    id: raw.id,
    teamId: raw.team_id ?? null,
    username: raw.name ?? null,
    realName: profile?.real_name ? profile.real_name : null,
    displayName: profile?.display_name ? profile.display_name : null,
    avatarUrl: profile?.image_72 ?? null,
    timezone: raw.tz ?? null,
    isBot: Boolean(raw.is_bot),
    isDeleted: Boolean(raw.deleted),
  };
}

/** Best available human-facing label for a user. */
export function userDisplayLabel(user: NormalizedUser): string {
  return user.displayName || user.realName || user.username || user.id;
}
