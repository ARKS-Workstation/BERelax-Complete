/**
 * The SMS provider port — the interface SMSala's real adapter will implement.
 *
 * Shaped around the provider, not around the fake (docs/12 §1.1). Two things make it SMSala-shaped
 * rather than generic: the **sender ID is an explicit argument**, because TDRA registers two of them
 * and sending promotional content from the transactional identity is the failure that suspends the
 * identity everything else depends on; and **delivery is asynchronous**, reported by a later DLR
 * rather than by the send call, so `send` returns "accepted" and never "delivered".
 */
import type { MessageClass } from '@berelax/shared'

/** A TDRA-registered sender identity. Promotional identities are prefixed `AD-`. */
export interface SenderId {
  readonly value: string
  readonly messageClass: MessageClass
}

export interface SmsRequest {
  /** E.164, including the `+`. */
  readonly recipient: string
  readonly body: string
  readonly senderId: SenderId
  readonly messageClass: MessageClass
  /** Deduplication key. The same key must never produce a second message. */
  readonly idempotencyKey: string
}

export interface SmsAccepted {
  readonly providerMessageId: string
  /** Billable segments, from `segmentSms`. Arabic is 70 characters per segment, not 160. */
  readonly segments: number
  readonly encoding: 'GSM-7' | 'UCS-2'
  /** Estimated cost in fils, for the campaign budget screen. */
  readonly estimatedCostFils: number
}

/** Delivery status as the provider reports it, arriving later by webhook. */
export type DeliveryStatus = 'accepted' | 'delivered' | 'failed' | 'expired' | 'rejected'

export interface DeliveryReceipt {
  readonly providerMessageId: string
  readonly status: DeliveryStatus
  readonly occurredAtIso: string
  readonly reason?: string
}

export interface SmsProvider {
  readonly name: string
  send(request: SmsRequest): Promise<SmsAccepted>
  /**
   * Delivery receipts the provider has reported since the last call.
   *
   * The real adapter receives these by webhook and persists them; this is the read side, so a
   * worker can drain them the same way regardless of how they arrived.
   */
  drainDeliveryReceipts(): Promise<readonly DeliveryReceipt[]>
}
