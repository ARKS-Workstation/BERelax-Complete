/**
 * The single send choke point.
 *
 * Every outbound message in the system goes through `sendMessage`, in this order:
 *
 *  1. resolve `message_class` from the **template**, never from the call site;
 *  2. select the sender identity registered for that class;
 *  3. run the promotional gate (`gate.ts`), which fails closed;
 *  4. compute encoding, segments and cost, and check the campaign spend cap;
 *  5. apply the staging send guard, then hand the message to the transport and record the provider id.
 *
 * ## Why there is no `senderId` on `SendRequest`
 *
 * The compliance decision that matters — which registered identity a message leaves from — is made
 * from the template's immutable class and nothing else. `SendRequest` therefore has no `senderId`,
 * no `messageClass` and no channel: there is no argument a caller can pass to route promotional
 * content down the transactional identity. A drag-and-drop flow builder is exactly where somebody
 * will try (docs/03 §5), and the type signature is what makes it impossible rather than discouraged.
 * `send.test.ts` asserts both overrides fail to compile.
 *
 * ## Why the gate runs before the staging guard
 *
 * The guard (`send-guard.ts`, F03) diverts anything outside production to the local outbox. If it ran
 * first, a promotional message with no consent record would be recorded as *diverted* on staging and
 * as *refused* in production — so the one environment where the compliance path is exercised daily
 * would be the one environment that never exercises it. The gate runs first, and a refusal is
 * recorded as a refusal everywhere.
 *
 * ## Why an unexpected transport throw is a failure and not an exception
 *
 * `sendMessage` returns a result for every outcome, including one the transport did not anticipate.
 * A send path that throws makes every caller — a worker, a route handler, a flow interpreter — invent
 * its own answer to "did that message go out?", and the answers disagree.
 */
import type { AppEnv } from '@berelax/config'
import { type Clock, type Instant, instantToIso } from '@berelax/core'
import { AppError, type MessageFailureReason } from '@berelax/shared'
import { costOf } from './encoding.ts'
import { evaluateGate, type GateContext, type GateEvaluatorName, type GateRefusal } from './gate.ts'
import type { InMemoryOutbox } from './outbox.ts'
import type { Channel, MessageClass, MessageId, OutboundMessage } from './port.ts'
import {
  placeholdersIn,
  renderTemplate,
  type TemplateDefinition,
  type TemplateValues,
} from './render.ts'
import { guardOutbound } from './send-guard.ts'

/** Promotional identities are registered with an `AD-` prefix; transactional ones must not carry it. */
export const PROMOTIONAL_SENDER_PREFIX = 'AD-'

/** A TDRA-registered sender identity, and the one class of traffic it may carry. */
export interface SenderIdentity {
  readonly value: string
  readonly messageClass: MessageClass
}

/**
 * The two registrations.
 *
 * Two, not one, and separately registered: with a single identity one over-eager blast suspends it
 * and every booking confirmation, reminder and OTP stops with it — a marketing mistake becoming an
 * operational outage. See ADR 0016 and docs/04 §5.
 */
export interface SenderIdRegistry {
  readonly transactional: SenderIdentity
  readonly promotional: SenderIdentity
}

/**
 * Checks a registry at the point it is built, rather than at the point a message needs it.
 *
 * A misconfigured registry is a configuration error, and the configuration is read at boot where a
 * deploy fails and somebody is watching. Discovering it on the 9pm reminder run instead means the
 * first symptom is a rejected send.
 */
export function assertSenderIdRegistry(registry: SenderIdRegistry): SenderIdRegistry {
  for (const messageClass of ['transactional', 'promotional'] as const) {
    const identity = registry[messageClass]
    if (identity.messageClass !== messageClass) {
      throw new AppError(
        'invariant_violated',
        `The ${messageClass} sender ID '${identity.value}' is registered as ` +
          `${identity.messageClass}. A registry whose slots and classes disagree routes one class of ` +
          'traffic out of the other identity, which is the send that gets a sender ID suspended.',
        { details: { messageClass, identity } },
      )
    }
  }

  // Checked before the prefix rules, and not after: one identity used for both classes always trips
  // one prefix rule or the other, so reporting the prefix would send somebody off to rename a sender
  // ID when the actual fault is that only one was ever registered.
  if (registry.transactional.value === registry.promotional.value) {
    throw new AppError(
      'invariant_violated',
      `Both classes are registered to '${registry.transactional.value}'. One identity means a ` +
        'promotional suspension takes every booking confirmation and OTP with it — the outage two ' +
        'registrations exist to remove.',
      { details: { registry } },
    )
  }

  if (!registry.promotional.value.startsWith(PROMOTIONAL_SENDER_PREFIX)) {
    throw new AppError(
      'invariant_violated',
      `The promotional sender ID '${registry.promotional.value}' must carry the ` +
        `'${PROMOTIONAL_SENDER_PREFIX}' prefix TDRA registers promotional identities under.`,
      { details: { promotional: registry.promotional } },
    )
  }

  if (registry.transactional.value.startsWith(PROMOTIONAL_SENDER_PREFIX)) {
    throw new AppError(
      'invariant_violated',
      `The transactional sender ID '${registry.transactional.value}' must not carry the ` +
        `'${PROMOTIONAL_SENDER_PREFIX}' prefix. A booking confirmation that arrives looking like an ` +
        'advert is what customers block.',
      { details: { transactional: registry.transactional } },
    )
  }

  return registry
}

/**
 * The registrations the build assumed, validated at import.
 *
 * Provisional: the real values are `Y6-sender-ids` in docs/OPEN-QUESTIONS.md, and registration is an
 * external dependency with a lead time (docs/05). They are a single constant so correcting them is one
 * edit, and `assertSenderIdRegistry` runs here so a wrong pair fails at boot rather than at 9pm.
 */
export const PROVISIONAL_SENDER_IDS: SenderIdRegistry = assertSenderIdRegistry({
  transactional: { value: 'BERELAX', messageClass: 'transactional' },
  promotional: { value: 'AD-BERELAX', messageClass: 'promotional' },
})

/** The identity for a class. The only way a sender ID is ever chosen. */
export function senderIdFor(
  registry: SenderIdRegistry,
  messageClass: MessageClass,
): SenderIdentity {
  const identity = registry[messageClass]
  if (identity.messageClass !== messageClass) {
    throw new AppError(
      'invariant_violated',
      `The ${messageClass} slot holds '${identity.value}', which is registered as ` +
        `${identity.messageClass}. Refusing to send rather than sending from the wrong identity.`,
      { details: { messageClass, identity } },
    )
  }
  return identity
}

// --- the transport seam ------------------------------------------------------------------------

/**
 * What the choke point needs from a channel transport.
 *
 * The sender identity is an argument because the choke point selects it. A transport that chose its
 * own would put the compliance decision back at the edge of the system, one file away from a
 * provider SDK.
 *
 * Implementations live in `src/transports/` and are the only modules in the repository permitted to
 * import a provider package — enforced by the `providers-only-inside-a-transport` rule in
 * `.dependency-cruiser.cjs`, with a known-bad fixture in `scripts/test-boundaries.mjs`.
 */
export interface TransportRequest {
  readonly message: OutboundMessage
  readonly senderId: SenderIdentity
  /** The same key must never produce a second message or a second charge. */
  readonly idempotencyKey: string
}

/**
 * Why a send did not leave.
 *
 * An alias rather than a second spelling of the union: the same four values are the value set of the
 * `message.last_failure_reason` CHECK in migration 0035, which `packages/db` needs and cannot get from
 * here, and the key of `MESSAGE_RETRY_POLICY` in `packages/core`, which cannot import this package
 * either. The list therefore lives in `@berelax/shared` as `MessageFailureReason`, and the name stays
 * `TransportFailure` here because that is what a transport returns. Two spellings of one vocabulary is
 * a retry policy keyed by a value the database will not store.
 */
export type TransportFailure = MessageFailureReason

export type TransportOutcome =
  | {
      readonly kind: 'accepted'
      readonly providerMessageId: string
      readonly segments: number
      readonly costFils: number
    }
  | { readonly kind: 'failed'; readonly reason: TransportFailure; readonly detail: string }

export interface ClassRoutedTransport {
  readonly channel: Channel
  send(request: TransportRequest): Promise<TransportOutcome>
}

// --- the campaign spend cap --------------------------------------------------------------------

/**
 * A campaign's spend, in fils.
 *
 * Checked *before* the send, because an SMS cannot be un-sent and a cap discovered on an invoice is
 * not a cap. Recorded from what the provider accepted rather than from the estimate, so the two can
 * be reconciled.
 */
export class CampaignSpend {
  readonly capFils: number
  private spent = 0

  constructor(capFils: number) {
    if (!Number.isInteger(capFils) || capFils < 0) {
      throw new AppError(
        'validation',
        `A campaign cap must be a whole number of fils, received ${capFils}. Money is integer fils; ` +
          'a float cap rounds a per-message check into a different answer every time.',
      )
    }
    this.capFils = capFils
  }

  get spentFils(): number {
    return this.spent
  }

  wouldExceed(fils: number): boolean {
    return this.spent + fils > this.capFils
  }

  record(fils: number): void {
    this.spent += fils
  }
}

// --- the request, the result, the context ------------------------------------------------------

/** A template as the choke point needs it: its own declaration plus the immutable class. */
export interface ClassifiedTemplate extends TemplateDefinition {
  readonly messageClass: MessageClass
}

/**
 * Everything a call site may say about a send.
 *
 * Deliberately no `senderId`, no `messageClass` and no `channel`. All three come from the template,
 * which is where the regulator's view of the message lives.
 */
export interface SendRequest {
  readonly id: MessageId
  readonly template: ClassifiedTemplate
  readonly values: TemplateValues
  /** E.164 for sms/whatsapp, an address for email. */
  readonly recipient: string
}

export type SendRefusal =
  | GateRefusal
  | 'blocked_unevaluable'
  | 'sender_id_class_mismatch'
  | 'campaign_cap_exceeded'
  | 'channel_has_no_transport'

export type SendResult =
  | {
      readonly kind: 'sent'
      readonly providerMessageId: string
      readonly senderId: string
      readonly segments: number
      readonly costFils: number
    }
  /** Held for the promotional window, with the instant it may leave at. Never dropped. */
  | {
      readonly kind: 'queued'
      readonly reason: 'queued_for_window'
      readonly releaseAtIso: string
    }
  /** Outside production, and the recipient is not allowlisted. In the local outbox, inspectable. */
  | { readonly kind: 'diverted'; readonly reason: string; readonly outboxRef: string }
  | {
      readonly kind: 'blocked'
      readonly reason: SendRefusal
      /** Which input could not be evaluated, for `blocked_unevaluable`; null otherwise. */
      readonly evaluator: GateEvaluatorName | null
      readonly detail: string
    }
  | { readonly kind: 'failed'; readonly reason: TransportFailure; readonly detail: string }

export interface SendContext {
  readonly appEnv: AppEnv
  readonly outboundAllowlist: readonly string[]
  readonly senderIds: SenderIdRegistry
  /** One per channel. A channel with no transport refuses rather than silently doing nothing. */
  readonly transports: readonly ClassRoutedTransport[]
  readonly outbox: InMemoryOutbox
  readonly clock: Clock
  readonly gate: GateContext
  readonly campaign?: CampaignSpend
}

const detailOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

/** `template.key:message.id`. The provider must not bill the same message twice on a retry. */
export function idempotencyKeyFor(message: OutboundMessage): string {
  return `${message.templateKey}:${message.id}`
}

/**
 * The message a request becomes, rendered.
 *
 * Exported for one caller: `lifecycle.ts`, which writes the durable row. The row stores the body, the
 * subject and the HTML part, and it must store the bytes the transport was given — so it calls this
 * rather than rendering the template a second time. Two renders of one template with one set of values
 * agree today and are two places to change tomorrow.
 */
export function outboundMessageFor(request: SendRequest): OutboundMessage {
  return buildMessage(request)
}

function buildMessage(request: SendRequest): OutboundMessage {
  const { template } = request
  const subject = renderSubject(template, request.values)
  return {
    id: request.id,
    channel: template.channel,
    // From the template, which is the only place it exists.
    messageClass: template.messageClass,
    recipient: request.recipient,
    body: renderTemplate(template, request.values),
    templateKey: template.key,
    locale: template.locale,
    ...(subject === undefined ? {} : { subject }),
  }
}

/**
 * Renders the subject against the placeholders the subject itself uses.
 *
 * The body's own render already validates every placeholder in body *and* subject against the
 * template's declaration, so this only has to supply values — but it has to supply them, because a
 * subject line reading "Your tax invoice " is a document nobody can find.
 */
function renderSubject(template: ClassifiedTemplate, values: TemplateValues): string | undefined {
  if (template.subject === undefined) return undefined
  return renderTemplate(
    { ...template, body: template.subject, variables: placeholdersIn(template.subject) },
    values,
  )
}

export async function sendMessage(ctx: SendContext, request: SendRequest): Promise<SendResult> {
  const instant: Instant = ctx.clock.now()
  const message = buildMessage(request)

  let senderId: SenderIdentity
  try {
    senderId = senderIdFor(ctx.senderIds, message.messageClass)
  } catch (error) {
    return {
      kind: 'blocked',
      reason: 'sender_id_class_mismatch',
      evaluator: null,
      detail: detailOf(error),
    }
  }

  const decision = evaluateGate(ctx.gate, message, instant)
  if (decision.kind === 'refuse' || decision.kind === 'unevaluable') {
    return {
      kind: 'blocked',
      reason: decision.reason,
      evaluator: decision.kind === 'unevaluable' ? decision.evaluator : null,
      detail: decision.detail,
    }
  }
  if (decision.kind === 'queue') {
    return { kind: 'queued', reason: decision.reason, releaseAtIso: decision.releaseAtIso }
  }

  const cost = costOf(message.channel, message.body)
  if (ctx.campaign?.wouldExceed(cost.costFils) === true) {
    return {
      kind: 'blocked',
      reason: 'campaign_cap_exceeded',
      evaluator: null,
      detail:
        `This message costs ${cost.costFils} fils (${cost.segments} ${cost.encoding} segment(s)) ` +
        `and the campaign has spent ${ctx.campaign.spentFils} of ${ctx.campaign.capFils}. ` +
        'Checked before the send, because an SMS cannot be un-sent.',
    }
  }

  const transport = ctx.transports.find((candidate) => candidate.channel === message.channel)
  if (transport === undefined) {
    return {
      kind: 'blocked',
      reason: 'channel_has_no_transport',
      evaluator: null,
      detail: `No transport is wired for channel '${message.channel}'.`,
    }
  }

  const guard = guardOutbound(
    { appEnv: ctx.appEnv, outboundAllowlist: ctx.outboundAllowlist },
    message,
  )
  if (guard.kind === 'divert') {
    const outboxRef = ctx.outbox.record(message, guard.reason, instantToIso(instant))
    return { kind: 'diverted', reason: guard.reason, outboxRef }
  }

  let outcome: TransportOutcome
  try {
    outcome = await transport.send({
      message,
      senderId,
      idempotencyKey: idempotencyKeyFor(message),
    })
  } catch (error) {
    // A transport that throws instead of returning an outcome is a bug in the transport. It must not
    // read as a send: the message did not necessarily leave, and "probably fine" is how a duplicate
    // charge or a missing OTP gets shipped.
    return { kind: 'failed', reason: 'provider_error', detail: detailOf(error) }
  }

  if (outcome.kind === 'failed') {
    return { kind: 'failed', reason: outcome.reason, detail: outcome.detail }
  }

  ctx.campaign?.record(outcome.costFils)
  return {
    kind: 'sent',
    providerMessageId: outcome.providerMessageId,
    senderId: senderId.value,
    segments: outcome.segments,
    costFils: outcome.costFils,
  }
}
