import { describe, expect, it } from 'vitest';

import { formatDayBucket, formatRelativeTime } from '@/lib/queue/time';

const NOW = '2026-07-25T12:00:00.000Z';

function ago(milliseconds: number): string {
  return new Date(Date.parse(NOW) - milliseconds).toISOString();
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe('formatRelativeTime', () => {
  it('reports anything under a minute as "now"', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe('now');
    expect(formatRelativeTime(ago(59 * SECOND), NOW)).toBe('now');
  });

  it('reports minutes, hours, days, weeks and years', () => {
    expect(formatRelativeTime(ago(MINUTE), NOW)).toBe('1m');
    expect(formatRelativeTime(ago(59 * MINUTE), NOW)).toBe('59m');
    expect(formatRelativeTime(ago(HOUR), NOW)).toBe('1h');
    expect(formatRelativeTime(ago(23 * HOUR), NOW)).toBe('23h');
    expect(formatRelativeTime(ago(DAY), NOW)).toBe('1d');
    expect(formatRelativeTime(ago(6 * DAY), NOW)).toBe('6d');
    expect(formatRelativeTime(ago(WEEK), NOW)).toBe('1w');
    expect(formatRelativeTime(ago(400 * DAY), NOW)).toBe('1y');
  });

  it('treats a future timestamp as "now" rather than a negative number', () => {
    // Slack ts vs. local clock skew is real; a "-3m" in the queue looks broken.
    expect(formatRelativeTime(new Date(Date.parse(NOW) + HOUR).toISOString(), NOW)).toBe(
      'now',
    );
  });

  it('returns an empty string for unparseable input rather than "NaNm"', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
    expect(formatRelativeTime(NOW, 'not-a-date')).toBe('');
  });

  it('is pure — the same arguments always give the same answer', () => {
    const iso = ago(3 * HOUR);
    expect(formatRelativeTime(iso, NOW)).toBe(formatRelativeTime(iso, NOW));
  });
});

describe('formatDayBucket', () => {
  it('buckets by recency', () => {
    expect(formatDayBucket(ago(HOUR), NOW)).toBe('Today');
    expect(formatDayBucket(ago(30 * HOUR), NOW)).toBe('Yesterday');
    expect(formatDayBucket(ago(3 * DAY), NOW)).toBe('This week');
    expect(formatDayBucket(ago(2 * WEEK), NOW)).toBe('This month');
    expect(formatDayBucket(ago(90 * DAY), NOW)).toBe('Older');
  });

  it('returns an empty string for unparseable input', () => {
    expect(formatDayBucket('nope', NOW)).toBe('');
  });
});
