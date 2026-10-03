import type { PaymentIntentEvent, PaymentIntentState } from '@berelax/core'
import { reduceIntent } from '@berelax/core'
import { AppError } from '@berelax/shared'

/**
 * Y-PAY-05 — what the gateway says, against what we recorded, and what to do about the difference.
 *
 * Pure: every figure is an argument, no clock is read and nothing here writes. The job is
 * `apps/worker/src/jobs/payment-reconciliation.ts`.
 *
 * ## This module exists because webhooks are LOST
 *
 * Y-PAY-04 makes a delivered event land exactly once. It can do nothing about an event that was never
 * delivered — a gateway outage, a deploy window, a 500 the endpoint answered for an unrelated reason, a
 * retry budget that ran out. From inside the system those are indistinguishable from an event that never
 * happened, and the symptom is a capture nobody recorded: the money is at the acquirer, the invoice reads
 * unpaid, and nothing anywhere is wrong.
 *
 * So the diff needs **both sides on file, each with its own instant**. A job that read only
 * `payment_intent` would be comparing our records with our records, and the one thing it could never find
 * is the event that never arrived. `gateway_state_observation` (migration 0148) is the gateway's answer,
 * stored with the instant WE asked at, and the exception row carries both sides — which is what makes a
 * repair auditable a month later rather than a figure that changed overnight.
 *
 * ## A divergence nobody can attribute is a QUARANTINE, never a silent fix
 *
 * The tempting implementation is "the gateway is the authority, so overwrite our figures with its". It is
 * refused, and not because the gateway is untrustworthy. `payment_intent`'s figures are a projection of
 * append-only transaction rows held equal to them at commit (`ZY163`, ADR 0056), so there is no UPDATE
 * that could write them without fabricating a gateway event — and a fabricated event is a lie about what
 * a third party did, in the one table a dispute is answered from.
 *
 * What a repair IS, therefore, is applying the EVENTS we missed. If the gateway's own event stream
 * explains the difference, the repair is exact and reproducible: the same events, folded by the same
 * `reduceIntent`, reaching the same state. If it does not — the figures differ and no missed event
 * accounts for it — the difference is **unattributable**, and ADR 0070's rule applies: a refusal, never a
 * zero and never a quiet correction. {@link planReconciliation} answers `quarantine`, the job writes an
 * exception and alerts, and a person decides.
 *
 * That is also why {@link divergenceOf} names the FIELDS rather than answering a boolean. "The intent
 * does not match" is not something anybody can act on; "captured is 21,000 here and 23,000 there" is.
 */

/** What this build holds for one intent. From `payment_intent` and its append-only rows. */
export interface LocalIntentPosition {
  readonly gatewayIntentId: string
  readonly state: PaymentIntentState
  readonly authorisedFils: number
  readonly capturedFils: number
  readonly refundedFils: number
  /** Every `gateway_event_id` already on `payment_intent_transaction`. */
  readonly knownEventIds: readonly string[]
}

/**
 * What the gateway says, as we observed it.
 *
 * `observedAt` is the instant WE asked, not an instant the gateway minted: a gateway's snapshot carries
 * its own `observedAt` on the port, and the two are kept apart on purpose. The port's instant says when
 * the gateway believes its answer was true; this one says when we were told. A reconciliation that
 * recorded only the first could not answer "how stale was the figure we repaired from".
 */
export interface GatewayObservation {
  readonly gatewayIntentId: string
  readonly state: PaymentIntentState
  readonly authorisedFils: number
  readonly capturedFils: number
  readonly refundedFils: number
  /** Epoch milliseconds, from the caller's clock. */
  readonly observedAtMs: number
}

/** The fields a divergence can be in. Named, because a boolean is not something anybody can act on. */
export const DIVERGENT_FIELDS = ['state', 'authorised', 'captured', 'refunded'] as const
export type DivergentField = (typeof DIVERGENT_FIELDS)[number]

export interface IntentDivergence {
  readonly gatewayIntentId: string
  /** In {@link DIVERGENT_FIELDS} order, so two reports of one divergence read the same. */
  readonly fields: readonly DivergentField[]
  readonly local: {
    readonly state: PaymentIntentState
    readonly authorisedFils: number
    readonly capturedFils: number
    readonly refundedFils: number
  }
  readonly gateway: {
    readonly state: PaymentIntentState
    readonly authorisedFils: number
    readonly capturedFils: number
    readonly refundedFils: number
  }
}

/**
 * Where the two sides disagree, field by field, or `null` when they agree exactly.
 *
 * To the fils, with no tolerance and nowhere to add one — Y-PAY-09's argument about a settlement applies
 * here for the same reason. A difference of a few fils between a gateway's ledger and ours is either a
 * missed event or money that went somewhere, and those are the same number; absorbed, the repair reports
 * success on every run and the figure it leaves behind reconciles against nothing.
 */
export function divergenceOf(
  local: LocalIntentPosition,
  gateway: GatewayObservation,
): IntentDivergence | null {
  if (local.gatewayIntentId !== gateway.gatewayIntentId) {
    throw new AppError(
      'invariant_violated',
      `divergenceOf was given a local position for ${local.gatewayIntentId} and a gateway observation ` +
        `for ${gateway.gatewayIntentId}. Comparing two intents produces a divergence in every field and ` +
        'a repair that would apply one intent’s events to another.',
    )
  }
  const fields = DIVERGENT_FIELDS.filter((field) => {
    if (field === 'state') return local.state !== gateway.state
    if (field === 'authorised') return local.authorisedFils !== gateway.authorisedFils
    if (field === 'captured') return local.capturedFils !== gateway.capturedFils
    return local.refundedFils !== gateway.refundedFils
  })
  if (fields.length === 0) return null
  return {
    gatewayIntentId: local.gatewayIntentId,
    fields,
    local: {
      state: local.state,
      authorisedFils: local.authorisedFils,
      capturedFils: local.capturedFils,
      refundedFils: local.refundedFils,
    },
    gateway: {
      state: gateway.state,
      authorisedFils: gateway.authorisedFils,
      capturedFils: gateway.capturedFils,
      refundedFils: gateway.refundedFils,
    },
  }
}

/**
 * The events the gateway has told us about and we have no transaction row for, oldest first.
 *
 * Ordered by the gateway's own instant, with `eventId` breaking a tie — `reduceIntent`'s own ordering,
 * because these events are about to be folded by it and a repair applied in a different order could
 * reach a state the fold would not.
 */
export function missedEvents(
  local: LocalIntentPosition,
  fromGateway: readonly PaymentIntentEvent[],
): readonly PaymentIntentEvent[] {
  const known = new Set(local.knownEventIds)
  return [...fromGateway]
    .filter((event) => !known.has(event.eventId))
    .sort(
      (a, b) =>
        a.occurredAt - b.occurredAt || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
    )
}

export const RECONCILIATION_ACTIONS = ['none', 'apply_missed_events', 'quarantine'] as const
export type ReconciliationAction = (typeof RECONCILIATION_ACTIONS)[number]

export interface ReconciliationPlan {
  readonly gatewayIntentId: string
  readonly action: ReconciliationAction
  /** Empty unless the action is `apply_missed_events`. */
  readonly missed: readonly PaymentIntentEvent[]
  /** The divergence as it stood BEFORE anything was applied. `null` when the two sides agreed. */
  readonly before: IntentDivergence | null
  /** What the position WOULD be once the missed events are folded. Null when nothing is applied. */
  readonly afterState: PaymentIntentState | null
  /** Why, in the words the exception row and the alert carry. */
  readonly reason: string
}

/**
 * What to do about one intent.
 *
 * Four answers, and the fourth is the one the unit is for:
 *
 * - **the sides agree and nothing is missing** — `none`. Not an exception row: a reconciliation that
 *   recorded every intent it looked at would make the exception table a log, and the acceptance line
 *   "a second consecutive run produces zero repairs" unassertable.
 * - **the sides agree and events are missing** — `apply_missed_events` anyway. This is a real state and
 *   it is worth stating: a `refunded` event that moves no figure we track still has to be ON FILE,
 *   because `payment_intent_transaction` is what a dispute is answered from and an intent whose rows do
 *   not add up to its header is `ZY163`'s own refusal.
 * - **the sides disagree and the missed events explain it** — `apply_missed_events`. The repair is the
 *   FOLD, not an overwrite: the same events through the same `reduceIntent`, so it is reproducible from
 *   the stored rows years later.
 * - **the sides disagree and nothing explains it** — `quarantine`. ADR 0070: an unattributable
 *   difference is a refusal, never a quiet correction. Overwriting the figures is impossible anyway —
 *   they are a projection held equal to the rows at commit — so the alternative to quarantining is
 *   fabricating a gateway event, which is a lie about a third party in the one table a dispute is
 *   answered from.
 *
 * `afterState` is computed by folding the whole set rather than by trusting the gateway's `state` field,
 * which is ADR 0056's division: the gateway says what happened and `reduceIntent` says which state that
 * reaches. A plan that believed the snapshot would silently accept an un-capture from a gateway that
 * disagreed with our table.
 */
export function planReconciliation(input: {
  readonly local: LocalIntentPosition
  readonly gateway: GatewayObservation
  /** Every event the gateway has told us about for this intent, in any order. */
  readonly fromGateway: readonly PaymentIntentEvent[]
  /** The events already on file, so the fold has the whole history. */
  readonly stored: readonly PaymentIntentEvent[]
}): ReconciliationPlan {
  const before = divergenceOf(input.local, input.gateway)
  const missed = missedEvents(input.local, input.fromGateway)

  if (missed.length === 0) {
    if (before === null) {
      return {
        gatewayIntentId: input.local.gatewayIntentId,
        action: 'none',
        missed: [],
        before: null,
        afterState: null,
        reason: 'the gateway and this build agree, to the fils, and no event is missing',
      }
    }
    return {
      gatewayIntentId: input.local.gatewayIntentId,
      action: 'quarantine',
      missed: [],
      before,
      afterState: null,
      reason:
        `the gateway and this build disagree on ${before.fields.join(', ')} and the gateway's own ` +
        'event stream contains nothing we have not already recorded, so the difference is attributable ' +
        'to no event. It is quarantined rather than corrected: the figures are a projection of ' +
        'append-only rows (ZY163), so writing them would mean fabricating a gateway event — a lie about ' +
        'a third party in the one table a dispute is answered from (ADR 0070, ADR 0101)',
    }
  }

  // Folded, not trusted. ADR 0056: the gateway says what happened, `reduceIntent` says what state that
  // reaches. A fold that throws here means the gateway's own stream is internally impossible, which is a
  // quarantine rather than a repair — applying half of it would leave a position neither side holds.
  let afterState: PaymentIntentState
  try {
    afterState = reduceIntent([...input.stored, ...missed]).state
  } catch (error) {
    return {
      gatewayIntentId: input.local.gatewayIntentId,
      action: 'quarantine',
      missed,
      before,
      afterState: null,
      reason:
        `the ${missed.length} event(s) the gateway has and this build does not cannot be folded onto the ` +
        `stored history: ${error instanceof Error ? error.name : 'the fold failed'}. Applying part of ` +
        'them would leave a position neither side holds, so the intent is quarantined',
    }
  }

  return {
    gatewayIntentId: input.local.gatewayIntentId,
    action: 'apply_missed_events',
    missed,
    before,
    afterState,
    reason:
      `${missed.length} event(s) the gateway sent and this build never recorded: ` +
      `${missed.map((event) => `${event.type}/${event.eventId}`).join(', ')}. ` +
      (before === null
        ? 'The figures already agreed, and the rows have to be on file anyway: payment_intent_transaction ' +
          'is what a dispute is answered from'
        : `They explain the difference in ${before.fields.join(', ')}`),
  }
}

/**
 * The plans that CHANGE something, which is what "the row count equals the number of consequential
 * dropped events" is counted over.
 *
 * `none` is excluded on purpose. A reconciliation that wrote a row for every intent it looked at would
 * make the exception table a log of runs rather than a register of divergences, and the acceptance line
 * about a second run producing zero repairs would be unassertable.
 */
export function consequentialPlans(
  plans: readonly ReconciliationPlan[],
): readonly ReconciliationPlan[] {
  return plans.filter((plan) => plan.action !== 'none')
}

/** The missed events a batch of plans will apply, summed. What a run reports and a test counts. */
export function missedEventCount(plans: readonly ReconciliationPlan[]): number {
  return plans
    .filter((plan) => plan.action === 'apply_missed_events')
    .reduce((total, plan) => total + plan.missed.length, 0)
}
