import { defineConfig } from 'vitest/config'

/**
 * Integration tests: require real external processes — PostgreSQL 16, and headless Chromium for the
 * document renderer.
 *
 * These do NOT skip when DATABASE_URL is absent — they fail. A gate that silently
 * skips is the failure mode described in docs/adr/0002-typescript-6-not-7.md.
 */
export default defineConfig({
  /**
   * JSX, so a test may import a React component and render it.
   *
   * `apps/web/tsconfig.json` sets `jsx: "preserve"`, which is what Next requires — it compiles JSX itself.
   * Vite reads that setting for any file under `apps/web`, hands esbuild `preserve`, and the transform then
   * emits JSX into a `.js` module, which fails with "the content contains invalid JS syntax". The failure is
   * in the *importer*, several frames from the cause, which is why it is worth a comment rather than a
   * shrug. Stating the runtime here overrides the tsconfig-derived value for the suite only; Next's own
   * build is untouched.
   *
   * W-SYS-10 is the first test that needs this: its acceptance criterion is that the admin preview's
   * `srcset` equals the production `<picture>` component's, and the only way to compare them is to render
   * both.
   */
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  test: {
    name: 'integration',
    include: ['packages/**/*.itest.ts', 'apps/**/*.itest.ts'],
    // The app shell test starts a production server; nothing else in the suite is that slow.
    hookTimeout: 180_000,
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    clearMocks: true,
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
