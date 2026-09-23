/**
 * @berelax/messaging — the send choke point, the promotional gate, the staging guard and the outbox.
 *
 * Provider adapters live in `@berelax/providers` (H02) behind their own ports, and the bridge from an
 * OutboundMessage to a provider request lives in `src/transports/`, which is the only directory
 * permitted to import one. Nothing in the codebase may call a provider SDK directly — a transport is
 * imported from `@berelax/messaging/transports/smsala` and handed to `sendMessage`, and it is
 * deliberately absent from this barrel so no feature reaches a provider by autocomplete.
 */

export { renderEmailHtml } from './email-html.ts'
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
export {
  type AttemptOutcome,
  type DeliveryDeps,
  type DeliveryOutcome,
  type DeliveryReceiptRecord,
  deliverMessage,
  MAX_ATTEMPTS_ANY_POLICY,
  MESSAGE_VENDORS,
  type MessageLifecycleStore,
  type MessageRecord,
  type MessageVendor,
  type ReceiptApplication,
  type ReceiptSource,
  type RecordedMessage,
  type RecordedSendRequest,
  vendorFor,
} from './lifecycle.ts'
export {
  createInMemoryMessageStore,
  type InMemoryMessageStore,
  type StoredMessage,
} from './lifecycle-memory.ts'
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
  CampaignSpend,
  type ClassifiedTemplate,
  type ClassRoutedTransport,
  idempotencyKeyFor,
  outboundMessageFor,
  type SendContext,
  type SendRefusal,
  type SendRequest,
  type SendResult,
  sendMessage,
  type TransportFailure,
  type TransportOutcome,
  type TransportRequest,
} from './send.ts'
export { type GuardContext, type GuardDecision, guardOutbound } from './send-guard.ts'
export {
  assertSenderIdRegistry,
  PROMOTIONAL_SENDER_PREFIX,
  PROVISIONAL_SENDER_IDS,
  resolveSenderIdentity,
  SENDER_IDENTITY_ROUTES,
  type SenderIdentity,
  type SenderIdentityRefusal,
  type SenderIdentityResolution,
  type SenderIdentityRoute,
  type SenderIdRegistry,
  type SenderIdRegistryFault,
  senderIdFor,
  senderIdRegistryFault,
} from './sender-identity.ts'
export {
  type CareWindow,
  type CareWindowState,
  type ClassifiedTemplateRow,
  careWindow,
  classifyTemplateRow,
  judgeVariant,
  type MessageTemplate,
  resolveVariant,
  type TemplateVariant,
  type TemplateVariantRow,
  type VariantRefusal,
  type VariantResolution,
  WHATSAPP_CARE_WINDOW_HOURS,
} from './template.ts'
export {
  DEFAULT_TEMPLATES,
  type DefaultTemplate,
  DISCRETION_FORBIDDEN_VARIABLES,
  promotionalDefaults,
  transactionalDefaults,
} from './templates.ts'
