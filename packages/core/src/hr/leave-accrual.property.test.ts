import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type LocalDate, localDate } from '../time.ts'
import {
  applyLeaveLedgerEvent,
  emptyLeaveLedger,
  type LeaveLedger,
  type LeaveLedgerEvent,
  type LeaveLedgerStep,
  leaveLedgerProblems,
} from './leave-accrual.ts'

/**
 * The leave ledger's invariants, over randomised sequences of accrual, request, approval and
 * cancellation.
 *
 * Two statements, and both are the unit's acceptance criterion:
 *
 *   1. **The balance never goes negative.** Whatever order the events arrive in, however many requests
 *      overlap, whatever is cancelled and re-requested, `availableHundredths` is at or above zero.
 *   2. **The sum of the movements always equals the balance.** Exactly, in integers. That is what makes
 *      `leave_balance` expressible as a VIEW over `leave_movement` (0066) rather than as a column that
 *      can drift, and it is why nothing in this engine may move a tally without writing the movement
 *      that accounts for it.
 *
 * Two more fall out of the same fold and are checked with them, because their being wrong is how the
 * first two come to hold vacuously: the pending requests must hold exactly `reservedHundredths` and the
 * approved ones exactly `takenHundredths`.
 *
 * ## The checker is proved able to fail, against four plausible implementations
 *
 * A property suite whose checker cannot fail asserts nothing, however many cases it runs. So the same
 * corpus of sequences is replayed through four **mutant reducers**, each of which is a reading somebody
 * would actually write, and each must be caught:
 *
 *   - `mutantNoReservation` moves the balance at APPROVAL instead of at request. That is the obvious
 *     model — a pending request has not been granted, so why would it touch the balance — and it is the
 *     one that lets two requests, each affordable on its own, be approved into an overdraft.
 *   - `mutantAllowsOverdraft` accepts a request larger than the balance. The refusal is the only thing
 *     standing between a leave screen and a negative balance.
 *   - `mutantForgetsToUntake` returns the days when approved leave is cancelled and leaves `taken` where
 *     it was, so the tallies stop adding up while the balance looks right.
 *   - `mutantLosesAMovement` moves the balance on a forfeiture and writes no row for it. Nothing about
 *     the balance looks wrong; it simply can no longer be explained by the ledger.
 *
 * The corpus is taken with a fixed seed rather than generated inside each mutant's assertion, so "the
 * mutant is caught" is a reproducible fact about a known set of sequences instead of a probabilistic one
 * — and the correct reducer is asserted clean over the SAME corpus, which is what makes the four
 * comparisons mean anything.
 *
 * ## Cost
 *
 * The explicit 30-second timeout is not decoration. `vitest.config.ts` declares no `testTimeout`, so the
 * default is 5,000 ms, and this file folds several thousand sequences while three other worktrees are
 * running their own verify on the same four cores. A correctness test that fails on a loaded machine
 * fails with a message about a timeout, which names the wrong thing entirely.
 */

/** Six months to accrue over. A small pool, so a duplicate accrual month is a common case, not a rare one. */
const MONTHS: readonly LocalDate[] = [
  '2027-01-01',
  '2027-02-01',
  '2027-03-01',
  '2027-04-01',
  '2027-05-01',
  '2027-06-01',
].map((value) => localDate(value))

/** Four request handles, so approving, cancelling and re-requesting the same one all happen often. */
const REQUEST_IDS = ['r1', 'r2', 'r3', 'r4'] as const

/**
 * The event arbitrary.
 *
 * Request sizes reach well past a plausible balance on purpose: the interesting sequences are the ones
 * where the refusal is the only thing keeping the balance non-negative, and a generator that only ever
 * asked for affordable leave would never exercise it.
 */
const eventArbitrary: fc.Arbitrary<LeaveLedgerEvent> = fc.oneof(
  fc
    .integer({ min: 0, max: 2000 })
    .map((hundredths): LeaveLedgerEvent => ({ kind: 'opening_balance', hundredths })),
  fc
    .record({
      accrualMonth: fc.constantFrom(...MONTHS),
      hundredths: fc.integer({ min: 0, max: 400 }),
    })
    .map((raw): LeaveLedgerEvent => ({ kind: 'accrual', ...raw })),
  fc
    .integer({ min: 0, max: 1500 })
    .map((hundredths): LeaveLedgerEvent => ({ kind: 'forfeit_carry_over', hundredths })),
  fc
    .record({
      requestId: fc.constantFrom(...REQUEST_IDS),
      hundredths: fc.integer({ min: 0, max: 1500 }),
    })
    .map((raw): LeaveLedgerEvent => ({ kind: 'request', ...raw })),
  fc
    .constantFrom(...REQUEST_IDS)
    .map((requestId): LeaveLedgerEvent => ({ kind: 'approve', requestId })),
  fc
    .constantFrom(...REQUEST_IDS)
    .map((requestId): LeaveLedgerEvent => ({ kind: 'reject', requestId })),
  fc
    .constantFrom(...REQUEST_IDS)
    .map((requestId): LeaveLedgerEvent => ({ kind: 'cancel', requestId })),
)

const sequenceArbitrary = fc.array(eventArbitrary, { minLength: 1, maxLength: 40 })

type Reducer = (ledger: LeaveLedger, event: LeaveLedgerEvent) => LeaveLedgerStep

function replay(reducer: Reducer, events: readonly LeaveLedgerEvent[]): LeaveLedger {
  let ledger = emptyLeaveLedger()
  for (const event of events) ledger = reducer(ledger, event).ledger
  return ledger
}

describe('the leave ledger, over randomised sequences of accrual, request, approval and cancellation', () => {
  // Both cases below carry an explicit 30-second timeout. `vitest.config.ts` declares no `testTimeout`,
  // so the default is 5,000 ms, and each of these folds several thousand sequences while other worktrees
  // run their own verify on the same four cores. Without it a correctness failure arrives as a timeout,
  // which names the wrong thing entirely.
  it('keeps the balance non-negative and equal to the sum of its movements, always', () => {
    fc.assert(
      fc.property(sequenceArbitrary, (events) => {
        const ledger = replay(applyLeaveLedgerEvent, events)
        const problems = leaveLedgerProblems(ledger)
        expect(problems, problems.join('; ')).toEqual([])
        // Stated again here, independently of the checker, so the two acceptance criteria are asserted
        // by this case and not only by a function the mutants below are also testing.
        expect(ledger.availableHundredths).toBeGreaterThanOrEqual(0)
        const summed = ledger.movements.reduce((total, movement) => total + movement.hundredths, 0)
        expect(summed).toBe(ledger.availableHundredths)
        return true
      }),
      { numRuns: 400 },
    )
  }, 30_000)

  it('replays a sequence deterministically, so a disputed balance can be recomputed', () => {
    fc.assert(
      fc.property(sequenceArbitrary, (events) => {
        expect(replay(applyLeaveLedgerEvent, events)).toEqual(replay(applyLeaveLedgerEvent, events))
        return true
      }),
      { numRuns: 200 },
    )
  }, 30_000)
})

describe('the invariant checker is able to fail, against four plausible implementations', () => {
  /** A fixed corpus, so "the mutant is caught" is reproducible rather than probabilistic. */
  const CORPUS = fc.sample(sequenceArbitrary, { numRuns: 300, seed: 20_260_924 })

  /** Sequences whose replay through `reducer` the checker objects to, with the problems it reported. */
  const caught = (reducer: Reducer): readonly string[] =>
    CORPUS.flatMap((events) => leaveLedgerProblems(replay(reducer, events)))

  it('reports nothing over the whole corpus for the shipped reducer', () => {
    // The control the four comparisons below rest on. Without it, a checker that objected to everything
    // would "catch" every mutant and prove nothing.
    expect(caught(applyLeaveLedgerEvent)).toEqual([])
  })

  it('catches a reducer that moves the balance at approval instead of at request', () => {
    // The balance-at-approval model. A pending request leaves `reserved` at zero while the request sits
    // on the ledger holding days, which is exactly how two separately affordable requests come to be
    // approved into an overdraft.
    const mutantNoReservation: Reducer = (ledger, event) => {
      if (event.kind !== 'request') return applyLeaveLedgerEvent(ledger, event)
      return {
        ledger: {
          ...ledger,
          requests: {
            ...ledger.requests,
            [event.requestId]: { status: 'pending', hundredths: event.hundredths },
          },
        },
        movement: null,
        refusal: null,
      }
    }
    expect(caught(mutantNoReservation).join('; ')).toMatch(/pending requests hold/)
  })

  it('catches a reducer that accepts a request larger than the balance', () => {
    const mutantAllowsOverdraft: Reducer = (ledger, event) => {
      if (event.kind !== 'request' || event.requestId in ledger.requests) {
        return applyLeaveLedgerEvent(ledger, event)
      }
      return {
        ledger: {
          ...ledger,
          availableHundredths: ledger.availableHundredths - event.hundredths,
          reservedHundredths: ledger.reservedHundredths + event.hundredths,
          movements: [
            ...ledger.movements,
            { kind: 'reserved', hundredths: -event.hundredths, requestId: event.requestId },
          ],
          requests: {
            ...ledger.requests,
            [event.requestId]: { status: 'pending', hundredths: event.hundredths },
          },
        },
        movement: { kind: 'reserved', hundredths: -event.hundredths, requestId: event.requestId },
        refusal: null,
      }
    }
    expect(caught(mutantAllowsOverdraft).join('; ')).toMatch(/the balance is negative/)
  })

  it('catches a reducer that returns the days on cancellation without untaking them', () => {
    const mutantForgetsToUntake: Reducer = (ledger, event) => {
      const step = applyLeaveLedgerEvent(ledger, event)
      const wasApproved = ledger.requests[event.kind === 'cancel' ? event.requestId : '']?.status
      if (event.kind !== 'cancel' || wasApproved !== 'approved' || step.refusal !== null)
        return step
      return {
        ...step,
        ledger: { ...step.ledger, takenHundredths: ledger.takenHundredths },
      }
    }
    expect(caught(mutantForgetsToUntake).join('; ')).toMatch(/approved requests hold/)
  })

  it('catches a reducer that moves the balance on a forfeiture and writes no row for it', () => {
    const mutantLosesAMovement: Reducer = (ledger, event) => {
      const step = applyLeaveLedgerEvent(ledger, event)
      if (event.kind !== 'forfeit_carry_over' || step.movement === null) return step
      return {
        ...step,
        ledger: { ...step.ledger, movements: ledger.movements },
        movement: null,
      }
    }
    expect(caught(mutantLosesAMovement).join('; ')).toMatch(/the movements sum to/)
  })

  it('catches a movement whose sign does not match its kind', () => {
    // Not a reducer mutant but a row mutant, because this is the shape a repository produces rather than
    // the engine: `leave_movement_sign_matches_kind` is 0066's CHECK, and this is the assertion that the
    // pure side would notice a row that got past it.
    const ledger: LeaveLedger = {
      ...emptyLeaveLedger(),
      availableHundredths: 400,
      movements: [{ kind: 'reserved', hundredths: 400, requestId: 'r1' }],
    }
    expect(leaveLedgerProblems(ledger).join('; ')).toMatch(
      /a reserved movement of 400 should not be positive/,
    )
  })

  it('catches a fractional movement, which is the float this engine has no place for', () => {
    const ledger: LeaveLedger = {
      ...emptyLeaveLedger(),
      availableHundredths: 250.5,
      movements: [{ kind: 'accrual', hundredths: 250.5, accrualMonth: localDate('2027-01-01') }],
    }
    expect(leaveLedgerProblems(ledger).join('; ')).toMatch(/is not whole/)
  })
})
