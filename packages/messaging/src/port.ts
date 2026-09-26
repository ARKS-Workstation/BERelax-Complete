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

/**
 * `Transport` and `SendOutcome` USED TO BE HERE, and their removal is C-AUTO-04's subject.
 *
 * `Transport.send(message)` took a bare message and returned a bare outcome: no sender identity, because
 * the choke point selects it, and no idempotency key, so a retry through it was a second charge. Its only
 * implementor was `createGuardedTransport` in `outbox.ts` — a send path that applied the staging guard and
 * nothing else — and its own comment said `send` was "never called directly by a feature", which is a
 * convention rather than a rule. Nothing in shipped code implemented or called either type.
 *
 * The seam that survives is `ClassRoutedTransport` in `send.ts`, and the difference is the unit's whole
 * point: its `send` takes a `TransportRequest`, which carries the resolved identity and the idempotency
 * key, so it is not constructible without the decisions the choke point makes. A shape that CAN be
 * satisfied without them is a shape somebody eventually satisfies without them.
 */
