/**
 * Waiting-on detection job: `npm run waiting:scan`
 *
 * Finds asks the user sent that nobody has answered, and records them on
 * `MessageState` so the "Waiting on Others" view can show them (plan.md,
 * Phase 6).
 *
 * Rule-based, not model-based. This runs over every message the user has ever
 * sent — exactly the high-volume per-message work CLAUDE.md says not to spend a
 * model on — and the rules are unit tested against a labeled set in
 * `src/lib/waiting/detect.test.ts`.
 *
 * Idempotent: it recomputes the whole set and clears flags that no longer hold,
 * so an ask that has since been answered stops being reported.
 *
 * Flags:
 *   --days <n>  how far back to look (default 30)
 *   --json      print the summary object
 */
import 'dotenv/config';

import { prisma } from '../src/lib/db';
import { getInstallation } from '../src/lib/slack/installation';
import {
  detectWaitingOn,
  describeWait,
  stalenessOf,
  type WaitingCandidate,
} from '../src/lib/waiting/detect';

const DAY_MS = 24 * 60 * 60 * 1000;

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const installation = await getInstallation();
  if (!installation) {
    console.error(
      'No Slack installation stored. Connect a workspace first (SLACK_APP_SETUP.md).',
    );
    process.exitCode = 1;
    return;
  }

  const days = arg('days', 30);
  const since = new Date(Date.now() - days * DAY_MS);
  const now = new Date();

  const rows = await prisma.message.findMany({
    where: { sentAt: { gte: since } },
    select: {
      id: true,
      conversationId: true,
      userId: true,
      text: true,
      sentAt: true,
      threadTs: true,
      isDeleted: true,
      reactions: true,
    },
    orderBy: { sentAt: 'asc' },
  });

  const candidates: WaitingCandidate[] = rows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    userId: row.userId,
    text: row.text,
    sentAt: row.sentAt,
    threadTs: row.threadTs,
    isDeleted: row.isDeleted,
    hasReactions: Array.isArray(row.reactions) && row.reactions.length > 0,
  }));

  const waiting = detectWaitingOn(candidates, {
    authedUserId: installation.authedUserId,
    now,
  });

  const waitingIds = new Set(waiting.map((result) => result.messageId));

  // Set the flag on everything currently waiting.
  for (const result of waiting) {
    await prisma.messageState.upsert({
      where: { messageId: result.messageId },
      create: {
        messageId: result.messageId,
        isWaitingOn: true,
        waitingOnSince: result.askedAt,
      },
      update: { isWaitingOn: true, waitingOnSince: result.askedAt },
    });
  }

  // And clear it everywhere it no longer holds — an ask that has since been
  // answered must stop being reported.
  const cleared = await prisma.messageState.updateMany({
    where: {
      isWaitingOn: true,
      messageId: { notIn: waitingIds.size > 0 ? [...waitingIds] : ['__none__'] },
    },
    data: { isWaitingOn: false, waitingOnSince: null },
  });

  const summary = {
    scannedMessages: candidates.length,
    windowDays: days,
    waitingOn: waiting.length,
    cleared: cleared.count,
    nudges: waiting.filter(
      (result) => stalenessOf(result.askedAt, now) === 'stale',
    ).length,
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(
    `Scanned ${summary.scannedMessages} message(s) from the last ${days} day(s).`,
  );
  console.log(
    `  waiting on a reply : ${summary.waitingOn}`,
  );
  console.log(`  no longer waiting  : ${summary.cleared}`);
  console.log(`  worth a nudge      : ${summary.nudges}`);

  if (waiting.length > 0) {
    console.log('');
    for (const result of waiting) {
      const staleness = stalenessOf(result.askedAt, now);
      console.log(
        `  ${staleness === 'stale' ? '!' : ' '} ${result.reason.padEnd(17)} ${describeWait(result.askedAt, now)}  ${result.messageId}`,
      );
    }
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
