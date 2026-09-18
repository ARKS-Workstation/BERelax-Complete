/**
 * Cash and card-terminal payments, recorded at the till.
 *
 * **This adapter is real, not a fake.** It is how the business takes money today and how it will keep
 * taking most of it: the customer pays at the desk, and the system records that it happened. There is
 * no external service, so there is nothing to stub — which is why it is here rather than beside the
 * fakes.
 *
 * It still writes to the call log. The log is the reconciliation surface, and a cash payment that
 * never appears there is a cash payment nobody can tie to a ledger entry.
 *
 * Two deliberate absences. It **cannot refund to a card**: a terminal refund is made on the terminal,
 * and this records it rather than performing it. And it emits **no asynchronous events**, because
 * cash does not settle later — the money is either in the drawer or it is not.
 */
import { AppError } from '@berelax/shared'
import type { CallLog } from '../call-log.ts'
import type { PaymentEvent, PaymentIntent, PaymentMethod, PaymentProvider, Refund } from './port.ts'

export const MANUAL = 'manual'

export interface ManualPaymentOptions {
  readonly log: CallLog
  readonly now: () => string
}

export function createManualPaymentProvider(options: ManualPaymentOptions): PaymentProvider {
  const { log, now } = options
  const intents = new Map<string, PaymentIntent>()
  const byIdempotencyKey = new Map<string, string>()
  let counter = 0

  const supports: readonly PaymentMethod[] = ['cash', 'card_terminal']

  return {
    name: MANUAL,
    supports,

    async createIntent({ amount, method, idempotencyKey, reference }) {
      if (!supports.includes(method)) {
        throw new AppError(
          'validation',
          `The manual till adapter takes ${supports.join(' and ')}, not ${method}. ` +
            'Online card payment needs a gateway, which is configured separately.',
          { details: { method, supports } },
        )
      }

      const existingId = byIdempotencyKey.get(idempotencyKey)
      const existing = existingId === undefined ? undefined : intents.get(existingId)
      if (existing !== undefined) return existing

      counter += 1
      // Money at the till is taken in the same moment it is recorded; there is no pending state to
      // model, and inventing one would put a status on the screen that never changes.
      const intent: PaymentIntent = {
        intentId: `manual-${String(counter).padStart(6, '0')}`,
        amount,
        status: 'succeeded',
        method,
        settledAtIso: now(),
      }
      intents.set(intent.intentId, intent)
      byIdempotencyKey.set(idempotencyKey, intent.intentId)

      log.record({
        provider: MANUAL,
        operation: 'createIntent',
        outcome: 'success',
        summary: `${method === 'cash' ? 'Cash' : 'Card terminal'} payment of ${amount.fils} fils recorded for ${reference}`,
        detail: { intentId: intent.intentId, method, fils: amount.fils, reference },
      })
      return intent
    },

    async confirmIntent(intentId: string) {
      const intent = intents.get(intentId)
      if (intent === undefined) {
        throw new AppError('not_found', `No till payment ${intentId}`, { details: { intentId } })
      }
      return intent
    },

    async refund({ intentId, amount, reason }) {
      const intent = intents.get(intentId)
      if (intent === undefined) {
        throw new AppError('not_found', `No till payment ${intentId}`, { details: { intentId } })
      }
      if (amount.fils > intent.amount.fils) {
        throw new AppError(
          'validation',
          `Refund of ${amount.fils} fils exceeds the ${intent.amount.fils} fils taken.`,
          { details: { intentId, refundFils: amount.fils, paidFils: intent.amount.fils } },
        )
      }
      counter += 1
      const refund: Refund = {
        refundId: `manual-refund-${String(counter).padStart(6, '0')}`,
        intentId,
        amount,
        status: 'succeeded',
      }
      log.record({
        provider: MANUAL,
        operation: 'refund',
        outcome: 'success',
        summary:
          `Refund of ${amount.fils} fils against ${intentId} recorded — ` +
          'the money is handed back at the desk, not moved by this system',
        detail: { refundId: refund.refundId, intentId, fils: amount.fils, reason },
      })
      return refund
    },

    async drainEvents(): Promise<readonly PaymentEvent[]> {
      // Cash does not settle later.
      return []
    },
  }
}
