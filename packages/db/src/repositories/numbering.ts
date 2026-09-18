import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * Statutory document numbering.
 *
 * ## The one rule
 *
 * `allocateDocumentNumber` takes a {@link UnitOfWork}, not a connection, and that is the whole
 * design. The number must be allocated **inside the transaction that inserts the document**: the
 * `UPDATE` on the counter row takes a lock that serialises issuers, and the rollback is what returns
 * an unused number to the pool. Allocate first, insert afterwards in a second transaction, and every
 * failed insert leaves a permanent hole in the range.
 *
 * Taking a `UnitOfWork` makes that structural rather than remembered. There is no overload that
 * accepts a pool, because the compiling-but-wrong call is the one worth making impossible.
 *
 * ## Why not a SEQUENCE
 *
 * `nextval` is non-transactional on purpose — that is what lets it scale — so it neither locks nor
 * rolls back, and a rolled-back transaction consumes its number for good. Gaps are harmless in a
 * surrogate key and are the first thing an FTA auditor asks about in an invoice range. See
 * `docs/adr/0023-gapless-numbering-row-locked-counter.md`.
 *
 * ## Why the display number is not formatted here
 *
 * `display_number` comes back from the database already composed, by
 * `document_number_display(prefix, period_key, padding, number)`. Re-implementing that formatting in
 * TypeScript would give a statutory identifier two definitions, and the day they disagree is the day
 * a document has already been filed under one of them.
 */

/** The three series the migration seeds. Adding one is a migration, not a settings change. */
export const DOCUMENT_SERIES_CODES = ['TAX-INV', 'SIMPL-INV', 'CR-NOTE'] as const
export type DocumentSeriesCode = (typeof DOCUMENT_SERIES_CODES)[number]

export interface AllocatedDocumentNumber {
  readonly seriesCode: string
  /** The reset period the number belongs to: '' under the 'never' policy, 'YYYY' under 'annual'. */
  readonly periodKey: string
  /**
   * The sequential integer. Gap reporting runs on this, not on the string.
   *
   * A JS number, deliberately: a document number that reached 2^53 would mean the spa had issued
   * nine quadrillion invoices. The counter itself is a bigint in the database, where it costs
   * nothing to be right.
   */
  readonly number: number
  /** The formatted identifier, exactly as it must be stored on the document and printed on it. */
  readonly displayNumber: string
}

/**
 * A run of numbers that does not start where the previous one ended.
 *
 * Zero of these across a series means the issued numbers are exactly `1..n`, contiguous and without
 * duplicates. `missingBefore` is how many numbers are absent at or before this run.
 */
export interface NumberingGap {
  readonly seriesCode: string
  readonly periodKey: string
  readonly missingBefore: number
  readonly firstNumber: number
  readonly lastNumber: number
  readonly runLength: number
}

interface AllocationRow {
  readonly series_code: string
  readonly period_key: string
  readonly number: string
  readonly display_number: string
}

/**
 * Allocates the next number in `seriesCode`, inside `uow`'s transaction.
 *
 * `tradingDate` is the document's **business day**, not the wall clock and not `now()`. Trading runs
 * 11:00-02:00, so a 01:30 sale belongs to the previous trading date; resolve it with
 * `resolveTradingDate` from `@berelax/core` and pass the result. Under the 'annual' reset policy that
 * date decides which year's range the document joins, so taking it from an ambient clock would put a
 * New Year's Eve invoice in the wrong statutory year roughly once a year.
 */
export async function allocateDocumentNumber(
  uow: UnitOfWork,
  seriesCode: string,
  tradingDate: string,
): Promise<AllocatedDocumentNumber> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate)) {
    throw new AppError(
      'validation',
      `tradingDate must be an ISO business day (YYYY-MM-DD), received "${tradingDate}"`,
    )
  }

  const rows = await uow.sql<AllocationRow[]>`
    select series_code, period_key, number, display_number
    from allocate_document_number(${seriesCode}, ${tradingDate}::date)
  `

  const row = rows[0]
  if (!row) {
    // The function raises on an unknown series, so reaching here means the shape changed underneath
    // us. Failing loudly beats returning a document number of NaN.
    throw new AppError(
      'invariant_violated',
      `allocate_document_number returned no row for "${seriesCode}"`,
    )
  }

  return {
    seriesCode: row.series_code,
    periodKey: row.period_key,
    number: Number(row.number),
    displayNumber: row.display_number,
  }
}

/** A series as configured: the format an admin may change, and the counter they may not. */
export interface DocumentSeriesRow {
  readonly code: string
  readonly documentKind: string
  readonly prefix: string
  readonly padding: number
  readonly resetPolicy: string
  readonly nextNumber: number
  readonly periodKey: string
}

export async function listDocumentSeries(sql: Sql): Promise<readonly DocumentSeriesRow[]> {
  const rows = await sql<
    {
      code: string
      document_kind: string
      prefix: string
      padding: number
      reset_policy: string
      next_number: string
      period_key: string
    }[]
  >`
    select code, document_kind, prefix, padding, reset_policy, next_number, period_key
    from document_series
    order by code
  `
  return rows.map((r) => ({
    code: r.code,
    documentKind: r.document_kind,
    prefix: r.prefix,
    padding: r.padding,
    resetPolicy: r.reset_policy,
    nextNumber: Number(r.next_number),
    periodKey: r.period_key,
  }))
}

/**
 * Column names every table of issued documents must expose for {@link findNumberingGaps} to read it.
 *
 * The gap report is parameterised by relation because the document tables do not exist yet
 * (M-TILL-04 adds `invoice`, and credit notes follow it). The report is the auditor's question, and
 * it belongs with the numbering mechanism rather than being written a third time in each document
 * module.
 */
export const NUMBERING_LEDGER_COLUMNS = [
  'series_code',
  'period_key',
  'number',
  'display_number',
] as const

/**
 * The gap report: `number - row_number() over (partition by series order by number)`.
 *
 * Within one contiguous run that expression is constant, and for a range that starts at 1 with no
 * holes the constant is **0**. So every returned row is a run that starts late — a gap before it, a
 * duplicate inside it (which makes the offset negative), or a series whose first document is not
 * number 1. Zero rows is the whole assertion.
 *
 * `relation` is interpolated as an identifier, never as text, so a schema-qualified name is escaped
 * rather than concatenated.
 */
export async function findNumberingGaps(
  sql: Sql,
  relation: string,
): Promise<readonly NumberingGap[]> {
  const parts = relation.split('.')
  if (parts.length > 2 || parts.some((p) => !/^[a-z_][a-z0-9_]*$/.test(p))) {
    throw new AppError('validation', `not a relation name: "${relation}"`)
  }

  const rows = await sql<
    {
      series_code: string
      period_key: string
      missing_before: string
      first_number: string
      last_number: string
      run_length: string
    }[]
  >`
    with numbered as (
      select series_code,
             period_key,
             number,
             number - row_number() over (
               partition by series_code, period_key order by number
             ) as run_offset
      from ${sql(relation)}
    )
    select series_code,
           period_key,
           run_offset          as missing_before,
           min(number)         as first_number,
           max(number)         as last_number,
           count(*)            as run_length
    from numbered
    where run_offset <> 0
    group by series_code, period_key, run_offset
    order by series_code, period_key, first_number
  `

  return rows.map((r) => ({
    seriesCode: r.series_code,
    periodKey: r.period_key,
    missingBefore: Number(r.missing_before),
    firstNumber: Number(r.first_number),
    lastNumber: Number(r.last_number),
    runLength: Number(r.run_length),
  }))
}
