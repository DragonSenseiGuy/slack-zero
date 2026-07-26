/**
 * Snooze scheduling (plan.md, Phase 6).
 *
 * Pure: every function takes the current time explicitly rather than reading a
 * clock. That is what makes "given a snooze time, the item reappears at/after
 * that time, not before" testable at all — plan.md's first Phase 6 verification
 * item — and it keeps SSR and hydration in agreement, as in `queue/time.ts`.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SNOOZE_PRESETS = [
  'later_today',
  'tomorrow',
  'next_week',
  'custom',
] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];

export const SNOOZE_PRESET_LABEL: Record<SnoozePreset, string> = {
  later_today: 'Later today',
  tomorrow: 'Tomorrow morning',
  next_week: 'Next week',
  custom: 'Pick a time…',
};

/** "Later today" means this many hours on. */
export const LATER_TODAY_HOURS = 3;
/** Morning, for the tomorrow/next-week presets. Local hour, 24h. */
export const MORNING_HOUR = 9;

/**
 * Resolve a preset to an absolute time.
 *
 * `later_today` is a relative offset rather than a fixed hour: snoozing at 11pm
 * should not mean "in 10 hours", and it should never resolve to a time that has
 * already passed. If the offset lands past midnight that is fine — it is still
 * three hours from now, which is what the user asked for.
 *
 * `tomorrow` and `next_week` snap to the morning, because that is when the user
 * will actually be triaging. Returns null for `custom`, which needs a time from
 * the caller.
 */
export function resolveSnoozePreset(
  preset: SnoozePreset,
  now: Date,
): Date | null {
  switch (preset) {
    case 'later_today':
      return new Date(now.getTime() + LATER_TODAY_HOURS * HOUR);

    case 'tomorrow': {
      const target = new Date(now);
      target.setDate(target.getDate() + 1);
      target.setHours(MORNING_HOUR, 0, 0, 0);
      return target;
    }

    case 'next_week': {
      const target = new Date(now);
      target.setDate(target.getDate() + 7);
      target.setHours(MORNING_HOUR, 0, 0, 0);
      return target;
    }

    case 'custom':
      return null;
  }
}

export class InvalidSnoozeTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSnoozeTimeError';
  }
}

/** The furthest ahead a snooze may be set. A year out is a mistake, not intent. */
export const MAX_SNOOZE_MS = 365 * DAY;

/**
 * Validate a chosen snooze time.
 *
 * A snooze in the past would reinject the item on the very next sweep, which
 * looks like the feature silently failing. Refuse it instead.
 */
export function validateSnoozeTime(until: Date, now: Date): void {
  if (Number.isNaN(until.getTime())) {
    throw new InvalidSnoozeTimeError('That is not a valid time.');
  }
  if (until.getTime() <= now.getTime()) {
    throw new InvalidSnoozeTimeError('Pick a time in the future.');
  }
  if (until.getTime() - now.getTime() > MAX_SNOOZE_MS) {
    throw new InvalidSnoozeTimeError('That is more than a year away.');
  }
}

// ---------------------------------------------------------------------------
// Is it back yet?
// ---------------------------------------------------------------------------

/**
 * The snooze-relevant state of one message.
 *
 * `lastActivityAt` is the newest activity on the *thread or conversation* this
 * message belongs to — a reply, an edit, a reaction. It is what makes early
 * unsnoozing possible.
 */
export type SnoozeState = {
  snoozedUntil: Date | null;
  /** When the snooze was set. Activity before this does not count as new. */
  snoozedAt: Date | null;
  lastActivityAt?: Date | null;
};

/**
 * Is this message currently hidden by a snooze?
 *
 * Two ways to be back: the time arrived, or something happened on the thread
 * while it was away. The second is the point of the feature — snoozing a
 * question until tomorrow should not mean missing the answer that arrives in ten
 * minutes.
 *
 * Boundary: at exactly `snoozedUntil` the item is back. plan.md says "at/after
 * that time", and an item that reappears a millisecond late is fine while one
 * that reappears early is a bug.
 */
export function isSnoozed(state: SnoozeState, now: Date): boolean {
  if (state.snoozedUntil === null) return false;
  if (now.getTime() >= state.snoozedUntil.getTime()) return false;
  return !hasNewActivitySinceSnooze(state);
}

/**
 * Did something happen on the thread after the snooze was set?
 *
 * Compared against `snoozedAt`, not against `snoozedUntil`: the question is
 * "has anything happened since I put this away", and the activity that *caused*
 * the user to snooze must not immediately wake it.
 *
 * Strictly greater-than, so activity in the same millisecond as the snooze —
 * which in practice means the snooze itself — does not count.
 */
export function hasNewActivitySinceSnooze(state: SnoozeState): boolean {
  if (!state.lastActivityAt || !state.snoozedAt) return false;
  return state.lastActivityAt.getTime() > state.snoozedAt.getTime();
}

/** Why an item came back, for the UI to explain itself. */
export type WakeReason = 'time' | 'activity' | null;

export function wakeReason(state: SnoozeState, now: Date): WakeReason {
  if (state.snoozedUntil === null) return null;
  if (hasNewActivitySinceSnooze(state)) return 'activity';
  if (now.getTime() >= state.snoozedUntil.getTime()) return 'time';
  return null;
}

/**
 * Snoozes that are due to be swept back into the queue.
 *
 * The background job is a sweep rather than a timer per message: a timer would
 * not survive a restart, and this tool is expected to be closed overnight. A
 * sweep is idempotent — running it twice reinjects nothing twice — so a missed
 * run costs latency, never correctness.
 */
export function selectDueSnoozes<T extends { id: string } & SnoozeState>(
  items: readonly T[],
  now: Date,
): T[] {
  return items.filter(
    (item) => item.snoozedUntil !== null && !isSnoozed(item, now),
  );
}

/** How often the sweep runs. Snooze precision is not worth a tighter loop. */
export const SWEEP_INTERVAL_MS = 60_000;

/**
 * When the next sweep would need to run to wake the earliest snooze on time.
 *
 * Null when nothing is snoozed. Never negative — an overdue item means "sweep
 * now", not "sweep in the past".
 */
export function nextSweepDelayMs(
  items: readonly SnoozeState[],
  now: Date,
): number | null {
  let earliest: number | null = null;

  for (const item of items) {
    if (item.snoozedUntil === null) continue;
    if (!isSnoozed(item, now)) return 0;
    const at = item.snoozedUntil.getTime();
    if (earliest === null || at < earliest) earliest = at;
  }

  if (earliest === null) return null;
  return Math.max(0, earliest - now.getTime());
}

/** Human label for a pending snooze, e.g. "Snoozed until 9:00 AM tomorrow". */
export function describeSnooze(until: Date, now: Date): string {
  const elapsed = until.getTime() - now.getTime();

  if (elapsed <= 0) return 'Back now';
  if (elapsed < HOUR) {
    const minutes = Math.max(1, Math.round(elapsed / MINUTE));
    return `Snoozed ${minutes} more minute${minutes === 1 ? '' : 's'}`;
  }
  if (elapsed < DAY) {
    const hours = Math.round(elapsed / HOUR);
    return `Snoozed ${hours} more hour${hours === 1 ? '' : 's'}`;
  }

  const days = Math.round(elapsed / DAY);
  return `Snoozed ${days} more day${days === 1 ? '' : 's'}`;
}
