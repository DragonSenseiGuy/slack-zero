'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CommandPalette } from '@/app/inbox/CommandPalette';
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
import {
  applyQueueFilters,
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
};

/** Local, unconfirmed done state layered over the server's. */
type DoneOverride = { isDone: boolean; doneAtIso: string | null };

export function InboxClient({
  items,
  paletteEntries,
  workspaceName,
  isConnected,
  nowIso,
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
      items.map((item) => {
        const override = overrides[item.id];
        return override
          ? { ...item, isDone: override.isDone, doneAtIso: override.doneAtIso }
          : item;
      }),
    [items, overrides],
  );

  const visibleItems = useMemo(
    () =>
      // Filter first, then collapse and sort. Collapsing after filtering is
      // what lets a chain whose original ask is already done still show up
      // under its oldest surviving follow-up rather than disappearing.
      sortQueue(
        applyQueueFilters(effectiveItems, { includeDone: showDone, scope }),
        { mode: sortMode },
      ),
    [effectiveItems, showDone, scope, sortMode],
  );

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
  ]);

  // Keep the stored index in range when the list shrinks under the cursor
  // (which is exactly what marking done does while done items are hidden).
  useEffect(() => {
    setSelectedIndex((current) => clampIndex(current, visibleItems.length));
  }, [visibleItems.length]);

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
        <div
          ref={listRef}
          tabIndex={-1}
          data-testid="queue-pane"
          data-mode={paletteOpen ? 'palette' : mode}
          data-hydrated={isHydrated ? 'true' : 'false'}
          data-pending-saves={pendingSaves}
          data-confirmed-saves={confirmedSaves}
          data-sort-mode={sortMode}
          className="w-full max-w-md shrink-0 overflow-y-auto border-r border-neutral-200 outline-none"
        >
          <QueueList
            items={visibleItems}
            selectedIndex={safeIndex}
            nowIso={nowIso}
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
