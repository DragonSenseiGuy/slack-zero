import { SocketModeClient } from '@slack/socket-mode';

import { getEnv } from '@/lib/env';
import {
  applyReactionEvent,
  markMessageDeleted,
  upsertMessage,
} from '@/lib/slack/ingest';
import { hydrateStubUsers } from '@/lib/slack/hydrate';
import { normalizeMessageEvent } from '@/lib/slack/normalize';
import type { RawReactionEvent, RawSlackMessage } from '@/lib/slack/raw';
import {
  configureClassificationScheduler,
  scheduleClassificationForSlackMessage,
} from '@/lib/triage/scheduler';

/**
 * Socket Mode listener: keeps the DB fresh without polling.
 *
 * Socket Mode is an *outbound* WebSocket to Slack, so no public URL or tunnel
 * is needed for local dev (this is why plan.md chose it). The app-level token
 * (`SLACK_APP_TOKEN`, `xapp-...`) authenticates the socket itself; the events
 * that arrive are the ones subscribed under `user_events` in the app manifest:
 * `message.im`, `message.mpim`, `message.groups`, `message.channels`, and
 * `reaction_added`.
 *
 * Note on duplicate delivery: when more than one user in the workspace has
 * installed the app, Slack delivers the same underlying message once per
 * authorization. That is handled by the `(conversationId, ts)` upsert in
 * `ingest.ts` rather than by filtering here — dropping events on an
 * authorization mismatch risks losing a message whose envelope names the other
 * account, whereas a redundant upsert costs nothing.
 */

export type IngestResult =
  | { action: 'created'; conversationId: string; ts: string; userId: string | null }
  | { action: 'updated'; conversationId: string; ts: string; userId: string | null }
  | { action: 'deleted'; conversationId: string; ts: string }
  | { action: 'reaction'; conversationId: string; ts: string; name: string }
  | { action: 'ignored'; reason: string };

export class SocketModeNotConfiguredError extends Error {
  constructor() {
    super(
      'SLACK_APP_TOKEN is not set. Generate an app-level token with the ' +
        '"connections:write" scope (see SLACK_APP_SETUP.md) before starting the listener.',
    );
    this.name = 'SocketModeNotConfiguredError';
  }
}

/**
 * Route one `message` event into the DB.
 *
 * Separated from the socket wiring so it can be exercised with a plain object;
 * the socket layer below only supplies the payload and acks.
 */
export async function handleMessageEvent(
  event: RawSlackMessage,
): Promise<IngestResult> {
  const normalized = normalizeMessageEvent(event);

  switch (normalized.kind) {
    case 'ignore':
      return { action: 'ignored', reason: normalized.reason };

    case 'delete': {
      const existed = await markMessageDeleted(
        normalized.conversationId,
        normalized.ts,
      );
      return existed
        ? {
            action: 'deleted',
            conversationId: normalized.conversationId,
            ts: normalized.ts,
          }
        : { action: 'ignored', reason: 'delete for an unknown message' };
    }

    case 'upsert': {
      const outcome = await upsertMessage(normalized.message, 'EVENT');
      return {
        action: outcome,
        conversationId: normalized.message.conversationId,
        ts: normalized.message.ts,
        userId: normalized.message.userId,
      };
    }
  }
}

/** Route a `reaction_added` / `reaction_removed` event into the DB. */
export async function handleReactionEvent(
  event: RawReactionEvent,
): Promise<IngestResult> {
  const conversationId = event.item?.channel;
  const ts = event.item?.ts;

  if (!conversationId || !ts || !event.reaction || !event.user) {
    return { action: 'ignored', reason: 'incomplete reaction event' };
  }
  // Reactions on files/file comments have no message to attach to.
  if (event.item.type !== 'message') {
    return { action: 'ignored', reason: `reaction on ${event.item.type}` };
  }

  const applied = await applyReactionEvent({
    conversationId,
    ts,
    name: event.reaction,
    userId: event.user,
    added: event.type !== 'reaction_removed',
  });

  return applied
    ? { action: 'reaction', conversationId, ts, name: event.reaction }
    : { action: 'ignored', reason: 'reaction on an un-ingested message' };
}

export type SocketListenerOptions = {
  /** Log sink. Defaults to a no-op. */
  onLog?: (message: string) => void;
  /** Called after each event is persisted. Used by the live smoke test. */
  onIngest?: (result: IngestResult) => void;
};

export type SocketListener = {
  stop: () => Promise<void>;
};

/**
 * Connect to Slack and stream events into the DB until `stop()` is called.
 */
export async function startSocketModeListener(
  options: SocketListenerOptions = {},
): Promise<SocketListener> {
  const log = options.onLog ?? (() => {});
  const appToken = getEnv().SLACK_APP_TOKEN;

  if (!appToken) throw new SocketModeNotConfiguredError();

  configureClassificationScheduler({ onLog: log });

  const socket = new SocketModeClient({ appToken });

  /**
   * Ack first, then persist. Slack expects an acknowledgement within three
   * seconds and redelivers otherwise; doing DB work before acking would turn a
   * slow write into a duplicate event.
   */
  const withAck = (
    handler: (event: unknown) => Promise<IngestResult>,
  ): ((args: { ack: () => Promise<void>; event: unknown }) => Promise<void>) => {
    return async ({ ack, event }) => {
      await ack();
      try {
        const result = await handler(event);
        options.onIngest?.(result);

        // Phase 3: hand a newly ingested message to the triage engine — after
        // it is already committed, and without awaiting. CLAUDE.md requires
        // classification never block ingestion, so this call is deliberately
        // fire-and-forget and lives in the wiring rather than inside
        // `handleMessageEvent`, which stays a pure ingest path.
        if (result.action === 'created') {
          scheduleClassificationForSlackMessage(result.conversationId, result.ts);
        }

        // Same shape, same reason: an author who joined since the last
        // backfill has only a stub `User` row, which would render in the queue
        // as a raw `U…` id. Resolve it with `users.info` after the message is
        // committed, without blocking the ack path.
        if (
          (result.action === 'created' || result.action === 'updated') &&
          result.userId
        ) {
          void hydrateStubUsers([result.userId], { onLog: log });
        }

        log(
          result.action === 'ignored'
            ? `ignored: ${result.reason}`
            : `${result.action} ${result.conversationId} @ ${result.ts}`,
        );
      } catch (error) {
        // A single bad event must not kill the listener.
        log(
          `error handling event: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
  };

  const onMessage = withAck((event) =>
    handleMessageEvent(event as RawSlackMessage),
  );
  const onReaction = withAck((event) =>
    handleReactionEvent(event as RawReactionEvent),
  );

  socket.on('message', onMessage);
  socket.on('reaction_added', onReaction);
  socket.on('reaction_removed', onReaction);

  socket.on('authenticated', () => log('socket authenticated'));
  socket.on('connected', () => log('socket connected — listening for events'));
  socket.on('disconnected', () => log('socket disconnected'));
  socket.on('error', (error: unknown) =>
    log(
      `socket error: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );

  await socket.start();

  return {
    stop: async () => {
      await socket.disconnect();
    },
  };
}
