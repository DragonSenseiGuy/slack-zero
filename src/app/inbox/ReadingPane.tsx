'use client';

import { forwardRef, useEffect, useState } from 'react';

import type { QueueItem } from '@/lib/queue/queue';
import { effectiveUrgency } from '@/lib/queue/queue';
import {
  bumpStalenessLabel,
  burstSpanLabel,
  formatRelativeTime,
  snoozeStatusLabel,
} from '@/lib/queue/time';
import { ConversationContext } from '@/app/inbox/ConversationContext';
import { Kbd } from '@/app/inbox/QueueList';
import { CategoryBadge, UrgencyBadge } from '@/app/inbox/TriageBadges';

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

/**
 * Says, in the pane itself, that this is a reminder rather than something that
 * just arrived — and when the user asked for it back.
 */
function SnoozeNote({ item, nowIso }: { item: QueueItem; nowIso: string }) {
  const localUntil = useLocalTimestamp(item.snooze?.untilIso ?? '');
  if (!item.snooze) return null;

  const isPending = item.snooze.state === 'pending';

  return (
    <p
      data-testid="snooze-note"
      data-snooze-state={item.snooze.state}
      data-snooze-reason={item.snooze.returnedReason ?? ''}
      className={`mb-4 rounded border px-3 py-2 text-xs ${
        isPending
          ? 'border-neutral-200 bg-neutral-50 text-neutral-600'
          : 'border-indigo-200 bg-indigo-50 text-indigo-900'
      }`}
    >
      <span className="font-medium">
        ⏰ {snoozeStatusLabel(item.snooze, nowIso)}
      </span>
      {localUntil ? (
        <span className="ml-1 text-neutral-500">
          {isPending ? 'Due' : 'You snoozed it until'} {localUntil}.
        </span>
      ) : null}
    </p>
  );
}

export type SentReply = {
  ts: string;
  body: string;
  sentAtIso: string;
};

export type ReadingPaneProps = {
  item: QueueItem | null;
  nowIso: string;
  isFocused: boolean;
  onToggleDone: (item: QueueItem) => void;
  sentReplies?: readonly SentReply[];
  replySlot?: React.ReactNode;
};

export const ReadingPane = forwardRef<HTMLElement, ReadingPaneProps>(
  function ReadingPane(
    { item, nowIso, isFocused, onToggleDone, sentReplies = [], replySlot },
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
              {item.isDone ? 'Completed ✓ — undo' : 'Mark as complete'}{' '}
              <Kbd>e</Kbd>
            </button>
            {item.isEdited ? (
              <span className="text-xs text-neutral-500">edited</span>
            ) : null}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="max-w-3xl px-6 py-5">
            <SnoozeNote item={item} nowIso={nowIso} />

            <TriageExplainer item={item} nowIso={nowIso} />

            <ConversationContext item={item} nowIso={nowIso} />

          {item.group ? (
            <p
              className="mb-2 text-xs text-violet-800"
              data-testid="group-note"
            >
              One task ·{' '}
              {burstSpanLabel(
                item.group.messageCount,
                item.group.firstMessageAtIso,
                nowIso,
              )}
              . Marking it as complete covers all of them.
            </p>
          ) : null}

          {item.group ? (
            <ol
              className="mb-4 space-y-3 border-l-2 border-violet-200 pl-4"
              data-testid="reading-pane-earlier"
            >
              {item.group.earlier.map((earlier) => (
                <li key={earlier.id} data-testid="earlier-message">
                  <span
                    className="font-mono text-[11px] text-neutral-400"
                    title={earlier.sentAtIso}
                  >
                    {formatRelativeTime(earlier.sentAtIso, nowIso)} ago
                  </span>
                  <p className="whitespace-pre-wrap break-words text-sm text-neutral-600">
                    {earlier.body}
                  </p>
                </li>
              ))}
            </ol>
          ) : null}

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

          {sentReplies.length > 0 ? (
            <div className="mt-6" data-testid="reading-pane-sent">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                You sent
              </h3>
              <ol className="mt-2 space-y-3 border-l-2 border-emerald-200 pl-4">
                {sentReplies.map((sent) => (
                  <li key={sent.ts} data-testid="sent-reply" data-ts={sent.ts}>
                    <span
                      className="font-mono text-[11px] text-neutral-400"
                      title={sent.sentAtIso}
                    >
                      {formatRelativeTime(sent.sentAtIso, nowIso)} ago
                    </span>
                    <p className="whitespace-pre-wrap break-words text-sm text-neutral-800">
                      {sent.body}
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
