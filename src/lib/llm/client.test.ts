import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the LLM client wrapper. The provider SDK is mocked — per
 * CLAUDE.md these must never hit the live Hack Club AI proxy.
 *
 * The truncation case is the one worth pinning down: the default model
 * (`qwen/qwen3-32b`) is a reasoning model, and the proxy returns its hidden
 * reasoning in a separate `message.reasoning` field. That keeps `content` clean
 * of `<think>` blocks, but reasoning still spends the `max_tokens` budget — so a
 * too-small budget yields `content: null` with `finish_reason: 'length'`.
 */

const create = vi.fn();

vi.mock('openai', () => {
  // Mirrors the real constructor signature: (status, error, message, headers).
  class APIError extends Error {
    status?: number;
    constructor(status?: number, _error?: unknown, message?: string) {
      super(message);
      this.status = status;
    }
  }

  class OpenAI {
    chat = { completions: { create } };
    static APIError = APIError;
  }

  return { default: OpenAI, APIError };
});

function completion(
  message: { content: string | null; reasoning?: string },
  finishReason: string,
) {
  return {
    model: 'qwen/qwen3-32b',
    choices: [{ index: 0, finish_reason: finishReason, message }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

describe('chat', () => {
  beforeEach(async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5433/slackzero';
    process.env.HACKCLUB_AI_API_KEY = 'test-key';
    process.env.HACKCLUB_AI_BASE_URL = 'https://ai.hackclub.com/proxy/v1';
    process.env.LLM_MODEL = 'qwen/qwen3-32b';

    const { resetEnvCache } = await import('@/lib/env');
    const { resetLlmClient } = await import('@/lib/llm/client');
    resetEnvCache();
    resetLlmClient();
  });

  afterEach(() => {
    create.mockReset();
  });

  it('returns the assistant text, model and finish reason', async () => {
    const { chat } = await import('@/lib/llm/client');
    create.mockResolvedValue(completion({ content: 'hello' }, 'stop'));

    const result = await chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.text).toBe('hello');
    expect(result.model).toBe('qwen/qwen3-32b');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
  });

  it('puts the system prompt ahead of the turns and defaults the model', async () => {
    const { chat } = await import('@/lib/llm/client');
    create.mockResolvedValue(completion({ content: 'ok' }, 'stop'));

    await chat({
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const [body] = create.mock.calls[0];
    expect(body.model).toBe('qwen/qwen3-32b');
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('asks for a JSON object when responseFormat is json', async () => {
    const { chat } = await import('@/lib/llm/client');
    create.mockResolvedValue(completion({ content: '{}' }, 'stop'));

    await chat({
      messages: [{ role: 'user', content: 'hi' }],
      responseFormat: 'json',
    });

    expect(create.mock.calls[0][0].response_format).toEqual({
      type: 'json_object',
    });
  });

  it('throws rather than returning an empty string when truncated mid-reasoning', async () => {
    const { chat, LlmError } = await import('@/lib/llm/client');
    create.mockResolvedValue(
      completion({ content: null, reasoning: 'thinking...' }, 'length'),
    );

    await expect(
      chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 40 }),
    ).rejects.toThrow(LlmError);

    await expect(
      chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 40 }),
    ).rejects.toThrow(/finish_reason=length/);
  });

  it('still returns partial text when truncated after some content', async () => {
    const { chat } = await import('@/lib/llm/client');
    create.mockResolvedValue(completion({ content: 'partial' }, 'length'));

    const result = await chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.text).toBe('partial');
    expect(result.finishReason).toBe('length');
  });

  it('flags a 429 as a rate limit so callers can back off', async () => {
    const { chat, LlmError } = await import('@/lib/llm/client');
    const { APIError } = await import('openai');
    create.mockRejectedValue(new APIError(429, undefined, 'slow down', undefined));

    try {
      await chat({ messages: [{ role: 'user', content: 'hi' }] });
      expect.unreachable('expected an LlmError');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as InstanceType<typeof LlmError>).isRateLimit).toBe(true);
      expect((error as InstanceType<typeof LlmError>).status).toBe(429);
    }
  });
});
