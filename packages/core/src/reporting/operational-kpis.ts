import { AppError } from '@berelax/shared'
import type { CostComponentId } from './contribution-margin.ts'

/**
 * The operational KPI set: eight named pure functions, each carrying its formula as a string (R-REP-04).
 *
 * # What this module is NOT
 *
 * It is **not a registry**. R-REP-03 owns `kpi-registry.ts` and a second registry would be a second
 * answer to "which KPIs exist" — the defect `reporting.materialised_view` exists to prevent one subject
 * along (ADR 0060). What is here is a *registrable set*: {@link OPERATIONAL_KPI_DEFINITIONS} is a frozen
 * `Record` over a closed union of ids, with no lookup function, no mutation and no claim that it is the
 * whole of anything. R-REP-03's registry registers these; this module cannot register anything.
 *
 * # The one shape every KPI returns
 *
 * {@link KpiOutcome} has four states and a number is only one of them:
 *
 *   * `value` — the figure.
 *   * `no_denominator` — the denominator is zero. Never `0`, never `NaN`, never `Infinity`. A
 *     utilisation of 0% on a day the salon was shut is a different claim from "we were shut" (migration
 *     0011's own words), and division is where the two become the same number.
 *   * `no_data` — a figure this KPI reads was not available. It NAMES the figures, so the answer to "why
 *     is this tile empty" is on the tile.
 *   * `not_attributable` — a figure exists for part of the population and not for the rest, so any
 *     number would be over a subset nobody chose. It names the open questions.
 *
 * The three non-value states are not error handling. They are the arrangement R-REP-07 needs — "a tile
 * physically cannot render a number whose check is failing" — reached by the KPI never producing one.
 *
 * # Why `bigint`, and why basis points rather than a percentage
 *
 * Money is `bigint` for `./statements.ts`'s reason: `packages/db/src/queries/trial-balance.ts` records a
 * ledger holding 2^53 + 1 fils on each side reporting a difference of -4 fils out of nothing, because
 * the two sides round independently.
 *
 * A ratio is an **integer number of basis points** and never a float. 1/3 as a float is a figure that
 * prints differently in two places and sums to something other than 100%; a rounded integer bp is
 * exact, comparable and the same unit `vat_rate_bp`, `rate_bp` and `promotion.percentage_bp` already
 * use throughout this build. {@link divideHalfUp} is the one rounding rule, stated once.
 *
 * # What this module deliberately cannot do
 *
 * Nothing here holds a rate, a fee, a window length or a cost. Every figure arrives as an argument,
 * from `packages/db/src/reporting/kpi-queries.ts` or from a caller that says where it got it. Three of
 * the eight KPIs therefore answer `no_data` against this build's own database today, and that is the
 * honest answer rather than a defect:
 *
 *   * `contribution_margin_ratio` and `break_even_revenue` need the expense accounts split into fixed
 *     and variable, and nothing in the build classifies them (Y9-cost-behaviour is inside
 *     Y9-unit-cost-basis). A split invented here would decide the headline figure "the revenue this
 *     salon must take to break even" on this build's guess about somebody else's cost structure.
 *   * `rebooking_rate` needs a window — what counts as having rebooked — and takes it as a required
 *     argument for the reason Y9-crm-lifecycle gives about the lapse thresholds: "events supplied by
 *     the caller, not durations this build has chosen".
 *
 * Nothing reads a clock or performs I/O.
 */

// --- the outcome ---------------------------------------------------------------------------------

export type KpiOutcome<T> =
  | { readonly state: 'value'; readonly value: T }
  | { readonly state: 'no_denominator'; readonly why: string }
  | { readonly state: 'no_data'; readonly why: string; readonly missingFigures: readonly string[] }
  | {
      readonly state: 'not_attributable'
      readonly why: string
      /** What could not be attributed: a cost component id, or the name of a figure. */
      readonly missing: readonly string[]
      readonly openQuestionIds: readonly string[]
    }

const value = <T>(v: T): KpiOutcome<T> => Object.freeze({ state: 'value' as const, value: v })

const noDenominator = <T>(why: string): KpiOutcome<T> =>
  Object.freeze({ state: 'no_denominator' as const, why })

const noData = <T>(why: string, missingFigures: readonly string[]): KpiOutcome<T> =>
  Object.freeze({
    state: 'no_data' as const,
    why,
    missingFigures: Object.freeze([...missingFigures]),
  })

const notAttributable = <T>(
  why: string,
  missing: readonly string[],
  openQuestionIds: readonly string[],
): KpiOutcome<T> =>
  Object.freeze({
    state: 'not_attributable' as const,
    why,
    missing: Object.freeze([...missing]),
    openQuestionIds: Object.freeze([...openQuestionIds]),
  })

// --- the one rounding rule ----------------------------------------------------------------------

/**
 * 10,000 basis points is the whole, as a `bigint`.
 *
 * A second statement of a figure `../seo/query-rows.ts` already exports as a `number`, and it arrives
 * with the check that holds the two equal in the same commit — `contribution-margin.test.ts` asserts
 * `Number(WHOLE_IN_BASIS_POINTS) === BASIS_POINTS`. It is a separate constant rather than a cast of that
 * one because a `bigint` arithmetic path must not be able to take a `number` from anywhere: that is the
 * whole reason every money figure here is a `bigint`, and `BigInt(someNumber)` is exactly the door it
 * would come through.
 */
export const WHOLE_IN_BASIS_POINTS = 10_000n

/**
 * Integer division of `bigint`s, rounded **half-up away from zero**, matching `roundHalfUp` in
 * `../money.ts`.
 *
 * `bigint` division truncates towards zero, which is a silent downward bias on every positive figure
 * and an upward one on every negative — so a hundred average tickets each truncated by half a fils is
 * fifty fils that belong to nobody. Away from zero rather than up, because a negative numerator is
 * reachable: net revenue in a month whose credit notes exceed its invoices is negative, and rounding
 * -0.5 to 0 would report a loss as break-even.
 *
 * A non-positive denominator throws rather than returning a state, because every caller here has
 * already decided what a zero denominator means — see {@link KpiOutcome}'s `no_denominator`. Reaching
 * this with one is a caller that skipped that decision.
 */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new AppError(
      'invariant_violated',
      `divideHalfUp was given a denominator of ${denominator}. A zero or negative denominator is a ` +
        "KpiOutcome of its own ('no_denominator'); it is not an arithmetic case.",
      { details: { numerator: numerator.toString(), denominator: denominator.toString() } },
    )
  }
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  if (remainder === 0n) return quotient
  const twice = (remainder < 0n ? -remainder : remainder) * 2n
  if (twice < denominator) return quotient
  return numerator < 0n ? quotient - 1n : quotient + 1n
}

/** A share of a whole, as whole basis points, half-up. 10,000 bp is the whole. */
export function shareInBasisPoints(part: bigint, whole: bigint): number {
  return Number(divideHalfUp(part * WHOLE_IN_BASIS_POINTS, whole))
}

const asCount = (what: string, n: number): bigint => {
  if (!Number.isInteger(n) || n < 0) {
    throw new AppError(
      'validation',
      `${what} must be a whole non-negative count, received ${n}. A fractional count is an average ` +
        'somebody has already taken.',
      { details: { what, n } },
    )
  }
  return BigInt(n)
}

// --- 1. average ticket ---------------------------------------------------------------------------

export interface AverageTicketInput {
  /** The net of every invoice issued in the period. Credit notes are NOT subtracted — see below. */
  readonly invoiceNetFils: bigint
  readonly invoiceCount: number
  /**
   * The net credited back in the period, carried so the figure is not read as the money kept.
   *
   * Deliberately not netted into the numerator. A credit note is a document of its own with its own
   * tax point (0072) and it is not a TICKET, so subtracting it from a numerator whose denominator
   * counts tickets mixes two populations — and a month with one large credit note would report an
   * average ticket smaller than any ticket actually issued.
   */
  readonly creditNoteNetFils: bigint
}

export interface AverageTicket {
  readonly averageNetFils: bigint
  readonly invoiceCount: number
  readonly invoiceNetFils: bigint
  /** Reported beside the average and never inside it. */
  readonly creditNoteNetFils: bigint
}

export const AVERAGE_TICKET_FORMULA =
  'average_ticket = invoice net fils / invoices issued, rounded half-up away from zero; a credit note ' +
  'is not a ticket, so credit_note_net_fils is reported alongside and never subtracted from the ' +
  'numerator'

export function averageTicket(input: AverageTicketInput): KpiOutcome<AverageTicket> {
  const tickets = asCount('invoiceCount', input.invoiceCount)
  if (tickets === 0n) {
    return noDenominator(
      'No invoice was issued in the period, so there is no ticket to average. A zero here would read ' +
        'as a period of free treatments.',
    )
  }
  return value({
    averageNetFils: divideHalfUp(input.invoiceNetFils, tickets),
    invoiceCount: input.invoiceCount,
    invoiceNetFils: input.invoiceNetFils,
    creditNoteNetFils: input.creditNoteNetFils,
  })
}

// --- 2. retail attachment ------------------------------------------------------------------------

export interface RetailAttachmentInput {
  readonly invoiceCount: number
  /** Invoices whose checkout posted to `4030 Retail product revenue`. */
  readonly invoicesCarryingRetail: number
}

export const RETAIL_ATTACHMENT_FORMULA =
  'retail_attachment_rate_bp = invoices carrying a posting to 4030 Retail product revenue / invoices ' +
  'issued x 10000. The till has no retail line kind today (ADR 0021: services and packages only), so ' +
  'the measured rate is a true zero rather than a missing figure, and it starts moving the day a ' +
  'retail line exists — the mechanism reads the account, not a product table'

export function retailAttachment(input: RetailAttachmentInput): KpiOutcome<number> {
  const tickets = asCount('invoiceCount', input.invoiceCount)
  const withRetail = asCount('invoicesCarryingRetail', input.invoicesCarryingRetail)
  if (tickets === 0n) {
    return noDenominator('No invoice was issued in the period, so no ticket could carry retail.')
  }
  if (withRetail > tickets) {
    throw new AppError(
      'invariant_violated',
      `${withRetail} invoices carrying retail out of ${tickets} issued is more than all of them, so ` +
        'the two figures were counted over different populations.',
      { details: { tickets: tickets.toString(), withRetail: withRetail.toString() } },
    )
  }
  return value(shareInBasisPoints(withRetail, tickets))
}

// --- 3. rebooking rate ---------------------------------------------------------------------------

export interface RebookingRateInput {
  readonly deliveredAppointments: number
  /** Deliveries followed by a booking made within `windowDays` of the delivery. */
  readonly rebookedWithinWindow: number
  /**
   * What "rebooked" means, in days, from the caller.
   *
   * No default, deliberately. "Booked their next visit before leaving" and "booked again within a
   * month" are two different figures that would arrive under one name, and the right window is
   * Y9-crm-lifecycle's unanswered question — whose provisional position is already that "the two
   * inactivity thresholds that move a record are events supplied by the caller, not durations this
   * build has chosen".
   */
  readonly windowDays: number
}

export interface RebookingRate {
  readonly rateBp: number
  readonly windowDays: number
  readonly deliveredAppointments: number
  readonly rebookedWithinWindow: number
}

export const REBOOKING_RATE_FORMULA =
  'rebooking_rate_bp = delivered appointments followed by a booking created within window_days / ' +
  'delivered appointments x 10000. window_days is REQUIRED and has no default: "booked before leaving" ' +
  'and "booked again within a month" are different figures (Y9-crm-lifecycle)'

export function rebookingRate(input: RebookingRateInput): KpiOutcome<RebookingRate> {
  if (!Number.isInteger(input.windowDays) || input.windowDays < 1) {
    throw new AppError(
      'validation',
      `A rebooking window of ${input.windowDays} days is not a window. It is a required argument with ` +
        'no default because the figure means something different for every value of it ' +
        '(Y9-crm-lifecycle).',
      { details: { windowDays: input.windowDays } },
    )
  }
  const delivered = asCount('deliveredAppointments', input.deliveredAppointments)
  const rebooked = asCount('rebookedWithinWindow', input.rebookedWithinWindow)
  if (delivered === 0n) {
    return noDenominator(
      'No appointment was delivered in the period, so nobody could rebook. A zero rate would read as ' +
        'every client declining to come back.',
    )
  }
  if (rebooked > delivered) {
    throw new AppError(
      'invariant_violated',
      `${rebooked} rebookings out of ${delivered} deliveries is more than all of them, so the two ` +
        'figures were counted over different populations.',
      { details: { delivered: delivered.toString(), rebooked: rebooked.toString() } },
    )
  }
  return value({
    rateBp: shareInBasisPoints(rebooked, delivered),
    windowDays: input.windowDays,
    deliveredAppointments: input.deliveredAppointments,
    rebookedWithinWindow: input.rebookedWithinWindow,
  })
}

// --- 4. no-show cost -----------------------------------------------------------------------------

export interface NoShowAppointment {
  readonly appointmentId: string
  readonly businessDay: string
  /** The net of the price snapshotted on the appointment. Never a catalogue lookup. */
  readonly netFils: bigint
  /**
   * The minutes the room was held for this delivery: the treatment plus its turnaround.
   *
   * Reported as a SEPARATE figure and never converted into money, which is the acceptance line's "with
   * lost room-hours reported alongside as a separate figure". Pricing an empty room needs a revenue per
   * available room-hour for the hour that was lost, and multiplying the two would double-count the
   * price the no-show already carries.
   */
  readonly roomMinutes: number
}

export interface NoShowCost {
  readonly costFils: bigint
  readonly noShows: number
  readonly lostRoomMinutes: number
  /** The rows the figure drills to, in the order given. */
  readonly appointmentIds: readonly string[]
}

export const NO_SHOW_COST_FORMULA =
  'no_show_cost_fils = SUM over appointments with status no_show in the period of the net of the price ' +
  'snapshotted on the appointment; lost_room_minutes = SUM of treatment minutes plus turnaround, ' +
  'reported alongside and never priced'

/**
 * The cost of the no-shows in a period, and the rows it drills to.
 *
 * A period with no no-shows is a MEASURED zero, not `no_data`: nobody failed to arrive, which is a fact
 * and a good one. That is the one place in this module where zero is the right answer, and it is right
 * because the denominator is not a division — it is a sum over an empty set.
 */
export function noShowCost(noShows: readonly NoShowAppointment[]): KpiOutcome<NoShowCost> {
  let costFils = 0n
  let lostRoomMinutes = 0
  const appointmentIds: string[] = []
  for (const appointment of noShows) {
    if (appointment.netFils < 0n) {
      throw new AppError(
        'invariant_violated',
        `No-show appointment ${appointment.appointmentId} carries a net of ${appointment.netFils} ` +
          'fils. A negative snapshot would reduce the cost of the other no-shows.',
        { details: { appointmentId: appointment.appointmentId } },
      )
    }
    if (!Number.isInteger(appointment.roomMinutes) || appointment.roomMinutes < 0) {
      throw new AppError(
        'invariant_violated',
        `No-show appointment ${appointment.appointmentId} held the room for ` +
          `${appointment.roomMinutes} minutes, which is not a whole non-negative number of minutes.`,
        { details: { appointmentId: appointment.appointmentId } },
      )
    }
    costFils += appointment.netFils
    lostRoomMinutes += appointment.roomMinutes
    appointmentIds.push(appointment.appointmentId)
  }
  return value({
    costFils,
    noShows: noShows.length,
    lostRoomMinutes,
    appointmentIds: Object.freeze(appointmentIds),
  })
}

// --- 5. discount leakage -------------------------------------------------------------------------

export interface DiscountedInvoiceLine {
  readonly invoiceId: string
  readonly lineNo: number
  /** `invoice_line.unit_gross_fils * quantity`: what the customer was charged for this line. */
  readonly chargedGrossFils: bigint
  /**
   * The gross this line started at, snapshotted — `appointment.gross_price_fils` for a line that bills
   * an appointment, which is the price before anything came off it at the till.
   *
   * `null` when no row holds one: a line that bills no appointment (`invoice_appointment.line_no` is
   * nullable by design, and a document may be raised outside a checkout) has nothing to compare
   * against. Such a line makes the figure `not_attributable` rather than contributing zero leakage,
   * because a line charged below a list price nobody recorded is indistinguishable from a line that
   * was never discounted.
   */
  readonly listGrossFils: bigint | null
}

export interface DiscountLeakage {
  readonly leakageGrossFils: bigint
  readonly lines: number
  readonly discountedLines: number
  /** The (invoiceId, lineNo) pairs the figure drills to. */
  readonly drillsTo: readonly { readonly invoiceId: string; readonly lineNo: number }[]
}

export const DISCOUNT_LEAKAGE_FORMULA =
  'discount_leakage_fils = SUM over invoice lines of (list gross - charged gross), both in integer ' +
  'fils and both SNAPSHOTS: the charged gross is invoice_line.unit_gross_fils x quantity and the list ' +
  'gross is appointment.gross_price_fils through invoice_appointment. A line with no snapshotted list ' +
  'gross makes the figure not_attributable rather than contributing zero'

/**
 * Till discount given away in a period, tied to the invoice lines it came off.
 *
 * **What this figure covers, exactly.** `appointment.gross_price_fils` is the price resolved at booking
 * and `invoice_line.unit_gross_fils` is what was charged, so the difference is the discount applied AT
 * THE TILL — `basket.ts`'s `ChargeableAmount.discount`, which reaches the document as a reduced line
 * price because `unit_gross_fils` is a `fils_nonneg` domain and a negative line is impossible.
 *
 * **What it does not cover, and why that is stated rather than smoothed.** A price reduced by a
 * `price_list` row or a promotion is already inside `appointment.gross_price_fils`, and the catalogue
 * price it was reduced FROM is not snapshotted anywhere — `dim_service.list_gross_fils` is the price
 * today (migration 0110). So a campaign menu is invisible to this figure. The caller reports
 * {@link DiscountLeakageCoverage} beside it, which is the same arrangement R-REP-05 uses for its
 * unattributed CAC share: a figure with its coverage named, rather than a figure that quietly means
 * less than its label.
 */
export function discountLeakage(
  lines: readonly DiscountedInvoiceLine[],
): KpiOutcome<DiscountLeakage> {
  const withoutListPrice: string[] = []
  let leakageGrossFils = 0n
  let discountedLines = 0
  const drillsTo: { invoiceId: string; lineNo: number }[] = []
  for (const line of lines) {
    if (line.listGrossFils === null) {
      withoutListPrice.push(`${line.invoiceId}#${line.lineNo}`)
      continue
    }
    if (line.listGrossFils < line.chargedGrossFils) {
      throw new AppError(
        'invariant_violated',
        `Invoice line ${line.invoiceId}#${line.lineNo} was charged ${line.chargedGrossFils} fils ` +
          `against a list gross of ${line.listGrossFils}. A line charged above its list price is a ` +
          'surcharge, not a discount, and summing it as negative leakage would make a discount given ' +
          'elsewhere disappear.',
        { details: { invoiceId: line.invoiceId, lineNo: line.lineNo } },
      )
    }
    const leakage = line.listGrossFils - line.chargedGrossFils
    if (leakage > 0n) {
      discountedLines += 1
      drillsTo.push({ invoiceId: line.invoiceId, lineNo: line.lineNo })
    }
    leakageGrossFils += leakage
  }
  if (withoutListPrice.length > 0) {
    return notAttributable(
      `${withoutListPrice.length} of ${lines.length} invoice line(s) have no snapshotted list gross, ` +
        'so the leakage on them is unknown rather than zero: ' +
        `${withoutListPrice.slice(0, 5).join(', ')}${withoutListPrice.length > 5 ? ', …' : ''}.`,
      ['list_gross_fils'],
      ['Y9-unit-cost-basis'],
    )
  }
  return value({
    leakageGrossFils,
    lines: lines.length,
    discountedLines,
    drillsTo: Object.freeze(drillsTo.map((row) => Object.freeze(row))),
  })
}

/** What share of a period's deliveries this leakage figure cannot see. Reported beside it, never in it. */
export interface DiscountLeakageCoverage {
  readonly deliveries: number
  /** Deliveries whose gross came from a `price_list` row: a menu reduction this figure cannot see. */
  readonly pricedByPriceList: number
  /** Deliveries carrying a promotion id: a campaign reduction this figure cannot see. */
  readonly pricedByPromotion: number
}

// --- 6. labour cost % ----------------------------------------------------------------------------

/**
 * The four labour figures, and there is deliberately no field for a tip.
 *
 * This is the acceptance line "excludes tips from its numerator" made structural rather than promised.
 * A tip is not a labour cost in this build at all: `posting.ts` credits a gratuity to
 * `2040 Tips payable`, a LIABILITY, because the money is the therapist's and the salon is holding it.
 * It never reaches an expense account, so including it would both invent an expense and double-count
 * money that is already owed.
 */
export interface LabourCostComponents {
  /** `5010 Therapist wages`. */
  readonly wagesFils: bigint
  /** `5020 Staff commission expense`. */
  readonly commissionFils: bigint
  /** `5030 End-of-service gratuity expense`. */
  readonly gratuityAccrualFils: bigint
  /** `5040 Annual leave expense`. */
  readonly leaveAccrualFils: bigint
}

export interface LabourCostPercentInput {
  readonly labour: LabourCostComponents
  /** The denominator, as the acceptance line names it: NET revenue, not gross. */
  readonly netRevenueFils: bigint
  /** Collected and owed to therapists. Carried for the report; it cannot enter the numerator. */
  readonly tipsCollectedFils: bigint
}

export interface LabourCostPercent {
  readonly percentBp: number
  readonly labourCostFils: bigint
  readonly netRevenueFils: bigint
  /** Reported beside the figure so a reader can see it was excluded rather than forgotten. */
  readonly tipsCollectedFils: bigint
}

export const LABOUR_COST_PERCENT_FORMULA =
  'labour_cost_percent_bp = (5010 wages + 5020 commission + 5030 gratuity accrual + 5040 leave ' +
  'accrual) / net revenue x 10000. Tips are EXCLUDED: a gratuity is credited to 2040 Tips payable, a ' +
  "liability, and is the therapist's money rather than an employer cost"

export function labourCostPercent(input: LabourCostPercentInput): KpiOutcome<LabourCostPercent> {
  const labourCostFils =
    input.labour.wagesFils +
    input.labour.commissionFils +
    input.labour.gratuityAccrualFils +
    input.labour.leaveAccrualFils
  if (input.netRevenueFils <= 0n) {
    return noDenominator(
      `Net revenue in the period is ${input.netRevenueFils} fils, so labour cost has nothing to be a ` +
        'percentage of. A zero or negative denominator would report either an infinite ratio or a ' +
        'negative one, and both print as a number somebody would act on.',
    )
  }
  return value({
    percentBp: shareInBasisPoints(labourCostFils, input.netRevenueFils),
    labourCostFils,
    netRevenueFils: input.netRevenueFils,
    tipsCollectedFils: input.tipsCollectedFils,
  })
}

/**
 * What labour cost % would be if tips were counted as labour. **Never report this.**
 *
 * Exported for one reason, the one `vatIfDiscountTaxedSeparately` is exported for: a test asserting
 * "the figure is 2,500 bp" proves nothing unless it also knows what the wrong method answers. Without
 * this, the control assertion would be a second copy of the right arithmetic.
 */
export function labourCostPercentIfTipsWereIncluded(input: LabourCostPercentInput): number {
  if (input.netRevenueFils <= 0n) {
    throw new AppError(
      'invariant_violated',
      'the wrong-method control needs a positive denominator, exactly as the right method does',
    )
  }
  const withTips =
    input.labour.wagesFils +
    input.labour.commissionFils +
    input.labour.gratuityAccrualFils +
    input.labour.leaveAccrualFils +
    input.tipsCollectedFils
  return shareInBasisPoints(withTips, input.netRevenueFils)
}

// --- 7. contribution margin ratio ----------------------------------------------------------------

export interface ContributionMarginRatioInput {
  readonly netRevenueFils: bigint
  /**
   * The costs that move with volume, in fils.
   *
   * `null` when nothing classifies them, which is this build's state: no column, setting or table
   * anywhere splits the expense accounts into fixed and variable, and the split is not arithmetic — it
   * is a statement about how this business behaves. See the module note and Y9-unit-cost-basis.
   */
  readonly variableCostFils: bigint | null
}

export const CONTRIBUTION_MARGIN_RATIO_FORMULA =
  'contribution_margin_ratio_bp = (net revenue - variable cost) / net revenue x 10000. variable_cost ' +
  'requires the expense accounts split into fixed and variable, which nothing in this build ' +
  'classifies (Y9-unit-cost-basis), so the figure is no_data rather than a guess'

export function contributionMarginRatio(input: ContributionMarginRatioInput): KpiOutcome<number> {
  if (input.variableCostFils === null) {
    return noData(
      'The expense accounts are not classified into fixed and variable anywhere in this build, so the ' +
        'variable cost of the period is unknown. Treating every cost as fixed would report the whole ' +
        'of net revenue as contribution, which is the largest possible answer.',
      ['variableCostFils'],
    )
  }
  if (input.netRevenueFils <= 0n) {
    return noDenominator(
      `Net revenue in the period is ${input.netRevenueFils} fils, so there is no ratio to take.`,
    )
  }
  return value(
    shareInBasisPoints(input.netRevenueFils - input.variableCostFils, input.netRevenueFils),
  )
}

// --- 8. break-even -------------------------------------------------------------------------------

export interface BreakEvenInput {
  /** The costs that do not move with volume, in fils, or `null` for the reason above. */
  readonly fixedCostFils: bigint | null
  /** The output of {@link contributionMarginRatio}, passed rather than recomputed. */
  readonly contributionMarginRatioBp: number | null
}

export const BREAK_EVEN_FORMULA =
  'break_even_revenue_fils = fixed cost x 10000 / contribution_margin_ratio_bp, rounded half-up away ' +
  'from zero. Both inputs need the fixed/variable split nothing in this build states ' +
  '(Y9-unit-cost-basis), so the figure is no_data rather than a guess'

export function breakEvenRevenue(input: BreakEvenInput): KpiOutcome<bigint> {
  const missing: string[] = []
  if (input.fixedCostFils === null) missing.push('fixedCostFils')
  if (input.contributionMarginRatioBp === null) missing.push('contributionMarginRatioBp')
  if (
    missing.length > 0 ||
    input.fixedCostFils === null ||
    input.contributionMarginRatioBp === null
  ) {
    return noData(
      'Break-even divides fixed cost by the contribution margin ratio, and both need the expense ' +
        'accounts split into fixed and variable. Nothing in this build makes that split ' +
        '(Y9-unit-cost-basis).',
      missing,
    )
  }
  if (input.contributionMarginRatioBp <= 0) {
    return noDenominator(
      `A contribution margin ratio of ${input.contributionMarginRatioBp} bp covers no fixed cost at ` +
        'any volume, so there is no revenue at which this business breaks even. That is a finding, ' +
        'not a number.',
    )
  }
  if (input.fixedCostFils < 0n) {
    throw new AppError(
      'invariant_violated',
      `A fixed cost of ${input.fixedCostFils} fils is negative, which would report a business that ` +
        'breaks even below zero revenue.',
      { details: { fixedCostFils: input.fixedCostFils.toString() } },
    )
  }
  return value(
    divideHalfUp(
      input.fixedCostFils * WHOLE_IN_BASIS_POINTS,
      BigInt(input.contributionMarginRatioBp),
    ),
  )
}

// --- the registrable set ------------------------------------------------------------------------

export const OPERATIONAL_KPI_IDS = [
  'average_ticket',
  'retail_attachment_rate',
  'rebooking_rate',
  'no_show_cost',
  'discount_leakage',
  'labour_cost_percent',
  'contribution_margin_ratio',
  'break_even_revenue',
] as const

export type OperationalKpiId = (typeof OPERATIONAL_KPI_IDS)[number]

export type { KpiUnit } from './kpi-expression.ts'

import type { KpiUnit } from './kpi-expression.ts'

/**
 * Every figure an operational KPI may read, in one place.
 *
 * The seam between `packages/db/src/reporting/kpi-queries.ts`, which produces this, and the KPIs, which
 * consume it. One bag rather than eight argument lists, for the reason R-REP-03's registry needs: a
 * registry hands a KPI a period and gets an outcome back, and it cannot know eight shapes.
 *
 * **`null` means "not read or not readable", never zero.** A KPI whose figure is null answers `no_data`
 * NAMING it, which is why every field is explicitly nullable rather than optional: an absent property
 * and a property nobody set are the same thing in JavaScript and different claims here.
 */
export interface PeriodFigures {
  readonly periodId: string
  readonly invoiceNetFils: bigint | null
  readonly invoiceCount: number | null
  readonly creditNoteNetFils: bigint | null
  readonly invoicesCarryingRetail: number | null
  readonly deliveredAppointments: number | null
  readonly rebookedWithinWindow: number | null
  readonly rebookingWindowDays: number | null
  readonly noShows: readonly NoShowAppointment[] | null
  readonly discountedLines: readonly DiscountedInvoiceLine[] | null
  readonly labour: LabourCostComponents | null
  readonly netRevenueFils: bigint | null
  readonly tipsCollectedFils: bigint | null
  readonly variableCostFils: bigint | null
  readonly fixedCostFils: bigint | null
}

export type KpiValue =
  | bigint
  | number
  | AverageTicket
  | RebookingRate
  | NoShowCost
  | DiscountLeakage
  | LabourCostPercent

/**
 * One KPI as a registry holds it: what it is, what it reads, its formula, and the pure function.
 *
 * `compute` is the same function the typed export is — not a copy of its arithmetic — so there is one
 * statement of every figure. What it adds is the adaptation from {@link PeriodFigures}, including the
 * `no_data` a null figure produces, which is the part a registry cannot write for eight different
 * shapes.
 */
export interface KpiDefinition {
  readonly kpiId: OperationalKpiId
  readonly label: string
  /** Non-empty, always. R-REP-03's registry test is entitled to assert that and this is why it holds. */
  readonly formula: string
  readonly unit: KpiUnit
  /** What one value of this KPI is about: a period, a service, a therapist. */
  readonly grain: string
  /** The {@link PeriodFigures} fields this KPI reads. A null one is the `no_data` it reports. */
  readonly figures: readonly (keyof PeriodFigures)[]
  readonly compute: (figures: PeriodFigures) => KpiOutcome<KpiValue>
}

/** Names the null figures a KPI needed, so `no_data` says which rather than that something was absent. */
const absent = (
  figures: PeriodFigures,
  needed: readonly (keyof PeriodFigures)[],
): readonly string[] => needed.filter((name) => figures[name] === null)

const PERIOD = 'one accounting period, business-day bounded'

/**
 * The set R-REP-03's registry registers. A `Record` over the closed union, so a KPI added to
 * {@link OPERATIONAL_KPI_IDS} and left undefined is a `pnpm typecheck` failure naming this file.
 *
 * There is no `kpiById` and no mutation. This is a list to be registered, not a registry: the one
 * registry is R-REP-03's.
 */
export const OPERATIONAL_KPI_DEFINITIONS: Record<OperationalKpiId, KpiDefinition> = Object.freeze({
  average_ticket: {
    kpiId: 'average_ticket',
    label: 'Average ticket',
    formula: AVERAGE_TICKET_FORMULA,
    unit: 'fils',
    grain: PERIOD,
    figures: ['invoiceNetFils', 'invoiceCount', 'creditNoteNetFils'],
    compute: (figures) => {
      const needed = ['invoiceNetFils', 'invoiceCount', 'creditNoteNetFils'] as const
      const missing = absent(figures, needed)
      if (missing.length > 0 || figures.invoiceNetFils === null || figures.invoiceCount === null) {
        return noData("Average ticket needs the period's invoice net and invoice count.", missing)
      }
      return averageTicket({
        invoiceNetFils: figures.invoiceNetFils,
        invoiceCount: figures.invoiceCount,
        creditNoteNetFils: figures.creditNoteNetFils ?? 0n,
      })
    },
  },
  retail_attachment_rate: {
    kpiId: 'retail_attachment_rate',
    label: 'Retail attachment rate',
    formula: RETAIL_ATTACHMENT_FORMULA,
    unit: 'basis_points',
    grain: PERIOD,
    figures: ['invoiceCount', 'invoicesCarryingRetail'],
    compute: (figures) => {
      const missing = absent(figures, ['invoiceCount', 'invoicesCarryingRetail'])
      if (
        missing.length > 0 ||
        figures.invoiceCount === null ||
        figures.invoicesCarryingRetail === null
      ) {
        return noData('Retail attachment needs both ticket counts.', missing)
      }
      return retailAttachment({
        invoiceCount: figures.invoiceCount,
        invoicesCarryingRetail: figures.invoicesCarryingRetail,
      })
    },
  },
  rebooking_rate: {
    kpiId: 'rebooking_rate',
    label: 'Rebooking rate',
    formula: REBOOKING_RATE_FORMULA,
    unit: 'basis_points',
    grain: PERIOD,
    figures: ['deliveredAppointments', 'rebookedWithinWindow', 'rebookingWindowDays'],
    compute: (figures) => {
      const missing = absent(figures, [
        'deliveredAppointments',
        'rebookedWithinWindow',
        'rebookingWindowDays',
      ])
      if (
        missing.length > 0 ||
        figures.deliveredAppointments === null ||
        figures.rebookedWithinWindow === null ||
        figures.rebookingWindowDays === null
      ) {
        return noData(
          'The rebooking rate needs both counts and the window they were counted over; the window has ' +
            'no default (Y9-crm-lifecycle).',
          missing,
        )
      }
      return rebookingRate({
        deliveredAppointments: figures.deliveredAppointments,
        rebookedWithinWindow: figures.rebookedWithinWindow,
        windowDays: figures.rebookingWindowDays,
      })
    },
  },
  no_show_cost: {
    kpiId: 'no_show_cost',
    label: 'No-show cost',
    formula: NO_SHOW_COST_FORMULA,
    unit: 'composite',
    grain: PERIOD,
    figures: ['noShows'],
    compute: (figures) => {
      const missing = absent(figures, ['noShows'])
      if (missing.length > 0 || figures.noShows === null) {
        return noData('No-show cost needs the no-show appointment rows it drills to.', missing)
      }
      return noShowCost(figures.noShows)
    },
  },
  discount_leakage: {
    kpiId: 'discount_leakage',
    label: 'Discount leakage',
    formula: DISCOUNT_LEAKAGE_FORMULA,
    unit: 'fils',
    grain: PERIOD,
    figures: ['discountedLines'],
    compute: (figures) => {
      const missing = absent(figures, ['discountedLines'])
      if (missing.length > 0 || figures.discountedLines === null) {
        return noData('Discount leakage needs the invoice lines it ties to.', missing)
      }
      return discountLeakage(figures.discountedLines)
    },
  },
  labour_cost_percent: {
    kpiId: 'labour_cost_percent',
    label: 'Labour cost %',
    formula: LABOUR_COST_PERCENT_FORMULA,
    unit: 'basis_points',
    grain: PERIOD,
    figures: ['labour', 'netRevenueFils', 'tipsCollectedFils'],
    compute: (figures) => {
      const missing = absent(figures, ['labour', 'netRevenueFils', 'tipsCollectedFils'])
      if (missing.length > 0 || figures.labour === null || figures.netRevenueFils === null) {
        return noData(
          'Labour cost % needs the four labour accounts and net revenue. Tips are read only to be ' +
            'reported beside the figure.',
          missing,
        )
      }
      return labourCostPercent({
        labour: figures.labour,
        netRevenueFils: figures.netRevenueFils,
        tipsCollectedFils: figures.tipsCollectedFils ?? 0n,
      })
    },
  },
  contribution_margin_ratio: {
    kpiId: 'contribution_margin_ratio',
    label: 'Contribution margin ratio',
    formula: CONTRIBUTION_MARGIN_RATIO_FORMULA,
    unit: 'basis_points',
    grain: PERIOD,
    figures: ['netRevenueFils', 'variableCostFils'],
    compute: (figures) => {
      const missing = absent(figures, ['netRevenueFils'])
      if (missing.length > 0 || figures.netRevenueFils === null) {
        return noData('The contribution margin ratio needs net revenue.', missing)
      }
      return contributionMarginRatio({
        netRevenueFils: figures.netRevenueFils,
        variableCostFils: figures.variableCostFils,
      })
    },
  },
  break_even_revenue: {
    kpiId: 'break_even_revenue',
    label: 'Break-even revenue',
    formula: BREAK_EVEN_FORMULA,
    unit: 'fils',
    grain: PERIOD,
    figures: ['fixedCostFils', 'netRevenueFils', 'variableCostFils'],
    compute: (figures) => {
      const ratio = contributionMarginRatio({
        netRevenueFils: figures.netRevenueFils ?? 0n,
        variableCostFils: figures.variableCostFils,
      })
      return breakEvenRevenue({
        fixedCostFils: figures.fixedCostFils,
        contributionMarginRatioBp: ratio.state === 'value' ? ratio.value : null,
      })
    },
  },
} satisfies Record<OperationalKpiId, KpiDefinition>)

/** The rules a KPI definition has to satisfy. Each one is broken by a case in gate block 148. */
export const KPI_DEFINITION_RULES = [
  'kpi-definition-key-matches-its-own-id',
  'kpi-definition-carries-a-non-empty-formula',
  'kpi-definition-states-its-grain',
  'kpi-definition-names-the-figures-it-reads',
  'kpi-definition-formula-names-its-own-unit',
] as const

export type KpiDefinitionRule = (typeof KPI_DEFINITION_RULES)[number]

export interface KpiDefinitionFinding {
  readonly rule: KpiDefinitionRule
  readonly kpiId: string
  readonly detail: string
}

/**
 * Every way a KPI definition can be unfit to register, as findings rather than as a throw.
 *
 * Findings and not an exception, for `statementLayoutFindings`' reason: a caller that wants all of them
 * — a test, R-REP-03's registry test, a gate — gets all of them, and {@link assertKpiDefinitions} is
 * the one-line throw for a caller that wants the first.
 *
 * It reads {@link OPERATIONAL_KPI_DEFINITIONS} rather than taking a copy, so a definition added
 * tomorrow is checked by what is already written.
 */
export function kpiDefinitionFindings(
  definitions: Record<OperationalKpiId, KpiDefinition> = OPERATIONAL_KPI_DEFINITIONS,
): readonly KpiDefinitionFinding[] {
  const findings: KpiDefinitionFinding[] = []
  for (const kpiId of OPERATIONAL_KPI_IDS) {
    const definition = definitions[kpiId]
    if (definition.kpiId !== kpiId) {
      findings.push({
        rule: 'kpi-definition-key-matches-its-own-id',
        kpiId,
        detail:
          `the entry under "${kpiId}" calls itself "${definition.kpiId}", so a registry keyed on
          one and a tile labelled from the other disagree`.replace(/\s+/g, ' '),
      })
    }
    if (definition.formula.trim() === '') {
      findings.push({
        rule: 'kpi-definition-carries-a-non-empty-formula',
        kpiId,
        detail:
          'the formula is empty, so the figure is a number with no stated derivation — which is what ' +
          'a registry of formulas exists to prevent',
      })
    }
    if (definition.grain.trim() === '') {
      findings.push({
        rule: 'kpi-definition-states-its-grain',
        kpiId,
        detail: 'the grain is empty, so what one value of this KPI is about is unstated',
      })
    }
    if (definition.figures.length === 0) {
      findings.push({
        rule: 'kpi-definition-names-the-figures-it-reads',
        kpiId,
        detail:
          'the definition reads no figure, so a no_data result could not name what was missing and a ' +
          'dashboard could not tell which query feeds it',
      })
    }
    const unitWord = definition.unit === 'basis_points' ? '10000' : 'fils'
    if (definition.unit !== 'composite' && !definition.formula.includes(unitWord)) {
      findings.push({
        rule: 'kpi-definition-formula-names-its-own-unit',
        kpiId,
        detail:
          `the unit is ${definition.unit} and the formula never mentions ${unitWord}, so the two are ` +
          'free to disagree about whether the figure is money, a ratio or a count',
      })
    }
  }
  return Object.freeze(findings)
}

/** Throws on the first finding. `pnpm typecheck` cannot see any of these — they are about values. */
export function assertKpiDefinitions(
  definitions: Record<OperationalKpiId, KpiDefinition> = OPERATIONAL_KPI_DEFINITIONS,
): void {
  const findings = kpiDefinitionFindings(definitions)
  const first = findings[0]
  if (first !== undefined) {
    throw new AppError(
      'invariant_violated',
      `The operational KPI definitions are unfit to register: ${first.rule} on ${first.kpiId} — ` +
        `${first.detail}. ${findings.length} finding(s) in all.`,
      { details: { findings: findings.map((f) => `${f.rule}:${f.kpiId}`) } },
    )
  }
}

/**
 * The cost components a margin-derived KPI would need, re-exported as the vocabulary of
 * {@link KpiOutcome}'s `not_attributable`.
 *
 * A type-only re-export, so this module states no component of its own.
 */
export type { CostComponentId }
