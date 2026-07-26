'use client';

import type { QueueItem } from '@/lib/queue/queue';
import { effectiveUrgency } from '@/lib/queue/queue';
import { bumpStalenessLabel } from '@/lib/queue/time';
import {
  CATEGORY_LABEL,
  urgencyBand,
  URGENCY_BAND_LABEL,
  type TriageCategory,
  type UrgencyBand,
} from '@/lib/triage/types';

/**
 * The visible half of the triage engine (plan.md, Phase 3).
 *
 * Three things have to be legible on a row: what the AI thinks the message
 * *is*, how urgent it thinks it is, and — for a collapsed chain — how long the
 * original ask has been waiting. The model's `reason` is shown in the reading
 * pane rather than here, because a list row has no space for a sentence and
 * hiding the score's justification entirely is exactly what CLAUDE.md rules
 * out.
 */

const CATEGORY_CLASS: Record<TriageCategory, string> = {
  action_needed: 'bg-rose-100 text-rose-800',
  fyi: 'bg-sky-100 text-sky-800',
  misc: 'bg-neutral-100 text-neutral-600',
};

const BAND_CLASS: Record<UrgencyBand, string> = {
  now: 'bg-red-600 text-white',
  soon: 'bg-orange-100 text-orange-900',
  today: 'bg-amber-100 text-amber-900',
  later: 'bg-neutral-100 text-neutral-600',
  whenever: 'bg-neutral-100 text-neutral-500',
};

export function CategoryBadge({ category }: { category: TriageCategory }) {
  return (
    <span
      data-testid="triage-category"
      data-category={category}
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${CATEGORY_CLASS[category]}`}
    >
      {CATEGORY_LABEL[category]}
    </span>
  );
}

export function UrgencyBadge({ score }: { score: number }) {
  const band = urgencyBand(score);
  return (
    <span
      data-testid="triage-urgency"
      data-urgency={score}
      data-band={band}
      title={`Urgency ${score}/100`}
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${BAND_CLASS[band]}`}
    >
      {URGENCY_BAND_LABEL[band]}
    </span>
  );
}

/**
 * "first asked 3 days ago · 2 follow-ups" — the staleness the collapse exists
 * to surface. A chase must not make an item look new; this is what it looks
 * like instead.
 */
export function BumpBadge({
  item,
  nowIso,
}: {
  item: QueueItem;
  nowIso: string;
}) {
  if (!item.bumps) return null;

  const { bumpCount, firstAskedAtIso } = item.bumps;

  return (
    <span
      data-testid="bump-summary"
      data-bump-count={bumpCount}
      className="shrink-0 rounded bg-fuchsia-100 px-1.5 py-0.5 text-[10px] font-medium text-fuchsia-900"
    >
      {bumpStalenessLabel(firstAskedAtIso, nowIso)} · {bumpCount}{' '}
      {bumpCount === 1 ? 'follow-up' : 'follow-ups'}
    </span>
  );
}

/** The urgency/category pair, or a "pending" marker for an unclassified row. */
export function TriageBadges({ item }: { item: QueueItem }) {
  const urgency = effectiveUrgency(item);

  if (item.triage === null && urgency === null) {
    return (
      <span
        data-testid="triage-pending"
        title="Not classified yet — classification runs after ingestion, never during it."
        className="shrink-0 rounded border border-dashed border-neutral-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400"
      >
        Unrated
      </span>
    );
  }

  return (
    <>
      {urgency !== null ? <UrgencyBadge score={urgency} /> : null}
      {item.triage ? <CategoryBadge category={item.triage.category} /> : null}
    </>
  );
}
