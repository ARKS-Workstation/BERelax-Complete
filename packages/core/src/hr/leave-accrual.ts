import { AppError } from '@berelax/shared'
import { type HoursForDate, tradingBounds } from '../business-day/resolve.ts'
// `addMonths` is M-VAT-04's, reused rather than rewritten. It clamps a month step to the end of the
// shorter month, which is what a 31 January probation end needs, and it clamps the same way PostgreSQL's
// `date + interval '1 month'` does - so the probation end computed here and one computed in SQL agree.
// A second implementation of month arithmetic is exactly the second opinion this repository keeps
// finding in date code, and the two would differ first on 31 January.
import { addMonths } from '../money/recurring-schedule.ts'
import {
  ASIA_DUBAI,
  fromLocal,
  type Instant,
  type LocalDate,
  localDate,
  localTime,
  type TimeZone,
} from '../time.ts'
import { assertSickLeaveTiers, type SickLeaveTiers } from './sick-leave.ts'

/**
 * Leave entitlement and the accrual engine: what a month of service earns, what a leave year carries
 * over, and the ledger a balance is the sum of. Pure.
 *
 * `leave_entitlement_rule` (migration 0066) holds one row per **version** of the policy, and this module
 * is the shape those rows take once they are in hand plus the arithmetic over them. Every figure is
 * data. There is no entitlement, probation length, cap or tier constant anywhere in this file, for
 * `./rates.ts`'s reason one subject along: a payroll that invents its own figures produces a balance
 * nobody can trace to a decision, and it looks exactly like a balance that came from the table.
 *
 * ## The unit is a hundredth of a day, and it is an integer
 *
 * 30 calendar days accrued monthly is 2.5 days a month, which is not a whole number of days. ADR 0007's
 * rule — money is integer fils, never a float — is about reconciliation rather than about money, and a
 * leave balance reconciles exactly as a ledger does: a year of accrual must equal the annual
 * entitlement to the last hundredth, and twelve additions of `2.5` in binary floating point do not.
 * So every quantity here is a whole number of **day-hundredths**: 250 is 2.5 days, 3000 is 30 days, and
 * `250 × 12 === 3000` exactly. 0066 holds the two figures to each other with a CHECK, so a rule version
 * whose monthly accrual does not add up to its stated annual entitlement is not a storable row.
 *
 * ## Calendar days, never working days
 *
 * A leave day is a **calendar** day. Annual leave of 30 days consumes 30 days whether or not a weekly
 * rest day falls inside them, and {@link calendarLeaveDays} counts dates and knows nothing about a rota.
 * That is the acceptance criterion this module is most likely to fail quietly: a working-day count is a
 * plausible implementation, it produces a smaller and entirely sensible-looking number, and the
 * difference only surfaces when somebody's balance runs out four days early. The test holds this
 * function against a working-day oracle and requires the two to **disagree**.
 *
 * ## Why the leave period is not a pair of calendar midnights
 *
 * Trading runs 11:00–02:00 (docs/01 decision 8), so a leave day that began at midnight would leave the
 * previous trading day's last two hours rostered, and a leave day that ended at midnight would leave its
 * own last two hours rostered — 0030 says so in the comment on `leave_request.period` and leaves the
 * choice to this unit. {@link leaveCoveragePeriod} makes it: a leave day covers its trading session, so
 * a day of leave on the 17th covers the 01:30 instant whose calendar date is the 18th. Storing and
 * approving that period is P-HR-09's; deciding what the instants ARE is here, once, so there is one
 * reading of it.
 *
 * ## Why the balance is a fold and not a column
 *
 * {@link foldLeaveLedger} replays movements. `leave_balance` (0066) is a VIEW summing the same rows, so
 * the balance has no second home that can disagree with them — which is what makes the unit's property
 * ("the sum of movements always equals the balance") true by construction rather than by arithmetic
 * luck. A stored balance column would be a second source of truth for a figure that is corrected
 * retrospectively more often than any other in an HR system.
 *
 * Pure: dates and integers in, integers out, the zone is an argument and there is no clock.
 */

/** Day-hundredths in one leave day. The engine's unit of account. */
export const HUNDREDTHS_PER_DAY = 100

/**
 * A whole number of leave days as day-hundredths, for a literal.
 *
 * The counterpart of `aed()` in `../money.ts` and there for the same reason: a bare `3000` in a test
 * reads as three thousand of something, and the something matters.
 */
export function leaveDays(days: number): number {
  if (!Number.isInteger(days) || days < 0) {
    throw new AppError('validation', `A whole number of leave days is required, got ${days}`)
  }
  return days * HUNDREDTHS_PER_DAY
}

/** One version of `leave_entitlement_rule`. Every figure is data; none of it is a constant here. */
export interface LeaveEntitlementRules {
  /** The first date this version governs. */
  readonly effectiveFrom: LocalDate
  /** The headline annual entitlement in whole calendar days. 0066 ties it to the monthly accrual. */
  readonly annualEntitlementDays: number
  /** Day-hundredths earned by a whole month of service. */
  readonly monthlyAccrualHundredths: number
  /** Months of probation from `employee.employed_from`. */
  readonly probationMonths: number
  /** Whether accrual runs during probation. Taking annual leave during it never does. */
  readonly accruesDuringProbation: boolean
  /** The most that may cross a leave-year boundary, in day-hundredths. */
  readonly carryOverCapHundredths: number
  /**
   * Whether carried days lapse at the end of the leave year they were carried into.
   *
   * A boolean and not a month count, deliberately: a count would let the table state a figure — "expires
   * after seven months" — that this engine has no per-day ledger to honour, and a policy the code
   * silently rounds is worse than one it cannot express. Answering Y9-leave-detail with anything other
   * than "at the next leave-year end" or "never" therefore needs a unit, not a value.
   */
  readonly carryOverExpiresAfterOneLeaveYear: boolean
  /**
   * Whether the leave year runs from the employment anniversary rather than from 1 January.
   *
   * The anniversary is derived from `employee.employed_from`, which is a fact the database holds; a
   * fixed calendar anchor other than the start of the year would be a date invented here (brief rule
   * 15), so `false` means 1 January and nothing else is expressible.
   */
  readonly leaveYearStartsOnAnniversary: boolean
  /** Whether approved unpaid leave reduces the month's accrual. */
  readonly unpaidLeaveReducesAccrual: boolean
  /** Whether an ABSENT day (P-HR-07's variance outcome) reduces the month's accrual. */
  readonly absentDayReducesAccrual: boolean
  readonly sickLeave: SickLeaveTiers
}

/** A guard rather than a rule: the figures above are policy, these bounds are sanity. */
const IMPLAUSIBLE_DAYS = 366
const IMPLAUSIBLE_HUNDREDTHS = IMPLAUSIBLE_DAYS * HUNDREDTHS_PER_DAY

function assertWholeHundredths(label: string, hundredths: number): void {
  if (!Number.isInteger(hundredths) || hundredths < 0 || hundredths > IMPLAUSIBLE_HUNDREDTHS) {
    throw new AppError(
      'validation',
      `${label} must be a whole number of day-hundredths between 0 and ${IMPLAUSIBLE_HUNDREDTHS}, ` +
        `got ${hundredths}`,
    )
  }
}

/**
 * Refuses a policy version the accrual arithmetic cannot be right about, with 0066's own reasons.
 *
 * Deliberately a second implementation of those CHECKs rather than a claim the database has checked
 * already, for `assertWorkingHoursRules`'s reason: most rule sets the maths sees in a test were built in
 * the test, and a version whose monthly accrual is zero satisfies every "the balance never goes
 * negative" assertion while entitling nobody to anything.
 */
export function assertLeaveEntitlementRules(rules: LeaveEntitlementRules): void {
  if (
    !Number.isInteger(rules.annualEntitlementDays) ||
    rules.annualEntitlementDays <= 0 ||
    rules.annualEntitlementDays > IMPLAUSIBLE_DAYS
  ) {
    throw new AppError(
      'validation',
      `The annual entitlement must be a whole number of days between 1 and ${IMPLAUSIBLE_DAYS}, got ` +
        `${rules.annualEntitlementDays}`,
    )
  }
  assertWholeHundredths('The monthly accrual', rules.monthlyAccrualHundredths)
  assertWholeHundredths('The carry-over cap', rules.carryOverCapHundredths)
  if (!Number.isInteger(rules.probationMonths) || rules.probationMonths < 0) {
    throw new AppError(
      'validation',
      `Probation must be a whole number of months and not negative, got ${rules.probationMonths}`,
    )
  }
  // The consistency 0066 enforces with leave_entitlement_rule_annual_total_matches_monthly_accrual. A
  // headline entitlement that disagrees with twelve months of accrual is the drift that ships: the
  // figure on the contract and the figure in the ledger are both plausible and only one of them is paid.
  if (rules.annualEntitlementDays * HUNDREDTHS_PER_DAY !== rules.monthlyAccrualHundredths * 12) {
    throw new AppError(
      'validation',
      `A stated annual entitlement of ${rules.annualEntitlementDays} days is ` +
        `${rules.annualEntitlementDays * HUNDREDTHS_PER_DAY} day-hundredths, and twelve months at ` +
        `${rules.monthlyAccrualHundredths} accrue ${rules.monthlyAccrualHundredths * 12}. The two ` +
        'figures are the same entitlement stated twice, so they must agree exactly; 0066 refuses the ' +
        'same row.',
    )
  }
  assertSickLeaveTiers(rules.sickLeave)
}

/**
 * The version of the policy that governs a date: the latest one effective at or before it.
 *
 * `versions` may arrive in any order, because the caller is usually a SQL read and an `order by` is easy
 * to lose. Throws when nothing governs the date, for the reason `rulesFor` in `./rates.ts` gives at
 * length: 0066 seeds a version from a sentinel date before any employment this business could have had,
 * so an empty answer means the row is gone, and a default policy here would be an entitlement the build
 * invented.
 */
export function leaveRulesFor(
  versions: readonly LeaveEntitlementRules[],
  on: LocalDate,
): LeaveEntitlementRules {
  let governing: LeaveEntitlementRules | undefined
  for (const version of versions) {
    if (version.effectiveFrom > on) continue
    if (governing === undefined || version.effectiveFrom > governing.effectiveFrom) {
      governing = version
    }
  }
  if (governing === undefined) {
    throw new AppError(
      'invariant_violated',
      `No leave entitlement version is effective on or before ${on}, so the annual entitlement, the ` +
        'monthly accrual, the probation length, the carry-over cap and the sick-leave tiers are all ' +
        'unknown. 0066 seeds a version from a sentinel date before any employment this business could ' +
        'have had; an empty answer means the row is gone. A default policy here would be an ' +
        'entitlement nobody decided.',
    )
  }
  assertLeaveEntitlementRules(governing)
  return governing
}

// --- date arithmetic ----------------------------------------------------------------------------
// Local to this module rather than a widening of `../time.ts`, and that is the position
// `./working-hours.ts` takes for its own `stepDate` with the reason spelled out there: an exported
// general-purpose `addMonths` grows a timezone argument and becomes a second opinion about what a date
// is. `T00:00:00Z` and the UTC accessors throughout, because a `LocalDate` is a label and not an
// instant — stepping it in any zone but UTC makes the answer depend on the offset at midnight.

function partsOf(date: LocalDate): {
  readonly year: number
  readonly month: number
  readonly day: number
} {
  const [year, month, day] = date.split('-')
  return { year: Number(year), month: Number(month), day: Number(day) }
}

function iso(year: number, month: number, day: number): LocalDate {
  return localDate(
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  )
}

/** The days in the calendar month a date falls in. Day 0 of the next month IS the last of this one. */
export function daysInMonthOf(date: LocalDate): number {
  const { year, month } = partsOf(date)
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The first calendar day of the month a date falls in. Every accrual is keyed on this. */
export function monthStart(date: LocalDate): LocalDate {
  const { year, month } = partsOf(date)
  return iso(year, month, 1)
}

/** The last calendar day of the month a date falls in. */
export function monthEnd(date: LocalDate): LocalDate {
  const { year, month } = partsOf(date)
  return iso(year, month, daysInMonthOf(date))
}

/** A date some whole number of days later or earlier. */
export function addDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isInteger(days)) {
    throw new AppError('validation', `Days must be a whole number, got ${days}`)
  }
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return localDate(value.toISOString().slice(0, 10))
}

/**
 * Whole calendar days from `earlier` to `later`, exclusive of `later`.
 *
 * Exact, because both ends are UTC midnights and no zone here observes DST at midnight. The difference
 * is asserted to land on a whole day rather than rounded, for the reason `workedMinutes` refuses a shift
 * boundary off the minute: a rounded date difference creates or destroys a day of entitlement.
 */
function dayDifference(later: LocalDate, earlier: LocalDate): number {
  const milliseconds = Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)
  const days = milliseconds / 86_400_000
  if (!Number.isInteger(days)) {
    throw new AppError(
      'invariant_violated',
      `The difference between ${earlier} and ${later} is ${days} days, which is not whole. Both are ` +
        'UTC midnights, so this cannot happen for two well-formed dates.',
    )
  }
  return days
}

/**
 * Calendar days of leave in an inclusive date range.
 *
 * **Inclusive at both ends**, which is the whole point: leave "from the 1st to the 30th" is 30 days, and
 * a half-open reading gives 29 and looks entirely reasonable. Nothing here consults a rota, a weekly
 * rest day or a public holiday — a leave day is a calendar day, and a working-day count is the plausible
 * wrong implementation this function's test exists to rule out.
 */
export function calendarLeaveDays(range: {
  readonly from: LocalDate
  readonly to: LocalDate
}): number {
  if (range.to < range.from) {
    throw new AppError(
      'validation',
      `Leave from ${range.from} to ${range.to} ends before it starts; there is no day count for it`,
    )
  }
  return dayDifference(range.to, range.from) + 1
}

/**
 * The instants a run of leave days covers, as a half-open `[startsAt, endsAt)` period.
 *
 * A leave day covers its **trading session**, so a day of leave on the 17th runs from the 17th's opening
 * to the 17th's close — which, with trading at 11:00–02:00, is 02:00 on the 18th. That is the decision
 * 0030 left to this unit in the comment on `leave_request.period`, and it is the one that makes a 01:30
 * appointment in the session's tail fall inside the leave rather than beside it. A period of two
 * calendar midnights would leave both tails rostered: the previous day's last two hours at the start and
 * the leave's own last two hours at the end.
 *
 * On a date the premises does not open there is no session, so the calendar day is used. That is not a
 * fallback to the wrong reading — it is the only reading available, and it covers nothing the rota can
 * offer anyway.
 *
 * The hours and the zone are arguments. This function performs no lookup of either, because
 * `hoursFor` is where a Ramadan override and a closure already live (`hoursFromSchedule`), and a second
 * source for "when is the premises open" is the defect that puts one answer on the booking page and
 * another on the leave screen.
 */
export function leaveCoveragePeriod(args: {
  readonly from: LocalDate
  readonly to: LocalDate
  readonly hoursFor: HoursForDate
  readonly zone?: TimeZone
}): { readonly startsAt: Instant; readonly endsAt: Instant } {
  const { from, to, hoursFor, zone = ASIA_DUBAI } = args
  // Validated for its own sake: an inverted range would otherwise produce an empty or negative period,
  // and `leave_request_period_nonempty` would refuse it several layers later with nothing saying why.
  calendarLeaveDays({ from, to })
  const midnight = (date: LocalDate): Instant => fromLocal(date, localTime('00:00'), zone)

  const openingHours = hoursFor(from)
  const startsAt =
    openingHours === undefined ? midnight(from) : tradingBounds(from, openingHours, zone).opensAt

  const closingHours = hoursFor(to)
  const endsAt =
    closingHours === undefined
      ? midnight(addDays(to, 1))
      : tradingBounds(to, closingHours, zone).closesAt

  if (endsAt <= startsAt) {
    throw new AppError(
      'invariant_violated',
      `Leave from ${from} to ${to} resolved to a period that ends when or before it starts. The ` +
        'trading hours for those dates close before they open, which no premises_hours row permits.',
    )
  }
  return { startsAt, endsAt }
}

// --- probation and the leave year --------------------------------------------------------------

/**
 * The first date the employee is out of probation.
 *
 * The day probation ENDS rather than its last day, so the comparison downstream is `on >= this` and
 * there is no off-by-one at the boundary. Clamped by {@link addMonths}, so somebody engaged on 31 August
 * with six months' probation is out of it on 28 or 29 February and not on 3 March.
 */
export function probationEndsOn(rules: LeaveEntitlementRules, employedFrom: LocalDate): LocalDate {
  assertLeaveEntitlementRules(rules)
  return addMonths(employedFrom, rules.probationMonths)
}

/**
 * Whether annual leave may be TAKEN on a date.
 *
 * Separate from accrual on purpose, and that separation is the provisional answer to Y9-leave-detail:
 * accrual runs from day one and taking waits for the end of probation. One flag for both would make the
 * probationary period cost the employee entitlement they are earning, which is the error that cannot be
 * put right later because nothing records what was refused.
 */
export function mayTakeAnnualLeaveOn(
  rules: LeaveEntitlementRules,
  employedFrom: LocalDate,
  on: LocalDate,
): boolean {
  return on >= probationEndsOn(rules, employedFrom)
}

/**
 * The first date of the leave year a date falls in.
 *
 * Anniversary-based when the rule says so: the leave year runs from the employment anniversary, which is
 * derived from a column the database holds rather than from a date this build chose. Otherwise 1
 * January. Nothing else is expressible, for brief rule 15's reason — a third anchor would be a date
 * invented here, and a plausible one is indistinguishable from a configured one.
 *
 * `on` before `employedFrom` is refused rather than answered with the employment date: an accrual or a
 * balance question about a date before the person was engaged is a caller mistake, and rolling it
 * forward to the first leave year would hide it.
 */
export function leaveYearStart(
  rules: LeaveEntitlementRules,
  employedFrom: LocalDate,
  on: LocalDate,
): LocalDate {
  assertLeaveEntitlementRules(rules)
  if (on < employedFrom) {
    throw new AppError(
      'validation',
      `${on} is before the employment started on ${employedFrom}, so it is in no leave year`,
    )
  }
  if (!rules.leaveYearStartsOnAnniversary) return iso(partsOf(on).year, 1, 1)

  // Stepped in whole years from the engagement date so a 29 February anniversary clamps the same way
  // every year, instead of being reconstructed from a month and a day that does not exist in three
  // years out of four.
  let years = partsOf(on).year - partsOf(employedFrom).year
  while (years > 0 && addMonths(employedFrom, years * 12) > on) years -= 1
  while (addMonths(employedFrom, (years + 1) * 12) <= on) years += 1
  return addMonths(employedFrom, years * 12)
}

// --- accrual ------------------------------------------------------------------------------------

/** One month's accrual for one employee, with every input that produced it. */
export interface MonthlyAccrual {
  /** The first calendar day of the month accrued for. The idempotency key, with the employee. */
  readonly accrualMonth: LocalDate
  /** Day-hundredths earned. Zero is a real answer and is reported, never omitted. */
  readonly hundredths: number
  readonly daysInMonth: number
  /** Days of that month the employment covered. */
  readonly employedDays: number
  /** Of those, the ones the rule says do not earn accrual. */
  readonly reducedDays: number
  /** `employedDays − reducedDays`: the days the accrual was pro-rated on. */
  readonly accruingDays: number
  /** True when the whole month falls inside probation. */
  readonly isProbationary: boolean
  /** The policy version used, so a recomputed month can be compared to the one that was written. */
  readonly ruleEffectiveFrom: LocalDate
}

/**
 * Integer division rounding **up**.
 *
 * The rounding direction is a decision rather than a detail. A month with unpaid days pro-rates to a
 * fraction of a hundredth, and rounding down withholds entitlement — invisibly, a hundredth of a day at
 * a time, in the employer's favour. Rounding up over-accrues by at most one hundredth of a day a month,
 * which is 0.12 of a day a year and shows on a balance anybody can read. Of two errors, the one to make
 * is the visible one that does not take something away.
 *
 * Written as integer arithmetic rather than `Math.ceil(a / b)` so there is no float in the chain at all;
 * the values here are small enough for either to be exact, and "no division producing a fraction" is
 * easier to keep true than to keep checking.
 */
function ceilDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator - 1) / denominator)
}

/**
 * One month's accrual.
 *
 * ## Pro-rated on days, not gated on a "completed month"
 *
 * The handover's phrase is "2.5 days per completed month", and read literally it gives a joiner on the
 * 15th nothing at all for their first month. Y9-leave-detail's recorded answer is "accrual from day 1",
 * and the two are reconciled the only way that honours both: a whole month earns the whole monthly
 * figure, and a part month earns it pro-rated on the days the employment actually covered. A whole month
 * is the exact figure — `250 × 31 / 31` is 250 with no rounding anywhere — so the ordinary case is
 * unaffected by the pro-rating and the twelve-month total is exactly the annual entitlement.
 *
 * ## Which days do not earn
 *
 * Unpaid leave and ABSENT days, each behind its own flag on the rule row, because whether they reduce
 * accrual is policy and not arithmetic. More reduced days than the employment covered is **refused**:
 * it means the absence count and the employment period disagree, which is a data fault worth surfacing
 * rather than clamping to zero and accruing nothing for a month somebody was at work.
 *
 * ## The date is an argument
 *
 * There is no clock here and no "current month". The month accrued for is passed in, which is what makes
 * a missed month re-runnable and a disputed one recomputable — and the reason
 * `apps/worker/src/jobs/leave-accrual.ts` can be driven at a frozen instant in a test and asserted to
 * produce the same rows twice.
 */
export function accrueMonth(args: {
  readonly versions: readonly LeaveEntitlementRules[]
  readonly employedFrom: LocalDate
  readonly employedUntil?: LocalDate | null
  /** Any date in the month to accrue for; normalised to its first day. */
  readonly accrualMonth: LocalDate
  readonly unpaidLeaveDays?: number
  readonly absentDays?: number
}): MonthlyAccrual {
  const { versions, employedFrom, employedUntil = null, unpaidLeaveDays = 0, absentDays = 0 } = args
  const month = monthStart(args.accrualMonth)
  const lastOfMonth = monthEnd(month)
  const rules = leaveRulesFor(versions, month)
  const daysInMonth = daysInMonthOf(month)

  if (employedUntil !== null && employedUntil < employedFrom) {
    throw new AppError(
      'validation',
      `Employment from ${employedFrom} to ${employedUntil} ends before it starts`,
    )
  }
  for (const [label, days] of [
    ['Unpaid leave days', unpaidLeaveDays],
    ['Absent days', absentDays],
  ] as const) {
    if (!Number.isInteger(days) || days < 0 || days > daysInMonth) {
      throw new AppError(
        'validation',
        `${label} in ${month} must be a whole number between 0 and ${daysInMonth}, got ${days}`,
      )
    }
  }

  const firstEmployedDay = employedFrom > month ? employedFrom : month
  const lastEmployedDay =
    employedUntil !== null && employedUntil < lastOfMonth ? employedUntil : lastOfMonth
  const employedDays =
    lastEmployedDay < firstEmployedDay ? 0 : dayDifference(lastEmployedDay, firstEmployedDay) + 1

  const reducedDays =
    (rules.unpaidLeaveReducesAccrual ? unpaidLeaveDays : 0) +
    (rules.absentDayReducesAccrual ? absentDays : 0)
  if (reducedDays > employedDays) {
    throw new AppError(
      'validation',
      `${reducedDays} day(s) of ${month} do not earn accrual but the employment covered only ` +
        `${employedDays} day(s) of it. The absence record and the employment period disagree; ` +
        'clamping this to zero would accrue nothing for a month somebody was at work.',
    )
  }
  const accruingDays = employedDays - reducedDays

  // The whole month inside probation. Reported rather than acted on for accrual unless the rule says
  // accrual waits: whether leave may be TAKEN is a question about a DATE and is
  // `mayTakeAnnualLeaveOn`'s, because a month straddling the probation end has days on both sides of it
  // and a per-month flag could only be wrong about one of them.
  const isProbationary = lastOfMonth < probationEndsOn(rules, employedFrom)
  const hundredths =
    isProbationary && !rules.accruesDuringProbation
      ? 0
      : ceilDiv(rules.monthlyAccrualHundredths * accruingDays, daysInMonth)

  return {
    accrualMonth: month,
    hundredths,
    daysInMonth,
    employedDays,
    reducedDays,
    accruingDays,
    isProbationary,
    ruleEffectiveFrom: rules.effectiveFrom,
  }
}

/**
 * The latest month whose accrual may be written, given the trading session an instant belongs to.
 *
 * A month is complete when its **last trading session has closed**, and that is not the same as its last
 * calendar day having ended. Trading runs 11:00–02:00, so at 01:30 on 1 March the session in force
 * opened on 28 February and February's last session is still running; a pass at that instant must accrue
 * January and not February. At 05:00 on 1 March that same session has closed, so February is complete.
 *
 * Both facts come from `business_day` through `businessDayAt`, which is why they arrive here as
 * arguments: this function performs no second reading of where a trading day ends.
 */
export function latestCompletedAccrualMonth(session: {
  readonly tradingDate: LocalDate
  readonly sessionIsOpen: boolean
}): LocalDate {
  const month = monthStart(session.tradingDate)
  const complete = session.tradingDate === monthEnd(month) && !session.sessionIsOpen
  return complete ? month : addMonths(month, -1)
}

/**
 * The months an employee has accrual owing for, oldest first.
 *
 * Bounded three ways, and each bound is there for a reason the unbounded version demonstrates:
 *
 *   - **not before the month of engagement**, because there is no service to accrue;
 *   - **not after the month employment ended**, for the same reason at the other end;
 *   - **not more than `maxMonths` back from `throughMonth`.** A first run against a roster engaged years
 *     ago would otherwise write a decade of rows, and every one of them would be a figure the business
 *     has no record of agreeing. History before the window is what the opening-balance importer is for
 *     — one stated figure with a source — and that is a better answer than a hundred derived ones.
 */
/**
 * The earliest month a catch-up window reaches, counting back from and including `throughMonth`.
 *
 * Exported so the job's READS and this module's month list cannot disagree about where the window starts.
 * They did not, once, in an earlier shape of this pass: the read of already-accrued months derived the
 * floor itself and the engine derived it again, and an off-by-one between the two meant the oldest month
 * in the window was re-accrued on every run because the read never returned its existing row.
 */
export function accrualCatchUpFloor(throughMonth: LocalDate, maxMonths: number): LocalDate {
  if (!Number.isInteger(maxMonths) || maxMonths < 1) {
    throw new AppError(
      'validation',
      `The catch-up window must be at least one month, got ${maxMonths}. Zero would make the pass a ` +
        'no-op that still reported success.',
    )
  }
  return addMonths(monthStart(throughMonth), -(maxMonths - 1))
}

export function accrualMonthsOwing(args: {
  readonly employedFrom: LocalDate
  readonly employedUntil?: LocalDate | null
  readonly throughMonth: LocalDate
  readonly maxMonths: number
  /** Months already accrued, in any order. Anything here is skipped. */
  readonly alreadyAccrued?: readonly LocalDate[]
}): readonly LocalDate[] {
  const { employedFrom, employedUntil = null, maxMonths, alreadyAccrued = [] } = args
  const through = monthStart(args.throughMonth)
  const earliestAllowed = accrualCatchUpFloor(through, maxMonths)
  const engagedMonth = monthStart(employedFrom)
  let from = engagedMonth > earliestAllowed ? engagedMonth : earliestAllowed
  const endedMonth = employedUntil === null ? null : monthStart(employedUntil)
  const to = endedMonth !== null && endedMonth < through ? endedMonth : through

  const done = new Set(alreadyAccrued.map((month) => monthStart(month)))
  const owing: LocalDate[] = []
  while (from <= to) {
    if (!done.has(from)) owing.push(from)
    from = addMonths(from, 1)
  }
  return owing
}

// --- the leave-year boundary --------------------------------------------------------------------

/** What a leave-year boundary does to a balance. */
export interface LeaveYearRollover {
  /** The balance as the leave year closed. */
  readonly closingHundredths: number
  /** What crosses the boundary. */
  readonly carriedHundredths: number
  /** What does not, whether by the cap or by expiry. Always `closing − carried`. */
  readonly forfeitedHundredths: number
  /** The cap that applied, so the figure can be read without a second lookup. */
  readonly capHundredths: number
  /** Of the forfeiture, the part the cap caused. */
  readonly cappedHundredths: number
  /** Of the forfeiture, the part last year's unused carry-in caused. */
  readonly expiredHundredths: number
}

/**
 * The carry-over at a leave-year boundary: what crosses, and what is lost.
 *
 * Two separate reductions, reported separately because they have different remedies. The **cap** is a
 * policy ceiling on how much leave may be banked; **expiry** is last year's carried days lapsing
 * unused. An employee told "you lost four days" wants to know which, because only one of the two could
 * have been avoided by taking leave sooner.
 *
 * Expiry is applied first and the cap second. The other order would let a day expire after the cap had
 * already removed it and report the same hundredth twice, so the two parts would not sum to the
 * forfeiture — which is exactly the reconciliation this shape exists to keep possible.
 *
 * `takenFromCarryInHundredths` is how much of last year's carry-in was actually used. It is an argument
 * and not a FIFO ledger inside this function: which days a leave request consumed is a question about
 * the ORDER of consumption, and answering it here would be a second opinion about a balance
 * {@link foldLeaveLedger} already computes from the movements.
 */
export function rolloverLeaveYear(args: {
  readonly rules: LeaveEntitlementRules
  readonly closingHundredths: number
  /** Carried into the year now closing. Omitted means none, which is a first leave year. */
  readonly carriedInHundredths?: number
  /** How much of that carry-in was consumed during the year. */
  readonly takenFromCarryInHundredths?: number
}): LeaveYearRollover {
  const { rules, closingHundredths, carriedInHundredths = 0, takenFromCarryInHundredths = 0 } = args
  assertLeaveEntitlementRules(rules)
  assertWholeHundredths('The closing balance', closingHundredths)
  assertWholeHundredths('The carry-in', carriedInHundredths)
  assertWholeHundredths('The carry-in consumed', takenFromCarryInHundredths)
  if (takenFromCarryInHundredths > carriedInHundredths) {
    throw new AppError(
      'validation',
      `${takenFromCarryInHundredths} day-hundredths cannot have been taken from a carry-in of ` +
        `${carriedInHundredths}`,
    )
  }

  const unusedCarryIn = carriedInHundredths - takenFromCarryInHundredths
  // Bounded by the closing balance: carried days that are no longer in the balance were spent on
  // something, and expiring them again would forfeit a day twice.
  const expiredHundredths = rules.carryOverExpiresAfterOneLeaveYear
    ? Math.min(unusedCarryIn, closingHundredths)
    : 0
  const afterExpiry = closingHundredths - expiredHundredths
  const carriedHundredths = Math.min(afterExpiry, rules.carryOverCapHundredths)
  return {
    closingHundredths,
    carriedHundredths,
    forfeitedHundredths: closingHundredths - carriedHundredths,
    capHundredths: rules.carryOverCapHundredths,
    cappedHundredths: afterExpiry - carriedHundredths,
    expiredHundredths,
  }
}

// --- the movement ledger ------------------------------------------------------------------------

/**
 * The kinds of movement a balance is the sum of. These are `leave_movement_kind` in 0066.
 *
 * Signed, and the sign is fixed per kind: `opening_balance`, `accrual` and `released` add, `reserved`
 * and `carry_over_forfeited` take away. That is what makes the balance the plain sum of the column and
 * therefore what makes `leave_balance` expressible as a view over it.
 *
 * There is deliberately **no `taken` movement**. A request reserves when it is made and the reservation
 * simply stops being refundable when it is approved, so approval changes no balance and writes no row.
 * A `taken` movement at approval would double-count against the reservation unless the reservation were
 * reversed in the same breath, which is two rows saying one thing and the classic way a ledger comes to
 * disagree with itself.
 */
export const LEAVE_MOVEMENT_KINDS = [
  'opening_balance',
  'accrual',
  'carry_over_forfeited',
  'reserved',
  'released',
] as const

export type LeaveMovementKind = (typeof LEAVE_MOVEMENT_KINDS)[number]

/** The kinds that may only ever be negative. Every other kind may only ever be positive. */
export const NEGATIVE_LEAVE_MOVEMENT_KINDS: readonly LeaveMovementKind[] = [
  'carry_over_forfeited',
  'reserved',
]

export interface LeaveMovement {
  readonly kind: LeaveMovementKind
  /** Signed day-hundredths. */
  readonly hundredths: number
  /** Set on `accrual`, and on nothing else. The idempotency key, with the employee. */
  readonly accrualMonth?: LocalDate
  /** Set on `reserved` and `released`, and on nothing else. */
  readonly requestId?: string
}

export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface LeaveLedger {
  /** The balance: what may still be requested. Always equals the sum of {@link movements}. */
  readonly availableHundredths: number
  /** Held by pending requests. */
  readonly reservedHundredths: number
  /** Consumed by approved requests. */
  readonly takenHundredths: number
  /** Lost at a leave-year boundary, by the cap or by expiry. */
  readonly forfeitedHundredths: number
  readonly movements: readonly LeaveMovement[]
  readonly requests: Readonly<
    Record<string, { readonly status: LeaveRequestStatus; readonly hundredths: number }>
  >
  /** Months already accrued, so a second accrual for one of them is refused rather than added. */
  readonly accruedMonths: readonly LocalDate[]
  readonly hasOpeningBalance: boolean
}

export type LeaveLedgerEvent =
  | { readonly kind: 'opening_balance'; readonly hundredths: number }
  | { readonly kind: 'accrual'; readonly accrualMonth: LocalDate; readonly hundredths: number }
  | { readonly kind: 'forfeit_carry_over'; readonly hundredths: number }
  | { readonly kind: 'request'; readonly requestId: string; readonly hundredths: number }
  | { readonly kind: 'approve'; readonly requestId: string }
  | { readonly kind: 'reject'; readonly requestId: string }
  | { readonly kind: 'cancel'; readonly requestId: string }

export type LeaveRefusalReason =
  /** The balance would go negative. The invariant this engine exists to keep. */
  | 'insufficient_balance'
  | 'opening_balance_already_set'
  | 'month_already_accrued'
  | 'request_already_known'
  | 'unknown_request'
  | 'request_already_decided'

export interface LeaveLedgerStep {
  /** The ledger after the event, or unchanged when the event was refused. */
  readonly ledger: LeaveLedger
  /** The movement the event produced, if any. An approval produces none. */
  readonly movement: LeaveMovement | null
  readonly refusal: { readonly reason: LeaveRefusalReason; readonly detail: string } | null
}

/** A ledger with nothing in it. Every fold starts here, so no tally is ever absent. */
export function emptyLeaveLedger(): LeaveLedger {
  return {
    availableHundredths: 0,
    reservedHundredths: 0,
    takenHundredths: 0,
    forfeitedHundredths: 0,
    movements: [],
    requests: {},
    accruedMonths: [],
    hasOpeningBalance: false,
  }
}

function refuse(ledger: LeaveLedger, reason: LeaveRefusalReason, detail: string): LeaveLedgerStep {
  return { ledger, movement: null, refusal: { reason, detail } }
}

/** Appends a movement and moves the balance by it. The only place `availableHundredths` changes. */
function withMovement(
  ledger: LeaveLedger,
  movement: LeaveMovement,
  patch: Partial<LeaveLedger>,
): LeaveLedgerStep {
  return {
    ledger: {
      ...ledger,
      ...patch,
      availableHundredths: ledger.availableHundredths + movement.hundredths,
      movements: [...ledger.movements, movement],
    },
    movement,
    refusal: null,
  }
}

/**
 * The three decisions a request can receive: approve, reject, cancel.
 *
 * Split out of {@link applyLeaveLedgerEvent} because it is the one branch with a state machine in it,
 * and a switch statement holding both the amount-moving events and a state machine is the shape nobody
 * re-reads. The split is where the seam already was.
 */
function decideRequest(
  ledger: LeaveLedger,
  event: Extract<LeaveLedgerEvent, { kind: 'approve' | 'reject' | 'cancel' }>,
): LeaveLedgerStep {
  const held = ledger.requests[event.requestId]
  if (held === undefined) {
    return refuse(
      ledger,
      'unknown_request',
      `Request ${event.requestId} is not on this ledger, so there is no reservation to ${event.kind}`,
    )
  }
  // A cancellation is legal from pending AND from approved — withdrawing a booked holiday is the
  // ordinary case, and it is the one that has to return the days. A rejection and an approval apply
  // only to a pending request: re-deciding a decided one is how a reservation comes to be released
  // twice, and the second release would create leave out of nothing.
  const decidable = event.kind === 'cancel' ? ['pending', 'approved'] : ['pending']
  if (!decidable.includes(held.status)) {
    return refuse(
      ledger,
      'request_already_decided',
      `Request ${event.requestId} is ${held.status}; ${event.kind} applies to a request that is ` +
        decidable.join(' or '),
    )
  }
  const status: LeaveRequestStatus =
    event.kind === 'approve' ? 'approved' : event.kind === 'reject' ? 'rejected' : 'cancelled'
  const requests = {
    ...ledger.requests,
    [event.requestId]: { status, hundredths: held.hundredths },
  }
  if (event.kind === 'approve') {
    // No movement: the reservation already took the days out of the balance, and approval only makes it
    // final. The ledger's tallies move, the sum of the movements does not.
    return {
      ledger: {
        ...ledger,
        reservedHundredths: ledger.reservedHundredths - held.hundredths,
        takenHundredths: ledger.takenHundredths + held.hundredths,
        requests,
      },
      movement: null,
      refusal: null,
    }
  }
  const wasApproved = held.status === 'approved'
  return withMovement(
    ledger,
    { kind: 'released', hundredths: held.hundredths, requestId: event.requestId },
    {
      reservedHundredths: ledger.reservedHundredths - (wasApproved ? 0 : held.hundredths),
      takenHundredths: ledger.takenHundredths - (wasApproved ? held.hundredths : 0),
      requests,
    },
  )
}

/**
 * Applies one event to a ledger, returning the new ledger and the movement it produced.
 *
 * **Every rejection is a returned refusal and not a thrown error**, because a refusal is an ordinary
 * outcome of this engine rather than a fault: an employee asking for more leave than they have is the
 * commonest thing that happens to a leave balance. Throwing would make the caller's happy path the
 * place the answer arrives and the exception handler the place the business rule lives, and it would
 * make the unit's property — that no sequence of events can drive the balance negative — untestable,
 * because a sequence would abort at the first refusal instead of continuing past it.
 *
 * The one thing that IS thrown is a malformed amount, which is a programming error rather than a
 * decision.
 */
export function applyLeaveLedgerEvent(
  ledger: LeaveLedger,
  event: LeaveLedgerEvent,
): LeaveLedgerStep {
  const add = (movement: LeaveMovement, patch: Partial<LeaveLedger>): LeaveLedgerStep =>
    withMovement(ledger, movement, patch)

  switch (event.kind) {
    case 'opening_balance': {
      assertWholeHundredths('An opening balance', event.hundredths)
      if (ledger.hasOpeningBalance) {
        return refuse(
          ledger,
          'opening_balance_already_set',
          'This employee already has an imported opening balance. A second one would add to the first ' +
            'rather than replace it, so the balance would be the sum of two statements of the same fact.',
        )
      }
      return add(
        { kind: 'opening_balance', hundredths: event.hundredths },
        {
          hasOpeningBalance: true,
        },
      )
    }

    case 'accrual': {
      assertWholeHundredths('An accrual', event.hundredths)
      const month = monthStart(event.accrualMonth)
      if (ledger.accruedMonths.includes(month)) {
        return refuse(
          ledger,
          'month_already_accrued',
          `${month} has already accrued. This is the idempotency rule the accrual job depends on, and ` +
            '0066 enforces the same thing with a partial unique index on (employee_id, accrual_month).',
        )
      }
      return add(
        { kind: 'accrual', hundredths: event.hundredths, accrualMonth: month },
        {
          accruedMonths: [...ledger.accruedMonths, month],
        },
      )
    }

    case 'forfeit_carry_over': {
      assertWholeHundredths('A forfeiture', event.hundredths)
      if (event.hundredths > ledger.availableHundredths) {
        return refuse(
          ledger,
          'insufficient_balance',
          `Forfeiting ${event.hundredths} day-hundredths would take the balance of ` +
            `${ledger.availableHundredths} below zero`,
        )
      }
      return add(
        { kind: 'carry_over_forfeited', hundredths: -event.hundredths },
        {
          forfeitedHundredths: ledger.forfeitedHundredths + event.hundredths,
        },
      )
    }

    case 'request': {
      assertWholeHundredths('A leave request', event.hundredths)
      if (event.requestId in ledger.requests) {
        return refuse(
          ledger,
          'request_already_known',
          `Request ${event.requestId} is already on this ledger; replaying it would reserve the days twice`,
        )
      }
      if (event.hundredths > ledger.availableHundredths) {
        return refuse(
          ledger,
          'insufficient_balance',
          `Request ${event.requestId} is for ${event.hundredths} day-hundredths and the balance is ` +
            `${ledger.availableHundredths}`,
        )
      }
      return add(
        { kind: 'reserved', hundredths: -event.hundredths, requestId: event.requestId },
        {
          reservedHundredths: ledger.reservedHundredths + event.hundredths,
          requests: {
            ...ledger.requests,
            [event.requestId]: { status: 'pending', hundredths: event.hundredths },
          },
        },
      )
    }

    case 'approve':
    case 'reject':
    case 'cancel':
      return decideRequest(ledger, event)
  }
}

/** Every event's outcome, in order, with the ledger it produced. */
export interface LeaveLedgerFold {
  readonly ledger: LeaveLedger
  readonly steps: readonly LeaveLedgerStep[]
}

/**
 * Replays a sequence of events onto an empty ledger.
 *
 * A refused event leaves the ledger untouched and its refusal in the step, so a caller — and the
 * property suite — can see both what happened and what was declined. Nothing is skipped and nothing
 * aborts the fold.
 */
export function foldLeaveLedger(events: readonly LeaveLedgerEvent[]): LeaveLedgerFold {
  let ledger = emptyLeaveLedger()
  const steps: LeaveLedgerStep[] = []
  for (const event of events) {
    const step = applyLeaveLedgerEvent(ledger, event)
    steps.push(step)
    ledger = step.ledger
  }
  return { ledger, steps }
}

/**
 * Everything that can be wrong with a ledger, as named problems.
 *
 * Returned as strings rather than a boolean so a failure says which invariant broke. Exported because
 * the same check is worth making against a ledger folded from real `leave_movement` rows: the
 * integration suite asserts it over the rows the accrual job wrote, which is the only way to find a
 * repository that writes a movement the engine would never produce.
 */
function movementProblems(movement: LeaveMovement): readonly string[] {
  const problems: string[] = []
  if (!Number.isInteger(movement.hundredths)) {
    problems.push(`a ${movement.kind} movement of ${movement.hundredths} is not whole`)
  }
  const mustBeNegative = NEGATIVE_LEAVE_MOVEMENT_KINDS.includes(movement.kind)
  if (mustBeNegative && movement.hundredths > 0) {
    problems.push(`a ${movement.kind} movement of ${movement.hundredths} should not be positive`)
  }
  if (!mustBeNegative && movement.hundredths < 0) {
    problems.push(`a ${movement.kind} movement of ${movement.hundredths} should not be negative`)
  }
  return problems
}

export function leaveLedgerProblems(ledger: LeaveLedger): readonly string[] {
  const problems: string[] = []
  let summed = 0
  for (const movement of ledger.movements) {
    problems.push(...movementProblems(movement))
    summed += movement.hundredths
  }
  if (summed !== ledger.availableHundredths) {
    problems.push(`the movements sum to ${summed} but the balance is ${ledger.availableHundredths}`)
  }
  if (ledger.availableHundredths < 0) {
    problems.push(`the balance is negative: ${ledger.availableHundredths}`)
  }
  for (const [label, value] of [
    ['reserved', ledger.reservedHundredths],
    ['taken', ledger.takenHundredths],
    ['forfeited', ledger.forfeitedHundredths],
  ] as const) {
    if (value < 0) problems.push(`${label} is negative: ${value}`)
  }
  let pending = 0
  let approved = 0
  for (const request of Object.values(ledger.requests)) {
    if (request.status === 'pending') pending += request.hundredths
    if (request.status === 'approved') approved += request.hundredths
  }
  if (pending !== ledger.reservedHundredths) {
    problems.push(
      `pending requests hold ${pending} day-hundredths but reserved is ${ledger.reservedHundredths}`,
    )
  }
  if (approved !== ledger.takenHundredths) {
    problems.push(
      `approved requests hold ${approved} day-hundredths but taken is ${ledger.takenHundredths}`,
    )
  }
  return problems
}

// --- opening balances ---------------------------------------------------------------------------

/**
 * An opening balance as the engine sees it: the figure, and whether anybody stated it.
 *
 * The distinction is the acceptance criterion. An employee whose balance nobody has imported has a
 * balance of zero **that is an assumption**, and that is a different fact from a balance of zero
 * somebody wrote down. Y8-leave is the question; `provisionalDefault` is what a reader returns until it
 * is answered, and the panel says so rather than the number passing as agreed.
 */
export interface OpeningBalance {
  readonly hundredths: number
  /** False when no import exists and this is {@link PROVISIONAL_OPENING_BALANCE}. */
  readonly isImported: boolean
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  /** Where the figure came from. Null only when nothing was imported. */
  readonly sourceNote: string | null
}

/** The OPEN-QUESTIONS id an un-imported opening balance is provisional against. */
export const OPENING_BALANCE_OPEN_QUESTION = 'Y8-leave'

/**
 * The answer for an employee nobody has imported a balance for.
 *
 * Zero, flagged, and naming the question — never a bare zero. A silent zero is indistinguishable from
 * an imported zero, and the two lead to opposite actions: one needs the HR file loading and the other
 * needs nothing.
 */
export const PROVISIONAL_OPENING_BALANCE: OpeningBalance = {
  hundredths: 0,
  isImported: false,
  isProvisional: true,
  openQuestionId: OPENING_BALANCE_OPEN_QUESTION,
  sourceNote: null,
}

/**
 * An imported row, or the flagged default.
 *
 * A function rather than a `??` at each call site, because there are several call sites and the default
 * is the thing that must not be got wrong in one of them.
 */
export function openingBalanceOr(imported: OpeningBalance | undefined): OpeningBalance {
  return imported ?? PROVISIONAL_OPENING_BALANCE
}
