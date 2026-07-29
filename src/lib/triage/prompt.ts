import { z } from 'zod';

import { describeAge } from '@/lib/queue/time';
import {
  clampUrgency,
  isTriageCategory,
  type TriageCategory,
} from '@/lib/triage/types';

/**
 * The classification prompt and its response parser.
 *
 * Pure on purpose. `classify.ts` does the network call; everything that decides
 * *what* to ask and *how* to read the answer lives here so it can be unit
 * tested against fixtures with no live provider (CLAUDE.md, "Unit test pure
 * logic ... with fixture data").
 *
 * Determinism is a requirement, not a nicety (CLAUDE.md: "same input should
 * reliably produce the same category"). Three things buy it:
 *  - the rubric is an ordered decision procedure, not a vibe;
 *  - the caller sends `temperature: 0` and JSON mode;
 *  - nothing in the prompt varies run to run except the message and the
 *    explicit `now` the caller passes in.
 */

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type PromptPreviousMessage = {
  /** Our internal message id. Never shown to the model — indices are. */
  id: string;
  text: string;
  sentAtIso: string;
};

export type ClassificationContext = {
  text: string;
  senderLabel: string;
  /** "#general", "DM · Ada", "Group DM" — the same label the queue row shows. */
  contextLabel: string;
  isDirectMessage: boolean;
  /** True when the message @-mentions the person being triaged. */
  mentionsMe: boolean;
  isThreadReply: boolean;
  sentAtIso: string;
  /** Explicit clock, so a fixture test is reproducible. */
  nowIso: string;
  /** Optimistic concurrency token; never included in the model prompt. */
  sourceUpdatedAtIso?: string;
  /**
   * Earlier messages from the same sender in the same conversation/thread,
   * oldest first. This is the only thing that makes bump detection possible:
   * "any update on this?" is only a bump relative to something.
   */
  previous: readonly PromptPreviousMessage[];
};

/** How many earlier messages to show. Four is enough to spot a chase and small
 * enough to keep the prompt (and therefore the token bill) bounded. */
export const PREVIOUS_MESSAGE_WINDOW = 4;

/**
 * Generous by design. `qwen/qwen3-32b` is a reasoning model and the proxy
 * spends part of `max_tokens` on hidden reasoning before emitting any content;
 * too small a budget returns `content: null` with `finish_reason: 'length'`
 * (see the note in `llm/client.ts`). Reasoning alone cost ~94 tokens on a
 * trivial prompt, and this prompt is far from trivial.
 */
export const CLASSIFICATION_MAX_TOKENS = 1200;

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export const CLASSIFICATION_SYSTEM_PROMPT = `You triage Slack messages for one person ("the reader"). You are given a single message and you reply with one JSON object and nothing else.

Reply with exactly these keys:
{"category": "action_needed" | "misc" | "fyi", "urgency_score": <integer 0-100>, "is_bump": <true|false>, "bump_of": <integer or null>, "reason_code": "DIRECT_REQUEST" | "QUESTION" | "APPROVAL_NEEDED" | "BLOCKED" | "DEADLINE" | "INCIDENT" | "FOLLOW_UP" | "INFORMATIONAL" | "AUTOMATED_NOTICE" | "SOCIAL" | "OTHER"}

CATEGORY — apply these rules in order and stop at the first one that matches:
1. The message asks the reader a question, requests something of them, needs a
   decision or approval from them, or says they are blocking someone
   -> "action_needed".
2. The message conveys information the reader should know but requires nothing
   from them: announcements, status/deploy/build notices, alerts, shared links,
   FYIs, someone reporting what they did -> "fyi".
3. Anything else — greetings, thanks, banter, reactions, one-word replies,
   small talk -> "misc".
A message with neither an ask nor information is "misc", never "fyi".
A question aimed at the channel in general, not the reader, is still
"action_needed" only if the reader is the one who can answer it; otherwise
"fyi".

URGENCY_SCORE — how soon the reader must look, 0-100:
  0-19    no time pressure: banter, thanks, background noise
  20-39   can wait days: no date, nobody blocked
  40-59   should be handled today
  60-79   within a couple of hours: someone is waiting or blocked
  80-100  immediately: production is broken, a hard deadline is imminent, or
          an explicit urgent/ASAP request from someone who is stuck
Raise the score for deadlines, outages, blockers and explicit urgency.
Keep it low for automated noise and social chatter. "misc" is rarely above 20.
Score the content, not the sender's seniority.

IS_BUMP — true only when this message chases an EARLIER unanswered message:
"any update on this?", "bump", "gentle ping", "did you get a chance?",
"following up on the above". A first-time ask is never a bump. A new question
that merely happens to follow other messages is not a bump.
When is_bump is true and one of the numbered PREVIOUS MESSAGES is the original
ask, set "bump_of" to that number. Otherwise set "bump_of" to null.
When is_bump is false, "bump_of" must be null.

REASON_CODE — choose exactly one of the closed values above. Never quote or
summarize message content.`;

function describeChannel(context: ClassificationContext): string {
  if (context.isDirectMessage) {
    return `${context.contextLabel} (a direct message — sent to the reader personally)`;
  }
  return `${context.contextLabel} (a channel)`;
}

/** Fenced so a message containing braces or quotes cannot be read as JSON. */
function quoteBody(text: string): string {
  return ['<<<MESSAGE', text, 'MESSAGE>>>'].join('\n');
}

export function buildClassificationUserPrompt(
  context: ClassificationContext,
): string {
  const lines: string[] = [];

  if (context.previous.length > 0) {
    lines.push(
      'PREVIOUS MESSAGES from the same sender in this conversation, oldest first:',
    );
    context.previous.forEach((previous, index) => {
      const age = describeAge(previous.sentAtIso, context.nowIso);
      lines.push(
        `[${index + 1}] (${age} ago) ${collapse(previous.text)}`,
      );
    });
  } else {
    lines.push(
      'PREVIOUS MESSAGES from the same sender in this conversation: none.',
    );
  }

  lines.push('');
  lines.push('MESSAGE TO CLASSIFY');
  lines.push(`Where: ${describeChannel(context)}`);
  lines.push(`From: ${context.senderLabel}`);
  lines.push(`Sent: ${describeAge(context.sentAtIso, context.nowIso)} ago`);
  lines.push(`Directly @-mentions the reader: ${context.mentionsMe ? 'yes' : 'no'}`);
  lines.push(`Is a reply inside a thread: ${context.isThreadReply ? 'yes' : 'no'}`);
  lines.push('Text:');
  lines.push(quoteBody(context.text));
  lines.push('');
  lines.push('Reply with the JSON object only.');

  return lines.join('\n');
}

/** Keep a previous message to one line so the numbered list stays parseable. */
function collapse(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 240 ? `${flat.slice(0, 237)}...` : flat;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export class ClassificationParseError extends Error {
  constructor(message: string, raw?: string) {
    super(message);
    void raw;
    this.name = 'ClassificationParseError';
  }
}

export type ParsedClassification = {
  urgencyScore: number;
  category: TriageCategory;
  isBump: boolean;
  bumpOfMessageId: string | null;
  reasonCode: ClassificationReasonCode;
};

export const CLASSIFICATION_REASON_CODES = ['DIRECT_REQUEST','QUESTION','APPROVAL_NEEDED','BLOCKED','DEADLINE','INCIDENT','FOLLOW_UP','INFORMATIONAL','AUTOMATED_NOTICE','SOCIAL','OTHER'] as const;
export type ClassificationReasonCode = (typeof CLASSIFICATION_REASON_CODES)[number];

/**
 * The model is asked for JSON mode, but a stray ```json fence still turns up
 * often enough that refusing to strip one would mean throwing away good
 * answers.
 */
function stripFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

/** Accept `ACTION_NEEDED`, `action-needed`, `Action Needed` — reject the rest. */
function normalizeCategory(value: unknown): TriageCategory | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return isTriageCategory(normalized) ? normalized : null;
}

const responseSchema = z.object({
  category: z.unknown(),
  urgency_score: z.unknown(),
  is_bump: z.unknown().optional(),
  bump_of: z.unknown().optional(),
  reason_code: z.unknown(),
}).strict();

/**
 * Phrases that make a message a chase rather than a fresh ask. Used only as a
 * *fallback linker* — never to override the model's `is_bump` — when the model
 * says "this is a bump" but does not say which message it bumps.
 */
const BUMP_PHRASES =
  /\b(any update|bump|gentle (ping|nudge)|following up|follow(-| )?up|checking in|did you (get a chance|see)|still waiting|ping)\b/i;

export function looksLikeBump(text: string): boolean {
  return BUMP_PHRASES.test(text);
}

/**
 * Pick the earlier message a bump most likely refers to, when the model did not
 * name one. The most recent earlier message that is not itself a chase is the
 * best guess; chains are then walked back to their root by `resolveBumpRoot`,
 * so guessing one link short still lands on the original ask.
 */
export function inferBumpTarget(
  previous: readonly PromptPreviousMessage[],
): PromptPreviousMessage | null {
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    if (!looksLikeBump(previous[index].text)) return previous[index];
  }
  return previous.length > 0 ? previous[previous.length - 1] : null;
}

/**
 * Read one model response into a stored classification.
 *
 * Throws rather than guessing. A message left unclassified is retried on the
 * next pass; a message stored with a fabricated category quietly poisons the
 * sort order forever. `reason` in particular is mandatory — CLAUDE.md requires
 * it be stored alongside the score, so a response without one is not usable.
 */
export function parseClassificationResponse(
  raw: string,
  context: Pick<ClassificationContext, 'previous'>,
): ParsedClassification {
  const body = stripFence(raw);

  if (body === '') {
    throw new ClassificationParseError('CLASSIFICATION_EMPTY_RESPONSE');
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ClassificationParseError('CLASSIFICATION_INVALID_JSON');
  }

  const shape = responseSchema.safeParse(json);
  if (!shape.success) {
    throw new ClassificationParseError(
      'response was not a JSON object with the expected keys',
      raw,
    );
  }

  const category = normalizeCategory(shape.data.category);
  if (category === null) {
    throw new ClassificationParseError(
      'CLASSIFICATION_UNKNOWN_CATEGORY',
    );
  }

  const scoreValue =
    typeof shape.data.urgency_score === 'string'
      ? Number(shape.data.urgency_score)
      : shape.data.urgency_score;
  if (typeof scoreValue !== 'number' || !Number.isFinite(scoreValue)) {
    throw new ClassificationParseError(
      'CLASSIFICATION_INVALID_URGENCY',
    );
  }

  const reasonCode = shape.data.reason_code;
  if (typeof reasonCode !== 'string' || !(CLASSIFICATION_REASON_CODES as readonly string[]).includes(reasonCode)) {
    throw new ClassificationParseError(
      'CLASSIFICATION_UNKNOWN_REASON_CODE',
    );
  }

  const isBump = shape.data.is_bump === true;

  let bumpOfMessageId: string | null = null;
  if (isBump) {
    const index =
      typeof shape.data.bump_of === 'string'
        ? Number(shape.data.bump_of)
        : shape.data.bump_of;

    if (typeof index === 'number' && Number.isInteger(index)) {
      // 1-based, as the prompt numbers them. Out of range means the model
      // pointed at something we did not show it — fall through to the guess.
      const candidate = context.previous[index - 1];
      if (candidate) bumpOfMessageId = candidate.id;
    }

    if (bumpOfMessageId === null) {
      bumpOfMessageId = inferBumpTarget(context.previous)?.id ?? null;
    }
  }

  return {
    urgencyScore: clampUrgency(scoreValue),
    category,
    isBump,
    bumpOfMessageId,
    reasonCode: reasonCode as ClassificationReasonCode,
  };
}
