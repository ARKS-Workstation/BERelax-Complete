import type { Brand } from '@berelax/shared'

/** Channels the platform can send on. WhatsApp is later but the model is channel-shaped now,
 *  because retrofitting it into a flat SMS-shaped type means touching every send path. */
export type Channel = 'sms' | 'email' | 'whatsapp'

/**
 * Transactional or promotional. This is the most consequential field in the messaging module.
 *
 * It is an immutable property of the TEMPLATE, never of the send call, so an automation cannot
 * route promotional content down a transactional path. UAE promotional SMS must carry an AD-
 * prefixed sender id and is confined to 07:00–21:00; getting it wrong risks sender-id suspension,
 * which would stop every booking confirmation. See docs/04-uae-compliance.md §5.
 */
export type MessageClass = 'transactional' | 'promotional'

export type MessageId = Brand<string, 'MessageId'>

export interface OutboundMessage {
  readonly id: MessageId
  readonly channel: Channel
  readonly messageClass: MessageClass
  /** E.164 for sms/whatsapp, an address for email. */
  readonly recipient: string
  readonly body: string
  readonly subject?: string
  readonly templateKey: string
  readonly locale: 'en' | 'ar'
}

export type SendOutcome =
  | { readonly kind: 'sent'; readonly providerMessageId: string }
  | { readonly kind: 'diverted'; readonly reason: string; readonly outboxRef: string }
  | { readonly kind: 'rejected'; readonly reason: string }

export interface Transport {
  readonly channel: Channel
  /** Never called directly by a feature. Everything goes through the guarded transport. */
  send(message: OutboundMessage): Promise<SendOutcome>
}
