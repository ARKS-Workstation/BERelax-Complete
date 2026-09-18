import { defineConfig } from 'vitest/config'

/**
 * Unit tests: pure, fast, no I/O. packages/core must be testable with nothing running.
 *
 * ## The coverage policy, and why it is not one number
 *
 * A single global threshold is easy to satisfy and easy to game: a large well-tested package hides a
 * small untested one, and the number drifts down a tenth at a time until somebody rounds it off.
 *
 * So there are two. A **global floor** across everything a unit test can reach, and a **higher floor
 * on `packages/core`**, which is the pure domain — money, time, business day, authorisation, text.
 * That code has no excuse for being uncovered: it takes arguments and returns values, and every line
 * of it decides something a customer or a tax authority cares about.
 *
 * What is deliberately *excluded* is as important. `packages/db`, `packages/pdf` and
 * `packages/harness` need a database or a browser, and their behaviour is proved by the integration
 * suite. Counting them here would either force a misleading floor or invite mocks that assert the
 * mock works — which is how a coverage number becomes a number rather than evidence.
 */
export default defineConfig({
  test: {
    name: 'unit',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.itest.ts', '**/e2e/**'],
    environment: 'node',
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'artifacts/coverage',
      // An explicit `include` counts every matching file whether or not a test imported it. Without
      // that, deleting the last test for a module *raises* coverage, which is the wrong direction for
      // a number to move.
      include: [
        'packages/core/src/**/*.ts',
        'packages/auth/src/**/*.ts',
        'packages/cms/src/**/*.ts',
        'packages/config/src/**/*.ts',
        'packages/messaging/src/**/*.ts',
        'packages/providers/src/**/*.ts',
        'packages/google/src/**/*.ts',
        'packages/media/src/**/*.ts',
        'packages/fixtures/src/**/*.ts',
        'packages/ui/src/**/*.ts',
        'packages/shared/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.itest.ts',
        '**/index.ts',
        // Generated. Its correctness is `scripts/palette.py`'s to prove, not a test's.
        'packages/ui/src/tokens/palette.generated.ts',
        // Loaded by the harness with a browser; the unit suite cannot reach the file reads.
        'packages/fixtures/src/media.ts',
        'packages/fixtures/src/load.ts',
        // SQL only. Its behaviour — including that a re-wrap touches five columns and nothing else — is
        // proved against a real PostgreSQL by packages/google/src/google-connection.itest.ts.
        'packages/google/src/postgres-store.ts',
        // The sharp pipeline. Twenty-four encodes is half a minute of libvips, which is the integration
        // suite's job — packages/media/src/derivatives.itest.ts drives it, and packages/fixtures's does it
        // again against the real photography. The pure halves it sits on, the ladders and the URL builder,
        // are counted above.
        'packages/media/src/derivatives.ts',
      ],
      thresholds: {
        statements: 88,
        branches: 78,
        functions: 85,
        lines: 88,
        'packages/core/src/**': {
          statements: 95,
          branches: 88,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
})
