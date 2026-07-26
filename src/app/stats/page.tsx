import Link from 'next/link';

import { loadStats } from '@/lib/stats/load';
import {
  formatDuration,
  formatPercent,
  WINDOW_LABEL,
  type DailyPoint,
  type TriageSummary,
} from '@/lib/stats/compute';

/**
 * The stats dashboard (plan.md, Phase 7).
 *
 * A server component: the whole page is a database read plus pure arithmetic
 * from `lib/stats/compute.ts`, so there is nothing for the client to do.
 */

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Stats · SlackZero',
};

function Stat({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div
      className="rounded-lg border border-neutral-200 px-4 py-3"
      data-testid={testId}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900">
        {value}
      </div>
      {hint ? (
        <div className="mt-0.5 text-[11px] text-neutral-500">{hint}</div>
      ) : null}
    </div>
  );
}

function SummaryBlock({
  summary,
  testId,
}: {
  summary: TriageSummary;
  testId: string;
}) {
  return (
    <section className="mt-6" data-testid={testId}>
      <h2 className="text-sm font-semibold text-neutral-800">
        {WINDOW_LABEL[summary.window]}
      </h2>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Triaged"
          value={String(summary.triaged)}
          hint="marked done in this window"
          testId={`${testId}-triaged`}
        />
        <Stat
          label="Median response"
          value={formatDuration(summary.medianResponseMs)}
          hint={
            summary.meanResponseMs !== null
              ? `mean ${formatDuration(summary.meanResponseMs)} · p90 ${formatDuration(summary.p90ResponseMs)}`
              : undefined
          }
          testId={`${testId}-median`}
        />
        <Stat
          label="Received"
          value={String(summary.received)}
          hint={
            summary.clearedRate !== null
              ? `${formatPercent(summary.clearedRate)} already cleared`
              : undefined
          }
          testId={`${testId}-received`}
        />
        <Stat
          label="Still open"
          value={String(summary.open)}
          hint="across all time"
          testId={`${testId}-open`}
        />
      </div>
    </section>
  );
}

/**
 * A bar chart in CSS, deliberately.
 *
 * A charting library would be a dependency and a client bundle for what is a
 * list of divs with a height. plan.md's Phase 7 asks for a "simple stats
 * dashboard page"; this is the simple version that stays a server component.
 */
function Sparkline({ series }: { series: DailyPoint[] }) {
  const peak = Math.max(1, ...series.map((point) => point.triaged));

  return (
    <section className="mt-8" data-testid="stats-series">
      <h2 className="text-sm font-semibold text-neutral-800">
        Triaged per day
      </h2>
      <ol className="mt-3 flex items-end gap-1" style={{ height: '96px' }}>
        {series.map((point) => {
          const heightPct = (point.triaged / peak) * 100;
          return (
            <li
              key={point.date}
              className="flex min-w-0 flex-1 flex-col justify-end"
              data-testid="stats-series-day"
              data-date={point.date}
              data-triaged={point.triaged}
              title={`${point.date}: ${point.triaged} triaged, ${point.received} received`}
            >
              <div
                className={
                  point.triaged > 0
                    ? 'rounded-sm bg-violet-500'
                    : 'rounded-sm bg-neutral-200'
                }
                // A zero day still gets a sliver, so the axis reads as a row of
                // days rather than as missing data.
                style={{ height: point.triaged > 0 ? `${Math.max(heightPct, 6)}%` : '2px' }}
              />
            </li>
          );
        })}
      </ol>
      <div className="mt-1 flex justify-between text-[10px] text-neutral-400">
        <span>{series[0]?.date}</span>
        <span>{series[series.length - 1]?.date}</span>
      </div>
    </section>
  );
}

export default async function StatsPage() {
  let stats;
  try {
    stats = await loadStats();
  } catch (error) {
    return (
      <main className="mx-auto max-w-4xl p-8" data-testid="stats-error">
        <h1 className="text-xl font-semibold">Stats unavailable</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Could not read from the database. Is Postgres running (
          <code>docker compose up -d</code>)?
        </p>
        <p className="mt-4 font-mono text-xs text-red-700">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <p className="mt-6 text-sm">
          <Link className="underline" href="/inbox">
            Back to the inbox
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl p-8" data-testid="stats-page">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Stats</h1>
        <nav className="text-sm">
          <Link className="underline" href="/inbox">
            Back to the inbox
          </Link>
        </nav>
      </header>

      {!stats.isConnected ? (
        <p
          className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          data-testid="stats-not-connected"
        >
          Slack is not connected, so there is nothing to measure yet.{' '}
          <Link className="underline" href="/">
            Connect a workspace
          </Link>
          .
        </p>
      ) : null}

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Open now"
          value={String(stats.openTotal)}
          hint="waiting to be triaged"
          testId="stat-open-total"
        />
        <Stat
          label="Waiting on others"
          value={String(stats.waitingOn)}
          hint="asks with no reply yet"
          testId="stat-waiting-on"
        />
        <Stat
          label="Streak"
          value={stats.streak === 0 ? '—' : `${stats.streak}d`}
          hint="consecutive days triaging"
          testId="stat-streak"
        />
      </div>

      <SummaryBlock summary={stats.today} testId="summary-day" />
      <SummaryBlock summary={stats.week} testId="summary-week" />

      <Sparkline series={stats.series} />

      <p className="mt-8 text-[11px] text-neutral-400">
        Response time is measured from when a message arrived to when you marked
        it done. Messages you sent yourself are excluded. Data covers the last 30
        days.
      </p>
    </main>
  );
}
