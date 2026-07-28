'use client';

import { Kbd } from '@/app/inbox/QueueList';
import { SHORTCUT_HELP } from '@/lib/keyboard/shortcuts';

export type ShortcutOverlayProps = {
  onClose: () => void;
};

export function ShortcutOverlay({ onClose }: ShortcutOverlayProps) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-neutral-900/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      data-testid="shortcut-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-xl">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            data-testid="shortcut-overlay-close"
            className="text-xs text-neutral-500 underline"
          >
            close
          </button>
        </div>

        <dl className="mt-4 space-y-2">
          {SHORTCUT_HELP.map((shortcut) => (
            <div
              key={shortcut.keys}
              className="flex items-baseline gap-3"
              data-testid="shortcut-row"
            >
              <dt className="w-20 shrink-0 text-right">
                <Kbd>{shortcut.keys}</Kbd>
              </dt>
              <dd className="text-sm text-neutral-700">
                {shortcut.description}
              </dd>
            </div>
          ))}
        </dl>

        <p className="mt-4 border-t border-neutral-200 pt-3 text-[11px] text-neutral-500">
          Shortcuts stand down while you are typing, so a reply containing
          &ldquo;read&rdquo; will not mark anything complete. Press{' '}
          <Kbd>Esc</Kbd> to close.
        </p>
      </div>
    </div>
  );
}
