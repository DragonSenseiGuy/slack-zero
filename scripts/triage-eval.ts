/**
 * Classification accuracy harness: `npm run triage:eval`
 *
 * Runs every hand-labeled fixture in `src/lib/triage/fixtures.ts` against the
 * live model and reports accuracy against the human labels.
 *
 * This is the *only* thing that makes live calls for evaluation.
 * `fixtures.test.ts` scores the `recorded` replies committed alongside each
 * fixture, so `npm run test` stays offline (CLAUDE.md: unit tests must not
 * depend on live API calls). Use this script when the prompt or the model
 * changes, then paste the refreshed recordings back into the fixtures.
 *
 * Model: `LLM_MODEL`, default `qwen/qwen3-32b`. Small and open-weight on
 * purpose (user decision, 2026-07-24: no frontier models for per-message work).
 * One call per fixture — 20 calls against a 450-per-30-minutes budget.
 *
 * Flags:
 *   --json      print the raw recordings, ready to paste into fixtures.ts
 *   --only <id> evaluate a single fixture
 */
import 'dotenv/config';

import { getEnv, isLlmConfigured } from '../src/lib/env';
import { chat } from '../src/lib/llm/client';
import { createRateLimiter, withRateLimitRetry } from '../src/lib/llm/ratelimit';
import { LABELED_MESSAGES, type LabeledMessage } from '../src/lib/triage/fixtures';
import {
  buildClassificationUserPrompt,
  CLASSIFICATION_MAX_TOKENS,
  CLASSIFICATION_SYSTEM_PROMPT,
  parseClassificationResponse,
} from '../src/lib/triage/prompt';

type Row = {
  fixture: LabeledMessage;
  raw: string | null;
  error: string | null;
  category: string | null;
  urgencyScore: number | null;
  isBump: boolean | null;
  reason: string | null;
  categoryOk: boolean;
  urgencyOk: boolean;
  bumpOk: boolean;
};

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function evaluate(
  fixture: LabeledMessage,
  limiter: ReturnType<typeof createRateLimiter>,
): Promise<Row> {
  const base: Row = {
    fixture,
    raw: null,
    error: null,
    category: null,
    urgencyScore: null,
    isBump: null,
    reason: null,
    categoryOk: false,
    urgencyOk: false,
    bumpOk: false,
  };

  try {
    const response = await withRateLimitRetry(async () => {
      await limiter.acquire();
      return chat({
        system: CLASSIFICATION_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: buildClassificationUserPrompt(fixture.context) },
        ],
        temperature: 0,
        responseFormat: 'json',
        maxTokens: CLASSIFICATION_MAX_TOKENS,
      });
    });

    const parsed = parseClassificationResponse(response.text, {
      previous: fixture.context.previous,
    });

    const [min, max] = fixture.expected.urgency;

    return {
      ...base,
      raw: response.text,
      category: parsed.category,
      urgencyScore: parsed.urgencyScore,
      isBump: parsed.isBump,
      reason: parsed.reason,
      categoryOk: parsed.category === fixture.expected.category,
      urgencyOk: parsed.urgencyScore >= min && parsed.urgencyScore <= max,
      bumpOk: parsed.isBump === fixture.expected.isBump,
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  if (!isLlmConfigured()) {
    console.error(
      'No LLM key configured. Set HACKCLUB_AI_API_KEY in .env (see .env.example).',
    );
    process.exitCode = 1;
    return;
  }

  const only = arg('only');
  const fixtures = only
    ? LABELED_MESSAGES.filter((fixture) => fixture.id === only)
    : LABELED_MESSAGES;

  if (fixtures.length === 0) {
    console.error(`No fixture matched --only ${only}`);
    process.exitCode = 1;
    return;
  }

  const model = getEnv().LLM_MODEL;
  console.error(`Evaluating ${fixtures.length} fixture(s) against ${model}...`);

  const limiter = createRateLimiter();
  const rows: Row[] = [];

  // Serial on purpose: 20 calls is not worth the rate-limit risk of a pool, and
  // serial output stays readable as it streams.
  for (const fixture of fixtures) {
    const row = await evaluate(fixture, limiter);
    rows.push(row);
    const mark = row.error
      ? 'ERR '
      : row.categoryOk && row.urgencyOk && row.bumpOk
        ? 'ok  '
        : 'MISS';
    console.error(
      `  ${mark} ${row.fixture.id}${row.error ? ` — ${row.error}` : ` — ${row.category} @ ${row.urgencyScore}`}`,
    );
  }

  if (process.argv.includes('--json')) {
    // Shaped for pasting straight back into fixtures.ts.
    console.log(
      JSON.stringify(
        rows.map((row) => ({ id: row.fixture.id, recorded: row.raw })),
        null,
        2,
      ),
    );
    return;
  }

  const strict = rows.filter((row) => row.fixture.ambiguous !== true);
  const pct = (key: 'categoryOk' | 'urgencyOk' | 'bumpOk') => {
    const hits = strict.filter((row) => row[key]).length;
    return `${hits}/${strict.length} (${((hits / strict.length) * 100).toFixed(0)}%)`;
  };

  const lines = [
    '',
    `model: ${model}`,
    `fixtures: ${rows.length} (${strict.length} unambiguous)`,
    `category : ${pct('categoryOk')}`,
    `urgency  : ${pct('urgencyOk')}`,
    `is_bump  : ${pct('bumpOk')}`,
  ];

  const misses = strict.filter(
    (row) => row.error || !row.categoryOk || !row.urgencyOk || !row.bumpOk,
  );
  if (misses.length > 0) {
    lines.push('', 'misses on the unambiguous set:');
    for (const row of misses) {
      lines.push(
        row.error
          ? `  ${row.fixture.id}: ERROR ${row.error}`
          : `  ${row.fixture.id}: expected ${row.fixture.expected.category} ${row.fixture.expected.urgency.join('-')} bump=${row.fixture.expected.isBump}, got ${row.category} ${row.urgencyScore} bump=${row.isBump}`,
      );
    }
  }

  const ambiguous = rows.filter((row) => row.fixture.ambiguous === true);
  if (ambiguous.length > 0) {
    lines.push('', 'ambiguous (reported, not scored):');
    for (const row of ambiguous) {
      lines.push(
        `  ${row.fixture.id}: expected ${row.fixture.expected.category}, got ${row.category} @ ${row.urgencyScore}`,
      );
    }
  }

  lines.push('', 'Re-run with --json to refresh the recordings in fixtures.ts.');
  console.log(lines.join('\n'));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
