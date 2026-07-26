/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * Build output directory, overridable per-process.
   *
   * The Playwright suite runs `next build && next start`, and by default that
   * writes into the very `.next` a running `npm run dev` is serving from. The
   * dev server then 404s its own stylesheet — the page loads with no CSS at all,
   * which looks like a broken app rather than a clobbered build directory. It
   * cost real debugging time once; the e2e suite now builds into `.next-e2e`
   * instead (see `playwright.config.ts`), so the two cannot collide.
   *
   * If you ever do see an unstyled page, `rm -rf .next` and restart the dev
   * server — that is the symptom of a mixed build/dev directory.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

export default nextConfig;
