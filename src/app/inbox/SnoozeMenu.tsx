'use client';

import { useRef, useState } from 'react';

import {
  resolveSnoozePreset,
  SNOOZE_PRESETS,
  SNOOZE_PRESET_LABEL,
  type SnoozePreset,
} from '@/lib/snooze/schedule';


export type SnoozeMenuProps = {
  nowIso: string;
  busy: boolean;
  error: string | null;
  onSnooze: (preset: SnoozePreset, customIso?: string) => void;
  onClose: () => void;
};

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" in *local* time, not an ISO Z. */
function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function previewFor(preset: SnoozePreset, now: Date): string {
  const resolved = resolveSnoozePreset(preset, now);
  if (!resolved) return '';
  const sameDay = resolved.toDateString() === now.toDateString();
  return resolved.toLocaleString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    ...(sameDay ? {} : { weekday: 'short' }),
  });
}

export function SnoozeMenu({
  nowIso,
  busy,
  error,
  onSnooze,
  onClose,
}: SnoozeMenuProps) {
  const now = new Date(nowIso);
  const [custom, setCustom] = useState(() =>
    toLocalInputValue(new Date(now.getTime() + 60 * 60_000)),
  );
  const ref = useRef<HTMLDivElement | null>(null);

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center bg-neutral-900/30 p-6 pt-32"
      role="dialog"
      aria-modal="true"
      aria-label="Snooze until"
      data-testid="snooze-menu"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-3 shadow-xl"
      >
        <h2 className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Snooze until
        </h2>

        <ul>
          {SNOOZE_PRESETS.filter((preset) => preset !== 'custom').map(
            (preset, index) => (
              <li key={preset}>
                <button
                  type="button"
                  disabled={busy}
                  data-testid={`snooze-${preset}`}
                  onClick={() => onSnooze(preset)}
                  className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-violet-50 disabled:opacity-50"
                >
                  <span className="w-4 shrink-0 font-mono text-[11px] text-neutral-400">
                    {index + 1}
                  </span>
                  <span className="flex-1">{SNOOZE_PRESET_LABEL[preset]}</span>
                  <span className="shrink-0 text-[11px] text-neutral-400">
                    {previewFor(preset, now)}
                  </span>
                </button>
              </li>
            ),
          )}
        </ul>

        <div className="mt-2 border-t border-neutral-200 pt-2">
          <label className="block px-2 text-[11px] font-medium text-neutral-500">
            {SNOOZE_PRESET_LABEL.custom}
          </label>
          <div className="mt-1 flex items-center gap-2 px-2">
            <input
              type="datetime-local"
              value={custom}
              data-testid="snooze-custom-input"
              onChange={(event) => setCustom(event.target.value)}
              className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
            />
            <button
              type="button"
              disabled={busy || custom === ''}
              data-testid="snooze-custom-submit"
              onClick={() => {
                const parsed = new Date(custom);
                if (Number.isNaN(parsed.getTime())) return;
                onSnooze('custom', parsed.toISOString());
              }}
              className="shrink-0 rounded bg-violet-600 px-2.5 py-1 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-40"
            >
              Snooze
            </button>
          </div>
        </div>

        {error ? (
          <p
            role="alert"
            data-testid="snooze-error"
            className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800"
          >
            {error}
          </p>
        ) : null}

        <button
          type="button"
          onClick={onClose}
          data-testid="snooze-cancel"
          className="mt-2 w-full rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
        >
          Cancel (Esc)
        </button>
      </div>
    </div>
  );
}
