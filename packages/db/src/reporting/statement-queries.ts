import { createHash } from 'node:crypto'
import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { type TrialBalance, trialBalanceAsAt } from '../queries/trial-balance.ts'
import { canonicaliseVat201WorkingPapers } from '../queries/vat201-working-papers.ts'
import { commissionPeriodSource } from '../repositories/commission.ts'

/**
 * The ledger reads the three financial statements are built from (R-REP-02).
 *
 * The **arithmetic** is `packages/core/src/reporting/statements.ts` and stays there: `packages/db` may
 * never import `packages/core` (ADR 0001), so this module returns ROWS and computes no statement figure of
 * its own. `packages/fixtures/src/statements.itest.ts` is where the two halves meet against a real
 * database, for the reason the brief gives — `packages/fixtures` may depend on both.
 *
 * # Which function is the ONE SOURCE of every figure here
 *
 * A statement set is exactly where a second derivation of an existing money figure creeps in, and a second
 * derivation is worse than a missing one: two numbers, both plausible, with nothing able to say which was
 * filed. So:
 *
 *   | figure                                   | the one source                      | unit     |
 *   | ---------------------------------------- | ----------------------------------- | -------- |
 *   | debits and credits per account to a date | `trialBalanceAsAt`                  | M-VAT-01 |
 *   | the instant a closed period is read at   | `commissionPeriodSource`            | P-HR-11  |
 *   | whether a date is inside a closed period | `periodStatusOn`, through the above | M-VAT-06 |
 *   | the canonical bytes of a money artefact  | `canonicaliseVat201WorkingPapers`   | M-VAT-07 |
 *
 * `periodStatusOn` is deliberately NOT called from this file, and neither is `period_lock` read here.
 * There is one reader of the lock per ADR 0026's arrangement, `commissionPeriodSource` is already its
 * caller, and a statement permitted by one reading of the lock and refused by another is the defect that
 * arrangement exists to prevent.
 *
 * The **movement** over a period is NOT read here either. It is the difference between two positions, and
 * `trial-balance.ts` says whose subtraction that is: "a period report is the difference between two of
 * these, which is a subtraction the caller can do and this function should not guess at." So
 * {@link statementLedgerFigures} returns the opening and the closing position and core subtracts them.
 * `trialBalanceMovement` would be a third read of the same quantity.
 *
 * # What this module IS the first source of
 *
 * Two things, both of which exist to make the statements checkable against `journal_line` rather than
 * against themselves. Measured, not assumed: nothing under `packages`, `apps` or `scripts` reads raw
 * `journal_line` rows for a set of account codes, and nothing counts them over a window.
 *
 *   * {@link statementDrillDown} — the RAW rows behind one line. The statements' figures come from a
 *     `group by account_code` aggregate; this is the row-by-row path. Comparing the two is the acceptance
 *     line "the drill-down returns journal_line rows whose sum equals the line exactly", and it is a real
 *     comparison precisely because the two queries share no `group by`, no `having` and no join to
 *     `account`.
 *   * {@link statementLedgerCensus} — a count and two sums over the whole window with **no reference to
 *     any account set**. An account posted to and claimed by no statement line is invisible to every other
 *     check in this unit and shows up here as a difference.
 *
 * # Every figure is a bigint, and no date is read from a clock
 *
 * `sum()` over the `fils` domain returns `numeric` and `connection.ts` hands it back as a string precisely
 * so nothing rounds it; `trial-balance.ts` records the four fils a `number` produced out of nothing. Both
 * ends of every window are arguments, so the statements for a closed month are the same next year — which
 * is the acceptance line, and impossible to even ask of a query that read `current_date`.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const assertIsoDate = (value: string, what: string): void => {
  if (!ISO_DATE.test(value)) {
    throw new AppError(
      'validation',
      `${what} must be an ISO business day (YYYY-MM-DD), got "${value}"`,
    )
  }
}

export interface StatementPeriod {
  /** The identifier an accountant recognises: `2026-08`, `2026-Q3`. It appears in every refusal. */
  readonly periodId: string
  readonly startsOn: string
  /** The last day **of** the period, not the first day after it. */
  readonly endsOn: string
}

function assertPeriod(period: StatementPeriod): void {
  assertIsoDate(period.startsOn, 'startsOn')
  assertIsoDate(period.endsOn, 'endsOn')
  if (period.endsOn < period.startsOn) {
    throw new AppError(
      'validation',
      `A statement period ends ${period.endsOn}, before it starts ${period.startsOn}. Read backwards ` +
        'it returns nothing and looks like a month with no trade in it.',
    )
  }
  if (period.periodId.trim() === '') {
    throw new AppError(
      'validation',
      'periodId is the identifier an accountant recognises; it is blank',
    )
  }
}

// --- the positions --------------------------------------------------------------------------------

/** Debits and credits on one account, cumulative to a date. `TrialBalanceRow` minus the signing. */
export interface StatementAccountFigure {
  readonly accountCode: string
  readonly debitFils: bigint
  readonly creditFils: bigint
}

export interface StatementLedgerFigures {
  /** The day before the period starts: the position the period opens from. */
  readonly openingAsAt: string
  readonly openingPosition: readonly StatementAccountFigure[]
  readonly closingPosition: readonly StatementAccountFigure[]
}

const figuresOf = (balance: TrialBalance): readonly StatementAccountFigure[] =>
  balance.rows.map((row) => ({
    accountCode: row.accountCode,
    debitFils: row.debitFils,
    creditFils: row.creditFils,
  }))

/**
 * The opening and closing positions for a period.
 *
 * `openingAsAt` is computed by PostgreSQL rather than in TypeScript, and that is not fastidiousness: the
 * day before the first of a month is month-end arithmetic, `packages/core`'s ledger directory is forbidden
 * from constructing a date at all, and a second implementation of "the day before" in JavaScript would be
 * a date rule this build states twice. `date - 1` is one operator in the database that already holds the
 * dates.
 *
 * The position is **exclusive of the period**: `trialBalanceAsAt(startsOn - 1)` is everything dated
 * strictly before the period, so consecutive periods neither overlap nor leave a gap. A closing range
 * would count the first day in both, which is the classic off-by-one in a financial report and shows up as
 * a year that does not add up to its months.
 */
export async function statementLedgerFigures(
  sql: Sql,
  period: StatementPeriod,
): Promise<StatementLedgerFigures> {
  assertPeriod(period)
  const [row] = await sql<{ openingAsAt: string }[]>`
    select (${period.startsOn}::date - 1)::text as "openingAsAt"
  `
  const openingAsAt = row?.openingAsAt
  if (openingAsAt === undefined) {
    throw new AppError(
      'invariant_violated',
      `the opening-date query returned no row for ${period.startsOn}`,
    )
  }
  const [opening, closing] = await Promise.all([
    trialBalanceAsAt(sql, openingAsAt),
    trialBalanceAsAt(sql, period.endsOn),
  ])
  return {
    openingAsAt,
    openingPosition: figuresOf(opening),
    closingPosition: figuresOf(closing),
  }
}

// --- the drill-down -------------------------------------------------------------------------------

export interface StatementDrillDownRow {
  readonly entryId: string
  readonly lineNo: number
  readonly entryDate: string
  readonly source: string
  readonly narrative: string
  readonly accountCode: string
  readonly debitFils: bigint
  readonly creditFils: bigint
  readonly memo: string | null
  /** The entry this one reverses, or null. A dated correction is a new entry pointing at the old one. */
  readonly reverses: string | null
}

export interface StatementDrillDownWindow {
  readonly accountCodes: readonly string[]
  /** `null` for a POSITION: everything dated on or before `toInclusive`, from the beginning. */
  readonly fromInclusive: string | null
  readonly toInclusive: string
}

/**
 * Every `journal_line` row behind one statement line.
 *
 * The rows, not a total. A drill-down that returned a sum would be a third aggregate to reconcile; the
 * caller adds these up with the line's own direction, which is the comparison that makes the line a claim
 * about the ledger. `order by` is fully determined — entry date, entry id, line number — so two runs
 * return the same rows in the same order and the bytes of a rendered drill-down are stable.
 *
 * `accountCodes` empty returns nothing and is refused instead. A line claiming no account is refused in
 * the layout (`statement-line-claims-at-least-one-account`) and this is the same refusal one layer down:
 * an empty `= any(...)` matches nothing, so the drill-down would agree with a zero line for ever.
 */
export async function statementDrillDown(
  sql: Sql,
  window: StatementDrillDownWindow,
): Promise<readonly StatementDrillDownRow[]> {
  if (window.accountCodes.length === 0) {
    throw new AppError(
      'validation',
      'A statement drill-down needs at least one account code. An empty set matches no journal line, ' +
        'so it would agree with any figure at all.',
    )
  }
  assertIsoDate(window.toInclusive, 'toInclusive')
  if (window.fromInclusive !== null) assertIsoDate(window.fromInclusive, 'fromInclusive')
  const rows = await sql<
    {
      entryId: string
      lineNo: number
      entryDate: string
      source: string
      narrative: string
      accountCode: string
      debitFils: string
      creditFils: string
      memo: string | null
      reverses: string | null
    }[]
  >`
    select l.entry_id              as "entryId",
           l.line_no               as "lineNo",
           e.entry_date::text      as "entryDate",
           e.source                as "source",
           e.narrative             as "narrative",
           l.account_code          as "accountCode",
           l.debit_fils::text      as "debitFils",
           l.credit_fils::text     as "creditFils",
           l.memo                  as "memo",
           e.reverses              as "reverses"
      from journal_line l
      join journal_entry e on e.entry_id = l.entry_id
     where l.account_code = any(${window.accountCodes}::text[])
       and e.entry_date <= ${window.toInclusive}::date
       and (${window.fromInclusive}::date is null or e.entry_date >= ${window.fromInclusive}::date)
     order by e.entry_date, l.entry_id, l.line_no
  `
  return rows.map((row) => ({
    entryId: row.entryId,
    lineNo: row.lineNo,
    entryDate: row.entryDate,
    source: row.source,
    narrative: row.narrative,
    accountCode: row.accountCode,
    // BigInt and not Number: the driver returns a bigint column as a string so nothing rounds it, and
    // these rows are the evidence a statement figure is right.
    debitFils: BigInt(row.debitFils),
    creditFils: BigInt(row.creditFils),
    memo: row.memo,
    reverses: row.reverses,
  }))
}

// --- the census -----------------------------------------------------------------------------------

export interface StatementLedgerCensus {
  readonly lineCount: number
  readonly debitFils: bigint
  readonly creditFils: bigint
  readonly accountCodes: readonly string[]
}

/**
 * Everything in the window, counted with no reference to any account set.
 *
 * This is the anchor that stops the statements being checked only against each other. The figures come
 * from `trialBalanceAsAt`, which groups by account and drops accounts with no activity; this counts rows
 * and sums both columns over the window with no `group by` and no `having`. An account posted to that no
 * statement line claims is invisible to every identity in the statements — the sheet still balances,
 * because the missing account is simply absent from both sides — and shows up here as a difference and as
 * a named code.
 *
 * `fromInclusive` null makes it the POSITION census: everything on or before `toInclusive`.
 */
export async function statementLedgerCensus(
  sql: Sql,
  window: { readonly fromInclusive: string | null; readonly toInclusive: string },
): Promise<StatementLedgerCensus> {
  assertIsoDate(window.toInclusive, 'toInclusive')
  if (window.fromInclusive !== null) assertIsoDate(window.fromInclusive, 'fromInclusive')
  const [row] = await sql<
    { lineCount: string; debitFils: string; creditFils: string; accountCodes: string[] | null }[]
  >`
    select count(*)::text                                    as "lineCount",
           coalesce(sum(l.debit_fils), 0)::text              as "debitFils",
           coalesce(sum(l.credit_fils), 0)::text             as "creditFils",
           coalesce(array_agg(distinct l.account_code), '{}') as "accountCodes"
      from journal_line l
      join journal_entry e on e.entry_id = l.entry_id
     where e.entry_date <= ${window.toInclusive}::date
       and (${window.fromInclusive}::date is null or e.entry_date >= ${window.fromInclusive}::date)
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'the ledger census returned no row, which it cannot')
  }
  return {
    lineCount: Number(row.lineCount),
    debitFils: BigInt(row.debitFils),
    creditFils: BigInt(row.creditFils),
    accountCodes: [...(row.accountCodes ?? [])].sort(),
  }
}

// --- as of the lock -------------------------------------------------------------------------------

export interface StatementSource {
  /** The lock's own `locked_at` for a closed period, the caller's instant for an open one. */
  readonly sourceAsOf: string
  readonly lockedPeriodId: string | null
  readonly earliestOpenDate: string
}

/**
 * The instant a period's statements read at, from the one function that answers this.
 *
 * `commissionPeriodSource` (P-HR-11) and not a second reading of `period_lock`: it already asks
 * `periodStatusOn` and already decides "the lock's `locked_at` for a closed period, the caller's instant
 * for an open one", which is exactly the question here. ADR 0053 settled what the answer is FOR — the
 * statements are read at the period's own dates and the discipline is asserted by
 * {@link journalRowsWrittenAfter}, never applied as a `created_at <= sourceAsOf` filter.
 */
export async function statementPeriodSource(
  sql: Sql,
  args: { readonly period: StatementPeriod; readonly nowIso: string },
): Promise<StatementSource> {
  assertPeriod(args.period)
  return commissionPeriodSource(sql, {
    periodEndsOn: args.period.endsOn,
    nowIso: args.nowIso,
  })
}

/**
 * `journal_line` rows dated inside the period whose `created_at` is after the instant read at.
 *
 * Zero in a month that has been closed and left alone, which is what makes "as of the lock" and "as of
 * now" the same answer for every figure in the statements. Non-zero means the period was reopened (ADR
 * 0026 makes that a sanctioned migration) and posted into, and then every figure is about a month that has
 * changed since it was filed — which is the one case a silent `created_at` filter would hide, and the
 * reason ADR 0053 made this a LINE rather than a predicate.
 *
 * Counted on `journal_line.created_at` rather than on `journal_entry.posted_at` because the line is the
 * grain the statements read; a line inserted against an existing entry would move a figure with the
 * entry's own `posted_at` untouched.
 *
 * `${instant}::text::timestamptz` and the `::text` is LOAD-BEARING. postgres.js infers a parameter's type
 * from the cast that follows it, so a bare `::timestamptz` is serialised at MILLISECOND precision while
 * the column holds MICROSECONDS — a `locked_at` of `…:13.123633+00` arrives as `…:13.123+00` and every
 * comparison against the stored value is wrong by up to a millisecond. `repositories/commission.ts`
 * records measuring exactly that.
 */
export async function journalRowsWrittenAfter(
  sql: Sql,
  period: StatementPeriod,
  instant: string,
): Promise<number> {
  assertPeriod(period)
  const [row] = await sql<{ late: string }[]>`
    select count(*)::text as late
      from journal_line l
      join journal_entry e on e.entry_id = l.entry_id
     where e.entry_date between ${period.startsOn}::date and ${period.endsOn}::date
       and l.created_at > ${instant}::text::timestamptz
  `
  return Number(row?.late ?? 0)
}

// --- the bytes ------------------------------------------------------------------------------------

/**
 * The canonical bytes of a statement set.
 *
 * `canonicaliseVat201WorkingPapers` is M-VAT-07's and is USED rather than copied: it sorts keys, drops
 * `undefined` and renders every `bigint` as a decimal string, which is what makes two runs years apart
 * produce the same bytes. A second canonicaliser in this file would be a second answer to "what are the
 * bytes of this artefact", and the first time the two disagreed the question would be which set of bytes
 * an accountant had been handed.
 *
 * Takes `unknown` because the statement set is built in `packages/core` and this package may not import
 * it. The canonical form does not need the type: it walks the value.
 */
export function statementBytes(statements: unknown): string {
  return canonicaliseVat201WorkingPapers(statements)
}

/** sha256 over {@link statementBytes}. The figure two runs compare when the bytes are long. */
export function statementContentHash(statements: unknown): string {
  return createHash('sha256').update(statementBytes(statements)).digest('hex')
}
