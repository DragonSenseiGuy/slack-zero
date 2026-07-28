'use client';

import { describeFilters, type SavedView } from '@/lib/views/filters';

export type ViewSidebarProps = {
  views: SavedView[];
  activeViewId: string | null;
  counts: Record<string, number>;
  onSelect: (view: SavedView) => void;
  onNew: () => void;
  onEdit: (view: SavedView) => void;
};

export function ViewSidebar({
  views,
  activeViewId,
  counts,
  onSelect,
  onNew,
  onEdit,
}: ViewSidebarProps) {
  return (
    <nav
      aria-label="Saved views"
      data-testid="view-sidebar"
      className="flex w-52 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50"
    >
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Views
        </h2>
        <button
          type="button"
          onClick={onNew}
          data-testid="new-view"
          title="New view"
          className="rounded px-1.5 text-sm leading-none text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
        >
          +
        </button>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {views.map((view) => {
          const isActive = view.id === activeViewId;
          const count = counts[view.id] ?? 0;

          return (
            <li key={view.id}>
              <div
                className={`group flex items-center gap-1 rounded ${
                  isActive ? 'bg-violet-100' : 'hover:bg-neutral-200/60'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(view)}
                  data-testid={`view-${view.name}`}
                  data-active={isActive ? 'true' : 'false'}
                  aria-current={isActive ? 'page' : undefined}
                  className="min-w-0 flex-1 px-2 py-1.5 text-left"
                >
                  <span
                    className={`block truncate text-sm ${
                      isActive ? 'font-medium text-violet-900' : 'text-neutral-800'
                    }`}
                  >
                    {view.name}
                  </span>
                  <span className="block truncate text-[11px] text-neutral-500">
                    {describeFilters(view.filters)}
                  </span>
                </button>

                <span
                  data-testid={`view-count-${view.name}`}
                  className="shrink-0 pr-1 text-[11px] tabular-nums text-neutral-500"
                >
                  {count}
                </span>

                <button
                  type="button"
                  onClick={() => onEdit(view)}
                  data-testid={`edit-view-${view.name}`}
                  title={`Edit ${view.name}`}
                  className="shrink-0 pr-2 text-[11px] text-neutral-400 opacity-0 hover:text-neutral-700 focus:opacity-100 group-hover:opacity-100"
                >
                  edit
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
