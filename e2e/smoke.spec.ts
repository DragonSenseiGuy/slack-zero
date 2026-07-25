import { expect, test } from '@playwright/test';

/**
 * Phase 0 smoke test: the app boots, the home page offers a way to connect
 * Slack, and the health endpoint reports a live database.
 */

test('home page renders the Phase 0 setup screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'SlackZero' })).toBeVisible();
  await expect(page.getByText('Not connected yet.')).toBeVisible();
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
