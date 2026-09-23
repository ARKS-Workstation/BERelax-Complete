import { parseConfig } from '@berelax/config'
import {
  type Clock,
  instantFromIso,
  localDate,
  obligationNoticeKeyFor,
  obligationNoticeStep,
  ROLES,
} from '@berelax/core'
import {
  type Actor,
  acknowledgeObligationInstance,
  completeObligationInstance,
  createConnection,
  createPostgresMessageStore,
  fileObligationEvidence,
  generateObligationInstances,
  issueObligationEvidenceGrant,
  OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY,
  OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
  obligationNoticesFor,
  readObligationAcknowledgements,
  recordEvidenceDownload,
  redeemObligationEvidenceGrant,
  rescheduleObligationInstance,
  type Sql,
  seedMessageTemplates,
  withUnitOfWork,
  writeSetting,
} from '@berelax/db'
import {
  type ClassRoutedTransport,
  DEFAULT_TEMPLATES,
  InMemoryOutbox,
  PROVISIONAL_SENDER_IDS,
  type SendContext,
  TDRA_PROMOTIONAL_WINDOW,
} from '@berelax/messaging'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import { REBUILD_OBLIGATION_NOTICES_JOB } from '@berelax/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertRegistry, cronRegistrations, JOB_REGISTRY } from '../registry.ts'
import {
  COMPLIANCE_CALENDAR_JOB,
  drainObligationNotice,
  type ObligationNoticeRuntime,
  obligationNoticeRuntimeFor,
  REBUILD_OBLIGATION_NOTICES_JOB as REBUILD_JOB,
  rebuildObligationNotices,
  runComplianceCalendar,
  SEND_OBLIGATION_NOTICE_JOB,
  sweepDueNotices,
} from './obligation-reminders.ts'

/**
 * M-VAT-11 — the compliance calendar's notices against real PostgreSQL and the real send choke point.
 *
 * It lives in `apps/worker` rather than in `packages/fixtures` for the reason B-MSG-03's suite gives:
 * `nothing-imports-an-app` in `.dependency-cruiser.cjs` forbids a package importing an app, and the claims
 * here are about the worker's jobs. Everything the pair suites in `packages/fixtures` do — join the pure
 * rule to the db write path, assert against a real database — is done here with the three jobs as the
 * thing under test.
 *
 * ## What cannot be asserted anywhere else
 *
 *   - **Exactly one message per (occurrence, step), proven by repeated runs.** The pass is run twice and
 *     every notice drained twice, and the message count is read back from `message` narrowed to this run's
 *     own recipients. Then the guarantee itself: a second SENT row for the same pair is refused by
 *     `obligation_notice_one_send_per_step` rather than by the drain being careful.
 *   - **Escalation goes to the role ABOVE the owner, exactly once, and stops on acknowledgement** — with
 *     the control that the REMINDERS of the same acknowledged occurrence still send, because an
 *     acknowledgement at 60 days must not silence the notice at 7.
 *   - **The gate.** With `APP_ENV` outside production and the recipient not allowlisted, the local outbox
 *     receives the message and the transport's `send` method is never called — counted by a spy wrapped
 *     around the real transport, so the assertion is about a method and not about a log.
 *   - **The evidence grant**: an absent, unknown, expired or wrong-file token is refused, a valid one
 *     resolves, and every download writes an `audit_event` — asserted as a DELTA, because `audit_event` is
 *     append-only (brief rule 9).
 *   - **The trading-date rule reaching the pass.** The clock is frozen at 01:30 Dubai, which is the
 *     PREVIOUS trading date, so a notice due that date is due and one due the calendar date is not.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind (brief
 * rule 12). Every obligation this file uses is its own `mvat11_*` definition, inserted here and deleted in
 * `afterAll`; the trading date 2093-09-20 is used by no other suite; every message read is narrowed to
 * this run's own recipient, because `message` cannot be cleaned up at all — a receipt is the evidence for
 * a status, `message_delivery_receipt` refuses DELETE and its foreign key is ON DELETE RESTRICT.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const MARKER = 'mvat11 obligation notice itest'
/** Unique per run: `message` rows cannot be deleted, so nothing here may reuse a recipient. */
const RUN = `${process.pid}${Math.floor(Math.random() * 1e6)}`
/** 11:00–02:00 Dubai. The session that opens on the 20th closes at 02:00 on the 21st. */
const TRADING_DATE = '2093-09-20'
const NEXT_DAY = '2093-09-21'
/**
 * 01:30 on the 21st Dubai, which is the **20th's** trading date.
 *
 * The boundary the business-day rule turns on, and the reason every comparison in this unit goes through
 * `complianceAsOfDate`: a notice due on the 20th is due at this instant, and one due on the 21st is not.
 */
const NOW_ISO = '2093-09-20T21:30:00Z'

/** Days before/after, in force for this file. Written through the audited settings writer. */
const REMINDERS = [60, 30, 7] as const
const ESCALATIONS = [7, 21] as const

/**
 * This file's own obligations, so no seeded row is mutated.
 *
 * `obligation` has DELETE revoked from `berelax_app` and every column but the due date is frozen by
 * `refuse_obligation_shape_change()`, so a suite that set an anchor on a seeded duty would have to restore
 * it — and a seeded obligation carrying an invented renewal date is exactly what 0052 refuses to ship.
 * Owning the definitions removes the question.
 */
const MANAGER_KEY = 'mvat11_manager_duty'
const OWNER_KEY = 'mvat11_owner_duty'
const EVIDENCE_KEY = 'mvat11_evidence_duty'
const KEYS = [MANAGER_KEY, OWNER_KEY, EVIDENCE_KEY] as const

/** A UAE mobile this run alone writes to, padded (see B-MSG-04's note on colliding run ids). */
const PHONE = `+9715${RUN.slice(0, 7).padStart(7, '0')}`
const ESCALATION_PHONE = `${PHONE.slice(0, -1)}8`

const ACTOR: Actor = { kind: 'staff', label: MARKER }

let sql: Sql

const nextDay = (date: string): string => {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

/** Every notice of every occurrence of this file's obligations, in one list. */
async function noticeRows(): Promise<
  readonly {
    key: string
    step: string
    kind: string
    toRole: string
    state: string
    notifyOn: string
    dueOn: string
    skippedReason: string | null
    messageId: string | null
  }[]
> {
  return await sql<
    {
      key: string
      step: string
      kind: string
      toRole: string
      state: string
      notifyOn: string
      dueOn: string
      skippedReason: string | null
      messageId: string | null
    }[]
  >`
    select o.key, n.step, n.kind::text as kind, n.to_role as "toRole", n.state::text as state,
           n.notify_on::text as "notifyOn", i.due_on::text as "dueOn",
           n.skipped_reason as "skippedReason", n.message_id::text as "messageId"
      from obligation_notice n
      join obligation_instance i on i.id = n.obligation_instance_id
      join obligation o on o.id = i.obligation_id
     where o.key = any(${[...KEYS]}::text[])
     order by o.key, n.notify_on, n.step
  `
}

/**
 * Every occurrence of this file's obligations, except any that committed evidence protects.
 *
 * `obligation_notice` cascades with its occurrence, so this clears the notices too. The exception is
 * defensive rather than expected: the evidence cases below file their attachment inside a unit of work and
 * throw, so nothing they write is ever committed — but if one ever were, `obligation_evidence` is
 * append-only (ZO004) and its foreign key is ON DELETE RESTRICT, and an unconditional delete would then
 * fail on every subsequent run of every case in this file.
 */
async function deleteMyOccurrences(): Promise<void> {
  await sql`
    delete from obligation_instance
     where obligation_id in (select id from obligation where key = any(${[...KEYS]}::text[]))
       and id not in (select obligation_instance_id from obligation_evidence)
  `
}

/** The occurrence ids of one obligation, in due-date order. */
async function occurrenceIds(key: string): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select i.id::text as id
      from obligation_instance i
      join obligation o on o.id = i.obligation_id
     where o.key = ${key}
     order by i.due_on
  `
  return rows.map((row) => row.id)
}

/** Messages this run sent, narrowed to its own recipients: `message` can never be cleaned up. */
async function messagesSent(): Promise<readonly { id: string; body: string; recipient: string }[]> {
  return await sql<{ id: string; body: string; recipient: string }[]>`
    select id::text as id, body, recipient
      from message
     where recipient in (${PHONE}, ${ESCALATION_PHONE})
     order by created_at, id
  `
}

/**
 * A delta over an append-only table, counted in SQL. Never a capped read (brief rule 12).
 *
 * The connection is an argument so a caller inside a unit of work counts through the TRANSACTION: the
 * evidence cases roll back, and a count taken on the pool would not see their rows at all.
 */
async function auditCount(action: string, connection: Sql = sql): Promise<number> {
  const [row] = await connection<{ count: string }[]>`
    select count(*)::text as count from audit_event where action = ${action}
  `
  return Number(row?.count ?? '0')
}

/**
 * An occurrence of the evidence-requiring obligation with one attachment filed against it.
 *
 * Written through the transaction it is given, so the caller can roll it back. `2093-10-15` is a date the
 * annual cadence never generates from the 2093-08-31 anchor, so the pass cannot collide with it.
 */
async function filedEvidence(uow: { readonly sql: Sql }): Promise<string> {
  await generateObligationInstances(uow.sql, [{ obligationKey: EVIDENCE_KEY, dueOn: '2093-10-15' }])
  const [row] = await uow.sql<{ id: string }[]>`
    select i.id::text as id from obligation_instance i
      join obligation o on o.id = i.obligation_id
     where o.key = ${EVIDENCE_KEY} and i.due_on = ${'2093-10-15'}::date
  `
  const filed = await fileObligationEvidence(uow as never, {
    instanceId: row?.id as string,
    storageKey: `compliance/evidence/${RUN}.bin`,
    contentHash: CONTENT_HASH,
    uploadedByLabel: MARKER,
  })
  return filed.evidenceId
}

/**
 * The runtime the drain is given: a fake SMSala wrapped in a spy, and a recipient resolver.
 *
 * `appEnv: 'production'` by default so F03's staging guard does not divert the send into the local outbox —
 * the same choice `send-scheduled-step.itest.ts` and `message-lifecycle.itest.ts` make, and for the same
 * reason: most of this file is about the durable row, and a diverted send produces none. One describe block
 * passes `staging`, which is the gate case the acceptance criterion names.
 *
 * The spy wraps the real transport rather than replacing it, so the "sent" path exercises the real fake and
 * the "diverted" path can assert that its `send` METHOD was never entered — which is a stronger claim than
 * an empty provider call log, because a transport that logged nothing would satisfy the log assertion.
 */
function runtimeWith(options: {
  readonly appEnv?: 'production' | 'staging'
  readonly recipients?: Readonly<Record<string, string>>
}): {
  readonly runtime: ObligationNoticeRuntime
  readonly transportCalls: () => number
  readonly outbox: InMemoryOutbox
} {
  const appEnv = options.appEnv ?? 'production'
  const config = parseConfig({ APP_ENV: appEnv, DATABASE_URL: url as string })
  const sms = createSmsalaTransport({ config, now: () => NOW_ISO })
  let entered = 0
  const spied: ClassRoutedTransport = {
    channel: sms.transport.channel,
    send: async (request) => {
      entered += 1
      return await sms.transport.send(request)
    },
  }
  const clock: Clock = { now: () => instantFromIso(NOW_ISO) }
  const outbox = new InMemoryOutbox()
  const send: SendContext = {
    appEnv,
    // The allowlist is empty on `staging`, so the guard diverts; on `production` the guard returns
    // `deliver` before the allowlist is consulted at all.
    outboundAllowlist: config.OUTBOUND_ALLOWLIST,
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [spied],
    outbox,
    clock,
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      evaluators: {
        hasConsent: () => true,
        isSuppressed: () => false,
        frequencyCapReached: () => false,
      },
    },
  }
  const recipients = options.recipients ?? { manager: PHONE, owner: ESCALATION_PHONE }
  return {
    runtime: {
      sql,
      deliveryFor: (connection) => ({
        store: createPostgresMessageStore(connection),
        send,
        waitUntil: async () => {},
      }),
      recipientForRole: (role) => recipients[role] ?? null,
    },
    transportCalls: () => entered,
    outbox,
  }
}

/** Drains every pending notice of this file's obligations, in the order the sweep hands them over. */
async function drainAll(runtime: ObligationNoticeRuntime): Promise<readonly string[]> {
  const pass = await runComplianceCalendar(sql, { atIso: NOW_ISO, keys: [...KEYS] })
  const mine = new Set(
    (
      await sql<{ id: string }[]>`
        select n.id::text as id
          from obligation_notice n
          join obligation_instance i on i.id = n.obligation_instance_id
          join obligation o on o.id = i.obligation_id
         where o.key = any(${[...KEYS]}::text[])
      `
    ).map((row) => row.id),
  )
  const outcomes: string[] = []
  for (const notice of pass.due) {
    if (!mine.has(notice.id)) continue
    const outcome = await drainObligationNotice(runtime, { noticeId: notice.id, atIso: NOW_ISO })
    outcomes.push(outcome.kind === 'skipped' ? `skipped:${outcome.reason}` : outcome.kind)
  }
  return outcomes
}

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })
  await seedMessageTemplates(sql, DEFAULT_TEMPLATES)

  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${`${TRADING_DATE} 11:00:00+04`}::timestamptz,
            ${`${nextDay(TRADING_DATE)} 02:00:00+04`}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${NEXT_DAY}, ${`${NEXT_DAY} 11:00:00+04`}::timestamptz,
            ${`${nextDay(NEXT_DAY)} 02:00:00+04`}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  // Three obligations of this file's own. The anchors are set on insert rather than through
  // `setObligationAnchorDate`, because these are not seeded duties with a deliberately blank date: they
  // are probes, and their dates are the dates the assertions are about.
  await sql`
    insert into obligation
      (key, title, obligation_class, cadence, subject_scope, owner_role, blocking_effect,
       evidence_required, source_reference, anchor_on)
    values
      (${MANAGER_KEY}, ${'Probe: a duty the manager owes'}, 'hygiene', 'annual', 'business',
       'manager', 'none', false, 'docs/04-uae-compliance.md §9', ${'2093-11-19'}),
      (${OWNER_KEY}, ${'Probe: a duty the owner owes'}, 'hygiene', 'annual', 'business',
       'owner', 'none', false, 'docs/04-uae-compliance.md §9', ${'2093-11-19'}),
      (${EVIDENCE_KEY}, ${'Probe: a duty that needs an attachment'}, 'hygiene', 'annual', 'business',
       'manager', 'none', true, 'docs/04-uae-compliance.md §9', ${'2093-08-31'})
    on conflict (key) do nothing
  `

  await withUnitOfWork(sql, ACTOR, async (uow) => {
    await writeSetting(uow, {
      key: OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
      value: [...REMINDERS],
      role: 'owner',
      actorLabel: MARKER,
      justification: MARKER,
    })
    await writeSetting(uow, {
      key: OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY,
      value: [...ESCALATIONS],
      role: 'owner',
      actorLabel: MARKER,
      justification: MARKER,
    })
  })
}, 120_000)

afterAll(async () => {
  /*
    Everything this file created goes, and it can go because nothing that resists deletion is ever
    committed. `obligation_evidence` is append-only (ZO004) and the occurrence beneath it is ON DELETE
    RESTRICT, so a committed attachment would leave a row no run could remove and the NEXT run would find
    the occurrence already carrying evidence — which is why the evidence block files its attachment inside
    a unit of work and then throws. `obligation_notice` cascades with its occurrence, so the order is
    occurrences, then definitions.
  */
  await deleteMyOccurrences()
  // Only where nothing references it. An occurrence that somehow carries committed evidence cannot be
  // removed by anybody (ZO004 refuses the DELETE for every role, the owner included), so an unconditional
  // delete here would make ONE bad run poison this database permanently — which is a worse outcome than a
  // leftover definition that the reads above narrow past anyway.
  await sql`
    delete from obligation
     where key = any(${[...KEYS]}::text[])
       and id not in (select obligation_id from obligation_instance)
  `
  await sql`delete from business_day where trading_date in (${TRADING_DATE}, ${NEXT_DAY})`
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  // Each case starts from no occurrences and therefore no notices (`obligation_notice` cascades), so none
  // inherits another's rows and a crashed run does not make the next one assert against a notice it did
  // not write. Every occurrence of this file's obligations goes, evidence included — which is possible
  // only because the evidence block below files its attachment INSIDE a unit of work and then throws.
  await deleteMyOccurrences()
})

describe('the job registry declares all three, and only the pass has a cron', () => {
  it('registers the calendar, the sender and the rebuild, with an agent on the cron', () => {
    assertRegistry(JOB_REGISTRY as never)
    const names = JOB_REGISTRY.map((job) => job.name)
    expect(names).toContain(COMPLIANCE_CALENDAR_JOB.name)
    expect(names).toContain(SEND_OBLIGATION_NOTICE_JOB.name)
    expect(names).toContain(REBUILD_JOB.name)
    // The rebuild's name is the constant the F09 registry names in `rerunJobs`. A registry naming one
    // string while the worker registers another declares a rebuild that never runs, with nothing to say so.
    expect(REBUILD_JOB.name).toBe(REBUILD_OBLIGATION_NOTICES_JOB)

    const crons = cronRegistrations(JOB_REGISTRY as never)
    const calendar = crons.find((cron) => cron.name === COMPLIANCE_CALENDAR_JOB.name)
    expect(calendar?.agent).toBe('compliance_calendar')
    // The other two are ANNOUNCED, not polled: a cron on either would be a poller looking for work an
    // enqueue already handed over.
    expect(crons.map((cron) => cron.name)).not.toContain(SEND_OBLIGATION_NOTICE_JOB.name)
    expect(crons.map((cron) => cron.name)).not.toContain(REBUILD_JOB.name)
  })

  it('and the agent it names has a definition and a heartbeat row', async () => {
    // The runtime half of G-AGT-01's rule. The static gate checks that a cron names an agent; this checks
    // the agent exists — and that it has a heartbeat, because `agentsWithHeartbeat` INNER joins and an
    // agent with no heartbeat row is one the watchdog silently never checks.
    const [row] = await sql<{ interval: number; beats: string }[]>`
      select d.expected_interval_seconds as interval,
             (select count(*)::text from agent_heartbeat h where h.agent_key = d.agent_key) as beats
        from agent_definition d where d.agent_key = 'compliance_calendar'
    `
    expect(row?.interval).toBe(60 * 60 * 24)
    expect(row?.beats).toBe('1')
  })
})

describe('acceptance — each declared offset fires exactly one message, and never twice', () => {
  it('sends one per (occurrence, step) and adds nothing on a repeated pass', async () => {
    const before = (await messagesSent()).length
    const { runtime, transportCalls } = runtimeWith({})

    const first = await drainAll(runtime)
    // The manager duty is due 2093-11-19, so at the 20th of September the 60-day reminder (2093-09-20) is
    // due exactly today — the trading date — and the 30-day and 7-day ones are not. The owner duty's
    // 60-day reminder is due too; its escalations are never planned, which the next block asserts.
    expect(first.filter((outcome) => outcome === 'sent')).toHaveLength(2)
    const afterFirst = await messagesSent()
    expect(afterFirst.length - before).toBe(2)
    expect(transportCalls()).toBe(2)

    // The SECOND pass and the second drain: the whole pipeline again, not one insert repeated.
    const second = await drainAll(runtime)
    expect(second).toEqual([])
    expect((await messagesSent()).length - before).toBe(2)
    // And the notices themselves are settled once: `sent` with a message, and the later rungs still
    // pending because their dates have not arrived.
    const rows = (await noticeRows()).filter((row) => row.key === MANAGER_KEY)
    expect(rows.map((row) => `${row.step} ${row.state}`)).toEqual([
      'reminder_60d sent',
      'reminder_30d pending',
      'reminder_7d pending',
      'escalation_7d pending',
      'escalation_21d pending',
    ])
    expect(rows.filter((row) => row.state === 'sent').every((row) => row.messageId !== null)).toBe(
      true,
    )
  }, 60_000)

  it('and draining the same notice twice is a no-op the ROW refuses, not one the drain avoids', async () => {
    const { runtime, transportCalls } = runtimeWith({})
    await drainAll(runtime)
    const callsAfterFirst = transportCalls()

    const [instanceId] = await occurrenceIds(MANAGER_KEY)
    const notices = await obligationNoticesFor(sql, instanceId as string)
    const sent = notices.find((notice) => notice.state === 'sent')
    expect(sent).toBeDefined()

    // The drain is asked for the SAME notice again, directly — not through the sweep, which would have
    // filtered it out. It reports the row's state and enters the transport zero more times.
    const again = await drainObligationNotice(runtime, {
      noticeId: sent?.id as string,
      atIso: NOW_ISO,
    })
    expect(again).toEqual({ kind: 'already_settled', state: 'sent' })
    expect(transportCalls()).toBe(callsAfterFirst)
  }, 60_000)

  it('and the database refuses a second SENT notice for one (occurrence, step)', async () => {
    // The guarantee itself, which is the acceptance criterion's "enforced by idempotency on (instance,
    // step)". Without this the claim above is about the drain being careful, and a reclaimed job, a
    // double enqueue or a psql session would each be a way past it.
    const { runtime } = runtimeWith({})
    await drainAll(runtime)
    const [instanceId] = await occurrenceIds(MANAGER_KEY)
    const step = obligationNoticeStep('reminder', 60)
    const key = obligationNoticeKeyFor({
      instanceId: instanceId as string,
      step,
      dueOn: localDate('2093-11-19'),
    })
    const [message] = await messagesSent()
    const second = sql`
      insert into obligation_notice
        (obligation_instance_id, step, kind, to_role, notify_on, invalidation_key, state,
         message_id, settled_at)
      values (${instanceId as string}::uuid, ${step}, 'reminder', 'manager', ${'2093-09-20'}::date,
              ${key}, 'sent', ${message?.id as string}::uuid, now())
    `
    await expect(second).rejects.toThrow(
      /obligation_notice_one_send_per_step|obligation_notice_message_claimed_once/,
    )

    // The control on the constraint: a second PENDING notice for the same pair is refused too, which is
    // what makes the planner's `on conflict do nothing` a no-op rather than a duplicate.
    const pending = sql`
      insert into obligation_notice
        (obligation_instance_id, step, kind, to_role, notify_on, invalidation_key)
      values (${instanceId as string}::uuid, ${'reminder_30d'}, 'reminder', 'manager',
              ${'2093-10-20'}::date, ${key})
    `
    await expect(pending).rejects.toThrow(/obligation_notice_one_pending_per_step/)
  }, 60_000)

  it('and a notice whose deadline has moved is refused rather than sent', async () => {
    // The damaging case. The occurrence is live, the notice is due today and perfectly renderable, and
    // the date it was built for no longer exists.
    const { runtime, transportCalls } = runtimeWith({})
    await runComplianceCalendar(sql, { atIso: NOW_ISO, keys: [...KEYS] })
    const [instanceId] = await occurrenceIds(MANAGER_KEY)
    const notices = await obligationNoticesFor(sql, instanceId as string)
    const due = notices.find((notice) => notice.step === 'reminder_60d')
    expect(due).toBeDefined()

    await withUnitOfWork(sql, ACTOR, (uow) =>
      rescheduleObligationInstance(uow, {
        instanceId: instanceId as string,
        dueOn: '2093-12-19',
        reason: MARKER,
      }),
    )
    const before = transportCalls()
    const outcome = await drainObligationNotice(runtime, {
      noticeId: due?.id as string,
      atIso: NOW_ISO,
    })
    expect(outcome).toEqual({ kind: 'skipped', reason: 'invalidation_key_stale' })
    // Nothing was handed to a vendor: the refusal happens before the send, not after it.
    expect(transportCalls()).toBe(before)
  }, 60_000)

  it('and the sweep hands over a notice id and nothing else', async () => {
    await runComplianceCalendar(sql, { atIso: NOW_ISO, keys: [...KEYS] })
    const handed: unknown[] = []
    const result = await sweepDueNotices([{ id: 'abc' }, { id: 'def' }], async (payload) => {
      handed.push(payload)
      return 'job-1'
    })
    expect(result).toEqual({
      due: 2,
      queued: 2,
      payloads: [{ noticeId: 'abc' }, { noticeId: 'def' }],
    })
    // One field, asserted structurally: a recipient in a queue payload would put a phone number in
    // `pgboss.job`, a table with a seven-day retention and no access control of its own, and a body there
    // would be a message about a deadline that may have moved.
    for (const payload of handed) {
      expect(Object.keys(payload as object)).toEqual(['noticeId'])
    }
  }, 30_000)
})

describe('acceptance — an unacknowledged occurrence escalates once, and stops on acknowledgement', () => {
  /** An occurrence already past its deadline, so the escalation rungs are due. */
  async function overdueOccurrence(key: string, dueOn: string): Promise<string> {
    await generateObligationInstances(sql, [{ obligationKey: key, dueOn }])
    const [id] = await sql<{ id: string }[]>`
      select i.id::text as id from obligation_instance i
        join obligation o on o.id = i.obligation_id
       where o.key = ${key} and i.due_on = ${dueOn}::date
    `
    return id?.id as string
  }

  it('escalates to the role above the owner, exactly once, however many times the pass runs', async () => {
    // Due on the 1st; at the 20th both escalation rungs (the 8th and the 22nd) have arrived for the first
    // and only the 7-day one for the second. The reminders are all in the past too.
    await overdueOccurrence(MANAGER_KEY, '2093-09-01')
    const { runtime } = runtimeWith({})
    await drainAll(runtime)

    const escalations = (await noticeRows()).filter(
      (row) => row.key === MANAGER_KEY && row.kind === 'escalation' && row.dueOn === '2093-09-01',
    )
    // `escalation_7d` fell due on the 8th and is sent; `escalation_21d` falls due on the 22nd and is not.
    expect(escalations.map((row) => `${row.step} ${row.state} ${row.toRole}`)).toEqual([
      'escalation_7d sent owner',
      'escalation_21d pending owner',
    ])
    // The role is the one ABOVE the owner of the duty, which is the whole of "somebody is accountable".
    expect(escalations.every((row) => row.toRole !== 'manager')).toBe(true)

    // Repeated passes add nothing: the sent rung is settled and the pending one is not due.
    await drainAll(runtime)
    await drainAll(runtime)
    const after = (await noticeRows()).filter(
      (row) => row.key === MANAGER_KEY && row.kind === 'escalation' && row.dueOn === '2093-09-01',
    )
    expect(after).toEqual(escalations)
  }, 60_000)

  it('stops escalating on acknowledgement, and does NOT stop the reminders', async () => {
    const instanceId = await overdueOccurrence(MANAGER_KEY, '2093-09-01')
    const before = await auditCount('compliance.obligation_instance.acknowledged')
    await withUnitOfWork(sql, ACTOR, (uow) =>
      acknowledgeObligationInstance(uow, {
        instanceId,
        role: 'manager',
        actorLabel: MARKER,
      }),
    )
    // A delta over an append-only table, never a total (brief rule 9).
    expect(await auditCount('compliance.obligation_instance.acknowledged')).toBe(before + 1)
    expect(await readObligationAcknowledgements(sql, [instanceId])).toEqual(new Set([instanceId]))

    const { runtime } = runtimeWith({})
    const outcomes = await drainAll(runtime)
    const rows = (await noticeRows()).filter(
      (row) => row.key === MANAGER_KEY && row.dueOn === '2093-09-01',
    )
    const escalation = rows.find((row) => row.step === 'escalation_7d')
    expect(escalation?.state).toBe('skipped')
    expect(escalation?.skippedReason).toBe('obligation_acknowledged')

    // THE control, and the asymmetry the unit is judged on: the reminders about the same acknowledged
    // occurrence were still SENT. A rule that suppressed both on acknowledgement would let one click at 60
    // days silence the notice at 7, which is the notice that matters.
    const reminders = rows.filter((row) => row.kind === 'reminder')
    expect(reminders).toHaveLength(3)
    expect(reminders.every((row) => row.state === 'sent')).toBe(true)
    expect(outcomes.filter((outcome) => outcome === 'sent').length).toBeGreaterThanOrEqual(3)

    // And acknowledging twice is refused rather than overwriting who took responsibility.
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        acknowledgeObligationInstance(uow, {
          instanceId,
          role: 'owner',
          actorLabel: MARKER,
        }),
      ),
    ).rejects.toThrow(/No unacknowledged obligation occurrence/)
  }, 60_000)

  it('plans no escalation at all for a duty the owner owes, and says so rather than inventing one', async () => {
    await overdueOccurrence(OWNER_KEY, '2093-09-01')
    const pass = await runComplianceCalendar(sql, { atIso: NOW_ISO, keys: [...KEYS] })
    expect(pass.withoutEscalation).toContain(OWNER_KEY)
    const rows = (await noticeRows()).filter((row) => row.key === OWNER_KEY)
    expect(rows.every((row) => row.kind === 'reminder')).toBe(true)
    // The control: the manager's duty, in the same pass, DID get escalations — so the absence above is
    // about the ladder having no rung above `owner` and not about escalation being switched off.
    await overdueOccurrence(MANAGER_KEY, '2093-09-02')
    await runComplianceCalendar(sql, { atIso: NOW_ISO, keys: [...KEYS] })
    expect(
      (await noticeRows()).some((row) => row.key === MANAGER_KEY && row.kind === 'escalation'),
    ).toBe(true)
  }, 60_000)

  it('and the database refuses an escalation addressed to the role that owes the duty', async () => {
    // The teeth behind "an escalation nobody new is accountable for is decoration". The ladder lives in
    // `@berelax/core` and cannot be read from SQL; "it is not the same role" is the half SQL can make, and
    // it is the half that catches a ladder collapsed onto its own first rung by a `?? ownerRole` fallback.
    const instanceId = await overdueOccurrence(MANAGER_KEY, '2093-09-03')
    const misaddressed = sql`
      insert into obligation_notice
        (obligation_instance_id, step, kind, to_role, notify_on, invalidation_key)
      values (${instanceId}::uuid, 'escalation_7d', 'escalation', 'manager', ${'2093-09-10'}::date,
              ${'escalation_7d:probe'})
    `
    await expect(misaddressed).rejects.toThrow(/ObligationEscalationGoesNowhere/)

    // And a REMINDER addressed to somebody who does not owe it is refused too.
    const wrongReminder = sql`
      insert into obligation_notice
        (obligation_instance_id, step, kind, to_role, notify_on, invalidation_key)
      values (${instanceId}::uuid, 'reminder_7d', 'reminder', 'receptionist', ${'2093-08-27'}::date,
              ${'reminder_7d:probe'})
    `
    await expect(wrongReminder).rejects.toThrow(/ObligationNoticeMisaddressed/)

    // The control: the correctly addressed pair is accepted, so the two refusals above are about the role
    // and not about the insert failing for an unrelated reason.
    const accepted = await sql<{ id: string }[]>`
      insert into obligation_notice
        (obligation_instance_id, step, kind, to_role, notify_on, invalidation_key)
      values (${instanceId}::uuid, 'escalation_21d', 'escalation', 'owner', ${'2093-09-24'}::date,
              ${'escalation_21d:probe'})
      returning id::text as id
    `
    expect(accepted).toHaveLength(1)
  }, 60_000)

  it('and a settled notice can never be re-opened so it fires again', async () => {
    const { runtime } = runtimeWith({})
    await overdueOccurrence(MANAGER_KEY, '2093-09-01')
    await drainAll(runtime)
    const [instanceId] = await occurrenceIds(MANAGER_KEY)
    const notices = await obligationNoticesFor(sql, instanceId as string)
    const sent = notices.find((notice) => notice.state === 'sent')
    const revive = sql`
      update obligation_notice set state = 'pending' where id = ${sent?.id as string}::uuid
    `
    await expect(revive).rejects.toThrow(/obligation_notice_must_not_be_resurrected/)
  }, 60_000)
})

describe('acceptance — the notices route through the messaging compliance gate', () => {
  it('diverts to the local outbox outside production and never enters the transport', async () => {
    await generateObligationInstances(sql, [{ obligationKey: MANAGER_KEY, dueOn: '2093-11-19' }])
    const { runtime, transportCalls, outbox } = runtimeWith({ appEnv: 'staging' })
    const before = (await messagesSent()).length

    const outcomes = await drainAll(runtime)
    expect(outcomes).toContain('skipped:send_refused')

    // The criterion, in both halves. The local outbox HAS the message, so nothing was dropped…
    //
    // Found by recipient rather than read at index 0: this pass diverts every due notice of every
    // obligation the filter allows, and the manager's is not reliably the first. The ORDER is a separate
    // claim, made by `dueObligationNotices`' total order, and asserting it here as well would make this
    // case fail for a reason that has nothing to do with the gate.
    const diverted = outbox.all().find((entry) => entry.message.recipient === PHONE)
    expect(diverted, 'the manager notice reached the local outbox').toBeDefined()
    expect(diverted?.reason).toMatch(/APP_ENV=staging/)
    // …and the transport's `send` method was never entered. A spy around the real transport rather than a
    // provider call log: a transport that logged nothing would satisfy a log assertion.
    expect(transportCalls()).toBe(0)
    // No `message` row either, which is B-MSG-04's stated rule — so the notice is settled with
    // `send_refused` rather than left pending to be re-swept every day for ever.
    expect((await messagesSent()).length).toBe(before)
    const rows = (await noticeRows()).filter((row) => row.state === 'skipped')
    expect(rows.some((row) => row.skippedReason === 'send_refused')).toBe(true)
  }, 60_000)

  it('and the shipped runtime resolves no recipient for any role, which is the honest state', () => {
    // The shipped value, asserted directly. Every other case in this block injects its own resolver, so
    // none of them would notice a default appearing here — and a plausible UAE mobile in
    // `obligationNoticeRuntimeFor` is brief rule 15 exactly: indistinguishable from a configured one, and
    // a renewal notice sent to somebody else's phone is a compliance disclosure nothing would report.
    const shipped = obligationNoticeRuntimeFor(sql)
    for (const role of ROLES) {
      expect(shipped.recipientForRole(role), `${role} has no contact detail on file`).toBeNull()
    }
  })

  it('records a role with no contact detail as a blank rather than guessing one', async () => {
    // The shipped state. No table in this build holds a staff phone number, so the shipped resolver
    // answers null for every role — and a plausible UAE mobile typed in here would be indistinguishable
    // from a configured one (brief rule 15). The row is what makes the absence visible and countable.
    await generateObligationInstances(sql, [{ obligationKey: MANAGER_KEY, dueOn: '2093-11-19' }])
    const { runtime, transportCalls } = runtimeWith({ recipients: {} })
    const outcomes = await drainAll(runtime)
    expect(outcomes).toContain('skipped:no_recipient_on_file')
    expect(transportCalls()).toBe(0)
    const rows = (await noticeRows()).filter((row) => row.skippedReason !== null)
    expect(rows.some((row) => row.skippedReason === 'no_recipient_on_file')).toBe(true)
    // And it is a DIFFERENT reason from a rendering failure, because the two send somebody to two
    // different places: a blank in the contact details, and a template nobody approved.
    expect(rows.every((row) => row.skippedReason !== 'content_unavailable')).toBe(true)
  }, 60_000)

  it('names the obligation and the date in the body, and no regulatory identifier', async () => {
    await generateObligationInstances(sql, [{ obligationKey: MANAGER_KEY, dueOn: '2093-11-19' }])
    const { runtime } = runtimeWith({})
    await drainAll(runtime)
    const [message] = (await messagesSent()).filter((row) => row.body.includes(MANAGER_KEY))
    expect(message?.body).toContain(MANAGER_KEY)
    expect(message?.body).toContain('2093-11-19')
    expect(message?.body).toContain('manager')
    // An SMS is read by whoever is holding the phone, so the body carries the obligation KEY and the date
    // and nothing else about the business. There is no licence or permit number on file to leak
    // (Y1-licence, Y1-trn) and the obligation table holds none, which is why this asserts the absence of
    // the words rather than of a particular number.
    expect(message?.body.toLowerCase()).not.toContain('trn')
    expect(message?.body.toLowerCase()).not.toContain('licence no')
  }, 60_000)
})

/**
 * A body that runs inside a unit of work and is then rolled back.
 *
 * The evidence cases MUST leave nothing behind, and that is not tidiness. `obligation_evidence` is
 * append-only (ZO004) and its occurrence is ON DELETE RESTRICT, so a committed attachment leaves a row no
 * run can remove — and the next run finds the occurrence already carrying evidence and asserts against
 * stale state. M-VAT-10's own completion cases do exactly this, for the same reason.
 *
 * The sentinel is compared by identity, so a genuine failure inside the body is re-thrown by the assertion
 * rather than mistaken for the deliberate rollback.
 */
const ROLLBACK = new Error('mvat11: deliberate rollback')

async function rolledBack(body: (uow: { readonly sql: Sql }) => Promise<void>): Promise<void> {
  await expect(
    withUnitOfWork(sql, ACTOR, async (uow) => {
      await body(uow)
      throw ROLLBACK
    }),
  ).rejects.toBe(ROLLBACK)
}

/** A content hash this run alone writes. 64 hex characters, which 0052's CHECK requires. */
const CONTENT_HASH = RUN.replace(/[^0-9a-f]/g, 'a')
  .padEnd(64, 'b')
  .slice(0, 64)

describe('acceptance — evidence is private, and every download is audited', () => {
  it('refuses an absent, unknown, expired and wrong-file grant, and resolves a valid one', async () => {
    await rolledBack(async (uow) => {
      const evidenceId = await filedEvidence(uow)

      // No grant at all. The shape a stranger's request has, and the one the acceptance criterion names.
      expect(await redeemObligationEvidenceGrant(uow.sql, { evidenceId, token: null })).toEqual({
        kind: 'refused',
        reason: 'grant_absent',
      })
      // A token nothing issued.
      expect(
        await redeemObligationEvidenceGrant(uow.sql, { evidenceId, token: 'not-a-grant' }),
      ).toEqual({ kind: 'refused', reason: 'grant_unknown' })

      // An expired one. Both instants are moved back, because `expires_at > created_at` is a CHECK — a
      // grant that had already expired when it was written would read on the screen as a broken link.
      const expired = await issueObligationEvidenceGrant(uow as never, {
        evidenceId,
        role: 'manager',
        actorLabel: MARKER,
        purpose: 'the expiry case',
        ttlSeconds: 60,
      })
      await uow.sql`
        update obligation_evidence_grant
           set created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes'
         where id = ${expired.grantId}::uuid
      `
      expect(
        await redeemObligationEvidenceGrant(uow.sql, { evidenceId, token: expired.token }),
      ).toEqual({ kind: 'refused', reason: 'grant_expired' })

      // A valid grant, and the control that makes the three refusals mean something: it resolves.
      const granted = await issueObligationEvidenceGrant(uow as never, {
        evidenceId,
        role: 'manager',
        actorLabel: MARKER,
        purpose: 'the municipality inspection file',
      })
      const resolved = await redeemObligationEvidenceGrant(uow.sql, {
        evidenceId,
        token: granted.token,
      })
      expect(resolved.kind).toBe('granted')
      if (resolved.kind === 'granted') {
        expect(resolved.evidence.contentHash).toBe(CONTENT_HASH)
        expect(resolved.evidence.issuedToRole).toBe('manager')
      }

      // And the same valid grant is refused for a DIFFERENT file, so the id in the path is not decoration:
      // one grant opens one attachment, not the filing cabinet.
      const second = await fileObligationEvidence(uow as never, {
        instanceId: resolved.kind === 'granted' ? resolved.evidence.obligationInstanceId : '',
        storageKey: `compliance/evidence/${RUN}-2.bin`,
        contentHash: `${CONTENT_HASH.slice(0, 63)}c`,
        uploadedByLabel: MARKER,
      })
      expect(
        await redeemObligationEvidenceGrant(uow.sql, {
          evidenceId: second.evidenceId,
          token: granted.token,
        }),
      ).toEqual({ kind: 'refused', reason: 'grant_not_for_this_evidence' })
    })

    // Nothing was kept: the rollback is what lets the next run start from the same state.
    const [left] = await sql<{ count: string }[]>`
      select count(*)::text as count from obligation_evidence where content_hash = ${CONTENT_HASH}
    `
    expect(left?.count).toBe('0')
  }, 60_000)

  it('writes an audit row for the grant and one for EVERY download, including a repeat', async () => {
    await rolledBack(async (uow) => {
      const evidenceId = await filedEvidence(uow)
      // Counted inside the transaction, which is what makes these deltas rather than totals: `audit_event`
      // is append-only and only grows, so a total would drift with every other suite (brief rule 9).
      const grantsBefore = await auditCount('compliance.obligation_evidence.grant_issued', uow.sql)
      const downloadsBefore = await auditCount('compliance.obligation_evidence.downloaded', uow.sql)

      const grant = await issueObligationEvidenceGrant(uow as never, {
        evidenceId,
        role: 'owner',
        actorLabel: MARKER,
        purpose: 'the audit case',
      })
      expect(await auditCount('compliance.obligation_evidence.grant_issued', uow.sql)).toBe(
        grantsBefore + 1,
      )

      const resolved = await redeemObligationEvidenceGrant(uow.sql, {
        evidenceId,
        token: grant.token,
      })
      if (resolved.kind !== 'granted') throw new Error('the grant did not resolve')
      for (const bytes of [12, 12]) {
        await recordEvidenceDownload(uow as never, { evidence: resolved.evidence, bytes })
      }
      // TWO rows for two downloads of one link: a second download is a second copy leaving the business,
      // and a trail that recorded only the first would answer the inspection's question wrongly.
      expect(await auditCount('compliance.obligation_evidence.downloaded', uow.sql)).toBe(
        downloadsBefore + 2,
      )

      // The token is nowhere in the trail. An audit row carrying the credential would be a second copy of
      // it, in a partitioned table several roles may read.
      const [leak] = await uow.sql<{ count: string }[]>`
        select count(*)::text as count from audit_event
         where action like 'compliance.obligation_evidence.%'
           and (after_state::text like ${`%${grant.token}%`}
             or before_state::text like ${`%${grant.token}%`})
      `
      expect(leak?.count).toBe('0')
      // The control on that assertion: the row DOES carry the grant id and the content hash, so the
      // absence above is about the token and not about the trail being empty.
      const [carried] = await uow.sql<{ count: string }[]>`
        select count(*)::text as count from audit_event
         where action = 'compliance.obligation_evidence.downloaded'
           and after_state->>'contentHash' = ${CONTENT_HASH}
      `
      expect(Number(carried?.count ?? '0')).toBe(2)
    })
  }, 60_000)

  it('and a completion without its attachment is still refused, which is what evidence is for', async () => {
    // M-VAT-10's rule, re-asserted here because this unit is the one that serves the attachment: a tick in
    // a box is not what an inspection asks for.
    await generateObligationInstances(sql, [{ obligationKey: EVIDENCE_KEY, dueOn: '2093-12-15' }])
    const [row] = await sql<{ id: string }[]>`
      select i.id::text as id from obligation_instance i
        join obligation o on o.id = i.obligation_id
       where o.key = ${EVIDENCE_KEY} and i.due_on = ${'2093-12-15'}::date
    `
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        completeObligationInstance(uow, {
          instanceId: row?.id as string,
          role: 'manager',
          actorLabel: MARKER,
        }),
      ),
    ).rejects.toThrow(/EvidenceRequired/)
    // The control: with an attachment filed it completes — so the refusal above is about the evidence and
    // not about the role, the date or anything else. Inside a rolled-back unit of work, because a
    // completion that has filed its evidence is permanent by design.
    await rolledBack(async (uow) => {
      await fileObligationEvidence(uow as never, {
        instanceId: row?.id as string,
        storageKey: `compliance/evidence/${RUN}-3.bin`,
        contentHash: `${CONTENT_HASH.slice(0, 63)}d`,
        uploadedByLabel: MARKER,
      })
      const completed = await completeObligationInstance(uow as never, {
        instanceId: row?.id as string,
        role: 'manager',
        actorLabel: MARKER,
      })
      expect(completed.completedAt).toBeInstanceOf(Date)
    })
  }, 60_000)
})

describe('the rebuild re-plans the calendar already in it', () => {
  it('supersedes the old ladder and plans the new one over the SAME occurrences', async () => {
    await generateObligationInstances(sql, [{ obligationKey: MANAGER_KEY, dueOn: '2093-11-19' }])
    await runComplianceCalendar(sql, { atIso: NOW_ISO, keys: [...KEYS] })
    const before = (await noticeRows()).filter(
      (row) => row.key === MANAGER_KEY && row.state === 'pending',
    )
    expect(before.map((row) => row.step)).toContain('reminder_30d')

    await withUnitOfWork(sql, ACTOR, (uow) =>
      writeSetting(uow, {
        key: OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
        value: [45],
        role: 'owner',
        actorLabel: MARKER,
        justification: MARKER,
      }),
    )
    const result = await rebuildObligationNotices(sql, { atIso: NOW_ISO, keys: [...KEYS] })
    expect(result.superseded).toBeGreaterThan(0)
    expect(result.planned).toBeGreaterThan(0)

    const after = await noticeRows()
    const mine = after.filter((row) => row.key === MANAGER_KEY)
    // The new rung exists, the old ones are SUPERSEDED rather than deleted — the count of them is how
    // "what did changing the ladder cost us" stays answerable — and a superseded row is not re-sent.
    expect(mine.some((row) => row.step === 'reminder_45d' && row.state === 'pending')).toBe(true)
    expect(
      mine.filter((row) => row.step === 'reminder_30d').every((row) => row.state === 'superseded'),
    ).toBe(true)

    // Restore the ladder for the rest of the file.
    await withUnitOfWork(sql, ACTOR, (uow) =>
      writeSetting(uow, {
        key: OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
        value: [...REMINDERS],
        role: 'owner',
        actorLabel: MARKER,
        justification: MARKER,
      }),
    )
  }, 60_000)

  it('and the pass resolves the TRADING date, not the calendar date', async () => {
    // 01:30 on the 21st Dubai is the 20th's trading date, because trading runs 11:00–02:00. A pass that
    // used the calendar date would call a notice due on the 21st due today, which is a day early — and it
    // would do so for the last two hours of every trading day.
    const pass = await runComplianceCalendar(sql, { atIso: NOW_ISO, keys: [...KEYS] })
    expect(pass.asOf).toBe(TRADING_DATE)
  }, 60_000)
})
