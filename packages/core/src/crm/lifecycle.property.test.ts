import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_ACQUISITION_PROVISIONAL,
  CUSTOMER_ACQUISITION_SOURCES,
  CUSTOMER_LIFECYCLE_EVENTS,
  CUSTOMER_LIFECYCLE_PROVISIONAL,
  CUSTOMER_LIFECYCLE_REFUSALS,
  CUSTOMER_LIFECYCLE_STATES,
  type CustomerLifecycleEvent,
  type CustomerLifecycleState,
  decideCustomerLifecycle,
  lifecycleStateAfter,
} from './lifecycle.ts'

/**
 * C-CRM-01's acceptance line: "the customer lifecycle reducer returns either a named next state or a
 * typed refusal for every pair — never throws, never returns undefined".
 *
 * That is a property over the whole (state x event) cross product, so it is asserted twice over: once
 * exhaustively, because 6 x 7 is 42 and there is no reason to sample a space that small, and once
 * through fast-check with generators that produce values from **outside** both unions. The second is
 * the one that matters for the contract: in production `from` arrives from a `customer.lifecycle_state`
 * column and `event` from a caller, so the realistic bad input is a label this build has not learned
 * about — and the permissive version of this function returns `undefined` for it, which at a call site
 * is indistinguishable from "no change needed".
 *
 * ## The controls
 *
 * Three, because each of the three ways this property can go vacuous has happened to a state machine
 * somewhere:
 *
 *   1. A reducer that answers `unchanged` for everything satisfies "never throws" and decides nothing.
 *      So the shape of the answer is counted: every kind must actually occur, and the counts are pinned.
 *   2. A table with a missing cell is caught by `Record` at compile time and by nothing at runtime if a
 *      cast is involved. The exhaustive walk asserts the cell exists for all 42 pairs.
 *   3. A checker that reads a state name out of the verdict and compares it to itself proves
 *      self-consistency. Every target is therefore checked against `CUSTOMER_LIFECYCLE_STATES`, the
 *      list the database's vocabulary table is pinned to.
 */
const ALL_PAIRS: readonly (readonly [CustomerLifecycleState, CustomerLifecycleEvent])[] =
  CUSTOMER_LIFECYCLE_STATES.flatMap((state) =>
    CUSTOMER_LIFECYCLE_EVENTS.map(
      (event) => [state, event] as [CustomerLifecycleState, CustomerLifecycleEvent],
    ),
  )

describe('the reducer is total over the whole cross product', () => {
  it('covers 42 pairs, and that is every pair', () => {
    expect(CUSTOMER_LIFECYCLE_STATES).toHaveLength(6)
    expect(CUSTOMER_LIFECYCLE_EVENTS).toHaveLength(7)
    expect(ALL_PAIRS).toHaveLength(42)
    expect(new Set(ALL_PAIRS.map(([s, e]) => `${s}|${e}`)).size).toBe(42)
  })

  it('answers every pair with a named next state or a typed refusal', () => {
    for (const [state, event] of ALL_PAIRS) {
      const verdict = decideCustomerLifecycle(state, event)
      expect(verdict, `${state} x ${event}`).toBeDefined()
      expect(verdict.why.length, `${state} x ${event} carries a reason`).toBeGreaterThan(20)
      if (verdict.kind === 'moved') {
        expect(CUSTOMER_LIFECYCLE_STATES, `${state} x ${event}`).toContain(verdict.to)
        expect(verdict.from).toBe(state)
        // A "move" to the state it is already in is an `unchanged` wearing the wrong label, and a
        // caller would write a history row for a change that did not happen.
        expect(verdict.to, `${state} x ${event} moved to itself`).not.toBe(state)
      } else if (verdict.kind === 'unchanged') {
        expect(verdict.state).toBe(state)
      } else {
        expect(CUSTOMER_LIFECYCLE_REFUSALS, `${state} x ${event}`).toContain(verdict.refusal)
        expect(verdict.from).toBe(state)
      }
    }
  })

  it('never throws, for any string pair at all', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(...CUSTOMER_LIFECYCLE_STATES),
          fc.string(),
          fc.constantFrom('__proto__', 'constructor', 'toString', 'hasOwnProperty'),
        ),
        fc.oneof(
          fc.constantFrom(...CUSTOMER_LIFECYCLE_EVENTS),
          fc.string(),
          fc.constantFrom('__proto__', 'constructor', 'valueOf'),
        ),
        (state, event) => {
          const verdict = decideCustomerLifecycle(
            state as CustomerLifecycleState,
            event as CustomerLifecycleEvent,
          )
          expect(verdict).toBeDefined()
          expect(['moved', 'unchanged', 'refused']).toContain(verdict.kind)
          return true
        },
      ),
      { numRuns: 2_000 },
    )
  })

  it('refuses a label from outside either union by name rather than returning undefined', () => {
    // The drift case, stated as itself. `__proto__` is in the generator above because an object-keyed
    // table reached with a bare index read answers it from the prototype chain, which is a "known pair"
    // the table never declared.
    const drifted = decideCustomerLifecycle('vip' as CustomerLifecycleState, 'booking_taken')
    expect(drifted.kind).toBe('refused')
    expect(drifted.kind === 'refused' && drifted.refusal).toBe('unknown_lifecycle_pair')
    const prototypePair = decideCustomerLifecycle(
      '__proto__' as CustomerLifecycleState,
      'toString' as CustomerLifecycleEvent,
    )
    expect(prototypePair.kind).toBe('refused')
  })
})

describe('the shape of the answers — the control on a reducer that decides nothing', () => {
  it('produces all three kinds, in the numbers the table declares', () => {
    const counts = { moved: 0, unchanged: 0, refused: 0 }
    for (const [state, event] of ALL_PAIRS) counts[decideCustomerLifecycle(state, event).kind] += 1
    // Pinned. A table edit that widens or narrows the machine changes one of these three and fails
    // here, which is the whole reason the numbers are written down rather than derived.
    expect(counts).toEqual({ moved: 18, unchanged: 12, refused: 12 })
  })

  it('reports the state after a verdict, and null for a refusal', () => {
    expect(lifecycleStateAfter(decideCustomerLifecycle('lead', 'booking_taken'))).toBe('new')
    expect(lifecycleStateAfter(decideCustomerLifecycle('active', 'booking_taken'))).toBe('active')
    expect(lifecycleStateAfter(decideCustomerLifecycle('blocked', 'booking_taken'))).toBeNull()
  })
})

describe('blocked does not lapse, and does not book', () => {
  it('refuses every event but an enquiry and the lift', () => {
    const refused = CUSTOMER_LIFECYCLE_EVENTS.filter(
      (event) => decideCustomerLifecycle('blocked', event).kind === 'refused',
    )
    expect([...refused].sort()).toEqual([
      'booking_taken',
      'inactivity_threshold_reached',
      'inactivity_warning_reached',
      'treatment_completed',
    ])
    for (const event of refused) {
      const verdict = decideCustomerLifecycle('blocked', event)
      expect(verdict.kind === 'refused' && verdict.refusal).toBe('customer_is_blocked')
    }
  })

  it('leaves blocked only by an explicit lift, never by the passage of time', () => {
    // The security property. A blocked record that could lapse would leave `blocked` on a timer: the
    // sweep would un-block somebody at 03:00 with nobody deciding it should.
    const reachedFromBlocked = CUSTOMER_LIFECYCLE_EVENTS.map((event) =>
      lifecycleStateAfter(decideCustomerLifecycle('blocked', event)),
    ).filter((state): state is CustomerLifecycleState => state !== null && state !== 'blocked')
    expect(reachedFromBlocked).toEqual(['lapsed'])
    expect(lifecycleStateAfter(decideCustomerLifecycle('blocked', 'blocklist_lifted'))).toBe(
      'lapsed',
    )
  })

  it('reaches blocked from every other state, so the block is never unreachable', () => {
    for (const state of CUSTOMER_LIFECYCLE_STATES) {
      const verdict = decideCustomerLifecycle(state, 'blocklisted')
      expect(lifecycleStateAfter(verdict), state).toBe('blocked')
    }
  })

  it('refuses a lift for a record that is not blocked', () => {
    for (const state of CUSTOMER_LIFECYCLE_STATES.filter((s) => s !== 'blocked')) {
      const verdict = decideCustomerLifecycle(state, 'blocklist_lifted')
      expect(verdict.kind === 'refused' && verdict.refusal, state).toBe('not_blocked')
    }
  })
})

describe('the vocabularies are registered as provisional', () => {
  it('names an OPEN-QUESTIONS id in the shape the settings registry test enforces', () => {
    for (const provisional of [CUSTOMER_LIFECYCLE_PROVISIONAL, CUSTOMER_ACQUISITION_PROVISIONAL]) {
      expect(provisional.openQuestionId).toMatch(/^Y\d+[a-z]?-[a-z-]+$/)
      expect(provisional.note.length).toBeGreaterThan(10)
    }
    // Two ids, not one: the business can answer "what are the client stages" without answering "which
    // channels do you count as acquisition", and one flag covering both would clear the Unconfirmed
    // Assumptions panel for an answer nobody gave.
    expect(CUSTOMER_LIFECYCLE_PROVISIONAL.openQuestionId).not.toBe(
      CUSTOMER_ACQUISITION_PROVISIONAL.openQuestionId,
    )
  })

  it('defaults the acquisition source to unknown rather than to a guess', () => {
    expect(CUSTOMER_ACQUISITION_SOURCES).toContain('unknown')
    expect(CUSTOMER_ACQUISITION_SOURCES).toHaveLength(6)
    expect(new Set(CUSTOMER_ACQUISITION_SOURCES).size).toBe(6)
  })
})
