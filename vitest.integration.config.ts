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
    /**
     * The seeded rows are read before the run and again after it, and the run that lost one fails.
     *
     * Wrapped round the whole suite rather than written as a test, because the defect is not in any one
     * file: these suites share ONE database in an order no file controls, `pnpm db:apply` refuses a
     * populated database so a lost row cannot be migrated back, and a PARTLY emptied database looks seeded
     * because a fixture loader leaves a table that already holds rows alone. It has bitten three times — a
     * bare `delete from customer` that skipped 21 cases in a file it had never heard of, 140 tables where
     * 153 were expected, and a salon answering about a rota it no longer had — and every time the symptom
     * surfaced in a suite that had done nothing wrong. W-SYS-13 and ADR 0050.
     */
    globalSetup: ['packages/fixtures/src/seeded-rows-global-setup.ts'],
  },
})
