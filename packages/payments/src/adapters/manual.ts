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
  Money,
  PaymentGateway,
  PaymentGatewayDependencies,
  RefundRequest,
  TenderKind,
  VoidRequest,
} from '@berelax/core'
import {
  add,
  assertIntegerFilsAmount,
  assertReferencePresent,
  assertServesInstrument,
  FILS_CONVENTION,
  IdempotencyKeyReusedAcrossIntents,
  nextIntentState,
  PartialCaptureNotAvailable,
  subtract,
  tenderTypeOf,
  toDecimalString,
  VoidNotAvailable,
  ZERO_AED,
} from '@berelax/core'
import { AppError } from '@berelax/shared'

/**
 * The manual gateway: cash, the in-salon card machine, and a bank transfer.
 *
 * **Real, not a fake, in every environment.** ADR 0022's *"the one adapter that is not a fake"*: the
 * customer pays at the desk and the system records it, so there is no external service to stub and a fake
 * would make the ledger fictional. It is here rather than beside a gateway fake for that reason, and it is
 * held to the same conformance suite for the other one — an adapter that has no service to fail still has
 * every other obligation, and the suite proves the *absence* of a service rather than excusing it.
 *
 * ## What it implements honestly, and what it declares it cannot do
 *
 * `authorise` reserves nothing, because there is nothing to reserve: the customer is standing there with
 * the money. It records the intent and the amount the operator keyed. `capture` records the money moving.
 * In practice both happen in the same second, and they are two calls rather than one so that the checkout
 * has a single code path whichever gateway is serving it.
 *
 * Three capabilities are declared **false**, and each one is a refusal this adapter owes rather than a case
 * it skips:
 *
 *   - `supportsPartialCapture` — the amount handed over IS the amount. Keying 200 and taking 150 is a
 *     mis-keyed tender, and the answer is to re-key it, not to draw down a reservation that was never made.
 *   - `supportsVoid` — there is no reservation to release. "Voiding" at the till would write a zero-fils
 *     movement for an event that did not happen, which is the kind of row that later reads as a failed
 *     payment.
 *   - `emitsEvents` — cash does not settle later. The money is in the drawer or it is not.
 *
 * And `hasExternalService` is false, which the suite turns into its own demand: arming a failure must change
 * nothing here. A till that could be made to fail by a test switch would be a till whose failures were
 * fiction.
 *
 * ## Why the state and the amounts are implemented here rather than shared with the gateway adapter
 *
 * The two adapters duplicate their intent map, their balance arithmetic and their invariant checks, and that
 * is deliberate. A shared kernel would mean the conformance suite ran one implementation twice and reported
 * it as two passes — which is exactly the vacuity ADR 0003 is about, and the reason the suite exists at all.
 * The pieces that ARE shared are the port's argument guards in `@berelax/core`, and they are shared because
 * the suite's saboteur fixture deliberately does not call them, so each of those rules has been seen to fail.
 */

export const MANUAL_GATEWAY = 'manual-till' as GatewayName

/**
 * Cash, the card machine, a transfer and an appointment's own deposit: every tender kind whose registry
 * adapter is `manual`.
 *
 * The list is held equal to `tender_type.adapter = 'manual'` in BOTH directions by
 * `packages/fixtures/src/gateway-tender.itest.ts`, which is what makes it a statement rather than a
 * comment — a kind the till could offer and no gateway could take is what `NoGatewayServesInstrument`
 * refuses, and that test found the omission the moment `deposit_on_account` was added to the registry.
 *
 * `deposit_on_account` is Y-PAY-06's (migration 0124) and it belongs here for the reason cash does, one
 * step further along: there is nothing to reserve because the money is already the business's, and
 * `capture` records a liability being discharged instead of a note going into a drawer. Every capability
 * this adapter declares false is false for it too — the amount applied IS the amount, there is no
 * reservation to void, and nothing settles later.
 */
const SERVES: readonly TenderKind[] = Object.freeze([
  'cash',
  'card_in_salon',
  'bank_transfer',
  'deposit_on_account',
])

interface TillIntent {
  readonly gatewayIntentId: GatewayIntentId
  readonly instrument: TenderKind
  readonly reference: string
  readonly authorised: Money
  captured: Money
  refunded: Money
  state: GatewayIntentSnapshot['state']
}

export function createManualGateway(deps: PaymentGatewayDependencies): PaymentGateway {
  const { clock, records } = deps
  const intents = new Map<string, TillIntent>()
  /** idempotency key → intent id, so a repeated call returns the first answer. */
  const answered = new Map<string, GatewayIntentId>()
  let counter = 0

  const snapshot = (intent: TillIntent): GatewayIntentSnapshot =>
    Object.freeze({
      gatewayIntentId: intent.gatewayIntentId,
      state: intent.state,
      instrument: intent.instrument,
      postingAccountCode: tenderTypeOf(intent.instrument).account,
      authorised: intent.authorised,
      captured: intent.captured,
      refunded: intent.refunded,
      observedAt: clock.now(),
    })

  const write = (args: {
    intent: TillIntent
    operation: GatewayOperation
    amount: Money
    summary: string
    idempotencyKey: IdempotencyKey
    suppressedDuplicate?: boolean
  }): void => {
    records.record(
      Object.freeze({
        gateway: MANUAL_GATEWAY,
        operation: args.operation,
        gatewayIntentId: args.intent.gatewayIntentId,
        instrument: args.intent.instrument,
        postingAccountCode: tenderTypeOf(args.intent.instrument).account,
        amount: args.amount,
        summary: args.summary,
        occurredAt: clock.now(),
        idempotencyKey: args.idempotencyKey,
        ...(args.suppressedDuplicate === true ? { suppressedDuplicate: true } : {}),
      }),
    )
  }

  const require_ = (gatewayIntentId: GatewayIntentId): TillIntent => {
    const intent = intents.get(gatewayIntentId)
    if (intent === undefined) {
      throw new AppError('not_found', `No till payment ${gatewayIntentId}`, {
        details: { gatewayIntentId },
      })
    }
    return intent
  }

  return {
    name: MANUAL_GATEWAY,
    serves: SERVES,
    minorUnits: FILS_CONVENTION,
    capabilities: Object.freeze({
      emitsEvents: false,
      supportsPartialCapture: false,
      supportsPartialRefund: true,
      supportsVoid: false,
      hasExternalService: false,
    }),

    async authorise(request: AuthoriseRequest): Promise<GatewayIntentSnapshot> {
      assertServesInstrument(MANUAL_GATEWAY, SERVES, request.instrument)
      assertIntegerFilsAmount(request.amount, 'the amount authorised')
      assertReferencePresent(request.reference)

      const seen = answered.get(request.idempotencyKey)
      if (seen !== undefined) {
        const first = require_(seen)
        // Recorded, not silent. A replay nobody can see is indistinguishable from a second payment that
        // was lost, and the reconciliation screen is where somebody has to tell them apart.
        write({
          intent: first,
          operation: 'authorise',
          amount: first.authorised,
          summary: `Duplicate till authorisation suppressed for ${first.reference}; no second tender recorded`,
          idempotencyKey: request.idempotencyKey,
          suppressedDuplicate: true,
        })
        return snapshot(first)
      }

      counter += 1
      const gatewayIntentId = `till_${String(counter).padStart(6, '0')}` as GatewayIntentId
      const intent: TillIntent = {
        gatewayIntentId,
        instrument: request.instrument,
        reference: request.reference,
        authorised: request.amount,
        captured: ZERO_AED,
        refunded: ZERO_AED,
        // No challenge and no waiting: the money is on the counter.
        state: nextIntentState('requires_authorisation', 'authorised'),
      }
      intents.set(gatewayIntentId, intent)
      answered.set(request.idempotencyKey, gatewayIntentId)

      write({
        intent,
        operation: 'authorise',
        amount: request.amount,
        summary:
          `${tenderTypeOf(request.instrument).label} of AED ${toDecimalString(request.amount)} keyed in ` +
          `for ${request.reference}`,
        idempotencyKey: request.idempotencyKey,
      })
      return snapshot(intent)
    },

    async capture(request: CaptureRequest): Promise<GatewayIntentSnapshot> {
      assertIntegerFilsAmount(request.amount, 'the amount captured')
      const intent = require_(request.gatewayIntentId)

      const seen = answered.get(request.idempotencyKey)
      if (seen !== undefined && seen !== request.gatewayIntentId) {
        throw new IdempotencyKeyReusedAcrossIntents(
          MANUAL_GATEWAY,
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
          summary: `Duplicate till capture suppressed on ${intent.gatewayIntentId}; the money moved once`,
          idempotencyKey: request.idempotencyKey,
          suppressedDuplicate: true,
        })
        return snapshot(require_(seen))
      }

      if (request.amount.fils !== intent.authorised.fils) {
        throw new PartialCaptureNotAvailable(
          MANUAL_GATEWAY,
          request.amount.fils,
          intent.authorised.fils,
        )
      }

      intent.state = nextIntentState(intent.state, 'captured')
      intent.captured = add(intent.captured, request.amount)
      answered.set(request.idempotencyKey, intent.gatewayIntentId)

      write({
        intent,
        operation: 'capture',
        amount: request.amount,
        summary:
          `AED ${toDecimalString(request.amount)} taken at the desk for ${intent.reference} ` +
          `(${tenderTypeOf(intent.instrument).label})`,
        idempotencyKey: request.idempotencyKey,
      })
      return snapshot(intent)
    },

    async refund(request: RefundRequest): Promise<GatewayRefundReceipt> {
      assertIntegerFilsAmount(request.amount, 'the amount refunded')
      const intent = require_(request.gatewayIntentId)

      const seen = answered.get(request.idempotencyKey)
      if (seen !== undefined && seen !== request.gatewayIntentId) {
        throw new IdempotencyKeyReusedAcrossIntents(
          MANUAL_GATEWAY,
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
          summary: `Duplicate till refund suppressed on ${intent.gatewayIntentId}; the money went back once`,
          idempotencyKey: request.idempotencyKey,
          suppressedDuplicate: true,
        })
        return Object.freeze({
          refundId: `till_refund_${request.idempotencyKey}`,
          gatewayIntentId: intent.gatewayIntentId,
          amount: request.amount,
          acknowledgedAt: clock.now(),
        })
      }

      const refundable = subtract(intent.captured, intent.refunded)
      if (request.amount.fils > refundable.fils) {
        throw new AppError(
          'validation',
          `A refund of ${request.amount.fils} fils exceeds the ${refundable.fils} fils still refundable ` +
            `on ${intent.gatewayIntentId}. Money that was never taken cannot be handed back.`,
          {
            details: {
              gatewayIntentId: intent.gatewayIntentId,
              requestedFils: request.amount.fils,
              refundableFils: refundable.fils,
            },
          },
        )
      }

      intent.state = nextIntentState(intent.state, 'refunded')
      intent.refunded = add(intent.refunded, request.amount)
      counter += 1
      const refundId = `till_refund_${String(counter).padStart(6, '0')}`
      answered.set(request.idempotencyKey, intent.gatewayIntentId)

      write({
        intent,
        operation: 'refund',
        amount: request.amount,
        summary:
          `AED ${toDecimalString(request.amount)} handed back at the desk against ${intent.reference} ` +
          `— ${request.reason}`,
        idempotencyKey: request.idempotencyKey,
      })
      return Object.freeze({
        refundId,
        gatewayIntentId: intent.gatewayIntentId,
        amount: request.amount,
        acknowledgedAt: clock.now(),
      })
    },

    async voidAuthorisation(request: VoidRequest): Promise<GatewayIntentSnapshot> {
      // Refused rather than quietly succeeding, because `supportsVoid` is declared false and the
      // conformance suite demands that a declared `false` is a refusal and not an exemption.
      require_(request.gatewayIntentId)
      throw new VoidNotAvailable(MANUAL_GATEWAY, request.gatewayIntentId)
    },

    async fetchIntent(gatewayIntentId: GatewayIntentId): Promise<GatewayIntentSnapshot> {
      return snapshot(require_(gatewayIntentId))
    },

    async eventsSince(
      _cursor: GatewayEventCursor | null,
    ): Promise<readonly GatewayEventDelivery[]> {
      // Cash does not settle later. `emitsEvents` is false and this is the behaviour that has to match it.
      return []
    },
  }
}
