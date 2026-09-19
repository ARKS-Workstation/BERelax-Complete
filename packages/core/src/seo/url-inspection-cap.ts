import { AppError } from '@berelax/shared'

/**
 * The URL Inspection quota, as arithmetic rather than as a hope.
 *
 * docs/10 §7 states the fact this module exists for: URL Inspection is **2,000 a day per site and
 * effectively unraisable** — so the design question is not "how do we inspect everything" but "which
 * 2,000, and how do we know we have not inspected the same ones for a week".
 *
 * The arithmetic is here, pure and separate from the rotation itself, because the two mistakes it
 * prevents are arithmetic mistakes:
 *
 *   1. **Treating the cap as per run rather than per day.** A job that retries after a partial failure
 *      and then spends a second full cap has burned the day's quota on the half it had already done, and
 *      the URLs at the back of the rotation are never reached at all. The remainder is therefore computed
 *      from what the DAY has spent (`seo_url_inspection_run`), never from what this run has spent.
 *   2. **Spending the last of the cap without noticing.** Going over does not fail gracefully at
 *      Google's end: every further call that day is refused, including a manual one somebody needed.
 */

/**
 * The per-site daily cap.
 *
 * A constant rather than a setting, deliberately. It is Google's number, not a preference, and docs/10 §7
 * records that it cannot be raised — so exposing it as a configurable value would only let somebody
 * configure a number Google will refuse to honour, which is the most expensive kind of setting.
 */
export const URL_INSPECTION_DAILY_CAP = 2000

export interface InspectionBudgetInput {
  /** What this property has already spent today, from the day's ledger row. */
  readonly spentToday: number
  readonly dailyCap?: number
  /** How many candidates are waiting. The budget is never larger than the work. */
  readonly candidates: number
}

export interface InspectionBudget {
  /** How many URLs this run may inspect. Zero is an ordinary answer, not an error. */
  readonly take: number
  readonly remainingAfter: number
  readonly capReached: boolean
}

export function inspectionBudget(input: InspectionBudgetInput): InspectionBudget {
  const cap = input.dailyCap ?? URL_INSPECTION_DAILY_CAP
  if (!Number.isInteger(cap) || cap < 1) {
    throw new AppError(
      'validation',
      `The URL Inspection cap must be a positive whole number: ${cap}`,
    )
  }
  if (!Number.isInteger(input.spentToday) || input.spentToday < 0) {
    throw new AppError(
      'validation',
      `Spend so far today must be a whole number of calls, received ${input.spentToday}.`,
    )
  }
  if (!Number.isInteger(input.candidates) || input.candidates < 0) {
    throw new AppError(
      'validation',
      `The candidate count must be a whole number, received ${input.candidates}.`,
    )
  }
  // `max(0, …)` rather than an assertion: a ledger row can legitimately show a full cap, and a run that
  // threw for finding its quota spent would turn the normal end of a rotation day into a failed cron.
  const remaining = Math.max(0, cap - input.spentToday)
  const take = Math.min(remaining, input.candidates)
  return {
    take,
    remainingAfter: remaining - take,
    capReached: remaining === 0,
  }
}
