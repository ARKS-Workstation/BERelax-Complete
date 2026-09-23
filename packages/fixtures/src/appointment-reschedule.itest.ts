import { getDefinition } from '@berelax/config'
import {
  CANCELLATION_WINDOW_SETTING_KEY as CORE_WINDOW_KEY,
  cancellationVerdictFor,
  DEFAULT_CANCELLATION_WINDOW_HOURS,
  decideAppointmentTransition,
  noShowVerdictFor,
  recheckShapeAssignment,
  reminderPlanFor,
  rescheduleTradingDate,
  successorStatusFor,
} from '@berelax/core'
import {
  type Actor,
  bookSlot,
  buildScheduledSteps,
  CANCELLATION_WINDOW_SETTING_KEY,
  type CancellationPolicy,
  cancelAppointmentTx,
  cancelBookingTx,
  cancellationRefusalOf,
  createConnection,
  markNoShowTx,
  type NoShowClockCheck,
  type RescheduleDeps,
  type RescheduleInput,
  readScheduledStepKeys,
  rescheduleAppointment,
  rescheduleAppointmentTx,
  rescheduleRefusalOf,
  type ScheduledStepKeyReader,
  type ScheduledStepPlanner,
  type SlotRecheck,
  type Sql,
  scheduledStepMaintainer,
  scheduledStepsFor,
  type TradingDateResolver,
  type TransitionActor,
  type TransitionDecider,
  transitionAppointmentTx,
  transitionRefusalOf,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * B-LIFE-03 — reschedule, cancellation, the no-show clock guard and the cancellation window, against real
 * PostgreSQL with core's own rules injected.
 *
 * It lives in `packages/fixtures` because every claim needs both halves of a boundary. The rules are in
 * `@berelax/core` — the transition table, the slot re-check, the trading-date resolver, the cancellation
 * window and the clock guard — the transactions are in `@berelax/db`, and `packages/db` may never import
 * `packages/core`. The five `satisfies` lines below are what make those seams typechecked declarations
 * rather than two hopeful descriptions of one shape.
 *
 * Four things here cannot be asserted anywhere else:
 *
 *   - **the room row lock**. A competing `select … for share nowait` receives 55P03 only if a real
 *     `FOR UPDATE` is held. B-AVAIL-06 measured that the `pg_locks` row alone proves nothing (the
 *     foreign-key check takes `FOR KEY SHARE`, which is also a RowShareLock), so the competing lock is the
 *     assertion and the same probe outside the transaction is its control.
 *   - **release-then-acquire in one transaction**. `appointment_therapist_no_overlap` is immediate, so a
 *     reschedule that moves a treatment by thirty minutes only commits if the old period was released
 *     first — and a reschedule that FAILS has to leave the old row untouched to the byte, which is asserted
 *     by comparing `to_jsonb(appointment.*)::text` before and after.
 *   - **all-or-none across a booking**, proved with two REAL forced failures rather than a mock: an
 *     appointment the lifecycle cannot move, and an outbox key already taken.
 *   - **the epoch advancing**. B-AVAIL-07's trigger (0045) is what invalidates the availability memo, and
 *     this suite asserts it rather than reimplementing it.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind. The
 * trading dates `2099-12-04` and `2099-12-05` are used by no other suite and no gate; every room, employee,
 * service and variant here is this file's own and carries {@link MARKER}; every read narrows to those ids.
 * `appointment_status_history`, `audit_event` and `outbox_event` are append-only or shared (ADR 0008), so
 * what is asserted of them is a **delta counted in SQL** or a per-appointment key set, never a total, and
 * nothing is deleted from any of them.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'blife03 reschedule pair itest'
/** The trading date everything starts on. 11:00-02:00, so its session ends on the 5th at 02:00. */
const TRADING_DATE = '2099-12-04'
/** The next trading date. The midnight cases are the difference between these two. */
const NEXT_TRADING_DATE = '2099-12-05'
const PROBE = 'blife03_probe'
const PROBE_PHONE = '+971590000631'
const SINGLE_ROOM = 'blife03-single'
const SECOND_ROOM = 'blife03-second'
const COUPLES_ROOM = 'blife03-couples'

/** 20000 fils gross and the exact split `splitGross` produces. Written out, never re-derived here. */
const GROSS_FILS = 20_000
const NET_FILS = 19_048
const VAT_FILS = 952
const TURNAROUND_MINUTES = 20
const BUFFER_MINUTES = 10

const CALLER: Actor = { kind: 'staff', label: 'B-LIFE-03 pair itest' }
const ACTOR_ID = '00000000-0000-4000-8000-00000000b301'
const OWNER: TransitionActor = {
  kind: 'staff',
  role: 'owner',
  id: ACTOR_ID,
  label: 'B-LIFE-03 pair itest',
}
const REASON = 'the client asked to be moved'

/**
 * Core's five rules, as the write paths' injected seams.
 *
 * `satisfies` and not a cast, every one of them. Each pair of declarations describes one seam across a
 * boundary neither package may cross, and this is what makes a field added on one side and not the other a
 * `pnpm typecheck` failure rather than a rule that silently stopped being applied.
 */
const decide = decideAppointmentTransition satisfies TransitionDecider
const recheck = recheckShapeAssignment satisfies SlotRecheck
const resolveTradingDate = rescheduleTradingDate satisfies TradingDateResolver
const classify = cancellationVerdictFor satisfies CancellationPolicy
const clock = noShowVerdictFor satisfies NoShowClockCheck

const RESCHEDULE_DEPS: RescheduleDeps = { decide, recheck, resolveTradingDate }

/**
 * B-MSG-03's step planner and maintainer, with the offsets written out rather than read from the setting.
 *
 * Only ONE case here needs them — the one B-MSG-03 unblocked — and they are deliberately NOT folded into
 * `RESCHEDULE_DEPS`: a reschedule that built a reminder set on every successor would leave pending steps
 * behind, and the cancellation cases below inject no maintainer, so 0051's deferred trigger would refuse
 * them. Which is the trigger being right: this file's other cases are about periods and locks, and an
 * appointment with no reminders attached is the state they mean to describe.
 */
const stepPlan: ScheduledStepPlanner = ({ appointmentId, period }) =>
  reminderPlanFor({ appointmentId, period, offsetsHours: [24, 2] })
const stepMaintainer = scheduledStepMaintainer({ plan: stepPlan })
const CANCEL_DEPS = { decide, classify }
const NO_SHOW_DEPS = { decide, clock }

let sql: Sql
/** The second pool every lock assertion needs: a lock one transaction holds is invisible inside it. */
let probe: Sql
let customerId: string
let variantId: string
const rooms = new Map<string, string>()
const staff = new Map<string, string>()

const roomId = (code: string): string => rooms.get(code) as string
const idOf = (reference: string): string => {
  const id = staff.get(reference)
  if (id === undefined) throw new Error(`no fixture employee ${reference}`)
  return id
}

/** A Dubai wall-clock instant on a given calendar date, as epoch milliseconds. */
const at = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+04:00`)
const dubai = (date: string, hhmm: string): string => `${date} ${hhmm}:00+04`
const MINUTE = 60_000

/** The refusal a rejected promise carries, or `null` when it resolved. */
async function refusalOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return rescheduleRefusalOf(error) ?? cancellationRefusalOf(error) ?? transitionRefusalOf(error)
  }
}

/** The SQLSTATE of a rejected statement, or undefined when it succeeded. */
async function stateOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
}

interface AppointmentRow {
  readonly id: string
  readonly status: string
  readonly trading_date: string
  readonly room_id: string
  readonly therapist_id: string
  readonly delivery_id: string
  readonly starts_at: Date
  readonly ends_at: Date
  readonly holds_resources: boolean
  readonly rescheduled_from_id: string | null
  readonly late_cancellation: boolean
  readonly late_cancellation_window_hours: number | null
  readonly room_places: number
  readonly turnaround_minutes: number
  readonly therapist_buffer_minutes: number
  readonly gross_price_fils: string
  readonly net_fils: string
  readonly vat_fils: string
  readonly vat_rate_bp: number
}

async function appointmentById(id: string): Promise<AppointmentRow | undefined> {
  const [row] = await sql<AppointmentRow[]>`
    select id::text as id, status::text as status, trading_date::text as trading_date,
           room_id::text as room_id, therapist_id::text as therapist_id,
           delivery_id::text as delivery_id, lower(period) as starts_at, upper(period) as ends_at,
           holds_resources, rescheduled_from_id::text as rescheduled_from_id,
           late_cancellation, late_cancellation_window_hours, room_places, turnaround_minutes,
           therapist_buffer_minutes, gross_price_fils::text as gross_price_fils,
           net_fils::text as net_fils, vat_fils::text as vat_fils, vat_rate_bp
      from appointment where id = ${id}
  `
  return row
}

/**
 * The WHOLE row as canonical JSON text, for the byte-identical comparison.
 *
 * `to_jsonb(a.*)` and not a column list, which is the point: a reschedule that failed must leave `updated_at`
 * and every other column it did not mean to touch exactly as they were, and a snapshot of the columns the
 * test expects to change cannot see the one it did not expect.
 */
async function snapshotOf(id: string): Promise<string | null> {
  const [row] = await sql<{ snapshot: string }[]>`
    select to_jsonb(a.*)::text as snapshot from appointment a where a.id = ${id}
  `
  return row?.snapshot ?? null
}

interface EventRow {
  readonly event_type: string
  readonly idempotency_key: string
  readonly payload: Record<string, unknown>
}

/** Every outbox row for one appointment. Narrowed by aggregate id, so other suites' rows are invisible. */
async function eventsOf(appointmentId: string): Promise<readonly EventRow[]> {
  return await sql<EventRow[]>`
    select event_type, idempotency_key, payload
      from outbox_event
     where aggregate_type = 'appointment' and aggregate_id = ${appointmentId}
     order by occurred_at, id
  `
}

/** The audit rows for one appointment, counted IN SQL — `audit_event` is append-only (ADR 0008). */
async function auditCount(appointmentId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
     where entity_type = 'appointment' and entity_id = ${appointmentId}
  `
  return Number(row?.n ?? 0)
}

/** The history rows for one appointment, counted IN SQL. Append-only for the same reason. */
async function historyCount(appointmentId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from appointment_status_history where appointment_id = ${appointmentId}
  `
  return Number(row?.n ?? 0)
}

/** `availability_epoch` for a trading date, or null when the date has never been written to. */
async function epochOf(tradingDate: string): Promise<{ epoch: string; cause: string } | null> {
  const [row] = await sql<{ epoch: string; cause: string }[]>`
    select epoch::text as epoch, last_cause::text as cause
      from availability_epoch where trading_date = ${tradingDate}
  `
  return row ?? null
}

/**
 * Every row count a cancellation must not move.
 *
 * DELTAS, never totals: the suite is sequential against one database and every one of these tables is
 * written by other files. `invoice` and `invoice_line` are the documents, `journal_entry` and `journal_line`
 * the money itself — a fee that charged anything would have to appear in at least one of the four.
 */
async function moneyRowCounts(): Promise<Record<string, number>> {
  const [row] = await sql<
    { invoice: string; invoice_line: string; journal_entry: string; journal_line: string }[]
  >`
    select (select count(*) from invoice)::text        as invoice,
           (select count(*) from invoice_line)::text   as invoice_line,
           (select count(*) from journal_entry)::text  as journal_entry,
           (select count(*) from journal_line)::text   as journal_line
  `
  return {
    invoice: Number(row?.invoice ?? 0),
    invoice_line: Number(row?.invoice_line ?? 0),
    journal_entry: Number(row?.journal_entry ?? 0),
    journal_line: Number(row?.journal_line ?? 0),
  }
}

async function addEmployee(args: {
  readonly reference: string
  readonly gender: 'female' | 'male'
  readonly skills?: readonly string[]
  readonly documents?: readonly { readonly type: string; readonly expiresOn: string }[]
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values (${args.reference}, ${args.gender}, '2099-01-01', ${MARKER})
    on conflict (staff_reference)
      do update set gender = excluded.gender, notes = excluded.notes
    returning id
  `
  const id = (row as { id: string }).id
  staff.set(args.reference, id)
  for (const skill of args.skills ?? ['asian_style']) {
    await sql`
      insert into employee_skill (employee_id, skill) values (${id}, ${skill}::therapist_skill)
      on conflict do nothing
    `
  }
  for (const document of args.documents ?? [
    { type: 'professional_licence', expiresOn: '2099-12-31' },
    { type: 'health_certificate', expiresOn: '2099-12-31' },
  ]) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${document.type}::employee_document_type, ${document.expiresOn})
      on conflict do nothing
    `
  }
  return id
}

/** One booking through `createBooking`, so every appointment this file moves was really sold. */
async function book(args: {
  readonly key: string
  readonly shape: 'solo' | 'couple' | 'four_hands'
  readonly room: string
  readonly therapists: readonly string[]
  readonly startsAt: number
  readonly endsAt: number
  readonly tradingDate?: string
  readonly status?: 'requested' | 'confirmed'
}): Promise<{ bookingId: string; appointmentIds: readonly string[] }> {
  const created = await bookSlot(
    sql,
    CALLER,
    {
      idempotencyKey: `${MARKER}:${args.key}`,
      customerId,
      source: 'front_desk',
      notes: MARKER,
      clientGender: 'female',
      deliveries: [
        {
          tradingDate: args.tradingDate ?? TRADING_DATE,
          serviceVariantId: variantId,
          shape: args.shape,
          roomId: roomId(args.room),
          therapistIds: args.therapists.map(idOf),
          treatment: { startsAt: args.startsAt, endsAt: args.endsAt },
          price: {
            grossFils: GROSS_FILS,
            netFils: NET_FILS,
            vatFils: VAT_FILS,
            vatRateBp: 500,
            priceListId: null,
            promotionId: null,
          },
          status: args.status ?? 'confirmed',
        },
      ],
    },
    { recheck },
  )
  const delivery = created.deliveries[0]
  if (delivery === undefined) throw new Error('the fixture booking wrote no delivery')
  return { bookingId: created.bookingId, appointmentIds: delivery.appointmentIds }
}

beforeAll(async () => {
  sql = createConnection({ url, max: 8 })
  probe = createConnection({ url, max: 4 })

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = (customer as { id: string }).id

  // The trading calendar is a TABLE (0011) and `appointment.trading_date` is a foreign key into it, so a
  // fixture cannot invent a date the premises does not trade on. Two consecutive dates, both 11:00-02:00 in
  // Asia/Dubai, because the midnight cases are the difference between them.
  for (const [date, nextCalendarDate] of [
    [TRADING_DATE, NEXT_TRADING_DATE],
    [NEXT_TRADING_DATE, '2099-12-06'],
  ] as const) {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (${date}, ${dubai(date, '11')}::timestamptz,
              ${dubai(nextCalendarDate, '02')}::timestamptz, 'weekly')
      on conflict (trading_date) do nothing
    `
  }

  for (const [code, roomType, capacity] of [
    [SINGLE_ROOM, 'standard', 1],
    [SECOND_ROOM, 'standard', 1],
    [COUPLES_ROOM, 'couples', 2],
  ] as const) {
    const [room] = await sql<{ id: string }[]>`
      insert into rooms (code, name, room_type, capacity, display_order, notes)
      values (${code}, ${`Probe ${code}`}, ${roomType}::room_type, ${capacity}, 95, ${MARKER})
      on conflict (code) do update set capacity = excluded.capacity
      returning id
    `
    rooms.set(code, (room as { id: string }).id)
  }

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, 'blife03-probe', 'Probe massage', 'Normal Massage (Asian)',
            ${TURNAROUND_MINUTES}, 97)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  const serviceId = (service as { id: string }).id
  for (const roomType of ['standard', 'couples'] as const) {
    await sql`
      insert into service_room_type_compat (service_style, service_treatment_key, room_type)
      values ('asian', ${PROBE}, ${roomType}::room_type)
      on conflict do nothing
    `
  }
  // `required_room_type` is NULL for solo and couple for the reason B-AVAIL-06's fixture gives: 0017 seeds
  // couple as `couples`-only, which would refuse a couple in a standard room by room TYPE before the places
  // rule was ever consulted.
  for (const [shape, therapists, minCapacity, requiredRoomType] of [
    ['solo', 1, 1, null],
    ['four_hands', 2, 1, 'standard'],
    ['couple', 2, 2, null],
  ] as const) {
    await sql`
      insert into service_resource_shape
        (service_style, service_treatment_key, shape, therapists_required, rooms_required,
         min_room_capacity, required_room_type, therapist_buffer_minutes)
      values ('asian', ${PROBE}, ${shape}::service_shape, ${therapists}, 1, ${minCapacity},
              ${requiredRoomType}::room_type, ${BUFFER_MINUTES})
      on conflict do nothing
    `
  }
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${serviceId}, 45, ${GROSS_FILS}, ${MARKER})
    on conflict (service_id, duration_minutes)
      do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = (variant as { id: string }).id

  await addEmployee({ reference: 'blife03-a', gender: 'female' })
  await addEmployee({ reference: 'blife03-b', gender: 'female' })
  await addEmployee({ reference: 'blife03-c', gender: 'female' })
  await addEmployee({ reference: 'blife03-d', gender: 'female' })
  // A licence that expires ON the first trading date. `expires_on < trading_date` is the exclusion rule
  // (B-AVAIL-04), so this therapist is eligible on the 4th and NOT on the 5th — which is what makes
  // "the eligibility model is re-applied against the date the appointment is MOVING to" testable.
  await addEmployee({
    reference: 'blife03-expiring',
    gender: 'female',
    documents: [
      { type: 'professional_licence', expiresOn: TRADING_DATE },
      { type: 'health_certificate', expiresOn: '2099-12-31' },
    ],
  })

  for (const [date, nextCalendarDate] of [
    [TRADING_DATE, NEXT_TRADING_DATE],
    [NEXT_TRADING_DATE, '2099-12-06'],
  ] as const) {
    const [shift] = await sql<{ id: string }[]>`
      insert into shift (trading_date, period, label)
      values (${date},
              ${`[${dubai(date, '11')},${dubai(nextCalendarDate, '02')})`}::tstzrange, ${MARKER})
      returning id
    `
    for (const id of staff.values()) {
      await sql`
        insert into shift_assignment (shift_id, employee_id)
        values (${(shift as { id: string }).id}, ${id})
      `
    }
  }
})

afterEach(async () => {
  // Cascades to `appointment` and to `booking_idempotency`, which is what releases this file's keys between
  // cases. `appointment_status_history`, `audit_event` and `outbox_event` are append-only or shared and are
  // left alone — every assertion above is a delta or a per-appointment key set.
  await sql`delete from appointment where booking_id in (select id from booking where notes = ${MARKER})`
  await sql`delete from booking where notes = ${MARKER}`
})

afterAll(async () => {
  await sql`delete from appointment where booking_id in (select id from booking where notes = ${MARKER})`
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from shift_assignment where employee_id = any(${[...staff.values()]}::uuid[])`
  await sql`delete from shift where label = ${MARKER}`
  await sql`delete from employee_document where employee_id = any(${[...staff.values()]}::uuid[])`
  await sql`delete from employee_skill where employee_id = any(${[...staff.values()]}::uuid[])`
  await sql`delete from employee where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from business_day where trading_date = any(${[TRADING_DATE, NEXT_TRADING_DATE]}::date[])`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await probe?.end({ timeout: 5 })
  await sql?.end({ timeout: 5 })
})

describe('acceptance — a reschedule releases the old period and acquires the new one, in one transaction', () => {
  it('supersedes the old row, writes a successor holding the new period, and copies the snapshot', async () => {
    const booked = await book({
      key: 'move-one',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string

    const result = await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: original,
        actor: OWNER,
        reason: REASON,
        treatment: { startsAt: at(TRADING_DATE, '21:00'), endsAt: at(TRADING_DATE, '21:45') },
      },
      RESCHEDULE_DEPS,
    )

    const predecessor = (await appointmentById(original)) as AppointmentRow
    const successor = (await appointmentById(
      result.rows[0]?.successorId as string,
    )) as AppointmentRow

    // The old row is superseded and holds nothing: `holds_resources` is GENERATED from the status (0024),
    // so the release is a property of the status change rather than a second column somebody must remember.
    expect(predecessor.status).toBe('rescheduled')
    expect(predecessor.holds_resources).toBe(false)
    // The new row holds the new period and points back at the row it replaced.
    expect(successor.holds_resources).toBe(true)
    expect(successor.rescheduled_from_id).toBe(original)
    expect(successor.starts_at.getTime()).toBe(at(TRADING_DATE, '21:00'))
    expect(successor.delivery_id).not.toBe(predecessor.delivery_id)
    // Not re-priced and not re-read from the catalogue: a reschedule is the same sale at another time, and
    // the two snapshotted figures are the ones in force when it was TAKEN (0038).
    expect(successor.gross_price_fils).toBe(predecessor.gross_price_fils)
    expect(successor.net_fils).toBe(predecessor.net_fils)
    expect(successor.vat_fils).toBe(predecessor.vat_fils)
    expect(successor.turnaround_minutes).toBe(predecessor.turnaround_minutes)
    expect(successor.therapist_buffer_minutes).toBe(predecessor.therapist_buffer_minutes)
    expect(successor.room_places).toBe(predecessor.room_places)
    // And the status the successor is born in is the mapping core declares, not a guess made here.
    expect(successor.status).toBe(successorStatusFor('confirmed'))
  })

  it('moves a treatment by thirty minutes, which only commits if the old period was released first', async () => {
    // The commonest front-desk correction there is, and the one that proves the ORDER. The new period
    // OVERLAPS the old for the same therapist and the same room, so `appointment_therapist_no_overlap` —
    // which is immediate, not deferred — refuses the successor unless the predecessor has already stopped
    // holding its period. Gate 56j breaks the release and watches this case fail.
    const booked = await book({
      key: 'overlap',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string

    const result = await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: original,
        actor: OWNER,
        reason: REASON,
        treatment: { startsAt: at(TRADING_DATE, '19:30'), endsAt: at(TRADING_DATE, '20:15') },
      },
      RESCHEDULE_DEPS,
    )
    const successor = (await appointmentById(
      result.rows[0]?.successorId as string,
    )) as AppointmentRow
    expect(successor.starts_at.getTime()).toBe(at(TRADING_DATE, '19:30'))
    expect(successor.therapist_id).toBe(idOf('blife03-a'))
    expect(successor.room_id).toBe(roomId(SINGLE_ROOM))
    expect(((await appointmentById(original)) as AppointmentRow).holds_resources).toBe(false)
  })

  it('holds the room row under FOR UPDATE for the whole transaction', async () => {
    const booked = await book({
      key: 'lock',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string

    // The decisive assertion, and B-AVAIL-06 recorded why the obvious one is not: inserting an appointment
    // makes PostgreSQL check `appointment_room_id_fkey`, which takes FOR KEY SHARE on the parent `rooms`
    // row — and FOR KEY SHARE is also a RowShareLock at table level, so a `pg_locks` row appears whether
    // the transaction took the lock deliberately or not. A competing `for share nowait` is compatible with
    // FOR KEY SHARE and CONFLICTS with FOR UPDATE, so 55P03 is the proof.
    const held = await withUnitOfWork(sql, CALLER, async (uow) => {
      await rescheduleAppointment(
        uow,
        {
          appointmentId: original,
          actor: OWNER,
          reason: REASON,
          treatment: { startsAt: at(TRADING_DATE, '21:00'), endsAt: at(TRADING_DATE, '21:45') },
        },
        RESCHEDULE_DEPS,
      )
      return await stateOf(
        probe`select 1 from rooms where id = ${roomId(SINGLE_ROOM)} for share nowait`,
      )
    })
    expect(held).toBe('55P03')

    // The control. The same probe outside any transaction succeeds, so the 55P03 above is about the lock
    // this transaction held and not about a statement that cannot run at all.
    expect(
      await stateOf(probe`select 1 from rooms where id = ${roomId(SINGLE_ROOM)} for share nowait`),
    ).toBeUndefined()
  })

  it('leaves the old appointment byte-identical when the new slot is taken', async () => {
    // Two bookings in one room: the one being moved, and the one occupying the period it is moved into.
    const moving = await book({
      key: 'byte-identical-moving',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    await book({
      key: 'byte-identical-blocking',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-b'],
      startsAt: at(TRADING_DATE, '21:00'),
      endsAt: at(TRADING_DATE, '21:45'),
    })
    const original = moving.appointmentIds[0] as string

    const before = await snapshotOf(original)
    const historyBefore = await historyCount(original)
    const auditBefore = await auditCount(original)
    const eventsBefore = (await eventsOf(original)).length

    expect(
      await refusalOf(
        rescheduleAppointmentTx(
          sql,
          {
            appointmentId: original,
            actor: OWNER,
            reason: REASON,
            treatment: { startsAt: at(TRADING_DATE, '21:00'), endsAt: at(TRADING_DATE, '21:45') },
          },
          RESCHEDULE_DEPS,
        ),
      ),
    ).toBe('slot_taken')

    // The WHOLE row, compared as canonical JSON text. `updated_at` is in there, which is the column a
    // partial snapshot would miss: the transaction sets the status to `rescheduled` before it discovers the
    // new slot is taken, and `set_updated_at` fires on that UPDATE — so anything short of a rollback shows
    // up here even though `status` is back to what it was.
    expect(await snapshotOf(original)).toBe(before)
    // And nothing was left behind in any of the three records either.
    expect(await historyCount(original)).toBe(historyBefore)
    expect(await auditCount(original)).toBe(auditBefore)
    expect((await eventsOf(original)).length).toBe(eventsBefore)
    // The control: the row really is still holding its own period, so the comparison above is not passing
    // against a row that was deleted.
    expect(((await appointmentById(original)) as AppointmentRow).status).toBe('confirmed')
  })

  it('leaves the old appointment byte-identical when the therapist is already booked', async () => {
    // A different failure LAYER: the exclusion constraint rather than the injected re-check. The re-check
    // only counts room places (`assignShape`), so a therapist clash is refused by
    // `appointment_therapist_no_overlap` at the INSERT — after the old period has been released.
    const moving = await book({
      key: 'clash-moving',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    await book({
      key: 'clash-blocking',
      shape: 'solo',
      room: SECOND_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '22:00'),
      endsAt: at(TRADING_DATE, '22:45'),
    })
    const original = moving.appointmentIds[0] as string
    const before = await snapshotOf(original)

    expect(
      await refusalOf(
        rescheduleAppointmentTx(
          sql,
          {
            appointmentId: original,
            actor: OWNER,
            reason: REASON,
            treatment: { startsAt: at(TRADING_DATE, '22:00'), endsAt: at(TRADING_DATE, '22:45') },
          },
          RESCHEDULE_DEPS,
        ),
      ),
    ).toBe('slot_taken')
    expect(await snapshotOf(original)).toBe(before)
    // The control, for the same reason the case above needs one: two nulls compare equal, so the snapshot
    // assertion has to be paired with proof that the row is still there holding its own period.
    expect(((await appointmentById(original)) as AppointmentRow).status).toBe('confirmed')
  })

  it('takes both room rows in ascending id order, so two opposite reschedules do not deadlock', async () => {
    // Two appointments in two rooms, swapped back and forth. Each transaction writes BOTH rooms, and the
    // two requests name them in opposite orders — which deadlocks unless every writer sorts. `lockRooms` is
    // B-AVAIL-06's own function and the sort is at this unit's call site; gate 56h removes it and
    // watches this case fail.
    const first = await book({
      key: 'deadlock-a',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const second = await book({
      key: 'deadlock-b',
      shape: 'solo',
      room: SECOND_ROOM,
      therapists: ['blife03-b'],
      startsAt: at(TRADING_DATE, '20:00'),
      endsAt: at(TRADING_DATE, '20:45'),
    })
    let live: readonly [string, string] = [
      first.appointmentIds[0] as string,
      second.appointmentIds[0] as string,
    ]
    let liveRooms: readonly [string, string] = [SINGLE_ROOM, SECOND_ROOM]

    for (let iteration = 0; iteration < 20; iteration += 1) {
      // Swap the rooms. Request A names (its own room, then the other); request B names them the other way
      // round, because each starts from the room it is in.
      const swapped: readonly [string, string] = [liveRooms[1], liveRooms[0]]
      const moves = await Promise.all([
        rescheduleAppointmentTx(
          sql,
          {
            appointmentId: live[0],
            actor: OWNER,
            reason: REASON,
            roomId: roomId(swapped[0]),
            treatment: { startsAt: at(TRADING_DATE, '19:00'), endsAt: at(TRADING_DATE, '19:45') },
          },
          RESCHEDULE_DEPS,
        ),
        rescheduleAppointmentTx(
          sql,
          {
            appointmentId: live[1],
            actor: OWNER,
            reason: REASON,
            roomId: roomId(swapped[1]),
            treatment: { startsAt: at(TRADING_DATE, '20:00'), endsAt: at(TRADING_DATE, '20:45') },
          },
          RESCHEDULE_DEPS,
        ),
      ])
      live = [moves[0].rows[0]?.successorId as string, moves[1].rows[0]?.successorId as string]
      liveRooms = swapped
    }

    // 40 reschedules over two rooms in two orders, and the assertion is that none of them raised 40P01.
    // The pair is still live and still in opposite rooms.
    const [one, two] = [await appointmentById(live[0]), await appointmentById(live[1])]
    expect(one?.holds_resources).toBe(true)
    expect(two?.holds_resources).toBe(true)
    expect(one?.room_id).not.toBe(two?.room_id)
  })

  it('moves every row of a four-hands delivery together, into one new delivery', async () => {
    // `appointment_delivery_is_coherent` exists because "a reschedule that moved one row of a Four Hands
    // would silently split it into two deliveries". Both rows move, and they share ONE new delivery id.
    const booked = await book({
      key: 'four-hands',
      shape: 'four_hands',
      room: SINGLE_ROOM,
      therapists: ['blife03-a', 'blife03-b'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    expect(booked.appointmentIds.length).toBe(2)

    const result = await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: booked.appointmentIds[0] as string,
        actor: OWNER,
        reason: REASON,
        treatment: { startsAt: at(TRADING_DATE, '21:00'), endsAt: at(TRADING_DATE, '21:45') },
      },
      RESCHEDULE_DEPS,
    )
    expect(result.rows.length).toBe(2)

    const successors = await Promise.all(result.rows.map((row) => appointmentById(row.successorId)))
    expect(new Set(successors.map((row) => row?.delivery_id)).size).toBe(1)
    expect(successors.every((row) => row?.holds_resources === true)).toBe(true)
    // Both predecessors were superseded, so the old period is free for both therapists.
    for (const id of booked.appointmentIds) {
      expect(((await appointmentById(id)) as AppointmentRow).status).toBe('rescheduled')
    }
  })

  it('refuses a move that changes nothing, and one the transition table forbids', async () => {
    const booked = await book({
      key: 'refusals',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string
    const move = (overrides: Partial<RescheduleInput>) =>
      rescheduleAppointmentTx(
        sql,
        {
          appointmentId: original,
          actor: OWNER,
          reason: REASON,
          treatment: { startsAt: at(TRADING_DATE, '21:00'), endsAt: at(TRADING_DATE, '21:45') },
          ...overrides,
        },
        RESCHEDULE_DEPS,
      )

    // The same period, room and therapists: nothing to move.
    expect(
      await refusalOf(
        move({
          treatment: { startsAt: at(TRADING_DATE, '19:00'), endsAt: at(TRADING_DATE, '19:45') },
        }),
      ),
    ).toBe('reschedule_changes_nothing')
    // The reason is mandatory, and the refusal is the DECIDER's — this unit does not re-implement it.
    expect(await refusalOf(move({ reason: '   ' }))).toBe('reason_required')
    // A role without `booking:reschedule` is refused by the F07 policy layer through the same decider.
    expect(await refusalOf(move({ actor: { ...OWNER, role: 'accountant' } }))).toBe(
      'transition_forbidden',
    )
    // And the start must belong to a trading date. 09:00 is the daytime gap: after the previous night's
    // close and before the day's opening.
    expect(
      await refusalOf(
        move({
          treatment: { startsAt: at(TRADING_DATE, '09:00'), endsAt: at(TRADING_DATE, '09:45') },
        }),
      ),
    ).toBe('new_slot_outside_trading')
    // Nothing above wrote anything: the row is still the one that was booked.
    expect(((await appointmentById(original)) as AppointmentRow).status).toBe('confirmed')
  })

  it('re-applies the eligibility read model against the date it is moving TO', async () => {
    // The licence expires ON the 4th, so this therapist is eligible that evening and not the next. A
    // reschedule that skipped the re-read would place the appointment with a therapist the availability
    // query refuses to offer — the hole `appointment.therapist_id`'s absent foreign key cannot close.
    const booked = await book({
      key: 'eligibility',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-expiring'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string

    expect(
      await refusalOf(
        rescheduleAppointmentTx(
          sql,
          {
            appointmentId: original,
            actor: OWNER,
            reason: REASON,
            treatment: {
              startsAt: at(NEXT_TRADING_DATE, '19:00'),
              endsAt: at(NEXT_TRADING_DATE, '19:45'),
            },
          },
          RESCHEDULE_DEPS,
        ),
      ),
    ).toBe('therapist_not_eligible')

    // The control: the same move on the SAME trading date is accepted, so the refusal is about the date
    // rather than about this therapist being unbookable at all.
    const ok = await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: original,
        actor: OWNER,
        reason: REASON,
        treatment: { startsAt: at(TRADING_DATE, '21:00'), endsAt: at(TRADING_DATE, '21:45') },
      },
      RESCHEDULE_DEPS,
    )
    expect(ok.tradingDate).toBe(TRADING_DATE)
  })
})

describe('acceptance — the reschedule event carries the periods and the scheduled-step keys', () => {
  it('emits one appointment.rescheduled carrying old_period, new_period and the key list', async () => {
    const booked = await book({
      key: 'event',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string

    const result = await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: original,
        actor: OWNER,
        reason: REASON,
        treatment: { startsAt: at(TRADING_DATE, '21:00'), endsAt: at(TRADING_DATE, '21:45') },
      },
      RESCHEDULE_DEPS,
    )

    const events = await eventsOf(original)
    const rescheduled = events.filter((row) => row.event_type === 'appointment.rescheduled')
    expect(rescheduled.length).toBe(1)
    const event = rescheduled[0] as EventRow
    expect(event.idempotency_key).toBe(`appointment.rescheduled:${original}`)
    // Periods as DATA — two instants — rather than as a rendered `[a,b)` range literal a reader would have
    // to parse (the lesson B-AVAIL-07 records about pre-rendered strings).
    expect(event.payload['old_period']).toEqual({
      starts_at: new Date(at(TRADING_DATE, '19:00')).toISOString(),
      ends_at: new Date(at(TRADING_DATE, '19:45')).toISOString(),
    })
    expect(event.payload['new_period']).toEqual({
      starts_at: new Date(at(TRADING_DATE, '21:00')).toISOString(),
      ends_at: new Date(at(TRADING_DATE, '21:45')).toISOString(),
    })
    expect(event.payload['successor_appointment_id']).toBe(result.rows[0]?.successorId)
    // The canonical facts still win: `extra` is spread FIRST, so a caller cannot overwrite them.
    expect(event.payload['toStatus']).toBe('rescheduled')
    expect(event.payload['fromStatus']).toBe('confirmed')
  })

  it('carries the keys of the steps ACTUALLY present, which is non-empty now that the table exists', async () => {
    /*
      The assertion B-LIFE-03 DEFERRED, written the day B-MSG-03 landed.

      Its own NOTE said why it could not be made then: `scheduled_step` did not exist, "no step row was
      faked to make the criterion pass", and the empty list was EXPLAINED rather than assumed by asserting
      `to_regclass('public.scheduled_step') is null` beside it. Migration 0051 creates the table, so the
      explanation flips and the criterion — "the key list is non-empty and matches the steps actually in the
      table" — is now assertable with real rows and no stub.

      The steps are built through B-MSG-03's own maintainer rather than by hand: a key this test composed
      itself would agree with `readScheduledStepKeys` however wrong both were.
    */
    const [present] = await sql<{ table_exists: boolean }[]>`
      select to_regclass('public.scheduled_step') is not null as table_exists
    `
    expect(present?.table_exists).toBe(true)

    const booked = await book({
      key: 'steps',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string
    // `createBooking` sells this appointment already `confirmed` and never transitions into that status,
    // so the reminder set is built through the same maintainer the lifecycle injects.
    await withUnitOfWork(sql, CALLER, (uow) =>
      buildScheduledSteps(uow, { appointmentId: original }, { plan: stepPlan }),
    )
    const attached = await scheduledStepsFor(sql, original)
    const keys = [...attached.map((step) => step.invalidationKey)].sort()
    expect(keys.length).toBeGreaterThan(0)

    // The reader agrees with the ROWS, which is the criterion. `ORDER BY invalidation_key` in the reader is
    // why the expectation is sorted rather than in plan order.
    expect(await readScheduledStepKeys(sql, original)).toEqual({ tablePresent: true, keys })

    const result = await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: original,
        actor: OWNER,
        reason: REASON,
        treatment: { startsAt: at(TRADING_DATE, '21:00'), endsAt: at(TRADING_DATE, '21:45') },
      },
      { ...RESCHEDULE_DEPS, steps: stepMaintainer },
    )
    expect(result.scheduledSteps).toEqual({ tablePresent: true, keys })
    const event = (await eventsOf(original)).find(
      (row) => row.event_type === 'appointment.rescheduled',
    ) as EventRow
    expect(event.payload['scheduled_step_invalidation_keys']).toEqual(keys)
    expect(event.payload['scheduled_step_table']).toBe('present')
    // And the keys it carried are the ones being INVALIDATED: every one of them now belongs to a superseded
    // row, and the successor's live set is a different set entirely.
    const superseded = await scheduledStepsFor(sql, original)
    expect(superseded.map((step) => step.state)).toEqual(attached.map(() => 'superseded'))
    const successorKeys = (await scheduledStepsFor(sql, result.rows[0]?.successorId as string)).map(
      (step) => step.invalidationKey,
    )
    for (const key of successorKeys) expect(keys).not.toContain(key)
  })

  it('carries the keys the reader FOUND, asserted with a reader that finds two', async () => {
    // The control the case above needs. An empty list is what an empty list looks like whether the payload
    // carries the reader's answer or a hard-coded `[]`, so the seam is exercised with a reader that returns
    // keys: this is the assertion that will still be meaningful the day B-MSG-03 lands.
    const booked = await book({
      key: 'steps-stub',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string
    const stub: ScheduledStepKeyReader = async (_sql, appointmentId) => ({
      tablePresent: true,
      keys: [`reminder_24h:${appointmentId}`, `reminder_2h:${appointmentId}`],
    })

    const result = await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: original,
        actor: OWNER,
        reason: REASON,
        treatment: { startsAt: at(TRADING_DATE, '21:00'), endsAt: at(TRADING_DATE, '21:45') },
      },
      { ...RESCHEDULE_DEPS, readScheduledStepKeys: stub },
    )
    expect(result.scheduledSteps.keys).toEqual([
      `reminder_24h:${original}`,
      `reminder_2h:${original}`,
    ])
    const event = (await eventsOf(original)).find(
      (row) => row.event_type === 'appointment.rescheduled',
    ) as EventRow
    expect(event.payload['scheduled_step_invalidation_keys']).toEqual([
      `reminder_24h:${original}`,
      `reminder_2h:${original}`,
    ])
    expect(event.payload['scheduled_step_table']).toBe('present')
  })

  it('advances the availability epoch of both trading dates, by B-AVAIL-07 s trigger', async () => {
    // Asserted rather than reimplemented. 0045 advances the epoch of every date an appointment write
    // touches, OLD and NEW, so a reschedule across midnight invalidates both memos with no step here.
    const booked = await book({
      key: 'epoch',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '23:00'),
      endsAt: at(TRADING_DATE, '23:45'),
    })
    const before = {
      from: await epochOf(TRADING_DATE),
      to: await epochOf(NEXT_TRADING_DATE),
    }

    await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: booked.appointmentIds[0] as string,
        actor: OWNER,
        reason: REASON,
        treatment: {
          startsAt: at(NEXT_TRADING_DATE, '19:00'),
          endsAt: at(NEXT_TRADING_DATE, '19:45'),
        },
      },
      RESCHEDULE_DEPS,
    )

    const after = { from: await epochOf(TRADING_DATE), to: await epochOf(NEXT_TRADING_DATE) }
    // A DELTA on each date, never a total: `availability_epoch` is shared and monotonic.
    expect(Number(after.from?.epoch)).toBeGreaterThan(Number(before.from?.epoch ?? 0))
    expect(Number(after.to?.epoch)).toBeGreaterThan(Number(before.to?.epoch ?? 0))
    expect(after.from?.cause).toBe('appointment')
    expect(after.to?.cause).toBe('appointment')
  })
})

describe('acceptance — a reschedule across midnight re-resolves the business day', () => {
  const moveTo = async (
    key: string,
    to: { readonly date: string; readonly hhmm: string },
  ): Promise<{ tradingDate: string; storedTradingDate: string }> => {
    // 23:50 on the 4th: inside the 4th's 11:00-02:00 session, and on the 4th's calendar date.
    const booked = await book({
      key,
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '23:50'),
      endsAt: at(NEXT_TRADING_DATE, '00:35'),
    })
    const original = booked.appointmentIds[0] as string
    expect(((await appointmentById(original)) as AppointmentRow).trading_date).toBe(TRADING_DATE)

    const result = await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: original,
        actor: OWNER,
        reason: REASON,
        treatment: {
          startsAt: at(to.date, to.hhmm),
          endsAt: at(to.date, to.hhmm) + 45 * MINUTE,
        },
      },
      RESCHEDULE_DEPS,
    )
    const successor = (await appointmentById(
      result.rows[0]?.successorId as string,
    )) as AppointmentRow
    return { tradingDate: result.tradingDate, storedTradingDate: successor.trading_date }
  }

  it('keeps the trading date when 23:50 moves to 00:30', async () => {
    // 00:30 on the 5th is inside the 4th's session, so the trading date does not move. Truncating the new
    // start's calendar date answers the 5th — the defect this criterion exists to catch, and one that works
    // correctly all afternoon.
    const moved = await moveTo('midnight-keeps', { date: NEXT_TRADING_DATE, hhmm: '00:30' })
    expect(moved.tradingDate).toBe(TRADING_DATE)
    // Asserted on the STORED value, which is the foreign key into `business_day` (0024) — the business-day
    // id the rota, the cash-up and the commission are all cut on.
    expect(moved.storedTradingDate).toBe(TRADING_DATE)
  })

  it('moves to the next trading date when 23:50 moves to 11:30 the following morning', async () => {
    const moved = await moveTo('midnight-moves', { date: NEXT_TRADING_DATE, hhmm: '11:30' })
    expect(moved.tradingDate).toBe(NEXT_TRADING_DATE)
    expect(moved.storedTradingDate).toBe(NEXT_TRADING_DATE)
  })
})

describe('acceptance — the cancellation window is a provisional F09 setting that flags, never charges', () => {
  it('is declared provisional in the registry, and the three packages spell the key once', async () => {
    const definition = getDefinition(CANCELLATION_WINDOW_SETTING_KEY)
    expect(definition.provisional?.openQuestionId).toBe('Y9-windows')
    expect(definition.defaultValue).toBe(DEFAULT_CANCELLATION_WINDOW_HOURS)
    // The key lives in three packages that may not import each other — the registry, the rule and the
    // reader — and this is the only place all three can be compared.
    expect(CANCELLATION_WINDOW_SETTING_KEY).toBe(CORE_WINDOW_KEY)
    expect(definition.key).toBe(CANCELLATION_WINDOW_SETTING_KEY)
    // And the stored row, if one exists, is flagged provisional in the database too.
    const [row] = await sql<{ is_provisional: boolean; open_question_id: string | null }[]>`
      select is_provisional, open_question_id from app_setting
       where key = ${CANCELLATION_WINDOW_SETTING_KEY}
    `
    if (row !== undefined) {
      expect(row.is_provisional).toBe(true)
      expect(row.open_question_id).toBe('Y9-windows')
    }
  })

  it('sets late_cancellation inside the window and creates zero payment, invoice or fee rows', async () => {
    const booked = await book({
      key: 'late-cancel',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string
    const before = await moneyRowCounts()

    const cancelled = await cancelAppointmentTx(
      sql,
      {
        appointmentId: original,
        to: 'cancelled_by_customer',
        actor: OWNER,
        reason: 'the client is unwell',
        // One hour before the start, which is inside the 24-hour window. The instant is an ARGUMENT.
        nowMs: at(TRADING_DATE, '18:00'),
      },
      CANCEL_DEPS,
    )
    expect(cancelled.lateCancellation).toBe(true)
    expect(cancelled.windowHours).toBe(DEFAULT_CANCELLATION_WINDOW_HOURS)
    expect(cancelled.chargeFils).toBe(0)

    const row = (await appointmentById(original)) as AppointmentRow
    expect(row.status).toBe('cancelled_by_customer')
    expect(row.late_cancellation).toBe(true)
    // The window is stored beside the flag, because the setting is provisional and a flag whose figure is
    // unrecoverable cannot be accounted for by the fee policy that later reads it.
    expect(Number(row.late_cancellation_window_hours)).toBe(DEFAULT_CANCELLATION_WINDOW_HOURS)

    // DELTAS of zero on all four money tables, counted in SQL.
    const after = await moneyRowCounts()
    expect(after).toEqual(before)
    // And there is no payment or fee table in the schema at all: the business takes no card payments, so a
    // fee that charged anything would be inventing a capability rather than using one.
    const [tables] = await sql<{ n: string }[]>`
      select count(*)::text as n from information_schema.tables
       where table_schema = 'public'
         and (table_name like '%payment%' or table_name like '%fee%')
    `
    expect(Number(tables?.n)).toBe(0)
    // The event and the audit row record the amount as zero rather than omitting it — an absent amount
    // reads as "not considered".
    const event = (await eventsOf(original)).find(
      (candidate) => candidate.event_type === 'appointment.cancelled_by_customer',
    ) as EventRow
    expect(event.payload['charge_fils']).toBe(0)
    expect(event.payload['late_cancellation']).toBe(true)
    expect(event.payload['cancellation_window_hours']).toBe(DEFAULT_CANCELLATION_WINDOW_HOURS)
  })

  it('leaves the flag false outside the window, with no window figure stored', async () => {
    // The control. Without it, "sets the flag" is satisfied by a column that is true for every
    // cancellation, which is a flag that says nothing.
    const booked = await book({
      key: 'early-cancel',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string

    const cancelled = await cancelAppointmentTx(
      sql,
      {
        appointmentId: original,
        to: 'cancelled_by_customer',
        actor: OWNER,
        // Thirty hours before the start: outside the 24-hour window.
        nowMs: at(TRADING_DATE, '19:00') - 30 * 60 * MINUTE,
      },
      CANCEL_DEPS,
    )
    expect(cancelled.lateCancellation).toBe(false)

    const row = (await appointmentById(original)) as AppointmentRow
    expect(row.late_cancellation).toBe(false)
    // Whole-or-nothing (0049): no flag, no figure.
    expect(row.late_cancellation_window_hours).toBeNull()
  })

  it('refuses the flag on an appointment that is not cancelled, by constraint name', async () => {
    // The database's half of the rule, as a known-bad fixture. A completed treatment carrying the flag is
    // the shape of a sweep that updated the wrong rows, and a fee policy reading it would charge for a
    // massage that was delivered.
    const booked = await book({
      key: 'flag-constraint',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string
    const failure = await sql`
      update appointment set late_cancellation = true, late_cancellation_window_hours = 24
       where id = ${original}
    `.catch((error: unknown) => error)
    expect(String(failure)).toContain('appointment_late_cancellation_needs_a_cancellation')
    // And half the record is refused too: a flag with no figure.
    const half = await sql`
      update appointment set late_cancellation = true where id = ${original}
    `.catch((error: unknown) => error)
    expect(String(half)).toContain('appointment_late_cancellation_is_whole')
  })
})

describe('acceptance — NO_SHOW is reachable only once the start is in the past', () => {
  it('refuses one minute before the start and accepts one minute after', async () => {
    const booked = await book({
      key: 'no-show',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string
    const start = at(TRADING_DATE, '19:00')
    const historyBefore = await historyCount(original)
    const auditBefore = await auditCount(original)

    // Frozen clock, one minute before. The instant is an argument, so this case reads the same at 03:00.
    expect(
      await refusalOf(
        markNoShowTx(
          sql,
          { appointmentId: original, actor: OWNER, nowMs: start - MINUTE },
          NO_SHOW_DEPS,
        ),
      ),
    ).toBe('appointment_not_started')
    // The guard runs BEFORE the transition, so nothing was recorded against the customer.
    expect(await historyCount(original)).toBe(historyBefore)
    expect(await auditCount(original)).toBe(auditBefore)
    expect(((await appointmentById(original)) as AppointmentRow).status).toBe('confirmed')

    // One minute after.
    const marked = await markNoShowTx(
      sql,
      { appointmentId: original, actor: OWNER, nowMs: start + MINUTE },
      NO_SHOW_DEPS,
    )
    expect(marked.transition.kind).toBe('transitioned')
    expect(marked.minutesSinceStart).toBe(1)
    const row = (await appointmentById(original)) as AppointmentRow
    expect(row.status).toBe('no_show')
    // A no-show releases the room and the therapist: `holds_resources` is false for it (0024).
    expect(row.holds_resources).toBe(false)
  })

  it('is reachable from CHECKED_IN as well as CONFIRMED, and from nothing else', async () => {
    const booked = await book({
      key: 'no-show-checked-in',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string
    const start = at(TRADING_DATE, '19:00')

    await transitionAppointmentTx(
      sql,
      { appointmentId: original, to: 'checked_in', actor: OWNER },
      { decide },
    )
    const marked = await markNoShowTx(
      sql,
      { appointmentId: original, actor: OWNER, nowMs: start + MINUTE },
      NO_SHOW_DEPS,
    )
    expect(marked.transition.kind).toBe('transitioned')

    // And from a state the table does not permit: the clock guard passes and the DECIDER refuses, which is
    // what "the guard narrows and never widens" means.
    const second = await book({
      key: 'no-show-illegal',
      shape: 'solo',
      room: SECOND_ROOM,
      therapists: ['blife03-b'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const other = second.appointmentIds[0] as string
    for (const to of ['checked_in', 'in_progress', 'completed'] as const) {
      await transitionAppointmentTx(sql, { appointmentId: other, to, actor: OWNER }, { decide })
    }
    expect(
      await refusalOf(
        markNoShowTx(
          sql,
          { appointmentId: other, actor: OWNER, nowMs: start + MINUTE },
          NO_SHOW_DEPS,
        ),
      ),
    ).toBe('illegal_transition')
  })

  it('is owner-or-manager only, and a receptionist is refused by the policy layer', async () => {
    const booked = await book({
      key: 'no-show-role',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    expect(
      await refusalOf(
        markNoShowTx(
          sql,
          {
            appointmentId: booked.appointmentIds[0] as string,
            actor: { ...OWNER, role: 'receptionist' },
            nowMs: at(TRADING_DATE, '19:00') + MINUTE,
          },
          NO_SHOW_DEPS,
        ),
      ),
    ).toBe('transition_forbidden')
  })
})

describe('acceptance — cancelling a multi-appointment booking cancels every appointment or none', () => {
  /** The couples booking: one delivery, two appointment rows, two client places in the couples room. */
  const coupleBooking = async (key: string) => {
    const booked = await book({
      key,
      shape: 'couple',
      room: COUPLES_ROOM,
      therapists: ['blife03-a', 'blife03-b'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    expect(booked.appointmentIds.length).toBe(2)
    return booked
  }

  it('cancels both rows of a couples booking in one transaction', async () => {
    const booked = await coupleBooking('couple-both')
    const result = await cancelBookingTx(
      sql,
      {
        bookingId: booked.bookingId,
        to: 'cancelled_by_salon',
        actor: OWNER,
        reason: 'the therapist called in sick',
        nowMs: at(TRADING_DATE, '18:00'),
      },
      CANCEL_DEPS,
    )
    expect(result.appointments.length).toBe(2)
    for (const id of booked.appointmentIds) {
      const row = (await appointmentById(id)) as AppointmentRow
      expect(row.status).toBe('cancelled_by_salon')
      expect(row.late_cancellation).toBe(true)
    }
  })

  it('cancels the live successor of a rescheduled appointment and leaves the superseded row alone', async () => {
    // The interaction between this unit's two halves, and the defect it was found by: a reschedule leaves
    // the SUPERSEDED row in the same booking, and `rescheduled` is terminal — so a cancellation that took
    // every row of the booking would be refused by the old one for ever, and the customer's live
    // appointment could not be cancelled at all.
    const booked = await book({
      key: 'cancel-after-reschedule',
      shape: 'solo',
      room: SINGLE_ROOM,
      therapists: ['blife03-a'],
      startsAt: at(TRADING_DATE, '19:00'),
      endsAt: at(TRADING_DATE, '19:45'),
    })
    const original = booked.appointmentIds[0] as string
    const moved = await rescheduleAppointmentTx(
      sql,
      {
        appointmentId: original,
        actor: OWNER,
        reason: REASON,
        treatment: { startsAt: at(TRADING_DATE, '21:00'), endsAt: at(TRADING_DATE, '21:45') },
      },
      RESCHEDULE_DEPS,
    )
    const successorId = moved.rows[0]?.successorId as string
    const supersededBefore = await snapshotOf(original)

    const result = await cancelBookingTx(
      sql,
      {
        bookingId: booked.bookingId,
        to: 'cancelled_by_customer',
        actor: OWNER,
        nowMs: at(TRADING_DATE, '20:30'),
      },
      CANCEL_DEPS,
    )
    // Exactly one appointment was cancelled: the live one.
    expect(result.appointments.map((row) => row.appointmentId)).toEqual([successorId])
    expect(((await appointmentById(successorId)) as AppointmentRow).status).toBe(
      'cancelled_by_customer',
    )
    // And the superseded row is byte-identical: rewriting it would be rewriting history.
    expect(await snapshotOf(original)).toBe(supersededBefore)
    expect(((await appointmentById(original)) as AppointmentRow).status).toBe('rescheduled')

    // A repeat is a no-op rather than "nothing to cancel": the row already in the target status is still
    // selected, and the transition table declares a repeated customer cancellation idempotent.
    const repeat = await cancelBookingTx(
      sql,
      {
        bookingId: booked.bookingId,
        to: 'cancelled_by_customer',
        actor: OWNER,
        nowMs: at(TRADING_DATE, '20:30'),
      },
      CANCEL_DEPS,
    )
    expect(repeat.appointments.map((row) => row.transition.kind)).toEqual(['no_op'])

    // And asking for the OTHER cancellation state, which nothing in this booking holds, is refused by
    // name rather than reported as a cancellation of nothing.
    expect(
      await refusalOf(
        cancelBookingTx(
          sql,
          {
            bookingId: booked.bookingId,
            to: 'cancelled_by_salon',
            actor: OWNER,
            reason: 'the gate asks for a state nothing in this booking holds',
            nowMs: at(TRADING_DATE, '20:30'),
          },
          CANCEL_DEPS,
        ),
      ),
    ).toBe('booking_has_nothing_to_cancel')
  })

  it('leaves BOTH rows untouched when the second cannot be moved (a real refusal, not a mock)', async () => {
    // The forced failure is a REAL one: the second appointment is driven to `completed` by real
    // transitions, and `completed` is terminal — so the decider refuses the second cancellation after the
    // first has already been written inside the same transaction.
    const booked = await coupleBooking('couple-completed')
    const [firstId, secondId] = booked.appointmentIds as readonly [string, string]
    for (const to of ['checked_in', 'in_progress', 'completed'] as const) {
      await transitionAppointmentTx(sql, { appointmentId: secondId, to, actor: OWNER }, { decide })
    }
    const before = { first: await snapshotOf(firstId), second: await snapshotOf(secondId) }

    expect(
      await refusalOf(
        cancelBookingTx(
          sql,
          {
            bookingId: booked.bookingId,
            to: 'cancelled_by_customer',
            actor: OWNER,
            nowMs: at(TRADING_DATE, '18:00'),
          },
          CANCEL_DEPS,
        ),
      ),
    ).toBe('illegal_transition')

    // Byte-identical, both of them. The first row was moved to `cancelled_by_customer` and its
    // `updated_at` was rewritten inside the transaction, so anything short of a rollback shows here.
    expect(await snapshotOf(firstId)).toBe(before.first)
    expect(await snapshotOf(secondId)).toBe(before.second)
    expect(((await appointmentById(firstId)) as AppointmentRow).status).toBe('confirmed')
    expect(((await appointmentById(secondId)) as AppointmentRow).status).toBe('completed')
  })

  it('leaves BOTH rows untouched when the second appointment s outbox key is already taken', async () => {
    // A second real forced failure, one layer down: the event the second cancellation must enqueue is
    // already in the outbox, so `publishEvent` answers null and `transitionAppointment` refuses with
    // `event_not_enqueued` rather than committing a state change nobody will hear about.
    const booked = await coupleBooking('couple-outbox')
    const [firstId, secondId] = booked.appointmentIds as readonly [string, string]
    await sql`
      insert into outbox_event (event_type, aggregate_type, aggregate_id, idempotency_key, payload)
      values ('appointment.cancelled_by_customer', 'appointment', ${secondId},
              ${`appointment.cancelled_by_customer:${secondId}`}, '{}'::jsonb)
    `
    const before = { first: await snapshotOf(firstId), second: await snapshotOf(secondId) }

    expect(
      await refusalOf(
        cancelBookingTx(
          sql,
          {
            bookingId: booked.bookingId,
            to: 'cancelled_by_customer',
            actor: OWNER,
            nowMs: at(TRADING_DATE, '18:00'),
          },
          CANCEL_DEPS,
        ),
      ),
    ).toBe('event_not_enqueued')
    expect(await snapshotOf(firstId)).toBe(before.first)
    expect(await snapshotOf(secondId)).toBe(before.second)

    // The control: with the key released the same call commits, so the two snapshots above are about the
    // key and not about a booking that could never be cancelled.
    await sql`
      delete from outbox_event where idempotency_key = ${`appointment.cancelled_by_customer:${secondId}`}
    `
    const result = await cancelBookingTx(
      sql,
      {
        bookingId: booked.bookingId,
        to: 'cancelled_by_customer',
        actor: OWNER,
        nowMs: at(TRADING_DATE, '18:00'),
      },
      CANCEL_DEPS,
    )
    expect(result.appointments.length).toBe(2)
  })
})
