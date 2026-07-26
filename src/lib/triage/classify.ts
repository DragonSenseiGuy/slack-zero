import { chat } from '@/lib/llm/client';
import {
  buildClassificationUserPrompt,
  CLASSIFICATION_MAX_TOKENS,
  CLASSIFICATION_SYSTEM_PROMPT,
  parseClassificationResponse,
  type ClassificationContext,
  type ParsedClassification,
} from '@/lib/triage/prompt';

/**
 * One classification call.
 *
 * This is the only file in the triage engine that talks to a provider, and it
 * does so through `lib/llm/client.ts` — nothing here imports `openai`
 * (CLAUDE.md: keeping the provider swappable in one file is the whole point).
 *
 * The model is the environment default, `qwen/qwen3-32b`: a small open-weight
 * model, chosen because classification is per-message and high-volume. Using a
 * frontier model here is an explicit user decision *against* (2026-07-24), so
 * this function never overrides `model` and the caller cannot pass one either.
 * If the small model demonstrably fails on some task, that is a finding to
 * raise, not a parameter to change quietly.
 */

export type ClassificationResult = ParsedClassification & {
  /** The model the provider actually served, as reported back. */
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
};

export type ClassifyOptions = {
  signal?: AbortSignal;
};

export async function classifyMessage(
  context: ClassificationContext,
  options: ClassifyOptions = {},
): Promise<ClassificationResult> {
  const response = await chat({
    system: CLASSIFICATION_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: buildClassificationUserPrompt(context) },
    ],
    // Determinism is a stated requirement: the same message must not flip
    // category between runs (CLAUDE.md).
    temperature: 0,
    responseFormat: 'json',
    maxTokens: CLASSIFICATION_MAX_TOKENS,
    signal: options.signal,
  });

  const parsed = parseClassificationResponse(response.text, context);

  return {
    ...parsed,
    model: response.model,
    usage: response.usage,
  };
}
