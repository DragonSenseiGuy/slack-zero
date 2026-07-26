import { describe, expect, it } from 'vitest';

import {
  LABELED_MESSAGES,
  STRICT_FIXTURES,
  type LabeledMessage,
} from '@/lib/triage/fixtures';
import { parseClassificationResponse } from '@/lib/triage/prompt';

/**
 * Classification accuracy against the hand-labeled set
 * (plan.md, Phase 3 verification: "unit tests with a fixed set of sample
 * messages (hand-labeled expected category/urgency) — track classification
 * accuracy against this labeled set").
 *
 * These score **real** `qwen/qwen3-32b` replies, captured live and committed as
 * `recorded` on each fixture, without touching the network — CLAUDE.md forbids
 * unit tests that depend on live API calls. `npm run triage:eval` refreshes the
 * recordings; if accuracy moves after a prompt or model change, the diff names
 * exactly which messages changed their mind.
 *
 * What is asserted, and why the two differ:
 *  - **category** exactly. CLAUDE.md: "category should not flip-flop".
 *  - **urgency** as a range. CLAUDE.md allows tolerance on the score.
 *
 * The two `ambiguous: true` fixtures are scored and reported but excluded from
 * the pass/fail threshold. Counting a case where reasonable humans disagree as a
 * model failure would make the accuracy number misleading in the other
 * direction.
 */

type Scored = {
  fixture: LabeledMessage;
  categoryOk: boolean;
  urgencyOk: boolean;
  bumpOk: boolean;
  actual: {
    category: string;
    urgencyScore: number;
    isBump: boolean;
    reason: string;
  };
};

function score(fixture: LabeledMessage): Scored {
  if (!fixture.recorded) {
    throw new Error(
      `fixture ${fixture.id} has no recorded reply — run npm run triage:eval`,
    );
  }

  const parsed = parseClassificationResponse(fixture.recorded, {
    previous: fixture.context.previous,
  });

  const [min, max] = fixture.expected.urgency;

  return {
    fixture,
    categoryOk: parsed.category === fixture.expected.category,
    urgencyOk: parsed.urgencyScore >= min && parsed.urgencyScore <= max,
    bumpOk: parsed.isBump === fixture.expected.isBump,
    actual: {
      category: parsed.category,
      urgencyScore: parsed.urgencyScore,
      isBump: parsed.isBump,
      reason: parsed.reason,
    },
  };
}

const scored = LABELED_MESSAGES.map(score);
const strict = scored.filter((row) => row.fixture.ambiguous !== true);

function rate(rows: Scored[], key: 'categoryOk' | 'urgencyOk' | 'bumpOk') {
  const hits = rows.filter((row) => row[key]).length;
  return { hits, total: rows.length, pct: (hits / rows.length) * 100 };
}

describe('the labeled set itself', () => {
  it('is big enough and every case has a live recording', () => {
    expect(LABELED_MESSAGES.length).toBeGreaterThanOrEqual(20);
    for (const fixture of LABELED_MESSAGES) {
      expect(fixture.recorded, `${fixture.id} missing a recording`).toBeTruthy();
    }
  });

  it('covers all three categories and both bump outcomes', () => {
    const categories = new Set(
      LABELED_MESSAGES.map((fixture) => fixture.expected.category),
    );
    expect([...categories].sort()).toEqual(['action_needed', 'fyi', 'misc']);
    expect(
      LABELED_MESSAGES.some((fixture) => fixture.expected.isBump),
    ).toBe(true);
    expect(
      LABELED_MESSAGES.some((fixture) => !fixture.expected.isBump),
    ).toBe(true);
  });

  it('has unique ids', () => {
    const ids = LABELED_MESSAGES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exposes the unambiguous subset used for the threshold', () => {
    expect(STRICT_FIXTURES.length).toBeLessThan(LABELED_MESSAGES.length);
    expect(STRICT_FIXTURES.every((f) => f.ambiguous !== true)).toBe(true);
  });
});

describe('every recorded reply is parseable', () => {
  // A model that stops producing readable JSON is a regression regardless of
  // whether it happens to guess the right category.
  it.each(LABELED_MESSAGES.map((f) => [f.id, f] as const))(
    'parses %s',
    (_id, fixture) => {
      expect(() =>
        parseClassificationResponse(fixture.recorded as string, {
          previous: fixture.context.previous,
        }),
      ).not.toThrow();
    },
  );

  it('always produces a non-empty reason', () => {
    // CLAUDE.md requires reasoning be stored with every score. A blank one would
    // have thrown in the parser, but assert it explicitly: this is the property
    // that makes the sort arguable rather than a black box.
    for (const row of scored) {
      expect(row.actual.reason.length, row.fixture.id).toBeGreaterThan(0);
    }
  });

  it('gives concrete reasons, not generic filler', () => {
    const filler = /^(seems|looks|probably|maybe)\b/i;
    for (const row of scored) {
      expect(filler.test(row.actual.reason), row.fixture.id).toBe(false);
    }
  });
});

describe('classification accuracy on the unambiguous set', () => {
  it('gets the category right at least 90% of the time', () => {
    const result = rate(strict, 'categoryOk');
    const misses = strict
      .filter((row) => !row.categoryOk)
      .map(
        (row) =>
          `${row.fixture.id}: expected ${row.fixture.expected.category}, got ${row.actual.category} ("${row.actual.reason}")`,
      );

    expect(
      result.pct,
      `category accuracy ${result.hits}/${result.total}\n${misses.join('\n')}`,
    ).toBeGreaterThanOrEqual(90);
  });

  /**
   * Urgency is gated with a tolerance, deliberately.
   *
   * Measured over three full live runs of the same 20 fixtures at
   * `temperature: 0`, categories and `is_bump` were identical every time but
   * urgency moved by up to 20 points (`prod-outage` 70/85/90,
   * `bump-gentle-ping` 50/70/70). So a tight band asserts the model's *noise*,
   * not its judgement — the exact-band figure swung between 61% and 100% across
   * runs without the prompt or model changing.
   *
   * CLAUDE.md anticipates exactly this: "urgency score can have some tolerance,
   * category should not flip-flop". The exact-band rate is still tracked and
   * printed by the report below; this is the assertion that means something.
   */
  const URGENCY_TOLERANCE = 15;

  it(`lands urgency within ${URGENCY_TOLERANCE} points of the expected band`, () => {
    const offBy = (row: Scored): number => {
      const [min, max] = row.fixture.expected.urgency;
      const score = row.actual.urgencyScore;
      if (score < min) return min - score;
      if (score > max) return score - max;
      return 0;
    };

    const outside = strict
      .filter((row) => offBy(row) > URGENCY_TOLERANCE)
      .map(
        (row) =>
          `${row.fixture.id}: expected ${row.fixture.expected.urgency.join('-')}, got ${row.actual.urgencyScore} (off by ${offBy(row)})`,
      );

    expect(outside).toEqual([]);
  });

  it('keeps the urgency ordering that the sort actually depends on', () => {
    // Absolute calibration drifts; the ordering is what decides what the user
    // sees first, and it held across every run.
    const scoreOf = (id: string): number => {
      const row = scored.find((each) => each.fixture.id === id);
      if (!row) throw new Error(`missing fixture ${id}`);
      return row.actual.urgencyScore;
    };

    expect(scoreOf('prod-outage')).toBeGreaterThan(scoreOf('announcement'));
    expect(scoreOf('review-with-deadline')).toBeGreaterThan(scoreOf('banter'));
    expect(scoreOf('blocked-colleague')).toBeGreaterThan(scoreOf('status-update'));
    expect(scoreOf('approval')).toBeGreaterThan(scoreOf('greeting'));
  });

  it('detects bumps correctly on every unambiguous case', () => {
    // Bump detection is a yes/no on explicit phrasing, not a judgement call, so
    // the bar here is higher than for urgency.
    const misses = strict
      .filter((row) => !row.bumpOk)
      .map(
        (row) =>
          `${row.fixture.id}: expected isBump=${row.fixture.expected.isBump}, got ${row.actual.isBump}`,
      );
    expect(misses).toEqual([]);
  });

  it('never scores a misc message as high urgency', () => {
    // The specific failure this guards: pattern-matching the word "urgent" in
    // social chatter and shoving banter to the top of the queue.
    for (const row of scored) {
      if (row.actual.category !== 'misc') continue;
      expect(row.actual.urgencyScore, row.fixture.id).toBeLessThan(40);
    }
  });

  it('scores a production outage above a thank-you', () => {
    // An ordering sanity check that does not depend on absolute calibration.
    const outage = scored.find((row) => row.fixture.id === 'prod-outage');
    const thanks = scored.find((row) => row.fixture.id === 'thanks');
    if (!outage || !thanks) throw new Error('expected both fixtures to exist');
    expect(outage.actual.urgencyScore).toBeGreaterThan(
      thanks.actual.urgencyScore,
    );
  });
});

describe('accuracy report', () => {
  // Not an assertion — plan.md asks for accuracy to be *tracked*, so the numbers
  // are printed on every run and the ambiguous cases are named rather than
  // silently folded into a single percentage.
  it('prints the numbers', () => {
    const lines = [
      '',
      `labeled fixtures: ${LABELED_MESSAGES.length} (${strict.length} unambiguous, ${LABELED_MESSAGES.length - strict.length} ambiguous)`,
      `category      : ${rate(strict, 'categoryOk').hits}/${strict.length} (${rate(strict, 'categoryOk').pct.toFixed(0)}%)  [gated at 90%]`,
      `urgency exact : ${rate(strict, 'urgencyOk').hits}/${strict.length} (${rate(strict, 'urgencyOk').pct.toFixed(0)}%)  [tracked only — noisy, see note above]`,
      `is_bump       : ${rate(strict, 'bumpOk').hits}/${strict.length} (${rate(strict, 'bumpOk').pct.toFixed(0)}%)  [gated at 100%]`,
    ];

    const ambiguous = scored.filter((row) => row.fixture.ambiguous === true);
    if (ambiguous.length > 0) {
      lines.push('ambiguous (excluded from thresholds):');
      for (const row of ambiguous) {
        lines.push(
          `  ${row.fixture.id}: expected ${row.fixture.expected.category}, model said ${row.actual.category} @ ${row.actual.urgencyScore}`,
        );
      }
    }

    const misses = strict.filter((row) => !row.categoryOk || !row.urgencyOk);
    if (misses.length > 0) {
      lines.push('misses:');
      for (const row of misses) {
        lines.push(
          `  ${row.fixture.id}: expected ${row.fixture.expected.category} ${row.fixture.expected.urgency.join('-')}, got ${row.actual.category} ${row.actual.urgencyScore}`,
        );
      }
    }

    // eslint-disable-next-line no-console -- the report is the point of this test
    console.info(lines.join('\n'));
    expect(scored).toHaveLength(LABELED_MESSAGES.length);
  });
});
