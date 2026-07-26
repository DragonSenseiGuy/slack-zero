'use client';

import { useEffect, useState } from 'react';

import {
  LAYOUT_LABEL,
  REASON_LABEL,
  SORT_LABEL,
  VIEW_LAYOUTS,
  VIEW_REASONS,
  VIEW_SORTS,
  type SavedView,
  type ViewFilters,
  type ViewLayout,
  type ViewReason,
  type ViewSort,
} from '@/lib/views/filters';
import { CATEGORY_LABEL, TRIAGE_CATEGORIES, type TriageCategory } from '@/lib/triage/types';

/**
 * The view builder (plan.md, Phase 4): name, layout, filters, sort.
 *
 * Deliberately dumb — it edits a draft and hands it back. Whether the resulting
 * filter set actually matches anything is `lib/views/filters.ts`'s job, and that
 * is where the tests are.
 */

export type ViewBuilderProps = {
  /** Null when creating; the view being edited otherwise. */
  view: SavedView | null;
  busy: boolean;
  error: string | null;
  onSave: (draft: {
    name: string;
    layout: ViewLayout;
    sort: ViewSort;
    filters: ViewFilters;
  }) => void;
  onDelete: (view: SavedView) => void;
  onCancel: () => void;
};

function toggle<T>(values: readonly T[] | undefined, value: T): T[] {
  const current = values ?? [];
  return current.includes(value)
    ? current.filter((each) => each !== value)
    : [...current, value];
}

export function ViewBuilder({
  view,
  busy,
  error,
  onSave,
  onDelete,
  onCancel,
}: ViewBuilderProps) {
  const [name, setName] = useState(view?.name ?? '');
  const [layout, setLayout] = useState<ViewLayout>(view?.layout ?? 'detailed');
  const [sort, setSort] = useState<ViewSort>(view?.sort ?? 'urgency');
  const [filters, setFilters] = useState<ViewFilters>(view?.filters ?? {});

  // Re-seed when the dialog is reused for a different view.
  useEffect(() => {
    setName(view?.name ?? '');
    setLayout(view?.layout ?? 'detailed');
    setSort(view?.sort ?? 'urgency');
    setFilters(view?.filters ?? {});
  }, [view]);

  const isEditing = view !== null;

  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center bg-neutral-900/30 p-6 pt-20"
      role="dialog"
      aria-modal="true"
      aria-label={isEditing ? `Edit ${view.name}` : 'New view'}
      data-testid="view-builder"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="w-full max-w-lg rounded-lg border border-neutral-200 bg-white p-4 shadow-xl"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ name, layout, sort, filters });
        }}
      >
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            data-testid="view-name"
            placeholder="e.g. Blocked on me"
            className="mt-1 w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-violet-500"
          />
        </label>

        <fieldset className="mt-4">
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Category
          </legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {TRIAGE_CATEGORIES.map((category: TriageCategory) => {
              const on = (filters.categories ?? []).includes(category);
              return (
                <button
                  key={category}
                  type="button"
                  aria-pressed={on}
                  data-testid={`filter-category-${category}`}
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      categories: toggle(current.categories, category),
                    }))
                  }
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    on
                      ? 'border-violet-400 bg-violet-100 text-violet-900'
                      : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50'
                  }`}
                >
                  {CATEGORY_LABEL[category]}
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="mt-3">
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Source
          </legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {VIEW_REASONS.map((reason: ViewReason) => {
              const on = (filters.reasons ?? []).includes(reason);
              return (
                <button
                  key={reason}
                  type="button"
                  aria-pressed={on}
                  data-testid={`filter-reason-${reason}`}
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      reasons: toggle(current.reasons, reason),
                    }))
                  }
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    on
                      ? 'border-violet-400 bg-violet-100 text-violet-900'
                      : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50'
                  }`}
                >
                  {REASON_LABEL[reason]}
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="mt-3">
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Also
          </legend>
          <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-neutral-700">
            {(
              [
                ['vipOnly', 'VIP only'],
                ['hasBump', 'Has been bumped'],
                ['classifiedOnly', 'Classified only'],
                ['includeDone', 'Include done'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={filters[key] === true}
                  data-testid={`filter-${key}`}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      [key]: event.target.checked ? true : undefined,
                    }))
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-4 flex flex-wrap gap-4">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              Layout
            </span>
            <select
              value={layout}
              data-testid="view-layout"
              onChange={(event) => setLayout(event.target.value as ViewLayout)}
              className="mt-1 block rounded border border-neutral-300 px-2 py-1 text-sm"
            >
              {VIEW_LAYOUTS.map((option) => (
                <option key={option} value={option}>
                  {LAYOUT_LABEL[option]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              Sort
            </span>
            <select
              value={sort}
              data-testid="view-sort"
              onChange={(event) => setSort(event.target.value as ViewSort)}
              className="mt-1 block rounded border border-neutral-300 px-2 py-1 text-sm"
            >
              {VIEW_SORTS.map((option) => (
                <option key={option} value={option}>
                  {SORT_LABEL[option]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error ? (
          <p
            role="alert"
            data-testid="view-builder-error"
            className="mt-3 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex items-center gap-2">
          <button
            type="submit"
            disabled={busy}
            data-testid="save-view"
            className="rounded bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : isEditing ? 'Save changes' : 'Create view'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            data-testid="cancel-view"
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            Cancel
          </button>

          {isEditing && !view.isBuiltIn ? (
            <button
              type="button"
              onClick={() => onDelete(view)}
              disabled={busy}
              data-testid="delete-view"
              className="ml-auto rounded px-2 py-1.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Delete
            </button>
          ) : null}
          {isEditing && view.isBuiltIn ? (
            <span className="ml-auto text-[11px] text-neutral-400">
              Built-in view
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}
