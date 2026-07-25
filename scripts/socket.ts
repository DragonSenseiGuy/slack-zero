/**
 * Socket Mode listener: `npm run socket`
 *
 * Holds an outbound WebSocket to Slack and writes incoming messages, edits,
 * deletions, and reactions straight into Postgres. No public URL or tunnel is
 * required. Runs until interrupted (Ctrl-C).
 */
import 'dotenv/config';

import { prisma } from '../src/lib/db';
import { startSocketModeListener } from '../src/lib/slack/socket';

async function main(): Promise<void> {
  const stamp = () => new Date().toISOString().slice(11, 23);

  const listener = await startSocketModeListener({
    onLog: (message) => console.log(`[${stamp()}] ${message}`),
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[${stamp()}] ${signal} — shutting down`);
    await listener.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
