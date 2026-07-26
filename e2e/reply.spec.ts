import { expect, test, type Page } from '@playwright/test';

import {
  clearDoneState,
  clearInboxFixtures,
  disconnectFixtures,
  findRealDirectMessage,
  getAuthedUserId,
  seedInboxFixtures,
  FIXTURE_CHANNEL_NAME,
  FIXTURE_ITEM_COUNT,
} from './fixtures/seed';

/**
 * Phase 5 verification (plan.md): reply to a test DM from the queue, confirm the
 * message appears in the actual Slack workspace, confirm the item is
 * auto-marked done.
 *
 * Split into two groups on purpose:
 *
 *  - **UI tests**, which always run. They cover the compose box against seeded
 *    fixtures and never send anything.
 *  - **The live-send test**, which posts a real message into the connected
 *    workspace and is therefore **opt-in**: it only runs with
 *    `SLACKZERO_E2E_LIVE_SEND=1`. Everything else in this suite is repeatable
 *    and invisible; that one is neither. A test that messages a real colleague
 *    every time someone runs `npm run test:e2e` is not a test, it is a hazard.
 *
 * The failure path plan.md also asks for ("simulate Slack API error on send,
 * confirm UI shows error and does not falsely mark done") is covered in
 * `src/lib/reply/actions.test.ts`, where the Slack error can actually be
 * simulated. It cannot be faked through the real UI without stubbing the server
 * action, which would test the stub.
 */

test.describe.configure({ mode: 'serial' });

const LIVE_SEND = process.env.SLACKZERO_E2E_LIVE_SEND === '1';

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

async function scopeToFixtures(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('command-palette-input').fill(FIXTURE_CHANNEL_NAME);
  await expect(page.getByTestId('command-palette-result')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('scope-chip')).toContainText(
    FIXTURE_CHANNEL_NAME,
  );
}

// ---------------------------------------------------------------------------
// UI, no sending
// ---------------------------------------------------------------------------

test.describe('the compose box', () => {
  test.beforeEach(async () => {
    test.skip(
      authedUserId === null,
      'No Slack installation in the database. Run the OAuth flow first.',
    );
    await seedInboxFixtures(authedUserId as string);
  });

  test('appears for the selected message with the sender named', async ({
    page,
  }) => {
    await loadInbox(page);
    await scopeToFixtures(page);
    await expect(page.getByTestId('queue-item')).toHaveCount(
      FIXTURE_ITEM_COUNT,
    );

    const box = page.getByTestId('reply-box');
    await expect(box).toBeVisible();
    await expect(page.getByTestId('reply-input')).toHaveAttribute(
      'placeholder',
      /Reply to /,
    );
  });

  test('refuses to send an empty or whitespace-only reply', async ({ page }) => {
    await loadInbox(page);
    await scopeToFixtures(page);

    // Nothing typed: the button is disabled rather than posting an empty message.
    await expect(page.getByTestId('reply-send')).toBeDisabled();

    await page.getByTestId('reply-input').fill('   ');
    await expect(page.getByTestId('reply-send')).toBeDisabled();

    await page.getByTestId('reply-input').fill('something');
    await expect(page.getByTestId('reply-send')).toBeEnabled();
  });

  test('auto-mark-done is on by default and can be turned off', async ({
    page,
  }) => {
    // plan.md: "After reply sent, auto-mark item done (configurable)".
    await loadInbox(page);
    await scopeToFixtures(page);

    const toggle = page.getByTestId('reply-mark-done');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
  });

  test('typing in the compose box does not fire queue shortcuts', async ({
    page,
  }) => {
    // "read" contains `r`, `e` and `d` — all bound. `e` marking the message done
    // mid-sentence would be the worst of them.
    await loadInbox(page);
    await scopeToFixtures(page);
    await expect(page.getByTestId('queue-item')).toHaveCount(
      FIXTURE_ITEM_COUNT,
    );

    await page.getByTestId('reply-input').click();
    await page.keyboard.type('read the draft, seriously');

    await expect(page.getByTestId('reply-input')).toHaveValue(
      'read the draft, seriously',
    );
    // Nothing was marked done, and the list did not shrink.
    await expect(page.getByTestId('queue-item')).toHaveCount(
      FIXTURE_ITEM_COUNT,
    );
  });

  test('r focuses the compose box from the list', async ({ page }) => {
    await loadInbox(page);
    await scopeToFixtures(page);

    await page.keyboard.press('r');
    await expect(page.getByTestId('reply-input')).toBeFocused();
  });

  test('the compose box clears when the selection changes', async ({ page }) => {
    // Carrying a half-typed reply to a different person is how you send it to
    // the wrong one.
    await loadInbox(page);
    await scopeToFixtures(page);

    await page.getByTestId('reply-input').fill('half-written thought');
    await page.getByTestId('reply-input').blur();
    await page.keyboard.press('j');

    await expect(page.getByTestId('reply-input')).toHaveValue('');
  });
});

// ---------------------------------------------------------------------------
// The live send — opt-in
// ---------------------------------------------------------------------------

test.describe('sending for real', () => {
  test.skip(
    !LIVE_SEND,
    'Opt-in: this posts a real message into the connected Slack workspace. Run with SLACKZERO_E2E_LIVE_SEND=1.',
  );

  test('a reply reaches Slack and the item is auto-marked done', async ({
    page,
  }) => {
    test.skip(
      authedUserId === null,
      'No Slack installation in the database. Run the OAuth flow first.',
    );

    const target = await findRealDirectMessage();
    test.skip(
      target === null,
      'No real DM in the database to reply to. Run `npm run backfill` first.',
    );

    const { messageId, conversationId } = target as {
      messageId: string;
      conversationId: string;
    };

    // Start from a known state so "auto-marked done" is a real transition.
    await clearDoneState(messageId);

    const body = `SlackZero Phase 5 e2e — please ignore (${Date.now()})`;

    await loadInbox(page);

    // Scope to the conversation the message is in, then select that message.
    const row = page.locator(
      `[data-testid="queue-item"][data-message-id="${messageId}"]`,
    );
    await expect(row).toHaveCount(1);
    await row.locator('button').first().click();

    await expect(page.getByTestId('reading-pane')).toHaveAttribute(
      'data-message-id',
      messageId,
    );
    await expect(page.getByTestId('reply-mark-done')).toBeChecked();

    await page.getByTestId('reply-input').fill(body);
    await page.getByTestId('reply-send').click();

    // Wait for the server to confirm, not for the optimistic UI.
    await expect(page.getByTestId('queue-pane')).toHaveAttribute(
      'data-replies-sent',
      '1',
    );
    await expect(page.getByTestId('queue-pane')).toHaveAttribute(
      'data-reply-sending',
      'false',
    );
    await expect(page.getByTestId('reply-error')).toHaveCount(0);
    await expect(page.getByTestId('reply-sent')).toBeVisible();

    // ---- confirm it is really in Slack ----
    const { WebClient } = await import('@slack/web-api');
    const { getInstallation } = await import('../src/lib/slack/installation');
    const installation = await getInstallation();
    expect(installation).not.toBeNull();

    const slack = new WebClient(
      (installation as { userAccessToken: string }).userAccessToken,
    );
    const history = await slack.conversations.history({
      channel: conversationId,
      limit: 20,
    });

    const texts = (history.messages ?? []).map((message) => message.text ?? '');
    expect(texts).toContain(body);

    // ---- and that the item was auto-marked done ----
    await loadInbox(page);
    await page.getByTestId('toggle-show-done').click();
    await expect(
      page.locator(
        `[data-testid="queue-item"][data-message-id="${messageId}"][data-done="true"]`,
      ),
    ).toHaveCount(1);
  });
});
