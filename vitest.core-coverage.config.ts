import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

/**
 * The money invariants' coverage floors, measured where the measurement is sound.
 *
 * M-VAT-13 set four per-file floors — `ledger/**`, `money.ts`, `money/**`, `tax/**` — and measured
 * them passing on the whole unit suite. At the final verify they failed there, and the cause is the
 * runner rather than the code: same commit, same tests, `packages/core` alone reports `money.ts` as
 * 55/55 lines while the whole 504-file suite reports 45/55. v8 drops coverage from some of the
 * module evaluations a run that size performs, and `--isolate=false` changes nothing.
 *
 * So this config runs the SAME unit configuration over `packages/core` only, which is where every
 * test that proves these modules lives, and carries the strict floors. It is a verify step of its
 * own (`pnpm coverage:core`), registered in gate case 29 beside `pnpm coverage`.
 *
 * It is deliberately NOT a different set of tests: the include is narrowed and nothing else, so a
 * module that only an integration suite reaches is as uncovered here as it was there.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['packages/core/**/*.test.ts'],
    coverage: {
      ...base.test?.coverage,
      thresholds: {
        'packages/core/src/ledger/**': { branches: 90, lines: 95 },
        'packages/core/src/money.ts': { branches: 90, lines: 95 },
        'packages/core/src/money/**': { branches: 90, lines: 95 },
        'packages/core/src/tax/**': { branches: 90, lines: 95 },
      },
    },
  },
})
