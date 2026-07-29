import Link from 'next/link';

import { getOwnerSession } from '@/lib/auth/require';
import { isSlackConfigured } from '@/lib/env';
import {
  getPublicInstallation,
  type PublicInstallation,
} from '@/lib/slack/installation';

export const dynamic = 'force-dynamic';

/**
 * Setup, status, and — since there is no separate login screen — the sign-in
 * page. Signing in *is* completing Slack OAuth as the owner, so this is the one
 * page that must stay reachable while signed out.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: {
    slack_error?: string;
    slack_connected?: string;
    backfill_error?: string;
    signed_out?: string;
  };
}) {
  const session = await getOwnerSession();

  let installation: PublicInstallation | null = null;
  let dbError = false;

  // Workspace details belong to the owner. Signed out, this page says only
  // whether Slack is configured and offers the connect button.
  if (session) {
    try {
      installation = await getPublicInstallation();
    } catch {
      dbError = true;
    }
  }

  const configured = isSlackConfigured();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">SlackZero</h1>
        <p className="text-sm text-neutral-500">
          Keyboard-first triage for Slack. This page is setup and status; the
          queue lives at <code>/inbox</code>.
        </p>
      </header>

      {session ? (
        <p className="flex items-center gap-3">
          <Link
            className="inline-block rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
            href="/inbox"
          >
            Open inbox →
          </Link>
          <form action="/api/auth/signout" method="post">
            <button
              className="rounded border border-neutral-300 px-3 py-2 text-sm"
              type="submit"
            >
              Sign out
            </button>
          </form>
        </p>
      ) : (
        <p className="rounded border border-neutral-300 bg-neutral-50 p-3 text-sm text-neutral-700">
          Signed out. Connect Slack below to sign in — only{' '}
          <code>SLACK_OWNER_USER_ID</code> (or, if that is unset, the Slack user
          who connected first) can open the inbox.
        </p>
      )}

      {searchParams.signed_out ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          You need to sign in with Slack to view that page.
        </p>
      ) : null}

      {searchParams.slack_error === 'not_the_owner' ? (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          That Slack account does not own this SlackZero install, so it was not
          connected. Sign in as the owner instead.
        </p>
      ) : searchParams.slack_error ? (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          Slack connection failed: <code>{searchParams.slack_error}</code>
        </p>
      ) : null}

      {searchParams.slack_connected && installation ? (
        <p className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800">
          Slack connected
          {searchParams.backfill_error ? '.' : ' and past messages imported.'}
        </p>
      ) : null}

      {searchParams.backfill_error ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          Past messages could not be imported. Check the server log, then retry
          by reconnecting Slack or running <code>npm run backfill</code>.
        </p>
      ) : null}

      {dbError ? (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          Could not read the database. Is Postgres running (
          <code>docker compose up -d</code>)?
        </p>
      ) : null}

      <section className="rounded border border-neutral-300 p-4">
        <h2 className="mb-2 text-lg font-medium">Slack</h2>

        {installation ? (
          <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
            <dt className="text-neutral-500">Workspace</dt>
            <dd>
              {installation.teamName}{' '}
              <span className="text-neutral-400">({installation.teamId})</span>
            </dd>

            <dt className="text-neutral-500">Authed user</dt>
            <dd>{installation.authedUserId}</dd>

            <dt className="text-neutral-500">Bot token</dt>
            <dd>{installation.hasBotToken ? 'present' : 'none'}</dd>

            <dt className="text-neutral-500">Scopes</dt>
            <dd className="break-words">
              {installation.scopes.length > 0
                ? installation.scopes.join(', ')
                : '(none reported)'}
            </dd>

            <dt className="text-neutral-500">Connected</dt>
            <dd>{installation.installedAt}</dd>
          </dl>
        ) : (
          <p className="mb-3 text-sm text-neutral-600">
            {session
              ? 'Not connected yet.'
              : 'Sign in to see the connected workspace.'}
          </p>
        )}

        <p className="mt-4">
          {configured ? (
            <a
              className="inline-block rounded bg-[#4A154B] px-4 py-2 text-sm font-medium text-white"
              href="/api/slack/oauth/start"
            >
              {installation ? 'Reconnect Slack' : 'Connect Slack'}
            </a>
          ) : (
            <span className="text-sm text-amber-700">
              Slack credentials are not set. Follow{' '}
              <code>SLACK_APP_SETUP.md</code> and fill in <code>.env</code>{' '}
              first.
            </span>
          )}
        </p>
      </section>

      <p className="text-sm">
        <Link className="underline" href="/health">
          View health check
        </Link>
      </p>
    </main>
  );
}
