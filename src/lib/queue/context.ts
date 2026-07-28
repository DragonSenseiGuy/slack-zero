import {
  HIDDEN_SUBTYPES,
  lookupFrom,
  senderLabelFor,
  type QueueConversation,
  type QueueUser,
} from '@/lib/queue/queue';
import { collapseWhitespace, renderSlackText } from '@/lib/queue/text';

/**
 * Conversation context: the messages that came *before* the one being triaged.
 *
 * A queue row is a single message pulled out of a conversation, which is enough
 * to decide "is this urgent" and nowhere near enough to decide "what do I say".
 * "sounds good, go ahead" means nothing without the question above it. This
 * module turns stored rows into the transcript the reading pane shows above the
 * message, one page at a time.
 *
 * Pure on purpose: the DB query lives in `load.ts`, so paging arithmetic and
 * rendering are testable without a database.
 */

/** How many messages a page of context holds. */
export const CONTEXT_PAGE_SIZE = 10;

/** Ceiling on `limit`, so a hand-written URL cannot ask for the whole history. */
export const MAX_CONTEXT_PAGE_SIZE = 50;

/** One earlier message, as the reading pane renders it. */
export type ContextMessage = {
  id: string;
  ts: string;
  sentAtIso: string;
  senderLabel: string;
  senderAvatarUrl: string | null;
  /** True when the authed user wrote it — their own half of the conversation. */
  isFromMe: boolean;
  body: string;
  isEdited: boolean;
};

export type ContextPage = {
  /** Oldest first, so the pane reads top-to-bottom into the message. */
  messages: ContextMessage[];
  /**
   * Whether more history exists before `messages[0]`. Derived from over-fetching
   * by one rather than from a count, which would double the query cost to answer
   * a question the user only needs a yes/no for.
   */
  hasMore: boolean;
};

/** The stored columns this module needs. Narrower than `QueueMessageRow`. */
export type ContextMessageRow = {
  id: string;
  ts: string;
  sentAt: Date;
  userId: string | null;
  authorName: string | null;
  botId: string | null;
  subtype: string | null;
  text: string;
  isEdited: boolean;
  isDeleted: boolean;
  hasFiles: boolean;
};

export type ContextRequest = {
  /** Slack `ts`; only strictly-earlier messages are returned. */
  before: string;
  limit: number;
};

export class InvalidContextRequestError extends Error {}

/**
 * Read `?before=&limit=` off a context request.
 *
 * `before` is required and is a Slack `ts` rather than an offset: paging by
 * offset would skip or repeat messages whenever ingestion inserted history
 * underneath the cursor, which backfill does routinely.
 */
export function parseContextRequest(params: URLSearchParams): ContextRequest {
  const before = params.get('before')?.trim() ?? '';
  if (before === '') {
    throw new InvalidContextRequestError('A `before` timestamp is required.');
  }
  if (!/^\d+\.\d+$/.test(before)) {
    throw new InvalidContextRequestError(
      '`before` must be a Slack timestamp, e.g. 1784938592.138359.',
    );
  }

  const rawLimit = params.get('limit');
  if (rawLimit === null) return { before, limit: CONTEXT_PAGE_SIZE };

  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidContextRequestError('`limit` must be a positive integer.');
  }

  return { before, limit: Math.min(limit, MAX_CONTEXT_PAGE_SIZE) };
}

/** Placeholder for a message whose whole content is an attachment. */
function emptyBodyFallback(row: ContextMessageRow): string {
  return row.hasFiles ? '(file attachment)' : '(no text)';
}

/** Whether a stored row is worth showing as context at all. */
export function isContextWorthy(row: ContextMessageRow): boolean {
  if (row.isDeleted) return false;
  return row.subtype === null || !HIDDEN_SUBTYPES.has(row.subtype);
}

export function toContextMessage(
  row: ContextMessageRow,
  users: ReadonlyMap<string, QueueUser>,
  conversations: ReadonlyMap<string, QueueConversation>,
  authedUserId: string | null,
): ContextMessage {
  const lookup = lookupFrom(users, conversations);
  const rendered = renderSlackText(row.text, lookup);

  return {
    id: row.id,
    ts: row.ts,
    sentAtIso: row.sentAt.toISOString(),
    senderLabel: senderLabelFor(
      { userId: row.userId, authorName: row.authorName, botId: row.botId },
      users,
    ),
    senderAvatarUrl: row.userId
      ? (users.get(row.userId)?.avatarUrl ?? null)
      : null,
    isFromMe: authedUserId !== null && row.userId === authedUserId,
    body: collapseWhitespace(rendered) ? rendered : emptyBodyFallback(row),
    isEdited: row.isEdited,
  };
}

/**
 * Turn one over-fetched, newest-first batch into a page.
 *
 * The caller asks the database for `limit + 1` rows newest-first (the cheap
 * direction when reading backwards from a cursor); this drops the extra, flips
 * the order, and reports whether the extra existed.
 */
export function buildContextPage(
  rowsNewestFirst: readonly ContextMessageRow[],
  limit: number,
  users: ReadonlyMap<string, QueueUser>,
  conversations: ReadonlyMap<string, QueueConversation>,
  authedUserId: string | null,
): ContextPage {
  const usable = rowsNewestFirst.filter(isContextWorthy);
  const hasMore = usable.length > limit;

  const page = usable.slice(0, limit).reverse();

  return {
    hasMore,
    messages: page.map((row) =>
      toContextMessage(row, users, conversations, authedUserId),
    ),
  };
}
