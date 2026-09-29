import { AppError } from '@berelax/shared'
import type { AccountCode } from '../ledger/account.ts'
import {
  credit,
  debit,
  type EntryDraft,
  type EntryId,
  type EntryLineDraft,
} from '../ledger/entry.ts'
// `addMonths` is M-VAT-04's and `monthEnd`/`monthStart`/`daysInMonthOf` are P-HR-08's, reused rather
// than rewritten. A second `addMonths` in this file would be a second opinion about what 31 January
// plus one month is, and the two would disagree about exactly the dates a service anniversary lands on.
import { addMonths } from '../money/recurring-schedule.ts'
import type { Fils, Money } from '../money.ts'
import { filsFrom } from '../money.ts'
import type { LocalDate } from '../time.ts'
import { localDate } from '../time.ts'
import { daysInMonthOf, monthEnd, monthStart } from './leave-accrual.ts'

/**
 * End-of-service gratuity as an ACCRUING BALANCE-SHEET LIABILITY. Pure.
 *
 * ## What docs/04 actually says, and what therefore is not here
 *
 * The whole of docs/04 §7 on this subject is one line: *"**End-of-service gratuity** as an accruing
 * balance-sheet liability, accrued monthly."* No rate, no service-length band, no cap, no wage basis and
 * no issuing authority. The section's own paragraph on where the HR figures live says why and says where
 * they go instead: *"The figures are versioned rows rather than prose"* — `working_hours_rule` (0059) and
 * `leave_entitlement_rule` (0066), each flagged `is_provisional` against a `Y9-` question and each
 * appearing on the Unconfirmed Assumptions panel, *"so answering either question publishes a new version
 * rather than editing a document."*
 *
 * So there is **no rate, band, divisor or cap written in this file.** Every figure arrives in
 * {@link GratuityRules}, which mirrors a version of `gratuity_rule` (migration 0107). A reader looking
 * for `21`, `30` or `5` here will not find one, and that is the check `packages/fixtures/src/
 * hr-gratuity.test.ts` makes by scanning this module's own source.
 *
 * ## Why the liability is CUMULATIVE and the month's figure is a difference
 *
 * The obvious implementation computes a month's accrual directly — a twelfth of a year's entitlement —
 * and adds it to a running total. It is wrong here for a reason that only shows up after a year: a
 * twelfth of 21 days' wage is not an integer number of fils, so every month is rounded, and twelve
 * rounded months do not sum to the year. The residue is small and it is permanent, in a journal that by
 * definition cannot be edited (ADR 0017), and it grows without bound over a career.
 *
 * So {@link gratuityLiabilityAt} computes the WHOLE liability owed at a date, exactly, with one rounding
 * at the very end, and {@link accrueGratuityMonth} posts the DIFFERENCE between that figure and what has
 * already been accrued. Three properties follow, and each is asserted:
 *
 *   * **No drift.** Any run of months sums exactly to the cumulative figure at the end of the run,
 *     because each movement is `cum(n) − cum(n−1)` and the sum telescopes. This holds for every rounding
 *     direction, which is why it is a property and not a worked example.
 *   * **Idempotence is free.** A month already accrued has movement zero by arithmetic, not by a flag.
 *   * **A wage change is a change in estimate, not a restatement.** It lands as one catch-up movement in
 *     the month it is known, and no earlier entry needs rewriting — which matters because P-HR-12's run
 *     is immutable once completed (ZY141) and its header figures may only be written by the statement
 *     that completes it (ZY142). Nothing here can require a completed run to be rewritten.
 *
 * ## Integer fils, BigInt, and the one rounding
 *
 * ADR 0007: money is integer fils, never a float. The cumulative figure is
 *
 *     ceil( wageFils × numerator ÷ (12 × dailyWageDaysDivisor × MONTH_LENGTH_LCM) )
 *
 * and the product runs in `BigInt` for `package-drawdown.ts`'s reason: `wageFils × numerator` leaves the
 * exact-double range for a long career on a large wage — 40 years at 30 days a year on AED 50,000 a month
 * is about 2.7 × 10^16, past `Number.MAX_SAFE_INTEGER` — and a silently inexact product here is a
 * liability that is wrong by dirhams with nothing looking odd.
 *
 * **Rounded UP.** This is a liability, so of the two available errors only one is recoverable: an
 * over-accrual is visible on the balance sheet and answered by a dated reversal, and an under-accrual is
 * money somebody is owed that no figure anywhere shows. At most one fil, once, on the cumulative total —
 * not once per month, because the monthly movements are differences of ceiled cumulatives and the ceil
 * therefore cannot accumulate.
 *
 * ## The three readings this build had to choose, all of them flagged
 *
 * None of these is stated anywhere in the handover. Each is implemented in the prudent direction — the
 * one that makes the liability LARGER, because understating what an employee is owed is the error that
 * leaves no trace — and each is recorded on `Y9-gratuity` as unsettled rather than smoothed over. They
 * are NOT flags on `gratuity_rule`, for the reason 0066 gives about carry-over expiry: a policy the
 * engine cannot honour is worse expressed as a column than left unexpressible, so answering any of them
 * differently needs a unit rather than a value.
 *
 *   1. **The wage is the wage as at the accrual month, applied to the whole of service** — the "final
 *      wage" reading. The alternative is a career average, month by month at each month's own wage. Final
 *      wage is larger whenever wages rise, which is the usual direction, and it is what "21 days' basic
 *      wage per year of service" reads as in plain English.
 *   2. **A month that straddles a band boundary earns at the HIGHER rate for the whole month**, because
 *      the band is decided by completed years of service at the month END. Splitting the month at the
 *      anniversary is the alternative and is smaller.
 *   3. **Probation months earn nothing but still COUNT as service** when the rule says accrual does not
 *      run during probation. So the band boundary arrives on the employment anniversary rather than six
 *      months after it. Not counting them is the alternative and reaches the higher band later, so it is
 *      smaller.
 *
 * ## There is deliberately NO CAP, and no column for one
 *
 * docs/04 names no cap and the manifest forbids inventing one. It is left out rather than nulled, and the
 * reason is that the SHAPE is unknown, not just the number: a cap could be a ceiling on the days earned,
 * on the months of service that earn, or on the total as a multiple of the wage, and choosing which to
 * store is inventing a cap just as surely as choosing a figure. A nullable `cap_fils` would also be a
 * place for somebody to put a number the engine would then apply to the wrong quantity. Uncapped is the
 * prudent direction, `Y9-gratuity` says so in words, and answering it needs a unit rather than a value.
 *
 * Pure: integers and dates in, integers out. No clock, no I/O, no `Date` beyond the date arithmetic
 * `@berelax/core`'s own helpers already do.
 */

/**
 * The lowest common multiple of every possible calendar month length — 28, 29, 30 and 31.
 *
 * A part month earns pro rata on its own days, so each month's contribution is a fraction whose
 * denominator is that month's length. Summing fractions with four different denominators by dividing
 * each one is how a per-month rounding gets back in through the side door. Multiplying each month's
 * contribution by `LCM ÷ daysInMonth` instead keeps the whole sum an exact integer, and the single
 * division at the end is the only one in the module.
 *
 * `2² · 3 · 5 · 7 · 29 · 31`. Asserted against a recomputation from the four lengths in the test suite,
 * so a typo in this literal fails rather than silently biasing every part month.
 */
export const MONTH_LENGTH_LCM = 377_580

/** Months in a year. Named so that the `12` in the denominator is not mistaken for a figure. */
const MONTHS_PER_YEAR = 12

/**
 * One version of `gratuity_rule` (migration 0107).
 *
 * Every field is a figure this build could not confirm. The row is flagged `is_provisional` against
 * `Y9-gratuity` and appears on the Unconfirmed Assumptions panel, so answering the question publishes a
 * NEW version rather than editing this interface — which is what lets a disputed month be recomputed
 * against the policy that applied then. Gratuity is asked about the past for the same reason payroll is.
 */
export interface GratuityRules {
  /** The first date this version governs. */
  readonly effectiveFrom: LocalDate
  /** Days of wage earned per year of service inside the first band. */
  readonly daysPerYearFirstBand: number
  /** Days of wage earned per year of service after the band boundary. */
  readonly daysPerYearAfterBand: number
  /** Completed years of service at which the second rate starts to apply. */
  readonly bandBoundaryYears: number
  /**
   * Calendar days a monthly wage is taken to cover, so that a day of wage can be derived from it.
   *
   * Its own column and NOT read from `labour_cost_rule.monthly_wage_days_divisor`, although version 1 of
   * both carries the same figure. 0081 makes exactly this distinction one step along, between its
   * `paid_minutes_per_day` and `working_hours_rule.ordinary_minutes_per_day`: *"Two figures that happen
   * to be equal."* `labour_cost_rule`'s divisor is a FORECAST's — P-HR-07's NOTE declines to pay
   * anybody with it in so many words — and this one is the basis of a statutory entitlement. They are
   * flagged against different questions and answering one does not answer the other, so one column
   * serving both would clear the panel for an answer nobody gave.
   */
  readonly dailyWageDaysDivisor: number
  /** Which wage figure the entitlement is computed on. */
  readonly wageBasis: GratuityWageBasis
  readonly probationMonths: number
  /** Whether accrual RUNS during probation. Probation months count as service either way — see the module note. */
  readonly accruesDuringProbation: boolean
  /** Whether an approved unpaid-leave day stops earning entitlement. */
  readonly unpaidLeaveDaysExcluded: boolean
}

export const GRATUITY_WAGE_BASES = ['basic', 'gross'] as const
export type GratuityWageBasis = (typeof GRATUITY_WAGE_BASES)[number]

/** Raised when a rule version could not produce a defensible figure. */
export class UnusableGratuityRules extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('invariant_violated', message, details === undefined ? undefined : { details })
    this.name = 'UnusableGratuityRules'
  }
}

/**
 * Refuses a rule version that cannot be applied.
 *
 * Every bound here is also a CHECK on `gratuity_rule`, restated on purpose: the migration seeds the
 * table and a later unit will add versions in its own migration, so the database is what makes a
 * hand-written INSERT fail, and this is what makes a row that reached a caller another way fail before
 * it prices anybody. `hr-gratuity.itest.ts` holds the pair honest by pushing the same bad row at both.
 */
export function assertGratuityRules(rules: GratuityRules): void {
  const named = (field: string, value: number, low: number, high: number): void => {
    if (!Number.isInteger(value) || value < low || value > high) {
      throw new UnusableGratuityRules(
        `gratuity_rule effective ${rules.effectiveFrom}: ${field} is ${value}, which is outside ` +
          `${low}..${high}. A gratuity figure outside its bounds is one somebody mistyped, and the ` +
          'liability it produces would look like a policy.',
        { field, value },
      )
    }
  }
  // Days per year of service, bounded by the length of a year: a rate above 366 days of wage per year of
  // service earns more than the wage itself, which is not a policy anybody has.
  named('daysPerYearFirstBand', rules.daysPerYearFirstBand, 0, 366)
  named('daysPerYearAfterBand', rules.daysPerYearAfterBand, 0, 366)
  named('bandBoundaryYears', rules.bandBoundaryYears, 1, 50)
  named('dailyWageDaysDivisor', rules.dailyWageDaysDivisor, 1, 31)
  named('probationMonths', rules.probationMonths, 0, 60)
  if (rules.daysPerYearFirstBand === 0 && rules.daysPerYearAfterBand === 0) {
    throw new UnusableGratuityRules(
      `gratuity_rule effective ${rules.effectiveFrom} earns nothing in either band, so every employee ` +
        'accrues zero for ever. That satisfies any reconciliation written against it while entitling ' +
        'nobody to anything — the shape 0066 refuses for an all-empty sick-leave tier set.',
    )
  }
  if (!GRATUITY_WAGE_BASES.includes(rules.wageBasis)) {
    throw new UnusableGratuityRules(
      `gratuity_rule effective ${rules.effectiveFrom} names wage basis "${rules.wageBasis}", which is ` +
        `not one of ${GRATUITY_WAGE_BASES.join(', ')}.`,
    )
  }
}

/**
 * The version governing a date: the latest one taking effect at or before it.
 *
 * The same selection `leaveRulesFor` and `attendanceGraceFor` make, and made the same way for the same
 * reason: a month recomputed after a policy change must be judged against the policy that applied then.
 */
export function gratuityRulesFor(versions: readonly GratuityRules[], on: LocalDate): GratuityRules {
  const applicable = versions
    .filter((version) => version.effectiveFrom <= on)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
  const governing = applicable.at(-1)
  if (governing === undefined) {
    throw new UnusableGratuityRules(
      `No gratuity_rule version takes effect at or before ${on}. The earliest version is ` +
        `${
          versions
            .map((v) => v.effectiveFrom)
            .sort()
            .at(0) ?? '(none at all)'
        }, so this date is ` +
        'before the policy exists and accruing against it would be inventing one.',
      { on, versions: versions.length },
    )
  }
  assertGratuityRules(governing)
  return governing
}

/** The first date the employee is out of probation, clamped to the month end the way 0066 clamps it. */
export function gratuityProbationEndsOn(rules: GratuityRules, employedFrom: LocalDate): LocalDate {
  assertGratuityRules(rules)
  return addMonths(employedFrom, rules.probationMonths)
}

/**
 * Completed years of service at a date.
 *
 * Counted by stepping whole years off the employment date rather than by dividing a day count, so
 * somebody engaged on 29 February completes a year on 28 February in a non-leap year and not on 1 March.
 * `addMonths` clamps, which is what makes that true.
 */
export function completedServiceYears(employedFrom: LocalDate, on: LocalDate): number {
  if (on < employedFrom) {
    throw new UnusableGratuityRules(
      `Asked for service years at ${on} for somebody engaged on ${employedFrom}. A date before the ` +
        'employment date is a caller mistake, and answering zero would hide it.',
      { employedFrom, on },
    )
  }
  let years = 0
  while (addMonths(employedFrom, (years + 1) * MONTHS_PER_YEAR) <= on) years += 1
  return years
}

/** The days-of-wage-per-year rate a month earns at, decided at the month END — see the module note. */
export function gratuityDaysPerYearOn(
  rules: GratuityRules,
  employedFrom: LocalDate,
  on: LocalDate,
): number {
  assertGratuityRules(rules)
  return completedServiceYears(employedFrom, on) >= rules.bandBoundaryYears
    ? rules.daysPerYearAfterBand
    : rules.daysPerYearFirstBand
}

/** How many days of a calendar month somebody was employed for, inclusive at both ends. */
export function employedDaysInMonth(args: {
  readonly accrualMonth: LocalDate
  readonly employedFrom: LocalDate
  readonly employedUntil?: LocalDate | null
}): number {
  const first = monthStart(args.accrualMonth)
  const last = monthEnd(args.accrualMonth)
  const from = args.employedFrom > first ? args.employedFrom : first
  const until = args.employedUntil ?? null
  const to = until !== null && until < last ? until : last
  if (to < from) return 0
  // Inclusive at both ends: employed from the 1st to the 30th is 30 days, and a half-open reading gives
  // 29 and looks entirely reasonable. The same reading `calendarLeaveDays` takes, for the same reason.
  return Number(to.slice(8)) - Number(from.slice(8)) + 1
}

/** One calendar month's contribution to the cumulative entitlement. */
export interface GratuityMonthContribution {
  readonly accrualMonth: LocalDate
  /** Calendar days of the month the person was employed for. */
  readonly employedDays: number
  /** Approved unpaid-leave days the rule excluded. Zero when the rule does not exclude them. */
  readonly excludedDays: number
  /** `employedDays − excludedDays`, never below zero. */
  readonly paidDays: number
  /** The band rate this month earned at. */
  readonly daysPerYear: number
  /** Whether the month fell wholly inside probation and therefore earned nothing. */
  readonly withinProbation: boolean
  /** `daysPerYear × paidDays × (MONTH_LENGTH_LCM ÷ daysInMonth)`, or 0. Exact, unrounded, unitless. */
  readonly numerator: number
}

export interface GratuityServiceHistory {
  readonly employedFrom: LocalDate
  readonly employedUntil?: LocalDate | null
  /** Approved unpaid-leave days per calendar month, keyed `YYYY-MM-01`. Absent means none. */
  readonly unpaidLeaveDaysByMonth?: ReadonlyMap<string, number>
}

/**
 * Every month from engagement to `asOf`, with what each contributes.
 *
 * Returned rather than folded away because it is the working paper: an employee disputing a figure asks
 * which months earned what, and a function that returned only the total could not answer. It is also
 * what makes the band boundary and the probation exclusion visible to a test at the month that changes.
 */
export function gratuityMonthContributions(args: {
  readonly rules: GratuityRules
  readonly service: GratuityServiceHistory
  /** The last date to accrue to. Contributions stop at the month this falls in. */
  readonly asOf: LocalDate
}): readonly GratuityMonthContribution[] {
  const { rules, service, asOf } = args
  assertGratuityRules(rules)
  if (asOf < service.employedFrom) return []

  const probationEnds = gratuityProbationEndsOn(rules, service.employedFrom)
  const lastMonth = monthStart(asOf)
  const contributions: GratuityMonthContribution[] = []

  let month = monthStart(service.employedFrom)
  while (month <= lastMonth) {
    const thisMonthEnd = monthEnd(month)
    // The month is truncated at `asOf` so a mid-month question is answered pro rata rather than by
    // awarding the whole month. A liability read on the 10th must not include the 11th to the 31st.
    const until =
      service.employedUntil !== null && service.employedUntil !== undefined
        ? service.employedUntil < asOf
          ? service.employedUntil
          : asOf
        : asOf
    const employedDays = employedDaysInMonth({
      accrualMonth: month,
      employedFrom: service.employedFrom,
      employedUntil: until,
    })
    // Wholly inside probation, judged on the month END: a month in which probation ends earns, because
    // the alternative loses a whole month's entitlement to a boundary that fell mid-month.
    const withinProbation = !rules.accruesDuringProbation && thisMonthEnd < probationEnds
    const declaredUnpaid = service.unpaidLeaveDaysByMonth?.get(month as string) ?? 0
    const excludedDays = rules.unpaidLeaveDaysExcluded
      ? Math.min(Math.max(declaredUnpaid, 0), employedDays)
      : 0
    const paidDays = Math.max(employedDays - excludedDays, 0)
    const daysPerYear = gratuityDaysPerYearOn(rules, service.employedFrom, thisMonthEnd)
    const scale = MONTH_LENGTH_LCM / daysInMonthOf(month)
    contributions.push({
      accrualMonth: month,
      employedDays,
      excludedDays,
      paidDays,
      daysPerYear,
      withinProbation,
      numerator: withinProbation ? 0 : daysPerYear * paidDays * scale,
    })
    month = addMonths(month, 1)
  }
  return contributions
}

/** `ceil(a ÷ b)` for positive `b`, in `BigInt`, correct for a negative `a` too. */
function ceilDiv(a: bigint, b: bigint): bigint {
  const quotient = a / b
  // Truncation rounds towards zero, so it already IS the ceiling for a negative numerator.
  return a % b === 0n || a < 0n ? quotient : quotient + 1n
}

/** A fils figure that has to come back from `BigInt` into the `number` the rest of the estate uses. */
function filsFromBig(value: bigint, what: string): Fils {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new UnusableGratuityRules(
      `${what} came to ${value} fils, which is outside the exact-integer range a number can hold. ` +
        'Returning it would silently lose dirhams from a liability nobody would then be able to ' +
        'reconcile — the reason the arithmetic runs in BigInt at all.',
      { fils: value.toString() },
    )
  }
  return filsFrom(Number(value))
}

export interface GratuityLiability {
  /** The whole liability owed at `asOf`, in integer fils. */
  readonly fils: Fils
  /** The wage the figure was computed on. Pinned, so a later rise cannot restate it. */
  readonly wageFils: Fils
  /** The rule version that governed. */
  readonly ruleEffectiveFrom: LocalDate
  /** Months of service that earned anything. Reported so "zero" is never mistaken for "no months". */
  readonly earningMonths: number
  /** Months that earned nothing because they fell inside probation. */
  readonly probationMonths: number
  /** The exact unrounded sum, for the working paper and for the reconciliation test. */
  readonly numerator: number
  /** Every month and what it contributed. */
  readonly contributions: readonly GratuityMonthContribution[]
}

/**
 * The WHOLE gratuity liability owed to one employee at a date.
 *
 * One rounding, at the end, upwards. See the module note for why the cumulative figure is the primitive
 * and the month's accrual is a difference of two of these.
 *
 * `wageFils` is the wage as at `asOf` and is applied to the whole of service — the final-wage reading,
 * flagged on `Y9-gratuity`. An employee with no wage on file is refused rather than priced at zero: all
 * nineteen seeded therapists have `basic_wage_fils` null (brief rule 15 — a wage is a fact about a
 * person), and a zero liability for somebody owed one is the error that leaves no trace. The JOB counts
 * and names them instead, the way `labour-cost.ts` reports an unpriced employee.
 */
export function gratuityLiabilityAt(args: {
  readonly rules: GratuityRules
  readonly service: GratuityServiceHistory
  readonly asOf: LocalDate
  readonly wageFils: number
}): GratuityLiability {
  const { rules, service, asOf, wageFils } = args
  assertGratuityRules(rules)
  if (!Number.isInteger(wageFils) || wageFils < 0) {
    throw new UnusableGratuityRules(
      `A gratuity liability was asked for on a wage of ${wageFils} fils. Money is a non-negative ` +
        'integer number of fils (ADR 0007); a fractional or negative wage here is a cast past `Money`.',
      { wageFils },
    )
  }
  const contributions = gratuityMonthContributions({ rules, service, asOf })
  const numerator = contributions.reduce((sum, month) => sum + month.numerator, 0)
  if (!Number.isSafeInteger(numerator)) {
    throw new UnusableGratuityRules(
      `The unrounded entitlement sum came to ${numerator}, which is not an exact integer. Every term ` +
        'is a product of small integers, so this can only mean a service history longer than any ' +
        'career.',
      { numerator, months: contributions.length },
    )
  }
  const denominator =
    BigInt(MONTHS_PER_YEAR) * BigInt(rules.dailyWageDaysDivisor) * BigInt(MONTH_LENGTH_LCM)
  const fils = filsFromBig(
    ceilDiv(BigInt(wageFils) * BigInt(numerator), denominator),
    `The gratuity liability at ${asOf}`,
  )
  return {
    fils,
    wageFils: filsFrom(wageFils),
    ruleEffectiveFrom: rules.effectiveFrom,
    earningMonths: contributions.filter((month) => month.numerator > 0).length,
    probationMonths: contributions.filter((month) => month.withinProbation).length,
    numerator,
    contributions,
  }
}

export interface GratuityAccrual {
  readonly accrualMonth: LocalDate
  /** The last day of the accrual month: what the liability is measured at and what the entry is dated. */
  readonly accruedTo: LocalDate
  /** The liability owed at the month end. */
  readonly cumulativeFils: Fils
  /** Already on the books for this employee, as the caller supplied it. */
  readonly alreadyAccruedFils: Fils
  /**
   * `cumulative − alreadyAccrued`. **Signed**, and zero for a month already accrued.
   *
   * Negative is not an error and is not posted as a negative line: it means the books hold more than is
   * owed, which the journal answers with a dated reversal and a replacement entry (ADR 0017), never with
   * a line whose sign carries its direction. {@link overAccrued} is the flag a caller branches on.
   */
  readonly movementFils: number
  /** True when the movement is negative, so the caller takes the correction path rather than posting. */
  readonly overAccrued: boolean
  readonly liability: GratuityLiability
}

/**
 * What one calendar month adds to an employee's gratuity liability.
 *
 * `alreadyAccruedFils` is the sum of that employee's live accrual rows and is an ARGUMENT, not something
 * this function could know: it is a fact about the ledger, and a pure engine that guessed it would be a
 * second opinion about a balance the journal already holds.
 */
export function accrueGratuityMonth(args: {
  readonly rules: GratuityRules
  readonly service: GratuityServiceHistory
  readonly accrualMonth: LocalDate
  readonly wageFils: number
  readonly alreadyAccruedFils: number
}): GratuityAccrual {
  const accrualMonth = monthStart(args.accrualMonth)
  const accruedTo = monthEnd(accrualMonth)
  if (!Number.isInteger(args.alreadyAccruedFils) || args.alreadyAccruedFils < 0) {
    throw new UnusableGratuityRules(
      `The gratuity already accrued was given as ${args.alreadyAccruedFils} fils. It is the sum of ` +
        'append-only accrual rows, so it is a non-negative integer or the caller read the wrong thing.',
      { alreadyAccruedFils: args.alreadyAccruedFils },
    )
  }
  const liability = gratuityLiabilityAt({
    rules: args.rules,
    service: args.service,
    asOf: accruedTo,
    wageFils: args.wageFils,
  })
  const movementFils = liability.fils - args.alreadyAccruedFils
  return {
    accrualMonth,
    accruedTo,
    cumulativeFils: liability.fils,
    alreadyAccruedFils: filsFrom(args.alreadyAccruedFils),
    movementFils,
    overAccrued: movementFils < 0,
    liability,
  }
}

// --- posting to the ledger ----------------------------------------------------------------------

/**
 * The two accounts a gratuity posting touches, resolved by the CALLER from the chart through settings.
 *
 * Arguments and never constants, which is the acceptance line *"debit and credit accounts are resolved
 * from the chart of accounts through settings, with a grep test asserting no account code literal in the
 * job"*. The chart is provisional against `Y8-coa` (0018 says so on `chart_of_accounts` itself), so a
 * code written into a posting rule would be this build deciding an accountant's classification — and
 * `hr-gratuity.test.ts` scans this module and the job for a four-digit literal.
 */
export interface GratuityAccounts {
  readonly expense: AccountCode
  readonly liability: AccountCode
}

/** The `journal_entry.source` every gratuity accrual and its reversal carry. Not a free string. */
export const GRATUITY_ACCRUAL_SOURCE = 'gratuity_accrual' as const

function positive(fils: number, what: string): Money {
  if (!Number.isInteger(fils) || fils <= 0) {
    throw new UnusableGratuityRules(
      `${what} is ${fils} fils. A journal line carries its direction in the side and its amount as a ` +
        'positive figure, so a zero or negative amount here is a line somebody forgot to fill in.',
      { fils },
    )
  }
  return { fils: filsFrom(fils), currency: 'AED' }
}

/**
 * The balanced two-line entry for one month's accrual: expense debit, liability credit.
 *
 * Two lines and no more, so the entry sums to zero fils by construction rather than by a check — which
 * is the acceptance line *"a test asserts every entry sums to zero fils"*, and it is also why the amount
 * is refused when it is not positive: a zero-fils entry balances perfectly and posts nothing.
 *
 * `entryDate` is an ARGUMENT and is not derived from the accrual month, because the two differ exactly
 * when they matter: an accrual for a month whose accounting period has since been LOCKED must land in
 * the next open period (ADR 0026 — a closed period cannot be reopened without a migration), dated there
 * and naming the locked month in its narrative. The caller knows the locks; this function must not
 * guess, for the reason `reverseEntry` takes its date as an argument rather than reading a clock.
 */
export function gratuityAccrualEntry(args: {
  readonly entryId: EntryId
  readonly entryDate: LocalDate
  readonly accounts: GratuityAccounts
  readonly amountFils: number
  /** The month accrued for, which the narrative names whether or not the entry is dated in it. */
  readonly accrualMonth: LocalDate
  /** The employee the accrual is for, by `staff_reference` — never a person's name (ADR 0020). */
  readonly staffReference: string
  /** Set when `accrualMonth` fell inside a locked period, so the narrative can say which. */
  readonly lockedPeriodId?: string | null
}): EntryDraft {
  const month = monthStart(args.accrualMonth)
  const amount = positive(
    args.amountFils,
    `A gratuity accrual for ${args.staffReference} in ${month}`,
  )
  const lines: readonly EntryLineDraft[] = [
    debit(args.accounts.expense, amount, `Gratuity accrued for ${args.staffReference}`),
    credit(args.accounts.liability, amount, `Gratuity owed to ${args.staffReference}`),
  ]
  const locked = args.lockedPeriodId ?? null
  return {
    entryId: args.entryId,
    entryDate: args.entryDate,
    // The narrative says which month EARNED it, not which month it was posted in. Those differ for
    // every catch-up and for every locked period, and the second half is what an accountant reading the
    // open period needs in order not to chase a figure that belongs to a month they have already filed.
    narrative:
      locked === null
        ? `Gratuity accrual for ${args.staffReference}, month ${month}`
        : `Gratuity accrual for ${args.staffReference}, month ${month} (accounting period ` +
          `"${locked}" is locked; posted in the next open period)`,
    source: GRATUITY_ACCRUAL_SOURCE,
    lines,
  }
}

/**
 * The balanced two-line entry that settles a leaver: liability debit, payable credit.
 *
 * It DISCHARGES the liability rather than paying it. The credit is a payable — the leaver is owed the
 * money until the run pays it — so this entry never touches cash, and the liability account nets to
 * exactly zero for that employee once it has posted, which is the acceptance line it exists for.
 */
export function gratuitySettlementEntry(args: {
  readonly entryId: EntryId
  readonly entryDate: LocalDate
  readonly liabilityAccount: AccountCode
  readonly payableAccount: AccountCode
  readonly amountFils: number
  readonly staffReference: string
  readonly employedUntil: LocalDate
}): EntryDraft {
  const amount = positive(
    args.amountFils,
    `A gratuity settlement for ${args.staffReference} leaving on ${args.employedUntil}`,
  )
  return {
    entryId: args.entryId,
    entryDate: args.entryDate,
    narrative:
      `End-of-service gratuity settlement for ${args.staffReference}, employment ended ` +
      `${args.employedUntil}`,
    // `payroll` and not `gratuity_accrual`: an accrual builds the liability and a settlement discharges
    // it, and the reconciliation that ties the liability account to the accrual rows can only be made if
    // the two are distinguishable by source rather than only by amount.
    source: 'payroll',
    lines: [
      debit(args.liabilityAccount, amount, `Gratuity settled for ${args.staffReference}`),
      credit(args.payableAccount, amount, `Final settlement owed to ${args.staffReference}`),
    ],
  }
}

export interface GratuityCorrection {
  /** Reverse the original first. Dated `on`, which {@link reverseEntry} refuses to backdate. */
  readonly reversalOf: EntryId
  /** Then post this. Absent when the corrected figure is zero — a reversal alone is the correction. */
  readonly replacement: EntryDraft | null
}

/**
 * Correcting an over-accrual: a dated reversal, then a replacement entry.
 *
 * Two entries and never an edit (ADR 0017), and in this order. The replacement is `null` when the
 * corrected figure is zero, because a zero-fils entry is not a posting — the reversal has already said
 * everything there is to say, and `postEntry` would refuse the empty replacement anyway.
 *
 * `on` is where the correction is DATED and is an argument: a February over-accrual found in March is
 * dated in February if February is still open and in March if it is not, and only the caller knows the
 * locks. This is `reverseEntry`'s own rule and the reason it takes a date rather than reading a clock.
 */
export function correctGratuityOverAccrual(args: {
  readonly original: EntryId
  readonly replacementEntryId: EntryId
  readonly on: LocalDate
  readonly accounts: GratuityAccounts
  readonly correctedFils: number
  readonly accrualMonth: LocalDate
  readonly staffReference: string
  readonly lockedPeriodId?: string | null
}): GratuityCorrection {
  if (!Number.isInteger(args.correctedFils) || args.correctedFils < 0) {
    throw new UnusableGratuityRules(
      `A gratuity correction for ${args.staffReference} was given a corrected figure of ` +
        `${args.correctedFils} fils. The corrected liability is what SHOULD have been accrued, so it ` +
        'is zero or positive; the reduction is expressed by the reversal, not by a negative amount.',
      { correctedFils: args.correctedFils },
    )
  }
  return {
    reversalOf: args.original,
    replacement:
      args.correctedFils === 0
        ? null
        : gratuityAccrualEntry({
            entryId: args.replacementEntryId,
            entryDate: args.on,
            accounts: args.accounts,
            amountFils: args.correctedFils,
            accrualMonth: args.accrualMonth,
            staffReference: args.staffReference,
            ...(args.lockedPeriodId === undefined ? {} : { lockedPeriodId: args.lockedPeriodId }),
          }),
  }
}

// --- the closed-period labour adjustment (P-HR-07's re-pointed gap) ------------------------------

/**
 * Work done in a month whose accounting period has since CLOSED, with no punch ever recorded.
 *
 * ## Why this is here and not in P-HR-07 or P-HR-12
 *
 * P-HR-07 could not record it: `attendance_correction.corrects_event_id` is NOT NULL because a
 * correction amends a record and cannot invent one, and a pair of punches written after the month closed
 * would be exactly the un-auditable write those tables exist to refuse. P-HR-12 could not either: its
 * `payroll_deduction` only ever REDUCES pay, and unrecorded work needs an UPWARD adjustment, which
 * nothing in the payroll schema expresses. `Y9-attendance` recorded the gap as *"a ledger-side
 * adjustment rather than a punch"* and pointed it at P-HR-12; P-HR-12 re-pointed it here, because this
 * is the HR unit that posts to the ledger.
 *
 * ## The amount is STATED by whoever authorises it, never derived
 *
 * There is no computation in this function and that is the whole design. Deriving the figure means
 * deciding what a day of a monthly wage is worth for the purpose of PAYING somebody, and P-HR-07's NOTE
 * declines to do that in so many words: `labour_cost_rule` is a forecast's divisor, and `Y9-deductions`
 * already records *"what a day of a monthly salary is worth"* as unanswered. A derived figure would also
 * be indistinguishable on the ledger from one a manager authorised, which is `Y9-deductions`' own
 * argument against a derived deduction. So the amount arrives with an authorising actor and a reason
 * somebody wrote in their own words, exactly as a `payroll_deduction` does, and this function's job is
 * to refuse the ways of dating it wrongly.
 *
 * ## It accrues, it does not pay
 *
 * Wages expense debit, wages payable credit. The money leaves through the next payroll run, which is
 * P-HR-12's and is not touched: a run that has completed is immutable (ZY141) and its header figures may
 * only be written by the statement that completes it (ZY142), so an adjustment that had to reach into
 * one would be unpostable. Crediting a payable instead means the next run discharges it with no
 * completed run rewritten — which is the constraint P-HR-12 handed over, satisfied by not needing it.
 */
export interface ClosedPeriodLabourAdjustment {
  readonly entryId: EntryId
  /**
   * Where the entry is DATED — inside an OPEN period, never inside the locked one.
   *
   * ADR 0026: a closed period cannot be reopened without a migration, and ADR 0017's journal has no
   * edit. So the adjustment is dated where it can be posted and NAMES the period it belongs to, which is
   * the acceptance line *"the entry lands in the next open period with a dated reference to the locked
   * one"* read as one mechanism rather than two.
   */
  readonly entryDate: LocalDate
  /** The trading date the work was actually done on, inside the locked period. */
  readonly workedOn: LocalDate
  readonly lockedPeriodId: string
  readonly wagesExpenseAccount: AccountCode
  readonly wagesPayableAccount: AccountCode
  readonly amountFils: number
  readonly staffReference: string
  /** Why, in the authoriser's own words. Never a vocabulary this build chose — see `Y9-deductions`. */
  readonly reason: string
}

export function closedPeriodLabourAdjustmentEntry(args: ClosedPeriodLabourAdjustment): EntryDraft {
  if (args.reason.trim().length === 0) {
    throw new UnusableGratuityRules(
      `A closed-period labour adjustment for ${args.staffReference} on ${args.workedOn} carries no ` +
        'reason. It is a payment for work no punch records, so the reason is the only evidence there ' +
        'is that it happened.',
    )
  }
  if (args.entryDate <= args.workedOn) {
    throw new UnusableGratuityRules(
      `A closed-period labour adjustment for work on ${args.workedOn} was dated ${args.entryDate}. ` +
        'The adjustment exists BECAUSE the period containing the work has closed, so an entry dated on ' +
        'or before the work is either inside the locked period — where it cannot post — or evidence ' +
        'that the period was not locked and a punch correction was the right answer.',
      { workedOn: args.workedOn, entryDate: args.entryDate },
    )
  }
  const amount = positive(
    args.amountFils,
    `A closed-period labour adjustment for ${args.staffReference} on ${args.workedOn}`,
  )
  return {
    entryId: args.entryId,
    entryDate: args.entryDate,
    narrative:
      `Unrecorded work by ${args.staffReference} on ${args.workedOn}, in locked accounting period ` +
      `"${args.lockedPeriodId}": ${args.reason.trim()}`,
    // `adjustment` and not `payroll`: a run pays what its timesheets approved, and this is money owed
    // for work no timesheet ever saw. A reader filtering the journal for payroll must not find it there
    // and conclude a run covered it.
    source: 'adjustment',
    lines: [
      debit(args.wagesExpenseAccount, amount, `Unrecorded work, ${args.staffReference}`),
      credit(
        args.wagesPayableAccount,
        amount,
        `Owed to ${args.staffReference} for ${args.workedOn}`,
      ),
    ],
  }
}

/** The first day of the month after `date`. Where a catch-up lands when the month itself is locked. */
export function monthAfter(date: LocalDate): LocalDate {
  return addMonths(monthStart(date), 1)
}

/** Parses a `YYYY-MM` accrual-month key into the `YYYY-MM-01` LocalDate every accrual is keyed on. */
export function accrualMonthKey(month: LocalDate): string {
  return (month as string).slice(0, 7)
}

/** The `YYYY-MM-01` date a `YYYY-MM` key names. The inverse of {@link accrualMonthKey}. */
export function accrualMonthFromKey(key: string): LocalDate {
  if (!/^\d{4}-\d{2}$/.test(key)) {
    throw new UnusableGratuityRules(
      `"${key}" is not an accrual month. An accrual is keyed YYYY-MM, and a looser reading here would ` +
        'let two spellings of one month both be "not yet accrued".',
      { key },
    )
  }
  return localDate(`${key}-01`)
}
