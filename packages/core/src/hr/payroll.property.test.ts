import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { localDate } from '../time.ts'
import { filsForWeightedMinuteBp, type LabourCostRules } from './labour-cost.ts'
import {
  computePayslip,
  overtimeUpliftMinuteBp,
  PAYSLIP_EARNING_COMPONENTS,
  type Payslip,
  priceOvertimeUplift,
  summarisePayroll,
} from './payroll.ts'

/**
 * The payslip identity over random figures, against an exact-arithmetic oracle.
 *
 * ## What the property is, and what it is NOT
 *
 * The claim is `basic + allowances + overtime + commission + tips − deductions = net`, per employee and in
 * total, **in exact integer arithmetic**. So the oracle is `BigInt`: the same identity in a representation
 * that cannot drift. An oracle using a different formula would be testing whether the formula is right,
 * which `./payroll.test.ts` does by worked example — figures somebody can check on paper, which no property
 * can be.
 *
 * ## The generator has to be able to exercise the claim, and this one is counted (brief rule 22)
 *
 * Two ways a generator here goes vacuous, and both are measured rather than reasoned about:
 *
 *   1. **Every component zero.** A run of payslips whose components are all zero satisfies the identity for
 *      any implementation at all, including one that ignored four of the five terms. So the property counts
 *      how many generated payslips have EVERY component non-zero — the only cases in which a dropped term
 *      changes the answer — and asserts that count against a floor measured from a run of this file.
 *   2. **A single payslip.** "In total" says nothing over one row. The generator therefore produces two or
 *      more, and the count of multi-payslip cases is asserted too.
 *
 * ## The census, and why the property alone is not enough
 *
 * {@link droppedTermCensus} walks a DETERMINISTIC corpus with an implementation that drops the tips term —
 * the likeliest real mistake in a five-term sum, because tips are the term added last — and counts how many
 * cases it gets wrong. An exact count over a fixed corpus rather than a floor, because a floor set just
 * under an observed minimum becomes its own flake (brief rule 22), while a count over a corpus that does not
 * move cannot. If it changes, the generator changed, and that is worth failing over.
 *
 * `Math.random` is unavailable here — `scripts/check-core-purity.mjs` walks every `.ts` under
 * `packages/core/src` including this one — so the census generator is an LCG, `labour-cost.property.test.ts`'s
 * arrangement for its reason.
 */

const RULES: LabourCostRules = {
  effectiveFrom: localDate('1900-01-01'),
  monthlyWageDaysDivisor: 30,
  paidMinutesPerDay: 480,
}

interface Figures {
  readonly basic: number
  readonly allowances: number
  readonly overtime: number
  readonly commission: number
  readonly tips: number
  readonly deductions: number
}

/** The identity in exact arithmetic. The oracle. */
function exactNet(figures: Figures): bigint {
  const gross =
    BigInt(figures.basic) +
    BigInt(figures.allowances) +
    BigInt(figures.overtime) +
    BigInt(figures.commission) +
    BigInt(figures.tips)
  return gross - BigInt(figures.deductions)
}

function payslipOf(employeeId: string, figures: Figures): Payslip {
  return computePayslip({
    employeeId,
    basicWageFils: figures.basic,
    allowancesFils: figures.allowances,
    overtimeFils: figures.overtime,
    commission:
      figures.commission === 0
        ? { fils: 0, runId: null, ruleVersion: null }
        : { fils: figures.commission, runId: `r-${employeeId}`, ruleVersion: 1 },
    tipsFils: figures.tips,
    deductionsFils: figures.deductions,
  })
}

/**
 * Figures a real payroll produces: a monthly wage in whole AED, and components that are often but not
 * always zero.
 *
 * `basic` is at least one fil, because an employee with no wage has no payslip at all (`computePayslip`
 * refuses one) and generating that case would only exercise the refusal. `deductions` is bounded by the
 * gross, because a deduction above it is refused — a separate claim, asserted by worked example.
 */
const figuresArb = fc
  .record({
    basicAed: fc.integer({ min: 1, max: 50_000 }),
    allowances: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 400_000 })),
    overtime: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 200_000 })),
    commission: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 300_000 })),
    tips: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 50_000 })),
    deductionRatio: fc.integer({ min: 0, max: 100 }),
  })
  .map((raw): Figures => {
    const basic = raw.basicAed * 100
    const gross = basic + raw.allowances + raw.overtime + raw.commission + raw.tips
    return {
      basic,
      allowances: raw.allowances,
      overtime: raw.overtime,
      commission: raw.commission,
      tips: raw.tips,
      // Floored, so it can never exceed gross and the property stays about the identity.
      deductions: Math.floor((gross * raw.deductionRatio) / 100),
    }
  })

const everyComponentNonZero = (figures: Figures): boolean =>
  figures.basic > 0 &&
  figures.allowances > 0 &&
  figures.overtime > 0 &&
  figures.commission > 0 &&
  figures.tips > 0

describe('the payslip identity holds in exact arithmetic over random figures', () => {
  it('per employee, with the exercising cases counted', () => {
    let exercising = 0
    let cases = 0
    fc.assert(
      fc.property(figuresArb, (figures) => {
        cases += 1
        if (everyComponentNonZero(figures)) exercising += 1
        const payslip = payslipOf('e-1', figures)
        expect(BigInt(payslip.netFils)).toBe(exactNet(figures))
        expect(BigInt(payslip.grossFils)).toBe(exactNet(figures) + BigInt(figures.deductions))
      }),
      { numRuns: 500 },
    )
    /*
      The vacuity floor, MEASURED and not guessed (brief rule 22).

      Each of the four optional components is zero with probability about 1/2 under `fc.oneof` of a constant
      and a range, so all four non-zero should be about one case in sixteen — roughly 31 of 500. MEASURED
      over eight runs of this file: 21, 25, 26, 29, 30, 32, 33, 33, so the lowest observed is 21 and the
      prediction holds.

      The floor is 12, a little over half the observed minimum rather than just under it, because a floor set
      at the minimum becomes its own flake (brief rule 22 says so in as many words). What it guards against
      is not an unlucky run — it is a generator change that made every component zero, which would take this
      count to 0 and leave the property passing for an implementation that ignored four of the five terms.
    */
    expect(cases).toBe(500)
    expect(
      exercising,
      'too few generated payslips have every component non-zero, so a dropped term would not change the ' +
        'answer in most cases and this property would be close to vacuous',
    ).toBeGreaterThanOrEqual(12)
  })

  it('in total across a run, over two or more payslips', () => {
    let multi = 0
    fc.assert(
      fc.property(fc.array(figuresArb, { minLength: 2, maxLength: 12 }), (rows) => {
        if (rows.length >= 2) multi += 1
        const payslips = rows.map((figures, index) => payslipOf(`e-${index}`, figures))
        const summary = summarisePayroll(payslips)
        const expected = rows.reduce((total, figures) => total + exactNet(figures), 0n)
        expect(BigInt(summary.netTotalFils)).toBe(expected)
        // And each component total, so a term that is summed into the wrong bucket is caught as well as one
        // that is dropped.
        for (const key of PAYSLIP_EARNING_COMPONENTS) {
          const own = rows.reduce(
            (total, figures) =>
              total +
              BigInt(
                key === 'basic'
                  ? figures.basic
                  : key === 'allowances'
                    ? figures.allowances
                    : key === 'overtime'
                      ? figures.overtime
                      : key === 'commission'
                        ? figures.commission
                        : figures.tips,
              ),
            0n,
          )
          expect(BigInt(summary.componentTotalsFils[key])).toBe(own)
        }
      }),
      { numRuns: 300 },
    )
    expect(
      multi,
      'the generator produced no multi-payslip run, so "in total" measured nothing',
    ).toBe(300)
    // A property over hundreds of cases needs an explicit timeout and a reason (brief rule 21): the default
    // is 5,000 ms and 300 runs of a 12-payslip summary is comfortably inside it alone, and not on a machine
    // running the whole suite under coverage.
  }, 30_000)
})

/** A 32-bit LCG. Deterministic, so the census below is a measurement rather than a sample. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

/**
 * How many of a fixed corpus an implementation that DROPS the tips term gets wrong.
 *
 * The likeliest real mistake in a five-term sum is the term added last, and tips are the newest concept in
 * this unit. A wrong implementation is only caught by a case whose tips are non-zero, which is exactly what
 * this counts — so the number is the property's power, stated rather than assumed.
 */
function droppedTermCensus(): { readonly cases: number; readonly caught: number } {
  const random = lcg(20_260_928)
  let caught = 0
  const cases = 20_000
  for (let index = 0; index < cases; index += 1) {
    const basic = (1 + Math.floor(random() * 50_000)) * 100
    const allowances = random() < 0.5 ? 0 : Math.floor(random() * 400_000)
    const overtime = random() < 0.5 ? 0 : Math.floor(random() * 200_000)
    const commission = random() < 0.5 ? 0 : Math.floor(random() * 300_000)
    const tips = random() < 0.5 ? 0 : Math.floor(random() * 50_000)
    const gross = basic + allowances + overtime + commission + tips
    const deductions = Math.floor((gross * Math.floor(random() * 101)) / 100)

    const right = Number(exactNet({ basic, allowances, overtime, commission, tips, deductions }))
    // The wrong implementation: tips never added.
    const wrong = basic + allowances + overtime + commission - deductions
    if (right !== wrong) caught += 1
  }
  return { cases, caught }
}

describe('the census: the corpus can actually catch a dropped term', () => {
  it('catches an implementation that never adds the tips, on an exact count', () => {
    const census = droppedTermCensus()
    expect(census.cases).toBe(20_000)
    /*
      An EXACT count over a deterministic corpus, not a floor. A floor set just under an observed minimum
      becomes its own flake (brief rule 22); a count over a corpus that cannot move cannot. If this number
      changes, the generator changed — which is worth failing over, because the generator is what decides
      whether the property above measures anything.
    */
    expect(census.caught).toBe(10_021)
    // And the direction that would make the census itself vacuous: it must not catch everything either, or
    // it would pass for a corpus of all-tips-nonzero cases that exercised nothing else.
    expect(census.caught).toBeLessThan(census.cases)
  })
})

describe('the overtime uplift, priced through the one shared formula', () => {
  it('never exceeds pricing the whole weighted total, and is zero exactly when there is no uplift', () => {
    let withUplift = 0
    fc.assert(
      fc.property(
        fc.record({
          basicAed: fc.integer({ min: 1, max: 50_000 }),
          ordinaryMinutes: fc.integer({ min: 0, max: 12_000 }),
          upliftMinutes: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 600 })),
          upliftMultiplierBp: fc.integer({ min: 10_000, max: 20_000 }),
        }),
        (raw) => {
          const basicWageFils = raw.basicAed * 100
          const payableMinutes = raw.ordinaryMinutes + raw.upliftMinutes
          const weightedMinuteBp =
            raw.ordinaryMinutes * 10_000 + raw.upliftMinutes * raw.upliftMultiplierBp
          const uplift = overtimeUpliftMinuteBp({
            payableMinutes,
            weightedMinuteBp,
            ordinaryMultiplierBp: 10_000,
          })
          // The identity the uplift IS: minutes times the excess multiplier.
          expect(uplift).toBe(raw.upliftMinutes * (raw.upliftMultiplierBp - 10_000))
          if (uplift > 0) withUplift += 1

          const fils = priceOvertimeUplift({ basicWageFils, upliftMinuteBp: uplift, rules: RULES })
          // Priced through the SAME primitive the roster forecast uses, so the two cannot round differently.
          expect(fils).toBe(
            filsForWeightedMinuteBp({ basicWageFils, weightedMinuteBp: uplift, rules: RULES }),
          )
          // And never more than pricing the whole total, which is the double-payment defect.
          expect(fils).toBeLessThanOrEqual(
            filsForWeightedMinuteBp({ basicWageFils, weightedMinuteBp, rules: RULES }),
          )
        },
      ),
      { numRuns: 400 },
    )
    /*
      Measured floor, for the reason above. `upliftMinutes` is zero about half the time and the multiplier
      equals 10,000 for 1 draw in 10,001, so about 200 of 400 cases should carry a real uplift. MEASURED over
      eight runs: 186, 186, 188, 193, 193, 199, 199, 222 — lowest 186. The floor is 80, well under it, and
      what it guards against is a generator that produced no uplift at all, which would make every assertion
      here about the zero case.
    */
    expect(
      withUplift,
      'no generated case carried a real uplift, so this property only exercised the zero path',
    ).toBeGreaterThanOrEqual(80)
  }, 30_000)
})
