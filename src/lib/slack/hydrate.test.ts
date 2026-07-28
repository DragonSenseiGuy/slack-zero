import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hydrateStubUsers, resetHydrationAttempts } from '@/lib/slack/hydrate';

/**
 * `hydrate.ts` is the fix for raw `U0…` ids showing up as sender names: a
 * message from someone who joined after the last backfill leaves a nameless
 * stub `User` row, and this module resolves it with `users.info`.
 *
 * Prisma and `upsertUser` are stubbed so this stays a pure unit test with no
 * database (CLAUDE.md). `vi.mock` is hoisted above the imports.
 */

const findMany = vi.fn();
const upsertUser = vi.fn();

vi.mock('@/lib/db', () => ({ prisma: { user: { findMany: (...a: unknown[]) => findMany(...a) } } }));
vi.mock('@/lib/slack/ingest', () => ({
  upsertUser: (...a: unknown[]) => upsertUser(...a),
}));

function clientReturning(user: unknown) {
  const info = vi.fn().mockResolvedValue({ ok: true, user });
  // The real `WebClient` has far more surface than hydration touches; only
  // `users.info` is exercised, so cast rather than build a full fake.
  return { info, client: { users: { info } } as never };
}

describe('hydrateStubUsers', () => {
  beforeEach(() => {
    resetHydrationAttempts();
    findMany.mockReset();
    upsertUser.mockReset();
  });

  it('resolves a stub row and stores the profile', async () => {
    findMany.mockResolvedValue([{ id: 'U0BKUQN94AZ' }]);
    const { info, client } = clientReturning({
      id: 'U0BKUQN94AZ',
      name: 'ada',
      profile: { real_name: 'Ada Lovelace', display_name: 'ada' },
    });

    const filled = await hydrateStubUsers(['U0BKUQN94AZ'], { client });

    expect(filled).toBe(1);
    expect(info).toHaveBeenCalledWith({ user: 'U0BKUQN94AZ' });
    expect(upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'U0BKUQN94AZ', displayName: 'ada' }),
    );
  });

  it('leaves users that already have a name alone', async () => {
    // A non-stub id is filtered out by the query, so nothing comes back.
    findMany.mockResolvedValue([]);
    const { info, client } = clientReturning({ id: 'U1' });

    expect(await hydrateStubUsers(['U1'], { client })).toBe(0);
    expect(info).not.toHaveBeenCalled();
  });

  it('only calls users.info once per id, even if the user keeps talking', async () => {
    findMany.mockResolvedValue([{ id: 'U2' }]);
    const { info, client } = clientReturning({ id: 'U2', name: 'bob' });

    await hydrateStubUsers(['U2'], { client });
    await hydrateStubUsers(['U2'], { client });

    expect(info).toHaveBeenCalledTimes(1);
  });

  it('swallows a Slack error so ingestion is never blocked', async () => {
    findMany.mockResolvedValue([{ id: 'U3' }]);
    const info = vi.fn().mockRejectedValue(
      Object.assign(new Error('slack'), { data: { error: 'user_not_found' } }),
    );
    const logs: string[] = [];

    const filled = await hydrateStubUsers(['U3'], {
      client: { users: { info } } as never,
      onLog: (m) => logs.push(m),
    });

    expect(filled).toBe(0);
    expect(logs.join('\n')).toContain('user_not_found');
  });

  it('does nothing when given no ids', async () => {
    expect(await hydrateStubUsers([])).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
