import { expect, test } from '@playwright/test';

import {
  clearInboxFixtures,
  disconnectFixtures,
  getAuthedUserId,
  seedDirectMessageFixture,
  seedInboxFixtures,
  FIXTURE_DM_ID,
  FIXTURE_DM_NEWEST_TEXT,
  FIXTURE_ITEM_COUNT,
} from './fixtures/seed';
import { loadScopedInbox, pinSortToNewest } from './fixtures/page';

/**
 * Conversation context in the reading pane.
 *
 * A queue row is one message lifted out of a conversation: enough to rank it,
 * nowhere near enough to answer it. "sounds good, go ahead" means nothing
 * without the question above it. These tests check the transcript is there, is
 * both halves of the conversation, and pages further back on demand.
 *
 * The page-size arithmetic is unit tested in `src/lib/queue/context.test.ts`;
 * what only a browser can show is that selecting a row fetches it, that paging
 * appends rather than replaces, and that a thread — which prints its own
 * replies inline — does not also print a competing transcript.
 */

test.describe.configure({ mode: 'serial' });

/** Matches `CONTEXT_PAGE_SIZE`. */
const PAGE_SIZE = 10;

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

test('a mention shows the ten messages before it, and pages further back', async ({
  page,
}) => {
  await loadScopedInbox(page);
  await expect(page.getByTestId('queue-item')).toHaveCount(FIXTURE_ITEM_COUNT);
  await pinSortToNewest(page);

  const context = page.getByTestId('conversation-context');
  await expect(context).toHaveAttribute('data-loaded', 'true');

  // Eleven messages sit before the newest fixture item, so the first page is
  // full and reports that there is more.
  await expect(context).toHaveAttribute(
    'data-message-count',
    String(PAGE_SIZE),
  );
  await expect(context).toHaveAttribute('data-has-more', 'true');

  await page.getByTestId('conversation-context-more').click();

  // Appended, not replaced — the point of paging is more context, not other
  // context.
  await expect(context).toHaveAttribute(
    'data-message-count',
    String(PAGE_SIZE + 1),
  );
  await expect(context).toHaveAttribute('data-has-more', 'false');
  await expect(page.getByTestId('conversation-context-more')).toHaveCount(0);
});

test('the context follows the selection', async ({ page }) => {
  await loadScopedInbox(page);
  await pinSortToNewest(page);

  const context = page.getByTestId('conversation-context');
  await expect(context).toHaveAttribute('data-loaded', 'true');

  const firstTop = await page
    .getByTestId('context-message')
    .first()
    .getAttribute('data-ts');

  // Move down one row: an older message, so its context is a different slice.
  await page.keyboard.press('j');
  await expect(context).toHaveAttribute('data-loaded', 'true');

  const secondTop = await page
    .getByTestId('context-message')
    .first()
    .getAttribute('data-ts');

  expect(secondTop).not.toBe(firstTop);
});

test('a DM shows both halves of the conversation', async ({ page }) => {
  await seedDirectMessageFixture(authedUserId as string);

  await page.goto(`/inbox?in=${encodeURIComponent(FIXTURE_DM_ID)}`);
  await expect(page.getByTestId('queue-pane')).toHaveAttribute(
    'data-hydrated',
    'true',
  );

  await expect(page.getByTestId('reading-pane-body')).toContainText(
    FIXTURE_DM_NEWEST_TEXT,
  );

  const context = page.getByTestId('conversation-context');
  await expect(context).toHaveAttribute(
    'data-message-count',
    String(PAGE_SIZE),
  );

  // Without the user's own replies the transcript is a monologue, and the
  // message being triaged still makes no sense.
  await expect(
    page.locator('[data-testid="context-message"][data-from-me="true"]'),
  ).not.toHaveCount(0);
  await expect(
    page.locator('[data-testid="context-message"][data-from-me="false"]'),
  ).not.toHaveCount(0);

  await expect(context).toHaveAttribute('data-has-more', 'true');
  await page.getByTestId('conversation-context-more').click();
  await expect(context).toHaveAttribute(
    'data-message-count',
    String(PAGE_SIZE + 2),
  );
  await expect(context).toHaveAttribute('data-has-more', 'false');
});
