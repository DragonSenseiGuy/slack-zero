/**
 * Fill in nameless `User` rows: `npm run hydrate:users`
 *
 * Ingestion creates a stub `User` (id only) for a message author that
 * `users.list` never returned — anyone who joined since the last backfill.
 * The Socket Mode listener now resolves those live, but rows created before
 * that need one pass to catch up, which is what this script is for.
 *
 * Safe to re-run: only rows with no username/real name/display name are
 * touched.
 */
import 'dotenv/config';

import { prisma } from '../src/lib/db';
import { hydrateAllStubUsers } from '../src/lib/slack/hydrate';

async function main(): Promise<void> {
  const filled = await hydrateAllStubUsers({
    onLog: (message) => console.log(message),
  });

  console.log(
    filled === 0
      ? 'no stub users needed hydrating'
      : `hydrated ${filled} user${filled === 1 ? '' : 's'}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
