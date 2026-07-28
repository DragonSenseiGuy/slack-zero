const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;

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

export function bumpStalenessLabel(
  firstAskedAtIso: string,
  nowIso: string,
): string {
  const age = describeAge(firstAskedAtIso, nowIso);
  return age === 'just now'
    ? 'first asked just now'
    : `first asked ${age} ago`;
}

export function burstSpanLabel(
  messageCount: number,
  firstMessageAtIso: string,
  nowIso: string,
): string {
  const count = `${messageCount} messages`;
  const age = describeAge(firstMessageAtIso, nowIso);
  return age === 'just now' ? count : `${count} · since ${age} ago`;
}

/** How long until `iso`, phrased like `describeAge` but forwards in time. */
export function describeDelay(iso: string, nowIso: string): string {
  return describeAge(nowIso, iso);
}

/**
 * One line saying that this row is a snooze the user set for themselves, and
 * where it is in its life.
 *
 * Exists because a woken snooze is otherwise indistinguishable from a message
 * that just arrived — the sweep clears `snoozedUntil` to bring the item back,
 * so the queue row loses the only evidence it was ever a reminder.
 */
export function snoozeStatusLabel(
  snooze: {
    state: 'pending' | 'returned';
    untilIso: string;
    returnedAtIso: string | null;
    returnedReason: 'time' | 'activity' | 'manual' | null;
  },
  nowIso: string,
): string {
  if (snooze.state === 'pending') {
    const delay = describeDelay(snooze.untilIso, nowIso);
    return delay === 'just now'
      ? 'Snoozed · due now'
      : `Snoozed · back in ${delay}`;
  }

  const returnedAt = snooze.returnedAtIso ?? snooze.untilIso;
  const age = describeAge(returnedAt, nowIso);
  const when = age === 'just now' ? 'just now' : `${age} ago`;

  switch (snooze.returnedReason) {
    case 'activity':
      return `Snoozed · woken early by new activity, ${when}`;
    case 'manual':
      return `Snoozed · you brought it back ${when}`;
    default:
      return `Snoozed · came back ${when}`;
  }
}

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
