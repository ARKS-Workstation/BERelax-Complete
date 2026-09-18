import type { Brand, Channel, MessageClass } from '@berelax/shared'

/**
 * `Channel` and `MessageClass` are declared in `@berelax/shared` and re-exported here, which is where
 * every consumer expects to find them. They moved because `@berelax/providers` needs `MessageClass` in
 * its port signatures while this package needs those ports — declaring them here made the two packages
 * cyclic workspace dependencies, which pnpm links and warns about and which leaves any future build step
 * for either one with no valid order. See `packages/shared/src/messaging.ts`.
 */
export type { Channel, MessageClass }

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
