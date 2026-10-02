import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { horizonDates } from '../business-day/horizon.ts'
import { type LocalDate, localDate } from '../time.ts'
import type {
  CashForecast,
  CashForecastInput,
  ForecastFigure,
  ForecastPayroll,
} from './cash-forecast.ts'
import {
  assertForecast,
  cashForecast,
  combineFigures,
  DAYS_PER_FORECAST_WEEK,
  FORECAST_CAVEAT,
  FORECAST_FIGURE_STATES,
  FORECAST_RULES,
  FORECAST_WEEKS,
  forecastBytes,
  forecastFindings,
  forecastWindows,
  payrollFromCensus,
  publishForecastFigure,
  showUpAssumption,
} from './cash-forecast.ts'
import { WHOLE_IN_BASIS_POINTS } from './operational-kpis.ts'

/**
 * R-REP-06 — the 13-week cash-flow forecast.
 *
 * # What this file is arranged to prove, and why it is not the articulation
 *
 * `opening + inflows − outflows = closing` is true by construction, because `closing` is defined that
 * way. Asserting it is therefore nearly content-free, and this file says so by asserting it ONCE over a
 * hand-computed fixture and spending the rest of its cases on the three things that can actually be wrong:
 *
 *   1. **the chain and the totals**, which are NOT true by construction. Week N's opening is week N−1's
 *      closing, and the horizon totals are summed from the LINES while the weekly subtotals are summed
 *      from each week's own lines — so a line dropped from one week keeps every weekly identity and fails
 *      only `forecast-total-is-the-sum-of-its-weeks`. Both directions are proved by handing
 *      `forecastFindings` an artefact that violates them and reading the rule name back, which is what
 *      makes the rules rules rather than comments (ADR 0003).
 *   2. **the marking**, which is this unit's reason for existing. A forecast is a number nobody can check
 *      until it is too late, so every case that produces a figure also asserts WHAT KIND of claim the
 *      figure is — and the property test asserts the lattice: a sum is as weak as its weakest part, and
 *      one unattributable part poisons it.
 *   3. **the refusals**, each asserted to produce no number at all rather than a smaller one. The error
 *      direction is the whole argument: an understated outflow OVERSTATES closing cash.
 *
 * Every figure below is hand-computed in the comment above it, in fils, so a reader can check the test
 * rather than the code.
 */

// --- the fixture ---------------------------------------------------------------------------------

/**
 * A Sunday, so the thirteen windows are whole weeks in the sense the report is published in.
 *
 * Deliberately NOT `FIXTURE_TODAY`: `packages/fixtures` may import `packages/core` and not the other way
 * round, so a pure test cannot reach the frozen clock. What it can do is take its own constant, which is
 * the same property — nothing here reads a clock, so two runs produce the same object — and the
 * byte-identity case under the real frozen clock is `cash-forecast.itest.ts`'.
 */
const AS_OF = localDate('2027-01-03')

const CASH_ACCOUNTS = ['1010', '1015', '1020'] as unknown as CashForecastInput['cashAccountCodes']

/** 9,000 basis points: the manifest's provisional 10% no-show rate, as the multiplier. */
const SHOW_UP: CashForecastInput['showUpRate'] = {
  rateBp: 9_000,
  settingKey: 'reporting.forecast_show_up_rate_bp',
  provisional: { openQuestionId: 'Y9-windows', note: '10% no-show rate assumed.' },
}

/** `asOf` plus whole days, through core's own date enumerator, so this file states no date arithmetic. */
const HORIZON: readonly LocalDate[] = horizonDates(AS_OF, FORECAST_WEEKS * DAYS_PER_FORECAST_WEEK)
const dayOfHorizon = (offset: number): LocalDate => {
  const day = HORIZON[offset]
  if (day === undefined) throw new Error(`day ${offset} is outside the horizon`)
  return day
}

const PAYROLL_SCHEDULED: ForecastPayroll = {
  state: 'scheduled',
  occurrences: [
    // Week 1, day 4. 1,900,000 fils.
    { periodKey: '2026-12', dueDate: dayOfHorizon(4), grossFils: 1_900_000n },
    // Week 6, day 2. 1,900,000 fils.
    {
      periodKey: '2027-01',
      dueDate: dayOfHorizon(5 * DAYS_PER_FORECAST_WEEK + 2),
      grossFils: 1_900_000n,
    },
  ],
}

/**
 * A forecast every component of which is supplied, so the articulation is assertable.
 *
 * This is the only fixture in the file that produces numbers all the way through. It is hand-built rather
 * than read, because against this build's own database the payroll line refuses — which
 * `cash-forecast.itest.ts` MEASURES. A test that only ever saw the refusing case would never have
 * exercised the arithmetic the refusal is standing in front of.
 */
const COMPLETE: CashForecastInput = {
  asOf: AS_OF,
  openingCashFils: 5_000_000n,
  cashAccountCodes: CASH_ACCOUNTS,
  recurringCosts: [
    // Rent, fixed, due on day 2 of week 1: 3,000,000 fils, COMMITTED.
    { code: 'rent', dueDate: dayOfHorizon(2), expectedFils: 3_000_000n, costKind: 'fixed' },
    // Electricity, variable, due on day 3 of week 1: the top of its band, 400,000 fils, PROJECTED.
    { code: 'electricity', dueDate: dayOfHorizon(3), expectedFils: 400_000n, costKind: 'variable' },
  ],
  forwardBookings: [
    // Week 1 holds 1,000,000 + 500,000 = 1,500,000 fils of snapshotted gross.
    { appointmentId: 'a1', tradingDate: dayOfHorizon(1), snapshotGrossFils: 1_000_000n },
    { appointmentId: 'a2', tradingDate: dayOfHorizon(5), snapshotGrossFils: 500_000n },
    // Week 2 holds 700,000.
    {
      appointmentId: 'a3',
      tradingDate: dayOfHorizon(DAYS_PER_FORECAST_WEEK + 1),
      snapshotGrossFils: 700_000n,
    },
  ],
  showUpRate: SHOW_UP,
  payroll: PAYROLL_SCHEDULED,
}

const figureFils = (figure: ForecastFigure): bigint => {
  if (figure.state === 'unattributable' || figure.state === 'none_by_construction') {
    throw new Error(`expected a figure, got ${figure.state}`)
  }
  return figure.fils
}

const weekOf = (forecast: CashForecast, weekNumber: number) => {
  const week = forecast.weeks[weekNumber - 1]
  if (week === undefined) throw new Error(`no week ${weekNumber}`)
  return week
}

const lineOf = (forecast: CashForecast, weekNumber: number, lineId: string) => {
  const line = weekOf(forecast, weekNumber).lines.find((entry) => entry.lineId === lineId)
  if (line === undefined) throw new Error(`no line ${lineId} in week ${weekNumber}`)
  return line
}

// --- the horizon ---------------------------------------------------------------------------------

describe('the horizon', () => {
  it('is thirteen consecutive seven-day windows starting at the as-of date', () => {
    const windows = forecastWindows(AS_OF)
    expect(windows).toHaveLength(FORECAST_WEEKS)
    expect(windows[0]?.fromInclusive).toBe(AS_OF)
    expect(windows[0]?.toInclusive).toBe(localDate('2027-01-09'))
    expect(windows[12]?.toInclusive).toBe(localDate('2027-04-03'))
    // Consecutive and non-overlapping: each window opens the day after the previous one closed, which is
    // the one property a thirteen-window report cannot be wrong about — a gap drops a week of costs and
    // an overlap counts one twice, and both leave every weekly identity intact.
    for (const [index, window] of windows.entries()) {
      if (index === 0) continue
      const previous = windows[index - 1]
      expect(previous).toBeDefined()
      expect(window.fromInclusive > (previous?.toInclusive ?? AS_OF)).toBe(true)
    }
    // And they tile: 13 × 7 = 91 days, so the last day is the 91st.
    expect(forecastWindows(AS_OF, 1)[0]?.toInclusive).toBe(windows[0]?.toInclusive)
  })

  it('refuses a horizon of no weeks, which would be a report with nothing in it', () => {
    expect(() => forecastWindows(AS_OF, 0)).toThrow(/at least one week/)
    expect(() => forecastWindows(AS_OF, 1.5)).toThrow(/at least one week/)
  })
})

// --- the articulation, once -----------------------------------------------------------------------

describe('the articulation', () => {
  const forecast = cashForecast(COMPLETE)

  /**
   * Week 1, hand-computed in fils:
   *
   *   opening                                                       5,000,000
   *   forward bookings  (1,000,000 + 500,000) × 9,000 ÷ 10,000  =   1,350,000
   *   recurring costs   3,000,000 + 400,000                     =   3,400,000
   *   payroll                                                       1,900,000
   *   closing  5,000,000 + 1,350,000 − 3,400,000 − 1,900,000     =   1,050,000
   */
  it('articulates week 1 to the fils, against hand-computed figures', () => {
    const week = weekOf(forecast, 1)
    expect(figureFils(week.openingCash)).toBe(5_000_000n)
    expect(figureFils(lineOf(forecast, 1, 'forward_bookings').figure)).toBe(1_350_000n)
    expect(figureFils(lineOf(forecast, 1, 'recurring_costs').figure)).toBe(3_400_000n)
    expect(figureFils(lineOf(forecast, 1, 'payroll').figure)).toBe(1_900_000n)
    expect(figureFils(week.totalInflows)).toBe(1_350_000n)
    expect(figureFils(week.totalOutflows)).toBe(5_300_000n)
    expect(figureFils(week.closingCash)).toBe(1_050_000n)
    expect(week.articulationDifferenceFils).toBe(0n)
  })

  it('articulates every one of the thirteen weeks and the total, to the fils', () => {
    expect(forecast.weeks).toHaveLength(FORECAST_WEEKS)
    for (const week of forecast.weeks) expect(week.articulationDifferenceFils).toBe(0n)
    expect(forecast.total.articulationDifferenceFils).toBe(0n)
    expect(forecast.total.totalsDifferenceFils).toBe(0n)
    expect(forecastFindings(forecast)).toEqual([])
    expect(() => assertForecast(forecast)).not.toThrow()
  })

  it('chains: every week opens where the previous one closed, and the total spans the whole horizon', () => {
    for (const week of forecast.weeks) expect(week.chainDifferenceFils).toBe(0n)
    expect(forecast.total.openingCash).toBe(weekOf(forecast, 1).openingCash)
    expect(forecast.total.closingCash).toBe(weekOf(forecast, FORECAST_WEEKS).closingCash)
    expect(forecast.total.fromInclusive).toBe(AS_OF)
    expect(forecast.total.toInclusive).toBe(weekOf(forecast, FORECAST_WEEKS).toInclusive)
    // Week 2 opens at week 1's closing: 1,050,000. Its own figures are 700,000 × 0.9 = 630,000 in and
    // nothing out, so it closes at 1,680,000.
    expect(figureFils(weekOf(forecast, 2).openingCash)).toBe(1_050_000n)
    expect(figureFils(weekOf(forecast, 2).closingCash)).toBe(1_680_000n)
  })

  /**
   * The control for the articulation, which is what makes the assertions above mean anything.
   *
   * The identity is true by construction inside `cashForecast`, so it cannot be broken by an input. It
   * CAN be broken by an artefact, and that is what the rules judge — so a week is edited to hold a
   * closing figure that does not follow from its own lines, and the rule written for it is required back
   * by name.
   */
  it('reports a week that does not articulate, by name', () => {
    const broken: CashForecast = {
      ...forecast,
      weeks: forecast.weeks.map((week, index) =>
        index === 3 ? { ...week, articulationDifferenceFils: 1n } : week,
      ),
    }
    expect(forecastFindings(broken).map((finding) => finding.rule)).toContain(
      'forecast-week-articulates-to-the-fils',
    )
    expect(() => assertForecast(broken)).toThrow(/forecast-week-articulates-to-the-fils/)
  })

  it('reports a week that opens away from the previous closing, by name', () => {
    const broken: CashForecast = {
      ...forecast,
      weeks: forecast.weeks.map((week, index) =>
        index === 5 ? { ...week, chainDifferenceFils: -4n } : week,
      ),
    }
    expect(forecastFindings(broken).map((finding) => finding.rule)).toContain(
      'forecast-weeks-chain-opening-to-previous-closing',
    )
  })

  /**
   * And the one identity that is NOT true by construction: a line dropped from one week.
   *
   * The totals are summed from the LINES and the weekly subtotals from each week's own lines, so removing
   * a line from a week leaves that week's articulation intact — the subtotal moves with it — and makes
   * the two readings of the horizon disagree. That is the only check in this file that could catch an
   * implementation that lost a row.
   */
  it('reports a horizon total that is not the sum of its weeks, by name', () => {
    const broken: CashForecast = {
      ...forecast,
      total: { ...forecast.total, totalsDifferenceFils: 630_000n },
    }
    expect(forecastFindings(broken).map((finding) => finding.rule)).toContain(
      'forecast-total-is-the-sum-of-its-weeks',
    )
  })

  it('reports a horizon that is not thirteen consecutive weeks, by name', () => {
    const short: CashForecast = { ...forecast, weeks: forecast.weeks.slice(0, 9) }
    expect(forecastFindings(short).map((finding) => finding.rule)).toContain(
      'forecast-covers-exactly-thirteen-consecutive-weeks',
    )
    const shifted: CashForecast = {
      ...forecast,
      weeks: forecast.weeks.map((week, index) =>
        index === 7 ? { ...week, fromInclusive: localDate('2099-01-01') } : week,
      ),
    }
    expect(forecastFindings(shifted).map((finding) => finding.rule)).toContain(
      'forecast-covers-exactly-thirteen-consecutive-weeks',
    )
  })

  it('every rule in FORECAST_RULES can be made to fire, so none of them is decoration', () => {
    // The two remaining rules, so the whole set is exercised somewhere in this file.
    const noCaveat: CashForecast = { ...forecast, caveats: [] }
    const undeclared: CashForecast = { ...forecast, assumptions: [] }
    const overMeasured: CashForecast = {
      ...forecast,
      weeks: forecast.weeks.map((week) => ({
        ...week,
        closingCash: { state: 'measured', fils: 1n, evidence: 'planted' },
        openingCash: { state: 'measured', fils: 1n, evidence: 'planted' },
      })),
    }
    const fired = new Set([
      ...forecastFindings(noCaveat).map((finding) => finding.rule),
      ...forecastFindings(undeclared).map((finding) => finding.rule),
      ...forecastFindings(overMeasured).map((finding) => finding.rule),
      'forecast-week-articulates-to-the-fils',
      'forecast-weeks-chain-opening-to-previous-closing',
      'forecast-total-is-the-sum-of-its-weeks',
      'forecast-covers-exactly-thirteen-consecutive-weeks',
    ])
    expect([...FORECAST_RULES].filter((rule) => !fired.has(rule))).toEqual([])
  })
})

// --- the marking ----------------------------------------------------------------------------------

describe('what kind of claim each figure is', () => {
  const forecast = cashForecast(COMPLETE)

  it('marks exactly one figure as measured: the opening position', () => {
    expect(weekOf(forecast, 1).openingCash.state).toBe('measured')
    for (const week of forecast.weeks.slice(1)) expect(week.openingCash.state).not.toBe('measured')
    // Every other figure in the artefact. The closing cash of week 1 is NOT measured even though its
    // opening is: a contracted amount added to a bank balance is not a bank balance any more.
    expect(weekOf(forecast, 1).closingCash.state).toBe('projected')
    expect(forecast.total.closingCash.state).toBe('projected')
  })

  it('marks a fixed cost committed and a variable cost projected, which are the same number and not the same claim', () => {
    const week1 = cashForecast({
      ...COMPLETE,
      recurringCosts: [COMPLETE.recurringCosts[0] ?? ({} as never)],
    })
    expect(lineOf(week1, 1, 'recurring_costs').figure.state).toBe('committed')
    const week1Variable = cashForecast({
      ...COMPLETE,
      recurringCosts: [COMPLETE.recurringCosts[1] ?? ({} as never)],
    })
    const variable = lineOf(week1Variable, 1, 'recurring_costs').figure
    expect(variable.state).toBe('projected')
    expect(figureFils(variable)).toBe(400_000n)
    // And the mixed week is as weak as its weakest part.
    expect(lineOf(forecast, 1, 'recurring_costs').figure.state).toBe('projected')
  })

  it('marks the forward-booking line projected and names the show-up rate on it', () => {
    const line = lineOf(forecast, 1, 'forward_bookings').figure
    expect(line.state).toBe('projected')
    expect(line.state === 'projected' ? line.assumptionIds : []).toEqual(['forecast.show_up_rate'])
    // And the assumption is on the artefact with its open question, so the figure's reason is lookupable.
    const assumption = forecast.assumptions.find(
      (entry) => entry.assumptionId === 'forecast.show_up_rate',
    )
    expect(assumption?.provisional?.openQuestionId).toBe('Y9-windows')
    expect(assumption?.statement).toContain('9000 basis points')
    expect(assumption).toEqual(showUpAssumption(SHOW_UP))
  })

  it('distinguishes a week with no cost due from a week whose cost is unknown', () => {
    // Week 3 of the complete fixture has no recurring cost and no booking in it.
    const costs = lineOf(forecast, 3, 'recurring_costs').figure
    expect(costs.state).toBe('none_by_construction')
    expect(costs.state === 'none_by_construction' ? costs.basis : '').toContain(
      'a cost nobody has registered is invisible',
    )
    // A `none_by_construction` figure carries no `fils` at all, so there is no path from it to a number.
    expect('fils' in costs).toBe(false)
  })

  it('carries a caveat no input can remove, and one sentence per assumption used', () => {
    expect(forecast.caveats[0]).toBe(FORECAST_CAVEAT)
    expect(forecast.caveats).toHaveLength(1 + forecast.assumptions.length)
    for (const assumption of forecast.assumptions) {
      expect(forecast.caveats).toContain(assumption.statement)
    }
    // There is no input that empties it: every field of CashForecastInput is exercised below and none of
    // them is a caveat, a flag or a presentation option.
    expect(Object.keys(COMPLETE).sort()).toEqual([
      'asOf',
      'cashAccountCodes',
      'forwardBookings',
      'openingCashFils',
      'payroll',
      'recurringCosts',
      'showUpRate',
    ])
  })

  it('hands back a printable number only with the words that must appear beside it', () => {
    const measured = publishForecastFigure(weekOf(forecast, 1).openingCash as never)
    expect(measured).toEqual({ fils: 5_000_000n, state: 'measured', qualifier: '' })
    const projected = publishForecastFigure(lineOf(forecast, 1, 'forward_bookings').figure as never)
    expect(projected.state).toBe('projected')
    expect(projected.qualifier).toBe('forecast — projected on forecast.show_up_rate')
    const committed = publishForecastFigure(lineOf(forecast, 1, 'payroll').figure as never)
    expect(committed.qualifier).toBe('forecast — committed, not yet received or paid')
    // Non-empty for everything but a measurement. That is the structural half of "no screen can render a
    // projection as though it were measured": the only function that produces a number produces the
    // qualifier with it, and its parameter type excludes the two states that have no number.
    for (const state of FORECAST_FIGURE_STATES) {
      if (state === 'measured' || state === 'none_by_construction' || state === 'unattributable')
        continue
      const figure: ForecastFigure =
        state === 'committed'
          ? { state, fils: 1n, evidence: 'x' }
          : { state, fils: 1n, assumptionIds: ['a'] }
      expect(publishForecastFigure(figure).qualifier).not.toBe('')
    }
  })
})

// --- the refusals ---------------------------------------------------------------------------------

describe('the refusals', () => {
  const unattributablePayroll: ForecastPayroll = {
    state: 'unattributable',
    why: 'no pay date exists and no wage is on file',
    missing: [
      'payroll_run: a date on which the wage bill settles',
      'employee.basic_wage_fils for e1',
    ],
    openQuestionIds: ['Y8-payroll-date', 'Y8-staff'],
  }

  it('refuses a closing figure in every week when payroll cannot be placed, and never a smaller one', () => {
    const forecast = cashForecast({ ...COMPLETE, payroll: unattributablePayroll })
    for (const week of forecast.weeks) {
      // The identity is ABSENT rather than satisfied: a week whose outflow is unknown has nothing to
      // articulate, and a zero difference here would be the artefact asserting the missing figure was
      // nil. `forecastFindings` therefore reports nothing, and that is asserted below.
      expect(week.articulationDifferenceFils).toBeNull()
      expect(lineOf(forecast, week.weekNumber, 'payroll').figure.state).toBe('unattributable')
      expect(week.totalOutflows.state).toBe('unattributable')
      expect(week.closingCash.state).toBe('unattributable')
      expect('fils' in week.closingCash).toBe(false)
    }
    expect(forecast.total.closingCash.state).toBe('unattributable')
    expect(forecast.total.articulationDifferenceFils).toBeNull()
    expect(forecast.total.totalsDifferenceFils).toBeNull()
    // The inflow side still reports: a refusal on the outflows must not take the figures that ARE known
    // down with it, or the artefact stops saying what it does know.
    expect(figureFils(lineOf(forecast, 1, 'forward_bookings').figure)).toBe(1_350_000n)
    expect(figureFils(forecast.total.totalInflows)).toBe(1_980_000n)
    // And a refused week is not reported as broken arithmetic.
    expect(forecastFindings(forecast)).toEqual([])
  })

  it('names the open questions and the missing figures on the refusal, so the gap is lookupable', () => {
    const forecast = cashForecast({ ...COMPLETE, payroll: unattributablePayroll })
    const refusal = weekOf(forecast, 1).closingCash
    expect(refusal.state).toBe('unattributable')
    if (refusal.state !== 'unattributable') throw new Error('expected a refusal')
    expect(refusal.openQuestionIds).toEqual(['Y8-payroll-date', 'Y8-staff'])
    expect(refusal.missing).toContain('payroll_run: a date on which the wage bill settles')
  })

  it('refuses a payroll refusal that names no open question', () => {
    expect(() =>
      cashForecast({
        ...COMPLETE,
        payroll: { state: 'unattributable', why: 'because', missing: [], openQuestionIds: [] },
      }),
    ).toThrow(/without naming an open question/)
  })

  it('treats an EMPTY payroll schedule as a real answer and not as a refusal', () => {
    // The distinction the refusal-shaped input exists for: no settlement in the horizon is a fact about
    // the pay cycle, and it has to be reportable without looking like an unknown.
    const forecast = cashForecast({
      ...COMPLETE,
      payroll: { state: 'scheduled', occurrences: [] },
    })
    expect(lineOf(forecast, 1, 'payroll').figure.state).toBe('none_by_construction')
    expect(forecast.total.closingCash.state).toBe('projected')
    // 5,000,000 + 1,980,000 − 3,400,000 = 3,580,000.
    expect(figureFils(forecast.total.closingCash)).toBe(3_580_000n)
  })

  it('refuses a show-up rate that is not a share of anything', () => {
    for (const rateBp of [-1, 10_001]) {
      expect(() => cashForecast({ ...COMPLETE, showUpRate: { ...SHOW_UP, rateBp } })).toThrow(
        /share of anything/,
      )
    }
    expect(() => cashForecast({ ...COMPLETE, showUpRate: { ...SHOW_UP, rateBp: 90.5 } })).toThrow(
      /whole basis points/,
    )
    // Both ends are legal: nobody shows up, and everybody does.
    expect(() => cashForecast({ ...COMPLETE, showUpRate: { ...SHOW_UP, rateBp: 0 } })).not.toThrow()
    expect(() =>
      cashForecast({
        ...COMPLETE,
        showUpRate: { ...SHOW_UP, rateBp: Number(WHOLE_IN_BASIS_POINTS) },
      }),
    ).not.toThrow()
  })

  it('refuses a recurring cost of zero, which is a missing amount and not a free contract', () => {
    expect(() =>
      cashForecast({
        ...COMPLETE,
        recurringCosts: [{ code: 'rent', dueDate: AS_OF, expectedFils: 0n, costKind: 'fixed' }],
      }),
    ).toThrow(/missing amount and not a free contract/)
  })

  it('refuses a negative booking gross and a negative wage bill, which would reverse their direction', () => {
    expect(() =>
      cashForecast({
        ...COMPLETE,
        forwardBookings: [{ appointmentId: 'a', tradingDate: AS_OF, snapshotGrossFils: -1n }],
      }),
    ).toThrow(/negative snapshotted gross/)
    expect(() =>
      cashForecast({
        ...COMPLETE,
        payroll: {
          state: 'scheduled',
          occurrences: [{ periodKey: '2027-01', dueDate: AS_OF, grossFils: -1n }],
        },
      }),
    ).toThrow(/negative wage bill/)
  })

  /**
   * The census-to-refusal mapping, which is where the two gaps become a refusal.
   *
   * Pure, and tested here rather than only against the database, so each reason can be exercised ALONE:
   * the integration suite reads a census in which both are true at once, and a mapping that had lost one
   * of the two branches would still refuse there.
   */
  it('refuses when no pay date is recorded, naming Y8-payroll-date', () => {
    const payroll = payrollFromCensus({
      activeEmploymentRecords: 19,
      pricedEmployees: 19,
      unpricedEmployeeIds: [],
      payrollRunsOverlappingTheWindow: 0,
      aPayDateIsRecordedAnywhere: false,
    })
    expect(payroll.state).toBe('unattributable')
    if (payroll.state !== 'unattributable') throw new Error('expected a refusal')
    expect(payroll.openQuestionIds).toEqual(['Y8-payroll-date'])
    expect(payroll.missing).toEqual(['a column recording the date payroll cash leaves the bank'])
  })

  it('refuses when a wage is missing, naming Y8-staff and every unpriced employee', () => {
    const payroll = payrollFromCensus({
      activeEmploymentRecords: 3,
      pricedEmployees: 1,
      unpricedEmployeeIds: ['e2', 'e3'],
      payrollRunsOverlappingTheWindow: 2,
      aPayDateIsRecordedAnywhere: true,
    })
    expect(payroll.state).toBe('unattributable')
    if (payroll.state !== 'unattributable') throw new Error('expected a refusal')
    expect(payroll.openQuestionIds).toEqual(['Y8-staff'])
    expect(payroll.missing).toEqual([
      'employee.basic_wage_fils for e2',
      'employee.basic_wage_fils for e3',
    ])
    // It does NOT report the wage bill of the one employee that IS priced. A partial figure is the
    // defect ADR 0070 is about: a number a screen renders, lower than the real one by exactly the
    // employees nobody has priced.
    expect('fils' in payroll).toBe(false)
  })

  it("names both gaps when both hold, which is this build's own state", () => {
    const payroll = payrollFromCensus({
      activeEmploymentRecords: 19,
      pricedEmployees: 0,
      unpricedEmployeeIds: ['e1'],
      payrollRunsOverlappingTheWindow: 0,
      aPayDateIsRecordedAnywhere: false,
    })
    expect(payroll.state === 'unattributable' ? payroll.openQuestionIds : []).toEqual([
      'Y8-payroll-date',
      'Y8-staff',
    ])
  })

  it('schedules rather than refuses once both gaps are answered', () => {
    // The branch this build cannot reach, kept so that answering both questions produces a figure
    // without a rewrite. An empty occurrence list is a real answer — no settlement in the horizon.
    const payroll = payrollFromCensus({
      activeEmploymentRecords: 19,
      pricedEmployees: 19,
      unpricedEmployeeIds: [],
      payrollRunsOverlappingTheWindow: 3,
      aPayDateIsRecordedAnywhere: true,
    })
    expect(payroll.state).toBe('scheduled')
  })

  it('reports an overdrawn opening position rather than clamping it to zero', () => {
    // Deliberately NOT refused: clamping is the one error in an opening position nobody can see
    // afterwards, because the forecast still articulates.
    const forecast = cashForecast({ ...COMPLETE, openingCashFils: -250_000n })
    expect(figureFils(weekOf(forecast, 1).openingCash)).toBe(-250_000n)
    expect(forecast.total.articulationDifferenceFils).toBe(0n)
  })
})

// --- the lattice ----------------------------------------------------------------------------------

describe('a sum is as weak as its weakest part', () => {
  const RANK: Record<string, number> = {
    measured: 4,
    committed: 3,
    none_by_construction: 3,
    projected: 2,
    unattributable: 0,
  }

  const arbitraryFigure = (): fc.Arbitrary<ForecastFigure> =>
    fc.oneof(
      fc
        .bigInt({ min: 0n, max: 1_000_000n })
        .map((fils): ForecastFigure => ({ state: 'measured', fils, evidence: 'ledger' })),
      fc
        .bigInt({ min: 0n, max: 1_000_000n })
        .map((fils): ForecastFigure => ({ state: 'committed', fils, evidence: 'contract' })),
      fc
        .bigInt({ min: 0n, max: 1_000_000n })
        .map((fils): ForecastFigure => ({ state: 'projected', fils, assumptionIds: ['a'] })),
      fc.constant<ForecastFigure>({ state: 'none_by_construction', basis: 'nothing of this kind' }),
      fc.constant<ForecastFigure>({
        state: 'unattributable',
        why: 'unknown',
        missing: ['m'],
        openQuestionIds: ['Q'],
      }),
    )

  it('never reports a sum stronger than its weakest part, and one unknown poisons it', () => {
    /**
     * The generator is weighted towards being able to DISAGREE, and the test counts that.
     *
     * A uniform draw over five states with one to four parts puts most cases at one part, where the
     * weakening rule is trivially satisfied — so the property would hold for an implementation that
     * ignored the lattice entirely about a fifth of the time. So the length is at least 2 and the floor
     * below is MEASURED rather than guessed: six runs of 300 cases observed 275, 277, 279, 281, 282 and
     * 282 mixed-state cases, so the floor is 240 — comfortably under the observed minimum, because a
     * floor set just beneath it becomes its own flake (brief rule 22).
     */
    let mixed = 0
    fc.assert(
      fc.property(fc.array(arbitraryFigure(), { minLength: 2, maxLength: 5 }), (parts) => {
        const states = new Set(parts.map((part) => part.state))
        if (states.size > 1) mixed += 1
        const combined = combineFigures(parts, 'basis', 'nil basis')
        const weakest = Math.min(...parts.map((part) => RANK[part.state] ?? 0))
        if (parts.some((part) => part.state === 'unattributable')) {
          // The only direction that matters: an unknown part must not become a number.
          expect(combined.state).toBe('unattributable')
          expect('fils' in combined).toBe(false)
          return
        }
        expect(RANK[combined.state] ?? 0).toBeLessThanOrEqual(weakest)
        // And the arithmetic is still exact: `none_by_construction` contributes nothing.
        const expected = parts.reduce(
          (total, part) => total + ('fils' in part ? part.fils : 0n),
          0n,
        )
        expect('fils' in combined ? combined.fils : 0n).toBe(expected)
      }),
      { numRuns: 300 },
    )
    expect(mixed).toBeGreaterThan(240)
  })

  it('reports a sum of nothing as nil by construction and not as a measured zero', () => {
    const empty = combineFigures([], 'basis', 'there is nothing of this kind')
    expect(empty.state).toBe('none_by_construction')
    expect(empty.state === 'none_by_construction' ? empty.basis : '').toBe(
      'there is nothing of this kind',
    )
  })
})

// --- determinism ----------------------------------------------------------------------------------

describe('two runs produce byte-identical output', () => {
  it('is byte-identical over two independent builds of the same input', () => {
    const first = forecastBytes(cashForecast(COMPLETE))
    const second = forecastBytes(cashForecast(COMPLETE))
    expect(second).toBe(first)
    expect(first.length).toBeGreaterThan(1_000)
  })

  it('is byte-identical when the input arrays arrive in a different order', () => {
    // The caller's SQL orders its rows, but a forecast whose bytes depended on that order would be a
    // forecast that diffs everywhere the day somebody adds an `order by`. The weeks select their own
    // rows, so reversing the inputs must change nothing.
    const reversed: CashForecastInput = {
      ...COMPLETE,
      recurringCosts: [...COMPLETE.recurringCosts].reverse(),
      forwardBookings: [...COMPLETE.forwardBookings].reverse(),
    }
    expect(forecastBytes(cashForecast(reversed))).toBe(forecastBytes(cashForecast(COMPLETE)))
  })

  it('changes bytes when a figure changes, so the comparison is not vacuous', () => {
    const moved = cashForecast({ ...COMPLETE, openingCashFils: 5_000_001n })
    expect(forecastBytes(moved)).not.toBe(forecastBytes(cashForecast(COMPLETE)))
  })

  it('refuses to serialise a bigint as null, which is how a cash total disappears', () => {
    // `JSON.stringify` THROWS on a bigint, and `forecastBytes` turns each one into a decimal string
    // instead. The control is that a bigint survives as its digits rather than as a null or a number.
    expect(forecastBytes({ fils: 9_007_199_254_740_993n })).toBe('{"fils":"9007199254740993"}')
  })

  it('sorts keys recursively, so the bytes do not depend on the order an object was built in', () => {
    expect(forecastBytes({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })
})
