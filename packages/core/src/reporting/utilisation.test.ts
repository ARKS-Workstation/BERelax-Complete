import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { AccountCode } from '../ledger/account.ts'
import { ACCOUNTS, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import type { LocalDate } from '../time.ts'
import { localDate } from '../time.ts'
import type {
  KpiAppointment,
  KpiBusinessDay,
  KpiInput,
  KpiResult,
  KpiRevenueLine,
  KpiRoomClosure,
  KpiRoomDay,
  KpiRosteredShift,
  KpiSpec,
  Measure,
  MeasuredKpi,
} from './kpi-expression.ts'
import {
  addRational,
  constant,
  differenceOf,
  divideRational,
  EMPTY_KPI_INPUT,
  evaluateExpr,
  exceedsUnity,
  expandExpr,
  formatFigure,
  isNegativeRational,
  isNoDenominator,
  KpiExpressionCycle,
  kpiRef,
  MalformedRational,
  measureRef,
  quotientOf,
  rational,
  referencesOf,
  renderExpr,
  scaledFigure,
  subtractRational,
  sumOf,
  UnknownKpiReference,
  unitOfExpr,
  wholeRational,
} from './kpi-expression.ts'
import type { KpiRegistryRule } from './kpi-registry.ts'
import {
  assertKpiRegistry,
  buildKpiRegistry,
  KPI_MEASURES,
  KPI_REGISTRY_RULES,
  KPI_SPECS,
  kpiRegistryFindings,
  publishedFigure,
  resolveKpi,
  resolveMeasure,
  UnknownKpi,
} from './kpi-registry.ts'
import { REVPARH_REVENUE_PARTITION } from './revpar.ts'

/**
 * R-REP-03's acceptance list, line by line, plus the controls each line needs to not be vacuous.
 *
 * ## What the hand-computed fixtures are for, and the one that is not obvious
 *
 * "5 rooms × 15h = 75.0 on a normal day, 73.0 when the wet room has a two-hour closure" is arithmetic
 * anybody can check, and an implementation that multiplied a hard-coded 15 by 60 would pass both — 15
 * hours IS the trading day (Y8-hours, resolved: 11:00-02:00). So the fixture that earns its place is the
 * THIRD one: a trading day whose `dim_date.open_minutes` is not 900. Five rooms on a 13-hour day are
 * 65.0, and the only implementations that answer that are the ones that read the column.
 *
 * `measure-reads-exactly-the-fields-it-declares` closes the same gap from the other side, and the two are
 * complementary rather than redundant: the fixture catches an implementation that reads the column and
 * then ignores it, and the rule catches one that stops reading it at all — including one that would go on
 * answering 75.0 for ever because the premises has not changed its hours yet.
 *
 * ## Why every figure is asserted as an exact rational AND as a published string
 *
 * The rational is the claim ("to the fils", "75.0"); the string is what a screen shows. Asserting only
 * the rational would leave the rounding rule untested, and asserting only the string would let a figure
 * that was wrong in the fourth decimal place round into agreement.
 */

// --- the fixture world ---------------------------------------------------------------------------

/** A trading date in the seeded range. Two consecutive dates, because the 01:30 case needs both. */
const DAY = localDate('2026-03-02')
const NEXT_DAY = localDate('2026-03-03')

/**
 * 900 minutes: 11:00 to 02:00, which is Y8-hours' resolved answer and `business_day`'s own window.
 *
 * It is a constant HERE, in the fixture, which is the only place it may be one: the figure under test
 * has to take it from `dim_date`.
 */
const OPEN_MINUTES = 900

/** Y8-rooms' five: three standard, one couples, one wet. The wet room is the one that gets closed. */
const WET_ROOM = 'room-wet'
const ROOMS = ['room-standard-1', 'room-standard-2', 'room-standard-3', 'room-couples', WET_ROOM]

const THERAPIST = 'employee-0001'

const day = (businessDay: LocalDate, openMinutes = OPEN_MINUTES): KpiBusinessDay => ({
  businessDay,
  openMinutes,
})

const roomDays = (businessDay: LocalDate, rooms: readonly string[] = ROOMS): KpiRoomDay[] =>
  rooms.map((roomId) => ({ businessDay, roomId }))

const closure = (
  roomId: string,
  fromMinuteAfterOpen: number,
  toMinuteAfterOpen: number,
  businessDay: LocalDate = DAY,
): KpiRoomClosure => ({ businessDay, roomId, fromMinuteAfterOpen, toMinuteAfterOpen })

const appointment = (overrides: Partial<KpiAppointment> = {}): KpiAppointment => ({
  businessDay: DAY,
  roomId: ROOMS[0] ?? WET_ROOM,
  employeeId: THERAPIST,
  isDelivered: true,
  treatmentMinutes: 60,
  turnaroundMinutes: 15,
  ...overrides,
})

const shift = (overrides: Partial<KpiRosteredShift> = {}): KpiRosteredShift => ({
  businessDay: DAY,
  employeeId: THERAPIST,
  rosteredMinutes: OPEN_MINUTES,
  ...overrides,
})

const revenue = (
  accountCode: AccountCode,
  netFils: bigint,
  businessDay: LocalDate = DAY,
): KpiRevenueLine => ({ businessDay, accountCode, netFils })

const inputOf = (overrides: Partial<KpiInput>): KpiInput => ({ ...EMPTY_KPI_INPUT, ...overrides })

/** The figure, with the no-denominator case refused: a test asserting a number needs one. */
function measured(result: KpiResult): MeasuredKpi {
  if (isNoDenominator(result)) {
    throw new Error(
      `${result.kpi} answered no_denominator (divisor ${result.divisorFormula}) where a figure was ` +
        'expected',
    )
  }
  return result
}

const figureOf = (kpiId: string, input: KpiInput): MeasuredKpi =>
  measured(resolveKpi(kpiId).compute(input))

/**
 * A probe that makes every measure read every field it declares.
 *
 * Non-trivial by necessity rather than by taste: `measure-reads-exactly-the-fields-it-declares` compares
 * a declaration against what was ACTUALLY touched, so a probe missing a dataset makes every measure that
 * reads it fail the rule. The empty-probe case below asserts exactly that, which is what makes this probe
 * evidence rather than decoration.
 */
const REGISTRY_PROBE: KpiInput = inputOf({
  businessDays: [day(DAY), day(NEXT_DAY)],
  roomDays: [...roomDays(DAY), ...roomDays(NEXT_DAY)],
  roomClosures: [closure(WET_ROOM, 0, 120)],
  appointments: [appointment(), appointment({ businessDay: NEXT_DAY })],
  rosteredShifts: [shift(), shift({ businessDay: NEXT_DAY })],
  // One included account and one excluded one, so the numerator's filter is exercised in both
  // directions and `netFils` is actually read.
  revenueLines: [
    revenue(ACCOUNTS.treatmentRevenue, 100_000n),
    revenue(ACCOUNTS.retailRevenue, 50n),
  ],
})

// --- available room-hours ------------------------------------------------------------------------

describe('available room-hours', () => {
  it('is 75.0 for five rooms on a 15-hour trading day', () => {
    const result = figureOf(
      'available_room_hours',
      inputOf({ businessDays: [day(DAY)], roomDays: roomDays(DAY) }),
    )
    expect(result.value).toEqual(wholeRational(75n))
    expect(publishedFigure(result)).toBe('75.0')
    expect(result.unit).toBe('hours')
  })

  it('is 73.0 when the wet room has a two-hour closure', () => {
    const result = figureOf(
      'available_room_hours',
      inputOf({
        businessDays: [day(DAY)],
        roomDays: roomDays(DAY),
        roomClosures: [closure(WET_ROOM, 0, 120)],
      }),
    )
    expect(result.value).toEqual(wholeRational(73n))
    expect(publishedFigure(result)).toBe('73.0')
  })

  it('follows dim_date open_minutes rather than a constant number of hours', () => {
    // 13 hours, which the premises has never traded. An implementation that multiplied 15 by 60 — right
    // today, and right until the hours change — answers 75.0 here. See this file's header.
    const thirteenHours = figureOf(
      'available_room_hours',
      inputOf({ businessDays: [day(DAY, 780)], roomDays: roomDays(DAY) }),
    )
    expect(thirteenHours.value).toEqual(wholeRational(65n))
    expect(publishedFigure(thirteenHours)).toBe('65.0')
    expect(thirteenHours.value).not.toEqual(wholeRational(75n))
  })

  it('subtracts nothing for a closure that falls wholly outside trading hours', () => {
    const before = figureOf(
      'available_room_hours',
      inputOf({
        businessDays: [day(DAY)],
        roomDays: roomDays(DAY),
        // Maintenance in the nine hours the premises is shut: a real block that closes no trading
        // minute. Subtracting it would report capacity lost that was never for sale.
        roomClosures: [closure(WET_ROOM, -180, -60), closure(WET_ROOM, 960, 1080)],
      }),
    )
    expect(before.value).toEqual(wholeRational(75n))
  })

  it('clips a closure that overruns closing time', () => {
    const result = figureOf(
      'available_room_minutes',
      inputOf({
        businessDays: [day(DAY)],
        roomDays: roomDays(DAY),
        // 840 to 1020: the last hour of trading plus two hours after it.
        roomClosures: [closure(WET_ROOM, 840, 1020)],
      }),
    )
    expect(result.value).toEqual(wholeRational(BigInt(5 * OPEN_MINUTES - 60)))
  })

  it('subtracts both of two closures that do not overlap', () => {
    // The union's other branch: a run that ends and a new one that starts. Three intervals, so the
    // merge, the flush and the final flush are each taken once — with only the overlapping pair the
    // loop never reaches the line that closes a run and opens the next.
    const result = figureOf(
      'available_room_minutes',
      inputOf({
        businessDays: [day(DAY)],
        roomDays: roomDays(DAY),
        roomClosures: [
          closure(WET_ROOM, 60, 180),
          closure(WET_ROOM, 120, 240),
          closure(WET_ROOM, 600, 660),
        ],
      }),
    )
    // 60 to 240 is 180 minutes, and 600 to 660 is 60 more.
    expect(result.value).toEqual(wholeRational(BigInt(5 * OPEN_MINUTES - 240)))
  })

  it('closes a room once when two closures overlap', () => {
    const overlapping = figureOf(
      'available_room_minutes',
      inputOf({
        businessDays: [day(DAY)],
        roomDays: roomDays(DAY),
        roomClosures: [closure(WET_ROOM, 60, 180), closure(WET_ROOM, 120, 240)],
      }),
    )
    // The union is 60 to 240, which is 180 minutes. Summing the two raw would subtract 240.
    expect(overlapping.value).toEqual(wholeRational(BigInt(5 * OPEN_MINUTES - 180)))
  })

  it('subtracts nothing for a closure of a room that was not in service that day', () => {
    const result = figureOf(
      'available_room_minutes',
      inputOf({
        businessDays: [day(DAY)],
        roomDays: roomDays(DAY, ROOMS.slice(0, 4)),
        roomClosures: [closure(WET_ROOM, 0, 120)],
      }),
    )
    expect(result.value).toEqual(wholeRational(BigInt(4 * OPEN_MINUTES)))
  })

  it('does not add capacity for a repeated room-day', () => {
    const result = figureOf(
      'available_room_minutes',
      inputOf({
        businessDays: [day(DAY)],
        roomDays: [...roomDays(DAY), ...roomDays(DAY)],
      }),
    )
    expect(result.value).toEqual(wholeRational(BigInt(5 * OPEN_MINUTES)))
  })

  it('is never negative, however long the closures are', () => {
    const result = figureOf(
      'available_room_minutes',
      inputOf({
        businessDays: [day(DAY)],
        roomDays: roomDays(DAY),
        roomClosures: [closure(WET_ROOM, -600, 2000)],
      }),
    )
    expect(result.value).toEqual(wholeRational(BigInt(4 * OPEN_MINUTES)))
    expect(isNegativeRational(result.value)).toBe(false)
  })

  it('counts a room-day on every trading day in the period', () => {
    const result = figureOf(
      'available_room_hours',
      inputOf({
        businessDays: [day(DAY), day(NEXT_DAY)],
        roomDays: [...roomDays(DAY), ...roomDays(NEXT_DAY)],
      }),
    )
    expect(result.value).toEqual(wholeRational(150n))
  })
})

// --- revenue per available room-hour -------------------------------------------------------------

describe('revenue per available room-hour', () => {
  /** 73.0 available room-hours, so a numerator of 365,000 fils is exactly 5,000 per room-hour. */
  const revparhInput = (lines: readonly KpiRevenueLine[]): KpiInput =>
    inputOf({
      businessDays: [day(DAY)],
      roomDays: roomDays(DAY),
      roomClosures: [closure(WET_ROOM, 0, 120)],
      revenueLines: lines,
    })

  const TREATMENT_NET = 365_000n

  it('is net treatment revenue in fils for every available room-hour, to the fils', () => {
    const result = figureOf(
      'revenue_per_available_room_hour',
      revparhInput([revenue(ACCOUNTS.treatmentRevenue, TREATMENT_NET)]),
    )
    expect(result.value).toEqual(wholeRational(5_000n))
    expect(publishedFigure(result)).toBe('5000')
    expect(result.unit).toBe('fils_per_room_hour')
  })

  it('excludes retail revenue from the numerator', () => {
    const withRetail = figureOf(
      'revenue_per_available_room_hour',
      revparhInput([
        revenue(ACCOUNTS.treatmentRevenue, TREATMENT_NET),
        // A bottle of oil sold at the desk occupies no room-minute, so counting it would raise a
        // room-productivity figure with no extra treatment delivered.
        revenue(ACCOUNTS.retailRevenue, 100_000n),
      ]),
    )
    expect(withRetail.value).toEqual(wholeRational(5_000n))
  })

  it('excludes a gratuity, which is not revenue at all', () => {
    const withTip = figureOf(
      'revenue_per_available_room_hour',
      revparhInput([
        revenue(ACCOUNTS.treatmentRevenue, TREATMENT_NET),
        // 2040 is a LIABILITY: a tip is the customer's money on its way to a therapist and appears on
        // no tax invoice (0068). It is outside the revenue partition by construction, which the
        // partition rule below is what keeps true.
        revenue(ACCOUNTS.tipsPayable, 50_000n),
      ]),
    )
    expect(withTip.value).toEqual(wholeRational(5_000n))
  })

  it('counts a package redemption and a voucher redemption as room-occupying revenue', () => {
    const result = figureOf(
      'revenue_per_available_room_hour',
      revparhInput([
        revenue(ACCOUNTS.packageRedemptionRevenue, 182_500n),
        revenue(ACCOUNTS.voucherRedemptionRevenue, 182_500n),
      ]),
    )
    expect(result.value).toEqual(wholeRational(5_000n))
  })

  it('is reduced by a credit note, which fact_sale signs negative', () => {
    const result = figureOf(
      'revenue_per_available_room_hour',
      revparhInput([
        revenue(ACCOUNTS.treatmentRevenue, TREATMENT_NET),
        revenue(ACCOUNTS.treatmentRevenue, -73_000n),
      ]),
    )
    expect(result.value).toEqual(wholeRational(4_000n))
  })

  it('is reduced by a discount, because the numerator is net of it', () => {
    const result = figureOf(
      'revenue_per_available_room_hour',
      revparhInput([
        revenue(ACCOUNTS.treatmentRevenue, TREATMENT_NET),
        revenue(ACCOUNTS.discountsAndAllowances, -73_000n),
      ]),
    )
    expect(result.value).toEqual(wholeRational(4_000n))
  })

  it('ignores a revenue posting whose trading day is outside the period', () => {
    const result = figureOf(
      'revenue_per_available_room_hour',
      revparhInput([
        revenue(ACCOUNTS.treatmentRevenue, TREATMENT_NET),
        // The same account and a real amount, on a trading day the period does not hold. The period IS
        // the set of dim_date rows, so this contributes nothing rather than inflating a day it was not
        // earned on.
        revenue(ACCOUNTS.treatmentRevenue, 1_000_000n, NEXT_DAY),
      ]),
    )
    expect(result.value).toEqual(wholeRational(5_000n))
  })

  it('carries the Y8-coa marker onto every figure, measured or not', () => {
    const figure = figureOf(
      'revenue_per_available_room_hour',
      revparhInput([revenue(ACCOUNTS.treatmentRevenue, TREATMENT_NET)]),
    )
    expect(figure.provisional?.openQuestionId).toBe('Y8-coa')
    const empty = resolveKpi('revenue_per_available_room_hour').compute(EMPTY_KPI_INPUT)
    expect(empty.provisional?.openQuestionId).toBe('Y8-coa')
  })

  it('rounds to the fils, half away from zero, when the division is not exact', () => {
    // 100 fils over 1 available room-hour is exact; 50 fils over 3 is 16.666..., and over -3 is the
    // mirror image. Both are asserted because half-up and half-away-from-zero differ only below zero.
    expect(scaledFigure(rational(50n, 3n), 0)).toBe(17n)
    expect(scaledFigure(rational(-50n, 3n), 0)).toBe(-17n)
    expect(scaledFigure(rational(1n, 2n), 0)).toBe(1n)
    expect(scaledFigure(rational(-1n, 2n), 0)).toBe(-1n)
  })
})

// --- the two utilisations ------------------------------------------------------------------------

describe('room and therapist utilisation', () => {
  /**
   * ONE fixture, two figures. One room open for 900 minutes with one therapist rostered across all of
   * it, and three delivered appointments of 60 minutes' treatment plus 15 minutes' turnaround.
   *
   * The room is occupied for 3 x 75 = 225 of 900 minutes, which is 25.00%. The therapist delivers
   * 3 x 60 = 180 of 900 rostered minutes, which is 20.00%. Both denominators are 900, so the whole of
   * the difference is the turnaround — which is the acceptance line.
   */
  const SHARED_FIXTURE: KpiInput = inputOf({
    businessDays: [day(DAY)],
    roomDays: roomDays(DAY, [ROOMS[0] ?? WET_ROOM]),
    appointments: [appointment(), appointment(), appointment()],
    rosteredShifts: [shift()],
  })

  it('differ by exactly the turnaround minutes on one fixture', () => {
    const room = figureOf('room_utilisation', SHARED_FIXTURE)
    const therapist = figureOf('therapist_utilisation', SHARED_FIXTURE)

    expect(room.value).toEqual(rational(1n, 4n))
    expect(publishedFigure(room)).toBe('0.2500')
    expect(therapist.value).toEqual(rational(1n, 5n))
    expect(publishedFigure(therapist)).toBe('0.2000')

    // The control: the two are DIFFERENT, and the difference is 45 minutes of turnaround over 900.
    expect(room.value).not.toEqual(therapist.value)
    expect(scaledFigure(room.value, 4) - scaledFigure(therapist.value, 4)).toBe(500n)
  })

  it('occupies no room-minute for an appointment holding no room', () => {
    const room = figureOf(
      'room_utilisation',
      inputOf({ ...SHARED_FIXTURE, appointments: [appointment({ roomId: null })] }),
    )
    expect(room.value).toEqual(wholeRational(0n))
  })

  it('occupies no therapist-minute for an unassigned appointment', () => {
    const therapist = figureOf(
      'therapist_utilisation',
      inputOf({ ...SHARED_FIXTURE, appointments: [appointment({ employeeId: null })] }),
    )
    expect(therapist.value).toEqual(wholeRational(0n))
  })

  it('counts a no-show as neither, because its lost room-hours are a separate figure', () => {
    const noShows = inputOf({
      ...SHARED_FIXTURE,
      appointments: [appointment({ isDelivered: false }), appointment({ isDelivered: false })],
    })
    expect(figureOf('room_utilisation', noShows).value).toEqual(wholeRational(0n))
    expect(figureOf('therapist_utilisation', noShows).value).toEqual(wholeRational(0n))
  })

  it("reads the therapist's roster and not the trading window as its denominator", () => {
    // Half a day rostered: the same 180 delivered minutes are 40% of the roster, not 20% of the day.
    const halfDay = inputOf({
      ...SHARED_FIXTURE,
      rosteredShifts: [shift({ rosteredMinutes: 450 })],
    })
    expect(figureOf('therapist_utilisation', halfDay).value).toEqual(rational(2n, 5n))
  })
})

// --- the business day ----------------------------------------------------------------------------

describe('the trading date an appointment counts in', () => {
  /**
   * A treatment delivered at 01:30 belongs to the PREVIOUS trading date: trading runs 11:00-02:00, and
   * `appointment.trading_date` resolves it per appointment across midnight (0024, ADR 0060). It arrives
   * here already keyed that way, and `businessDay` is the only date on the row — there is no instant in
   * `KpiInput` at all, so no measure here could re-derive one even if it wanted to.
   *
   * What the two cases below assert is the consequence: the period that counts it is the one holding the
   * PREVIOUS date, numerator and denominator together, and the period holding the calendar date the
   * clock said does not count it and reports its own day's capacity instead.
   */
  const lateTreatment = appointment({
    businessDay: DAY,
    treatmentMinutes: 60,
    turnaroundMinutes: 15,
  })

  const world = (days: readonly KpiBusinessDay[], at: readonly LocalDate[]): KpiInput =>
    inputOf({
      businessDays: days,
      roomDays: at.flatMap((businessDay) => roomDays(businessDay, [ROOMS[0] ?? WET_ROOM])),
      appointments: [lateTreatment],
      rosteredShifts: at.map((businessDay) => shift({ businessDay })),
    })

  it('counts a 01:30 treatment in the previous trading date, in numerator and denominator', () => {
    const previousDay = world([day(DAY)], [DAY])
    expect(figureOf('room_utilisation', previousDay).value).toEqual(rational(75n, 900n))
    expect(figureOf('therapist_utilisation', previousDay).value).toEqual(rational(60n, 900n))
    expect(figureOf('available_room_hours', previousDay).value).toEqual(wholeRational(15n))
  })

  it('does not count it in a period holding the calendar date the clock said', () => {
    const calendarDay = world([day(NEXT_DAY)], [NEXT_DAY])
    expect(figureOf('room_utilisation', calendarDay).value).toEqual(wholeRational(0n))
    expect(figureOf('therapist_utilisation', calendarDay).value).toEqual(wholeRational(0n))
    // The denominator is the NEXT day's own capacity, not the previous day's, so the two periods are
    // genuinely different windows rather than one window with a filter.
    expect(figureOf('available_room_hours', calendarDay).value).toEqual(wholeRational(15n))
  })
})

// --- an empty denominator ------------------------------------------------------------------------

describe('an empty denominator', () => {
  it('answers NoDenominator naming available_room_minutes when no room was in service', () => {
    const result = resolveKpi('room_utilisation').compute(
      inputOf({ businessDays: [day(DAY)], appointments: [appointment()] }),
    )
    expect(isNoDenominator(result)).toBe(true)
    if (!isNoDenominator(result)) throw new Error('narrowing failed')
    expect(result.divisorFormula).toBe('available_room_minutes')
    // The three things it must not be. `0` is the worst of them: a room utilisation of zero is a real
    // reading that means the rooms were idle, not that there were none.
    expect(result).not.toHaveProperty('value')
    expect(Object.values(result).every((field) => !Number.isNaN(field))).toBe(true)
  })

  it('answers NoDenominator naming therapist_rostered_minutes when nobody was rostered', () => {
    const result = resolveKpi('therapist_utilisation').compute(
      inputOf({ businessDays: [day(DAY)], appointments: [appointment()] }),
    )
    expect(isNoDenominator(result)).toBe(true)
    if (!isNoDenominator(result)) throw new Error('narrowing failed')
    expect(result.divisorFormula).toBe('therapist_rostered_minutes')
  })

  it('answers NoDenominator naming available_room_hours for RevPARH', () => {
    const result = resolveKpi('revenue_per_available_room_hour').compute(
      inputOf({
        businessDays: [day(DAY)],
        revenueLines: [revenue(ACCOUNTS.treatmentRevenue, 100_000n)],
      }),
    )
    expect(isNoDenominator(result)).toBe(true)
    if (!isNoDenominator(result)) throw new Error('narrowing failed')
    expect(result.divisorFormula).toBe('available_room_hours')
  })

  it('reports a measured zero when the NUMERATOR is empty, which is a different fact', () => {
    const idle = figureOf(
      'room_utilisation',
      inputOf({ businessDays: [day(DAY)], roomDays: roomDays(DAY) }),
    )
    expect(idle.value).toEqual(wholeRational(0n))
  })

  it('refuses a rational with a zero denominator rather than constructing one', () => {
    expect(() => rational(1n, 0n)).toThrow(MalformedRational)
  })
})

// --- the formulas, which are derived -------------------------------------------------------------

describe('the published formulas', () => {
  it('renders each KPI one level deep and again expanded to its measures', () => {
    expect(resolveKpi('available_room_minutes').formula).toBe(
      'room_open_minutes − room_closure_minutes',
    )
    expect(resolveKpi('available_room_hours').formula).toBe('available_room_minutes ÷ 60')
    expect(resolveKpi('available_room_hours').expandedFormula).toBe(
      '(room_open_minutes − room_closure_minutes) ÷ 60',
    )
    expect(resolveKpi('room_utilisation').expandedFormula).toBe(
      'room_occupied_minutes ÷ (room_open_minutes − room_closure_minutes)',
    )
    expect(resolveKpi('therapist_utilisation').formula).toBe(
      'therapist_treatment_minutes ÷ therapist_rostered_minutes',
    )
    expect(resolveKpi('revenue_per_available_room_hour').expandedFormula).toBe(
      'treatment_net_revenue_fils ÷ ((room_open_minutes − room_closure_minutes) ÷ 60)',
    )
  })

  it('changes when the expression changes, which is what "derived" means', () => {
    // The control for the whole arrangement. A `formula` field somebody typed would not move when the
    // arithmetic did, and nothing in the suite would notice; this does, and the gate block holds it.
    const altered: KpiSpec = {
      ...KPI_SPECS[0],
      id: 'available_room_minutes',
      label: 'Altered',
      summary: 'A deliberately different expression.',
      unit: 'minutes',
      expression: sumOf(measureRef('room_open_minutes'), measureRef('room_closure_minutes')),
      provisional: null,
    }
    const registry = buildKpiRegistry([altered], [...KPI_MEASURES])
    expect(resolveKpi('available_room_minutes', registry).formula).toBe(
      'room_open_minutes + room_closure_minutes',
    )
    expect(resolveKpi('available_room_minutes', registry).formula).not.toBe(
      resolveKpi('available_room_minutes').formula,
    )
  })

  it('renders a nullary sum as zero rather than as an empty string', () => {
    expect(renderExpr(sumOf())).toBe('0')
  })

  it('expands a KPI referenced twice in one expression in both places', () => {
    // A `seen` set that grew as the walk descended would expand the first and truncate the second,
    // producing a formula shorter than the arithmetic — the drift this whole module exists against.
    const twice = differenceOf(kpiRef('available_room_hours'), kpiRef('available_room_hours'))
    const expanded = expandExpr(
      twice,
      (id) =>
        id === 'available_room_hours' ? quotientOf(measureRef('m'), constant(60n)) : undefined,
      [],
    )
    expect(renderExpr(expanded)).toBe('(m ÷ 60) − (m ÷ 60)')
  })
})

// --- the registry and its rules ------------------------------------------------------------------

describe('the KPI registry', () => {
  it('is sound over the shipped registry and the shipped chart', () => {
    expect(kpiRegistryFindings({ probe: REGISTRY_PROBE })).toEqual([])
    expect(() => assertKpiRegistry({ probe: REGISTRY_PROBE })).not.toThrow()
  })

  it('throws naming every rule that fired, rather than reporting a count', () => {
    // A caller that only wants a yes or no still has to be told WHICH rule, because the remedies differ:
    // an unclaimed revenue account is a chart that moved and a mismatched read set is a measure that
    // changed. The empty probe is the cheapest registry defect to produce.
    expect(() => assertKpiRegistry({ probe: EMPTY_KPI_INPUT })).toThrow(
      /measure-reads-exactly-the-fields-it-declares/,
    )
  })

  it('gives every KPI a non-empty formula and a registered pure function', () => {
    expect(KPI_SPECS.length).toBeGreaterThan(0)
    for (const spec of KPI_SPECS) {
      const kpi = resolveKpi(spec.id)
      expect(kpi.formula.trim()).not.toBe('')
      expect(kpi.expandedFormula.trim()).not.toBe('')
      expect(typeof kpi.compute).toBe('function')
      // Pure: two calls with the same input agree, and neither leaves a trace in the other.
      expect(kpi.compute(REGISTRY_PROBE)).toEqual(kpi.compute(REGISTRY_PROBE))
    }
  })

  it('refuses an unregistered id rather than answering with an empty tile', () => {
    expect(() => resolveKpi('occupancy')).toThrow(UnknownKpi)
    expect(resolveMeasure('room_open_minutes')?.unit).toBe('minutes')
    expect(resolveMeasure('not_a_measure')).toBeUndefined()
  })

  /** Each rule, blinded by a registry that breaks it, asserted BY NAME (ADR 0003). */
  const firesWith = (
    rule: KpiRegistryRule,
    options: Parameters<typeof kpiRegistryFindings>[0],
  ): void => {
    const rules = kpiRegistryFindings(options).map((finding) => finding.rule)
    expect(rules, `expected ${rule} among [${rules.join(', ')}]`).toContain(rule)
  }

  const specNamed = (id: string): KpiSpec => {
    const spec = KPI_SPECS.find((candidate) => candidate.id === id)
    if (spec === undefined)
      throw new Error(`the suite names a KPI the registry does not hold: ${id}`)
    return spec
  }

  const measureNamed = (id: string): Measure => {
    const measure = KPI_MEASURES.find((candidate) => candidate.id === id)
    if (measure === undefined)
      throw new Error(`the suite names a measure that is not registered: ${id}`)
    return measure
  }

  it('names every rule it can report, and reports each one against a registry that breaks it', () => {
    expect(new Set(KPI_REGISTRY_RULES).size).toBe(KPI_REGISTRY_RULES.length)

    firesWith('registry-names-are-unique-across-kpis-and-measures', {
      probe: REGISTRY_PROBE,
      registry: buildKpiRegistry(
        [specNamed('available_room_minutes')],
        [...KPI_MEASURES, { ...measureNamed('room_open_minutes'), id: 'available_room_minutes' }],
      ),
    })

    firesWith('registry-entry-carries-a-label-and-a-summary', {
      probe: REGISTRY_PROBE,
      registry: buildKpiRegistry(
        [{ ...specNamed('available_room_minutes'), summary: '  ' }],
        [...KPI_MEASURES],
      ),
    })

    firesWith('kpi-expression-references-only-registered-names', {
      probe: REGISTRY_PROBE,
      registry: buildKpiRegistry(
        [
          {
            ...specNamed('available_room_minutes'),
            expression: measureRef('minutes_nobody_measures'),
          },
        ],
        [...KPI_MEASURES],
      ),
    })

    firesWith('kpi-expression-has-no-cycle', {
      probe: REGISTRY_PROBE,
      registry: buildKpiRegistry(
        [
          {
            ...specNamed('available_room_minutes'),
            expression: differenceOf(
              measureRef('room_open_minutes'),
              kpiRef('available_room_minutes'),
            ),
          },
        ],
        [...KPI_MEASURES],
      ),
    })

    firesWith('kpi-unit-follows-from-its-expression', {
      probe: REGISTRY_PROBE,
      // Minutes divided by 30 is half-hours, and labelling it `hours` is the mislabel that would put a
      // figure twice its true size on a screen with the right word beside it.
      registry: buildKpiRegistry(
        [
          {
            ...specNamed('available_room_hours'),
            expression: quotientOf(measureRef('room_open_minutes'), constant(30n)),
          },
        ],
        [...KPI_MEASURES],
      ),
    })

    firesWith('measure-reads-exactly-the-fields-it-declares', {
      probe: REGISTRY_PROBE,
      registry: buildKpiRegistry(
        [specNamed('available_room_minutes')],
        [
          ...KPI_MEASURES.filter((measure) => measure.id !== 'room_open_minutes'),
          // The case this rule exists for: a denominator that stopped reading dim_date's own
          // open_minutes and assumed the fifteen hours that are correct today.
          {
            ...measureNamed('room_open_minutes'),
            reduce: (input) => BigInt(input.roomDays.length * OPEN_MINUTES),
          },
        ],
      ),
    })

    firesWith('revparh-revenue-partition-claims-every-revenue-account-exactly-once', {
      probe: REGISTRY_PROBE,
      revenuePartition: {
        included: REVPARH_REVENUE_PARTITION.included,
        // Retail dropped from both sides: revenue the numerator now silently ignores, and the
        // identity-free kind of defect that no figure in any fixture would reveal.
        excluded: REVPARH_REVENUE_PARTITION.excluded.filter(
          (code) => code !== ACCOUNTS.retailRevenue,
        ),
      },
    })

    firesWith('revparh-revenue-partition-claims-every-revenue-account-exactly-once', {
      probe: REGISTRY_PROBE,
      // And the other direction: the tips-payable LIABILITY smuggled into a revenue partition.
      revenuePartition: {
        included: [...REVPARH_REVENUE_PARTITION.included, ACCOUNTS.tipsPayable],
        excluded: REVPARH_REVENUE_PARTITION.excluded,
      },
    })
  })

  it('fires the formula rule when the renderer drops part of the arithmetic', () => {
    // The renderer is shipped, so the only way to break it from here is to hand the registry a KPI
    // whose formula cannot name what it computes: a measure whose id is not a word the renderer can
    // print. `scripts/test-gates.mjs` 146e breaks the renderer itself.
    firesWith('kpi-formula-names-every-reference-it-computes', {
      probe: REGISTRY_PROBE,
      registry: {
        ...buildKpiRegistry([specNamed('available_room_minutes')], [...KPI_MEASURES]),
        byId: new Map([
          [
            'available_room_minutes',
            {
              ...resolveKpi('available_room_minutes'),
              formula: 'room_open_minutes',
              expandedFormula: 'room_open_minutes',
            },
          ],
        ]),
      },
    })
  })

  it('fires the reads rule against an EMPTY probe rather than passing over it', () => {
    // The vacuity control for the rule that holds a declaration equal to an access: a probe with no rows
    // makes every reducer read nothing, which agrees with no declaration. A rules function that reported
    // nothing here would be reporting nothing at all.
    const rules = kpiRegistryFindings({ probe: EMPTY_KPI_INPUT }).map((finding) => finding.rule)
    expect(rules).toContain('measure-reads-exactly-the-fields-it-declares')
    expect(new Set(rules).size).toBe(1)
  })

  it('throws rather than hanging when a cyclic KPI is computed', () => {
    const registry = buildKpiRegistry(
      [
        {
          ...specNamed('available_room_minutes'),
          expression: kpiRef('available_room_minutes'),
        },
      ],
      [...KPI_MEASURES],
    )
    expect(() => resolveKpi('available_room_minutes', registry).compute(REGISTRY_PROBE)).toThrow(
      KpiExpressionCycle,
    )
    expect(resolveKpi('available_room_minutes', registry).formula).toBe('available_room_minutes')
  })

  it('resolves a cyclic unit to nothing rather than overflowing the stack', () => {
    // Found by gate case 146d, which blinds the cycle RULE: with it blind the rules pass went on to
    // `unitOfExpr`, which had no cycle guard, and died with `RangeError: Maximum call stack size
    // exceeded` instead of naming the rule that had stopped firing — so the case read a blinded detector
    // as undetected. A registry defect has to present as a finding even when the finding that names it
    // has been removed, which is what makes every other walk here guard too.
    const registry = buildKpiRegistry(
      [{ ...specNamed('available_room_minutes'), expression: kpiRef('available_room_minutes') }],
      [...KPI_MEASURES],
    )
    expect(
      unitOfExpr(kpiRef('available_room_minutes'), {
        measures: registry.measuresById,
        kpis: registry.specsById,
      }),
    ).toBeNull()
  })

  it('holds the revenue partition against the chart in both directions', () => {
    const revenueCodes = STANDARD_SPA_CHART.accounts
      .filter((account) => account.type === 'revenue')
      .map((account) => account.code)
    const claimed = [...REVPARH_REVENUE_PARTITION.included, ...REVPARH_REVENUE_PARTITION.excluded]
    expect([...claimed].sort()).toEqual([...revenueCodes].sort())
    expect(claimed).not.toContain(ACCOUNTS.tipsPayable)
  })
})

// --- the figure formatter ------------------------------------------------------------------------

describe('a published figure', () => {
  it('formats to the places asked for, with a sign and a padded fraction', () => {
    expect(formatFigure(rational(3n, 2n), 2)).toBe('1.50')
    expect(formatFigure(rational(-3n, 2n), 2)).toBe('-1.50')
    expect(formatFigure(rational(1n, 8n), 4)).toBe('0.1250')
    expect(formatFigure(rational(0n, 5n), 1)).toBe('0.0')
    expect(formatFigure(wholeRational(75n), 0)).toBe('75')
  })

  it('refuses a negative or fractional number of decimal places', () => {
    expect(() => scaledFigure(wholeRational(1n), -1)).toThrow()
    expect(() => scaledFigure(wholeRational(1n), 1.5)).toThrow()
  })

  it('reduces a figure, so one number has one representation', () => {
    expect(rational(450n, 900n)).toEqual(rational(1n, 2n))
    expect(rational(1n, -2n)).toEqual({ numerator: -1n, denominator: 2n })
    expect(exceedsUnity(rational(901n, 900n))).toBe(true)
    expect(exceedsUnity(rational(900n, 900n))).toBe(false)
  })
})

// --- the property ---------------------------------------------------------------------------------

/**
 * No utilisation exceeds 100%, and a zero denominator is named rather than computed.
 *
 * ## Why the generator builds a FEASIBLE schedule
 *
 * A utilisation above 100% is not a rounding question, it is an impossible reading, and the inputs that
 * produce one are inputs the booking rules already refuse: `resource_block` makes a room unavailable
 * while it is closed, and the deferred room-capacity trigger (ADR 0015) refuses two appointments
 * overlapping in one room. So the generator models what the database guarantees — appointments placed in
 * sequence inside the room's OPEN and UNCLOSED minutes, each therapist rostered for the window their own
 * room is used in — and the property is then a claim about this arithmetic rather than about the
 * generator.
 *
 * What would break it: a closure counted twice, a clip that allowed a negative length, a denominator
 * taken from the wrong day, or a turnaround counted in the numerator and not in the capacity. Each of
 * those raises the ratio above one on some generated world.
 *
 * ## The counts, and why they are asserted (brief rule 22)
 *
 * The claim is vacuous on a world with no appointments: 0 ÷ 900 is under 100% whatever the arithmetic
 * does. So the property counts the worlds that could actually disagree — a room utilisation at or above
 * 25%, which needs a real schedule — and the worlds with an empty denominator, and asserts a floor on
 * each. The floors are MEASURED, over eight runs of 300 cases, whose minima were:
 *
 *     busy (room utilisation at or above 25%) 144, empty denominator 221
 *
 * Each floor is set at about half its observed minimum, deliberately: a floor placed just under the
 * minimum becomes its own intermittent failure.
 */
const RUNS = 300

/**
 * An explicit timeout, because `vitest.config.ts` declares no `testTimeout` and the default is 5,000 ms.
 *
 * 300 generated worlds, each building up to three days x four rooms of appointments and evaluating four
 * KPIs over them, measured at about 0.4s alone. Brief rule 21 has cost five files: a correctness test
 * with no explicit timeout fails under coverage on a loaded machine and names the wrong thing.
 */
const TIMEOUT_MS = 30_000

/** One generated world, as the smallest thing fast-check can shrink. */
interface Plan {
  /** `dim_date.open_minutes` per trading day in scope. An empty list is a period with no trading day. */
  readonly openMinutes: readonly number[]
  /** Rooms, each paired 1:1 with a therapist rostered for the day's whole window. */
  readonly pairs: number
  /** A closure per (room, day), as a start and a length; a non-positive length closes nothing. */
  readonly closures: readonly { readonly from: number; readonly length: number }[]
  /** The gap, treatment and turnaround pattern the placement walks, cycling. */
  readonly pattern: readonly {
    readonly gap: number
    readonly treatment: number
    readonly turnaround: number
  }[]
}

const planArbitrary = fc.record({
  openMinutes: fc.array(fc.integer({ min: 0, max: 960 }), { minLength: 0, maxLength: 3 }),
  pairs: fc.integer({ min: 0, max: 4 }),
  closures: fc.array(
    fc.record({
      from: fc.integer({ min: -120, max: 1080 }),
      length: fc.integer({ min: -60, max: 480 }),
    }),
    { minLength: 0, maxLength: 12 },
  ),
  pattern: fc.array(
    fc.record({
      gap: fc.integer({ min: 0, max: 30 }),
      treatment: fc.integer({ min: 30, max: 90 }),
      turnaround: fc.integer({ min: 0, max: 20 }),
    }),
    { minLength: 1, maxLength: 4 },
  ),
})

/** `2026-04-DD`, one date per generated day. The dates only have to be distinct and valid. */
const planDay = (at: number): LocalDate => localDate(`2026-04-${String(at + 1).padStart(2, '0')}`)

/** The closure a plan places on one (room, day), or `null` for a room that was never closed. */
function closureFor(
  plan: Plan,
  dayAt: number,
  roomAt: number,
  roomCount: number,
): { readonly from: number; readonly to: number } | null {
  const spec = plan.closures[(dayAt * roomCount + roomAt) % Math.max(plan.closures.length, 1)]
  if (spec === undefined || spec.length <= 0) return null
  return { from: spec.from, to: spec.from + spec.length }
}

/**
 * The stretches of a room-day an appointment may be placed in: the open window less the closure,
 * clipped to it.
 *
 * The placement never crosses one, which is what `resource_block` and the room-capacity trigger already
 * guarantee in the database — so the property below is a claim about the arithmetic rather than about
 * inputs the booking rules would have refused.
 */
function freeStretches(
  closed: { readonly from: number; readonly to: number } | null,
  openMinutes: number,
): readonly { readonly from: number; readonly to: number }[] {
  if (closed === null) return [{ from: 0, to: openMinutes }]
  const from = Math.max(closed.from, 0)
  const to = Math.min(closed.to, openMinutes)
  if (to <= from) return [{ from: 0, to: openMinutes }]
  return [
    { from: 0, to: from },
    { from: to, to: openMinutes },
  ]
}

/** The world a plan describes, with every appointment inside its room's open and unclosed minutes. */
function worldOf(plan: Plan): KpiInput {
  const businessDays: KpiBusinessDay[] = plan.openMinutes.map((openMinutes, at) => ({
    businessDay: planDay(at),
    openMinutes,
  }))
  const rooms = Array.from({ length: plan.pairs }, (_, at) => `room-${at}`)
  const roomDaysOut: KpiRoomDay[] = []
  const closuresOut: KpiRoomClosure[] = []
  const appointmentsOut: KpiAppointment[] = []
  const shiftsOut: KpiRosteredShift[] = []
  let patternAt = 0

  businessDays.forEach((businessDay, dayAt) => {
    rooms.forEach((roomId, roomAt) => {
      roomDaysOut.push({ businessDay: businessDay.businessDay, roomId })
      shiftsOut.push({
        businessDay: businessDay.businessDay,
        employeeId: `employee-${roomAt}`,
        rosteredMinutes: businessDay.openMinutes,
      })

      const closed = closureFor(plan, dayAt, roomAt, rooms.length)
      if (closed !== null) {
        closuresOut.push({
          businessDay: businessDay.businessDay,
          roomId,
          fromMinuteAfterOpen: closed.from,
          toMinuteAfterOpen: closed.to,
        })
      }

      for (const stretch of freeStretches(closed, businessDay.openMinutes)) {
        let cursor = stretch.from
        for (;;) {
          const step = plan.pattern[patternAt % plan.pattern.length]
          if (step === undefined) break
          const start = cursor + step.gap
          const end = start + step.treatment + step.turnaround
          if (end > stretch.to) break
          patternAt += 1
          appointmentsOut.push({
            businessDay: businessDay.businessDay,
            roomId,
            employeeId: `employee-${roomAt}`,
            isDelivered: true,
            treatmentMinutes: step.treatment,
            turnaroundMinutes: step.turnaround,
          })
          cursor = end
        }
      }
    })
  })

  return {
    businessDays,
    roomDays: roomDaysOut,
    roomClosures: closuresOut,
    appointments: appointmentsOut,
    rosteredShifts: shiftsOut,
    revenueLines: [],
  }
}

describe('utilisation over generated rosters and bookings', () => {
  it(
    'never exceeds 100%, and names an empty denominator instead of returning NaN, Infinity or 0',
    () => {
      let busy = 0
      let emptyDenominator = 0

      fc.assert(
        fc.property(planArbitrary, (plan: Plan) => {
          const world = worldOf(plan)
          for (const id of ['room_utilisation', 'therapist_utilisation'] as const) {
            const result = resolveKpi(id).compute(world)
            if (isNoDenominator(result)) {
              emptyDenominator += 1
              expect(result.divisorFormula).not.toBe('')
              continue
            }
            expect(
              exceedsUnity(result.value),
              `${id} exceeded 100% on ${JSON.stringify(plan)}`,
            ).toBe(false)
            expect(isNegativeRational(result.value)).toBe(false)
            const published = scaledFigure(result.value, 4)
            expect(Number.isFinite(Number(published))).toBe(true)
            if (id === 'room_utilisation' && published >= 2500n) busy += 1
          }

          // The denominator itself, which is what both ratios rest on.
          const hours = resolveKpi('available_room_hours').compute(world)
          if (!isNoDenominator(hours)) expect(isNegativeRational(hours.value)).toBe(false)
        }),
        { numRuns: RUNS },
      )

      // Measured floors, each about half its observed minimum over eight runs. See the block comment.
      expect(busy, 'the generator produced too few schedules that could disagree').toBeGreaterThan(
        70,
      )
      expect(
        emptyDenominator,
        'the generator produced too few worlds with an empty denominator',
      ).toBeGreaterThan(110)
    },
    TIMEOUT_MS,
  )
})

// --- the expression language itself ---------------------------------------------------------------

describe('the expression language', () => {
  /**
   * The nodes no shipped KPI uses YET, exercised directly.
   *
   * `sum` is the obvious one: nothing in R-REP-03 adds two measures, and R-REP-04's contribution margin
   * — net price less therapist cost, consumables, room consumables and the payment fee — is a sum of
   * four. A node that ships untested is a node whose first user debugs it, and the coverage floor on
   * `packages/core` exists to say so.
   */
  const probeRegistry = buildKpiRegistry([...KPI_SPECS], [...KPI_MEASURES])

  const evaluate = (expr: Parameters<typeof renderExpr>[0]) =>
    evaluateExpr(expr, {
      input: REGISTRY_PROBE,
      measures: probeRegistry.measuresById,
      kpis: probeRegistry.specsById,
    })

  const units = { measures: probeRegistry.measuresById, kpis: probeRegistry.specsById }

  it('adds the terms of a sum exactly, in rational arithmetic', () => {
    const open = evaluate(measureRef('room_open_minutes'))
    const closed = evaluate(measureRef('room_closure_minutes'))
    const both = evaluate(
      sumOf(measureRef('room_open_minutes'), measureRef('room_closure_minutes')),
    )
    if (!open.ok || !closed.ok || !both.ok) throw new Error('the probe produced no figure')
    expect(both.value).toEqual(rational(open.value.numerator + closed.value.numerator, 1n))
    // Rationals, not integers: a half plus a third is five sixths and not zero.
    expect(addRational(rational(1n, 2n), rational(1n, 3n))).toEqual(rational(5n, 6n))
    expect(subtractRational(rational(1n, 2n), rational(1n, 3n))).toEqual(rational(1n, 6n))
    expect(divideRational(rational(1n, 2n), rational(0n, 3n))).toBeNull()
  })

  it('stops folding a sum at the first term with no denominator', () => {
    // A sum whose second term divides by zero has no value, and the fold must say so rather than add
    // whatever the first term was to a figure that does not exist.
    const outcome = evaluate(
      sumOf(measureRef('room_open_minutes'), quotientOf(constant(1n), constant(0n))),
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('narrowing failed')
    expect(outcome.divisorFormula).toBe('0')
    // And the term order is not what decides it: a sum whose every term resolves has a value.
    const whole = evaluate(sumOf(constant(2n), constant(3n)))
    expect(whole.ok && whole.value).toEqual(wholeRational(5n))
  })

  it('reports every name an expression reaches, once, in printing order', () => {
    const expr = differenceOf(
      sumOf(measureRef('room_open_minutes'), measureRef('room_open_minutes')),
      quotientOf(kpiRef('available_room_minutes'), measureRef('room_closure_minutes')),
    )
    expect(referencesOf(expr)).toEqual({
      measures: ['room_open_minutes', 'room_closure_minutes'],
      kpis: ['available_room_minutes'],
    })
    expect(renderExpr(expr)).toBe(
      '(room_open_minutes + room_open_minutes) − (available_room_minutes ÷ room_closure_minutes)',
    )
  })

  it('refuses a name nothing defines, at evaluation rather than at render time', () => {
    // A dangling reference renders perfectly well — it is just a word — so the refusal has to be here.
    expect(renderExpr(measureRef('minutes_nobody_measures'))).toBe('minutes_nobody_measures')
    expect(() => evaluate(measureRef('minutes_nobody_measures'))).toThrow(UnknownKpiReference)
    expect(() => evaluate(kpiRef('occupancy'))).toThrow(UnknownKpiReference)
  })

  it('implies a unit only where the arithmetic has one', () => {
    expect(unitOfExpr(constant(60n), units)).toBeNull()
    expect(unitOfExpr(measureRef('minutes_nobody_measures'), units)).toBeNull()
    expect(unitOfExpr(sumOf(), units)).toBeNull()
    expect(
      unitOfExpr(sumOf(measureRef('room_open_minutes'), measureRef('room_closure_minutes')), units),
    ).toBe('minutes')
    // Minutes plus fils is not a quantity, and neither is minutes less fils.
    expect(
      unitOfExpr(
        sumOf(measureRef('room_open_minutes'), measureRef('treatment_net_revenue_fils')),
        units,
      ),
    ).toBeNull()
    expect(
      unitOfExpr(
        differenceOf(measureRef('room_open_minutes'), measureRef('treatment_net_revenue_fils')),
        units,
      ),
    ).toBeNull()
    // Minutes over 30 is half-hours, which is not a unit this build has a word for.
    expect(unitOfExpr(quotientOf(measureRef('room_open_minutes'), constant(30n)), units)).toBeNull()
    // Fils over MINUTES is fils per room-minute: a figure sixty times smaller that would read as a
    // plausible RevPARH, so it is refused rather than labelled.
    expect(
      unitOfExpr(
        quotientOf(measureRef('treatment_net_revenue_fils'), measureRef('room_open_minutes')),
        units,
      ),
    ).toBeNull()
  })

  it('leaves a measure and a constant alone when expanding', () => {
    expect(expandExpr(measureRef('room_open_minutes'), () => undefined)).toEqual(
      measureRef('room_open_minutes'),
    )
    expect(expandExpr(constant(60n), () => undefined)).toEqual(constant(60n))
    // A reference the lookup does not know stays a name rather than disappearing.
    expect(renderExpr(expandExpr(kpiRef('occupancy'), () => undefined))).toBe('occupancy')
    expect(
      renderExpr(
        expandExpr(sumOf(kpiRef('a'), constant(1n)), (id) =>
          id === 'a' ? measureRef('room_open_minutes') : undefined,
        ),
      ),
    ).toBe('room_open_minutes + 1')
  })
})
