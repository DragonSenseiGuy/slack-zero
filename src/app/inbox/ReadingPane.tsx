'use client';

import { forwardRef, useEffect, useState } from 'react';

import type { QueueItem } from '@/lib/queue/queue';
import { effectiveUrgency } from '@/lib/queue/queue';
import { bumpStalenessLabel, formatRelativeTime } from '@/lib/queue/time';
import { Kbd } from '@/app/inbox/QueueList';
import { CategoryBadge, UrgencyBadge } from '@/app/inbox/TriageBadges';

/**
 * The reading pane of the split view: full content of the selected message
 * without leaving the queue (plan.md, Phase 2). The list keeps its scroll
 * position and its selection because nothing here navigates.
 */

/**
 * Absolute timestamps are locale- and timezone-dependent, so rendering one
 * during SSR guarantees a hydration mismatch. Render nothing on the server,
 * fill it in after mount.
 */
function useLocalTimestamp(iso: string): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const date = new Date(iso);
    setLabel(
      Number.isNaN(date.getTime())
        ? null
        : date.toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
    );
  }, [iso]);

  return label;
}

/**
 * Why this message is where it is in the queue.
 *
 * CLAUDE.md requires the model's `reason` be stored alongside every score
 * "for debugging and building trust in the sorting, not optional metadata".
 * Storing it and never showing it would satisfy the letter and miss the point,
 * so it is rendered here, with the model that produced it — a score you cannot
 * argue with is a score you cannot trust.
 */
function TriageExplainer({ item, nowIso }: { item: QueueItem; nowIso: string }) {
  const urgency = effectiveUrgency(item);

  if (!item.triage) {
    return (
      <p
        data-testid="triage-explainer"
        data-classified="false"
        className="mb-4 rounded border border-dashed border-neutral-300 px-3 py-2 text-xs text-neutral-500"
      >
        Not classified yet. Triage runs after ingestion, never during it — run{' '}
        <code className="font-mono">npm run classify</code> to catch up.
      </p>
    );
  }

  return (
    <div
      data-testid="triage-explainer"
      data-classified="true"
      className="mb-4 rounded border border-neutral-200 bg-neutral-50 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {urgency !== null ? <UrgencyBadge score={urgency} /> : null}
        <CategoryBadge category={item.triage.category} />
        <span className="font-mono text-[10px] text-neutral-400">
          urgency {item.triage.urgencyScore}/100
        </span>
      </div>

      <p
        className="mt-1.5 text-xs text-neutral-700"
        data-testid="triage-reason"
      >
        {item.triage.reason}
      </p>

      {item.bumps ? (
        <p className="mt-1 text-xs text-fuchsia-800" data-testid="triage-bump-note">
          Collapsed {item.bumps.bumpCount}{' '}
          {item.bumps.bumpCount === 1 ? 'follow-up' : 'follow-ups'} —{' '}
          {bumpStalenessLabel(item.bumps.firstAskedAtIso, nowIso)}, last chased{' '}
          {formatRelativeTime(item.bumps.lastBumpedAtIso, nowIso)} ago.
        </p>
      ) : null}

      <p className="mt-1 font-mono text-[10px] text-neutral-400">
        {item.triage.model}
      </p>
    </div>
  );
}

export type ReadingPaneProps = {
  item: QueueItem | null;
  nowIso: string;
  isFocused: boolean;
  onToggleDone: (item: QueueItem) => void;
  /**
   * The reply box (Phase 5), passed in rather than built here.
   *
   * Keeps the pane a pure renderer of a message: sending state, drafts and
   * rollback all live with the rest of the mutation logic in `InboxClient`.
   */
  replySlot?: React.ReactNode;
};

export const ReadingPane = forwardRef<HTMLElement, ReadingPaneProps>(
  function ReadingPane(
    { item, nowIso, isFocused, onToggleDone, replySlot },
    ref,
  ) {
    const localTime = useLocalTimestamp(item?.sentAtIso ?? '');

    if (!item) {
      return (
        <section
          ref={ref}
          tabIndex={-1}
          data-testid="reading-pane"
          data-empty="true"
          className="flex h-full items-center justify-center p-8 text-center text-sm text-neutral-500"
        >
          <p>
            Select a message with <Kbd>j</Kbd> / <Kbd>k</Kbd>, then press{' '}
            <Kbd>Enter</Kbd> to read it.
          </p>
        </section>
      );
    }

    return (
      <section
        ref={ref}
        tabIndex={-1}
        data-testid="reading-pane"
        data-message-id={item.id}
        data-focused={isFocused ? 'true' : 'false'}
        className={`flex h-full min-h-0 flex-col outline-none ${
          isFocused ? 'ring-2 ring-inset ring-violet-400' : ''
        }`}
      >
        <header className="border-b border-neutral-200 px-6 py-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-base font-semibold text-neutral-900">
              {item.senderLabel}
            </h2>
            {item.isBotSender ? (
              <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium uppercase text-neutral-600">
                App
              </span>
            ) : null}
            <span className="text-sm text-neutral-500">{item.contextLabel}</span>
            <span
              className="ml-auto font-mono text-xs text-neutral-400"
              title={item.sentAtIso}
            >
              {localTime ?? formatRelativeTime(item.sentAtIso, nowIso)}
            </span>
          </div>

          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={() => onToggleDone(item)}
              data-testid="reading-pane-done-toggle"
              aria-pressed={item.isDone}
              className={`rounded border px-2.5 py-1 text-xs font-medium ${
                item.isDone
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                  : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50'
              }`}
            >
              {item.isDone ? 'Done ✓ — undo' : 'Mark done'} <Kbd>e</Kbd>
            </button>
            {item.isEdited ? (
              <span className="text-xs text-neutral-500">edited</span>
            ) : null}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="max-w-3xl px-6 py-5">
            <TriageExplainer item={item} nowIso={nowIso} />

          <p
            className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-neutral-800"
            data-testid="reading-pane-body"
          >
            {item.body}
          </p>

          {item.reactions.length > 0 ? (
            <ul className="mt-4 flex flex-wrap gap-1.5">
              {item.reactions.map((reaction) => (
                <li
                  key={reaction.name}
                  className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-600"
                >
                  :{reaction.name}: {reaction.count}
                </li>
              ))}
            </ul>
          ) : null}

          {item.threadReplies.length > 0 ? (
            <div className="mt-6" data-testid="reading-pane-thread">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Thread · {item.threadReplies.length}{' '}
                {item.threadReplies.length === 1 ? 'reply' : 'replies'}
              </h3>
              <ol className="mt-2 space-y-3 border-l-2 border-neutral-200 pl-4">
                {item.threadReplies.map((reply) => (
                  <li key={reply.id} data-testid="thread-reply">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-neutral-800">
                        {reply.senderLabel}
                      </span>
                      <span
                        className="font-mono text-[11px] text-neutral-400"
                        title={reply.sentAtIso}
                      >
                        {formatRelativeTime(reply.sentAtIso, nowIso)}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm text-neutral-700">
                      {reply.body}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          </div>
        </div>

        {replySlot}
      </section>
    );
  },
);
