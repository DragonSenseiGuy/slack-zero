'use client';

import type { QueueItem } from '@/lib/queue/queue';
import { effectiveUrgency } from '@/lib/queue/queue';
import {
  bumpStalenessLabel,
  burstSpanLabel,
  snoozeStatusLabel,
} from '@/lib/queue/time';
import {
  CATEGORY_LABEL,
  urgencyBand,
  URGENCY_BAND_LABEL,
  type TriageCategory,
  type UrgencyBand,
} from '@/lib/triage/types';

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

export function GroupBadge({
  item,
  nowIso,
}: {
  item: QueueItem;
  nowIso: string;
}) {
  if (!item.group) return null;

  const { messageCount, firstMessageAtIso } = item.group;

  return (
    <span
      data-testid="group-summary"
      data-message-count={messageCount}
      className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-900"
    >
      {burstSpanLabel(messageCount, firstMessageAtIso, nowIso)}
    </span>
  );
}

/**
 * Marks a row as a reminder the user set for themselves — while it is hidden,
 * and just as importantly once it has come back.
 */
export function SnoozeBadge({
  item,
  nowIso,
}: {
  item: QueueItem;
  nowIso: string;
}) {
  if (!item.snooze) return null;

  const isPending = item.snooze.state === 'pending';

  return (
    <span
      data-testid="snooze-summary"
      data-snooze-state={item.snooze.state}
      data-snooze-reason={item.snooze.returnedReason ?? ''}
      title={`Snoozed until ${item.snooze.untilIso}`}
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
        isPending
          ? 'bg-neutral-200 text-neutral-700'
          : 'bg-indigo-100 text-indigo-900'
      }`}
    >
      ⏰ {snoozeStatusLabel(item.snooze, nowIso)}
    </span>
  );
}

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
