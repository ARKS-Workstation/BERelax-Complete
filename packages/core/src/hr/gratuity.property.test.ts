import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { localDate } from '../time.ts'
import {
  accrueGratuityMonth,
  type GratuityRules,
  type GratuityServiceHistory,
  gratuityLiabilityAt,
  gratuityRulesFor,
  MONTH_LENGTH_LCM,
} from './gratuity.ts'
import { daysInMonthOf, monthEnd, monthStart } from './leave-accrual.ts'
import { addMonths } from '../money/recurring-schedule.ts'

/**
 * The gratuity engine's invariants, over randomised policies, wages and service histories.
 *
 * ## The four statements
 *
 *   1. **No drift.** For any service history, any policy and any wage, the sum of the monthly movements
 *      equals the whole liability at the end of the run, exactly, in integers. This is the claim ADR 0057
 *      is about, and it is the reason the cumulative figure is the primitive rather than the month's.
 *   2. **Never understated.** The stored liability is at or above the exact rational entitlement. A
 *      liability one fil short is money owed that no figure anywhere shows, so the rounding may only ever
 *      err upwards — and by at most one fil, which is also asserted, because "round up" satisfied by
 *      adding a dirham is not the rule.
 *   3. **Monotone.** A longer service and a higher wage never produce a smaller liability, and an unpaid
 *      leave day never produces a larger one. These are the three directions somebody would get backwards
 *      by inverting a comparison, and each is invisible in a single figure.
 *   4. **Order-independent.** `gratuityRulesFor` returns the same version whatever order the list arrives
 *      in, because a policy list arrives in whatever order a query returned it.
 *
 * ## Why there are mutants, and why the corpus is fixed
 *
 * A property suite whose checker cannot fail asserts nothing, however many cases it runs (ADR 0002). So
 * the same corpus is replayed through four **mutant engines**, each of which is an implementation somebody
 * would actually write, and each must be caught:
 *
 *   - `mutantPerMonthRounding` rounds each month's twelfth on its own and adds them up. This is the
 *     obvious implementation and it is the one this module exists to avoid: the residue is permanent in an
 *     append-only journal and grows over a career.
 *   - `mutantFloorRounding` rounds the cumulative figure DOWN. Indistinguishable from the correct engine
 *     in most months and always wrong in the one direction that cannot be noticed.
 *   - `mutantIgnoresUnpaidLeave` earns on employed days rather than paid ones, so the policy flag does
 *     nothing. Caught only by a case that HAS an unpaid day in an earning month, which is why that count
 *     is asserted rather than hoped for (brief rule 22).
 *   - `mutantBandAtMonthStart` decides the band at the month START. Caught only by a service whose
 *     anniversary falls mid-month inside the window, which is likewise counted.
 *
 * **The corpus is a fixed-seed sample, taken once, and every property and every mutant runs over that
 * same array.** Brief rule 22 warns that a floor set just under an observed minimum becomes its own
 * flake; a fixed corpus removes the floor entirely — the discriminating counts are exact integers about a
 * known set of cases, so a generator change that stopped exercising a claim fails loudly instead of
 * quietly passing a threshold.
 *
 * ## Cost
 *
 * The explicit timeouts are not decoration. `vitest.config.ts` declares no `testTimeout`, so the default
 * is 5,000 ms, and this file walks several hundred service histories of up to ten years — tens of
 * thousands of month contributions — five times over, while other worktrees run their own verify on the
 * same four cores. A correctness test that fails on a loaded machine fails with a message about a
 * timeout, which names the wrong thing entirely (brief rule 21).
 */

interface Case {
  readonly rules: GratuityRules
  readonly service: GratuityServiceHistory
  readonly wageFils: number
  /** Months to walk from the employment month. */
  readonly months: number
  /** Unpaid days offered per month index, so the same case can be run with and without them. */
  readonly unpaidByIndex: readonly number[]
}

/** A policy whose every figure moves, so no property can be passing because of version 1's numbers. */
const rulesArb = fc.record({
  daysPerYearFirstBand: fc.integer({ min: 1, max: 40 }),
  daysPerYearAfterBand: fc.integer({ min: 1, max: 60 }),
  bandBoundaryYears: fc.integer({ min: 1, max: 6 }),
  dailyWageDaysDivisor: fc.integer({ min: 26, max: 31 }),
  probationMonths: fc.integer({ min: 0, max: 8 }),
  accruesDuringProbation: fc.boolean(),
})

/**
 * Employment dates spread across month lengths and across the 29 February case.
 *
 * Weighted towards mid-month starts deliberately: a first-of-the-month start can never produce a
 * straddling band boundary, so a uniform day-of-month would make `mutantBandAtMonthStart` catchable in
 * only a thirtieth of cases. The counts below say how many of the corpus actually discriminate.
 */
const employedFromArb = fc
  .tuple(
    fc.integer({ min: 2018, max: 2021 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 2, max: 28 }),
  )
  .map(([year, month, day]) =>
    localDate(
      `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    ),
  )

const caseArb: fc.Arbitrary<Case> = fc
  .record({
    rules: rulesArb,
    employedFrom: employedFromArb,
    // Wages that are and are not divisible by the divisor, so the rounding is exercised both ways.
    wageFils: fc.integer({ min: 1, max: 5_000_000 }),
    months: fc.integer({ min: 1, max: 120 }),
    unpaidByIndex: fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 121, maxLength: 121 }),
  })
  .map((raw) => ({
    rules: {
      effectiveFrom: localDate('1900-01-01'),
      wageBasis: 'basic' as const,
      unpaidLeaveDaysExcluded: true,
      ...raw.rules,
    },
    service: { employedFrom: raw.employedFrom, employedUntil: null },
    wageFils: raw.wageFils,
    months: raw.months,
    unpaidByIndex: raw.unpaidByIndex,
  }))

/**
 * The corpus: 400 cases from a fixed seed.
 *
 * `fc.sample` rather than `fc.assert`, so every property and every mutant sees the SAME cases. A mutant
 * caught on a different corpus from the one the correct engine was cleared on proves nothing about either.
 */
const CORPUS: readonly Case[] = fc.sample(caseArb, { numRuns: 400, seed: 13_0107 })

/** The months a case walks, oldest first. */
const monthsOf = (c: Case): readonly string[] => {
  const out: string[] = []
  let month = monthStart(c.service.employedFrom)
  for (let i = 0; i < c.months; i += 1) {
    out.push(month as string)
    month = addMonths(month, 1)
  }
  return out
}

/** The unpaid-day map for a case, or an empty one. */
const unpaidMapOf = (c: Case): ReadonlyMap<string, number> =>
  new Map(monthsOf(c).map((month, index) => [month, c.unpaidByIndex[index] ?? 0]))

const withUnpaid = (c: Case): GratuityServiceHistory => ({
  ...c.service,
  unpaidLeaveDaysByMonth: unpaidMapOf(c),
})

const liabilityOf = (c: Case, service: GratuityServiceHistory, asOf: string): number =>
  gratuityLiabilityAt({ rules: c.rules, service, asOf: localDate(asOf), wageFils: c.wageFils }).fils

const lastMonthEnd = (c: Case): string => monthEnd(localDate(monthsOf(c).at(-1) as string)) as string

// --- the correct engine's own claims -------------------------------------------------------------

describe('the gratuity engine, over randomised policies and service histories', () => {
  it(
    'never drifts: the monthly movements sum exactly to the liability at the end of the run',
    () => {
      let roundedCases = 0
      for (const c of CORPUS) {
        const service = withUnpaid(c)
        let already = 0
        for (const month of monthsOf(c)) {
          const accrual = accrueGratuityMonth({
            rules: c.rules,
            service,
            accrualMonth: localDate(month),
            wageFils: c.wageFils,
            alreadyAccruedFils: already,
          })
          // Over-accrual cannot arise here: the wage is constant across the run, so the cumulative figure
          // is non-decreasing and every movement is at or above zero. A negative one would mean the
          // cumulative had gone backwards on a fixed wage, which is a defect and not a case to tolerate.
          expect(accrual.overAccrued).toBe(false)
          already += accrual.movementFils
        }
        const whole = liabilityOf(c, service, lastMonthEnd(c))
        expect(already).toBe(whole)

        // Count the cases where the rounding actually bites. A corpus of exactly-divisible wages would
        // satisfy this property under `mutantPerMonthRounding` too, so the count is what says the property
        // can discriminate at all (brief rule 22).
        const exact = exactEntitlementFils(c, service, lastMonthEnd(c))
        if (!Number.isInteger(exact)) roundedCases += 1
      }
      // Exact, not a floor: the corpus is a fixed-seed sample, so this is a reproducible fact about a
      // known set of cases rather than a threshold that can drift into a flake.
      expect(roundedCases).toBe(EXPECTED_ROUNDED_CASES)
    },
    30_000,
  )

  it(
    'never understates, and never overstates by more than a fil',
    () => {
      for (const c of CORPUS) {
        const service = withUnpaid(c)
        const asOf = lastMonthEnd(c)
        const stored = liabilityOf(c, service, asOf)
        const exact = exactEntitlementFils(c, service, asOf)
        expect(stored).toBeGreaterThanOrEqual(exact)
        expect(stored - exact).toBeLessThan(1)
      }
    },
    30_000,
  )

  it(
    'is monotone in service length, in wage, and in unpaid leave',
    () => {
      let unpaidDiscriminating = 0
      for (const c of CORPUS) {
        const asOf = lastMonthEnd(c)
        const bare: GratuityServiceHistory = { ...c.service }

        // Longer service never earns less. The comparison is against the PREVIOUS month end, so it is a
        // claim about adding one month rather than about two unrelated dates.
        const months = monthsOf(c)
        if (months.length >= 2) {
          const earlier = monthEnd(localDate(months.at(-2) as string)) as string
          expect(liabilityOf(c, bare, asOf)).toBeGreaterThanOrEqual(liabilityOf(c, bare, earlier))
        }

        // A higher wage never earns less.
        const dearer = { ...c, wageFils: c.wageFils * 2 }
        expect(liabilityOf(dearer, bare, asOf)).toBeGreaterThanOrEqual(liabilityOf(c, bare, asOf))

        // An unpaid day never earns more, and where it earns strictly less the case can tell
        // `mutantIgnoresUnpaidLeave` apart from the real engine.
        const withDays = liabilityOf(c, withUnpaid(c), asOf)
        const withoutDays = liabilityOf(c, bare, asOf)
        expect(withDays).toBeLessThanOrEqual(withoutDays)
        if (withDays < withoutDays) unpaidDiscriminating += 1
      }
      expect(unpaidDiscriminating).toBe(EXPECTED_UNPAID_DISCRIMINATING)
    },
    30_000,
  )

  it('picks the same rule version whatever order the list arrives in', () => {
    // Order-independence over PERMUTATIONS of a list that can disagree. Brief rule 22's lesson from
    // `resolveConsent`: a generator whose records mostly cannot disagree makes the property hold for a
    // completely order-dependent implementation. Here every list has three versions with distinct
    // effective dates and the query date is inside the range, so every case can disagree — and the count
    // says so rather than leaving it to be assumed.
    let discriminating = 0
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 2020, max: 2030 }), { minLength: 3, maxLength: 3 }),
        fc.integer({ min: 2020, max: 2030 }),
        (years, on) => {
          const versions = years.map((year) => ({
            effectiveFrom: localDate(`${year}-01-01`),
            daysPerYearFirstBand: year - 2000,
            daysPerYearAfterBand: 30,
            bandBoundaryYears: 5,
            dailyWageDaysDivisor: 30,
            wageBasis: 'basic' as const,
            probationMonths: 6,
            accruesDuringProbation: false,
            unpaidLeaveDaysExcluded: true,
          }))
          const date = localDate(`${on}-06-30`)
          const applicable = versions.filter((v) => v.effectiveFrom <= date)
          if (applicable.length < 2) return true
          discriminating += 1
          const forward = gratuityRulesFor(versions, date)
          const backward = gratuityRulesFor([...versions].reverse(), date)
          const shuffled = gratuityRulesFor([versions[1]!, versions[2]!, versions[0]!], date)
          return (
            forward.effectiveFrom === backward.effectiveFrom &&
            forward.effectiveFrom === shuffled.effectiveFrom
          )
        },
      ),
      { numRuns: 300, seed: 130_107 },
    )
    // At least a third of the runs must have had two or more applicable versions, or the permutations
    // could not have changed the answer and the property would be about nothing.
    expect(discriminating).toBeGreaterThan(100)
  })
})

// --- the mutants, over the SAME corpus ----------------------------------------------------------

/**
 * The exact rational entitlement in fils, as a double.
 *
 * Deliberately a different expression from the engine's: the engine sums an integer numerator over a
 * common denominator and divides once in `BigInt`, and this multiplies each month's own fraction. Two
 * routes to one figure, which is what makes the comparison an oracle rather than a restatement. The
 * double is exact enough for the corpus's magnitudes and the assertion allows a fil either way.
 */
function exactEntitlementFils(
  c: Case,
  service: GratuityServiceHistory,
  asOf: string,
): number {
  const contributions = gratuityLiabilityAt({
    rules: c.rules,
    service,
    asOf: localDate(asOf),
    wageFils: c.wageFils,
  }).contributions
  let days = 0
  for (const month of contributions) {
    if (month.numerator === 0) continue
    days += (month.daysPerYear / 12) * (month.paidDays / daysInMonthOf(month.accrualMonth))
  }
  return (days * c.wageFils) / c.rules.dailyWageDaysDivisor
}

/** Rounds every month on its own and adds them up — the implementation ADR 0057 rejects. */
function mutantPerMonthRounding(c: Case, service: GratuityServiceHistory, asOf: string): number {
  const contributions = gratuityLiabilityAt({
    rules: c.rules,
    service,
    asOf: localDate(asOf),
    wageFils: c.wageFils,
  }).contributions
  let total = 0
  for (const month of contributions) {
    if (month.numerator === 0) continue
    total += Math.ceil(
      (c.wageFils * month.daysPerYear * month.paidDays) /
        (12 * c.rules.dailyWageDaysDivisor * daysInMonthOf(month.accrualMonth)),
    )
  }
  return total
}

/** Rounds the cumulative figure down. */
function mutantFloorRounding(c: Case, service: GratuityServiceHistory, asOf: string): number {
  const { numerator } = gratuityLiabilityAt({
    rules: c.rules,
    service,
    asOf: localDate(asOf),
    wageFils: c.wageFils,
  })
  return Number(
    (BigInt(c.wageFils) * BigInt(numerator)) /
      (12n * BigInt(c.rules.dailyWageDaysDivisor) * BigInt(MONTH_LENGTH_LCM)),
  )
}

describe('the checker is proved able to fail', () => {
  it(
    'catches an engine that rounds each month separately',
    () => {
      let caught = 0
      for (const c of CORPUS) {
        const service = withUnpaid(c)
        const asOf = lastMonthEnd(c)
        if (mutantPerMonthRounding(c, service, asOf) !== liabilityOf(c, service, asOf)) caught += 1
      }
      // Every case in which the rounding bites must be caught, and there must be many of them.
      expect(caught).toBe(EXPECTED_PER_MONTH_CAUGHT)
      expect(caught).toBeGreaterThan(CORPUS.length / 2)
    },
    30_000,
  )

  it(
    'catches an engine that rounds the cumulative figure down',
    () => {
      let caught = 0
      for (const c of CORPUS) {
        const service = withUnpaid(c)
        const asOf = lastMonthEnd(c)
        const floored = mutantFloorRounding(c, service, asOf)
        const stored = liabilityOf(c, service, asOf)
        if (floored !== stored) {
          caught += 1
          // And it is caught in the DIRECTION the property claims: the mutant understates.
          expect(floored).toBeLessThan(stored)
        }
      }
      expect(caught).toBe(EXPECTED_FLOOR_CAUGHT)
    },
    30_000,
  )

  it(
    'catches an engine that ignores the unpaid-leave exclusion',
    () => {
      // The mutant IS "earn on employed days": running the real engine with the flag off produces exactly
      // that answer, so no separate implementation is needed and none can drift from the real one.
      let caught = 0
      for (const c of CORPUS) {
        const asOf = lastMonthEnd(c)
        const honours = liabilityOf(c, withUnpaid(c), asOf)
        const ignores = liabilityOf(
          { ...c, rules: { ...c.rules, unpaidLeaveDaysExcluded: false } },
          withUnpaid(c),
          asOf,
        )
        if (honours !== ignores) caught += 1
      }
      expect(caught).toBe(EXPECTED_UNPAID_DISCRIMINATING)
    },
    30_000,
  )

  it(
    'catches an engine that decides the band at the month START',
    () => {
      // Shifting the decision to the month start changes the answer only for a month containing an
      // anniversary that is not the 1st — which is why `employedFromArb` never draws day 1, and why this
      // count is asserted: a generator change that started drawing first-of-month dates would make this
      // mutant uncatchable and the count would say so.
      let caught = 0
      for (const c of CORPUS) {
        const service = withUnpaid(c)
        const asOf = lastMonthEnd(c)
        const real = gratuityLiabilityAt({
          rules: c.rules,
          service,
          asOf: localDate(asOf),
          wageFils: c.wageFils,
        })
        // Rebuild the numerator deciding the band at the month start instead of its end.
        let mutantNumerator = 0
        for (const month of real.contributions) {
          if (month.withinProbation) continue
          const atStart = bandAt(c.rules, c.service.employedFrom as string, month.accrualMonth as string)
          mutantNumerator +=
            atStart * month.paidDays * (MONTH_LENGTH_LCM / daysInMonthOf(month.accrualMonth))
        }
        if (mutantNumerator !== real.numerator) caught += 1
      }
      expect(caught).toBe(EXPECTED_BAND_CAUGHT)
      expect(caught).toBeGreaterThan(0)
    },
    30_000,
  )
})

/** The band rate at a date, computed independently of the engine so the mutant is a real alternative. */
function bandAt(rules: GratuityRules, employedFrom: string, on: string): number {
  let years = 0
  while ((addMonths(localDate(employedFrom), (years + 1) * 12) as string) <= on) years += 1
  return years >= rules.bandBoundaryYears ? rules.daysPerYearAfterBand : rules.daysPerYearFirstBand
}

/**
 * The MEASURED discriminating counts for the fixed corpus above.
 *
 * Exact integers and not floors. The corpus is a fixed-seed `fc.sample`, so these are reproducible facts
 * about a known set of 400 cases; brief rule 22 warns that a floor set just under an observed minimum
 * becomes its own flake, and an exact count over a fixed corpus has no floor to set. Change the seed, the
 * corpus size or a generator and these fail by name — which is the point: a generator that stopped
 * exercising a claim would otherwise keep the properties green while proving nothing.
 */
const EXPECTED_ROUNDED_CASES = 369
const EXPECTED_PER_MONTH_CAUGHT = 354
const EXPECTED_FLOOR_CAUGHT = 369
const EXPECTED_UNPAID_DISCRIMINATING = 349
const EXPECTED_BAND_CAUGHT = 213
