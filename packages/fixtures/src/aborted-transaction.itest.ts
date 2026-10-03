import { recheckShapeAssignment } from '@berelax/core'
import {
  type Actor,
  createBooking,
  createConnection,
  readMandatoryDocumentTypes,
  type SlotRecheck,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * H-HARD-08 — an ABORT mid-transaction leaves no partial state, which is a different claim from a refusal.
 *
 * ## What B-AVAIL-06 already proves, and what it does not
 *
 * `booking-transaction.itest.ts` has two cases that look like this one: *"leaves zero booking and zero
 * appointment rows when the second appointment is refused"* and *"writes neither the event nor the audit
 * row when the booking is refused"*. Both are about a REFUSAL — the transaction decides not to proceed,
 * raises, and rolls itself back. That is the application working.
 *
 * This unit's premise is the other one: **the salon's wifi drops mid-checkout**. The transaction does not
 * decide anything; the process or the connection dies part-way through, after some of the rows are in and
 * before the commit. Nothing in the application chose that moment, which is exactly why it has to be
 * proved separately: a refusal aborts at a point the code picked, and an outage aborts at a point it did
 * not.
 *
 * So the case below writes the booking, its appointment and its outbox event through the real
 * `createBooking`, and then **throws from inside the unit of work** — the closest a test can get to a
 * connection vanishing after the writes and before the COMMIT. PostgreSQL rolls the whole thing back, and
 * all three tables are asserted absent at once, which is the acceptance line's own wording.
 *
 * The control is the same booking committed normally, under a second key, asserting all three rows PRESENT.
 * Without it, "the three tables are empty" is satisfied by a fixture that never wrote anything — which is
 * the vacuous pass this whole suite exists to avoid, and the shape the first draft had before the control
 * was added.
 *
 * ## Isolation
 *
 * The trading date `2097-11-14` is used by no other suite. Every room, service, variant and employee here
 * is this file's own and carries {@link MARKER}; every assertion narrows to this file's own idempotency
 * keys or ids. `afterAll` removes the committed booking, which cascades to its appointment and its
 * idempotency claim; `outbox_event` and `audit_event` are append-only (ADR 0008, 0006), so what is
 * asserted of them is a row's PRESENCE or ABSENCE by key and nothing is deleted from either.
 */

const MARKER = 'hhard08 abort itest'
const TRADING_DATE = '2097-11-14'
const NEXT_CALENDAR_DATE = '2097-11-15'
const FAR_FUTURE = '2097-12-31'
const PROBE = 'hhard08_probe'
const PROBE_PHONE = '+971590000814'
const ROOM_CODE = 'hhard08-single'
const GROSS_FILS = 20_000
const NET_FILS = 19_048
const VAT_FILS = 952

const ACTOR: Actor = { kind: 'staff', label: MARKER }
const recheck = recheckShapeAssignment satisfies SlotRecheck

let sql: Sql
let customerId = ''
let roomId = ''
let variantId = ''
let therapistId = ''
/** The committed booking's id, so `afterAll` removes exactly the row this file created. */
let committedBookingId = ''

const dubai = (date: string, hour: string): string => `${date} ${hour}:00:00+04`
const at = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+04:00`)

const ABORT_KEY = `${MARKER}:aborted`
const COMMIT_KEY = `${MARKER}:committed`

/** The one booking shape this file needs: one therapist, one standard room, forty-five minutes. */
function bookingInput(idempotencyKey: string, startsAt: number) {
  return {
    idempotencyKey,
    customerId,
    source: 'front_desk' as const,
    notes: MARKER,
    clientGender: 'female' as const,
    deliveries: [
      {
        tradingDate: TRADING_DATE,
        serviceVariantId: variantId,
        shape: 'solo' as const,
        roomId,
        therapistIds: [therapistId],
        treatment: { startsAt, endsAt: startsAt + 45 * 60 * 1000 },
        price: {
          grossFils: GROSS_FILS,
          netFils: NET_FILS,
          vatFils: VAT_FILS,
          vatRateBp: 500,
          priceListId: null,
          promotionId: null,
        },
        status: 'confirmed' as const,
      },
    ],
  }
}

/** The three tables the acceptance line names, counted by this file's own keys, in SQL. */
async function rowsFor(idempotencyKey: string): Promise<{
  readonly bookings: number
  readonly appointments: number
  readonly outboxEvents: number
}> {
  /*
    The booking is found through `booking_idempotency` and not through a column on `booking`.

    `booking` holds no `idempotency_key`: the claim is a separate table (0038's shape), which is what lets
    a key be released when its transaction rolls back. So "the rows this file's request produced" is a
    join through the claim — and the claim's own absence is asserted in its own case below, because a
    claim surviving its transaction would refuse the retry for ever.
  */
  const [row] = await sql<{ bookings: string; appointments: string; outboxEvents: string }[]>`
    with b as (
      select b.id
        from booking b
        join booking_idempotency i on i.booking_id = b.id
       where i.idempotency_key = ${idempotencyKey}
    )
    select (select count(*)::text from b)                                        as "bookings",
           (select count(*)::text from appointment
             where booking_id in (select id from b))                             as "appointments",
           -- Counted by the booking id inside the payload rather than by a join, because the outbox is
           -- append-only and holds no foreign key: 0006 stores the aggregate id as text precisely so an
           -- event outlives the row it is about.
           (select count(*)::text from outbox_event
             where aggregate_id in (select id::text from b))                      as "outboxEvents"
  `
  return {
    bookings: Number(row?.bookings ?? '0'),
    appointments: Number(row?.appointments ?? '0'),
    outboxEvents: Number(row?.outboxEvents ?? '0'),
  }
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = (customer as { id: string }).id

  // The trading calendar is a TABLE (0011) and `appointment.trading_date` is a foreign key into it, so a
  // fixture cannot invent a date the premises does not trade on. 11:00-02:00 Dubai, which is the real
  // session and is what makes the after-midnight half of this unit's day sheet meaningful.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${dubai(TRADING_DATE, '11')}::timestamptz,
            ${dubai(NEXT_CALENDAR_DATE, '02')}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  const [room] = await sql<{ id: string }[]>`
    insert into rooms (code, name, room_type, capacity, display_order, notes)
    values (${ROOM_CODE}, ${`Probe ${ROOM_CODE}`}, 'standard'::room_type, 1, 94, ${MARKER})
    on conflict (code) do update set capacity = excluded.capacity
    returning id
  `
  roomId = (room as { id: string }).id

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, 'hhard08-probe', 'Probe massage', 'Normal Massage (Asian)', 20, 94)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  const serviceId = (service as { id: string }).id
  await sql`
    insert into service_room_type_compat (service_style, service_treatment_key, room_type)
    values ('asian', ${PROBE}, 'standard'::room_type)
    on conflict do nothing
  `
  // `required_room_type` is NULL for solo, which is B-AVAIL-06's fixture's reason: 0017's seeded shapes
  // would otherwise refuse the room by TYPE before the places rule was ever consulted.
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
    on conflict (service_id, duration_minutes)
      do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = (variant as { id: string }).id

  const [employee] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values (${'hhard08-a'}, 'female', '2097-01-01', ${MARKER})
    on conflict (staff_reference) do update set gender = excluded.gender, notes = excluded.notes
    returning id
  `
  therapistId = (employee as { id: string }).id
  await sql`
    insert into employee_skill (employee_id, skill) values (${therapistId}, 'asian_style')
    on conflict do nothing
  `
  // Every type the profile in force makes mandatory, read rather than listed: a type that is merely ON
  // FILE and not mandatory excludes nobody, so a hand-written list would make the fixture eligible for a
  // reason the eligibility rule has nothing to do with.
  for (const type of await readMandatoryDocumentTypes(sql)) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${therapistId}, ${type}::employee_document_type, ${FAR_FUTURE})
      on conflict do nothing
    `
  }

  /*
    A rostered shift covering the session, and it is not optional.

    `readEligibleTherapists` answers from the ROTA as well as from the credentials: a therapist with every
    document on file and no shift on the trading date is not eligible, and the refusal is
    `therapist_not_eligible` with no reason named — which is the eligibility rule being right and was the
    first draft of this file being wrong. Found by the control case, which could not book at all.
  */
  const [shift] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (${TRADING_DATE},
            ${`[${dubai(TRADING_DATE, '11')},${dubai(NEXT_CALENDAR_DATE, '02')})`}::tstzrange,
            ${MARKER})
    returning id
  `
  await sql`
    insert into shift_assignment (shift_id, employee_id)
    values (${(shift as { id: string }).id}, ${therapistId})
    on conflict do nothing
  `

  // Anything a previous run of this file committed, removed first. `booking` cascades to `appointment`
  // and to the idempotency claim; a run whose `afterAll` did not reach would otherwise make the control
  // below a replay rather than a write, and a replay writes no outbox event.
  await sql`
    delete from booking
     where id in (
       select booking_id from booking_idempotency
        where idempotency_key in (${ABORT_KEY}, ${COMMIT_KEY})
     )
  `
}, 60_000)

afterAll(async () => {
  // Only rows this file created. `booking` cascades to `appointment` and to the idempotency claim;
  // `outbox_event` and `audit_event` are append-only (0006, ADR 0008) and are left alone, which is why
  // every assertion above is a presence or an absence by key rather than a count of either table.
  if (committedBookingId !== '') {
    await sql`delete from booking where id = ${committedBookingId}::uuid`
  }
  await sql`delete from shift_assignment where employee_id = ${therapistId}::uuid`
  await sql`delete from shift where label = ${MARKER}`
  await sql?.end({ timeout: 5 })
})

describe('an aborted booking transaction leaves no partial state', () => {
  it('rolls back the booking, the appointment AND the outbox event together', async () => {
    /*
      The abort, and the shape of it is the claim.

      `createBooking` runs to completion — the booking row, the delivery, the appointment, the attribution
      and the outbox event are all written — and then the closure throws. That is as close as a test can
      get to the connection vanishing after the writes and before the COMMIT, and it is deliberately NOT a
      refusal: `withUnitOfWork` is given work that succeeds and is then interrupted, so nothing in the
      application chose the moment.
    */
    await expect(
      withUnitOfWork(sql, ACTOR, async (uow) => {
        const created = await createBooking(
          uow,
          bookingInput(ABORT_KEY, at(TRADING_DATE, '12:00')),
          {
            recheck,
          },
        )
        // Read back INSIDE the transaction, so the case fails loudly if `createBooking` wrote nothing —
        // which would make the assertion below pass about a booking that never existed.
        const [inFlight] = await uow.sql<{ appointments: string }[]>`
          select count(*)::text as appointments from appointment
           where booking_id = ${created.bookingId}::uuid
        `
        expect(Number(inFlight?.appointments ?? '0')).toBeGreaterThan(0)
        throw new Error('the connection dropped here, after the writes and before the commit')
      }),
    ).rejects.toThrow('the connection dropped here')

    // All three absent, asserted in ONE statement so the three counts are taken at one instant: three
    // separate reads could each see a different moment of a concurrent rollback.
    expect(await rowsFor(ABORT_KEY)).toEqual({ bookings: 0, appointments: 0, outboxEvents: 0 })
  }, 30_000)

  it('writes all three when it is NOT interrupted, which is the control', async () => {
    // Without this, the case above is satisfied by a fixture that cannot book at all — which is what the
    // first draft of this file was, before the in-flight read was added to the closure.
    const created = await withUnitOfWork(sql, ACTOR, (uow) =>
      createBooking(uow, bookingInput(COMMIT_KEY, at(TRADING_DATE, '14:00')), { recheck }),
    )
    committedBookingId = created.bookingId
    expect(await rowsFor(COMMIT_KEY)).toEqual({ bookings: 1, appointments: 1, outboxEvents: 1 })
  }, 30_000)

  it('leaves the aborted idempotency key free, so the same request can be made again', async () => {
    // The half that would make a rollback useless: a claim row surviving its own transaction would refuse
    // the retry for ever, and the operator would be told their booking "already exists" while no booking
    // does. `bookSlot`'s own comment records the same reading for the race — a winner that rolled back
    // releases the key, and that is a genuine retry.
    const [claim] = await sql<{ count: string }[]>`
      select count(*)::text as count from booking_idempotency
       where idempotency_key = ${ABORT_KEY}
    `
    expect(Number(claim?.count ?? '0')).toBe(0)
  })
})
