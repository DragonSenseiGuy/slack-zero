import { expect, test, type Page } from '@playwright/test';

import {
  clearInboxFixtures,
  disconnectFixtures,
  getAuthedUserId,
  seedInboxFixtures,
  FIXTURE_CHANNEL_NAME,
  FIXTURE_ITEM_COUNT,
} from './fixtures/seed';

/**
 * Phase 6, the database-backed half.
 *
 * The scheduling rules themselves are unit tested in
 * `src/lib/snooze/schedule.test.ts` — plan.md's Phase 6 verification is three
 * unit-test items, and those pass there without a browser. What that cannot
 * cover is the round trip: does snoozing actually remove the row from the queue,
 * and does it stay gone across a reload? That is what this file checks.
 */

test.describe.configure({ mode: 'serial' });

let authedUserId: string | null = null;

test.beforeAll(async () => {
  authedUserId = await getAuthedUserId();
});

test.beforeEach(async () => {
  test.skip(
    authedUserId === null,
    'No Slack installation in the database. Run the OAuth flow first.',
  );
  await seedInboxFixtures(authedUserId as string);
});

test.afterAll(async () => {
  if (authedUserId) await clearInboxFixtures();
  await disconnectFixtures();
});

async function loadInbox(page: Page) {
  await page.goto('/inbox');
  await expect(page.getByTestId('queue-pane')).toHaveAttribute(
    'data-hydrated',
    'true',
  );
}

async function scopeToFixtures(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('command-palette-input').fill(FIXTURE_CHANNEL_NAME);
  await expect(page.getByTestId('command-palette-result')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('scope-chip')).toContainText(
    FIXTURE_CHANNEL_NAME,
  );
}

async function openScopedInbox(page: Page) {
  await loadInbox(page);
  await scopeToFixtures(page);
  await expect(page.getByTestId('queue-item')).toHaveCount(FIXTURE_ITEM_COUNT);
}

test('h opens the snooze picker', async ({ page }) => {
  await openScopedInbox(page);

  await page.keyboard.press('h');
  await expect(page.getByTestId('snooze-menu')).toBeVisible();

  // Esc closes it without snoozing anything.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('snooze-menu')).toBeHidden();
  await expect(page.getByTestId('queue-item')).toHaveCount(FIXTURE_ITEM_COUNT);
});

test('snoozing removes the item from the queue and it stays gone after a reload', async ({
  page,
}) => {
  await openScopedInbox(page);

  const target = page.getByTestId('queue-item').first();
  const messageId = await target.getAttribute('data-message-id');
  expect(messageId).toBeTruthy();

  await page.keyboard.press('h');
  await expect(page.getByTestId('snooze-menu')).toBeVisible();
  await page.getByTestId('snooze-tomorrow').click();

  await expect(page.getByTestId('snooze-menu')).toBeHidden();

  // Gone from the queue.
  await expect(page.getByTestId('queue-item')).toHaveCount(
    FIXTURE_ITEM_COUNT - 1,
  );
  await expect(
    page.locator(`[data-testid="queue-item"][data-message-id="${messageId}"]`),
  ).toHaveCount(0);

  // Still gone after a full reload — it was stored, not just hidden locally.
  await loadInbox(page);
  await scopeToFixtures(page);
  await expect(page.getByTestId('queue-item')).toHaveCount(
    FIXTURE_ITEM_COUNT - 1,
  );
  await expect(
    page.locator(`[data-testid="queue-item"][data-message-id="${messageId}"]`),
  ).toHaveCount(0);
});

test('a custom snooze in the past is refused with a reason', async ({ page }) => {
  await openScopedInbox(page);

  await page.keyboard.press('h');
  await expect(page.getByTestId('snooze-menu')).toBeVisible();

  // Accepting this would reinject on the very next sweep, which looks like the
  // feature silently failing.
  await page.getByTestId('snooze-custom-input').fill('2020-01-01T09:00');
  await page.getByTestId('snooze-custom-submit').click();

  await expect(page.getByTestId('snooze-error')).toContainText('future');
  // The picker stays open and nothing left the queue.
  await expect(page.getByTestId('snooze-menu')).toBeVisible();
  await expect(page.getByTestId('queue-item')).toHaveCount(FIXTURE_ITEM_COUNT);
});

test('a snoozed item is not counted as done', async ({ page }) => {
  // Snooze and done are different states: "not now" is not "handled". Showing
  // done items must not resurrect a snoozed one.
  await openScopedInbox(page);

  await page.keyboard.press('h');
  await page.getByTestId('snooze-tomorrow').click();
  await expect(page.getByTestId('queue-item')).toHaveCount(
    FIXTURE_ITEM_COUNT - 1,
  );

  await page.getByTestId('toggle-show-done').click();
  await expect(page.getByTestId('queue-item')).toHaveCount(
    FIXTURE_ITEM_COUNT - 1,
  );
});

test('the Waiting on Others view exists and is empty for these fixtures', async ({
  page,
}) => {
  // The fixtures are all messages *from* someone else, so there is nothing the
  // user is waiting on. An empty view here is the correct answer, and asserting
  // it catches a detector that flags inbound messages by mistake.
  await loadInbox(page);

  await expect(page.getByTestId('view-Waiting on Others')).toBeVisible();
  await page.getByTestId('view-Waiting on Others').click();

  await expect(page.getByTestId('queue-pane')).toHaveAttribute(
    'data-active-view',
    'Waiting on Others',
  );
  await expect(page.getByTestId('queue-empty')).toBeVisible();
});
