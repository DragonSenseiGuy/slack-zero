import { expect, test, type Page } from '@playwright/test';

import {
  clearInboxFixtures,
  countDoneStates,
  disconnectFixtures,
  getAuthedUserId,
  seedBurstFixture,
  seedInboxFixtures,
  BURST_MESSAGES,
  BURST_MESSAGE_IDS,
  BURST_NEWEST_TEXT,
  FIXTURE_ITEM_COUNT,
} from './fixtures/seed';
import { loadScopedInbox } from './fixtures/page';

/**
 * One person, one row.
 *
 * The grouping rule itself is unit tested in `src/lib/queue/queue.test.ts`
 * against fixtures. What a browser adds is the half that arithmetic cannot
 * reach: that a collapsed row is one row in the DOM, that opening it still shows
 * every message it swallowed, and — the part that actually bit — that marking it
 * done writes state for *all* of its messages, so it does not reappear the
 * moment the page reloads.
 */

test.describe.configure({ mode: 'serial' });

/** The burst is one row; everything else in the fixtures is unchanged. */
const EXPECTED_ITEM_COUNT = FIXTURE_ITEM_COUNT + 1;

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
  await seedBurstFixture(authedUserId as string);
});

test.afterAll(async () => {
  if (authedUserId) await clearInboxFixtures();
  await disconnectFixtures();
});

async function openScopedInbox(page: Page, expectedItems = EXPECTED_ITEM_COUNT) {
  await loadScopedInbox(page);
  await expect(page.getByTestId('queue-item')).toHaveCount(expectedItems);
}

/** The burst row: the only one standing for more than one message. */
function burstRow(page: Page) {
  return page.locator(
    `[data-testid="queue-item"][data-message-count="${BURST_MESSAGES.length}"]`,
  );
}

test('three messages in a row from one person are one queue item', async ({
  page,
}) => {
  await openScopedInbox(page);

  await expect(burstRow(page)).toHaveCount(1);

  // It shows the newest message, not the first — the latest line is the one
  // being answered, and burying it under a stale preview is how an urgent
  // message goes unread.
  await expect(burstRow(page)).toContainText(BURST_NEWEST_TEXT);
  await expect(burstRow(page).getByTestId('group-summary')).toContainText(
    `${BURST_MESSAGES.length} messages`,
  );

  // None of the swallowed messages has a row of its own.
  for (const id of BURST_MESSAGE_IDS.slice(0, -1)) {
    await expect(
      page.locator(`[data-testid="queue-item"][data-message-id="${id}"]`),
    ).toHaveCount(0);
  }
});

test('opening the row shows every message in the run', async ({ page }) => {
  await openScopedInbox(page);

  await burstRow(page).getByRole('button').first().click();
  await page.keyboard.press('Enter');

  const pane = page.getByTestId('reading-pane');
  await expect(pane.getByTestId('earlier-message')).toHaveCount(
    BURST_MESSAGES.length - 1,
  );

  for (const message of BURST_MESSAGES) {
    await expect(pane).toContainText(message.text);
  }
});

test('marking the row done finishes every message behind it', async ({
  page,
}) => {
  await openScopedInbox(page);

  await burstRow(page).getByRole('button').first().click();
  await page.keyboard.press('e');

  // Gone from the queue, and the save is confirmed by the server rather than
  // merely painted optimistically.
  await expect(page.getByTestId('queue-item')).toHaveCount(
    EXPECTED_ITEM_COUNT - 1,
  );
  await expect(page.getByTestId('queue-pane')).toHaveAttribute(
    'data-confirmed-saves',
    '1',
  );

  expect(await countDoneStates(BURST_MESSAGE_IDS)).toBe(BURST_MESSAGES.length);

  // The regression that matters: with only the newest message marked done, the
  // other two would come straight back as their own row on reload.
  await openScopedInbox(page, EXPECTED_ITEM_COUNT - 1);
  await expect(burstRow(page)).toHaveCount(0);
});
