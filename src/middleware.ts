import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE_NAME } from '@/lib/auth/session';

/**
 * First-pass gate: anonymous requests never reach a page or handler.
 *
 * Deliberately a *presence* check, not a signature check. Middleware runs on
 * the edge runtime, where Next inlines `process.env` at build time — and this
 * app is built in Docker with placeholder values and given its real secrets at
 * run time, so a signature check here would verify against an empty secret and
 * lock the owner out of their own app.
 *
 * The real check is `requireOwnerSession()` / `requireOwnerPage()` in
 * `src/lib/auth/require.ts`, which runs in the Node runtime and can read the
 * database. Every protected surface calls it. This file exists so an
 * unauthenticated visitor gets a redirect instead of a stack trace — forging
 * the cookie's presence gets you past middleware and no further.
 */

/** Reachable signed out: the connect screen, health, and the OAuth handshake. */
const PUBLIC_PATHS = new Set([
  '/',
  '/api/health',
  '/api/slack/oauth/start',
  '/api/slack/oauth/callback',
  '/api/auth/signout',
]);

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  if (request.cookies.get(SESSION_COOKIE_NAME)?.value) {
    return NextResponse.next();
  }

  // Server actions POST to the page they live on; a redirect would be
  // swallowed by the action response. 401 is both honest and visible.
  if (request.method !== 'GET') {
    return new NextResponse(null, { status: 401 });
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const target = request.nextUrl.clone();
  target.pathname = '/';
  target.search = '?signed_out=1';
  return NextResponse.redirect(target);
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own static output and the favicon. Those are
     * public build artifacts with no user data in them, and gating them only
     * breaks the sign-in page's own styling.
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
