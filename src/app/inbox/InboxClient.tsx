'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CommandPalette } from '@/app/inbox/CommandPalette';
import { ReplyBox } from '@/app/inbox/ReplyBox';
import { ShortcutOverlay } from '@/app/inbox/ShortcutOverlay';
import { SnoozeMenu } from '@/app/inbox/SnoozeMenu';
import { ViewBuilder } from '@/app/inbox/ViewBuilder';
import { ViewSidebar } from '@/app/inbox/ViewSidebar';
import { Kbd, QueueList } from '@/app/inbox/QueueList';
import { ReadingPane } from '@/app/inbox/ReadingPane';
import {
  isTypingTarget,
  resolveShortcut,
  SHORTCUT_HELP,
  type InboxMode,
} from '@/lib/keyboard/shortcuts';
import type { PaletteEntry } from '@/lib/palette/search';
import { filterPaletteEntries } from '@/lib/palette/search';
import { setMessageDone } from '@/lib/queue/actions';
import { draftReplies, sendReplyToMessage } from '@/lib/reply/actions';
import { snoozeMessage } from '@/lib/snooze/actions';
import type { SnoozePreset } from '@/lib/snooze/schedule';
import type { ReplyDraft } from '@/lib/reply/draft';
import { createView, deleteView, updateView } from '@/lib/views/actions';
import {
  applyViewFilters,
  DEFAULT_VIEW_NAME,
  sortForView,
  type SavedView,
  type ViewFilters,
  type ViewLayout,
  type ViewSort,
} from '@/lib/views/filters';
import {
  clampIndex,
  moveSelection,
  nextSortMode,
  queueCounts,
  sortQueue,
  unclassifiedCount,
  SORT_MODE_LABEL,
  type QueueItem,
  type QueueScope,
  type QueueSortMode,
} from '@/lib/queue/queue';

/**
 * The inbox shell: split view, keyboard dispatch, optimistic done state,
 * command palette.
 *
 * Only presentation and interaction live here. Which messages qualify, how
 * they sort, what a key means, and how the palette ranks are all pure
 * functions in `lib/` with their own unit tests — this component is the part
 * that is only meaningfully testable through Playwright, so it is kept thin
 * on purpose.
 */

export type InboxClientProps = {
  items: QueueItem[];
  paletteEntries: PaletteEntry[];
  workspaceName: string | null;
  isConnected: boolean;
  nowIso: string;
  /** Saved views for the sidebar (plan.md, Phase 4). Empty is a valid state. */
  views: SavedView[];
};

/** Local, unconfirmed done state layered over the server's. */
type DoneOverride = { isDone: boolean; doneAtIso: string | null };

export function InboxClient({
  items,
  paletteEntries,
  workspaceName,
  isConnected,
  nowIso,
  views: initialViews,
}: InboxClientProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<InboxMode>('list');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [showDone, setShowDone] = useState(false);
  /**
   * Urgency is the default because prioritization is the product (plan.md,
   * Phase 3). `s` switches to recency, where a collapsed bump chain sorts at
   * the time of the *original* ask — which is the whole point of collapsing:
   * a chase surfaces staleness instead of looking like new activity.
   */
  const [sortMode, setSortMode] = useState<QueueSortMode>('urgency');
  const [scope, setScope] = useState<QueueScope | null>(null);

  /**
   * Saved views (plan.md, Phase 4). Held in client state and seeded from the
   * server so switching views is a re-filter of data already in memory — no
   * fetch and no navigation, which is what "without full page reload" requires.
   */
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
  const [error, setError] = useState<string | null>(null);
  /**
   * Saves still in flight, and saves the server has confirmed. The optimistic
   * update means the UI is already showing the new state, so without this
   * there is nothing — for the user or for a test — that distinguishes "shown"
   * from "stored". Navigating away mid-flight would silently drop the write.
   */
  const [pendingSaves, setPendingSaves] = useState(0);
  const [confirmedSaves, setConfirmedSaves] = useState(0);

  /**
   * Reply state (plan.md, Phase 5).
   *
   * `sentTs` and `replyError` are keyed by nothing — they are about the *current*
   * selection, and are cleared when it changes, because a success or failure
   * notice that outlived its message would be attached to the wrong person.
   */
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replySentTs, setReplySentTs] = useState<string | null>(null);
  const [replySentCount, setReplySentCount] = useState(0);
  /** Auto-mark done after sending. plan.md: configurable, on by default. */
  const [replyMarkDone, setReplyMarkDone] = useState(true);
  /** Snooze picker (Phase 6). */
  const [helpOpen, setHelpOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeBusy, setSnoozeBusy] = useState(false);
  const [snoozeError, setSnoozeError] = useState<string | null>(null);
  /** Ids hidden locally by a snooze the server has already accepted. */
  const [snoozedIds, setSnoozedIds] = useState<Set<string>>(new Set());

  const [drafts, setDrafts] = useState<ReplyDraft[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftsError, setDraftsError] = useState<string | null>(null);

  const paneRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Hydration marker. Until this flips, the page is server-rendered HTML with
  // no key listener attached, so a keystroke is silently dropped. The e2e
  // suite waits on it instead of racing hydration; a user gets the same
  // guarantee that the shortcut footer only claims to work once it does.
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => setIsHydrated(true), []);

  // Server truth, with any in-flight local toggle applied on top.
  const effectiveItems = useMemo(
    () =>
      items
        // A snooze the server has accepted but this render has not re-fetched.
        // Dropping the row here rather than filtering later keeps the sidebar
        // counts honest too.
        .filter((item) => !snoozedIds.has(item.id))
        .map((item) => {
          const override = overrides[item.id];
          return override
            ? { ...item, isDone: override.isDone, doneAtIso: override.doneAtIso }
            : item;
        }),
    [items, overrides, snoozedIds],
  );

  const activeView = useMemo(
    () => views.find((view) => view.id === activeViewId) ?? null,
    [views, activeViewId],
  );

  /**
   * The view's own filters, with the two live toggles layered on top.
   *
   * `u` (show done) and the palette scope are transient UI state, not part of
   * the saved view — so they override rather than mutate it. A view that saved
   * `includeDone: true` still honours that; `u` can only widen.
   */
  const effectiveFilters = useMemo<ViewFilters>(
    () => ({
      ...(activeView?.filters ?? {}),
      ...(showDone ? { includeDone: true } : {}),
      ...(scope ? { scope } : {}),
    }),
    [activeView, showDone, scope],
  );

  const visibleItems = useMemo(() => {
    // Filter first, then collapse and sort. Collapsing after filtering is what
    // lets a chain whose original ask is already done still show up under its
    // oldest surviving follow-up rather than disappearing.
    const filtered = applyViewFilters(effectiveItems, effectiveFilters);

    // The header's sort toggle stays authoritative while it is showing, so `s`
    // keeps working inside a saved view; the view's own sort is the starting
    // point for views that specify one of the Phase 4 orders.
    if (activeView && (activeView.sort === 'oldest' || activeView.sort === 'vip_unread_first')) {
      return sortForView(filtered, activeView.sort);
    }
    return sortQueue(filtered, { mode: sortMode });
  }, [effectiveItems, effectiveFilters, activeView, sortMode]);

  /** Open-item count per view, for the sidebar badges. */
  const viewCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const view of views) {
      counts[view.id] = applyViewFilters(effectiveItems, view.filters).length;
    }
    return counts;
  }, [views, effectiveItems]);

  const counts = useMemo(
    () => queueCounts(effectiveItems, scope),
    [effectiveItems, scope],
  );

  const pendingTriage = useMemo(
    () => unclassifiedCount(visibleItems),
    [visibleItems],
  );

  const safeIndex = clampIndex(selectedIndex, visibleItems.length);
  const selectedItem = visibleItems[safeIndex] ?? null;

  const paletteResults = useMemo(
    () => filterPaletteEntries(paletteEntries, paletteQuery),
    [paletteEntries, paletteQuery],
  );

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const toggleDone = useCallback(
    (item: QueueItem) => {
      const next = !item.isDone;
      const previous = { isDone: item.isDone, doneAtIso: item.doneAtIso };

      // Optimistic: the whole point of the phase is that `e` feels instant.
      setOverrides((current) => ({
        ...current,
        [item.id]: {
          isDone: next,
          doneAtIso: next ? new Date().toISOString() : null,
        },
      }));
      setError(null);
      setPendingSaves((count) => count + 1);

      void setMessageDone(item.id, next)
        .then((result) => {
          if (result.ok) {
            setOverrides((current) => ({
              ...current,
              [item.id]: {
                isDone: result.isDone,
                doneAtIso: result.doneAtIso,
              },
            }));
            setConfirmedSaves((count) => count + 1);
            return;
          }
          // Roll back rather than leave the UI claiming something is saved
          // when it is not — a triage tool that silently loses "done" is worse
          // than one that refuses.
          setOverrides((current) => ({ ...current, [item.id]: previous }));
          setError(result.error);
        })
        .catch((cause: unknown) => {
          setOverrides((current) => ({ ...current, [item.id]: previous }));
          setError(
            cause instanceof Error
              ? `Could not save done state: ${cause.message}`
              : 'Could not save done state.',
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
            // Keep the dialog open with the reason — a duplicate name is the
            // common case and retyping the whole view would be punishing.
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
            // Never leave the inbox with no view selected — fall back to the
            // default rather than rendering an unfiltered list with no sidebar
            // selection, which reads as a broken state.
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

  /**
   * Send a reply, then optionally mark the item done.
   *
   * Deliberately *not* optimistic about the send itself. Everywhere else in this
   * app an optimistic update is right, because the worst case is a local flag
   * that rolls back. Here the worst case is the user believing a colleague got a
   * message that never left the building — so the button says "Sending…" and the
   * item stays put until Slack confirms.
   *
   * The done flag, once the send succeeds, *is* applied locally straight away:
   * the server has already written it, and re-fetching just to see it would make
   * a successful reply feel slow.
   */
  const sendReply = useCallback(
    (text: string) => {
      const target = selectedItem;
      if (!target) return;

      setReplySending(true);
      setReplyError(null);
      setReplySentTs(null);

      void sendReplyToMessage(target.id, text, { markDone: replyMarkDone })
        .then((result) => {
          if (!result.ok) {
            // No rollback needed: nothing was changed optimistically. The item
            // stays in the queue, which is the correct place for a message that
            // still has not been answered.
            setReplyError(result.error);
            return;
          }

          setReplySentTs(result.ts);
          setReplySentCount((count) => count + 1);
          setDrafts([]);
          setDraftsError(null);

          if (result.markedDone) {
            setOverrides((current) => ({
              ...current,
              [target.id]: {
                isDone: true,
                doneAtIso: new Date().toISOString(),
              },
            }));
          } else if (replyMarkDone) {
            // Sent, but the done write did not land. Say so rather than leaving
            // the user to wonder why the item is still there.
            setReplyError(
              'Reply sent, but the item could not be marked done. It is still in the queue.',
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
          // Drafts are a convenience, never a prerequisite for replying — a
          // failure here must not disturb the compose box.
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

      void snoozeMessage(target.id, { preset, customIso })
        .then((result) => {
          if (!result.ok) {
            // Keep the picker open with the reason — "pick a time in the
            // future" is actionable, and closing would lose the chosen time.
            setSnoozeError(result.error);
            return;
          }
          // Hide it locally straight away; the server has already stored it.
          setSnoozedIds((current) => new Set(current).add(target.id));
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
    // Focus the pane so PgUp/PgDn/space scroll the message, not the page.
    window.requestAnimationFrame(() => paneRef.current?.focus());
  }, [selectedItem]);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    setPaletteQuery('');
    setPaletteIndex(0);
  }, []);

  const pickPaletteEntry = useCallback(
    (entry: PaletteEntry) => {
      const [kind, ...rest] = entry.id.split(':');
      const id = rest.join(':');

      if (kind === 'conversation') {
        setScope({ kind: 'conversation', id, label: entry.label });
      } else if (kind === 'person') {
        setScope({ kind: 'user', id, label: entry.label });
      }

      setSelectedIndex(0);
      setMode('list');
      closePalette();
    },
    [closePalette],
  );

  const goBack = useCallback(() => {
    if (mode === 'reading') {
      setMode('list');
      listRef.current?.focus();
      return;
    }
    // Nothing to leave: Esc then means "widen back out to everything".
    if (scope) {
      setScope(null);
      setSelectedIndex(0);
    }
  }, [mode, scope]);

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = resolveShortcut(event, {
        mode: paletteOpen ? 'palette' : mode,
        isTyping: isTypingTarget(event.target),
      });

      if (!action) return;
      event.preventDefault();

      switch (action.type) {
        case 'move':
          if (paletteOpen) {
            setPaletteIndex((current) =>
              moveSelection(current, action.delta, paletteResults.length),
            );
          } else {
            setSelectedIndex((current) =>
              moveSelection(current, action.delta, visibleItems.length),
            );
          }
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
          // The snooze picker is the innermost layer, so Escape closes it
          // first — before the reading pane or the palette scope.
          if (snoozeOpen) {
            setSnoozeOpen(false);
            setSnoozeError(null);
            break;
          }
          goBack();
          break;

        case 'openPalette':
          setPaletteIndex(0);
          setPaletteOpen(true);
          break;

        case 'closePalette':
          closePalette();
          break;

        case 'palettePick': {
          const entry = paletteResults[clampIndex(paletteIndex, paletteResults.length)];
          if (entry) pickPaletteEntry(entry);
          break;
        }

        case 'toggleShowDone':
          setShowDone((current) => !current);
          setSelectedIndex(0);
          break;

        case 'cycleSort':
          setSortMode(nextSortMode);
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
          // `r` is a shortcut *into* the compose box; the box itself then owns
          // the keyboard, since `isTypingTarget` stands the shortcuts down.
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
    paletteOpen,
    paletteIndex,
    paletteResults,
    visibleItems.length,
    selectedItem,
    toggleDone,
    openSelected,
    goBack,
    closePalette,
    pickPaletteEntry,
    requestDrafts,
    snoozeOpen,
    helpOpen,
  ]);

  // Keep the stored index in range when the list shrinks under the cursor
  // (which is exactly what marking done does while done items are hidden).
  useEffect(() => {
    setSelectedIndex((current) => clampIndex(current, visibleItems.length));
  }, [visibleItems.length]);

  // A sent/failed notice or a set of drafts belongs to one message. Carrying
  // either to the next selection would attach it to the wrong person.
  useEffect(() => {
    setReplyError(null);
    setReplySentTs(null);
    setDrafts([]);
    setDraftsError(null);
  }, [selectedItem?.id]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

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
          {counts.open} open · {counts.done} done
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
              setSortMode(nextSortMode);
              setSelectedIndex(0);
            }}
            data-testid="sort-mode-toggle"
            data-sort-mode={sortMode}
            className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
          >
            Sort: {SORT_MODE_LABEL[sortMode]} <Kbd>s</Kbd>
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
            {showDone ? 'Hide done' : 'Show done'} <Kbd>u</Kbd>
          </button>
          <button
            type="button"
            onClick={() => {
              setPaletteIndex(0);
              setPaletteOpen(true);
            }}
            data-testid="open-palette"
            className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
          >
            Jump to… <Kbd>⌘K</Kbd>
          </button>
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
          data-mode={paletteOpen ? 'palette' : mode}
          data-hydrated={isHydrated ? 'true' : 'false'}
          data-pending-saves={pendingSaves}
          data-confirmed-saves={confirmedSaves}
          data-sort-mode={sortMode}
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
            showDayBuckets={sortMode === 'recency'}
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

      <footer className="shrink-0 border-t border-neutral-200 px-4 py-1.5">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-neutral-500">
          {SHORTCUT_HELP.map((shortcut) => (
            <li key={shortcut.keys} className="flex items-center gap-1.5">
              <Kbd>{shortcut.keys}</Kbd>
              <span>{shortcut.description}</span>
            </li>
          ))}
        </ul>
      </footer>

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

      {paletteOpen ? (
        <CommandPalette
          entries={paletteEntries}
          query={paletteQuery}
          selectedIndex={paletteIndex}
          onQueryChange={setPaletteQuery}
          onSelectedIndexChange={setPaletteIndex}
          onPick={pickPaletteEntry}
          onClose={closePalette}
        />
      ) : null}
    </div>
  );
}
