import { defineConfig } from 'vitest/config'

/**
 * The seven money invariants, and the test that STATES each one (M-VAT-13).
 *
 * # Why this is a registry of existing tests and not a new suite
 *
 * Every one of the seven claims below is already proved somewhere, and each is proved in the only place
 * it can be: `net + vat === gross` is a property over generated amounts in a pure test, `UPDATE on
 * journal_line raises ZL001` can only be proved against real PostgreSQL, and the exhaustive partition
 * needs a closed period with documents behind it. A new suite restating any of them would be a second
 * statement of a fact, which this build spends most of its constraints preventing — and the second
 * statement is the one that drifts.
 *
 * What was missing is that nothing said the seven are a SET. Each test was reachable only through
 * `pnpm test:integration`'s glob and `pnpm coverage`'s, so deleting one, renaming it, or moving it into
 * a `describe.skip` reduced the run by one test and nothing anywhere said which claim had stopped being
 * made. That is the ADR 0002 shape — a gate that examined nothing while reporting success — applied to
 * the claims a tax authority asks about.
 *
 * So: `pnpm money-invariants` (`scripts/money-invariants.mjs`) reads this registry, refuses an entry whose
 * file or test name no longer resolves, runs the named files under the config each one belongs to, and
 * refuses any invariant for which ZERO tests passed. It is a step of `pnpm verify` and of
 * `.github/workflows/ci.yml`, registered in `scripts/test-gates.mjs` case 29, so dropping it is a failing
 * build rather than a silent loss of coverage.
 *
 * # Why the registry lives in this file
 *
 * This is the file that already decides what the integration suite IS. A separate module listing test
 * files would be a second answer to that question, and the money set is a subset of this one — so the day
 * a money file stops matching `include` the registry is read beside the glob that no longer covers it.
 * The unit tests in the set are named with their config, because a runner that guessed would run
 * `money.test.ts` under the integration config, where `include` does not match it and vitest reports no
 * test files rather than a missing claim.
 *
 * # What a marker is, and what it costs
 *
 * `nameContains` is a substring of the test's own name, matched against the names the RUNNER reports as
 * passed. It is deliberately a whole clause rather than a word: a word would keep matching a test that
 * had been rewritten to assert something else, which is the vacuity this registry exists to refuse. The
 * cost is that renaming one of these tests fails `pnpm money-invariants` by name — which is the intended
 * behaviour, and the failure says which clause to re-point.
 *
 * `oneStatement` is the module or migration object the claim rests on. It is not read by the runner; it is
 * read by `scripts/test-gates.mjs`'s 152a-152z block, which breaks several of them and requires the named
 * test back by name (ADR 0003). See docs/adr/0074-the-money-invariants-are-a-named-set.md.
 */
export interface MoneyInvariantTest {
  /** Which runner config the file belongs to. A unit test under the integration glob matches nothing. */
  readonly config: 'unit' | 'integration'
  readonly file: string
  /** A clause of the test's own name, matched against the names the runner reports as PASSED. */
  readonly nameContains: string
}

export interface MoneyInvariant {
  readonly id: string
  /** The acceptance line's own words for this claim. */
  readonly claim: string
  /** Where the rule is stated once. Read by the gate block, not by the runner. */
  readonly oneStatement: string
  readonly tests: readonly MoneyInvariantTest[]
}

export const MONEY_INVARIANTS: readonly MoneyInvariant[] = [
  {
    id: 'LEDGER_BALANCES',
    claim: 'ledger always balances',
    oneStatement:
      'assert_entry_balanced() raising ZL003 at COMMIT (packages/db/migrations/0018_ledger.sql), and ' +
      'postEntry refusing an unbalanced draft before it writes (packages/core/src/ledger/entry.ts)',
    tests: [
      {
        config: 'integration',
        file: 'packages/db/src/repositories/journal.itest.ts',
        nameContains: 'accepts each line insert and fails the COMMIT when they do not sum to zero',
      },
      {
        config: 'integration',
        file: 'packages/db/src/repositories/journal.itest.ts',
        // The case the LINE-level trigger cannot see at all, and therefore the one a check that only
        // summed lines would pass over: an entry inserted with no lines fires no line trigger.
        nameContains: 'rejects an entry with no lines at all',
      },
      {
        config: 'unit',
        file: 'packages/core/src/ledger/entry.test.ts',
        nameContains: 'throws UnbalancedEntry rather than returning a value',
      },
    ],
  },
  {
    id: 'VAT_ROUND_TRIP',
    claim: 'VAT gross/net round-trip exact at the fils',
    oneStatement:
      'splitGross in packages/core/src/money.ts — net is rounded half-up and VAT is the REMAINDER, ' +
      'which is what makes net + vat === gross exact (ADR 0007). Deliberately not restated in SQL: ' +
      '0026_invoice.sql argues at length against a generated vat_total for exactly that reason, so the ' +
      'coverage floor on packages/core/src/money* in vitest.config.ts is the other half of this claim',
    tests: [
      {
        config: 'unit',
        file: 'packages/core/src/money.test.ts',
        nameContains: 'net + vat === gross, exactly, for every gross amount',
      },
      {
        config: 'unit',
        file: 'packages/core/src/money/vat.test.ts',
        // The document grain, which the property above says nothing about: a document total is the SUM
        // of per-line VAT, and re-deriving it from the document gross is wrong by a fils on two lines
        // of 11.
        nameContains: 'are sums of the lines for an arbitrary set of lines',
      },
    ],
  },
  {
    id: 'JOURNAL_APPEND_ONLY',
    claim: 'no UPDATE or DELETE on journal_line',
    oneStatement:
      'refuse_journal_change() raising ZL001 on four triggers, plus the revokes of UPDATE, DELETE and ' +
      'TRUNCATE from berelax_app (packages/db/migrations/0018_ledger.sql). Both layers, because a ' +
      'trigger fires for the owner a privilege cannot constrain and a privilege refuses before any ' +
      'trigger runs',
    tests: [
      {
        config: 'integration',
        file: 'packages/db/src/repositories/journal.itest.ts',
        nameContains:
          'UPDATE and DELETE on journal_line raise ZL001 with the named trigger message',
      },
      {
        config: 'integration',
        file: 'packages/db/src/repositories/journal.itest.ts',
        nameContains: 'the application role is refused by the GRANT, before any trigger runs',
      },
    ],
  },
  {
    id: 'NUMBERING_GAP_FREE',
    claim: 'gap-free numbering',
    oneStatement:
      'allocate_document_number() against a row-locked counter (packages/db/migrations/' +
      '0013_document_series.sql, ADR 0023), and findNumberingGaps reading number - row_number() ' +
      '(packages/db/src/repositories/numbering.ts)',
    tests: [
      {
        config: 'integration',
        file: 'packages/db/src/repositories/numbering.itest.ts',
        nameContains: 'finds nothing across 10,000 issued documents, with rollbacks in the middle',
      },
    ],
  },
  {
    id: 'PACKAGE_LIABILITY_IDENTITY',
    claim: 'package liability identity',
    oneStatement:
      'package_release_through_fils() and ZG009 holding a balance to it ' +
      '(packages/db/migrations/0083_package_redemption.sql), with releaseThrough and ' +
      'remainingSessionShareFils as its complement in packages/core',
    tests: [
      {
        config: 'integration',
        file: 'packages/fixtures/src/package-liability.itest.ts',
        nameContains: 'ties the sum of remaining package value to 2050, to the fils',
      },
      {
        config: 'integration',
        file: 'packages/fixtures/src/package-redemption.itest.ts',
        // The formula itself, held equal between SQL and TypeScript over a counted census — the claim
        // that makes the tie above an identity rather than a coincidence of one fixture.
        nameContains: 'agree at every point of a bounded census, and the census is counted',
      },
    ],
  },
  {
    id: 'CASH_SESSION_BUSINESS_DAY',
    claim: 'business-day cash session',
    oneStatement:
      'cash_session.trading_date as a foreign key into business_day, with ZU005 holding the snapshot ' +
      'to the rows for that day (packages/db/migrations/0076_cash_session.sql), and ' +
      'cash_session_expected_float_fils() as the one statement of the expected float',
    tests: [
      {
        config: 'integration',
        file: 'packages/fixtures/src/cash-up.itest.ts',
        // Trading runs 11:00-02:00, so the after-midnight tenders belong to the PREVIOUS trading date.
        // This is the half a calendar truncation gets wrong without changing any day's total.
        nameContains:
          'files every tender of the shift on one business day, including the ones after midnight',
      },
      {
        config: 'integration',
        file: 'packages/fixtures/src/cash-up.itest.ts',
        nameContains:
          'reconciles the session to the sum of the cash payment rows, exact to the fils',
      },
    ],
  },
  {
    id: 'VAT_BOX_PARTITION',
    claim: 'VAT box partition exhaustive',
    oneStatement:
      'vat201_partition_census() over vat201_box_line, and ZY009 refusing an account the mapping does ' +
      'not attribute (packages/db/migrations/0089_vat201_mapping.sql)',
    tests: [
      {
        config: 'integration',
        file: 'packages/fixtures/src/vat201.itest.ts',
        nameContains: 'attributes every journal line in the return month exactly once',
      },
    ],
  },
]

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
