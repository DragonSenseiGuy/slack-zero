import { NextResponse } from 'next/server';

import { getHealth } from '@/lib/health';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health
 *
 * Always 200 when the app itself is serving — the payload's `ok` field carries
 * dependency status. (A non-200 here would be indistinguishable from the app
 * being down.)
 */
export async function GET(): Promise<NextResponse> {
  const report = await getHealth();
  return NextResponse.json(report, {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  });
}
