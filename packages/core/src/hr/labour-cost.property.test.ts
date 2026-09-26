import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type LocalDate, localDate } from '../time.ts'
import { type EmployeeWage, forecastLabourCost, type LabourCostRules } from './labour-cost.ts'
import { emptyBucketMinutes } from './rates.ts'
import type { TradingDayHours } from './working-hours.ts'

/**
 * The forecast against an integer oracle, over random rotas, asserting exact equality.
 *
 * ## The oracle, and why BigInt is the right one for this claim
 *
 * The claim under test is **"no floating-point drift"** — a claim about the REPRESENTATION of the
 * arithmetic and not about the formula. So the oracle is the same formula in exact arithmetic: `BigInt`,
 * with the ceiling taken as `(n + d - 1) / d` on integers. An oracle that used a different formula would
 * be testing whether the formula is right, which is `./labour-cost.test.ts`'s job and is done there by
 * worked example — a figure somebody can check on paper, which no property can be.
 *
 * ## The generator has to be able to exercise the claim, and this one could not at first
 *
 * The first version of this file generated a uniform random wage and a uniform random basis-point-minute
 * total, and a deliberately WRONG float implementation agreed with the oracle on all 200,000 cases. The
 * reason is arithmetic rather than luck: a float error of one part in 10^15 only changes a CEILING when
 * the exact quotient is within that of a whole number, and with a denominator of 144,000,000 a uniform
 * random numerator lands there about once in 10^8 draws.
 *
 * But a real rota lands there constantly. An ordinary eight-hour day at the ordinary rate is exactly one
 * thirtieth of a monthly wage, so the quotient is a whole number whenever the wage divides by 30 — which
 * a wage in whole AED usually does. The generator therefore produces what a rota produces: whole minutes
 * at the ordinary and night multipliers, and wages in whole AED. With that, the wrong implementation is
 * caught.
 *
 * {@link driftCensus} is how this file proves it rather than asserting it: a DETERMINISTIC corpus, walked
 * by a seeded generator of this file's own, counting how many cases the rate-first float implementation
 * gets wrong. The count is a measurement — 49 of 20,000 — and it is asserted exactly rather than as a
 * floor, because a floor set just under an observed minimum becomes its own flake (brief rule 22) while an
 * exact count over a fixed corpus cannot. If it ever changes, the generator changed, and that is worth
 * failing over.
 *
 * ## Measured: the fast-check property alone does NOT catch the float implementation
 *
 * This is the reason the census exists and is not belt and braces. Gate case 108i splices the rate-first
 * implementation into `lineFils` and runs this file: the census case fails and the two `fc.assert`
 * properties above it **pass**. 300 runs of the weighted generator produced no rota whose exact quotient
 * was close enough to a whole number for the float error to change a ceiling, so the property that reads
 * like the acceptance criterion is not the assertion doing the work.
 *
 * Two consequences, both acted on rather than noted. The gate case asserts the CENSUS's name, because that
 * is the layer whose wording is load-bearing. And the property below COUNTS how many of its generated lines
 * could have exposed drift at all — the lines whose quotient is exact — and asserts that count against a
 * floor, so a generator change that made the property vacuous fails here instead of going quiet.
 *
 * `Math.random` is unavailable here: `scripts/check-core-purity.mjs` walks every `.ts` under
 * `packages/core/src` including this one, so the census generator is an LCG.
 */

/** Version 1 of `labour_cost_rule`: a monthly wage covers 30 days of 480 paid minutes. */
const VERSION_ONE: LabourCostRules = {
  effectiveFrom: localDate('1900-01-01'),
  monthlyWageDaysDivisor: 30,
  paidMinutesPerDay: 480,
}

const MULTIPLIER_BP = {
  ordinary: 10_000,
  overtime: 12_500,
  night: 15_000,
  publicHoliday: 15_000,
} as const

/** The exact answer, in whole fils, rounded up. `BigInt` throughout, so nothing can drift. */
function oracleFils(args: {
  readonly basicWageFils: number
  readonly weightedMinuteBp: number
  readonly rules: LabourCostRules
}): number {
  const numerator = BigInt(args.basicWageFils) * BigInt(args.weightedMinuteBp)
  const denominator =
    BigInt(args.rules.monthlyWageDaysDivisor) * BigInt(args.rules.paidMinutesPerDay) * 10_000n
  return Number((numerator + denominator - 1n) / denominator)
}

/**
 * The mistake this whole file exists to catch: a rate per minute computed first, then applied.
 *
 * It is the natural way to write it and it is what ADR 0007 forbids. 300,000 fils over 14,400 minutes is
 * 20.833… fils a minute, which has no exact representation, so the product drifts a hair either side of
 * the whole number and the ceiling lands one fil out.
 */
function rateFirstFloatFils(args: {
  readonly basicWageFils: number
  readonly weightedMinuteBp: number
  readonly rules: LabourCostRules
}): number {
  const filsPerMinute =
    args.basicWageFils / (args.rules.monthlyWageDaysDivisor * args.rules.paidMinutesPerDay)
  return Math.ceil((filsPerMinute * args.weightedMinuteBp) / 10_000)
}

/** One employee-day, built from bucket minutes exactly as `summariseWorkedHours` returns one. */
function dayOf(args: {
  readonly employeeId: string
  readonly tradingDate: LocalDate
  readonly ordinary: number
  readonly overtime: number
  readonly night: number
  readonly publicHoliday: number
}): TradingDayHours {
  const minutes = {
    ...emptyBucketMinutes(),
    ordinary: args.ordinary,
    overtime: args.overtime,
    night: args.night,
    publicHoliday: args.publicHoliday,
  }
  let totalMinutes = 0
  let weightedMinuteBp = 0
  for (const bucket of ['publicHoliday', 'night', 'overtime', 'ordinary'] as const) {
    totalMinutes += minutes[bucket]
    weightedMinuteBp += minutes[bucket] * MULTIPLIER_BP[bucket]
  }
  return {
    employeeId: args.employeeId,
    tradingDate: args.tradingDate,
    totalMinutes,
    minutes,
    multiplierBp: MULTIPLIER_BP,
    weightedMinuteBp,
    overtimeMinutes: minutes.overtime,
    overtimeBeyondCapMinutes: 0,
    isPublicHoliday: minutes.publicHoliday > 0,
    shiftIds: [`shift-${args.employeeId}-${args.tradingDate}`],
  }
}

/** Four trading dates, so a rota spans days without the generator having to build a calendar. */
const DATES: readonly LocalDate[] = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'].map(
  (date) => localDate(date),
)

/**
 * A rota: a handful of employees, each on one to four of the dates, with realistic bucket minutes.
 *
 * Wages in WHOLE AED — a hundred fils — because that is what a wage is, and because it is what puts the
 * exact quotient on a whole number often enough for a float error to change the answer. See the header.
 */
const rotaArbitrary = fc
  .record({
    // Two to five employees, wages 1,500 to 12,000 AED a month, some of them unpriced.
    wages: fc.array(
      fc.record({
        wholeAed: fc.integer({ min: 1_500, max: 12_000 }),
        priced: fc.boolean(),
      }),
      { minLength: 2, maxLength: 5 },
    ),
    // One bucket split per employee per date. 0 is allowed for a date they are not on.
    splits: fc.array(
      fc.array(
        fc.record({
          ordinary: fc.integer({ min: 0, max: 540 }),
          overtime: fc.integer({ min: 0, max: 120 }),
          night: fc.integer({ min: 0, max: 240 }),
          publicHoliday: fc.integer({ min: 0, max: 480 }),
        }),
        { minLength: 4, maxLength: 4 },
      ),
      { minLength: 5, maxLength: 5 },
    ),
  })
  .map(({ wages, splits }) => {
    const employees = wages.map((wage, index) => ({
      employeeId: `t${index}`,
      basicWageFils: wage.priced ? wage.wholeAed * 100 : null,
    })) satisfies EmployeeWage[]
    const days: TradingDayHours[] = []
    for (const [index, employee] of employees.entries()) {
      for (const [dateIndex, date] of DATES.entries()) {
        const split = splits[index]?.[dateIndex]
        if (split === undefined) continue
        const total = split.ordinary + split.overtime + split.night + split.publicHoliday
        // A day with no minutes is not a rostered day; `summariseWorkedHours` returns no row for one, and
        // a zero-minute row here would test a shape the real input cannot have.
        if (total === 0) continue
        days.push({ ...dayOf({ employeeId: employee.employeeId, tradingDate: date, ...split }) })
      }
    }
    return { days, wages: employees }
  })

describe('acceptance — the forecast equals an integer oracle exactly, over random rotas', () => {
  it('prices every line exactly as exact integer arithmetic does', () => {
    let pricedLines = 0
    // Lines whose exact quotient is a WHOLE NUMBER, which is the only shape a float error can turn into a
    // different ceiling. Counted rather than assumed: brief rule 22's rule is that a property test's
    // generator has to be able to exercise the claim and the test has to count that.
    let exactQuotientLines = 0
    fc.assert(
      fc.property(rotaArbitrary, ({ days, wages }) => {
        const forecast = forecastLabourCost({ days, wages, ruleVersions: [VERSION_ONE] })
        const wageById = new Map(wages.map((wage) => [wage.employeeId, wage.basicWageFils]))
        const denominator =
          BigInt(VERSION_ONE.monthlyWageDaysDivisor) *
          BigInt(VERSION_ONE.paidMinutesPerDay) *
          10_000n
        for (const line of forecast.lines) {
          const basicWageFils = wageById.get(line.employeeId) ?? null
          if (basicWageFils === null) {
            expect(line.fils).toBeNull()
            continue
          }
          pricedLines += 1
          if ((BigInt(basicWageFils) * BigInt(line.weightedMinuteBp)) % denominator === 0n) {
            exactQuotientLines += 1
          }
          expect(line.fils).toBe(
            oracleFils({
              basicWageFils,
              weightedMinuteBp: line.weightedMinuteBp,
              rules: VERSION_ONE,
            }),
          )
          // And it is a whole number of fils. A float that happened to equal the oracle numerically would
          // still be a float, and `toBe` would not say so.
          expect(Number.isInteger(line.fils)).toBe(true)
        }
      }),
      { numRuns: 300 },
    )
    // The property ran over something: a few thousand priced lines, of which a measured handful are the
    // shape that can disagree. The floor is 1 rather than a figure near the observed count, because
    // fast-check draws a fresh seed each run and a floor just under an observed minimum becomes its own
    // flake — and because the claim being made is only that the corpus is not entirely incapable. What
    // proves the checker CAN fail is `driftCensus`, over a fixed corpus, below.
    expect(pricedLines).toBeGreaterThan(1_000)
    expect(exactQuotientLines).toBeGreaterThanOrEqual(1)
  })

  it('has a total that is the exact integer sum of its priced lines', () => {
    fc.assert(
      fc.property(rotaArbitrary, ({ days, wages }) => {
        const forecast = forecastLabourCost({ days, wages, ruleVersions: [VERSION_ONE] })
        let summed = 0
        for (const line of forecast.lines) summed += line.fils ?? 0
        expect(forecast.totalFils).toBe(summed)
        expect(Number.isSafeInteger(forecast.totalFils)).toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  it('names every employee once, as priced or unpriced and never both', () => {
    fc.assert(
      fc.property(rotaArbitrary, ({ days, wages }) => {
        const forecast = forecastLabourCost({ days, wages, ruleVersions: [VERSION_ONE] })
        const rostered = new Set(days.map((day) => day.employeeId))
        const named = new Set([...forecast.pricedEmployeeIds, ...forecast.unpricedEmployeeIds])
        expect(named).toEqual(rostered)
        expect(
          forecast.pricedEmployeeIds.filter((id) => forecast.unpricedEmployeeIds.includes(id)),
        ).toEqual([])
      }),
      { numRuns: 200 },
    )
  })
})

/**
 * The census: a deterministic corpus, and how many cases the wrong implementation gets wrong on it.
 *
 * An LCG with a fixed seed, so the corpus and therefore the count are the same on every machine and every
 * run. The parameters are the realistic ones the header argues for.
 */
function driftCensus(total: number): {
  readonly cases: number
  readonly implementationWrong: number
  readonly rateFirstWrong: number
} {
  let state = 123_456_789
  const next = (max: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state % max
  }
  let cases = 0
  let implementationWrong = 0
  let rateFirstWrong = 0
  for (let index = 0; index < total; index += 1) {
    const wholeAed = 1_500 + next(10_500)
    const basicWageFils = wholeAed * 100
    const ordinary = next(541)
    const night = next(241)
    if (ordinary + night === 0) continue
    cases += 1
    const days = [
      dayOf({
        employeeId: 't1',
        tradingDate: DATES[0] as LocalDate,
        ordinary,
        overtime: 0,
        night,
        publicHoliday: 0,
      }),
    ]
    const forecast = forecastLabourCost({
      days,
      wages: [{ employeeId: 't1', basicWageFils }],
      ruleVersions: [VERSION_ONE],
    })
    const weightedMinuteBp = days[0]?.weightedMinuteBp as number
    const exact = oracleFils({ basicWageFils, weightedMinuteBp, rules: VERSION_ONE })
    if (forecast.totalFils !== exact) implementationWrong += 1
    if (rateFirstFloatFils({ basicWageFils, weightedMinuteBp, rules: VERSION_ONE }) !== exact) {
      rateFirstWrong += 1
    }
  }
  return { cases, implementationWrong, rateFirstWrong }
}

describe('the control: the checker is proved able to fail', () => {
  it('catches the rate-first float implementation on a measured number of cases', () => {
    // 20,000 cases, and the figures are MEASURED on this exact corpus rather than guessed. Asserted
    // exactly: a floor just under an observed minimum becomes its own flake, while an exact count over a
    // fixed corpus cannot — and if the generator ever changes, this is the line that says so.
    const census = driftCensus(20_000)
    // Every draw is a usable case: the generator can produce a zero-minute day in principle and does not
    // in this corpus, and the count is asserted rather than assumed so a corpus that started skipping
    // cases could not quietly shrink the census.
    expect(census.cases).toBe(20_000)
    expect(census.implementationWrong).toBe(0)
    expect(census.rateFirstWrong).toBe(49)
    // The claim in the form that matters: the corpus CAN expose the defect, so the zero above is evidence
    // rather than the absence of it.
    expect(census.rateFirstWrong).toBeGreaterThan(0)
  }, 30_000)

  it('names three cases the rate-first implementation gets wrong, checked individually', () => {
    // Taken from the census and written out, so the control does not depend on the generator at all: if
    // the LCG is ever replaced these three still prove the difference is real.
    const known = [
      { basicWageFils: 584_800, ordinary: 117, night: 138, exact: 13_158 },
      { basicWageFils: 317_600, ordinary: 159, night: 230, exact: 11_116 },
      { basicWageFils: 169_600, ordinary: 201, night: 205, exact: 5_989 },
    ]
    for (const entry of known) {
      const day = dayOf({
        employeeId: 't1',
        tradingDate: DATES[0] as LocalDate,
        ordinary: entry.ordinary,
        overtime: 0,
        night: entry.night,
        publicHoliday: 0,
      })
      const forecast = forecastLabourCost({
        days: [day],
        wages: [{ employeeId: 't1', basicWageFils: entry.basicWageFils }],
        ruleVersions: [VERSION_ONE],
      })
      expect(forecast.totalFils).toBe(entry.exact)
      expect(
        rateFirstFloatFils({
          basicWageFils: entry.basicWageFils,
          weightedMinuteBp: day.weightedMinuteBp,
          rules: VERSION_ONE,
        }),
      ).toBe(entry.exact + 1)
    }
  })

  it('catches a rounding-DOWN implementation, which is the other way to be wrong', () => {
    // 6.944 fils for one ordinary minute at 1,000 AED a month. Rounded down it is 6, and a forecast that
    // understates is the error that says a rota is affordable when it is not.
    const day = dayOf({
      employeeId: 't1',
      tradingDate: DATES[0] as LocalDate,
      ordinary: 1,
      overtime: 0,
      night: 0,
      publicHoliday: 0,
    })
    const forecast = forecastLabourCost({
      days: [day],
      wages: [{ employeeId: 't1', basicWageFils: 100_000 }],
      ruleVersions: [VERSION_ONE],
    })
    const roundedDown = Math.floor((100_000 * day.weightedMinuteBp) / (30 * 480 * 10_000))
    expect(roundedDown).toBe(6)
    expect(forecast.totalFils).toBe(7)
  })
})
