/**
 * What is refundable, and why a refund is not a negative payment (Y-PAY-08).
 *
 * ## A refund is its own document, with its own direction
 *
 * The cheap implementation of a refund is a payment of minus the amount. It balances, it reconciles, and
 * it is wrong in four places at once: `payment.amount_fils` is `fils_nonneg` so the row could not be
 * written at all; the outstanding figure every screen reads would move the wrong way; a cash-up would
 * count a refund as a collection of a negative amount rather than as money leaving the drawer; and the
 * customer's copy of the invoice would say a different thing from the ledger.
 *
 * So a refund is a `refund` row naming a `credit_note` (migration 0068, mandatory from the day the table
 * existed) and a DATED REVERSAL in the journal (ADR 0017). Nothing is edited. This module is the
 * arithmetic that says how much may go back, and the one thing it has to get right is the CAP.
 *
 * ## Why the cap is three figures and not two
 *
 * Y-PAY-06 already caps a deposit refund at the balance held, and it records why: an uncapped subtraction
 * returns a NEGATIVE refund the day a fee exceeds a deposit, which posts as money arriving from a
 * cancellation. The same mistake has a second shape here, and it is the one a chargeback introduces.
 *
 * `payment_intent` carries `captured_fils` and `refunded_fils` and a CHECK that the second does not exceed
 * the first. That check is satisfied by an intent whose money has ALREADY been taken back by the acquirer:
 * AED 100 captured, AED 100 charged back, and AED 100 is still "refundable" by that arithmetic — so the
 * business refunds money it no longer has and the figure reconciles perfectly at both ends. What remains
 * refundable is therefore `captured - refunded - chargedBack`, and {@link refundableFils} is the one place
 * that subtraction is written.
 *
 * **And the cap is a DATABASE refusal as well, not a screen's validation.** `ZY433` in migration 0135
 * states the same identity over the rows, because a screen's validation is a request that the caller be
 * polite and a trigger is a refusal. The two statements are held equal by
 * `packages/fixtures/src/chargeback.itest.ts`, which is the only package allowed to import both.
 */
import { AppError } from '@berelax/shared'
import type { Fils } from '../money.ts'
import { filsFrom } from '../money.ts'

/**
 * The intent states from which money can be given back.
 *
 * `captured` alone. An authorisation is a reservation and not money, so there is nothing to return from
 * `authorised`; `voided` and `failed` are states in which no money ever moved. Stated as a value rather
 * than as a condition in a function body so the set is readable and a sixth state added to ADR 0056's
 * lifecycle cannot be silently admitted.
 */
export const REFUNDABLE_INTENT_STATES = ['captured'] as const
export type RefundableIntentState = (typeof REFUNDABLE_INTENT_STATES)[number]

/** Every figure the cap is computed from. One object, so a caller cannot pass two of the three. */
export interface RefundablePosition {
  /** What the gateway has actually taken. */
  readonly capturedFils: number
  /** What has already gone back, by this build's own hand. */
  readonly refundedFils: number
  /**
   * What a third party has taken back. NET of won disputes.
   *
   * A chargeback that the business WINS is unwound to net zero, so the money is the business's again and
   * is refundable again. A chargeback still open, or lost, is money that has left — and refunding it would
   * be refunding money the business does not have.
   */
  readonly chargedBackFils: number
}

/**
 * The state of the intent, plus its figures. What {@link assertRefundPermitted} judges.
 *
 * `RefundableRequest` and not `RefundRequest`, which is the GATEWAY port's type one module along
 * (`port.ts`): that one is what a gateway is asked to do and this one is what the business is allowed to
 * ask. Two names because they are two things, and the barrel exports both.
 */
export interface RefundableRequest extends RefundablePosition {
  readonly intentRef: string
  /** From ADR 0056's exhaustive lifecycle. A string, because an unknown state must be refusable. */
  readonly state: string
  readonly requestedFils: number
}

/** The refund asks for more than remains. */
export class RefundExceedsRefundable extends AppError {
  readonly refundableFils: number
  readonly requestedFils: number
  constructor(intentRef: string, position: RefundablePosition, requestedFils: number) {
    const remaining = position.capturedFils - position.refundedFils - position.chargedBackFils
    super(
      'validation',
      `RefundExceedsRefundable: intent "${intentRef}" captured ${position.capturedFils} fils, has ` +
        `already refunded ${position.refundedFils} and has ${position.chargedBackFils} charged back, so ` +
        `${remaining} fils remain refundable and ${requestedFils} was asked for. The subtraction is ` +
        'capped here and refused in the database (ZY433) because an uncapped one returns a NEGATIVE ' +
        'refund, which posts as money ARRIVING from a refund — and a chargeback is money that has ' +
        'already left, so an intent whose capture has been taken back has nothing left to give back.',
      { details: { intentRef, ...position, requestedFils } },
    )
    this.refundableFils = remaining
    this.requestedFils = requestedFils
  }
}

/** The intent is in a state from which no money can be returned. */
export class RefundOfAnUncapturedIntent extends AppError {
  constructor(intentRef: string, state: string) {
    super(
      'conflict',
      `RefundOfAnUncapturedIntent: intent "${intentRef}" is "${state}" and only a captured intent can be ` +
        'refunded. An authorisation is a RESERVATION and not money — releasing one is a void and not a ' +
        'refund, and it produces no credit note because nothing was ever invoiced as paid. A refund ' +
        'against a state in which no money moved would be money leaving the business with nothing on ' +
        'the other side of the entry.',
      { details: { intentRef, state } },
    )
  }
}

/** A refund of zero or less. Not a refund, and not a no-op either. */
export class RefundIsNotAFigure extends AppError {
  constructor(intentRef: string, requestedFils: number) {
    super(
      'validation',
      `RefundIsNotAFigure: ${requestedFils} fils is not a refund of intent "${intentRef}". Money is ` +
        'integer fils (ADR 0007), and a refund of zero or less is not a smaller refund — a negative one ' +
        'is a COLLECTION wearing a refund’s document, which is the exact shape "a refund is not a ' +
        'negative payment" exists to refuse.',
      { details: { intentRef, requestedFils } },
    )
  }
}

/**
 * What remains refundable. **Never negative, and the clamp is deliberate rather than defensive.**
 *
 * The three figures come from different places — two columns on the intent and a sum over the chargeback
 * rows — so they can disagree in a database somebody has repaired by hand. Returning a negative here
 * would make `requestedFils <= refundable` true for no request at all, which is the right answer, but it
 * would also be published to a screen as "AED -20 refundable". Clamped at nought, so an inconsistent
 * position reads as "nothing may go back" rather than as a figure.
 */
export function refundableFils(position: RefundablePosition): Fils {
  const remaining = position.capturedFils - position.refundedFils - position.chargedBackFils
  return filsFrom(remaining > 0 ? remaining : 0)
}

/**
 * Refuses a refund that cannot be made. The three acceptance refusals, in the order a caller meets them.
 *
 * **Not `assertRefundable`, which already exists in `state.ts` and does a NARROWER job.** That one holds a
 * refund to `captured - refunded` over an intent's own amounts, and this one adds the dimension a
 * chargeback introduces. Two functions and not one, because the narrow one is what the gateway port's
 * caller needs before it asks for a refund, and this one is what the LEDGER needs before it posts one —
 * and the second cannot live in `state.ts`, which knows nothing about disputes.
 *
 * The figure is checked FIRST, then the state, then the cap. That order is the honest one here and the
 * reverse of Y-PAY-07's, because these three refusals are all reachable today: there is no provisional
 * policy to sit behind. What the order buys is the message a caller shows somebody — "that is not an
 * amount" before "that intent cannot be refunded" before "there is only this much left".
 */
export function assertRefundPermitted(request: RefundableRequest): void {
  const { intentRef, state, requestedFils } = request

  if (!Number.isInteger(requestedFils) || requestedFils <= 0) {
    throw new RefundIsNotAFigure(intentRef, requestedFils)
  }

  if (!(REFUNDABLE_INTENT_STATES as readonly string[]).includes(state)) {
    throw new RefundOfAnUncapturedIntent(intentRef, state)
  }

  const remaining = refundableFils(request)
  if (requestedFils > remaining) {
    throw new RefundExceedsRefundable(intentRef, request, requestedFils)
  }
}

/** Whether a refund of this size could be made, without throwing. For a screen that greys a button. */
export function isRefundPermitted(request: RefundableRequest): boolean {
  try {
    assertRefundPermitted(request)
    return true
  } catch {
    return false
  }
}

/**
 * What a partial refund of one invoice line produces. **Two documents and no edit.**
 *
 * A VALUE and not a pair of writes, so the one claim that matters is assertable without a database: a
 * refund yields a credit note AND a dated reversal, and the reversal's date is the business day the money
 * went back rather than the day the invoice was issued. A reversal dated back to the sale would move
 * revenue out of a period that may already be closed, which is ADR 0017's reason for a dated reversal
 * rather than an edit, and `period_lock` would refuse it anyway — late, and from the wrong layer.
 */
export interface PartialRefundPlan {
  readonly intentRef: string
  /** The invoice the credit note corrects. */
  readonly invoiceId: string
  /** The one line this refund is against. A partial refund names a LINE, not a document. */
  readonly invoiceLineNo: number
  readonly refundFils: Fils
  /** What is left after this one. The screen shows it; `ZY433` enforces it. */
  readonly remainingRefundableFils: Fils
  /** The entry the reversal undoes. Named, so the pair is findable from either end. */
  readonly reversesEntryId: string
  /** True always, and stated as a field because the acceptance line is about the PAIR existing. */
  readonly producesCreditNote: true
  /** True always, for the same reason. A refund that reversed nothing would be an edit. */
  readonly producesDatedReversal: true
}

/**
 * The plan for a partial refund of one line, or a refusal.
 *
 * It computes nothing about VAT, and that is ADR 0007's rule rather than an omission: the credit note's
 * net and VAT come from `assertReversalMatches` in `issue-credit-note.ts`, which holds a note's figures to
 * the lines it corrects. A second derivation of the split here would be a second answer to how much VAT
 * the business owes back.
 */
export function partialRefundPlan(input: {
  readonly request: RefundableRequest
  readonly invoiceId: string
  readonly invoiceLineNo: number
  readonly reversesEntryId: string
}): PartialRefundPlan {
  assertRefundPermitted(input.request)
  const after = refundableFils({
    capturedFils: input.request.capturedFils,
    refundedFils: input.request.refundedFils + input.request.requestedFils,
    chargedBackFils: input.request.chargedBackFils,
  })
  return Object.freeze({
    intentRef: input.request.intentRef,
    invoiceId: input.invoiceId,
    invoiceLineNo: input.invoiceLineNo,
    refundFils: filsFrom(input.request.requestedFils),
    remainingRefundableFils: after,
    reversesEntryId: input.reversesEntryId,
    producesCreditNote: true as const,
    producesDatedReversal: true as const,
  })
}
