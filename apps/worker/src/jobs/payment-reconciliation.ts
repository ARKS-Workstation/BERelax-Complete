import type {
  GatewayEventCursor,
  GatewayIntentId,
  IdempotencyKey,
  PaymentGateway,
  PaymentIntentEvent,
} from '@berelax/core'
import {
  closeReconciliationRun,
  openReconciliationRun,
  readIntentPositions,
  readPaymentIntentTransactions,
  readReconciliationWatermark,
  recordGatewayObservation,
  recordReconciliationException,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { applyGatewayEvents, planReconciliation, type ReconciliationPlan } from '@berelax/payments'
import { AppError } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * Y-PAY-05 — the pass that makes the ledger eventually correct when a webhook was never delivered.
 *
 * Y-PAY-04 makes a delivered event land exactly once. It can do nothing about an event that never
 * arrived: a gateway outage, a deploy window, a 500 the endpoint answered for an unrelated reason, a
 * retry budget that ran out. From inside the system those are indistinguishable from an event that never
 * happened, and the symptom is a capture nobody recorded — the money is at the acquirer, the invoice
 * reads unpaid, and nothing anywhere is wrong.
 *
 * ## The pass reads BOTH sides, and that is the point
 *
 * `eventsSince(cursor)` gives the gateway's own stream from a durable watermark; `fetchIntent` gives its
 * answer for each intent, which is stored as a `gateway_state_observation` with the instant WE asked at.
 * A pass that read only `payment_intent` would be comparing our records with our records, and the one
 * thing it could never find is the event that never arrived.
 *
 * ## A repair is an APPLIED EVENT, never an overwrite
 *
 * `payment_intent`'s three figures are a projection of append-only transaction rows held equal to them at
 * commit (`ZY163`, ADR 0056), so there is no UPDATE that could write them without fabricating a gateway
 * event — a lie about what a third party did, in the one table a dispute is answered from. So a repair
 * applies the events the gateway's stream contains and this build is missing, through the same
 * `applyGatewayEvents` the webhook uses, and is therefore reproducible from the stored rows years later.
 *
 * A divergence NOTHING explains is quarantined and alerted, never corrected (ADR 0070, ADR 0101).
 *
 * ## Why one transaction per intent
 *
 * Not one per pass, and not one per statement. Per pass, an interruption rolls back every repair already
 * made and the next run redoes all of them — correct, because they are idempotent, but it means the
 * acceptance line about a kill mid-run is satisfied by doing nothing at all, which proves nothing. Per
 * statement, an intent could commit its observation and die before its exception, leaving a repaired
 * figure with nothing explaining it.
 *
 * Per intent is the grain at which the work is actually idempotent: the events are keyed on
 * `unique (payment_intent_id, gateway_event_id)`, so re-applying one is a no-op, and a pass that died
 * halfway has committed exactly the repairs it reported. The WATERMARK is what stops the window being
 * skipped: it advances only when the run closes, so an interrupted pass re-reads its own window and the
 * second pass records no exception for the repairs it finds already made.
 */

export const PAYMENT_RECONCILIATION_JOB = 'payments.reconciliation'
export const PAYMENT_RECONCILIATION_AGENT = 'payment_reconciliation'

export interface ReconciliationDeps {
  readonly sql: Sql
  readonly gateway: PaymentGateway
  /** The adapter name `payment_intent.gateway` holds. The port's `name` is branded; this is the column. */
  readonly gatewayName: string
  /** Injected, so a suite pins it. A job body never reads the clock itself. */
  readonly now: () => number
  /**
   * The intents to examine, for a SUITE only.
   *
   * The pass reads the whole population. A suite that did the same would reconcile every other suite's
   * fixture intents into tables that refuse DELETE for every role (brief rule 12), so a suite narrows and
   * the pass does not — and `narrowTo` being absent in the job definition below is what keeps that true.
   */
  readonly narrowTo?: readonly string[]
}

export interface ReconciliationReport {
  readonly runId: string
  readonly cursorFrom: string | null
  readonly cursorTo: string | null
  readonly intentsExamined: number
  readonly repairs: number
  readonly quarantines: number
  /** Every missed event actually applied, summed. What "consequential dropped events" counts. */
  readonly eventsApplied: number
}

/**
 * Runs one pass.
 *
 * Exported so a suite drives the same code the cron does, with its own connection, its own fake gateway
 * and a pinned clock.
 */
export async function runPaymentReconciliation(
  deps: ReconciliationDeps,
): Promise<ReconciliationReport> {
  const cursorFrom = await readReconciliationWatermark(deps.sql, deps.gatewayName)
  const runId = await openReconciliationRun(deps.sql, deps.gatewayName, cursorFrom)

  // The gateway's stream FIRST, so the window a run reports is the one it read. Reading per intent would
  // make the cursor meaningless: there would be no single point the pass had got to.
  const deliveries = await deps.gateway.eventsSince(
    cursorFrom === null ? null : (cursorFrom as GatewayEventCursor),
  )
  let cursorTo = cursorFrom
  const byIntent = new Map<string, PaymentIntentEvent[]>()
  for (const delivery of deliveries) {
    const existing = byIntent.get(delivery.gatewayIntentId)
    if (existing === undefined) byIntent.set(delivery.gatewayIntentId, [delivery.event])
    else existing.push(delivery.event)
    // The LARGEST cursor seen, not the last. The port guarantees a monotone bookmark and `eventsSince`
    // answers oldest first, so the two agree — and taking the maximum means a gateway that answered out
    // of order could not move the watermark backwards, which `ZY684` would refuse at the close anyway.
    if (cursorTo === null || delivery.cursor > cursorTo) cursorTo = delivery.cursor
  }

  const positions = await readIntentPositions(deps.sql, deps.gatewayName, deps.narrowTo)
  let repairs = 0
  let quarantines = 0
  let eventsApplied = 0

  for (const position of positions) {
    const outcome = await reconcileOneIntent(deps, runId, position, byIntent)
    if (outcome.kind === 'repaired') {
      repairs += 1
      eventsApplied += outcome.eventsApplied
    }
    if (outcome.kind === 'quarantined') quarantines += 1
  }

  await closeReconciliationRun(deps.sql, {
    runId,
    cursorTo,
    intentsExamined: positions.length,
    repairs,
    quarantines,
  })

  return {
    runId,
    cursorFrom,
    cursorTo,
    intentsExamined: positions.length,
    repairs,
    quarantines,
    eventsApplied,
  }
}

type IntentOutcome =
  | { readonly kind: 'in_step' }
  | { readonly kind: 'repaired'; readonly eventsApplied: number }
  | { readonly kind: 'quarantined' }

/** One intent, in one transaction. See the module note on why that is the grain. */
async function reconcileOneIntent(
  deps: ReconciliationDeps,
  runId: string,
  position: Awaited<ReturnType<typeof readIntentPositions>>[number],
  byIntent: ReadonlyMap<string, readonly PaymentIntentEvent[]>,
): Promise<IntentOutcome> {
  const gatewayIntentId = position.gatewayIntentId
  // The gateway's answer, OUTSIDE the transaction: it is a network call, and holding a transaction open
  // across one is how a pass over five hundred intents holds five hundred locks for the length of five
  // hundred round trips.
  const snapshot = await fetchOrNull(deps.gateway, gatewayIntentId)
  const observedAtIso = new Date(deps.now()).toISOString()

  return await withUnitOfWork(
    deps.sql,
    { kind: 'system', label: PAYMENT_RECONCILIATION_JOB },
    async (uow) => {
      const observationId = await recordGatewayObservation(uow, {
        gateway: deps.gatewayName,
        gatewayIntentId,
        // An unrecognised intent is recorded with the state WE hold, because the gateway offered none and
        // a stand-in state would be a claim it never made. The `recognised` flag is what says which.
        state: snapshot === null ? position.state : snapshot.state,
        authorisedFils: snapshot?.authorised.fils ?? 0,
        capturedFils: snapshot?.captured.fils ?? 0,
        refundedFils: snapshot?.refunded.fils ?? 0,
        observedAtIso,
        recognised: snapshot !== null,
      })

      if (snapshot === null) {
        // The acceptance line: quarantined and alerted, never silently deleted. Nothing here deletes
        // anything — `ZY161` already refuses a transaction DELETE for every role, so an intent that
        // touched money is undeletable; this is what makes the state VISIBLE rather than merely safe.
        await recordReconciliationException(uow, {
          runId,
          paymentIntentId: position.id,
          gatewayIntentId,
          observationId,
          kind: 'quarantined',
          before: {
            gatewayIntentId,
            fields: ['state'],
            local: {
              state: position.state,
              authorisedFils: position.authorisedFils,
              capturedFils: position.capturedFils,
              refundedFils: position.refundedFils,
            },
            gateway: null,
          },
          after: null,
          missedEventIds: [],
          detail:
            `the gateway does not recognise intent ${gatewayIntentId} at all, and this build holds it ` +
            `as "${position.state}" with ${position.capturedFils} fils captured. It is quarantined and ` +
            'alerted, never deleted: either the intent was created against another merchant account ' +
            '(0106 removed the uniqueness that would have caught that, because no account has been ' +
            'chosen) or a figure here has no counterparty at all, and both need a person.',
        })
        return { kind: 'quarantined' } as const
      }

      const stored = (await readPaymentIntentTransactions(uow.sql, position.id)).map((row) => ({
        eventId: row.gatewayEventId,
        type: row.gatewayEventType as PaymentIntentEvent['type'],
        occurredAt: row.occurredAt.getTime() as PaymentIntentEvent['occurredAt'],
        ...(row.amountFils > 0
          ? { amount: { fils: row.amountFils as never, currency: 'AED' as const } }
          : {}),
      }))

      const plan = planReconciliation({
        local: {
          gatewayIntentId,
          state: position.state as never,
          authorisedFils: position.authorisedFils,
          capturedFils: position.capturedFils,
          refundedFils: position.refundedFils,
          knownEventIds: position.knownEventIds,
        },
        gateway: {
          gatewayIntentId,
          state: snapshot.state,
          authorisedFils: snapshot.authorised.fils,
          capturedFils: snapshot.captured.fils,
          refundedFils: snapshot.refunded.fils,
          observedAtMs: deps.now(),
        },
        fromGateway: byIntent.get(gatewayIntentId) ?? [],
        stored,
      })

      if (plan.action === 'none') return { kind: 'in_step' } as const

      if (plan.action === 'quarantine') {
        await recordReconciliationException(uow, {
          runId,
          paymentIntentId: position.id,
          gatewayIntentId,
          observationId,
          kind: 'quarantined',
          before: plan.before,
          after: null,
          missedEventIds: plan.missed.map((event) => event.eventId),
          detail: plan.reason,
        })
        return { kind: 'quarantined' } as const
      }

      const applied = await applyGatewayEvents(uow, position.id, plan.missed, {
        // Named after the RUN and the intent, so a repair's idempotency key says which pass made it. A
        // fresh key per attempt would make two passes two different claims on the gateway's side.
        idempotencyKey: `reconcile:${runId}:${gatewayIntentId}` as IdempotencyKey,
        gatewayIntentId: gatewayIntentId as GatewayIntentId,
      })
      if (applied.length === 0) {
        // Nothing moved after all: another writer applied the same events between the read and here. Not
        // an exception — `ZY682` would refuse a repair naming events that did not need applying, and
        // recording one would make "a second run produces zero repairs" false for a correct system.
        return { kind: 'in_step' } as const
      }
      await recordReconciliationException(uow, {
        runId,
        paymentIntentId: position.id,
        gatewayIntentId,
        observationId,
        kind: 'repaired',
        before: plan.before,
        after: { state: plan.afterState, applied: applied.map((row) => row.gatewayEventId) },
        missedEventIds: applied.map((row) => row.gatewayEventId),
        detail: plan.reason,
      })
      return { kind: 'repaired', eventsApplied: applied.length } as const
    },
  )
}

/**
 * The gateway's answer, or `null` when it does not recognise the intent.
 *
 * `null` and not a throw, because "the gateway has never heard of this" is an ANSWER and the acceptance
 * line is about recording it. Every other failure is re-thrown: a network error is not a statement about
 * the intent, and treating one as "unrecognised" would quarantine the whole population during an outage.
 */
async function fetchOrNull(
  gateway: PaymentGateway,
  gatewayIntentId: string,
): Promise<Awaited<ReturnType<PaymentGateway['fetchIntent']>> | null> {
  try {
    return await gateway.fetchIntent(gatewayIntentId as GatewayIntentId)
  } catch (error) {
    if (error instanceof AppError && error.kind === 'not_found') return null
    // The fake raises a plain `Error` naming the id for an intent it does not hold. Matched on the NAME
    // of the condition rather than on the message text where the error carries one.
    if (error instanceof Error && /unknown|not found|no such/i.test(error.message)) return null
    throw error
  }
}

let runtime: ReconciliationDeps | undefined

/**
 * The dependencies, supplied at boot.
 *
 * A module-level binding for `setMediaStorage`'s reason: `JOB_REGISTRY` is a module constant `pnpm jobs`
 * imports and enumerates WITHOUT a database or a gateway, so making a handler's dependencies constructor
 * arguments would turn the registry into a function — at which point "every job this system runs is
 * declared in one array" stops being checkable statically.
 */
export function setPaymentReconciliationRuntime(deps: ReconciliationDeps): void {
  runtime = deps
}

const reconciliationHandler = async (_data: never, _context: JobContext): Promise<void> => {
  if (runtime === undefined) {
    throw new AppError(
      'invariant_violated',
      'The payment reconciliation pass has no gateway. `setPaymentReconciliationRuntime` is called at ' +
        'boot; a pass that ran without one would read no gateway state at all and would therefore ' +
        'report every intent as in step — the one failure mode this unit exists to remove.',
    )
  }
  await runPaymentReconciliation(runtime)
}

export const PAYMENT_RECONCILIATION_JOB_DEFINITION: JobDefinition<never> = {
  name: PAYMENT_RECONCILIATION_JOB,
  purpose:
    "Pulls the gateway's own event stream since a durable watermark, diffs it against the intents this " +
    'build recorded, applies the events a lost webhook never delivered, and quarantines any divergence ' +
    'nothing explains. Webhooks are at-least-once and sometimes zero-times; this is what makes the ' +
    'ledger eventually correct anyway (Y-PAY-05, ADR 0101).',
  // Hourly at minute 20, Asia/Dubai. Hourly rather than nightly because the gap between a lost capture
  // and its repair is a window in which an invoice reads unpaid and a customer is chased for money they
  // have already handed over; and at :20 rather than :00 so it does not contend with the liveness check
  // that runs on the hour. `registerJobs` passes the zone to pg-boss rather than this file computing an
  // offset.
  cron: '20 * * * *',
  agent: PAYMENT_RECONCILIATION_AGENT,
  retryLimit: 2,
  retryDelaySeconds: 300,
  retryBackoff: true,
  // One stream read plus one gateway call and one short transaction per intent. Ten minutes is generous
  // for this population; a pass still running past it is blocked rather than slow, and reclaiming it is
  // safe — the watermark only advances on a clean close, so the next pass re-reads the same window and
  // the repairs already made are no-ops.
  expireInSeconds: 600,
  handler: reconciliationHandler,
}

export type { ReconciliationPlan }
