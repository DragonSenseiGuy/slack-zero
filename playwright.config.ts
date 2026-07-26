import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests. Phase 0 only ships a smoke test that the app boots and the
 * health page renders; the real user-flow coverage arrives with the UI in
 * Phase 2+.
 *
 * `webServer` builds and starts the app on plain http://localhost:3100 — https
 * is only needed for the Slack OAuth redirect, not for these tests, and the
 * non-default port keeps this from colliding with a dev server you have open.
 *
 * **Single worker, deliberately.** Every spec that needs data seeds it into the
 * one local Postgres under a shared fixture id namespace
 * (`e2e/fixtures/seed.ts`), clearing first so a crashed run cannot poison the
 * next. Two spec files doing that concurrently delete each other's rows
 * mid-test — which is exactly what happened when Phase 4's suite was added
 * alongside Phase 2's. Per-file namespaces would restore parallelism, but the
 * whole suite runs in well under a minute, so isolation is the better trade.
 */
const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
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
