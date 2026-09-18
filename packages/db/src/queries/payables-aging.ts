import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * Payables aging: how overdue the money we owe is, as at a date the caller supplies.
 *
 * ## The as-of date is an argument, never `current_date`
 *
 * Every figure in this system has to be reproducible. An aging report that read the clock would give a
 * different answer tomorrow for a period that has already been filed, and the worked example committed
 * in `packages/fixtures/src/purchases.ts` could not exist. The caller passes the **business day**,
 * resolved with `resolveTradingDate` from `@berelax/core` — trading runs 11:00–02:00, so a report cut
 * at 01:30 is the previous trading day's report.
 *
 * ## Why the buckets are computed in SQL
 *
 * By `payables_aging_bucket(due_date, as_of)` from `0028_purchases.sql`, so the grouping happens where
 * the rows are. The same boundaries are stated in `payablesBucketFor` in
 * `packages/core/src/purchases/payables-aging.ts`, because `packages/db` may not import `packages/core`
 * — and `packages/fixtures/src/purchases.itest.ts` asserts the two agree on every boundary day. That
 * is the arrangement `price_list` and `resolve-price.ts` already use, for the same reason and with the
 * same agreement test.
 *
 * ## Every figure here is a bigint
 *
 * `sum()` over the `fils` domain returns numeric, and the driver hands it back as a **string** so that
 * nothing can silently round a money total. `BigInt`, not `Number`: `trial-balance.ts` documents the
 * four-fils difference a `number` produced out of nothing, and an aging report is read by whoever is
 * about to pay somebody.
 *
 * ## What "outstanding" means today
 *
 * The full gross of every posted bill. There is no payment or settlement table yet — no unit in the
 * manifest builds one before this — so nothing has been paid and every bill is outstanding in full.
 * When settlement arrives it is an allocation row pointing at the bill (never an UPDATE of it, which
 * the append-only triggers refuse), and this becomes `gross_fils - coalesce(allocated, 0)`: a join, not
 * a redesign. `NOTE` in the manifest says the same thing where a reader of the acceptance will see it.
 */

/**
 * The buckets, in report order. Mirrors `PAYABLES_AGING_BUCKETS` in `@berelax/core`.
 *
 * Five, where the acceptance names four (current/30/60/90+): all four named ones are here and mean
 * literally what they say, and 61–90 exists because a bucket labelled "90+" holding a 75-day payable
 * misstates the oldest debt in the business, which is the one figure an aging report is opened for.
 */
export const PAYABLES_AGING_BUCKETS = [
  'current',
  'days_1_30',
  'days_31_60',
  'days_61_90',
  'days_over_90',
] as const
export type PayablesAgingBucket = (typeof PAYABLES_AGING_BUCKETS)[number]

export interface OutstandingPayable {
  /** Our own internal reference, e.g. `BILL-2026-00001`. */
  readonly reference: string
  readonly billId: string
  readonly supplierCode: string
  /** The supplier's own invoice number, which is what they will quote when chased. */
  readonly supplierReference: string
  readonly dueDate: string
  readonly outstandingFils: bigint
  readonly bucket: PayablesAgingBucket
}

export interface PayablesAgingRow {
  readonly bucket: PayablesAgingBucket
  readonly totalFils: bigint
  readonly billCount: number
  /** The references in the bucket, sorted, so two runs produce identical working papers. */
  readonly references: readonly string[]
}

export interface PayablesAgingReport {
  readonly asOf: string
  /** All five buckets, always, in report order. An absent bucket is a zero, not a gap. */
  readonly rows: readonly PayablesAgingRow[]
  readonly totalFils: bigint
  readonly billCount: number
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertIsoDate(asOf: string): void {
  if (!ISO_DATE.test(asOf)) {
    throw new AppError('validation', `asOf must be an ISO business day (YYYY-MM-DD), got "${asOf}"`)
  }
}

/**
 * Every outstanding payable with the bucket it falls in, oldest first.
 *
 * Ordered by due date and then by reference: a stable order, so a printed aging report diffs only
 * where a figure changed. Oldest first because that is the order somebody chasing payment reads.
 */
export async function outstandingPayables(
  sql: Sql,
  asOf: string,
  options: { readonly supplierCode?: string } = {},
): Promise<readonly OutstandingPayable[]> {
  assertIsoDate(asOf)
  const rows = await sql<
    {
      reference: string
      bill_id: string
      supplier_code: string
      supplier_reference: string
      due_date: string
      outstanding_fils: string
      bucket: string
    }[]
  >`
    select b.display_number as reference,
           b.bill_id::text  as bill_id,
           s.code           as supplier_code,
           b.supplier_reference,
           b.due_date::text as due_date,
           b.gross_fils::text as outstanding_fils,
           payables_aging_bucket(b.due_date, ${asOf}::date) as bucket
    from bill b
    join supplier s on s.supplier_id = b.supplier_id
    where (${options.supplierCode ?? null}::text is null or s.code = ${options.supplierCode ?? null})
    order by b.due_date, b.display_number
  `
  return rows.map((row) => ({
    reference: row.reference,
    billId: row.bill_id,
    supplierCode: row.supplier_code,
    supplierReference: row.supplier_reference,
    dueDate: row.due_date,
    // The driver returns the `fils` domain as a string precisely so nothing rounds; BigInt, not Number.
    outstandingFils: BigInt(row.outstanding_fils),
    bucket: row.bucket as PayablesAgingBucket,
  }))
}

/**
 * The aging report: one row per bucket, totalled in the database.
 *
 * The totals are summed by PostgreSQL rather than by adding up the rows above, so a caller that wants
 * only the five figures does not pull every bill across the wire — and the two are asserted equal by
 * the integration test, because "the totals match the detail" is the property an aging report lives or
 * dies by.
 */
export async function payablesAging(
  sql: Sql,
  asOf: string,
  options: { readonly supplierCode?: string } = {},
): Promise<PayablesAgingReport> {
  assertIsoDate(asOf)
  const rows = await sql<
    { bucket: string; total_fils: string; bill_count: string; references: string[] }[]
  >`
    select payables_aging_bucket(b.due_date, ${asOf}::date) as bucket,
           sum(b.gross_fils)::text as total_fils,
           count(*)::text          as bill_count,
           array_agg(b.display_number order by b.display_number) as references
    from bill b
    join supplier s on s.supplier_id = b.supplier_id
    where (${options.supplierCode ?? null}::text is null or s.code = ${options.supplierCode ?? null})
    group by 1
  `

  const byBucket = new Map(rows.map((row) => [row.bucket, row]))
  const shaped = PAYABLES_AGING_BUCKETS.map((bucket) => {
    const row = byBucket.get(bucket)
    return {
      bucket,
      totalFils: row === undefined ? 0n : BigInt(row.total_fils),
      billCount: row === undefined ? 0 : Number(row.bill_count),
      references: row?.references ?? [],
    }
  })

  return {
    asOf,
    rows: shaped,
    totalFils: shaped.reduce((total, row) => total + row.totalFils, 0n),
    billCount: shaped.reduce((count, row) => count + row.billCount, 0),
  }
}

/** The total of one bucket, or zero. For a caller that wants one figure without a find(). */
export function bucketTotalFils(report: PayablesAgingReport, bucket: PayablesAgingBucket): bigint {
  return report.rows.find((row) => row.bucket === bucket)?.totalFils ?? 0n
}

/**
 * Everything past due: the total less what is not yet due.
 *
 * Subtracted rather than re-summed from the four overdue buckets, so the two figures on a report cannot
 * disagree by a fils.
 */
export function overdueTotalFils(report: PayablesAgingReport): bigint {
  return report.totalFils - bucketTotalFils(report, 'current')
}
