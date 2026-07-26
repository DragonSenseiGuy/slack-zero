import { chat } from '@/lib/llm/client';
import {
  buildDraftUserPrompt,
  DRAFT_MAX_TOKENS,
  DRAFT_SYSTEM_PROMPT,
  DRAFT_TEMPERATURE,
  parseDraftResponse,
  type DraftContext,
  type ReplyDraft,
} from '@/lib/reply/draft';

/**
 * One reply-drafting call.
 *
 * Like `triage/classify.ts`, this is the only file in the reply feature that
 * talks to a provider, and it does so through `lib/llm/client.ts` — nothing here
 * imports `openai` (CLAUDE.md).
 *
 * No `model` is ever passed, so `LLM_MODEL` stays the single control point and
 * drafting cannot quietly end up on a frontier model.
 */

export type GenerateDraftsResult = {
  drafts: ReplyDraft[];
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
};

export async function generateDrafts(
  context: DraftContext,
  options: { signal?: AbortSignal } = {},
): Promise<GenerateDraftsResult> {
  const response = await chat({
    system: DRAFT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildDraftUserPrompt(context) }],
    temperature: DRAFT_TEMPERATURE,
    responseFormat: 'json',
    maxTokens: DRAFT_MAX_TOKENS,
    signal: options.signal,
  });

  return {
    drafts: parseDraftResponse(response.text),
    model: response.model,
    usage: response.usage,
  };
}
