import { AppError } from '@berelax/shared'
import { type Money, subtract, sum, ZERO_AED } from '../money.ts'
import { type LocalDate, localDate } from '../time.ts'

/**
 * Payables aging: how overdue the money we owe is, as at a date somebody supplies.
 *
 * ## The as-of date is an argument, always
 *
 * There is no clock here — `scripts/check-core-purity.mjs` would refuse one, and the rule exists for
 * this kind of function. An aging report that read the clock would give a different answer tomorrow
 * for a period that has already been filed, and the worked example committed in
 * `packages/fixtures/src/purchases.ts` could not exist at all. The caller passes the business day.
 *
 * ## Five buckets where the acceptance names four
 *
 * The specification names current / 30 / 60 / 90+. All four are here and each means literally what it
 * says; the fifth (61–90) exists because a bucket labelled "90+" that actually holds a 75-day payable
 * misstates the oldest debt in the business, and the oldest debt is the only figure anybody opens an
 * aging report for. Collapsing 61–90 into 90+ is a presentation choice a report can still make; a
 * bucket that lies is not.
 *
 * ## One definition, two statements
 *
 * The same boundaries are expressed in SQL as `payables_aging_bucket(due_date, as_of)` in
 * `0028_purchases.sql`, because `packages/db` may not import this package and the aging query has to
 * group in the database. `packages/fixtures/src/purchases.itest.ts` asserts the two agree on every
 * boundary day, which is the arrangement `price_list` and `resolve-price.ts` already use.
 */

/**
 * The buckets, in report order.
 *
 * `current` first because that is how an aging report reads: what is not yet due, then how far past
 * due the rest is.
 */
export const PAYABLES_AGING_BUCKETS = [
  'current',
  'days_1_30',
  'days_31_60',
  'days_61_90',
  'days_over_90',
] as const
export type PayablesAgingBucket = (typeof PAYABLES_AGING_BUCKETS)[number]

/**
 * The open-ended bucket everything older falls into.
 *
 * Named, because it is the one bucket with no upper bound and therefore the one a cascade falls
 * through to. A literal at the end of `payablesBucketFor` would be a second place the last bucket is
 * decided.
 */
export const OLDEST_PAYABLES_BUCKET = 'days_over_90' satisfies PayablesAgingBucket

/**
 * The inclusive upper bound of each bucket, in days past due.
 *
 * Held as data so the boundaries are readable in one place and testable one by one. `current` is
 * everything at or below zero days overdue — a payable due today is not overdue by anything, and an
 * off-by-one here puts every bill due today into the 1–30 bucket, which is how an aging report starts
 * reporting arrears that do not exist.
 */
export const PAYABLES_AGING_BOUNDARY_DAYS: readonly {
  readonly bucket: PayablesAgingBucket
  readonly upToDaysOverdue: number | null
}[] = [
  { bucket: 'current', upToDaysOverdue: 0 },
  { bucket: 'days_1_30', upToDaysOverdue: 30 },
  { bucket: 'days_31_60', upToDaysOverdue: 60 },
  { bucket: 'days_61_90', upToDaysOverdue: 90 },
  { bucket: OLDEST_PAYABLES_BUCKET, upToDaysOverdue: null },
]

const MS_PER_DAY = 86_400_000

/**
 * Whole days between two ISO dates, `later - earlier`.
 *
 * Both are parsed at midnight **UTC** and subtracted, which is why this is exact: a local-midnight
 * parse would cross a DST boundary in some jurisdictions and give 29.958 days, and rounding that away
 * would hide the error until the one case where it rounded the wrong way. The UAE does not observe
 * DST, but the correctness of an aging boundary should not depend on that remaining true.
 *
 * `localDate()` re-validates both arguments rather than trusting the brand. The brand is a compile-time
 * claim and this function is reachable from a JSON payload; a malformed date would otherwise become
 * `NaN` days overdue, which compares false against every boundary and lands in the last bucket.
 */
export function daysBetween(earlier: LocalDate, later: LocalDate): number {
  const from = Date.parse(`${localDate(earlier)}T00:00:00Z`)
  const to = Date.parse(`${localDate(later)}T00:00:00Z`)
  return (to - from) / MS_PER_DAY
}

/** Days a payable is overdue as at `asOf`. Zero or negative means it is not yet due. */
export function daysOverdue(dueDate: LocalDate, asOf: LocalDate): number {
  return daysBetween(dueDate, asOf)
}

/**
 * The bucket one payable falls in. The SQL mirror of this is `payables_aging_bucket()`.
 *
 * The cascade runs over the boundary table rather than repeating the day counts, so the boundaries are
 * stated once in this file. Only the closed boundaries are compared; the open-ended one is the
 * fall-through, which is also why there is no unreachable `else` to leave untested.
 */
export function payablesBucketFor(dueDate: LocalDate, asOf: LocalDate): PayablesAgingBucket {
  const overdue = daysOverdue(dueDate, asOf)
  for (const boundary of PAYABLES_AGING_BOUNDARY_DAYS) {
    if (boundary.upToDaysOverdue !== null && overdue <= boundary.upToDaysOverdue) {
      return boundary.bucket
    }
  }
  return OLDEST_PAYABLES_BUCKET
}

/** One payable, as the aging report sees it: what is owed, when it was due, and against what. */
export interface PayableForAging {
  /** Our own internal reference, so a bucket can be traced back to the bill. */
  readonly reference: string
  readonly supplierCode: string
  readonly dueDate: LocalDate
  /** What is still owed. VAT-inclusive gross, because that is what gets paid. */
  readonly outstanding: Money
}

export interface PayablesAgingRow {
  readonly bucket: PayablesAgingBucket
  readonly total: Money
  readonly billCount: number
  /** The references in the bucket, sorted, so two runs produce identical working papers. */
  readonly references: readonly string[]
}

export interface PayablesAging {
  readonly asOf: LocalDate
  /** One row per bucket, always all five and in report order — an absent bucket is a zero, not a gap. */
  readonly rows: readonly PayablesAgingRow[]
  readonly total: Money
  readonly billCount: number
}

/**
 * Buckets a set of payables and totals each bucket.
 *
 * Every bucket is present even when empty. A report that omitted its empty buckets would change shape
 * between months, and the reader who notices that "90+" is missing cannot tell whether nothing is
 * that old or whether the query stopped returning it.
 */
export function agePayables(asOf: LocalDate, payables: readonly PayableForAging[]): PayablesAging {
  const classified = payables.map((payable) => {
    if (payable.outstanding.fils < 0) {
      throw new AppError(
        'validation',
        `Payable ${payable.reference} has a negative outstanding amount ` +
          `(${payable.outstanding.fils} fils). A credit is a supplier credit note, not a negative bill.`,
      )
    }
    return { payable, bucket: payablesBucketFor(payable.dueDate, asOf) }
  })

  // A filter per bucket rather than a keyed map. Five passes over a handful of payables costs nothing,
  // and it removes the `get()` that would otherwise be an unreachable undefined case in a function
  // whose whole job is to leave no bucket unaccounted for.
  const rows = PAYABLES_AGING_BUCKETS.map((bucket) => {
    const members = classified.filter((row) => row.bucket === bucket).map((row) => row.payable)
    return {
      bucket,
      total: sum(members.map((member) => member.outstanding)),
      billCount: members.length,
      references: members.map((member) => member.reference).sort(),
    }
  })

  return {
    asOf,
    rows,
    total: sum(rows.map((row) => row.total)),
    billCount: payables.length,
  }
}

/** The total of one bucket, or zero AED. For a report that wants one figure without a find(). */
export function bucketTotal(aging: PayablesAging, bucket: PayablesAgingBucket): Money {
  return aging.rows.find((row) => row.bucket === bucket)?.total ?? ZERO_AED
}

/**
 * Everything past due: the aging total less what is not yet due.
 *
 * Subtracted rather than re-summed from the overdue buckets, so the two figures on a report cannot
 * disagree by a fils.
 */
export function overdueTotal(aging: PayablesAging): Money {
  return subtract(aging.total, bucketTotal(aging, 'current'))
}
