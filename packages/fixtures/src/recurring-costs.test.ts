import { classifyVariance, filsFrom, forwardSchedule, money } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_FORECAST_AS_OF,
  FIXTURE_FORECAST_LOW_TOTAL_FILS,
  FIXTURE_FORECAST_MONTHS,
  FIXTURE_FORECAST_PERIODS,
  FIXTURE_FORECAST_ROW_COUNT,
  FIXTURE_FORECAST_TOTAL_FILS,
  FIXTURE_RECURRING_COSTS,
  FIXTURE_RECURRING_DEFINITIONS,
  FIXTURE_VARIANCE_CASES,
  fixtureRecurringCost,
} from './recurring-costs.ts'

/**
 * The committed recurring cost worked examples, checked against the pure schedule.
 *
 * This is the half that needs no database. `recurring-costs.itest.ts` asserts the same figures come out
 * of PostgreSQL, which is what proves the two statements of the rule agree — and it is why the numbers
 * live in `recurring-costs.ts` rather than inside either test.
 */
describe('acceptance — the 12-period forward schedule totals the committed example to the fils', () => {
  const schedule = forwardSchedule(
    FIXTURE_RECURRING_DEFINITIONS,
    FIXTURE_FORECAST_AS_OF,
    FIXTURE_FORECAST_MONTHS,
  )

  it('produces the committed number of occurrences', () => {
    // Asserted as well as the total, because 29 rows in the wrong months would still add up right.
    expect(schedule.rows).toHaveLength(FIXTURE_FORECAST_ROW_COUNT)
  })

  it('totals the committed prudent and optimistic figures', () => {
    expect(schedule.total.fils).toBe(FIXTURE_FORECAST_TOTAL_FILS)
    expect(schedule.lowTotal.fils).toBe(FIXTURE_FORECAST_LOW_TOTAL_FILS)
    // The difference between the two IS the one variable cost's band across twelve months, which is the
    // amount a forecast built on the midpoint would be wrong by.
    expect(FIXTURE_FORECAST_TOTAL_FILS - FIXTURE_FORECAST_LOW_TOTAL_FILS).toBe(
      12 * (525_000 - 210_000),
    )
  })

  it('lands each cost in the committed month, with the committed subtotal', () => {
    const byPeriod = new Map<string, { expectedFils: number; costCount: number }>()
    for (const row of schedule.rows) {
      const current = byPeriod.get(row.periodKey) ?? { expectedFils: 0, costCount: 0 }
      byPeriod.set(row.periodKey, {
        expectedFils: current.expectedFils + row.expected.fils,
        costCount: current.costCount + 1,
      })
    }
    expect([...byPeriod.keys()].sort()).toEqual(
      FIXTURE_FORECAST_PERIODS.map((period) => period.periodKey),
    )
    for (const period of FIXTURE_FORECAST_PERIODS) {
      expect(byPeriod.get(period.periodKey), period.periodKey).toEqual({
        expectedFils: period.expectedFils,
        costCount: period.costCount,
      })
    }
  })

  it('spans thirteen calendar months for a twelve-month rolling window', () => {
    // The half-open window opens on the 18th and closes on the 18th, so the first and last months are
    // partial. Asserted, because "twelve periods" read as twelve calendar months would give eleven
    // occurrences of a cost due on the 1st and twelve of one due on the 20th.
    expect(FIXTURE_FORECAST_PERIODS).toHaveLength(13)
    expect(FIXTURE_FORECAST_PERIODS[0]?.periodKey).toBe('2026-09')
    expect(FIXTURE_FORECAST_PERIODS.at(-1)?.periodKey).toBe('2027-09')
  })

  it('gives each cadence the number of occurrences its cadence implies', () => {
    const counts = new Map<string, number>()
    for (const row of schedule.rows) counts.set(row.code, (counts.get(row.code) ?? 0) + 1)
    expect(Object.fromEntries(counts)).toEqual({
      'fixture-monthly-rent': 12,
      'fixture-monthly-utilities': 12,
      'fixture-quarterly-insurance': 4,
      'fixture-annual-licence': 1,
    })
  })

  it('sums the committed per-month subtotals to the committed total', () => {
    // The control for the table itself: a typo in one month would otherwise be invisible as long as the
    // schedule agreed with it.
    expect(FIXTURE_FORECAST_PERIODS.reduce((total, period) => total + period.expectedFils, 0)).toBe(
      FIXTURE_FORECAST_TOTAL_FILS,
    )
  })
})

describe('acceptance — the committed variance cases, at the tolerance boundary on both sides', () => {
  for (const testCase of FIXTURE_VARIANCE_CASES) {
    it(`${testCase.costCode}: ${testCase.why}`, () => {
      const definition = FIXTURE_RECURRING_DEFINITIONS.find(
        (candidate) => candidate.code === testCase.costCode,
      )
      if (definition === undefined) throw new Error(`no definition for ${testCase.costCode}`)
      const verdict = classifyVariance(
        definition.expectation,
        money(filsFrom(testCase.actualGrossFils)),
      )
      expect(verdict.delta.fils).toBe(testCase.expectedDeltaFils)
      expect(verdict.tolerance.fils).toBe(testCase.expectedToleranceFils)
      expect(verdict.overTolerance).toBe(testCase.overTolerance)
    })
  }

  it('covers both sides of a boundary for both cost shapes', () => {
    // Without this the table could drift to all-within or all-over and every assertion above would
    // still pass. Both verdicts must be represented, and for a fixed cost and a variable one.
    const kinds = new Set(
      FIXTURE_VARIANCE_CASES.map(
        (testCase) => `${fixtureRecurringCost(testCase.costCode).kind}:${testCase.overTolerance}`,
      ),
    )
    expect([...kinds].sort()).toEqual([
      'fixed:false',
      'fixed:true',
      'variable:false',
      'variable:true',
    ])
  })
})

describe('the fixture register itself', () => {
  it('is unmistakably a fixture: every cost names a fixture supplier', () => {
    for (const shape of FIXTURE_RECURRING_COSTS) {
      expect(shape.supplierCode.startsWith('fixture-'), shape.code).toBe(true)
      expect(shape.code.startsWith('fixture-'), shape.code).toBe(true)
    }
  })

  it('declares an explicit tolerance on every cost, because there is no default anywhere', () => {
    for (const shape of FIXTURE_RECURRING_COSTS) {
      expect(Number.isInteger(shape.varianceToleranceBp), shape.code).toBe(true)
    }
  })

  it('covers both cost kinds and all three cadences', () => {
    expect(new Set(FIXTURE_RECURRING_COSTS.map((shape) => shape.kind))).toEqual(
      new Set(['fixed', 'variable']),
    )
    expect(new Set(FIXTURE_RECURRING_COSTS.map((shape) => shape.cadence))).toEqual(
      new Set(['monthly', 'quarterly', 'annual']),
    )
  })

  it('throws on a code that does not exist, rather than returning undefined', () => {
    expect(() => fixtureRecurringCost('fixture-not-a-cost')).toThrow(/No fixture recurring cost/)
  })
})
