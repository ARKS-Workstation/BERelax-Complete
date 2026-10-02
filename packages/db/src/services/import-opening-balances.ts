import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The write path and the one translator for an imported opening trial balance (H-MIG-07, migration 0132).
 *
 * `packages/migration` may import this package and `@berelax/shared` and nothing else first-party, so
 * every statement this import issues against `journal_entry`, `journal_line` and
 * `opening_balance_import` is here. The arithmetic is `@berelax/core`'s — `openingTrialBalance` and
 * `openingRemainder` in `ledger/period-lock.ts` — and the importer takes its answers as arguments.
 *
 * ## The read that has to happen BEFORE the post
 *
 * {@link readOpeningBalancePostings} is the whole reason this file exists rather than one insert.
 * H-MIG-03's reconstructed package liability posts on `journal_entry.source = 'opening_balance'`
 * (ADR 0069) and so does this import, so the attested opening position is a SET of entries. The import
 * therefore reads what that source already holds at the boundary, posts the REMAINDER per account, and
 * attests the SUM — and `ZY382` refuses, at COMMIT, an attestation whose totals are not the ledger's.
 *
 * An import that skipped the read would state totals smaller than the lines and could not commit; an
 * import that posted its own copy of the liability would state totals that balanced perfectly and still
 * could not commit, because the boundary's sum would be twice the liability. Both are the failure 0027
 * names as the one nobody detects afterwards: the books balance, they are simply larger.
 */

/** The SQLSTATEs `packages/db/migrations/0132_opening_boundary.sql` raises. */
export const OPENING_BOUNDARY_SQLSTATE = {
  /** An entry dated before the boundary, whatever its source, once an opening balance is imported. */
  behindTheBoundary: 'ZY381',
  /** The attested totals do not equal the opening_balance lines at the boundary. Raised at COMMIT. */
  openingTotalsDoNotTieToTheLedger: 'ZY382',
  /** A further opening_balance entry dated ON a boundary that is already attested. */
  openingPositionIsClosed: 'ZY383',
  /** An opening-balance import was updated or deleted. */
  openingBalanceImportImmutable: 'ZY384',
} as const

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a refusal from 0132 into an `AppError`, or `null` for anything else.
 *
 * The KINDS are chosen by what the caller has to go and do:
 *
 *   - `validation` for ZY381 — a date in the thing being posted is wrong, and it is a date somebody can
 *     go and look at.
 *   - `conflict` for ZY383 — nothing about the caller's data is wrong. The opening position is already
 *     attested, and the answer is a dated reversal and a re-based import rather than a correction here.
 *   - `invariant_violated` for ZY382 — this code, not the person running the import, attested totals
 *     that are not the ledger's. A validation failure would send whoever reads it to the spreadsheet,
 *     which is the one place the defect is not: the figures in the file are what they are, and the
 *     import failed to read what was already posted.
 *   - `forbidden` for ZY384 — the statement will never be permitted, for any caller, with any data.
 */
export function openingBoundaryError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  const details = { sqlState: code }
  switch (code) {
    case OPENING_BOUNDARY_SQLSTATE.behindTheBoundary:
      return new AppError('validation', message, { details })
    case OPENING_BOUNDARY_SQLSTATE.openingPositionIsClosed:
      return new AppError('conflict', message, { details })
    case OPENING_BOUNDARY_SQLSTATE.openingTotalsDoNotTieToTheLedger:
      return new AppError('invariant_violated', message, { details })
    case OPENING_BOUNDARY_SQLSTATE.openingBalanceImportImmutable:
      return new AppError('forbidden', message, { details })
    default:
      return null
  }
}

export const isBehindTheBoundaryRefusal = (err: unknown): boolean =>
  sqlState(err) === OPENING_BOUNDARY_SQLSTATE.behindTheBoundary

/** One account's signed position, in fils: debits less credits. */
export interface AccountPosition {
  readonly accountCode: string
  readonly netFils: number
}

/**
 * What `opening_balance` entries already hold, per account, at a boundary.
 *
 * Signed (debits less credits) and per ACCOUNT, because that is the granularity the remainder is computed
 * at. Read split by journal SOURCE and not by date alone, which is ADR 0071's rule for the same figure
 * one report along: a posting from outside the opening path is a named variance rather than one absorbed.
 */
export async function readOpeningBalancePostings(
  sql: Sql,
  openingDate: string,
): Promise<readonly AccountPosition[]> {
  const rows = await sql<{ accountCode: string; netFils: string }[]>`
    select l.account_code as "accountCode",
           (sum(l.debit_fils) - sum(l.credit_fils))::text as "netFils"
      from journal_line l
      join journal_entry e on e.entry_id = l.entry_id
     where e.source = 'opening_balance'
       and e.entry_date = ${openingDate}::date
     group by l.account_code
     order by l.account_code
  `
  return rows.map((row) => ({ accountCode: row.accountCode, netFils: Number(row.netFils) }))
}

/** Has an opening balance already been attested for this boundary? */
export async function openingBalanceIsAttested(sql: Sql, openingDate: string): Promise<boolean> {
  const rows = await sql<{ attested: boolean }[]>`
    select true as attested from opening_balance_import where opening_date = ${openingDate}::date
  `
  return rows[0]?.attested === true
}

/** The earliest boundary any import has attested, or null before the first one. */
export async function readOpeningBoundary(sql: Sql): Promise<string | null> {
  const rows = await sql<{ opensOn: string | null }[]>`
    select opening_date_for()::text as "opensOn"
  `
  return rows[0]?.opensOn ?? null
}

/** The legal-entity singleton. Refused loudly rather than defaulted — 0027's guard takes 1 by default. */
export async function readLegalEntityId(sql: Sql): Promise<number> {
  const rows = await sql<{ id: number }[]>`select id from legal_entity order by id`
  if (rows.length !== 1) {
    throw new AppError(
      'invariant_violated',
      `There are ${rows.length} legal_entity rows and an opening balance is attested for exactly one. ` +
        'Refused rather than defaulted to the first: `opening_balance_import` is unique on ' +
        '(legal_entity_id, opening_date), so a guess here attaches the whole opening position to the ' +
        'wrong entity and the unique key then prevents the right one.',
    )
  }
  const id = rows[0]?.id
  if (id === undefined)
    throw new AppError('invariant_violated', 'The legal_entity read returned no id.')
  return id
}

/** The accounts the chart in force holds, so a file naming one it does not can be refused by name. */
export async function readChartAccountCodes(sql: Sql): Promise<readonly string[]> {
  const rows = await sql<{ code: string }[]>`select code from account order by code`
  return rows.map((row) => row.code)
}

export interface ImportedOpeningEntryLine {
  readonly accountCode: string
  readonly debitFils: number
  readonly creditFils: number
}

/**
 * The reconciliation this unit's fourth acceptance line asks for, per account and in fils.
 *
 * *"the opening balance sheet ties to the H-MIG-03 package liability, cash and bank to the fils, asserted
 * by a reconciliation test."* `stated` is what the file attested for the account, `posted` is what
 * `opening_balance` entries at the boundary actually hold for it, and `variance` is the difference. A
 * variance of zero on every row is the tie; anything else is named rather than absorbed, which is ADR
 * 0071's rule for the same figure one report along.
 *
 * It is a READ and not a stored figure, for ADR 0064's reason: a statement line holds no figure of its
 * own, so a materialised reconciliation would be a second copy of a sum the journal already makes — and
 * the first thing it would be wrong about is a correction posted after it was stored.
 */
export interface OpeningReconciliationRow {
  readonly accountCode: string
  readonly statedFils: number
  readonly postedFils: number
  readonly varianceFils: number
}

export async function reconcileOpeningPosition(
  sql: Sql,
  args: {
    readonly openingDate: string
    /** What the file attested, per account, signed: debits less credits. */
    readonly stated: readonly AccountPosition[]
  },
): Promise<readonly OpeningReconciliationRow[]> {
  const posted = new Map(
    (await readOpeningBalancePostings(sql, args.openingDate)).map((row) => [
      row.accountCode,
      row.netFils,
    ]),
  )
  const codes = [
    ...new Set([...args.stated.map((row) => row.accountCode), ...posted.keys()]),
  ].sort()
  const stated = new Map(args.stated.map((row) => [row.accountCode, row.netFils]))
  return codes.map((accountCode) => {
    const statedFils = stated.get(accountCode) ?? 0
    const postedFils = posted.get(accountCode) ?? 0
    return { accountCode, statedFils, postedFils, varianceFils: statedFils - postedFils }
  })
}

export interface Vat201AccountAttribution {
  readonly accountCode: string
  readonly disposition: string
  readonly boxNo: number | null
  readonly openQuestionId: string | null
}

/**
 * Every account's VAT201 attribution, for the completeness assertion.
 *
 * A LEFT JOIN from `account`, so an account with no attribution appears with a null disposition. That is
 * the shape the claim needs: `account_carries_a_vat201_attribution` (ZY009) refuses such a row at COMMIT,
 * so the assertion over this read is a measurement of a rule rather than a restatement of it — and a
 * query that inner-joined would report completeness by construction.
 */
export async function readVat201Attributions(
  sql: Sql,
): Promise<readonly Vat201AccountAttribution[]> {
  return sql<Vat201AccountAttribution[]>`
    select a.code                as "accountCode",
           m.disposition         as disposition,
           m.box_no              as "boxNo",
           m.open_question_id    as "openQuestionId"
      from account a
      left join vat201_box_mapping m on m.account_code = a.code
     order by a.code
  `
}
