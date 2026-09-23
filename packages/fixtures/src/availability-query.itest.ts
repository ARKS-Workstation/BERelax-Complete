import { recheckShapeAssignment, solveAvailabilityQuery } from '@berelax/core'
import {
  type Actor,
  type AvailabilityDeps,
  type AvailabilityRequest,
  type AvailabilitySlot,
  type AvailabilitySolve,
  availabilityCacheTag,
  bookingRefusalOf,
  bookSlot,
  createAvailabilityCache,
  createConnection,
  joinWaitlist,
  noAvailabilityAlternatives,
  peekAvailabilityCache,
  queryAvailability,
  readMandatoryDocumentTypes,
  readWaitlistFor,
  type SlotRecheck,
  type Sql,
  WAITLIST_INELIGIBILITY,
} from '@berelax/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * B-AVAIL-07 — the availability read path against real PostgreSQL, with core's own rule injected.
 *
 * It lives in `packages/fixtures` because it needs both halves of a boundary. The rule that turns rows into
 * offerable slots is `solveAvailabilityQuery` in `@berelax/core`; the query that reads the rows is
 * `queryAvailability` in `@berelax/db`; and `packages/db` may never import `packages/core`. The same
 * arrangement `booking-transaction.itest.ts` has for `recheckShapeAssignment` and
 * `therapist-eligibility.itest.ts` for the eligibility port.
 *
 * The centre of the file is the third describe block. **A deliberately stale memo must never sell a slot
 * that no longer exists**, and the only honest way to write that is to make the memo stale on purpose:
 * prime it, commit a booking out of band, read the memo back and watch it still offer the slot, then book
 * from it. The refusal is `bookSlot`'s, by name, because the booking transaction re-reads the committed
 * rows under the room lock and re-applies `assignShape` before it writes. The cache is an optimisation; the
 * database is the authority.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind. The
 * trading dates 2097-05-10 / 11 / 12 and 2097-05-20 are used by no other suite and no gate; every room,
 * service, variant, employee and shift here carries {@link MARKER}; `afterEach` removes this file's
 * bookings, which cascade to their appointments and idempotency claims; and every count is a **delta** or a
 * key-set comparison, never a total on a shared table.
 *
 * Therapists are ids throughout. `staff_reference` is a handle, never a name (ADR 0020).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'bavail07 pair itest'
const PROBE = 'bavail07_pair'
const PROBE_PHONE = '+971590000711'
/** The day before the busy one, so `nearest_days` has something earlier to find. */
const EARLIER = '2097-05-10'
/** The day the named therapist is fully booked. */
const BUSY = '2097-05-11'
/** The day after, so `nearest_days` has something later to find. */
const LATER = '2097-05-12'
/** An untouched day, for the stale-memo case. */
const QUIET = '2097-05-20'
const DATES = [EARLIER, BUSY, LATER, QUIET]

const BUSY_ROOM = 'bavail07p-busy'
const FREE_ROOM = 'bavail07p-free'

const DURATION_MINUTES = 60
const TURNAROUND_MINUTES = 20
const BUFFER_MINUTES = 10
const GROSS_FILS = 20_000
const NET_FILS = 19_048
const VAT_FILS = 952

/** Three days before {@link EARLIER}, so the 2-hour lead and the 90-day advance both hold as shipped. */
const NOW = Date.parse('2097-05-07T12:00:00+04:00')

const CALLER: Actor = { kind: 'staff', label: 'B-AVAIL-07 pair itest' }

/**
 * Core's rule as the query's injected solver, and core's re-check as the booking's.
 *
 * `satisfies` and not a cast, both of them. `AvailabilitySolve`/`SlotRecheck` (db) and
 * `AvailabilityQueryFacts`/`ShapeRecheckInput` (core) are two declarations of one shape, because neither
 * package may import the other, and these two lines are what make a field added to one and not the other a
 * `pnpm typecheck` failure rather than a slot list nobody computed.
 */
const solve = solveAvailabilityQuery satisfies AvailabilitySolve
const recheck = recheckShapeAssignment satisfies SlotRecheck

let sql: Sql
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

const nextDay = (date: string): string => {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

const at = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+04:00`)

const request = (overrides: Partial<AvailabilityRequest> = {}): AvailabilityRequest => ({
  tradingDate: BUSY,
  serviceVariantId: variantId,
  // The provisional figures as shipped (Y9-lead), read in production through `readAvailabilityLimits`.
  minLeadMinutes: 120,
  maxAdvanceDays: 90,
  // Same-gender matching is strict by default and every probe therapist is female, so the client's
  // gender has to be stated or the query refuses with `requires_client_gender` (B-AVAIL-05).
  clientGender: 'female',
  ...overrides,
})

const deps = (overrides: Partial<AvailabilityDeps> = {}): AvailabilityDeps => ({
  solve,
  now: NOW,
  ...overrides,
})

async function addEmployee(reference: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values (${reference}, 'female', '2097-01-01', ${MARKER})
    on conflict (staff_reference) do update set notes = excluded.notes
    returning id
  `
  const id = (row as { id: string }).id
  staff.set(reference, id)
  await sql`
    insert into employee_skill (employee_id, skill) values (${id}, 'asian_style')
    on conflict do nothing
  `
  // The mandatory credential set IN FORCE, not a hard-coded pair. Migration 0058 reconciled the row
  // with the column DEFAULT — docs/01 decision 20's six — and a fixture naming two of them stops meaning
  // "holds every mandatory document" the moment that answer changes, which surfaces as
  // `credential_missing` in a file that mentions no credentials (0054's header, brief rule 12).
  for (const documentType of await readMandatoryDocumentTypes(sql)) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${documentType}::employee_document_type, '2099-12-31')
      on conflict do nothing
    `
  }
  return id
}

/** One committed appointment, stated in full: 0038 made four of these columns NOT NULL with no default. */
async function commitAppointment(args: {
  readonly bookingId: string
  readonly tradingDate: string
  readonly room: string
  readonly therapist: string
  readonly startsAt: number
  readonly endsAt: number
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
       gross_price_fils, net_fils, vat_fils)
    values (${args.bookingId}, ${args.tradingDate}, ${variantId}, 'solo', ${args.therapist},
            ${args.room},
            ${`[${new Date(args.startsAt).toISOString()},${new Date(args.endsAt).toISOString()})`}::tstzrange,
            'confirmed', uuid_generate_v7(), 1, ${TURNAROUND_MINUTES}, ${BUFFER_MINUTES},
            ${GROSS_FILS}, ${NET_FILS}, ${VAT_FILS})
    returning id::text as id
  `
  return (row as { id: string }).id
}

beforeAll(async () => {
  sql = createConnection({ url, max: 8 })

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = (customer as { id: string }).id

  // 11:00–02:00 Asia/Dubai, the window the whole system is built around. `appointment.trading_date`,
  // `shift.trading_date` and `waitlist.trading_date` are all foreign keys into this table, so no fixture
  // can invent a date the premises does not trade on.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    select d::date, (d::date || ' 11:00:00+04')::timestamptz,
           ((d::date + 1) || ' 02:00:00+04')::timestamptz, 'weekly'
      from unnest(${DATES}::date[]) as d
    on conflict (trading_date) do nothing
  `

  for (const [code, capacity, order] of [
    [BUSY_ROOM, 1, 92],
    [FREE_ROOM, 1, 93],
  ] as const) {
    const [room] = await sql<{ id: string }[]>`
      insert into rooms (code, name, room_type, capacity, display_order, notes)
      values (${code}, ${`Probe ${code}`}, 'standard', ${capacity}, ${order}, ${MARKER})
      on conflict (code) do update set capacity = excluded.capacity
      returning id
    `
    rooms.set(code, (room as { id: string }).id)
  }

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, ${'bavail07-pair'}, ${'Probe massage'}, ${'Normal Massage (Asian)'},
            ${TURNAROUND_MINUTES}, 96)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
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
    values ('asian', ${PROBE}, 'solo', 1, 1, 1, null, ${BUFFER_MINUTES})
    on conflict do nothing
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${serviceId}, ${DURATION_MINUTES}, ${GROSS_FILS}, ${MARKER})
    on conflict (service_id, duration_minutes)
      do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = (variant as { id: string }).id

  for (const reference of ['bavail07p-a', 'bavail07p-b', 'bavail07p-c'] as const) {
    await addEmployee(reference)
  }

  for (const tradingDate of DATES) {
    const [shift] = await sql<{ id: string }[]>`
      insert into shift (trading_date, period, label)
      values (${tradingDate},
              ${`[${new Date(at(tradingDate, '11:00')).toISOString()},${new Date(at(nextDay(tradingDate), '02:00')).toISOString()})`}::tstzrange,
              ${MARKER})
      returning id::text as id
    `
    for (const id of staff.values()) {
      await sql`
        insert into shift_assignment (shift_id, employee_id)
        values (${(shift as { id: string }).id}, ${id}) on conflict do nothing
      `
    }
  }

  // The busy day. Therapist A holds eleven back-to-back 60-minute treatments in ONE room, each followed
  // by its 20-minute turnaround, so her buffered presence is covered continuously from 10:50 to 01:30 and
  // the room's occupancy runs 11:00 to 01:40 — past the last bookable start for a 60+20 footprint, which
  // is 00:40. The OTHER room stays empty and therapists B and C stay free, which is what makes
  // `alternative_therapists` non-empty for a request narrowed to A: the binding constraint is the
  // therapist, not the floor.
  const [busyBooking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}, 'front_desk', ${MARKER}) returning id
  `
  const busyBookingId = (busyBooking as { id: string }).id
  for (let index = 0; index < 11; index += 1) {
    const startsAt = at(BUSY, '11:00') + index * 80 * 60_000
    await commitAppointment({
      bookingId: busyBookingId,
      tradingDate: BUSY,
      room: roomId(BUSY_ROOM),
      therapist: idOf('bavail07p-a'),
      startsAt,
      endsAt: startsAt + DURATION_MINUTES * 60_000,
    })
  }
})

afterEach(async () => {
  // Cascades to `appointment` and `booking_idempotency`, which is what releases this file's keys between
  // cases — but only the bookings a CASE made: the busy day's fixture booking carries the same marker, so
  // it is re-created by the guard below when a case has removed it.
  await sql`delete from booking where notes = ${`${MARKER} case`}`
  await sql`delete from waitlist where customer_id = ${customerId}`
})

afterAll(async () => {
  await sql`delete from booking where notes like ${`${MARKER}%`}`
  await sql`delete from waitlist where customer_id = ${customerId}`
  await sql`delete from shift_assignment where employee_id = any(${[...staff.values()]}::uuid[])`
  await sql`delete from shift where label = ${MARKER}`
  await sql`delete from employee_document where employee_id = any(${[...staff.values()]}::uuid[])`
  await sql`delete from employee_skill where employee_id = any(${[...staff.values()]}::uuid[])`
  await sql`delete from employee where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from availability_epoch where trading_date = any(${DATES}::date[])`
  await sql`delete from business_day where trading_date = any(${DATES}::date[])`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await sql?.end({ timeout: 5 })
})

/**
 * A booking request for one solo slot on {@link QUIET}, as the page would assemble it from an answer.
 *
 * `therapistIds` is overridable so the out-of-band booking can take the same room with a DIFFERENT
 * therapist: the room holds one client, so the second delivery meets a room with no free place, which is
 * the injected re-check refusing rather than the exclusion constraint firing on a repeated therapist.
 * Those are two different proofs and only one of them is about this unit.
 */
function bookingFor(
  slot: AvailabilitySlot,
  idempotencyKey: string,
  therapistIds: readonly string[] = slot.therapistIds,
) {
  return {
    idempotencyKey,
    customerId,
    source: 'online' as const,
    notes: `${MARKER} case`,
    clientGender: 'female' as const,
    deliveries: [
      {
        tradingDate: QUIET,
        serviceVariantId: variantId,
        shape: 'solo' as const,
        roomId: slot.roomId,
        therapistIds,
        treatment: { startsAt: slot.treatment.startsAt, endsAt: slot.treatment.endsAt },
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

describe('the query, through core', () => {
  it('offers slots on an empty trading day, each with a concrete room and therapist', async () => {
    const answer = await queryAvailability(sql, request({ tradingDate: QUIET }), deps())
    expect(answer.refusal).toBeNull()
    expect(answer.slots.length).toBeGreaterThan(0)
    for (const slot of answer.slots) {
      // The room is whichever one `compareRoomPreference` ranked first among those free — which may be a
      // room 0012 seeds, because a production availability query reads the WHOLE inventory and must. So
      // the assertion is that a concrete room was chosen and that it was one of the free ones, not which
      // room it is: narrowing the query to this file's own rooms would be testing a different function.
      expect(slot.roomId).toMatch(/^[0-9a-f-]{36}$/)
      expect(slot.availableRoomIds).toContain(slot.roomId)
      expect(slot.therapistIds).toHaveLength(1)
      expect(slot.availableTherapistIds).toContain(slot.therapistIds[0])
      // Only this file's probe therapists are rostered on these dates, so the free set is a subset of
      // them — which is what makes the therapist half of this fixture isolated where the room half
      // cannot be.
      for (const therapistId of slot.availableTherapistIds) {
        expect([...staff.values()]).toContain(therapistId)
      }
      expect(slot.placesUsed).toBe(1)
      // Every probe therapist is female and the client is female, so a proved same-gender match is
      // available for every start: `genderMismatch` false is a CLAIM and this is the evidence for it.
      expect(slot.genderMismatch).toBe(false)
    }
  })

  it('offers no start whose treatment plus turnaround would run past close', async () => {
    // 02:00 close, 60-minute treatment, 20-minute turnaround: `latestStartIn` is 00:40, and the grid is
    // aligned to the WALL CLOCK at 15-minute steps (`alignToStep`), so the last start actually OFFERED
    // is 00:30. 00:45 would finish its turnaround at 02:05. The 00:40 figure is only ever offered when
    // the step divides it, which `candidateStarts` says in so many words — and asserting 00:40 here
    // would be asserting a figure this configuration cannot produce.
    const answer = await queryAvailability(sql, request({ tradingDate: QUIET }), deps())
    const starts = answer.slots.map((slot) => slot.startsAt)
    const latest = Math.max(...starts)
    expect(latest).toBe(at(nextDay(QUIET), '00:30'))
    expect(starts).not.toContain(at(nextDay(QUIET), '00:45'))
    // And the first start is 11:15, not 11:00. The therapist interval is `[start - buffer, end + buffer)`
    // and the roster starts at 11:00, so an 11:00 start would need the therapist from 10:50 — which
    // `coveredWithoutGap` refuses. The 10-minute buffer eats the day's first grid point, and that is the
    // turnaround/buffer distinction B-AVAIL-02 keeps: the ROOM is free at 11:00 and the therapist is not.
    expect(Math.min(...starts)).toBe(at(QUIET, '11:15'))
  })

  it('offers nothing for a therapist whose day is full, and everything for one whose is not', async () => {
    const forA = await queryAvailability(
      sql,
      request({ tradingDate: BUSY, therapistIds: [idOf('bavail07p-a')] }),
      deps(),
    )
    expect(forA.slots).toEqual([])
    // The control, and it is the assertion that makes the one above about the THERAPIST rather than
    // about the day: the same date, the same room inventory, a different therapist.
    const forB = await queryAvailability(
      sql,
      request({ tradingDate: BUSY, therapistIds: [idOf('bavail07p-b')] }),
      deps(),
    )
    expect(forB.slots.length).toBeGreaterThan(0)
  })

  it('refuses with requires_client_gender when the client gender was never collected', async () => {
    // B-AVAIL-05's rule, honoured rather than re-opened: absent is strict, and the refusal arrives from
    // core through the injected solver rather than from a second copy of the rule here.
    const { clientGender: _dropped, ...withoutGender } = request({ tradingDate: QUIET })
    const answer = await queryAvailability(sql, withoutGender, deps())
    expect(answer.refusal).toBe('requires_client_gender')
    expect(answer.slots).toEqual([])
  })
})

describe('the memo, through core', () => {
  it('serves the second identical request from the memo and recomputes after a booking', async () => {
    const cache = createAvailabilityCache()
    const options = deps({ cache })
    const first = await queryAvailability(sql, request({ tradingDate: QUIET }), options)
    expect(first.cached).toBe(false)
    expect((await queryAvailability(sql, request({ tradingDate: QUIET }), options)).cached).toBe(
      true,
    )

    const slot = first.slots[0] as AvailabilitySlot
    await bookSlot(sql, CALLER, bookingFor(slot, `${MARKER}-purge`), { recheck })

    const after = await queryAvailability(sql, request({ tradingDate: QUIET }), options)
    expect(after.cached).toBe(false)
    // The START survives, and that is correct: a production availability query reads the whole room
    // inventory, so another free room still delivers it. What must change is that the booked ROOM is no
    // longer among the free ones for that start — which is why `availableRoomIds` is on the slot.
    const sameStart = after.slots.find((row) => row.startsAt === slot.startsAt)
    expect(sameStart?.availableRoomIds ?? []).not.toContain(slot.roomId)
    // And the therapist who took it is no longer free for it either.
    expect(sameStart?.availableTherapistIds ?? []).not.toContain(slot.therapistIds[0])
  })
})

describe('a deliberately stale memo never sells a slot that no longer exists', () => {
  it('still offers the slot from the memo, and the booking refuses it with slot_taken', async () => {
    const cache = createAvailabilityCache()
    const options = deps({ cache })
    const tag = availabilityCacheTag(request({ tradingDate: QUIET }))

    // 1. Prime the memo.
    const primed = await queryAvailability(sql, request({ tradingDate: QUIET }), options)
    const slot = primed.slots.find(
      (candidate) => candidate.startsAt === at(QUIET, '15:00'),
    ) as AvailabilitySlot
    expect(slot).toBeDefined()

    // 2. Take the slot OUT OF BAND, with a different therapist in the same room. The room holds one
    //    client, so the delivery that arrives second meets a room with no free place — which is the
    //    re-check refusing, not a constraint firing at COMMIT.
    const otherTherapist = slot.therapistIds.includes(idOf('bavail07p-b'))
      ? idOf('bavail07p-c')
      : idOf('bavail07p-b')
    const outOfBand = await bookSlot(
      sql,
      CALLER,
      bookingFor(slot, `${MARKER}-out-of-band`, [otherTherapist]),
      { recheck },
    )
    expect(outOfBand.replayed).toBe(false)

    // 3. The memo is now WRONG, and it still offers the slot. Asserted, because without this the case
    //    below could be satisfied by a memo that had already been purged — which proves the opposite of
    //    what this test claims.
    const stale = peekAvailabilityCache(cache, tag)
    expect(stale, 'the memo was purged, so nothing stale is left to book from').toBeDefined()
    const staleSlot = stale?.answer.slots.find((row) => row.startsAt === slot.startsAt)
    expect(staleSlot, 'the stale memo no longer holds the slot at all').toBeDefined()
    // The memo still says that ROOM is free at that start. It is not: the out-of-band booking took it.
    expect(staleSlot?.availableRoomIds).toContain(slot.roomId)

    // 4. Book from the stale list. The database is the authority: `createBooking` re-reads the committed
    //    rows under the room lock and re-applies `assignShape`, so the answer is a named refusal.
    const refusal = await (async (): Promise<string | null> => {
      try {
        await bookSlot(sql, CALLER, bookingFor(slot, `${MARKER}-from-stale`), { recheck })
        return null
      } catch (error) {
        return bookingRefusalOf(error)
      }
    })()
    expect(refusal).toBe('slot_taken')

    // 5. And exactly one appointment exists for that period — the out-of-band one. A DELTA on a shared
    //    table, keyed on this file's own booking ids.
    const [counted] = await sql<{ n: string }[]>`
      select count(*)::text as n from appointment
       where trading_date = ${QUIET}
         and room_id = ${slot.roomId}
         and lower(period) = ${new Date(slot.treatment.startsAt).toISOString()}::timestamptz
         and holds_resources
    `
    expect(Number((counted as { n: string }).n)).toBe(1)
  })

  it('the validated read does NOT offer it, so the staleness above is the memo and not the query', async () => {
    // The control. The same request through `queryAvailability` consults the epoch and recomputes, so the
    // taken slot is absent. Without this pair, "the memo is stale" and "the query is wrong" are the same
    // observation.
    const cache = createAvailabilityCache()
    const options = deps({ cache })
    const primed = await queryAvailability(sql, request({ tradingDate: QUIET }), options)
    const slot = primed.slots[0] as AvailabilitySlot
    await bookSlot(sql, CALLER, bookingFor(slot, `${MARKER}-control`), { recheck })

    const fresh = await queryAvailability(sql, request({ tradingDate: QUIET }), options)
    expect(fresh.cached).toBe(false)
    const sameStart = fresh.slots.find((row) => row.startsAt === slot.startsAt)
    expect(sameStart?.availableRoomIds ?? []).not.toContain(slot.roomId)
  })
})

describe('the no-availability answer is structured data', () => {
  /** Every string anywhere inside a value, for the "no pre-rendered string" assertion. */
  const stringsIn = (value: unknown): string[] => {
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.flatMap(stringsIn)
    if (value !== null && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).flatMap(stringsIn)
    }
    return []
  }

  it('populates nearest_days, alternative_therapists and waitlist_eligible on a full day', async () => {
    const asked = request({ tradingDate: BUSY, therapistIds: [idOf('bavail07p-a')] })
    const answer = await noAvailabilityAlternatives(sql, asked, deps(), {
      searchDays: 2,
      customerId,
    })

    // All three populated, which is what the acceptance line asks for.
    expect(answer.nearestDays.length).toBeGreaterThan(0)
    expect(answer.alternativeTherapists.length).toBeGreaterThan(0)
    expect(answer.waitlistEligible.eligible).toBe(true)
    expect(answer.waitlistEligible.reason).toBeNull()

    // Nearest first, and both directions found: the day before and the day after both have space for
    // this therapist, because only the busy day holds her appointments.
    expect(answer.nearestDays.map((row) => row.tradingDate)).toEqual(
      expect.arrayContaining([EARLIER, LATER]),
    )
    expect(Math.abs(answer.nearestDays[0]?.daysAway ?? 99)).toBe(1)

    // The alternatives are the therapists the FILTER removed, never the one that was asked for.
    const alternatives = answer.alternativeTherapists.map((row) => row.therapistId)
    expect(alternatives).not.toContain(idOf('bavail07p-a'))
    expect(alternatives).toEqual(expect.arrayContaining([idOf('bavail07p-b'), idOf('bavail07p-c')]))
  })

  it('carries no pre-rendered string in any of the three fields', async () => {
    const asked = request({ tradingDate: BUSY, therapistIds: [idOf('bavail07p-a')] })
    const answer = await noAvailabilityAlternatives(sql, asked, deps(), {
      searchDays: 2,
      customerId,
    })

    // Structure first: each row is an object with exactly the keys the type declares, so nobody can add
    // a `label: 'Thursday 3 October, 4 slots from 7pm'` and have it read as data.
    for (const row of answer.nearestDays) {
      expect(typeof row).toBe('object')
      expect(Object.keys(row).sort()).toEqual([
        'daysAway',
        'firstStartsAt',
        'slotCount',
        'tradingDate',
      ])
      expect(typeof row.slotCount).toBe('number')
      expect(typeof row.firstStartsAt).toBe('number')
      expect(typeof row.daysAway).toBe('number')
      expect(row.tradingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    for (const row of answer.alternativeTherapists) {
      expect(Object.keys(row).sort()).toEqual(['firstStartsAt', 'slotCount', 'therapistId'])
      // An id, never a display name: a therapist has no display name until an admin sets one
      // (ADR 0020), and inventing one here is what rule 10 of the brief forbids.
      expect(row.therapistId).toMatch(/^[0-9a-f-]{36}$/)
    }
    expect(Object.keys(answer.waitlistEligible).sort()).toEqual([
      'alreadyWaiting',
      'desiredWindow',
      'eligible',
      'reason',
      'serviceVariantId',
      'shape',
      'therapistId',
      'tradingDate',
    ])
    expect(typeof answer.waitlistEligible.eligible).toBe('boolean')
    expect(typeof answer.waitlistEligible.desiredWindow?.startsAt).toBe('number')

    // And no value anywhere in the three fields is a formatted date, a formatted time or a weekday or
    // month name. A caller formats; this does not, because the Arabic page, the JSON API and an ICS
    // export each need a different rendering of the same three numbers.
    const strings = [
      ...stringsIn(answer.nearestDays),
      ...stringsIn(answer.alternativeTherapists),
      ...stringsIn(answer.waitlistEligible),
    ]
    expect(strings.length).toBeGreaterThan(0)
    for (const value of strings) {
      expect(value, `"${value}" looks like a rendered time`).not.toMatch(/\d{1,2}:\d{2}/)
      expect(value, `"${value}" looks like a rendered date`).not.toMatch(
        /\b(mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i,
      )
      expect(value, `"${value}" looks like a rendered count`).not.toMatch(/\bslots?\b/i)
    }
  })

  it('refuses the waitlist by name when the day has space', async () => {
    // The control for `eligible: true` above. A waitlist that accepted a day with space would fill with
    // people who could have booked, and the reader that offers a released slot would offer it to them
    // first.
    const answer = await noAvailabilityAlternatives(sql, request({ tradingDate: QUIET }), deps(), {
      searchDays: 1,
      customerId,
    })
    expect(answer.waitlistEligible.eligible).toBe(false)
    expect(answer.waitlistEligible.reason).toBe('slots_are_available')
    expect(WAITLIST_INELIGIBILITY as readonly string[]).toContain(
      answer.waitlistEligible.reason as string,
    )
  })

  it('reports alreadyWaiting once the customer has joined, and the join is idempotent', async () => {
    const asked = request({ tradingDate: BUSY, therapistIds: [idOf('bavail07p-a')] })
    const before = await noAvailabilityAlternatives(sql, asked, deps(), {
      searchDays: 1,
      customerId,
    })
    expect(before.waitlistEligible.alreadyWaiting).toBe(false)

    const window = before.waitlistEligible.desiredWindow as {
      startsAt: number
      endsAt: number
    }
    const held = (await readWaitlistFor(sql, { customerId })).length
    const first = await joinWaitlist(sql, {
      customerId,
      serviceVariantId: variantId,
      tradingDate: BUSY,
      window,
      therapistId: before.waitlistEligible.therapistId,
    })
    const second = await joinWaitlist(sql, {
      customerId,
      serviceVariantId: variantId,
      tradingDate: BUSY,
      window,
      therapistId: before.waitlistEligible.therapistId,
    })
    // A DELTA, because `waitlist` is shared with every other suite in this run.
    expect((await readWaitlistFor(sql, { customerId })).length - held).toBe(1)
    expect(second.waitlistId).toBe(first.waitlistId)
    expect(second.created).toBe(false)

    const after = await noAvailabilityAlternatives(sql, asked, deps(), {
      searchDays: 1,
      customerId,
    })
    expect(after.waitlistEligible.alreadyWaiting).toBe(true)
  })

  it('returns no alternative therapists when the caller named none', async () => {
    // Not a gap: the request was already about every therapist, so a non-empty list would be the same
    // slots the caller has just been told do not exist.
    const answer = await noAvailabilityAlternatives(sql, request({ tradingDate: BUSY }), deps(), {
      searchDays: 1,
    })
    expect(answer.alternativeTherapists).toEqual([])
  })
})
