import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * Input VAT recovery for a period: what may be claimed, and what may not, with the reason.
 *
 * This is the input side of the VAT201 working papers. The box **numbering** and the full return —
 * output tax, the reverse-charge pair, the partition proof and the drill-down from every box — are
 * M-VAT-07's, which reads this; what lives here is the classification M-VAT-02 owns and the figure the
 * claim is made of.
 *
 * ## Read from what was recorded, never re-derived
 *
 * Every figure below is summed from `bill_line.recoverable_input_vat_fils` and
 * `bill_line.blocked_input_vat_fils`, written when the bill was posted and immutable afterwards (ADR
 * 0017). Nothing here joins `account` to decide what was recoverable, and that omission is the point: a
 * return that recomputed recoverability from today's chart would silently restate a filed period the day
 * an interpretation changes, and Y11-blocked-vat is exactly such an interpretation — the day the tax
 * agent answers it, last quarter's return must not move. `reclassifyAccountRecoverability` changes what
 * the next bill records; it cannot reach these figures.
 *
 * The account **name** and its current classification are joined for the working paper's own readability,
 * and they are labels rather than figures: no amount in this report depends on them.
 *
 * ## Nothing is dropped, everything is disclosed
 *
 * A blocked bill must not simply be absent from the return. It appears under an explicit
 * non-recoverable disclosure row — the tax the business bore and did not claim — and the three reasons
 * are reported as a fixed list so that a zero is a row rather than a gap. That is what makes "we claimed
 * nothing on entertainment" evidence instead of silence, which is the same argument
 * `PAYABLES_AGING_BUCKETS` makes about an empty bucket.
 *
 * ## The period is the business day, and both ends are arguments
 *
 * A bill's period is `journal_entry.entry_date` — the **business day** the caller resolved with
 * `resolveTradingDate` (trading runs 11:00–02:00, so 01:30 belongs to the previous trading date), and the
 * only date on a bill that decides which VAT period it lands in. `bill_date` is the supplier's tax point
 * and is deliberately not used: a December invoice entered in January is posted, and claimed, in January.
 * Neither end is ever `current_date`; a return that read the clock could not be regenerated for a closed
 * period, and regenerating it identically is M-VAT-08's whole premise.
 *
 * ## Every figure is a bigint
 *
 * `sum()` over the `fils` domain returns numeric and the driver hands it back as a **string**, so nothing
 * can silently round. `BigInt`, not `Number`: `./trial-balance.ts` documents the four-fils difference a
 * `number` produced out of nothing, and this is the figure a claim is made on.
 */

/**
 * Why a line's VAT is not in the claim. A fixed list, reported whether or not the period has any.
 *
 *   `blocked_category`  the supplier charged VAT and UAE VAT denies recovery on the category — the
 *                       disclosure this unit exists for.
 *   `no_supplier_trn`   the supplier held no TRN when the bill was recorded, so there is no valid tax
 *                       invoice and nothing was claimable.
 *   `no_vat_charged`    a zero-rated, exempt or out-of-scope supply: no VAT existed to claim.
 *
 * The distinction between the first and the last is the one a tax agent asks about: one is tax the
 * business bore, the other is tax that was never charged, and a single "not recoverable" bucket cannot
 * tell them apart.
 */
export const INPUT_VAT_NON_RECOVERY_REASONS = [
  'blocked_category',
  'no_supplier_trn',
  'no_vat_charged',
] as const
export type InputVatNonRecoveryReason = (typeof INPUT_VAT_NON_RECOVERY_REASONS)[number]

export interface InputVatDisclosureRow {
  readonly reason: InputVatNonRecoveryReason
  readonly lineCount: number
  readonly netFils: bigint
  readonly grossFils: bigint
  /** The VAT borne and not claimed. Non-zero only for `blocked_category`. */
  readonly nonRecoverableVatFils: bigint
}

export interface InputVatAccountRow {
  readonly accountCode: string
  readonly accountName: string
  /** The account's classification **today**, a label for the reader. No figure depends on it. */
  readonly recoverabilityNow: string
  readonly lineCount: number
  readonly netFils: bigint
  readonly vatFils: bigint
  readonly recoverableInputVatFils: bigint
  readonly blockedInputVatFils: bigint
}

export interface BlockedInputVatLine {
  /** Our own internal reference, so the disclosure drills down to a document. */
  readonly reference: string
  readonly billId: string
  readonly lineNo: number
  readonly supplierCode: string
  readonly supplierReference: string
  readonly entryDate: string
  readonly accountCode: string
  readonly description: string
  readonly netFils: bigint
  readonly blockedInputVatFils: bigint
}

export interface InputVatRecoveryWorkingPaper {
  readonly from: string
  readonly to: string
  /** What the period may claim: the sum of the recoverable lines. */
  readonly recoverableInputVatFils: bigint
  /** The non-recoverable disclosure figure: the sum of the blocked lines. */
  readonly blockedInputVatFils: bigint
  /** Every reason, always, in report order. An absent reason is a zero row, never a gap. */
  readonly disclosures: readonly InputVatDisclosureRow[]
  /** One row per expense account touched, for the working paper's detail. */
  readonly accounts: readonly InputVatAccountRow[]
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface InputVatPeriod {
  readonly from: string
  readonly to: string
  /** Narrows to one supplier. For a test that must not see another suite's rows, not for a return. */
  readonly supplierCode?: string
}

function assertPeriod(period: InputVatPeriod): void {
  for (const [label, value] of [
    ['from', period.from],
    ['to', period.to],
  ] as const) {
    if (!ISO_DATE.test(value)) {
      throw new AppError(
        'validation',
        `${label} must be an ISO business day (YYYY-MM-DD), got "${value}"`,
      )
    }
  }
  if (period.to < period.from) {
    throw new AppError(
      'validation',
      `The period ends ${period.to}, before it starts ${period.from}. A VAT period read backwards ` +
        'returns nothing and looks like a period with no purchases in it.',
    )
  }
}

/**
 * The reason a line's VAT is not claimable, in SQL, derived from the **recorded treatment**.
 *
 * From `tax_treatment` rather than from the amounts: the treatment is the classification the preparer
 * recorded, and the amounts are its consequence. Reading `blocked_input_vat_fils > 0` instead would give
 * the same answer today and would silently reclassify a line the day a CHECK is relaxed.
 */
const REASON_SQL = `case
    when l.tax_treatment = 'blocked_not_recoverable' then 'blocked_category'
    when l.tax_treatment = 'no_trn_not_recoverable'  then 'no_supplier_trn'
    else 'no_vat_charged'
  end`

/**
 * The input-VAT working paper for a period: one claim figure, one disclosure figure, and the reasons.
 *
 * Three round trips rather than one — the totals, the reasons and the per-account detail — because each
 * groups differently and a single query would either return the detail to a caller that wanted the total
 * or make the caller sum rows the database can sum.
 */
export async function inputVatRecovery(
  sql: Sql,
  period: InputVatPeriod,
): Promise<InputVatRecoveryWorkingPaper> {
  assertPeriod(period)
  const supplierCode = period.supplierCode ?? null

  const [totals] = await sql<{ recoverable: string; blocked: string }[]>`
    select coalesce(sum(l.recoverable_input_vat_fils), 0)::text as recoverable,
           coalesce(sum(l.blocked_input_vat_fils), 0)::text     as blocked
    from bill_line l
    join bill b          on b.bill_id = l.bill_id
    join journal_entry e on e.entry_id = b.entry_id
    join supplier s      on s.supplier_id = b.supplier_id
    where e.entry_date between ${period.from}::date and ${period.to}::date
      and (${supplierCode}::text is null or s.code = ${supplierCode})
  `

  const reasons = await sql<
    {
      reason: string
      line_count: string
      net_fils: string
      gross_fils: string
      non_recoverable_vat_fils: string
    }[]
  >`
    select ${sql.unsafe(REASON_SQL)}                        as reason,
           count(*)::text                                   as line_count,
           coalesce(sum(l.net_fils), 0)::text               as net_fils,
           coalesce(sum(l.gross_fils), 0)::text             as gross_fils,
           coalesce(sum(l.blocked_input_vat_fils), 0)::text as non_recoverable_vat_fils
    from bill_line l
    join bill b          on b.bill_id = l.bill_id
    join journal_entry e on e.entry_id = b.entry_id
    join supplier s      on s.supplier_id = b.supplier_id
    where e.entry_date between ${period.from}::date and ${period.to}::date
      and (${supplierCode}::text is null or s.code = ${supplierCode})
      -- The claim is not a disclosure. A recoverable line belongs in the box, not in the list of
      -- reasons nothing was claimed.
      and l.tax_treatment <> 'standard_recoverable'
    group by 1
  `

  const accounts = await sql<
    {
      account_code: string
      account_name: string
      recoverability_now: string
      line_count: string
      net_fils: string
      vat_fils: string
      recoverable_input_vat_fils: string
      blocked_input_vat_fils: string
    }[]
  >`
    select l.expense_account_code                            as account_code,
           a.name                                            as account_name,
           case
             when a.vat_box = 'blocked_input_tax' then 'blocked'
             when a.input_vat_recoverable then 'recoverable'
             else 'out_of_scope'
           end                                               as recoverability_now,
           count(*)::text                                    as line_count,
           coalesce(sum(l.net_fils), 0)::text                as net_fils,
           coalesce(sum(l.vat_fils), 0)::text                as vat_fils,
           coalesce(sum(l.recoverable_input_vat_fils), 0)::text as recoverable_input_vat_fils,
           coalesce(sum(l.blocked_input_vat_fils), 0)::text  as blocked_input_vat_fils
    from bill_line l
    join bill b          on b.bill_id = l.bill_id
    join journal_entry e on e.entry_id = b.entry_id
    join supplier s      on s.supplier_id = b.supplier_id
    join account a       on a.code = l.expense_account_code
    where e.entry_date between ${period.from}::date and ${period.to}::date
      and (${supplierCode}::text is null or s.code = ${supplierCode})
    group by 1, 2, 3
    order by 1
  `

  const byReason = new Map(reasons.map((row) => [row.reason, row]))
  return {
    from: period.from,
    to: period.to,
    recoverableInputVatFils: BigInt(totals?.recoverable ?? '0'),
    blockedInputVatFils: BigInt(totals?.blocked ?? '0'),
    disclosures: INPUT_VAT_NON_RECOVERY_REASONS.map((reason) => {
      const row = byReason.get(reason)
      return {
        reason,
        lineCount: row === undefined ? 0 : Number(row.line_count),
        netFils: row === undefined ? 0n : BigInt(row.net_fils),
        grossFils: row === undefined ? 0n : BigInt(row.gross_fils),
        nonRecoverableVatFils: row === undefined ? 0n : BigInt(row.non_recoverable_vat_fils),
      }
    }),
    accounts: accounts.map((row) => ({
      accountCode: row.account_code,
      accountName: row.account_name,
      recoverabilityNow: row.recoverability_now,
      lineCount: Number(row.line_count),
      netFils: BigInt(row.net_fils),
      vatFils: BigInt(row.vat_fils),
      recoverableInputVatFils: BigInt(row.recoverable_input_vat_fils),
      blockedInputVatFils: BigInt(row.blocked_input_vat_fils),
    })),
  }
}

/**
 * The lines behind the blocked disclosure, oldest first: the drill-down from the figure to the document.
 *
 * A disclosure figure nobody can trace to an invoice is a number a tax agent has to take on trust, and
 * the whole reason the classification is stored per line is that it can be traced years later.
 */
export async function blockedInputVatLines(
  sql: Sql,
  period: InputVatPeriod,
): Promise<readonly BlockedInputVatLine[]> {
  assertPeriod(period)
  const supplierCode = period.supplierCode ?? null
  const rows = await sql<
    {
      reference: string
      bill_id: string
      line_no: number
      supplier_code: string
      supplier_reference: string
      entry_date: string
      account_code: string
      description: string
      net_fils: string
      blocked_input_vat_fils: string
    }[]
  >`
    select b.display_number   as reference,
           b.bill_id::text    as bill_id,
           l.line_no,
           s.code             as supplier_code,
           b.supplier_reference,
           e.entry_date::text as entry_date,
           l.expense_account_code as account_code,
           l.description,
           l.net_fils::text   as net_fils,
           l.blocked_input_vat_fils::text as blocked_input_vat_fils
    from bill_line l
    join bill b          on b.bill_id = l.bill_id
    join journal_entry e on e.entry_id = b.entry_id
    join supplier s      on s.supplier_id = b.supplier_id
    where e.entry_date between ${period.from}::date and ${period.to}::date
      and (${supplierCode}::text is null or s.code = ${supplierCode})
      and l.tax_treatment = 'blocked_not_recoverable'
    order by e.entry_date, b.display_number, l.line_no
  `
  return rows.map((row) => ({
    reference: row.reference,
    billId: row.bill_id,
    lineNo: row.line_no,
    supplierCode: row.supplier_code,
    supplierReference: row.supplier_reference,
    entryDate: row.entry_date,
    accountCode: row.account_code,
    description: row.description,
    netFils: BigInt(row.net_fils),
    blockedInputVatFils: BigInt(row.blocked_input_vat_fils),
  }))
}

/** One disclosure row, or a zero row. For a caller that wants one figure without a find(). */
export function disclosureFor(
  paper: InputVatRecoveryWorkingPaper,
  reason: InputVatNonRecoveryReason,
): InputVatDisclosureRow {
  return (
    paper.disclosures.find((row) => row.reason === reason) ?? {
      reason,
      lineCount: 0,
      netFils: 0n,
      grossFils: 0n,
      nonRecoverableVatFils: 0n,
    }
  )
}
