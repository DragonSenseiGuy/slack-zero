import { expect, test } from '@playwright/test';

import {
  clearInboxFixtures,
  deliverLateMessage,
  disconnectFixtures,
  expireSnooze,
  getAuthedUserId,
  seedInboxFixtures,
  FIXTURE_ITEM_COUNT,
  LATE_MESSAGE_TEXT,
} from './fixtures/seed';
import { loadScopedInbox } from './fixtures/page';

/**
 * The inbox updates itself.
 *
 * Before this, the queue was a snapshot taken at page load: a DM arriving over
 * Socket Mode, or a snooze elapsing, only showed up if you reloaded. For a tool
 * you leave open all day that is the difference between an inbox and a
 * screenshot of one.
 *
 * Both tests drive the database directly rather than replaying Slack events,
 * because that is genuinely where the boundary is — the Socket Mode listener is
 * a separate process (`npm run socket`), and the database is the only channel
 * between it and the web server. See `src/app/api/inbox/stream/route.ts`.
 *
 * Timeouts here are generous on purpose: the stream polls every couple of
 * seconds, so "did not appear instantly" is not a failure and asserting it
 * would make this suite flaky by design.
 */

test.describe.configure({ mode: 'serial' });

/** Comfortably more than the stream's poll interval. */
const LIVE_TIMEOUT = 15_000;

let authedUserId: string | null = null;

test.beforeAll(async () => {
  authedUserId = await getAuthedUserId();
});

test.beforeEach(async () => {
  test.skip(
    authedUserId === null,
    'No Slack installation in the database. Run the OAuth flow (SLACK_APP_SETUP.md) before the live e2e suite.',
  );
  await seedInboxFixtures(authedUserId as string);
});

test.afterAll(async () => {
  if (authedUserId) await clearInboxFixtures();
  await disconnectFixtures();
});

test('the header reports a live connection', async ({ page }) => {
  await loadScopedInbox(page);

  // Without this the user cannot tell "nothing is happening" from "the stream
  // died twenty minutes ago", which is what makes a push-updated inbox
  // untrustworthy.
  await expect(page.getByTestId('live-status')).toHaveAttribute(
    'data-status',
    'live',
    { timeout: LIVE_TIMEOUT },
  );
});

test('a message that arrives after load appears without a reload', async ({
  page,
}) => {
  await loadScopedInbox(page);
  await expect(page.getByTestId('queue-item')).toHaveCount(FIXTURE_ITEM_COUNT);

  // Marker on the window: if the queue updated by navigating, it would be gone,
  // and the update would have cost the user their selection and sort.
  await page.evaluate(() => {
    (window as unknown as { __noReload?: boolean }).__noReload = true;
  });

  await deliverLateMessage(authedUserId as string);

  await expect(page.getByTestId('queue-item')).toHaveCount(
    FIXTURE_ITEM_COUNT + 1,
    { timeout: LIVE_TIMEOUT },
  );
  await expect(page.getByTestId('queue-list')).toContainText(LATE_MESSAGE_TEXT);

  const survived = await page.evaluate(
    () => (window as unknown as { __noReload?: boolean }).__noReload === true,
  );
  expect(survived).toBe(true);
});

test('a snooze that elapses brings the item back on its own', async ({
  page,
}) => {
  await loadScopedInbox(page);
  await expect(page.getByTestId('queue-item')).toHaveCount(FIXTURE_ITEM_COUNT);

  const target = page.getByTestId('queue-item').first();
  const messageId = await target.getAttribute('data-message-id');
  expect(messageId).toBeTruthy();

  await page.keyboard.press('h');
  await expect(page.getByTestId('snooze-menu')).toBeVisible();
  await page.getByTestId('snooze-tomorrow').click();
  await expect(page.getByTestId('queue-item')).toHaveCount(
    FIXTURE_ITEM_COUNT - 1,
  );

  // Make it due. The sweep runs inside the stream, so nothing else has to
  // happen — no reload, no keystroke, no background job.
  await expireSnooze(messageId as string);

  await expect(page.getByTestId('queue-item')).toHaveCount(FIXTURE_ITEM_COUNT, {
    timeout: LIVE_TIMEOUT,
  });

  // And it says it is a reminder. The sweep clears `snoozedUntil` to bring the
  // item back, so without the provenance columns a snooze you set for yourself
  // would rejoin the queue looking like a message that just arrived.
  const returned = page.locator(
    `[data-testid="queue-item"][data-message-id="${messageId}"]`,
  );
  await expect(returned.getByTestId('snooze-summary')).toHaveAttribute(
    'data-snooze-state',
    'returned',
  );
  await expect(returned.getByTestId('snooze-summary')).toContainText('Snoozed');
});
