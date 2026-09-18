import { AppError } from '@berelax/shared'
import { filsFrom, type Money, money, roundHalfUp, subtract, sum, ZERO_AED } from '../money.ts'
import { type LocalDate, localDate } from '../time.ts'

/**
 * The recurring cost register's arithmetic: when a cost is next expected, what it is expected to be,
 * and by how much a bill missed.
 *
 * Pure. Every date and every amount is an argument — there is no clock here and
 * `scripts/check-core-purity.mjs` would refuse one. A schedule that read the clock would produce a
 * different forecast tomorrow for a horizon somebody already committed to, and the worked example
 * committed in `packages/fixtures/src/recurring-costs.ts` could not exist at all.
 *
 * ## What a variance is measured against
 *
 * **The cost's own declared expectation for that period.** Not last period, and not a rolling mean.
 *
 * The declared expectation has two shapes, which is the whole reason a cost declares whether it is
 * fixed or variable:
 *
 *   - A **fixed** cost (rent, insurance, a trade licence, a subscription) expects a contracted
 *     **amount**. Any difference beyond its declared tolerance is news, in either direction: a rent
 *     200 AED low is a credit to chase or an error, exactly as a rent 200 AED high is.
 *   - A **variable** cost (a utility recharge, laundry by volume, card-processing fees) moves by
 *     design, so a single expected number would be wrong every month by construction. It expects a
 *     **band**, and its variance is the distance *outside* the band — zero while the bill is inside it.
 *     That is what stops an August electricity bill at the top of its range alerting every summer.
 *
 * Both alternatives are worse and specifically so:
 *
 *   - **Against last period.** The second month of a wrong amount is silent. The landlord overcharges
 *     in March and the alert fires; he overcharges the identical amount in April and the difference is
 *     zero. A wrong figure that persists is the one most worth catching.
 *   - **Against a rolling mean.** The mean absorbs the error it is meant to detect — three months of
 *     an incorrect rent pulls the mean onto the incorrect rent. On a seasonal cost it is worse still:
 *     it fires on the way up and again on the way down, both of which are normal, and an alert that
 *     fires every month is an alert nobody reads.
 *
 * ## One rule, two statements
 *
 * `0031_recurring_cost.sql` states the same four things in SQL — `recurring_cost_period_months`,
 * `recurring_cost_period_key`, `recurring_cost_due_date` and `recurring_cost_variance` — because
 * `packages/db` may not import this package and the forecast has to group where the rows are.
 * `packages/fixtures/src/recurring-costs.itest.ts` asserts the two agree over every cadence, a long
 * run of occurrences and both sides of the tolerance boundary. That is the arrangement
 * `payables_aging_bucket` / `payablesBucketFor` already uses, for the same reason and with the same
 * agreement test.
 */

/**
 * How often a cost recurs.
 *
 * Three, and adding a fourth is a migration — the CHECK on `recurring_cost.cadence` and
 * `recurring_cost_period_months()` both have to learn it, and a cadence this module could express but
 * the database could not step would produce a forecast the register cannot generate periods for.
 */
export const RECURRING_CADENCES = ['monthly', 'quarterly', 'annual'] as const
export type RecurringCadence = (typeof RECURRING_CADENCES)[number]

/** Whether a cost expects an amount or a band. Stated on the definition, never inferred. */
export const RECURRING_COST_KINDS = ['fixed', 'variable'] as const
export type RecurringCostKind = (typeof RECURRING_COST_KINDS)[number]

/**
 * The refusals this module raises, by name.
 *
 * Named constants rather than message matching, for the reason `PURCHASES_SQLSTATE` gives: a caller
 * that recognised a refusal by its wording stops recognising it the day somebody improves the
 * sentence, and the code that then treats a missing expected range as an unknown failure is the code
 * that retries it.
 */
export const RECURRING_COST_REFUSALS = {
  /** A variable cost saved with no band. There is nothing to be inside, so nothing is ever normal. */
  expectedRangeRequired: 'ExpectedRangeRequired',
  /** A fixed cost saved with no contracted amount. There is nothing to differ from. */
  expectedAmountRequired: 'ExpectedAmountRequired',
  /** A band whose maximum is below its minimum: every bill is both too high and too low. */
  expectedRangeInverted: 'ExpectedRangeInverted',
  /** Zero or negative. A missing amount, not a free contract. */
  expectedAmountNotPositive: 'ExpectedAmountNotPositive',
  /** A tolerance outside 0..10000 basis points is not a fraction of anything. */
  toleranceOutOfRange: 'ToleranceOutOfRange',
  /** An anchor on the 29th, 30th or 31st: see `recurringDueDate`. */
  anchorDayOutsideEveryMonth: 'AnchorDayOutsideEveryMonth',
  /** A contract that ends before its first period falls due generates nothing. */
  contractEndsBeforeItStarts: 'ContractEndsBeforeItStarts',
  /** A cadence neither this module nor the database can step. */
  unknownCadence: 'UnknownRecurringCadence',
} as const

export type RecurringCostRefusal =
  (typeof RECURRING_COST_REFUSALS)[keyof typeof RECURRING_COST_REFUSALS]

/** Raises the named refusal. The name is in the message AND in `details`, so both readers work. */
function refuse(refusal: RecurringCostRefusal, explanation: string): never {
  throw new AppError('validation', `${refusal}: ${explanation}`, { details: { refusal } })
}

/** True when `err` is the named refusal. */
export function isRecurringCostRefusal(err: unknown, refusal: RecurringCostRefusal): boolean {
  return err instanceof AppError && err.details['refusal'] === refusal
}

/**
 * The last day of the month a cost may be anchored on.
 *
 * 28, because `date + interval '1 month'` clamps 31 January to 28 February: an anchor on the 31st
 * would step to the 28th, the 31st, the 30th — a series whose day of the month wanders, which cannot
 * be compared period to period and cannot be predicted by whoever reads the forecast. Restricting the
 * anchor removes the clamp instead of documenting it, and a cost genuinely due on the last day of the
 * month is anchored on the 28th: at worst three days early for an alert whose purpose is to fire
 * *before* somebody forgets.
 */
export const LAST_ANCHOR_DAY_OF_MONTH = 28

/** Calendar months in one period of a cadence. */
export function periodMonthsFor(cadence: RecurringCadence): number {
  switch (cadence) {
    case 'monthly':
      return 1
    case 'quarterly':
      return 3
    case 'annual':
      return 12
    default:
      return refuse(
        RECURRING_COST_REFUSALS.unknownCadence,
        `"${String(cadence)}" is not a cadence this schedule can step`,
      )
  }
}

/**
 * The period a due date belongs to, as `YYYY-MM`.
 *
 * A calendar **month** for every cadence, not the cadence's own unit. A quarterly cost lands in the
 * month it falls due and an annual one in its renewal month, which is what lets costs of different
 * cadences be summed into one cash-flow line — a per-cadence key like `2027-Q2` could not be added to
 * a monthly one. The SQL mirror is `recurring_cost_period_key()`.
 *
 * A slice rather than a date parse: a `LocalDate` is `YYYY-MM-DD`, so its first seven characters *are*
 * the key, and re-parsing it would be a second chance to shift a month at a zone boundary.
 */
export function recurringPeriodKey(dueDate: LocalDate): string {
  return localDate(dueDate).slice(0, 7)
}

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/

/** True for a `YYYY-MM` period key. Exported so a reader of a stored key can check it. */
export function isRecurringPeriodKey(value: string): boolean {
  return MONTH_KEY.test(value)
}

interface DateParts {
  readonly year: number
  readonly month: number
  readonly day: number
}

function partsOf(date: LocalDate): DateParts {
  const iso = localDate(date)
  return {
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  }
}

/** Days in a month, 1-indexed. Not a lookup table: the leap rule belongs in one expression. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function toIsoDate(year: number, month: number, day: number): LocalDate {
  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  return localDate(`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`)
}

/**
 * Whole calendar months from `earlier` to `later`, ignoring the day.
 *
 * Used only to find which occurrence a window starts at, which is why the day is irrelevant: the
 * occurrence itself is then filtered against the window by date.
 */
export function monthsBetween(earlier: LocalDate, later: LocalDate): number {
  const from = partsOf(earlier)
  const to = partsOf(later)
  return (to.year - from.year) * 12 + (to.month - from.month)
}

/**
 * The due date of occurrence `n`, counting the anchor as occurrence 0.
 *
 * Anchored on `firstDueDate` and stepped in whole months, so the series is a function of the
 * definition alone. Stepping from the *previous* occurrence instead would make the series depend on
 * which rows already exist, and one missing row would shift every later date — which is how a
 * generator comes to file October's expectation under September.
 *
 * The clamp mirrors PostgreSQL's `date + interval '1 month'` exactly, so the two statements of this
 * rule agree even for an anchor `LAST_ANCHOR_DAY_OF_MONTH` forbids. It is total rather than reachable:
 * validation refuses such an anchor, and this stays defined so that the agreement test can compare the
 * two implementations over the days validation rules out as well as the ones it allows.
 */
export function recurringDueDate(
  firstDueDate: LocalDate,
  cadence: RecurringCadence,
  occurrence: number,
): LocalDate {
  if (!Number.isInteger(occurrence)) {
    throw new AppError(
      'validation',
      `Occurrence must be a whole number of periods, received ${occurrence}`,
    )
  }
  const anchor = partsOf(firstDueDate)
  const monthIndex = anchor.month - 1 + occurrence * periodMonthsFor(cadence)
  const year = anchor.year + Math.floor(monthIndex / 12)
  const month = (((monthIndex % 12) + 12) % 12) + 1
  return toIsoDate(year, month, Math.min(anchor.day, daysInMonth(year, month)))
}

/** A fixed cost's expectation, or a variable cost's. The discriminant is the cost kind. */
export type RecurringExpectation =
  | {
      readonly kind: 'fixed'
      readonly amount: Money
      readonly toleranceBp: number
    }
  | {
      readonly kind: 'variable'
      readonly min: Money
      readonly max: Money
      readonly toleranceBp: number
    }

export interface RecurringCostInput {
  readonly code: string
  readonly cadence: RecurringCadence
  readonly firstDueDate: LocalDate
  /** `null` or absent is open-ended, which is the normal case for rent and utilities. */
  readonly finalDueDate?: LocalDate | null
  readonly kind: RecurringCostKind
  /** A fixed cost's contracted amount. */
  readonly expectedAmount?: Money | null
  /** A variable cost's normal band. */
  readonly expectedMin?: Money | null
  readonly expectedMax?: Money | null
  /**
   * How far past the expectation is still not news, in basis points of the breached expectation.
   *
   * No default here and none in the schema: this is the one number that decides whether the alert is
   * read. Defaulted to zero, every variable cost alerts on the first fils outside its band; defaulted
   * to 500, a 5% rent rise is accepted for ever. A default makes "nobody chose" and "somebody chose
   * that" indistinguishable.
   */
  readonly toleranceBp: number
}

export interface RecurringCost {
  readonly code: string
  readonly cadence: RecurringCadence
  readonly firstDueDate: LocalDate
  readonly finalDueDate: LocalDate | null
  readonly expectation: RecurringExpectation
}

/**
 * Validates one definition and normalises it into the expectation a variance is measured against.
 *
 * The two shape rules are the ones the acceptance names, and they are refused here **and** by
 * `recurring_cost_variable_needs_an_expected_range` / `recurring_cost_fixed_needs_an_expected_amount`
 * in the migration. Two layers, for the reason 0028 gives about the no-TRN rule: the CHECK holds for
 * every role and survives this function being bypassed, and this function is the layer a person reads
 * — a bare constraint name tells whoever is filling in the form nothing about which field is missing.
 */
export function validateRecurringCost(input: RecurringCostInput): RecurringCost {
  if (!RECURRING_CADENCES.includes(input.cadence)) {
    refuse(
      RECURRING_COST_REFUSALS.unknownCadence,
      `recurring cost "${input.code}" declares cadence "${String(input.cadence)}"`,
    )
  }
  if (!Number.isInteger(input.toleranceBp) || input.toleranceBp < 0 || input.toleranceBp > 10_000) {
    refuse(
      RECURRING_COST_REFUSALS.toleranceOutOfRange,
      `recurring cost "${input.code}" declares a tolerance of ${input.toleranceBp} bp; a tolerance is ` +
        '0 to 10000 basis points of the expectation',
    )
  }
  if (partsOf(input.firstDueDate).day > LAST_ANCHOR_DAY_OF_MONTH) {
    refuse(
      RECURRING_COST_REFUSALS.anchorDayOutsideEveryMonth,
      `recurring cost "${input.code}" is anchored on ${input.firstDueDate}, whose day does not exist ` +
        `in every month. Anchor it on the ${LAST_ANCHOR_DAY_OF_MONTH}th or earlier: a series that ` +
        'clamps in February has a day of the month that wanders and cannot be compared period to period',
    )
  }
  const finalDueDate = input.finalDueDate ?? null
  if (finalDueDate !== null && localDate(finalDueDate) < localDate(input.firstDueDate)) {
    refuse(
      RECURRING_COST_REFUSALS.contractEndsBeforeItStarts,
      `recurring cost "${input.code}" ends ${finalDueDate}, before its first period falls due on ` +
        `${input.firstDueDate}, so it would expect nothing at all`,
    )
  }

  return {
    code: input.code,
    cadence: input.cadence,
    firstDueDate: input.firstDueDate,
    finalDueDate,
    expectation: expectationFor(input),
  }
}

function expectationFor(input: RecurringCostInput): RecurringExpectation {
  if (input.kind === 'fixed') {
    const amount = input.expectedAmount ?? null
    if (amount === null) {
      refuse(
        RECURRING_COST_REFUSALS.expectedAmountRequired,
        `recurring cost "${input.code}" is fixed and states no expected amount. A fixed cost's ` +
          'variance is measured against its contracted amount, so without one there is nothing to ' +
          'differ from and no bill could ever be wrong',
      )
    }
    if ((input.expectedMin ?? null) !== null || (input.expectedMax ?? null) !== null) {
      refuse(
        RECURRING_COST_REFUSALS.expectedAmountRequired,
        `recurring cost "${input.code}" is fixed and also states a band. A fixed cost is an amount ` +
          'and nothing else; whichever of the two a reader reached for first would decide the variance',
      )
    }
    if (amount.fils <= 0) {
      refuse(
        RECURRING_COST_REFUSALS.expectedAmountNotPositive,
        `recurring cost "${input.code}" expects ${amount.fils} fils. Zero is a missing amount, not a ` +
          'free contract: it would forecast nothing and make every arriving bill a total variance',
      )
    }
    return { kind: 'fixed', amount, toleranceBp: input.toleranceBp }
  }

  if (input.kind !== 'variable') {
    refuse(
      RECURRING_COST_REFUSALS.expectedAmountRequired,
      `recurring cost "${input.code}" declares kind "${String(input.kind)}", which is neither fixed ` +
        'nor variable',
    )
  }

  const min = input.expectedMin ?? null
  const max = input.expectedMax ?? null
  if (min === null || max === null) {
    refuse(
      RECURRING_COST_REFUSALS.expectedRangeRequired,
      `recurring cost "${input.code}" is variable and states no expected range. A variable cost moves ` +
        'by design, so a single expected number would be wrong every period and an alert on any ' +
        'difference would fire every period. Declare the band it is normal inside',
    )
  }
  if ((input.expectedAmount ?? null) !== null) {
    refuse(
      RECURRING_COST_REFUSALS.expectedRangeRequired,
      `recurring cost "${input.code}" is variable and also states a single expected amount. A variable ` +
        'cost is a band and nothing else',
    )
  }
  if (min.fils <= 0) {
    refuse(
      RECURRING_COST_REFUSALS.expectedAmountNotPositive,
      `recurring cost "${input.code}" has a band starting at ${min.fils} fils. Zero is a missing ` +
        'amount, not a free contract',
    )
  }
  if (max.fils < min.fils) {
    refuse(
      RECURRING_COST_REFUSALS.expectedRangeInverted,
      `recurring cost "${input.code}" expects between ${min.fils} and ${max.fils} fils. An inverted ` +
        'band accepts nothing: every bill is simultaneously above the maximum and below the minimum, ' +
        'so every period alerts and the alert means nothing',
    )
  }
  return { kind: 'variable', min, max, toleranceBp: input.toleranceBp }
}

/**
 * The figure to hold cash for: the contracted amount, or the **top** of a variable band.
 *
 * The midpoint is the tempting choice and it is wrong for a forecast — a plan built on the middle of
 * every band is short of cash in about half the months it covers, and not being short of cash is the
 * only reason to build one.
 */
export function prudentExpectation(expectation: RecurringExpectation): Money {
  return expectation.kind === 'fixed' ? expectation.amount : expectation.max
}

/** The bottom of the range a period could land in. Equal to the amount for a fixed cost. */
export function lowExpectation(expectation: RecurringExpectation): Money {
  return expectation.kind === 'fixed' ? expectation.amount : expectation.min
}

export interface VarianceVerdict {
  /**
   * Signed: above the expectation is positive, below is negative, and zero inside a variable band.
   *
   * Signed deliberately. Folding the sign away would put "the landlord billed 200 short" and "the
   * landlord billed 200 over" in the same bucket, and those are opposite conversations.
   */
  readonly delta: Money
  /** The threshold in fils, so an alert can explain itself without re-deriving anything. */
  readonly tolerance: Money
  readonly overTolerance: boolean
  readonly direction: 'above' | 'below' | 'within'
}

/**
 * How far one bill missed one period's expectation, and whether that is past tolerance.
 *
 * The SQL mirror is `recurring_cost_variance()`. `tolerance` is a fraction of the **breached**
 * expectation — the contracted amount for a fixed cost, and whichever band edge was crossed for a
 * variable one — so one declared number means one thing ("how far past the expectation is still not
 * news") while the two cost shapes keep their two expectations.
 *
 * Strictly greater: a bill exactly *on* the tolerance is within it. An off-by-one here alerts on every
 * cost whose tolerance was set to the amount it actually varies by, which is the amount somebody sets
 * it to.
 */
export function classifyVariance(
  expectation: RecurringExpectation,
  actualGross: Money,
): VarianceVerdict {
  const { delta, reference, direction } = breachOf(expectation, actualGross)
  // Integer arithmetic, half-up, matching `(reference * bp + 5000) / 10000` in the SQL mirror. The
  // reference is never negative, so half-up and floor(x + 0.5) are the same function here.
  const tolerance = money(
    filsFrom(roundHalfUp((reference.fils * expectation.toleranceBp) / 10_000)),
  )
  return {
    delta,
    tolerance,
    overTolerance: Math.abs(delta.fils) > tolerance.fils,
    direction,
  }
}

function breachOf(
  expectation: RecurringExpectation,
  actualGross: Money,
): { delta: Money; reference: Money; direction: 'above' | 'below' | 'within' } {
  if (expectation.kind === 'fixed') {
    const delta = subtract(actualGross, expectation.amount)
    return {
      delta,
      reference: expectation.amount,
      direction: delta.fils === 0 ? 'within' : delta.fils > 0 ? 'above' : 'below',
    }
  }
  if (actualGross.fils > expectation.max.fils) {
    return {
      delta: subtract(actualGross, expectation.max),
      reference: expectation.max,
      direction: 'above',
    }
  }
  if (actualGross.fils < expectation.min.fils) {
    return {
      delta: subtract(actualGross, expectation.min),
      reference: expectation.min,
      direction: 'below',
    }
  }
  // Inside the declared band is not a variance at all. This is the line that stops a seasonal cost
  // alerting every month, which is the whole reason a band is declared for it.
  return { delta: ZERO_AED, reference: ZERO_AED, direction: 'within' }
}

export interface ExpectedInstance {
  /** `YYYY-MM` of the due date. */
  readonly periodKey: string
  readonly dueDate: LocalDate
  /** The occurrence index from the anchor, so a caller can reproduce the date from the definition. */
  readonly occurrence: number
}

export interface ScheduleWindow {
  /** Inclusive. */
  readonly from: LocalDate
  /** **Exclusive**, so two adjacent windows neither overlap nor leave a gap. */
  readonly to: LocalDate
}

/**
 * Every period a cost expects with a due date in `window`, in date order.
 *
 * Half-open on purpose: `[from, to)` is what makes a 12-month window hold exactly 12 occurrences of a
 * monthly cost whatever day of the month it falls on. Bounding it on calendar months instead would
 * give eleven occurrences for a cost due on the 1st and twelve for one due on the 20th, purely because
 * of where in the month the report was run.
 *
 * The first occurrence is found arithmetically rather than by stepping from zero. A cost anchored years
 * back would otherwise cost a hundred iterations per call, and — worse — a loop bounded by a constant
 * number of steps would simply stop before reaching the window and report the cost as expecting
 * nothing, which is the failure this register exists to remove.
 */
export function expectedInstances(
  cost: RecurringCost,
  window: ScheduleWindow,
): readonly ExpectedInstance[] {
  if (localDate(window.to) < localDate(window.from)) {
    throw new AppError(
      'validation',
      `Schedule window ends ${window.to}, before it starts ${window.from}`,
    )
  }
  const step = periodMonthsFor(cost.cadence)
  // One period early, so an occurrence whose day of the month falls just before `from` is still
  // considered and then filtered by date rather than skipped by month arithmetic.
  const start = Math.max(0, Math.floor(monthsBetween(cost.firstDueDate, window.from) / step) - 1)
  const instances: ExpectedInstance[] = []
  for (let occurrence = start; ; occurrence += 1) {
    const dueDate = localDate(recurringDueDate(cost.firstDueDate, cost.cadence, occurrence))
    // Both breaks before the `from` filter, so a contract that ended before the window opened
    // terminates the loop instead of stepping to the far end of the horizon to discover it is over.
    if (dueDate >= localDate(window.to)) break
    if (cost.finalDueDate !== null && dueDate > localDate(cost.finalDueDate)) break
    if (dueDate < localDate(window.from)) continue
    instances.push({
      periodKey: recurringPeriodKey(dueDate),
      dueDate,
      occurrence,
    })
  }
  return instances
}

export interface ForwardScheduleRow {
  readonly code: string
  readonly periodKey: string
  readonly dueDate: LocalDate
  /** The prudent figure: the contracted amount, or the top of a variable band. */
  readonly expected: Money
  readonly expectedLow: Money
}

export interface ForwardSchedule {
  readonly asOf: LocalDate
  readonly months: number
  readonly rows: readonly ForwardScheduleRow[]
  /** What to hold cash for across the whole horizon. */
  readonly total: Money
  /** The optimistic end of the same horizon, for a report that shows a range. */
  readonly lowTotal: Money
}

/**
 * The cost side of the cash-flow forecast: every occurrence due in `[asOf, asOf + months)`.
 *
 * Computed from the definitions, never from generated periods. A forecast that read
 * `recurring_cost_instance` would quietly shorten to wherever the generator last got to, and a horizon
 * that ends early looks exactly like a business with no costs in month eleven. The SQL mirror,
 * `recurring_cost_forward_schedule()`, is written the same way for the same reason.
 */
export function forwardSchedule(
  costs: readonly RecurringCost[],
  asOf: LocalDate,
  months = 12,
): ForwardSchedule {
  if (!Number.isInteger(months) || months < 1) {
    throw new AppError(
      'validation',
      `A forward schedule covers at least one month; received ${months}`,
    )
  }
  const horizon = addMonths(asOf, months)
  const rows = costs
    .flatMap((cost) =>
      expectedInstances(cost, { from: asOf, to: horizon }).map((instance) => ({
        code: cost.code,
        periodKey: instance.periodKey,
        dueDate: instance.dueDate,
        expected: prudentExpectation(cost.expectation),
        expectedLow: lowExpectation(cost.expectation),
      })),
    )
    // Due date then code: a stable order, so a printed forecast diffs only where a figure changed.
    .sort((a, b) =>
      a.dueDate === b.dueDate ? a.code.localeCompare(b.code) : a.dueDate < b.dueDate ? -1 : 1,
    )

  return {
    asOf,
    months,
    rows,
    total: sum(rows.map((row) => row.expected)),
    lowTotal: sum(rows.map((row) => row.expectedLow)),
  }
}

/**
 * `date` plus whole months, clamped to the end of the target month.
 *
 * The same clamp as `recurringDueDate` and as PostgreSQL's `date + interval '1 month'`, so a horizon
 * computed here lands on the same day the database would compute.
 */
export function addMonths(date: LocalDate, months: number): LocalDate {
  const parts = partsOf(date)
  const monthIndex = parts.month - 1 + months
  const year = parts.year + Math.floor(monthIndex / 12)
  const month = (((monthIndex % 12) + 12) % 12) + 1
  return toIsoDate(year, month, Math.min(parts.day, daysInMonth(year, month)))
}

/** True when a period is past its due date as at a business day. Due today is not late. */
export function isPeriodOverdue(dueDate: LocalDate, asOf: LocalDate): boolean {
  return localDate(dueDate) < localDate(asOf)
}
