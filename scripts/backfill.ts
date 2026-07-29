/**
 * Backfill runner: `npm run backfill`
 *
 * Pulls up to ten unread messages from each of the authed user's DMs and group
 * DMs, plus channel mentions, into Postgres.
 * Safe to re-run — every write is an upsert keyed on Slack's own ids, so a
 * second run reports "refreshed" rather than creating duplicates.
 *
 * Flags:
 *   --oldest <ts>   only fetch messages newer than this Slack ts
 *   --no-mentions   skip the search.messages pass
 *   --no-threads    skip the conversations.replies pass
 *   --json          print the stats object instead of a summary
 */
import 'dotenv/config';

import { prisma } from '../src/lib/db';
import { runBackfill, type BackfillOptions } from '../src/lib/slack/backfill';

function parseArgs(argv: string[]): BackfillOptions & { json: boolean } {
  const options: BackfillOptions & { json: boolean } = { json: false };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--oldest':
        options.oldestTs = argv[++i];
        break;
      case '--no-mentions':
        options.includeMentions = false;
        break;
      case '--no-threads':
        options.includeThreads = false;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const { json, ...options } = parseArgs(process.argv.slice(2));

  const stats = await runBackfill({
    ...options,
    onProgress: json ? undefined : (line) => console.log(`  ${line}`),
  });

  if (json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log('\nBackfill complete.');
  console.log(`  workspace       ${stats.teamId} as ${stats.authedUserId}`);
  console.log(
    `  users           ${stats.users.created} created, ${stats.users.updated} updated`,
  );
  console.log(
    `  conversations   ${stats.conversations.created} created, ${stats.conversations.updated} updated`,
  );
  console.log(
    `  messages        ${stats.messages.created} created, ${stats.messages.updated} updated, ${stats.messages.skipped} skipped`,
  );
  console.log(
    `  mentions        ${stats.mentions.ingested} ingested (search reported ${stats.mentions.searchTotal})`,
  );
  console.log(
    `  threads         ${stats.threads.parents} parents, ${stats.threads.repliesFetched} messages`,
  );
  console.log(`  duration        ${stats.durationMs}ms`);

  if (stats.errors.length > 0) {
    console.log(`\n  ${stats.errors.length} conversation(s) skipped:`);
    for (const failure of stats.errors) {
      console.log(`    ${failure.conversationId}: ${failure.error}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
