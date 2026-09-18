/**
 * The payment port — cash and card through one interface.
 *
 * Cards are "at a later point" in the brief, and the manual adapter is the one that runs on day one:
 * cash and terminal payments recorded at the till. Both go through this port so the ledger has a
 * single shape to post against, and so adding a gateway is a configuration change rather than a
 * second settlement path through the accounts.
 *
 * Gateway-shaped in the ways that matter: **an intent is created before it is confirmed** (3DS
 * happens in between and can be abandoned), **refunds are partial by default** because a spa refunds
 * one treatment out of three more often than a whole invoice, and **webhooks replay**, so every
 * handler is keyed on an event id it has seen before.
 */
import type { Money } from '@berelax/core'

export type PaymentMethod = 'cash' | 'card_terminal' | 'card_online'

export type PaymentIntentStatus =
  | 'requires_confirmation'
  /** 3DS or another challenge is outstanding. The customer has left the page. */
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface PaymentIntent {
  readonly intentId: string
  readonly amount: Money
  readonly status: PaymentIntentStatus
  readonly method: PaymentMethod
  /** Where the customer is sent to complete a challenge. Present only for `requires_action`. */
  readonly actionUrl?: string
  /** Set once settled, for reconciliation against the ledger. */
  readonly settledAtIso?: string
}

export interface Refund {
  readonly refundId: string
  readonly intentId: string
  readonly amount: Money
  readonly status: 'pending' | 'succeeded' | 'failed'
}

export type PaymentEventType =
  | 'payment.succeeded'
  | 'payment.failed'
  | 'refund.succeeded'
  | 'dispute.opened'

export interface PaymentEvent {
  /** Stable across replays. Every handler must be idempotent on this. */
  readonly eventId: string
  readonly type: PaymentEventType
  readonly intentId: string
  readonly occurredAtIso: string
  readonly amount?: Money
}

export interface PaymentProvider {
  readonly name: string
  readonly supports: readonly PaymentMethod[]
  createIntent(args: {
    amount: Money
    method: PaymentMethod
    idempotencyKey: string
    /** Booking or invoice reference, carried through to reconciliation. */
    reference: string
  }): Promise<PaymentIntent>
  confirmIntent(intentId: string): Promise<PaymentIntent>
  refund(args: { intentId: string; amount: Money; reason: string }): Promise<Refund>
  drainEvents(): Promise<readonly PaymentEvent[]>
}
