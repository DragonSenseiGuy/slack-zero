import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DemoUnavailableError,
  isDemoAvailable,
  requireDemoAvailable,
} from '@/lib/demo/guard';

const { count } = vi.hoisted(() => ({ count: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: { slackInstallation: { count } },
}));

beforeEach(() => {
  count.mockReset().mockResolvedValue(0);
  delete process.env.SLACKZERO_DEMO;
});

afterEach(() => {
  delete process.env.SLACKZERO_DEMO;
});

describe('demo availability', () => {
  it('is unavailable with the flag off, without even querying', async () => {
    await expect(isDemoAvailable()).resolves.toBe(false);
    expect(count).not.toHaveBeenCalled();
    await expect(requireDemoAvailable()).rejects.toBeInstanceOf(
      DemoUnavailableError,
    );
  });

  it('is available with the flag on and no installation stored', async () => {
    process.env.SLACKZERO_DEMO = '1';

    await expect(isDemoAvailable()).resolves.toBe(true);
    await expect(requireDemoAvailable()).resolves.toBeUndefined();
  });

  it('refuses on a database that holds a real Slack installation', async () => {
    // The whole point: demo mode signs a visitor in without Slack, so it must
    // never be reachable where that would hand over someone's real queue.
    process.env.SLACKZERO_DEMO = '1';
    count.mockResolvedValue(1);

    await expect(isDemoAvailable()).resolves.toBe(false);
    await expect(requireDemoAvailable()).rejects.toMatchObject({
      reason: 'real_installation',
    });
  });
});
