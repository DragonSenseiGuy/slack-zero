import { prisma } from '@/lib/db';
import { isDemoMode } from '@/lib/demo/workspace';

/**
 * Demo mode signs a visitor in without Slack. That is only ever acceptable on
 * a database with no real Slack installation in it — otherwise flipping one
 * environment variable would hand an anonymous visitor the owner's queue,
 * which is exactly the hole Phase 10 was written to close.
 *
 * So: demo mode is available only when `SLACKZERO_DEMO=1` *and* no
 * installation has ever been stored. Point `DATABASE_URL` at a throwaway
 * database (see README, "Demo mode") rather than reusing a connected one.
 */
export class DemoUnavailableError extends Error {
  constructor(readonly reason: 'disabled' | 'real_installation') {
    super(
      reason === 'disabled'
        ? 'Demo mode is off. Start the app with SLACKZERO_DEMO=1.'
        : 'Refusing to run demo mode: this database holds a real Slack ' +
            'installation. Use a separate DATABASE_URL for the demo.',
    );
    this.name = 'DemoUnavailableError';
  }
}

/** True when demo mode is on and safe to use on this database. */
export async function isDemoAvailable(): Promise<boolean> {
  if (!isDemoMode()) return false;
  const installations = await prisma.slackInstallation.count();
  return installations === 0;
}

/** @throws {DemoUnavailableError} */
export async function requireDemoAvailable(): Promise<void> {
  if (!isDemoMode()) throw new DemoUnavailableError('disabled');
  const installations = await prisma.slackInstallation.count();
  if (installations > 0) throw new DemoUnavailableError('real_installation');
}
