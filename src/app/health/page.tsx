import Link from 'next/link';

import { requireOwnerPage } from '@/lib/auth/require';
import { getHealth, type Check, type CheckStatus } from '@/lib/health';

export const dynamic = 'force-dynamic';

/** Plain server-rendered view of the same report /api/health returns. */
export default async function HealthPage() {
  // Owner-only: unlike /api/health this always renders the unredacted detail.
  await requireOwnerPage();

  const report = await getHealth();

  const rows: Array<[string, Check]> = [
    ['Database', report.checks.db],
    ['Slack', report.checks.slack],
    ['LLM (Hack Club AI)', report.checks.llm],
  ];

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Health</h1>
        <p className="text-sm text-neutral-500">
          Overall:{' '}
          <strong className={report.ok ? 'text-green-700' : 'text-red-700'}>
            {report.ok ? 'ok' : 'degraded'}
          </strong>{' '}
          · checked {report.checkedAt}
        </p>
      </header>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left">
            <th className="py-2 pr-4 font-medium">Dependency</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 font-medium">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, check]) => (
            <tr key={label} className="border-b border-neutral-200 align-top">
              <td className="py-2 pr-4">{label}</td>
              <td className={`py-2 pr-4 ${statusClass(check.status)}`}>
                {check.status}
                {typeof check.latencyMs === 'number' ? (
                  <span className="text-neutral-400"> ({check.latencyMs}ms)</span>
                ) : null}
              </td>
              <td className="py-2 text-neutral-600">{check.detail ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-sm text-neutral-500">
        <code>not_configured</code> is expected before Slack OAuth has been run
        and before an LLM key is set.
      </p>

      <p className="text-sm">
        <Link className="underline" href="/">
          Back
        </Link>
      </p>
    </main>
  );
}

function statusClass(status: CheckStatus): string {
  switch (status) {
    case 'ok':
      return 'text-green-700';
    case 'not_configured':
      return 'text-amber-700';
    default:
      return 'text-red-700';
  }
}
