import type { Instant, PaymentIntentEvent } from '@berelax/core'
import { filsFrom, money } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import type { GatewayObservation, LocalIntentPosition } from './reconcile.ts'
import {
  consequentialPlans,
  DIVERGENT_FIELDS,
  divergenceOf,
  missedEventCount,
  missedEvents,
  planReconciliation,
  RECONCILIATION_ACTIONS,
} from './reconcile.ts'

/**
 * Y-PAY-05's arithmetic: where the two sides differ, which events explain it, and what to do.
 *
 * Every figure here is this file's own and none is a money figure anybody has to believe. The claim the
 * cases are arranged around is the one that is easy to get wrong in the safe-looking direction: a
 * divergence NOTHING explains must be quarantined rather than corrected, and the tempting
 * implementation — "the gateway is the authority, overwrite our figures" — is impossible anyway, because
 * the figures are a projection of append-only rows.
 */

const INTENT = 'gw-recon-0001'
const T0 = 1_900_000_000_000 as Instant

const event = (
  id: string,
  type: PaymentIntentEvent['type'],
  offsetMs: number,
  fils?: number,
): PaymentIntentEvent => ({
  eventId: id,
  type,
  occurredAt: (T0 + offsetMs) as Instant,
  ...(fils === undefined ? {} : { amount: money(filsFrom(fils)) }),
})

const AUTH = event('e-auth', 'authorised', 0, 20_000)
const CAP = event('e-cap', 'captured', 1_000, 20_000)
const REF = event('e-ref', 'refunded', 2_000, 5_000)

const local = (over: Partial<LocalIntentPosition> = {}): LocalIntentPosition => ({
  gatewayIntentId: INTENT,
  state: 'captured',
  authorisedFils: 20_000,
  capturedFils: 20_000,
  refundedFils: 0,
  knownEventIds: ['e-auth', 'e-cap'],
  ...over,
})

const gateway = (over: Partial<GatewayObservation> = {}): GatewayObservation => ({
  gatewayIntentId: INTENT,
  state: 'captured',
  authorisedFils: 20_000,
  capturedFils: 20_000,
  refundedFils: 0,
  observedAtMs: T0 + 10_000,
  ...over,
})

describe('divergenceOf', () => {
  it('answers null when the two sides agree exactly', () => {
    expect(divergenceOf(local(), gateway())).toBeNull()
  })

  it.each(DIVERGENT_FIELDS)('names %s when only that field differs', (field) => {
    const over: Partial<GatewayObservation> =
      field === 'state'
        ? { state: 'authorised' }
        : field === 'authorised'
          ? { authorisedFils: 20_001 }
          : field === 'captured'
            ? { capturedFils: 20_001 }
            : { refundedFils: 1 }
    const divergence = divergenceOf(local(), gateway(over))
    expect(divergence?.fields).toEqual([field])
    // Both sides on the row, which is what makes a repair auditable rather than a figure that moved.
    expect(divergence?.local).toBeDefined()
    expect(divergence?.gateway).toBeDefined()
  })

  it('names a one-fils difference, because there is no tolerance', () => {
    expect(divergenceOf(local(), gateway({ capturedFils: 19_999 }))?.fields).toEqual(['captured'])
  })

  it('names every divergent field, in a stable order', () => {
    const divergence = divergenceOf(
      local(),
      gateway({ state: 'authorised', capturedFils: 0, refundedFils: 7 }),
    )
    expect(divergence?.fields).toEqual(['state', 'captured', 'refunded'])
  })

  it('refuses to compare two different intents', () => {
    // A divergence in every field and a repair that would apply one intent's events to another.
    expect(() => divergenceOf(local(), gateway({ gatewayIntentId: 'gw-somebody-else' }))).toThrow(
      /two different intents|divergenceOf was given/,
    )
  })
})

describe('missedEvents', () => {
  it('returns only the events we have no row for, in the gateway’s own order', () => {
    const missed = missedEvents(local(), [REF, CAP, AUTH])
    expect(missed.map((e) => e.eventId)).toEqual(['e-ref'])
  })

  it('orders by instant and breaks a tie on the event id, which is the fold’s own order', () => {
    const a = event('e-b', 'refunded', 2_000, 1_000)
    const b = event('e-a', 'refunded', 2_000, 1_000)
    expect(missedEvents(local(), [a, b]).map((e) => e.eventId)).toEqual(['e-a', 'e-b'])
  })

  it('returns nothing when the stream holds nothing new', () => {
    expect(missedEvents(local(), [AUTH, CAP])).toEqual([])
  })
})

describe('planReconciliation', () => {
  it('answers `none` when the sides agree and nothing is missing', () => {
    const plan = planReconciliation({
      local: local(),
      gateway: gateway(),
      fromGateway: [AUTH, CAP],
      stored: [AUTH, CAP],
    })
    expect(plan.action).toBe('none')
    expect(plan.before).toBeNull()
    // Not an exception row: a reconciliation recording every intent it looked at would make the table a
    // log of runs, and "a second consecutive run produces zero repairs" unassertable.
    expect(consequentialPlans([plan])).toEqual([])
  })

  it('repairs a divergence the gateway’s own stream explains, by FOLDING', () => {
    const plan = planReconciliation({
      local: local(),
      gateway: gateway({ refundedFils: 5_000 }),
      fromGateway: [AUTH, CAP, REF],
      stored: [AUTH, CAP],
    })
    expect(plan.action).toBe('apply_missed_events')
    expect(plan.missed.map((e) => e.eventId)).toEqual(['e-ref'])
    expect(plan.before?.fields).toEqual(['refunded'])
    // The state the FOLD reaches, not the state the gateway's snapshot claims. ADR 0056's division.
    expect(plan.afterState).toBe('captured')
    expect(plan.reason).toContain('e-ref')
    expect(missedEventCount([plan])).toBe(1)
  })

  it('computes the after-state by FOLDING, not by believing the gateway\u2019s own state field', () => {
    // The gateway's snapshot claims `authorised` while the events it sent fold to `captured`. A gateway
    // that agrees with our table makes the two indistinguishable, which is why this case has to be one
    // that DISAGREES — ADR 0056's division: the gateway says what happened and the lifecycle table says
    // which state that reaches, and believing the snapshot would silently accept an un-capture.
    const plan = planReconciliation({
      local: local({
        state: 'authorised',
        capturedFils: 0,
        knownEventIds: ['e-auth'],
      }),
      gateway: gateway({ state: 'authorised', capturedFils: 20_000 }),
      fromGateway: [AUTH, CAP],
      stored: [AUTH],
    })
    expect(plan.action).toBe('apply_missed_events')
    expect(plan.missed.map((e) => e.eventId)).toEqual(['e-cap'])
    // The FOLD's answer, and deliberately not the snapshot's.
    expect(plan.afterState).toBe('captured')
    expect(plan.afterState).not.toBe('authorised')
  })

  it('still applies a missed event when the FIGURES already agree', () => {
    // A real state worth stating: the rows have to be on file anyway, because
    // `payment_intent_transaction` is what a dispute is answered from and ZY163 holds the header to them.
    const plan = planReconciliation({
      local: local({ refundedFils: 5_000, knownEventIds: ['e-auth', 'e-cap'] }),
      gateway: gateway({ refundedFils: 5_000 }),
      fromGateway: [AUTH, CAP, REF],
      stored: [AUTH, CAP],
    })
    expect(plan.action).toBe('apply_missed_events')
    expect(plan.before).toBeNull()
    expect(plan.reason).toContain('have to be on file anyway')
  })

  it('QUARANTINES a divergence nothing explains, rather than correcting it', () => {
    // THE case the unit is about. The figures differ, the gateway's stream contains nothing we have not
    // recorded, and the safe-looking fix — overwrite ours with theirs — is impossible: the figures are a
    // projection of append-only rows, so writing them means fabricating a gateway event.
    const plan = planReconciliation({
      local: local(),
      gateway: gateway({ capturedFils: 23_000 }),
      fromGateway: [AUTH, CAP],
      stored: [AUTH, CAP],
    })
    expect(plan.action).toBe('quarantine')
    expect(plan.missed).toEqual([])
    expect(plan.before?.fields).toEqual(['captured'])
    expect(plan.afterState).toBeNull()
    expect(plan.reason).toContain('attributable to no event')
    expect(consequentialPlans([plan])).toHaveLength(1)
    // And nothing was "repaired", so the count of applied events stays nought.
    expect(missedEventCount([plan])).toBe(0)
  })

  it('quarantines a stream that cannot be folded onto the stored history', () => {
    // The gateway's own stream being internally impossible: a capture with no authorisation behind it.
    // Applying part of it would leave a position neither side holds.
    const plan = planReconciliation({
      local: local({
        state: 'requires_authorisation',
        authorisedFils: 0,
        capturedFils: 0,
        knownEventIds: [],
      }),
      gateway: gateway(),
      fromGateway: [CAP],
      stored: [],
    })
    expect(plan.action).toBe('quarantine')
    expect(plan.missed.map((e) => e.eventId)).toEqual(['e-cap'])
    expect(plan.reason).toContain('cannot be folded')
  })

  it('declares every action, and the three are the whole set', () => {
    // The control that stops the cases above from covering two of three without saying so.
    const covered = new Set(
      [
        planReconciliation({
          local: local(),
          gateway: gateway(),
          fromGateway: [AUTH, CAP],
          stored: [AUTH, CAP],
        }),
        planReconciliation({
          local: local(),
          gateway: gateway({ refundedFils: 5_000 }),
          fromGateway: [AUTH, CAP, REF],
          stored: [AUTH, CAP],
        }),
        planReconciliation({
          local: local(),
          gateway: gateway({ capturedFils: 23_000 }),
          fromGateway: [AUTH, CAP],
          stored: [AUTH, CAP],
        }),
      ].map((plan) => plan.action),
    )
    expect([...covered].sort()).toEqual([...RECONCILIATION_ACTIONS].sort())
  })
})
