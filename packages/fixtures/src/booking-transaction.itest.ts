import {
  type Fils,
  filsFrom,
  localDate,
  type PriceListId,
  type PriceListLayer,
  recheckShapeAssignment,
  resolvePrice,
  selectEffectivePriceList,
} from '@berelax/core'
import {
  type Actor,
  type BookingDeliveryInput,
  bookingRefusalOf,
  bookSlot,
  type CreateBookingInput,
  createBooking,
  createConnection,
  drainOutbox,
  type HandlerRegistration,
  readBookingByIdempotencyKey,
  readCommittedAppointments,
  readMandatoryDocumentTypes,
  type SlotRecheck,
  type Sql,
  type StoredEvent,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * B-AVAIL-06 — the booking transaction, against real PostgreSQL, with core's own rule injected.
 *
 * The whole unit is a claim about two things nothing else can stand in for: **a row lock** and **five
 * records committing together**. A mock would assert that the mock refuses the second booking.
 *
 * It lives in `packages/fixtures` because it needs both halves of a boundary. The rule that decides
 * whether a tuple is still deliverable is `recheckShapeAssignment` in `@berelax/core`; the transaction
 * that applies it is `createBooking` in `@berelax/db`; and `packages/db` may never import
 * `packages/core`, so `packages/fixtures` is the only package that may see them at once. The same
 * arrangement `catalogue-compliance.itest.ts` has for the public-name lint and
 * `therapist-eligibility.itest.ts` for the eligibility port.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind. The
 * trading date `2099-10-05` is used by no other suite and no gate; every room, employee, service and
 * variant here is this file's own and carries {@link MARKER}; every read narrows to those ids; and
 * `afterEach` removes this file's bookings, which cascade to their appointments and their idempotency
 * claims. `audit_event` and `appointment_status_history` are append-only (ADR 0008), so what is asserted
 * of them is a **delta**, never a total, and nothing is deleted from either.
 *
 * Therapists are ids throughout. `staff_reference` is a handle, never a name.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'bavail06 booking pair itest'
const TRADING_DATE = '2099-10-05'
/** Every mandatory credential a fixture therapist holds expires here unless the case is about an expiry. */
const FAR_FUTURE = '2099-12-31'
const PROBE = 'bavail06_probe'
const PROBE_PHONE = '+971590000601'
const SINGLE_ROOM = 'bavail06-single'
const SECOND_ROOM = 'bavail06-second'
const COUPLES_ROOM = 'bavail06-couples'

/** 20000 fils gross, and the exact split `splitGross` produces. Written out, never re-derived here. */
const GROSS_FILS = 20_000
const NET_FILS = 19_048
const VAT_FILS = 952
/** The two figures 0038 snapshots, at the values this file's probe service carries. */
const TURNAROUND_MINUTES = 20
const BUFFER_MINUTES = 10

const CALLER: Actor = { kind: 'staff', label: 'B-AVAIL-06 pair itest' }

/**
 * Core's re-check, as the transaction's injected rule.
 *
 * `satisfies` and not a cast. `SlotRecheck` (db) and `ShapeRecheckInput`/`ShapeRecheckResult` (core) are
 * two declarations of one shape, because neither package may import the other, and this line is what
 * makes a field added to one and not the other a `pnpm typecheck` failure rather than a booking that
 * re-checked nothing.
 */
const recheck = recheckShapeAssignment satisfies SlotRecheck
const DEPS = { recheck }

let sql: Sql
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

const dubai = (hhmm: string): string => `${TRADING_DATE} ${hhmm}:00+04`
const at = (hhmm: string): number => Date.parse(`${TRADING_DATE}T${hhmm}:00+04:00`)

/** The SQLSTATE and message of a rejected promise, or a marker that it was not rejected. */
async function stateOf(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await promise
    return { code: undefined, message: 'the statement succeeded' }
  } catch (error) {
    const err = error as { code?: unknown }
    return {
      code: typeof err.code === 'string' ? err.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** The refusal a rejected booking carries, or `null` when it resolved. */
async function refusalOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return bookingRefusalOf(error)
  }
}

/**
 * The mandatory credential set IN FORCE, far in the future, with `lapsed` overriding one type's expiry.
 *
 * Read from `regulatory_profile_current` rather than naming `professional_licence` and
 * `health_certificate`, which is what this file did until migration 0058 reconciled the row in force with
 * the column DEFAULT — docs/01 decision 20's six. A fixture naming two types stops meaning "holds every
 * mandatory document" the moment that answer changes, and the failure is `credential_missing` in a file
 * that mentions no credentials (0054's header, brief rule 12).
 *
 * `lapsed` names the type whose expiry a case is ABOUT, and it has to be one of the mandatory ones or the
 * therapist is not excluded at all — which is why it is an override on this list and not a separate array.
 */
async function mandatoryDocuments(
  lapsed: Readonly<Record<string, string>> = {},
): Promise<readonly { readonly type: string; readonly expiresOn: string }[]> {
  return (await readMandatoryDocumentTypes(sql)).map((type) => ({
    type,
    expiresOn: lapsed[type] ?? FAR_FUTURE,
  }))
}

async function addEmployee(args: {
  readonly reference: string
  readonly gender: 'female' | 'male'
  readonly skills?: readonly string[]
  readonly documents?: readonly { readonly type: string; readonly expiresOn: string }[]
}): Promise<string> {
  // Upserted rather than inserted: `employee_staff_reference_key` is unique, and a run that failed
  // part-way leaves the roster behind — a fixture that cannot be re-run turns one red test into a suite
  // that never starts again.
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
  for (const document of args.documents ?? (await mandatoryDocuments())) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${document.type}::employee_document_type, ${document.expiresOn})
      on conflict do nothing
    `
  }
  return id
}

beforeAll(async () => {
  // Two pools. `probe` is the second connection every concurrency assertion needs — a lock taken by one
  // transaction is invisible to a test running inside it.
  sql = createConnection({ url, max: 8 })
  probe = createConnection({ url, max: 4 })

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = (customer as { id: string }).id

  // The trading calendar is a TABLE (0011) and `appointment.trading_date` is a foreign key into it, so a
  // fixture cannot invent a date the premises does not trade on. 07:00Z–22:00Z is 11:00–02:00 in
  // Asia/Dubai, the window the whole system is built around.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${dubai('11')}::timestamptz, ${`${'2099-10-06'} 02:00:00+04`}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  for (const [code, roomType, capacity] of [
    [SINGLE_ROOM, 'standard', 1],
    [SECOND_ROOM, 'standard', 1],
    [COUPLES_ROOM, 'couples', 2],
  ] as const) {
    const [room] = await sql<{ id: string }[]>`
      insert into rooms (code, name, room_type, capacity, display_order, notes)
      values (${code}, ${`Probe ${code}`}, ${roomType}::room_type, ${capacity}, 96, ${MARKER})
      on conflict (code) do update set capacity = excluded.capacity
      returning id
    `
    rooms.set(code, (room as { id: string }).id)
  }

  // This file's own service, so nothing here depends on the catalogue another suite is mutating. Three
  // shapes, because the Four Hands case is the point: 2 therapists, 1 standard room, 1 client.
  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, ${'bavail06-probe'}, ${'Probe massage'}, ${'Normal Massage (Asian)'},
            ${TURNAROUND_MINUTES}, 98)
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
  // `required_room_type` is NULL for solo and couple, and that is deliberate rather than a shortcut.
  // 0017 seeds couple as `couples`-only, which means a Couple Massage in a standard room is refused by
  // the room TYPE before the places rule is ever consulted — so an assertion about places would pass
  // vacuously. The column is nullable and an admin can clear it (B-AVAIL-03 makes the same move for its
  // ranking assertions), which leaves the client-place count as the only thing that can refuse. Four
  // Hands keeps the seeded `standard`, because the standard room is the whole point of that case.
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
    values (${serviceId}, 60, ${GROSS_FILS}, ${MARKER})
    on conflict (service_id, duration_minutes)
      do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = (variant as { id: string }).id

  await addEmployee({ reference: 'bavail06-a', gender: 'female' })
  await addEmployee({ reference: 'bavail06-b', gender: 'female' })
  await addEmployee({ reference: 'bavail06-c', gender: 'female' })
  await addEmployee({ reference: 'bavail06-male', gender: 'male' })
  // Arabic style only, so an Asian treatment excludes them with `missing_skill`.
  await addEmployee({
    reference: 'bavail06-wrong-skill',
    gender: 'female',
    skills: ['arabic_style'],
  })
  // A mandatory credential that lapsed the day before the trading date. `labour_card` and not
  // `professional_licence`, because only a type in the set 0058 put in force excludes anybody — a lapsed
  // document that is merely ON FILE would make this therapist bookable and the refusal below vacuous.
  await addEmployee({
    reference: 'bavail06-lapsed',
    gender: 'female',
    documents: await mandatoryDocuments({ labour_card: '2099-10-04' }),
  })

  const [shift] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (${TRADING_DATE},
            ${`[${dubai('11')},${'2099-10-06 02:00:00+04'})`}::tstzrange, ${MARKER})
    returning id
  `
  for (const id of staff.values()) {
    await sql`
      insert into shift_assignment (shift_id, employee_id)
      values (${(shift as { id: string }).id}, ${id})
    `
  }
})

afterEach(async () => {
  // Cascades to `appointment` and to `booking_idempotency`, which is what releases this file's keys
  // between cases. `appointment_status_history` and `audit_event` are append-only and are left alone.
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from price_list where label = ${MARKER}`
})

afterAll(async () => {
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from price_list where label = ${MARKER}`
  await sql`delete from shift_assignment where employee_id = any(${[...staff.values()]}::uuid[])`
  await sql`delete from shift where label = ${MARKER}`
  await sql`delete from employee_document where employee_id = any(${[...staff.values()]}::uuid[])`
  await sql`delete from employee_skill where employee_id = any(${[...staff.values()]}::uuid[])`
  // Deleted, not just unmarked: `employee_staff_reference_key` is unique, so a roster left behind stops
  // the next run of this file before its first assertion.
  await sql`delete from employee where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await probe?.end({ timeout: 5 })
  await sql?.end({ timeout: 5 })
})

const price = {
  grossFils: GROSS_FILS,
  netFils: NET_FILS,
  vatFils: VAT_FILS,
  vatRateBp: 500,
  priceListId: null,
  promotionId: null,
}

function delivery(overrides: Partial<BookingDeliveryInput> = {}): BookingDeliveryInput {
  return {
    tradingDate: TRADING_DATE,
    serviceVariantId: variantId,
    shape: 'solo',
    roomId: roomId(SINGLE_ROOM),
    therapistIds: [idOf('bavail06-a')],
    treatment: { startsAt: at('19:00'), endsAt: at('20:00') },
    price,
    status: 'confirmed',
    ...overrides,
  }
}

/**
 * A request, with `clientGender` spelled so `undefined` is sayable.
 *
 * `exactOptionalPropertyTypes` makes an explicit `undefined` a different type from an absent key, and
 * "we never collected it" is exactly the case one assertion below is about — so the override type says
 * `| undefined` and the spread drops the key when that is what it is.
 */
interface RequestOverrides
  extends Partial<Omit<CreateBookingInput, 'clientGender' | 'genderMatching'>> {
  readonly clientGender?: 'female' | 'male' | undefined
  readonly genderMatching?: 'strict' | 'advisory' | undefined
}

let keySeed = 0
function request(overrides: RequestOverrides = {}): CreateBookingInput {
  keySeed += 1
  const { clientGender, genderMatching, ...rest } = overrides
  const carriesGender = 'clientGender' in overrides ? clientGender !== undefined : true
  return {
    idempotencyKey: `bavail06-${keySeed}`,
    customerId,
    source: 'online',
    notes: MARKER,
    deliveries: [delivery()],
    ...(carriesGender ? { clientGender: clientGender ?? 'female' } : {}),
    ...(genderMatching === undefined ? {} : { genderMatching }),
    ...rest,
  }
}

const book = (input: CreateBookingInput) => bookSlot(sql, CALLER, input, DEPS)

async function appointmentRows(): Promise<
  readonly {
    delivery_id: string
    room_id: string
    therapist_id: string
    room_places: number
    turnaround_minutes: number
    therapist_buffer_minutes: number
    gross_price_fils: string
    net_fils: string
    vat_fils: string
    vat_rate_bp: number
    price_list_id: string | null
    promotion_id: string | null
  }[]
> {
  return await sql`
    select a.delivery_id::text as delivery_id, a.room_id::text as room_id,
           a.therapist_id::text as therapist_id, a.room_places, a.turnaround_minutes,
           a.therapist_buffer_minutes, a.gross_price_fils::text as gross_price_fils,
           a.net_fils::text as net_fils, a.vat_fils::text as vat_fils, a.vat_rate_bp,
           a.price_list_id::text as price_list_id, a.promotion_id
      from appointment a join booking b on b.id = a.booking_id
     where b.notes = ${MARKER}
     order by a.therapist_id
  `
}

const countOf = async (table: 'booking' | 'appointment'): Promise<number> => {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from ${sql(table)} t
     where ${table === 'booking' ? sql`t.notes = ${MARKER}` : sql`t.booking_id in (select id from booking where notes = ${MARKER})`}
  `
  return Number(row?.n ?? 0)
}

const peakPlaces = async (code: string): Promise<number> => {
  const [row] = await sql<{ concurrent: number }[]>`
    select concurrent from room_peak_concurrency(${roomId(code)}, null::tstzrange)
  `
  return Number(row?.concurrent ?? 0)
}

describe('acceptance — Four Hands is bookable in the capacity-1 standard rooms the salon owns', () => {
  it('writes two appointment rows as ONE delivery of one client place', async () => {
    // The disagreement this unit inherited. 0024 stored one appointment row per therapist and counted
    // rows against `rooms.capacity` — a column 0012 documents as CLIENTS — so a Four Hands was two
    // places, and every standard room B-CAT-06 measured and seeded is capacity 1. docs/13 §4 states the
    // footprint as 2 therapists, 1 standard room, 1 CLIENT. 0038 counts client places per delivery, and
    // this is the shape that was unbookable before it.
    const created = await book(
      request({
        deliveries: [
          delivery({
            shape: 'four_hands',
            therapistIds: [idOf('bavail06-a'), idOf('bavail06-b')],
          }),
        ],
      }),
    )
    expect(created.replayed).toBe(false)
    expect(created.deliveries).toHaveLength(1)
    expect(created.deliveries[0]?.appointmentIds).toHaveLength(2)
    expect(created.deliveries[0]?.roomPlaces).toBe(1)

    const rows = await appointmentRows()
    expect(rows).toHaveLength(2)
    // One delivery id across both rows — the grouping the capacity trigger sums places over.
    expect(new Set(rows.map((row) => row.delivery_id)).size).toBe(1)
    expect(rows.every((row) => Number(row.room_places) === 1)).toBe(true)
    expect(new Set(rows.map((row) => row.therapist_id))).toEqual(
      new Set([idOf('bavail06-a'), idOf('bavail06-b')]),
    )
    // And the database agrees: one client place held in a capacity-1 room.
    expect(await peakPlaces(SINGLE_ROOM)).toBe(1)

    // The control, and it is what makes the acceptance above about the DELIVERY rather than about a
    // capacity check that has stopped counting: a second, separate delivery in the same capacity-1 room
    // over the same period is refused by name.
    await expect(
      refusalOf(
        book(
          request({
            deliveries: [
              delivery({ therapistIds: [idOf('bavail06-c')], roomId: roomId(SINGLE_ROOM) }),
            ],
          }),
        ),
      ),
    ).resolves.toBe('slot_taken')
    expect(await peakPlaces(SINGLE_ROOM)).toBe(1)
  })

  it('still refuses a two-client footprint in a one-client room', async () => {
    // A Couple Massage is two clients, so the places figure really is read rather than assumed to be 1.
    // Without this the case above is satisfied by a rule that never refuses anything.
    await expect(
      refusalOf(
        book(
          request({
            deliveries: [
              delivery({
                shape: 'couple',
                roomId: roomId(SINGLE_ROOM),
                therapistIds: [idOf('bavail06-a'), idOf('bavail06-b')],
              }),
            ],
          }),
        ),
      ),
    ).resolves.toBe('slot_taken')
    expect(await countOf('appointment')).toBe(0)

    // And in the capacity-2 couples room the identical request commits, with TWO places.
    const created = await book(
      request({
        deliveries: [
          delivery({
            shape: 'couple',
            roomId: roomId(COUPLES_ROOM),
            therapistIds: [idOf('bavail06-a'), idOf('bavail06-b')],
          }),
        ],
      }),
    )
    expect(created.deliveries[0]?.roomPlaces).toBe(2)
    expect(await peakPlaces(COUPLES_ROOM)).toBe(2)
  })

  it('offers the freed room again once the booking is cancelled', async () => {
    const created = await book(
      request({
        deliveries: [
          delivery({ shape: 'four_hands', therapistIds: [idOf('bavail06-a'), idOf('bavail06-b')] }),
        ],
      }),
    )
    await sql`
      update appointment set status = 'cancelled_by_customer'
       where id = any(${[...(created.deliveries[0]?.appointmentIds ?? [])]}::uuid[])
    `
    // `holds_resources` is the one definition of "still holds" (0024), so the places go with the status.
    expect(await peakPlaces(SINGLE_ROOM)).toBe(0)
    const after = await book(
      request({ deliveries: [delivery({ therapistIds: [idOf('bavail06-c')] })] }),
    )
    expect(after.replayed).toBe(false)
  })
})

describe('acceptance — every appointment snapshots the price, and a price-list change cannot move it', () => {
  it('stores gross, net, VAT and the price_list_id, and none of the five moves afterwards', async () => {
    // An effective-dated override covering the booking's calendar date, so `price_list` is the layer
    // that applied and `price_list_id` is not null — which is what makes the "unchanged afterwards"
    // assertion about a snapshot rather than about a column nobody wrote.
    const [listRow] = await sql<{ id: string }[]>`
      insert into price_list (service_variant_id, gross_price_fils, label, valid_from, valid_to)
      values (${variantId}, 25000, ${MARKER}, '2099-10-01', '2099-10-31')
      returning id
    `
    const priceListId = (listRow as { id: string }).id
    const layers: PriceListLayer[] = [
      {
        priceListId: priceListId as PriceListId,
        grossFils: filsFrom(25_000),
        validFrom: localDate('2099-10-01'),
        validTo: localDate('2099-10-31'),
        label: MARKER,
      },
    ]
    // The resolver decides the figures; this file does not. `resolvePrice` is B-CAT-04's and the whole
    // point of the snapshot is that whatever it answered is what gets stored.
    const resolved = resolvePrice(
      {
        variant: { grossFils: GROSS_FILS as Fils, durationMinutes: 60 },
        priceList: selectEffectivePriceList(layers, localDate('2099-10-05')),
      },
      { on: localDate('2099-10-05') },
    )
    expect(resolved.appliedRule).toBe('price_list')
    expect(resolved.priceListId).toBe(priceListId)

    await book(
      request({
        deliveries: [
          delivery({
            price: {
              grossFils: resolved.gross.fils,
              netFils: resolved.net.fils,
              vatFils: resolved.vat.fils,
              vatRateBp: resolved.vatRateBp,
              priceListId: resolved.priceListId,
              promotionId: resolved.promotionId,
            },
          }),
        ],
      }),
    )

    const before = await appointmentRows()
    expect(before).toHaveLength(1)
    const stored = before[0]
    expect(Number(stored?.gross_price_fils)).toBe(25_000)
    // 25000 x 20 / 21 = 23809.52 -> 23810 net, and VAT is the remainder so the sum is exact.
    expect(Number(stored?.net_fils)).toBe(23_810)
    expect(Number(stored?.vat_fils)).toBe(1_190)
    expect(Number(stored?.net_fils) + Number(stored?.vat_fils)).toBe(
      Number(stored?.gross_price_fils),
    )
    expect(stored?.vat_rate_bp).toBe(500)
    expect(stored?.price_list_id).toBe(priceListId)
    // Null rather than absent: considered, did not apply — the distinction `ResolvedPrice` makes.
    expect(stored?.promotion_id).toBeNull()

    // The price list changes. B-CAT-05 asserts this must not move a booked figure, and the snapshot is
    // what makes it true: nothing in the appointment is derived from the row at read time.
    await sql`update price_list set gross_price_fils = 99000 where id = ${priceListId}`
    const after = await appointmentRows()
    expect(after).toEqual(before)

    // Non-vacuity: the price list really did change, so the equality above is the snapshot and not a
    // statement that affected nothing.
    const [current] = await sql<{ gross_price_fils: string }[]>`
      select gross_price_fils::text as gross_price_fils from price_list where id = ${priceListId}
    `
    expect(Number(current?.gross_price_fils)).toBe(99_000)
  })

  it('snapshots the turnaround and the buffer, so a catalogue change cannot move a held room', async () => {
    // `solve.ts` always said both figures were snapshotted onto the appointment; until 0038 the columns
    // were not there and `readCommittedAppointments` re-derived them at today's figures. Shortening the
    // configured turnaround therefore moved the occupancy of every appointment already taken, and the
    // first sign of it would have been a double booking.
    await book(request())
    const [written] = await appointmentRows()
    expect(written?.turnaround_minutes).toBe(TURNAROUND_MINUTES)
    expect(written?.therapist_buffer_minutes).toBe(BUFFER_MINUTES)

    await sql`update service set turnaround_minutes = 5 where treatment_key = ${PROBE}`
    await sql`
      update service_resource_shape set therapist_buffer_minutes = 0
       where service_treatment_key = ${PROBE}
    `
    try {
      const committed = await readCommittedAppointments(sql, { tradingDate: TRADING_DATE })
      const mine = committed.filter((row) => row.roomId === roomId(SINGLE_ROOM))
      expect(mine).toHaveLength(1)
      expect(mine[0]?.turnaroundMinutes).toBe(TURNAROUND_MINUTES)
      expect(mine[0]?.therapistBufferMinutes).toBe(BUFFER_MINUTES)

      // The control: a booking taken AFTER the change carries the new figures, so the assertion above
      // is the snapshot and not a reader that ignores the catalogue entirely. A different room, because
      // the first booking still holds this one.
      await book(
        request({
          deliveries: [
            delivery({ therapistIds: [idOf('bavail06-b')], roomId: roomId(SECOND_ROOM) }),
          ],
        }),
      )
      const fresh = (await appointmentRows()).find((row) => row.therapist_id === idOf('bavail06-b'))
      expect(fresh?.turnaround_minutes).toBe(5)
      expect(fresh?.therapist_buffer_minutes).toBe(0)
    } finally {
      await sql`
        update service set turnaround_minutes = ${TURNAROUND_MINUTES} where treatment_key = ${PROBE}
      `
      await sql`
        update service_resource_shape set therapist_buffer_minutes = ${BUFFER_MINUTES}
         where service_treatment_key = ${PROBE}
      `
    }
  })
})

describe('acceptance — all of it or none of it', () => {
  it('leaves zero booking and zero appointment rows when the second appointment is refused', async () => {
    const bookingsBefore = await countOf('booking')
    const appointmentsBefore = await countOf('appointment')
    expect(bookingsBefore).toBe(0)
    expect(appointmentsBefore).toBe(0)

    // Two deliveries, the second naming a therapist the first has already taken over the same period.
    // `appointment_therapist_no_overlap` refuses it with SQLSTATE 23P01 — the database is the arbiter,
    // not the application — and the first delivery's rows must go with it.
    const key = 'bavail06-all-or-none'
    const outcome = await refusalOf(
      book(
        request({
          idempotencyKey: key,
          deliveries: [
            delivery({ therapistIds: [idOf('bavail06-a')], roomId: roomId(SINGLE_ROOM) }),
            delivery({ therapistIds: [idOf('bavail06-a')], roomId: roomId(SECOND_ROOM) }),
          ],
        }),
      ),
    )
    expect(outcome).toBe('slot_taken')
    expect(await countOf('booking')).toBe(bookingsBefore)
    expect(await countOf('appointment')).toBe(appointmentsBefore)

    // And the idempotency key went with it, which is what makes a genuine retry possible: the claim is
    // written in the booking's own transaction, so a rolled-back booking releases its key.
    expect(await readBookingByIdempotencyKey(sql, key)).toBeNull()
    const retried = await book(request({ idempotencyKey: key, deliveries: [delivery()] }))
    expect(retried.replayed).toBe(false)
    expect(await countOf('appointment')).toBe(1)
  })

  it('counts the deliveries it has already written when checking the next one', async () => {
    // Two deliveries into the one capacity-2 couples room, each of one client. The second must be
    // counted against the first — which is not committed yet and therefore invisible to a re-read — or
    // the pair would pass the check and meet `room_over_capacity` at COMMIT instead.
    const twoOfTwo = await book(
      request({
        deliveries: [
          delivery({ roomId: roomId(COUPLES_ROOM), therapistIds: [idOf('bavail06-a')] }),
          delivery({ roomId: roomId(COUPLES_ROOM), therapistIds: [idOf('bavail06-b')] }),
        ],
      }),
    )
    expect(twoOfTwo.deliveries).toHaveLength(2)
    expect(await peakPlaces(COUPLES_ROOM)).toBe(2)

    // Three of two is refused, and by name rather than from COMMIT.
    await expect(
      refusalOf(
        book(
          request({
            deliveries: [
              delivery({ roomId: roomId(COUPLES_ROOM), therapistIds: [idOf('bavail06-c')] }),
            ],
          }),
        ),
      ),
    ).resolves.toBe('slot_taken')
    expect(await peakPlaces(COUPLES_ROOM)).toBe(2)
  })
})

describe('acceptance — the eligibility read model is re-applied inside the transaction', () => {
  it('refuses a therapist without the skill the treatment requires, naming the reason', async () => {
    // `appointment.therapist_id` has no foreign key, deliberately: `references employee (id)` would
    // accept a receptionist as the therapist of a massage while reading as though it had proved
    // otherwise (B-AVAIL-04's NOTE). This is the claim that constraint could not make.
    let details: unknown
    try {
      await book(
        request({ deliveries: [delivery({ therapistIds: [idOf('bavail06-wrong-skill')] })] }),
      )
    } catch (error) {
      details = (error as { details?: unknown }).details
    }
    expect(bookingRefusalOf(new Error('x'))).toBeNull()
    expect(details).toMatchObject({
      refusal: 'therapist_not_eligible',
      ineligible: [idOf('bavail06-wrong-skill')],
      excluded: [{ therapistId: idOf('bavail06-wrong-skill'), reason: 'missing_skill' }],
    })
    expect(await countOf('appointment')).toBe(0)
  })

  it('refuses a therapist whose mandatory credential expired before the trading date', async () => {
    await expect(
      refusalOf(
        book(request({ deliveries: [delivery({ therapistIds: [idOf('bavail06-lapsed')] })] })),
      ),
    ).resolves.toBe('therapist_not_eligible')
    expect(await countOf('appointment')).toBe(0)

    // The control: the same request with a credentialled therapist commits, so the refusal above is the
    // credential and not a transaction that refuses everybody.
    const created = await book(request())
    expect(created.replayed).toBe(false)
  })

  it('refuses a cross-gender pairing under strict matching, and takes the matching one', async () => {
    // B-AVAIL-05's rule, applied to the therapists the caller named. Not re-opened here: the mode goes
    // through the same reader and the same normaliser the solver used.
    await expect(
      refusalOf(
        book(
          request({
            clientGender: 'female',
            genderMatching: 'strict',
            deliveries: [delivery({ therapistIds: [idOf('bavail06-male')] })],
          }),
        ),
      ),
    ).resolves.toBe('therapist_not_eligible')

    // Under advisory the identical request is accepted, which is what makes the refusal above the
    // constraint rather than a therapist who is unbookable for some other reason.
    const created = await book(
      request({
        clientGender: 'female',
        genderMatching: 'advisory',
        deliveries: [delivery({ therapistIds: [idOf('bavail06-male')] })],
      }),
    )
    expect(created.replayed).toBe(false)
  })

  it('refuses a booking whose client gender was never collected, under strict matching', async () => {
    // Zero slots and `requires_client_gender` is what the solver answers before any start is considered.
    // A booking path that accepted the omission would book through a refusal already made — and the
    // eligibility reader cannot catch it, because an absent client gender means "this query is not about
    // a client" there.
    await expect(
      refusalOf(book(request({ clientGender: undefined, genderMatching: 'strict' }))),
    ).resolves.toBe('requires_client_gender')
    expect(await countOf('booking')).toBe(0)
  })
})

describe('acceptance — the rows, the outbox event and the audit row commit together', () => {
  const auditCount = async (): Promise<number> => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'booking.created'
    `
    return Number(row?.n ?? 0)
  }

  it('leaves the event pending with nothing delivered, then delivers it exactly once', async () => {
    // A DELTA, never a total: `audit_event` is append-only (ADR 0008) and every earlier suite has left
    // rows in it.
    const auditBefore = await auditCount()
    const created = await book(request())
    expect(await auditCount()).toBe(auditBefore + 1)

    const [event] = await sql<
      { id: string; published_at: string | null; idempotency_key: string; payload: unknown }[]
    >`
      select id::text as id, published_at, idempotency_key, payload
        from outbox_event
       where aggregate_type = 'booking' and aggregate_id = ${created.bookingId}
    `
    // This is the "the worker was killed before it drained" state, and it is the ordinary state
    // immediately after a commit: the event is durable, pending, and nothing has been sent.
    expect(event?.published_at).toBeNull()
    expect(event?.idempotency_key).toBe(`booking.created:${created.bookingId}`)
    expect(event?.payload).toMatchObject({ bookingId: created.bookingId, source: 'online' })
    const [claims] = await sql<{ n: string }[]>`
      select count(*)::text as n from outbox_delivery where event_id = ${event?.id as string}
    `
    expect(Number(claims?.n)).toBe(0)

    // Draining later delivers it, once.
    //
    // Backdated first, and that is isolation rather than convenience. `drainOutbox` claims
    // `where published_at is null order by occurred_at limit batchSize`, and this event is the NEWEST in
    // the queue — so a fixed batch claims whatever every earlier suite left pending and stops before
    // reaching it. This case was green on its own and empty in the full run for exactly that reason
    // (brief rule 12, in a fourth form: a batch is a cap, and a cap is not a filter). Making this row the
    // oldest pending one lets `batchSize: 1` claim exactly it and nothing else — narrowing what the code
    // under test can SEE, rather than deleting another suite's rows or publishing them as a side effect.
    await sql`
      update outbox_event set occurred_at = '1970-01-01T00:00:00Z' where id = ${event?.id as string}
    `
    const seen: StoredEvent[] = []
    const handler: HandlerRegistration = {
      name: `bavail06-spy-${created.bookingId}`,
      eventTypes: ['booking.created'],
      handle: async (delivered) => {
        if (delivered.aggregateId === created.bookingId) seen.push(delivered)
      },
    }
    const firstDrain = await drainOutbox(sql, [handler], { batchSize: 1 })
    expect(firstDrain.claimed).toBe(1)
    expect(firstDrain.delivered).toBe(1)
    expect(firstDrain.failed).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.eventType).toBe('booking.created')

    const [published] = await sql<{ published_at: string | null }[]>`
      select published_at from outbox_event where id = ${event?.id as string}
    `
    expect(published?.published_at).not.toBeNull()
    const [delivered] = await sql<{ n: string; handler: string }[]>`
      select count(*)::text as n, min(handler) as handler
        from outbox_delivery where event_id = ${event?.id as string}
    `
    expect(Number(delivered?.n)).toBe(1)
    expect(delivered?.handler).toBe(handler.name)

    // EXACTLY once, and the mechanism that makes it so is `outbox_delivery`'s primary key rather than
    // the published flag. Asserting it needs the event claimed a SECOND time, so `published_at` goes back
    // to null — which is not a contrived state: it is precisely a worker that delivered the event and was
    // killed before it could mark it published, the at-least-once case 0007 exists for. The handler must
    // now be SKIPPED, not run again.
    await sql`update outbox_event set published_at = null where id = ${event?.id as string}`
    const secondDrain = await drainOutbox(sql, [handler], { batchSize: 1 })
    expect(secondDrain.claimed).toBe(1)
    expect(secondDrain.delivered).toBe(0)
    expect(secondDrain.skippedAlreadyDelivered).toBe(1)
    expect(seen).toHaveLength(1)
  })

  it('writes neither the event nor the audit row when the booking is refused', async () => {
    const auditBefore = await auditCount()
    const [pendingBefore] = await sql<{ n: string }[]>`
      select count(*)::text as n from outbox_event
       where event_type = 'booking.created' and published_at is null
    `
    await expect(
      refusalOf(
        book(request({ deliveries: [delivery({ therapistIds: [idOf('bavail06-lapsed')] })] })),
      ),
    ).resolves.toBe('therapist_not_eligible')
    expect(await auditCount()).toBe(auditBefore)
    const [pendingAfter] = await sql<{ n: string }[]>`
      select count(*)::text as n from outbox_event
       where event_type = 'booking.created' and published_at is null
    `
    expect(pendingAfter?.n).toBe(pendingBefore?.n)
  })
})

describe('acceptance — the idempotency key is a UNIQUE constraint on the client-supplied value', () => {
  it('is a real constraint in pg_constraint, over exactly that column', async () => {
    const [row] = await sql<{ name: string; contype: string; columns: string[] }[]>`
      select c.conname as name, c.contype::text as contype,
             array_agg(a.attname order by a.attname) as columns
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
       where t.relname = 'booking_idempotency' and c.contype in ('p', 'u')
         and a.attname = 'idempotency_key'
       group by c.conname, c.contype
    `
    // A PRIMARY KEY is a unique constraint in PostgreSQL's terms, backed by a unique index, and it is
    // the one 0024 declared. A second UNIQUE on the same column would be a duplicate index and a second
    // answer to one question.
    expect(row?.contype).toBe('p')
    expect(row?.columns).toEqual(['idempotency_key'])
  })

  it('refuses a duplicate key at the database, by constraint name', async () => {
    const created = await book(request({ idempotencyKey: 'bavail06-dup' }))
    const refused = await stateOf(sql`
      insert into booking_idempotency (idempotency_key, request_fingerprint, booking_id)
      values ('bavail06-dup', 'a-different-fingerprint', ${created.bookingId})
    `)
    expect(refused.code).toBe('23505')
    expect(refused.message).toContain('booking_idempotency_pkey')

    // The control: a different key for the same booking is refused too, by the OTHER unique constraint —
    // one booking is created by exactly one request.
    const second = await stateOf(sql`
      insert into booking_idempotency (idempotency_key, request_fingerprint, booking_id)
      values ('bavail06-dup-2', 'a-different-fingerprint', ${created.bookingId})
    `)
    expect(second.code).toBe('23505')
    expect(second.message).toContain('booking_idempotency_booking_id_key')
  })

  it('replays the original booking and creates no second one', async () => {
    const input = request({ idempotencyKey: 'bavail06-replay' })
    const first = await book(input)
    const second = await book(input)
    expect(second.replayed).toBe(true)
    expect(second.bookingId).toBe(first.bookingId)
    expect(second.deliveries).toEqual(first.deliveries)
    expect(await countOf('booking')).toBe(1)
    expect(await countOf('appointment')).toBe(1)
  })

  it('refuses the same key used for a different request', async () => {
    const key = 'bavail06-reused'
    await book(request({ idempotencyKey: key }))
    await expect(
      refusalOf(
        book(
          request({
            idempotencyKey: key,
            deliveries: [delivery({ therapistIds: [idOf('bavail06-b')] })],
          }),
        ),
      ),
    ).resolves.toBe('idempotency_key_reused')
    expect(await countOf('booking')).toBe(1)
  })

  it('makes the second request WAIT while the first is still in flight, then replays it', async () => {
    // The mechanism, stated: the claim is inserted inside the booking's own transaction, so a second
    // transaction holding the same key blocks on the primary key's index until the first commits or
    // rolls back. An in-memory set answers the wrong question in the same process and no question at all
    // in the second one.
    const key = 'bavail06-inflight'
    const input = request({ idempotencyKey: key })
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = withUnitOfWork(sql, CALLER, async (uow) => {
      const created = await createBooking(uow, input, DEPS)
      // The transaction is open and the key is claimed. Everything below happens against that.
      await held
      return created
    })

    // Give the first transaction time to claim the key, then start the second on its own connection.
    await new Promise((resolve) => setTimeout(resolve, 150))
    let settled = false
    const second = bookSlot(probe, CALLER, input, DEPS).finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    // Blocked, not refused and not committed. This is the assertion the whole case exists for.
    expect(settled).toBe(false)

    release()
    const winner = await first
    const loser = await second
    expect(loser.bookingId).toBe(winner.bookingId)
    expect(loser.replayed).toBe(true)
    expect(await countOf('booking')).toBe(1)
    expect(await countOf('appointment')).toBe(1)
  })
})

describe('acceptance — the room row is held FOR UPDATE for the whole transaction', () => {
  it('holds the room row FOR UPDATE, which a competing FOR SHARE cannot take', async () => {
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const inFlight = withUnitOfWork(sql, CALLER, async (uow) => {
      const created = await createBooking(uow, request(), DEPS)
      await held
      return created
    })
    await new Promise((resolve) => setTimeout(resolve, 200))

    try {
      // The acceptance line asks for pg_locks, and here it is: `SELECT … FOR UPDATE` takes a table-level
      // ROW SHARE lock on `rooms`, which a plain `SELECT` does not — a plain read takes ACCESS SHARE.
      const locks = await probe<{ mode: string }[]>`
        select l.mode
          from pg_locks l join pg_class c on c.oid = l.relation
         where c.relname = 'rooms' and l.granted and l.mode = 'RowShareLock'
      `
      expect(locks.length).toBeGreaterThan(0)

      // And this is the assertion that actually distinguishes the lock, because the row above does not.
      // Inserting an appointment makes PostgreSQL check `appointment_room_id_fkey`, which takes FOR KEY
      // SHARE on the parent `rooms` row — and FOR KEY SHARE is also a ROW SHARE lock at the table level.
      // So the pg_locks row appears whether this transaction took the lock deliberately or not, and it
      // was measured doing exactly that before this assertion was added.
      //
      // FOR SHARE is what tells them apart: it is compatible with FOR KEY SHARE and conflicts with FOR
      // UPDATE. `NOWAIT` turns the conflict into 55P03 instead of a wait, so the refusal is the assertion.
      const blockedShare = await stateOf(
        probe`select id from rooms where id = ${roomId(SINGLE_ROOM)} for share nowait`,
      )
      expect(blockedShare.code).toBe('55P03')

      // The control, and the one that matters: an untouched room is NOT locked, so the refusal above is
      // this row and not a transaction that has locked the whole table.
      const free = await stateOf(
        probe`select id from rooms where id = ${roomId(COUPLES_ROOM)} for share nowait`,
      )
      expect(free.code).toBeUndefined()

      // The second control: a room this booking wrote but did not lock would still refuse a competing FOR
      // UPDATE, because of the foreign-key check alone. Asserting that here is what keeps the FOR SHARE
      // probe above from looking like an arbitrary choice of lock mode.
      const blockedUpdate = await stateOf(
        probe`select id from rooms where id = ${roomId(SINGLE_ROOM)} for update nowait`,
      )
      expect(blockedUpdate.code).toBe('55P03')
    } finally {
      release()
      await inFlight
    }

    // Released on commit: the same FOR SHARE now succeeds.
    const afterCommit = await stateOf(
      probe`select id from rooms where id = ${roomId(SINGLE_ROOM)} for share nowait`,
    )
    expect(afterCommit.code).toBeUndefined()
  })

  it('locks in room-id order, whichever order the deliveries name them in', async () => {
    // The deadlock-avoidance rule, observed rather than asserted about the source. A competitor holds
    // the LOWER room id; the booking names the HIGHER one first. If it locked in request order it would
    // take the higher room and then block, so a third connection could not lock it. Ordering by id makes
    // it block on the lower room first and never reach the higher one — which is what lets two bookings
    // over overlapping room sets queue instead of deadlocking.
    const [lower, higher] = [roomId(SINGLE_ROOM), roomId(SECOND_ROOM)].sort()
    const codeOf = (id: string): string => (id === roomId(SINGLE_ROOM) ? SINGLE_ROOM : SECOND_ROOM)

    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const competitor = probe.begin(async (tx) => {
      await tx`select id from rooms where id = ${lower as string} for update`
      await held
    })
    await new Promise((resolve) => setTimeout(resolve, 150))

    const blockedBooking = book(
      request({
        deliveries: [
          delivery({
            roomId: higher as string,
            therapistIds: [idOf('bavail06-a')],
            treatment: { startsAt: at('19:00'), endsAt: at('20:00') },
          }),
          delivery({
            roomId: lower as string,
            therapistIds: [idOf('bavail06-b')],
            treatment: { startsAt: at('19:00'), endsAt: at('20:00') },
          }),
        ],
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 250))

    try {
      const higherStillFree = await stateOf(
        sql`select id from rooms where id = ${higher as string} for update nowait`,
      )
      expect(higherStillFree.code).toBeUndefined()
    } finally {
      release()
      await competitor
      const created = await blockedBooking
      // It completed once the lower room was released, and it booked both rooms.
      expect(created.deliveries.map((d) => codeOf(d.roomId)).sort()).toEqual(
        [SECOND_ROOM, SINGLE_ROOM].sort(),
      )
    }
  })
})
