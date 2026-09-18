import { defineConfig } from 'vitest/config'

/** Unit tests: pure, fast, no I/O. packages/core must be testable with nothing running. */
export default defineConfig({
  test: {
    name: 'unit',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.itest.ts', '**/e2e/**'],
    environment: 'node',
    clearMocks: true,
  },
})
