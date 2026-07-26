import { describe, expect, it } from 'vitest';

import {
  describeSnooze,
  hasNewActivitySinceSnooze,
  InvalidSnoozeTimeError,
  isSnoozed,
  LATER_TODAY_HOURS,
  MAX_SNOOZE_MS,
  MORNING_HOUR,
  nextSweepDelayMs,
  resolveSnoozePreset,
  selectDueSnoozes,
  SNOOZE_PRESETS,
  validateSnoozeTime,
  wakeReason,
  type SnoozeState,
} from '@/lib/snooze/schedule';

/**
 * plan.md, Phase 6 verification items 1 and 2:
 *  - "given a snooze time, item reappears at/after that time, not before"
 *  - "test early-unsnooze-on-new-activity path"
 *
 * Every function takes `now` explicitly, so none of this needs fake timers or a
 * sleeping test.
 */

const NOW = new Date('2026-07-26T14:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

function state(overrides: Partial<SnoozeState> = {}): SnoozeState {
  return {
    snoozedUntil: at(HOUR),
    snoozedAt: at(-MINUTE),
    lastActivityAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

describe('resolveSnoozePreset', () => {
  it('puts "later today" a few hours out, never at a fixed hour', () => {
    // Snoozing at 11pm must not mean "in 10 hours".
    const resolved = resolveSnoozePreset('later_today', NOW);
    expect(resolved?.getTime()).toBe(NOW.getTime() + LATER_TODAY_HOURS * HOUR);

    const lateNight = new Date('2026-07-26T23:30:00.000Z');
    const fromLate = resolveSnoozePreset('later_today', lateNight);
    expect(fromLate!.getTime()).toBeGreaterThan(lateNight.getTime());
  });

  it('snaps tomorrow and next week to the morning', () => {
    const tomorrow = resolveSnoozePreset('tomorrow', NOW)!;
    expect(tomorrow.getHours()).toBe(MORNING_HOUR);
    expect(tomorrow.getMinutes()).toBe(0);

    const nextWeek = resolveSnoozePreset('next_week', NOW)!;
    expect(nextWeek.getHours()).toBe(MORNING_HOUR);
    expect(nextWeek.getTime()).toBeGreaterThan(tomorrow.getTime());
  });

  it('always resolves to the future', () => {
    for (const preset of SNOOZE_PRESETS) {
      const resolved = resolveSnoozePreset(preset, NOW);
      if (resolved === null) continue;
      expect(resolved.getTime(), preset).toBeGreaterThan(NOW.getTime());
    }
  });

  it('returns null for custom, which needs a time from the caller', () => {
    expect(resolveSnoozePreset('custom', NOW)).toBeNull();
  });
});

describe('validateSnoozeTime', () => {
  it('accepts a time in the future', () => {
    expect(() => validateSnoozeTime(at(HOUR), NOW)).not.toThrow();
  });

  it('refuses a time in the past', () => {
    // Accepting one would reinject on the very next sweep, which looks like the
    // feature silently failing.
    expect(() => validateSnoozeTime(at(-HOUR), NOW)).toThrow(
      InvalidSnoozeTimeError,
    );
  });

  it('refuses now exactly', () => {
    expect(() => validateSnoozeTime(new Date(NOW), NOW)).toThrow(/future/);
  });

  it('refuses an unparseable date', () => {
    expect(() => validateSnoozeTime(new Date('nonsense'), NOW)).toThrow(
      /not a valid time/,
    );
  });

  it('refuses something absurdly far out', () => {
    expect(() => validateSnoozeTime(at(MAX_SNOOZE_MS + DAY), NOW)).toThrow(
      /year/,
    );
  });
});

// ---------------------------------------------------------------------------
// Verification 1: back at/after the time, never before
// ---------------------------------------------------------------------------

describe('isSnoozed', () => {
  it('hides the item before the snooze time', () => {
    expect(isSnoozed(state({ snoozedUntil: at(HOUR) }), NOW)).toBe(true);
    expect(isSnoozed(state({ snoozedUntil: at(MINUTE) }), NOW)).toBe(true);
    expect(isSnoozed(state({ snoozedUntil: at(1) }), NOW)).toBe(true);
  });

  it('brings it back exactly at the snooze time', () => {
    // plan.md says "at/after". Late by a millisecond is fine; early is a bug.
    expect(isSnoozed(state({ snoozedUntil: new Date(NOW) }), NOW)).toBe(false);
  });

  it('brings it back after the snooze time', () => {
    expect(isSnoozed(state({ snoozedUntil: at(-MINUTE) }), NOW)).toBe(false);
    expect(isSnoozed(state({ snoozedUntil: at(-DAY) }), NOW)).toBe(false);
  });

  it('is not snoozed when no snooze is set', () => {
    expect(isSnoozed(state({ snoozedUntil: null }), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verification 2: early unsnooze on new activity
// ---------------------------------------------------------------------------

describe('early unsnooze on new activity', () => {
  it('wakes the item when someone replies while it is away', () => {
    // The whole point: snoozing a question until tomorrow must not mean missing
    // the answer that arrives ten minutes later.
    const woken = state({
      snoozedUntil: at(DAY),
      snoozedAt: at(-HOUR),
      lastActivityAt: at(-MINUTE),
    });

    expect(hasNewActivitySinceSnooze(woken)).toBe(true);
    expect(isSnoozed(woken, NOW)).toBe(false);
    expect(wakeReason(woken, NOW)).toBe('activity');
  });

  it('ignores activity that predates the snooze', () => {
    // The message that *caused* the user to snooze must not immediately wake it.
    const quiet = state({
      snoozedUntil: at(DAY),
      snoozedAt: at(-HOUR),
      lastActivityAt: at(-2 * HOUR),
    });

    expect(hasNewActivitySinceSnooze(quiet)).toBe(false);
    expect(isSnoozed(quiet, NOW)).toBe(true);
  });

  it('ignores activity in the same millisecond as the snooze', () => {
    const snoozedAt = at(-HOUR);
    const simultaneous = state({
      snoozedUntil: at(DAY),
      snoozedAt,
      lastActivityAt: new Date(snoozedAt),
    });

    expect(hasNewActivitySinceSnooze(simultaneous)).toBe(false);
    expect(isSnoozed(simultaneous, NOW)).toBe(true);
  });

  it('stays asleep when there is no activity at all', () => {
    expect(
      isSnoozed(
        state({ snoozedUntil: at(DAY), snoozedAt: at(-HOUR), lastActivityAt: null }),
        NOW,
      ),
    ).toBe(true);
  });

  it('needs a snoozedAt to compare against', () => {
    // A row with a snooze time but no snoozedAt is malformed; treat activity as
    // inconclusive rather than waking everything.
    expect(
      hasNewActivitySinceSnooze({
        snoozedUntil: at(DAY),
        snoozedAt: null,
        lastActivityAt: at(-MINUTE),
      }),
    ).toBe(false);
  });

  it('reports why an item came back', () => {
    expect(wakeReason(state({ snoozedUntil: at(-MINUTE) }), NOW)).toBe('time');
    expect(
      wakeReason(
        state({ snoozedUntil: at(DAY), snoozedAt: at(-HOUR), lastActivityAt: NOW }),
        NOW,
      ),
    ).toBe('activity');
    expect(wakeReason(state({ snoozedUntil: at(HOUR) }), NOW)).toBeNull();
    expect(wakeReason(state({ snoozedUntil: null }), NOW)).toBeNull();
  });

  it('prefers "activity" when both reasons apply', () => {
    // Overdue *and* replied to: the reply is the more useful explanation.
    expect(
      wakeReason(
        state({
          snoozedUntil: at(-MINUTE),
          snoozedAt: at(-HOUR),
          lastActivityAt: at(-30 * MINUTE),
        }),
        NOW,
      ),
    ).toBe('activity');
  });
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe('selectDueSnoozes', () => {
  const items = [
    { id: 'due-by-time', ...state({ snoozedUntil: at(-MINUTE) }) },
    { id: 'still-asleep', ...state({ snoozedUntil: at(HOUR) }) },
    {
      id: 'due-by-activity',
      ...state({
        snoozedUntil: at(DAY),
        snoozedAt: at(-HOUR),
        lastActivityAt: at(-MINUTE),
      }),
    },
    { id: 'never-snoozed', ...state({ snoozedUntil: null }) },
  ];

  it('returns exactly the items that should come back', () => {
    expect(selectDueSnoozes(items, NOW).map((item) => item.id)).toEqual([
      'due-by-time',
      'due-by-activity',
    ]);
  });

  it('is idempotent — sweeping twice reinjects the same set, not more', () => {
    // A sweep rather than a timer per message, because a timer would not survive
    // the app being closed overnight. That only works if re-running is safe.
    const first = selectDueSnoozes(items, NOW);
    const second = selectDueSnoozes(items, NOW);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
  });

  it('never returns an item that was never snoozed', () => {
    expect(
      selectDueSnoozes(items, NOW).some((item) => item.id === 'never-snoozed'),
    ).toBe(false);
  });
});

describe('nextSweepDelayMs', () => {
  it('is null when nothing is snoozed', () => {
    expect(nextSweepDelayMs([state({ snoozedUntil: null })], NOW)).toBeNull();
    expect(nextSweepDelayMs([], NOW)).toBeNull();
  });

  it('counts down to the earliest pending snooze', () => {
    expect(
      nextSweepDelayMs(
        [state({ snoozedUntil: at(2 * HOUR) }), state({ snoozedUntil: at(HOUR) })],
        NOW,
      ),
    ).toBe(HOUR);
  });

  it('is zero when something is already due', () => {
    expect(
      nextSweepDelayMs(
        [state({ snoozedUntil: at(HOUR) }), state({ snoozedUntil: at(-DAY) })],
        NOW,
      ),
    ).toBe(0);
  });

  it('is never negative', () => {
    expect(
      nextSweepDelayMs([state({ snoozedUntil: at(-DAY) })], NOW),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('describeSnooze', () => {
  it('describes the remaining time in useful units', () => {
    expect(describeSnooze(at(30 * MINUTE), NOW)).toBe('Snoozed 30 more minutes');
    expect(describeSnooze(at(MINUTE), NOW)).toBe('Snoozed 1 more minute');
    expect(describeSnooze(at(3 * HOUR), NOW)).toBe('Snoozed 3 more hours');
    expect(describeSnooze(at(2 * DAY), NOW)).toBe('Snoozed 2 more days');
  });

  it('says it is back once the time has passed', () => {
    expect(describeSnooze(at(-MINUTE), NOW)).toBe('Back now');
    expect(describeSnooze(new Date(NOW), NOW)).toBe('Back now');
  });
});
