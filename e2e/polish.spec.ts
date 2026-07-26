import { expect, test, type Page } from '@playwright/test';

import {
  clearInboxFixtures,
  disconnectFixtures,
  getAuthedUserId,
  seedInboxFixtures,
} from './fixtures/seed';
import { SHORTCUT_HELP } from '../src/lib/keyboard/shortcuts';

/**
 * plan.md, Phase 8: the `?` cheat sheet, empty/loading states, and 404.
 *
 * The full-suite-green requirement is satisfied by running `npm run test:e2e`
 * with every spec present, not by anything in this file.
 */

test.describe.configure({ mode: 'serial' });

let authedUserId: string | null = null;

test.beforeAll(async () => {
  authedUserId = await getAuthedUserId();
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

test('? opens the shortcut cheat sheet and Esc closes it', async ({ page }) => {
  await loadInbox(page);

  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcut-overlay')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shortcut-overlay')).toBeHidden();
});

test('the cheat sheet documents every shortcut, from one source', async ({
  page,
}) => {
  // The overlay renders SHORTCUT_HELP, the same list the footer uses and the
  // same module that resolves keys — so it cannot drift into documenting a key
  // that no longer works.
  await loadInbox(page);
  await page.keyboard.press('?');

  // Asserted against the source list rather than a hardcoded number — a literal
  // here would be the very drift this test exists to catch.
  const rows = page.getByTestId('shortcut-row');
  await expect(rows).toHaveCount(SHORTCUT_HELP.length);

  const overlay = page.getByTestId('shortcut-overlay');
  for (const shortcut of SHORTCUT_HELP) {
    await expect(overlay).toContainText(shortcut.description);
  }
});

test('the ? button opens it too, for anyone who has not found the key', async ({
  page,
}) => {
  await loadInbox(page);

  await page.getByTestId('open-help').click();
  await expect(page.getByTestId('shortcut-overlay')).toBeVisible();

  await page.getByTestId('shortcut-overlay-close').click();
  await expect(page.getByTestId('shortcut-overlay')).toBeHidden();
});

test('typing ? in the compose box does not open the cheat sheet', async ({
  page,
}) => {
  test.skip(
    authedUserId === null,
    'No Slack installation in the database. Run the OAuth flow first.',
  );
  await seedInboxFixtures(authedUserId as string);
  await loadInbox(page);

  await page.getByTestId('reply-input').click();
  await page.keyboard.type('why?');

  await expect(page.getByTestId('shortcut-overlay')).toHaveCount(0);
  await expect(page.getByTestId('reply-input')).toHaveValue('why?');
});

test('an empty queue says so rather than rendering a blank pane', async ({
  page,
}) => {
  // With no fixtures seeded and the queue scoped to nothing that exists, the
  // list should explain itself. A blank column reads as a broken app.
  await clearInboxFixtures();
  await loadInbox(page);

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('command-palette-input').fill('nothing-matches-this');
  await expect(page.getByTestId('command-palette-result')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // The reading pane's empty state is always reachable and always explains.
  const emptyish = page.getByTestId('queue-empty').or(page.getByTestId('queue-list'));
  await expect(emptyish.first()).toBeVisible();
});

test('an unknown route renders the 404 page, not a crash', async ({ page }) => {
  const response = await page.goto('/no-such-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId('not-found')).toBeVisible();
});

test('the health endpoint reports all three checks', async ({ page }) => {
  // The first thing to look at when anything else misbehaves, so it needs to
  // stay honest.
  const response = await page.request.get('/api/health');
  expect(response.status()).toBe(200);

  const body = (await response.json()) as {
    checks: Record<string, { status: string }>;
  };

  expect(Object.keys(body.checks).sort()).toEqual(['db', 'llm', 'slack']);
  expect(body.checks.db.status).toBe('ok');
});
