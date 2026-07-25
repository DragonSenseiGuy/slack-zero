import { expect, test } from '@playwright/test';

/**
 * Phase 0 smoke test: the app boots, the home page offers a way to connect
 * Slack, and the health endpoint reports a live database.
 */

test('home page renders the setup screen in whichever connection state applies', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'SlackZero' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Slack', exact: true }),
  ).toBeVisible();

  // This used to assert "Not connected yet." unconditionally, which stopped
  // being true the moment Phase 0's OAuth round-trip stored an installation —
  // the test passed only against an empty database. Assert the invariant that
  // actually holds instead: the page renders exactly one of the two states,
  // and offers the action matching it.
  const notConnected = page.getByText('Not connected yet.');
  const isConnected = (await notConnected.count()) === 0;

  await expect(
    page.getByRole('link', {
      name: isConnected ? 'Reconnect Slack' : 'Connect Slack',
      exact: true,
    }),
  ).toBeVisible();
});

test('health page reports database status', async ({ page }) => {
  await page.goto('/health');
  await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Database' })).toBeVisible();
});

test('/api/health returns 200 with a db check', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(body.checks.db.status).toBe('ok');
});
