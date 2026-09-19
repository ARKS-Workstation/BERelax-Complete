import { recheckShapeAssignment } from '@berelax/core'
import {
  type Actor,
  type BookingDeliveryInput,
  bookingRefusalOf,
  bookSlot,
  type CreateBookingInput,
  createConnection,
  type SlotRecheck,
  type Sql,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * B-AVAIL-06 — the two claims that only exist under concurrency, measured with real transactions racing.
 *
 * Both are about the room. A therapist cannot be in two places because of an exclusion constraint, and
 * constraints do not race; "a room holds as many people as it holds" is a **count**, and a count can be
 * taken twice. Two transactions each read a capacity-1 room as free, each decide there is a place, and
 * each commit one — which is two clients in a one-client room, discovered on the floor. `SELECT … FOR
 * UPDATE` on the `rooms` row is what serialises them (docs/01 decision 9, ADR 0024's consequences).
 *
 * ## Why a test that only checks a row exists afterwards is worthless here
 *
 * "A booking was created" is true whether the lock works or not — the difference is whether **two** were.
 * So every iteration below asserts the *shape of both outcomes*: exactly one promise fulfils, the other
 * rejects with the named `slot_taken`, and the room's peak client places never exceeds its capacity. An
 * iteration where both fulfil, both reject, or the loser fails for an unnamed reason fails the test.
 *
 * ## Isolation
 *
 * `2099-10-06` is used by no other suite and no gate. Every room, employee, service and variant is this
 * file's own; each iteration deletes its own bookings, which cascade to their appointments and their
 * idempotency claims. Nothing is deleted from `audit_event` or `appointment_status_history`.
 *
 * ## If this file fails with `sorry, too many clients already`
 *
 * Another worktree was running the integration suite at the same time. It is not this unit's failure;
 * re-run it. The pool sizes below are deliberately small for that reason.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'bavail06 concurrency itest'
const TRADING_DATE = '2099-10-06'
const PROBE = 'bavail06c_probe'
const PROBE_PHONE = '+971590000602'
/** The capacity-1 standard room every "last remaining slot" race is run in. */
const LAST_ROOM = 'bavail06c-last'
/** Two capacity-2 rooms, so the interleaved stress contends on LOCKS rather than on places. */
const TWIN_A = 'bavail06c-twin-a'
const TWIN_B = 'bavail06c-twin-b'

const GROSS_FILS = 20_000
const NET_FILS = 19_048
const VAT_FILS = 952

const CALLER: Actor = { kind: 'staff', label: 'B-AVAIL-06 concurrency itest' }
const DEPS = { recheck: recheckShapeAssignment satisfies SlotRecheck }

/** The acceptance figures, named so the report and the assertions cannot disagree. */
const LAST_SLOT_ITERATIONS = 100
const DEADLOCK_ITERATIONS = 200

let sql: Sql
let customerId: string
let variantId: string
const rooms = new Map<string, string>()
const staff: string[] = []

const roomId = (code: string): string => rooms.get(code) as string
const dubai = (hhmm: string): string => `${TRADING_DATE} ${hhmm}:00+04`
const at = (hhmm: string): number => Date.parse(`${TRADING_DATE}T${hhmm}:00+04:00`)

beforeAll(async () => {
  // 8 connections: two racing transactions at a time, plus headroom for the cleanup between iterations.
  // Small on purpose — the integration suite runs against one server and a 64-connection pool here would
  // be the `too many clients` failure the header warns about.
  sql = createConnection({ url, max: 8 })

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = (customer as { id: string }).id

  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${dubai('11')}::timestamptz, '2099-10-07 02:00:00+04'::timestamptz,
            'weekly')
    on conflict (trading_date) do nothing
  `

  for (const [code, capacity] of [
    [LAST_ROOM, 1],
    [TWIN_A, 2],
    [TWIN_B, 2],
  ] as const) {
    const [room] = await sql<{ id: string }[]>`
      insert into rooms (code, name, room_type, capacity, display_order, notes)
      values (${code}, ${`Race ${code}`}, 'standard', ${capacity}, 97, ${MARKER})
      on conflict (code) do update set capacity = excluded.capacity
      returning id
    `
    rooms.set(code, (room as { id: string }).id)
  }

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, ${'bavail06c-probe'}, ${'Race probe'}, ${'Normal Massage (Asian)'},
            20, 97)
    on conflict (style, treatment_key) do update set turnaround_minutes = 20
    returning id
  `
  const serviceId = (service as { id: string }).id
  await sql`
    insert into service_room_type_compat (service_style, service_treatment_key, room_type)
    values ('asian', ${PROBE}, 'standard')
    on conflict do nothing
  `
  await sql`
    insert into service_resource_shape
      (service_style, service_treatment_key, shape, therapists_required, rooms_required,
       min_room_capacity, required_room_type, therapist_buffer_minutes)
    values ('asian', ${PROBE}, 'solo', 1, 1, 1, 'standard', 10)
    on conflict do nothing
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${serviceId}, 60, ${GROSS_FILS}, ${MARKER})
    on conflict (service_id, duration_minutes)
      do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = (variant as { id: string }).id

  // Four therapists: one per delivery of the two interleaved bookings, so no race here is ever decided
  // by `appointment_therapist_no_overlap` instead of by the room lock.
  const [shift] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (${TRADING_DATE}, ${`[${dubai('11')},2099-10-07 02:00:00+04)`}::tstzrange, ${MARKER})
    returning id
  `
  for (const index of [1, 2, 3, 4]) {
    const [employee] = await sql<{ id: string }[]>`
      insert into employee (staff_reference, gender, employed_from, notes)
      values (${`bavail06c-${index}`}, 'female', '2099-01-01', ${MARKER})
      on conflict (staff_reference) do update set gender = 'female', notes = excluded.notes
      returning id
    `
    const id = (employee as { id: string }).id
    staff.push(id)
    await sql`
      insert into employee_skill (employee_id, skill) values (${id}, 'asian_style')
      on conflict do nothing
    `
    for (const type of ['professional_licence', 'health_certificate'] as const) {
      await sql`
        insert into employee_document (employee_id, document_type, expires_on)
        values (${id}, ${type}::employee_document_type, '2099-12-31')
        on conflict do nothing
      `
    }
    await sql`
      insert into shift_assignment (shift_id, employee_id)
      values (${(shift as { id: string }).id}, ${id})
      on conflict do nothing
    `
  }
})

afterAll(async () => {
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from shift_assignment where employee_id = any(${[...staff]}::uuid[])`
  await sql`delete from shift where label = ${MARKER}`
  await sql`delete from employee_document where employee_id = any(${[...staff]}::uuid[])`
  await sql`delete from employee_skill where employee_id = any(${[...staff]}::uuid[])`
  await sql`delete from employee where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await sql?.end({ timeout: 5 })
})

function delivery(args: {
  readonly room: string
  readonly therapist: string
  readonly from: string
  readonly to: string
}): BookingDeliveryInput {
  return {
    tradingDate: TRADING_DATE,
    serviceVariantId: variantId,
    shape: 'solo',
    roomId: roomId(args.room),
    therapistIds: [args.therapist],
    treatment: { startsAt: at(args.from), endsAt: at(args.to) },
    price: {
      grossFils: GROSS_FILS,
      netFils: NET_FILS,
      vatFils: VAT_FILS,
      vatRateBp: 500,
      priceListId: null,
      promotionId: null,
    },
    status: 'confirmed',
  }
}

const request = (key: string, deliveries: readonly BookingDeliveryInput[]): CreateBookingInput => ({
  idempotencyKey: key,
  customerId,
  source: 'online',
  notes: MARKER,
  clientGender: 'female',
  deliveries,
})

/** Every room's peak client places, so "zero over-capacity" is measured and not assumed. */
async function overCapacityRooms(): Promise<readonly { code: string; peak: number }[]> {
  return await sql`
    select r.code, p.concurrent as peak
      from rooms r cross join lateral room_peak_concurrency(r.id, null::tstzrange) p
     where r.notes = ${MARKER} and p.concurrent > r.capacity
  `
}

const clear = () => sql`delete from booking where notes = ${MARKER}`

describe('acceptance — two requests for the last remaining slot, one hundred times', () => {
  it('commits exactly one and refuses the other by name, with no over-capacity room', async () => {
    const outcomes: { won: number; refusedBy: string | null; code: string | undefined }[] = []
    const overCapacity: unknown[] = []

    for (let iteration = 0; iteration < LAST_SLOT_ITERATIONS; iteration += 1) {
      const first = request(`bavail06c-a-${iteration}`, [
        delivery({
          room: LAST_ROOM,
          therapist: staff[0] as string,
          from: '19:00',
          to: '20:00',
        }),
      ])
      const second = request(`bavail06c-b-${iteration}`, [
        delivery({
          room: LAST_ROOM,
          therapist: staff[1] as string,
          from: '19:00',
          to: '20:00',
        }),
      ])
      // Two different customers' requests for one place, issued together on two connections. Different
      // therapists on purpose: the exclusion constraint must not be what decides this, or the test would
      // pass with no room lock at all.
      const settled = await Promise.allSettled([
        bookSlot(sql, CALLER, first, DEPS),
        bookSlot(sql, CALLER, second, DEPS),
      ])
      const fulfilled = settled.filter((result) => result.status === 'fulfilled')
      const rejected = settled.filter((result) => result.status === 'rejected')
      outcomes.push({
        won: fulfilled.length,
        refusedBy: rejected[0] === undefined ? null : bookingRefusalOf(rejected[0].reason),
        code:
          rejected[0] === undefined
            ? undefined
            : ((rejected[0].reason as { code?: string }).code ?? undefined),
      })
      overCapacity.push(...(await overCapacityRooms()))
      await clear()
    }

    // Exactly one winner, every time. Not "at least one": two winners is the double booking, and zero
    // winners is a deadlock or a lock that refuses both, which is availability that never works.
    expect(outcomes).toHaveLength(LAST_SLOT_ITERATIONS)
    expect(outcomes.filter((outcome) => outcome.won !== 1)).toEqual([])
    // And the loser is refused by NAME. A bare rejection would also be what a typo in a column name
    // produces, and the rule under test would be dead while this file reported PASS (ADR 0003).
    expect(outcomes.filter((outcome) => outcome.refusedBy !== 'slot_taken')).toEqual([])
    // Never a deadlock: `40P01` is what an unordered lock acquisition produces under this load.
    expect(outcomes.filter((outcome) => outcome.code === '40P01')).toEqual([])
    expect(overCapacity).toEqual([])
  }, 180_000)

  it('commits both when there are two places, so the refusal above is scarcity and not the lock', async () => {
    // The control for the whole case above. The same two requests into a capacity-2 room both commit —
    // so `slot_taken` is the room being full rather than a lock that refuses whoever arrives second.
    const settled = await Promise.allSettled([
      bookSlot(
        sql,
        CALLER,
        request('bavail06c-both-1', [
          delivery({ room: TWIN_A, therapist: staff[0] as string, from: '19:00', to: '20:00' }),
        ]),
        DEPS,
      ),
      bookSlot(
        sql,
        CALLER,
        request('bavail06c-both-2', [
          delivery({ room: TWIN_A, therapist: staff[1] as string, from: '19:00', to: '20:00' }),
        ]),
        DEPS,
      ),
    ])
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    const [row] = await sql<{ concurrent: number }[]>`
      select concurrent from room_peak_concurrency(${roomId(TWIN_A)}, null::tstzrange)
    `
    expect(Number(row?.concurrent)).toBe(2)
    expect(await overCapacityRooms()).toEqual([])
    await clear()
  })
})

describe('acceptance — two interleaved two-room bookings, two hundred times', () => {
  it('never deadlocks, because every writer takes the room rows in id order', async () => {
    // The deadlock this asserts the absence of is the classic one: A-then-B against B-then-A. Each
    // booking below names its two rooms in the opposite order to the other, and both rooms hold two
    // places so neither booking is refused for scarcity — the only thing being measured is the lock
    // acquisition order. `createBooking` sorts the room ids before the `for update`, which is an order
    // both writers can compute without coordinating.
    const failures: { iteration: number; code: string | undefined; message: string }[] = []

    for (let iteration = 0; iteration < DEADLOCK_ITERATIONS; iteration += 1) {
      const settled = await Promise.allSettled([
        bookSlot(
          sql,
          CALLER,
          request(`bavail06c-ab-${iteration}`, [
            delivery({ room: TWIN_A, therapist: staff[0] as string, from: '19:00', to: '20:00' }),
            delivery({ room: TWIN_B, therapist: staff[1] as string, from: '19:00', to: '20:00' }),
          ]),
          DEPS,
        ),
        bookSlot(
          sql,
          CALLER,
          request(`bavail06c-ba-${iteration}`, [
            delivery({ room: TWIN_B, therapist: staff[2] as string, from: '19:00', to: '20:00' }),
            delivery({ room: TWIN_A, therapist: staff[3] as string, from: '19:00', to: '20:00' }),
          ]),
          DEPS,
        ),
      ])
      for (const result of settled) {
        if (result.status === 'rejected') {
          const err = result.reason as { code?: string }
          failures.push({
            iteration,
            code: err.code,
            message: result.reason instanceof Error ? result.reason.message : String(result.reason),
          })
        }
      }
      await clear()
    }

    // Zero failures of any kind, and the deadlock SQLSTATE named so a failure that IS a deadlock is
    // legible in the output rather than being one of 400 promises that did not settle.
    expect(failures).toEqual([])
    expect(failures.filter((failure) => failure.code === '40P01')).toEqual([])
    expect(await overCapacityRooms()).toEqual([])
  }, 300_000)
})
