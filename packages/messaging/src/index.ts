/**
 * @berelax/messaging — the outbound port, the staging send guard and the local outbox.
 *
 * Provider adapters live in `@berelax/providers` (H02) behind their own ports; `B-MSG` bridges an
 * OutboundMessage to a provider request, because the mapping needs a sender ID from settings and a
 * template's message class. Nothing in the codebase may call a provider SDK directly.
 */

export {
  campaignCost,
  costOf,
  type MessageCost,
  PROVISIONAL_FILS_PER_SEGMENT,
} from './encoding.ts'
export { createGuardedTransport, InMemoryOutbox, type OutboxEntry } from './outbox.ts'
export type {
  Channel,
  MessageClass,
  MessageId,
  OutboundMessage,
  SendOutcome,
  Transport,
} from './port.ts'
export {
  placeholdersIn,
  renderTemplate,
  type TemplateDefinition,
  TemplateRenderError,
  type TemplateValues,
  validateTemplate,
} from './render.ts'
export { type GuardContext, type GuardDecision, guardOutbound } from './send-guard.ts'
export {
  DEFAULT_TEMPLATES,
  type DefaultTemplate,
  DISCRETION_FORBIDDEN_VARIABLES,
  transactionalDefaults,
} from './templates.ts'
