import { NextResponse } from 'next/server';

import { getOwnerSession } from '@/lib/auth/require';
import { getHealth, redactHealth } from '@/lib/health';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/health
 *
 * Always 200 when the app itself is serving — the payload's `ok` field carries
 * dependency status. (A non-200 here would be indistinguishable from the app
 * being down.)
 *
 * Public, because container health checks run without a session — but the
 * detail lines name the Slack user and workspace, so anonymous callers get the
 * redacted report.
 */
export async function GET(): Promise<NextResponse> {
  const [report, session] = await Promise.all([getHealth(), getOwnerSession()]);

  return NextResponse.json(session ? report : redactHealth(report), {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  });
}
