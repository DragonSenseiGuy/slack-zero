import OpenAI from 'openai';

import { getEnv, isLlmConfigured, requireLlmEnv } from '@/lib/env';
import { noStoreFetch } from '@/lib/http/no-store';

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
  system?: string;
  messages: ChatMessage[];
  model?: string;
  responseFormat?: 'text' | 'json';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type ChatResponse = {
  text: string;
  model: string;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

export class LlmError extends Error {
  readonly status?: number;
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

  const cacheKey = `${baseUrl}::${apiKey}`;
  if (!client || clientKey !== cacheKey) {
    client = new OpenAI({ baseURL: baseUrl, apiKey, fetch: noStoreFetch });
    clientKey = cacheKey;
  }

  return { openai: client, model };
}

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
