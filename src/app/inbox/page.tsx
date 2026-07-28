import Link from 'next/link';

import { loadInbox, resolveConversationScope } from '@/lib/queue/load';
import { runSnoozeSweeps } from '@/lib/snooze/actions';
import { listViews } from '@/lib/views/actions';
import { InboxClient } from '@/app/inbox/InboxClient';
import type { QueueScope } from '@/lib/queue/queue';
import type { SavedView } from '@/lib/views/filters';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Inbox · SlackZero',
};

export default async function InboxPage({
  searchParams,
}: {
  searchParams?: { in?: string };
}) {
  try {
    await runSnoozeSweeps();
  } catch {
  }

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
  let views: SavedView[] = [];
  try {
    views = await listViews();
  } catch {
    views = [];
  }

  let initialScope: QueueScope | null = null;
  if (searchParams?.in) {
    try {
      initialScope = await resolveConversationScope(searchParams.in);
    } catch {
      initialScope = null;
    }
  }

  const nowIso = new Date().toISOString();

  return (
    <InboxClient
      items={data.items}
      workspaceName={data.workspaceName}
      isConnected={data.authedUserId !== null}
      nowIso={nowIso}
      views={views}
      initialScope={initialScope}
    />
  );
}
