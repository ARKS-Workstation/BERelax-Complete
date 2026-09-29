import { AppError } from '@berelax/shared'
import type { TenderKind } from '../checkout/posting.ts'
import type { Money } from '../money.ts'
import { filsFrom } from '../money.ts'

/**
 * The argument refusals every adapter owes, as pure functions rather than as a habit.
 *
 * Three checks, and they are here rather than repeated inside each adapter for one reason: the conformance
 * suite demands them of every adapter including the real one, and an adapter author who has to write them
 * from scratch writes two of the three. The suite's saboteur fixture is what keeps them from going vacuous —
 * it deliberately does NOT call them, so each rule has been seen to fail.
 *
 * What is deliberately not here is anything about state or amounts against a balance. Those differ per
 * adapter and are each implemented separately on purpose: a shared invariant kernel would mean the
 * conformance suite tested one implementation twice and reported it as two.
 */

/** Raised when an amount that reached the port is not an integer number of fils. */
export class GatewayAmountNotIntegerFils extends AppError {
  constructor(label: string, amount: Money, cause: unknown) {
    super(
      'validation',
      `GatewayAmountNotIntegerFils: ${label} is ${String(amount.fils)} ${amount.currency}, which is not ` +
        'an integer number of fils. Money on this port is integer fils in both directions (ADR 0007); a ' +
        'fractional amount here has come through a cast, and rounding it would move real money.',
      { details: { label, fils: amount.fils, currency: amount.currency }, cause },
    )
    this.name = 'GatewayAmountNotIntegerFils'
  }
}

/** Raised when an authorisation carries no document reference. */
export class GatewayReferenceMissing extends AppError {
  constructor() {
    super(
      'validation',
      'GatewayReferenceMissing: an authorisation carries no reference. It is the only thing tying the ' +
        'movement to an invoice or a booking, so a blank one produces a payment nobody can reconcile — ' +
        'and blank is not the same as absent: an empty string reads as a reference that was not captured.',
    )
    this.name = 'GatewayReferenceMissing'
  }
}

/** Raised when a gateway is asked for an instrument it does not declare. */
export class GatewayDoesNotServeInstrument extends AppError {
  constructor(gateway: string, instrument: string, serves: readonly TenderKind[]) {
    super(
      'validation',
      `GatewayDoesNotServeInstrument: "${gateway}" takes ${serves.join(', ')}, not "${instrument}". ` +
        'Every tender kind is served by exactly one gateway, and the registry is what answers which — ' +
        'a caller that guessed would send an online card to the till.',
      { details: { gateway, instrument, serves } },
    )
    this.name = 'GatewayDoesNotServeInstrument'
  }
}

/**
 * Raised when an idempotency key has already answered for a DIFFERENT intent.
 *
 * An idempotency key identifies one CALL. Every adapter remembers which intent each key answered for, so a
 * retry returns the first answer and moves no money twice — and the hazard that makes this a refusal rather
 * than a comment is what that lookup returns when a key is reused across intents: the REMEMBERED intent,
 * whose snapshot the caller then reads as the answer for the one it asked about. A capture against invoice A
 * would report success carrying invoice B's figures, and both documents would reconcile — separately,
 * wrongly, and with nothing anywhere saying a key had been reused.
 *
 * Y-PAY-02 makes key uniqueness structural, with a unique constraint on the public surface. This is the
 * adapter-side layer, and it exists because a port that trusted its caller here would fail silently rather
 * than loudly the first time one did not.
 */
export class IdempotencyKeyReusedAcrossIntents extends AppError {
  constructor(gateway: string, key: string, remembered: string, requested: string) {
    super(
      'conflict',
      `IdempotencyKeyReusedAcrossIntents: on "${gateway}" the key ${JSON.stringify(key)} already answered ` +
        `for intent ${remembered} and has now been offered for ${requested}. A key identifies one call; ` +
        "answering with the remembered intent would report one document's figures as another's.",
      { details: { gateway, key, remembered, requested } },
    )
    this.name = 'IdempotencyKeyReusedAcrossIntents'
  }
}

/**
 * Raised when a gateway declaring `supportsPartialCapture: false` is asked to capture a different amount.
 *
 * In core and not in an adapter, because the refusal is the PORT's: a declared `false` capability is a
 * refusal the conformance suite demands, and an adapter that wrote its own would be free to write a
 * plausible one that no consumer could match on. The reason is the same for any such adapter — a figure
 * other than the one authorised is an amount nobody agreed to.
 */
export class PartialCaptureNotAvailable extends AppError {
  constructor(gateway: string, requestedFils: number, authorisedFils: number) {
    super(
      'validation',
      `PartialCaptureNotAvailable: "${gateway}" declares that it cannot capture part of an authorisation, ` +
        `and ${requestedFils} fils was asked against ${authorisedFils} authorised. There is no reservation ` +
        'to draw down, so a different figure is a mis-key — authorise the amount you mean to take.',
      { details: { gateway, requestedFils, authorisedFils } },
    )
    this.name = 'PartialCaptureNotAvailable'
  }
}

/** Raised when a gateway declaring `supportsVoid: false` is asked to release an authorisation. */
export class VoidNotAvailable extends AppError {
  constructor(gateway: string, gatewayIntentId: string) {
    super(
      'validation',
      `VoidNotAvailable: "${gateway}" declares that it cannot release an authorisation, and ` +
        `${gatewayIntentId} was asked to be voided. Before the money is taken there is nothing to ` +
        'release; after it is taken the correction is a refund against a credit note, which is a dated ' +
        'reversal and not a void.',
      { details: { gateway, gatewayIntentId } },
    )
    this.name = 'VoidNotAvailable'
  }
}

/**
 * Refuses a non-integer or out-of-range amount.
 *
 * Delegates to `filsFrom`, which is the one place the integer rule lives, and re-throws as a payments-named
 * error so a caller can tell "the gateway was handed a bad amount" from "a price calculation went wrong
 * three layers up". The original is the `cause`, so nothing is lost.
 */
export function assertIntegerFilsAmount(amount: Money, label: string): void {
  try {
    filsFrom(amount.fils)
  } catch (error) {
    throw new GatewayAmountNotIntegerFils(label, amount, error)
  }
}

export function assertReferencePresent(reference: string): void {
  if (reference.trim().length === 0) throw new GatewayReferenceMissing()
}

export function assertServesInstrument(
  gateway: string,
  serves: readonly TenderKind[],
  instrument: TenderKind,
): void {
  if (!serves.includes(instrument)) {
    throw new GatewayDoesNotServeInstrument(gateway, instrument, serves)
  }
}
