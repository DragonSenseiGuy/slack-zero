/**
 * Triage statistics (plan.md, Phase 7).
 *
 * Pure: takes rows and an explicit `now`, returns numbers. No Prisma, no clock,
 * no formatting decisions that depend on a locale at module load. That is what
 * makes plan.md's "unit test response-time calculation against fixture data with
 * known timestamps" a real test rather than a snapshot of whenever it last ran.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One triaged (or still-open) message, as the stats care about it. */
export type StatsRow = {
  id: string;
  /** When the message arrived in Slack. */
  sentAt: Date;
  /** When the user marked it done, if they have. */
  doneAt: Date | null;
  isDone: boolean;
  /**
   * When the user replied in this conversation, if they did. Used for the
   * reply-specific response time, which is the number that actually reflects
   * "how long did someone wait to hear back from me".
   */
  repliedAt?: Date | null;
};

/**
 * Time from a message arriving to the user disposing of it.
 *
 * Null when it is not yet done, or when the timestamps are unusable.
 *
 * **Clamped at zero, never negative.** A negative response time is not a real
 * measurement, it is a clock problem: Slack's `ts` is the sender's view of when
 * the message existed, our `doneAt` comes from this machine, and the two can
 * disagree by a second or two. Letting one negative value through would drag an
 * average below zero and make the whole dashboard untrustworthy.
 */
export function responseTimeMs(row: StatsRow): number | null {
  if (!row.isDone || row.doneAt === null) return null;

  const sent = row.sentAt.getTime();
  const done = row.doneAt.getTime();
  if (!Number.isFinite(sent) || !Number.isFinite(done)) return null;

  return Math.max(0, done - sent);
}

/** Time from arrival to the user's reply, for rows that got one. */
export function replyTimeMs(row: StatsRow): number | null {
  if (!row.repliedAt) return null;

  const sent = row.sentAt.getTime();
  const replied = row.repliedAt.getTime();
  if (!Number.isFinite(sent) || !Number.isFinite(replied)) return null;

  return Math.max(0, replied - sent);
}

/**
 * Median rather than mean, as the headline.
 *
 * Response times are heavily skewed: a handful of messages triaged after a
 * two-week holiday will drag a mean far above anything the user recognises as
 * their normal turnaround. The mean is still reported, because the gap between
 * the two is itself informative, but the median is the number that answers "how
 * fast am I usually".
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round(total / values.length);
}

/** Nth percentile by nearest-rank, so p90 of 10 values is the 9th. */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null;
  if (p <= 0) return Math.min(...values);
  if (p >= 100) return Math.max(...values);

  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

export type StatsWindow = 'day' | 'week';

export const WINDOW_MS: Record<StatsWindow, number> = {
  day: DAY,
  week: 7 * DAY,
};

export const WINDOW_LABEL: Record<StatsWindow, string> = {
  day: 'Last 24 hours',
  week: 'Last 7 days',
};

export type TriageSummary = {
  window: StatsWindow;
  /** Messages the user marked done inside the window. */
  triaged: number;
  /** Still open right now, regardless of when they arrived. */
  open: number;
  /** Arrived inside the window, done or not. */
  received: number;
  medianResponseMs: number | null;
  meanResponseMs: number | null;
  p90ResponseMs: number | null;
  medianReplyMs: number | null;
  /** Of the messages received in the window, how many are already handled. */
  clearedRate: number | null;
};

/**
 * Summarize triage over a window.
 *
 * `triaged` counts by **when it was done**, not when it arrived: the question
 * the dashboard answers is "how much did I get through today", and a message
 * from last week cleared this morning is part of today's work. `received`
 * counts by arrival, which is a different question, so both are reported rather
 * than one standing in for the other.
 */
export function summarize(
  rows: readonly StatsRow[],
  window: StatsWindow,
  now: Date,
): TriageSummary {
  const since = now.getTime() - WINDOW_MS[window];

  const doneInWindow = rows.filter(
    (row) => row.isDone && row.doneAt !== null && row.doneAt.getTime() >= since,
  );

  const receivedInWindow = rows.filter(
    (row) => row.sentAt.getTime() >= since,
  );

  const responseTimes = doneInWindow
    .map(responseTimeMs)
    .filter((value): value is number => value !== null);

  const replyTimes = doneInWindow
    .map(replyTimeMs)
    .filter((value): value is number => value !== null);

  const clearedFromWindow = receivedInWindow.filter((row) => row.isDone).length;

  return {
    window,
    triaged: doneInWindow.length,
    open: rows.filter((row) => !row.isDone).length,
    received: receivedInWindow.length,
    medianResponseMs: median(responseTimes),
    meanResponseMs: mean(responseTimes),
    p90ResponseMs: percentile(responseTimes, 90),
    medianReplyMs: median(replyTimes),
    clearedRate:
      receivedInWindow.length === 0
        ? null
        : clearedFromWindow / receivedInWindow.length,
  };
}

export type DailyPoint = {
  /** YYYY-MM-DD in local time, which is what the user thinks of as "a day". */
  date: string;
  triaged: number;
  received: number;
  medianResponseMs: number | null;
};

function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Per-day series for the last `days` days, oldest first.
 *
 * Days with no activity are included as zeroes rather than omitted — a gap in a
 * chart reads as missing data, while a zero reads as a quiet day, and only one
 * of those is true.
 */
export function dailySeries(
  rows: readonly StatsRow[],
  days: number,
  now: Date,
): DailyPoint[] {
  const buckets = new Map<string, { triaged: number[]; received: number }>();

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(now);
    day.setDate(day.getDate() - offset);
    buckets.set(localDateKey(day), { triaged: [], received: 0 });
  }

  for (const row of rows) {
    if (row.isDone && row.doneAt) {
      const bucket = buckets.get(localDateKey(row.doneAt));
      if (bucket) {
        const elapsed = responseTimeMs(row);
        if (elapsed !== null) bucket.triaged.push(elapsed);
        else bucket.triaged.push(0);
      }
    }

    const receivedBucket = buckets.get(localDateKey(row.sentAt));
    if (receivedBucket) receivedBucket.received += 1;
  }

  return [...buckets.entries()].map(([date, bucket]) => ({
    date,
    triaged: bucket.triaged.length,
    received: bucket.received,
    medianResponseMs: median(bucket.triaged),
  }));
}

/** The user's longest run of consecutive days with at least one item triaged. */
export function currentStreak(series: readonly DailyPoint[]): number {
  let streak = 0;
  for (let index = series.length - 1; index >= 0; index -= 1) {
    if (series[index].triaged === 0) break;
    streak += 1;
  }
  return streak;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * A duration, in the coarsest unit that still says something useful.
 *
 * Deliberately not `Intl.RelativeTimeFormat`: this is a duration, not a point in
 * time, and "in 3 hours" would be wrong for "took 3 hours".
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.round((ms % HOUR) / MINUTE);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.round((ms % DAY) / HOUR);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

export function formatPercent(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}
