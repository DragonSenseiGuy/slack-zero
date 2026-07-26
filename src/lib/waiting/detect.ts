/**
 * "Waiting on others" detection (plan.md, Phase 6).
 *
 * A message *the user sent* that asked for something and has not been answered.
 * Pure and deterministic — no LLM. That is deliberate:
 *
 *  - it runs over every message the user has ever sent, which is exactly the
 *    high-volume per-message work CLAUDE.md says not to spend a model on;
 *  - plan.md asks for it to be unit tested "against labeled sample
 *    conversations", and a rule can be held to a labeled set exactly, whereas
 *    the Phase 3 experience showed model output drifting between runs.
 *
 * The rules below are intentionally conservative. A missed waiting-on item is
 * invisible; a false one nags the user to chase something that was never a
 * question, which is how a follow-up feature gets turned off.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One message in a conversation, from the detector's point of view. */
export type WaitingCandidate = {
  id: string;
  conversationId: string;
  /** Slack user id of the author. */
  userId: string | null;
  text: string;
  sentAt: Date;
  threadTs: string | null;
  isDeleted?: boolean;
  /** True when someone reacted — a thumbs-up often *is* the answer. */
  hasReactions?: boolean;
};

export type WaitingResult = {
  messageId: string;
  conversationId: string;
  askedAt: Date;
  /** Why it counted as an ask, for debugging and for the UI to explain itself. */
  reason: WaitingReason;
};

export type WaitingReason =
  | 'direct_question'
  | 'request'
  | 'approval_request'
  | 'scheduling';

/**
 * Phrasings that make a message a request even without a question mark.
 * Ordered most to least specific; the first match wins so `reason` is stable.
 */
const REQUEST_PATTERNS: ReadonlyArray<{ reason: WaitingReason; pattern: RegExp }> =
  [
    {
      reason: 'approval_request',
      pattern:
        /\b(can you (approve|sign off|review)|need(s)? (your )?(approval|sign-?off|review)|please (approve|review)|approve this|sign off on)\b/i,
    },
    {
      reason: 'scheduling',
      pattern:
        /\b(are you (free|available)|when (are|is) you|does .{0,20}work for you|can we (meet|sync|chat)|what time|book a (time|slot))\b/i,
    },
    {
      reason: 'request',
      pattern:
        /\b(could you|can you|would you mind|please (send|share|take a look|check|update|look)|let me know|any chance you)\b/i,
    },
  ];

/**
 * Messages that end in a question mark but are not asks.
 *
 * Rhetorical and social questions are the main source of false positives, and a
 * feature that tells the user they are "waiting on" a reply to "how are you?"
 * loses their trust immediately.
 */
const NOT_AN_ASK =
  /^(how are you|how are we|how's it going|hows it going|you (there|around|about)|anyone (there|around)|right|really|what|huh|ok|okay|wdyt|thoughts|no|yeah|yeah right|makes sense|sound good|cool)$/i;

/**
 * Strip surrounding punctuation and whitespace before matching `NOT_AN_ASK`.
 *
 * The candidate sentences arrive with their terminating `?` still attached, so
 * anchoring the patterns without allowing for it silently matched nothing —
 * "how are you?" was classified as a real ask until the labeled set caught it.
 */
function bareSentence(sentence: string): string {
  return sentence.replace(/^[\s"'“‘(]+|[\s"'”’)?!.,]+$/g, '').trim();
}

/** Strip Slack code spans and blocks before looking for question marks. */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/**
 * Does this message ask the recipient for something?
 *
 * A question mark alone is not enough (rhetorical questions), and a request
 * phrase alone is enough (`"could you take a look"` needs no punctuation).
 */
export function classifyAsk(text: string): WaitingReason | null {
  const body = withoutCode(text).trim();
  if (body === '') return null;

  for (const { reason, pattern } of REQUEST_PATTERNS) {
    if (pattern.test(body)) return reason;
  }

  if (body.includes('?')) {
    // Check the sentence the question mark actually terminates, not the whole
    // message — "thanks! how are you?" should not qualify a real ask elsewhere.
    const questions = body
      .split(/(?<=\?)/)
      .map((part) => part.trim())
      .filter((part) => part.endsWith('?'));

    const meaningful = questions.filter((question) => {
      const bare = bareSentence(question);
      if (bare === '') return false;
      if (NOT_AN_ASK.test(bare)) return false;
      // A bare "?" or a two-word question is almost always social.
      return bare.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).length >= 3;
    });

    if (meaningful.length > 0) return 'direct_question';
  }

  return null;
}

export type DetectWaitingOptions = {
  /** The user whose outgoing messages are being examined. */
  authedUserId: string;
  now: Date;
  /**
   * Ignore asks newer than this — nobody is "waiting" ten seconds in, and
   * flagging a message the instant it is sent is noise.
   */
  minAgeMs?: number;
};

export const DEFAULT_MIN_AGE_MS = 30 * MINUTE;

/**
 * Find the asks the user is still waiting on.
 *
 * "Answered" is defined as *anyone else* speaking in the same thread (or, for a
 * non-threaded message, the same conversation) after the ask. That is a
 * deliberate simplification: it cannot tell whether the reply actually addressed
 * the question, and it treats any later message as an answer. The alternative —
 * asking a model whether each reply resolved each ask — is precisely the
 * per-message LLM work this module exists to avoid.
 *
 * The user's own later messages do **not** count as answers; otherwise every
 * bump would clear the very item it was chasing.
 */
export function detectWaitingOn(
  messages: readonly WaitingCandidate[],
  options: DetectWaitingOptions,
): WaitingResult[] {
  const { authedUserId, now } = options;
  const minAge = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;

  const live = messages.filter((message) => message.isDeleted !== true);

  const results: WaitingResult[] = [];

  for (const message of live) {
    if (message.userId !== authedUserId) continue;
    if (now.getTime() - message.sentAt.getTime() < minAge) continue;

    const reason = classifyAsk(message.text);
    if (reason === null) continue;

    // A reaction is often the whole answer ("👍" to "can you approve this?").
    if (message.hasReactions) continue;

    const answered = live.some((other) => {
      if (other.id === message.id) return false;
      if (other.userId === authedUserId || other.userId === null) return false;
      if (other.conversationId !== message.conversationId) return false;
      if (other.sentAt.getTime() <= message.sentAt.getTime()) return false;
      // Inside a thread, only that thread's replies answer it. Outside one, any
      // later message in the conversation counts.
      if (message.threadTs) return other.threadTs === message.threadTs;
      return true;
    });

    if (answered) continue;

    results.push({
      messageId: message.id,
      conversationId: message.conversationId,
      askedAt: message.sentAt,
      reason,
    });
  }

  // Oldest first: the stalest ask is the one most worth chasing.
  return results.sort((a, b) => a.askedAt.getTime() - b.askedAt.getTime());
}

// ---------------------------------------------------------------------------
// Staleness and nudges
// ---------------------------------------------------------------------------

/** Past this, an unanswered ask is worth surfacing as a nudge. */
export const NUDGE_THRESHOLD_MS = 2 * DAY;

export type Staleness = 'fresh' | 'aging' | 'stale';

/**
 * How overdue an ask is.
 *
 * Three bands rather than a number, because the exact hour count is not what the
 * user acts on — "this has been sitting for days" is.
 */
export function stalenessOf(askedAt: Date, now: Date): Staleness {
  const elapsed = now.getTime() - askedAt.getTime();
  if (elapsed >= NUDGE_THRESHOLD_MS) return 'stale';
  if (elapsed >= DAY) return 'aging';
  return 'fresh';
}

export const STALENESS_LABEL: Record<Staleness, string> = {
  fresh: 'Waiting',
  aging: 'Waiting a day',
  stale: 'Needs a nudge',
};

/** The asks that have gone quiet long enough to be worth chasing. */
export function selectNudges(
  waiting: readonly WaitingResult[],
  now: Date,
  thresholdMs: number = NUDGE_THRESHOLD_MS,
): WaitingResult[] {
  return waiting.filter(
    (result) => now.getTime() - result.askedAt.getTime() >= thresholdMs,
  );
}

/** "asked 3 days ago" — the staleness indicator plan.md asks for. */
export function describeWait(askedAt: Date, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - askedAt.getTime());

  if (elapsed < HOUR) {
    const minutes = Math.max(1, Math.floor(elapsed / MINUTE));
    return `asked ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `asked ${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.floor(elapsed / DAY);
  return `asked ${days} day${days === 1 ? '' : 's'} ago`;
}
