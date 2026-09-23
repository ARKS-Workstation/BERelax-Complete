import { parseConfig } from '@berelax/config'
import {
  type Clock,
  cancellationVerdictFor,
  decideAppointmentTransition,
  instantFromIso,
  invalidationKeyFor,
  recheckShapeAssignment,
  rescheduleTradingDate,
} from '@berelax/core'
import {
  type Actor,
  bookSlot,
  type CancellationPolicy,
  cancelBookingTx,
  createConnection,
  createPostgresMessageStore,
  listMessageInbox,
  readCurrentTemplate,
  rebuildScheduledSteps,
  rescheduleAppointmentTx,
  type ScheduledStepMaintainer,
  type ScheduledStepPlanner,
  type SlotRecheck,
  type Sql,
  scheduledStepMaintainer,
  scheduledStepsFor,
  seedMessageTemplates,
  type TradingDateResolver,
  type TransitionActor,
  type TransitionDecider,
  transitionAppointmentTx,
  withUnitOfWork,
  writeSetting,
} from '@berelax/db'
import {
  DEFAULT_TEMPLATES,
  InMemoryOutbox,
  PROVISIONAL_SENDER_IDS,
  type SendContext,
  TDRA_PROMOTIONAL_WINDOW,
} from '@berelax/messaging'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import { REBUILD_SCHEDULED_STEPS_JOB, REMINDER_OFFSETS_SETTING_KEY } from '@berelax/shared'
import type { PgBoss } from 'pg-boss'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createBoss, shutdown } from '../boss.ts'
import { enqueue } from '../enqueue.ts'
import { deadLetterFor } from '../registry.ts'
import {
  drainScheduledStep,
  plannerFrom,
  type ScheduledStepRuntime,
  SEND_SCHEDULED_STEP_JOB,
  sweepDueSteps,
} from './send-scheduled-step.ts'

/**
 * B-MSG-03 — scheduled steps against real PostgreSQL, a real pg-boss and the real send choke point.
 *
 * It lives in `apps/worker` rather than in `packages/fixtures`, and that is forced rather than chosen:
 * `nothing-imports-an-app` in `.dependency-cruiser.cjs` forbids a package importing an app, and the claims
 * here are about the worker's jobs. Everything the pair suites in `packages/fixtures` do — inject core's
 * rules into the db write paths with `satisfies`, assert against a real database — is done here, with the
 * two jobs as the thing under test.
 *
 * ## What cannot be asserted anywhere else
 *
 *   - **The pg-boss payload.** The unit suite asserts the object the sweep builds; this asserts the row
 *     pg-boss actually wrote. A payload asserted only in the shape it was constructed in says nothing
 *     about what was stored, and the criterion is about the queue.
 *   - **The four transitions by row-state counts.** The maintainer runs inside `transitionAppointment`'s
 *     transaction, so its effect is a set of rows and nothing else.
 *   - **The rebuild reaching bookings taken BEFORE the setting changed**, including one with no steps at
 *     all — an appointment born `confirmed` by `createBooking`, which never transitions into that status.
 *   - **The 6-hour outage**, both ways: sent with a recorded note, and skipped with a recorded reason. And
 *     the third case asserted absent, in SQL, over the rows this file created.
 *   - **The database backstop.** 0051's deferred trigger refuses a cancellation that would commit a
 *     pending step, which is what makes forgetting the maintainer loud rather than dangerous.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind (brief
 * rule 12). The trading dates `2099-11-16` and `2099-11-17` are used by no other suite and no gate; every
 * room, employee, service, variant, customer and template key here is this file's own and carries
 * {@link MARKER} or the run id; every read narrows to those ids. `message` and
 * `message_delivery_receipt` cannot be cleaned up even in principle — the receipt table refuses DELETE and
 * protects the message with ON DELETE RESTRICT — so every message assertion is narrowed to this run's own
 * recipient, and none is a total.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const MARKER = 'bmsg03 scheduled step itest'
/** Unique per run: `message` rows cannot be deleted, so nothing here may reuse a recipient or an id. */
const RUN = `${process.pid}${Math.floor(Math.random() * 1e6)}`
/** 11:00–02:00 Dubai. The session that opens on the 16th closes at 02:00 on the 17th. */
const TRADING_DATE = '2099-11-16'
const NEXT_TRADING_DATE = '2099-11-17'
const DAY_AFTER = '2099-11-18'
const PROBE = 'bmsg03_probe'
const ROOM = 'bmsg03-room'
const SECOND_ROOM = 'bmsg03-room-2'
/** A UAE mobile this run alone writes to. Seven digits of the run id, padded (see B-MSG-04's note). */
const PHONE = `+9715${RUN.slice(0, 7).padStart(7, '0')}`

const GROSS_FILS = 20_000
const NET_FILS = 19_048
const VAT_FILS = 952

const CALLER: Actor = { kind: 'staff', label: MARKER }
const OWNER: TransitionActor = {
  kind: 'staff',
  role: 'owner',
  id: '00000000-0000-4000-8000-00000000c301',
  label: MARKER,
}
const SETTINGS_OWNER: Actor = { kind: 'staff', label: MARKER }

/**
 * Core's rules as the write paths' injected seams. `satisfies`, never a cast.
 *
 * Each pair of declarations describes one seam across a boundary neither package may cross, and this is
 * what makes a field added on one side and not the other a `pnpm typecheck` failure rather than a rule
 * that silently stopped being applied.
 */
const decide = decideAppointmentTransition satisfies TransitionDecider
const recheck = recheckShapeAssignment satisfies SlotRecheck
const resolveTradingDate = rescheduleTradingDate satisfies TradingDateResolver
const classify = cancellationVerdictFor satisfies CancellationPolicy

/** Dubai wall clock as epoch milliseconds, and as the literal `business_day` needs. */
const at = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+04:00`)
const dubai = (date: string, hhmm: string): string => `${date} ${hhmm}:00+04`
const HOUR_MS = 3_600_000

let sql: Sql
let boss: PgBoss
let customerId: string
let variantId: string
let templateId: string
const rooms = new Map<string, string>()
const staff: string[] = []
/** The maintainer under test, bound to whatever the reminder setting says. Rebuilt when it changes. */
let maintainer: ScheduledStepMaintainer
let planner: ScheduledStepPlanner

const roomId = (code: string): string => rooms.get(code) as string

/**
 * The runtime the drain is given: a fake SMSala, a working magic link, and a store bound per transaction.
 *
 * `appEnv: 'production'` so F03's staging guard does not divert the send into the local outbox — the same
 * choice `message-lifecycle.itest.ts` makes, and for the same reason: this file is about the durable row,
 * and a diverted send produces none.
 */
function runtimeWith(options: {
  readonly magicLink: boolean
  readonly nowIso: string
  /** `staging` exercises F03's guard, which diverts to the local outbox and writes no message row. */
  readonly appEnv?: 'production' | 'staging'
}): {
  readonly runtime: ScheduledStepRuntime
  readonly calls: () => number
} {
  const appEnv = options.appEnv ?? 'production'
  const config = parseConfig({ APP_ENV: appEnv, DATABASE_URL: url as string })
  const sms = createSmsalaTransport({ config, now: () => options.nowIso })
  const clock: Clock = { now: () => instantFromIso(options.nowIso) }
  const send: SendContext = {
    appEnv,
    outboundAllowlist: config.OUTBOUND_ALLOWLIST,
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [sms.transport],
    outbox: new InMemoryOutbox(),
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
  return {
    runtime: {
      sql,
      deliveryFor: (connection) => ({
        store: createPostgresMessageStore(connection),
        send,
        waitUntil: async () => {},
      }),
      magicLink: options.magicLink
        ? ({ bookingId }) => `https://be.relax/b/${bookingId}`
        : () => null,
      planner: plannerFrom,
    },
    calls: () =>
      sms.calls.forProvider('smsala').filter((call) => call.outcome === 'success').length,
  }
}

interface StepRow {
  readonly id: string
  readonly stepType: string
  readonly invalidationKey: string
  readonly state: string
  readonly sendAtIso: string
  readonly messageId: string | null
  readonly stalenessNote: string | null
  readonly skippedReason: string | null
  readonly settledAtIso: string | null
}

const stepsOf = (appointmentId: string): Promise<readonly StepRow[]> =>
  scheduledStepsFor(sql, appointmentId)

/** The appointment's period as the key derivation needs it. Read back, never remembered. */
async function periodOf(
  appointmentId: string,
): Promise<{ readonly startsAtMs: number; readonly endsAtMs: number; readonly status: string }> {
  const [row] = await sql<{ starts_at: Date; ends_at: Date; status: string }[]>`
    select lower(period) as starts_at, upper(period) as ends_at, status::text as status
      from appointment where id = ${appointmentId}
  `
  if (row === undefined) throw new Error(`no appointment ${appointmentId}`)
  return {
    startsAtMs: row.starts_at.getTime(),
    endsAtMs: row.ends_at.getTime(),
    status: row.status,
  }
}

/** Counts by state for one appointment, which is what the four-transition criterion asks for. */
async function stateCounts(appointmentId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const step of await stepsOf(appointmentId)) {
    counts[step.state] = (counts[step.state] ?? 0) + 1
  }
  return counts
}

/** One booking through `createBooking`, so every appointment here was really sold. */
async function book(args: {
  readonly key: string
  readonly startsAt: number
  readonly endsAt: number
  readonly room?: string
  readonly therapist?: number
  readonly tradingDate?: string
  readonly status?: 'requested' | 'confirmed'
}): Promise<{ readonly bookingId: string; readonly appointmentId: string }> {
  const created = await bookSlot(
    sql,
    CALLER,
    {
      idempotencyKey: `${MARKER}:${RUN}:${args.key}`,
      customerId,
      source: 'front_desk',
      notes: MARKER,
      clientGender: 'female',
      deliveries: [
        {
          tradingDate: args.tradingDate ?? TRADING_DATE,
          serviceVariantId: variantId,
          shape: 'solo',
          roomId: roomId(args.room ?? ROOM),
          therapistIds: [staff[args.therapist ?? 0] as string],
          treatment: { startsAt: args.startsAt, endsAt: args.endsAt },
          price: {
            grossFils: GROSS_FILS,
            netFils: NET_FILS,
            vatFils: VAT_FILS,
            vatRateBp: 500,
            priceListId: null,
            promotionId: null,
          },
          status: args.status ?? 'requested',
        },
      ],
    },
    { recheck },
  )
  const delivery = created.deliveries[0]
  const appointmentId = delivery?.appointmentIds[0]
  if (appointmentId === undefined) throw new Error('the fixture booking wrote no appointment')
  return { bookingId: created.bookingId, appointmentId }
}

/** Books and confirms, which is the path that creates the declared reminder set. */
async function bookConfirmed(args: {
  readonly key: string
  readonly startsAt: number
  readonly endsAt: number
  readonly room?: string
  readonly therapist?: number
  readonly tradingDate?: string
}): Promise<{ readonly bookingId: string; readonly appointmentId: string }> {
  const booked = await book(args)
  await transitionAppointmentTx(
    sql,
    { appointmentId: booked.appointmentId, to: 'confirmed', actor: OWNER },
    { decide, steps: maintainer },
  )
  return booked
}

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via, locale) values (${PHONE}, 'guest_booking', 'en')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = (customer as { id: string }).id

  for (const [date, nextCalendarDate] of [
    [TRADING_DATE, NEXT_TRADING_DATE],
    [NEXT_TRADING_DATE, DAY_AFTER],
  ] as const) {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (${date}, ${dubai(date, '11')}::timestamptz,
              ${dubai(nextCalendarDate, '02')}::timestamptz, 'weekly')
      on conflict (trading_date) do nothing
    `
  }

  for (const code of [ROOM, SECOND_ROOM]) {
    const [room] = await sql<{ id: string }[]>`
      insert into rooms (code, name, room_type, capacity, display_order, notes)
      values (${code}, ${`Probe ${code}`}, 'standard'::room_type, 1, 93, ${MARKER})
      on conflict (code) do update set capacity = excluded.capacity
      returning id
    `
    rooms.set(code, (room as { id: string }).id)
  }

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, 'bmsg03-probe', 'Probe massage', 'Normal Massage (Asian)', 20, 96)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  const serviceId = (service as { id: string }).id
  await sql`
    insert into service_room_type_compat (service_style, service_treatment_key, room_type)
    values ('asian', ${PROBE}, 'standard'::room_type)
    on conflict do nothing
  `
  await sql`
    insert into service_resource_shape
      (service_style, service_treatment_key, shape, therapists_required, rooms_required,
       min_room_capacity, required_room_type, therapist_buffer_minutes)
    values ('asian', ${PROBE}, 'solo'::service_shape, 1, 1, 1, null, 10)
    on conflict do nothing
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${serviceId}, 45, ${GROSS_FILS}, ${MARKER})
    on conflict (service_id, duration_minutes) do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = (variant as { id: string }).id

  for (const reference of ['bmsg03-a', 'bmsg03-b', 'bmsg03-c', 'bmsg03-d', 'bmsg03-e']) {
    const [row] = await sql<{ id: string }[]>`
      insert into employee (staff_reference, gender, employed_from, notes)
      values (${reference}, 'female', '2099-01-01', ${MARKER})
      on conflict (staff_reference) do update set notes = excluded.notes
      returning id
    `
    const id = (row as { id: string }).id
    staff.push(id)
    await sql`
      insert into employee_skill (employee_id, skill) values (${id}, 'asian_style'::therapist_skill)
      on conflict do nothing
    `
    for (const [type, expires] of [
      ['professional_licence', '2099-12-31'],
      ['health_certificate', '2099-12-31'],
    ] as const) {
      await sql`
        insert into employee_document (employee_id, document_type, expires_on)
        values (${id}, ${type}::employee_document_type, ${expires})
        on conflict do nothing
      `
    }
  }

  for (const [date, nextCalendarDate] of [
    [TRADING_DATE, NEXT_TRADING_DATE],
    [NEXT_TRADING_DATE, DAY_AFTER],
  ] as const) {
    const [shift] = await sql<{ id: string }[]>`
      insert into shift (trading_date, period, label)
      values (${date},
              ${`[${dubai(date, '11')},${dubai(nextCalendarDate, '02')})`}::tstzrange, ${MARKER})
      returning id
    `
    for (const id of staff) {
      await sql`
        insert into shift_assignment (shift_id, employee_id) values (${(shift as { id: string }).id}, ${id})
      `
    }
  }

  // The shipped templates, through the seed this unit adds. `booking.reminder` has to be a ROW because
  // `message.template_id` is a foreign key: without it a reminder cannot produce a message at all.
  await seedMessageTemplates(sql, DEFAULT_TEMPLATES)
  const template = await readCurrentTemplate(sql, {
    key: 'booking.reminder',
    channel: 'sms',
    locale: 'en',
  })
  if (template === undefined) throw new Error('booking.reminder was not seeded')
  templateId = template.templateId

  planner = await plannerFrom(sql)
  maintainer = scheduledStepMaintainer({ plan: planner })

  boss = createBoss({ config: { DATABASE_URL: url as string } })
  await boss.start()
  /*
    `createQueue` directly rather than `registerJobs`, which UNSCHEDULES every cron it is not given — a
    side effect on a shared database that has nothing to do with this file. Test files are exempt from
    `no-schedule-outside-the-registry` for exactly that kind of reason.

    With the SAME options `registerJobs` would pass, and the dead-letter queue first, because pg-boss's
    `create_queue` is `on conflict do nothing`: a queue created here with defaults would keep those
    defaults for ever, and a later `registerJobs` would silently not correct them. This file sorts before
    `worker.itest.ts`, so it really is the one that gets there first.
  */
  await boss.createQueue(deadLetterFor(SEND_SCHEDULED_STEP_JOB.name))
  await boss.createQueue(SEND_SCHEDULED_STEP_JOB.name, {
    retryLimit: SEND_SCHEDULED_STEP_JOB.retryLimit,
    retryDelay: SEND_SCHEDULED_STEP_JOB.retryDelaySeconds,
    retryBackoff: SEND_SCHEDULED_STEP_JOB.retryBackoff,
    expireInSeconds: SEND_SCHEDULED_STEP_JOB.expireInSeconds,
    deadLetter: deadLetterFor(SEND_SCHEDULED_STEP_JOB.name),
  })
}, 120_000)

afterEach(async () => {
  // Cascades to `appointment`, which cascades to `scheduled_step` (0051's one CASCADE), and to
  // `booking_idempotency`, which releases this file's keys between cases. `appointment_status_history`,
  // `audit_event`, `outbox_event`, `message` and `message_delivery_receipt` are append-only or protected
  // and are left alone — every assertion over them is a delta or narrowed to this run.
  await sql`delete from appointment where booking_id in (select id from booking where notes = ${MARKER})`
  await sql`delete from booking where notes = ${MARKER}`
})

afterAll(async () => {
  await sql`delete from appointment where booking_id in (select id from booking where notes = ${MARKER})`
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from shift_assignment where employee_id = any(${staff}::uuid[])`
  await sql`delete from shift where label = ${MARKER}`
  await sql`delete from employee_document where employee_id = any(${staff}::uuid[])`
  await sql`delete from employee_skill where employee_id = any(${staff}::uuid[])`
  await sql`delete from employee where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from business_day where trading_date = any(${[TRADING_DATE, NEXT_TRADING_DATE]}::date[])`
  await sql`delete from customer where phone_e164 = ${PHONE}`
  // The reminder setting restored to the seeded state, value AND provisional flag: it is provisional
  // against Y9-windows, and a suite that left it confirmed would remove a row from the Unconfirmed
  // Assumptions panel that nobody answered.
  await sql`
    update app_setting
       set value = ${sql.json([24, 2] as never)}, is_provisional = true,
           open_question_id = 'Y9-windows'
     where key = ${REMINDER_OFFSETS_SETTING_KEY}
  `
  if (boss !== undefined) await shutdown(boss)
  await sql?.end({ timeout: 5 })
})

// --- the row, and the key ------------------------------------------------------------------------

describe('acceptance — a reminder is a row whose key is derived from the appointment period', () => {
  it('stores one pending step per declared offset, each keyed on the period as stored', async () => {
    const startsAt = at(TRADING_DATE, '19')
    const { appointmentId } = await bookConfirmed({
      key: 'keys',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
    })
    const period = await periodOf(appointmentId)
    const steps = await stepsOf(appointmentId)

    expect(steps.map((step) => step.stepType)).toEqual(['reminder_24h', 'reminder_2h'])
    for (const step of steps) {
      expect(step.state).toBe('pending')
      // The key recomputed from the period the DATABASE holds, not from the number this test passed in.
      expect(step.invalidationKey).toBe(
        invalidationKeyFor({
          appointmentId,
          stepType: step.stepType,
          period: { startsAtMs: period.startsAtMs, endsAtMs: period.endsAtMs },
        }),
      )
      // A pending step has decided nothing: 0051's `scheduled_step_pending_has_settled_nothing`.
      expect([step.messageId, step.skippedReason, step.stalenessNote, step.settledAtIso]).toEqual([
        null,
        null,
        null,
        null,
      ])
    }
    expect(steps.map((step) => step.sendAtIso)).toEqual([
      new Date(period.startsAtMs - 24 * HOUR_MS).toISOString(),
      new Date(period.startsAtMs - 2 * HOUR_MS).toISOString(),
    ])
  })

  it('refuses a second pending step of the same type, and a step type outside the registry bounds', async () => {
    const startsAt = at(TRADING_DATE, '20')
    const { appointmentId } = await bookConfirmed({
      key: 'constraints',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
    })
    // The database half of "exactly one live step per step_type".
    await expect(
      sql`
        insert into scheduled_step (appointment_id, step_type, invalidation_key, send_at)
        values (${appointmentId}, 'reminder_24h', 'duplicate', ${new Date(startsAt - HOUR_MS).toISOString()})
      `,
    ).rejects.toThrow(/scheduled_step_one_pending_step_per_type/)
    // And the bound the F09 registry declares, restated in SQL because the database cannot import it.
    await expect(
      sql`
        insert into scheduled_step (appointment_id, step_type, invalidation_key, send_at)
        values (${appointmentId}, 'reminder_9999h', 'out-of-range',
                ${new Date(startsAt - HOUR_MS).toISOString()})
      `,
    ).rejects.toThrow(/scheduled_step_type_is_a_declared_reminder/)
    // The control: a DIFFERENT step type on the same appointment is accepted, so the index above is
    // about the pair rather than about the appointment.
    await expect(
      sql`
        insert into scheduled_step (appointment_id, step_type, invalidation_key, send_at)
        values (${appointmentId}, 'reminder_6h', 'fresh', ${new Date(startsAt - HOUR_MS).toISOString()})
      `,
    ).resolves.toBeDefined()
  })

  it('spells the setting key the same way in the registry, the rule and the reader', async () => {
    // Three packages that may not import each other. This is the only place all three can be compared.
    expect(REMINDER_OFFSETS_SETTING_KEY).toBe('booking.reminder_offsets_hours')
    const { jobs } = await withUnitOfWork(sql, SETTINGS_OWNER, async (uow) =>
      writeSetting(uow, {
        key: REMINDER_OFFSETS_SETTING_KEY,
        value: [24, 2],
        role: 'owner',
        actorLabel: MARKER,
      }),
    )
    expect(jobs).toEqual([REBUILD_SCHEDULED_STEPS_JOB])
  })
})

// --- the four transitions ------------------------------------------------------------------------

describe('acceptance — the four transitions, by row state counts', () => {
  it('CONFIRMED creates the declared set and a repeat adds nothing', async () => {
    const startsAt = at(TRADING_DATE, '19')
    const booked = await book({ key: 'confirm', startsAt, endsAt: startsAt + 45 * 60_000 })
    expect(await stepsOf(booked.appointmentId)).toEqual([])

    const first = await transitionAppointmentTx(
      sql,
      { appointmentId: booked.appointmentId, to: 'confirmed', actor: OWNER },
      { decide, steps: maintainer },
    )
    expect(first.kind === 'transitioned' && first.steps).toMatchObject({
      action: 'build',
      built: ['reminder_24h', 'reminder_2h'],
      settled: 0,
    })
    expect(await stateCounts(booked.appointmentId)).toEqual({ pending: 2 })

    // `confirmed` declares its repeat IDEMPOTENT, so a double-tapped Confirm is a no-op — and a no-op
    // must not build a second set. Two rows after two confirmations, not four.
    const repeat = await transitionAppointmentTx(
      sql,
      { appointmentId: booked.appointmentId, to: 'confirmed', actor: OWNER },
      { decide, steps: maintainer },
    )
    expect(repeat.kind).toBe('no_op')
    expect(await stateCounts(booked.appointmentId)).toEqual({ pending: 2 })
  })

  it('RESCHEDULED supersedes the old rows and inserts new ones on the successor', async () => {
    const startsAt = at(TRADING_DATE, '19')
    const booked = await bookConfirmed({
      key: 'reschedule',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
    })
    const before = await stepsOf(booked.appointmentId)

    const moved = await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: booked.appointmentId,
        actor: OWNER,
        reason: 'the client asked to be moved',
        treatment: {
          startsAt: startsAt + 2 * HOUR_MS,
          endsAt: startsAt + 2 * HOUR_MS + 45 * 60_000,
        },
        clientGender: 'female',
      },
      { decide, recheck, resolveTradingDate, steps: maintainer },
    )
    const successorId = moved.rows[0]?.successorId as string

    // The predecessor: every step superseded, none pending, none deleted.
    expect(await stateCounts(booked.appointmentId)).toEqual({ superseded: 2 })
    // The successor: a fresh set, keyed on the NEW period.
    const after = await stepsOf(successorId)
    expect(await stateCounts(successorId)).toEqual({ pending: 2 })
    const successorPeriod = await periodOf(successorId)
    for (const step of after) {
      expect(step.invalidationKey).toBe(
        invalidationKeyFor({
          appointmentId: successorId,
          stepType: step.stepType,
          period: successorPeriod,
        }),
      )
    }
    // The keys really changed. Without this the assertion above is satisfied by a reschedule that moved
    // nothing.
    expect(after.map((step) => step.invalidationKey)).not.toEqual(
      before.map((step) => step.invalidationKey),
    )
    // And B-LIFE-03's event now carries what its own NOTE said it would the day this table landed.
    const [event] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from outbox_event
       where aggregate_type = 'appointment' and aggregate_id = ${booked.appointmentId}
         and event_type = 'appointment.rescheduled'
    `
    expect(event?.payload['scheduled_step_table']).toBe('present')
    expect(event?.payload['scheduled_step_invalidation_keys']).toEqual(
      [...before.map((step) => step.invalidationKey)].sort(),
    )
  })

  it('CANCELLED_BY_CUSTOMER and CANCELLED_BY_SALON settle the set as cancelled', async () => {
    for (const [key, actorKind, hour, therapist] of [
      ['cancel-customer', 'customer', '19', 0],
      ['cancel-salon', 'salon', '21', 1],
    ] as const) {
      const startsAt = at(TRADING_DATE, hour)
      const booked = await bookConfirmed({
        key,
        startsAt,
        endsAt: startsAt + 45 * 60_000,
        therapist,
      })
      expect(await stateCounts(booked.appointmentId)).toEqual({ pending: 2 })

      await cancelBookingTx(
        sql,
        {
          bookingId: booked.bookingId,
          to: actorKind === 'customer' ? 'cancelled_by_customer' : 'cancelled_by_salon',
          actor: OWNER,
          reason: 'the client cannot come',
          nowMs: startsAt - 48 * HOUR_MS,
        },
        { decide, classify, steps: maintainer },
      )
      expect(await stateCounts(booked.appointmentId), key).toEqual({ cancelled: 2 })
    }
  })

  it('refuses a cancellation that would commit a pending step, when the maintainer is not wired', async () => {
    // The database backstop, and the reason omitting the maintainer is LOUD rather than dangerous. Gate
    // 63 removes the maintainer from the cancellation and watches this transaction fail by name.
    const startsAt = at(TRADING_DATE, '19')
    const booked = await bookConfirmed({
      key: 'backstop',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
    })
    await expect(
      cancelBookingTx(
        sql,
        {
          bookingId: booked.bookingId,
          to: 'cancelled_by_customer',
          actor: OWNER,
          nowMs: startsAt - 48 * HOUR_MS,
        },
        { decide, classify },
      ),
    ).rejects.toThrow(/scheduled_step_must_not_outlive_its_appointment/)
    // The control: nothing was written. The refusal is a rolled-back transaction, not a half-cancellation.
    expect((await periodOf(booked.appointmentId)).status).toBe('confirmed')
    expect(await stateCounts(booked.appointmentId)).toEqual({ pending: 2 })
  })
})

// --- reschedule there and back -------------------------------------------------------------------

describe('acceptance — reschedule and reschedule back resurrects nothing and does not double-send', () => {
  it('leaves exactly one live step per step_type, and the revived row is a NEW row', async () => {
    const startsAt = at(TRADING_DATE, '19')
    const booked = await bookConfirmed({
      key: 'there-and-back',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
    })
    const original = await stepsOf(booked.appointmentId)

    const away = await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: booked.appointmentId,
        actor: OWNER,
        reason: 'moved out',
        treatment: {
          startsAt: startsAt + 3 * HOUR_MS,
          endsAt: startsAt + 3 * HOUR_MS + 45 * 60_000,
        },
        clientGender: 'female',
      },
      { decide, recheck, resolveTradingDate, steps: maintainer },
    )
    const middleId = away.rows[0]?.successorId as string

    const back = await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: middleId,
        actor: OWNER,
        reason: 'moved back',
        treatment: { startsAt, endsAt: startsAt + 45 * 60_000 },
        clientGender: 'female',
      },
      { decide, recheck, resolveTradingDate, steps: maintainer },
    )
    const finalId = back.rows[0]?.successorId as string

    // One live step per type, on the row that still exists and nowhere else.
    expect(await stateCounts(booked.appointmentId)).toEqual({ superseded: 2 })
    expect(await stateCounts(middleId)).toEqual({ superseded: 2 })
    const live = await stepsOf(finalId)
    expect(await stateCounts(finalId)).toEqual({ pending: 2 })
    expect(live).toHaveLength(2)

    // The period is back where it started, so the KEY re-derives to the same string as the original
    // step's — which is exactly why the key is not unique and why liveness is the row's state.
    const finalPeriod = await periodOf(finalId)
    expect(finalPeriod.startsAtMs).toBe(startsAt)
    // Different appointment id, so the key differs by that alone: the successor is a new row.
    expect(live.map((step) => step.invalidationKey)).toEqual(
      live.map((step) =>
        invalidationKeyFor({
          appointmentId: finalId,
          stepType: step.stepType,
          period: finalPeriod,
        }),
      ),
    )
    // And the superseded rows were not revived: their ids are not the live ones.
    const originalIds = new Set(original.map((step) => step.id))
    for (const step of live) expect(originalIds.has(step.id)).toBe(false)

    // The database refuses the revival even from outside the application.
    const superseded = original[0] as StepRow
    await expect(
      sql`update scheduled_step set state = 'pending', settled_at = null where id = ${superseded.id}`,
    ).rejects.toThrow(/scheduled_step_must_not_be_resurrected/)
  })

  it('sends exactly one message across the whole history, and refuses the superseded steps', async () => {
    const startsAt = at(NEXT_TRADING_DATE, '19')
    const booked = await bookConfirmed({
      key: 'no-double-send',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
      tradingDate: NEXT_TRADING_DATE,
      therapist: 1,
    })
    const away = await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: booked.appointmentId,
        actor: OWNER,
        reason: 'moved out',
        treatment: { startsAt: startsAt + HOUR_MS, endsAt: startsAt + HOUR_MS + 45 * 60_000 },
        clientGender: 'female',
      },
      { decide, recheck, resolveTradingDate, steps: maintainer },
    )
    const successorId = away.rows[0]?.successorId as string

    const twoHourStep = (await stepsOf(successorId)).find(
      (step) => step.stepType === 'reminder_2h',
    ) as StepRow
    const supersededStep = (await stepsOf(booked.appointmentId)).find(
      (step) => step.stepType === 'reminder_2h',
    ) as StepRow

    const nowIso = twoHourStep.sendAtIso
    const { runtime, calls } = runtimeWith({ magicLink: true, nowIso })

    // The superseded step first, which is the job the queue would still be holding.
    const stale = await drainScheduledStep(runtime, { stepId: supersededStep.id, atIso: nowIso })
    expect(stale).toEqual({ kind: 'already_settled', state: 'superseded' })
    expect(calls()).toBe(0)

    const sent = await drainScheduledStep(runtime, { stepId: twoHourStep.id, atIso: nowIso })
    expect(sent.kind).toBe('sent')
    expect(calls()).toBe(1)
    expect((await stepsOf(successorId)).find((s) => s.stepType === 'reminder_2h')?.state).toBe(
      'sent',
    )
  })
})

// --- the drain, the outage and the double drain --------------------------------------------------

describe('acceptance — the drain refuses a stale key, and every drained step is recorded', () => {
  it('skips a step whose key no longer matches, with zero transport calls', async () => {
    const startsAt = at(TRADING_DATE, '19')
    const { appointmentId } = await bookConfirmed({
      key: 'stale',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
    })
    const step = (await stepsOf(appointmentId)).find(
      (candidate) => candidate.stepType === 'reminder_2h',
    ) as StepRow

    // The defect the key exists for, written by hand because no code path in this build produces it: a
    // writer that moved the period and knew nothing about the reminders. LATER rather than earlier, so
    // 0051's own trigger (which sees only "due at or after the start") has nothing to say and the KEY is
    // the only thing standing there.
    await sql`
      update appointment
         set period = tstzrange(${new Date(startsAt + 3 * HOUR_MS).toISOString()}::timestamptz,
                                ${new Date(startsAt + 3 * HOUR_MS + 45 * 60_000).toISOString()}::timestamptz,
                                '[)')
       where id = ${appointmentId}
    `

    const nowIso = step.sendAtIso
    const { runtime, calls } = runtimeWith({ magicLink: true, nowIso })
    const outcome = await drainScheduledStep(runtime, { stepId: step.id, atIso: nowIso })
    expect(outcome).toEqual({ kind: 'skipped', reason: 'invalidation_key_stale' })
    expect(calls()).toBe(0)

    const settled = (await stepsOf(appointmentId)).find((s) => s.id === step.id) as StepRow
    expect(settled.state).toBe('skipped')
    expect(settled.skippedReason).toBe('invalidation_key_stale')
    expect(settled.settledAtIso).not.toBeNull()
    expect(settled.messageId).toBeNull()
  })

  it('sends a step the same appointment still holds — the control for the case above', async () => {
    const startsAt = at(TRADING_DATE, '21')
    const { appointmentId } = await bookConfirmed({
      key: 'fresh',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
      therapist: 2,
    })
    const step = (await stepsOf(appointmentId)).find(
      (candidate) => candidate.stepType === 'reminder_2h',
    ) as StepRow
    const nowIso = step.sendAtIso
    const { runtime, calls } = runtimeWith({ magicLink: true, nowIso })
    const outcome = await drainScheduledStep(runtime, { stepId: step.id, atIso: nowIso })
    expect(outcome.kind).toBe('sent')
    expect(calls()).toBe(1)

    const settled = (await stepsOf(appointmentId)).find((s) => s.id === step.id) as StepRow
    expect(settled.state).toBe('sent')
    expect(settled.messageId).not.toBeNull()
    expect(settled.stalenessNote).toBeNull()
    // The message is a real row in the inbox, rendered from the seeded template and carrying the time.
    const inbox = await listMessageInbox(sql, { recipient: PHONE, limit: 50 })
    const entry = inbox.find((row) => row.id === settled.messageId)
    expect(entry).toMatchObject({ templateKey: 'booking.reminder', channel: 'sms', status: 'sent' })
    expect(entry?.body).toContain('Reminder')
  })

  it('after a 6-hour outage, sends with a recorded note or skips with a recorded reason — never neither', async () => {
    const startsAt = at(NEXT_TRADING_DATE, '19')
    const { appointmentId } = await bookConfirmed({
      key: 'outage',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
      tradingDate: NEXT_TRADING_DATE,
      therapist: 3,
    })
    const steps = await stepsOf(appointmentId)
    const dayBefore = steps.find((s) => s.stepType === 'reminder_24h') as StepRow
    const twoHour = steps.find((s) => s.stepType === 'reminder_2h') as StepRow

    // The worker comes back six hours after the 24-hour reminder should have gone. The appointment is
    // still eighteen hours away, so the reminder is still worth sending — late.
    const recoveredIso = new Date(Date.parse(dayBefore.sendAtIso) + 6 * HOUR_MS).toISOString()
    const first = runtimeWith({ magicLink: true, nowIso: recoveredIso })
    const late = await drainScheduledStep(first.runtime, {
      stepId: dayBefore.id,
      atIso: recoveredIso,
    })
    expect(late.kind).toBe('sent')
    expect(late.kind === 'sent' && late.stalenessNote).toMatch(/360 minute\(s\)/)
    expect(first.calls()).toBe(1)

    // And the other half of the criterion: a step whose treatment has already begun is not a reminder.
    const afterStartIso = new Date(startsAt + 30 * 60_000).toISOString()
    const second = runtimeWith({ magicLink: true, nowIso: afterStartIso })
    const missed = await drainScheduledStep(second.runtime, {
      stepId: twoHour.id,
      atIso: afterStartIso,
    })
    expect(missed).toEqual({ kind: 'skipped', reason: 'send_window_missed' })
    expect(second.calls()).toBe(0)

    // The third case, asserted ABSENT. Two ways, because one of them is about the rows this file wrote
    // and the other about what the schema will store at all.
    const settled = await stepsOf(appointmentId)
    for (const step of settled) {
      expect(step.state, step.stepType).not.toBe('pending')
      expect(step.settledAtIso, step.stepType).not.toBeNull()
      const recorded = step.state === 'sent' ? step.messageId : step.skippedReason
      expect(recorded, `${step.stepType} ended in a silent unrecorded state`).not.toBeNull()
    }
    const [unrecorded] = await sql<{ n: string }[]>`
      select count(*)::text as n from scheduled_step s
        join appointment a on a.id = s.appointment_id
        join booking b on b.id = a.booking_id
       where b.notes = ${MARKER} and s.state <> 'pending' and s.settled_at is null
    `
    expect(Number(unrecorded?.n ?? -1)).toBe(0)
    // And the control on that count: the schema is what makes it zero, not luck.
    await expect(
      sql`update scheduled_step set state = 'skipped', skipped_reason = 'appointment_not_live',
                 settled_at = null where id = ${dayBefore.id}`,
    ).rejects.toThrow(/scheduled_step_terminal_is_settled|scheduled_step_must_not_be_resurrected/)
  })

  it('draining the same step twice produces exactly one message row', async () => {
    const startsAt = at(NEXT_TRADING_DATE, '21')
    const { appointmentId } = await bookConfirmed({
      key: 'double-drain',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
      tradingDate: NEXT_TRADING_DATE,
      therapist: 4,
    })
    const step = (await stepsOf(appointmentId)).find(
      (candidate) => candidate.stepType === 'reminder_2h',
    ) as StepRow
    const nowIso = step.sendAtIso
    const { runtime, calls } = runtimeWith({ magicLink: true, nowIso })

    const first = await drainScheduledStep(runtime, { stepId: step.id, atIso: nowIso })
    const second = await drainScheduledStep(runtime, { stepId: step.id, atIso: nowIso })
    expect(first.kind).toBe('sent')
    expect(second).toEqual({ kind: 'already_settled', state: 'sent' })
    // One transport call, so the second drain did not reach a vendor at all.
    expect(calls()).toBe(1)

    const [messages] = await sql<{ n: string }[]>`
      select count(*)::text as n from message m
        join scheduled_step s on s.message_id = m.id
       where s.id = ${step.id}
    `
    expect(Number(messages?.n ?? -1)).toBe(1)
  })

  it('skips with a reason when the message cannot be built, which is the shipped behaviour today', async () => {
    // `magicLink: false` is what `scheduledStepRuntimeFor` ships: B-UI-02 owns magic links and this build
    // cannot mint one, so a due reminder is SKIPPED and says so rather than being sent with a link to
    // nothing. A step left pending would be re-swept every fifteen minutes for ever.
    const startsAt = at(TRADING_DATE, '19')
    const { appointmentId } = await bookConfirmed({
      key: 'no-link',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
    })
    const step = (await stepsOf(appointmentId)).find(
      (candidate) => candidate.stepType === 'reminder_2h',
    ) as StepRow
    const nowIso = step.sendAtIso
    const { runtime, calls } = runtimeWith({ magicLink: false, nowIso })
    const outcome = await drainScheduledStep(runtime, { stepId: step.id, atIso: nowIso })
    expect(outcome).toEqual({ kind: 'skipped', reason: 'content_unavailable' })
    expect(calls()).toBe(0)
    expect((await stepsOf(appointmentId)).find((s) => s.id === step.id)?.skippedReason).toBe(
      'content_unavailable',
    )
  })

  it('records a staging diversion as send_refused, not as a rendering failure', async () => {
    // The ORDINARY outcome on a staging worker: the message rendered, and F03's guard diverted it to the
    // local outbox because APP_ENV is not production and the recipient is not allowlisted. No `message`
    // row exists (B-MSG-04's rule), so the step has nothing to point at — and a report that called this a
    // content failure would send somebody to look at the template.
    const startsAt = at(TRADING_DATE, '19')
    const { appointmentId } = await bookConfirmed({
      key: 'diverted',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
    })
    const step = (await stepsOf(appointmentId)).find(
      (candidate) => candidate.stepType === 'reminder_2h',
    ) as StepRow
    const nowIso = step.sendAtIso
    const { runtime, calls } = runtimeWith({ magicLink: true, nowIso, appEnv: 'staging' })
    const outcome = await drainScheduledStep(runtime, { stepId: step.id, atIso: nowIso })
    expect(outcome).toEqual({ kind: 'skipped', reason: 'send_refused' })
    // The vendor was never asked, and the row is settled with the reason rather than left pending.
    expect(calls()).toBe(0)
    const settled = (await stepsOf(appointmentId)).find((s) => s.id === step.id) as StepRow
    expect(settled).toMatchObject({
      state: 'skipped',
      skippedReason: 'send_refused',
      messageId: null,
    })
    expect(settled.settledAtIso).not.toBeNull()
  })

  it('leaves a step that is not due pending, and writes nothing about it', async () => {
    const startsAt = at(TRADING_DATE, '21')
    const { appointmentId } = await bookConfirmed({
      key: 'not-due',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
      therapist: 2,
    })
    const step = (await stepsOf(appointmentId)).find(
      (candidate) => candidate.stepType === 'reminder_2h',
    ) as StepRow
    const earlyIso = new Date(Date.parse(step.sendAtIso) - HOUR_MS).toISOString()
    const { runtime, calls } = runtimeWith({ magicLink: true, nowIso: earlyIso })
    const outcome = await drainScheduledStep(runtime, { stepId: step.id, atIso: earlyIso })
    expect(outcome.kind).toBe('deferred')
    expect(calls()).toBe(0)
    // Still pending, still unsettled: a pending row IS the record that the step is not due.
    const after = (await stepsOf(appointmentId)).find((s) => s.id === step.id) as StepRow
    expect(after.state).toBe('pending')
    expect(after.settledAtIso).toBeNull()
  })
})

// --- the queue payload ---------------------------------------------------------------------------

describe('acceptance — the queue carries a step id and nothing else', () => {
  it('writes a pgboss.job row whose data is exactly the step id', async () => {
    const startsAt = at(TRADING_DATE, '19')
    const { appointmentId } = await bookConfirmed({
      key: 'payload',
      startsAt,
      endsAt: startsAt + 45 * 60_000,
    })
    const step = (await stepsOf(appointmentId)).find(
      (candidate) => candidate.stepType === 'reminder_2h',
    ) as StepRow
    const template = await readCurrentTemplate(sql, {
      key: 'booking.reminder',
      channel: 'sms',
      locale: 'en',
    })

    const result = await sweepDueSteps([{ id: step.id }], (data) =>
      enqueue(boss).send(SEND_SCHEDULED_STEP_JOB, data, { singletonKey: data.stepId }),
    )
    expect(result).toMatchObject({ due: 1, queued: 1 })

    const [row] = await sql<{ data: Record<string, unknown> }[]>`
      select data from pgboss.job
       where name = ${SEND_SCHEDULED_STEP_JOB.name} and data->>'stepId' = ${step.id}
    `
    // The row pg-boss really stored, not the object the sweep built.
    expect(row?.data).toEqual({ stepId: step.id })
    const serialised = JSON.stringify(row?.data)
    for (const forbidden of [PHONE, templateId, template?.body ?? 'booking.reminder', 'Reminder']) {
      expect(serialised, forbidden).not.toContain(forbidden)
    }
  })
})

// --- the rebuild ---------------------------------------------------------------------------------

describe('acceptance — changing the reminder timing rebuilds the forward book', () => {
  it('rebuilds bookings taken BEFORE the change, including one with no steps at all', async () => {
    const withSteps = await bookConfirmed({
      key: 'rebuild-a',
      startsAt: at(TRADING_DATE, '19'),
      endsAt: at(TRADING_DATE, '19') + 45 * 60_000,
    })
    const secondWithSteps = await bookConfirmed({
      key: 'rebuild-b',
      startsAt: at(NEXT_TRADING_DATE, '19'),
      endsAt: at(NEXT_TRADING_DATE, '19') + 45 * 60_000,
      tradingDate: NEXT_TRADING_DATE,
      therapist: 1,
    })
    // Born `confirmed` by `createBooking`, which never transitions into that status — so nothing ever
    // built its reminders. This is the half of the criterion a new default applied at confirmation time
    // would miss, and it is the reason the rebuild sweeps APPOINTMENTS rather than steps.
    const bornConfirmed = await book({
      key: 'rebuild-c',
      startsAt: at(TRADING_DATE, '21'),
      endsAt: at(TRADING_DATE, '21') + 45 * 60_000,
      therapist: 2,
      status: 'confirmed',
    })
    expect(await stepsOf(bornConfirmed.appointmentId)).toEqual([])

    const keysBefore = new Map<string, readonly string[]>()
    for (const id of [
      withSteps.appointmentId,
      secondWithSteps.appointmentId,
      bornConfirmed.appointmentId,
    ]) {
      keysBefore.set(
        id,
        (await stepsOf(id)).map((step) => step.invalidationKey),
      )
    }
    expect(keysBefore.get(withSteps.appointmentId)).toHaveLength(2)

    // The setting change, through the real write path. `jobs` is what tells the caller to run the rebuild.
    const written = await withUnitOfWork(sql, SETTINGS_OWNER, (uow) =>
      writeSetting(uow, {
        key: REMINDER_OFFSETS_SETTING_KEY,
        value: [48, 3],
        role: 'owner',
        actorLabel: MARKER,
      }),
    )
    expect(written.jobs).toEqual([REBUILD_SCHEDULED_STEPS_JOB])

    const changed = await plannerFrom(sql)
    const result = await withUnitOfWork(sql, SETTINGS_OWNER, (uow) =>
      rebuildScheduledSteps(
        uow,
        { fromIso: new Date(at(TRADING_DATE, '11')).toISOString() },
        {
          plan: changed,
        },
      ),
    )
    expect(result.superseded).toBeGreaterThanOrEqual(4)
    expect(result.built).toBeGreaterThanOrEqual(6)

    for (const id of [
      withSteps.appointmentId,
      secondWithSteps.appointmentId,
      bornConfirmed.appointmentId,
    ]) {
      const steps = await stepsOf(id)
      const live = steps.filter((step) => step.state === 'pending')
      expect(
        live.map((step) => step.stepType),
        id,
      ).toEqual(['reminder_48h', 'reminder_3h'])
      // The key SETS differ, which is the criterion's own wording. The old keys are still on the
      // superseded rows, so this is a comparison of sets and not of "did anything change".
      const before = keysBefore.get(id) ?? []
      for (const key of live.map((step) => step.invalidationKey)) {
        expect(before, id).not.toContain(key)
      }
      // Every superseded row is one of the keys that was there before (or none, for the booking that
      // had no steps), so the rebuild replaced rather than added.
      for (const step of steps.filter((s) => s.state === 'superseded')) {
        expect(before, id).toContain(step.invalidationKey)
      }
    }

    // And the control: a rebuild with no planner refuses rather than superseding the whole forward book
    // and inserting nothing in its place.
    await expect(
      withUnitOfWork(sql, SETTINGS_OWNER, (uow) =>
        rebuildScheduledSteps(uow, { fromIso: new Date(at(TRADING_DATE, '11')).toISOString() }, {}),
      ),
    ).rejects.toThrow(/step_plan_not_derived/)

    // The same refusal over a window holding NO forward appointments, which is what makes the rebuild's
    // own fail-closed check load-bearing rather than a duplicate of `buildScheduledSteps`'s. With work to
    // do, a planner-less pass fails on the first appointment it reaches; with nothing to do it would
    // return `{ appointments: 0, superseded: 0, built: 0 }` and report success over a pass that could not
    // have written anything — ADR 0002's failure mode exactly. 2098 is before every fixture in the
    // database, so the window is empty by construction rather than by luck.
    await expect(
      withUnitOfWork(sql, SETTINGS_OWNER, (uow) =>
        rebuildScheduledSteps(
          uow,
          { fromIso: '2098-01-01T00:00:00.000Z', toIso: '2098-01-02T00:00:00.000Z' },
          {},
        ),
      ),
    ).rejects.toThrow(/step_plan_not_derived/)
    // And its control: the same empty window WITH a planner is a clean pass over nothing, so the refusal
    // above is about the missing planner and not about the window.
    expect(
      await withUnitOfWork(sql, SETTINGS_OWNER, (uow) =>
        rebuildScheduledSteps(
          uow,
          { fromIso: '2098-01-01T00:00:00.000Z', toIso: '2098-01-02T00:00:00.000Z' },
          { plan: changed },
        ),
      ),
    ).toEqual({ appointments: 0, superseded: 0, built: 0 })
  })
})
