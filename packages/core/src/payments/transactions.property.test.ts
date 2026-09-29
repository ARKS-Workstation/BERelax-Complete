import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Money } from '../money.ts'
import { add, filsFrom, money, ZERO_AED } from '../money.ts'
import type { Instant } from '../time.ts'
import { instantFromIso } from '../time.ts'
import type { PaymentIntentAmounts, PaymentIntentEvent } from './state.ts'
import { CaptureExceedsAuthorised, RefundExceedsCaptured, reduceIntent } from './state.ts'
import type { PaymentIntentTransaction } from './transactions.ts'
import { intentTransactions, storedFiguresOf, sumIntentTransactions } from './transactions.ts'

/**
 * The acceptance line: *"property test over 2,000 random capture/refund/void sequences: captured never
 * exceeds authorised, refunded never exceeds captured, and the intent's derived balance equals the sum of its
 * append-only transaction rows"*.
 *
 * Three claims, and the third is the one that needed a module built for it. "The derived balance equals the
 * sum of the rows" is only a claim at all if the two sides are derived INDEPENDENTLY: `reduceIntent` folds
 * events into figures, `intentTransactions` projects the same events into rows, and `sumIntentTransactions`
 * adds the rows back up. Nothing is shared between the fold and the sum but the event list, so an arithmetic
 * change on either side breaks the equality. A test that read the figures back off the fold would agree with
 * itself for any fold at all.
 *
 * The same equality is asserted a third time, over the STORED rows in PostgreSQL, by
 * `packages/fixtures/src/payment-intent.itest.ts`, and enforced at COMMIT by 0106's ZY163.
 *
 * ## Why the generator produces ILLEGAL sequences too, and why they are counted
 *
 * Brief rule 22. "Captured never exceeds authorised" over a generator that can only build legal sequences is
 * satisfied by a fold with no ceiling check in it — every case passes and the assertion has never been near
 * the code it names. So the generator draws an over-capture and an over-refund on purpose, the property
 * asserts the refusal BY NAME for those, and the runs of each kind are counted against a measured floor. A
 * run in which no illegal sequence was drawn would have proved nothing about the ceilings and says so.
 *
 * ## And why the maximum-not-sum rule has its own control
 *
 * The one arithmetic mistake here that makes an over-capture look legal is summing authorisation rows
 * instead of taking the largest: a gateway increasing a reservation reports the NEW TOTAL, so a sum doubles
 * the ceiling. It is invisible in review — a sum of amounts looks like every other sum in the file — so this
 * file carries {@link summingAuthorisations}, the deliberately wrong summer, runs it on the same rows, and
 * counts the cases where it disagrees. That count is the number of cases that could have caught the edit.
 *
 * ## The floors are MEASURED
 *
 * Over six runs of 2,000 cases:
 *
 *     legalWithCaptureAndRefund    652  673  698  655  703  652   (minimum 652)
 *     overCaptureRefused           346  312  300  339  305  329   (minimum 300)
 *     overRefundRefused            292  255  235  246  243  267   (minimum 235)
 *     summingWouldDisagree         666  745  724  692  718  680   (minimum 666)
 *
 * Each floor is set at a little over half the observed minimum. That distance is deliberate: a floor placed
 * just under an observed minimum becomes its own intermittent failure, which is the shape a property test in
 * this build has already taken once.
 */

/** The acceptance line's figure, exactly. */
const RUNS = 2_000

/**
 * An explicit timeout, because `vitest.config.ts` declares no `testTimeout` and every test inherits 5,000 ms.
 *
 * 2,000 cases of two pure folds over at most nine events, measured at between 0.8s and 1.5s alone.
 * Brief rule 21: a correctness test with no explicit budget fails under coverage on a loaded machine and
 * names the wrong thing when it does.
 */
const TIMEOUT_MS = 30_000

const T0 = instantFromIso('2026-09-28T19:00:00.000Z')
const at = (index: number): Instant => (T0 + index * 60_000) as Instant

interface Shape {
  readonly authorisedFils: number
  /** A second, larger authorisation: the reservation increase that makes max-not-sum load-bearing. */
  readonly increaseBy: number
  readonly challengeFirst: boolean
  readonly captureShares: readonly number[]
  readonly refundCount: number
  readonly voidInstead: boolean
  readonly declineInstead: boolean
  readonly overCapture: boolean
  readonly overRefund: boolean
}

interface Sequence {
  readonly events: readonly PaymentIntentEvent[]
  /** Does this sequence break a ceiling on purpose? Decides which half of the property applies. */
  readonly illegal: 'over-capture' | 'over-refund' | null
  /** Does it carry two authorisation rows? The cases a summing implementation would get wrong. */
  readonly hasIncrease: boolean
  readonly hasCapture: boolean
  readonly hasRefund: boolean
}

/**
 * One sequence from a shape, legal or deliberately not.
 *
 * Every amount is an integer number of fils by construction: the shares are integer divisions floored at 1,
 * which is what stops a one-fils authorisation producing a zero-fils capture — an amount
 * `payment_intent_transaction_amount_matches_event` refuses in the database and
 * `TransactionAmountWrongForEvent` refuses here.
 */
function sequenceFrom(shape: Shape): Sequence {
  const events: PaymentIntentEvent[] = []
  let index = 0
  const push = (event: Omit<PaymentIntentEvent, 'occurredAt'>): void => {
    events.push({ ...event, occurredAt: at(index) })
    index += 1
  }

  if (shape.challengeFirst) push({ eventId: `e${index}-action`, type: 'action_required' })

  if (shape.declineInstead) {
    push({ eventId: `e${index}-failed`, type: 'authorisation_failed' })
    return { events, illegal: null, hasIncrease: false, hasCapture: false, hasRefund: false }
  }

  push({
    eventId: `e${index}-authorised`,
    type: 'authorised',
    amount: money(filsFrom(shape.authorisedFils)),
  })

  // The increase is a NEW event with a NEW id, not a resend: `reduceIntent` deduplicates on the id, so a
  // second delivery carrying the same id is dropped and could never exercise the maximum at all.
  const ceiling = shape.authorisedFils + shape.increaseBy
  const hasIncrease = shape.increaseBy > 0
  if (hasIncrease) {
    push({ eventId: `e${index}-authorised`, type: 'authorised', amount: money(filsFrom(ceiling)) })
  }

  if (shape.voidInstead) {
    push({ eventId: `e${index}-voided`, type: 'voided' })
    return { events, illegal: null, hasIncrease, hasCapture: false, hasRefund: false }
  }

  let remaining = ceiling
  const captures: number[] = []
  for (const share of shape.captureShares) {
    if (remaining <= 0) break
    const take = Math.min(remaining, Math.max(1, Math.floor((remaining * share) / 101)))
    captures.push(take)
    remaining -= take
  }
  if (captures.length === 0) captures.push(ceiling)
  for (const amount of captures) {
    push({
      eventId: `e${index}-captured`,
      type: 'captured',
      amount: money(filsFrom(amount)),
    })
  }

  const capturedTotal = captures.reduce((total, amount) => total + amount, 0)

  if (shape.overCapture) {
    // One fils more than is left, so the refusal is about the ceiling and not about a large number.
    push({
      eventId: `e${index}-captured-over`,
      type: 'captured',
      amount: money(filsFrom(ceiling - capturedTotal + 1)),
    })
    return { events, illegal: 'over-capture', hasIncrease, hasCapture: true, hasRefund: false }
  }

  let refundable = capturedTotal
  let refunds = 0
  for (let n = 0; n < shape.refundCount && refundable > 0; n += 1) {
    const take = Math.min(refundable, Math.max(1, Math.floor(refundable / 2)))
    push({ eventId: `e${index}-refunded`, type: 'refunded', amount: money(filsFrom(take)) })
    refundable -= take
    refunds += 1
  }

  if (shape.overRefund) {
    push({
      eventId: `e${index}-refunded-over`,
      type: 'refunded',
      amount: money(filsFrom(refundable + 1)),
    })
    return { events, illegal: 'over-refund', hasIncrease, hasCapture: true, hasRefund: true }
  }

  return {
    events,
    illegal: null,
    hasIncrease,
    hasCapture: captures.length > 0,
    hasRefund: refunds > 0,
  }
}

/**
 * The wrong summer: authorisations ADDED rather than maximised. The control, and nothing else uses it.
 *
 * Identical to `sumIntentTransactions` in every other respect, so a case where it disagrees is a case that
 * would have caught somebody replacing the maximum with a sum while tidying.
 */
function summingAuthorisations(rows: readonly PaymentIntentTransaction[]): PaymentIntentAmounts {
  let authorised = ZERO_AED
  let captured = ZERO_AED
  let refunded = ZERO_AED
  let released = false
  for (const row of rows) {
    if (row.eventType === 'authorised') authorised = add(authorised, row.amount)
    else if (row.eventType === 'captured') captured = add(captured, row.amount)
    else if (row.eventType === 'refunded') refunded = add(refunded, row.amount)
    else if (row.eventType === 'voided') released = true
  }
  const minus = (a: Money, b: Money): Money => money(filsFrom(a.fils - b.fils))
  return {
    authorised,
    captured,
    refunded,
    capturable: released ? ZERO_AED : minus(authorised, captured),
    refundable: minus(captured, refunded),
  }
}

const shapeArbitrary: fc.Arbitrary<Shape> = fc.record({
  // Weighted low as well as high: a one-fils authorisation is where a capture share rounds to zero, and the
  // `Math.max(1, …)` in the builder is what keeps the generated capture legal there.
  authorisedFils: fc.oneof(
    fc.integer({ min: 1, max: 20 }),
    fc.integer({ min: 100, max: 1_000_000 }),
  ),
  // Zero most of the time, because an increase is rare in life; often enough that the maximum rule is
  // exercised in well over half the runs, which the measured floor for `summingWouldDisagree` records.
  increaseBy: fc.oneof(
    { arbitrary: fc.constant(0), weight: 2 },
    { arbitrary: fc.integer({ min: 1, max: 500_000 }), weight: 3 },
  ),
  challengeFirst: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
  captureShares: fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 3 }),
  refundCount: fc.integer({ min: 0, max: 2 }),
  // A tenth each. A voided or declined sequence exercises neither ceiling, so drawing them uniformly would
  // spend most of the runs on the two shapes that can catch the least.
  voidInstead: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
  declineInstead: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
  overCapture: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
  overRefund: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
})

describe('acceptance — 2,000 random capture/refund/void sequences', () => {
  it(
    'keeps captured within authorised and refunded within captured, and the rows sum to the fold',
    () => {
      let legalWithCaptureAndRefund = 0
      let overCaptureRefused = 0
      let overRefundRefused = 0
      let summingWouldDisagree = 0
      let cases = 0

      fc.assert(
        fc.property(shapeArbitrary, (shape) => {
          cases += 1
          const sequence = sequenceFrom(shape)

          if (sequence.illegal !== null) {
            // The refusal, BY NAME. `toThrow()` would pass for any throw at all, including a
            // `TransactionAmountWrongForEvent` from a generator that had started producing zero amounts.
            let caught: unknown
            try {
              reduceIntent(sequence.events)
            } catch (error) {
              caught = error
            }
            if (sequence.illegal === 'over-capture') {
              expect(caught).toBeInstanceOf(CaptureExceedsAuthorised)
              expect((caught as Error).name).toBe('CaptureExceedsAuthorised')
              overCaptureRefused += 1
            } else {
              expect(caught).toBeInstanceOf(RefundExceedsCaptured)
              expect((caught as Error).name).toBe('RefundExceedsCaptured')
              overRefundRefused += 1
            }
            // The rows are projected from the fold, so the same refusal has to reach a caller that asked
            // for rows rather than for figures — otherwise there would be a path that stored movements for
            // an intent the fold refused.
            expect(() => intentTransactions(sequence.events)).toThrow()
            return
          }

          const projection = reduceIntent(sequence.events)
          const amounts = projection.amounts

          // Claim 1 and 2: the two ceilings, on every legal sequence.
          expect(amounts.captured.fils).toBeLessThanOrEqual(amounts.authorised.fils)
          expect(amounts.refunded.fils).toBeLessThanOrEqual(amounts.captured.fils)

          // Claim 3: the derived balance equals the sum of the append-only rows. Deep equality over all
          // five figures, not just the balance — `capturable` is the one that a void has to zero, and a
          // comparison of `refundable` alone would pass for a sum that had lost the release entirely.
          const rows = intentTransactions(sequence.events)
          expect(sumIntentTransactions(rows)).toEqual(amounts)

          // And the three figures a caller stores, which is what 0106's ZY163 recomputes at COMMIT.
          expect(storedFiguresOf(rows)).toEqual({
            authorisedFils: amounts.authorised.fils,
            capturedFils: amounts.captured.fils,
            refundedFils: amounts.refunded.fils,
          })

          // One row per applied event, so a sequence cannot lose a movement on the way to the table.
          expect(rows.length).toBe(projection.applied.length)

          if (sequence.hasCapture && sequence.hasRefund) legalWithCaptureAndRefund += 1
          if (sequence.hasIncrease) {
            // The control: the wrong summer must actually get this case wrong, or the maximum rule is
            // being asserted over inputs that cannot tell the two apart.
            expect(summingAuthorisations(rows)).not.toEqual(amounts)
            summingWouldDisagree += 1
          }
        }),
        { numRuns: RUNS },
      )

      expect(cases, 'the property did not run').toBe(RUNS)
      // See the module note for the six measured runs and each observed minimum. Every floor is a little
      // over half of it, because a floor set just under an observed minimum becomes its own flake.
      expect(
        legalWithCaptureAndRefund,
        'too few generated sequences both captured and refunded, so the two ceilings were asserted over ' +
          'inputs that could not have broken them',
      ).toBeGreaterThan(330)
      expect(
        overCaptureRefused,
        'no over-capture was drawn, so "captured never exceeds authorised" measured nothing',
      ).toBeGreaterThan(150)
      expect(
        overRefundRefused,
        'no over-refund was drawn, so "refunded never exceeds captured" measured nothing',
      ).toBeGreaterThan(115)
      expect(
        summingWouldDisagree,
        'no sequence carried an authorisation increase, so the maximum-not-sum rule was never exercised',
      ).toBeGreaterThan(330)
    },
    TIMEOUT_MS,
  )
})
