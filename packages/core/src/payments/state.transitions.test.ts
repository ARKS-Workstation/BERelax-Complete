import { describe, expect, it } from 'vitest'
import { aed, filsFrom, money } from '../money.ts'
import type { Instant } from '../time.ts'
import { instantFromIso } from '../time.ts'
import type { PaymentIntentEvent, PaymentIntentState } from './state.ts'
import {
  ABSORBING_INTENT_STATES,
  assertCapturable,
  assertRefundable,
  CaptureExceedsAuthorised,
  countRedeliveries,
  EMPTY_INTENT,
  INTENT_EVENT_CARRIES_AMOUNT,
  INTENT_TRANSITIONS,
  IntentEventAmountMalformed,
  IntentTransitionRefused,
  isFullyRefunded,
  isIntentTransitionAllowed,
  nextIntentState,
  PAYMENT_INTENT_EVENTS,
  PAYMENT_INTENT_INITIAL_STATE,
  PAYMENT_INTENT_STATES,
  RefundExceedsCaptured,
  reduceIntent,
  TRANSITION_REFUSED,
} from './state.ts'

/**
 * The lifecycle table, the fold, and the invariants.
 *
 * Y-PAY-02 owns `state.test.ts` — the exhaustive assertion that the table is total over the enum product
 * and that every pair outside it is refused by name — and this file deliberately leaves that filename free.
 * What is here is what has to hold for the table to be worth asserting over: it is complete in shape, the
 * fold is order-independent, and each invariant has been seen to refuse something.
 */

const T0 = instantFromIso('2026-09-28T19:00:00.000Z')
const at = (offsetSeconds: number): Instant => (T0 + offsetSeconds * 1000) as Instant

const event = (
  eventId: string,
  type: PaymentIntentEvent['type'],
  offsetSeconds: number,
  fils?: number,
): PaymentIntentEvent => ({
  eventId,
  type,
  occurredAt: at(offsetSeconds),
  ...(fils === undefined ? {} : { amount: money(filsFrom(fils)) }),
})

describe('the transition table', () => {
  it('declares a cell for every state and every event', () => {
    // The shape Y-PAY-02's exhaustiveness test asserts over. A `Partial<Record<…>>` would compile with a
    // row missing and resolve every one of its pairs to "not allowed" silently, which is the answer for
    // most of them and the wrong way to arrive at it.
    for (const state of PAYMENT_INTENT_STATES) {
      const row = INTENT_TRANSITIONS[state]
      expect(Object.keys(row).sort()).toEqual([...PAYMENT_INTENT_EVENTS].sort())
      for (const eventType of PAYMENT_INTENT_EVENTS) {
        const target = row[eventType]
        const allowed: readonly string[] = [...PAYMENT_INTENT_STATES, TRANSITION_REFUSED]
        expect(allowed, `${state} + ${eventType} = ${target}`).toContain(target)
      }
    }
  })

  it('allows at least one event from every state, so none is a dead end', () => {
    // A state every event refuses is a state an intent can enter and never be told anything about again,
    // and it would not look like a bug: the intent stops moving and the reconciliation job reports it as
    // divergent for ever. Even the absorbing states accept their own event, because that is the one a
    // gateway retries hardest.
    const deadEnds = PAYMENT_INTENT_STATES.filter((state) =>
      PAYMENT_INTENT_EVENTS.every(
        (eventType) => INTENT_TRANSITIONS[state][eventType] === TRANSITION_REFUSED,
      ),
    )
    expect(deadEnds).toEqual([])
  })

  it('derives the absorbing states from the table, and `captured` is one of them', () => {
    // Measured from the table rather than asserted from memory, and the first version of this case got it
    // wrong: it expected `['failed', 'voided']`. `captured` cannot be left either — a captured intent is
    // never voided and never fails, and it stays `captured` however much is refunded, because fullness is
    // an amount fact and not a state. Absorbing is not the same as inert.
    expect([...ABSORBING_INTENT_STATES].sort()).toEqual(['captured', 'failed', 'voided'])
    // And the control: the two states an intent passes THROUGH are not absorbing.
    expect(ABSORBING_INTENT_STATES).not.toContain('requires_authorisation')
    expect(ABSORBING_INTENT_STATES).not.toContain('authorised')
  })

  it('refuses a capture on an unauthorised intent, by name', () => {
    expect(() => nextIntentState('requires_authorisation', 'captured', 'evt-1')).toThrow(
      IntentTransitionRefused,
    )
    expect(() => nextIntentState('requires_authorisation', 'captured', 'evt-1')).toThrow(
      /IntentTransitionRefused/,
    )
  })

  it('refuses a void on a captured intent, because taken money is refunded and not released', () => {
    expect(() => nextIntentState('captured', 'voided')).toThrow(IntentTransitionRefused)
  })

  it('refuses an un-authorisation, because releasing a reservation is a void', () => {
    expect(() => nextIntentState('authorised', 'authorisation_failed')).toThrow(
      IntentTransitionRefused,
    )
  })

  it('keeps a replayed authorisation from moving a captured intent backwards', () => {
    // The single cell that makes at-least-once delivery safe. Getting it wrong un-captures money.
    expect(nextIntentState('captured', 'authorised')).toBe('captured')
  })

  it('lets a terminal state absorb its own event, because that is the one a gateway retries hardest', () => {
    expect(nextIntentState('voided', 'voided')).toBe('voided')
    expect(nextIntentState('failed', 'authorisation_failed')).toBe('failed')
  })

  it('the control: the predicate and the thrower agree for every pair', () => {
    // Two readings of one table. Without this, `isIntentTransitionAllowed` could answer `true` for a pair
    // `nextIntentState` refuses, and a caller that checked before acting would be refused anyway.
    let allowed = 0
    for (const state of PAYMENT_INTENT_STATES) {
      for (const eventType of PAYMENT_INTENT_EVENTS) {
        const permitted = isIntentTransitionAllowed(state, eventType)
        if (permitted) allowed += 1
        const threw = ((): boolean => {
          try {
            nextIntentState(state, eventType)
            return false
          } catch {
            return true
          }
        })()
        expect(threw, `${state} + ${eventType}`).toBe(!permitted)
      }
    }
    // A floor, so a table that refused everything would not satisfy the agreement vacuously.
    expect(allowed).toBeGreaterThan(10)
  })
})

describe('event amounts', () => {
  it('states for every event whether it carries one', () => {
    expect(Object.keys(INTENT_EVENT_CARRIES_AMOUNT).sort()).toEqual(
      [...PAYMENT_INTENT_EVENTS].sort(),
    )
  })

  it('refuses a capture with no amount, rather than folding an unknown quantity', () => {
    expect(() =>
      reduceIntent([event('a', 'authorised', 0, 35_000), event('b', 'captured', 1)]),
    ).toThrow(IntentEventAmountMalformed)
  })

  it('refuses a void that carries one, because an authorisation is released whole', () => {
    expect(() =>
      reduceIntent([event('a', 'authorised', 0, 35_000), event('b', 'voided', 1, 100)]),
    ).toThrow(/a partial void does not exist/)
  })
})

describe('the fold', () => {
  it('starts empty and at the initial state', () => {
    expect(EMPTY_INTENT.state).toBe(PAYMENT_INTENT_INITIAL_STATE)
    expect(reduceIntent([]).amounts.authorised.fils).toBe(0)
  })

  it('derives every figure from the events', () => {
    const projection = reduceIntent([
      event('a', 'authorised', 0, 35_000),
      event('b', 'captured', 1, 20_000),
      event('c', 'captured', 2, 15_000),
      event('d', 'refunded', 3, 5_000),
    ])
    expect(projection.state).toBe('captured')
    expect(projection.amounts.authorised.fils).toBe(35_000)
    expect(projection.amounts.captured.fils).toBe(35_000)
    expect(projection.amounts.refunded.fils).toBe(5_000)
    expect(projection.amounts.capturable.fils).toBe(0)
    expect(projection.amounts.refundable.fils).toBe(30_000)
  })

  it('takes the largest authorisation rather than summing replays', () => {
    // Summing would double the ceiling every capture is checked against, which is the one arithmetic
    // mistake here that makes an over-capture look legal.
    const projection = reduceIntent([
      event('a', 'authorised', 0, 35_000),
      event('a-again', 'authorised', 1, 35_000),
      event('b', 'captured', 2, 35_000),
    ])
    expect(projection.amounts.authorised.fils).toBe(35_000)
    expect(projection.amounts.capturable.fils).toBe(0)
  })

  it('refuses a capture over the authorised amount, by name', () => {
    expect(() =>
      reduceIntent([event('a', 'authorised', 0, 35_000), event('b', 'captured', 1, 35_001)]),
    ).toThrow(CaptureExceedsAuthorised)
  })

  it('refuses a refund over what was captured, by name', () => {
    expect(() =>
      reduceIntent([
        event('a', 'authorised', 0, 35_000),
        event('b', 'captured', 1, 20_000),
        event('c', 'refunded', 2, 20_001),
      ]),
    ).toThrow(RefundExceedsCaptured)
  })

  it('zeroes what is capturable once voided, because the reservation is gone', () => {
    const projection = reduceIntent([event('a', 'authorised', 0, 35_000), event('b', 'voided', 1)])
    expect(projection.state).toBe('voided')
    expect(projection.amounts.authorised.fils).toBe(35_000)
    expect(projection.amounts.capturable.fils).toBe(0)
  })

  it('does not mutate the array it was given', () => {
    // A caller passing its own stored event list should not find it reordered under it.
    const events = [event('b', 'captured', 5, 35_000), event('a', 'authorised', 0, 35_000)]
    const order = events.map((e) => e.eventId)
    reduceIntent(events)
    expect(events.map((e) => e.eventId)).toEqual(order)
  })

  it('orders by the gateway instant, not by the delivery order', () => {
    const inOrder = reduceIntent([
      event('a', 'authorised', 0, 35_000),
      event('b', 'captured', 1, 35_000),
    ])
    const reversed = reduceIntent([
      event('b', 'captured', 1, 35_000),
      event('a', 'authorised', 0, 35_000),
    ])
    expect(reversed.state).toBe(inOrder.state)
    expect(reversed.amounts.captured.fils).toBe(inOrder.amounts.captured.fils)
  })

  it('is idempotent on the event id, because a gateway stream is at-least-once', () => {
    // The defect this case was written for: the H02 fake redelivers every event deliberately, and a fold
    // that counted both copies of a `captured` event reported twice the money — a capture of 20,000 fils on
    // a 35,000 authorisation folded to 40,000 and threw CaptureExceedsAuthorised. The refusal firing was
    // the system working; the cause was here, and an at-least-once stream is the normal case.
    const once = [
      event('a', 'authorised', 0, 35_000),
      event('b', 'captured', 1, 20_000),
      event('c', 'refunded', 2, 5_000),
    ]
    const twice = once.flatMap((e) => [e, { ...e }])
    expect(
      countRedeliveries(twice),
      'the duplicated input contains no duplicates, so this case measures nothing',
    ).toBe(3)

    const from1 = reduceIntent(once)
    const from2 = reduceIntent(twice)
    expect(from2.amounts).toEqual(from1.amounts)
    expect(from2.state).toBe(from1.state)
    expect(from2.applied).toHaveLength(3)
  })

  it('keeps two events that share an instant but not an id, which is an authorisation increase', () => {
    // The distinction the dedupe must not blur. A resend carries the same id; an increase is a new event
    // with a new one, which is why `authorised` takes the largest amount rather than the first.
    const projection = reduceIntent([
      event('a', 'authorised', 0, 20_000),
      event('a-increase', 'authorised', 0, 35_000),
    ])
    expect(projection.applied).toHaveLength(2)
    expect(projection.amounts.authorised.fils).toBe(35_000)
  })

  it('counts redeliveries, and reports none for a clean stream', () => {
    expect(countRedeliveries([event('a', 'authorised', 0, 1)])).toBe(0)
    expect(countRedeliveries([])).toBe(0)
  })

  it('breaks a tie on the event id, so two events sharing an instant still fold the same way', () => {
    // The case that would otherwise be order-dependent in exactly the situation hardest to reproduce.
    const forwards = reduceIntent([
      event('a-authorised', 'authorised', 0, 35_000),
      event('b-captured', 'captured', 0, 35_000),
    ])
    const backwards = reduceIntent([
      event('b-captured', 'captured', 0, 35_000),
      event('a-authorised', 'authorised', 0, 35_000),
    ])
    expect(backwards.applied.map((e) => e.eventId)).toEqual(forwards.applied.map((e) => e.eventId))
    expect(backwards.state).toBe('captured')
  })
})

describe('fullness and the pre-flight assertions', () => {
  it('calls a fully refunded intent fully refunded, and a voided one not', () => {
    const refunded = reduceIntent([
      event('a', 'authorised', 0, 35_000),
      event('b', 'captured', 1, 35_000),
      event('c', 'refunded', 2, 35_000),
    ])
    expect(isFullyRefunded(refunded.amounts)).toBe(true)

    // An intent that never captured anything has given back everything it took, and calling that "fully
    // refunded" would put a voided authorisation on a refunds report.
    const voided = reduceIntent([event('a', 'authorised', 0, 35_000), event('b', 'voided', 1)])
    expect(isFullyRefunded(voided.amounts)).toBe(false)
  })

  it('refuses a request that would exceed the ceiling before it is sent', () => {
    const authorised = reduceIntent([event('a', 'authorised', 0, 35_000)])
    expect(() => assertCapturable(authorised.amounts, aed(351))).toThrow(CaptureExceedsAuthorised)
    const captured = reduceIntent([
      event('a', 'authorised', 0, 35_000),
      event('b', 'captured', 1, 35_000),
    ])
    expect(() => assertRefundable(captured.amounts, aed(351))).toThrow(RefundExceedsCaptured)
  })

  it('the control: a request inside the ceiling is permitted', () => {
    // Without this the two refusals above are satisfied by functions that refuse everything.
    const captured = reduceIntent([
      event('a', 'authorised', 0, 35_000),
      event('b', 'captured', 1, 35_000),
    ])
    expect(() => assertCapturable(captured.amounts, money(filsFrom(0)))).not.toThrow()
    expect(() => assertRefundable(captured.amounts, aed(350))).not.toThrow()
  })
})

describe('the state vocabulary', () => {
  it('has no state the table cannot name', () => {
    const named = new Set<PaymentIntentState>()
    for (const state of PAYMENT_INTENT_STATES) {
      named.add(state)
      for (const eventType of PAYMENT_INTENT_EVENTS) {
        const target = INTENT_TRANSITIONS[state][eventType]
        if (target !== TRANSITION_REFUSED) named.add(target)
      }
    }
    expect([...named].sort()).toEqual([...PAYMENT_INTENT_STATES].sort())
  })
})
