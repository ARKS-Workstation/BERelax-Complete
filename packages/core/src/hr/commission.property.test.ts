import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  COMMISSION_ROUNDING_MODES,
  type CommissionRoundingMode,
  commissionFilsFor,
  MAX_COMMISSION_BASIS_FILS,
} from './commission.ts'

/**
 * Percentage commission against an integer oracle, over a wide fils range, asserting exact equality.
 *
 * ## The oracle, and what the claim actually is
 *
 * The acceptance criterion is "integer-only arithmetic with an explicit asserted rounding direction". Two
 * claims, and they are caught by different things:
 *
 *   * **Integer-only** is a claim about the REPRESENTATION, so the oracle is the same formula in exact
 *     arithmetic — `BigInt`, with the floor as integer division and half-up as `(n + d/2) / d`. An oracle
 *     using a different formula would be testing whether the formula is right, which is
 *     `./commission.test.ts`'s job and is done there by worked example: a figure a reader can check on
 *     paper, which no property can be.
 *   * **The rounding DIRECTION** is the claim a property is bad at, and this is worth stating plainly
 *     rather than discovering later. `Math.floor(basis * rateBp / 10000)` is EXACT for every input inside
 *     `MAX_COMMISSION_BASIS_FILS`, because the product is a safe integer and the quotient of two safe
 *     integers is correctly rounded — so a property comparing a float-division implementation against the
 *     oracle can never fail, and would be a passing check that examines nothing (ADR 0002). What CAN be
 *     wrong is the direction: rounding half-up where the version says floor, or rounding to nearest where
 *     it says half-up on a tie.
 *
 * So this file does both, and {@link directionCensus} is the half that does the work.
 *
 * ## The generator has to be able to exercise the claim, and the first version could not
 *
 * A uniform random basis and a uniform random rate produce a product whose remainder modulo 10,000 is
 * uniform, so `floor` and `half_up` disagree about half the time and the tie — remainder exactly 5,000 —
 * arrives about once in 10,000 draws. The tie is the boundary the direction is DEFINED at, so a generator
 * that never produces one cannot see a half-up implementation that rounds `> .5` instead of `>= .5`.
 *
 * So the work is split, and the split is a MEASUREMENT rather than a preference. The random property draws
 * whole dirhams plus a fils jitter — what a price list and a discount produce together — and COUNTS how
 * many of its cases are ones where the two modes disagree at all, asserting that count against a floor, so
 * a generator change that made it vacuous fails there instead of going quiet (brief rule 22). It does NOT
 * assert a floor on exact TIES, because 4,000 draws produced 3 of them: a floor on that is a flake waiting
 * for the run that draws none. The tie is measured where it can be, over the deterministic census, which
 * holds 229 of them.
 *
 * Every count below is MEASURED, not reasoned, and is recorded with the run that produced it.
 *
 * `Math.random` is unavailable here — `scripts/check-core-purity.mjs` walks every `.ts` under
 * `packages/core/src` including this one — so the census generator is an LCG, exactly as
 * `./labour-cost.property.test.ts`'s is.
 */

/** The exact answer, in whole fils. `BigInt` throughout, so nothing can drift. */
function oracleFils(basisFils: number, rateBp: number, mode: CommissionRoundingMode): number {
  const numerator = BigInt(basisFils) * BigInt(rateBp)
  if (mode === 'floor') return Number(numerator / 10_000n)
  return Number((numerator + 5_000n) / 10_000n)
}

/** Deterministic, because `Math.random` is refused in `packages/core` and a census must be repeatable. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    // Numerical Recipes' constants. The high bits are the usable ones in an LCG, hence the shift.
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}

/**
 * How many cases of a fixed corpus each WRONG rounding direction gets wrong.
 *
 * A census and not a sample: the claim is "these two implementations of one direction agree", and a random
 * sample of it is a claim about the seed. The corpus is deterministic, so the counts below are exact rather
 * than a floor — and a floor set just under an observed minimum becomes its own flake (brief rule 22),
 * while an exact count over a fixed corpus cannot.
 */
/** The rates the census walks, and the bases {@link CENSUS_BASIS_DRAWS} draws per rate. */
const CENSUS_RATES = [1, 25, 100, 250, 500, 750, 1_000, 1_250, 1_500, 2_000, 2_500, 5_000, 10_000]
const CENSUS_BASIS_DRAWS = 200

/**
 * The census corpus, as `(basisFils, rateBp)` pairs. Walked by both cases below, so the one that counts
 * what the WRONG implementations get wrong and the one that checks the real one cannot diverge.
 *
 * Whole dirhams, which is what a price list holds, plus a jitter in fils so the remainder modulo 10,000 is
 * not always the same residue. 100 fils to 100,000 fils covers the catalogue's whole range.
 */
function censusCorpus(): readonly { readonly basisFils: number; readonly rateBp: number }[] {
  const next = lcg(20_970_011)
  const out: { basisFils: number; rateBp: number }[] = []
  for (const rateBp of CENSUS_RATES) {
    for (let i = 0; i < CENSUS_BASIS_DRAWS; i += 1) {
      const dirhams = 1 + Math.floor(next() * 1_000)
      out.push({ basisFils: dirhams * 100 + Math.floor(next() * 100), rateBp })
    }
  }
  return out
}

/** How one case of the corpus classifies: whether each wrong direction gets it wrong. */
function classify(
  basisFils: number,
  rateBp: number,
): {
  readonly tie: boolean
  readonly modesDisagree: boolean
  readonly nearestWrong: boolean
  readonly strictlyAboveWrong: boolean
  readonly divideFirstWrong: boolean
} {
  const product = basisFils * rateBp
  const remainder = product % 10_000
  const floorAnswer = oracleFils(basisFils, rateBp, 'floor')
  const halfUpAnswer = oracleFils(basisFils, rateBp, 'half_up')
  // "Strictly above a half goes up", which differs from half-up exactly on a tie.
  const strictlyAbove = Math.floor(product / 10_000) + (remainder > 5_000 ? 1 : 0)
  return {
    tie: remainder === 5_000,
    modesDisagree: remainder >= 5_000,
    // Rounding to NEAREST where the version says floor. The most likely mistake, because `Math.round` is
    // what a reader reaches for.
    nearestWrong: Math.round(product / 10_000) !== floorAnswer,
    strictlyAboveWrong: strictlyAbove !== halfUpAnswer,
    // Dividing before multiplying. The one that answers 0 for a small basis.
    divideFirstWrong: Math.floor(basisFils / 10_000) * rateBp !== floorAnswer,
  }
}

function directionCensus(): {
  readonly cases: number
  readonly ties: number
  readonly modesDisagree: number
  readonly nearestInsteadOfFloor: number
  readonly strictlyAboveHalfInsteadOfHalfUp: number
  readonly divideFirst: number
} {
  const corpus = censusCorpus()
  const tally = (predicate: (row: ReturnType<typeof classify>) => boolean): number =>
    corpus.filter((row) => predicate(classify(row.basisFils, row.rateBp))).length
  return {
    cases: corpus.length,
    ties: tally((row) => row.tie),
    modesDisagree: tally((row) => row.modesDisagree),
    nearestInsteadOfFloor: tally((row) => row.nearestWrong),
    strictlyAboveHalfInsteadOfHalfUp: tally((row) => row.strictlyAboveWrong),
    divideFirst: tally((row) => row.divideFirstWrong),
  }
}

describe('commission against an integer oracle', () => {
  /**
   * The corpus is fixed, so these are MEASURED counts and not budgets. They exist so that a generator
   * change which made the census blind fails here rather than going quiet: `ties` at 0 would mean the
   * half-up boundary is untested, and `nearestInsteadOfFloor` at 0 would mean the corpus cannot tell the
   * two directions apart at all.
   */
  const MEASURED = {
    cases: 2_600,
    ties: 229,
    modesDisagree: 1_233,
    nearestInsteadOfFloor: 1_233,
    strictlyAboveHalfInsteadOfHalfUp: 229,
    divideFirst: 2_384,
  } as const

  it('the census corpus can tell the rounding directions apart, and by how much', () => {
    const census = directionCensus()
    expect(census).toEqual(MEASURED)
    // The claim in the form that matters: the corpus CAN expose each wrong direction, so the exact counts
    // above are evidence rather than the absence of it.
    expect(census.nearestInsteadOfFloor).toBeGreaterThan(0)
    expect(census.strictlyAboveHalfInsteadOfHalfUp).toBeGreaterThan(0)
    expect(census.divideFirst).toBeGreaterThan(0)
    // And the implementation under test agrees with the oracle on every case of that same corpus, which is
    // what makes the three counts above measurements of the WRONG implementations rather than of noise.
    // Walked through `censusCorpus()` so the two halves cannot drift onto different inputs.
    let disagreements = 0
    for (const { basisFils, rateBp } of censusCorpus()) {
      for (const mode of COMMISSION_ROUNDING_MODES) {
        if (commissionFilsFor(basisFils, rateBp, mode) !== oracleFils(basisFils, rateBp, mode)) {
          disagreements += 1
        }
      }
    }
    expect(disagreements).toBe(0)
  }, 30_000)

  it('agrees with the oracle exactly, in both modes, over a wide fils range', () => {
    let disagreeing = 0
    let cases = 0
    fc.assert(
      fc.property(
        // Whole dirhams plus a fils jitter, which is what a price list and a discount produce together.
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.constantFrom(...COMMISSION_ROUNDING_MODES),
        (dirhams, jitter, rateBp, mode) => {
          const basisFils = dirhams * 100 + jitter
          cases += 1
          if ((basisFils * rateBp) % 10_000 >= 5_000) disagreeing += 1
          expect(commissionFilsFor(basisFils, rateBp, mode)).toBe(
            oracleFils(basisFils, rateBp, mode),
          )
        },
      ),
      { numRuns: 4_000 },
    )
    /*
      How many of the generated cases COULD have disagreed — the ones where `floor` and `half_up` give
      different answers. MEASURED: 4,000 draws produced 1,991, and the floor is set well under that
      because the generator is random and a floor at an observed value is its own flake (brief rule 22).

      The EXACT TIE is deliberately not counted here, and that is a measurement rather than an omission:
      the same run produced 3 ties out of 4,000, so a floor on ties would fail on a run that happened to
      draw none. The tie is the boundary the half-up direction is defined at, so it is measured where it
      can be — the deterministic census above, which holds 229 of them and catches the
      strictly-above-a-half implementation on every one.
    */
    expect(cases).toBe(4_000)
    expect(disagreeing).toBeGreaterThan(1_200)
  }, 30_000)

  it('is exact at the top of the range, where a float would not be', () => {
    // The bound exists because `basisFils * rateBp` must stay a safe integer. At the bound and at the
    // full rate the product is exactly 2^53's neighbourhood, and the answer is the basis itself.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (rateBp) => {
        const basisFils = MAX_COMMISSION_BASIS_FILS
        expect(Number.isSafeInteger(basisFils * rateBp)).toBe(true)
        for (const mode of COMMISSION_ROUNDING_MODES) {
          expect(commissionFilsFor(basisFils, rateBp, mode)).toBe(
            oracleFils(basisFils, rateBp, mode),
          )
        }
      }),
      { numRuns: 300 },
    )
    // An explicit timeout on every case in this file, because vitest.config.ts declares none and each test
    // inherits 5,000ms: 4,000 property cases, a 5,200-comparison census and 300 more are comfortably under
    // that alone and are not under it on a loaded machine under coverage, which is where four files have
    // already failed (brief rule 21).
  }, 30_000)
})
