import type { NormalizedMessage } from '@/lib/slack/normalize';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messageCacheKey, slackMessageCache } from '@/lib/slack/cache';
import { markMessageDeleted, mergeReaction, upsertMessage } from '@/lib/slack/ingest';

// `ingest.ts` constructs nothing at import time except the Prisma singleton,
// which would still want a DATABASE_URL. Stub it so this file stays a pure
// unit test with no database (CLAUDE.md: unit tests must not need live
// infrastructure). `vi.mock` is hoisted above the import above.
const mocks = vi.hoisted(() => ({
  conversationUpsert: vi.fn(),
  userUpsert: vi.fn(),
  messageFindUnique: vi.fn(),
  messageCreate: vi.fn(),
  messageUpsert: vi.fn(),
  messageUpdate: vi.fn(),
  classificationDeleteMany: vi.fn(),
  messageStateUpdateMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    conversation: { upsert: mocks.conversationUpsert },
    user: { upsert: mocks.userUpsert },
    message: {
      findUnique: mocks.messageFindUnique,
      create: mocks.messageCreate,
      upsert: mocks.messageUpsert,
      update: mocks.messageUpdate,
    },
    $transaction: mocks.transaction,
  },
}));

const message: NormalizedMessage = {
  conversationId: 'D-SYNTHETIC',
  ts: '1785000000.000100',
  sentAt: new Date('2026-07-25T00:00:00.000Z'),
  threadTs: null,
  isThreadReply: false,
  isThreadParent: false,
  replyCount: 0,
  userId: 'U-SYNTHETIC',
  botId: 'B-SYNTHETIC',
  authorName: 'Synthetic Person',
  subtype: 'synthetic_subtype',
  text: 'synthetic private message content',
  blocks: [{ type: 'section', text: { type: 'plain_text', text: 'synthetic' } }],
  isEdited: true,
  editedAt: new Date('2026-07-25T00:01:00.000Z'),
  hasFiles: true,
  reactions: [{ name: 'eyes', count: 1, userIds: ['U-SYNTHETIC'] }],
  mentionedUserIds: ['U-OTHER'],
  teamId: 'T-SYNTHETIC',
};

const forbiddenMessageKeys = [
  'text', 'blocks', 'reactions', 'mentionedUserIds', 'authorName', 'botId',
  'subtype', 'files', 'hasFiles', 'isEdited', 'editedAt', 'edited',
];

describe('privacy-first message persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    slackMessageCache.clear();
    mocks.conversationUpsert.mockResolvedValue({});
    mocks.userUpsert.mockResolvedValue({});
    mocks.messageCreate.mockResolvedValue({});
    mocks.messageUpdate.mockResolvedValue({});
    mocks.messageUpsert.mockResolvedValue({ id: 'message-synthetic' });
  });

  it('omits Slack content and metadata from the create persistence object', async () => {
    mocks.messageFindUnique.mockResolvedValue(null);
    await upsertMessage(message, 'EVENT', 'U-OTHER');

    const data = mocks.messageCreate.mock.calls[0]?.[0].data;
    expect(data).toEqual({
      conversationId: message.conversationId,
      ts: message.ts,
      source: 'EVENT',
      sentAt: message.sentAt,
      threadTs: null,
      userId: message.userId,
      isContent: true,
      mentionsAuthedUser: true,
    });
    for (const key of forbiddenMessageKeys) expect(data).not.toHaveProperty(key);
  });

  it('omits Slack content and metadata from the update persistence object', async () => {
    mocks.messageFindUnique.mockResolvedValue({ id: 'message-synthetic' });
    await upsertMessage(message, 'EVENT', 'U-OTHER');

    const data = mocks.messageUpdate.mock.calls[0]?.[0].data;
    expect(data).toEqual({ sentAt: message.sentAt, threadTs: null, userId: message.userId, isContent: true, mentionsAuthedUser: true });
    for (const key of forbiddenMessageKeys) expect(data).not.toHaveProperty(key);
  });

  it('evicts cache immediately and performs only privacy-safe deletion updates', async () => {
    const key = messageCacheKey(message.conversationId, message.ts);
    slackMessageCache.set(key, {
      raw: { type: 'message', ts: message.ts, text: message.text },
      revisionMs: 0,
    });
    let releaseTransaction: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    mocks.transaction.mockImplementation(async (callback) => {
      await gate;
      return callback({
        conversation: { upsert: mocks.conversationUpsert },
        message: { findUnique: mocks.messageFindUnique, upsert: mocks.messageUpsert },
        classification: { deleteMany: mocks.classificationDeleteMany },
        messageState: { updateMany: mocks.messageStateUpdateMany },
        $queryRaw: vi.fn(),
      });
    });
    mocks.messageFindUnique.mockResolvedValue({ id: 'message-synthetic' });
    const deletedAt = new Date('2026-07-25T01:00:00.000Z');

    const pendingDeletion = markMessageDeleted(message.conversationId, message.ts, deletedAt);
    expect(slackMessageCache.get(key)).toBeUndefined();
    releaseTransaction?.();
    await expect(pendingDeletion).resolves.toBe(true);

    expect(mocks.classificationDeleteMany).toHaveBeenCalledWith({
      where: { messageId: 'message-synthetic' },
    });
    const stateData = mocks.messageStateUpdateMany.mock.calls[0]?.[0].data;
    expect(stateData).toEqual({ isWaitingOn: false, waitingOnSince: null });
    expect(stateData).not.toHaveProperty('isDone');
    expect(stateData).not.toHaveProperty('doneAt');
    expect(stateData).not.toHaveProperty('snoozedUntil');
    expect(mocks.messageUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ isDeleted: true, sentAt: new Date('2026-07-25T17:20:00.000Z') }),
      update: { isDeleted: true, deletedAt },
    }));
  });
});

/**
 * `mergeReaction` is the reaction half of idempotency: Socket Mode can deliver
 * the same `reaction_added` more than once (redelivery after a slow ack, or a
 * second installation's authorization), and the stored count must not drift.
 */
describe('mergeReaction', () => {
  it('adds the first reaction to a message that had none', () => {
    expect(
      mergeReaction(null, { name: 'eyes', userId: 'U1', added: true }),
    ).toEqual([{ name: 'eyes', count: 1, userIds: ['U1'] }]);
  });

  it('adds a second user to an existing reaction', () => {
    expect(
      mergeReaction([{ name: 'eyes', count: 1, userIds: ['U1'] }], {
        name: 'eyes',
        userId: 'U2',
        added: true,
      }),
    ).toEqual([{ name: 'eyes', count: 2, userIds: ['U1', 'U2'] }]);
  });

  it('is idempotent — a duplicate delivery does not double-count', () => {
    const once = mergeReaction(null, {
      name: 'eyes',
      userId: 'U1',
      added: true,
    });
    const twice = mergeReaction(once, {
      name: 'eyes',
      userId: 'U1',
      added: true,
    });
    expect(twice).toEqual([{ name: 'eyes', count: 1, userIds: ['U1'] }]);
  });

  it('removes a user and recounts', () => {
    expect(
      mergeReaction([{ name: 'eyes', count: 2, userIds: ['U1', 'U2'] }], {
        name: 'eyes',
        userId: 'U1',
        added: false,
      }),
    ).toEqual([{ name: 'eyes', count: 1, userIds: ['U2'] }]);
  });

  it('drops a reaction entirely once its last user removes it', () => {
    expect(
      mergeReaction([{ name: 'eyes', count: 1, userIds: ['U1'] }], {
        name: 'eyes',
        userId: 'U1',
        added: false,
      }),
    ).toBeNull();
  });

  it('ignores a removal for a reaction we never had', () => {
    expect(
      mergeReaction([{ name: 'eyes', count: 1, userIds: ['U1'] }], {
        name: 'tada',
        userId: 'U9',
        added: false,
      }),
    ).toEqual([{ name: 'eyes', count: 1, userIds: ['U1'] }]);
  });

  it('keeps the list sorted by name, matching normalizeMessage’s ordering', () => {
    const result = mergeReaction(
      [{ name: 'zap', count: 1, userIds: ['U1'] }],
      { name: 'apple', userId: 'U1', added: true },
    );
    expect(result?.map((reaction) => reaction.name)).toEqual(['apple', 'zap']);
  });

  it('does not mutate the input array', () => {
    const current = [{ name: 'eyes', count: 1, userIds: ['U1'] }];
    mergeReaction(current, { name: 'eyes', userId: 'U2', added: true });
    expect(current).toEqual([{ name: 'eyes', count: 1, userIds: ['U1'] }]);
  });
});
