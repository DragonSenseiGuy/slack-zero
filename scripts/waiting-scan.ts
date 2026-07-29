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
import { getSlackContext } from '../src/lib/slack/client';
import { scanWaitingWindow } from '../src/lib/waiting/scan';
import {
  detectWaitingOn,
  describeWait,
  stalenessOf,
  type WaitingCandidate,
} from '../src/lib/waiting/detect';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_WAITING_IDENTITY_ROWS = 10_000;

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  let slack;
  try {
    slack = await getSlackContext();
  } catch {
    console.error(
      'No Slack installation stored. Connect a workspace first (SLACK_APP_SETUP.md).',
    );
    process.exitCode = 1;
    return;
  }

  const days = arg('days', 30);
  const since = new Date(Date.now() - days * DAY_MS);
  const now = new Date();

  const loadedRows = await prisma.message.findMany({
    where: { sentAt: { gte: since } },
    select: {
      id: true,
      conversationId: true,
      userId: true,
      ts: true,
      sentAt: true,
      threadTs: true,
      isDeleted: true,
    },
    orderBy: { sentAt: 'asc' },
    take: MAX_WAITING_IDENTITY_ROWS + 1,
  });
  const identityTruncated = loadedRows.length > MAX_WAITING_IDENTITY_ROWS;
  const rows = loadedRows.slice(0, MAX_WAITING_IDENTITY_ROWS);

  const scan = await scanWaitingWindow(slack.client, rows, since);
  if (identityTruncated) {
    scan.complete = false;
    scan.errors.push('WAITING_IDENTITY_CAP_EXCEEDED');
  }
  const candidates: WaitingCandidate[] = scan.candidates;

  const waiting = detectWaitingOn(candidates, {
    authedUserId: slack.authedUserId,
    now,
  });

  const waitingIds = new Set(waiting.map((result) => result.messageId));

  let cleared = { count: 0 };
  if (scan.complete) await prisma.$transaction(async (tx) => {
    for (const result of waiting) {
      await tx.$queryRaw`SELECT id FROM "Message" WHERE id = ${result.messageId} FOR UPDATE`;
      const target = await tx.message.findUnique({ where: { id: result.messageId }, select: { isDeleted: true } });
      if (!target || target.isDeleted) continue;
      await tx.messageState.upsert({
        where: { messageId: result.messageId },
        create: {
          messageId: result.messageId,
          isWaitingOn: true,
          waitingOnSince: result.askedAt,
        },
        update: { isWaitingOn: true, waitingOnSince: result.askedAt },
      });
    }

    const scannedIds = candidates.map((candidate) => candidate.id);
    cleared = await tx.messageState.updateMany({
      where: {
        isWaitingOn: true,
        messageId: { in: scannedIds },
        NOT: { messageId: { in: waitingIds.size > 0 ? [...waitingIds] : ['__none__'] } },
      },
      data: { isWaitingOn: false, waitingOnSince: null },
    });
  });

  const summary = {
    scannedMessages: candidates.length,
    windowDays: days,
    waitingOn: waiting.length,
    cleared: cleared.count,
    complete: scan.complete,
    errors: scan.errors,
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
