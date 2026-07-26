/**
 * Timestamp formatting for the queue.
 *
 * `now` is always an explicit argument rather than a call to `Date.now()`.
 * Two reasons: it makes the function testable without faking timers, and the
 * inbox is server-rendered then hydrated — reading the clock independently on
 * each side produces a React hydration mismatch on any message near a
 * boundary. The server passes one `now` down and both renders agree.
 *
 * Only relative labels are produced here. Absolute times are locale- and
 * timezone-dependent, so they are rendered after mount by the client (see
 * `useLocalTimestamp`), never during SSR.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;

/**
 * Compact relative label: "now", "5m", "3h", "2d", "6w", "1y".
 *
 * Compact rather than "5 minutes ago" because this sits in a dense list where
 * the column has to stay narrow and scannable. Clock skew (a message stamped
 * slightly in the future) reads as "now" instead of a negative number.
 */
export function formatRelativeTime(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);

  if (!Number.isFinite(then) || !Number.isFinite(now)) return '';

  const elapsed = now - then;
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d`;
  if (elapsed < YEAR) return `${Math.floor(elapsed / WEEK)}w`;
  return `${Math.floor(elapsed / YEAR)}y`;
}

/**
 * Long-form age: "just now", "5 minutes", "3 hours", "2 days", "3 weeks".
 *
 * The compact form above is right for a dense timestamp column; this one is for
 * prose — the bump staleness label and the classification prompt, both of which
 * read as sentences. Singular/plural is handled because "1 days ago" in a
 * user-facing string looks like a bug.
 */
export function describeAge(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return 'an unknown time';

  const elapsed = now - then;
  if (elapsed < MINUTE) return 'just now';

  const unit = (value: number, name: string) =>
    `${value} ${name}${value === 1 ? '' : 's'}`;

  if (elapsed < HOUR) return unit(Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return unit(Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < WEEK) return unit(Math.floor(elapsed / DAY), 'day');
  if (elapsed < YEAR) return unit(Math.floor(elapsed / WEEK), 'week');
  return unit(Math.floor(elapsed / YEAR), 'year');
}

/**
 * The label a collapsed bump chain wears (plan.md, Phase 3: "a 3-message bump
 * chain should appear as 1 item showing 'first asked X days ago'").
 *
 * The point of collapsing is that a chase does *not* make the item look new —
 * so the row states how long the original ask has been sitting there.
 */
export function bumpStalenessLabel(
  firstAskedAtIso: string,
  nowIso: string,
): string {
  const age = describeAge(firstAskedAtIso, nowIso);
  return age === 'just now'
    ? 'first asked just now'
    : `first asked ${age} ago`;
}

/** Day bucket for the list's group headers. Also relative, also pure. */
export function formatDayBucket(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return '';

  const elapsed = now - then;
  if (elapsed < DAY) return 'Today';
  if (elapsed < 2 * DAY) return 'Yesterday';
  if (elapsed < WEEK) return 'This week';
  if (elapsed < 4 * WEEK) return 'This month';
  return 'Older';
}
