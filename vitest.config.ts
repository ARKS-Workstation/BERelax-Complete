import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
    environment: 'node',
    // Deterministic clock: packages/core must never read the clock directly (F05),
    // so tests that need time inject it. No global fake timers by default.
    clearMocks: true,
    coverage: { provider: 'v8', reporter: ['text', 'json-summary'] },
  },
})
