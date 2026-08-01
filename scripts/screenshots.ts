/**
 * README screenshots: `npm run screenshots`
 *
 * Drives a running demo instance and writes PNGs into docs/screenshots/.
 * Deliberately points at demo mode rather than a connected workspace — the
 * README is public, and real DMs are not.
 *
 *   npm run demo:setup
 *   npm run demo            # in another terminal
 *   SCREENSHOT_BASE_URL=http://localhost:3000 npm run screenshots
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium, type Page } from '@playwright/test';

const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? 'http://localhost:3000';
const OUT_DIR = path.join(process.cwd(), 'docs', 'screenshots');

async function shoot(page: Page, name: string): Promise<void> {
  // Let the queue settle: content is hydrated after the shell renders.
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  console.log(`  ✓ ${name}.png`);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  console.log(`Capturing from ${BASE_URL}`);

  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  await shoot(page, 'connect');

  const demoButton = page.getByRole('button', { name: /enter the demo/i });
  if ((await demoButton.count()) === 0) {
    throw new Error(
      'No demo entry point on the landing page. Start the app with ' +
        '`npm run demo` (SLACKZERO_DEMO=1 and a demo database).',
    );
  }
  await demoButton.click();
  await page.waitForURL('**/inbox', { waitUntil: 'networkidle' });
  await shoot(page, 'inbox');

  // Reading pane: walk down to the threaded item, so the pane shows a
  // conversation rather than the single message the queue opens with.
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  await shoot(page, 'reading-pane');

  await page.keyboard.press('Escape');

  // A saved view: the asks you are waiting on someone else to answer.
  const waitingView = page.getByText('Waiting on Others', { exact: true });
  if (await waitingView.count()) {
    await waitingView.first().click();
    await shoot(page, 'waiting-on-others');
  }

  await page.keyboard.press('?');
  await shoot(page, 'shortcuts');
  await page.keyboard.press('Escape');

  await page.goto(`${BASE_URL}/stats`, { waitUntil: 'networkidle' });
  await shoot(page, 'stats');

  await browser.close();
  console.log(`Wrote screenshots to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
