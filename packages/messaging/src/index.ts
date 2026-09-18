/**
 * @berelax/messaging — the outbound port, the staging send guard and the local outbox.
 *
 * Provider adapters live in `@berelax/providers` (H02) behind their own ports; `B-MSG` bridges an
 * OutboundMessage to a provider request, because the mapping needs a sender ID from settings and a
 * template's message class. Nothing in the codebase may call a provider SDK directly.
 */

export { createGuardedTransport, InMemoryOutbox, type OutboxEntry } from './outbox.ts'
export type {
  Channel,
  MessageClass,
  MessageId,
  OutboundMessage,
  SendOutcome,
  Transport,
} from './port.ts'
export { type GuardContext, type GuardDecision, guardOutbound } from './send-guard.ts'
