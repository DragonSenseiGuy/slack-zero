import { z } from 'zod';

import { describeAge } from '@/lib/queue/time';

/**
 * Reply-draft prompt and response parsing (plan.md, Phase 5).
 *
 * Pure, like `triage/prompt.ts`: this file decides *what* to ask and *how* to
 * read the answer, and `generate.ts` makes the call. That split is what makes
 * plan.md's "unit test the reply-draft prompt/response parsing" possible with no
 * live provider (CLAUDE.md forbids unit tests that hit the API).
 *
 * The model is the environment default `qwen/qwen3-32b` — drafting is
 * per-message work, so the 2026-07-24 no-frontier-models decision applies here
 * exactly as it does to classification.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The reply patterns plan.md names, plus `answer` as the catch-all.
 *
 * These are *labels for suggestions*, not a classification of the incoming
 * message — the model proposes up to one draft per pattern that actually fits,
 * so a message asking to book a meeting yields `scheduling` and probably `ack`,
 * but not `approval`.
 */
export const DRAFT_KINDS = [
  'ack',
  'answer',
  'scheduling',
  'approval',
  'decline',
] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export function isDraftKind(value: unknown): value is DraftKind {
  return (
    typeof value === 'string' && (DRAFT_KINDS as readonly string[]).includes(value)
  );
}

export const DRAFT_KIND_LABEL: Record<DraftKind, string> = {
  ack: 'Acknowledge',
  answer: 'Answer',
  scheduling: 'Scheduling',
  approval: 'Approve',
  decline: 'Decline',
};

/** Stable order for rendering, independent of the order the model replied in. */
const KIND_RANK: Record<DraftKind, number> = {
  answer: 0,
  approval: 1,
  scheduling: 2,
  ack: 3,
  decline: 4,
};

export type ReplyDraft = {
  kind: DraftKind;
  /** The reply text, ready to send as-is. */
  text: string;
};

/** How many drafts to offer. More than three is a menu, not a suggestion. */
export const MAX_DRAFTS = 3;

/**
 * Generous, for the same reason as classification: `qwen/qwen3-32b` is a
 * reasoning model whose hidden reasoning spends the `max_tokens` budget before
 * any content is emitted. Drafting produces more output than a classification
 * JSON blob, so this is larger still.
 *
 * Measured, not guessed: at 1600 the "blocked colleague" case in
 * `npm run draft:eval` failed outright with `finish_reason: 'length'` and zero
 * content — the model spent the whole budget reasoning. That happened *because*
 * the system prompt was tightened to stop it inventing specifics: more rules to
 * weigh means more reasoning. Anyone editing the prompt should re-run
 * `npm run draft:eval` and expect to move this number with it.
 */
export const DRAFT_MAX_TOKENS = 3000;

/**
 * Drafting is the one place a little variation is fine — three suggestions that
 * are near-identical are useless. Still low: a reply the user is one keystroke
 * from sending should not be a creative risk.
 */
export const DRAFT_TEMPERATURE = 0.3;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type DraftContext = {
  /** The message being replied to, already rendered to plain text. */
  text: string;
  senderLabel: string;
  /** How the user should be referred to in the third person, if needed. */
  selfLabel: string;
  contextLabel: string;
  isDirectMessage: boolean;
  isThread: boolean;
  sentAtIso: string;
  nowIso: string;
  /** Recent conversation, oldest first, for tone and continuity. */
  history?: readonly { author: string; text: string }[];
};

export const HISTORY_WINDOW = 6;

export const DRAFT_SYSTEM_PROMPT = `You draft short Slack replies on behalf of the reader. You are given one message and you reply with one JSON object and nothing else.

Reply with exactly this shape:
{"drafts": [{"kind": "ack" | "answer" | "scheduling" | "approval" | "decline", "text": "<the reply>"}]}

Offer between 1 and 3 drafts. Only include a kind that genuinely fits the
message — do not pad the list. Order does not matter.

KINDS:
- "ack": acknowledge receipt or agree, committing to nothing specific.
- "answer": actually answer the question asked, when the answer is evident from
  the message or the conversation history. If you would have to invent a fact,
  do not offer this kind.
- "scheduling": propose or confirm a time, when the message is about meeting.
- "approval": grant what was asked, when the message requests approval.
- "decline": say no, or not now, politely.

RULES FOR THE TEXT:
- Write as the reader, in first person. Never write "the reader".
- One or two sentences. Slack, not email: no greeting line, no sign-off.
- Match the informality of the incoming message.

- NEVER CLAIM SOMETHING IS ALREADY DONE. The reader has not acted yet — they are
  reading the message right now. Write what they *will* do, not what they did.
  Wrong: "Approved the access request." / "Fixed it." / "I've sent it over."
  Right: "Approving that now." / "I'll take a look." / "Sending it over."
  This applies to "approval" most of all: approve as an intention, never as a
  completed act.

- NEVER INVENT A SPECIFIC. No times, dates, numbers, names, links, prices or
  status claims unless they appear in the message or the history above. If a
  natural reply needs a detail you were not given, write a bracketed blank for
  the reader to fill in: [time], [date], [name].
  Wrong: "How about 10am tomorrow?" when no time was mentioned.
  Right: "Tomorrow works — how about [time]?"

- Do not commit the reader to a deadline the message did not propose.
- Plain text. No markdown, no bullet points, no quoting the original.`;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function buildDraftUserPrompt(context: DraftContext): string {
  const lines: string[] = [];

  if (context.history && context.history.length > 0) {
    lines.push('CONVERSATION SO FAR, oldest first:');
    for (const entry of context.history.slice(-HISTORY_WINDOW)) {
      lines.push(`  ${entry.author}: ${collapse(entry.text)}`);
    }
    lines.push('');
  }

  lines.push('MESSAGE TO REPLY TO');
  lines.push(
    `Where: ${context.contextLabel}${
      context.isDirectMessage ? ' (a direct message)' : ' (a channel)'
    }${context.isThread ? ', inside a thread' : ''}`,
  );
  lines.push(`From: ${context.senderLabel}`);
  lines.push(`You are: ${context.selfLabel}`);
  lines.push(`Sent: ${describeAge(context.sentAtIso, context.nowIso)} ago`);
  lines.push('Text:');
  lines.push('<<<MESSAGE');
  lines.push(context.text);
  lines.push('MESSAGE>>>');
  lines.push('');
  lines.push('Reply with the JSON object only.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export class DraftParseError extends Error {
  readonly raw: string;

  constructor(message: string, raw: string) {
    super(message);
    this.name = 'DraftParseError';
    this.raw = raw;
  }
}

function stripFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

const responseSchema = z.object({
  drafts: z.array(z.object({ kind: z.unknown(), text: z.unknown() })),
});

/** Longer than this is not a Slack reply, and would not fit the compose box. */
export const MAX_DRAFT_LENGTH = 600;

/**
 * Strip markdown the prompt asked the model not to use.
 *
 * Kept deliberately narrow — leading bullets and surrounding quotes, which are
 * the two things the model actually does. Anything more aggressive would start
 * mangling legitimate reply text like "the **only** blocker".
 */
function tidy(text: string): string {
  let out = text.trim();
  out = out.replace(/^\s*[-*•]\s+/, '');
  // A whole-string wrap in matching quotes: the model quoting its own draft.
  if (
    (out.startsWith('"') && out.endsWith('"') && out.length > 1) ||
    (out.startsWith('“') && out.endsWith('”'))
  ) {
    out = out.slice(1, -1).trim();
  }
  return collapse(out);
}

/**
 * Read a model response into a list of drafts.
 *
 * Skips individual malformed drafts rather than throwing the whole set away — if
 * two of three are usable, offering two beats offering none. Throws only when
 * nothing usable survives, which is a real failure the caller should surface.
 */
export function parseDraftResponse(raw: string): ReplyDraft[] {
  const body = stripFence(raw);

  if (body === '') throw new DraftParseError('empty response', raw);

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    throw new DraftParseError(
      `response was not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      raw,
    );
  }

  const shape = responseSchema.safeParse(json);
  if (!shape.success) {
    throw new DraftParseError(
      'response was not an object with a "drafts" array',
      raw,
    );
  }

  const drafts: ReplyDraft[] = [];
  const seenKinds = new Set<DraftKind>();

  for (const candidate of shape.data.drafts) {
    if (!isDraftKind(candidate.kind)) continue;
    if (typeof candidate.text !== 'string') continue;

    const text = tidy(candidate.text);
    if (text === '') continue;
    if (text.length > MAX_DRAFT_LENGTH) continue;
    // One draft per kind: two "ack"s are the same suggestion twice.
    if (seenKinds.has(candidate.kind)) continue;

    seenKinds.add(candidate.kind);
    drafts.push({ kind: candidate.kind, text });
  }

  if (drafts.length === 0) {
    throw new DraftParseError('no usable drafts in the response', raw);
  }

  return drafts
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])
    .slice(0, MAX_DRAFTS);
}

/**
 * Does a draft still contain a blank the user must fill in?
 *
 * The prompt asks the model to leave `[time]`-style placeholders rather than
 * invent specifics. Sending one of those verbatim to a colleague would be worse
 * than sending nothing, so the UI must not offer one-key send on it.
 */
export function hasPlaceholder(text: string): boolean {
  return /\[[^\]\n]{1,40}\]/.test(text);
}
