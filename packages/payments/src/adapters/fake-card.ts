import type {
  AuthoriseRequest,
  CaptureRequest,
  GatewayEventCursor,
  GatewayEventDelivery,
  GatewayIntentId,
  GatewayIntentSnapshot,
  GatewayName,
  GatewayOperation,
  GatewayRefundReceipt,
  IdempotencyKey,
  MinorUnitConvention,
  Money,
  PaymentGateway,
  PaymentGatewayDependencies,
  PaymentIntentEventType,
  PaymentIntentState,
  RefundRequest,
  TenderKind,
  VoidRequest,
} from '@berelax/core'
import {
  assertIntegerFilsAmount,
  assertReferencePresent,
  assertServesInstrument,
  fromGatewayMinor,
  IdempotencyKeyReusedAcrossIntents,
  nextIntentState,
  tenderTypeOf,
  toDecimalString,
  toGatewayMinor,
} from '@berelax/core'
import type { FailureScript } from '@berelax/providers/failure'
import { failureError } from '@berelax/providers/failure'
import { REFERENCE_MARKERS } from '@berelax/providers/payments'
import { AppError } from '@berelax/shared'

/**
 * The card gateway fake, against the Y-PAY port.
 *
 * H02 built this fake's behaviours and this is the same fake, re-expressed on the port the Y-PAY chain
 * builds against: the steering suffixes are imported from `@berelax/providers` rather than restated, and so
 * is the shared `FailureScript`, so arming a failure in one place still arms it for payments.
 *
 * What it models, and why each one changes the code around it (ADR 0022):
 *
 * **3DS is a round trip the customer can abandon.** A reference ending `-3DS` authorises into
 * `requires_customer_action` with a URL, and nothing moves until {@link FakeCardGateway.completeCustomerAction}
 * is called — which is the fake's stand-in for the customer coming back, and is NOT on the port. Most
 * checkout bugs live in the window where they have not come back.
 *
 * **Webhooks replay.** Every event is queued twice. A consumer that has only ever seen one copy of an event
 * has an idempotency bug it has not met yet, so the fake replays deliberately rather than as a rare accident.
 *
 * **Partial captures and partial refunds accumulate**, and each is refused past its ceiling — a spa refunds
 * one treatment out of three far more often than a whole invoice.
 *
 * **It reports minor units in a convention that is not ours**, and this is the one behaviour chosen for the
 * build rather than copied from a real gateway. No gateway has been chosen — the provider, the merchant
 * account and the MCC are all unanswered (OPEN-QUESTIONS `Y7-mcc`), so the real convention is unknown. What
 * IS known is that ADR 0007 requires a foreign convention to be converted **at the edge and nowhere else**,
 * and a build where every adapter happened to speak fils would ship that requirement untested: the
 * conversion functions would have no caller and the conformance rule would pass vacuously. So this fake
 * stores thousandths internally and converts on the way in and out, which makes the edge a real edge. It is
 * a property of a fake and not a claim about any acquirer.
 */

export const FAKE_CARD_GATEWAY = 'fake-card-gateway' as GatewayName

/** Online cards only. Cash and the terminal go through the manual till gateway. */
const SERVES: readonly TenderKind[] = Object.freeze(['card_online'])

/**
 * Thousandths of a dirham. Ten times our fils, so every integer fils figure round-trips exactly and a
 * gateway figure that does not divide by ten is refused rather than rounded.
 */
export const THOUSANDTHS: MinorUnitConvention = Object.freeze({
  label: 'thousandths of an AED (the fake gateway convention)',
  exponent: 3,
})

/**
 * What an authorisation does, decided from the reference's steering suffix.
 *
 * A named outcome and two lookup tables rather than nested ternaries in `authorise`, because the three
 * branches each pick a state, an event and a sentence, and writing that as three parallel conditionals is
 * how one of the three comes to disagree with the others — a declined authorisation that emits
 * `authorisation_failed` and records "authorised" in the summary looks fine in every test that reads only
 * the state.
 */
type AuthorisationOutcome = 'authorised' | 'challenged' | 'declined'

const outcomeFor = (reference: string): AuthorisationOutcome => {
  if (reference.endsWith(REFERENCE_MARKERS.declined)) return 'declined'
  if (reference.endsWith(REFERENCE_MARKERS.requiresAction)) return 'challenged'
  return 'authorised'
}

const AUTHORISE_EVENT: Readonly<Record<AuthorisationOutcome, PaymentIntentEventType>> =
  Object.freeze({
    authorised: 'authorised',
    challenged: 'action_required',
    declined: 'authorisation_failed',
  })

const AUTHORISE_SUMMARY: Readonly<
  Record<AuthorisationOutcome, (amount: string, reference: string) => string>
> = Object.freeze({
  authorised: (amount, reference) => `AED ${amount} authorised for ${reference}`,
  challenged: (amount, reference) => `AED ${amount} for ${reference} awaits a customer challenge`,
  declined: (amount, reference) => `Authorisation of AED ${amount} for ${reference} was declined`,
})

export interface FakeCardGatewayOptions extends PaymentGatewayDependencies {
  /** Shared with every other provider, so one `failNext` arms them all (ADR 0022 rule 2). */
  readonly failures: FailureScript
}

/** The fake's own surface, beyond the port. Not reachable through the registry's `PaymentGateway` type. */
export interface FakeCardGateway extends PaymentGateway {
  /** The customer came back from the challenge. The fake's stand-in for a completed 3DS round trip. */
  completeCustomerAction(gatewayIntentId: GatewayIntentId): void
}

interface CardIntent {
  readonly gatewayIntentId: GatewayIntentId
  readonly reference: string
  /** Held in the gateway's own convention, which is the point: the edge converts, the inside does not. */
  readonly authorisedMinor: number
  capturedMinor: number
  refundedMinor: number
  state: PaymentIntentState
  actionUrl?: string
}

export function createFakeCardGateway(options: FakeCardGatewayOptions): FakeCardGateway {
  const { clock, records, failures } = options
  const intents = new Map<string, CardIntent>()
  const answered = new Map<string, GatewayIntentId>()
  const queue: GatewayEventDelivery[] = []
  let counter = 0
  let eventCounter = 0

  const toFils = (minor: number): Money => fromGatewayMinor(minor, THOUSANDTHS)

  const snapshot = (intent: CardIntent): GatewayIntentSnapshot =>
    Object.freeze({
      gatewayIntentId: intent.gatewayIntentId,
      state: intent.state,
      instrument: 'card_online' as TenderKind,
      postingAccountCode: tenderTypeOf('card_online').account,
      authorised: toFils(intent.authorisedMinor),
      captured: toFils(intent.capturedMinor),
      refunded: toFils(intent.refundedMinor),
      observedAt: clock.now(),
      ...(intent.actionUrl === undefined ? {} : { customerActionUrl: intent.actionUrl }),
    })

  /** Queues an event twice, because every real gateway redelivers. */
  const emit = (intent: CardIntent, type: PaymentIntentEventType, amount?: Money): void => {
    for (const _copy of [0, 1]) {
      eventCounter += 1
      queue.push(
        Object.freeze({
          gatewayIntentId: intent.gatewayIntentId,
          cursor: `evt_${String(eventCounter).padStart(8, '0')}` as GatewayEventCursor,
          event: Object.freeze({
            // The SAME event id on both copies. A replay that carried a new id would be a new event, and
            // the consumer's idempotency — which is keyed on the id — would never be exercised.
            eventId: `evt_${intent.gatewayIntentId}_${type}_${String(intent.capturedMinor)}_${String(intent.refundedMinor)}`,
            type,
            occurredAt: clock.now(),
            ...(amount === undefined ? {} : { amount }),
          }),
        }),
      )
    }
  }

  const write = (args: {
    intent: CardIntent
    operation: GatewayOperation
    amount: Money
    summary: string
    idempotencyKey: IdempotencyKey
    suppressedDuplicate?: boolean
    instrumentTokenPresented?: boolean
  }): void => {
    records.record(
      Object.freeze({
        gateway: FAKE_CARD_GATEWAY,
        operation: args.operation,
        gatewayIntentId: args.intent.gatewayIntentId,
        instrument: 'card_online' as TenderKind,
        postingAccountCode: tenderTypeOf('card_online').account,
        amount: args.amount,
        summary: args.summary,
        occurredAt: clock.now(),
        idempotencyKey: args.idempotencyKey,
        ...(args.suppressedDuplicate === true ? { suppressedDuplicate: true } : {}),
        // Recorded on every call, `true` or `false`, rather than only when present. An absent field would be
        // indistinguishable from an adapter that had stopped reporting it, which is the direction a checkout
        // that stopped forwarding the token would go unnoticed in (Y-PAY-03).
        ...(args.instrumentTokenPresented === undefined
          ? {}
          : { instrumentTokenPresented: args.instrumentTokenPresented }),
      }),
    )
  }

  /**
   * Every call that would reach the network checks the shared script first.
   *
   * No operation argument: the script arms the NEXT call whatever it is, which is ADR 0022's design —
   * `failNext(mode, 2)` arms two calls so a retry path can be tested. A per-operation script would let a
   * test arm a failure that the code under test never reaches and report the retry path as covered.
   */
  const armed = (): void => {
    const mode = failures.take()
    if (mode === undefined) return
    throw failureError(FAKE_CARD_GATEWAY, mode)
  }

  const require_ = (gatewayIntentId: GatewayIntentId): CardIntent => {
    const intent = intents.get(gatewayIntentId)
    if (intent === undefined) {
      throw new AppError('not_found', `No payment intent ${gatewayIntentId}`, {
        details: { gatewayIntentId },
      })
    }
    return intent
  }

  return {
    name: FAKE_CARD_GATEWAY,
    serves: SERVES,
    minorUnits: THOUSANDTHS,
    capabilities: Object.freeze({
      emitsEvents: true,
      supportsPartialCapture: true,
      supportsPartialRefund: true,
      supportsVoid: true,
      hasExternalService: true,
    }),

    async authorise(request: AuthoriseRequest): Promise<GatewayIntentSnapshot> {
      assertServesInstrument(FAKE_CARD_GATEWAY, SERVES, request.instrument)
      assertIntegerFilsAmount(request.amount, 'the amount authorised')
      assertReferencePresent(request.reference)
      armed()

      const seen = answered.get(request.idempotencyKey)
      if (seen !== undefined) {
        const first = require_(seen)
        write({
          intent: first,
          operation: 'authorise',
          amount: toFils(first.authorisedMinor),
          summary: `Duplicate suppressed for ${first.reference}; no second authorisation was attempted`,
          idempotencyKey: request.idempotencyKey,
          suppressedDuplicate: true,
        })
        return snapshot(first)
      }

      counter += 1
      const gatewayIntentId = `pi_fake_${String(counter).padStart(6, '0')}` as GatewayIntentId
      const outcome = outcomeFor(request.reference)

      const intent: CardIntent = {
        gatewayIntentId,
        reference: request.reference,
        authorisedMinor: toGatewayMinor(request.amount, THOUSANDTHS),
        capturedMinor: 0,
        refundedMinor: 0,
        state: nextIntentState('requires_authorisation', AUTHORISE_EVENT[outcome]),
        ...(outcome === 'challenged' ? { actionUrl: `/dev/payments/3ds/${gatewayIntentId}` } : {}),
      }
      intents.set(gatewayIntentId, intent)
      answered.set(request.idempotencyKey, gatewayIntentId)

      // Only a clean authorisation carries an amount: `action_required` and `authorisation_failed` move no
      // money, and the port refuses an amount on an event that does not (`INTENT_EVENT_CARRIES_AMOUNT`).
      emit(intent, AUTHORISE_EVENT[outcome], outcome === 'authorised' ? request.amount : undefined)

      write({
        intent,
        operation: 'authorise',
        amount: request.amount,
        summary: AUTHORISE_SUMMARY[outcome](toDecimalString(request.amount), request.reference),
        idempotencyKey: request.idempotencyKey,
        instrumentTokenPresented: request.instrumentToken !== undefined,
      })
      return snapshot(intent)
    },

    async capture(request: CaptureRequest): Promise<GatewayIntentSnapshot> {
      assertIntegerFilsAmount(request.amount, 'the amount captured')
      armed()
      const intent = require_(request.gatewayIntentId)

      const seen = answered.get(request.idempotencyKey)
      if (seen !== undefined && seen !== request.gatewayIntentId) {
        throw new IdempotencyKeyReusedAcrossIntents(
          FAKE_CARD_GATEWAY,
          request.idempotencyKey,
          seen,
          request.gatewayIntentId,
        )
      }
      if (seen !== undefined) {
        write({
          intent,
          operation: 'capture',
          amount: request.amount,
          summary: `Duplicate capture suppressed on ${intent.gatewayIntentId}; nothing was taken twice`,
          idempotencyKey: request.idempotencyKey,
          suppressedDuplicate: true,
        })
        return snapshot(require_(seen))
      }

      const requestedMinor = toGatewayMinor(request.amount, THOUSANDTHS)
      if (intent.capturedMinor + requestedMinor > intent.authorisedMinor) {
        throw new AppError(
          'validation',
          `A capture of ${request.amount.fils} fils would take ` +
            `${toDecimalString(toFils(intent.capturedMinor + requestedMinor))} against ` +
            `${toDecimalString(toFils(intent.authorisedMinor))} authorised on ${intent.gatewayIntentId}. ` +
            'A gateway cannot take more than it reserved.',
          {
            details: {
              gatewayIntentId: intent.gatewayIntentId,
              requestedFils: request.amount.fils,
              capturedFils: toFils(intent.capturedMinor).fils,
              authorisedFils: toFils(intent.authorisedMinor).fils,
            },
          },
        )
      }

      intent.state = nextIntentState(intent.state, 'captured')
      intent.capturedMinor += requestedMinor
      answered.set(request.idempotencyKey, intent.gatewayIntentId)
      emit(intent, 'captured', request.amount)

      write({
        intent,
        operation: 'capture',
        amount: request.amount,
        summary: `AED ${toDecimalString(request.amount)} captured on ${intent.gatewayIntentId} for ${intent.reference}`,
        idempotencyKey: request.idempotencyKey,
      })
      return snapshot(intent)
    },

    async refund(request: RefundRequest): Promise<GatewayRefundReceipt> {
      assertIntegerFilsAmount(request.amount, 'the amount refunded')
      armed()
      const intent = require_(request.gatewayIntentId)

      const seen = answered.get(request.idempotencyKey)
      if (seen !== undefined && seen !== request.gatewayIntentId) {
        throw new IdempotencyKeyReusedAcrossIntents(
          FAKE_CARD_GATEWAY,
          request.idempotencyKey,
          seen,
          request.gatewayIntentId,
        )
      }
      if (seen !== undefined) {
        write({
          intent,
          operation: 'refund',
          amount: request.amount,
          summary: `Duplicate refund suppressed on ${intent.gatewayIntentId}; the money went back once`,
          idempotencyKey: request.idempotencyKey,
          suppressedDuplicate: true,
        })
        return Object.freeze({
          refundId: `re_fake_${request.idempotencyKey}`,
          gatewayIntentId: intent.gatewayIntentId,
          amount: request.amount,
          acknowledgedAt: clock.now(),
        })
      }

      const requestedMinor = toGatewayMinor(request.amount, THOUSANDTHS)
      if (intent.refundedMinor + requestedMinor > intent.capturedMinor) {
        throw new AppError(
          'validation',
          `A refund of ${request.amount.fils} fils exceeds the ` +
            `${toDecimalString(toFils(intent.capturedMinor - intent.refundedMinor))} still refundable on ` +
            `${intent.gatewayIntentId}. Money that was never captured cannot be given back.`,
          {
            details: {
              gatewayIntentId: intent.gatewayIntentId,
              requestedFils: request.amount.fils,
              refundableFils: toFils(intent.capturedMinor - intent.refundedMinor).fils,
            },
          },
        )
      }

      intent.state = nextIntentState(intent.state, 'refunded')
      intent.refundedMinor += requestedMinor
      counter += 1
      answered.set(request.idempotencyKey, intent.gatewayIntentId)
      emit(intent, 'refunded', request.amount)

      write({
        intent,
        operation: 'refund',
        amount: request.amount,
        summary:
          `AED ${toDecimalString(request.amount)} refunded on ${intent.gatewayIntentId} ` +
          `against ${intent.reference} — ${request.reason}`,
        idempotencyKey: request.idempotencyKey,
      })
      return Object.freeze({
        refundId: `re_fake_${String(counter).padStart(6, '0')}`,
        gatewayIntentId: intent.gatewayIntentId,
        amount: request.amount,
        acknowledgedAt: clock.now(),
      })
    },

    async voidAuthorisation(request: VoidRequest): Promise<GatewayIntentSnapshot> {
      armed()
      const intent = require_(request.gatewayIntentId)

      const seen = answered.get(request.idempotencyKey)
      if (seen !== undefined && seen !== request.gatewayIntentId) {
        throw new IdempotencyKeyReusedAcrossIntents(
          FAKE_CARD_GATEWAY,
          request.idempotencyKey,
          seen,
          request.gatewayIntentId,
        )
      }
      if (seen !== undefined) {
        write({
          intent,
          operation: 'void',
          amount: toFils(0),
          summary: `Duplicate void suppressed on ${intent.gatewayIntentId}; the reservation was released once`,
          idempotencyKey: request.idempotencyKey,
          suppressedDuplicate: true,
        })
        return snapshot(intent)
      }

      // The transition table is what refuses a void on a captured intent, rather than a check here: money
      // that has been taken is refunded, and having one answer to that in the table means the webhook path
      // and this one cannot disagree about it.
      intent.state = nextIntentState(intent.state, 'voided')
      delete intent.actionUrl
      answered.set(request.idempotencyKey, intent.gatewayIntentId)
      emit(intent, 'voided')

      write({
        intent,
        operation: 'void',
        amount: toFils(0),
        summary: `Authorisation released on ${intent.gatewayIntentId} for ${intent.reference}; nothing was taken`,
        idempotencyKey: request.idempotencyKey,
      })
      return snapshot(intent)
    },

    async fetchIntent(gatewayIntentId: GatewayIntentId): Promise<GatewayIntentSnapshot> {
      armed()
      return snapshot(require_(gatewayIntentId))
    },

    async eventsSince(cursor: GatewayEventCursor | null): Promise<readonly GatewayEventDelivery[]> {
      armed()
      // Zero-padded cursors, so a string comparison is the sequence comparison and no consumer has to
      // parse the cursor to resume. Y-PAY-05's watermark is one of these and nothing else.
      return cursor === null ? [...queue] : queue.filter((delivery) => delivery.cursor > cursor)
    },

    completeCustomerAction(gatewayIntentId: GatewayIntentId): void {
      const intent = require_(gatewayIntentId)
      intent.state = nextIntentState(intent.state, 'authorised')
      delete intent.actionUrl
      emit(intent, 'authorised', toFils(intent.authorisedMinor))
    },
  }
}
