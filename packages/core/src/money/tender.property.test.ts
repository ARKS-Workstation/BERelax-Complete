import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { TENDER_KINDS } from '../checkout/posting.ts'
import { filsFrom, money } from '../money.ts'
import type { TenderSettlement, TenderToApply } from './tender.ts'
import { ChangeNotAvailable, reconcileSettlement, settleTenders, TENDER_TYPES } from './tender.ts'

/**
 * The two claims the acceptance states as a property, over generated tender and change pairs:
 *
 *   1. the recorded payment never exceeds what the document has outstanding, and
 *   2. change given is recorded SEPARATELY rather than netted into the payment.
 *
 * ## Why the generator is weighted, and why the counts are asserted
 *
 * Brief rule 22, which cost a real run: `resolveConsent`'s order-independence property generated record
 * sets that could not disagree about 63% of the time, so the property held for a completely
 * order-dependent resolver about one run in eight, and the visible symptom was a gate reporting a rule
 * as missing.
 *
 * Both claims here are vacuous on a tender that exactly covers the balance: nothing is over, nothing is
 * short, and an implementation that netted the change into the payment would pass every such case. So
 * the amounts are drawn as a FRACTION of the amount due, spread across under, exact and over, and the
 * kinds are weighted towards `cash` — the only type that may give change, so a uniform draw from three
 * kinds would turn most over-tenders into a refusal and leave the arithmetic untested.
 *
 * The property then COUNTS how many generated cases exercised each direction, and asserts a floor on
 * each. The floors are MEASURED, over eight runs of 400 cases, whose minima were:
 *
 *     settled 239, change given 111, receivable left 110, surplus refused 126, two-or-more tenders 244
 *
 * Each floor is set at about half its observed minimum. That distance is deliberate: a floor placed just
 * under the minimum becomes its own intermittent failure, which is the shape gate case 72a's one run in
 * eight took.
 */

const RUNS = 400

/**
 * An explicit per-test timeout, because `vitest.config.ts` declares no `testTimeout` and the default is
 * 5,000 ms.
 *
 * 400 cases, each building up to three tenders and reconciling them, measured at about 0.3s alone. Brief
 * rule 21 has now cost five files: a correctness test with no explicit timeout fails under coverage on a
 * loaded machine, names the wrong thing, and costs a whole verify run.
 */
const TIMEOUT_MS = 30_000

/**
 * A tender plan: the amount due, a share of it per tender, and a kind per tender.
 *
 * `share` is in hundredths, from 10 (a tenth of the balance) to 150 (half again over it), so a surplus
 * and a shortfall are each about as likely as an exact cover.
 */
interface Plan {
  readonly dueFils: number
  readonly shares: readonly number[]
  readonly kinds: readonly (typeof TENDER_KINDS)[number][]
}

const plans = fc
  .record({
    dueFils: fc.integer({ min: 1, max: 500_000 }),
    shares: fc.array(fc.integer({ min: 10, max: 150 }), { minLength: 1, maxLength: 3 }),
    kinds: fc.array(
      fc.oneof(
        { arbitrary: fc.constant('cash' as const), weight: 3 },
        { arbitrary: fc.constant('card_in_salon' as const), weight: 1 },
        { arbitrary: fc.constant('bank_transfer' as const), weight: 1 },
      ),
      { minLength: 3, maxLength: 3 },
    ),
  })
  .map(
    (raw): Plan => ({
      dueFils: raw.dueFils,
      shares: raw.shares,
      // One kind per share, taken from a fixed-length list so the two arrays cannot disagree in length.
      kinds: raw.shares.map((_, index) => raw.kinds[index] ?? 'cash'),
    }),
  )

function tendersOf(plan: Plan): readonly TenderToApply[] {
  return plan.shares.map((share, index) => ({
    kind: plan.kinds[index] ?? 'cash',
    // At least one fils: a zero tender is refused for a different reason, and this property is not
    // about that refusal.
    amount: money(filsFrom(Math.max(1, Math.round((plan.dueFils * share) / 100)))),
    // Always supplied, so `TenderReferenceMissing` cannot be why a case was refused. The one refusal
    // this property is about is `ChangeNotAvailable`.
    reference: `REF-${index + 1}`,
  }))
}

/** What each generated case turned out to exercise, so a floor can be asserted on it. */
interface Coverage {
  settled: number
  overTender: number
  shortfall: number
  refusedForChange: number
  multiTender: number
}

/** Claim 1, per tender and in total: nothing was applied above what was outstanding. */
function expectNothingAppliedAboveTheBalance(settlement: TenderSettlement, dueFils: number): void {
  expect(settlement.applied.fils).toBeLessThanOrEqual(dueFils)
  let remaining = dueFils
  for (const tender of settlement.tenders) {
    expect(tender.applied.fils).toBeLessThanOrEqual(remaining)
    remaining -= tender.applied.fils
  }
  expect(remaining).toBe(settlement.outstanding.fils)
}

/** Claim 2: the change is beside the payment, never inside it. */
function expectChangeRecordedSeparately(settlement: TenderSettlement): void {
  for (const tender of settlement.tenders) {
    expect(tender.tendered.fils).toBe(tender.applied.fils + tender.changeGiven.fils)
    if (tender.changeGiven.fils === 0) continue
    expect(TENDER_TYPES[tender.kind].givesChange).toBe(true)
    // The half that fails on a netted implementation: what was handed over is strictly larger than what
    // it settled, so storing `applied` as the tender would lose a fact the drawer is counted against.
    expect(tender.tendered.fils).toBeGreaterThan(tender.applied.fils)
  }
}

describe('settleTenders, as a property over generated tender and change pairs', () => {
  it(
    'never applies more than is outstanding, and never nets the change into the payment',
    () => {
      const coverage: Coverage = {
        settled: 0,
        overTender: 0,
        shortfall: 0,
        refusedForChange: 0,
        multiTender: 0,
      }

      fc.assert(
        fc.property(plans, (plan) => {
          const tenders = tendersOf(plan)
          if (tenders.length > 1) coverage.multiTender += 1

          let settlement: TenderSettlement
          try {
            settlement = settleTenders({ due: money(filsFrom(plan.dueFils)), tenders })
          } catch (err) {
            // The only refusal reachable here, and a claim in its own right: a surplus on a tender type
            // that gives no change is refused rather than absorbed. Absorbing it would pay change out
            // of a drawer nobody over-paid.
            expect(err).toBeInstanceOf(ChangeNotAvailable)
            coverage.refusedForChange += 1
            return
          }
          coverage.settled += 1

          expectNothingAppliedAboveTheBalance(settlement, plan.dueFils)
          expectChangeRecordedSeparately(settlement)

          // Every reconciliation difference is zero, which is the same arithmetic a runtime guard reads.
          expect(reconcileSettlement(settlement)).toEqual({
            tenderedVersusAppliedAndChangeFils: 0,
            dueVersusAppliedAndOutstandingFils: 0,
            appliedAboveDueFils: 0,
            changeOnATypeThatGivesNoneFils: 0,
          })

          if (settlement.changeGiven.fils > 0) coverage.overTender += 1
          if (settlement.outstanding.fils > 0) coverage.shortfall += 1
        }),
        { numRuns: RUNS },
      )

      // The counts, against the measured floors. Without them the property above is satisfied by a
      // generator that only ever produced exact covers — on which a netted implementation passes.
      expect(coverage.overTender, 'generated cases that actually gave change').toBeGreaterThan(60)
      expect(coverage.shortfall, 'generated cases that left a receivable').toBeGreaterThan(60)
      expect(
        coverage.refusedForChange,
        'generated cases where a surplus had to be refused',
      ).toBeGreaterThan(60)
      expect(coverage.multiTender, 'generated cases with more than one tender').toBeGreaterThan(150)
      // And the floor that says the refusals did not swallow the run: most cases settled.
      expect(coverage.settled, 'generated cases that settled').toBeGreaterThan(150)
    },
    TIMEOUT_MS,
  )
})
