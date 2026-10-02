import { AppError } from '@berelax/shared'
import { horizonDates } from '../business-day/horizon.ts'
import type { AccountCode } from '../ledger/account.ts'
import type { ProvisionalMarker } from '../ledger/chart-of-accounts.ts'
import type { LocalDate } from '../time.ts'
import { divideHalfUp, WHOLE_IN_BASIS_POINTS } from './operational-kpis.ts'

/**
 * The 13-week cash-flow forecast (R-REP-06). Pure, and ADR 0073 is the decision behind its shape.
 *
 * # The problem this module is organised around
 *
 * **A forecast is a number nobody can check until it is too late.** Every other figure in the R-REP set
 * can be audited the moment it is published: a statement line drills to `journal_line`, a KPI names the
 * expression it was computed from, a margin names the costs it is missing. A closing-cash figure for week
 * nine can only be checked in week nine, and by then the decision it was read for has been taken.
 *
 * Two decisions follow, and they are the whole of this module's design. Both are ADR 0073.
 *
 * ## 1. Every line is a commitment already on file, re-timed. Nothing is extrapolated.
 *
 * The forecast may be derived from exactly four things:
 *
 *   * the **measured** cash position at `asOf`, from the ledger's cash accounts (ADR 0064's set);
 *   * **recurring cost occurrences** computed from contracted definitions — `forwardSchedule` here, and
 *     `recurring_cost_forward_schedule()` in the database, never the generated instances;
 *   * **forward bookings** already in the diary, at the gross `appointment.gross_price_fils` snapshotted
 *     when each was taken, reduced by a show-up rate;
 *   * **rostered shifts** already on the rota, priced by the labour-cost rule versions.
 *
 * And from nothing else. There is no trend, no moving average, no regression, no growth rate and **no
 * seasonality index**: `./seasonality.ts` is not imported here and must not be, which gate case 151j
 * holds shut with a scan of its own and a planted import. The reason is specific rather than stylistic —
 * this business has weeks of history, so a seasonality index over its own trading days is an index over
 * almost nothing, and multiplying a cash figure by one would change the number with no trace left in it
 * of what had been assumed. The index is published BESIDE the forecast with its own evidence count, and
 * a reader joins them.
 *
 * What that buys is the only kind of checkability a forecast can have: every line's error mode is "the
 * commitment did not happen", which is a fact somebody can look up, and never "the model was wrong",
 * which is not.
 *
 * ## 2. No figure here can be rendered as a measurement, and that is structural rather than labelled.
 *
 * Every amount is a {@link ForecastFigure}, which is a discriminated union and not a number. Its states
 * are the vocabulary R-REP-04 established for a cost component (ADR 0070) with one addition this unit
 * needs:
 *
 *   * `measured` — read from the ledger. **Exactly one figure in the whole artefact is this**: week 1's
 *     opening cash.
 *   * `committed` — a quantity on file whose CASH is still in the future. A contracted rent, a booking at
 *     its snapshotted price. Not a measurement: the invoice may not be paid and the client may not come.
 *   * `projected` — an assumption was applied. Names every assumption in its chain.
 *   * `none_by_construction` — nil because there is nothing of that kind in the week. Deliberately not
 *     `measured 0`: no recurring cost falling due in week seven is a fact about the contracts, and a
 *     measured zero would be a bank account that was looked at.
 *   * `unattributable` — refused, and **carries no `fils` field at all**, so there is no code path from
 *     an unknown to a number even by mistake.
 *
 * {@link combineFigures} makes a sum as weak as its weakest part, so a week's closing cash is `projected`
 * the moment one projected amount reaches it, and `unattributable` the moment one unknown does. The only
 * function that turns a figure into something printable, {@link publishForecastFigure}, returns the number
 * and its qualifier TOGETHER and takes only the three states that have a number — so a caller must narrow
 * past the two that do not, and cannot print a projection without the words that say it is one. That is
 * R-REP-07's "no numeric fallback branch" reached one unit early, as `publishedFigure` already does for a
 * KPI.
 *
 * ## The caveat that is always there
 *
 * R-REP-02 states that a balance sheet read as a movement omits every opening balance and still balances,
 * so the window a statement reads is a property of the statement and not of its lines. The same class of
 * caveat applies here and is {@link CashForecast.caveats}: it is DERIVED — one entry per assumption
 * actually used, plus {@link FORECAST_CAVEAT}, which no input can remove. A caveat a caller could switch
 * off is a caveat that will be off on the screen it matters on.
 *
 * ## What the articulation proves, and what it does not
 *
 * `opening + inflows − outflows = closing` is true by construction, because `closing` is defined that
 * way — ADR 0064's point about the balance sheet balancing, one subject along. What it does prove is that
 * the artefact is a CHAIN and that its totals are a second, independent read of its lines:
 *
 *   * each week's `articulationDifferenceFils` is 0;
 *   * each week's opening is the previous week's closing (`chainDifferenceFils`), so no week re-reads the
 *     ledger half way through the horizon;
 *   * the total row's inflows and outflows are summed from the LINES across all thirteen weeks, while
 *     each week's subtotals are summed from its own lines, and `totalsDifferenceFils` holds the two
 *     equal. An implementation that dropped a line from a week would keep every weekly identity and fail
 *     this one.
 *
 * Nothing here reads a clock, and `asOf` is a trading date the caller resolved on `business_day` — so two
 * runs under the frozen clock produce the same object and {@link forecastBytes} the same bytes.
 */

// --- the shape of the horizon --------------------------------------------------------------------

export const FORECAST_FORMAT_VERSION = 'cash-forecast-1'

/** Thirteen, which is the quarter this report is named for. */
export const FORECAST_WEEKS = 13
export const DAYS_PER_FORECAST_WEEK = 7

/**
 * The caveat no input can switch off.
 *
 * Phrased as what the artefact IS rather than as advice, because a caveat that reads as advice gets
 * treated as one.
 */
export const FORECAST_CAVEAT =
  'Every figure in this forecast except the opening cash position is a claim about the future. The ' +
  'opening position is the only one read from the ledger; a committed figure is a quantity on file ' +
  'whose cash has not moved, and a projected figure had an assumption applied to it. No figure here ' +
  'has been measured, and none may be presented as though it had been.'

// --- a figure, which is never a bare number ------------------------------------------------------

/** What kind of claim a figure is. See the module header. */
export const FORECAST_FIGURE_STATES = [
  'measured',
  'committed',
  'projected',
  'none_by_construction',
  'unattributable',
] as const
export type ForecastFigureState = (typeof FORECAST_FIGURE_STATES)[number]

/**
 * An assumption a projected figure rests on.
 *
 * `provisional` is the open question that owns the assumption, or `null` when there is not one — and the
 * distinction is a real one rather than an optionality. The show-up rate is a value the build GUESSED and
 * `Y9-windows` owns it, so answering that question replaces the figure. The top of a variable cost's band
 * is a PRUDENCE rule this build chose and nobody has to answer: the band is the register's own data, and
 * `prudentExpectation` takes its top because a plan built on the middle of every band is short of cash in
 * about half the months it covers. A marker invented for it would put a question on the Unconfirmed
 * Assumptions panel that has no answer.
 */
export interface ForecastAssumption {
  readonly assumptionId: string
  readonly provisional: ProvisionalMarker | null
  /** What was assumed, in the author's words, including the value. */
  readonly statement: string
}

export type ForecastFigure =
  /** Read from the ledger. One figure in the artefact is this: week 1's opening cash. */
  | { readonly state: 'measured'; readonly fils: bigint; readonly evidence: string }
  /** A quantity on file whose cash has not moved. */
  | { readonly state: 'committed'; readonly fils: bigint; readonly evidence: string }
  /** An assumption was applied. Every assumption in the chain is named. */
  | {
      readonly state: 'projected'
      readonly fils: bigint
      readonly assumptionIds: readonly string[]
    }
  /** Nil because there is nothing of this kind. Not a measured zero — ADR 0070. */
  | { readonly state: 'none_by_construction'; readonly basis: string }
  /** Refused. No `fils` field: there is no path from here to a number. */
  | {
      readonly state: 'unattributable'
      readonly why: string
      readonly missing: readonly string[]
      readonly openQuestionIds: readonly string[]
    }

/** The states that carry a number. A caller must narrow to these before it can print anything. */
export type NumberedForecastFigure = Extract<ForecastFigure, { readonly fils: bigint }>

/**
 * How strong a claim each state is, for {@link combineFigures}.
 *
 * `none_by_construction` ranks with `committed` and not with `measured`: adding a known nil to a
 * contracted amount leaves a contracted amount, and nothing about the sum has been looked at.
 * `unattributable` is 0 and poisons, which is the direction that matters.
 */
const FIGURE_RANK: Record<ForecastFigureState, number> = {
  measured: 4,
  committed: 3,
  none_by_construction: 3,
  projected: 2,
  unattributable: 0,
}

/**
 * `fils` where the state has one, 0 for a known nil, and `null` for a refusal.
 *
 * `null` and not 0 for the refusal, which is the whole point: every arithmetic below propagates the null
 * rather than substituting a zero, so an identity over a missing figure is ABSENT rather than satisfied.
 */
const filsOf = (figure: ForecastFigure): bigint | null =>
  figure.state === 'unattributable'
    ? null
    : figure.state === 'none_by_construction'
      ? 0n
      : figure.fils

/** A sum of figures' amounts, `null` as soon as one of them is a refusal. */
const addFigures = (
  ...figures: readonly (readonly [ForecastFigure, 1n | -1n])[]
): bigint | null => {
  let total = 0n
  for (const [figure, sign] of figures) {
    const fils = filsOf(figure)
    if (fils === null) return null
    total += fils * sign
  }
  return total
}

const assumptionsOf = (figure: ForecastFigure): readonly string[] =>
  figure.state === 'projected' ? figure.assumptionIds : []

/**
 * A sum of figures, as weak as its weakest part.
 *
 * `basis` is the sentence the result carries when it is `committed` or `none_by_construction`, and
 * `nilBasis` the one it carries when there was nothing to add at all. Two arguments rather than one,
 * because "every part of this was contracted" and "there was nothing of this kind in the week" are
 * different claims and the second is the one ADR 0070 is about.
 */
export function combineFigures(
  parts: readonly ForecastFigure[],
  basis: string,
  nilBasis: string,
): ForecastFigure {
  const refused = parts.filter((part) => part.state === 'unattributable')
  if (refused.length > 0) {
    return Object.freeze({
      state: 'unattributable' as const,
      why: refused.map((part) => (part.state === 'unattributable' ? part.why : '')).join(' '),
      missing: Object.freeze([
        ...new Set(
          refused.flatMap((part) => (part.state === 'unattributable' ? part.missing : [])),
        ),
      ]),
      openQuestionIds: Object.freeze([
        ...new Set(
          refused.flatMap((part) => (part.state === 'unattributable' ? part.openQuestionIds : [])),
        ),
      ]),
    })
  }
  if (parts.length === 0) {
    return Object.freeze({ state: 'none_by_construction' as const, basis: nilBasis })
  }
  const weakest = parts.reduce(
    (state, part) => (FIGURE_RANK[part.state] < FIGURE_RANK[state] ? part.state : state),
    parts[0]?.state ?? ('none_by_construction' as ForecastFigureState),
  )
  // Every part is known here — the refusal branch returned above — so the fold cannot meet a null.
  const fils = parts.reduce((total, part) => total + (filsOf(part) ?? 0n), 0n)
  if (weakest === 'projected') {
    return Object.freeze({
      state: 'projected' as const,
      fils,
      assumptionIds: Object.freeze([...new Set(parts.flatMap(assumptionsOf))].sort()),
    })
  }
  if (
    weakest === 'none_by_construction' &&
    parts.every((part) => part.state === 'none_by_construction')
  ) {
    return Object.freeze({ state: 'none_by_construction' as const, basis: nilBasis })
  }
  // `measured` survives a sum only when every part is measured, which in this artefact means a sum of
  // one. Anything else is at most `committed`, because a contracted amount added to a bank balance is
  // not a bank balance any more.
  return Object.freeze({
    state: weakest === 'measured' ? ('measured' as const) : ('committed' as const),
    fils,
    evidence: basis,
  })
}

/** A figure a screen may print: the number and the words that must appear beside it, together. */
export interface PublishedForecastFigure {
  readonly fils: bigint
  readonly state: 'measured' | 'committed' | 'projected'
  /** Empty for a measured figure and never empty for the other two. */
  readonly qualifier: string
}

/**
 * The only way to a printable number, and it hands back the qualifier with it.
 *
 * It takes {@link NumberedForecastFigure} rather than {@link ForecastFigure} deliberately: the caller has
 * to narrow past `unattributable` and `none_by_construction` first, so there is no code path from an
 * unknown — or from a known nil — to a printed figure. That is `publishedFigure`'s arrangement for a KPI
 * (ADR 0068) with the qualifier added, because a KPI's figure is measured and this one never is.
 */
export function publishForecastFigure(figure: NumberedForecastFigure): PublishedForecastFigure {
  switch (figure.state) {
    case 'measured':
      return Object.freeze({ fils: figure.fils, state: 'measured' as const, qualifier: '' })
    case 'committed':
      return Object.freeze({
        fils: figure.fils,
        state: 'committed' as const,
        qualifier: 'forecast — committed, not yet received or paid',
      })
    case 'projected':
      return Object.freeze({
        fils: figure.fils,
        state: 'projected' as const,
        qualifier: `forecast — projected on ${figure.assumptionIds.join(', ')}`,
      })
  }
}

// --- the inputs ----------------------------------------------------------------------------------

/** Which contracted occurrence falls due when, from `forwardSchedule` or its SQL mirror. */
export interface ForecastCostOccurrence {
  readonly code: string
  readonly dueDate: LocalDate
  /** The prudent figure: the contracted amount, or the TOP of a variable band. */
  readonly expectedFils: bigint
  /** `fixed` is a contracted amount and `variable` is a band — which is why the two differ in basis. */
  readonly costKind: 'fixed' | 'variable'
}

/** One appointment already in the diary, at the gross snapshotted when it was taken. */
export interface ForwardBooking {
  readonly appointmentId: string
  /** `appointment.trading_date`, so a 01:30 treatment is in the week its trading date is in. */
  readonly tradingDate: LocalDate
  /** `appointment.gross_price_fils`: the price this booking was taken at, never today's catalogue. */
  readonly snapshotGrossFils: bigint
}

/** The share of forward bookings expected to show up, in basis points, and where the figure came from. */
export interface ShowUpRate {
  readonly rateBp: number
  readonly settingKey: string
  readonly provisional: ProvisionalMarker
}

/** One payroll settlement expected inside the horizon: the wage bill, and the date the cash leaves. */
export interface ForecastPayrollOccurrence {
  /** The period the run pays for, `payroll_run`'s own grain. */
  readonly periodKey: string
  /** The date the money leaves the bank. See {@link ForecastPayroll} for why this cannot be derived. */
  readonly dueDate: LocalDate
  readonly grossFils: bigint
}

/**
 * The payroll side, which is the one input that may arrive as a REFUSAL rather than as rows.
 *
 * It has to, because payroll is where this build's data runs out twice over and the two gaps are
 * independent:
 *
 *   1. **There is no pay date anywhere.** `payroll_run` records `period_starts_on` and `period_ends_on`
 *      and no date on which the money leaves the bank. A cash forecast is about dates, and a 13-week
 *      horizon holds three payroll settlements — so putting one on the last day of the period, or on a
 *      fixed day of the following month, moves a whole month's wage bill into or out of the horizon.
 *      That is `Y8-payroll-date`.
 *   2. **Every wage is NULL.** `employee.basic_wage_fils` is unset for every employment record
 *      (`Y8-staff`), which is the state ADR 0070 was written about: "an employee with no wage
 *      contributes nothing to a sum, so a forecast over a rota where no wage is recorded is 0 fils and
 *      reads as a free rota".
 *
 * An EMPTY `occurrences` list cannot carry either, because an empty list is a week with no payroll in
 * it — a real and different answer. So the refusal is a state of the input and not an absence from it,
 * and `packages/fixtures/src/cash-forecast.itest.ts` MEASURES that this build's own database produces it
 * rather than asserting that it should.
 */
export type ForecastPayroll =
  | { readonly state: 'scheduled'; readonly occurrences: readonly ForecastPayrollOccurrence[] }
  | {
      readonly state: 'unattributable'
      readonly why: string
      readonly missing: readonly string[]
      readonly openQuestionIds: readonly string[]
    }

/**
 * What is KNOWN about payroll over a horizon, which is a census and deliberately not an amount.
 *
 * Structurally `PayrollForecastCensus` in `packages/db`, written twice because `db` may never import
 * `core` (ADR 0001) — the same unavoidable pair `PeriodFigures` / `KpiPeriodFigures` already is, and it
 * arrives with the check that holds the two equal in the same commit: `cash-forecast.itest.ts` annotates
 * the db census with this type and compares the field sets, so a field renamed on either side is a
 * `pnpm typecheck` failure.
 */
export interface PayrollCensus {
  readonly activeEmploymentRecords: number
  readonly pricedEmployees: number
  readonly unpricedEmployeeIds: readonly string[]
  readonly payrollRunsOverlappingTheWindow: number
  /** Whether ANY column in the build records the date payroll cash leaves. See `Y8-payroll-date`. */
  readonly aPayDateIsRecordedAnywhere: boolean
}

/**
 * The payroll input, derived from a census rather than from an amount.
 *
 * Here rather than in the worker because it is the SHAPE of this unit's honesty claim and has to be
 * testable without a queue: `cash-forecast.itest.ts` calls it with a census read from the real database
 * and reads back `unattributable`, which MEASURES the refusal instead of asserting it (ADR 0070's
 * arrangement for the contribution margin).
 *
 * It returns no figure even when some wages ARE on file. A partial wage bill is the defect ADR 0070 is
 * about: it is a number, a screen renders it, and it is lower than the real one by exactly the employees
 * nobody has priced.
 */
export function payrollFromCensus(census: PayrollCensus): ForecastPayroll {
  const missing: string[] = []
  const questions: string[] = []
  if (!census.aPayDateIsRecordedAnywhere) {
    missing.push('a column recording the date payroll cash leaves the bank')
    questions.push('Y8-payroll-date')
  }
  if (census.unpricedEmployeeIds.length > 0) {
    for (const id of census.unpricedEmployeeIds) missing.push(`employee.basic_wage_fils for ${id}`)
    questions.push('Y8-staff')
  }
  if (missing.length === 0) {
    // Not reachable against this build's own database, and the branch is here rather than thrown because
    // the day both gaps are answered this must produce a figure without being rewritten. The occurrences
    // are empty: whoever answers Y8-payroll-date supplies the schedule, and an empty list is "no
    // settlement falls due in this horizon", which is a real answer and not a refusal.
    return Object.freeze({ state: 'scheduled' as const, occurrences: Object.freeze([]) })
  }
  return Object.freeze({
    state: 'unattributable' as const,
    why:
      `Payroll cannot be placed in this horizon. ${census.activeEmploymentRecords} employment ` +
      `record(s) are active, ${census.pricedEmployees} of them carry a wage, and ` +
      `${census.payrollRunsOverlappingTheWindow} payroll run(s) overlap the window. Nil would forecast ` +
      'a quarter of free staff, which is the error that overstates closing cash.',
    missing: Object.freeze(missing),
    openQuestionIds: Object.freeze([...new Set(questions)]),
  })
}

export interface CashForecastInput {
  /** The trading date the forecast is cut on, resolved by the caller on `business_day`. */
  readonly asOf: LocalDate
  /** The ledger's cash position at `asOf`. The artefact's one measured figure. */
  readonly openingCashFils: bigint
  /** Which accounts that position is the sum of, so the figure drills (ADR 0064's cash set). */
  readonly cashAccountCodes: readonly AccountCode[]
  readonly recurringCosts: readonly ForecastCostOccurrence[]
  readonly forwardBookings: readonly ForwardBooking[]
  readonly showUpRate: ShowUpRate
  readonly payroll: ForecastPayroll
}

// --- the lines -----------------------------------------------------------------------------------

/** One drillable line of one week. There is no other kind: a subtotal is a sum of these. */
export interface ForecastLine {
  readonly lineId: string
  readonly label: string
  readonly direction: 'inflow' | 'outflow'
  readonly figure: ForecastFigure
  /** The ids a drill-down reads: appointment ids, recurring cost codes, employee ids. */
  readonly drillsTo: readonly string[]
}

export interface ForecastWeek {
  /** 1 to 13. */
  readonly weekNumber: number
  readonly fromInclusive: LocalDate
  readonly toInclusive: LocalDate
  readonly openingCash: ForecastFigure
  readonly lines: readonly ForecastLine[]
  readonly totalInflows: ForecastFigure
  readonly totalOutflows: ForecastFigure
  readonly closingCash: ForecastFigure
  /**
   * `opening + inflows − outflows − closing`. Zero — and `null` when a figure in it is refused.
   *
   * `null` rather than 0, because a week whose outflow is `unattributable` has no identity to satisfy:
   * treating the missing figure as zero would make the week articulate, which is the artefact asserting
   * that an unknown is nil — the exact substitution ADR 0070 is against, arriving through the back door
   * of a check rather than through a figure. A null is visible; a satisfied identity over a missing
   * number is not.
   */
  readonly articulationDifferenceFils: bigint | null
  /** This week's opening less the previous week's closing. Zero; `null` when either is refused. */
  readonly chainDifferenceFils: bigint | null
}

export interface ForecastTotal {
  readonly fromInclusive: LocalDate
  readonly toInclusive: LocalDate
  readonly openingCash: ForecastFigure
  readonly totalInflows: ForecastFigure
  readonly totalOutflows: ForecastFigure
  readonly closingCash: ForecastFigure
  readonly articulationDifferenceFils: bigint | null
  /**
   * The horizon totals, summed from the LINES, less the sum of the thirteen weekly subtotals.
   *
   * Zero, and it is the one identity here that is not true by construction: see the module header.
   * `null` when a figure on either side is refused, for {@link ForecastWeek.articulationDifferenceFils}'
   * reason.
   */
  readonly totalsDifferenceFils: bigint | null
}

export interface CashForecast {
  readonly formatVersion: typeof FORECAST_FORMAT_VERSION
  readonly asOf: LocalDate
  readonly weeks: readonly ForecastWeek[]
  readonly total: ForecastTotal
  /** Every assumption any figure rests on, deduplicated, in id order. */
  readonly assumptions: readonly ForecastAssumption[]
  /** {@link FORECAST_CAVEAT} plus one sentence per assumption used. Derived, never supplied. */
  readonly caveats: readonly string[]
  /** Which cash accounts the opening position came from. */
  readonly cashAccountCodes: readonly AccountCode[]
}

// --- the arithmetic ------------------------------------------------------------------------------

const SHOW_UP_ASSUMPTION_ID = 'forecast.show_up_rate'

/**
 * The show-up rate as an assumption, so the figure it produces names it rather than absorbing it.
 *
 * The rate is a settings-registry value flagged `provisional: true` and therefore on the Unconfirmed
 * Assumptions panel (`provisionalSettings()`), which is R-REP-06's second acceptance line. It is reported
 * HERE as well because a panel is a different screen: a figure that rests on an assumption has to name it
 * where the figure is, or the reader has to already suspect there is one.
 */
export function showUpAssumption(rate: ShowUpRate): ForecastAssumption {
  return Object.freeze({
    assumptionId: SHOW_UP_ASSUMPTION_ID,
    provisional: rate.provisional,
    statement:
      `${rate.rateBp} basis points of the gross value of forward bookings is expected to show up, ` +
      `from the setting "${rate.settingKey}". No no-show policy has been agreed ` +
      `(${rate.provisional.openQuestionId}), so this is an assumption and not a measured rate: the ` +
      "realised no-show count is R-REP-04's no-show cost, over appointments that have already happened.",
  })
}

function assertInput(input: CashForecastInput): void {
  if (!Number.isInteger(input.showUpRate.rateBp)) {
    throw new AppError(
      'validation',
      `The show-up rate must be whole basis points, got ${input.showUpRate.rateBp}. A fractional rate ` +
        'would put a fraction into an integer-fils figure.',
    )
  }
  if (input.showUpRate.rateBp < 0 || BigInt(input.showUpRate.rateBp) > WHOLE_IN_BASIS_POINTS) {
    throw new AppError(
      'validation',
      `A show-up rate of ${input.showUpRate.rateBp} basis points is not a share of anything; it must ` +
        `be between 0 and ${WHOLE_IN_BASIS_POINTS}. Above the whole it would forecast more revenue than ` +
        'was booked.',
    )
  }
  // A NEGATIVE opening position is deliberately not refused. An overdrawn bank account is a real
  // position, and clamping it to zero would be the one error in an opening position nobody can see
  // afterwards — the balance still articulates. Stated here so the next reader knows the absence of a
  // check is a decision and not an omission.
  for (const occurrence of input.recurringCosts) {
    if (occurrence.expectedFils <= 0n) {
      throw new AppError(
        'validation',
        `Recurring cost ${occurrence.code} expects ${occurrence.expectedFils} fils on ` +
          `${occurrence.dueDate}. A cost of zero is a missing amount and not a free contract — ` +
          '`validateRecurringCost` refuses one at the register, so this is a read that lost it.',
      )
    }
  }
  for (const booking of input.forwardBookings) {
    if (booking.snapshotGrossFils < 0n) {
      throw new AppError(
        'validation',
        `Booking ${booking.appointmentId} carries a negative snapshotted gross ` +
          `(${booking.snapshotGrossFils} fils), which would make a forward booking an outflow.`,
      )
    }
  }
  if (input.payroll.state === 'scheduled') {
    for (const occurrence of input.payroll.occurrences) {
      if (occurrence.grossFils < 0n) {
        throw new AppError(
          'validation',
          `The payroll settlement for ${occurrence.periodKey} is ${occurrence.grossFils} fils. A ` +
            'negative wage bill would make payroll an inflow.',
        )
      }
    }
  } else if (input.payroll.openQuestionIds.length === 0) {
    // A refusal with no open question behind it is a refusal nobody can act on, which is the state
    // `calendar_observance_provisional_names_a_question` refuses one layer down (migration 0110).
    throw new AppError(
      'validation',
      'The payroll input refuses without naming an open question. A figure withheld for a reason ' +
        'nobody can look up is indistinguishable from one withheld by accident.',
    )
  }
}

/** The thirteen windows, as `[from, to]` pairs of trading dates, starting at `asOf`. */
export function forecastWindows(
  asOf: LocalDate,
  weeks = FORECAST_WEEKS,
): readonly {
  readonly weekNumber: number
  readonly fromInclusive: LocalDate
  readonly toInclusive: LocalDate
}[] {
  if (!Number.isInteger(weeks) || weeks < 1) {
    throw new AppError('validation', `A forecast covers at least one week; received ${weeks}`)
  }
  // Consecutive 7-day windows anchored on `asOf`, and NOT ISO weeks. An ISO-week forecast has a partial
  // first week whose figure is not comparable with the twelve after it, and the first week is the one
  // anybody acts on. `horizonDates` is core's own date enumerator, so "the next calendar date" is stated
  // once in this package.
  const dates = horizonDates(asOf, weeks * DAYS_PER_FORECAST_WEEK)
  return Object.freeze(
    Array.from({ length: weeks }, (_unused, index) => {
      const from = dates[index * DAYS_PER_FORECAST_WEEK]
      const to = dates[(index + 1) * DAYS_PER_FORECAST_WEEK - 1]
      if (from === undefined || to === undefined) {
        throw new AppError('invariant_violated', `The horizon is short of week ${index + 1}`)
      }
      return Object.freeze({ weekNumber: index + 1, fromInclusive: from, toInclusive: to })
    }),
  )
}

const within = (date: LocalDate, from: LocalDate, to: LocalDate): boolean =>
  date >= from && date <= to

/** The forward-booking inflow for one week: `round_half_up(Σ snapshotted gross × rate ÷ 10000)`. */
function bookingsFor(
  bookings: readonly ForwardBooking[],
  rate: ShowUpRate,
): { readonly figure: ForecastFigure; readonly drillsTo: readonly string[] } {
  const ids = bookings.map((booking) => booking.appointmentId).sort()
  if (bookings.length === 0) {
    return {
      figure: Object.freeze({
        state: 'none_by_construction' as const,
        basis:
          'No appointment in the diary has a trading date in this week. An empty diary is a fact about ' +
          'the diary; it is not a forecast of no revenue, and a week beyond the booking window will ' +
          'read this way whatever demand turns out to be.',
      }),
      drillsTo: ids,
    }
  }
  const gross = bookings.reduce((total, booking) => total + booking.snapshotGrossFils, 0n)
  // Rounded ONCE per week, because the rate applies to the POPULATION and not to one booking: a single
  // appointment either happens or it does not. Rounding per booking and summing is a different figure,
  // and the week is the unit this report is published in — so the horizon total is the sum of the
  // thirteen rounded weeks and never a re-rounding of the horizon, which would differ by up to twelve
  // fils and break the articulation.
  return {
    figure: Object.freeze({
      state: 'projected' as const,
      fils: divideHalfUp(gross * BigInt(rate.rateBp), WHOLE_IN_BASIS_POINTS),
      assumptionIds: Object.freeze([SHOW_UP_ASSUMPTION_ID]),
    }),
    drillsTo: ids,
  }
}

/** The recurring-cost outflow for one week. A fixed amount is committed; a band's top is projected. */
function costsFor(occurrences: readonly ForecastCostOccurrence[]): {
  readonly figure: ForecastFigure
  readonly drillsTo: readonly string[]
} {
  const codes = [...new Set(occurrences.map((occurrence) => occurrence.code))].sort()
  const parts = occurrences.map(
    (occurrence): ForecastFigure =>
      occurrence.costKind === 'fixed'
        ? Object.freeze({
            state: 'committed' as const,
            fils: occurrence.expectedFils,
            evidence: `${occurrence.code}: the contracted amount, due ${occurrence.dueDate}`,
          })
        : Object.freeze({
            state: 'projected' as const,
            fils: occurrence.expectedFils,
            // The band's own id rather than a shared one: a utility recharge and a laundry volume are
            // two different assumptions and a reader deciding which to question needs them apart.
            assumptionIds: Object.freeze([`recurring_cost.${occurrence.code}.band_top`]),
          }),
  )
  return {
    figure: combineFigures(
      parts,
      'the contracted amounts of the occurrences due in this week',
      'No recurring cost falls due in this week. That is a fact about the contracts in the register, ' +
        'not a week with no costs: a cost nobody has registered is invisible to this line.',
    ),
    drillsTo: codes,
  }
}

/**
 * The payroll outflow for one week.
 *
 * A refusal propagates to EVERY week rather than only to the weeks a settlement would have fallen in,
 * and that is the decision rather than a shortcut: when the pay date is unknown, which weeks the wage
 * bill belongs to is exactly what is unknown — so a week reported as nil would be claiming the money
 * does not leave then, which is the claim nobody can make. ADR 0070's direction argument is sharper here
 * than anywhere else in the build: an understated outflow OVERSTATES closing cash, on the screen
 * somebody decides whether they can pay the rent from.
 */
function payrollFor(
  payroll: ForecastPayroll,
  week: {
    readonly weekNumber: number
    readonly fromInclusive: LocalDate
    readonly toInclusive: LocalDate
  },
): { readonly figure: ForecastFigure; readonly drillsTo: readonly string[] } {
  if (payroll.state === 'unattributable') {
    return {
      figure: Object.freeze({
        state: 'unattributable' as const,
        why: `Week ${week.weekNumber} has no payroll figure. ${payroll.why}`,
        missing: payroll.missing,
        openQuestionIds: payroll.openQuestionIds,
      }),
      drillsTo: [],
    }
  }
  const due = payroll.occurrences.filter((occurrence) =>
    within(occurrence.dueDate, week.fromInclusive, week.toInclusive),
  )
  return {
    figure: combineFigures(
      due.map((occurrence) =>
        Object.freeze({
          state: 'committed' as const,
          fils: occurrence.grossFils,
          evidence: `payroll for ${occurrence.periodKey}, settling ${occurrence.dueDate}`,
        }),
      ),
      'the wage bill of the payroll settlements falling due in this week',
      'No payroll settlement falls due in this week. Payroll leaves the bank on a pay date, so most ' +
        'weeks of a 13-week horizon have none — which is a fact about the pay cycle and not a week of ' +
        'free staff.',
    ),
    drillsTo: due.map((occurrence) => occurrence.periodKey).sort(),
  }
}

/** The forecast. Pure: the same input gives the same object, always. */
export function cashForecast(input: CashForecastInput, weeks = FORECAST_WEEKS): CashForecast {
  assertInput(input)
  const windows = forecastWindows(input.asOf, weeks)
  const assumptions = new Map<string, ForecastAssumption>()
  const showUp = showUpAssumption(input.showUpRate)

  const built: ForecastWeek[] = []
  let opening: ForecastFigure = Object.freeze({
    state: 'measured' as const,
    fils: input.openingCashFils,
    evidence:
      `the ledger position of ${input.cashAccountCodes.join(', ')} at ${input.asOf}, which is the ` +
      "balance sheet's own cash line (ADR 0064)",
  })

  for (const window of windows) {
    const bookings = bookingsFor(
      input.forwardBookings.filter((booking) =>
        within(booking.tradingDate, window.fromInclusive, window.toInclusive),
      ),
      input.showUpRate,
    )
    if (bookings.figure.state === 'projected') assumptions.set(showUp.assumptionId, showUp)

    const costs = costsFor(
      input.recurringCosts.filter((occurrence) =>
        within(occurrence.dueDate, window.fromInclusive, window.toInclusive),
      ),
    )
    for (const id of assumptionsOf(costs.figure)) {
      if (!assumptions.has(id)) {
        assumptions.set(
          id,
          Object.freeze({
            assumptionId: id,
            // No open question: see ForecastAssumption. The band is the register's own data and the
            // choice of its TOP is `prudentExpectation`'s rule, not a figure awaiting an answer.
            provisional: null,
            statement:
              `the top of the band declared for recurring cost "${id.split('.')[1] ?? id}" is held as ` +
              'its expected amount, because a variable cost has no single contracted figure and a plan ' +
              'built on the middle of every band is short of cash in about half the months it covers',
          }),
        )
      }
    }

    const payroll = payrollFor(input.payroll, window)

    const lines: ForecastLine[] = [
      Object.freeze({
        lineId: 'forward_bookings',
        label: 'Forward bookings at their snapshotted price, after the show-up rate',
        direction: 'inflow' as const,
        figure: bookings.figure,
        drillsTo: bookings.drillsTo,
      }),
      Object.freeze({
        lineId: 'recurring_costs',
        label: 'Recurring costs falling due',
        direction: 'outflow' as const,
        figure: costs.figure,
        drillsTo: costs.drillsTo,
      }),
      Object.freeze({
        lineId: 'payroll',
        label: 'Payroll for the rostered shifts',
        direction: 'outflow' as const,
        figure: payroll.figure,
        drillsTo: payroll.drillsTo,
      }),
    ]

    const totalInflows = combineFigures(
      lines.filter((line) => line.direction === 'inflow').map((line) => line.figure),
      'the inflow lines of this week',
      'No inflow line has anything in it this week.',
    )
    const totalOutflows = combineFigures(
      lines.filter((line) => line.direction === 'outflow').map((line) => line.figure),
      'the outflow lines of this week',
      'No outflow line has anything in it this week.',
    )
    // `closing` is DEFINED as opening + in − out, which is why the weekly articulation is zero by
    // construction and why the module header says what it does and does not prove. The subtraction is
    // expressed as a sum with the outflow negated so that `combineFigures`' weakening rule applies to
    // it unchanged — a second combinator for subtraction would be a second place for the lattice to be
    // stated.
    const negatedOutflows: ForecastFigure =
      totalOutflows.state === 'unattributable' || totalOutflows.state === 'none_by_construction'
        ? totalOutflows
        : totalOutflows.state === 'projected'
          ? Object.freeze({
              state: 'projected' as const,
              fils: -totalOutflows.fils,
              assumptionIds: totalOutflows.assumptionIds,
            })
          : Object.freeze({
              state: totalOutflows.state,
              fils: -totalOutflows.fils,
              evidence: totalOutflows.evidence,
            })
    const closing = combineFigures(
      [opening, totalInflows, negatedOutflows],
      "the opening position carried forward with this week's forecast movements",
      'Nothing is known about this week at all.',
    )

    const previousClosing = built.at(-1)?.closingCash
    built.push(
      Object.freeze({
        weekNumber: window.weekNumber,
        fromInclusive: window.fromInclusive,
        toInclusive: window.toInclusive,
        openingCash: opening,
        lines: Object.freeze(lines),
        totalInflows,
        totalOutflows,
        closingCash: closing,
        articulationDifferenceFils: addFigures(
          [opening, 1n],
          [totalInflows, 1n],
          [totalOutflows, -1n],
          [closing, -1n],
        ),
        chainDifferenceFils:
          previousClosing === undefined ? 0n : addFigures([opening, 1n], [previousClosing, -1n]),
      }),
    )
    opening = closing
  }

  // The horizon totals are summed from the LINES across all thirteen weeks, independently of the weekly
  // subtotals, and `totalsDifferenceFils` holds the two readings equal. See the module header.
  const everyLine = built.flatMap((week) => week.lines)
  const horizonInflows = combineFigures(
    everyLine.filter((line) => line.direction === 'inflow').map((line) => line.figure),
    'every inflow line of the horizon',
    'No inflow line has anything in it across the whole horizon.',
  )
  const horizonOutflows = combineFigures(
    everyLine.filter((line) => line.direction === 'outflow').map((line) => line.figure),
    'every outflow line of the horizon',
    'No outflow line has anything in it across the whole horizon.',
  )
  const firstWeek = built[0]
  const lastWeek = built.at(-1)
  if (firstWeek === undefined || lastWeek === undefined) {
    throw new AppError('invariant_violated', 'A forecast with no weeks cannot have been built')
  }

  const used = [...assumptions.values()].sort((a, b) =>
    a.assumptionId.localeCompare(b.assumptionId),
  )
  return Object.freeze({
    formatVersion: FORECAST_FORMAT_VERSION,
    asOf: input.asOf,
    weeks: Object.freeze(built),
    total: Object.freeze({
      fromInclusive: firstWeek.fromInclusive,
      toInclusive: lastWeek.toInclusive,
      openingCash: firstWeek.openingCash,
      totalInflows: horizonInflows,
      totalOutflows: horizonOutflows,
      closingCash: lastWeek.closingCash,
      articulationDifferenceFils: addFigures(
        [firstWeek.openingCash, 1n],
        [horizonInflows, 1n],
        [horizonOutflows, -1n],
        [lastWeek.closingCash, -1n],
      ),
      // Two independent readings of one quantity: the horizon totals summed from every line, and the
      // sum of the thirteen weekly subtotals. Null as soon as either side holds a refusal, for the same
      // reason the weekly identity is.
      totalsDifferenceFils: (() => {
        const horizon = addFigures([horizonInflows, 1n], [horizonOutflows, -1n])
        const weekly = addFigures(
          ...built.flatMap((week): readonly (readonly [ForecastFigure, 1n | -1n])[] => [
            [week.totalInflows, 1n],
            [week.totalOutflows, -1n],
          ]),
        )
        return horizon === null || weekly === null ? null : horizon - weekly
      })(),
    }),
    assumptions: Object.freeze(used),
    caveats: Object.freeze([FORECAST_CAVEAT, ...used.map((assumption) => assumption.statement)]),
    cashAccountCodes: Object.freeze([...input.cashAccountCodes]),
  })
}

// --- the bytes -----------------------------------------------------------------------------------

/**
 * The forecast as bytes, deterministically: keys sorted recursively, every `bigint` a decimal string.
 *
 * The fifth acceptance line is "two runs under the frozen clock produce byte-identical forecast output",
 * and that needs a canonical form: `JSON.stringify` preserves INSERTION order, so the bytes would depend
 * on the order this module happened to build an object in, and `bigint` has no JSON representation at all
 * — `JSON.stringify` throws on one, which is the good failure, because a figure silently becoming `null`
 * is how a cash total disappears from an artefact somebody is comparing.
 *
 * It is the same canonical form as `canonicaliseVat201WorkingPapers` / `statementBytes`, which is a
 * SECOND statement of one function — unavoidable, because that one is in `packages/db` and `packages/core`
 * may not import it (ADR 0001), and moving it into `@berelax/shared` would be editing two other units'
 * modules to no purpose of this one's. So it arrives with the check that holds the two equal in the same
 * commit: `packages/fixtures/src/cash-forecast.itest.ts` asserts `forecastBytes(f) === statementBytes(f)`
 * over a real forecast, in the one package that may import both.
 */
export function forecastBytes(forecast: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (typeof value === 'bigint') return value.toString()
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      )
    }
    return value
  }
  return JSON.stringify(canonical(forecast))
}

// --- the rules -----------------------------------------------------------------------------------

/**
 * Every way a built forecast fails to be one, as named findings.
 *
 * Findings over an ARGUMENT rather than throws inside the builder, for `statementLayoutFindings`' and
 * `kpiRegistryFindings`' reason (ADR 0003): a rule that stops matching reports nothing, and "the forecast
 * articulates" then passes over one that does not. A test can hand this a forecast that DOES violate each
 * rule and read back which rule fired, and `scripts/test-gates.mjs` block 151 blinds each detector and
 * requires its own name back.
 */
export const FORECAST_RULES = [
  'forecast-week-articulates-to-the-fils',
  'forecast-weeks-chain-opening-to-previous-closing',
  'forecast-total-is-the-sum-of-its-weeks',
  'forecast-covers-exactly-thirteen-consecutive-weeks',
  'forecast-carries-the-caveat-no-input-can-remove',
  'forecast-projected-figure-names-its-assumptions',
  'forecast-measured-figure-is-the-opening-position-only',
] as const
export type ForecastRule = (typeof FORECAST_RULES)[number]

export interface ForecastFinding {
  readonly rule: ForecastRule
  readonly detail: string
}

export function forecastFindings(forecast: CashForecast): readonly ForecastFinding[] {
  const findings: ForecastFinding[] = []
  for (const week of forecast.weeks) {
    // A null difference is a week with a refused figure in it, which has no identity to satisfy — see
    // `ForecastWeek.articulationDifferenceFils`. Reporting it as a failure would make every refusal look
    // like broken arithmetic, and silently treating it as zero would make the artefact claim the missing
    // figure was nil.
    if (week.articulationDifferenceFils !== null && week.articulationDifferenceFils !== 0n) {
      findings.push({
        rule: 'forecast-week-articulates-to-the-fils',
        detail:
          `week ${week.weekNumber} is out by ${week.articulationDifferenceFils} fils: opening plus ` +
          'forecast inflows less forecast outflows is not its closing cash',
      })
    }
    if (week.chainDifferenceFils !== null && week.chainDifferenceFils !== 0n) {
      findings.push({
        rule: 'forecast-weeks-chain-opening-to-previous-closing',
        detail:
          `week ${week.weekNumber} opens ${week.chainDifferenceFils} fils away from week ` +
          `${week.weekNumber - 1}'s closing cash. A week that re-read the ledger half way through the ` +
          'horizon would present a jump nobody could drill to',
      })
    }
  }
  const totalsOut =
    forecast.total.totalsDifferenceFils !== null && forecast.total.totalsDifferenceFils !== 0n
  const totalOut =
    forecast.total.articulationDifferenceFils !== null &&
    forecast.total.articulationDifferenceFils !== 0n
  if (totalsOut || totalOut) {
    findings.push({
      rule: 'forecast-total-is-the-sum-of-its-weeks',
      detail:
        `the horizon totals summed from the lines differ from the sum of the weekly subtotals by ` +
        `${forecast.total.totalsDifferenceFils} fils, and the total row articulates to ` +
        `${forecast.total.articulationDifferenceFils}. A line dropped from one week keeps every weekly ` +
        'identity and fails only this one',
    })
  }

  const expected = forecastWindows(forecast.asOf, FORECAST_WEEKS)
  const misaligned = expected.filter((window, index) => {
    const week = forecast.weeks[index]
    return (
      week === undefined ||
      week.fromInclusive !== window.fromInclusive ||
      week.toInclusive !== window.toInclusive
    )
  })
  if (forecast.weeks.length !== FORECAST_WEEKS || misaligned.length > 0) {
    findings.push({
      rule: 'forecast-covers-exactly-thirteen-consecutive-weeks',
      detail:
        `the forecast holds ${forecast.weeks.length} week(s) and ${misaligned.length} of them do not ` +
        `match the ${DAYS_PER_FORECAST_WEEK}-day windows from ${forecast.asOf}. A horizon that ends ` +
        'early looks exactly like a business with no costs in week thirteen',
    })
  }
  if (!forecast.caveats.includes(FORECAST_CAVEAT)) {
    findings.push({
      rule: 'forecast-carries-the-caveat-no-input-can-remove',
      detail:
        'the artefact does not carry FORECAST_CAVEAT. Every figure in it except the opening position ' +
        'is a claim about the future, and a reader who is not told that will read the closing cash of ' +
        'week nine as a balance',
    })
  }

  const declared = new Set(forecast.assumptions.map((assumption) => assumption.assumptionId))
  const everyFigure = [
    ...forecast.weeks.flatMap((week) => [
      week.openingCash,
      week.totalInflows,
      week.totalOutflows,
      week.closingCash,
      ...week.lines.map((line) => line.figure),
    ]),
    forecast.total.openingCash,
    forecast.total.totalInflows,
    forecast.total.totalOutflows,
    forecast.total.closingCash,
  ]
  const undeclared = [
    ...new Set(
      everyFigure.flatMap((figure) =>
        figure.state === 'projected' ? figure.assumptionIds.filter((id) => !declared.has(id)) : [],
      ),
    ),
  ].sort()
  const unnamed = everyFigure.filter(
    (figure) => figure.state === 'projected' && figure.assumptionIds.length === 0,
  ).length
  if (undeclared.length > 0 || unnamed > 0) {
    findings.push({
      rule: 'forecast-projected-figure-names-its-assumptions',
      detail:
        `${unnamed} projected figure(s) name no assumption at all and [${undeclared.join(', ')}] are ` +
        'named on a figure and not declared on the artefact. A projection whose assumption is not on ' +
        'the artefact is a number with no visible reason to doubt it',
    })
  }

  const measured = everyFigure.filter((figure) => figure.state === 'measured')
  const openings = forecast.weeks.filter((week) => week.openingCash.state === 'measured').length
  if (measured.length > openings + 1 || openings > 1) {
    findings.push({
      rule: 'forecast-measured-figure-is-the-opening-position-only',
      detail:
        `${measured.length} figure(s) in this forecast claim to be measured and at most one may: the ` +
        'opening cash position, which appears on week 1 and on the total row. Anything else measured ' +
        'is a figure about the future that a screen will render as a fact',
    })
  }
  return findings
}

/** Throws naming every rule that fired. */
export function assertForecast(forecast: CashForecast): void {
  const findings = forecastFindings(forecast)
  if (findings.length === 0) return
  throw new AppError(
    'invariant_violated',
    'The cash-flow forecast does not articulate. ' +
      findings.map((finding) => `${finding.rule}: ${finding.detail}`).join('; '),
    { details: { rules: findings.map((finding) => finding.rule) } },
  )
}
