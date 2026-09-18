/**
 * @berelax/messaging — the outbound port, the staging send guard and the local outbox.
 *
 * Provider adapters (SMSala, Resend, WhatsApp) are added in H02 against this port. Nothing in the
 * codebase may call a provider SDK directly.
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
