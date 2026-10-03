import {
  ALERT_EVENT_AGGREGATE_TYPE,
  ALERT_IDS,
  ALERT_OBSERVATION_WINDOW_HOURS,
  ALERT_RAISED_EVENT,
  ALERT_THRESHOLD_SETTING_KEYS,
  ALERT_THRESHOLD_UNREADABLE_EVENT,
  type AlertId,
  AUTH_FAILURE_WINDOW_MINUTES,
  STAFF_SESSION_REFUSED_ACTION,
} from '@berelax/shared'
import type { Sql } from './connection.ts'
import { publishEvent } from './outbox.ts'
import { readSetting } from './settings-store.ts'

/**
 * The reads behind every alert in `ALERT_REGISTRY`, and nothing else.
 *
 * ## One observer per registered alert, looked up by id
 *
 * {@link ALERT_OBSERVERS} is a `Record<AlertId, …>`, so an alert with no reader does not typecheck and a
 * reader with no alert does not either. That is the property the whole unit rests on: the registry is
 * what the alerting path READS rather than a document beside it, which is G-AGT-01's argument one level
 * up — a scheduled job names an `agent_definition` and `pnpm jobs` refuses one that does not, because a
 * cron nobody watches is indistinguishable from a cron that is working.
 *
 * ## Every observer returns a figure AND an incident key, and the key never contains the clock
 *
 * The figure is compared against the threshold by `@berelax/core`'s `evaluateAlert` — this module does no
 * arithmetic and makes no decision, because `packages/db` may not import `core` (ADR 0001) and a second
 * comparison here would be a second answer. The incident key is derived from the rows observed, so every
 * pass inside one incident computes the same value and the notification's idempotency key discards the
 * duplicate. A key containing `now()` would raise one notification per pass, which is `agent_alert`'s own
 * comment from the other side: ninety-six alerts for one broken agent, and the ninety-sixth is the one
 * nobody reads.
 *
 * That makes every `order by … limit 1` here a TOTAL order, with `id` as the last key. A tie leaves the
 * row PostgreSQL returns undefined, and the row is the incident key — so a tie is a key that flaps
 * between passes and raises a second notification for one situation, which is the defect the key exists
 * to prevent. `id` is `uuid_generate_v7()` on all four tables, so the tiebreak agrees with the time
 * column ahead of it rather than being arbitrary. This was found by running the suite twice rather than
 * by reading the queries, which is why rule "a suite that cannot run twice is a suite that leaks" earns
 * its place: the leak was append-only rows the first run left, and the defect it exposed was in the
 * production query and not in the test.
 *
 * ## A reader that cannot read must not return zero
 *
 * Every query here returns a figure or throws. None of them coalesces an error into `0`, because `0` is
 * "nothing is wrong" and it is the one answer a broken reader must not be able to give.
 */

/** What one observer answers. The shape `@berelax/core`'s `AlertObservation` consumes. */
export interface ObservedAlert {
  readonly alertId: AlertId
  readonly observed: number
  readonly incidentKey: string
  readonly detail: Readonly<Record<string, unknown>>
}

/**
 * What every observer is given.
 *
 * `tradingDate` is an ARGUMENT and not something this module computes, for two reasons that point the
 * same way. `resolveTradingDate` lives in `@berelax/core` and `packages/db` may never import it
 * (ADR 0001), and this schema has no `resolve_trading_date()` function to call instead — so a trading
 * date derived here would be a third implementation of a rule two already exist for. The caller computes
 * it once with core and hands it over, which also makes the boundary case testable without a clock:
 * trading runs 11:00-02:00, so at 01:30 the trading date is YESTERDAY and an obligation due yesterday is
 * not yet overdue.
 */
export interface AlertObservationContext {
  readonly nowIso: string
  /** `YYYY-MM-DD`, from `resolveTradingDate` in `@berelax/core`. */
  readonly tradingDate: string
}

type AlertObserver = (sql: Sql, at: AlertObservationContext) => Promise<ObservedAlert>

/**
 * The largest export in the last day, by the number of data subjects it covered.
 *
 * The LARGEST and not the most recent, which is the one decision in this query. Taking the most recent
 * would let a single-subject export arriving ten minutes after a bulk one clear the alert about the bulk
 * one — the alert would have fired, the operator would not necessarily have seen it, and the evidence
 * that it ever fired would be gone from the reading. Taking the maximum means the alert stands for the
 * whole day the bulk export happened in.
 *
 * `subject_count` and not `row_count`: 0085 ties `rights_export.alerted` to `subject_count` by a CHECK,
 * so a bulk export cannot be RECORDED as un-alerted. Counting rows instead would make a single subject
 * with four hundred bookings look like a bulk read.
 *
 * The `id` on the end of the ORDER BY is what makes the ordering TOTAL, and it is not decoration. Two
 * exports of the same size at the same instant are a tie, a tie leaves the row the planner returns
 * undefined, and the row IS the incident key — so the key would flap between passes and raise a second
 * notification for one situation, which is the exact defect the key exists to prevent. `id` is
 * `uuid_generate_v7()`, so `desc` is also "most recently inserted" and agrees with `exported_at desc`
 * rather than being an arbitrary tiebreak bolted on to make a query deterministic. Found by running
 * this unit's suite twice: the second run's export tied with the first run's and the first one won.
 */
const observeCustomerListExport: AlertObserver = async (sql, at) => {
  const [row] = await sql<{ subjectCount: number | null; exportId: string | null }[]>`
    select subject_count as "subjectCount", id as "exportId"
      from rights_export
     where exported_at > ${at.nowIso}::timestamptz - make_interval(hours => ${ALERT_OBSERVATION_WINDOW_HOURS})
     order by subject_count desc, exported_at desc, id desc
     limit 1
  `
  return {
    alertId: 'customer_list_export',
    observed: row?.subjectCount ?? 0,
    // The export's own id. One notification per export, for ever, whatever the pass schedule is.
    incidentKey: row?.exportId ?? 'none',
    detail: { exportId: row?.exportId ?? null, windowHours: ALERT_OBSERVATION_WINDOW_HOURS },
  }
}

/**
 * The age of the oldest unpublished outbox event, in seconds.
 *
 * `aggregate_type <> 'operational_alert'` is the load-bearing clause and it is not an optimisation. An
 * alert is published INTO this table, so an alert event waiting for its first drain is itself backlog —
 * and an alarm whose own output trips it rings for ever, with the lag climbing by one pass each time.
 * Excluding the aggregate type is how the measurement stays about the thing it is named after.
 */
const observeOutboxLag: AlertObserver = async (sql, at) => {
  const [row] = await sql<{ ageSeconds: string; oldestId: string | null; pending: string }[]>`
    select coalesce(extract(epoch from (${at.nowIso}::timestamptz - min(occurred_at)))::bigint, 0)::text
             as "ageSeconds",
           (select id from outbox_event
             where published_at is null and aggregate_type <> ${ALERT_EVENT_AGGREGATE_TYPE}
             order by occurred_at, id limit 1) as "oldestId",
           count(*)::text as pending
      from outbox_event
     where published_at is null
       and aggregate_type <> ${ALERT_EVENT_AGGREGATE_TYPE}
  `
  if (row === undefined) {
    throw new Error(
      'The outbox lag query returned no row, which an aggregate over an empty table cannot.',
    )
  }
  return {
    alertId: 'outbox_lag',
    observed: Number(row.ageSeconds),
    // The oldest event's id: stable for as long as that event is the blockage, and gone the moment it
    // publishes. That is what makes the alert clear by itself.
    incidentKey: row.oldestId ?? 'none',
    detail: { pending: Number(row.pending), oldestEventId: row.oldestId },
  }
}

/**
 * Messages queued and not yet accepted by a vendor.
 *
 * `status = 'queued'` is the whole condition. 0035's CHECK makes `sent` and `delivered` require a
 * provider id and a `sent_at`, so queued is exactly "nothing has accepted this", and a failed message is
 * deliberately NOT counted: a failure has a reason on the row and its own screen, and adding it here
 * would make the banner say "delayed" about something that will never arrive.
 */
const observeSendBacklog: AlertObserver = async (sql) => {
  const [row] = await sql<{ queued: string; oldestId: string | null }[]>`
    select count(*)::text as queued,
           (select id from message where status = 'queued' order by queued_at, id limit 1) as "oldestId"
      from message
     where status = 'queued'
  `
  if (row === undefined) {
    throw new Error(
      'The send backlog query returned no row, which an aggregate over an empty table cannot.',
    )
  }
  return {
    alertId: 'send_backlog',
    observed: Number(row.queued),
    incidentKey: row.oldestId ?? 'none',
    detail: { queued: Number(row.queued), oldestMessageId: row.oldestId },
  }
}

/**
 * The worst consecutive-failure streak across enabled agents.
 *
 * The maximum rather than a rate, and the reason is that a rate needs a denominator this build does not
 * record: `agent_heartbeat` carries the last outcome and the streak, not a count of attempts. A streak
 * is the honest measurement of the same failure — "running and failing every time" — and 0021's own
 * comment says why the column exists: a heartbeat that recorded only successes could not tell that case
 * apart from "not running at all", and those two need different people woken.
 */
const observeJobFailureRate: AlertObserver = async (sql) => {
  const rows = await sql<
    { agentKey: string; consecutiveFailures: number; lastFailureAt: Date | null }[]
  >`
    select h.agent_key as "agentKey",
           h.consecutive_failures as "consecutiveFailures",
           h.last_failure_at as "lastFailureAt"
      from agent_heartbeat h
      join agent_definition d on d.agent_key = h.agent_key
     where d.enabled
     order by h.consecutive_failures desc, h.agent_key
  `
  const worst = rows[0]
  return {
    alertId: 'job_failure_rate',
    observed: worst?.consecutiveFailures ?? 0,
    // The agent plus the instant of its last failure: the streak's identity. A further failure moves the
    // instant and raises a new notification, which is correct — the incident has got worse.
    incidentKey:
      worst === undefined
        ? 'none'
        : `${worst.agentKey}:${worst.lastFailureAt?.toISOString() ?? 'never'}`,
    detail: {
      failing: rows
        .filter((r) => r.consecutiveFailures > 0)
        .map((r) => ({ agentKey: r.agentKey, consecutiveFailures: r.consecutiveFailures })),
    },
  }
}

/**
 * Refused sign-ins on one credential inside the window.
 *
 * Grouped by `entity_id`, which is the `staff_credential` the attempt was made against — so "repeated
 * failures on ONE account" is what the figure means rather than "a lot of failures somewhere". The
 * sign-in route writes the row only when the staff reference resolved to a real credential; an unknown
 * handle writes nothing, deliberately, and `UNDEFENDED_BY_DESIGN` says why.
 *
 * `operation = 'denied'` as well as the action, and not instead of it: `denied` is in `ALWAYS_AUDITED`
 * and is written by a dozen other paths, so the action is what narrows this to sign-in.
 */
const observeRepeatedAuthFailure: AlertObserver = async (sql, at) => {
  const [row] = await sql<{ refusals: string; credentialId: string | null; lastAt: Date | null }[]>`
    select count(*)::text as refusals,
           entity_id as "credentialId",
           max(occurred_at) as "lastAt"
      from audit_event
     where action = ${STAFF_SESSION_REFUSED_ACTION}
       and operation = 'denied'
       and entity_id is not null
       and occurred_at > ${at.nowIso}::timestamptz - make_interval(mins => ${AUTH_FAILURE_WINDOW_MINUTES})
     group by entity_id
     order by count(*) desc, entity_id
     limit 1
  `
  return {
    alertId: 'repeated_auth_failure',
    observed: Number(row?.refusals ?? 0),
    // The credential plus the count. The count is in the key on purpose: a burst that grows past the
    // threshold again is a worse incident than the one already notified, and an operator who was told
    // about five refusals should be told about the fifteenth.
    incidentKey:
      row?.credentialId === undefined || row.credentialId === null
        ? 'none'
        : `${row.credentialId}:${row.refusals}`,
    detail: {
      credentialId: row?.credentialId ?? null,
      windowMinutes: AUTH_FAILURE_WINDOW_MINUTES,
      lastRefusalAt: row?.lastAt?.toISOString() ?? null,
    },
  }
}

/**
 * How many days past its due date the most overdue open blocking obligation is.
 *
 * `is_blocking` is 0052's GENERATED column and not a boolean anybody can switch: the migration's header
 * records that a blocking flag anything could turn off would be a flag that gets turned off, so the
 * consequence is an enum and the flag is derived from it. This query reads the derived column, which is
 * what makes the alert agree with the availability engine's own exclusion
 * (`overdueBlockingObligationExclusion`) rather than re-deciding what blocking means.
 *
 * The comparison is against the TRADING date supplied by the caller, never `current_date`: trading runs
 * 11:00-02:00, so at 01:30 the business is still working the previous trading date and an obligation due
 * that date is not yet overdue. The threshold is one day for exactly that reason.
 */
const observeOverdueBlockingObligation: AlertObserver = async (sql, at) => {
  const rows = await sql<
    { instanceId: string; obligationKey: string; dueOn: string; daysPastDue: number }[]
  >`
    select i.id as "instanceId",
           o.key as "obligationKey",
           i.due_on::text as "dueOn",
           (${at.tradingDate}::date - i.due_on)::int as "daysPastDue"
      from obligation_instance i
      join obligation o on o.id = i.obligation_id
     where i.status = 'open'
       and o.is_blocking
       and i.due_on < ${at.tradingDate}::date
     order by i.due_on, i.id
  `
  const worst = rows[0]
  return {
    alertId: 'overdue_blocking_obligation',
    observed: worst?.daysPastDue ?? 0,
    // The instance, not the count: one notification per overdue obligation, and a second obligation
    // falling overdue is a second incident rather than a louder version of the first.
    incidentKey: worst?.instanceId ?? 'none',
    detail: {
      overdue: rows.map((r) => ({
        obligationKey: r.obligationKey,
        dueOn: r.dueOn,
        daysPastDue: r.daysPastDue,
      })),
    },
  }
}

/**
 * One observer per registered alert.
 *
 * `satisfies Record<AlertId, AlertObserver>` and not a type annotation: the annotation would accept an
 * extra key, and `satisfies` refuses both directions — a missing observer and an observer for an alert
 * the registry does not declare. `alerts.itest.ts` asserts the same equality at runtime, because a
 * `Record` proves it for the tree that typechecks and says nothing about a tree where the type was
 * widened.
 */
export const ALERT_OBSERVERS = {
  customer_list_export: observeCustomerListExport,
  outbox_lag: observeOutboxLag,
  send_backlog: observeSendBacklog,
  job_failure_rate: observeJobFailureRate,
  repeated_auth_failure: observeRepeatedAuthFailure,
  overdue_blocking_obligation: observeOverdueBlockingObligation,
} satisfies Record<AlertId, AlertObserver>

/**
 * Every observation, in registry order.
 *
 * Sequential and not `Promise.all`, for the reason the brief's rule 1 gives about pool exhaustion: this
 * runs inside a worker pass beside everything else, six short queries cost nothing serialised, and a
 * fan-out that opened six connections would be six more than the pass needs.
 */
export async function observeAlerts(
  sql: Sql,
  at: AlertObservationContext,
): Promise<readonly ObservedAlert[]> {
  const observations: ObservedAlert[] = []
  for (const id of ALERT_IDS) {
    const observer = ALERT_OBSERVERS[id]
    observations.push(await observer(sql, at))
  }
  return observations
}

/**
 * The threshold settings, read through the one read path.
 *
 * `readSetting` checks the key against the F09 registry and throws on an undeclared one, and falls back
 * to the registry's declared default when no `app_setting` row exists — so a freshly migrated database
 * behaves exactly like a seeded one. What it cannot do is turn a corrupt stored value into a number, and
 * that is deliberate: `resolveAlertThreshold` in `@berelax/core` answers `threshold_unreadable` for one,
 * because an alert reporting all-clear because its own configuration is broken is the one outcome
 * nothing would notice.
 */
export async function readAlertThresholdSettings(sql: Sql): Promise<ReadonlyMap<string, unknown>> {
  const entries = new Map<string, unknown>()
  for (const key of ALERT_THRESHOLD_SETTING_KEYS) {
    entries.set(key, await readSetting<unknown>(sql, key))
  }
  return entries
}

/**
 * Records one firing alert as an outbox event, and reports whether it was new.
 *
 * `null` means the idempotency key was already there: this incident has already been notified and the
 * pass has nothing to do. That is the same contract `raiseAlert` has for `agent_alert`, expressed with
 * the mechanism that already exists rather than with a second table — see
 * `ALERT_RAISED_EVENT`'s comment for why the firing STATE is derived and only the notification is
 * stored.
 */
export async function raiseAlertNotification(
  tx: Sql,
  firing: {
    readonly alertId: string
    readonly severity: string
    readonly runbook: string
    readonly observed: number
    readonly threshold: number
    readonly incidentKey: string
    readonly detail: Readonly<Record<string, unknown>>
  },
): Promise<string | null> {
  return await publishEvent(tx, {
    eventType: ALERT_RAISED_EVENT,
    aggregateType: ALERT_EVENT_AGGREGATE_TYPE,
    aggregateId: firing.alertId,
    payload: {
      alertId: firing.alertId,
      severity: firing.severity,
      runbook: firing.runbook,
      observed: firing.observed,
      threshold: firing.threshold,
      incidentKey: firing.incidentKey,
      detail: firing.detail,
    },
    idempotencyKey: `alert:${firing.alertId}:${firing.incidentKey}`,
  })
}

/**
 * Records a threshold nobody can read.
 *
 * A separate event type from a firing alert, because they need different people: a firing alert is an
 * operational problem and this is a configuration fault. Collapsing them would put "the outbox has
 * stopped" and "somebody typed a word into a number field" on the same screen with the same words.
 *
 * The idempotency key carries the setting key and the reason, so the same broken value is notified once
 * and a differently broken one is notified again.
 */
export async function raiseAlertThresholdFault(
  tx: Sql,
  fault: { readonly alertId: string; readonly settingKey: string; readonly reason: string },
): Promise<string | null> {
  return await publishEvent(tx, {
    eventType: ALERT_THRESHOLD_UNREADABLE_EVENT,
    aggregateType: ALERT_EVENT_AGGREGATE_TYPE,
    aggregateId: fault.alertId,
    payload: { alertId: fault.alertId, settingKey: fault.settingKey, reason: fault.reason },
    idempotencyKey: `alert_fault:${fault.alertId}:${fault.settingKey}:${fault.reason}`,
  })
}
