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
  /**
   * JSX, for the same reason `vitest.integration.config.ts` states it.
   *
   * `apps/web/tsconfig.json` sets `jsx: "preserve"` because Next compiles JSX itself, Vite reads that for any
   * file under `apps/web`, and the transform then emits JSX into a `.js` module — which fails in the
   * IMPORTER with "the content contains invalid JS syntax", several frames from the cause. Declared in both
   * configs rather than only in the one that needs it today: two runners that disagree about JSX is a test
   * that passes in one suite and cannot be written in the other. It is `oxc` and not `esbuild` because Vite 8
   * transforms with oxc.
   */
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
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
        // The payment adapters and their registry. Counted rather than excluded: the exclusions below are
        // all "needs a database or a browser", and this package needs neither — both adapters are in-memory
        // and the conformance suite runs with nothing started. Money-handling code with no coverage floor
        // would be the one unjustified exemption in the list.
        'packages/payments/src/**/*.ts',
        'packages/google/src/**/*.ts',
        // The clinical boundary was counted by NEITHER floor: the package holding the envelope, the AAD
        // binding and the KEK rotation was absent from this list, so the most sensitive code in the
        // repository had no coverage requirement at all. Found while adding H-HARD-03.
        'packages/clinical/src/**/*.ts',
        // The staff PII estate, for the same reason the clinical one is here: the envelope and the AAD
        // binding for bank accounts and identity-document numbers must be counted by a floor.
        'packages/hr/src/**/*.ts',
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
        // H-HARD-11's soak runs. Every line is a transaction, a race or a drain against a real
        // PostgreSQL — 200 bookings in flight for one place and a 10,000-event backlog — so the unit
        // suite cannot reach any of it, and a mock of a row lock would assert that the mock works. The
        // JUDGEMENTS over what it measures are `packages/core/src/ops/soak.ts`, which is counted, and
        // the run itself is driven by `scripts/soak.mjs` and by gate case 204k.
        'packages/fixtures/src/soak.ts',
        // SQL only. Its behaviour — including that a re-wrap touches five columns and nothing else — is
        // proved against a real PostgreSQL by packages/google/src/google-connection.itest.ts.
        'packages/google/src/postgres-store.ts',
        // The same two exclusions for the clinical boundary, for the same two reasons. The key store is
        // SQL only and is driven against a real PostgreSQL by
        // packages/clinical/src/crypto/rotation.itest.ts; the Drizzle mirrors are declarations whose
        // agreement with the database is `pnpm db:drift`'s to prove, not a test's — the equivalents in
        // packages/db are excluded by that package's absence from the list above.
        'packages/clinical/src/crypto/postgres-key-store.ts',
        'packages/clinical/src/schema/**',
        // The same exclusion for the same reason a third time. Every statement in the employee repository
        // is a query, a transaction or an audit row, and its behaviour — including that a decrypt writes
        // exactly one audit row and that a refused read writes a `denied` one — is proved against a real
        // PostgreSQL by packages/hr/src/employee.itest.ts. The envelope beside it IS counted.
        'packages/hr/src/employee-repository.ts',
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
        /*
         * The modules the money invariants rest on, each with a floor of its own (M-VAT-13).
         *
         * ## Why they are not covered by the line above
         *
         * `packages/core/src/**` is an AGGREGATE over forty-odd directories, and an aggregate hides a
         * small module inside a large one: `ledger`, `money` and `tax` are about 900 statements of a
         * 6,500-statement package, so all four of these groups could fall to 70% without moving the
         * package figure past its floor. And these are the modules nothing else can check: the half-up
         * rounding rule, the release formula's complement and the expected-float expression each have
         * exactly one statement and it is HERE, deliberately not restated in SQL — 0026_invoice.sql
         * argues at length against a generated `vat_total` for that reason. `pnpm money-invariants`
         * says those modules' tests RAN; only a floor says how much of them they reach.
         *
         * `money.ts` is listed beside `money/**` rather than folded into it: `splitGross` is in the FILE
         * and the per-line derivation is in the DIRECTORY, and the file is the one that defines what
         * "exact at the fils" means. A glob matching only the directory would leave it to the aggregate.
         *
         * ## Why only two dimensions
         *
         * M-VAT-13's acceptance line names lines and branches, and it names 95 and 90. Statements and
         * functions are deliberately left to the `packages/core/src/**` group above, which still counts
         * every one of these files — vitest computes each glob group independently and the global
         * thresholds over everything, so a file matching two globs is held by both. Adding a 95% FUNCTION
         * floor here would have been a tighter gate than the acceptance line asks for on a dimension it
         * does not mention, and `money.ts` measures 95.45% on it today: one more uncovered function and
         * the build would fail a threshold nobody asked for, which is how a floor becomes a figure people
         * edit rather than a floor people meet.
         *
         * Measured when written, so the headroom is a fact rather than a hope: ledger 100.00% lines /
         * 97.24% branches, money.ts 98.18/100.00, money/ 98.99/96.92, tax 98.23/93.90.
         */
        'packages/core/src/ledger/**': { branches: 90, lines: 95 },
        'packages/core/src/money.ts': { branches: 90, lines: 95 },
        'packages/core/src/money/**': { branches: 90, lines: 95 },
        'packages/core/src/tax/**': { branches: 90, lines: 95 },
      },
    },
  },
})
