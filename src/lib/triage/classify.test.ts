import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the single classification call.
 *
 * `chat()` is mocked: CLAUDE.md forbids unit tests that hit the live proxy, and
 * the point here is the *request* this function builds, not the model's answer.
 * Live model behaviour is covered by `fixtures.test.ts` (recorded replies) and
 * `npm run triage:eval` (actual calls).
 */

const chat = vi.fn();

vi.mock('@/lib/llm/client', () => ({
  chat: (...args: unknown[]) => chat(...args),
}));

const { classifyMessage } = await import('@/lib/triage/classify');
const { CLASSIFICATION_SYSTEM_PROMPT, CLASSIFICATION_MAX_TOKENS } =
  await import('@/lib/triage/prompt');

import type { ClassificationContext } from '@/lib/triage/prompt';

function context(
  overrides: Partial<ClassificationContext> = {},
): ClassificationContext {
  return {
    text: 'can you approve the staging request?',
    senderLabel: 'Dragon Sensei Guy',
    contextLabel: 'Direct message',
    isDirectMessage: true,
    mentionsMe: false,
    isThreadReply: false,
    sentAtIso: '2026-07-25T16:30:00.000Z',
    nowIso: '2026-07-25T17:00:00.000Z',
    previous: [],
    ...overrides,
  };
}

const GOOD_REPLY = JSON.stringify({
  category: 'action_needed',
  urgency_score: 55,
  is_bump: false,
  bump_of: null,
  reason_code: 'APPROVAL_NEEDED',
});

function respond(text: string, model = 'qwen/qwen3-32b') {
  chat.mockResolvedValue({
    text,
    model,
    finishReason: 'stop',
    usage: { promptTokens: 300, completionTokens: 120, totalTokens: 420 },
  });
}

beforeEach(() => {
  chat.mockReset();
});

describe('classifyMessage', () => {
  it('returns the parsed classification with the model that served it', async () => {
    respond(GOOD_REPLY);

    const result = await classifyMessage(context());

    expect(result.category).toBe('action_needed');
    expect(result.urgencyScore).toBe(55);
    expect(result.isBump).toBe(false);
    expect(result.reasonCode).toBe('APPROVAL_NEEDED');
    // Recording the served model means a model change is visible in the data
    // rather than silently rewriting the meaning of stored scores.
    expect(result.model).toBe('qwen/qwen3-32b');
    expect(result.usage?.totalTokens).toBe(420);
  });

  it('asks for temperature 0 and JSON mode, for determinism', async () => {
    respond(GOOD_REPLY);
    await classifyMessage(context());

    const request = chat.mock.calls[0][0];
    expect(request.temperature).toBe(0);
    expect(request.responseFormat).toBe('json');
  });

  it('never pins a model, so LLM_MODEL stays the single control point', async () => {
    // The user's decision (2026-07-24) is that per-message work uses a small
    // open-weight model. Hard-coding any model here — or accepting one from a
    // caller — is how that decision gets quietly undone.
    respond(GOOD_REPLY);
    await classifyMessage(context());

    expect(chat.mock.calls[0][0].model).toBeUndefined();
  });

  it('budgets max_tokens generously for hidden reasoning', async () => {
    // qwen3-32b spends part of the budget reasoning before emitting content; too
    // small a budget returns content: null with finish_reason 'length'.
    respond(GOOD_REPLY);
    await classifyMessage(context());

    expect(chat.mock.calls[0][0].maxTokens).toBe(CLASSIFICATION_MAX_TOKENS);
    expect(CLASSIFICATION_MAX_TOKENS).toBeGreaterThanOrEqual(800);
  });

  it('sends the shared system prompt and the built user prompt', async () => {
    respond(GOOD_REPLY);
    await classifyMessage(context({ text: 'ping about the migration' }));

    const request = chat.mock.calls[0][0];
    expect(request.system).toBe(CLASSIFICATION_SYSTEM_PROMPT);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].role).toBe('user');
    expect(request.messages[0].content).toContain('ping about the migration');
  });

  it('passes an abort signal through', async () => {
    respond(GOOD_REPLY);
    const controller = new AbortController();
    await classifyMessage(context(), { signal: controller.signal });

    expect(chat.mock.calls[0][0].signal).toBe(controller.signal);
  });

  it('resolves a bump against the previous messages it was shown', async () => {
    respond(
      JSON.stringify({
        category: 'action_needed',
        urgency_score: 60,
        is_bump: true,
        bump_of: 1,
        reason_code: 'FOLLOW_UP',
      }),
    );

    const result = await classifyMessage(
      context({
        text: 'any update on this?',
        previous: [
          {
            id: 'm-original',
            text: 'can you approve the staging request?',
            sentAtIso: '2026-07-22T17:00:00.000Z',
          },
        ],
      }),
    );

    expect(result.isBump).toBe(true);
    expect(result.bumpOfMessageId).toBe('m-original');
  });

  it('propagates a parse failure rather than inventing a classification', async () => {
    // A stored-but-wrong category poisons the sort order permanently; a thrown
    // error just means this message is retried on the next pass.
    respond('the model felt chatty today');

    await expect(classifyMessage(context())).rejects.toThrow(
      'CLASSIFICATION_INVALID_JSON',
    );
  });

  it('propagates a truncated-response error from the client', async () => {
    chat.mockRejectedValue(
      new Error("llm response was truncated (finish_reason: 'length')"),
    );

    await expect(classifyMessage(context())).rejects.toThrow(/truncated/);
  });
});
