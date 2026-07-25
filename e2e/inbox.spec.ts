import { expect, test, type Page } from '@playwright/test';

import {
  clearInboxFixtures,
  disconnectFixtures,
  getAuthedUserId,
  seedInboxFixtures,
  FIXTURE_CHANNEL_NAME,
  FIXTURE_ITEM_COUNT,
  FIXTURE_MESSAGES,
  FIXTURE_NEWEST_TEXT,
  FIXTURE_SECOND_TEXT,
  FIXTURE_THREAD_PARENT,
  FIXTURE_THREAD_REPLIES,
  FIXTURE_USER_LABEL,
} from './fixtures/seed';

/**
 * Phase 2 verification (plan.md): load the queue, navigate with `j`/`k`, mark
 * an item done, refresh the page, confirm the done state persisted.
 *
 * Two things make this robust against a database that already holds real
 * ingested data and a live Slack installation:
 *  - every assertion is made against seeded fixtures in an id namespace that
 *    cannot collide with real Slack ids (see `fixtures/seed.ts`);
 *  - the queue is narrowed to the fixture channel through the command palette
 *    first, so counts do not depend on how much real traffic exists.
 *
 * Fixtures are re-seeded before each test (which also clears any `MessageState`
 * by cascade), so no test depends on another having run.
 */

test.describe.configure({ mode: 'serial' });

let authedUserId: string | null = null;

test.beforeAll(async () => {
  authedUserId = await getAuthedUserId();
});

test.beforeEach(async () => {
  test.skip(
    authedUserId === null,
    'No Slack installation in the database. Run the OAuth flow (SLACK_APP_SETUP.md) before the inbox e2e suite — a channel mention cannot be attributed without an authed user.',
  );
  await seedInboxFixtures(authedUserId as string);
});

test.afterAll(async () => {
  if (authedUserId) await clearInboxFixtures();
  await disconnectFixtures();
});

/** Load the inbox and wait for hydration — before it, keystrokes are dropped. */
async function loadInbox(page: Page) {
  await page.goto('/inbox');
  await expect(page.getByTestId('queue-pane')).toHaveAttribute(
    'data-hydrated',
    'true',
  );
}

/** Narrow the queue to the fixture channel via ⌘K. */
async function scopeToFixtures(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  await page.getByTestId('command-palette-input').fill(FIXTURE_CHANNEL_NAME);
  await expect(page.getByTestId('command-palette-result')).toHaveCount(1);

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-palette')).toBeHidden();
  await expect(page.getByTestId('scope-chip')).toContainText(
    FIXTURE_CHANNEL_NAME,
  );
}

async function openScopedInbox(page: Page) {
  await loadInbox(page);
  await scopeToFixtures(page);
  await expect(page.getByTestId('queue-item')).toHaveCount(FIXTURE_ITEM_COUNT);
}

function selectedRow(page: Page) {
  return page.locator('[data-testid="queue-item"][data-selected="true"]');
}

function doneRows(page: Page) {
  return page.locator('[data-testid="queue-item"][data-done="true"]');
}

/**
 * Block until the server has confirmed `count` saves.
 *
 * The done toggle is optimistic, so the list updates before anything is
 * stored. Reloading at that moment aborts the in-flight request and the write
 * is lost — which is exactly the bug this wait was added to stop the suite
 * from papering over.
 */
async function waitForSaves(page: Page, count: number) {
  await expect(page.getByTestId('queue-pane')).toHaveAttribute(
    'data-confirmed-saves',
    String(count),
  );
  await expect(page.getByTestId('queue-pane')).toHaveAttribute(
    'data-pending-saves',
    '0',
  );
}

// ---------------------------------------------------------------------------

test('the queue loads, newest first, with sender / preview / context / time', async ({
  page,
}) => {
  await openScopedInbox(page);

  const first = page.getByTestId('queue-item').first();
  await expect(first).toContainText(FIXTURE_USER_LABEL);
  await expect(first).toContainText(`#${FIXTURE_CHANNEL_NAME}`);
  await expect(first).toContainText(FIXTURE_NEWEST_TEXT);

  await expect(page.getByTestId('queue-item').nth(1)).toContainText(
    FIXTURE_SECOND_TEXT,
  );

  // Slack's mention encoding is resolved at the boundary, never shown raw.
  await expect(page.getByTestId('queue-list')).not.toContainText('<@U');
});

test('j and k move the selection and stop at the ends rather than wrapping', async ({
  page,
}) => {
  await openScopedInbox(page);

  await expect(selectedRow(page)).toContainText(FIXTURE_NEWEST_TEXT);

  await page.keyboard.press('j');
  await expect(selectedRow(page)).toContainText(FIXTURE_SECOND_TEXT);

  await page.keyboard.press('j');
  await expect(selectedRow(page)).toContainText(FIXTURE_MESSAGES[4].text);

  await page.keyboard.press('k');
  await expect(selectedRow(page)).toContainText(FIXTURE_SECOND_TEXT);

  await page.keyboard.press('k');
  await page.keyboard.press('k');
  await expect(selectedRow(page)).toContainText(FIXTURE_NEWEST_TEXT);

  for (let i = 0; i < FIXTURE_ITEM_COUNT + 3; i += 1) {
    await page.keyboard.press('j');
  }
  await expect(selectedRow(page)).toContainText(FIXTURE_MESSAGES[0].text);
  await expect(selectedRow(page)).toHaveCount(1);
});

test('Enter opens the reading pane with full content and the thread; Esc returns', async ({
  page,
}) => {
  await openScopedInbox(page);

  const pane = page.getByTestId('reading-pane');
  await expect(pane).toHaveAttribute('data-focused', 'false');

  // The pane already shows the selection — reading costs zero extra clicks.
  await expect(page.getByTestId('reading-pane-body')).toContainText(
    FIXTURE_THREAD_PARENT.text,
  );

  await page.keyboard.press('Enter');
  await expect(pane).toHaveAttribute('data-focused', 'true');

  await expect(page.getByTestId('thread-reply')).toHaveCount(
    FIXTURE_THREAD_REPLIES.length,
  );
  await expect(page.getByTestId('thread-reply').first()).toContainText(
    FIXTURE_THREAD_REPLIES[0].text,
  );

  await page.keyboard.press('Escape');
  await expect(pane).toHaveAttribute('data-focused', 'false');

  // Queue position survived opening and closing.
  await expect(selectedRow(page)).toContainText(FIXTURE_NEWEST_TEXT);
});

test('e marks an item done, it leaves the queue, and the state survives a reload', async ({
  page,
}) => {
  await openScopedInbox(page);

  // Triage the *second* item, so the assertion cannot be satisfied by an
  // off-by-one that happens to land on the default selection.
  await page.keyboard.press('j');
  await expect(selectedRow(page)).toContainText(FIXTURE_SECOND_TEXT);

  await page.keyboard.press('e');

  await expect(page.getByTestId('queue-item')).toHaveCount(
    FIXTURE_ITEM_COUNT - 1,
  );
  await expect(page.getByTestId('queue-list')).not.toContainText(
    FIXTURE_SECOND_TEXT,
  );
  await expect(page.getByTestId('inbox-error')).toHaveCount(0);

  // The cursor stayed put, so the next item slid under it — `e e e` triages a
  // run without a `j` in between.
  await expect(selectedRow(page)).toContainText(FIXTURE_MESSAGES[4].text);

  // --- the persistence check: full reload, fresh server render -------------
  await waitForSaves(page, 1);
  await loadInbox(page);
  await scopeToFixtures(page);

  await expect(page.getByTestId('queue-item')).toHaveCount(
    FIXTURE_ITEM_COUNT - 1,
  );
  await expect(page.getByTestId('queue-list')).not.toContainText(
    FIXTURE_SECOND_TEXT,
  );

  // And it really is there, flagged done, once done items are revealed.
  await page.keyboard.press('u');
  await expect(page.getByTestId('queue-item')).toHaveCount(FIXTURE_ITEM_COUNT);
  await expect(doneRows(page)).toHaveCount(1);
  await expect(doneRows(page)).toContainText(FIXTURE_SECOND_TEXT);
  await expect(doneRows(page).getByTestId('queue-item-done-badge')).toBeVisible();
});

test('done is reversible, and the undo persists too', async ({ page }) => {
  await openScopedInbox(page);

  await page.keyboard.press('e');
  await expect(page.getByTestId('queue-item')).toHaveCount(
    FIXTURE_ITEM_COUNT - 1,
  );
  await waitForSaves(page, 1);

  await page.keyboard.press('u');
  await expect(doneRows(page)).toHaveCount(1);
  await doneRows(page).getByTestId('queue-item-done-toggle').click();
  await expect(doneRows(page)).toHaveCount(0);
  await waitForSaves(page, 2);

  await loadInbox(page);
  await scopeToFixtures(page);
  await expect(page.getByTestId('inbox-error')).toHaveCount(0);
  await expect(page.getByTestId('queue-item')).toHaveCount(FIXTURE_ITEM_COUNT);
  await expect(doneRows(page)).toHaveCount(0);
});

test('Esc with nothing open clears the palette scope and widens back out', async ({
  page,
}) => {
  await openScopedInbox(page);

  const scopedCount = await page.getByTestId('queue-item').count();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);

  // The unscoped queue is a superset: the real workspace data is back too.
  expect(await page.getByTestId('queue-item').count()).toBeGreaterThanOrEqual(
    scopedCount,
  );
});

test('typing in the palette does not leak into the queue shortcuts', async ({
  page,
}) => {
  await openScopedInbox(page);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  // "jee" is next-item, mark-done, mark-done. None of it may reach the queue.
  await page
    .getByTestId('command-palette-input')
    .pressSequentially('jee', { delay: 20 });
  await expect(page.getByTestId('command-palette-input')).toHaveValue('jee');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toBeHidden();

  await expect(page.getByTestId('queue-item')).toHaveCount(FIXTURE_ITEM_COUNT);
  await expect(doneRows(page)).toHaveCount(0);
  await expect(selectedRow(page)).toContainText(FIXTURE_NEWEST_TEXT);
});
