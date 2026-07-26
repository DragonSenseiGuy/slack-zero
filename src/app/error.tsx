'use client';

import { useEffect } from 'react';

/**
 * Root error boundary (plan.md, Phase 8).
 *
 * Catches anything a route throws during render so a single bad row cannot
 * replace the whole app with a blank page. The message is shown rather than
 * hidden: this is a single-user local tool, the "user" is the person who can
 * fix it, and swallowing the reason would just mean opening devtools anyway.
 */

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Next has already logged this, but not with our framing.
    console.error('SlackZero crashed while rendering:', error);
  }, [error]);

  return (
    <main className="mx-auto max-w-2xl p-8" data-testid="app-error">
      <h1 className="text-xl font-semibold text-neutral-900">
        Something broke
      </h1>
      <p className="mt-2 text-sm text-neutral-600">
        This page failed to render. Your Slack data is untouched — SlackZero
        never writes to Slack except when you send a reply.
      </p>

      <pre
        className="mt-4 overflow-x-auto rounded border border-red-200 bg-red-50 p-3 font-mono text-xs text-red-800"
        data-testid="app-error-detail"
      >
        {error.message}
        {error.digest ? `\n\ndigest: ${error.digest}` : ''}
      </pre>

      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={reset}
          data-testid="app-error-retry"
          className="rounded bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700"
        >
          Try again
        </button>
        <a
          href="/inbox"
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
        >
          Back to the inbox
        </a>
      </div>

      <p className="mt-6 text-xs text-neutral-500">
        If this keeps happening, check that Postgres is up
        (<code>docker compose up -d</code>) and that <code>/api/health</code>{' '}
        reports all three checks green.
      </p>
    </main>
  );
}
