/**
 * Classification runner: `npm run classify`
 *
 * Classifies every ingested message that does not have a `Classification` row
 * yet, newest first. Safe to re-run and safe to interrupt: the stored row *is*
 * the checkpoint, so a second run picks up exactly where the first stopped.
 *
 * Deliberately a separate job from `npm run backfill`. CLAUDE.md requires that
 * classification never block ingestion, and a backfill that also had to make
 * one rate-limited LLM call per message would be exactly that.
 *
 * Model: whatever `LLM_MODEL` is, which defaults to `qwen/qwen3-32b` — a small
 * open-weight model, on purpose (user decision, 2026-07-24: no frontier models
 * for per-message work).
 *
 * Flags:
 *   --limit <n>        max messages this run (default 200)
 *   --concurrency <n>  in-flight calls (default 4)
 *   --dry-run          show what would be classified, make no LLM calls
 *   --json             print the summary object instead of a report
 */
import 'dotenv/config';

import { prisma } from '../src/lib/db';
import { getEnv, isLlmConfigured } from '../src/lib/env';
import {
  createRateLimiter,
  HACKCLUB_REQUEST_LIMIT,
  HACKCLUB_WINDOW_MS,
} from '../src/lib/llm/ratelimit';
import {
  classifyPendingMessages,
  selectPendingMessageIds,
  DEFAULT_BATCH_LIMIT,
  DEFAULT_CONCURRENCY,
} from '../src/lib/triage/pipeline';

type Args = {
  limit: number;
  concurrency: number;
  dryRun: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    limit: DEFAULT_BATCH_LIMIT,
    concurrency: DEFAULT_CONCURRENCY,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--limit':
        args.limit = Number(argv[++i]);
        break;
      case '--concurrency':
        args.concurrency = Number(argv[++i]);
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  if (!Number.isFinite(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive number');
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    throw new Error('--concurrency must be a positive number');
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!isLlmConfigured()) {
    throw new Error(
      'HACKCLUB_AI_API_KEY is not set — nothing to classify with. See .env.example.',
    );
  }

  if (args.dryRun) {
    const ids = await selectPendingMessageIds({ limit: args.limit });
    console.log(
      `${ids.length} message(s) would be classified with ${getEnv().LLM_MODEL}.`,
    );
    for (const id of ids) console.log(`  ${id}`);
    return;
  }

  const rateLimiter = createRateLimiter();

  const summary = await classifyPendingMessages({
    limit: args.limit,
    concurrency: args.concurrency,
    rateLimiter,
    onProgress: args.json
      ? undefined
      : (event) => {
          switch (event.kind) {
            case 'classified':
              console.log(
                `  ${event.messageId}  ${event.result.category.padEnd(13)} ` +
                  `${String(event.result.urgencyScore).padStart(3)}` +
                  `${event.result.isBump ? '  [bump]' : ''}  ${event.result.reasonCode}`,
              );
              break;
            case 'skipped':
              console.log(`  ${event.messageId}  skipped: ${event.reason}`);
              break;
            case 'failed':
              console.log(`  ${event.messageId}  FAILED: ${event.error}`);
              break;
          }
        },
  });

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('\nClassification complete.');
  console.log(`  model         ${getEnv().LLM_MODEL}`);
  console.log(`  attempted     ${summary.attempted}`);
  console.log(`  classified    ${summary.classified}`);
  console.log(`  skipped       ${summary.skipped}`);
  console.log(`  failed        ${summary.failed}`);
  console.log(
    `  requests      ${rateLimiter.used()} used, ${rateLimiter.remaining()} left in the ` +
      `${HACKCLUB_WINDOW_MS / 60_000}-minute / ${HACKCLUB_REQUEST_LIMIT}-request budget`,
  );

  if (summary.failures.length > 0) {
    console.log(`\n  ${summary.failures.length} failure(s):`);
    for (const failure of summary.failures) {
      console.log(`    ${failure.messageId}: ${failure.error}`);
    }
    console.log(
      '\n  These stay unclassified and will be retried on the next run.',
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
