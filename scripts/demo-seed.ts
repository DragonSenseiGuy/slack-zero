/**
 * Demo seeder: `npm run demo:seed`
 *
 * Fills the database with a fake workspace so SlackZero can be run without a
 * Slack app. See src/lib/demo/workspace.ts for what demo mode is and is not.
 *
 * Refuses to touch a database that holds a real Slack installation — seeding
 * fiction next to someone's actual queue is never what was meant. Use a
 * throwaway DATABASE_URL:
 *
 *   DATABASE_URL=postgresql://slackzero:slackzero@localhost:5433/slackzero_demo
 *
 * Flags:
 *   --clear   remove the demo rows and exit
 */
import 'dotenv/config';

import { prisma } from '../src/lib/db';
import { clearDemoWorkspace, seedDemoWorkspace } from '../src/lib/demo/seed';

async function main(): Promise<void> {
  const clear = process.argv.slice(2).includes('--clear');

  const installations = await prisma.slackInstallation.count();
  if (installations > 0) {
    console.error(
      'Refusing to seed: this database holds a real Slack installation.\n' +
        'Point DATABASE_URL at a separate database for the demo, e.g.\n' +
        '  DATABASE_URL=postgresql://slackzero:slackzero@localhost:5433/slackzero_demo',
    );
    process.exitCode = 1;
    return;
  }

  if (clear) {
    await clearDemoWorkspace(prisma);
    console.log('Demo workspace removed.');
    return;
  }

  const summary = await seedDemoWorkspace(prisma);
  console.log(
    `Seeded the demo workspace: ${summary.messages} messages across ` +
      `${summary.conversations} conversations, ${summary.classifications} ` +
      `classified, ${summary.states} with triage state.`,
  );
  console.log('Now run: npm run demo');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
