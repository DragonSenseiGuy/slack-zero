import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests. Phase 0 only ships a smoke test that the app boots and the
 * health page renders; the real user-flow coverage arrives with the UI in
 * Phase 2+.
 *
 * `webServer` builds and starts the app on plain http://localhost:3100 — https
 * is only needed for the Slack OAuth redirect, not for these tests, and the
 * non-default port keeps this from colliding with a dev server you have open.
 */
const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run build && npx next start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
