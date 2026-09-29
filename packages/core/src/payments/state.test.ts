import { describe, expect, it } from 'vitest'
import type { PaymentIntentEventType, PaymentIntentState } from './state.ts'
import {
  INTENT_EVENT_CARRIES_AMOUNT,
  INTENT_TRANSITIONS,
  IntentTransitionRefused,
  isIntentTransitionAllowed,
  nextIntentState,
  PAYMENT_INTENT_EVENTS,
  PAYMENT_INTENT_STATES,
  TRANSITION_REFUSED,
} from './state.ts'
import { transactionAmountIsLegal } from './transactions.ts'

/**
 * The acceptance line: *"the declared (state, event) table is asserted total over the enum product, and every
 * pair outside it is refused with a named error"*.
 *
 * Y-PAY-01 built the table and left this filename free for it. `state.transitions.test.ts` next door asserts
 * that the table is complete in SHAPE — a cell exists for every pair and holds a legal value — by walking
 * `INTENT_TRANSITIONS` itself. That is the right check for shape and it is not this one, because walking the
 * table to describe the table cannot notice a cell whose VALUE is wrong: every assertion of the form "read
 * the cell, check the cell is legal" passes for a table in which `voided` from `captured` has become
 * `voided`, which would release a reservation that no longer exists and leave a capture unaccounted for.
 *
 * ## So the expected table below is written out by hand, all thirty-six cells
 *
 * That is the whole design of this file and the reason it is long. The assertion is a comparison against an
 * INDEPENDENT statement of the answer, so any single cell changing in `state.ts` fails here by name and a
 * reader has to justify the change in two places. It is the arrangement the repository already uses where one
 * derivation would be circular — `packages/fixtures/src/payment.itest.ts` holds `tender_type` equal to
 * `TENDER_ACCOUNT` rather than deriving one from the other — and it is the only shape in which "the table is
 * total" is a claim about the table's contents rather than about its keys.
 *
 * The cells are grouped by row with a sentence per row saying what the row MEANS, because thirty-six
 * literals with no argument in them is a wall a reviewer skims. The four that are worth stopping on carry
 * their own reason inline.
 *
 * ## Every assertion here has a control that must fail
 *
 * A comparison against a hand-written table is exactly the check that goes vacuous if the walk stops
 * walking, so: the pair count is asserted (36, not "at least one"), the allowed and refused counts are
 * asserted against the hand-written table rather than against `INTENT_TRANSITIONS`, and the equality is also
 * run against a DELIBERATELY WRONG copy of the expected table which must be detected in every cell. Without
 * that last one this file would pass for a `deepEqual` that had been reduced to comparing two references.
 */

/** Shorthand so a row fits on one line and the grid is readable as a grid. */
const R = TRANSITION_REFUSED

type Cell = PaymentIntentState | typeof TRANSITION_REFUSED
type ExpectedTable = Readonly<Record<PaymentIntentState, Readonly<Record<PaymentIntentEventType, Cell>>>>

/**
 * The lifecycle, written out independently of `state.ts`.
 *
 * Typed as the same total `Record` so that adding a state or an event to either enum fails `tsc` HERE as
 * well as in `state.ts` — which is the property that makes this file a second opinion rather than a copy
 * that can be forgotten. Gate case 134b is the known-bad fixture for it.
 */
const EXPECTED: ExpectedTable = Object.freeze({
  // Created, nothing reserved, the gateway has not answered. Everything that can start an intent is here,
  // and the two that cannot are a capture and a refund: there is nothing yet to take or give back.
  requires_authorisation: Object.freeze({
    action_required: 'requires_customer_action',
    authorised: 'authorised',
    authorisation_failed: 'failed',
    captured: R,
    refunded: R,
    // A void before the gateway answered releases a reservation we do not know exists. Allowed because that
    // is exactly the state an abandoned checkout is in, and someone has to be able to close it.
    voided: 'voided',
  }),
  // A challenge is outstanding and the customer may never come back. Same row as above by design: the
  // challenge changed what the CUSTOMER has to do, not what the money has done.
  requires_customer_action: Object.freeze({
    // A second "a challenge is outstanding" is a redelivery, not a second challenge.
    action_required: 'requires_customer_action',
    authorised: 'authorised',
    authorisation_failed: 'failed',
    captured: R,
    refunded: R,
    voided: 'voided',
  }),
  // Funds reserved, nothing taken.
  authorised: Object.freeze({
    // The challenge is over. A gateway asking for one now is an event for another intent.
    action_required: R,
    authorised: 'authorised',
    // A gateway does not un-authorise. Releasing a reservation is a void, and it has its own event because
    // it has its own ledger consequence.
    authorisation_failed: R,
    captured: 'captured',
    refunded: R,
    voided: 'voided',
  }),
  // At least one capture has succeeded. Absorbing, and still very much alive: further captures and refunds
  // change the AMOUNTS, because refund fullness is an amount fact and not a state.
  captured: Object.freeze({
    action_required: R,
    // THE cell that makes at-least-once delivery safe. A redelivered authorisation webhook must not move a
    // captured intent backwards; getting this wrong un-captures money that has been taken.
    authorised: 'captured',
    authorisation_failed: R,
    captured: 'captured',
    refunded: 'captured',
    // Money that has been taken is refunded, not voided. A void here would release a reservation that no
    // longer exists and leave the capture unaccounted for.
    voided: R,
  }),
  // The authorisation was released without taking anything. Terminal.
  voided: Object.freeze({
    action_required: R,
    authorised: R,
    authorisation_failed: R,
    captured: R,
    refunded: R,
    // A terminal intent is the one a gateway retries hardest, so its own event stays put rather than
    // refusing. A refusal here turns a duplicate delivery into an incident.
    voided: 'voided',
  }),
  // The gateway refused the authorisation. Terminal, and the replay on the diagonal for the same reason.
  failed: Object.freeze({
    action_required: R,
    authorised: R,
    authorisation_failed: 'failed',
    captured: R,
    refunded: R,
    voided: R,
  }),
})

/** Every (state, event) pair, as a flat list. The enum PRODUCT, which is what "total" is about. */
const PAIRS: readonly { state: PaymentIntentState; event: PaymentIntentEventType }[] =
  PAYMENT_INTENT_STATES.flatMap((state) =>
    PAYMENT_INTENT_EVENTS.map((event) => ({ state, event })),
  )

const expectedCell = (state: PaymentIntentState, event: PaymentIntentEventType): Cell =>
  EXPECTED[state][event]

/**
 * Every pair on which a candidate table disagrees with the shipped one, as `state+event`.
 *
 * The comparison itself, extracted so the control can run the SAME comparison against a table that is known
 * to be wrong. The first version of the control only checked that its perturbation differed from the real
 * cell, which proves that two values are different and nothing at all about the comparison — the comparison
 * could have been deleted and the control would still have passed.
 */
function disagreements(candidate: ExpectedTable): readonly string[] {
  return PAIRS.filter(
    ({ state, event }) => INTENT_TRANSITIONS[state][event] !== candidate[state][event],
  ).map(({ state, event }) => `${state}+${event}`)
}

/** A copy of the expected table with one cell replaced. Nothing mutates {@link EXPECTED}, which is frozen. */
function withCell(
  state: PaymentIntentState,
  event: PaymentIntentEventType,
  cell: Cell,
): ExpectedTable {
  return {
    ...EXPECTED,
    [state]: { ...EXPECTED[state], [event]: cell },
  } as ExpectedTable
}

describe('acceptance — the transition table is total over the enum product', () => {
  it('has a cell for all 36 pairs and no pair the product does not name', () => {
    // The vacuity floor for every case below: 6 states x 6 events. A literal, not a product of the two
    // lengths, because computing it from the enums would make a shrunken enum satisfy it.
    expect(PAIRS.length, 'the enum product is not 36 pairs; every count below is measured against it').toBe(
      36,
    )
    expect(new Set(PAIRS.map(({ state, event }) => `${state}+${event}`)).size).toBe(36)

    // Both directions over the KEYS, so a row or a column that exists in one table and not the other is a
    // failure rather than a pair nobody compared.
    expect(Object.keys(INTENT_TRANSITIONS).sort()).toEqual([...PAYMENT_INTENT_STATES].sort())
    expect(Object.keys(EXPECTED).sort()).toEqual([...PAYMENT_INTENT_STATES].sort())
    for (const state of PAYMENT_INTENT_STATES) {
      expect(Object.keys(INTENT_TRANSITIONS[state]).sort(), state).toEqual(
        [...PAYMENT_INTENT_EVENTS].sort(),
      )
      expect(Object.keys(EXPECTED[state]).sort(), state).toEqual([...PAYMENT_INTENT_EVENTS].sort())
    }
  })

  it('declares exactly the cell this unit expects, for every one of the 36', () => {
    let compared = 0
    for (const { state, event } of PAIRS) {
      expect(
        INTENT_TRANSITIONS[state][event],
        `${state} + ${event}: the shipped table and this file's independent statement of the lifecycle ` +
          'disagree. One of the two is wrong and neither is authoritative on its own — change both, in the ' +
          'same commit, with the reason in the cell comment.',
      ).toBe(expectedCell(state, event))
      compared += 1
    }
    expect(compared, 'no cell was compared, so this case measured nothing').toBe(36)
  })

  it('the control: each of the 36 cells, perturbed one at a time, is reported by name', () => {
    // Without this the case above passes for a comparison that had stopped comparing — a loop whose body
    // never ran, an `EXPECTED` that had become an alias for `INTENT_TRANSITIONS`, a `toBe` reading both
    // sides out of the same object. So the real comparison is run against 36 tables that are each wrong in
    // exactly one place, and each one must report exactly that place.
    expect(disagreements(EXPECTED), 'the unperturbed tables already disagree').toEqual([])

    let detected = 0
    for (const { state, event } of PAIRS) {
      const actual = INTENT_TRANSITIONS[state][event]
      // A value that is never the right one: the refusal where a state is declared, and a state where the
      // refusal is. `captured` is the stand-in state because it is a legal cell value everywhere, so the
      // perturbed table stays type-correct and the failure is a wrong ANSWER rather than a wrong shape.
      const wrong: Cell = actual === TRANSITION_REFUSED ? 'captured' : TRANSITION_REFUSED
      expect(wrong, `${state} + ${event}: the perturbation equals the real cell`).not.toBe(actual)
      expect(
        disagreements(withCell(state, event, wrong)),
        `perturbing ${state} + ${event} was not detected, or was reported as another pair`,
      ).toEqual([`${state}+${event}`])
      detected += 1
    }
    expect(detected, 'no cell could be perturbed, so the comparison above proves nothing').toBe(36)
  })

  it('counts the allowed and refused pairs against the hand-written table', () => {
    // Counted from EXPECTED and not from INTENT_TRANSITIONS, deliberately: a count derived from the thing
    // under test agrees with it whatever it says. These two figures are the table's shape in one line, and
    // a cell flipping between allowed and refused changes one of them.
    const refused = PAIRS.filter(({ state, event }) => expectedCell(state, event) === R)
    const allowed = PAIRS.filter(({ state, event }) => expectedCell(state, event) !== R)
    expect(refused.length + allowed.length).toBe(36)
    expect(refused.length, 'the number of refused pairs changed').toBe(20)
    expect(allowed.length, 'the number of allowed pairs changed').toBe(16)

    for (const { state, event } of refused) {
      expect(isIntentTransitionAllowed(state, event), `${state} + ${event}`).toBe(false)
    }
    for (const { state, event } of allowed) {
      expect(isIntentTransitionAllowed(state, event), `${state} + ${event}`).toBe(true)
    }
  })
})

describe('acceptance — every pair outside the table is refused with a named error', () => {
  it('throws IntentTransitionRefused, by name, for all 20 refused pairs', () => {
    let refusals = 0
    for (const { state, event } of PAIRS) {
      if (expectedCell(state, event) !== R) continue
      let caught: unknown
      try {
        nextIntentState(state, event, 'evt_probe')
      } catch (error) {
        caught = error
      }
      // `instanceof` AND the name AND the message, because each one alone has failed somewhere in this
      // repository: a subclass renamed but still extending, a name set and the class replaced, and a
      // `toThrow()` that passes for any throw at all including a TypeError from the line above it.
      expect(caught, `${state} + ${event} did not throw`).toBeInstanceOf(IntentTransitionRefused)
      expect((caught as Error).name).toBe('IntentTransitionRefused')
      expect((caught as Error).message).toContain(`"${event}" event cannot reach`)
      expect((caught as Error).message).toContain(`"${state}"`)
      // The event id reaches the details, which is what makes a refusal in production traceable to one
      // delivery rather than to a state and a type that a thousand deliveries share.
      expect((caught as { details?: { eventId?: string } }).details?.eventId).toBe('evt_probe')
      refusals += 1
    }
    expect(refusals, 'no refusal was exercised, so this case measured nothing').toBe(20)
  })

  it('returns the declared state, and throws nothing, for all 16 allowed pairs', () => {
    // The control on the case above. A `nextIntentState` that threw for everything would satisfy it
    // completely, and that is not a hypothetical: a single `throw` moved above the table lookup does it.
    let moves = 0
    for (const { state, event } of PAIRS) {
      const cell = expectedCell(state, event)
      if (cell === R) continue
      expect(nextIntentState(state, event, 'evt_probe'), `${state} + ${event}`).toBe(cell)
      moves += 1
    }
    expect(moves, 'no allowed pair was exercised, so the refusal case above proves nothing').toBe(16)
  })

  it('the predicate and the thrower agree on all 36, against the hand-written table', () => {
    // `state.transitions.test.ts` asserts this pair against INTENT_TRANSITIONS. Here it is against
    // EXPECTED, which is the direction that catches both of them being wrong together.
    let checked = 0
    for (const { state, event } of PAIRS) {
      const allowed = expectedCell(state, event) !== R
      expect(isIntentTransitionAllowed(state, event), `${state} + ${event}`).toBe(allowed)
      let threw = false
      try {
        nextIntentState(state, event, 'evt_probe')
      } catch {
        threw = true
      }
      expect(threw, `${state} + ${event}: the predicate says ${String(allowed)}`).toBe(!allowed)
      checked += 1
    }
    expect(checked).toBe(36)
  })
})

describe('the two amount tables stay in step with the event enum', () => {
  it('declares whether every event carries an amount, and exactly three do', () => {
    expect(Object.keys(INTENT_EVENT_CARRIES_AMOUNT).sort()).toEqual([...PAYMENT_INTENT_EVENTS].sort())
    // The three, named. A count alone would pass for any three, and which three it is decides whether a
    // capture can be folded at all.
    const carrying = PAYMENT_INTENT_EVENTS.filter((event) => INTENT_EVENT_CARRIES_AMOUNT[event])
    expect([...carrying].sort()).toEqual(['authorised', 'captured', 'refunded'])
  })

  it("lets a transaction row carry fils for exactly the events that carry an amount", () => {
    // 0106 stores one row per event and its CHECK is three-way: strictly positive for the three money
    // events, exactly zero for the other three. `transactionAmountIsLegal` derives that from
    // INTENT_EVENT_CARRIES_AMOUNT rather than from its own list, and this is what holds the derivation to
    // the table — a row carrying a figure for an event that moves nothing reads as a partial release, and a
    // zero-fils capture reads as a settled movement for nothing.
    let checked = 0
    for (const event of PAYMENT_INTENT_EVENTS) {
      const carries = INTENT_EVENT_CARRIES_AMOUNT[event]
      expect(transactionAmountIsLegal(event, 1), `${event} with 1 fils`).toBe(carries)
      expect(transactionAmountIsLegal(event, 0), `${event} with 0 fils`).toBe(!carries)
      checked += 1
    }
    expect(checked, 'no event was checked, so this case measured nothing').toBe(6)
    // The control on the loop: both answers really do appear, so the two assertions above cannot both be
    // passing because every event happens to fall on the same side.
    expect(PAYMENT_INTENT_EVENTS.filter((e) => transactionAmountIsLegal(e, 1)).length).toBe(3)
    expect(PAYMENT_INTENT_EVENTS.filter((e) => transactionAmountIsLegal(e, 0)).length).toBe(3)
  })
})
