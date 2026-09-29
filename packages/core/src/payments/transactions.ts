import { AppError } from '@berelax/shared'
import type { Money } from '../money.ts'
import { add, subtract, ZERO_AED } from '../money.ts'
import type { Instant } from '../time.ts'
import type { PaymentIntentAmounts, PaymentIntentEvent, PaymentIntentEventType } from './state.ts'
import { INTENT_EVENT_CARRIES_AMOUNT, reduceIntent } from './state.ts'

/**
 * The append-only rows an intent's figures are derived FROM, as a pure projection of its events.
 *
 * `state.ts` folds a set of gateway events into one answer. This module says what that fold leaves behind:
 * one durable row per event, which is what `payment_intent_transaction` in migration 0106 holds. The reason
 * the projection is here rather than assembled inside the repository is that the acceptance line — *"the
 * intent's derived balance equals the sum of its append-only transaction rows"* — is a claim about TWO
 * derivations agreeing. Two derivations that share no code cannot be made to agree by accident, and one
 * written inside `packages/db` could only ever be checked against a database.
 *
 * So: {@link intentTransactions} turns events into rows, {@link sumIntentTransactions} turns rows back into
 * figures, and `transactions.property.test.ts` asserts the round trip equals {@link reduceIntent}'s own
 * amounts over thousands of random sequences. The database then asserts the same equality over the STORED
 * rows at COMMIT (ZY163), so a caller cannot write an intent header that disagrees with its own rows.
 *
 * ## Why there is a row for every event, including the three that move no money
 *
 * The first version of this module wrote rows only for movements — authorisation, capture, refund, void —
 * and it could not hold the rule that matters. 0106's ZY162 is *"an intent's state moves only with a NEW
 * transaction row of its own"*, which is what stops a browser's claim of success from moving an intent, and
 * `action_required` and `authorisation_failed` both move the state while moving nothing. With a
 * movements-only table those two transitions had no row to name, so the rule needed an exemption — and an
 * exemption in that rule is the hole the rule exists to close. Worse, the exemption would have been a SECOND
 * copy, in plpgsql, of which events move money: exactly the two-homes-for-one-fact defect ADR 0043 is about.
 *
 * So there is one row per applied event and the three non-movement kinds carry zero fils. The table is still
 * the transaction ledger the acceptance line names — every fils that ever moved is a row in it, and the
 * balance is its sum — and "this event moved nothing" is recorded rather than inferred from an absence.
 *
 * ## Why the row's kind IS the event type
 *
 * A second vocabulary (`'authorisation' | 'capture' | …`) was written first and deleted: it was a bijection
 * with `PAYMENT_INTENT_EVENTS` and therefore a map with nothing in it but a rename, which is one more thing
 * to drift the day Y-PAY-08 adds the dispute event. 0068's argument for reusing `tender_type` rather than
 * inventing a `PaymentMethod` enum is the same argument: reuse a word when it means the same thing. The
 * database mirrors this enum in a CHECK exactly as `payment_intent_state_known` mirrors
 * `PAYMENT_INTENT_STATES`, and `packages/fixtures/src/payment-intent.itest.ts` holds both mirrors equal to
 * the enums in BOTH directions, read out of the PostgreSQL catalogue.
 *
 * ## Why the sum of authorisations is a maximum and not a total
 *
 * Every other figure accumulates: two captures of AED 100 captured AED 200. An authorisation does not. A
 * gateway that increases a reservation reports the NEW TOTAL rather than the increment — which is why
 * `reduceIntent` takes the largest `authorised` amount it has seen — so adding two authorisation rows would
 * double the ceiling every capture is checked against. That is the one arithmetic mistake here that makes an
 * over-capture look legal, and it is why this module exports a named fold rather than leaving a caller to
 * write `rows.reduce(add)` and be right three times out of four.
 */

/** One append-only row: which event, how much it moved, and when the gateway says it happened. */
export interface PaymentIntentTransaction {
  /**
   * The gateway event this row is the record of, and the row's identity. What makes writing it twice
   * impossible rather than unlikely: 0106 carries `unique (payment_intent_id, gateway_event_id)`.
   */
  readonly gatewayEventId: string
  /** The event type, which is the row's kind. See the module note on why there is no second vocabulary. */
  readonly eventType: PaymentIntentEventType
  /** Integer fils. Zero for exactly the events {@link INTENT_EVENT_CARRIES_AMOUNT} refuses an amount on. */
  readonly amount: Money
  /** The gateway's own instant, carried from the event. Never ours. */
  readonly occurredAt: Instant
}

/** Raised when a row's amount disagrees with what its event type may carry. */
export class TransactionAmountWrongForEvent extends AppError {
  constructor(eventType: PaymentIntentEventType, fils: number, gatewayEventId: string) {
    super(
      'invariant_violated',
      `TransactionAmountWrongForEvent: a "${eventType}" row carries ${fils} fils. An event that moves ` +
        'money must carry more than zero — a zero-fils capture is a capture somebody started and did not ' +
        'fill in, and it would read as a settled movement for nothing — and an event that moves none must ' +
        'carry exactly zero, because a figure there reads as a partial release, which does not exist.',
      { details: { eventType, fils, gatewayEventId } },
    )
    this.name = 'TransactionAmountWrongForEvent'
  }
}

/**
 * Is this amount legal for this event type?
 *
 * Derived from {@link INTENT_EVENT_CARRIES_AMOUNT} rather than from its own list, so the two cannot
 * disagree: an event that is declared to carry an amount must carry a positive one, and one that is not must
 * carry zero. Exported because the same rule is asserted in three places — here, the repository's argument
 * refusal, and 0106's `payment_intent_transaction_amount_matches_kind` CHECK — and two of the three sharing
 * a predicate is one fewer place for it to be written differently.
 */
export function transactionAmountIsLegal(
  eventType: PaymentIntentEventType,
  fils: number,
): boolean {
  return INTENT_EVENT_CARRIES_AMOUNT[eventType] ? fils > 0 : fils === 0
}

export function assertTransactionAmount(row: PaymentIntentTransaction): void {
  if (!transactionAmountIsLegal(row.eventType, row.amount.fils)) {
    throw new TransactionAmountWrongForEvent(row.eventType, row.amount.fils, row.gatewayEventId)
  }
}

/**
 * The append-only rows a set of gateway events leaves behind, in the order the fold applied them.
 *
 * Built from {@link reduceIntent}'s `applied` list rather than from the raw input, and that routing is the
 * point: `applied` is sorted by the gateway's instant and deduplicated by event id, so the rows are a
 * function of the SET of events. A gateway stream is at-least-once — the H02 fake redelivers every event
 * deliberately — and rows built from the raw deliveries would hold both copies of every one. That is not a
 * rounding error; it is double the money, in the table the intent's figures are checked against.
 *
 * It also means the refusals happen first. A sequence the lifecycle does not allow throws out of
 * `reduceIntent` here, so there is no path that produces rows for an intent the fold would have refused.
 */
export function intentTransactions(
  events: readonly PaymentIntentEvent[],
): readonly PaymentIntentTransaction[] {
  const rows: PaymentIntentTransaction[] = []
  for (const event of reduceIntent(events).applied) {
    const row: PaymentIntentTransaction = Object.freeze({
      gatewayEventId: event.eventId,
      eventType: event.type,
      // `?? ZERO_AED` is reachable only for the three events that carry none: `reduceIntent` has already
      // refused an event whose amount disagrees with `INTENT_EVENT_CARRIES_AMOUNT`.
      amount: event.amount ?? ZERO_AED,
      occurredAt: event.occurredAt,
    })
    assertTransactionAmount(row)
    rows.push(row)
  }
  return Object.freeze(rows)
}

/**
 * The intent's figures, derived from its rows alone.
 *
 * The same shape {@link reduceIntent} produces and asserted equal to it in the property suite. `capturable`
 * needs no extra argument: a `voided` row exists exactly when the fold ends in `voided`, because the
 * lifecycle table sends every state that accepts the event to `voided` and lets no event leave it — so "was
 * the reservation released" is a fact the rows carry.
 */
export function sumIntentTransactions(
  rows: readonly PaymentIntentTransaction[],
): PaymentIntentAmounts {
  let authorised = ZERO_AED
  let captured = ZERO_AED
  let refunded = ZERO_AED
  let released = false

  for (const row of rows) {
    assertTransactionAmount(row)
    switch (row.eventType) {
      case 'authorised':
        // The maximum, not the total. See the module note: a reservation increase reports the new total.
        authorised = row.amount.fils > authorised.fils ? row.amount : authorised
        break
      case 'captured':
        captured = add(captured, row.amount)
        break
      case 'refunded':
        refunded = add(refunded, row.amount)
        break
      case 'voided':
        released = true
        break
      case 'action_required':
      case 'authorisation_failed':
        break
    }
  }

  return Object.freeze({
    authorised,
    captured,
    refunded,
    // Zero once released, because the reservation is gone. `authorised` stays as it was: it is the record
    // of what WAS reserved, which is the figure a reconciliation against the gateway needs.
    capturable: released ? ZERO_AED : subtract(authorised, captured),
    refundable: subtract(captured, refunded),
  })
}

/**
 * The three figures a caller stores on the intent header, as integers.
 *
 * `capturable` and `refundable` are deliberately absent: they are differences of the other three, and a
 * stored difference is a fourth figure that can disagree with the three it is derived from. 0106 stores
 * three columns for that reason and derives the rest in the reader.
 */
export interface StoredIntentFigures {
  readonly authorisedFils: number
  readonly capturedFils: number
  readonly refundedFils: number
}

/** The header figures for a set of rows. What the repository writes and what ZY163 recomputes. */
export function storedFiguresOf(
  rows: readonly PaymentIntentTransaction[],
): StoredIntentFigures {
  const amounts = sumIntentTransactions(rows)
  return Object.freeze({
    authorisedFils: amounts.authorised.fils,
    capturedFils: amounts.captured.fils,
    refundedFils: amounts.refunded.fils,
  })
}
