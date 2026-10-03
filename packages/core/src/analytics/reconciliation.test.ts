import { describe, expect, it } from 'vitest'
import {
  DISPATCH_DIFFERENCE_KINDS,
  DISPATCH_STATE_WAS_PUSHED,
  DISPATCH_STATE_WAS_REFUSED_ON_PURPOSE,
  DISPATCH_STATES,
  type DispatchReconciliationUnreconciled,
  type InternalConversion,
  isUnreconciled,
  type PushedDispatch,
  reconcileDispatches,
  UNRECONCILED,
  UNRECONCILED_PANEL_SENTENCE,
} from './reconciliation.ts'

/**
 * Internal truth against what was pushed (A-MEAS-07).
 *
 * Every case here comes with the half that could fail. "It reconciles" is satisfied by a function that
 * always answers `reconciled`, so each claim is paired with an input that must come back `unreconciled` —
 * and the acceptance line's own fixture (10 paid conversions, 9 successful dispatches, exactly one missing
 * item named by event_id) is the first case for that reason.
 */

const DESTINATION = 'analytics_measurement_push'

const conversion = (n: number, valueFils = 32_010): InternalConversion => ({
  eventId: `event-${String(n).padStart(2, '0')}`,
  valueFils,
})

const sent = (n: number, valueFils = 32_010): PushedDispatch => ({
  eventId: `event-${String(n).padStart(2, '0')}`,
  dispatchId: `dispatch-${String(n).padStart(2, '0')}`,
  state: 'sent',
  valueFils,
})

const unreconciledOf = (
  result: ReturnType<typeof reconcileDispatches>,
): DispatchReconciliationUnreconciled => {
  expect(isUnreconciled(result), 'this case is about the unreconciled answer').toBe(true)
  return result as DispatchReconciliationUnreconciled
}

describe('the acceptance fixture: ten paid conversions and nine dispatches', () => {
  const internal = Array.from({ length: 10 }, (_, index) => conversion(index + 1))
  const pushed = Array.from({ length: 9 }, (_, index) => sent(index + 1))

  it('reports exactly ONE missing item, named by event_id', () => {
    const result = unreconciledOf(
      reconcileDispatches({ destination: DESTINATION, internal, pushed }),
    )
    expect(result.counts).toMatchObject({
      internalCount: 10,
      pushedCount: 9,
      missingCount: 1,
      duplicateCount: 0,
      intentionallyNotPushedCount: 0,
    })
    expect(result.differences).toHaveLength(1)
    expect(result.differences[0]).toEqual({
      kind: 'missing',
      eventId: 'event-10',
      valueFils: 32_010,
    })
    // The money difference is the one conversion's value, signed in the direction that says the platform
    // is SHORT of what this business took.
    expect(result.differenceFils).toBe(32_010)
  })

  it('reconciles when the tenth dispatch lands, which is the control', () => {
    const result = reconcileDispatches({
      destination: DESTINATION,
      internal,
      pushed: [...pushed, sent(10)],
    })
    expect(result.kind).toBe('reconciled')
    expect(isUnreconciled(result)).toBe(false)
    if (result.kind !== 'reconciled') throw new Error('narrowing')
    expect(result.pushedFils).toBe(10 * 32_010)
    expect(result.missingCount).toBe(0)
  })

  it('carries no revenue figure on the unreconciled variant at all', () => {
    // The acceptance line: the API returns Unreconciled rather than a NUMBER. A caller that could read a
    // figure off this would read it, and the panel would render it beside a warning nobody reads twice.
    const result = unreconciledOf(
      reconcileDispatches({ destination: DESTINATION, internal, pushed }),
    )
    expect(Object.hasOwn(result, 'pushedFils')).toBe(false)
    expect(UNRECONCILED).toBe('Unreconciled')
  })
})

describe('a consent-denied conversion', () => {
  it("is classified 'intentionally_not_pushed' and is not counted as a discrepancy", () => {
    const internal = [conversion(1), conversion(2)]
    const pushed: readonly PushedDispatch[] = [
      sent(1),
      { eventId: 'event-02', dispatchId: 'dispatch-02', state: 'suppressed', valueFils: 0 },
    ]
    const result = reconcileDispatches({ destination: DESTINATION, internal, pushed })
    // RECONCILED: the conversion happened, the push correctly did not, and nothing is owed.
    expect(result.kind).toBe('reconciled')
    if (result.kind !== 'reconciled') throw new Error('narrowing')
    expect(result.intentionallyNotPushedCount).toBe(1)
    expect(result.missingCount).toBe(0)
    expect(result.intentionallyNotPushed[0]).toMatchObject({
      kind: 'intentionally_not_pushed',
      eventId: 'event-02',
      dispatchId: 'dispatch-02',
      state: 'suppressed',
    })
    // And its value is in NEITHER side, so the difference is zero rather than permanently equal to the
    // suppressed conversions — a permanent disagreement is a number somebody eventually suppresses.
    expect(result.pushedFils).toBe(32_010)
  })

  it('treats a withdrawal the same way, because both are the system working', () => {
    const result = reconcileDispatches({
      destination: DESTINATION,
      internal: [conversion(1)],
      pushed: [
        {
          eventId: 'event-01',
          dispatchId: 'dispatch-01',
          state: 'cancelled_consent_withdrawn',
          valueFils: 0,
        },
      ],
    })
    expect(result.kind).toBe('reconciled')
  })

  it('is NOT what a queued or failed row is, which is the control that matters', () => {
    // The pass runs after the day has closed and the consumer drains every five minutes, so a row still
    // owed at that point is a conversion the platform does not have — whatever the reason.
    for (const state of ['queued', 'failed'] as const) {
      const result = unreconciledOf(
        reconcileDispatches({
          destination: DESTINATION,
          internal: [conversion(1)],
          pushed: [{ eventId: 'event-01', dispatchId: 'dispatch-01', state, valueFils: 32_010 }],
        }),
      )
      expect(result.counts.missingCount).toBe(1)
      expect(result.counts.intentionallyNotPushedCount).toBe(0)
    }
  })
})

describe('a duplicate dispatch', () => {
  it("is classified 'duplicate' and carries BOTH row ids", () => {
    const result = unreconciledOf(
      reconcileDispatches({
        destination: DESTINATION,
        internal: [conversion(1)],
        pushed: [
          { eventId: 'event-01', dispatchId: 'dispatch-01a', state: 'sent', valueFils: 32_010 },
          { eventId: 'event-01', dispatchId: 'dispatch-01b', state: 'sent', valueFils: 32_010 },
        ],
      }),
    )
    expect(result.counts.duplicateCount).toBe(1)
    expect(result.differences[0]).toEqual({
      kind: 'duplicate',
      eventId: 'event-01',
      dispatchId: 'dispatch-01a',
      otherDispatchId: 'dispatch-01b',
      valueFils: 32_010,
    })
    // The ids are in id ORDER, so "the first two" is a decision rather than whichever row the query
    // happened to return first — two runs of the pass must produce identical rows.
    expect(result.differences[0]).toMatchObject({ dispatchId: 'dispatch-01a' })
  })

  it('counts the value ONCE, so the money difference does not report a disagreement that is not there', () => {
    // The platform's figure is the sum over the IDS it has seen, so one conversion delivered twice under
    // one id is one conversion to it too. Counting it twice here would make the difference -32,010.
    const result = unreconciledOf(
      reconcileDispatches({
        destination: DESTINATION,
        internal: [conversion(1)],
        pushed: [
          { eventId: 'event-01', dispatchId: 'dispatch-01a', state: 'sent', valueFils: 32_010 },
          { eventId: 'event-01', dispatchId: 'dispatch-01b', state: 'sent', valueFils: 32_010 },
        ],
      }),
    )
    expect(result.differenceFils).toBe(0)
    // And it is STILL unreconciled, which is the point: the money agrees and the records do not.
    expect(result.counts.duplicateCount).toBe(1)
  })

  it('takes the first two of three in id order, rather than dropping the extra silently', () => {
    const result = unreconciledOf(
      reconcileDispatches({
        destination: DESTINATION,
        internal: [conversion(1)],
        pushed: [
          { eventId: 'event-01', dispatchId: 'dispatch-c', state: 'sent', valueFils: 1 },
          { eventId: 'event-01', dispatchId: 'dispatch-a', state: 'sent', valueFils: 1 },
          { eventId: 'event-01', dispatchId: 'dispatch-b', state: 'sent', valueFils: 1 },
        ],
      }),
    )
    expect(result.differences[0]).toMatchObject({
      dispatchId: 'dispatch-a',
      otherDispatchId: 'dispatch-b',
    })
  })
})

describe('a dispatch with no internal truth behind it', () => {
  it('is reported on its own list and makes the day unreconciled', () => {
    // The other direction, and the more alarming one: a platform was told about a conversion this business
    // cannot produce from its own records. Not folded into `duplicate`, which would have been the
    // convenient lie, and not left out, which would have been the silent one.
    const result = unreconciledOf(
      reconcileDispatches({
        destination: DESTINATION,
        internal: [conversion(1)],
        pushed: [sent(1), sent(2)],
      }),
    )
    expect(result.pushedWithoutInternalTruth).toEqual(['event-02'])
    expect(result.counts.missingCount).toBe(0)
    expect(result.counts.duplicateCount).toBe(0)
    // Negative: the platform was told about revenue the journal cannot produce.
    expect(result.differenceFils).toBe(-32_010)
  })

  it('ignores a suppressed row with no internal truth, which is not a push at all', () => {
    const result = reconcileDispatches({
      destination: DESTINATION,
      internal: [],
      pushed: [
        { eventId: 'event-09', dispatchId: 'dispatch-09', state: 'suppressed', valueFils: 0 },
      ],
    })
    expect(result.kind).toBe('reconciled')
  })
})

describe('the vocabularies', () => {
  it('declare a pushed-ness and a refused-ness for every dispatch state, in both directions', () => {
    expect(Object.keys(DISPATCH_STATE_WAS_PUSHED).sort()).toEqual([...DISPATCH_STATES].sort())
    expect(Object.keys(DISPATCH_STATE_WAS_REFUSED_ON_PURPOSE).sort()).toEqual(
      [...DISPATCH_STATES].sort(),
    )
    // No state is both, which would make one conversion two classifications.
    for (const state of DISPATCH_STATES) {
      expect(
        DISPATCH_STATE_WAS_PUSHED[state] && DISPATCH_STATE_WAS_REFUSED_ON_PURPOSE[state],
        `${state} cannot be both pushed and deliberately refused`,
      ).toBe(false)
    }
  })

  it('use every declared classification, so none is dead', () => {
    const used = new Set(
      unreconciledOf(
        reconcileDispatches({
          destination: DESTINATION,
          internal: [conversion(1), conversion(2), conversion(3)],
          pushed: [
            { eventId: 'event-02', dispatchId: 'dispatch-02', state: 'suppressed', valueFils: 0 },
            { eventId: 'event-03', dispatchId: 'dispatch-03a', state: 'sent', valueFils: 32_010 },
            { eventId: 'event-03', dispatchId: 'dispatch-03b', state: 'sent', valueFils: 32_010 },
          ],
        }),
      ).differences.map((difference) => difference.kind),
    )
    expect([...used].sort()).toEqual([...DISPATCH_DIFFERENCE_KINDS].sort())
  })

  it('orders the differences missing, then duplicate, then the suppressions', () => {
    const result = unreconciledOf(
      reconcileDispatches({
        destination: DESTINATION,
        internal: [conversion(1), conversion(2), conversion(3)],
        pushed: [
          { eventId: 'event-02', dispatchId: 'dispatch-02', state: 'suppressed', valueFils: 0 },
          { eventId: 'event-03', dispatchId: 'dispatch-03a', state: 'sent', valueFils: 32_010 },
          { eventId: 'event-03', dispatchId: 'dispatch-03b', state: 'sent', valueFils: 32_010 },
        ],
      }),
    )
    expect(result.differences.map((difference) => difference.kind)).toEqual([
      'missing',
      'duplicate',
      'intentionally_not_pushed',
    ])
  })
})

describe('the refusals and the panel sentence', () => {
  it('refuses a fractional fils on either side rather than producing a difference from it', () => {
    expect(() =>
      reconcileDispatches({
        destination: DESTINATION,
        internal: [conversion(1, 320.5)],
        pushed: [],
      }),
    ).toThrow(/not a whole number/)
    expect(() =>
      reconcileDispatches({
        destination: DESTINATION,
        internal: [conversion(1)],
        pushed: [sent(1, 320.5)],
      }),
    ).toThrow(/not a whole number/)
  })

  it('reconciles an empty day rather than refusing it', () => {
    // A day with no conversions is reconciled and says so with zero counts. ADR 0002's other half: the
    // answer has to distinguish "nothing happened" from "we could not tell", and the heartbeat is what
    // says the pass ran at all.
    const result = reconcileDispatches({ destination: DESTINATION, internal: [], pushed: [] })
    expect(result.kind).toBe('reconciled')
    if (result.kind !== 'reconciled') throw new Error('narrowing')
    expect(result).toMatchObject({ internalCount: 0, pushedCount: 0, pushedFils: 0 })
  })

  it('states the panel sentence once, here, so the renderer cannot hold a second copy', () => {
    expect(UNRECONCILED_PANEL_SENTENCE).toContain('unreconciled')
    expect(UNRECONCILED_PANEL_SENTENCE).toContain('no figure is shown')
  })
})
