'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ReplyBox } from '@/app/inbox/ReplyBox';
import { ShortcutOverlay } from '@/app/inbox/ShortcutOverlay';
import { SnoozeMenu } from '@/app/inbox/SnoozeMenu';
import { ViewBuilder } from '@/app/inbox/ViewBuilder';
import { ViewSidebar } from '@/app/inbox/ViewSidebar';
import { Kbd, QueueList } from '@/app/inbox/QueueList';
import { ReadingPane, type SentReply } from '@/app/inbox/ReadingPane';
import {
  isTypingTarget,
  resolveShortcut,
  type InboxMode,
} from '@/lib/keyboard/shortcuts';
import { setMessagesDone } from '@/lib/queue/actions';
import { useInboxLive } from '@/lib/queue/useInboxLive';
import { draftReplies, sendReplyToMessage } from '@/lib/reply/actions';
import { snoozeMessages } from '@/lib/snooze/actions';
import type { SnoozePreset } from '@/lib/snooze/schedule';
import type { ReplyDraft } from '@/lib/reply/draft';
import { createView, deleteView, updateView } from '@/lib/views/actions';
import {
  applyViewFilters,
  DEFAULT_VIEW_NAME,
  isChronologicalSort,
  nextViewSort,
  sortForView,
  SORT_LABEL,
  type SavedView,
  type ViewFilters,
  type ViewLayout,
  type ViewSort,
} from '@/lib/views/filters';
import {
  clampIndex,
  collapseBursts,
  itemMessageIds,
  moveSelection,
  queueCounts,
  unclassifiedCount,
  type QueueItem,
  type QueueScope,
} from '@/lib/queue/queue';

// The inbox shell

export type InboxClientProps = {
  items: QueueItem[];
  workspaceName: string | null;
  isConnected: boolean;
  nowIso: string;
  views: SavedView[];
  initialScope?: QueueScope | null;
};

type DoneOverride = { isDone: boolean; doneAtIso: string | null };

export function InboxClient({
  items,
  workspaceName,
  isConnected,
  nowIso,
  views: initialViews,
  initialScope = null,
}: InboxClientProps) {
  const router = useRouter();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<InboxMode>('list');
  const [showDone, setShowDone] = useState(false);
  const [sortOverride, setSortOverride] = useState<ViewSort | null>(null);
  const [scope, setScope] = useState<QueueScope | null>(initialScope);

  const [views, setViews] = useState<SavedView[]>(initialViews);
  const [activeViewId, setActiveViewId] = useState<string | null>(() => {
    const preferred =
      initialViews.find((view) => view.name === DEFAULT_VIEW_NAME) ??
      initialViews[0];
    return preferred?.id ?? null;
  });
  /** null = closed; { view: null } = creating; { view } = editing. */
  const [builder, setBuilder] = useState<{ view: SavedView | null } | null>(null);
  const [builderBusy, setBuilderBusy] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, DoneOverride>>({});
  /** Read-only mirror, so rollback can see the current overrides without
   * making every keystroke handler depend on them. */
  const overridesRef = useRef(overrides);
  useEffect(() => {
    overridesRef.current = overrides;
  }, [overrides]);
  const [error, setError] = useState<string | null>(null);
  const [pendingSaves, setPendingSaves] = useState(0);
  const [confirmedSaves, setConfirmedSaves] = useState(0);

  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replySentTs, setReplySentTs] = useState<string | null>(null);
  const [replySentCount, setReplySentCount] = useState(0);
  const [sentReplies, setSentReplies] = useState<Record<string, SentReply[]>>({});
  const [replyMarkDone, setReplyMarkDone] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeBusy, setSnoozeBusy] = useState(false);
  const [snoozeError, setSnoozeError] = useState<string | null>(null);
  const [pendingSnoozeIds, setPendingSnoozeIds] = useState<Set<string>>(
    new Set(),
  );

  const [drafts, setDrafts] = useState<ReplyDraft[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftsError, setDraftsError] = useState<string | null>(null);

  const paneRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => setIsHydrated(true), []);

  const effectiveItems = useMemo(
    () =>
      items
        .filter((item) => !pendingSnoozeIds.has(item.id))
        .map((item) => {
          const override = overrides[item.id];
          return override
            ? { ...item, isDone: override.isDone, doneAtIso: override.doneAtIso }
            : item;
        }),
    [items, overrides, pendingSnoozeIds],
  );

  useEffect(() => {
    setPendingSnoozeIds((current) => {
      if (current.size === 0) return current;

      const byId = new Map(items.map((item) => [item.id, item]));
      const next = new Set(current);
      for (const id of current) {
        const item = byId.get(id);
        if (!item || item.snoozedUntilIso !== null) next.delete(id);
      }

      return next.size === current.size ? current : next;
    });
  }, [items]);

  const activeView = useMemo(
    () => views.find((view) => view.id === activeViewId) ?? null,
    [views, activeViewId],
  );

  const effectiveFilters = useMemo<ViewFilters>(
    () => ({
      ...(activeView?.filters ?? {}),
      ...(showDone ? { includeDone: true } : {}),
      ...(scope ? { scope } : {}),
    }),
    [activeView, showDone, scope],
  );

  const sort: ViewSort = sortOverride ?? activeView?.sort ?? 'urgency';

  const visibleItems = useMemo(() => {
    return sortForView(
      applyViewFilters(effectiveItems, effectiveFilters),
      sort,
    );
  }, [effectiveItems, effectiveFilters, sort]);

  const viewCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const view of views) {
      counts[view.id] = collapseBursts(
        applyViewFilters(effectiveItems, view.filters),
      ).length;
    }
    return counts;
  }, [views, effectiveItems]);

  const counts = useMemo(
    () => queueCounts(collapseBursts(effectiveItems), scope),
    [effectiveItems, scope],
  );

  const pendingTriage = useMemo(
    () => unclassifiedCount(visibleItems),
    [visibleItems],
  );

  const safeIndex = clampIndex(selectedIndex, visibleItems.length);
  const selectedItem = visibleItems[safeIndex] ?? null;

  const liveStatus = useInboxLive(useCallback(() => router.refresh(), [router]));

  const toggleDone = useCallback(
    (item: QueueItem) => {
      const next = !item.isDone;
      const ids = itemMessageIds(item);
      const previous = Object.fromEntries(
        ids.map((id) => [
          id,
          overridesRef.current[id] ?? {
            isDone: item.isDone,
            doneAtIso: item.doneAtIso,
          },
        ]),
      );

      const applyAll = (state: DoneOverride) =>
        setOverrides((current) => ({
          ...current,
          ...Object.fromEntries(ids.map((id) => [id, state])),
        }));

      applyAll({
        isDone: next,
        doneAtIso: next ? new Date().toISOString() : null,
      });
      setError(null);
      setPendingSaves((count) => count + 1);

      void setMessagesDone(ids, next)
        .then((result) => {
          if (result.ok) {
            applyAll({ isDone: result.isDone, doneAtIso: result.doneAtIso });
            setConfirmedSaves((count) => count + 1);
            return;
          }
          setOverrides((current) => ({ ...current, ...previous }));
          setError(result.error);
        })
        .catch((cause: unknown) => {
          setOverrides((current) => ({ ...current, ...previous }));
          setError(
            cause instanceof Error
              ? `Could not save the completion state: ${cause.message}`
              : 'Could not save the completion state.',
          );
        })
        .finally(() => setPendingSaves((count) => Math.max(count - 1, 0)));
    },
    [],
  );

  const selectView = useCallback((view: SavedView) => {
    setActiveViewId(view.id);
    setSelectedIndex(0);
    setMode('list');
    setSortOverride(null);
  }, []);

  const saveView = useCallback(
    (draft: {
      name: string;
      layout: ViewLayout;
      sort: ViewSort;
      filters: ViewFilters;
    }) => {
      const editing = builder?.view ?? null;
      setBuilderBusy(true);
      setBuilderError(null);

      const run = editing
        ? updateView(editing.id, draft)
        : createView(draft);

      void run
        .then((result) => {
          if (!result.ok) {
            setBuilderError(result.error);
            return;
          }
          setViews((current) => {
            const next = editing
              ? current.map((view) =>
                  view.id === result.view.id ? result.view : view,
                )
              : [...current, result.view];
            return next
              .slice()
              .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
          });
          setActiveViewId(result.view.id);
          setSelectedIndex(0);
          setBuilder(null);
        })
        .catch((cause: unknown) => {
          setBuilderError(
            cause instanceof Error ? cause.message : 'Could not save the view.',
          );
        })
        .finally(() => setBuilderBusy(false));
    },
    [builder],
  );

  const removeView = useCallback(
    (view: SavedView) => {
      setBuilderBusy(true);
      setBuilderError(null);

      void deleteView(view.id)
        .then((result) => {
          if (!result.ok) {
            setBuilderError(result.error);
            return;
          }
          setViews((current) => {
            const next = current.filter((each) => each.id !== view.id);
            setActiveViewId((currentId) => {
              if (currentId !== view.id) return currentId;
              const fallback =
                next.find((each) => each.name === DEFAULT_VIEW_NAME) ?? next[0];
              return fallback?.id ?? null;
            });
            return next;
          });
          setSelectedIndex(0);
          setBuilder(null);
        })
        .catch((cause: unknown) => {
          setBuilderError(
            cause instanceof Error ? cause.message : 'Could not delete the view.',
          );
        })
        .finally(() => setBuilderBusy(false));
    },
    [],
  );

  const sendReply = useCallback(
    (text: string) => {
      const target = selectedItem;
      if (!target) return;

      setReplySending(true);
      setReplyError(null);
      setReplySentTs(null);

      const ids = itemMessageIds(target);

      void sendReplyToMessage(target.id, text, {
        markDone: replyMarkDone,
        alsoMarkDone: ids.filter((id) => id !== target.id),
      })
        .then((result) => {
          if (!result.ok) {
            setReplyError(result.error);
            return;
          }

          setReplySentTs(result.ts);
          setReplySentCount((count) => count + 1);
          setDrafts([]);
          setDraftsError(null);

          setSentReplies((current) => {
            const existing = current[target.id] ?? [];
            if (existing.some((sent) => sent.ts === result.ts)) return current;
            return {
              ...current,
              [target.id]: [
                ...existing,
                { ts: result.ts, body: text, sentAtIso: new Date().toISOString() },
              ],
            };
          });

          if (result.markedDone) {
            const doneAtIso = new Date().toISOString();
            setOverrides((current) => ({
              ...current,
              ...Object.fromEntries(
                ids.map((id) => [id, { isDone: true, doneAtIso }]),
              ),
            }));
          } else if (replyMarkDone) {
            setReplyError(
              'Reply sent, but the item could not be marked as complete. It is still in the queue.',
            );
          }
        })
        .catch((cause: unknown) => {
          setReplyError(
            cause instanceof Error
              ? `Could not send the reply: ${cause.message}`
              : 'Could not send the reply.',
          );
        })
        .finally(() => setReplySending(false));
    },
    [selectedItem, replyMarkDone],
  );

  const requestDrafts = useCallback(() => {
    const target = selectedItem;
    if (!target) return;

    setDraftsLoading(true);
    setDraftsError(null);

    void draftReplies(target.id)
      .then((result) => {
        if (!result.ok) {
          setDraftsError(result.error);
          setDrafts([]);
          return;
        }
        setDrafts(result.drafts);
      })
      .catch((cause: unknown) => {
        setDraftsError(
          cause instanceof Error ? cause.message : 'Could not draft a reply.',
        );
      })
      .finally(() => setDraftsLoading(false));
  }, [selectedItem]);

  const snooze = useCallback(
    (preset: SnoozePreset, customIso?: string) => {
      const target = selectedItem;
      if (!target) return;

      setSnoozeBusy(true);
      setSnoozeError(null);

      const ids = itemMessageIds(target);

      void snoozeMessages(ids, { preset, customIso })
        .then((result) => {
          if (!result.ok) {
            setSnoozeError(result.error);
            return;
          }
          setPendingSnoozeIds((current) => {
            const next = new Set(current);
            for (const id of ids) next.add(id);
            return next;
          });
          setSnoozeOpen(false);
        })
        .catch((cause: unknown) => {
          setSnoozeError(
            cause instanceof Error ? cause.message : 'Could not snooze.',
          );
        })
        .finally(() => setSnoozeBusy(false));
    },
    [selectedItem],
  );

  const openSelected = useCallback(() => {
    if (!selectedItem) return;
    setMode('reading');
    window.requestAnimationFrame(() => paneRef.current?.focus());
  }, [selectedItem]);

  const goBack = useCallback(() => {
    if (mode === 'reading') {
      setMode('list');
      listRef.current?.focus();
      return;
    }
    if (scope) {
      setScope(null);
      setSelectedIndex(0);
    }
  }, [mode, scope]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = resolveShortcut(event, {
        mode,
        isTyping: isTypingTarget(event.target),
      });

      if (!action) return;
      event.preventDefault();

      switch (action.type) {
        case 'move':
          setSelectedIndex((current) =>
            moveSelection(current, action.delta, visibleItems.length),
          );
          break;

        case 'moveTo':
          setSelectedIndex(
            action.position === 'first' ? 0 : Math.max(visibleItems.length - 1, 0),
          );
          break;

        case 'open':
          openSelected();
          break;

        case 'toggleDone':
          if (selectedItem) toggleDone(selectedItem);
          break;

        case 'back':
          if (helpOpen) {
            setHelpOpen(false);
            break;
          }
          if (snoozeOpen) {
            setSnoozeOpen(false);
            setSnoozeError(null);
            break;
          }
          goBack();
          break;

        case 'toggleShowDone':
          setShowDone((current) => !current);
          setSelectedIndex(0);
          break;

        case 'cycleSort':
          setSortOverride(nextViewSort(sort));
          setSelectedIndex(0);
          break;

        case 'draftReply':
          requestDrafts();
          break;

        case 'toggleHelp':
          setHelpOpen((current) => !current);
          break;

        case 'snooze':
          if (selectedItem) {
            setSnoozeError(null);
            setSnoozeOpen(true);
          }
          break;

        case 'focusReply': {
          const input = document.querySelector<HTMLTextAreaElement>(
            '[data-testid="reply-input"]',
          );
          input?.focus();
          break;
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    mode,
    sort,
    visibleItems.length,
    selectedItem,
    toggleDone,
    openSelected,
    goBack,
    requestDrafts,
    snoozeOpen,
    helpOpen,
  ]);

  useEffect(() => {
    setSelectedIndex((current) => clampIndex(current, visibleItems.length));
  }, [visibleItems.length]);

  useEffect(() => {
    setReplyError(null);
    setReplySentTs(null);
    setDrafts([]);
    setDraftsError(null);
  }, [selectedItem?.id]);

  return (
    <div className="flex h-screen flex-col bg-white text-neutral-900">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-neutral-200 px-4 py-2.5">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          SlackZero
        </Link>
        {workspaceName ? (
          <span className="text-xs text-neutral-500">{workspaceName}</span>
        ) : null}

        <span
          className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600"
          data-testid="queue-counts"
        >
          {counts.open} open · {counts.done} complete
        </span>

        {scope ? (
          <button
            type="button"
            onClick={() => {
              setScope(null);
              setSelectedIndex(0);
            }}
            data-testid="scope-chip"
            className="rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-xs text-violet-800"
          >
            {scope.label} ✕
          </button>
        ) : null}

        {pendingTriage > 0 ? (
          <span
            className="rounded-full border border-dashed border-neutral-300 px-2 py-0.5 text-xs text-neutral-500"
            data-testid="pending-triage"
            title="Classification runs after ingestion, never during it. Run `npm run classify` to catch up."
          >
            {pendingTriage} unrated
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            data-testid="open-help"
            aria-label="Keyboard shortcuts"
            className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
          >
            ?
          </button>
          <Link
            href="/stats"
            data-testid="stats-link"
            className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
          >
            Stats
          </Link>
          <button
            type="button"
            onClick={() => {
              setSortOverride(nextViewSort(sort));
              setSelectedIndex(0);
            }}
            data-testid="sort-mode-toggle"
            data-sort-mode={sort}
            title={`Sorting ${SORT_LABEL[sort].toLowerCase()}. Press s for the next order.`}
            className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
          >
            Sort: {SORT_LABEL[sort]} <Kbd>s</Kbd>
          </button>
          {pendingSaves > 0 ? (
            <span className="text-xs text-neutral-400" data-testid="saving-indicator">
              Saving…
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setShowDone((current) => !current);
              setSelectedIndex(0);
            }}
            data-testid="toggle-show-done"
            aria-pressed={showDone}
            className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
          >
            {showDone ? 'Hide completed' : 'Show completed'} <Kbd>u</Kbd>
          </button>
          {/* Whether the queue is actually following Slack. Without it, "live"
              and "the stream died twenty minutes ago" look identical — which is
              the failure mode that makes a push-updated inbox untrustworthy. */}
          <span
            data-testid="live-status"
            data-status={liveStatus}
            title={
              liveStatus === 'live'
                ? 'Live: new messages and woken snoozes appear on their own.'
                : liveStatus === 'connecting'
                  ? 'Connecting to the live stream…'
                  : 'Not receiving live updates. Reload to catch up.'
            }
            className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${
              liveStatus === 'live'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : liveStatus === 'connecting'
                  ? 'border-neutral-200 text-neutral-500'
                  : 'border-amber-300 bg-amber-50 text-amber-800'
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                liveStatus === 'live'
                  ? 'bg-emerald-500'
                  : liveStatus === 'connecting'
                    ? 'bg-neutral-400'
                    : 'bg-amber-500'
              }`}
            />
            {liveStatus === 'live'
              ? 'Live'
              : liveStatus === 'connecting'
                ? 'Connecting'
                : 'Offline'}
          </span>
        </div>
      </header>

      {!isConnected ? (
        <p
          className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
          data-testid="not-connected-banner"
        >
          Slack is not connected, so this queue is empty.{' '}
          <Link className="underline" href="/">
            Connect a workspace
          </Link>
          .
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          data-testid="inbox-error"
          className="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800"
        >
          {error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {views.length > 0 ? (
          <ViewSidebar
            views={views}
            activeViewId={activeViewId}
            counts={viewCounts}
            onSelect={selectView}
            onNew={() => {
              setBuilderError(null);
              setBuilder({ view: null });
            }}
            onEdit={(view) => {
              setBuilderError(null);
              setBuilder({ view });
            }}
          />
        ) : null}

        <div
          ref={listRef}
          tabIndex={-1}
          data-testid="queue-pane"
          data-mode={mode}
          data-hydrated={isHydrated ? 'true' : 'false'}
          data-pending-saves={pendingSaves}
          data-confirmed-saves={confirmedSaves}
          data-sort-mode={sort}
          data-live={liveStatus}
          data-active-view={activeView?.name ?? ''}
          data-replies-sent={replySentCount}
          data-reply-sending={replySending ? 'true' : 'false'}
          className="w-full max-w-md shrink-0 overflow-y-auto border-r border-neutral-200 outline-none"
        >
          <QueueList
            items={visibleItems}
            selectedIndex={safeIndex}
            nowIso={nowIso}
            layout={activeView?.layout ?? 'detailed'}
            showDayBuckets={isChronologicalSort(sort)}
            onSelect={setSelectedIndex}
            onOpen={(index) => {
              setSelectedIndex(index);
              setMode('reading');
              window.requestAnimationFrame(() => paneRef.current?.focus());
            }}
            onToggleDone={toggleDone}
          />
        </div>

        <div className="min-w-0 flex-1">
          <ReadingPane
            ref={paneRef}
            item={selectedItem}
            nowIso={nowIso}
            isFocused={mode === 'reading'}
            onToggleDone={toggleDone}
            sentReplies={selectedItem ? sentReplies[selectedItem.id] : undefined}
            replySlot={
              selectedItem && isConnected ? (
                <ReplyBox
                  item={selectedItem}
                  drafts={drafts}
                  draftsLoading={draftsLoading}
                  draftsError={draftsError}
                  sending={replySending}
                  error={replyError}
                  sentTs={replySentTs}
                  markDone={replyMarkDone}
                  onMarkDoneChange={setReplyMarkDone}
                  onSend={sendReply}
                  onRequestDrafts={requestDrafts}
                  onDismissError={() => setReplyError(null)}
                />
              ) : null
            }
          />
        </div>
      </div>

      {helpOpen ? (
        <ShortcutOverlay onClose={() => setHelpOpen(false)} />
      ) : null}

      {snoozeOpen && selectedItem ? (
        <SnoozeMenu
          nowIso={nowIso}
          busy={snoozeBusy}
          error={snoozeError}
          onSnooze={snooze}
          onClose={() => {
            setSnoozeOpen(false);
            setSnoozeError(null);
          }}
        />
      ) : null}

      {builder ? (
        <ViewBuilder
          view={builder.view}
          busy={builderBusy}
          error={builderError}
          onSave={saveView}
          onDelete={removeView}
          onCancel={() => {
            setBuilder(null);
            setBuilderError(null);
          }}
        />
      ) : null}
    </div>
  );
}
