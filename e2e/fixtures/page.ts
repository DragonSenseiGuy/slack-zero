import { expect, type Page } from '@playwright/test';

import { FIXTURE_CHANNEL_ID, FIXTURE_CHANNEL_NAME } from './seed';

/**
 * Page helpers shared by every inbox spec.
 *
 * These used to be copy-pasted into each file and drove the queue's scope
 * through the `⌘K` command palette. The palette was removed (it duplicated
 * saved views and nobody used it), so scoping now goes through the `?in=` URL
 * parameter instead — same guarantee, one navigation instead of four
 * interactions, and no dependency on a UI surface that no longer exists.
 */

/** Load the inbox and wait for hydration — before it, keystrokes are dropped. */
export async function loadInbox(
  page: Page,
  options: { scopeToFixtures?: boolean } = {},
): Promise<void> {
  await page.goto(
    options.scopeToFixtures
      ? `/inbox?in=${encodeURIComponent(FIXTURE_CHANNEL_ID)}`
      : '/inbox',
  );
  await expect(page.getByTestId('queue-pane')).toHaveAttribute(
    'data-hydrated',
    'true',
  );

  if (options.scopeToFixtures) {
    // The chip is the proof the scope resolved. Without this assertion a
    // renamed or unseeded channel would silently widen the queue to the whole
    // workspace and every count below would be measuring real traffic.
    await expect(page.getByTestId('scope-chip')).toContainText(
      FIXTURE_CHANNEL_NAME,
    );
  }
}

/** Load the inbox already narrowed to the seeded fixture channel. */
export async function loadScopedInbox(page: Page): Promise<void> {
  await loadInbox(page, { scopeToFixtures: true });
}

/**
 * Press `s` until the queue is in newest-first order.
 *
 * Written as a loop rather than a fixed number of presses because `s` now
 * cycles through every sort a view can specify, and the starting point is
 * whatever the active view asked for — so "press it twice" would break the day
 * a built-in view changed its default order.
 */
export async function pinSortToNewest(page: Page): Promise<void> {
  const pane = page.getByTestId('queue-pane');

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await pane.getAttribute('data-sort-mode')) === 'newest') return;
    await page.keyboard.press('s');
  }

  await expect(pane).toHaveAttribute('data-sort-mode', 'newest');
}
