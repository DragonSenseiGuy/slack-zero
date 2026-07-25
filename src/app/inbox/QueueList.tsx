'use client';

import { Fragment, useEffect, useRef } from 'react';

import type { QueueItem, QueueReason } from '@/lib/queue/queue';
import { formatDayBucket, formatRelativeTime } from '@/lib/queue/time';

/**
 * The queue list. One row per message: sender, preview, channel/DM context,
 * timestamp (plan.md, Phase 2).
 *
 * Rows are buttons, not links: clicking selects and opens in the pane without
 * a navigation, which is what keeps the queue position stable.
 */

const REASON_LABEL: Record<QueueReason, string> = {
  dm: 'DM',
  mention: 'Mention',
  thread: 'Thread',
};

const REASON_CLASS: Record<QueueReason, string> = {
  dm: 'bg-violet-100 text-violet-800',
  mention: 'bg-amber-100 text-amber-900',
  thread: 'bg-sky-100 text-sky-800',
};

export type QueueListProps = {
  items: QueueItem[];
  selectedIndex: number;
  nowIso: string;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
  onToggleDone: (item: QueueItem) => void;
};

export function QueueList({
  items,
  selectedIndex,
  nowIso,
  onSelect,
  onOpen,
  onToggleDone,
}: QueueListProps) {
  const selectedRef = useRef<HTMLLIElement | null>(null);

  // Keep the cursor on screen while paging with j/k. `nearest` scrolls the
  // minimum amount, so a long run of `j` reads as a moving highlight rather
  // than the list jumping under the user.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (items.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center p-8 text-center"
        data-testid="queue-empty"
      >
        <div>
          <p className="text-lg font-medium text-neutral-700">Inbox zero</p>
          <p className="mt-1 text-sm text-neutral-500">
            Nothing left to triage. Press <Kbd>u</Kbd> to see done items.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-neutral-200" data-testid="queue-list">
      {items.map((item, index) => {
        const isSelected = index === selectedIndex;
        const bucket = formatDayBucket(item.sentAtIso, nowIso);
        const previousBucket =
          index === 0
            ? null
            : formatDayBucket(items[index - 1].sentAtIso, nowIso);

        return (
          <Fragment key={item.id}>
            {bucket && bucket !== previousBucket ? (
              <li
                aria-hidden="true"
                className="bg-neutral-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400"
              >
                {bucket}
              </li>
            ) : null}
            <li
            ref={isSelected ? selectedRef : null}
            data-testid="queue-item"
            data-message-id={item.id}
            data-selected={isSelected ? 'true' : 'false'}
            data-done={item.isDone ? 'true' : 'false'}
            aria-current={isSelected ? 'true' : undefined}
            className={
              isSelected
                ? 'border-l-2 border-l-violet-600 bg-violet-50'
                : 'border-l-2 border-l-transparent hover:bg-neutral-50'
            }
          >
            <div className="flex items-start gap-2 px-3 py-2.5">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onSelect(index)}
                onDoubleClick={() => onOpen(index)}
              >
                <div className="flex items-baseline gap-2">
                  <span
                    className={`truncate text-sm font-semibold ${
                      item.isDone
                        ? 'text-neutral-400 line-through'
                        : 'text-neutral-900'
                    }`}
                  >
                    {item.senderLabel}
                  </span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${REASON_CLASS[item.reason]}`}
                  >
                    {REASON_LABEL[item.reason]}
                  </span>
                  <span
                    className="ml-auto shrink-0 font-mono text-[11px] text-neutral-400"
                    title={item.sentAtIso}
                  >
                    {formatRelativeTime(item.sentAtIso, nowIso)}
                  </span>
                </div>

                <p
                  className={`mt-0.5 truncate text-sm ${
                    item.isDone ? 'text-neutral-400' : 'text-neutral-600'
                  }`}
                  data-testid="queue-item-preview"
                >
                  {item.preview}
                </p>

                <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500">
                  <span className="truncate">{item.contextLabel}</span>
                  {item.replyCount > 0 ? (
                    <span className="shrink-0">· {item.replyCount} replies</span>
                  ) : null}
                  {item.hasFiles ? <span className="shrink-0">· file</span> : null}
                  {item.isEdited ? (
                    <span className="shrink-0">· edited</span>
                  ) : null}
                  {item.isDone ? (
                    <span
                      className="shrink-0 font-medium text-emerald-700"
                      data-testid="queue-item-done-badge"
                    >
                      · Done
                    </span>
                  ) : null}
                </div>
              </button>

              <button
                type="button"
                aria-label={
                  item.isDone
                    ? `Mark ${item.senderLabel}'s message not done`
                    : `Mark ${item.senderLabel}'s message done`
                }
                aria-pressed={item.isDone}
                data-testid="queue-item-done-toggle"
                className={`mt-0.5 shrink-0 rounded border px-2 py-1 text-[11px] font-medium ${
                  item.isDone
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : 'border-neutral-300 text-neutral-500 hover:border-neutral-400 hover:text-neutral-800'
                }`}
                onClick={() => onToggleDone(item)}
              >
                {item.isDone ? 'Undo' : 'Done'}
              </button>
            </div>
            </li>
          </Fragment>
        );
      })}
    </ul>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-neutral-300 bg-neutral-100 px-1 font-mono text-[11px] text-neutral-700">
      {children}
    </kbd>
  );
}
