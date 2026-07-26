import { describe, expect, it } from 'vitest';

import {
  currentStreak,
  dailySeries,
  formatDuration,
  formatPercent,
  mean,
  median,
  percentile,
  replyTimeMs,
  responseTimeMs,
  summarize,
  type StatsRow,
} from '@/lib/stats/compute';

/**
 * plan.md, Phase 7 verification: "unit test response-time calculation against
 * fixture data with known timestamps".
 *
 * Every timestamp below is an exact offset from a fixed `NOW`, so each expected
 * duration is written out rather than derived — a test that recomputes the
 * thing it is checking proves nothing.
 */

const NOW = new Date('2026-07-26T18:00:00.000Z');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

let counter = 0;

function row(overrides: Partial<StatsRow> = {}): StatsRow {
  counter += 1;
  return {
    id: `m${counter}`,
    sentAt: at(-2 * HOUR),
    doneAt: at(-HOUR),
    isDone: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Response time
// ---------------------------------------------------------------------------

describe('responseTimeMs', () => {
  it('is the gap between arrival and done', () => {
    // Arrived 5h ago, done 2h ago → took exactly 3h.
    expect(
      responseTimeMs(row({ sentAt: at(-5 * HOUR), doneAt: at(-2 * HOUR) })),
    ).toBe(3 * HOUR);
  });

  it('is exact for a sub-minute turnaround', () => {
    expect(
      responseTimeMs(
        row({ sentAt: at(-90_000), doneAt: at(-60_000) }),
      ),
    ).toBe(30_000);
  });

  it('is null while the item is still open', () => {
    expect(responseTimeMs(row({ isDone: false, doneAt: null }))).toBeNull();
  });

  it('is null when marked done with no timestamp', () => {
    expect(responseTimeMs(row({ isDone: true, doneAt: null }))).toBeNull();
  });

  it('clamps a negative gap to zero rather than reporting it', () => {
    // Slack's `ts` is the sender's clock and `doneAt` is ours; they disagree by
    // a second or two routinely. One negative value would drag an average below
    // zero and make the whole dashboard untrustworthy.
    expect(
      responseTimeMs(row({ sentAt: at(-HOUR), doneAt: at(-2 * HOUR) })),
    ).toBe(0);
  });

  it('is null for an unparseable timestamp', () => {
    expect(
      responseTimeMs(row({ sentAt: new Date('nonsense') })),
    ).toBeNull();
  });
});

describe('replyTimeMs', () => {
  it('measures arrival to reply, independently of done', () => {
    expect(
      replyTimeMs(
        row({ sentAt: at(-4 * HOUR), repliedAt: at(-3 * HOUR), isDone: false }),
      ),
    ).toBe(HOUR);
  });

  it('is null when there was no reply', () => {
    expect(replyTimeMs(row())).toBeNull();
    expect(replyTimeMs(row({ repliedAt: null }))).toBeNull();
  });

  it('clamps a negative gap to zero', () => {
    expect(
      replyTimeMs(row({ sentAt: at(-HOUR), repliedAt: at(-2 * HOUR) })),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

describe('median', () => {
  it('is the middle value for an odd count', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middle values for an even count', () => {
    // (2 + 3) / 2 = 2.5, rounded to 3 — these are millisecond durations, so a
    // fractional result is noise rather than precision.
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('is null for no data', () => {
    expect(median([])).toBeNull();
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('resists the skew that would wreck a mean', () => {
    // Nine fast triages and one from after a two-week holiday. The median is
    // the number the user recognises as their turnaround; the mean is not.
    const values = [
      ...Array.from({ length: 9 }, () => 5 * MINUTE),
      14 * DAY,
    ];
    expect(median(values)).toBe(5 * MINUTE);
    expect(mean(values)!).toBeGreaterThan(HOUR);
  });
});

describe('percentile', () => {
  it('uses nearest-rank', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 90)).toBe(9);
    expect(percentile(values, 50)).toBe(5);
  });

  it('clamps out-of-range percentiles to the extremes', () => {
    expect(percentile([5, 1, 9], 0)).toBe(1);
    expect(percentile([5, 1, 9], 100)).toBe(9);
  });

  it('is null for no data', () => {
    expect(percentile([], 90)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

describe('summarize', () => {
  it('counts triaged by when it was DONE, not when it arrived', () => {
    // A message from last week cleared this morning is part of today's work.
    const rows = [
      row({ sentAt: at(-10 * DAY), doneAt: at(-HOUR) }),
      row({ sentAt: at(-2 * HOUR), doneAt: at(-30 * MINUTE) }),
    ];

    expect(summarize(rows, 'day', NOW).triaged).toBe(2);
  });

  it('counts received by arrival, which is a different question', () => {
    const rows = [
      row({ sentAt: at(-10 * DAY), doneAt: at(-HOUR) }),
      row({ sentAt: at(-2 * HOUR), doneAt: at(-30 * MINUTE) }),
    ];

    const summary = summarize(rows, 'day', NOW);
    expect(summary.received).toBe(1);
    expect(summary.triaged).toBe(2);
  });

  it('excludes work done before the window', () => {
    const rows = [
      row({ sentAt: at(-5 * DAY), doneAt: at(-3 * DAY) }),
      row({ sentAt: at(-2 * HOUR), doneAt: at(-HOUR) }),
    ];

    expect(summarize(rows, 'day', NOW).triaged).toBe(1);
    expect(summarize(rows, 'week', NOW).triaged).toBe(2);
  });

  it('counts open items regardless of when they arrived', () => {
    const rows = [
      row({ isDone: false, doneAt: null, sentAt: at(-30 * DAY) }),
      row({ isDone: false, doneAt: null, sentAt: at(-HOUR) }),
      row(),
    ];

    expect(summarize(rows, 'day', NOW).open).toBe(2);
  });

  it('computes response-time stats over exactly the windowed rows', () => {
    // Two triaged today: one took 1h, one took 3h. Median of [1h, 3h] = 2h.
    const rows = [
      row({ sentAt: at(-3 * HOUR), doneAt: at(-2 * HOUR) }),
      row({ sentAt: at(-5 * HOUR), doneAt: at(-2 * HOUR) }),
      // Outside the window, and much slower — must not move the numbers.
      row({ sentAt: at(-20 * DAY), doneAt: at(-10 * DAY) }),
    ];

    const summary = summarize(rows, 'day', NOW);
    expect(summary.medianResponseMs).toBe(2 * HOUR);
    expect(summary.meanResponseMs).toBe(2 * HOUR);
    expect(summary.p90ResponseMs).toBe(3 * HOUR);
  });

  it('reports the cleared rate over messages received in the window', () => {
    const rows = [
      row({ sentAt: at(-HOUR), doneAt: at(-30 * MINUTE), isDone: true }),
      row({ sentAt: at(-2 * HOUR), isDone: false, doneAt: null }),
      row({ sentAt: at(-3 * HOUR), isDone: false, doneAt: null }),
      row({ sentAt: at(-4 * HOUR), isDone: false, doneAt: null }),
    ];

    expect(summarize(rows, 'day', NOW).clearedRate).toBe(0.25);
  });

  it('returns nulls rather than zeroes when there is no data', () => {
    // Zero would claim an instant response time; null says "nothing to report",
    // and only one of those is honest on a fresh install.
    const summary = summarize([], 'day', NOW);

    expect(summary.triaged).toBe(0);
    expect(summary.open).toBe(0);
    expect(summary.medianResponseMs).toBeNull();
    expect(summary.meanResponseMs).toBeNull();
    expect(summary.p90ResponseMs).toBeNull();
    expect(summary.clearedRate).toBeNull();
  });

  it('reports the reply time separately from the done time', () => {
    // Replied in 1h, marked done 3h later. "How long did they wait to hear
    // back" is the first number, not the second.
    const rows = [
      row({
        sentAt: at(-5 * HOUR),
        repliedAt: at(-4 * HOUR),
        doneAt: at(-HOUR),
      }),
    ];

    const summary = summarize(rows, 'day', NOW);
    expect(summary.medianReplyMs).toBe(HOUR);
    expect(summary.medianResponseMs).toBe(4 * HOUR);
  });
});

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

describe('dailySeries', () => {
  it('returns one point per day, oldest first', () => {
    const series = dailySeries([], 7, NOW);
    expect(series).toHaveLength(7);

    const dates = series.map((point) => point.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('includes quiet days as zeroes rather than omitting them', () => {
    // A gap in a chart reads as missing data; a zero reads as a quiet day, and
    // only one of those is true.
    const series = dailySeries([row({ doneAt: at(-HOUR) })], 5, NOW);

    expect(series).toHaveLength(5);
    expect(series.slice(0, 4).every((point) => point.triaged === 0)).toBe(true);
    expect(series[series.length - 1].triaged).toBe(1);
  });

  it('buckets by the day the item was done', () => {
    const series = dailySeries(
      [
        row({ sentAt: at(-3 * DAY), doneAt: at(-2 * DAY) }),
        row({ sentAt: at(-2 * DAY), doneAt: at(-HOUR) }),
      ],
      4,
      NOW,
    );

    expect(series[series.length - 1].triaged).toBe(1);
    expect(series.reduce((sum, point) => sum + point.triaged, 0)).toBe(2);
  });

  it('ignores rows outside the requested range', () => {
    const series = dailySeries([row({ doneAt: at(-30 * DAY) })], 7, NOW);
    expect(series.every((point) => point.triaged === 0)).toBe(true);
  });
});

describe('currentStreak', () => {
  it('counts consecutive active days back from today', () => {
    const series = [
      { date: '2026-07-22', triaged: 3, received: 3, medianResponseMs: null },
      { date: '2026-07-23', triaged: 0, received: 1, medianResponseMs: null },
      { date: '2026-07-24', triaged: 2, received: 2, medianResponseMs: null },
      { date: '2026-07-25', triaged: 1, received: 1, medianResponseMs: null },
      { date: '2026-07-26', triaged: 5, received: 5, medianResponseMs: null },
    ];
    expect(currentStreak(series)).toBe(3);
  });

  it('is zero when today has no activity', () => {
    expect(
      currentStreak([
        { date: '2026-07-25', triaged: 9, received: 9, medianResponseMs: null },
        { date: '2026-07-26', triaged: 0, received: 2, medianResponseMs: null },
      ]),
    ).toBe(0);
  });

  it('is zero for an empty series', () => {
    expect(currentStreak([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('picks the coarsest unit that still says something', () => {
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(5 * MINUTE)).toBe('5m');
    expect(formatDuration(3 * HOUR)).toBe('3h');
    expect(formatDuration(3 * HOUR + 20 * MINUTE)).toBe('3h 20m');
    expect(formatDuration(2 * DAY)).toBe('2d');
    expect(formatDuration(2 * DAY + 5 * HOUR)).toBe('2d 5h');
  });

  it('never reports zero seconds for a real duration', () => {
    expect(formatDuration(400)).toBe('1s');
  });

  it('renders no data as a dash, not as zero', () => {
    expect(formatDuration(null)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('rounds to whole percents', () => {
    expect(formatPercent(0.25)).toBe('25%');
    expect(formatPercent(0.666)).toBe('67%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('renders no data as a dash', () => {
    expect(formatPercent(null)).toBe('—');
  });
});
