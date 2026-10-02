import { AppError } from '@berelax/shared'
import type { AccountCode } from '../ledger/account.ts'
import type { LocalDate } from '../time.ts'

/**
 * The language a KPI is written in, and the arithmetic it is evaluated with (R-REP-03).
 *
 * # Why a KPI is an EXPRESSION and not a function with a formula beside it
 *
 * The acceptance line asks for "named pure KPI functions each carrying its formula as a documented
 * string". Written the obvious way that is two statements of one fact — a `formula` field somebody typed
 * and a body somebody wrote — and the brief's rule about a second statement applies to it exactly: it
 * drifts, and the drift is invisible, because a wrong formula string is still a string and the figure it
 * describes is still a figure. Nothing fails.
 *
 * So the formula is **derived**. A KPI declares one {@link KpiExpr}; {@link renderExpr} turns that tree
 * into the string and {@link evaluateExpr} turns it into the number. There is no second place to be
 * wrong, no check needed to hold two things equal, and a change to the arithmetic changes the published
 * formula in the same edit. {@link expandExpr} substitutes every KPI reference with its own expression
 * first, so a consumer can read a headline figure all the way down to the measures without following
 * references by hand.
 *
 * What is left over is the one place a second statement is unavoidable: a {@link Measure} is a reducer
 * over the input rows and cannot be an expression, because the aggregation is a fold and not an
 * arithmetic combination. Each one therefore DECLARES which dataset fields it reads
 * ({@link Measure.reads}), and {@link recordedReads} replays it against a recording copy of the input so
 * the declaration can be held equal to the access. That is what makes "the hours denominator reads
 * `dim_date.open_minutes`" a machine-checked claim rather than a comment: a measure that computed 15
 * hours from anything else stops touching `businessDays.openMinutes`, and the rule fires by name.
 *
 * # Why every figure is an exact rational of `bigint`s
 *
 * Utilisation is a ratio, RevPARH is fils per room-hour, and available room hours is minutes over 60.
 * None of the three is an integer and all three are divided, so a `number` would put a float in the
 * middle of a figure whose acceptance line says "to the fils". ADR 0064 already records what a `number`
 * did to a cumulative ledger position — a ledger holding 2^53 + 1 fils on each side reported a
 * difference of -4 fils out of nothing — and the same argument reaches a revenue numerator.
 *
 * So a figure is a {@link Rational}: two `bigint`s, reduced, denominator always positive, and division is
 * exact. Rounding happens once, at the edge, in {@link scaledFigure}, with a stated rule. The structural
 * consequence is the one the acceptance line asks for: a zero divisor cannot produce `NaN`, `Infinity`
 * or a silent `0`, because `bigint` division by zero throws rather than returning any of them — and
 * {@link evaluateExpr} never gets that far, reporting {@link NoDenominator} instead and naming the
 * divisor that was zero.
 *
 * # What this module does NOT know
 *
 * It holds no measure, no KPI and no registry. `utilisation.ts` and `revpar.ts` declare those, and
 * `kpi-registry.ts` assembles them — in that direction only, because `pnpm boundaries` refuses a cycle
 * and a registry that imported its own entries' types from the module that imports it would be one.
 */

// --- the input, which IS the period --------------------------------------------------------------

/**
 * One trading day in scope, as `reporting.dim_date` gives it.
 *
 * `openMinutes` is `dim_date.open_minutes`, which migration 0110 derives from
 * `business_day.duration_seconds`, which 0011 GENERATES from the day's own instants. It is read and
 * never recomputed: 0110's own header states that every hours denominator in R-REP-03 through R-REP-06
 * reads `premises_hours` and its dated overrides transitively through this column, so a Ramadan schedule
 * is a row in `premises_hours_override` plus a regeneration of `business_day` and no code change
 * anywhere. A KPI that multiplied 15 by 60 would be correct today, wrong the first time the premises
 * changed its hours, and wrong silently.
 */
export interface KpiBusinessDay {
  readonly businessDay: LocalDate
  /** `dim_date.open_minutes`. Minutes, integral by construction (0110 divides the seconds). */
  readonly openMinutes: number
}

/**
 * One (room, trading day) the room was in service for.
 *
 * The cross of the rooms with the days is the CALLER's, deliberately, and it is the one input here that
 * cannot be taken from a fact table as it stands: `rooms.is_bookable` (0012) is current state with no
 * history, so "which rooms were in service in March" is not a question the schema can answer. That is a
 * property of the data rather than of this arithmetic, and it is recorded as a deferral to R-REP-04,
 * which owns the queries that fill this input.
 */
export interface KpiRoomDay {
  readonly businessDay: LocalDate
  readonly roomId: string
}

/**
 * A closure of one room on one trading day, as minutes after that day's opening instant.
 *
 * **Offsets and not instants, and that is the whole point.** ADR 0060's rule is that a trading date is
 * taken from `business_day` and never derived from an instant — trading runs 11:00-02:00, so 01:30
 * belongs to the previous trading date and anything that re-derived it would disagree with the calendar
 * for the nine hours either side of midnight. The cheapest way to make that impossible rather than
 * merely true is to hand this module no instant at all: rebasing `resource_block.period` against
 * `dim_date.opens_at` is one expression in the caller's SQL, and once it has happened there is nothing
 * here a date could be derived from.
 *
 * Either bound may fall outside `[0, openMinutes)` — a maintenance block booked before opening or past
 * closing is ordinary — so both are clipped. See {@link KpiRoomClosure} usage in `utilisation.ts`.
 */
export interface KpiRoomClosure {
  readonly businessDay: LocalDate
  readonly roomId: string
  /** Minutes after the day's opening instant; may be negative for a block that starts before opening. */
  readonly fromMinuteAfterOpen: number
  /** Minutes after the day's opening instant; may exceed `openMinutes` for one that runs past closing. */
  readonly toMinuteAfterOpen: number
}

/**
 * One appointment, as `reporting.fact_appointment` gives it.
 *
 * `businessDay` is `appointment.trading_date`, foreign-keyed to `business_day` and resolved per
 * appointment across midnight, so a 01:30 treatment arrives here already filed under the previous
 * trading date. There is no instant on this row for the reason {@link KpiRoomClosure} gives.
 *
 * `turnaroundMinutes` and `treatmentMinutes` are separate because the acceptance line turns on the
 * difference: the room is occupied for both, the therapist for the treatment alone.
 */
export interface KpiAppointment {
  readonly businessDay: LocalDate
  /** `null` for an appointment holding no room, which occupies no room-minute. */
  readonly roomId: string | null
  /** `null` for an unassigned appointment, which occupies no therapist-minute. */
  readonly employeeId: string | null
  /** `fact_appointment.is_delivered`: `status = 'completed'`. */
  readonly isDelivered: boolean
  readonly treatmentMinutes: number
  readonly turnaroundMinutes: number
}

/**
 * One shift assignment, as `reporting.fact_shift` gives it — one row per employee per shift.
 *
 * 0110's header states the grain and why: the measure is "this person was rostered for these minutes",
 * which is the denominator of therapist utilisation. A shift with nobody on it has no row.
 */
export interface KpiRosteredShift {
  readonly businessDay: LocalDate
  readonly employeeId: string
  readonly rosteredMinutes: number
}

/**
 * One revenue posting, keyed on the trading day of the supply and on the account it landed in.
 *
 * **Why the account code and not an invoice line.** `invoice_line` (0026) carries a description snapshot,
 * a quantity and three money columns and NO revenue kind at all, so "treatment revenue, excluding
 * retail" is not a question an invoice can answer. The distinction exists exactly once in this build, in
 * the chart of accounts: `4010` treatment, `4020` package redemption, `4030` retail. And a tip is not
 * revenue in any account — 0068 records that "a tip is not consideration for a supply, so it appears on
 * no tax invoice", and it posts to the `2040` tips-payable LIABILITY — which is why "tips excluded" is
 * structural here rather than a filter: `revpar.ts` partitions the chart's REVENUE accounts, and `2040`
 * is not one of them.
 */
export interface KpiRevenueLine {
  readonly businessDay: LocalDate
  readonly accountCode: AccountCode
  /** Net of VAT, in fils. Negative for a credit note, which `fact_sale` already signs (0110). */
  readonly netFils: bigint
}

/**
 * One customer whose first DELIVERED visit fell in `cohortMonth` (R-REP-05).
 *
 * `cohortMonth` is the first day of a business month, `YYYY-MM-01`, and it is derived from
 * `reporting.dim_customer.first_visit_business_day` — which migration 0110 defines as "the earliest
 * trading date of an appointment that was DELIVERED. Not booked, not paid — delivered, because a cohort
 * of people who booked and never came is a different cohort", and which this module therefore reads
 * rather than recomputing.
 *
 * **`firstTouch` is a RESOLVED state and not an acquisition label, and that is the whole of why CAC
 * refuses against this build's data.** Whether a customer's first touch was PAID is a fact about the
 * touch — a medium, a campaign, a click — and A-FIRST-08 owns the attribution row that will carry it.
 * The vocabulary that exists (`customer_acquisition_source`, migration 0053: `walk_in`, `whatsapp`,
 * `phone`, `web`, `referral`, `unknown`) records none of that: a `web` booking may have come from
 * organic search, from a link in a message or from an advertisement, and the row cannot tell the three
 * apart. So `cac.ts`'s `firstTouchPaidStateOf` classifies all six as `not_recorded`, the share of
 * customers in that state is published beside every CAC, and a row arriving as `paid` is one a later
 * attribution model produced rather than one this build inferred.
 */
export interface KpiCohortMember {
  readonly customerId: string
  /** `YYYY-MM-01`: the first day of the business month of the first delivered visit. */
  readonly cohortMonth: LocalDate
  /** Whether the first touch was a paid one, as A-FIRST-08's attribution will resolve it. */
  readonly firstTouch: FirstTouchPaidState
}

/** Whether a customer's first touch was bought. See {@link KpiCohortMember.firstTouch}. */
export type FirstTouchPaidState = 'paid' | 'unpaid' | 'not_recorded'

/**
 * One (cohort, elapsed month) pair the caller has selected. **This IS the realised window.**
 *
 * `businessDays` is the period for every R-REP-03 figure and this is its analogue: there is no horizon
 * argument anywhere in this module, because a horizon passed as a number is a horizon a caller can pass
 * a larger one than the cohort has lived. `cohortRealisedWindow` in `cohorts.ts` is the only thing that
 * builds these rows and it refuses a month that has not fully elapsed, so an LTV extrapolated past the
 * cohort's own history is unreachable rather than merely discouraged (ADR 0071).
 *
 * A month in which the cohort spent nothing still has a row. That is what stops the monthly average
 * dividing by the months that happened to produce revenue — the same defect as a figure divided by
 * "days in the period" counting only the days the salon took money.
 */
export interface KpiCohortMonth {
  readonly cohortMonth: LocalDate
  /** 0 for the acquisition month itself. Whole months elapsed since `cohortMonth`. */
  readonly monthIndex: number
}

/**
 * One customer-month's realised net CONTRIBUTION, in fils.
 *
 * Contribution and not revenue, and the distinction is the acceptance line's: "LTV is cumulative
 * realised net contribution per cohort". A contribution is a net price less the costs attributable to
 * delivering it, and ADR 0070 established that three of those four costs do not exist in this build —
 * so `cohortContributionRow` refuses to build one of these out of a delivery whose margin is
 * `not_attributable`, rather than letting an unknown cost arrive here as a zero and report the highest
 * possible lifetime value on the screen somebody plans against.
 *
 * Negative is legitimate: a month whose credit notes exceed its invoices has a negative contribution,
 * and clamping it would make a refunded cohort look break-even.
 */
export interface KpiCohortContribution {
  readonly cohortMonth: LocalDate
  readonly monthIndex: number
  readonly customerId: string
  readonly netContributionFils: bigint
}

/**
 * Acquisition spend attributed to a PAID channel in one cohort month, in fils.
 *
 * Only channel-attributed paid spend may be in this dataset, which is why `cac.ts` is the only thing
 * that builds a row and why it refuses a total that is not attributed to a channel. Nothing in this
 * build tags a cost with a marketing channel: `bill_line.expense_account_code` and
 * `recurring_cost.expense_account_code` reference `account (code)` and carry no channel column, so the
 * movement on `6070 Marketing and advertising` is the whole of what is readable and it mixes paid
 * acquisition with signage, print and anything else the owner files there.
 *
 * Measured on this build's own database rather than assumed: zero `bill_line` rows, zero
 * `recurring_cost` rows and zero `journal_line` rows on `6070` after a clean migrate and seed. So there
 * is no spend figure at all today, let alone a channel-attributed one, and `Y9-paid-channel-attribution`
 * is the row that would answer it.
 */
export interface KpiAcquisitionSpend {
  readonly cohortMonth: LocalDate
  /** The paid channel the spend was attributed to. Carried so a figure can drill to its channels. */
  readonly channel: string
  /** Net of recoverable VAT, in fils. */
  readonly netFils: bigint
}

/**
 * One package balance's outstanding entitlement: the sessions still owed and the gross they carry.
 *
 * The grain is `package_balance` and not `package_sale`, because 0078 allocates the sale's gross across
 * the template version's LINES by largest remainder so the shares sum to the price exactly (ZG006) —
 * the per-session gross exists only within a line, and summing a sale-level average over lines would
 * reintroduce the residue that allocation removed.
 *
 * `valueFils` is `package_balance.value_fils`, the share this line carries, which 0078 records is
 * "never re-derived: re-deriving it at redemption time would give a different answer the moment the
 * catalogue's prices moved". `sessionsRemaining` is `sessions_total - sessions_redeemed`.
 */
export interface KpiPackageEntitlement {
  readonly packageSaleId: string
  readonly balanceId: string
  readonly sessionsTotal: number
  readonly sessionsRemaining: number
  readonly valueFils: bigint
}

/**
 * Everything a KPI may read.
 *
 * **`businessDays` IS the period.** There is no `from`/`to` pair: the days in scope are the `dim_date`
 * rows the caller selected, and every measure restricts its own rows to those days. That is not a
 * convenience — it is what makes "a 01:30 appointment counts in the previous business_day" a property of
 * this module rather than of its caller. The appointment's `businessDay` is the only date it carries, so
 * a period holding the previous trading date counts it and a period holding the calendar date of the
 * wall clock does not, and no filter here can be written any other way.
 *
 * A date the premises did not trade on has no `dim_date` row (ADR 0060), so it cannot appear here, and a
 * figure divided by "days in the period" cannot quietly include a day the salon was shut.
 */
export interface KpiInput {
  readonly businessDays: readonly KpiBusinessDay[]
  readonly roomDays: readonly KpiRoomDay[]
  readonly roomClosures: readonly KpiRoomClosure[]
  readonly appointments: readonly KpiAppointment[]
  readonly rosteredShifts: readonly KpiRosteredShift[]
  readonly revenueLines: readonly KpiRevenueLine[]
  /**
   * R-REP-05's five, and the rule above reaches all of them. `cohortMonths` is the realised window the
   * way `businessDays` is the period: every cohort measure restricts its own rows to it, so a month the
   * cohort has not lived cannot enter a figure and no filter here can be written any other way.
   */
  readonly cohortMembers: readonly KpiCohortMember[]
  readonly cohortMonths: readonly KpiCohortMonth[]
  readonly cohortContributions: readonly KpiCohortContribution[]
  readonly acquisitionSpend: readonly KpiAcquisitionSpend[]
  readonly packageEntitlements: readonly KpiPackageEntitlement[]
}

/** Every dataset of {@link KpiInput}, so a `reads` declaration can be checked against a known set. */
export const KPI_DATASETS = [
  'businessDays',
  'roomDays',
  'roomClosures',
  'appointments',
  'rosteredShifts',
  'revenueLines',
  'cohortMembers',
  'cohortMonths',
  'cohortContributions',
  'acquisitionSpend',
  'packageEntitlements',
] as const satisfies readonly (keyof KpiInput)[]

export type KpiDataset = (typeof KPI_DATASETS)[number]

/** `<dataset>.<field>`, the unit a {@link Measure} declares and {@link recordedReads} observes. */
export type DatasetRead = `${KpiDataset}.${string}`

/** An empty input, so a caller or a test can state only the datasets it is about. */
export const EMPTY_KPI_INPUT: KpiInput = Object.freeze({
  businessDays: Object.freeze([]),
  roomDays: Object.freeze([]),
  roomClosures: Object.freeze([]),
  appointments: Object.freeze([]),
  rosteredShifts: Object.freeze([]),
  revenueLines: Object.freeze([]),
  cohortMembers: Object.freeze([]),
  cohortMonths: Object.freeze([]),
  cohortContributions: Object.freeze([]),
  acquisitionSpend: Object.freeze([]),
  packageEntitlements: Object.freeze([]),
})

// --- exact rational arithmetic -------------------------------------------------------------------

/**
 * An exact figure: `numerator / denominator`, reduced, with `denominator` strictly positive.
 *
 * Reduced on construction so two figures that are the same number are the same value, which is what
 * lets a test assert a utilisation of 25% as `{ numerator: 1n, denominator: 4n }` rather than as
 * whatever minutes happened to produce it.
 */
export interface Rational {
  readonly numerator: bigint
  readonly denominator: bigint
}

const absolute = (value: bigint): bigint => (value < 0n ? -value : value)

function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  let left = absolute(a)
  let right = absolute(b)
  while (right !== 0n) {
    const next = left % right
    left = right
    right = next
  }
  return left
}

/** Raised when a `Rational` is asked for with a zero denominator, which is a caller defect. */
export class MalformedRational extends AppError {
  constructor(numerator: bigint) {
    super(
      'invariant_violated',
      `A rational needs a non-zero denominator; ${numerator}/0 was asked for. A division whose ` +
        'divisor may legitimately be zero is reported as NoDenominator rather than constructed.',
      { details: { numerator: numerator.toString() } },
    )
    this.name = 'MalformedRational'
  }
}

/** `numerator / denominator`, reduced, with the sign carried by the numerator. */
export function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new MalformedRational(numerator)
  const sign = denominator < 0n ? -1n : 1n
  const signedNumerator = numerator * sign
  const positiveDenominator = denominator * sign
  const divisor = greatestCommonDivisor(signedNumerator, positiveDenominator)
  // `gcd(0, d) === d`, so a zero numerator reduces to 0/1 rather than dividing by zero.
  if (divisor === 0n) return { numerator: 0n, denominator: 1n }
  return { numerator: signedNumerator / divisor, denominator: positiveDenominator / divisor }
}

/** A whole number as a figure. */
export const wholeRational = (value: bigint): Rational => ({ numerator: value, denominator: 1n })

export const addRational = (a: Rational, b: Rational): Rational =>
  rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator)

export const subtractRational = (a: Rational, b: Rational): Rational =>
  rational(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator)

/** `null` when `b` is zero, which is the only outcome a caller must handle. */
export function divideRational(a: Rational, b: Rational): Rational | null {
  if (b.numerator === 0n) return null
  return rational(a.numerator * b.denominator, a.denominator * b.numerator)
}

export const isZeroRational = (value: Rational): boolean => value.numerator === 0n

/** `true` when the figure is strictly greater than one, which for a ratio means above 100%. */
export const exceedsUnity = (value: Rational): boolean => value.numerator > value.denominator

/** `true` when the figure is below zero. A utilisation or an available-hours figure must not be. */
export const isNegativeRational = (value: Rational): boolean => value.numerator < 0n

const TEN = 10n

/**
 * The figure as an integer scaled by `10 ** decimals`, rounded HALF AWAY FROM ZERO.
 *
 * Integral all the way through: the numerator is scaled first and the remainder compared against half
 * the denominator with a doubling rather than a halving, so there is no intermediate fraction and
 * nothing to round twice. `roundHalfUp` in `../money.ts` is the same rule over a `number` and is the
 * wrong tool here for ADR 0064's reason.
 *
 * Half AWAY FROM ZERO and not half UP, because a figure here can be negative: `fact_sale` signs a credit
 * note's amounts negative (0110), so a month whose refunds exceed its takings has a negative RevPARH,
 * and half-up would round -0.5 towards zero while rounding 0.5 away from it — an asymmetry that makes a
 * credit note worth a fraction of a fil less than the sale it corrects.
 */
export function scaledFigure(value: Rational, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new AppError(
      'invariant_violated',
      `scaledFigure needs a non-negative whole number of decimals, received ${decimals}`,
      { details: { decimals } },
    )
  }
  const scaled = value.numerator * TEN ** BigInt(decimals)
  const quotient = scaled / value.denominator
  const remainder = scaled % value.denominator
  if (absolute(remainder) * 2n < value.denominator) return quotient
  return remainder < 0n ? quotient - 1n : quotient + 1n
}

/**
 * The figure as a fixed-point decimal string, for a formula's documented value and for a screen.
 *
 * Assembled from the scaled integer rather than formatted, because `Intl` in a reporting module would be
 * a locale lookup over a figure whose digits are the thing being asserted — and because the one decimal
 * place in "75.0 room-hours" has to be the same character in every locale for a test to read it.
 */
export function formatFigure(value: Rational, decimals: number): string {
  const scaled = scaledFigure(value, decimals)
  const sign = scaled < 0n ? '-' : ''
  const digits = absolute(scaled)
    .toString()
    .padStart(decimals + 1, '0')
  if (decimals === 0) return `${sign}${digits}`
  const whole = digits.slice(0, digits.length - decimals)
  return `${sign}${whole}.${digits.slice(digits.length - decimals)}`
}

// --- the expression language ---------------------------------------------------------------------

/**
 * A KPI's arithmetic, which is also its formula.
 *
 * Deliberately small: a sum, a difference and a quotient over measures, other KPIs and whole-number
 * constants. Nothing here can branch, loop, read a row or hold a figure, so a KPI cannot acquire a
 * special case that its formula does not show — which is the property that makes the rendered string
 * trustworthy rather than merely present.
 */
export type KpiExpr =
  | { readonly node: 'measure'; readonly measure: string }
  | { readonly node: 'kpi'; readonly kpi: string }
  | { readonly node: 'constant'; readonly value: bigint }
  | { readonly node: 'sum'; readonly terms: readonly KpiExpr[] }
  | { readonly node: 'difference'; readonly minuend: KpiExpr; readonly subtrahend: KpiExpr }
  | { readonly node: 'quotient'; readonly dividend: KpiExpr; readonly divisor: KpiExpr }

export const measureRef = (measure: string): KpiExpr => ({ node: 'measure', measure })
export const kpiRef = (kpi: string): KpiExpr => ({ node: 'kpi', kpi })
export const constant = (value: bigint): KpiExpr => ({ node: 'constant', value })
export const sumOf = (...terms: readonly KpiExpr[]): KpiExpr => ({ node: 'sum', terms })
export const differenceOf = (minuend: KpiExpr, subtrahend: KpiExpr): KpiExpr => ({
  node: 'difference',
  minuend,
  subtrahend,
})
export const quotientOf = (dividend: KpiExpr, divisor: KpiExpr): KpiExpr => ({
  node: 'quotient',
  dividend,
  divisor,
})

/** `true` for a node whose rendering needs brackets inside a larger one. */
const isCompound = (expr: KpiExpr): boolean =>
  expr.node === 'sum' || expr.node === 'difference' || expr.node === 'quotient'

/** The names a KPI expression reaches directly, in the order the formula prints them. */
export function referencesOf(expr: KpiExpr): {
  readonly measures: readonly string[]
  readonly kpis: readonly string[]
} {
  const measures: string[] = []
  const kpis: string[] = []
  const walk = (node: KpiExpr): void => {
    switch (node.node) {
      case 'measure':
        if (!measures.includes(node.measure)) measures.push(node.measure)
        return
      case 'kpi':
        if (!kpis.includes(node.kpi)) kpis.push(node.kpi)
        return
      case 'constant':
        return
      case 'sum':
        for (const term of node.terms) walk(term)
        return
      case 'difference':
        walk(node.minuend)
        walk(node.subtrahend)
        return
      case 'quotient':
        walk(node.dividend)
        walk(node.divisor)
        return
    }
  }
  walk(expr)
  return { measures, kpis }
}

/** The expression as its formula string. One job, so there is one thing to be wrong. */
export function renderExpr(expr: KpiExpr): string {
  const bracket = (node: KpiExpr): string => {
    const text = renderExpr(node)
    return isCompound(node) ? `(${text})` : text
  }
  switch (expr.node) {
    case 'measure':
      return expr.measure
    case 'kpi':
      return expr.kpi
    case 'constant':
      return expr.value.toString()
    case 'sum':
      // A nullary sum is zero and renders as it, rather than as an empty string that would satisfy
      // every "the formula is not empty" assertion while saying nothing.
      return expr.terms.length === 0 ? '0' : expr.terms.map(bracket).join(' + ')
    case 'difference':
      return `${bracket(expr.minuend)} − ${bracket(expr.subtrahend)}`
    case 'quotient':
      return `${bracket(expr.dividend)} ÷ ${bracket(expr.divisor)}`
  }
}

/**
 * `expr` with every KPI reference replaced by that KPI's own expression, so the result reaches the
 * measures. Rendering it is the expanded formula.
 *
 * A reference already on `path` is left as a NAME rather than substituted. That is what keeps a cyclic
 * registry a failing rule — `kpi-expression-has-no-cycle` in `kpi-registry.ts` names it — instead of a
 * substitution that never terminates, which would hang at module load with no rule to read.
 *
 * `path` and not a shared `seen` set: a KPI referenced twice in two different branches of one expression
 * must expand in both, and a set that grew as the walk descended would silently truncate the second —
 * producing a formula that is shorter than the arithmetic, which is exactly the drift this module exists
 * to prevent.
 */
export function expandExpr(
  expr: KpiExpr,
  expand: (kpi: string) => KpiExpr | undefined,
  path: readonly string[] = [],
): KpiExpr {
  const descend = (node: KpiExpr): KpiExpr => expandExpr(node, expand, path)
  switch (expr.node) {
    case 'measure':
    case 'constant':
      return expr
    case 'kpi': {
      if (path.includes(expr.kpi)) return expr
      const expansion = expand(expr.kpi)
      if (expansion === undefined) return expr
      return expandExpr(expansion, expand, [...path, expr.kpi])
    }
    case 'sum':
      return { node: 'sum', terms: expr.terms.map(descend) }
    case 'difference':
      return {
        node: 'difference',
        minuend: descend(expr.minuend),
        subtrahend: descend(expr.subtrahend),
      }
    case 'quotient':
      return { node: 'quotient', dividend: descend(expr.dividend), divisor: descend(expr.divisor) }
  }
}

// --- measures ------------------------------------------------------------------------------------

/**
 * One named integer quantity folded out of the input rows.
 *
 * A measure is the only thing here that is not an expression, because an aggregation is a fold. That
 * makes it the one place where a name and a computation sit beside each other, so it carries
 * {@link Measure.reads} and {@link recordedReads} holds the two equal.
 */
export interface Measure {
  readonly id: string
  /** What one unit of this measure IS, in a sentence. */
  readonly summary: string
  /** The unit, so an expression's result can be read without guessing. */
  readonly unit: KpiUnit
  /**
   * Every `<dataset>.<field>` the reducer touches, declared.
   *
   * Held equal to the access by `kpi-registry.ts`'s `measure-reads-exactly-the-fields-it-declares`, in
   * both directions: a field read and not declared, and a field declared and not read. The second
   * direction is the one that matters — it is what fires when a denominator stops reading
   * `businessDays.openMinutes` and starts assuming fifteen hours.
   */
  readonly reads: readonly DatasetRead[]
  readonly reduce: (input: KpiInput) => bigint
}

/**
 * The input again, as a fresh object whose every row field is a GETTER that records
 * `<dataset>.<field>` before it answers.
 *
 * Observation from outside and not instrumentation inside the reducers: code that reported its own
 * reads would be the second statement this exists to catch.
 *
 * **A copy with getters rather than a `Proxy`, and that is not a style choice.** A proxy's `get` trap
 * must return the target's own value for a non-configurable, non-writable data property, and
 * {@link EMPTY_KPI_INPUT} is frozen — so a proxy over it throws "'get' on proxy: property
 * 'businessDays' is a read-only and non-configurable data property ... but the proxy did not return its
 * actual value" the moment a reducer touches a dataset. The empty probe is exactly the input the vacuity
 * control uses, so the proxy arrangement failed on the one case it existed for. Fresh objects carry no
 * such invariant.
 *
 * Only a row's own enumerable fields are recorded, which is the right grain: a reducer that read a field
 * no row carries records nothing, and is then reported as declaring what it does not read.
 */
export function recordedReads(
  input: KpiInput,
  reduce: (input: KpiInput) => bigint,
): { readonly value: bigint; readonly reads: ReadonlySet<string> } {
  const reads = new Set<string>()

  const recordingRow = (dataset: string, row: object): object => {
    const recorded: Record<string, unknown> = {}
    for (const field of Object.keys(row)) {
      Object.defineProperty(recorded, field, {
        enumerable: true,
        get: () => {
          reads.add(`${dataset}.${field}`)
          return (row as Record<string, unknown>)[field]
        },
      })
    }
    return recorded
  }

  const recording: Record<string, unknown> = {}
  for (const dataset of Object.keys(input)) {
    const rows = (input as unknown as Record<string, unknown>)[dataset]
    recording[dataset] = Array.isArray(rows)
      ? rows.map((row: unknown) =>
          typeof row === 'object' && row !== null ? recordingRow(dataset, row) : row,
        )
      : rows
  }

  return { value: reduce(recording as unknown as KpiInput), reads }
}

// --- KPIs ----------------------------------------------------------------------------------------

/**
 * What a figure is measured in.
 *
 * Declared per KPI rather than inferred from the expression, and then CHECKED against it
 * (`kpi-unit-follows-from-its-expression` in `kpi-registry.ts`): minutes over minutes is a ratio, fils
 * over hours is fils per room-hour, and a unit nobody stated is how a screen comes to print a percentage
 * sign beside a count of minutes.
 */
/**
 * The unit a KPI's figure is in, for every KPI in the build and not just this module's.
 *
 * R-REP-03 and R-REP-04 each declared a `KpiUnit` in the same batch, with disjoint members — one for the
 * utilisation and RevPARH measures, one for the operational set — and `pnpm typecheck` refused the barrel
 * with TS2308 at the merge. That is the better failure: two unions of the same name are two answers to
 * "what can a KPI be measured in", and the one a caller gets would have depended on which module it
 * imported. One union, in the lowest module both can reach without a cycle.
 */
export type KpiUnit =
  | 'minutes'
  | 'hours'
  | 'ratio'
  | 'fils'
  | 'fils_per_room_hour'
  | 'basis_points'
  | 'composite'
  // R-REP-05's four. `customers` and `months` are counts a cohort figure divides BY, and they are
  // separate members rather than one `count` because `fils ÷ customers` and `fils ÷ months` are
  // different figures that a single dimensionless count would have made interchangeable — a lifetime
  // value and a monthly run rate reading as the same unit on the same screen.
  | 'customers'
  | 'months'
  | 'fils_per_customer'
  | 'fils_per_customer_month'

/** How many decimal places a figure of each unit is published to, stated once. */
export const KPI_UNIT_DECIMALS = {
  minutes: 0,
  hours: 1,
  // Four, so a ratio reads in basis points: utilisation to two decimal places of a percentage.
  ratio: 4,
  fils: 0,
  fils_per_room_hour: 0,
  // R-REP-04's two. Basis points are already the hundredth of a percent, so a figure in them is a whole
  // number; `composite` is a figure whose unit is whichever its parts are, and publishing one to a decimal
  // place this record chose would be this module deciding something the KPI's own parts decide.
  basis_points: 0,
  composite: 0,
  // R-REP-05's four. A count of customers is whole. A payback is published to one decimal place of a
  // month, because the figure it is compared against — "we get it back inside the quarter" — is a whole
  // number of months and a second place would suggest a precision a cohort of twenty does not have. The
  // two money-per-customer figures are fils, so they are whole for ADR 0007's reason.
  customers: 0,
  months: 1,
  fils_per_customer: 0,
  fils_per_customer_month: 0,
} as const satisfies Record<KpiUnit, number>

/** A KPI as its author declares it. `formula` and `compute` are derived from `expression`. */
export interface KpiSpec {
  readonly id: string
  readonly label: string
  /** What the figure answers, and anything a reader must know to use it. */
  readonly summary: string
  readonly unit: KpiUnit
  readonly expression: KpiExpr
  /**
   * The open question this KPI's shape stands in for, or `null`.
   *
   * Copied onto every result, the way `buildFinancialStatements` copies the statement layout's marker,
   * so a figure whose definition is an assumption cannot be read as a settled one.
   */
  readonly provisional: KpiProvisionalMarker | null
}

/**
 * The unit the expression itself implies, or `null` where the combination has no meaning.
 *
 * The unit is stated on the spec AND implied by the arithmetic, which is two statements of one fact, so
 * this is the function that holds them equal (`kpi-unit-follows-from-its-expression`). It is a small
 * declared table rather than a dimension system, and the three entries are the three combinations this
 * build's figures actually are:
 *
 *   * **minutes ÷ 60 is hours.** The only quotient by a constant that means anything here, and the
 *     constant is checked: `available_room_minutes ÷ 30` would be half-hours and is refused rather than
 *     labelled hours.
 *   * **minutes ÷ minutes is a ratio.** Both utilisations.
 *   * **fils ÷ hours is fils per room-hour.** RevPARH, and the reason the divisor must be `hours` and
 *     not `minutes`: fils per room-MINUTE is a figure sixty times smaller that would read as a plausible
 *     RevPARH on a screen.
 *
 * A sum or a difference keeps its operands' unit and refuses a mixture, which is what stops minutes
 * being subtracted from fils.
 *
 * `path` is the chain of KPI references already being resolved, and a revisit answers `null` rather than
 * recurring. Every other walk here guards against a cycle — {@link expandExpr} stops substituting,
 * {@link evaluateExpr} throws, and `kpi-registry.ts`'s `transitiveMeasures` reports one — and this one
 * did not, which `scripts/test-gates.mjs` 146d found by blinding the cycle rule: the rules pass then died
 * with `RangeError: Maximum call stack size exceeded` instead of naming the rule that had stopped firing,
 * so the case reported the blinding as undetected. A registry defect must present as a finding, including
 * when the finding that names it has been removed.
 */
export function unitOfExpr(
  expr: KpiExpr,
  context: {
    readonly measures: ReadonlyMap<string, Measure>
    readonly kpis: ReadonlyMap<string, KpiSpec>
  },
  path: readonly string[] = [],
): KpiUnit | null {
  const descend = (node: KpiExpr): KpiUnit | null => unitOfExpr(node, context, path)
  switch (expr.node) {
    case 'measure':
      return context.measures.get(expr.measure)?.unit ?? null
    case 'kpi': {
      if (path.includes(expr.kpi)) return null
      const kpi = context.kpis.get(expr.kpi)
      return kpi === undefined ? null : unitOfExpr(kpi.expression, context, [...path, expr.kpi])
    }
    case 'constant':
      // A constant is dimensionless. It is legal only as a divisor, which the quotient case enforces.
      return null
    case 'sum': {
      const units = expr.terms.map(descend)
      const first = units[0]
      if (first === undefined || first === null) return null
      return units.every((unit) => unit === first) ? first : null
    }
    case 'difference': {
      const minuend = descend(expr.minuend)
      return minuend !== null && minuend === descend(expr.subtrahend) ? minuend : null
    }
    case 'quotient':
      return quotientUnit(expr.dividend, expr.divisor, context, path)
  }
}

/** The seven quotients this build's figures are. See {@link unitOfExpr}. */
function quotientUnit(
  dividend: KpiExpr,
  divisor: KpiExpr,
  context: {
    readonly measures: ReadonlyMap<string, Measure>
    readonly kpis: ReadonlyMap<string, KpiSpec>
  },
  path: readonly string[],
): KpiUnit | null {
  const over = unitOfExpr(dividend, context, path)
  if (over === 'minutes' && divisor.node === 'constant') {
    return divisor.value === 60n ? 'hours' : null
  }
  const under = unitOfExpr(divisor, context, path)
  if (over === 'minutes' && under === 'minutes') return 'ratio'
  if (over === 'fils' && under === 'hours') return 'fils_per_room_hour'
  // R-REP-05's four lines in the same table, which ADR 0068 names as this record's extension point
  // ("a fourth kind of quotient is a line in that table").
  //
  //   * **fils ÷ customers is fils per customer.** The realised cohort value and the CAC. It is NOT
  //     `fils` — a figure in fils on a dashboard is a total, and a per-customer figure labelled as one
  //     is read as the cohort's whole takings.
  //   * **customers ÷ customers is a ratio.** The unattributed share. Separate from minutes ÷ minutes
  //     rather than a general "like over like" rule, because a general rule would also make
  //     fils ÷ fils a ratio and that is a margin percentage this module has no rounding rule for.
  //   * **fils_per_customer ÷ months is fils per customer-month.** The monthly contribution run rate.
  //   * **fils_per_customer ÷ fils_per_customer_month is months.** The payback, and the reason the two
  //     run-rate units are distinct at all: this is the one division in the build whose ANSWER is a
  //     duration, and it is only a duration because its divisor carries the month.
  if (over === 'fils' && under === 'customers') return 'fils_per_customer'
  if (over === 'customers' && under === 'customers') return 'ratio'
  if (over === 'fils_per_customer' && under === 'months') return 'fils_per_customer_month'
  if (over === 'fils_per_customer' && under === 'fils_per_customer_month') return 'months'
  return null
}

/** The open question a KPI's shape stands in for. Structurally `ProvisionalMarker` from the ledger. */
export interface KpiProvisionalMarker {
  readonly openQuestionId: string
  readonly note: string
}

/** A measured figure: exact, with the expression that produced it named. */
export interface MeasuredKpi {
  readonly kind: 'measured'
  readonly kpi: string
  readonly unit: KpiUnit
  readonly value: Rational
  readonly formula: string
  readonly provisional: KpiProvisionalMarker | null
}

/**
 * The explicit answer when a divisor is zero.
 *
 * The acceptance line names this shape: "a zero denominator returns an explicit NoDenominator result
 * rather than NaN, Infinity or 0". All three of those are worse than an error for the same reason — each
 * is a value a screen will render — and `0` is the worst, because a utilisation of zero is a real reading
 * that means the rooms were idle rather than that there were no rooms.
 *
 * `divisorFormula` is the rendered divisor, so the answer says WHICH denominator was empty: a RevPARH
 * with no available room-hours and a RevPARH over a period with no trading days are different operational
 * facts and the message must not collapse them.
 */
export interface NoDenominator {
  readonly kind: 'no_denominator'
  readonly kpi: string
  readonly unit: KpiUnit
  readonly formula: string
  readonly divisorFormula: string
  readonly provisional: KpiProvisionalMarker | null
}

export type KpiResult = MeasuredKpi | NoDenominator

export const isNoDenominator = (result: KpiResult): result is NoDenominator =>
  result.kind === 'no_denominator'

/** The outcome of evaluating an expression: a figure, or the divisor that was zero. */
export type ExprOutcome =
  | { readonly ok: true; readonly value: Rational }
  | { readonly ok: false; readonly divisorFormula: string }

/** Raised when an expression names something the registry does not hold. */
export class UnknownKpiReference extends AppError {
  constructor(kind: 'measure' | 'KPI', name: string) {
    super(
      'not_found',
      `A KPI expression references the ${kind} "${name}", which is not registered. An expression is ` +
        'also the published formula, so a dangling name would print a figure nobody can resolve.',
      { details: { kind, name } },
    )
    this.name = 'UnknownKpiReference'
  }
}

/** Raised when a KPI is defined, directly or through another, in terms of itself. */
export class KpiExpressionCycle extends AppError {
  constructor(id: string, path: readonly string[]) {
    super(
      'invariant_violated',
      `The KPI "${id}" is defined in terms of itself (${[...path, id].join(' -> ')}). A cyclic ` +
        'definition has no value; the registry rule kpi-expression-has-no-cycle names it before a ' +
        'figure is ever asked for.',
      { details: { id, path: [...path] } },
    )
    this.name = 'KpiExpressionCycle'
  }
}

/**
 * The expression's exact value, or the divisor that was zero.
 *
 * `measures` and `kpis` are passed in for the acyclicity reason the header gives: this module may not
 * import the registry, because `pnpm boundaries` refuses a cycle between modules just as this function
 * refuses one between KPIs.
 *
 * `visiting` is the path of KPI references already being evaluated, and a revisit THROWS rather than
 * recurring. A registry defect must not present as a hung process: `kpi-expression-has-no-cycle` is the
 * rule that names it, and this throw is what makes the rule's absence survivable rather than fatal.
 */
export function evaluateExpr(
  expr: KpiExpr,
  context: {
    readonly input: KpiInput
    readonly measures: ReadonlyMap<string, Measure>
    readonly kpis: ReadonlyMap<string, KpiSpec>
    readonly visiting?: ReadonlySet<string>
  },
): ExprOutcome {
  const recur = (node: KpiExpr): ExprOutcome => evaluateExpr(node, context)
  switch (expr.node) {
    case 'measure':
      return {
        ok: true,
        value: wholeRational(measureOf(expr.measure, context).reduce(context.input)),
      }
    case 'kpi':
      return evaluateKpiNode(expr.kpi, context)
    case 'constant':
      return { ok: true, value: wholeRational(expr.value) }
    case 'sum':
      return foldSum(expr.terms, recur)
    case 'difference': {
      const minuend = recur(expr.minuend)
      if (!minuend.ok) return minuend
      const subtrahend = recur(expr.subtrahend)
      if (!subtrahend.ok) return subtrahend
      return { ok: true, value: subtractRational(minuend.value, subtrahend.value) }
    }
    case 'quotient': {
      const dividend = recur(expr.dividend)
      if (!dividend.ok) return dividend
      const divisor = recur(expr.divisor)
      if (!divisor.ok) return divisor
      const quotient = divideRational(dividend.value, divisor.value)
      // The one place a zero denominator is answered rather than computed. `bigint` division by zero
      // throws, so there is no path from here to NaN, Infinity or a silent 0.
      if (quotient === null) return { ok: false, divisorFormula: renderExpr(expr.divisor) }
      return { ok: true, value: quotient }
    }
  }
}

function measureOf(
  id: string,
  context: { readonly measures: ReadonlyMap<string, Measure> },
): Measure {
  const measure = context.measures.get(id)
  if (measure === undefined) throw new UnknownKpiReference('measure', id)
  return measure
}

function evaluateKpiNode(
  id: string,
  context: {
    readonly input: KpiInput
    readonly measures: ReadonlyMap<string, Measure>
    readonly kpis: ReadonlyMap<string, KpiSpec>
    readonly visiting?: ReadonlySet<string>
  },
): ExprOutcome {
  const kpi = context.kpis.get(id)
  if (kpi === undefined) throw new UnknownKpiReference('KPI', id)
  const visiting = context.visiting ?? new Set<string>()
  if (visiting.has(id)) throw new KpiExpressionCycle(id, [...visiting])
  return evaluateExpr(kpi.expression, { ...context, visiting: new Set([...visiting, id]) })
}

function foldSum(terms: readonly KpiExpr[], recur: (node: KpiExpr) => ExprOutcome): ExprOutcome {
  let total = wholeRational(0n)
  for (const term of terms) {
    const outcome = recur(term)
    if (!outcome.ok) return outcome
    total = addRational(total, outcome.value)
  }
  return { ok: true, value: total }
}
