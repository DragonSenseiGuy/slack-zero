import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Event routing tests for the Socket Mode handlers.
 *
 * The persistence layer is mocked, so these assert the decision the handler
 * makes — upsert vs. soft-delete vs. ignore — without a DB. The live
 * end-to-end check (a real DM landing in Postgres) is plan.md's verification
 * #3 and is by definition not a unit test.
 */

import { handleMessageEvent, handleReactionEvent } from '@/lib/slack/socket';
import type { UpsertOutcome } from '@/lib/slack/ingest';

const upsertMessage = vi.fn(
  async (): Promise<UpsertOutcome> => 'created',
);
const markMessageDeleted = vi.fn(async (): Promise<boolean> => true);
const applyReactionEvent = vi.fn(async (): Promise<boolean> => true);

// Hoisted above the imports by vitest, so `socket.ts` binds to these.
const { classificationDeleteMany } = vi.hoisted(() => ({ classificationDeleteMany: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { classification: { deleteMany: classificationDeleteMany } } }));
vi.mock('@/lib/slack/ingest', () => ({
  upsertMessage: (...args: unknown[]) => upsertMessage(...(args as [])),
  markMessageDeleted: (...args: unknown[]) =>
    markMessageDeleted(...(args as [])),
  applyReactionEvent: (...args: unknown[]) =>
    applyReactionEvent(...(args as [])),
}));

beforeEach(() => {
  upsertMessage.mockClear().mockResolvedValue('created');
  markMessageDeleted.mockClear().mockResolvedValue(true);
  applyReactionEvent.mockClear().mockResolvedValue(true);
  classificationDeleteMany.mockClear().mockResolvedValue({ count: 0 });
});

describe('handleMessageEvent', () => {
  it('upserts a new DM and tags it as event-sourced', async () => {
    const result = await handleMessageEvent({
      type: 'message',
      channel: 'D0BKMJLRRNH',
      channel_type: 'im',
      user: 'U0BEHBXNGHK',
      ts: '1784938592.138359',
      text: 'hello',
    });

    expect(result).toEqual({
      action: 'created',
      conversationId: 'D0BKMJLRRNH',
      ts: '1784938592.138359',
      // Carried through so the listener can hydrate an unknown author's
      // profile after the event is committed (see `hydrate.ts`).
      userId: 'U0BEHBXNGHK',
    });
    expect(upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ts: '1784938592.138359', text: 'hello' }),
      'EVENT',
    );
  });

  it('reports an updated row when the message was already ingested', async () => {
    upsertMessage.mockResolvedValue('updated');
    const result = await handleMessageEvent({
      channel: 'D1',
      ts: '1.000100',
      text: 'again',
    });
    expect(result).toMatchObject({ action: 'updated' });
  });

  it('soft-deletes on message_deleted', async () => {
    const result = await handleMessageEvent({
      subtype: 'message_deleted',
      channel: 'D1',
      ts: '2.000000',
      deleted_ts: '1.000100',
    });

    expect(markMessageDeleted).toHaveBeenCalledWith('D1', '1.000100');
    expect(result).toMatchObject({ action: 'deleted', ts: '1.000100' });
    expect(upsertMessage).not.toHaveBeenCalled();
  });

  it('ignores a deletion for a message outside our backfill window', async () => {
    markMessageDeleted.mockResolvedValue(false);
    const result = await handleMessageEvent({
      subtype: 'message_deleted',
      channel: 'D1',
      deleted_ts: '1.000100',
    });
    expect(result).toMatchObject({ action: 'ignored' });
  });

  it('updates the original ts on an edit rather than inserting a new row', async () => {
    upsertMessage.mockResolvedValue('updated');
    const result = await handleMessageEvent({
      subtype: 'message_changed',
      channel: 'D1',
      ts: '9.999999',
      message: {
        ts: '1.000100',
        user: 'U1',
        text: 'edited',
        edited: { user: 'U1', ts: '9.999999' },
      },
    });

    expect(result).toMatchObject({ action: 'updated', ts: '1.000100' });
    expect(upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ts: '1.000100', isEdited: true }),
      'EVENT',
      undefined,
      { clearClassification: true },
    );
  });

  it('ignores an event it cannot place', async () => {
    const result = await handleMessageEvent({ ts: '1.0', text: 'orphan' });
    expect(result).toMatchObject({ action: 'ignored' });
    expect(upsertMessage).not.toHaveBeenCalled();
  });
});

describe('handleReactionEvent', () => {
  it('applies reaction_added', async () => {
    const result = await handleReactionEvent({
      type: 'reaction_added',
      user: 'U1',
      reaction: 'eyes',
      item: { type: 'message', channel: 'D1', ts: '1.000100' },
    });

    expect(applyReactionEvent).toHaveBeenCalledWith({
      conversationId: 'D1',
      ts: '1.000100',
      name: 'eyes',
      userId: 'U1',
      added: true,
    });
    expect(result).toMatchObject({ action: 'reaction', name: 'eyes' });
  });

  it('applies reaction_removed as a removal', async () => {
    await handleReactionEvent({
      type: 'reaction_removed',
      user: 'U1',
      reaction: 'eyes',
      item: { type: 'message', channel: 'D1', ts: '1.000100' },
    });
    expect(applyReactionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ added: false }),
    );
  });

  it('ignores reactions on non-message items, which have no row to update', async () => {
    const result = await handleReactionEvent({
      type: 'reaction_added',
      user: 'U1',
      reaction: 'eyes',
      item: { type: 'file', channel: 'D1', ts: '1.000100' },
    });
    expect(result).toMatchObject({ action: 'ignored' });
    expect(applyReactionEvent).not.toHaveBeenCalled();
  });

  it('ignores an incomplete reaction event', async () => {
    const result = await handleReactionEvent({ type: 'reaction_added' });
    expect(result).toMatchObject({ action: 'ignored' });
  });

  it('ignores a reaction on a message we never ingested', async () => {
    applyReactionEvent.mockResolvedValue(false);
    const result = await handleReactionEvent({
      type: 'reaction_added',
      user: 'U1',
      reaction: 'eyes',
      item: { type: 'message', channel: 'D1', ts: '1.000100' },
    });
    expect(result).toMatchObject({ action: 'ignored' });
  });
});
