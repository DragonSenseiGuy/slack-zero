import { expect, test, type Page } from '@playwright/test';

import {
  clearInboxFixtures,
  disconnectFixtures,
  getAuthedUserId,
  seedInboxFixtures,
  FIXTURE_CHANNEL_NAME,
} from './fixtures/seed';

/**
 * plan.md, Phase 7 verification: "Playwright check that dashboard renders with
 * real data without errors."
 *
 * The arithmetic is unit tested against known timestamps in
 * `src/lib/stats/compute.test.ts`. What this adds is the half that cannot be
 * unit tested: the page reads the actual database, renders, and does not throw —
 * including on a database where nothing has been triaged yet, which is the state
 * a fresh install is in and the easiest one to render wrong.
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

/** Fail the test on any console error or uncaught page exception. */
function watchForErrors(page: Page): string[] {
  const problems: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    problems.push(`pageerror: ${error.message}`);
  });

  return problems;
}

test('the dashboard renders against the real database without errors', async ({
  page,
}) => {
  const problems = watchForErrors(page);

  const response = await page.goto('/stats');
  expect(response?.status()).toBe(200);

  await expect(page.getByTestId('stats-page')).toBeVisible();
  await expect(page.getByTestId('stats-error')).toHaveCount(0);

  // The headline tiles are present and hold something renderable.
  for (const testId of ['stat-open-total', 'stat-waiting-on', 'stat-streak']) {
    await expect(page.getByTestId(testId)).toBeVisible();
    await expect(page.getByTestId(testId)).not.toBeEmpty();
  }

  // Both summary windows.
  await expect(page.getByTestId('summary-day')).toBeVisible();
  await expect(page.getByTestId('summary-week')).toBeVisible();

  expect(problems).toEqual([]);
});

test('renders sensibly when nothing has been triaged yet', async ({ page }) => {
  // The state a fresh install is in, and the easiest one to get wrong: a zero
  // response time would claim an instant turnaround. It must read as "no data".
  const problems = watchForErrors(page);

  await page.goto('/stats');

  const median = page.getByTestId('summary-day-median');
  await expect(median).toBeVisible();

  const text = (await median.textContent()) ?? '';
  // Either a real duration, or an em dash — never "0s" or "NaN".
  expect(text).not.toContain('NaN');
  expect(text).not.toMatch(/\b0s\b/);

  expect(problems).toEqual([]);
});

test('the daily series always has one bar per day, including quiet days', async ({
  page,
}) => {
  // A gap would read as missing data; a zero-height bar reads as a quiet day.
  await page.goto('/stats');

  const days = page.getByTestId('stats-series-day');
  await expect(days).toHaveCount(14);

  // Every bar carries its date and count, so the chart is inspectable.
  const first = days.first();
  await expect(first).toHaveAttribute('data-date', /^\d{4}-\d{2}-\d{2}$/);
  await expect(first).toHaveAttribute('data-triaged', /^\d+$/);
});

test('numbers move when an item is actually triaged', async ({ page }) => {
  // The strongest check available without waiting a day: mark a seeded item
  // done in the inbox, then confirm the dashboard counts it. This is what makes
  // the page a measurement rather than a static layout.
  test.skip(
    authedUserId === null,
    'No Slack installation in the database. Run the OAuth flow first.',
  );
  await seedInboxFixtures(authedUserId as string);

  await page.goto('/stats');
  const before = Number(
    (await page.getByTestId('summary-day-triaged').textContent())?.match(
      /\d+/,
    )?.[0] ?? '0',
  );

  // Triage one item.
  await page.goto('/inbox');
  await expect(page.getByTestId('queue-pane')).toHaveAttribute(
    'data-hydrated',
    'true',
  );
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('command-palette-input').fill(FIXTURE_CHANNEL_NAME);
  await expect(page.getByTestId('command-palette-result')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('scope-chip')).toBeVisible();

  await page.keyboard.press('e');
  // Wait for the server to confirm, not the optimistic update.
  await expect(page.getByTestId('queue-pane')).toHaveAttribute(
    'data-confirmed-saves',
    '1',
  );

  await page.goto('/stats');
  const after = Number(
    (await page.getByTestId('summary-day-triaged').textContent())?.match(
      /\d+/,
    )?.[0] ?? '0',
  );

  expect(after).toBe(before + 1);

  // And a response time now exists where there may have been none.
  await expect(page.getByTestId('summary-day-median')).not.toContainText('NaN');
});

test('the inbox links to the dashboard', async ({ page }) => {
  await page.goto('/inbox');
  await expect(page.getByTestId('stats-link')).toBeVisible();
  await page.getByTestId('stats-link').click();
  await expect(page.getByTestId('stats-page')).toBeVisible();
});
