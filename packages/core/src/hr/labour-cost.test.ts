import { describe, expect, it } from 'vitest'
import { type LocalDate, localDate } from '../time.ts'
import {
  type EmployeeWage,
  forecastLabourCost,
  type LabourCostRules,
  labourCostRulesFor,
} from './labour-cost.ts'
import { emptyBucketMinutes, type WorkedMinuteBucket } from './rates.ts'
import type { TradingDayHours } from './working-hours.ts'

/**
 * The labour-cost forecast, by worked example.
 *
 * Every figure below is arithmetic somebody can check on paper, which is the point: the property suite in
 * `./labour-cost.property.test.ts` proves the implementation agrees with exact integer arithmetic over
 * thousands of rotas, and proves a floating-point implementation would be caught — but a property cannot
 * say whether the FORMULA is the right one. These cases are that half.
 *
 * Version 1's divisors: a monthly wage covers 30 days of 480 paid minutes, so a 3,000 AED month is
 * 300,000 fils over 14,400 minutes — 20.8333 fils a minute, and an ordinary eight-hour day is exactly
 * one thirtieth of the month.
 */

const DAY_ONE = localDate('2026-03-04')
const DAY_TWO = localDate('2026-03-05')

/** Version 1 of `labour_cost_rule` (migration 0081). */
function rules(overrides: Partial<LabourCostRules> = {}): LabourCostRules {
  return {
    effectiveFrom: localDate('1900-01-01'),
    monthlyWageDaysDivisor: 30,
    paidMinutesPerDay: 480,
    ...overrides,
  }
}

/** One employee-day of hours, as `summariseWorkedHours(...).days` returns it. */
function day(args: {
  readonly employeeId: string
  readonly tradingDate: LocalDate
  readonly minutes: Partial<Record<WorkedMinuteBucket, number>>
}): TradingDayHours {
  const minutes = { ...emptyBucketMinutes(), ...args.minutes }
  const multiplierBp = {
    ordinary: 10_000,
    overtime: 12_500,
    night: 15_000,
    publicHoliday: 15_000,
  } as const
  let totalMinutes = 0
  let weightedMinuteBp = 0
  for (const bucket of ['publicHoliday', 'night', 'overtime', 'ordinary'] as const) {
    totalMinutes += minutes[bucket]
    weightedMinuteBp += minutes[bucket] * multiplierBp[bucket]
  }
  return {
    employeeId: args.employeeId,
    tradingDate: args.tradingDate,
    totalMinutes,
    minutes,
    multiplierBp,
    weightedMinuteBp,
    overtimeMinutes: minutes.overtime,
    overtimeBeyondCapMinutes: 0,
    isPublicHoliday: minutes.publicHoliday > 0,
    shiftIds: [`shift-${args.employeeId}-${args.tradingDate}`],
  }
}

const WAGE_3000_AED: EmployeeWage = { employeeId: 't1', basicWageFils: 300_000 }

describe('the worked examples', () => {
  it('prices an ordinary eight-hour day at exactly one thirtieth of the month', () => {
    // 300,000 fils a month over 30 days is 10,000 fils a day, and 480 ordinary minutes IS the paid day.
    // Exact, with nothing to round — which is the case a float implementation gets wrong most often,
    // because the intermediate rate of 20.8333 fils a minute is not representable.
    const forecast = forecastLabourCost({
      days: [day({ employeeId: 't1', tradingDate: DAY_ONE, minutes: { ordinary: 480 } })],
      wages: [WAGE_3000_AED],
      ruleVersions: [rules()],
    })
    expect(forecast.totalFils).toBe(10_000)
    expect(forecast.lines[0]?.fils).toBe(10_000)
  })

  it('prices a whole public-holiday day at 150 per cent of an ordinary one', () => {
    const forecast = forecastLabourCost({
      days: [day({ employeeId: 't1', tradingDate: DAY_ONE, minutes: { publicHoliday: 480 } })],
      wages: [WAGE_3000_AED],
      ruleVersions: [rules()],
    })
    expect(forecast.totalFils).toBe(15_000)
  })

  it('prices the late band: 240 ordinary minutes and 240 night minutes', () => {
    // 240 × 10,000 + 240 × 15,000 = 6,000,000 basis-point-minutes. Against 144,000,000 and a 300,000-fils
    // wage: 1.8 × 10^12 / 1.44 × 10^8 = 12,500 fils. A quarter dearer than the ordinary day, which is what
    // four hours at 1.5× on an eight-hour shift comes to.
    const forecast = forecastLabourCost({
      days: [
        day({ employeeId: 't1', tradingDate: DAY_ONE, minutes: { ordinary: 240, night: 240 } }),
      ],
      wages: [WAGE_3000_AED],
      ruleVersions: [rules()],
    })
    expect(forecast.totalFils).toBe(12_500)
  })

  it('rounds a part-minute of cost UP, because a forecast must not understate', () => {
    // One ordinary minute at 1,000 AED a month: 100,000 × 10,000 / 144,000,000 = 6.944 fils. Up to 7, and
    // the pair with the assertion below is what shows the direction is a decision rather than an accident.
    const forecast = forecastLabourCost({
      days: [day({ employeeId: 't1', tradingDate: DAY_ONE, minutes: { ordinary: 1 } })],
      wages: [{ employeeId: 't1', basicWageFils: 100_000 }],
      ruleVersions: [rules()],
    })
    expect(forecast.totalFils).toBe(7)
    expect(forecast.totalFils).not.toBe(6)
  })

  it('takes the divisors from the version governing each trading date', () => {
    // A rota spanning a divisor change: the day before it keeps the old figure. The same reason the
    // thresholds are versioned — a forecast reproduced for last March must use March's divisor.
    const forecast = forecastLabourCost({
      days: [
        day({ employeeId: 't1', tradingDate: DAY_ONE, minutes: { ordinary: 480 } }),
        day({ employeeId: 't1', tradingDate: DAY_TWO, minutes: { ordinary: 480 } }),
      ],
      wages: [WAGE_3000_AED],
      ruleVersions: [rules(), rules({ effectiveFrom: DAY_TWO, monthlyWageDaysDivisor: 20 })],
    })
    expect(forecast.lines.map((line) => line.fils)).toEqual([10_000, 15_000])
    expect(forecast.lines.map((line) => line.ruleEffectiveFrom)).toEqual([
      localDate('1900-01-01'),
      DAY_TWO,
    ])
  })
})

describe('the aggregate identity', () => {
  it('has a total that is the exact sum of the lines it prints beside it', () => {
    const forecast = forecastLabourCost({
      days: [
        day({ employeeId: 't1', tradingDate: DAY_ONE, minutes: { ordinary: 437 } }),
        day({ employeeId: 't1', tradingDate: DAY_TWO, minutes: { ordinary: 211, night: 97 } }),
        day({ employeeId: 't2', tradingDate: DAY_ONE, minutes: { ordinary: 313, overtime: 41 } }),
      ],
      wages: [WAGE_3000_AED, { employeeId: 't2', basicWageFils: 275_500 }],
      ruleVersions: [rules()],
    })
    // Deliberately awkward minute counts, so every line rounds. The identity is what stops a total that
    // disagrees with the numbers printed beside it — the defect a user finds first and trusts least.
    const summed = forecast.lines.reduce((total, line) => total + (line.fils ?? 0), 0)
    expect(forecast.totalFils).toBe(summed)
    expect(forecast.totalMinutes).toBe(437 + 211 + 97 + 313 + 41)
  })
})

describe('an employee with no wage on file', () => {
  it('is UNPRICED and named, never counted as zero', () => {
    const forecast = forecastLabourCost({
      days: [
        day({ employeeId: 't1', tradingDate: DAY_ONE, minutes: { ordinary: 480 } }),
        day({ employeeId: 't2', tradingDate: DAY_ONE, minutes: { ordinary: 480 } }),
      ],
      wages: [WAGE_3000_AED, { employeeId: 't2', basicWageFils: null }],
      ruleVersions: [rules()],
    })
    expect(forecast.unpricedEmployeeIds).toEqual(['t2'])
    expect(forecast.pricedEmployeeIds).toEqual(['t1'])
    expect(forecast.totalFils).toBe(10_000)
    // The minutes ARE knowable for an unpriced employee, and they are reported: a screen that showed
    // neither a cost nor an hours figure would have nothing to say about half the rota.
    expect(forecast.totalMinutes).toBe(960)
    expect(forecast.lines.find((line) => line.employeeId === 't2')?.fils).toBeNull()
  })

  it('makes a whole rota of unpriced therapists report 0 fils AND say why', () => {
    // The shipped state: all nineteen seeded employees have `basic_wage_fils` null. A forecast of 0 that
    // did not name them would read as a free rota, and nothing about the number would look wrong.
    const forecast = forecastLabourCost({
      days: ['t1', 't2', 't3'].map((employeeId) =>
        day({ employeeId, tradingDate: DAY_ONE, minutes: { ordinary: 480 } }),
      ),
      wages: ['t1', 't2', 't3'].map((employeeId) => ({ employeeId, basicWageFils: null })),
      ruleVersions: [rules()],
    })
    expect(forecast.totalFils).toBe(0)
    expect(forecast.unpricedEmployeeIds).toEqual(['t1', 't2', 't3'])
    expect(forecast.pricedEmployeeIds).toEqual([])
  })

  it('is not the same thing as an employee missing from the wage list, which is refused', () => {
    // Absence is a caller mistake — the read returns a row per assigned employee — and treating it as
    // unpriced would make a forgotten join indistinguishable from a wage nobody has entered.
    expect(() =>
      forecastLabourCost({
        days: [day({ employeeId: 't9', tradingDate: DAY_ONE, minutes: { ordinary: 480 } })],
        wages: [WAGE_3000_AED],
        ruleVersions: [rules()],
      }),
    ).toThrow(/does not appear in the wage list/)
  })
})

describe('the refusals', () => {
  it('refuses to invent a divisor when no version governs the date', () => {
    expect(() => labourCostRulesFor([rules({ effectiveFrom: DAY_TWO })], DAY_ONE)).toThrow(
      /No labour-cost rule version is effective/,
    )
  })

  it('refuses a divisor of zero rather than dividing by it', () => {
    expect(() => labourCostRulesFor([rules({ monthlyWageDaysDivisor: 0 })], DAY_ONE)).toThrow(
      /whole number of days/,
    )
  })

  it('refuses a fractional wage, because ADR 0007 money is integer fils', () => {
    expect(() =>
      forecastLabourCost({
        days: [day({ employeeId: 't1', tradingDate: DAY_ONE, minutes: { ordinary: 480 } })],
        wages: [{ employeeId: 't1', basicWageFils: 300_000.5 }],
        ruleVersions: [rules()],
      }),
    ).toThrow(/whole non-negative number of fils/)
  })

  it('refuses two wages for one employee', () => {
    expect(() =>
      forecastLabourCost({
        days: [day({ employeeId: 't1', tradingDate: DAY_ONE, minutes: { ordinary: 480 } })],
        wages: [WAGE_3000_AED, { employeeId: 't1', basicWageFils: 400_000 }],
        ruleVersions: [rules()],
      }),
    ).toThrow(/appears twice in the wage list/)
  })

  it('refuses a product that has left exact integer arithmetic', () => {
    // Far beyond any real wage, and that is the point: the guard fires loudly rather than returning a
    // float that looks like a whole number, which is ADR 0007 failing quietly.
    expect(() =>
      forecastLabourCost({
        days: [day({ employeeId: 't1', tradingDate: DAY_ONE, minutes: { ordinary: 900 } })],
        wages: [{ employeeId: 't1', basicWageFils: 2 ** 48 }],
        ruleVersions: [rules()],
      }),
    ).toThrow(/exceeds exact integer arithmetic/)
  })
})
