import { AppError } from '@berelax/shared'
import { monthStart } from '../hr/leave-accrual.ts'
import { addMonths, monthsBetween } from '../money/recurring-schedule.ts'
import type { LocalDate } from '../time.ts'
import type { ContributionMarginUnit } from './contribution-margin.ts'
import type {
  FirstTouchPaidState,
  KpiCohortContribution,
  KpiCohortMember,
  KpiCohortMonth,
  KpiSpec,
  Measure,
} from './kpi-expression.ts'
import { kpiRef, measureRef, quotientOf } from './kpi-expression.ts'

/**
 * Retention cohorts by first-visit business month, and the REALISED value of one (R-REP-05).
 *
 * # The decision this module exists to enforce
 *
 * The acceptance line is "LTV is cumulative realised net contribution per cohort", and the word that
 * carries the risk is **realised**. A lifetime value is, by its name, a figure about a future; a cohort
 * this business has held for six weeks has six weeks of history; and the arithmetic that turns the
 * second into the first is one line long. Whatever that line is — a retention curve, a decay rate, an
 * annualisation, an average revisit interval extended out — it produces a number somebody will plan
 * against, and nothing about the number says which part of it was observed.
 *
 * So there is no such line here, and the absence is structural rather than disciplined:
 *
 *   1. **A cohort figure is reported AT A STATED HORIZON.** {@link cohortRealisedWindow} is the only
 *      thing that builds the `cohortMonths` rows every cohort measure restricts itself to, and it
 *      REFUSES a horizon longer than the cohort's own fully-elapsed history ({@link CohortHorizonNotReached}).
 *      There is no horizon argument in `kpi-expression.ts` at all — the window IS the rows — so a KPI
 *      cannot be asked for a month the cohort has not lived.
 *   2. **A month the cohort lived but spent nothing in still has a row.** Otherwise the monthly average
 *      divides by the months that happened to produce revenue, which is the same defect as a figure
 *      divided by "days in the period" counting only the days the salon took money (migration 0011).
 *   3. **The figure is never called a lifetime value.** `cohort_realised_value_per_customer` is what the
 *      registry publishes, its formula names the horizon's own measure, and {@link comparableHorizon}
 *      exists so that a caller comparing cohorts compares them at a horizon all of them reach — the
 *      planning error this record is about is reading a twelve-month cohort's figure and a one-month
 *      cohort's figure off the same column.
 *   4. **No forecasting code may be reachable from the path.** That is an arch rule rather than a type,
 *      because the construct that breaks it is a plausible helper rather than a wrong signature:
 *      `packages/fixtures/src/ltv-arch.ts` walks the import closure of this module and refuses a
 *      forecasting, regression, projection, decay or annualisation construct anywhere in it.
 *
 * # Why the contribution cannot be revenue
 *
 * A contribution is a net price less the costs attributable to delivering it, and ADR 0070 settled that
 * three of those four costs do not exist in this build. Substituting revenue would report the HIGHEST
 * possible lifetime value, which is exactly the zero-cost substitution that record refuses — one subject
 * along and with a larger consequence, because the figure is what an acquisition budget is set from.
 *
 * So {@link cohortContributionRow} takes R-REP-04's own {@link ContributionMarginUnit} values and
 * refuses a `not_attributable` one. A contribution row therefore cannot exist for a delivery whose cost
 * is unknown, the cohort measures read nothing else, and `cohorts.itest.ts` MEASURES that no delivery in
 * this build's database has an attributable cost rather than asserting it.
 *
 * # A cohort month is a `LocalDate`
 *
 * `YYYY-MM-01`, so it sorts and compares as a string and uses `addMonths` and `monthsBetween` — the
 * month arithmetic this build already has one implementation of, whose clamp mirrors PostgreSQL's
 * `date + interval '1 month'`. A `YearMonth` type would have been a second statement of that
 * arithmetic, and the `YYYY-MM` string that invites one has no month arithmetic at all.
 *
 * Nothing here reads a clock, performs I/O or consults the catalogue. Every figure is a `bigint` and
 * none is a `Fils`, for ADR 0064's measured reason.
 */

// --- the cohort grid ----------------------------------------------------------------------------

/**
 * One customer as the cohort grid takes them: who they are and when they first came in.
 *
 * `firstVisitBusinessDay` is `reporting.dim_customer.first_visit_business_day` — the trading date of the
 * earliest DELIVERED appointment, which migration 0110 defines once and this module reads rather than
 * recomputing. A customer with no delivered visit has no row: they are not in a cohort, and a
 * never-attended booking is not a retention of nought.
 */
export interface CohortMember {
  readonly customerId: string
  readonly firstVisitBusinessDay: LocalDate
  readonly firstTouch: FirstTouchPaidState
}

/** One trading month in which a customer had at least one DELIVERED appointment. */
export interface CohortActivity {
  readonly customerId: string
  /** The business month of the delivery, as `YYYY-MM-01`. */
  readonly activityMonth: LocalDate
}

/** One period of one cohort's retention row. */
export interface CohortPeriod {
  /** 0 is the acquisition month itself. */
  readonly monthIndex: number
  readonly month: LocalDate
  readonly activeCustomers: number
  /** `activeCustomers ÷ cohortSize`, in whole basis points, half-up. 10,000 is the whole cohort. */
  readonly retainedBasisPoints: number
}

/** One cohort: the customers whose first delivered visit fell in `cohortMonth`, and their periods. */
export interface RetentionCohort {
  readonly cohortMonth: LocalDate
  readonly cohortSize: number
  /** Every period from 0 to the horizon, with no gaps. */
  readonly periods: readonly CohortPeriod[]
  /** The customer ids in the cohort, sorted, so a figure can drill to its people. */
  readonly customerIds: readonly string[]
}

/** Raised when a cohort's period-0 count and its size disagree. See {@link buildRetentionCohorts}. */
export class CohortPeriodZeroDisagrees extends AppError {
  constructor(
    cohortMonth: string,
    cohortSize: number,
    activeInPeriodZero: number,
    absent: string[],
  ) {
    super(
      'invariant_violated',
      `The ${cohortMonth} cohort has ${cohortSize} member(s) and ${activeInPeriodZero} of them active ` +
        `in period 0. A member's cohort month IS the month of their first delivered visit, so every ` +
        'member is active in it by definition and a shortfall is a gap in the activity the caller ' +
        `supplied, not a retention of ${activeInPeriodZero}: [${absent.slice(0, 10).join(', ')}]. ` +
        'Reported as a refusal because a missing activity row makes period 0 look like churn in the ' +
        'acquisition month, which every later period is then measured against.',
      { details: { cohortMonth, cohortSize, activeInPeriodZero, absent } },
    )
    this.name = 'CohortPeriodZeroDisagrees'
  }
}

/** A share of a whole in whole basis points, half-up away from zero. 10,000 bp is the whole. */
const shareBp = (part: number, whole: number): number => {
  if (whole <= 0) return 0
  return Math.round((part * 10_000) / whole)
}

/**
 * The members collapsed so each customer appears exactly once, under the EARLIER cohort month.
 *
 * This is the acceptance line "a merged customer appears in exactly one cohort — the earlier one", and
 * it is here as well as in the query for a reason worth stating. `merge_record` keeps the merged-away
 * record as a TOMBSTONE rather than deleting it (migration 0069), and `booking.customer_id` is
 * re-pointed to the survivor (`repoint_update`, C-CRM-05) — so after a refresh
 * `reporting.dim_customer` holds the survivor with the earlier first visit and the tombstone with none.
 * But a materialised view is only as current as its last refresh (ADR 0060), and between the merge and
 * the next pass the view still holds two rows with two first visits.
 *
 * So the query resolves `merge_survivor_of` AND this collapses whatever arrives: two mechanisms for one
 * property, because the window in which the first one is wrong is exactly the window in which a merge
 * has just happened and somebody is looking at the screen to see whether it worked.
 *
 * `min` and not "the survivor's own": a merge does not say which record is older, only which survives,
 * and a customer's cohort is the month they first came in under either record.
 */
export function collapseCohortMembers(
  members: readonly CohortMember[],
): readonly (CohortMember & { readonly cohortMonth: LocalDate })[] {
  const byCustomer = new Map<string, CohortMember & { readonly cohortMonth: LocalDate }>()
  for (const member of members) {
    const cohortMonth = monthStart(member.firstVisitBusinessDay)
    const held = byCustomer.get(member.customerId)
    if (held === undefined) {
      byCustomer.set(member.customerId, { ...member, cohortMonth })
      continue
    }
    if (cohortMonth < held.cohortMonth) {
      // The earlier month wins, and so does its first-visit date and its first touch: a merge retains
      // the EARLIER first touch (A-FIRST-08's fourth acceptance line), so the two must move together or
      // a customer's cohort and their channel would come from two different records.
      byCustomer.set(member.customerId, { ...member, cohortMonth })
    }
  }
  return Object.freeze(
    [...byCustomer.values()].sort((left, right) =>
      left.customerId < right.customerId ? -1 : left.customerId > right.customerId ? 1 : 0,
    ),
  )
}

/**
 * The retention grid: one row per cohort month, one period per elapsed month up to `horizonMonths`.
 *
 * `horizonMonths` is the number of periods REPORTED, which is a presentation choice and is not the
 * horizon a VALUE may be computed at — that one is {@link cohortRealisedWindow}'s and is refused when it
 * exceeds what the cohort has lived. A grid showing a period the cohort has not finished is honest as
 * long as the period is labelled, which is why `monthIndex` and `month` are both on the row.
 *
 * Period 0's count is DERIVED from the activity like every other period and then held equal to the
 * cohort size, rather than being set to the size. Setting it would make the acceptance line true by
 * construction and unable to notice the thing it is for: an activity set that is missing the
 * acquisition month makes period 0 read as churn, and every later period is then measured against a
 * base that is too small. {@link CohortPeriodZeroDisagrees} names the customers.
 */
export function buildRetentionCohorts(input: {
  readonly members: readonly CohortMember[]
  readonly activity: readonly CohortActivity[]
  readonly horizonMonths: number
}): readonly RetentionCohort[] {
  if (!Number.isInteger(input.horizonMonths) || input.horizonMonths < 1) {
    throw new AppError(
      'validation',
      `A retention grid needs at least one period, received ${input.horizonMonths}. Period 0 is the ` +
        'acquisition month and is the period the cohort size is proved against.',
      { details: { horizonMonths: input.horizonMonths } },
    )
  }

  const members = collapseCohortMembers(input.members)
  const activeMonths = new Map<string, Set<string>>()
  for (const row of input.activity) {
    const months = activeMonths.get(row.customerId) ?? new Set<string>()
    months.add(monthStart(row.activityMonth))
    activeMonths.set(row.customerId, months)
  }

  const byCohort = new Map<string, (CohortMember & { readonly cohortMonth: LocalDate })[]>()
  for (const member of members) {
    const held = byCohort.get(member.cohortMonth) ?? []
    held.push(member)
    byCohort.set(member.cohortMonth, held)
  }

  const cohorts: RetentionCohort[] = []
  for (const cohortMonth of [...byCohort.keys()].sort()) {
    const inCohort = byCohort.get(cohortMonth) ?? []
    const cohortSize = inCohort.length
    const periods: CohortPeriod[] = []
    for (let monthIndex = 0; monthIndex < input.horizonMonths; monthIndex += 1) {
      const month = addMonths(cohortMonth as LocalDate, monthIndex)
      const active = inCohort.filter((member) => activeMonths.get(member.customerId)?.has(month))
      if (monthIndex === 0 && active.length !== cohortSize) {
        throw new CohortPeriodZeroDisagrees(
          cohortMonth,
          cohortSize,
          active.length,
          inCohort
            .filter((member) => !activeMonths.get(member.customerId)?.has(month))
            .map((member) => member.customerId),
        )
      }
      periods.push({
        monthIndex,
        month,
        activeCustomers: active.length,
        retainedBasisPoints: shareBp(active.length, cohortSize),
      })
    }
    cohorts.push(
      Object.freeze({
        cohortMonth: cohortMonth as LocalDate,
        cohortSize,
        periods: Object.freeze(periods),
        customerIds: Object.freeze(inCohort.map((member) => member.customerId)),
      }),
    )
  }
  return Object.freeze(cohorts)
}

// --- the realised window, which is the whole of "never forecast" --------------------------------

/** Raised when a value is asked for at a horizon the cohort has not lived. See the module header. */
export class CohortHorizonNotReached extends AppError {
  constructor(cohortMonth: string, horizonMonths: number, realisedMonths: number) {
    super(
      'validation',
      `The ${cohortMonth} cohort has ${realisedMonths} fully elapsed month(s) of history and a value ` +
        `was asked for at ${horizonMonths}. A figure over a month that has not finished is part ` +
        'observation and part extrapolation, and nothing about the number says which part is which — ' +
        'so it is refused rather than reported with a caveat. Ask for a horizon the cohort has reached, ' +
        'or compare cohorts at comparableHorizon().',
      { details: { cohortMonth, horizonMonths, realisedMonths } },
    )
    this.name = 'CohortHorizonNotReached'
  }
}

/**
 * How many whole months of history a cohort has, as at the last month that has fully elapsed.
 *
 * `throughMonth` is the last COMPLETE business month, which the caller supplies from the trading
 * calendar rather than from a clock: this module reads no instant, for ADR 0060's reason — a trading
 * date comes from `business_day` and is never derived from one.
 *
 * The acquisition month counts, so a cohort acquired in the month that has just closed has one realised
 * month. A cohort acquired in a month that has not closed has NONE, which is the answer that stops a
 * three-week-old cohort appearing in a comparison with a figure of any kind.
 */
export function realisedMonthsOf(cohortMonth: LocalDate, throughMonth: LocalDate): number {
  const elapsed = monthsBetween(monthStart(cohortMonth), monthStart(throughMonth)) + 1
  return elapsed < 0 ? 0 : elapsed
}

/**
 * The longest horizon every cohort in the set has lived, so a comparison is between like figures.
 *
 * This is the planning error the whole record is about, made into one function: a column headed "LTV"
 * holding a twelve-month cohort beside a one-month cohort is not a comparison, and the youngest cohort
 * is always the one whose figure looks worst. `0` means the youngest cohort has no realised month, and a
 * caller that gets it has nothing to compare rather than a small number.
 */
export function comparableHorizon(
  cohortMonths: readonly LocalDate[],
  throughMonth: LocalDate,
): number {
  if (cohortMonths.length === 0) return 0
  return cohortMonths.reduce(
    (least, month) => Math.min(least, realisedMonthsOf(month, throughMonth)),
    Number.POSITIVE_INFINITY,
  )
}

/**
 * The `cohortMonths` rows for one cohort at one horizon — the dataset every cohort measure divides by.
 *
 * The one place a horizon is turned into data, and the one place it is refused. Every month from 0 to
 * `horizonMonths - 1` gets a row whether or not the cohort spent anything in it, for the reason the
 * header gives.
 */
export function cohortRealisedWindow(args: {
  readonly cohortMonth: LocalDate
  readonly horizonMonths: number
  readonly throughMonth: LocalDate
}): readonly KpiCohortMonth[] {
  const realised = realisedMonthsOf(args.cohortMonth, args.throughMonth)
  if (!Number.isInteger(args.horizonMonths) || args.horizonMonths < 1) {
    throw new AppError(
      'validation',
      `A realised window needs at least one month, received ${args.horizonMonths}. A cohort's value at ` +
        'a horizon of zero months is not zero — it is a figure nobody has observed yet.',
      { details: { horizonMonths: args.horizonMonths } },
    )
  }
  if (args.horizonMonths > realised) {
    throw new CohortHorizonNotReached(args.cohortMonth, args.horizonMonths, realised)
  }
  const months: KpiCohortMonth[] = []
  for (let monthIndex = 0; monthIndex < args.horizonMonths; monthIndex += 1) {
    months.push({ cohortMonth: monthStart(args.cohortMonth), monthIndex })
  }
  return Object.freeze(months)
}

// --- a contribution row, which cannot exist for an unattributable cost --------------------------

/** Raised when a cohort contribution is asked for over a delivery whose cost nothing can attribute. */
export class CohortContributionNotAttributable extends AppError {
  constructor(customerId: string, missing: readonly string[], openQuestionIds: readonly string[]) {
    super(
      'invariant_violated',
      `Customer ${customerId}'s contribution cannot be stated: the component(s) ` +
        `[${missing.join(', ')}] are unattributable (${openQuestionIds.join(', ')}). A cohort value ` +
        'built from net revenue instead would report the HIGHEST possible lifetime value, on the figure ' +
        'an acquisition budget is set from — ADR 0070 refused the same substitution one grain down, ' +
        'where the consequence was only a service ranking.',
      { details: { customerId, missing: [...missing], openQuestionIds: [...openQuestionIds] } },
    )
    this.name = 'CohortContributionNotAttributable'
  }
}

/**
 * One customer-month's realised contribution, from the margins of the deliveries that produced it.
 *
 * It takes R-REP-04's {@link ContributionMarginUnit} values rather than a figure, which is what makes
 * the refusal structural: the only way to state a contribution here is to hand over margins that were
 * computed, and a margin whose cost list held an unattributable component is a `not_attributable` value
 * that this function refuses. There is no parameter a net price could arrive through.
 *
 * An empty `units` list is refused rather than reported as a contribution of zero. A customer-month
 * with no delivery has no row at all — the month is still in the window, so the monthly average still
 * divides by it — and a zero row would be a delivery that earned nothing, which is a different claim.
 */
export function cohortContributionRow(args: {
  readonly cohortMonth: LocalDate
  readonly monthIndex: number
  readonly customerId: string
  readonly units: readonly ContributionMarginUnit[]
}): KpiCohortContribution {
  if (args.units.length === 0) {
    throw new AppError(
      'validation',
      `Customer ${args.customerId} has no delivery in month ${args.monthIndex} of their cohort, so ` +
        'there is no contribution row to build. The month is in the window either way, which is what ' +
        'keeps it in the denominator; a row of zero would be a delivery that earned nothing.',
      { details: { customerId: args.customerId, monthIndex: args.monthIndex } },
    )
  }
  if (!Number.isInteger(args.monthIndex) || args.monthIndex < 0) {
    throw new AppError(
      'validation',
      `A cohort month index must be a whole number of months since the acquisition month, received ` +
        `${args.monthIndex}.`,
      { details: { monthIndex: args.monthIndex } },
    )
  }
  let netContributionFils = 0n
  const missing = new Set<string>()
  const openQuestionIds = new Set<string>()
  for (const unit of args.units) {
    if (unit.state === 'margin') {
      netContributionFils += unit.marginFils
      continue
    }
    for (const component of unit.missing) missing.add(component)
    for (const id of unit.openQuestionIds) openQuestionIds.add(id)
  }
  if (missing.size > 0) {
    throw new CohortContributionNotAttributable(
      args.customerId,
      [...missing].sort(),
      [...openQuestionIds].sort(),
    )
  }
  return Object.freeze({
    cohortMonth: monthStart(args.cohortMonth),
    monthIndex: args.monthIndex,
    customerId: args.customerId,
    netContributionFils,
  })
}

// --- the measures -------------------------------------------------------------------------------

/** The `(cohortMonth, monthIndex)` pairs the window holds, as the key every restriction uses. */
const windowKeys = (months: readonly KpiCohortMonth[]): ReadonlySet<string> => {
  const keys = new Set<string>()
  for (const month of months) keys.add(`${month.cohortMonth}#${month.monthIndex}`)
  return keys
}

/** The cohort months the window covers. Separate from {@link windowKeys}: spend is month-0 only. */
const windowCohorts = (months: readonly KpiCohortMonth[]): ReadonlySet<string> => {
  const cohorts = new Set<string>()
  for (const month of months) cohorts.add(month.cohortMonth)
  return cohorts
}

/** Distinct customers in the window's cohorts whose first touch is in `states`. */
const countMembers = (
  members: readonly KpiCohortMember[],
  cohorts: ReadonlySet<string>,
  states: readonly FirstTouchPaidState[] | null,
): bigint => {
  const seen = new Set<string>()
  for (const member of members) {
    if (!cohorts.has(member.cohortMonth)) continue
    if (states !== null && !states.includes(member.firstTouch)) continue
    seen.add(member.customerId)
  }
  return BigInt(seen.size)
}

export const COHORT_CUSTOMERS: Measure = {
  id: 'cohort_customers',
  summary:
    'How many customers are in the cohorts the window covers: one per customer whose first DELIVERED ' +
    'visit fell in a cohort month of the window. Counted DISTINCT, so a merged customer who still has ' +
    'a tombstone row in a stale dim_customer is one person and not two.',
  unit: 'customers',
  reads: ['cohortMonths.cohortMonth', 'cohortMembers.cohortMonth', 'cohortMembers.customerId'],
  reduce: (input) => countMembers(input.cohortMembers, windowCohorts(input.cohortMonths), null),
}

export const COHORT_REALISED_MONTHS: Measure = {
  id: 'cohort_realised_months',
  summary:
    'How many fully elapsed months the window covers — the horizon, as data. Every month in the ' +
    'window has a row whether or not the cohort spent anything in it, which is what stops a monthly ' +
    'average dividing by the months that happened to produce revenue.',
  unit: 'months',
  reads: ['cohortMonths.monthIndex'],
  reduce: (input) => {
    const indices = new Set<number>()
    for (const month of input.cohortMonths) indices.add(month.monthIndex)
    return BigInt(indices.size)
  },
}

export const COHORT_REALISED_NET_CONTRIBUTION_FILS: Measure = {
  id: 'cohort_realised_net_contribution_fils',
  summary:
    'The cumulative realised net contribution of the cohorts in the window, in fils: every delivery ' +
    "whose cost was attributable, summed over the window's months. A delivery whose cost is " +
    'unattributable has no row here at all (ADR 0070), so the figure is never a revenue total wearing ' +
    'the word contribution.',
  unit: 'fils',
  reads: [
    'cohortMonths.cohortMonth',
    'cohortMonths.monthIndex',
    'cohortContributions.cohortMonth',
    'cohortContributions.monthIndex',
    'cohortContributions.netContributionFils',
  ],
  reduce: (input) => {
    const keys = windowKeys(input.cohortMonths)
    let total = 0n
    for (const row of input.cohortContributions) {
      // The restriction is on the window and not on the cohort, which is the whole point: a
      // contribution row for a month past the horizon is dropped rather than quietly extending it.
      if (!keys.has(`${row.cohortMonth}#${row.monthIndex}`)) continue
      total += row.netContributionFils
    }
    return total
  },
}

export const COHORT_MEASURES: readonly Measure[] = Object.freeze([
  COHORT_CUSTOMERS,
  COHORT_REALISED_MONTHS,
  COHORT_REALISED_NET_CONTRIBUTION_FILS,
])

/** Exported so `cac.ts` can count members without a second statement of the restriction. */
export const cohortMemberCount = countMembers
export const cohortWindowCohorts = windowCohorts

// --- the KPIs -----------------------------------------------------------------------------------

/**
 * The realised value of a customer in a cohort, at the window's horizon.
 *
 * **Deliberately not called a lifetime value, and the label says the horizon.** The figure is the
 * cohort's observed contribution divided by its size; what it is not is a prediction of what the cohort
 * will eventually be worth, and the two differ by an unknown amount that grows the younger the cohort
 * is. `comparableHorizon` is how a caller gets a set of these that can be read in one column.
 */
export const COHORT_REALISED_VALUE_PER_CUSTOMER: KpiSpec = {
  id: 'cohort_realised_value_per_customer',
  label: 'Realised value per customer, at the stated horizon',
  summary:
    'The net contribution a cohort has actually produced, per customer, over the months it has lived. ' +
    'It is NOT a lifetime value: it is an observation at a horizon, it rises as the cohort ages, and ' +
    'two cohorts are comparable only at a horizon both have reached (comparableHorizon). No ' +
    'extrapolation, decay or retention curve participates in it, which an arch rule over this ' +
    "module's whole import closure refuses.",
  unit: 'fils_per_customer',
  expression: quotientOf(
    measureRef(COHORT_REALISED_NET_CONTRIBUTION_FILS.id),
    measureRef(COHORT_CUSTOMERS.id),
  ),
  provisional: null,
}

/**
 * The monthly run rate the payback divides by, which is why it is a KPI rather than a measure.
 *
 * `realised value ÷ realised months` and not "the latest month's contribution": a cohort's spend is
 * lumpy — a package bought in month 0 is released over six — and a payback computed from one month
 * would swing with whichever month was last. Averaging over the whole realised window is the only
 * version of this figure that does not move for a reason that has nothing to do with the cohort.
 */
export const COHORT_MONTHLY_CONTRIBUTION_PER_CUSTOMER: KpiSpec = {
  id: 'cohort_monthly_contribution_per_customer',
  label: 'Monthly net contribution per customer',
  summary:
    "The cohort's realised value per customer spread over the months it has lived. The average over " +
    'the whole realised window and never the latest month, because a package bought in month 0 is ' +
    'released over the months that follow and a one-month reading would swing with which month was ' +
    'last.',
  unit: 'fils_per_customer_month',
  expression: quotientOf(
    kpiRef(COHORT_REALISED_VALUE_PER_CUSTOMER.id),
    measureRef(COHORT_REALISED_MONTHS.id),
  ),
  provisional: null,
}

export const COHORT_KPIS: readonly KpiSpec[] = Object.freeze([
  COHORT_REALISED_VALUE_PER_CUSTOMER,
  COHORT_MONTHLY_CONTRIBUTION_PER_CUSTOMER,
])
