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
