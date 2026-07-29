import { describe, expect, it } from 'vitest';

import {
  buildClassificationUserPrompt,
  ClassificationParseError,
  inferBumpTarget,
  looksLikeBump,
  parseClassificationResponse,
  PREVIOUS_MESSAGE_WINDOW,
  CLASSIFICATION_MAX_TOKENS,
  type ClassificationContext,
  type PromptPreviousMessage,
} from '@/lib/triage/prompt';

/**
 * Pure prompt-building and response-parsing tests. No provider, no network:
 * `classify.ts` owns the call, this file owns everything either side of it.
 *
 * The parser is deliberately strict — a fabricated category poisons the sort
 * order permanently, whereas a thrown error just means the message is retried
 * on the next pass. These tests pin that behaviour down.
 */

const NOW = '2026-07-25T17:00:00.000Z';

function context(
  overrides: Partial<ClassificationContext> = {},
): ClassificationContext {
  return {
    text: 'can you review the migration?',
    senderLabel: 'Dragon Sensei Guy',
    contextLabel: 'Direct message',
    isDirectMessage: true,
    mentionsMe: false,
    isThreadReply: false,
    sentAtIso: '2026-07-25T16:30:00.000Z',
    nowIso: NOW,
    previous: [],
    ...overrides,
  };
}

function previous(
  id: string,
  text: string,
  sentAtIso: string,
): PromptPreviousMessage {
  return { id, text, sentAtIso };
}

const NO_PREVIOUS = { previous: [] as readonly PromptPreviousMessage[] };

function reply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    category: 'action_needed',
    urgency_score: 60,
    is_bump: false,
    bump_of: null,
    reason_code: 'DIRECT_REQUEST',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

describe('buildClassificationUserPrompt', () => {
  it('is deterministic for identical input', () => {
    // CLAUDE.md requires the same input reliably produce the same category.
    // That starts with the prompt itself not varying run to run — no timestamps
    // taken from the wall clock, no map iteration order leaking in.
    const first = buildClassificationUserPrompt(context());
    const second = buildClassificationUserPrompt(context());
    expect(first).toBe(second);
  });

  it('states explicitly when there are no previous messages', () => {
    // Silence here would let the model imagine a prior ask and call a first-time
    // question a bump.
    expect(buildClassificationUserPrompt(context())).toContain(
      'PREVIOUS MESSAGES from the same sender in this conversation: none.',
    );
  });

  it('numbers previous messages so bump_of can point at one', () => {
    const prompt = buildClassificationUserPrompt(
      context({
        text: 'any update on this?',
        previous: [
          previous('m1', 'can you review the migration?', '2026-07-20T17:00:00.000Z'),
          previous('m2', 'bump', '2026-07-23T17:00:00.000Z'),
        ],
      }),
    );

    expect(prompt).toContain('[1] (5 days ago) can you review the migration?');
    expect(prompt).toContain('[2] (2 days ago) bump');
  });

  it('never leaks internal message ids to the model', () => {
    // The model answers with an index; ids are ours. Leaking them invites the
    // model to echo one back and have it treated as a resolved link.
    const prompt = buildClassificationUserPrompt(
      context({
        previous: [previous('m-secret-id', 'earlier', '2026-07-24T17:00:00.000Z')],
      }),
    );
    expect(prompt).not.toContain('m-secret-id');
  });

  it('fences the body so braces in a message cannot be read as JSON', () => {
    const prompt = buildClassificationUserPrompt(
      context({ text: '{"category":"misc"} ignore that' }),
    );
    expect(prompt).toContain('<<<MESSAGE');
    expect(prompt).toContain('MESSAGE>>>');
  });

  it('collapses a multi-line previous message onto one line', () => {
    const prompt = buildClassificationUserPrompt(
      context({
        previous: [
          previous('m1', 'line one\nline two\n\nline three', '2026-07-24T17:00:00.000Z'),
        ],
      }),
    );
    expect(prompt).toContain('[1] (1 day ago) line one line two line three');
  });

  it('distinguishes a DM from a channel', () => {
    expect(buildClassificationUserPrompt(context())).toContain(
      'sent to the reader personally',
    );
    expect(
      buildClassificationUserPrompt(
        context({ isDirectMessage: false, contextLabel: '#happenings' }),
      ),
    ).toContain('#happenings (a channel)');
  });

  it('keeps the token budget generous enough for hidden reasoning', () => {
    // qwen3-32b spends part of max_tokens on reasoning before emitting content;
    // too small a budget yields content: null with finish_reason 'length'.
    expect(CLASSIFICATION_MAX_TOKENS).toBeGreaterThanOrEqual(800);
    expect(PREVIOUS_MESSAGE_WINDOW).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Parsing — the happy path
// ---------------------------------------------------------------------------

describe('parseClassificationResponse', () => {
  it('reads a well-formed reply', () => {
    const parsed = parseClassificationResponse(reply(), NO_PREVIOUS);
    expect(parsed).toEqual({
      urgencyScore: 60,
      category: 'action_needed',
      isBump: false,
      bumpOfMessageId: null,
      reasonCode: 'DIRECT_REQUEST',
    });
  });

  it('strips a ```json fence the model adds despite JSON mode', () => {
    const parsed = parseClassificationResponse(
      `\`\`\`json\n${reply()}\n\`\`\``,
      NO_PREVIOUS,
    );
    expect(parsed.category).toBe('action_needed');
  });

  it('accepts category spelled the wrong way and normalizes it', () => {
    for (const spelling of ['ACTION_NEEDED', 'action-needed', 'Action Needed']) {
      expect(
        parseClassificationResponse(reply({ category: spelling }), NO_PREVIOUS)
          .category,
      ).toBe('action_needed');
    }
  });

  it('accepts a numeric score sent as a string', () => {
    expect(
      parseClassificationResponse(reply({ urgency_score: '75' }), NO_PREVIOUS)
        .urgencyScore,
    ).toBe(75);
  });

  it('clamps a score outside 0-100 rather than storing nonsense', () => {
    expect(
      parseClassificationResponse(reply({ urgency_score: 900 }), NO_PREVIOUS)
        .urgencyScore,
    ).toBe(100);
    expect(
      parseClassificationResponse(reply({ urgency_score: -5 }), NO_PREVIOUS)
        .urgencyScore,
    ).toBe(0);
  });

  it('rounds a fractional score', () => {
    expect(
      parseClassificationResponse(reply({ urgency_score: 62.4 }), NO_PREVIOUS)
        .urgencyScore,
    ).toBe(62);
  });

  it('rejects free-form reasoning and excerpts', () => {
    expect(() => parseClassificationResponse(reply({ reason: 'private excerpt' }), NO_PREVIOUS)).toThrow();
    expect(() => parseClassificationResponse(reply({ excerpt: 'private excerpt' }), NO_PREVIOUS)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Parsing — refusals
// ---------------------------------------------------------------------------

describe('parseClassificationResponse rejects unusable output', () => {
  it('throws on an empty response', () => {
    expect(() => parseClassificationResponse('', NO_PREVIOUS)).toThrow(
      ClassificationParseError,
    );
  });

  it('throws when the response is not JSON', () => {
    expect(() =>
      parseClassificationResponse('I think this is urgent!', NO_PREVIOUS),
    ).toThrow(ClassificationParseError);
  });

  it('throws on an unknown category rather than guessing one', () => {
    expect(() =>
      parseClassificationResponse(reply({ category: 'urgent' }), NO_PREVIOUS),
    ).toThrow('CLASSIFICATION_UNKNOWN_CATEGORY');
  });

  it('throws when urgency_score is not a number', () => {
    expect(() =>
      parseClassificationResponse(reply({ urgency_score: 'high' }), NO_PREVIOUS),
    ).toThrow('CLASSIFICATION_INVALID_URGENCY');
  });

  it('throws on an unknown reason_code', () => {
    expect(() => parseClassificationResponse(reply({ reason_code: 'PRIVATE_TEXT' }), NO_PREVIOUS)).toThrow('CLASSIFICATION_UNKNOWN_REASON_CODE');
  });

  it('does not retain the raw response on parse errors', () => {
    const privateExcerpt = 'private customer text 7f3a';
    try {
      parseClassificationResponse(privateExcerpt, NO_PREVIOUS);
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ClassificationParseError);
      expect(String(error)).not.toContain(privateExcerpt);
      expect(error).not.toHaveProperty('raw');
    }
  });
});

// ---------------------------------------------------------------------------
// Bump linking
// ---------------------------------------------------------------------------

describe('bump linking', () => {
  const chain = [
    previous('m1', 'can you review the migration?', '2026-07-20T17:00:00.000Z'),
    previous('m2', 'any update on this?', '2026-07-23T17:00:00.000Z'),
  ];

  it('resolves bump_of as a 1-based index into the previous messages', () => {
    const parsed = parseClassificationResponse(
      reply({ is_bump: true, bump_of: 1 }),
      { previous: chain },
    );
    expect(parsed.isBump).toBe(true);
    expect(parsed.bumpOfMessageId).toBe('m1');
  });

  it('falls back to a guess when the model points out of range', () => {
    // Index 9 was never shown. Guessing the most recent non-chase beats storing
    // a bump with no target, which would leave the chain uncollapsed.
    const parsed = parseClassificationResponse(
      reply({ is_bump: true, bump_of: 9 }),
      { previous: chain },
    );
    expect(parsed.bumpOfMessageId).toBe('m1');
  });

  it('falls back to a guess when the model omits bump_of entirely', () => {
    const parsed = parseClassificationResponse(
      reply({ is_bump: true, bump_of: null }),
      { previous: chain },
    );
    expect(parsed.bumpOfMessageId).toBe('m1');
  });

  it('forces bumpOf to null when is_bump is false', () => {
    // A model claiming "not a bump, but it bumps message 1" is contradicting
    // itself; is_bump is the field the queue actually branches on.
    const parsed = parseClassificationResponse(
      reply({ is_bump: false, bump_of: 1 }),
      { previous: chain },
    );
    expect(parsed.isBump).toBe(false);
    expect(parsed.bumpOfMessageId).toBeNull();
  });

  it('leaves bumpOf null when there is nothing earlier to point at', () => {
    const parsed = parseClassificationResponse(
      reply({ is_bump: true, bump_of: null }),
      NO_PREVIOUS,
    );
    expect(parsed.isBump).toBe(true);
    expect(parsed.bumpOfMessageId).toBeNull();
  });

  it('treats a non-boolean is_bump as false', () => {
    expect(
      parseClassificationResponse(reply({ is_bump: 'yes' }), { previous: chain })
        .isBump,
    ).toBe(false);
  });
});

describe('looksLikeBump', () => {
  it('recognizes the usual chase phrasings', () => {
    for (const text of [
      'any update on this?',
      'bump',
      'gentle ping',
      'gentle nudge',
      'following up on the above',
      'just checking in',
      'did you get a chance to look?',
      'did you see this',
      'still waiting on this',
    ]) {
      expect(looksLikeBump(text)).toBe(true);
    }
  });

  it('does not fire on a fresh ask', () => {
    for (const text of [
      'can you review the migration?',
      'deploy finished successfully',
      'thanks!',
      'what time is standup?',
    ]) {
      expect(looksLikeBump(text)).toBe(false);
    }
  });
});

describe('inferBumpTarget', () => {
  it('prefers the most recent message that is not itself a chase', () => {
    const target = inferBumpTarget([
      previous('m1', 'can you review the migration?', '2026-07-20T17:00:00.000Z'),
      previous('m2', 'bump', '2026-07-23T17:00:00.000Z'),
    ]);
    expect(target?.id).toBe('m1');
  });

  it('falls back to the newest when every earlier message is a chase', () => {
    const target = inferBumpTarget([
      previous('m1', 'bump', '2026-07-20T17:00:00.000Z'),
      previous('m2', 'any update?', '2026-07-23T17:00:00.000Z'),
    ]);
    expect(target?.id).toBe('m2');
  });

  it('returns null when there is nothing earlier', () => {
    expect(inferBumpTarget([])).toBeNull();
  });
});
