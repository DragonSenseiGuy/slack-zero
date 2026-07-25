import Link from 'next/link';

import { loadInbox } from '@/lib/queue/load';
import { InboxClient } from '@/app/inbox/InboxClient';

/**
 * The unified inbox (plan.md, Phase 2).
 *
 * A server component: the database read, the Slack installation lookup, and
 * the queue construction all happen here, and only the serializable
 * `QueueItem[]` crosses to the client. No Slack token, no Prisma row, and no
 * raw Slack payload shape is in the props.
 */

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Inbox · SlackZero',
};

export default async function InboxPage() {
  let data;
  try {
    data = await loadInbox();
  } catch (error) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="text-xl font-semibold">Inbox unavailable</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Could not read the queue from the database. Is Postgres running (
          <code>docker compose up -d</code>)?
        </p>
        <p className="mt-4 font-mono text-xs text-red-700">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <p className="mt-6 text-sm">
          <Link className="underline" href="/">
            Back to setup
          </Link>
        </p>
      </main>
    );
  }

  // The clock is read once, here, and passed down — see the note in
  // `lib/queue/time.ts` about hydration.
  const nowIso = new Date().toISOString();

  return (
    <InboxClient
      items={data.items}
      paletteEntries={data.paletteEntries}
      workspaceName={data.workspaceName}
      isConnected={data.authedUserId !== null}
      nowIso={nowIso}
    />
  );
}
