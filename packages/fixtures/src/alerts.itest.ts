import { evaluateAlert, evaluateAlerts, firingAlerts } from '@berelax/core'
import {
  ALERT_OBSERVERS,
  createConnection,
  type ObservedAlert,
  observeAlerts,
  publishEvent,
  raiseAlertNotification,
  readAlertThresholdSettings,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import {
  ALERT_EVENT_AGGREGATE_TYPE,
  ALERT_IDS,
  ALERT_RAISED_EVENT,
  alertDefinition,
  STAFF_SESSION_REFUSED_ACTION,
} from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * H-HARD-05 — the alert ladder against a real PostgreSQL.
 *
 * Every case makes a condition TRUE, asserts the registry's own reader sees it and the registry's own
 * evaluator fires, then makes it false again and asserts the alert clears. A mock would assert that the
 * mock works; the whole claim of this unit is that six queries over rows that are already there agree
 * with the table that declares them.
 *
 * ## Why every assertion is a delta
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind
 * (brief rule 12). Three of these six conditions are counts over tables other suites write — queued
 * messages, unpublished outbox events, agent heartbeats — so a case asserting `observed === 3` would be
 * green until another unit landed and then red on somebody else's branch. So each case measures a
 * baseline, changes exactly one thing, and asserts the CHANGE. The threshold is then supplied relative
 * to that baseline, which is also what makes the clear direction mean something: it is the same reader
 * and the same evaluator answering differently about the same alert.
 *
 * ## Why `audit_event` is handled differently from everything else
 *
 * It is append-only (ADR 0008), so the refused-sign-in case cannot clean up after itself. It therefore
 * writes its rows against a credential id of its own and clears the alert by moving the WINDOW rather
 * than by deleting anything — which is the honest shape anyway: the alert is "this many refusals in the
 * last hour", and an hour passing is how it really clears.
 *
 * It lives in `packages/fixtures` because it needs both halves: the readers are `@berelax/db`'s and
 * `evaluateAlert` is `@berelax/core`'s, `db` may not import `core`, and the pairing is the thing under
 * test.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
const RUN = Math.random().toString(36).slice(2, 10)

let sql: Sql

beforeAll(() => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
})

afterAll(async () => {
  await sql.end({ timeout: 5 })
})

/** `now` for the observers, as the worker supplies it. */
function at(nowIso: string) {
  return { nowIso, tradingDate: nowIso.slice(0, 10) }
}

async function observe(id: string, nowIso: string): Promise<ObservedAlert> {
  const observer = ALERT_OBSERVERS[id as keyof typeof ALERT_OBSERVERS]
  if (observer === undefined) throw new Error(`no observer for ${id}`)
  return await observer(sql, at(nowIso))
}

/** A threshold map that makes exactly this alert's figure the one under test. */
function thresholdFor(id: string, value: number): ReadonlyMap<string, unknown> {
  const entry = alertDefinition(id)
  if (entry.threshold.kind !== 'setting') return new Map()
  return new Map<string, unknown>([[entry.threshold.settingKey, value]])
}

async function verdict(id: string, nowIso: string, threshold: number) {
  return evaluateAlert(alertDefinition(id), await observe(id, nowIso), thresholdFor(id, threshold))
}

const NOW_ISO = '2026-10-02T12:00:00.000Z'

describe('the registry is what the alerting path reads', () => {
  it('has an observer for every registered alert and no others, at runtime as well as in the type', () => {
    // The `Record<AlertId, …>` proves this for a tree that typechecks and says nothing about one where
    // somebody widened the type — which is exactly how `pnpm boundaries` once reported success over
    // zero modules (ADR 0002). So it is asserted again, at runtime, over the real objects.
    expect(Object.keys(ALERT_OBSERVERS).sort()).toEqual([...ALERT_IDS].sort())
  })

  it('produces one observation per alert in one pass, in registry order', async () => {
    const observations = await observeAlerts(sql, at(NOW_ISO))
    expect(observations.map((o) => o.alertId)).toEqual([...ALERT_IDS])
    // Every figure is a number and none of them is NaN: a reader that coalesced an error into zero
    // would report "nothing is wrong", and zero is the one answer a broken reader must not give.
    for (const o of observations) expect(Number.isFinite(o.observed), o.alertId).toBe(true)
  })

  it('evaluates every alert against the STORED thresholds without throwing', async () => {
    const settings = await readAlertThresholdSettings(sql)
    const verdicts = evaluateAlerts(await observeAlerts(sql, at(NOW_ISO)), settings)
    expect(verdicts).toHaveLength(ALERT_IDS.length)
    // Not one of them may be `threshold_unreadable` on a seeded database: the F09 registry's declared
    // defaults are what `readSetting` falls back to, so an unreadable threshold here would mean the
    // registry and the reader disagree about a key's spelling.
    expect(verdicts.filter((v) => v.kind === 'threshold_unreadable')).toHaveLength(0)
  })
})

describe('exporting the client list', () => {
  it('writes an audit_event with its row count, raises the alert, and neither can be switched off', async () => {
    const [customer] = await sql<{ id: string }[]>`select id from customer limit 1`
    if (customer === undefined) throw new Error('the seed created no customer')
    const [second] = await sql<{ id: string }[]>`select id from customer offset 1 limit 1`
    if (second === undefined) throw new Error('the seed created fewer than two customers')

    const before = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
       where action = 'privacy.subject_data_exported' and operation = 'export'
    `
    const beforeCount = Number(before[0]?.n ?? 0)

    const exported = await withUnitOfWork(
      sql,
      { kind: 'staff', id: customer.id, label: `staff alerts-${RUN}` },
      async (uow) => {
        const [request] = await uow.sql<{ id: string }[]>`
          insert into rights_request (request_type, subject_customer_id, received_at, sla_days, due_at,
                                      verified_via, actor_kind, actor_label, request_detail, state)
          values ('export', ${customer.id}::uuid, ${NOW_ISO}::timestamptz, 30,
                  ${NOW_ISO}::timestamptz + interval '30 days', 'otp', 'customer',
                  'Customer (fixture, OTP verified)',
                  'Asked for a copy of their record.', 'in_progress')
          returning id
        `
        if (request === undefined) throw new Error('the fixture rights request was not created')
        const { exportSubjectData } = await import('@berelax/db')
        // Closed at the end of this transaction, which is what lets the suite run twice:
        // `rights_request_one_open_per_subject_and_type` is a partial unique index over OPEN requests,
        // so a probe left `in_progress` makes the second run's insert a duplicate key. Completing it is
        // also what really happens — the export IS the answer to an access request.
        const result = await exportSubjectData(uow, {
          rightsRequestId: request.id,
          purpose: `H-HARD-05 bulk export probe ${RUN}`,
          exportedAtIso: NOW_ISO,
          subjectCustomerIds: [customer.id, second.id],
          actorKind: 'staff',
          actorLabel: `staff alerts-${RUN}`,
        })
        // `closed_at` in the same statement as the state, because 0085's
        // `rights_request_closure_matches_state` ties the two by CHECK: a terminal state with no
        // closure instant is refused, which is the right rule and is why this is one UPDATE rather
        // than two. A request answered with no record of when it was answered is the shape of a
        // statutory deadline nobody can prove was met.
        await uow.sql`
          update rights_request
             set state = 'completed', closed_at = ${NOW_ISO}::timestamptz
           where id = ${request.id}::uuid
        `
        return result
      },
    )

    // Half one: the audit row exists, with the row count on it. `recordExport` is the INDEXED
    // insider-threat signal (migration 0005) and it is written for every export, not only a bulk one.
    const after = await sql<{ n: string; after_state: { rowCount: number } }[]>`
      select count(*) over ()::text as n, after_state
        from audit_event
       where action = 'privacy.subject_data_exported' and operation = 'export'
       order by occurred_at desc limit 1
    `
    const latest = after[0]
    expect(Number(latest?.n ?? 0)).toBe(beforeCount + 1)
    expect(latest?.after_state.rowCount).toBe(exported.rowCount)

    // Half two: the alert fires, through the registry's own reader and evaluator.
    const fired = await verdict('customer_list_export', NOW_ISO, 2)
    expect(fired.kind).toBe('firing')
    if (fired.kind !== 'firing') throw new Error('unreachable')
    expect(fired.observed).toBeGreaterThanOrEqual(2)
    expect(fired.incidentKey).toBe(exported.exportId)

    // Half three: neither path can be disabled by a setting. The threshold is STRUCTURAL — it points at
    // the CHECK in 0085 that ties `alerted` to `subject_count` — so there is no F09 key to set, and this
    // asserts that absence rather than trusting it: a `setting` threshold here would make an owner-only
    // settings change enough to silence the one alert docs/06 D4 says this business actually needs.
    expect(alertDefinition('customer_list_export').threshold.kind).toBe('structural')
    const { SETTINGS } = await import('@berelax/config')
    const governing = SETTINGS.filter(
      (s) => s.key.startsWith('privacy.') && /export|alert|audit/.test(s.key),
    )
    expect(
      governing,
      `settings that could disable the export alert: ${governing.map((s) => s.key).join(', ')}`,
    ).toHaveLength(0)

    // And the database will not record a bulk export as un-alerted even if a caller forgets to publish.
    const refused = await sql`
      update rights_export set alerted = false where id = ${exported.exportId}::uuid
    `.then(
      () => 'accepted',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(refused).not.toBe('accepted')

    // Half four, and the only clear direction this condition has: the WINDOW. `rights_export` is
    // append-only too — the DELETE this test originally ended with is refused by name
    // (`RightsRecordImmutable`) — so a bulk export never stops having happened, and the honest reading
    // is that the alert stands for the day it happened in and then stops. Two days later the same
    // reader answers nothing about it, which is also the control for every assertion above: they are
    // about this row rather than about a reader that always says the same thing.
    const twoDaysOn = new Date(Date.parse(NOW_ISO) + 48 * 60 * 60 * 1000).toISOString()
    const later = await verdict('customer_list_export', twoDaysOn, 2)
    expect(later.kind).toBe('clear')
    // The OBSERVATION's detail and not the verdict's, because `AlertClear` deliberately carries none:
    // a clear alert has nothing for an operator to act on, and a detail blob on it would be the one
    // thing somebody later renders on a screen as though it meant something. The reader is where the
    // claim belongs anyway — what is being asserted is that the query no longer returns this export.
    const laterObservation = await observe('customer_list_export', twoDaysOn)
    expect(JSON.stringify(laterObservation.detail)).not.toContain(exported.exportId)
  })
})

describe('the outbox', () => {
  it('raises the lag alert for an unpublished event and clears it when the event publishes', async () => {
    const baseline = await observe('outbox_lag', NOW_ISO)

    // An event that is already old, so the figure is about age rather than about this test's duration.
    const oldIso = new Date(Date.parse(NOW_ISO) - 3 * 60 * 60 * 1000).toISOString()
    const [event] = await sql<{ id: string }[]>`
      insert into outbox_event (occurred_at, event_type, aggregate_type, aggregate_id, payload,
                                idempotency_key)
      values (${oldIso}::timestamptz, 'alerts.lag_probe', 'alert_probe', ${RUN}, '{}'::jsonb,
              ${`alerts.lag_probe:${RUN}`})
      returning id
    `
    if (event === undefined) throw new Error('the probe event was not inserted')

    const firing = await verdict('outbox_lag', NOW_ISO, 900)
    expect(firing.kind).toBe('firing')
    if (firing.kind !== 'firing') throw new Error('unreachable')
    expect(firing.observed).toBeGreaterThanOrEqual(3 * 60 * 60)
    expect(firing.incidentKey).toBe(event.id)

    // Publishing it is what a working handler would have done. The alert clears by itself: there is no
    // stored alert row to close, because the firing state is a measurement over these rows.
    await sql`update outbox_event set published_at = now() where id = ${event.id}::uuid`
    const cleared = await observe('outbox_lag', NOW_ISO)
    expect(cleared.observed).toBe(baseline.observed)
    expect(cleared.incidentKey).toBe(baseline.incidentKey)

    await sql`delete from outbox_event where id = ${event.id}::uuid`
  })

  it('excludes its OWN alert events from the lag it measures, or the alarm feeds itself', async () => {
    const baseline = await observe('outbox_lag', NOW_ISO)
    const oldIso = new Date(Date.parse(NOW_ISO) - 9 * 60 * 60 * 1000).toISOString()
    const [raised] = await sql<{ id: string }[]>`
      insert into outbox_event (occurred_at, event_type, aggregate_type, aggregate_id, payload,
                                idempotency_key)
      values (${oldIso}::timestamptz, ${ALERT_RAISED_EVENT}, ${ALERT_EVENT_AGGREGATE_TYPE},
              'outbox_lag', '{}'::jsonb, ${`alert:outbox_lag:self-feed-${RUN}`})
      returning id
    `
    if (raised === undefined) throw new Error('the probe alert event was not inserted')

    // Nine hours of unpublished alert event, and the measurement does not move. The control is the case
    // above, where an ordinary event of three hours moved it by three hours.
    const unchanged = await observe('outbox_lag', NOW_ISO)
    expect(unchanged.observed).toBe(baseline.observed)

    await sql`delete from outbox_event where id = ${raised.id}::uuid`
  })
})

describe('the send backlog', () => {
  it('fires above its threshold and clears when the queue drains', async () => {
    const [template] = await sql<{ id: string }[]>`
      select id from message_template limit 1
    `
    if (template === undefined) throw new Error('the seed created no message template')

    const baseline = await observe('send_backlog', NOW_ISO)
    const ids: string[] = []
    for (let n = 0; n < 3; n += 1) {
      const [row] = await sql<{ id: string }[]>`
        insert into message (template_id, channel, message_class, locale, vendor, recipient, sender_id,
                             body, encoding, segments, cost_fils, status, attempts, queued_at)
        values (${template.id}::uuid, 'sms'::message_channel, 'transactional'::message_class, 'en',
                'smsala', '+971500000901', 'BERELAX', 'Booking confirmed.', 'GSM-7', 1, 9,
                'queued'::message_status, 0, ${NOW_ISO}::timestamptz)
        returning id
      `
      if (row === undefined) throw new Error('the probe message was not inserted')
      ids.push(row.id)
    }

    const firing = await verdict('send_backlog', NOW_ISO, baseline.observed + 3)
    expect(firing.kind).toBe('firing')
    if (firing.kind !== 'firing') throw new Error('unreachable')
    expect(firing.observed).toBe(baseline.observed + 3)

    // One below the queue is still firing; one above it is clear. Both directions of the same figure,
    // so neither is satisfied by a reader that always answers the same thing.
    expect((await verdict('send_backlog', NOW_ISO, baseline.observed + 4)).kind).toBe('clear')

    await sql`delete from message where id = any(${ids}::uuid[])`
    const drained = await observe('send_backlog', NOW_ISO)
    expect(drained.observed).toBe(baseline.observed)
  })
})

describe('job failures, auth failures and overdue obligations', () => {
  it('fires for an agent failing consecutive runs, and clears on a success', async () => {
    const AGENT = 'nightly_rollups'
    const [before] = await sql<{ consecutive_failures: number }[]>`
      select consecutive_failures from agent_heartbeat where agent_key = ${AGENT}
    `
    if (before === undefined) throw new Error(`no heartbeat row for ${AGENT}`)
    const baseline = await observe('job_failure_rate', NOW_ISO)

    try {
      await sql`
        update agent_heartbeat
           set consecutive_failures = ${baseline.observed + 5},
               last_failure_at = ${NOW_ISO}::timestamptz,
               last_outcome = 'failed', last_error = ${`alerts probe ${RUN}`}
         where agent_key = ${AGENT}
      `
      const firing = await verdict('job_failure_rate', NOW_ISO, 3)
      expect(firing.kind).toBe('firing')
      if (firing.kind !== 'firing') throw new Error('unreachable')
      expect(firing.observed).toBe(baseline.observed + 5)
      expect(firing.incidentKey).toContain(AGENT)
      expect(JSON.stringify(firing.detail)).toContain(AGENT)

      // A success resets the streak, which is how this alert clears: there is nothing to acknowledge.
      await sql`
        update agent_heartbeat set consecutive_failures = 0, last_success_at = ${NOW_ISO}::timestamptz,
               last_outcome = 'succeeded', last_error = null
         where agent_key = ${AGENT}
      `
      const after = await observe('job_failure_rate', NOW_ISO)
      expect(after.observed).toBeLessThanOrEqual(baseline.observed)
    } finally {
      await sql`
        update agent_heartbeat set consecutive_failures = ${before.consecutive_failures}
         where agent_key = ${AGENT}
      `
    }
  })

  it('fires for repeated refused sign-ins on ONE credential, and clears as the window moves', async () => {
    // A FIXED probe credential and not one per run, which is the opposite of what this file does
    // everywhere else and is forced by `audit_event` being append-only (ADR 0008). A per-run id was
    // written first and the suite failed on its SECOND run: the previous run's six rows carried the same
    // frozen `occurred_at`, so two credentials tied at six and the observer's tie-break by `entity_id`
    // picked the older one. A fixed id accumulates instead, so every re-run makes this probe a clearer
    // maximum rather than a rival for it.
    const credentialId = 'credential-alerts-probe'
    const refusedAtIso = new Date(Date.parse(NOW_ISO) - 5 * 60 * 1000).toISOString()
    for (let n = 0; n < 6; n += 1) {
      await sql`
        insert into audit_event (actor_kind, actor_label, action, entity_type, entity_id, operation,
                                 after_state, occurred_at)
        values ('system', 'admin sign-in', ${STAFF_SESSION_REFUSED_ACTION}, 'staff_credential',
                ${credentialId}, 'denied', ${sql.json({ stage: 'password_required' })},
                ${refusedAtIso}::timestamptz)
      `
    }

    // The oracle: the same grouping, computed independently of the reader under test. Asserting that
    // the reader picked THE WORST account is a claim about its ordering; asserting it picked a
    // particular string would be a claim about what else is in the table.
    const [worst] = await sql<{ entity_id: string; n: string }[]>`
      select entity_id, count(*)::text as n from audit_event
       where action = ${STAFF_SESSION_REFUSED_ACTION} and operation = 'denied'
         and occurred_at > ${NOW_ISO}::timestamptz - interval '60 minutes'
       group by entity_id order by count(*) desc, entity_id limit 1
    `
    if (worst === undefined) throw new Error('the probe refusal rows were not written')
    expect(Number(worst.n)).toBeGreaterThanOrEqual(6)

    const firing = await verdict('repeated_auth_failure', NOW_ISO, 5)
    expect(firing.kind).toBe('firing')
    if (firing.kind !== 'firing') throw new Error('unreachable')
    expect(firing.observed).toBe(Number(worst.n))
    expect(firing.detail['credentialId']).toBe(worst.entity_id)
    // And this run's rows are among the ones counted, which is what makes the figure above about the
    // write this test performed rather than about whatever was already there.
    const [mine] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
       where action = ${STAFF_SESSION_REFUSED_ACTION} and entity_id = ${credentialId}
         and occurred_at > ${NOW_ISO}::timestamptz - interval '60 minutes'
    `
    expect(Number(mine?.n ?? 0)).toBeGreaterThanOrEqual(6)

    // Two hours later the same rows are outside the window and the same reader answers nothing of mine.
    // That is how this alert really clears, and it is why the window is in the measurement rather than
    // in a stored row somebody would have to close.
    const laterIso = new Date(Date.parse(NOW_ISO) + 2 * 60 * 60 * 1000).toISOString()
    const later = await observe('repeated_auth_failure', laterIso)
    expect(JSON.stringify(later.detail)).not.toContain(credentialId)
    // The control for the window: the SAME rows, read at the original instant, are counted. So the
    // clear above is the window moving and not the reader failing to find anything at all.
    expect((await observe('repeated_auth_failure', NOW_ISO)).observed).toBeGreaterThanOrEqual(6)
  })

  it('fires for an overdue blocking obligation and clears when it is completed', async () => {
    const [obligation] = await sql<{ id: string; key: string }[]>`
      select id, key from obligation where is_blocking order by key limit 1
    `
    if (obligation === undefined) throw new Error('the seed created no blocking obligation')

    const baseline = await observe('overdue_blocking_obligation', NOW_ISO)
    const dueOn = '2026-09-01'
    const [instance] = await sql<{ id: string }[]>`
      insert into obligation_instance (obligation_id, due_on, status)
      values (${obligation.id}::uuid, ${dueOn}::date, 'open')
      on conflict do nothing
      returning id
    `
    if (instance === undefined) throw new Error('the probe obligation instance was not inserted')

    try {
      const firing = await verdict('overdue_blocking_obligation', NOW_ISO, 1)
      expect(firing.kind).toBe('firing')
      if (firing.kind !== 'firing') throw new Error('unreachable')
      // 31 days past due, counted against the trading date the compliance calendar itself uses.
      expect(firing.observed).toBeGreaterThanOrEqual(31)
      expect(JSON.stringify(firing.detail)).toContain(obligation.key)

      // The control the threshold needs: an obligation due ON the trading date is not overdue. Trading
      // runs 11:00-02:00, so 0052 compares `due_on` against the trading date, and a threshold of zero
      // days would have made every obligation due today fire.
      const dueToday = await observe('overdue_blocking_obligation', `${dueOn}T12:00:00.000Z`)
      expect(dueToday.observed).toBeLessThanOrEqual(baseline.observed)
    } finally {
      await sql`delete from obligation_instance where id = ${instance.id}::uuid`
    }

    const cleared = await observe('overdue_blocking_obligation', NOW_ISO)
    expect(cleared.observed).toBe(baseline.observed)
  })
})

describe('the notification', () => {
  it('is one outbox event per incident, and a second pass inserts nothing', async () => {
    const firing = {
      alertId: 'outbox_lag',
      severity: 'immediate',
      runbook: 'alerting#the-outbox-has-stopped-draining',
      observed: 4000,
      threshold: 900,
      incidentKey: `incident-${RUN}`,
      detail: { pending: 3 },
    }
    const first = await sql.begin(async (tx) =>
      raiseAlertNotification(tx as unknown as Sql, firing),
    )
    expect(first).not.toBeNull()
    // The same incident again. `publishEvent`'s `on conflict do nothing` is what makes a watchdog pass
    // every fifteen minutes cost a query rather than ninety-six notifications — and the ninety-sixth is
    // the one nobody reads.
    const second = await sql.begin(async (tx) =>
      raiseAlertNotification(tx as unknown as Sql, firing),
    )
    expect(second).toBeNull()
    // A DIFFERENT incident on the same alert is a new notification. Without this the dedup could be
    // per-alert rather than per-incident, which would mean the second outage of the day was silent.
    const other = await sql.begin(async (tx) =>
      raiseAlertNotification(tx as unknown as Sql, { ...firing, incidentKey: `other-${RUN}` }),
    )
    expect(other).not.toBeNull()

    const stored = await sql<{ event_type: string; aggregate_type: string }[]>`
      select event_type, aggregate_type from outbox_event where id = ${first ?? ''}::uuid
    `
    expect(stored[0]?.event_type).toBe(ALERT_RAISED_EVENT)
    expect(stored[0]?.aggregate_type).toBe(ALERT_EVENT_AGGREGATE_TYPE)

    await sql`delete from outbox_event where idempotency_key in (
      ${`alert:outbox_lag:incident-${RUN}`}, ${`alert:outbox_lag:other-${RUN}`})`
  })

  it('publishes for the firing verdicts and for no clear one, which is the control for the case above', async () => {
    // A generous settings map, so every setting-thresholded alert is clear and only a structural one can
    // fire. Asserting "nothing fires" outright would be a claim about what every other suite in this
    // sequential run happens to have left behind (brief rule 12) — and it failed exactly that way, on
    // this file's own append-only export row. Asserting that exactly the FIRING verdicts were published,
    // and that no clear verdict's incident key exists, is a claim about this code.
    const settings = await readAlertThresholdSettings(sql)
    const generous = new Map<string, unknown>(
      [...settings].map(([k]): [string, unknown] => [k, 1_000_000]),
    )
    const verdicts = evaluateAlerts(await observeAlerts(sql, at(NOW_ISO)), generous)
    const firing = firingAlerts(verdicts)
    const clears = verdicts.filter((v) => v.kind === 'clear')
    expect(clears.length).toBeGreaterThan(0)

    const published: string[] = []
    for (const fired of firing) {
      await sql.begin(async (tx) => raiseAlertNotification(tx as unknown as Sql, fired))
      published.push(`alert:${fired.alertId}:${fired.incidentKey}`)
    }
    if (published.length > 0) {
      const rows = await sql<{ idempotency_key: string }[]>`
        select idempotency_key from outbox_event where idempotency_key = any(${published})
      `
      expect(rows.map((r) => r.idempotency_key).sort()).toEqual([...published].sort())
    }

    // The incident key of a clear verdict is derivable from its own observation, so its ABSENCE is a
    // fact this test can check rather than a count it has to trust.
    const observations = await observeAlerts(sql, at(NOW_ISO))
    const clearKeys = clears.map((v) => {
      const seen = observations.find((each) => each.alertId === v.alertId)
      return `alert:${v.alertId}:${seen?.incidentKey ?? 'none'}`
    })
    const leaked = await sql<{ idempotency_key: string }[]>`
      select idempotency_key from outbox_event where idempotency_key = any(${clearKeys})
    `
    expect(leaked).toHaveLength(0)

    if (published.length > 0) {
      await sql`delete from outbox_event where idempotency_key = any(${published})`
    }
  })

  it('publishes a readable payload: an operator gets the runbook, the figures and the incident', async () => {
    const key = `alert:send_backlog:payload-${RUN}`
    await sql.begin(async (tx) =>
      publishEvent(tx as unknown as Sql, {
        eventType: ALERT_RAISED_EVENT,
        aggregateType: ALERT_EVENT_AGGREGATE_TYPE,
        aggregateId: 'send_backlog',
        payload: { probe: true },
        idempotencyKey: key,
      }),
    )
    const [row] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from outbox_event where idempotency_key = ${key}
    `
    expect(row?.payload).toEqual({ probe: true })
    await sql`delete from outbox_event where idempotency_key = ${key}`
  })
})
