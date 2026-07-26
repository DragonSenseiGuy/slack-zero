/**
 * Snooze reinjection job: `npm run snooze:sweep`
 *
 * Wakes snoozed messages whose time has come, and any whose thread has seen new
 * activity since the snooze was set (plan.md, Phase 6).
 *
 * A polling sweep rather than a timer per message, deliberately: a timer would
 * not survive the process being closed, and this is a local tool that is closed
 * overnight — which is exactly when a "tomorrow morning" snooze elapses. The
 * sweep is idempotent, so a missed run costs latency and never correctness.
 *
 * The inbox also sweeps on load, so running this is optional; it exists so an
 * item reappears while the app is *already open*.
 *
 * Flags:
 *   --once   run a single sweep and exit (default: loop)
 */
import 'dotenv/config';

import { prisma } from '../src/lib/db';
import { runSnoozeSweeps } from '../src/lib/snooze/actions';
import { SWEEP_INTERVAL_MS } from '../src/lib/snooze/schedule';

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

async function sweepOnce(): Promise<void> {
  const { byTime, byActivity } = await runSnoozeSweeps();
  if (byTime > 0 || byActivity > 0) {
    console.log(
      `[${stamp()}] woke ${byTime} by time, ${byActivity} by new activity`,
    );
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');

  if (once) {
    await sweepOnce();
    return;
  }

  console.log(
    `Sweeping snoozes every ${SWEEP_INTERVAL_MS / 1000}s. Ctrl-C to stop.`,
  );

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    try {
      await sweepOnce();
    } catch (error) {
      // Never exit the loop on a transient database error: the whole value of a
      // sweep is that it keeps running unattended.
      console.error(
        `[${stamp()}] sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, SWEEP_INTERVAL_MS));
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
