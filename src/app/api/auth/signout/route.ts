import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE_NAME } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/auth/signout
 *
 * Drops the session cookie. The Slack installation and its token stay put —
 * signing out ends the browser session, it does not disconnect the workspace.
 *
 * POST-only so a stray link preview or prefetch cannot sign the owner out.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.redirect(new URL('/', request.nextUrl.origin), {
    // 303 so the browser follows with GET rather than re-POSTing.
    status: 303,
  });

  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: 0,
  });

  return response;
}
