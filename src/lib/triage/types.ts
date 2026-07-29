/**
 * The vocabulary of the triage engine (plan.md, Phase 3).
 *
 * Deliberately dependency-free: no Prisma, no LLM client, no DOM. The queue UI
 * imports this from a client component, the pipeline imports it on the server,
 * and both agree on what a category and an urgency score mean. Anything that
 * needs the provider SDK lives in `classify.ts`, which is server-only.
 *
 * Category strings are lower_snake here because that is what the model is asked
 * to emit and what plan.md names. Prisma's enum is SCREAMING_SNAKE; the two
 * mappings below are the only place that difference is allowed to exist.
 */

export type TriageCategory = 'action_needed' | 'misc' | 'fyi';

export const TRIAGE_CATEGORIES: readonly TriageCategory[] = [
  'action_needed',
  'misc',
  'fyi',
] as const;

export function isTriageCategory(value: unknown): value is TriageCategory {
  return (
    typeof value === 'string' &&
    (TRIAGE_CATEGORIES as readonly string[]).includes(value)
  );
}

/** DB enum values, spelled out rather than imported so this stays Prisma-free. */
export type DbMessageCategory = 'ACTION_NEEDED' | 'MISC' | 'FYI';

const TO_DB: Record<TriageCategory, DbMessageCategory> = {
  action_needed: 'ACTION_NEEDED',
  misc: 'MISC',
  fyi: 'FYI',
};

const FROM_DB: Record<DbMessageCategory, TriageCategory> = {
  ACTION_NEEDED: 'action_needed',
  MISC: 'misc',
  FYI: 'fyi',
};

export function toDbCategory(category: TriageCategory): DbMessageCategory {
  return TO_DB[category];
}

export function fromDbCategory(category: DbMessageCategory): TriageCategory {
  return FROM_DB[category];
}

/**
 * Sort precedence when two messages score the same. Action beats FYI beats
 * misc: if the model could not separate them by urgency, "you have to do
 * something about this" should still be the one you see first.
 */
const CATEGORY_RANK: Record<TriageCategory, number> = {
  action_needed: 0,
  fyi: 1,
  misc: 2,
};

export function categoryRank(category: TriageCategory): number {
  return CATEGORY_RANK[category];
}

export const CATEGORY_LABEL: Record<TriageCategory, string> = {
  action_needed: 'Action',
  misc: 'Misc',
  fyi: 'FYI',
};

export const REASON_CODE_LABEL: Record<MessageTriage['reasonCode'], string> = {
  DIRECT_REQUEST: 'Direct request', QUESTION: 'Question', APPROVAL_NEEDED: 'Approval needed',
  BLOCKED: 'Blocked', DEADLINE: 'Deadline', INCIDENT: 'Incident', FOLLOW_UP: 'Follow-up',
  INFORMATIONAL: 'Informational', AUTOMATED_NOTICE: 'Automated notice', SOCIAL: 'Social', OTHER: 'Other',
};

/** Scores are 0-100 by contract; a model that ignores that gets clamped. */
export function clampUrgency(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export type UrgencyBand = 'now' | 'today' | 'soon' | 'later' | 'whenever';

/**
 * Coarse band for display. The exact number is noisy — the prompt only asks
 * for a band's worth of precision — so the UI shows a band and keeps the digits
 * as a tooltip.
 */
export function urgencyBand(score: number): UrgencyBand {
  const value = clampUrgency(score);
  if (value >= 80) return 'now';
  if (value >= 60) return 'soon';
  if (value >= 40) return 'today';
  if (value >= 20) return 'later';
  return 'whenever';
}

export const URGENCY_BAND_LABEL: Record<UrgencyBand, string> = {
  now: 'Now',
  soon: 'Soon',
  today: 'Today',
  later: 'Later',
  whenever: 'Whenever',
};

/**
 * One message's triage result, as the UI sees it.
 *
 * `reason` is not optional and is not decoration: CLAUDE.md requires the
 * model's reasoning be stored and surfaced alongside every score so the sort
 * order can be argued with. A result without one is a parse failure, not a
 * result (see `classify.ts`).
 */
export type MessageTriage = {
  urgencyScore: number;
  category: TriageCategory;
  isBump: boolean;
  /** The earlier message this one chases, when the model identified it. */
  bumpOfMessageId: string | null;
  reasonCode: import('@/lib/triage/prompt').ClassificationReasonCode;
  /** Model that produced this, so a model change is visible in the data. */
  model: string;
  classifiedAtIso: string;
};
