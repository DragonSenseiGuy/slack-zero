import { z } from 'zod';

/**
 * Typed, validated environment access.
 *
 * Design notes:
 * - Only `DATABASE_URL` is genuinely required to boot. Slack and LLM
 *   credentials are optional so the app can start, render "Connect Slack",
 *   and report `not_configured` from /api/health before anything is set up.
 * - Groups that *are* needed for a specific operation (the OAuth flow, an LLM
 *   call) are validated at the point of use via `requireSlackEnv()` /
 *   `requireLlmEnv()`, which throw one clear message naming the missing vars.
 * - Server-side only. Nothing here is prefixed `NEXT_PUBLIC_`, so none of it
 *   can reach the browser bundle.
 */

/** Treat `FOO=""` in a .env file the same as "not set". */
const optionalString = z
  .preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  )
  .optional();

/** Same, but with a fallback when unset/blank. */
function optionalStringWithDefault(fallback: string) {
  return z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().default(fallback),
  );
}

const envSchema = z.object({
  // --- Required -------------------------------------------------------
  DATABASE_URL: z
    .string({ message: 'is required (Postgres connection string)' })
    .min(1, 'is required (Postgres connection string)'),

  // --- Slack (optional until the app is set up) ------------------------
  SLACK_CLIENT_ID: optionalString,
  SLACK_CLIENT_SECRET: optionalString,
  SLACK_SIGNING_SECRET: optionalString,
  SLACK_APP_TOKEN: optionalString,
  SLACK_STATE_SECRET: optionalString,
  SLACK_REDIRECT_URI: optionalStringWithDefault(
    'https://localhost:3000/api/slack/oauth/callback',
  ),
  APP_BASE_URL: optionalStringWithDefault('https://localhost:3000'),

  // --- LLM: Hack Club AI (OpenAI-compatible proxy) ---------------------
  HACKCLUB_AI_BASE_URL: optionalStringWithDefault(
    'https://ai.hackclub.com/proxy/v1',
  ),
  HACKCLUB_AI_API_KEY: optionalString,
  // Small open-weight model on purpose: classification is per-message and
  // high-volume, and the default must never silently be a frontier model
  // (user decision, 2026-07-24). Matches .env.example and SLACK_APP_SETUP.md.
  LLM_MODEL: optionalStringWithDefault('qwen/qwen3-32b'),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validate an arbitrary environment-shaped object. Exported so tests can feed
 * it fixtures instead of mutating `process.env`.
 *
 * @throws {EnvValidationError} with every problem listed, one per line.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'} ${issue.message}`)
      .join('\n');
    throw new EnvValidationError(
      `Invalid environment configuration:\n${details}\n\n` +
        'Copy .env.example to .env and fill in the missing values.',
    );
  }

  return result.data;
}

let cached: Env | undefined;

/** Validated environment, parsed once per process. */
export function getEnv(): Env {
  if (!cached) {
    cached = parseEnv(process.env);
  }
  return cached;
}

/** Test helper: drop the memoized value so the next getEnv() re-reads. */
export function resetEnvCache(): void {
  cached = undefined;
}

// ---------------------------------------------------------------------------
// Feature-group helpers
// ---------------------------------------------------------------------------

/** Slack values needed to run the OAuth flow. */
export type SlackOAuthEnv = {
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  redirectUri: string;
  appBaseUrl: string;
};

const SLACK_OAUTH_VARS = [
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_STATE_SECRET',
] as const;

/** True when the Slack OAuth flow has everything it needs. */
export function isSlackConfigured(env: Env = getEnv()): boolean {
  return SLACK_OAUTH_VARS.every((key) => Boolean(env[key]));
}

/**
 * @throws {EnvValidationError} naming exactly which Slack vars are missing.
 */
export function requireSlackEnv(env: Env = getEnv()): SlackOAuthEnv {
  const missing = SLACK_OAUTH_VARS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new EnvValidationError(
      `Slack is not configured. Missing: ${missing.join(', ')}.\n` +
        'See SLACK_APP_SETUP.md for where to get these values.',
    );
  }
  return {
    clientId: env.SLACK_CLIENT_ID as string,
    clientSecret: env.SLACK_CLIENT_SECRET as string,
    stateSecret: env.SLACK_STATE_SECRET as string,
    redirectUri: env.SLACK_REDIRECT_URI,
    appBaseUrl: env.APP_BASE_URL,
  };
}

/** Values needed to talk to the Hack Club AI proxy. */
export type LlmEnv = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

/** True when an LLM API key is present. */
export function isLlmConfigured(env: Env = getEnv()): boolean {
  return Boolean(env.HACKCLUB_AI_API_KEY);
}

/**
 * @throws {EnvValidationError} when no LLM key is set.
 */
export function requireLlmEnv(env: Env = getEnv()): LlmEnv {
  if (!env.HACKCLUB_AI_API_KEY) {
    throw new EnvValidationError(
      'LLM is not configured. Missing: HACKCLUB_AI_API_KEY.\n' +
        'Create a key at https://ai.hackclub.com (note: 18 and under only).',
    );
  }
  return {
    baseUrl: env.HACKCLUB_AI_BASE_URL,
    apiKey: env.HACKCLUB_AI_API_KEY,
    model: env.LLM_MODEL,
  };
}
