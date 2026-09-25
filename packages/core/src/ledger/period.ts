import { AppError } from '@berelax/shared'
import type { LocalDate } from '../time.ts'
import { localDate } from '../time.ts'
import type { JournalEntry } from './entry.ts'
import { type ReversalOptions, reverseEntry } from './reverse.ts'

/**
 * Accounting periods, and the rule that a correction lands in an open one (M-VAT-06).
 *
 * `reverse.ts` builds the entry that undoes another one, on a date its caller supplies, and says why
 * the date can only be the caller's: "A correction found in March for a February entry is dated in
 * February if February is still open and in March if it is closed, and only the caller — which knows
 * the period locks — can decide which." This module is the half of that sentence `reverse.ts` cannot
 * state: given the periods that ARE closed, which dates a correction may carry.
 *
 * ## Why nothing here computes the earliest open date
 *
 * The obvious missing function is `earliestOpenDateOnOrAfter(date, closedPeriods)`. It is missing on
 * purpose. `earliest_open_date_from(date)` in `0072_credit_note.sql` already answers it, every guard in
 * the database calls that one, and a second implementation here would be a second answer to the
 * question the schema exists to settle — the defect `packages/db/src/repositories/journal.ts` names for
 * the balance invariant: "three statements of one rule is two opportunities to disagree."
 *
 * So the division is: the database SAYS where a correction may go, and this module REFUSES one that
 * went somewhere else. Two statements of the rule, which is the number `journal.ts` argues for, and no
 * arithmetic duplicated between them. A caller reaches `earliestOpenDateFrom` in `@berelax/db` for the
 * date and `planCorrection` here for the entry.
 *
 * ## What a period identifier is, and what it is not
 *
 * `period_lock.period_id` is free text, deliberately — 0018: "the VAT period length is the authority's
 * to set, not ours". The authority on a period's extent is therefore the explicit `starts_on`/`ends_on`
 * pair on the row, never a string anybody parses. {@link parsePeriodId} exists for the two shapes this
 * business writes by hand, `2026-08` and `2026-Q3`, so a screen or an import can turn one into a range
 * without inventing its own month-end arithmetic. It refuses anything else rather than guess, and it is
 * NOT how the guards decide what is closed: {@link closedPeriodContaining} takes ranges.
 */

/** Raised when a period identifier is neither `YYYY-MM` nor `YYYY-Qn`. */
export class UnrecognisedPeriodId extends AppError {
  constructor(periodId: string) {
    super(
      'validation',
      `Period identifier "${periodId}" is neither a month (YYYY-MM) nor a quarter (YYYY-Qn). ` +
        'period_lock.period_id is free text, so a period of another shape carries its own start and ' +
        'end dates and is not parsed.',
      { details: { periodId } },
    )
    this.name = 'UnrecognisedPeriodId'
  }
}

/** Raised when a correction would be dated inside a period that is closed. */
export class CorrectionIntoClosedPeriod extends AppError {
  constructor(entryId: string, on: string, periodId: string) {
    super(
      'forbidden',
      `Cannot date the correction of entry "${entryId}" on ${on}: accounting period "${periodId}" is ` +
        'closed. A correction to a closed period is a dated reversal in the next OPEN period — ask ' +
        'earliestOpenDateFrom for the date; it is not derived here.',
      { details: { entryId, on, periodId } },
    )
    this.name = 'CorrectionIntoClosedPeriod'
  }
}

/**
 * A period with an explicit extent.
 *
 * `endsOn` is the last day **of** the period and not the first day after it, matching
 * `period_lock.ends_on` and the inclusive `daterange(starts_on, ends_on, '[]')` its exclusion
 * constraint is built on. An exclusive end would leave the last day of every filed period open, which
 * is the day the cash-up runs.
 */
export interface AccountingPeriod {
  readonly periodId: string
  readonly startsOn: LocalDate
  readonly endsOn: LocalDate
}

/** Days in each month, 1-indexed by the array position being month - 1. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/**
 * The proleptic Gregorian leap rule, written out rather than obtained from a calendar library.
 *
 * `scripts/check-core-purity.mjs` bans the date object from this directory outright, and the reason is
 * worth more than the six lines this costs: a trading date resolved by the caller on `business_day`
 * must never be re-derived here, and a directory that may construct dates will eventually construct
 * one. The rule has not changed since 1582 and will not change before this software is retired.
 */
const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

const lastDayOfMonth = (year: number, month: number): number =>
  month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0)

const MONTH_ID = /^(\d{4})-(0[1-9]|1[0-2])$/
const QUARTER_ID = /^(\d{4})-Q([1-4])$/

/**
 * The range a `YYYY-MM` or `YYYY-Qn` identifier names.
 *
 * Both shapes and no others, and the refusal is the point: a `period_id` this cannot read is a period
 * whose extent is only on its own row, and a parser that guessed at `2026-H1` or `FY26` would return a
 * range somebody then closed. See the module note on what a period identifier is not.
 */
export function parsePeriodId(periodId: string): AccountingPeriod {
  const month = MONTH_ID.exec(periodId)
  if (month) {
    const year = Number(month[1])
    const m = Number(month[2])
    return Object.freeze({
      periodId,
      startsOn: localDate(`${year}-${pad2(m)}-01`),
      endsOn: localDate(`${year}-${pad2(m)}-${pad2(lastDayOfMonth(year, m))}`),
    })
  }
  const quarter = QUARTER_ID.exec(periodId)
  if (quarter) {
    const year = Number(quarter[1])
    const q = Number(quarter[2])
    const firstMonth = (q - 1) * 3 + 1
    const lastMonth = firstMonth + 2
    return Object.freeze({
      periodId,
      startsOn: localDate(`${year}-${pad2(firstMonth)}-01`),
      endsOn: localDate(`${year}-${pad2(lastMonth)}-${pad2(lastDayOfMonth(year, lastMonth))}`),
    })
  }
  throw new UnrecognisedPeriodId(periodId)
}

/**
 * True when `date` falls inside `period`, both ends included.
 *
 * `YYYY-MM-DD` compares correctly as a string, which is why there is no date arithmetic here — the
 * same property `reverse.ts` relies on for its backdating check.
 */
export function periodContains(period: AccountingPeriod, date: LocalDate): boolean {
  return date >= period.startsOn && date <= period.endsOn
}

/**
 * True when two periods share at least one day.
 *
 * The pure mirror of `period_lock_no_overlap`, the gist exclusion constraint that makes "which period
 * locks this date" unambiguous. It exists so a screen can refuse an overlapping range with a sentence
 * instead of letting the INSERT come back as `23P01`, and not as a substitute for it: the constraint is
 * the authority, because this function cannot see the rows.
 */
export function accountingPeriodsOverlap(a: AccountingPeriod, b: AccountingPeriod): boolean {
  return a.startsOn <= b.endsOn && b.startsOn <= a.endsOn
}

/**
 * The closed period containing `date`, or `null`.
 *
 * At most one can match, because `period_lock_no_overlap` makes overlapping locks unrepresentable — so
 * the first hit is the answer and not merely an answer. Given a list that DOES overlap (which only a
 * caller that built it by hand can produce) the earliest-starting match wins, so the result is at least
 * deterministic; `accountingPeriodsOverlap` is how a caller checks before it gets there.
 */
export function closedPeriodContaining(
  date: LocalDate,
  closedPeriods: readonly AccountingPeriod[],
): AccountingPeriod | null {
  let found: AccountingPeriod | null = null
  for (const period of closedPeriods) {
    if (!periodContains(period, date)) continue
    if (found === null || period.startsOn < found.startsOn) found = period
  }
  return found
}

/** What {@link planCorrection} produced, and where it had to be dated. */
export interface CorrectionPlan {
  /** The reversing entry, built by `reverseEntry`: debits and credits swapped, amounts untouched. */
  readonly reversal: JournalEntry
  /** The date the reversal carries. */
  readonly on: LocalDate
  /**
   * True when `on` is later than the entry being corrected, which is what "the correction went to a
   * later period" looks like. False for a same-day correction inside a period still open.
   */
  readonly deferred: boolean
}

/**
 * The correction of `entry`, dated `on`, refused if `on` is inside a closed period.
 *
 * This is the whole of "corrections are by dated reversal, never by editing", as one function:
 *
 *   - the reversal is a NEW entry (`reverseEntry`), so nothing is edited and nothing is deleted;
 *   - it may not predate the entry it corrects (`reverseEntry` raises `BackdatedReversal`), because a
 *     correction appearing in a period the original never reached is a restatement of that period;
 *   - it may not land in a closed period, which is this function's own refusal.
 *
 * The two cases that decide the design, and both come out of the same three lines:
 *
 *   - **a correction whose date falls in a closed period.** Refused here, and refused again by ZL002
 *     in the database if a caller skips this. The caller asks `earliestOpenDateFrom` for a date that is
 *     open and passes that instead.
 *   - **a correction of an entry whose OWN period closed after it was posted.** Nothing special
 *     happens, and that is the result rather than an omission: the original is untouched — it has to
 *     be, the journal refuses UPDATE and DELETE for every role — and the reversal is dated forward into
 *     the open period. The closed period keeps saying exactly what it said when it was filed, which is
 *     the property period locking exists to buy.
 */
export function planCorrection(
  entry: JournalEntry,
  on: LocalDate,
  closedPeriods: readonly AccountingPeriod[],
  options: ReversalOptions = {},
): CorrectionPlan {
  const closed = closedPeriodContaining(on, closedPeriods)
  if (closed !== null) {
    throw new CorrectionIntoClosedPeriod(entry.entryId as string, on as string, closed.periodId)
  }
  return Object.freeze({
    reversal: reverseEntry(entry, on, options),
    on,
    deferred: on > entry.entryDate,
  })
}
