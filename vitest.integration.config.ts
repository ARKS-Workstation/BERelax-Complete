import { defineConfig } from 'vitest/config'

/**
 * Integration tests: require real external processes — PostgreSQL 16, and headless Chromium for the
 * document renderer.
 *
 * These do NOT skip when DATABASE_URL is absent — they fail. A gate that silently
 * skips is the failure mode described in docs/adr/0002-typescript-6-not-7.md.
 */
export default defineConfig({
  test: {
    name: 'integration',
    include: ['packages/**/*.itest.ts', 'apps/**/*.itest.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    clearMocks: true,
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
