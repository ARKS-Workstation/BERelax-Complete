import {
  ASIA_DUBAI,
  type CampaignEstimate,
  type ConsentResolution,
  campaignSendWindowVerdict,
  frequencyLedgerHorizonSeconds,
  type Instant,
  instantFromIso,
  instantToIso,
  resolveConsent,
  toLocal,
} from '@berelax/core'
import {
  type CampaignRecipientRow,
  claimCampaignRecipient,
  type FrequencyLedgerAttribution,
  haltCampaign,
  readConsentLogs,
  readCountedSendsByContact,
  readCurrentTemplate,
  readSuppressionLogs,
  type Sql,
  settleCampaignRecipient,
  withUnitOfWork,
} from '@berelax/db'
import {
  CampaignSpend,
  type ClassifiedTemplate,
  classifyTemplateRow,
  costOf,
  type DeliveryDeps,
  deliverMessage,
  type MessageId,
  promotionalGateEvaluators,
} from '@berelax/messaging'
import type { MessageChannel } from '@berelax/shared'
import {
  FLOW_PROMOTIONAL_CONSENT_PURPOSE,
  keyKindFor,
  ledgerBackedStore,
  type MessageNodeDeps,
  recipientFor,
} from './nodes/message.ts'
import { asConsentLog, asSuppressionLogs } from './reads.ts'

/**
 * The campaign drain: one claim, one send through the choke point, one settlement — repeated.
 *
 * C-AUTO-10. Everything compliance-relevant about a campaign send is already somewhere else, and that is
 * the shape of this file rather than a consequence of it:
 *
 *   - the SEND is `deliverMessage`, over `sendMessage` — the one choke point, where the template is
 *     judged, the sender identity is resolved, the gate is run and the staging guard diverts. A campaign
 *     that reached a transport another way is the defect `pnpm send-chokepoint` exists to make
 *     impossible, and this file reaches no transport at all;
 *   - the WINDOW is {@link campaignSendWindowVerdict} over `promotional-window.ts`. There is no second
 *     reading of 07:00–21:00 here and no hour written down;
 *   - the CAP is `claim_campaign_recipient`, which reserves and claims in one statement under the
 *     campaign row's lock. `CampaignSpend` is still handed to the choke point, built from the figures
 *     THIS loop read out of the campaign row — so the choke point's per-message `campaign_cap_exceeded`
 *     refusal still fires and there is one statement of the cap rather than two;
 *   - the LEDGER row is `ledgerBackedStore`, the same composition the flow interpreter uses, so a
 *     campaign send spends the contact's frequency allowance exactly as a journey send does.
 *
 * ## Why the window is checked per message and not once per drain
 *
 * The acceptance line is *"a campaign scheduled at 20:55 ... records zero sends after 21:00 and holds the
 * remainder rather than running past the boundary"*. A drain that checked the window once at the top
 * would pass that test on a fast machine and fail it on a slow one, which is the same thing as not
 * checking: the campaign was legitimately inside the window when it started, and the only instant that
 * can answer for the next message is the one immediately before it.
 *
 * ## Why the claim comes BEFORE the send and the settlement after
 *
 * An SMS cannot be un-sent. So the reservation is taken against the estimate first — if the cap binds, no
 * provider is called at all and the recipient is held — and the provider's own figure is reconciled
 * against the reservation afterwards. The window between them is the one thing the database cannot close,
 * and the recipient's `claimed` state is what names it: a row stuck in `claimed` is a message whose
 * outcome this build does not know, which is a visible fact rather than a lost one.
 */

/** How many recipients one drain will take before returning, so a tick is bounded. */
export const CAMPAIGN_DRAIN_CEILING = 500

export type CampaignDrainStop =
  /** Nothing left pending. */
  | { readonly kind: 'drained' }
  /** The cap bound mid-send. The remainder is held. */
  | { readonly kind: 'halted'; readonly reason: 'spend_cap_reached'; readonly held: number }
  /** The promotional window closed under the drain. The remainder is held. */
  | {
      readonly kind: 'halted'
      readonly reason: 'promotional_window_closed'
      readonly held: number
      readonly reopensAtIso: string
    }
  /** The drain ceiling was reached. More work remains and the caller should tick again. */
  | { readonly kind: 'ceiling_reached' }

export interface CampaignDrainResult {
  readonly stop: CampaignDrainStop
  readonly sent: number
  readonly held: number
  readonly failed: number
  /** What the provider accepted, in fils. Reconcilable against the estimate to the fils. */
  readonly spentFils: number
}

export interface CampaignSendInput {
  readonly campaignId: string
  readonly campaignKey: string
  readonly templateKey: string
  readonly channel: MessageChannel
  readonly capFils: number
  readonly spentFils: number
  /** The instant this drain is taken at. Injected, never the wall clock. */
  readonly atIso: string
  /** The promotional ceiling, read from `messaging.promotional_window` by the caller. */
  readonly window: { readonly startHour: number; readonly endHour: number }
  /** Whether the marketing kill switch is engaged, from its one home. Never a literal here. */
  readonly marketingKillSwitchEngaged: boolean
}

/**
 * Drain one campaign.
 *
 * The estimate is the per-message cost of THIS campaign's body, computed once: one campaign is one body,
 * so the reservation is the same number for every recipient and recomputing it per recipient would be the
 * same arithmetic in a place that invites a per-recipient adjustment. `estimateCampaign` in
 * `@berelax/core` is what the pre-launch figure came from and `costOf` is what the choke point prices
 * with; both end in `segments.ts`, so the estimate and the outcome agree to the fils by construction
 * rather than by comparison.
 */
export async function drainCampaign(
  sql: Sql,
  deps: MessageNodeDeps,
  input: CampaignSendInput,
): Promise<CampaignDrainResult> {
  const template = await readCurrentTemplate(sql, {
    key: input.templateKey,
    channel: input.channel,
    locale: 'en',
  })
  if (template === undefined) {
    throw new Error(
      `Campaign ${input.campaignKey} names template "${input.templateKey}" and no current version of it ` +
        'exists for this channel. Refusing rather than skipping: a campaign with no copy is a campaign ' +
        'whose recipients would be settled as failed for a reason that is not about them.',
    )
  }
  const classified = classifyTemplateRow(template)
  if (classified.kind !== 'template') {
    throw new Error(
      `Campaign ${input.campaignKey}'s template "${input.templateKey}" is not readable: ` +
        `${classified.column} = '${classified.value}'. The choke point would refuse every recipient for ` +
        'the same reason, so the drain refuses once instead of 200 times.',
    )
  }

  const perMessage = costOf(input.channel, classified.template.body)
  // The reservation. One figure for the whole campaign — see the function's note.
  const estimateFils = perMessage.costFils

  // The choke point's own cap check, over the figures the campaign ROW holds. Not a second cap: the
  // numbers come from the row the database enforces against, and the point of handing them over is that
  // `sendMessage` still refuses `campaign_cap_exceeded` by name rather than silently relying on this loop
  // having claimed correctly.
  const spend = new CampaignSpend(input.capFils, input.spentFils)

  let sent = 0
  let held = 0
  let failed = 0

  for (let drained = 0; drained < CAMPAIGN_DRAIN_CEILING; drained += 1) {
    const at = instantFromIso(input.atIso)

    // THE BOUNDARY, asked before every claim. See the header on why it is not asked once.
    const window = campaignSendWindowVerdict({
      at,
      local: toLocal(at, ASIA_DUBAI),
      zone: ASIA_DUBAI,
      ceiling: input.window,
    })
    if (window.kind === 'halt') {
      const halted = await withUnitOfWork(sql, CAMPAIGN_ACTOR, (uow) =>
        haltCampaign(uow, {
          campaignId: input.campaignId,
          reason: 'promotional_window_closed',
          detail: window.detail,
          at: new Date(at),
        }),
      )
      return {
        stop: {
          kind: 'halted',
          reason: 'promotional_window_closed',
          held: halted.held,
          reopensAtIso: instantToIso(window.reopensAt),
        },
        sent,
        held: held + halted.held,
        failed,
        spentFils: spend.spentFils - input.spentFils,
      }
    }

    const claimed = await claimCampaignRecipient(sql, {
      campaignId: input.campaignId,
      estimateFils,
    })
    if (claimed === null)
      return {
        stop: { kind: 'drained' },
        sent,
        held,
        failed,
        spentFils: spend.spentFils - input.spentFils,
      }

    if (claimed.state === 'held') {
      // The cap bound. No provider was called for this recipient and none will be for the remainder.
      const halted = await withUnitOfWork(sql, CAMPAIGN_ACTOR, (uow) =>
        haltCampaign(uow, {
          campaignId: input.campaignId,
          reason: 'spend_cap_reached',
          detail:
            `The reservation of ${estimateFils} fils would have taken this campaign past its cap of ` +
            `${input.capFils} fils. Held at recipient ${claimed.position}.`,
          at: new Date(at),
        }),
      )
      return {
        stop: { kind: 'halted', reason: 'spend_cap_reached', held: halted.held + 1 },
        sent,
        held: held + halted.held + 1,
        failed,
        spentFils: spend.spentFils - input.spentFils,
      }
    }

    const outcome = await sendOneRecipient(sql, deps, input, {
      claimed,
      at,
      spend,
      template: classified.template,
      perMessage,
      templateId: template.templateId,
    })
    if (outcome === 'sent') sent += 1
    else if (outcome === 'held') held += 1
    else failed += 1
  }

  return {
    stop: { kind: 'ceiling_reached' },
    sent,
    held,
    failed,
    spentFils: spend.spentFils - input.spentFils,
  }
}

/** The actor a campaign's writes are recorded under. The SURFACE, stated rather than invented. */
const CAMPAIGN_ACTOR = { kind: 'system' as const, label: 'Campaign sender' }

type RecipientOutcome = 'sent' | 'held' | 'failed'

/**
 * One recipient: prefetch, gate, send through the choke point, settle.
 *
 * The consent record id is recovered by resolving consent a SECOND time, which is `message.ts`'s
 * arrangement and for its reason: the gate reduces the resolution to a boolean and the row needs the id
 * the boolean rested on. Two CALLS of one pure fold over one log at one instant cannot disagree; two
 * implementations could.
 */
async function sendOneRecipient(
  sql: Sql,
  deps: MessageNodeDeps,
  input: CampaignSendInput,
  args: {
    readonly claimed: CampaignRecipientRow
    readonly at: Instant
    readonly spend: CampaignSpend
    readonly template: ClassifiedTemplate
    readonly perMessage: { readonly segments: number; readonly costFils: number }
    /** `message_template.id`, as `readCurrentTemplate` reports it. `message.template_id` references it. */
    readonly templateId: string
  },
): Promise<RecipientOutcome> {
  const { claimed, at } = args
  const recipient = await recipientFor(sql, claimed.customerId)
  if (recipient === null) {
    await settleCampaignRecipient(sql, {
      recipientId: claimed.id,
      state: 'held',
      costFils: null,
      segments: null,
      gateDecision: 'no_recipient',
      consentRecordId: null,
      heldReason: 'no_recipient',
    })
    return 'held'
  }

  const consentLogs = await readConsentLogs(sql, [claimed.customerId])
  const consentLog = consentLogs.get(claimed.customerId)
  if (consentLog === undefined) {
    // `readConsentLogs` seeds an empty log per contact asked about, so an absent entry means the read was
    // not about this contact at all. Fail closed, as `message.ts` does: an unread log is not a refusal.
    await settleCampaignRecipient(sql, {
      recipientId: claimed.id,
      state: 'held',
      costFils: null,
      segments: null,
      gateDecision: 'blocked_unevaluable',
      consentRecordId: null,
      heldReason: 'consent_log_unreadable',
    })
    return 'held'
  }

  const horizonSeconds = frequencyLedgerHorizonSeconds(deps.caps)
  const ledgerReadFrom = (at - horizonSeconds * 1000) as Instant
  const ledgerCountedAt = await readCountedSendsByContact(sql, {
    contactCustomerIds: [claimed.customerId],
    sinceIso: instantToIso(ledgerReadFrom),
    untilIso: input.atIso,
  })
  const suppressionLogs = await readSuppressionLogs(sql, deps.suppressionKeying(), [
    { keyKind: keyKindFor(input.channel), recipient },
  ])
  const narrowedConsent = asConsentLog(consentLog)

  // The three REAL evaluators, from C-AUTO-04's own assembly. Not three of this file's own: three
  // builders assembled twice is how the order and the failure behaviour come to differ between two
  // senders, and a campaign is the second sender.
  const evaluators = promotionalGateEvaluators({
    reads: {
      consentLogs: new Map([[recipient, { ...narrowedConsent, contactId: recipient }]]),
      suppressionLogs: asSuppressionLogs(suppressionLogs),
      ledgerCountedAt: new Map([
        [recipient, (ledgerCountedAt.get(claimed.customerId) ?? []) as readonly Instant[]],
      ]),
      ledgerReadFrom,
    },
    purpose: FLOW_PROMOTIONAL_CONSENT_PURPOSE,
    at,
    caps: deps.caps,
  })

  const resolution: ConsentResolution = resolveConsent(
    narrowedConsent,
    input.channel,
    FLOW_PROMOTIONAL_CONSENT_PURPOSE,
    at,
  )
  const consentRecordId = 'recordId' in resolution ? resolution.recordId : null

  const attribution: FrequencyLedgerAttribution = {
    contactCustomerId: claimed.customerId,
    sourceKind: 'campaign',
    sourceRef: input.campaignKey,
    sendKey: campaignSendKeyFor(input.campaignId, claimed.id),
  }

  const delivery: DeliveryDeps = {
    store: ledgerBackedStore(sql, attribution, input.atIso),
    send: {
      ...deps.sendContextFor({
        sql,
        evaluators,
        atIso: input.atIso,
        // From its one home, read by the caller and passed down. Never a literal in this file: a false
        // that looks like a read is the switch nobody notices is not wired.
        marketingKillSwitch: input.marketingKillSwitchEngaged,
      }),
      campaign: args.spend,
    },
    waitUntil: async () => {},
  }

  const outcome = await deliverMessage(delivery, {
    templateId: args.templateId,
    id: campaignSendKeyFor(input.campaignId, claimed.id) as MessageId,
    template: args.template,
    values: {},
    recipient,
  })

  if (outcome.kind === 'sent') {
    await settleCampaignRecipient(sql, {
      recipientId: claimed.id,
      state: 'sent',
      costFils: outcome.message.costFils ?? args.perMessage.costFils,
      segments: outcome.message.segments ?? args.perMessage.segments,
      // The verdict the choke point reached, as one column. The regulator's question is "on what basis
      // did this message go out", and a verdict split across two nullable columns is a question with two
      // places to look.
      gateDecision: 'allow',
      consentRecordId,
      heldReason: null,
    })
    return 'sent'
  }

  if (outcome.kind === 'held') {
    await settleCampaignRecipient(sql, {
      recipientId: claimed.id,
      state: 'held',
      costFils: null,
      segments: null,
      gateDecision: 'queued_for_window',
      consentRecordId,
      heldReason: 'queued_for_window',
    })
    return 'held'
  }

  if (outcome.kind === 'failed') {
    await settleCampaignRecipient(sql, {
      recipientId: claimed.id,
      state: 'failed',
      costFils: null,
      segments: null,
      gateDecision: 'provider_failed',
      consentRecordId,
      heldReason: null,
    })
    return 'failed'
  }

  // `not_sent`: a gate refusal, a staging diversion or an expiry. Every one of them is a HELD recipient
  // rather than a failed one, and the difference is the acceptance arithmetic: a refusal is about this
  // contact and reads the same tomorrow, so the campaign still owes them nothing and the row says why.
  const reason =
    outcome.result.kind === 'blocked' || outcome.result.kind === 'expired'
      ? outcome.result.reason
      : outcome.result.kind === 'diverted'
        ? 'diverted'
        : outcome.result.kind
  await settleCampaignRecipient(sql, {
    recipientId: claimed.id,
    state: 'held',
    costFils: null,
    segments: null,
    gateDecision: reason,
    consentRecordId,
    heldReason: reason,
  })
  return 'held'
}

/**
 * `campaign:<campaign>:<recipient>`. The idempotency key, derived rather than generated.
 *
 * Derived from the two ids so a worker killed between the provider call and the commit computes the SAME
 * key on its retry — the fake derives the same provider message id from it and suppresses the duplicate,
 * which is the layer under the claim when the claim itself rolled back.
 */
export function campaignSendKeyFor(campaignId: string, recipientId: string): string {
  return `campaign:${campaignId}:${recipientId}`
}

/** Both estimate figures a launch stores, from one {@link CampaignEstimate}. */
export const launchEstimateFrom = (
  estimate: CampaignEstimate,
): {
  readonly recipients: number
  readonly segmentsPerMessage: number
  readonly totalFils: number
} => ({
  recipients: estimate.recipients,
  segmentsPerMessage: estimate.segmentsPerMessage,
  totalFils: estimate.total.fils,
})
