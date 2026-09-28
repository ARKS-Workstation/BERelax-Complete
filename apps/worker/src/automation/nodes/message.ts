import {
  type ConsentResolution,
  decideFrequencyCap,
  type FrequencyCap,
  frequencyLedgerHorizonSeconds,
  type Instant,
  instantFromIso,
  instantToIso,
  resolveConsent,
} from '@berelax/core'
import {
  claimNodeEffect,
  createPostgresMessageStore,
  type FrequencyLedgerAttribution,
  readConsentLogs,
  readCountedSendsByContact,
  readCurrentTemplate,
  readSuppressionLogs,
  recordFrequencyCapRefusal,
  recordSendWithLedger,
  type Sql,
  type SuppressionKeying,
} from '@berelax/db'
import {
  classifyTemplateRow,
  costOf,
  type DeliveryDeps,
  deliverMessage,
  type MessageId,
  type MessageLifecycleStore,
  promotionalGateEvaluators,
  type SendContext,
} from '@berelax/messaging'
import type { MessageChannel } from '@berelax/shared'
import { asConsentLog, asSuppressionLogs } from '../reads.ts'
import type { NodeContext, NodeEffect } from './effect.ts'

/**
 * `action_message`: the only node that talks to a vendor, and therefore the only one the idempotency token,
 * the compliance gate and the frequency ledger are about.
 *
 * ## The order of the five things it does, and why each is where it is
 *
 * 1. **Claim the token**, before anything else and before any vendor is asked. `flow_node_effect_once_per
 *    _contact` answers the question: no returned row means this job has been delivered before, and the
 *    outcome is the typed `duplicate` — which is what makes *"delivering the same job 50 times produces
 *    exactly one message row and 49 typed `duplicate` outcomes"* true at ONE statement rather than at a
 *    read somebody could race.
 * 2. **Read the template and judge it whole.** `classifyTemplateRow` narrows the row — the words, the
 *    channel, the locale, the approval state and the immutable CLASS — and nothing here restates any of
 *    them. C-AUTO-01's failure is a call site that says `messageClass: 'promotional'` about a
 *    transactional template, and `SendRequest` fences all three fields out with `?: never` so it cannot.
 * 3. **Prefetch this contact's consent, suppression and ledger, and build the three real evaluators.**
 *    `promotionalGateEvaluators` is C-AUTO-04's assembly and is used rather than three evaluators of our
 *    own, because three builders assembled twice is how the order and the failure behaviour come to differ
 *    between two senders.
 * 4. **Resolve consent a SECOND time, for the record id.** The gate reduces the resolution to a boolean;
 *    the step log needs the id the boolean rested on. Calling `resolveConsent` again is safe in a way two
 *    IMPLEMENTATIONS would not be — it is a pure fold over the same log at the same instant, so the two
 *    calls cannot disagree — and it is exactly what `frequency-ledger.itest.ts` does with
 *    `decideFrequencyCap` for the bound cap, for the same reason.
 * 5. **Send through `deliverMessage`, over a store that writes the frequency ledger row with the message
 *    row.** One transaction: the token, the message, the ledger row and the step log commit together.
 *
 * ## The window is not in this file, and that is an acceptance line
 *
 * Nothing here asks what time it is in Dubai. A promotional send outside the promotional window comes back
 * from `deliverMessage` as `{kind: 'held'}` with the instant the GATE named, and this node passes that
 * instant out untouched for the tick to schedule the release at. `packages/messaging/src/gate/window.ts`
 * states the reason in as many words: two implementations of quiet hours is the failure the acceptance line
 * is written against.
 *
 * ## Why a template that declares a variable is REFUSED rather than sent with a blank
 *
 * The DSL's `action_message` node carries a template key, a channel and a class, and no values — by design
 * (`schemas/flow.ts` is `.strict()`). So the interpreter has nothing to render `{{link}}` from, and
 * B-MSG-01's renderer refuses a blank for a declared variable precisely because *"Reminder: your booking
 * tomorrow at 19:00. Details or changes: "* sends successfully and is reported as delivered. A resolver
 * that supplied a review link or an offer code would be inventing a business fact nobody has stated (brief
 * rule 15). So a node whose template declares any variable is recorded as `refused` with
 * `template_variables_unresolved`, the flow carries on, and the step log says which variables were wanted.
 * The resolver belongs to C-AUTO-11, which owns the stock journeys that need the values.
 */

/**
 * The consent purpose a promotional flow send is gated on.
 *
 * `marketing` and not `review_request`, and it is the strictest of the two readings rather than the
 * convenient one (docs/12 §2): a contact who granted `review_request` and withheld `marketing` is refused
 * under this choice and permitted under the other. The DSL node carries no purpose field and deliberately
 * so — a per-node purpose would let a builder pick the gate its own message passes — and
 * `FLOW_CONDITION_FACTS` names `has_marketing_consent` and no review-request equivalent, which is the same
 * decision taken one file along. ADR 0040 records it.
 */
export const FLOW_PROMOTIONAL_CONSENT_PURPOSE = 'marketing'

export interface MessageNodeDeps {
  /** The send context, built over the tick's connection and this contact's prefetched reads. */
  readonly sendContextFor: (input: {
    readonly sql: Sql
    readonly evaluators: ReturnType<typeof promotionalGateEvaluators>
  }) => SendContext
  /** The caps in force, read from settings by the runtime rather than assumed here. */
  readonly caps: readonly FrequencyCap[]
  /**
   * The suppression peppers and normaliser, resolved LAZILY.
   *
   * A thunk, because `loadSuppressionPeppers` refuses loudly when the environment has no pepper — and a
   * worker that could not boot without one would be a worker that cannot run a booking reminder because
   * marketing is unconfigured. Resolved at the first promotional send instead, so the failure is a send
   * refused `blocked_unevaluable` naming `isSuppressed`, which is the gate failing closed rather than the
   * process failing to start.
   */
  readonly suppressionKeying: () => SuppressionKeying
  /**
   * What one template's body costs, for a DRY RUN's quotation.
   *
   * On this type rather than on the interpreter's, because the answer is `costOf` over the same body the
   * live send prices — and a dry run that priced a message differently from the run it predicts is the one
   * thing a quotation may not do. `null` for a template the estate does not hold, which the projection
   * records as an absent costing rather than as a cost of zero.
   */
  readonly priceTemplate: (input: {
    readonly templateKey: string
    readonly channel: MessageChannel
  }) => Promise<{
    readonly encoding: string
    readonly segments: number
    readonly costFils: number
  } | null>
}

interface MessageNodeSpec {
  readonly id: string
  readonly templateKey: string
  readonly channel: MessageChannel
  readonly messageClass: 'transactional' | 'promotional'
}

export async function executeMessageNode(
  context: NodeContext,
  node: MessageNodeSpec,
  deps: MessageNodeDeps,
): Promise<NodeEffect> {
  const key = {
    runId: context.run.runId,
    nodeId: node.id,
    channel: node.channel,
    contactCustomerId: context.customerId,
  }
  const claim = await claimNodeEffect(context.uow.sql, key, context.atIso)
  if (claim.kind === 'duplicate') {
    // The typed outcome, from the constraint. No vendor is asked, no message row is written, and the step
    // log records that this delivery of the job found the work already done.
    return effect({
      outcome: 'duplicate',
      channel: node.channel,
      templateKey: node.templateKey,
      detail:
        'An earlier delivery of this job already executed this node for this contact. ' +
        'flow_node_effect_once_per_contact refused the second claim.',
    })
  }

  const { sql } = context.uow
  const template = await readCurrentTemplate(sql, {
    key: node.templateKey,
    channel: node.channel,
    locale: context.facts.locale === 'ar' ? 'ar' : 'en',
  })
  if (template === undefined) {
    return effect({
      outcome: 'refused',
      channel: node.channel,
      templateKey: node.templateKey,
      gateDecision: 'no_variant',
      detail:
        `No current "${node.templateKey}" variant for ${node.channel}/${context.facts.locale}. The node ` +
        'is recorded refused rather than sent in another language: a message in a language the contact ' +
        'did not choose is not the message the operator drew.',
    })
  }
  const classified = classifyTemplateRow({ ...template, locale: template.locale })
  if (classified.kind !== 'template') {
    return effect({
      outcome: 'refused',
      channel: node.channel,
      templateKey: node.templateKey,
      gateDecision: 'template_unreadable',
      detail:
        `The "${node.templateKey}" row carries a vocabulary value this build cannot read, so its ` +
        'permissions are unknown and it is not sent under a guess.',
    })
  }
  if (classified.template.variables.length > 0) {
    // See the header. The values belong to C-AUTO-11's stock journeys; a blank would send successfully.
    return effect({
      outcome: 'refused',
      channel: node.channel,
      templateKey: node.templateKey,
      gateDecision: 'template_variables_unresolved',
      detail:
        `"${node.templateKey}" declares ${classified.template.variables.join(', ')} and a flow node ` +
        'carries no values. Sending it would either refuse at the renderer or deliver a sentence with a ' +
        'hole in it; the resolver belongs to the unit that owns the journeys needing those values.',
    })
  }

  const now = instantFromIso(context.atIso)
  const recipient = await recipientFor(sql, context.customerId)
  if (recipient === null) {
    return effect({
      outcome: 'refused',
      channel: node.channel,
      templateKey: node.templateKey,
      gateDecision: 'no_recipient',
      detail: 'The contact has no address for this channel, so there is nobody to send to.',
    })
  }

  // Keyed by CUSTOMER id here and re-keyed by RECIPIENT below, because the gate's three evaluators are all
  // keyed exactly as `message.recipient` spells it (`PromotionalGateReads` says so) while the stores are
  // keyed on the contact. Re-keying once, in one place, is what stops one of the three being looked up
  // under the wrong key — which would make it throw and the send `blocked_unevaluable`.
  const consentLogs = await readConsentLogs(sql, [context.customerId])
  const consentLog = consentLogs.get(context.customerId)
  if (consentLog === undefined) {
    // `readConsentLogs` seeds an empty log per contact asked about, so an absent entry means the read was
    // not about this contact at all. Fail closed and loudly rather than treat it as "no records".
    return effect({
      outcome: 'refused',
      channel: node.channel,
      templateKey: node.templateKey,
      gateDecision: 'blocked_unevaluable',
      detail:
        'The consent log read returned no entry for this contact, which is not the same as an empty log. ' +
        'The send is refused rather than evaluated against nothing.',
    })
  }
  const horizonSeconds = frequencyLedgerHorizonSeconds(deps.caps)
  const ledgerReadFrom = (now - horizonSeconds * 1000) as Instant
  const ledgerCountedAt = await readCountedSendsByContact(sql, {
    contactCustomerIds: [context.customerId],
    sinceIso: instantToIso(ledgerReadFrom),
    untilIso: context.atIso,
  })
  const suppressionLogs = await readSuppressionLogs(sql, deps.suppressionKeying(), [
    { keyKind: keyKindFor(node.channel), recipient },
  ])
  const narrowedConsent = asConsentLog(consentLog)
  const evaluators = promotionalGateEvaluators({
    reads: {
      consentLogs: new Map([[recipient, { ...narrowedConsent, contactId: recipient }]]),
      suppressionLogs: asSuppressionLogs(suppressionLogs),
      ledgerCountedAt: new Map([
        [recipient, (ledgerCountedAt.get(context.customerId) ?? []) as readonly Instant[]],
      ]),
      ledgerReadFrom,
    },
    purpose: FLOW_PROMOTIONAL_CONSENT_PURPOSE,
    at: now,
    caps: deps.caps,
  })

  // The SECOND resolution, for the record id the step log carries. A pure fold over the same log at the
  // same instant as the evaluator's, so the two cannot disagree.
  const resolution: ConsentResolution = resolveConsent(
    narrowedConsent,
    node.channel,
    FLOW_PROMOTIONAL_CONSENT_PURPOSE,
    now,
  )
  const consentRecordId = 'recordId' in resolution ? resolution.recordId : null

  const attribution: FrequencyLedgerAttribution = {
    contactCustomerId: context.customerId,
    sourceKind: 'flow',
    sourceRef: context.run.flowKey,
    // The (flow_run, node, channel, contact) key, which is what `frequency-ledger.ts` says this field
    // holds for a flow node: an at-least-once replay across a merge then folds onto one counted send.
    sendKey: sendKeyFor(key),
  }
  const delivery: DeliveryDeps = {
    store: ledgerBackedStore(sql, attribution, context.atIso),
    send: deps.sendContextFor({ sql, evaluators }),
    // A retry inside the tick would hold the run's row lock for the length of the declared backoff. The
    // queue is the thing that waits, which is `send-scheduled-step.ts`'s decision and for its reason.
    waitUntil: async () => {},
  }

  const outcome = await deliverMessage(delivery, {
    templateId: template.templateId,
    // Derived from the four-part key, so a replay after a worker was KILLED between the provider call and
    // the commit computes the SAME idempotency key — the fake derives the same provider message id from it
    // and suppresses the duplicate, which is the layer under the token when the token itself rolled back.
    id: sendKeyFor(key) as MessageId,
    template: classified.template,
    values: {},
    recipient,
  })

  // The authoring-time figures, computed by the same `costOf` the choke point prices the send with rather
  // than read off the variant row: a second source for "what does this body cost" is how a dry run's
  // quotation comes to disagree with the invoice it is supposed to predict.
  const priced = costOf(node.channel, classified.template.body)
  const costing = {
    encoding: priced.encoding,
    segments: priced.segments,
    costFils: priced.costFils,
  }

  if (outcome.kind === 'held') {
    return effect({
      outcome: 'held',
      channel: node.channel,
      templateKey: node.templateKey,
      messageId: outcome.message.id,
      consentRecordId,
      gateDecision: 'queued_for_window',
      ...costing,
      // The gate's instant, carried out untouched. The tick schedules the release at it.
      releaseAtIso: outcome.message.nextAttemptAtIso,
      detail: `Held for the promotional window until ${String(outcome.message.nextAttemptAtIso)}.`,
      pause: true,
    })
  }
  if (outcome.kind === 'not_sent') {
    // `not_sent` covers a gate refusal, a staging diversion and an expiry, and every one of them has a word
    // for itself. `sent` and `queued` cannot reach here — `deliverMessage` returns those as `sent`/`held` —
    // so the fallback names the kind rather than guessing at a reason it does not carry.
    const reason =
      outcome.result.kind === 'blocked' || outcome.result.kind === 'expired'
        ? outcome.result.reason
        : outcome.result.kind === 'diverted'
          ? 'diverted'
          : outcome.result.kind
    if (reason === 'refused_frequency_cap') {
      // The bound cap, recorded as it stood. `decideFrequencyCap` a second time over the same instants and
      // the same caps — the gate reduced it to a boolean and this recovers the figure, which is what makes
      // "why was this refused in March" answerable with March's limit rather than April's.
      const decision = decideFrequencyCap({
        messageClass: 'promotional',
        now,
        countedAt: (ledgerCountedAt.get(context.customerId) ?? []) as readonly Instant[],
        caps: deps.caps,
        countedSince: ledgerReadFrom,
      })
      if (decision.kind === 'capped') {
        await recordFrequencyCapRefusal(sql, {
          attribution,
          channel: node.channel,
          attemptedAtIso: context.atIso,
          boundCap: {
            key: decision.bound.cap.key,
            limit: decision.bound.cap.limit,
            windowSeconds: decision.bound.cap.windowSeconds,
            countInWindow: decision.bound.countInWindow,
          },
        })
      }
    }
    return effect({
      outcome: 'refused',
      channel: node.channel,
      templateKey: node.templateKey,
      consentRecordId,
      gateDecision: reason,
      ...costing,
      detail: `The send was refused: ${reason}.`,
    })
  }
  return effect({
    outcome: 'executed',
    channel: node.channel,
    templateKey: node.templateKey,
    messageId: outcome.message.id,
    consentRecordId,
    gateDecision: 'allow',
    ...costing,
    detail:
      outcome.kind === 'failed'
        ? `The vendor did not accept it: ${String(outcome.message.lastFailureReason)}.`
        : 'Sent.',
  })
}

/**
 * The message store the flow sends through: the message row AND the frequency ledger row, one transaction.
 *
 * This is the composition `frequency-ledger.itest.ts` describes as *"the composition C-AUTO-07 and
 * C-AUTO-10 will make"*. `recordSendWithLedger` writes into the transaction it is given (that file's own
 * `isTransaction` read is there for this), so a tick that rolls back leaves neither row — a message with no
 * ledger row is a promotional send that spent no allowance, and a ledger row with no message is an
 * allowance spent on nothing.
 */
function ledgerBackedStore(
  sql: Sql,
  attribution: FrequencyLedgerAttribution,
  attemptedAtIso: string,
): MessageLifecycleStore {
  const plain = createPostgresMessageStore(sql)
  return {
    recordSend: async (message, outcome, queuedAtIso) =>
      (
        await recordSendWithLedger(sql, {
          message,
          outcome,
          queuedAtIso,
          attemptedAtIso,
          attribution,
        })
      ).message,
    recordAttempt: (id, outcome) => plain.recordAttempt(id, outcome),
    applyReceipt: (receipt) => plain.applyReceipt(receipt),
  }
}

/** `flow:<run>:<node>:<channel>:<contact>`. The four-part key, as one string. */
export function sendKeyFor(key: {
  readonly runId: string
  readonly nodeId: string
  readonly channel: string
  readonly contactCustomerId: string
}): string {
  return `flow:${key.runId}:${key.nodeId}:${key.channel}:${key.contactCustomerId}`
}

/** The suppression key kind a channel is listed under. `phone` for sms/whatsapp, `email` for email. */
const keyKindFor = (channel: MessageChannel): string => (channel === 'email' ? 'email' : 'phone')

/** The contact's address for this channel. Only the phone exists in this schema today. */
async function recipientFor(sql: Sql, customerId: string): Promise<string | null> {
  const [row] = await sql<{ phone: string | null }[]>`
    select phone_e164 as phone from customer where id = ${customerId}::uuid
  `
  return row?.phone ?? null
}

/** Fills the fields a node effect leaves alone, so each branch above states only what it decided. */
function effect(
  partial: Partial<NodeEffect> & { readonly outcome: NodeEffect['outcome'] },
): NodeEffect {
  return {
    channel: null,
    templateKey: null,
    messageId: null,
    consentRecordId: null,
    gateDecision: null,
    encoding: null,
    segments: null,
    costFils: null,
    detail: null,
    releaseAtIso: null,
    pause: false,
    ...partial,
  }
}
