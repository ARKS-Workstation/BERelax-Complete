/**
 * @berelax/messaging — the send choke point, the promotional gate, the staging guard and the outbox.
 *
 * Provider adapters live in `@berelax/providers` (H02) behind their own ports, and the bridge from an
 * OutboundMessage to a provider request lives in `src/transports/`, which is the only directory
 * permitted to import one. Nothing in the codebase may call a provider SDK directly — a transport is
 * imported from `@berelax/messaging/transports/smsala` and handed to `sendMessage`, and it is
 * deliberately absent from this barrel so no feature reaches a provider by autocomplete.
 */

export {
  campaignCost,
  costOf,
  type MessageCost,
  PROVISIONAL_FILS_PER_SEGMENT,
} from './encoding.ts'
export {
  asPromotionalWindow,
  assertPromotionalWindowChange,
  evaluateGate,
  type GateContext,
  type GateDecision,
  type GateEvaluatorName,
  type GateEvaluators,
  type GateRefusal,
  nextPromotionalWindowOpen,
  PROMOTIONAL_WINDOW_SETTING_KEY,
  type PromotionalWindow,
  TDRA_PROMOTIONAL_WINDOW,
  withinPromotionalWindow,
} from './gate.ts'
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
export {
  assertSenderIdRegistry,
  CampaignSpend,
  type ClassifiedTemplate,
  type ClassRoutedTransport,
  idempotencyKeyFor,
  PROMOTIONAL_SENDER_PREFIX,
  PROVISIONAL_SENDER_IDS,
  type SendContext,
  type SenderIdentity,
  type SenderIdRegistry,
  type SendRefusal,
  type SendRequest,
  type SendResult,
  senderIdFor,
  sendMessage,
  type TransportFailure,
  type TransportOutcome,
  type TransportRequest,
} from './send.ts'
export { type GuardContext, type GuardDecision, guardOutbound } from './send-guard.ts'
export {
  DEFAULT_TEMPLATES,
  type DefaultTemplate,
  DISCRETION_FORBIDDEN_VARIABLES,
  transactionalDefaults,
} from './templates.ts'
