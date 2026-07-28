'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CONTEXT_PAGE_SIZE,
  type ContextMessage,
  type ContextPage,
} from '@/lib/queue/context';
import type { QueueItem } from '@/lib/queue/queue';
import { formatRelativeTime } from '@/lib/queue/time';

/**
 * The conversation leading up to the message being triaged.
 *
 * Why it exists: a queue row is one message lifted out of a conversation, which
 * is enough to rank it and not enough to answer it — "sounds good, go ahead"
 * needs the question above it. This shows the last ten messages by default and
 * fetches ten more whenever the user scrolls to the top of the box.
 *
 * It is its own scroll region rather than part of the pane's: paging on the
 * pane's scroll would fight the reply box for the same gesture, and restoring
 * the scroll offset after prepending older messages is only well-defined
 * against a container this component owns.
 */

type Loaded = {
  messages: ContextMessage[];
  hasMore: boolean;
};

function isContextWorthReason(item: QueueItem): boolean {
  // Threads already render their own replies inline, so the surrounding
  // channel would be a second, competing transcript.
  return item.reason === 'dm' || item.reason === 'mention';
}

export function ConversationContext({
  item,
  nowIso,
}: {
  item: QueueItem;
  nowIso: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Set while a page is being prepended, so the scroll handler cannot fire a
  // second request for the same page and the restore below knows to run.
  const restoreRef = useRef<number | null>(null);

  const enabled = isContextWorthReason(item);

  // Start from the *oldest* message this row stands for. A collapsed burst
  // already prints its earlier messages in the pane, so paging back from the
  // row's own `ts` would show them a second time.
  const cursorTs = item.group?.earlier[0]?.ts ?? item.ts;

  const fetchPage = useCallback(
    async (before: string): Promise<ContextPage> => {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(item.conversationId)}/context` +
          `?before=${encodeURIComponent(before)}&limit=${CONTEXT_PAGE_SIZE}`,
        { cache: 'no-store' },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Request failed (${response.status}).`);
      }

      return (await response.json()) as ContextPage;
    },
    [item.conversationId],
  );

  // First page, and a reset whenever the selection moves.
  useEffect(() => {
    if (!enabled) {
      setLoaded(null);
      return;
    }

    let cancelled = false;
    setLoaded(null);
    setError(null);
    setLoading(true);

    fetchPage(cursorTs)
      .then((page) => {
        if (cancelled) return;
        setLoaded({ messages: page.messages, hasMore: page.hasMore });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? `Could not load earlier messages: ${cause.message}`
            : 'Could not load earlier messages.',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cursorTs, enabled, fetchPage, item.id]);

  const loadOlder = useCallback(() => {
    if (loading || !loaded?.hasMore) return;
    const oldest = loaded.messages[0];
    if (!oldest) return;

    setLoading(true);
    setError(null);
    // Remember how far the content extended above the viewport, so the messages
    // already on screen stay put once older ones are prepended.
    restoreRef.current = scrollRef.current
      ? scrollRef.current.scrollHeight - scrollRef.current.scrollTop
      : null;

    fetchPage(oldest.ts)
      .then((page) => {
        setLoaded((current) => ({
          messages: [...page.messages, ...(current?.messages ?? [])],
          hasMore: page.hasMore,
        }));
      })
      .catch((cause: unknown) => {
        restoreRef.current = null;
        setError(
          cause instanceof Error
            ? `Could not load earlier messages: ${cause.message}`
            : 'Could not load earlier messages.',
        );
      })
      .finally(() => setLoading(false));
  }, [fetchPage, loaded, loading]);

  // Keep the newest context next to the message on first load, and hold the
  // reading position steady after older messages are prepended.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !loaded) return;

    const pending = restoreRef.current;
    if (pending === null) {
      element.scrollTop = element.scrollHeight;
      return;
    }

    element.scrollTop = element.scrollHeight - pending;
    restoreRef.current = null;
  }, [loaded]);

  if (!enabled) return null;

  const messages = loaded?.messages ?? [];

  return (
    <section
      className="mb-4"
      data-testid="conversation-context"
      data-loaded={loaded ? 'true' : 'false'}
      data-message-count={messages.length}
      data-has-more={loaded?.hasMore ? 'true' : 'false'}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Earlier in {item.contextLabel}
      </h3>

      <div
        ref={scrollRef}
        data-testid="conversation-context-scroll"
        onScroll={(event) => {
          if (event.currentTarget.scrollTop <= 8) loadOlder();
        }}
        className="mt-2 max-h-64 overflow-y-auto rounded border border-neutral-200 bg-neutral-50 px-3 py-2"
      >
        {loaded?.hasMore ? (
          <button
            type="button"
            onClick={loadOlder}
            disabled={loading}
            data-testid="conversation-context-more"
            className="mb-2 w-full rounded border border-neutral-200 bg-white px-2 py-1 text-[11px] text-neutral-600 hover:border-neutral-300 disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Load older messages'}
          </button>
        ) : null}

        {loaded && messages.length === 0 ? (
          <p
            className="text-xs text-neutral-500"
            data-testid="conversation-context-empty"
          >
            Nothing before this — it is the start of the conversation.
          </p>
        ) : null}

        {!loaded && loading ? (
          <p className="text-xs text-neutral-500">Loading earlier messages…</p>
        ) : null}

        <ol className="space-y-2">
          {messages.map((message) => (
            <li
              key={message.id}
              data-testid="context-message"
              data-ts={message.ts}
              data-from-me={message.isFromMe ? 'true' : 'false'}
            >
              <div className="flex items-baseline gap-2">
                <span
                  className={`text-xs font-medium ${
                    message.isFromMe ? 'text-emerald-700' : 'text-neutral-700'
                  }`}
                >
                  {message.isFromMe ? 'You' : message.senderLabel}
                </span>
                <span
                  className="font-mono text-[10px] text-neutral-400"
                  title={message.sentAtIso}
                >
                  {formatRelativeTime(message.sentAtIso, nowIso)}
                </span>
                {message.isEdited ? (
                  <span className="text-[10px] text-neutral-400">edited</span>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap break-words text-xs text-neutral-600">
                {message.body}
              </p>
            </li>
          ))}
        </ol>
      </div>

      {error ? (
        <p
          role="alert"
          data-testid="conversation-context-error"
          className="mt-1 text-xs text-red-700"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
