import type {
  DepositApplication,
  DepositPolicy,
  DepositRedemptionTarget,
  TenderLine,
} from '@berelax/core'
import {
  applyDepositToInvoice,
  assertDepositRedeemable,
  DEPOSIT_TENDER_KIND,
  depositPolicy,
  depositReleaseTender,
} from '@berelax/core'

/**
 * What the checkout does with the deposit an appointment is already holding (Y-PAY-06).
 *
 * No Next, no connection and no clock, which is the split every admin surface in this build takes and the
 * reason `handler.ts` beside this file gives: the things worth asserting are the figures and the refusals,
 * and both are decided from a balance and a target that a test can construct. Reading the balance is
 * `readDepositBalance` in `@berelax/db`, reading the policy is `readDepositPolicy`, and writing the
 * movement is `appendDepositMovement` — all three belong to whatever route finalises the sale.
 *
 * ## Why this is a decision and not a write
 *
 * Nothing in this build finalises a checkout through a route yet. `finaliseCheckout` is driven from
 * `packages/fixtures`, the `/checkout` screen beside this file is Y-PAY-03's hosted-fields AUTHORISATION
 * surface rather than the till, and M-TILL-07's NOTE records that a partial tender at checkout is still
 * refused. So the honest deliverable here is the decision — what is still due, what tender the release
 * must be presented as, and which targets are refused — handed to the transaction whenever one arrives.
 * `build/manifest.yaml` carries the NOTE saying so and names the unit the wiring is deferred to.
 *
 * What this module deliberately does NOT do is compute a second answer to how much of the document is
 * paid. The release is a {@link TenderLine} of kind `deposit_on_account`, so it reaches
 * `finaliseCheckout` through the same path as cash: the `payment` row, the ZT001 overpayment ceiling and
 * `invoice_payable_fils` all see it, and the document's outstanding figure is right by construction
 * rather than by a second subtraction somebody has to remember.
 */

/** What the till has to know about an appointment's deposit before it can take the rest. */
export interface DepositAtCheckout {
  /** Nothing is held, so the document is settled the ordinary way and no release is written. */
  readonly holding: boolean
  /** `invoiceGross - applied`: what the customer still hands over, in integer fils. */
  readonly amountDueFils: number
  /** What the release settles. Zero when nothing is held. */
  readonly appliedFils: number
  /** What stays on `2045` because the deposit exceeded the document. */
  readonly remainingHeldFils: number
  /**
   * The tender the checkout must present for the applied part, or `null`.
   *
   * `null` rather than a zero tender: `checkoutPosting` refuses a non-positive tender by name, and a
   * zero-fils release would write a `payment` row for a settlement that settled nothing.
   */
  readonly release: TenderLine | null
  /** The whole application, for a caller writing the `deposit_movement` row. */
  readonly application: DepositApplication
}

export interface ApplyDepositInput {
  /** The appointment the deposit was taken for. */
  readonly appointmentId: string
  /**
   * The document and the appointments it bills, from `invoice_appointment`.
   *
   * A {@link DepositRedemptionTarget} and not a bare invoice id, so the two refusals are reachable
   * without a cast: a document that bills somebody else's appointment and a package sale are both values
   * of this type, and `assertDepositRedeemable` is total over it.
   */
  readonly target: DepositRedemptionTarget
  /** The document's VAT-inclusive gross, which is the authoritative figure (ADR 0007). */
  readonly invoiceGrossFils: number
  /** `appointment_deposit_balance.held_fils`, or 0 when the view holds no row for the appointment. */
  readonly heldFils: number
  /** The reference the `payment` row carries — the movement being discharged. */
  readonly reference: string
}

/**
 * What the checkout still has to collect, and the release that settles the rest.
 *
 * The scope is checked BEFORE the arithmetic, deliberately. A caller that offered a deposit against the
 * wrong document would otherwise get a plausible `amountDueFils` back and only be refused by `ZY305` at
 * COMMIT — by which time the operator has been shown a figure, the statutory invoice number has been
 * allocated against it, and the refusal arrives as a rolled-back sale rather than as a question.
 *
 * `heldFils` of zero is NOT a refusal. An appointment with no deposit is the ordinary case — deposits are
 * disabled (`Y9-deposits`), so today it is the only case — and the answer is "the whole gross is due and
 * there is no release to write".
 */
export function applyDepositAtCheckout(input: ApplyDepositInput): DepositAtCheckout {
  assertDepositRedeemable(input.appointmentId, input.target)
  const application = applyDepositToInvoice({
    invoiceGrossFils: input.invoiceGrossFils,
    heldFils: input.heldFils,
  })
  return Object.freeze({
    holding: input.heldFils > 0,
    amountDueFils: application.amountDueFils,
    appliedFils: application.appliedFils,
    remainingHeldFils: application.remainingHeldFils,
    release: depositReleaseTender(application, input.reference),
    application,
  })
}

/**
 * Whether the till should offer to take a deposit at all, from the two stored settings.
 *
 * Exported beside the application because the screen needs both answers and they are different questions:
 * this one is about TAKING a deposit on a booking (`payments.deposit_enabled`), and
 * {@link applyDepositAtCheckout} is about releasing one that has already been taken. A deposit taken
 * before the flag was turned off is still the customer's money and must still be releasable — so the
 * release path reads no setting at all, and that is the decision rather than an omission.
 */
export function depositOfferedAtBooking(stored: {
  readonly enabled: unknown
  readonly percentBp: unknown
}): DepositPolicy {
  return depositPolicy(stored)
}

/** The tender kind a release is recorded as, re-exported so the screen states one string. */
export { DEPOSIT_TENDER_KIND }
