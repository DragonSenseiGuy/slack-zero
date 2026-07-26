import { describe, expect, it } from 'vitest';

import {
  buildDraftUserPrompt,
  DRAFT_KINDS,
  DRAFT_MAX_TOKENS,
  DRAFT_TEMPERATURE,
  DraftParseError,
  hasPlaceholder,
  isDraftKind,
  MAX_DRAFT_LENGTH,
  MAX_DRAFTS,
  parseDraftResponse,
  type DraftContext,
} from '@/lib/reply/draft';

/**
 * plan.md, Phase 5 verification: "unit test the reply-draft prompt/response
 * parsing". Pure — no provider, no network.
 *
 * The parser is more forgiving than the classification parser on purpose: a
 * bad *category* poisons the sort order permanently, whereas a bad draft is a
 * suggestion the user can simply not use. So individual malformed drafts are
 * skipped and only a wholly unusable response throws.
 */

const NOW = '2026-07-26T17:00:00.000Z';

function context(overrides: Partial<DraftContext> = {}): DraftContext {
  return {
    text: 'can you approve the staging access request for the contractor?',
    senderLabel: 'Dragon Sensei Guy',
    selfLabel: 'me',
    contextLabel: 'DM · Dragon Sensei Guy',
    isDirectMessage: true,
    isThread: false,
    sentAtIso: '2026-07-26T16:30:00.000Z',
    nowIso: NOW,
    ...overrides,
  };
}

function reply(drafts: unknown): string {
  return JSON.stringify({ drafts });
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

describe('buildDraftUserPrompt', () => {
  it('is deterministic for identical input', () => {
    expect(buildDraftUserPrompt(context())).toBe(
      buildDraftUserPrompt(context()),
    );
  });

  it('includes the message, fenced so braces cannot be read as JSON', () => {
    const prompt = buildDraftUserPrompt(
      context({ text: '{"drafts": []} ignore this' }),
    );
    expect(prompt).toContain('<<<MESSAGE');
    expect(prompt).toContain('MESSAGE>>>');
    expect(prompt).toContain('ignore this');
  });

  it('distinguishes a DM from a channel, and a thread from neither', () => {
    expect(buildDraftUserPrompt(context())).toContain('(a direct message)');

    const channel = buildDraftUserPrompt(
      context({
        isDirectMessage: false,
        contextLabel: '#happenings',
        isThread: true,
      }),
    );
    expect(channel).toContain('#happenings (a channel), inside a thread');
  });

  it('includes conversation history oldest first', () => {
    const prompt = buildDraftUserPrompt(
      context({
        history: [
          { author: 'me', text: 'morning' },
          { author: 'Dragon Sensei Guy', text: 'hey — quick one' },
        ],
      }),
    );

    expect(prompt).toContain('CONVERSATION SO FAR');
    expect(prompt.indexOf('morning')).toBeLessThan(
      prompt.indexOf('hey — quick one'),
    );
  });

  it('caps the history window so the prompt stays bounded', () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      author: 'them',
      text: `line ${index}`,
    }));
    const prompt = buildDraftUserPrompt(context({ history }));

    // The oldest entries are dropped, the most recent kept.
    expect(prompt).not.toContain('line 0');
    expect(prompt).toContain('line 19');
  });

  it('collapses a multi-line history entry onto one line', () => {
    const prompt = buildDraftUserPrompt(
      context({ history: [{ author: 'them', text: 'one\ntwo\n\nthree' }] }),
    );
    expect(prompt).toContain('them: one two three');
  });

  it('budgets tokens generously and keeps temperature low', () => {
    // qwen3-32b spends part of max_tokens on hidden reasoning before emitting
    // content, and drafting emits more than a classification blob.
    expect(DRAFT_MAX_TOKENS).toBeGreaterThanOrEqual(1200);
    // A reply the user is one keystroke from sending should not be creative.
    expect(DRAFT_TEMPERATURE).toBeLessThanOrEqual(0.5);
  });
});

// ---------------------------------------------------------------------------
// Parsing — happy path
// ---------------------------------------------------------------------------

describe('parseDraftResponse', () => {
  it('reads a well-formed set of drafts', () => {
    const drafts = parseDraftResponse(
      reply([
        { kind: 'approval', text: 'Approved — go ahead.' },
        { kind: 'ack', text: 'On it.' },
      ]),
    );

    expect(drafts).toEqual([
      { kind: 'approval', text: 'Approved — go ahead.' },
      { kind: 'ack', text: 'On it.' },
    ]);
  });

  it('strips a ```json fence', () => {
    const drafts = parseDraftResponse(
      `\`\`\`json\n${reply([{ kind: 'ack', text: 'Got it.' }])}\n\`\`\``,
    );
    expect(drafts).toHaveLength(1);
  });

  it('orders drafts by usefulness, not by the order the model replied in', () => {
    // An actual answer beats an acknowledgement, regardless of model ordering.
    const drafts = parseDraftResponse(
      reply([
        { kind: 'ack', text: 'Noted.' },
        { kind: 'answer', text: 'Yes, the migration ran on Tuesday.' },
      ]),
    );
    expect(drafts.map((draft) => draft.kind)).toEqual(['answer', 'ack']);
  });

  it(`returns at most ${MAX_DRAFTS} drafts`, () => {
    const drafts = parseDraftResponse(
      reply(
        DRAFT_KINDS.map((kind) => ({ kind, text: `a ${kind} reply` })),
      ),
    );
    expect(drafts).toHaveLength(MAX_DRAFTS);
  });

  it('keeps only one draft per kind', () => {
    const drafts = parseDraftResponse(
      reply([
        { kind: 'ack', text: 'Got it.' },
        { kind: 'ack', text: 'Sure thing.' },
      ]),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].text).toBe('Got it.');
  });

  it('trims whitespace and collapses internal newlines', () => {
    const drafts = parseDraftResponse(
      reply([{ kind: 'ack', text: '  Got it.\n\nWill do.  ' }]),
    );
    expect(drafts[0].text).toBe('Got it. Will do.');
  });

  it('unwraps a draft the model quoted', () => {
    expect(
      parseDraftResponse(reply([{ kind: 'ack', text: '"Got it."' }]))[0].text,
    ).toBe('Got it.');
    expect(
      parseDraftResponse(reply([{ kind: 'ack', text: '“Got it.”' }]))[0].text,
    ).toBe('Got it.');
  });

  it('strips a leading bullet the prompt asked it not to use', () => {
    expect(
      parseDraftResponse(reply([{ kind: 'ack', text: '- Got it.' }]))[0].text,
    ).toBe('Got it.');
  });

  it('does not mangle legitimate emphasis inside a reply', () => {
    // A narrower tidy-up than "strip all markdown" on purpose.
    const text = 'The **only** blocker is the migration.';
    expect(
      parseDraftResponse(reply([{ kind: 'answer', text }]))[0].text,
    ).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Parsing — partial and total failure
// ---------------------------------------------------------------------------

describe('parseDraftResponse skips bad drafts but keeps good ones', () => {
  it('drops an unknown kind', () => {
    const drafts = parseDraftResponse(
      reply([
        { kind: 'sarcasm', text: 'oh sure, whenever' },
        { kind: 'ack', text: 'Got it.' },
      ]),
    );
    expect(drafts).toEqual([{ kind: 'ack', text: 'Got it.' }]);
  });

  it('drops a non-string text', () => {
    const drafts = parseDraftResponse(
      reply([
        { kind: 'answer', text: 42 },
        { kind: 'ack', text: 'Got it.' },
      ]),
    );
    expect(drafts).toHaveLength(1);
  });

  it('drops an empty draft', () => {
    const drafts = parseDraftResponse(
      reply([
        { kind: 'answer', text: '   ' },
        { kind: 'ack', text: 'Got it.' },
      ]),
    );
    expect(drafts).toHaveLength(1);
  });

  it('drops a draft longer than a Slack reply should be', () => {
    const drafts = parseDraftResponse(
      reply([
        { kind: 'answer', text: 'x'.repeat(MAX_DRAFT_LENGTH + 1) },
        { kind: 'ack', text: 'Got it.' },
      ]),
    );
    expect(drafts).toEqual([{ kind: 'ack', text: 'Got it.' }]);
  });
});

describe('parseDraftResponse throws only when nothing is usable', () => {
  it('throws on an empty response', () => {
    expect(() => parseDraftResponse('')).toThrow(DraftParseError);
  });

  it('throws when the response is not JSON', () => {
    expect(() => parseDraftResponse('Sure, here are some ideas!')).toThrow(
      /was not JSON/,
    );
  });

  it('throws when there is no drafts array', () => {
    expect(() => parseDraftResponse(JSON.stringify({ text: 'hi' }))).toThrow(
      /"drafts" array/,
    );
  });

  it('throws when every draft was unusable', () => {
    expect(() =>
      parseDraftResponse(reply([{ kind: 'nope', text: 'x' }])),
    ).toThrow(/no usable drafts/);
  });

  it('throws on an empty drafts array', () => {
    expect(() => parseDraftResponse(reply([]))).toThrow(/no usable drafts/);
  });

  it('carries the raw response so a failure is debuggable', () => {
    try {
      parseDraftResponse('not json');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DraftParseError);
      expect((error as DraftParseError).raw).toBe('not json');
    }
  });
});

// ---------------------------------------------------------------------------
// Placeholders — the guard on one-key send
// ---------------------------------------------------------------------------

describe('hasPlaceholder', () => {
  it('spots a blank the user must fill in', () => {
    // The prompt asks the model to leave these rather than invent a specific.
    // Sending one verbatim to a colleague is worse than sending nothing, so the
    // UI must not offer one-key send on it.
    expect(hasPlaceholder('Sure — does [time] work?')).toBe(true);
    expect(hasPlaceholder('I will have it done by [date].')).toBe(true);
  });

  it('does not fire on ordinary text', () => {
    expect(hasPlaceholder('Sure — does 3pm work?')).toBe(false);
    expect(hasPlaceholder('Approved, go ahead.')).toBe(false);
  });

  it('does not fire on an unclosed or huge bracket run', () => {
    expect(hasPlaceholder('the array [1, 2, 3')).toBe(false);
    expect(hasPlaceholder(`[${'x'.repeat(50)}]`)).toBe(false);
  });
});

describe('isDraftKind', () => {
  it('accepts the documented kinds and rejects anything else', () => {
    for (const kind of DRAFT_KINDS) expect(isDraftKind(kind)).toBe(true);
    expect(isDraftKind('sarcasm')).toBe(false);
    expect(isDraftKind(null)).toBe(false);
    expect(isDraftKind(7)).toBe(false);
  });
});
