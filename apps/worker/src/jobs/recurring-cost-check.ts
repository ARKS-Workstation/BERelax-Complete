import {
  type Actor,
  generateRecurringInstances,
  type RaisedAlert,
  type Sql,
  sweepRecurringCostAlerts,
  tradingDateAt,
  withUnitOfWork,
} from '@berelax/db'
import { AppError } from '@berelax/shared'

/**
 * The nightly pass over the recurring cost register.
 *
 * Three things, in this order, and the order is load-bearing:
 *
 *   1. **Generate the periods** every cost expects across the window. A period that does not exist
 *      cannot raise a missing-cost alert, so generation has to happen before the sweep or the first
 *      unbilled month of a newly registered cost is silent until tomorrow.
 *   2. **Raise the variance alerts** for any matched period outside its declared tolerance.
 *   3. **Raise the missing-cost alerts** for any period past its due date with no bill matched to it.
 *
 * Steps 2 and 3 are one call, `sweepRecurringCostAlerts`, because both are derived from the same
 * comparison and a second implementation of either is how a variance comes to be reported differently
 * depending on whether a human or this job noticed it first.
 *
 * ## Why it raises once and not once per run
 *
 * It does not remember anything. `recurring_cost_alert_once_per_period_and_kind` is a unique constraint
 * and the insert is `on conflict do nothing`, so the *database* is what makes a daily pass raise once per
 * incident. A job that tracked "already alerted" in its own state would raise a second copy the first
 * time that state was lost, which is the failure the 96-alerts-per-broken-agent note in 0021 describes.
 *
 * ## What it deliberately does not do
 *
 * **It does not match bills.** Nothing here guesses which invoice satisfies which period. A landlord
 * bills rent *and* a service charge, so "the other invoice from this supplier" is not a unique answer,
 * and one wrong attachment reports a false variance, silences a real missing-cost alert and leaves
 * another cost looking unbilled — three wrong answers from one row. Matching is recorded by whoever is
 * holding the invoice, through `postRecurringBill` or `matchBillToRecurringCost`.
 *
 * ## The date is the business day, and it is refused rather than guessed
 *
 * Trading runs 11:00–02:00, so a pass at 03:30 belongs to the session that opened the previous morning.
 * `tradingDateAt` reads that from `business_day`, the materialised calendar generated from the same rule
 * `resolveTradingDate` states. If the calendar holds nothing, this job **throws**: an alert dated by
 * truncating a timestamp would be a day late, and at a month boundary would land in a period that has
 * already been filed.
 */

/** A year back and a year forward. See `RECURRING_COST_WINDOW_MONTHS`. */
export const RECURRING_COST_LOOK_BACK_MONTHS = 12
export const RECURRING_COST_LOOK_AHEAD_MONTHS = 12

/**
 * The generation window, in months, centred on the business day.
 *
 * Bounded on the **past** side deliberately. Generating from each cost's anchor would mean a cost
 * registered today with a 2019 anchor instantly acquires seven years of unbilled periods and seven years
 * of missing-cost alerts — a burst nobody reads, which is the same failure as an alert that fires every
 * month. Twelve months back is one full VAT year: long enough that a period which genuinely went unbilled
 * inside the period anybody can still amend is caught, and short enough that registering a long-standing
 * contract does not bury its own first real alert.
 *
 * Bounded on the future side because the forecast does not need generated rows — it computes occurrences
 * from the definitions — so periods ahead exist only to be matched against early invoices.
 */
export const RECURRING_COST_WINDOW_MONTHS =
  RECURRING_COST_LOOK_BACK_MONTHS + RECURRING_COST_LOOK_AHEAD_MONTHS

export interface RecurringCostCheckResult {
  /** The business day the pass was made for. */
  readonly asOf: string
  /** Periods written by this pass. Empty on the second run of the same day, which is the point. */
  readonly generated: number
  /** Alerts newly inserted by this pass. Excludes an incident already alerted on. */
  readonly raised: readonly RaisedAlert[]
}

/** `actor_id` is a uuid column; the label is where a name goes. */
const ACTOR: Actor = { kind: 'system', label: 'recurring-cost.check' }

/**
 * One pass, for the business day containing `atIso`.
 *
 * `atIso` is injected rather than read here, so the pass is reproducible: the integration test drives it
 * at the frozen clock and asserts that the second run raises nothing, which is exactly what a job that
 * read `new Date()` could not be asked.
 */
export async function runRecurringCostCheck(
  sql: Sql,
  atIso: string,
): Promise<RecurringCostCheckResult> {
  const asOf = await tradingDateAt(sql, atIso)
  if (asOf === null) {
    throw new AppError(
      'invariant_violated',
      `The recurring cost check ran at ${atIso} and business_day holds no trading session at or ` +
        'before it, so there is no business day to date its alerts on. Generate the trading calendar ' +
        '(generateBusinessDays) first: dating an alert by truncating the timestamp would put it a day ' +
        'out, and at a month boundary into a period that has already been filed.',
    )
  }

  return withUnitOfWork(sql, ACTOR, async (uow) => {
    const generated = await generateRecurringInstances(uow, {
      from: monthsBefore(asOf, RECURRING_COST_LOOK_BACK_MONTHS),
      months: RECURRING_COST_WINDOW_MONTHS,
    })
    const raised = await sweepRecurringCostAlerts(uow, { asOf })
    return { asOf, generated: generated.length, raised }
  })
}

/**
 * `date` minus whole months, clamped to the end of the target month.
 *
 * Spelled here rather than imported from `@berelax/core`'s `addMonths` for one reason: this is the only
 * date arithmetic in this module, and the window's start is an operational choice of this job rather than
 * part of the schedule rule. The schedule rule — which dates a cost is actually due on — is `@berelax/core`
 * and `0031_recurring_cost.sql`, and neither is restated here.
 */
function monthsBefore(date: string, months: number): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number)
  const index = month - 1 - months
  const targetYear = year + Math.floor(index / 12)
  const targetMonth = (((index % 12) + 12) % 12) + 1
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate()
  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  return `${pad(targetYear, 4)}-${pad(targetMonth, 2)}-${pad(Math.min(day, lastDay), 2)}`
}
