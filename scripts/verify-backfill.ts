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

import { prisma } from '../src/lib/db';
import { getSlackContext } from '../src/lib/slack/client';

type Row = {
  what: string;
  slack: number;
  db: number;
  note?: string;
};

async function main(): Promise<void> {
  const context = await getSlackContext();
  const slack = context.client;
  const me = context.authedUserId;
  const rows: Row[] = [];

  console.log(`Cross-checking ${context.teamName ?? context.teamId} as ${me}\n`);

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

  // --- Unread messages per DM --------------------------------------------
  const unreadDmKeys = new Set<string>();
  const unreadable: string[] = [];

  for (const im of ims) {
    if (!im.id) continue;
    try {
      const info = await slack.conversations.info({ channel: im.id });
      const lastRead = info.channel?.last_read;
      const history = await slack.conversations.history({
        channel: im.id,
        limit: 10,
      });
      const unread = (history.messages ?? []).filter(
        (message) =>
          message.ts && (!lastRead || Number(message.ts) > Number(lastRead)),
      );
      unread.forEach((message) => unreadDmKeys.add(`${im.id}:${message.ts}`));
      console.log(`  ${im.id}: ${unread.length} unread message(s) in the latest 10`);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null
          ? ((error as { data?: { error?: string } }).data?.error ?? 'error')
          : 'error';
      unreadable.push(`${im.id} (${code})`);
      console.log(`  ${im.id}: unreadable — ${code}`);
    }
  }

  const unreadDmIdentities = unreadDmKeys.size > 0
    ? await prisma.message.findMany({
        where: {
          OR: [...unreadDmKeys].map((key) => {
            const separator = key.indexOf(':');
            return {
              conversationId: key.slice(0, separator),
              ts: key.slice(separator + 1),
            };
          }),
        },
        select: { conversationId: true, ts: true },
      })
    : [];
  rows.push({
    what: 'recent unread DMs/mpims',
    slack: unreadDmKeys.size,
    db: unreadDmIdentities.length,
    note: unreadable.length > 0 ? `skipped: ${unreadable.join(', ')}` : undefined,
  });

  // --- Channel mentions --------------------------------------------------
  const mentionMatches: Array<{ channel?: { id?: string }; ts?: string }> = [];
  let mentionPage = 1;
  let mentionPages = 1;
  do {
    const search = await slack.search.messages({ query: `<@${me}>`, count: 100, page: mentionPage });
    mentionMatches.push(...((search.messages?.matches ?? []) as typeof mentionMatches));
    mentionPages = search.messages?.paging?.pages ?? mentionPage;
    mentionPage += 1;
  } while (mentionPage <= mentionPages);
  const slackMentionKeys = new Set(
    mentionMatches.flatMap((match) => {
      const channelId = match.channel?.id;
      return channelId && match.ts ? [`${channelId}:${match.ts}`] : [];
    }),
  );
  const dbMentionIdentities = await prisma.message.findMany({
    where: { OR: [...slackMentionKeys].map((key) => {
      const separator = key.indexOf(':');
      return { conversationId: key.slice(0, separator), ts: key.slice(separator + 1) };
    }) },
    select: { conversationId: true, ts: true },
  });
  const dbMentionKeys = new Set(dbMentionIdentities.map((row) => `${row.conversationId}:${row.ts}`));
  const identityMatch = slackMentionKeys.size === dbMentionKeys.size && [...slackMentionKeys].every((key) => dbMentionKeys.has(key));
  rows.push({
    what: 'channel mentions of me',
    slack: slackMentionKeys.size,
    db: dbMentionKeys.size,
    note: identityMatch ? undefined : 'identity sets differ',
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
