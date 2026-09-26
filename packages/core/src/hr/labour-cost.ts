import { AppError } from '@berelax/shared'
import type { LocalDate } from '../time.ts'
import type { TradingDayHours } from './working-hours.ts'

/**
 * The labour-cost forecast for a rota: integer fils, and nothing that could be mistaken for pay. Pure.
 *
 * P-HR-05 stops at `weightedMinuteBp` — whole basis-point-minutes — and its NOTE says why: turning that
 * into money needs a rate per minute, `employee.basic_wage_fils` is a MONTHLY figure, and the
 * monthly-to-hourly divisor is a policy question nobody has answered. This module takes the last step,
 * with the divisor arriving as a versioned row of `labour_cost_rule` (migration 0081) rather than as a
 * number written here.
 *
 * ## This is a FORECAST and must never be paid
 *
 * It prices the ROSTER: what the published rota would cost if everybody worked exactly what they are
 * rostered for. Payroll pays ATTENDANCE — P-HR-07's clock-in/out attributed to a business day, with its
 * INCOMPLETE state and its audited corrections — against the same buckets. The two will differ every month
 * a therapist is ill, late or asked to stay, and the difference is the point of having both. A caller that
 * paid this figure would pay somebody for a shift they did not work, so nothing here returns a payslip, a
 * net figure or a VAT line: a wage is not a supply and carries no VAT (ADR 0007's estate does not apply).
 *
 * ## Integer fils, and where the one division is
 *
 * ADR 0007: money is integer fils and never a float. The whole computation is integer, and there is
 * exactly one division:
 *
 *     fils = ceil( basicWageFils × weightedMinuteBp ÷ (daysDivisor × paidMinutesPerDay × 10_000) )
 *
 * `weightedMinuteBp` is minutes × multiplier in basis points, so dividing by 10,000 turns basis-point-
 * minutes into minutes-at-the-ordinary-rate. That 10,000 is the SCALE of the basis-point representation
 * and not a rate: every rate in the expression is already inside `weightedMinuteBp`, read from
 * `working_hours_rule` by P-HR-05. A reader looking for a multiplier literal here will not find one,
 * because there is none to find.
 *
 * **Rounded UP, once per line.** Two decisions, and each has an alternative that is wrong here:
 *
 *   * *Up rather than nearest.* A forecast decides whether a rota is affordable, so the error that matters
 *     is the one that says yes when the answer is no. Rounding up costs at most one fil per line — for
 *     nineteen therapists over a month, under six AED — and it can never understate.
 *   * *Once per line, where a line is one employee on one trading date.* That is the cell the rota grid
 *     draws, and every aggregate is the exact SUM of those cells: the total equals the sum of the days,
 *     which equals the sum of the employees. Rounding once at the end instead would make a total that is
 *     not the sum of the numbers printed beside it, which is the defect a user finds first and trusts
 *     least. Rounding per BUCKET instead would round four times per cell for no gain.
 *
 * ## An employee with no wage on file is UNPRICED, never zero
 *
 * All nineteen seeded employees have `basic_wage_fils` null, because a wage is a fact about a person and
 * the build does not invent one (brief rule 15). An unpriced employee contributes nothing to a sum, so a
 * forecast that treated null as zero would report a rota of nineteen unpriced therapists as costing
 * **0 fils** — a free rota, and nothing about the figure would look wrong. So they are counted and named:
 * {@link LabourCostForecast.unpricedEmployeeIds}, `rota_version.forecast_unpriced_employees`, and a line
 * on the rota screen beside the total. The total is the cost of the priced ones and says so.
 *
 * Pure: integers in, integers out, no clock and no I/O.
 */

/**
 * The scale of the basis-point representation, not a rate.
 *
 * 10,000 basis points is one unit. It appears once, in the denominator, and it is here as a named
 * constant so that the thing it is cannot be mistaken: every multiplier in the sum has already been
 * applied by `splitWorkedMinutes` and read from `working_hours_rule`.
 */
const BASIS_POINTS_PER_UNIT = 10_000

/** One version of `labour_cost_rule`: how a monthly wage becomes a rate per worked minute. */
export interface LabourCostRules {
  readonly effectiveFrom: LocalDate
  /** Calendar days a monthly wage is taken to cover. 30 in version 1, a convention and not a decision. */
  readonly monthlyWageDaysDivisor: number
  /**
   * Minutes a daily wage is taken to cover — the DENOMINATOR.
   *
   * Deliberately not `working_hours_rule.ordinary_minutes_per_day`, although version 1 carries the same
   * 480: that figure is the point a minute becomes overtime-eligible, a CAP, and reading a cap as a
   * denominator means raising the daily cap to nine hours quietly makes every hour cheaper.
   */
  readonly paidMinutesPerDay: number
}

/** One employee's monthly basic wage, or the absence of one. */
export interface EmployeeWage {
  readonly employeeId: string
  /** `employee.basic_wage_fils`, a MONTHLY figure. Null when none is on file, which is not zero. */
  readonly basicWageFils: number | null
}

/** One cell of the forecast: one employee on one trading date. Where the single rounding happens. */
export interface LabourCostLine {
  readonly employeeId: string
  readonly tradingDate: LocalDate
  readonly totalMinutes: number
  readonly weightedMinuteBp: number
  /** Integer fils, rounded up. Null when the employee has no wage on file. */
  readonly fils: number | null
  /** The rule version that priced it, so a reproduced forecast can be checked against the same divisor. */
  readonly ruleEffectiveFrom: LocalDate
}

export interface LabourCostForecast {
  /** One per (employee, trading date) with rostered minutes, ordered by employee then date. */
  readonly lines: readonly LabourCostLine[]
  /** The exact sum of every priced line. Never an approximation of one. */
  readonly totalFils: number
  /** Total rostered minutes, priced and unpriced alike — the figure that is knowable for everybody. */
  readonly totalMinutes: number
  /** Employees with rostered minutes and no wage on file, sorted. Empty is the only silent case. */
  readonly unpricedEmployeeIds: readonly string[]
  /** Employees whose cost is in `totalFils`, sorted. Named so a screen can say "of 19". */
  readonly pricedEmployeeIds: readonly string[]
}

/**
 * The version of the cost rules governing a trading date: the latest one effective at or before it.
 *
 * A near-copy of `rulesFor` and `rotaCoverageRulesFor` rather than a shared generic, for the reason
 * `rotaCoverageRulesFor` states: the three tables answer different questions and the message naming the
 * right one is half the value of the throw.
 */
export function labourCostRulesFor(
  versions: readonly LabourCostRules[],
  tradingDate: LocalDate,
): LabourCostRules {
  let governing: LabourCostRules | undefined
  for (const version of versions) {
    if (version.effectiveFrom > tradingDate) continue
    if (governing === undefined || version.effectiveFrom > governing.effectiveFrom) {
      governing = version
    }
  }
  if (governing === undefined) {
    throw new AppError(
      'invariant_violated',
      `No labour-cost rule version is effective on or before the trading date ${tradingDate}, so what an ` +
        'hour of a monthly wage is worth is unknown. 0081 seeds a version from a sentinel date before any ' +
        'trading this business could have done; an empty answer means the row is gone. A default divisor ' +
        'here would be a forecast that invented its own idea of what an hour costs.',
    )
  }
  assertLabourCostRules(governing)
  return governing
}

/** A zero or fractional divisor is a division by zero or a fils that is not an integer. */
export function assertLabourCostRules(rules: LabourCostRules): void {
  if (!Number.isInteger(rules.monthlyWageDaysDivisor) || rules.monthlyWageDaysDivisor < 1) {
    throw new AppError(
      'validation',
      `A monthly wage covers a whole number of days, at least one; got ${rules.monthlyWageDaysDivisor}. ` +
        "0081's CHECK refuses the row, so a value arriving here is a hand-built rule set.",
    )
  }
  if (!Number.isInteger(rules.paidMinutesPerDay) || rules.paidMinutesPerDay < 1) {
    throw new AppError(
      'validation',
      `A paid day is a whole number of minutes, at least one; got ${rules.paidMinutesPerDay}.`,
    )
  }
}

/**
 * The fils one line costs: the single division, rounded up, with the numerator checked to be exact.
 *
 * `Number.isSafeInteger` on the product rather than a comment promising it cannot overflow. The realistic
 * numbers are far below the limit — a 5,000 AED monthly wage against a 12-hour public-holiday day is about
 * 5.4 × 10^13 against a ceiling of 9.0 × 10^15 — but a forecast over a YEAR of a hand-built rota is the
 * shape that gets there, and beyond it the arithmetic silently stops being integer. That is the ADR 0007
 * failure exactly: not a wrong answer, a plausible one.
 */
function lineFils(args: {
  readonly basicWageFils: number
  readonly weightedMinuteBp: number
  readonly rules: LabourCostRules
}): number {
  const { basicWageFils, weightedMinuteBp, rules } = args
  if (!Number.isInteger(basicWageFils) || basicWageFils < 0) {
    throw new AppError(
      'validation',
      `A basic wage is a whole non-negative number of fils; got ${basicWageFils}. ADR 0007: money is ` +
        'integer fils and never a float, and a fractional wage here would put a fraction in the forecast.',
    )
  }
  const numerator = basicWageFils * weightedMinuteBp
  if (!Number.isSafeInteger(numerator)) {
    throw new AppError(
      'invariant_violated',
      `Pricing ${weightedMinuteBp} basis-point-minutes against a wage of ${basicWageFils} fils exceeds ` +
        'exact integer arithmetic. Beyond this point the product is a float that looks like a whole ' +
        'number, which is ADR 0007 failing quietly rather than loudly. Forecast a shorter period.',
    )
  }
  const denominator = rules.monthlyWageDaysDivisor * rules.paidMinutesPerDay * BASIS_POINTS_PER_UNIT
  // Integer ceiling. `Math.ceil(a / b)` would do the division in floating point first, which for a
  // numerator above 2^53 and for quotients that land a hair above an integer gives one fil too many —
  // the drift the property test's control is built to catch.
  return Math.floor((numerator + denominator - 1) / denominator)
}

/**
 * The forecast for a rota, from P-HR-05's per-day bucket totals.
 *
 * Takes `TradingDayHours[]` — `summariseWorkedHours(...).days` — rather than the shifts, so there is
 * exactly one reading of how long a 18:00–02:00 shift is and which bucket each of its minutes falls in.
 * A forecast that re-split the shifts would be that second reading, and it would disagree with payroll
 * about the night window on the one day it mattered.
 *
 * Every employee with rostered minutes must appear in `wages`. An absent employee is a caller mistake —
 * the read returns a row per assigned employee — and treating absence as "unpriced" would make a forgotten
 * join look like an unrecorded wage, which is the one thing the unpriced count exists to distinguish.
 */
export function forecastLabourCost(args: {
  readonly days: readonly TradingDayHours[]
  readonly wages: readonly EmployeeWage[]
  readonly ruleVersions: readonly LabourCostRules[]
}): LabourCostForecast {
  const { days, wages, ruleVersions } = args
  const wageById = new Map(wages.map((wage) => [wage.employeeId, wage.basicWageFils]))
  if (wageById.size !== wages.length) {
    throw new AppError(
      'validation',
      'The same employee appears twice in the wage list. Two wages for one person would price the same ' +
        'roster differently depending on which row was read second.',
    )
  }

  const lines: LabourCostLine[] = []
  const unpriced = new Set<string>()
  const priced = new Set<string>()
  let totalFils = 0
  let totalMinutes = 0

  const ordered = [...days].sort(
    (a, b) =>
      (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0) ||
      (a.tradingDate < b.tradingDate ? -1 : a.tradingDate > b.tradingDate ? 1 : 0),
  )
  for (const day of ordered) {
    if (!wageById.has(day.employeeId)) {
      throw new AppError(
        'validation',
        `Employee ${day.employeeId} is rostered on ${day.tradingDate} and does not appear in the wage ` +
          'list. Absence is a caller mistake, not an unrecorded wage: treating it as unpriced would make ' +
          'a forgotten join indistinguishable from a wage nobody has entered.',
      )
    }
    const rules = labourCostRulesFor(ruleVersions, day.tradingDate)
    const basicWageFils = wageById.get(day.employeeId) ?? null
    totalMinutes += day.totalMinutes
    if (basicWageFils === null) {
      unpriced.add(day.employeeId)
      lines.push({
        employeeId: day.employeeId,
        tradingDate: day.tradingDate,
        totalMinutes: day.totalMinutes,
        weightedMinuteBp: day.weightedMinuteBp,
        fils: null,
        ruleEffectiveFrom: rules.effectiveFrom,
      })
      continue
    }
    const fils = lineFils({ basicWageFils, weightedMinuteBp: day.weightedMinuteBp, rules })
    priced.add(day.employeeId)
    totalFils += fils
    lines.push({
      employeeId: day.employeeId,
      tradingDate: day.tradingDate,
      totalMinutes: day.totalMinutes,
      weightedMinuteBp: day.weightedMinuteBp,
      fils,
      ruleEffectiveFrom: rules.effectiveFrom,
    })
  }

  return {
    lines,
    totalFils,
    totalMinutes,
    unpricedEmployeeIds: [...unpriced].sort(),
    pricedEmployeeIds: [...priced].sort(),
  }
}
