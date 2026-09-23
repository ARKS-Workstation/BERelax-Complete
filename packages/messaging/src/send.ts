/**
 * The single send choke point.
 *
 * Every outbound message in the system goes through `sendMessage`, in this order:
 *
 *  1. judge the template variant (`template.ts`) — approved, or refused with `no_variant`,
 *     `template_not_approved` or `outside_care_window`;
 *  2. resolve `message_class` from the **template**, never from the call site;
 *  3. select the sender identity registered for that (class, channel) pair, or refuse;
 *  4. run the promotional gate (`gate.ts`), which fails closed;
 *  5. compute encoding, segments and cost, and check the campaign spend cap;
 *  6. apply the staging send guard, then hand the message to the transport and record the provider id.
 *
 * ## Why there is no `senderId` on `SendRequest`
 *
 * The compliance decision that matters — which registered identity a message leaves from — is made from
 * the template's immutable class and its channel, and from nothing else. `SendRequest` therefore has no
 * `senderId`, no `messageClass` and no `channel`, and all three are *fenced out* with `?: never` rather
 * than merely absent, so a request assembled into a variable is refused as well as one written as a
 * literal. See the field comments there. A drag-and-drop flow builder is exactly where somebody will try
 * (docs/03 §5), and the type is what makes it impossible rather than discouraged.
 *
 * ## Why the template is judged before anything else
 *
 * An unapproved template is not sendable, and "not sendable" has to mean a refused send rather than the
 * absence of a call: a reader who proves it by showing nothing called the transport has proved something
 * about their own test. So `sendMessage` returns `blocked` with the template's own reason, the outcome is
 * recorded, and the reason says which of the four situations it was.
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
import { placeholdersIn, renderTemplate, type TemplateValues } from './render.ts'
import { guardOutbound } from './send-guard.ts'
import {
  resolveSenderIdentity,
  type SenderIdentity,
  type SenderIdentityRefusal,
  type SenderIdRegistry,
} from './sender-identity.ts'
import {
  type CareWindowState,
  judgeVariant,
  type TemplateVariant,
  type VariantRefusal,
} from './template.ts'

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
  /**
   * The registered identity, or `null` for a channel whose identity belongs to its transport.
   *
   * Nullable because `SENDER_IDENTITY_ROUTES` answers `delegated` for email: the verified sending
   * address is the transport's own configuration (Y6-email-sender), and handing an SMS transport's
   * `BERELAX` to it was how an SMS alphanumeric ended up in the `sender_id` column of an email row.
   * The SMS transport refuses a null rather than sending without one.
   */
  readonly senderId: SenderIdentity | null
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

/**
 * A template as the choke point needs it: one resolved variant plus the immutable class.
 *
 * One VARIANT and not a whole template, because choosing between variants is a decision about channels
 * and locales that has already been made by the time a send is requested — `resolveVariant` in
 * `template.ts` makes it, and `no_variant` is its refusal. What arrives here is the words, the channel,
 * the locale, the approval state and the class, which is exactly the set `sendMessage` decides from.
 *
 * `approvalState` is required and has no default. A template whose approval state could be omitted is a
 * template that is sendable by existing, which is the state migration 0014's `default 'draft'` and this
 * type both exist to refuse.
 */
export interface ClassifiedTemplate extends TemplateVariant {
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
  /**
   * The three fences, and they are not fields.
   *
   * `readonly x?: never` makes any object carrying the property unassignable to this type — not only an
   * object *literal*, which is all an excess-property check catches. That distinction is the whole value
   * of writing them out: `sendMessage(ctx, { ...base, messageClass: 'promotional' })` was already refused
   * by the excess-property rule, and
   *
   *     const request = { ...base, messageClass: 'promotional' }
   *     await sendMessage(ctx, request)
   *
   * was NOT — a variable is checked for assignability and not for extra keys, so the two-line version of
   * the same mistake compiled. A flow builder assembles its send request exactly that way (docs/03 §5).
   *
   * All three come from the template, which is where the regulator's view of the message lives: the
   * class is immutable on the template row, the channel is the variant's, and the identity is resolved
   * from the pair of them by `resolveSenderIdentity`. There is no argument a caller can pass to route
   * promotional content down the transactional identity, and `send.test.ts` asserts each of the three
   * fails to compile.
   */
  readonly messageClass?: never
  readonly senderId?: never
  readonly channel?: never
}

export type SendRefusal =
  | GateRefusal
  | 'blocked_unevaluable'
  /** The template's own refusals: not approved, no variant, and the WhatsApp care window. */
  | VariantRefusal
  /** No identity is registered for this (class, channel), or the registry may not be used. */
  | SenderIdentityRefusal
  | 'campaign_cap_exceeded'
  | 'channel_has_no_transport'

export type SendResult =
  | {
      readonly kind: 'sent'
      readonly providerMessageId: string
      /** `null` for a channel whose identity is its transport's. See `TransportRequest.senderId`. */
      readonly senderId: string | null
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
  /**
   * What is known about the recipient's last inbound WhatsApp message.
   *
   * Optional, and the default is the restrictive one — `{ lastInboundAt: null }`, no inbound ever, care
   * window shut. Nothing in this build receives an inbound WhatsApp message (there is no contracted
   * vendor), so that default is also the truth today rather than a convenience; a context that forgot to
   * supply it gets the answer that refuses a free-form send rather than the one that permits it.
   */
  readonly care?: CareWindowState
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

  // 1. May these words be sent at all? Before the identity and before the gate, because an unapproved
  //    template is not sendable however the registry is configured and whatever the recipient consented
  //    to — and because this is the one check that is about the template rather than about the send.
  //    `judgeVariant` is the same function `resolveVariant` ends in, so the refusal a caller gets when it
  //    resolves a template and the refusal it gets from here are one reading with one reason.
  const judged = judgeVariant({
    templateKey: request.template.key,
    variant: request.template,
    at: instant,
    care: ctx.care ?? { lastInboundAt: null },
  })
  if (judged.kind === 'refused') {
    return { kind: 'blocked', reason: judged.reason, evaluator: null, detail: judged.detail }
  }

  const message = buildMessage(request)

  // 2. The identity, from the (class, channel) pair and from nothing else. A refusal here is a refusal:
  //    the table never falls back to another pair's registration, because a promotional message leaving
  //    from the transactional identity is the send that gets that identity suspended.
  const resolved = resolveSenderIdentity(ctx.senderIds, message)
  if (resolved.kind === 'refused') {
    return {
      kind: 'blocked',
      reason: resolved.reason,
      evaluator: null,
      detail: resolved.detail,
    }
  }
  const senderId: SenderIdentity | null = resolved.kind === 'identity' ? resolved.identity : null

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
    senderId: senderId?.value ?? null,
    segments: outcome.segments,
    costFils: outcome.costFils,
  }
}
