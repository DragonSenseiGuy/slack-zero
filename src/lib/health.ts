import { prisma } from '@/lib/db';
import { ping as pingLlm } from '@/lib/llm/client';
import { checkSlackAuth } from '@/lib/slack/api';

/**
 * Health checks for the three external dependencies.
 *
 * `not_configured` is a first-class, non-failing state: before the user has run
 * OAuth or added an LLM key, that is the correct answer and the app is still
 * "ok". Only a real failure (DB down, invalid token, proxy unreachable) flips
 * the overall `ok` to false.
 */

export type CheckStatus = 'ok' | 'not_configured' | 'error';

export type Check = {
  status: CheckStatus;
  /** Human-readable one-liner. Never contains secrets. */
  detail?: string;
  latencyMs?: number;
};

export type HealthReport = {
  ok: boolean;
  checkedAt: string;
  checks: {
    db: Check;
    slack: Check;
    llm: Check;
  };
};

export async function getHealth(): Promise<HealthReport> {
  const [db, slack, llm] = await Promise.all([
    checkDb(),
    checkSlack(),
    checkLlm(),
  ]);

  const checks = { db, slack, llm };
  const ok = Object.values(checks).every((check) => check.status !== 'error');

  return { ok, checkedAt: new Date().toISOString(), checks };
}

/**
 * The same report with every `detail` and timing dropped.
 *
 * `/api/health` has to stay reachable signed out — it is the container's
 * liveness probe — but the full report names the authenticated Slack user and
 * workspace and echoes raw database errors. An anonymous caller gets the
 * statuses and nothing else.
 */
export function redactHealth(report: HealthReport): HealthReport {
  const strip = (check: Check): Check => ({ status: check.status });

  return {
    ok: report.ok,
    checkedAt: report.checkedAt,
    checks: {
      db: strip(report.checks.db),
      slack: strip(report.checks.slack),
      llm: strip(report.checks.llm),
    },
  };
}

async function checkDb(): Promise<Check> {
  const startedAt = Date.now();
  try {
    // A real round-trip, not just "is the client constructed".
    await prisma.$queryRaw`SELECT 1`;
    return {
      status: 'ok',
      detail: 'connected',
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    };
  }
}

async function checkSlack(): Promise<Check> {
  const startedAt = Date.now();
  const result = await checkSlackAuth();
  const latencyMs = Date.now() - startedAt;

  switch (result.status) {
    case 'ok':
      return {
        status: 'ok',
        detail: `authenticated as ${result.userId} in ${result.teamName}`,
        latencyMs,
      };
    case 'not_configured':
      return {
        status: 'not_configured',
        detail: 'no Slack installation stored yet — connect Slack to finish setup',
      };
    default:
      return { status: 'error', detail: result.error, latencyMs };
  }
}

async function checkLlm(): Promise<Check> {
  const startedAt = Date.now();
  const result = await pingLlm();
  const latencyMs = Date.now() - startedAt;

  switch (result.status) {
    case 'ok':
      return {
        status: 'ok',
        detail:
          `Hack Club AI reachable; default model ${result.model}` +
          (result.modelCount ? ` (${result.modelCount} models available)` : ''),
        latencyMs,
      };
    case 'not_configured':
      return {
        status: 'not_configured',
        detail: 'HACKCLUB_AI_API_KEY is not set',
      };
    default:
      return { status: 'error', detail: result.error, latencyMs };
  }
}
