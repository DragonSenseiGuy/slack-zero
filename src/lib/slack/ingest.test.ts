import { describe, expect, it, vi } from 'vitest';

import { mergeReaction } from '@/lib/slack/ingest';

// `ingest.ts` constructs nothing at import time except the Prisma singleton,
// which would still want a DATABASE_URL. Stub it so this file stays a pure
// unit test with no database (CLAUDE.md: unit tests must not need live
// infrastructure). `vi.mock` is hoisted above the import above.
vi.mock('@/lib/db', () => ({ prisma: {} }));

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
