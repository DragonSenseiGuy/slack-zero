'use client';

import { useEffect, useRef, useState } from 'react';

import { Kbd } from '@/app/inbox/QueueList';
import type { QueueItem } from '@/lib/queue/queue';
import {
  DRAFT_KIND_LABEL,
  hasPlaceholder,
  type ReplyDraft,
} from '@/lib/reply/draft';

export type ReplyBoxProps = {
  item: QueueItem;
  drafts: ReplyDraft[];
  draftsLoading: boolean;
  draftsError: string | null;
  sending: boolean;
  error: string | null;
  sentTs: string | null;
  markDone: boolean;
  onMarkDoneChange: (markDone: boolean) => void;
  onSend: (text: string) => void;
  onRequestDrafts: () => void;
  onDismissError: () => void;
};

export function ReplyBox({
  item,
  drafts,
  draftsLoading,
  draftsError,
  sending,
  error,
  sentTs,
  markDone,
  onMarkDoneChange,
  onSend,
  onRequestDrafts,
  onDismissError,
}: ReplyBoxProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setText('');
  }, [item.id]);

  const trimmed = text.trim();
  const canSend = trimmed !== '' && !sending;

  function submit() {
    if (!canSend) return;
    onSend(trimmed);
    setText('');
  }

  return (
    <div
      className="border-t border-neutral-200 bg-neutral-50 px-5 py-3"
      data-testid="reply-box"
      data-sending={sending ? 'true' : 'false'}
    >
      {drafts.length > 0 || draftsLoading || draftsError ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Drafts
          </span>

          {draftsLoading ? (
            <span className="text-xs text-neutral-500" data-testid="drafts-loading">
              Drafting…
            </span>
          ) : null}

          {drafts.map((draft, index) => {
            const needsEditing = hasPlaceholder(draft.text);
            return (
              <button
                key={draft.kind}
                type="button"
                data-testid={`draft-${draft.kind}`}
                data-needs-editing={needsEditing ? 'true' : 'false'}
                title={
                  needsEditing
                    ? 'Fill in the blank before sending'
                    : `Use this draft (${index + 1})`
                }
                onClick={() => {
                  setText(draft.text);
                  inputRef.current?.focus();
                }}
                className="max-w-xs truncate rounded-full border border-violet-300 bg-white px-2.5 py-1 text-xs text-violet-900 hover:bg-violet-50"
              >
                <span className="font-medium">
                  {DRAFT_KIND_LABEL[draft.kind]}
                </span>
                {needsEditing ? ' ✎' : ''}
                <span className="text-violet-700"> · {draft.text}</span>
              </button>
            );
          })}

          {draftsError ? (
            <span
              className="text-xs text-neutral-500"
              data-testid="drafts-error"
              title={draftsError}
            >
              Drafts unavailable
            </span>
          ) : null}
        </div>
      ) : null}

      <textarea
        ref={inputRef}
        value={text}
        rows={2}
        disabled={sending}
        placeholder={`Reply to ${item.senderLabel}…`}
        data-testid="reply-input"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        className="w-full resize-y rounded border border-neutral-300 bg-white px-2.5 py-2 text-sm outline-none focus:border-violet-500 disabled:bg-neutral-100"
      />

      {error ? (
        <p
          role="alert"
          data-testid="reply-error"
          className="mt-2 flex items-start gap-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800"
        >
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={onDismissError}
            className="shrink-0 underline"
          >
            dismiss
          </button>
        </p>
      ) : null}

      {sentTs && !error ? (
        <p
          className="mt-2 text-xs text-emerald-700"
          data-testid="reply-sent"
          data-sent-ts={sentTs}
        >
          Sent to Slack.
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          data-testid="reply-send"
          className="rounded bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-40"
        >
          {sending ? 'Sending…' : 'Send'} <Kbd>↵</Kbd>
        </button>

        <button
          type="button"
          onClick={onRequestDrafts}
          disabled={draftsLoading}
          data-testid="request-drafts"
          className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          Suggest replies <Kbd>d</Kbd>
        </button>

        <label className="flex items-center gap-1.5 text-xs text-neutral-600">
          <input
            type="checkbox"
            checked={markDone}
            data-testid="reply-mark-done"
            onChange={(event) => onMarkDoneChange(event.target.checked)}
          />
          Mark as complete after sending
        </label>

        <span className="ml-auto text-[11px] text-neutral-400">
          Shift+↵ for a newline
        </span>
      </div>
    </div>
  );
}
