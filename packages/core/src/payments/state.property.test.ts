import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { add, filsFrom, money, ZERO_AED } from '../money.ts'
import type { Instant } from '../time.ts'
import { instantFromIso } from '../time.ts'
import type { PaymentIntentEvent, PaymentIntentProjection, PaymentIntentState } from './state.ts'
import {
  countRedeliveries,
  nextIntentState,
  PAYMENT_INTENT_INITIAL_STATE,
  reduceIntent,
} from './state.ts'

/**
 * The fold's answer is a function of the SET of events, not of the order they were delivered in.
 *
 * This is the property Y-PAY-04's acceptance line depends on — *"shuffled-permutation test over a 6-event
 * sequence converges to the same terminal state as in-order delivery"* — and it holds here rather than in
 * the webhook handler because that is where the ordering is actually resolved: {@link reduceIntent} sorts by
 * the gateway's `occurredAt` before folding. A handler built on an order-DEPENDENT fold could only converge
 * by buffering, and a buffer has a flush policy, a size and a bug.
 *
 * ## Why the generator is weighted, and why the count is asserted
 *
 * Brief rule 22. A permutation can only disagree if the events actually interact: a one-event set, or a set
 * whose permutation happens to be the sorted order, is satisfied by a completely order-dependent
 * implementation. So this test carries {@link unsortedFold} — a deliberately order-dependent reducer, the
 * "deliberately wrong X" — runs it on the same permuted input, and COUNTS the cases where it disagrees with
 * `reduceIntent` or throws. That count is the number of cases that could have caught an unsorted
 * implementation, and it is asserted against a floor.
 *
 * The floor is MEASURED, not guessed. Over eight runs of 400 cases the counts were:
 *
 *     couldDisagree        306 294 304 309 325 309 302 312   (minimum 294)
 *     permutationsDiffered 338 326 334 337 342 328 325 334   (minimum 325)
 *
 * The floor is set at 160, a little over half the observed minimum. That distance is deliberate: a floor
 * placed just under an observed minimum becomes its own intermittent failure, which is the shape a property
 * test in this build has already taken once.
 */

const RUNS = 400

/**
 * An explicit timeout, because `vitest.config.ts` declares no `testTimeout` and every test inherits 5,000 ms.
 *
 * 400 cases of a pure fold over at most six events, measured at about 0.2s alone. Brief rule 21: a
 * correctness test with no explicit budget fails under coverage on a loaded machine and names the wrong thing.
 */
const TIMEOUT_MS = 30_000

const T0 = instantFromIso('2026-09-28T19:00:00.000Z')
const at = (index: number): Instant => (T0 + index * 60_000) as Instant

/**
 * An order-dependent fold. The control, and the only reason this property is not vacuous.
 *
 * Identical to `reduceIntent` except that it does NOT sort, so it is what the real fold would be if somebody
 * removed the sort while tidying. A case where this disagrees is a case that could have caught that edit.
 */
function unsortedFold(events: readonly PaymentIntentEvent[]): PaymentIntentProjection {
  let state: PaymentIntentState = PAYMENT_INTENT_INITIAL_STATE
  let authorised = ZERO_AED
  let captured = ZERO_AED
  let refunded = ZERO_AED
  for (const event of events) {
    state = nextIntentState(state, event.type, event.eventId)
    const amount = event.amount ?? ZERO_AED
    if (event.type === 'authorised') {
      authorised = amount.fils > authorised.fils ? amount : authorised
    }
    if (event.type === 'captured') {
      captured = add(captured, amount)
      if (captured.fils > authorised.fils) throw new Error('over-capture')
    }
    if (event.type === 'refunded') {
      refunded = add(refunded, amount)
      if (refunded.fils > captured.fils) throw new Error('over-refund')
    }
  }
  return {
    state,
    amounts: {
      authorised,
      captured,
      refunded,
      capturable: money(filsFrom(state === 'voided' ? 0 : authorised.fils - captured.fils)),
      refundable: money(filsFrom(captured.fils - refunded.fils)),
    },
    applied: events,
  }
}

interface Shape {
  readonly authorisedFils: number
  readonly captureShares: readonly number[]
  readonly refundCount: number
  readonly voidInstead: boolean
}

/**
 * A valid in-order event sequence from a generated shape.
 *
 * Built so every sequence is legal BEFORE it is shuffled. The property is about delivery order, and a
 * generator that produced illegal sequences would test the refusals instead and pass for the wrong reason.
 */
function inOrderEvents(shape: Shape): readonly PaymentIntentEvent[] {
  const events: PaymentIntentEvent[] = [
    {
      eventId: 'e0-authorised',
      type: 'authorised',
      occurredAt: at(0),
      amount: money(filsFrom(shape.authorisedFils)),
    },
  ]
  if (shape.voidInstead) {
    events.push({ eventId: 'e1-voided', type: 'voided', occurredAt: at(1) })
    return events
  }

  let remaining = shape.authorisedFils
  const captures: number[] = []
  for (const share of shape.captureShares) {
    if (remaining <= 0) break
    const take = Math.min(remaining, Math.max(1, Math.floor((remaining * share) / 101)))
    captures.push(take)
    remaining -= take
  }
  if (captures.length === 0) captures.push(shape.authorisedFils)

  let index = 1
  for (const amount of captures) {
    events.push({
      eventId: `e${index}-captured`,
      type: 'captured',
      occurredAt: at(index),
      amount: money(filsFrom(amount)),
    })
    index += 1
  }

  let refundable = captures.reduce((total, amount) => total + amount, 0)
  for (let n = 0; n < shape.refundCount && refundable > 0; n += 1) {
    const take = Math.min(refundable, Math.max(1, Math.floor(refundable / 2)))
    events.push({
      eventId: `e${index}-refunded`,
      type: 'refunded',
      occurredAt: at(index),
      amount: money(filsFrom(take)),
    })
    refundable -= take
    index += 1
  }
  return events
}

const shapeArbitrary = fc.record({
  // Weighted low as well as high: a one-fils authorisation is the case where a capture share rounds to
  // zero, and the `Math.max(1, …)` above is what stops the generator producing an illegal sequence there.
  authorisedFils: fc.oneof(
    fc.integer({ min: 1, max: 20 }),
    fc.integer({ min: 100, max: 1_000_000 }),
  ),
  captureShares: fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 3 }),
  refundCount: fc.integer({ min: 0, max: 2 }),
  // A tenth, not a half. A voided sequence is two events and disagrees under permutation far less often
  // than a capture-and-refund one, so drawing it uniformly would halve the cases that can catch anything.
  voidInstead: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
})

/** Six sort keys, which is the longest sequence the shape can produce. */
const keysArbitrary = fc.array(fc.integer({ min: 0, max: 1_000 }), {
  minLength: 6,
  maxLength: 6,
})

describe('the fold is order-independent', () => {
  it(
    'gives the same answer for every delivery order, and the count of cases that could disagree is above a measured floor',
    () => {
      let couldDisagree = 0
      let permutationsDiffered = 0
      let duplicatedCases = 0

      fc.assert(
        fc.property(shapeArbitrary, keysArbitrary, (shape, keys) => {
          const ordered = inOrderEvents(shape)
          const permuted = ordered
            .map((event, index) => ({ event, key: keys[index] ?? 0, index }))
            .sort((a, b) => a.key - b.key || a.index - b.index)
            .map((entry) => entry.event)

          if (permuted.map((e) => e.eventId).join() !== ordered.map((e) => e.eventId).join()) {
            permutationsDiffered += 1
          }

          const fromOrdered = reduceIntent(ordered)
          const fromPermuted = reduceIntent(permuted)

          // The claim.
          expect(fromPermuted.state).toBe(fromOrdered.state)
          expect(fromPermuted.amounts).toEqual(fromOrdered.amounts)
          expect(fromPermuted.applied.map((e) => e.eventId)).toEqual(
            fromOrdered.applied.map((e) => e.eventId),
          )

          // And the same claim over an at-least-once stream: every event delivered twice, shuffled, must
          // fold to the same answer. This is the direction that found a defect — the fold counted both
          // copies of a capture — and it is asserted here as well as in the unit suite because a property
          // over 400 generated shapes reaches amount combinations a hand-written case does not.
          const doubled = permuted.flatMap((event) => [event, { ...event }])
          duplicatedCases += countRedeliveries(doubled) > 0 ? 1 : 0
          const fromDoubled = reduceIntent(doubled)
          expect(fromDoubled.state).toBe(fromOrdered.state)
          expect(fromDoubled.amounts).toEqual(fromOrdered.amounts)

          // The control: would an unsorted fold have noticed this case?
          try {
            const naive = unsortedFold(permuted)
            if (
              naive.state !== fromOrdered.state ||
              naive.amounts.captured.fils !== fromOrdered.amounts.captured.fils ||
              naive.amounts.refunded.fils !== fromOrdered.amounts.refunded.fils
            ) {
              couldDisagree += 1
            }
          } catch {
            // An unsorted fold refusing the permutation is the strongest form of disagreement.
            couldDisagree += 1
          }
          return true
        }),
        { numRuns: RUNS },
      )

      // See the module note for the eight measured runs; the minimum was 294.
      expect(
        couldDisagree,
        `only ${couldDisagree} of ${RUNS} generated cases could have caught an order-dependent fold, so ` +
          'this property is close to vacuous. Weight the generator towards sequences whose events interact.',
      ).toBeGreaterThan(160)
      expect(
        permutationsDiffered,
        'no generated delivery order differed from the gateway order, so nothing was permuted at all',
      ).toBeGreaterThan(RUNS / 2)
      expect(
        duplicatedCases,
        'no generated stream was actually duplicated, so the at-least-once half measured nothing',
      ).toBe(RUNS)
    },
    TIMEOUT_MS,
  )
})
