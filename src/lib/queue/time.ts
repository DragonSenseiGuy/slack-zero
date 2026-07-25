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
