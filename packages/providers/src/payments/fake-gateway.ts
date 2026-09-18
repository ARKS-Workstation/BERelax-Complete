/**
 * The card gateway fake.
 *
 * Cards are "at a later point" in the brief, so no gateway is chosen yet. That is precisely why this
 * exists: the checkout flow, the settlement reconciliation and the refund path are all built and
 * tested now, against an interface a real gateway will fit. Choosing the provider later becomes a
 * configuration exercise rather than a feature.
 *
 * It models the four things that shape the code around it:
 *
 * **3DS is a round trip the customer can abandon.** `createIntent` returns `requires_action` with a
 * URL; nothing is settled until the customer comes back. Most of the bugs in a checkout live in the
 * window where they have not.
 *
 * **Refunds are partial.** A spa refunds one treatment out of three far more often than a whole
 * invoice, and partial refunds accumulate: the fake tracks the refunded total and refuses to exceed
 * the captured amount.
 *
 * **Webhooks replay.** The same event id is delivered more than once, and every handler must be
 * idempotent on it. The fake replays deliberately rather than as a rare accident.
 *
 * **Disputes arrive weeks later**, against an intent nobody is looking at any more.
 *
 * Test card numbers follow the industry convention so the same fixtures work against a real gateway.
 */
import { filsFrom, money, subtract } from '@berelax/core'
import { AppError } from '@berelax/shared'
import type { CallLog } from '../call-log.ts'
import { type FailureScript, failureError } from '../failure.ts'
import type { PaymentEvent, PaymentIntent, PaymentMethod, PaymentProvider, Refund } from './port.ts'

export const FAKE_GATEWAY = 'fake-card-gateway'

/**
 * Reference suffixes that steer the fake, so a fixture or a screenshot can reach each path.
 *
 * A flag on the call would work in a test and nowhere else. A suffix on the booking reference is
 * reachable from seed data, which is what makes the admin screens demoable in every state.
 */
export const REFERENCE_MARKERS = {
  /** Requires a 3DS challenge before it settles. */
  requiresAction: '-3DS',
  /** Declined at authorisation. */
  declined: '-DECLINE',
  /** Settles, then is disputed. */
  disputed: '-DISPUTE',
} as const

export interface FakeGatewayOptions {
  readonly log: CallLog
  readonly failures: FailureScript
  readonly now: () => string
}

interface IntentState {
  intent: PaymentIntent
  reference: string
  refundedFils: number
}

export function createFakeCardGateway(options: FakeGatewayOptions): PaymentProvider {
  const { log, failures, now } = options
  const intents = new Map<string, IntentState>()
  const byIdempotencyKey = new Map<string, string>()
  let pendingEvents: PaymentEvent[] = []
  let counter = 0

  const supports: readonly PaymentMethod[] = ['card_online']

  const emit = (event: PaymentEvent, replay: boolean): void => {
    pendingEvents.push(event)
    // Every real gateway redelivers. A system that only ever sees one copy of an event has an
    // idempotency bug it has not met yet.
    if (replay) pendingEvents.push({ ...event })
  }

  return {
    name: FAKE_GATEWAY,
    supports,

    async createIntent({ amount, method, idempotencyKey, reference }) {
      const armed = failures.take()
      if (armed !== undefined) {
        log.record({
          provider: FAKE_GATEWAY,
          operation: 'createIntent',
          outcome: 'failure',
          summary: `Intent for ${reference} failed: ${armed}`,
          detail: { failureMode: armed, reference },
        })
        throw failureError(FAKE_GATEWAY, armed)
      }

      if (!supports.includes(method)) {
        throw new AppError(
          'validation',
          `The card gateway takes ${supports.join(', ')}, not ${method}. Cash and terminal ` +
            'payments go through the manual till adapter.',
          { details: { method, supports } },
        )
      }

      const existingId = byIdempotencyKey.get(idempotencyKey)
      const existing = existingId === undefined ? undefined : intents.get(existingId)
      if (existing !== undefined) {
        log.record({
          provider: FAKE_GATEWAY,
          operation: 'createIntent',
          outcome: 'success',
          summary: `Duplicate suppressed for ${reference}; no second authorisation`,
          detail: { idempotencyKey, intentId: existing.intent.intentId },
        })
        return existing.intent
      }

      counter += 1
      const intentId = `pi_fake_${String(counter).padStart(6, '0')}`
      const needsAction = reference.endsWith(REFERENCE_MARKERS.requiresAction)
      const declined = reference.endsWith(REFERENCE_MARKERS.declined)

      const intent: PaymentIntent = declined
        ? { intentId, amount, status: 'failed', method }
        : needsAction
          ? {
              intentId,
              amount,
              status: 'requires_action',
              method,
              actionUrl: `/dev/payments/3ds/${intentId}`,
            }
          : { intentId, amount, status: 'requires_confirmation', method }

      intents.set(intentId, { intent, reference, refundedFils: 0 })
      byIdempotencyKey.set(idempotencyKey, intentId)

      if (declined) {
        emit(
          {
            eventId: `evt_${intentId}_failed`,
            type: 'payment.failed',
            intentId,
            occurredAtIso: now(),
          },
          true,
        )
      }

      log.record({
        provider: FAKE_GATEWAY,
        operation: 'createIntent',
        outcome: 'success',
        summary: `Intent ${intentId} for ${reference}: ${intent.status}, ${amount.fils} fils`,
        detail: { intentId, reference, status: intent.status, fils: amount.fils },
      })
      return intent
    },

    async confirmIntent(intentId: string) {
      const armed = failures.take()
      if (armed !== undefined) {
        log.record({
          provider: FAKE_GATEWAY,
          operation: 'confirmIntent',
          outcome: 'failure',
          summary: `Confirming ${intentId} failed: ${armed}`,
          detail: { failureMode: armed, intentId },
        })
        throw failureError(FAKE_GATEWAY, armed)
      }

      const state = intents.get(intentId)
      if (state === undefined) {
        throw new AppError('not_found', `No payment intent ${intentId}`, { details: { intentId } })
      }
      if (state.intent.status === 'failed' || state.intent.status === 'cancelled') {
        throw new AppError(
          'conflict',
          `Intent ${intentId} is ${state.intent.status} and cannot be confirmed.`,
          { details: { intentId, status: state.intent.status } },
        )
      }

      const settled: PaymentIntent = { ...state.intent, status: 'succeeded', settledAtIso: now() }
      intents.set(intentId, { ...state, intent: settled })

      emit(
        {
          eventId: `evt_${intentId}_succeeded`,
          type: 'payment.succeeded',
          intentId,
          occurredAtIso: now(),
          amount: settled.amount,
        },
        true,
      )

      if (state.reference.endsWith(REFERENCE_MARKERS.disputed)) {
        // Weeks later in reality, immediately here — the point is that it arrives against an intent
        // nobody is watching any more.
        emit(
          {
            eventId: `evt_${intentId}_dispute`,
            type: 'dispute.opened',
            intentId,
            occurredAtIso: now(),
            amount: settled.amount,
          },
          false,
        )
      }

      log.record({
        provider: FAKE_GATEWAY,
        operation: 'confirmIntent',
        outcome: 'success',
        summary: `Intent ${intentId} settled, ${settled.amount.fils} fils`,
        detail: { intentId, fils: settled.amount.fils },
      })
      return settled
    },

    async refund({ intentId, amount, reason }) {
      const armed = failures.take()
      if (armed !== undefined) {
        log.record({
          provider: FAKE_GATEWAY,
          operation: 'refund',
          outcome: 'failure',
          summary: `Refunding ${intentId} failed: ${armed}`,
          detail: { failureMode: armed, intentId },
        })
        throw failureError(FAKE_GATEWAY, armed)
      }

      const state = intents.get(intentId)
      if (state === undefined) {
        throw new AppError('not_found', `No payment intent ${intentId}`, { details: { intentId } })
      }
      if (state.intent.status !== 'succeeded') {
        throw new AppError('conflict', `Intent ${intentId} has not settled; nothing to refund.`, {
          details: { intentId, status: state.intent.status },
        })
      }

      const remaining = subtract(state.intent.amount, money(filsFrom(state.refundedFils)))
      if (amount.fils > remaining.fils) {
        log.record({
          provider: FAKE_GATEWAY,
          operation: 'refund',
          outcome: 'failure',
          summary: `Refund of ${amount.fils} fils rejected: only ${remaining.fils} fils remain on ${intentId}`,
          detail: { intentId, requestedFils: amount.fils, remainingFils: remaining.fils },
        })
        throw failureError(FAKE_GATEWAY, 'rejected')
      }

      counter += 1
      const refund: Refund = {
        refundId: `re_fake_${String(counter).padStart(6, '0')}`,
        intentId,
        amount,
        status: 'succeeded',
      }
      intents.set(intentId, { ...state, refundedFils: state.refundedFils + amount.fils })

      emit(
        {
          eventId: `evt_${refund.refundId}`,
          type: 'refund.succeeded',
          intentId,
          occurredAtIso: now(),
          amount,
        },
        true,
      )

      log.record({
        provider: FAKE_GATEWAY,
        operation: 'refund',
        outcome: 'success',
        summary: `Refunded ${amount.fils} of ${state.intent.amount.fils} fils on ${intentId}`,
        detail: {
          refundId: refund.refundId,
          intentId,
          fils: amount.fils,
          refundedTotalFils: state.refundedFils + amount.fils,
          reason,
        },
      })
      return refund
    },

    async drainEvents(): Promise<readonly PaymentEvent[]> {
      const drained = pendingEvents
      pendingEvents = []
      if (drained.length > 0) {
        log.record({
          provider: FAKE_GATEWAY,
          operation: 'drainEvents',
          outcome: 'success',
          summary: `${drained.length} event(s) drained, replays included`,
          detail: { types: drained.map((event) => event.type) },
        })
      }
      return drained
    },
  }
}
