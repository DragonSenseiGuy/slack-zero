'use client';

import { useEffect, useMemo, useRef } from 'react';

import {
  filterPaletteEntries,
  type PaletteEntry,
} from '@/lib/palette/search';

/**
 * `⌘K` palette: jump to a channel or a person (plan.md, Phase 2).
 *
 * "Jumping" here means scoping the queue to that conversation or sender —
 * there is nowhere else to jump to yet. Saved views join this list in Phase 4;
 * `PaletteEntry.kind` already has a slot for them.
 *
 * All matching and ranking lives in `lib/palette/search.ts` so it is unit
 * tested; this component only renders and dispatches.
 */

export type CommandPaletteProps = {
  entries: PaletteEntry[];
  query: string;
  selectedIndex: number;
  onQueryChange: (query: string) => void;
  onSelectedIndexChange: (index: number) => void;
  onPick: (entry: PaletteEntry) => void;
  onClose: () => void;
};

const KIND_LABEL: Record<PaletteEntry['kind'], string> = {
  conversation: 'Channel',
  person: 'Person',
  command: 'Command',
};

export function CommandPalette({
  entries,
  query,
  selectedIndex,
  onQueryChange,
  onSelectedIndexChange,
  onPick,
  onClose,
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo(
    () => filterPaletteEntries(entries, query),
    [entries, query],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const clampedIndex =
    results.length === 0
      ? -1
      : Math.min(Math.max(selectedIndex, 0), results.length - 1);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-neutral-900/30 p-4 pt-[12vh]"
      data-testid="command-palette"
      role="dialog"
      aria-modal="true"
      aria-label="Jump to a channel or person"
      onMouseDown={(event) => {
        // Only a click on the backdrop itself dismisses — a click that started
        // inside the panel and drifted out must not close it mid-selection.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-lg border border-neutral-300 bg-white shadow-xl">
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Jump to a channel or person…"
          aria-label="Jump to a channel or person"
          data-testid="command-palette-input"
          className="w-full border-b border-neutral-200 px-4 py-3 text-sm outline-none placeholder:text-neutral-400"
          onChange={(event) => {
            onQueryChange(event.target.value);
            onSelectedIndexChange(0);
          }}
        />

        {results.length === 0 ? (
          <p
            className="px-4 py-6 text-center text-sm text-neutral-500"
            data-testid="command-palette-empty"
          >
            Nothing matches “{query}”.
          </p>
        ) : (
          <ul className="max-h-80 overflow-y-auto" data-testid="command-palette-results">
            {results.map((entry, index) => (
              <li key={entry.id}>
                <button
                  type="button"
                  data-testid="command-palette-result"
                  data-entry-id={entry.id}
                  data-selected={index === clampedIndex ? 'true' : 'false'}
                  className={`flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm ${
                    index === clampedIndex
                      ? 'bg-violet-50 text-neutral-900'
                      : 'text-neutral-700 hover:bg-neutral-50'
                  }`}
                  onMouseEnter={() => onSelectedIndexChange(index)}
                  onClick={() => onPick(entry)}
                >
                  <span className="truncate font-medium">{entry.label}</span>
                  {entry.hint ? (
                    <span className="ml-auto shrink-0 text-xs text-neutral-400">
                      {entry.hint}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-neutral-400">
                    {KIND_LABEL[entry.kind]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
