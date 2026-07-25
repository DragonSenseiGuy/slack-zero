import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Unit tests only. Per CLAUDE.md these are colocated next to the code they
 * test (`foo.ts` + `foo.test.ts`) and must not hit live Slack/LLM APIs.
 * Browser-level flows live in `e2e/` and belong to Playwright.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', '.next', 'e2e'],
    clearMocks: true,
    restoreMocks: true,
  },
});
