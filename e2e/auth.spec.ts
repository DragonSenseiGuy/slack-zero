import { expect, test } from '@playwright/test';

/**
 * The authorization boundary, exercised with no session at all.
 *
 * Every other spec runs signed in via the global setup's storage state, so
 * without this file the gate could be removed and the suite would stay green.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('signed out', () => {
  test('the inbox is not reachable', async ({ page }) => {
    await page.goto('/inbox');

    await expect(page).toHaveURL(/\/\?signed_out=1$/);
    await expect(page.getByTestId('queue-pane')).toHaveCount(0);
    await expect(
      page.getByText('You need to sign in with Slack'),
    ).toBeVisible();
  });

  test('stats and health are not reachable', async ({ page }) => {
    for (const path of ['/stats', '/health']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/\?signed_out=1$/);
    }
  });

  test('the data APIs answer 401 rather than serving Slack content', async ({
    request,
  }) => {
    const context = await request.get(
      '/api/conversations/CE2ESEED001/context?before=1',
    );
    expect(context.status()).toBe(401);

    const stream = await request.get('/api/inbox/stream');
    expect(stream.status()).toBe(401);
  });

  test('/api/health stays up but names neither user nor workspace', async ({
    request,
  }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.ok).toBeDefined();
    expect(body.checks.slack.status).toBeDefined();
    // The signed-in report says "authenticated as U… in <workspace>".
    expect(body.checks.slack.detail).toBeUndefined();
    expect(body.checks.db.detail).toBeUndefined();
  });

  test('the setup page hides the connected workspace', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('Signed out.')).toBeVisible();
    await expect(
      page.getByText('Sign in to see the connected workspace.'),
    ).toBeVisible();
  });
});
