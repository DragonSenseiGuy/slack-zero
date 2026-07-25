import OpenAI from 'openai';

import { getEnv, isLlmConfigured, requireLlmEnv } from '@/lib/env';

/**
 * The ONE place this app talks to an LLM.
 *
 * Provider: Hack Club AI (https://ai.hackclub.com), an OpenAI-compatible proxy.
 * This is a deliberate swap away from calling the Anthropic API directly —
 * user decision, 2026-07-24. Larger models are still reachable through the same
 * proxy, but the default is deliberately the small open-weight
 * `qwen/qwen3-32b`: classification is per-message and high-volume, so frontier
 * models are off the table for it. Only override `model` per-call if a task
 * demonstrably fails on the default, and flag it when you do.
 *
 * Everything else in the app must import from this module rather than reaching
 * for `openai` (or any other SDK) directly, so that swapping providers later is
 * a one-file change. The exported surface is intentionally narrow: `chat()`,
 * plus a reachability `ping()` for the health check.
 *
 * Server-side only — the API key must never reach the browser.
 */

if (typeof window !== 'undefined') {
  throw new Error(
    'src/lib/llm/client.ts is server-only and must not be imported from client components.',
  );
}

export type ChatRole = 'user' | 'assistant';

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatRequest = {
  /** System prompt. Kept separate from the turn list on purpose. */
  system?: string;
  messages: ChatMessage[];
  /** Defaults to LLM_MODEL from the environment. */
  model?: string;
  /** `'json'` asks the provider for a JSON object back. */
  responseFormat?: 'text' | 'json';
  temperature?: number;
  maxTokens?: number;
  /** Abort/timeouts from callers. */
  signal?: AbortSignal;
};

export type ChatResponse = {
  /** Assistant text. Empty string if the provider returned no content. */
  text: string;
  /** Model that actually served the request, as reported by the provider. */
  model: string;
  /** Provider's stop reason, e.g. `'stop'` or `'length'`. */
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

/** Thrown for provider-side failures so callers can distinguish them. */
export class LlmError extends Error {
  readonly status?: number;
  /** Hack Club AI allows 450 chat/embedding requests per 30 minutes. */
  readonly isRateLimit: boolean;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.isRateLimit = status === 429;
  }
}

let client: OpenAI | undefined;
let clientKey: string | undefined;

function getClient(): { openai: OpenAI; model: string } {
  const { baseUrl, apiKey, model } = requireLlmEnv();

  // Rebuild if the key/base changed (matters in tests more than at runtime).
  const cacheKey = `${baseUrl}::${apiKey}`;
  if (!client || clientKey !== cacheKey) {
    client = new OpenAI({ baseURL: baseUrl, apiKey });
    clientKey = cacheKey;
  }

  return { openai: client, model };
}

/** Test/dev helper: forget the memoized SDK instance. */
export function resetLlmClient(): void {
  client = undefined;
  clientKey = undefined;
}

/**
 * Single chat completion.
 *
 * @throws {LlmError} on provider errors (including 429 rate limiting).
 * @throws {EnvValidationError} when HACKCLUB_AI_API_KEY is unset.
 */
export async function chat(request: ChatRequest): Promise<ChatResponse> {
  const { openai, model: defaultModel } = getClient();

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (request.system) {
    messages.push({ role: 'system', content: request.system });
  }
  for (const message of request.messages) {
    messages.push({ role: message.role, content: message.content });
  }

  try {
    const completion = await openai.chat.completions.create(
      {
        model: request.model ?? defaultModel,
        messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        response_format:
          request.responseFormat === 'json'
            ? { type: 'json_object' }
            : undefined,
      },
      { signal: request.signal },
    );

    const choice = completion.choices[0];
    const text = choice?.message?.content ?? '';
    const finishReason = choice?.finish_reason;

    // Reasoning models (the default `qwen/qwen3-32b` included) spend part of
    // the max_tokens budget on hidden reasoning before emitting any content.
    // The proxy returns that separately (`message.reasoning`), so it never
    // pollutes `content` — but if the budget runs out during reasoning, the
    // provider replies with `content: null` and `finish_reason: 'length'`.
    // Failing loudly beats handing callers a silent empty string to parse.
    if (text === '' && finishReason === 'length') {
      throw new LlmError(
        'Hack Club AI returned no content: the response was truncated ' +
          '(finish_reason=length) before any text was emitted. Reasoning ' +
          'models consume max_tokens on hidden reasoning first — raise ' +
          `maxTokens (was ${request.maxTokens ?? 'unset'}).`,
      );
    }

    return {
      text,
      model: completion.model,
      finishReason,
      usage: completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          }
        : undefined,
    };
  } catch (error) {
    // Our own truncation error above is already well-formed; don't re-wrap it.
    if (error instanceof LlmError) {
      throw error;
    }
    if (error instanceof OpenAI.APIError) {
      throw new LlmError(
        `Hack Club AI request failed (${error.status ?? 'no status'}): ${error.message}`,
        error.status,
      );
    }
    throw new LlmError(
      `Hack Club AI request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export type LlmPingResult =
  | { status: 'ok'; model: string; modelCount?: number }
  | { status: 'not_configured' }
  | { status: 'error'; error: string };

/**
 * Cheap reachability check for the health endpoint.
 *
 * Hits `GET <base>/models`, which needs no auth and costs no tokens, so it
 * confirms the proxy is reachable without burning rate limit on completions.
 */
export async function ping(timeoutMs = 5_000): Promise<LlmPingResult> {
  const env = getEnv();

  if (!isLlmConfigured(env)) {
    return { status: 'not_configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${env.HACKCLUB_AI_BASE_URL}/models`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      return {
        status: 'error',
        error: `models endpoint returned HTTP ${response.status}`,
      };
    }

    const body: unknown = await response.json();
    const modelCount =
      typeof body === 'object' &&
      body !== null &&
      'data' in body &&
      Array.isArray((body as { data: unknown[] }).data)
        ? (body as { data: unknown[] }).data.length
        : undefined;

    return { status: 'ok', model: env.LLM_MODEL, modelCount };
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
