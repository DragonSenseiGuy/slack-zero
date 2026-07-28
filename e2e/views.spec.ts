import { expect, test, type Page } from '@playwright/test';

import {
  clearInboxFixtures,
  disconnectFixtures,
  getAuthedUserId,
  seedInboxFixtures,
  setFixtureSenderVip,
  E2E_VIEW_PREFIX,
  FIXTURE_ACTION_NEEDED_COUNT,
  FIXTURE_CHANNEL_NAME,
  FIXTURE_FYI_MISC_COUNT,
  FIXTURE_ITEM_COUNT,
} from './fixtures/seed';
import { loadInbox, loadScopedInbox } from './fixtures/page';

/**
 * Phase 4 verification (plan.md): create a custom view with 2 filters, save,
 * reload the app, confirm the view persists and filters correctly.
 *
 * Same robustness rules as the Phase 2 suite: everything is asserted against
 * seeded fixtures in an id namespace that cannot collide with real Slack ids,
 * and the queue is scoped to the fixture channel first so counts do not depend
 * on how much real traffic the workspace has. Views created here are prefixed
 * (`E2E ...`) so cleanup deletes exactly the suite's rows.
 *
 * The fixtures carry *seeded* classifications rather than model output — a
 * Playwright run must not depend on the live proxy, and this suite is about
 * whether filters select the right subset, not about model quality.
 */

test.describe.configure({ mode: 'serial' });

const CUSTOM_VIEW = `${E2E_VIEW_PREFIX}Blocked on me`;

let authedUserId: string | null = null;

test.beforeAll(async () => {
  authedUserId = await getAuthedUserId();
});

test.beforeEach(async () => {
  test.skip(
    authedUserId === null,
    'No Slack installation in the database. Run the OAuth flow (SLACK_APP_SETUP.md) before the views e2e suite.',
  );
  await seedInboxFixtures(authedUserId as string);
  await setFixtureSenderVip(false);
});

test.afterAll(async () => {
  if (authedUserId) await clearInboxFixtures();
  await disconnectFixtures();
});

async function openScopedInbox(page: Page) {
  await loadScopedInbox(page);
}

function rows(page: Page) {
  return page.getByTestId('queue-item');
}

// ---------------------------------------------------------------------------
// Built-in views
// ---------------------------------------------------------------------------

test('the three built-in views are present and filter correctly', async ({
  page,
}) => {
  await openScopedInbox(page);

  const sidebar = page.getByTestId('view-sidebar');
  await expect(sidebar).toBeVisible();

  // plan.md names these three as shipped out of the box.
  await expect(page.getByTestId('view-Needs Reply')).toBeVisible();
  await expect(page.getByTestId('view-Waiting Room')).toBeVisible();
  await expect(page.getByTestId('view-Everything')).toBeVisible();

  // "Everything" is the default and shows every scoped fixture row.
  await expect(page.getByTestId('queue-pane')).toHaveAttribute(
    'data-active-view',
    'Everything',
  );
  await expect(rows(page)).toHaveCount(FIXTURE_ITEM_COUNT);

  // "Needs Reply" is action_needed only.
  await page.getByTestId('view-Needs Reply').click();
  await expect(page.getByTestId('queue-pane')).toHaveAttribute(
    'data-active-view',
    'Needs Reply',
  );
  await expect(rows(page)).toHaveCount(FIXTURE_ACTION_NEEDED_COUNT);

  // "Waiting Room" is the fyi/misc pile, and uses the dense layout.
  await page.getByTestId('view-Waiting Room').click();
  await expect(rows(page)).toHaveCount(FIXTURE_FYI_MISC_COUNT);
  await expect(page.getByTestId('queue-list')).toHaveAttribute(
    'data-layout',
    'dense',
  );
});

test('switching views does not reload the page', async ({ page }) => {
  await openScopedInbox(page);

  // If a view switch navigated, this marker would be wiped.
  await page.evaluate(() => {
    (window as unknown as { __noReload?: boolean }).__noReload = true;
  });

  await page.getByTestId('view-Needs Reply').click();
  await expect(rows(page)).toHaveCount(FIXTURE_ACTION_NEEDED_COUNT);

  const survived = await page.evaluate(
    () => (window as unknown as { __noReload?: boolean }).__noReload === true,
  );
  expect(survived).toBe(true);

  // The scope chip surviving is the user-visible half of the same claim: a
  // reload would drop it and widen the queue back out.
  await expect(page.getByTestId('scope-chip')).toContainText(
    FIXTURE_CHANNEL_NAME,
  );
});

// ---------------------------------------------------------------------------
// The Phase 4 verification proper
// ---------------------------------------------------------------------------

test('a custom view with 2 filters saves, survives a reload, and filters correctly', async ({
  page,
}) => {
  // One of the two filters is VIP, so make the fixture sender a VIP.
  await setFixtureSenderVip(true);

  await openScopedInbox(page);

  await page.getByTestId('new-view').click();
  await expect(page.getByTestId('view-builder')).toBeVisible();

  await page.getByTestId('view-name').fill(CUSTOM_VIEW);

  // Filter 1: category = action_needed.
  await page.getByTestId('filter-category-action_needed').click();
  // Filter 2: VIP only.
  await page.getByTestId('filter-vipOnly').check();

  await page.getByTestId('view-sort').selectOption('urgency');
  await page.getByTestId('save-view').click();

  // Saved: the dialog closes and the new view becomes active.
  await expect(page.getByTestId('view-builder')).toBeHidden();
  await expect(page.getByTestId(`view-${CUSTOM_VIEW}`)).toBeVisible();
  await expect(page.getByTestId('queue-pane')).toHaveAttribute(
    'data-active-view',
    CUSTOM_VIEW,
  );

  // ---- the reload is the point of this test ----
  await loadScopedInbox(page);

  // The view persisted across a full page load, from the database.
  await expect(page.getByTestId(`view-${CUSTOM_VIEW}`)).toBeVisible();

  await page.getByTestId(`view-${CUSTOM_VIEW}`).click();

  // And it still filters: action_needed AND from a VIP.
  await expect(rows(page)).toHaveCount(FIXTURE_ACTION_NEEDED_COUNT);

  // The filters really are ANDed — dropping VIP status must empty the view,
  // which no single-filter view would do.
  await setFixtureSenderVip(false);
  await loadScopedInbox(page);
  await page.getByTestId(`view-${CUSTOM_VIEW}`).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId('queue-empty')).toBeVisible();
});

test('a saved view can be edited and the change persists', async ({ page }) => {
  await setFixtureSenderVip(true);
  await openScopedInbox(page);

  await page.getByTestId('new-view').click();
  await page.getByTestId('view-name').fill(CUSTOM_VIEW);
  await page.getByTestId('filter-category-action_needed').click();
  await page.getByTestId('filter-vipOnly').check();
  await page.getByTestId('save-view').click();
  await expect(page.getByTestId('view-builder')).toBeHidden();

  // Widen it: fyi/misc instead of action_needed.
  await page.getByTestId(`edit-view-${CUSTOM_VIEW}`).click();
  await expect(page.getByTestId('view-builder')).toBeVisible();
  await page.getByTestId('filter-category-action_needed').click(); // off
  await page.getByTestId('filter-category-fyi').click();
  await page.getByTestId('filter-category-misc').click();
  await page.getByTestId('save-view').click();
  await expect(page.getByTestId('view-builder')).toBeHidden();

  await loadScopedInbox(page);
  await page.getByTestId(`view-${CUSTOM_VIEW}`).click();
  await expect(rows(page)).toHaveCount(FIXTURE_FYI_MISC_COUNT);
});

test('a custom view can be deleted; a built-in cannot', async ({ page }) => {
  await openScopedInbox(page);

  await page.getByTestId('new-view').click();
  await page.getByTestId('view-name').fill(CUSTOM_VIEW);
  await page.getByTestId('filter-category-misc').click();
  await page.getByTestId('save-view').click();
  await expect(page.getByTestId(`view-${CUSTOM_VIEW}`)).toBeVisible();

  await page.getByTestId(`edit-view-${CUSTOM_VIEW}`).click();
  await page.getByTestId('delete-view').click();

  await expect(page.getByTestId('view-builder')).toBeHidden();
  await expect(page.getByTestId(`view-${CUSTOM_VIEW}`)).toBeHidden();

  // Gone from the database too, not just from client state.
  await loadInbox(page);
  await expect(page.getByTestId(`view-${CUSTOM_VIEW}`)).toBeHidden();

  // A built-in offers no delete button — it would be re-seeded, so "deleting"
  // it would appear to work and then undo itself.
  await page.getByTestId('edit-view-Everything').click();
  await expect(page.getByTestId('view-builder')).toBeVisible();
  await expect(page.getByTestId('delete-view')).toHaveCount(0);
});

test('a duplicate view name is refused with a reason, not silently', async ({
  page,
}) => {
  await openScopedInbox(page);

  await page.getByTestId('new-view').click();
  await page.getByTestId('view-name').fill(CUSTOM_VIEW);
  await page.getByTestId('filter-category-misc').click();
  await page.getByTestId('save-view').click();
  await expect(page.getByTestId('view-builder')).toBeHidden();

  await page.getByTestId('new-view').click();
  await page.getByTestId('view-name').fill(CUSTOM_VIEW);
  await page.getByTestId('save-view').click();

  // The dialog stays open with the reason, so the work is not lost.
  await expect(page.getByTestId('view-builder')).toBeVisible();
  await expect(page.getByTestId('view-builder-error')).toContainText('already exists');
});

test('an unnamed view is refused', async ({ page }) => {
  await openScopedInbox(page);

  await page.getByTestId('new-view').click();
  await page.getByTestId('save-view').click();

  await expect(page.getByTestId('view-builder')).toBeVisible();
  await expect(page.getByTestId('view-builder-error')).toContainText('needs a name');
});

test('a view filtering on category excludes rows the classifier has not reached', async ({
  page,
}) => {
  // The thread parent is deliberately seeded without a Classification.
  // "Everything" must still show it — classification is async and an unrated
  // message is a normal state, not an error — while a category view must not.
  await openScopedInbox(page);

  await expect(rows(page)).toHaveCount(FIXTURE_ITEM_COUNT);

  await page.getByTestId('view-Needs Reply').click();
  await expect(rows(page)).toHaveCount(FIXTURE_ACTION_NEEDED_COUNT);

  await page.getByTestId('view-Waiting Room').click();
  await expect(rows(page)).toHaveCount(FIXTURE_FYI_MISC_COUNT);

  // action_needed + fyi + misc = 6, but Everything shows 7. The extra row is
  // the unclassified one, and it is reachable in exactly one of these views.
  expect(FIXTURE_ACTION_NEEDED_COUNT + FIXTURE_FYI_MISC_COUNT).toBe(
    FIXTURE_ITEM_COUNT - 1,
  );
});
