/**
 * Backfill cross-check: `npm run backfill:verify`
 *
 * Independently recounts what Slack reports and compares it to what is in
 * Postgres. Deliberately does NOT reuse `backfill.ts` or `normalize.ts` — it
 * calls the Slack API and Prisma directly, so a bug in the ingestion path
 * cannot hide behind the same bug in the check.
 *
 * This is the evidence for plan.md Phase 1, verification #1.
 */
import 'dotenv/config';

import { WebClient } from '@slack/web-api';

import { prisma } from '../src/lib/db';

type Row = {
  what: string;
  slack: number;
  db: number;
  note?: string;
};

async function main(): Promise<void> {
  const installation = await prisma.slackInstallation.findFirst({
    orderBy: { updatedAt: 'desc' },
  });
  if (!installation) throw new Error('No Slack installation stored.');

  const slack = new WebClient(installation.userAccessToken);
  const me = installation.authedUserId;
  const rows: Row[] = [];

  console.log(`Cross-checking ${installation.teamName} as ${me}\n`);

  // --- Users -------------------------------------------------------------
  const users = await slack.users.list({ limit: 200 });
  rows.push({
    what: 'workspace members',
    slack: users.members?.length ?? 0,
    db: await prisma.user.count(),
  });

  // --- Conversations -----------------------------------------------------
  const conversations = await slack.conversations.list({
    types: 'im,mpim,private_channel,public_channel',
    exclude_archived: true,
    limit: 200,
  });
  const channels = conversations.channels ?? [];
  rows.push({
    what: 'conversations',
    slack: channels.length,
    db: await prisma.conversation.count(),
  });

  const ims = channels.filter((channel) => channel.is_im || channel.is_mpim);
  rows.push({
    what: '  of which DMs/mpims',
    slack: ims.length,
    db: await prisma.conversation.count({
      where: { kind: { in: ['IM', 'MPIM'] } },
    }),
  });

  // --- Messages per DM ---------------------------------------------------
  let dmMessages = 0;
  const unreadable: string[] = [];

  for (const im of ims) {
    if (!im.id) continue;
    try {
      const history = await slack.conversations.history({
        channel: im.id,
        limit: 1000,
      });
      const count = history.messages?.length ?? 0;
      dmMessages += count;
      console.log(`  ${im.id}: ${count} message(s) visible in Slack`);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null
          ? ((error as { data?: { error?: string } }).data?.error ?? 'error')
          : 'error';
      unreadable.push(`${im.id} (${code})`);
      console.log(`  ${im.id}: unreadable — ${code}`);
    }
  }

  rows.push({
    what: 'messages in DMs/mpims',
    slack: dmMessages,
    db: await prisma.message.count({
      where: { conversation: { kind: { in: ['IM', 'MPIM'] } } },
    }),
    note: unreadable.length > 0 ? `skipped: ${unreadable.join(', ')}` : undefined,
  });

  // --- Channel mentions --------------------------------------------------
  const search = await slack.search.messages({
    query: `<@${me}>`,
    count: 100,
  });
  rows.push({
    what: 'channel mentions of me',
    slack: search.messages?.total ?? 0,
    db: await prisma.message.count({
      where: {
        conversation: { kind: { in: ['PUBLIC_CHANNEL', 'PRIVATE_CHANNEL'] } },
        mentionedUserIds: { has: me },
      },
    }),
  });

  // --- Report ------------------------------------------------------------
  console.log('');
  let allMatch = true;
  for (const row of rows) {
    const match = row.slack === row.db;
    allMatch &&= match;
    console.log(
      `${match ? 'OK  ' : 'MISMATCH'}  ${row.what.padEnd(24)} slack=${row.slack}  db=${row.db}` +
        (row.note ? `   (${row.note})` : ''),
    );
  }

  console.log(
    allMatch
      ? '\nAll counts match.'
      : '\nCounts do not match — investigate before marking Phase 1 done.',
  );
  if (!allMatch) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
