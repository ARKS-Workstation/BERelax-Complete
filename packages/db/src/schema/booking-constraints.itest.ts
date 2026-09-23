import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'

/**
 * B-AVAIL-01 — the booking and appointment concurrency constraints, against real PostgreSQL.
 *
 * Every property here is a property of the *database* and none of them can be tested against a mock:
 * a `btree_gist` exclusion constraint, a constraint trigger whose whole point is that it is checked
 * at COMMIT rather than at each statement, a grant, and a trigger that refuses an administrative
 * change. A mock would assert that the mock refuses an overlap.
 *
 * Three shapes are deliberate throughout, and each of them is a way this file could otherwise have
 * passed while examining nothing.
 *
 *   - **No assertion on "an error was raised".** Every refusal is matched on its SQLSTATE and, where
 *     the message carries the rule name, on that too. A bare rejection would pass just as happily if
 *     the statement had failed for a typo in a column name.
 *   - **Every assertion has a control that must fail.** After proving an overlap is refused, the
 *     same therapist takes an abutting appointment; after proving a capacity reduction is refused,
 *     the same reduction succeeds once the appointments no longer overlap.
 *   - **The deferred case proves it is deferred.** The rows go in one at a time, each INSERT
 *     succeeding, and are read back *inside* the transaction before the COMMIT is asserted to fail.
 *     A test that failed on the third INSERT would have proved the opposite of what is wanted — that
 *     the constraint is immediate, and therefore unusable for a reschedule. `journal.itest.ts` does
 *     exactly this for M-TILL-02's balance trigger.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** `23P01`, exclusion_violation: two rows the exclusion constraint refuses to hold at once. */
const EXCLUSION_VIOLATION = '23P01'
/** `ZB001`: the deferred room-capacity trigger, raised from COMMIT. */
const ROOM_OVER_CAPACITY = 'ZB001'
/** `ZB002`: `rooms.capacity` reduced below what the room has already promised. */
const CAPACITY_BELOW_COMMITTED = 'ZB002'
/** `ZB003`: appointment_status_history refusing an UPDATE or a DELETE, for every role. */
const HISTORY_APPEND_ONLY = 'ZB003'
/** `42501`, insufficient_privilege: the grant layer refusing before any trigger runs. */
const INSUFFICIENT_PRIVILEGE = '42501'
/** `23514`, check_violation. */
const CHECK_VIOLATION = '23514'

/**
 * A trading date far enough ahead that every fixture appointment is still in the future.
 *
 * That matters for exactly one assertion: the `rooms.capacity` guard counts appointments that have
 * not yet ended, because a past appointment happened and no capacity number changes that. A fixture
 * in the past would make that guard pass for the wrong reason.
 */
const TRADING_DATE = '2099-03-01'
/**
 * The two figures 0038 made NOT NULL on `appointment`, at the values 0017 seeds for a standard dry
 * massage. There is no honest default for either — a zero turnaround claims the room is free the instant
 * the treatment ends — so every writer states them and a missing snapshot is a not-null violation.
 */
const TURNAROUND_MINUTES = 20
const BUFFER_MINUTES = 10
const at = (hhmm: string) => `2099-03-01 ${hhmm}:00+00`
const period = (from: string, to: string) => `[${at(from)},${at(to)})`

/** Therapists have no display name; these are ids and nothing else (brief rule 10, ADR 0020). */
const THERAPIST_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const THERAPIST_B = 'aaaaaaaa-0000-4000-8000-00000000000b'
const THERAPIST_C = 'aaaaaaaa-0000-4000-8000-00000000000c'

/** Phone-shaped, not a person. The customer is `Customer 0042` everywhere it is displayed. */
const PROBE_PHONE = '+971500000142'
/** A room this file owns, so no test mutates the seeded inventory. */
const TWIN_ROOM_CODE = 'bavail01-twin'

let sql: Sql
let customerId: string
let variantId: string
let couplesRoomId: string
let standardRoomId: string
let twinRoomId: string

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = customer?.id as string

  // The trading calendar is a TABLE (0011), and appointment.trading_date is a foreign key into it,
  // so a fixture cannot invent a date the premises does not trade on. 07:00Z–22:00Z is 11:00–02:00
  // in Asia/Dubai, which is the trading window the whole system is built around.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${at('07')}::timestamptz, ${at('22')}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  // 0017 deliberately seeds no prices (they are B-CAT-06's), so the variant this file books against
  // is its own. 200.00 AED as integer fils, VAT-inclusive gross (ADR 0007).
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    select s.id, 90, 20000, 'B-AVAIL-01 fixture'
      from service s where s.style = 'asian' and s.treatment_key = 'normal_massage'
    on conflict (service_id, duration_minutes)
      do update set provisional_note = excluded.provisional_note
    returning id
  `
  variantId = variant?.id as string

  // A capacity-2 room of type `standard`, and the type is the point.
  //
  // The obvious fixture is the seeded couples room, which is also capacity 2. It cannot be used for
  // the capacity-reduction case: 0012's `rooms_couples_holds_two` refuses ANY couples room below
  // capacity 2, so the reduction would be rejected by a constraint that has nothing to do with the
  // appointments in the room, and the test would pass while `capacity_below_committed` was dead.
  // That case asserts both, by name, for exactly this reason.
  const [twin] = await sql<{ id: string }[]>`
    insert into rooms (code, name, room_type, capacity, display_order, notes)
    values (${TWIN_ROOM_CODE}, 'Twin fixture room', 'standard', 2, 90, 'B-AVAIL-01 fixture')
    on conflict (code) do update set capacity = 2
    returning id
  `
  twinRoomId = twin?.id as string

  const rooms = await sql<{ id: string; code: string }[]>`
    select id, code from rooms where code in ('room-couples', 'room-1')
  `
  couplesRoomId = rooms.find((r) => r.code === 'room-couples')?.id as string
  standardRoomId = rooms.find((r) => r.code === 'room-1')?.id as string
})

afterAll(async () => {
  await sql.unsafe(
    'truncate booking_idempotency, appointment_status_history, scheduled_step, appointment, booking',
  )
  await sql`delete from rooms where code = ${TWIN_ROOM_CODE}`
  await sql`delete from service_variant where provisional_note = 'B-AVAIL-01 fixture'`
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  // TRUNCATE, not DELETE: appointment_status_history refuses a DELETE from every role including this
  // one, which is the property the privilege case tests. TRUNCATE fires no row-level trigger, which
  // is precisely why 0024 revokes it from the application role.
  //
  // `scheduled_step` is in the list because 0051 (B-MSG-03) gave `appointment` its first referencing
  // table, and PostgreSQL refuses to truncate a table a foreign key points at unless every referencing
  // table is truncated in the SAME statement. Named rather than reached with CASCADE, so the next table
  // to reference `appointment` shows up here as a failing test rather than as rows quietly removed.
  await sql.unsafe(
    'truncate booking_idempotency, appointment_status_history, scheduled_step, appointment, booking',
  )
  await sql`update rooms set capacity = 2 where code = ${TWIN_ROOM_CODE}`
})

/** The SQLSTATE and message of a rejected promise, or a marker that it was not rejected at all. */
async function stateOf(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await promise
    return { code: undefined, message: 'the statement succeeded' }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return {
      code: typeof code === 'string' ? code : undefined,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Creates a booking and returns its id. */
async function newBooking(tx: Sql = sql): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into booking (customer_id, source) values (${customerId}, 'front_desk') returning id
  `
  return row?.id as string
}

interface AppointmentInput {
  bookingId: string
  roomId: string
  therapistId: string
  period: string
  shape?: 'solo' | 'four_hands' | 'couple'
  status?: string
  id?: string
  /**
   * Omitted means a fresh delivery per row, which is what `appointment.delivery_id` defaults to and the
   * count this file was written against: one row, one delivery, one client place (0038). A shape whose
   * two rows are ONE delivery is B-AVAIL-06's own suites' to write.
   */
  deliveryId?: string
  roomPlaces?: number
}

async function insertAppointment(tx: Sql, input: AppointmentInput): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into appointment
      (id, booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period,
       status, delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
       gross_price_fils, net_fils, vat_fils)
    values (
      coalesce(${input.id ?? null}::uuid, uuid_generate_v7()),
      ${input.bookingId}, ${TRADING_DATE}, ${variantId}, ${input.shape ?? 'solo'},
      ${input.therapistId}, ${input.roomId}, ${input.period}::tstzrange,
      ${input.status ?? 'confirmed'}::appointment_status,
      coalesce(${input.deliveryId ?? null}::uuid, uuid_generate_v7()),
      ${input.roomPlaces ?? 1}, ${TURNAROUND_MINUTES}, ${BUFFER_MINUTES}, 20000, 19048, 952
    )
    returning id
  `
  return row?.id as string
}

/** Runs `body` as the application role, in its own transaction. */
async function asApplicationRole<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`set local role berelax_app`
    return body(tx as unknown as Sql)
  }) as Promise<T>
}

describe('acceptance — a therapist cannot be in two places', () => {
  it('declares EXCLUDE USING gist (therapist_id WITH =, period WITH &&) with a partial predicate', async () => {
    const [row] = await sql<{ def: string; contype: string }[]>`
      select pg_get_constraintdef(oid) as def, contype::text as contype
        from pg_constraint where conname = 'appointment_therapist_no_overlap'
    `
    expect(row?.contype).toBe('x') // a real exclusion CONSTRAINT, not a bare index
    expect(row?.def).toContain('EXCLUDE USING gist')
    expect(row?.def).toContain('therapist_id WITH =')
    expect(row?.def).toContain('period WITH &&')
    // The predicate is what lets a cancelled appointment release its therapist. PostgreSQL 16 accepts
    // a WHERE on an EXCLUDE table constraint; it is UNIQUE that has no partial constraint form.
    expect(row?.def).toContain('WHERE (holds_resources)')

    // Control: a constraint that is NOT an exclusion reads differently, so the assertions above are
    // about this constraint rather than about pg_get_constraintdef returning something for anything.
    const [check] = await sql<{ def: string; contype: string }[]>`
      select pg_get_constraintdef(oid) as def, contype::text as contype
        from pg_constraint where conname = 'appointment_period_half_open'
    `
    expect(check?.contype).toBe('c')
    expect(check?.def).not.toContain('EXCLUDE')
  })

  it('refuses two overlapping appointments for one therapist with SQLSTATE 23P01', async () => {
    const bookingId = await newBooking()
    await insertAppointment(sql, {
      bookingId,
      roomId: standardRoomId,
      therapistId: THERAPIST_A,
      period: period('15', '16'),
    })

    // A different room, deliberately: the therapist is the constraint, not the room.
    const refused = await stateOf(
      insertAppointment(sql, {
        bookingId,
        roomId: twinRoomId,
        therapistId: THERAPIST_A,
        period: period('15', '16'),
      }),
    )
    expect(refused.code).toBe(EXCLUSION_VIOLATION)
    expect(refused.message).toContain('appointment_therapist_no_overlap')

    // Control 1: the identical overlapping period for a DIFFERENT therapist is accepted, so the
    // refusal above is the therapist clause and not a period the table has stopped accepting.
    await expect(
      insertAppointment(sql, {
        bookingId,
        roomId: twinRoomId,
        therapistId: THERAPIST_B,
        period: period('15', '16'),
      }),
    ).resolves.toBeTruthy()

    // Control 2: a period that merely touches, rather than overlaps, is accepted for the SAME
    // therapist. Without this the case would pass equally against a constraint on therapist_id alone.
    await expect(
      insertAppointment(sql, {
        bookingId,
        roomId: standardRoomId,
        therapistId: THERAPIST_A,
        period: period('16', '17'),
      }),
    ).resolves.toBeTruthy()
  })
})

describe("acceptance — period is a '[)' tstzrange and abutting appointments are legal", () => {
  it('refuses an upper bound at or before the lower bound, and an inclusive upper bound', async () => {
    const bookingId = await newBooking()

    const inverted = await stateOf(
      insertAppointment(sql, {
        bookingId,
        roomId: standardRoomId,
        therapistId: THERAPIST_A,
        period: `[${at('16')},${at('15')})`,
      }),
    )
    // An inverted range does not even reach the CHECK: the range constructor itself refuses it,
    // which is a stronger refusal and worth asserting as the one that actually fires.
    expect(inverted.message).toMatch(/range lower bound must be less than or equal to range upper/)

    const empty = await stateOf(
      insertAppointment(sql, {
        bookingId,
        roomId: standardRoomId,
        therapistId: THERAPIST_A,
        period: `[${at('15')},${at('15')})`,
      }),
    )
    // An empty range has null bounds, so `upper(period) > lower(period)` evaluates to NULL and
    // PASSES. `appointment_period_bounded` is the constraint that catches it, which is exactly why
    // the two are separate rather than one clever expression.
    expect(empty.code).toBe(CHECK_VIOLATION)
    expect(empty.message).toContain('appointment_period_bounded')

    const inclusive = await stateOf(
      insertAppointment(sql, {
        bookingId,
        roomId: standardRoomId,
        therapistId: THERAPIST_A,
        period: `[${at('15')},${at('16')}]`,
      }),
    )
    expect(inclusive.code).toBe(CHECK_VIOLATION)
    expect(inclusive.message).toContain('appointment_period_half_open')

    // Control: the legitimate half-open range inserts. Three refusals and no acceptance would be a
    // table that refuses every period.
    await expect(
      insertAppointment(sql, {
        bookingId,
        roomId: standardRoomId,
        therapistId: THERAPIST_A,
        period: period('15', '16'),
      }),
    ).resolves.toBeTruthy()
  })

  it('accepts two appointments abutting exactly at a boundary instant for the same therapist', async () => {
    // The whole reason the bound style is pinned. Stored as '[]' the second would overlap the first
    // at 16:00 and be refused, which silently shortens every trading day by one treatment.
    const bookingId = await newBooking()
    const first = await insertAppointment(sql, {
      bookingId,
      roomId: standardRoomId,
      therapistId: THERAPIST_A,
      period: period('15', '16'),
    })
    const second = await insertAppointment(sql, {
      bookingId,
      roomId: standardRoomId,
      therapistId: THERAPIST_A,
      period: period('16', '17'),
    })
    expect(first).not.toBe(second)

    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from appointment where booking_id = ${bookingId}
    `
    expect(row?.n).toBe('2')

    // Control: one minute of genuine overlap at the same boundary IS refused, so the acceptance
    // above is the half-open bound and not an exclusion constraint that has stopped working.
    const refused = await stateOf(
      insertAppointment(sql, {
        bookingId,
        roomId: standardRoomId,
        therapistId: THERAPIST_A,
        period: `[2099-03-01 16:59:00+00,${at('18')})`,
      }),
    )
    expect(refused.code).toBe(EXCLUSION_VIOLATION)
  })
})

describe('acceptance — the room-capacity trigger is deferred to COMMIT', () => {
  it('is registered DEFERRABLE INITIALLY DEFERRED, not merely late-firing', async () => {
    const [row] = await sql<{ deferrable: boolean; deferred: boolean }[]>`
      select tgdeferrable as deferrable, tginitdeferred as deferred
        from pg_trigger where tgname = 'appointment_room_capacity'
    `
    expect(row?.deferrable).toBe(true)
    expect(row?.deferred).toBe(true)

    // Control: the mirror-image guard on `rooms` is NOT deferred, because reducing a capacity is a
    // single-row administrative change with nothing transient about it. If every trigger read as
    // deferred, the assertion above would be about the query rather than about the constraint.
    const [immediate] = await sql<{ deferrable: boolean }[]>`
      select tgdeferrable as deferrable
        from pg_trigger where tgname = 'rooms_capacity_covers_commitments'
    `
    expect(immediate?.deferrable).toBe(false)
  })

  it('commits the two appointments of a couples booking into the capacity-2 room', async () => {
    const bookingId = await newBooking()
    await expect(
      sql.begin(async (tx) => {
        await insertAppointment(tx as unknown as Sql, {
          bookingId,
          roomId: couplesRoomId,
          therapistId: THERAPIST_A,
          period: period('19', '20'),
          shape: 'couple',
        })
        await insertAppointment(tx as unknown as Sql, {
          bookingId,
          roomId: couplesRoomId,
          therapistId: THERAPIST_B,
          period: period('19', '20'),
          shape: 'couple',
        })
        return 'committed'
      }),
    ).resolves.toBe('committed')

    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from appointment where room_id = ${couplesRoomId}
    `
    expect(row?.n).toBe('2')
  })

  it('accepts each INSERT and fails the COMMIT when the third overlaps in a capacity-2 room', async () => {
    // The structure IS the proof. An immediate trigger would reject the third INSERT, so a test that
    // failed there would have proved the opposite of what is wanted.
    const bookingId = await newBooking()
    const reached: string[] = []

    const outcome = await stateOf(
      sql.begin(async (tx) => {
        await insertAppointment(tx as unknown as Sql, {
          bookingId,
          roomId: couplesRoomId,
          therapistId: THERAPIST_A,
          period: period('19', '20'),
          shape: 'couple',
        })
        reached.push('first couples appointment inserted')
        await insertAppointment(tx as unknown as Sql, {
          bookingId,
          roomId: couplesRoomId,
          therapistId: THERAPIST_B,
          period: period('19', '20'),
          shape: 'couple',
        })
        reached.push('second couples appointment inserted')
        await insertAppointment(tx as unknown as Sql, {
          bookingId,
          roomId: couplesRoomId,
          therapistId: THERAPIST_C,
          period: `[2099-03-01 19:30:00+00,${at('20')})`,
        })
        reached.push('third overlapping appointment inserted')
        // Every statement above succeeded while the room was over capacity. If any of them had
        // raised, `reached` would be short and the assertion below would fail.
        const [visible] = await tx<{ n: string }[]>`
          select count(*)::text as n from appointment where room_id = ${couplesRoomId}
        `
        reached.push(`${visible?.n} appointments visible inside the transaction`)
      }),
    )

    expect(reached).toEqual([
      'first couples appointment inserted',
      'second couples appointment inserted',
      'third overlapping appointment inserted',
      '3 appointments visible inside the transaction',
    ])
    // And the failure arrived from COMMIT.
    expect(outcome.code).toBe(ROOM_OVER_CAPACITY)
    expect(outcome.message).toContain('room_over_capacity')
    expect(outcome.message).toContain('room-couples')
    expect(outcome.message).toContain('capacity is 2')

    // The whole transaction rolled back, so no half-booking survives.
    const [after] = await sql<{ n: string }[]>`select count(*)::text as n from appointment`
    expect(after?.n).toBe('0')
  })

  it('counts overlap rather than the day, so two appointments at different times are not a peak of 2', async () => {
    // The naive implementation counts the room's appointments for the day, and would refuse the
    // second of these two. It is also what makes the capacity-reduction guard usable.
    // The capacity-2 fixture room, because room-1 holds one and the point here is the count rather
    // than the refusal.
    const bookingId = await newBooking()
    await insertAppointment(sql, {
      bookingId,
      roomId: twinRoomId,
      therapistId: THERAPIST_A,
      period: period('15', '16'),
    })
    await insertAppointment(sql, {
      bookingId,
      roomId: twinRoomId,
      therapistId: THERAPIST_B,
      period: period('18', '19'),
    })

    const [peak] = await sql<{ concurrent: number }[]>`
      select concurrent from room_peak_concurrency(${twinRoomId}, null::tstzrange)
    `
    expect(peak?.concurrent).toBe(1)

    // Control: overlapping them makes the same room report 2, so the 1 above is the function
    // measuring concurrency and not a function that always answers 1.
    await sql`
      update appointment set period = ${period('15', '16')}::tstzrange
       where therapist_id = ${THERAPIST_B}
    `
    const [overlapping] = await sql<{ concurrent: number }[]>`
      select concurrent from room_peak_concurrency(${twinRoomId}, null::tstzrange)
    `
    expect(overlapping?.concurrent).toBe(2)

    // And an empty room answers 0 in one row, not an absent row: a caller comparing a capacity
    // against NULL gets neither true nor false, and the guard would pass in silence.
    const [empty] = await sql<{ concurrent: number; at: string | null }[]>`
      select concurrent, at from room_peak_concurrency(${couplesRoomId}, null::tstzrange)
    `
    expect(empty?.concurrent).toBe(0)
    expect(empty?.at).toBeNull()
  })
})

describe('acceptance — the IMMEDIATE variant is the regression that justifies DEFERRED', () => {
  /**
   * The same trigger function, attached without `DEFERRABLE`. Kept as a fixture and created inside
   * the case, never shipped: an immediate variant on the live table would refuse the rearrangement
   * below every time the front desk made it.
   */
  const IMMEDIATE_VARIANT = `
    create constraint trigger appointment_room_capacity_immediate_regression
      after insert or update on appointment
      for each row execute function assert_room_capacity()
  `

  /**
   * Two bookings in the one couples room, swapping slots.
   *
   * B is a couples booking (two appointments, 19:00) and C a single appointment at 20:00. Moving B
   * to 20:00 and C to 19:00 is legitimate and ends valid — 19:00 holds one appointment, 20:00 holds
   * two, and the room's capacity is two. It cannot be done without passing through a state where
   * three appointments overlap at 20:00, because the statements arrive one at a time.
   */
  async function seedSwapFixture(): Promise<{ b1: string; b2: string; c1: string }> {
    const coupleBooking = await newBooking()
    const singleBooking = await newBooking()
    const b1 = await insertAppointment(sql, {
      bookingId: coupleBooking,
      roomId: couplesRoomId,
      therapistId: THERAPIST_A,
      period: period('19', '20'),
      shape: 'couple',
    })
    const b2 = await insertAppointment(sql, {
      bookingId: coupleBooking,
      roomId: couplesRoomId,
      therapistId: THERAPIST_B,
      period: period('19', '20'),
      shape: 'couple',
    })
    const c1 = await insertAppointment(sql, {
      bookingId: singleBooking,
      roomId: couplesRoomId,
      therapistId: THERAPIST_C,
      period: period('20', '21'),
    })
    return { b1, b2, c1 }
  }

  const moveTo = (tx: Sql, id: string, from: string, to: string) =>
    tx`update appointment set period = ${period(from, to)}::tstzrange where id = ${id}`

  it('rejects the legitimate second couples row, which the deferred original accepts', async () => {
    const { b1, b2, c1 } = await seedSwapFixture()
    const reached: string[] = []
    let outcome: { code: string | undefined; message: string }

    await sql.unsafe(IMMEDIATE_VARIANT)
    try {
      outcome = await stateOf(
        sql.begin(async (tx) => {
          await moveTo(tx as unknown as Sql, b1, '20', '21')
          reached.push('first couples row moved')
          await moveTo(tx as unknown as Sql, b2, '20', '21')
          reached.push('second couples row moved')
          await moveTo(tx as unknown as Sql, c1, '19', '20')
          reached.push('the single appointment moved')
        }),
      )
    } finally {
      // A fixture trigger left attached would make every later case in this file fail with an error
      // about the wrong thing, and the first person to see it would spend an hour on the wrong bug.
      await sql.unsafe('drop trigger appointment_room_capacity_immediate_regression on appointment')
    }

    // The FIRST move is accepted — at that instant the room holds two, which is its capacity. It is
    // the SECOND row of the legitimate couples booking that the immediate variant refuses, and there
    // is no order of these three statements that avoids it.
    expect(reached).toEqual(['first couples row moved'])
    expect(outcome.code).toBe(ROOM_OVER_CAPACITY)
    expect(outcome.message).toContain('room_over_capacity')

    // And the whole point: the identical trigger, deferred, accepts the same three statements and
    // the transaction commits. Without this the case above would only prove that a trigger can say
    // no. The fixture is untouched, because the immediate transaction rolled back.
    await expect(
      sql.begin(async (tx) => {
        await moveTo(tx as unknown as Sql, b1, '20', '21')
        await moveTo(tx as unknown as Sql, b2, '20', '21')
        await moveTo(tx as unknown as Sql, c1, '19', '20')
        return 'committed'
      }),
    ).resolves.toBe('committed')

    const rows = await sql<{ id: string; starts: string }[]>`
      select id, to_char(lower(period) at time zone 'UTC', 'HH24:MI') as starts
        from appointment order by lower(period), id
    `
    expect(rows.map((r) => r.starts)).toEqual(['19:00', '20:00', '20:00'])
    expect(rows[0]?.id).toBe(c1)
  })

  it('still refuses a final state that is genuinely over capacity, deferred or not', async () => {
    // The deferred trigger must not be a trigger that never fires. Same fixture, but the single
    // appointment is left where it is, so the transaction ENDS with three overlapping at 20:00.
    const { b1, b2 } = await seedSwapFixture()
    const outcome = await stateOf(
      sql.begin(async (tx) => {
        await moveTo(tx as unknown as Sql, b1, '20', '21')
        await moveTo(tx as unknown as Sql, b2, '20', '21')
      }),
    )
    expect(outcome.code).toBe(ROOM_OVER_CAPACITY)
    // "client places", not "appointments": 0038 corrected the unit rooms.capacity is counted in, and
    // these three rows are three separate deliveries of one client each.
    expect(outcome.message).toContain('would hold 3 client places')
  })
})

describe('acceptance — cancelled and no-show appointments release their room and therapist', () => {
  it('re-books the freed period for the same therapist and the same room after a cancellation', async () => {
    const bookingId = await newBooking()
    const original = await insertAppointment(sql, {
      bookingId,
      roomId: standardRoomId,
      therapistId: THERAPIST_A,
      period: period('19', '20'),
    })

    // Before the cancellation, the same therapist and room are taken.
    const blocked = await stateOf(
      insertAppointment(sql, {
        bookingId,
        roomId: standardRoomId,
        therapistId: THERAPIST_A,
        period: period('19', '20'),
      }),
    )
    expect(blocked.code).toBe(EXCLUSION_VIOLATION)

    await sql`
      update appointment set status = 'cancelled_by_customer' where id = ${original}
    `
    const [cancelled] = await sql<{ holds: boolean }[]>`
      select holds_resources as holds from appointment where id = ${original}
    `
    expect(cancelled?.holds).toBe(false)

    // The same therapist, the same room, the same period. This is the correction the front desk
    // makes most often, and without the partial predicate the constraint protecting the slot would
    // be the thing refusing to release it.
    const rebooked = await insertAppointment(sql, {
      bookingId,
      roomId: standardRoomId,
      therapistId: THERAPIST_A,
      period: period('19', '20'),
    })
    expect(rebooked).not.toBe(original)

    // A no-show releases it too, and the capacity trigger agrees with the exclusion constraint: the
    // capacity-1 standard room now holds two rows for one period and is not over capacity.
    await sql`update appointment set status = 'no_show' where id = ${rebooked}`
    const [peak] = await sql<{ concurrent: number }[]>`
      select concurrent from room_peak_concurrency(${standardRoomId}, null::tstzrange)
    `
    expect(peak?.concurrent).toBe(0)

    // Control: un-cancelling the original makes both constraints see it again. Without this the
    // assertions above would pass against a predicate that excluded every row.
    const restored = await stateOf(
      sql`update appointment set status = 'confirmed' where id = ${original}`,
    )
    expect(restored.code).toBeUndefined()
    const [restoredPeak] = await sql<{ concurrent: number }[]>`
      select concurrent from room_peak_concurrency(${standardRoomId}, null::tstzrange)
    `
    expect(restoredPeak?.concurrent).toBe(1)
  })

  it('backs the exclusion with a partial index, so a cancelled row is absent from it', async () => {
    const indexes = await sql<{ name: string; partial: boolean }[]>`
      select c.relname as name, (i.indpred is not null) as partial
        from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname in ('appointment_therapist_no_overlap',
                           'appointment_room_period_idx',
                           'appointment_booking_idx')
    `
    const byName = new Map(indexes.map((row) => [row.name, row.partial]))
    expect(byName.get('appointment_therapist_no_overlap')).toBe(true)
    expect(byName.get('appointment_room_period_idx')).toBe(true)
    // Control: an index that is NOT partial reads as false, so the two trues are the predicate and
    // not a query that reports every index as partial.
    expect(byName.get('appointment_booking_idx')).toBe(false)
  })
})

describe('acceptance — rooms.capacity cannot be reduced below what the room already owes', () => {
  it('refuses the reduction by name, and allows it once the appointments no longer overlap', async () => {
    const bookingId = await newBooking()
    await insertAppointment(sql, {
      bookingId,
      roomId: twinRoomId,
      therapistId: THERAPIST_A,
      period: period('19', '20'),
      shape: 'couple',
    })
    await insertAppointment(sql, {
      bookingId,
      roomId: twinRoomId,
      therapistId: THERAPIST_B,
      period: period('19', '20'),
      shape: 'couple',
    })

    const refused = await stateOf(sql`update rooms set capacity = 1 where id = ${twinRoomId}`)
    expect(refused.code).toBe(CAPACITY_BELOW_COMMITTED)
    expect(refused.message).toContain('capacity_below_committed')
    expect(refused.message).toContain(TWIN_ROOM_CODE)
    // Two rows, two deliveries, two client places (0038). The figure is the same as the row count here
    // because each row is its own delivery, which is what `delivery_id`'s default means.
    expect(refused.message).toContain('already holds 2 client places')

    // Control 1: raising the capacity is never refused, so the guard is the reduction and not a
    // table that has stopped accepting updates.
    await expect(sql`update rooms set capacity = 3 where id = ${twinRoomId}`).resolves.toBeDefined()
    await sql`update rooms set capacity = 2 where id = ${twinRoomId}`

    // Control 2, and the one that matters. Moving one appointment to a different time of the same
    // evening leaves the room with two bookings and a peak of one, and the reduction must now be
    // allowed. A guard counting the day's total would refuse this, which is an admin unable to
    // correct data — the guard becoming the problem it exists to prevent.
    await sql`
      update appointment set period = ${period('21', '22')}::tstzrange
       where therapist_id = ${THERAPIST_B}
    `
    await expect(sql`update rooms set capacity = 1 where id = ${twinRoomId}`).resolves.toBeDefined()
    const [row] = await sql<{ capacity: number; n: string }[]>`
      select r.capacity, (select count(*)::text from appointment a where a.room_id = r.id) as n
        from rooms r where r.id = ${twinRoomId}
    `
    expect(row?.capacity).toBe(1)
    expect(row?.n).toBe('2')
  })

  it('is a different rule from the couples-room floor, which the fixture room exists to avoid', async () => {
    // The seeded couples room is also capacity 2 and cannot be used for the case above: 0012's
    // `rooms_couples_holds_two` refuses ANY couples room below 2, so the reduction would be rejected
    // by a constraint that has nothing to do with the appointments in it, and
    // `capacity_below_committed` could have been dead code for ever while the test passed.
    const empty = await stateOf(sql`update rooms set capacity = 1 where id = ${couplesRoomId}`)
    expect(empty.code).toBe(CHECK_VIOLATION)
    expect(empty.message).toContain('rooms_couples_holds_two')
    expect(empty.code).not.toBe(CAPACITY_BELOW_COMMITTED)
  })

  it('ignores appointments that have already ended, so a room stays correctable', async () => {
    // A past appointment happened; no capacity number changes that. Refusing a reduction because of
    // last year's bookings would mean a room whose capacity can never be corrected again.
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values ('2020-03-01', '2020-03-01 07:00:00+00', '2020-03-01 22:00:00+00', 'weekly')
      on conflict (trading_date) do nothing
    `
    const bookingId = await newBooking()
    const past = '[2020-03-01 19:00:00+00,2020-03-01 20:00:00+00)'
    for (const therapistId of [THERAPIST_A, THERAPIST_B]) {
      await sql`
        insert into appointment
          (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period,
           status, turnaround_minutes, therapist_buffer_minutes, gross_price_fils, net_fils, vat_fils)
        values (${bookingId}, '2020-03-01', ${variantId}, 'couple', ${therapistId},
                ${twinRoomId}, ${past}::tstzrange, 'completed', ${TURNAROUND_MINUTES},
                ${BUFFER_MINUTES}, 20000, 19048, 952)
      `
    }
    await expect(sql`update rooms set capacity = 1 where id = ${twinRoomId}`).resolves.toBeDefined()

    // Control: the same two appointments in the future DO refuse the reduction, so the acceptance
    // above is the time window and not a guard that has stopped counting.
    await sql`update rooms set capacity = 2 where id = ${twinRoomId}`
    await sql`
      update appointment set period = ${period('19', '20')}::tstzrange, trading_date = ${TRADING_DATE}
       where room_id = ${twinRoomId}
    `
    const refused = await stateOf(sql`update rooms set capacity = 1 where id = ${twinRoomId}`)
    expect(refused.code).toBe(CAPACITY_BELOW_COMMITTED)

    await sql.unsafe(
      'truncate booking_idempotency, appointment_status_history, scheduled_step, appointment, booking',
    )
    await sql`delete from business_day where trading_date = '2020-03-01'`
  })
})

describe('acceptance — appointment_status_history is append-only for the application role', () => {
  it('refuses UPDATE and DELETE from the application role with insufficient_privilege', async () => {
    const bookingId = await newBooking()
    const appointmentId = await insertAppointment(sql, {
      bookingId,
      roomId: standardRoomId,
      therapistId: THERAPIST_A,
      period: period('19', '20'),
    })

    const updated = await stateOf(
      asApplicationRole(
        (tx) => tx`update appointment_status_history set to_status = 'completed'
                   where appointment_id = ${appointmentId}`,
      ),
    )
    // 42501, not ZB003: the privilege is absent, so the statement never reaches the refusal trigger.
    // That ordering is the point of having both layers — an injected statement cannot get far enough
    // to be refused by a trigger somebody might later drop.
    expect(updated.code).toBe(INSUFFICIENT_PRIVILEGE)
    expect(updated.message).toMatch(/permission denied/)

    const deleted = await stateOf(
      asApplicationRole(
        (tx) => tx`delete from appointment_status_history where appointment_id = ${appointmentId}`,
      ),
    )
    expect(deleted.code).toBe(INSUFFICIENT_PRIVILEGE)

    // TRUNCATE is the statement that slips past a row-level trigger, so the privilege matters more
    // here than anywhere else.
    const truncated = await stateOf(
      asApplicationRole((tx) => tx.unsafe('truncate appointment_status_history')),
    )
    expect(truncated.code).toBe(INSUFFICIENT_PRIVILEGE)

    // Control 1: the application role CAN read and append, which are the privileges it holds. Three
    // refusals with no acceptance would be a role that cannot see the table at all.
    const appended = await asApplicationRole(async (tx) => {
      await tx`insert into appointment_status_history (appointment_id, from_status, to_status)
               values (${appointmentId}, 'confirmed', 'completed')`
      const [row] = await tx<{ n: string }[]>`
        select count(*)::text as n from appointment_status_history
         where appointment_id = ${appointmentId}
      `
      return row?.n
    })
    expect(appended).toBe('2')

    // Control 2: the same role CAN update `appointment`, so the refusals above are this table's
    // grants and not a read-only session.
    const allowed = await stateOf(
      asApplicationRole(
        (tx) => tx`update appointment set status = 'checked_in' where id = ${appointmentId}`,
      ),
    )
    expect(allowed.code).toBeUndefined()
  })

  it('states the grants it holds and the ones it does not', async () => {
    const [priv] = await sql<
      { sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }[]
    >`
      select has_table_privilege('berelax_app', 'appointment_status_history', 'SELECT')   as sel,
             has_table_privilege('berelax_app', 'appointment_status_history', 'INSERT')   as ins,
             has_table_privilege('berelax_app', 'appointment_status_history', 'UPDATE')   as upd,
             has_table_privilege('berelax_app', 'appointment_status_history', 'DELETE')   as del,
             has_table_privilege('berelax_app', 'appointment_status_history', 'TRUNCATE') as trunc
    `
    expect(priv?.upd).toBe(false)
    expect(priv?.del).toBe(false)
    expect(priv?.trunc).toBe(false)
    // The control: SELECT and INSERT are held, so the three falses are not a role with no access.
    expect(priv?.sel).toBe(true)
    expect(priv?.ins).toBe(true)
  })

  it('refuses UPDATE and DELETE for the owner too, which privileges cannot cover', async () => {
    // A migration, a psql session and any future admin tool connect as the owner, and the owner is
    // who rewrites history by hand at 2am.
    const bookingId = await newBooking()
    const appointmentId = await insertAppointment(sql, {
      bookingId,
      roomId: standardRoomId,
      therapistId: THERAPIST_A,
      period: period('19', '20'),
    })
    const [me] = await sql<{ me: string }[]>`select current_user as me`
    expect(me?.me).not.toBe('berelax_app')

    const updated = await stateOf(
      sql`update appointment_status_history set to_status = 'completed'
           where appointment_id = ${appointmentId}`,
    )
    expect(updated.code).toBe(HISTORY_APPEND_ONLY)
    expect(updated.message).toContain('is append-only')

    const deleted = await stateOf(
      sql`delete from appointment_status_history where appointment_id = ${appointmentId}`,
    )
    expect(deleted.code).toBe(HISTORY_APPEND_ONLY)

    // Control: the same connection CAN delete from a table that is not append-only, so the refusal
    // is the trigger and not a read-only session.
    await expect(sql`delete from appointment where id = ${appointmentId}`).resolves.toBeDefined()
  })

  it('records every transition, written by the trigger rather than by the caller', async () => {
    const bookingId = await newBooking()
    const appointmentId = await insertAppointment(sql, {
      bookingId,
      roomId: standardRoomId,
      therapistId: THERAPIST_A,
      period: period('19', '20'),
      status: 'requested',
    })
    await sql`update appointment set status = 'confirmed' where id = ${appointmentId}`
    // Re-asserting the status it already has writes no row: a "transition" from a state to itself is
    // a row that makes the chain read as activity where nothing happened.
    await sql`update appointment set status = 'confirmed' where id = ${appointmentId}`
    await sql`update appointment set status = 'cancelled_by_salon' where id = ${appointmentId}`

    const rows = await sql<{ from_status: string | null; to_status: string }[]>`
      select from_status, to_status from appointment_status_history
       where appointment_id = ${appointmentId} order by id
    `
    expect(rows).toEqual([
      { from_status: null, to_status: 'requested' },
      { from_status: 'requested', to_status: 'confirmed' },
      { from_status: 'confirmed', to_status: 'cancelled_by_salon' },
    ])

    // Control: a hand-written row claiming a transition from a state to itself is refused, so the
    // three rows above are the trigger's shape and not a table that accepts anything.
    const selfTransition = await stateOf(
      sql`insert into appointment_status_history (appointment_id, from_status, to_status)
          values (${appointmentId}, 'confirmed', 'confirmed')`,
    )
    expect(selfTransition.code).toBe(CHECK_VIOLATION)
    expect(selfTransition.message).toContain('appointment_status_history_is_a_change')
  })
})

describe('booking_idempotency — one request, one booking', () => {
  it('refuses a replayed key and a second key for the same booking', async () => {
    const bookingId = await newBooking()
    await sql`
      insert into booking_idempotency (idempotency_key, request_fingerprint, booking_id)
      values ('bavail01-key-1', 'sha256:aaa', ${bookingId})
    `

    const replayed = await stateOf(sql`
      insert into booking_idempotency (idempotency_key, request_fingerprint, booking_id)
      values ('bavail01-key-1', 'sha256:bbb', ${await newBooking()})
    `)
    expect(replayed.code).toBe('23505')
    expect(replayed.message).toContain('booking_idempotency_pkey')

    const secondKey = await stateOf(sql`
      insert into booking_idempotency (idempotency_key, request_fingerprint, booking_id)
      values ('bavail01-key-2', 'sha256:aaa', ${bookingId})
    `)
    expect(secondKey.code).toBe('23505')
    expect(secondKey.message).toContain('booking_idempotency_booking_id_key')

    // Control: a fresh key for a fresh booking is accepted, so the two refusals are the unique
    // constraints and not a table that has stopped accepting rows.
    await expect(sql`
      insert into booking_idempotency (idempotency_key, request_fingerprint, booking_id)
      values ('bavail01-key-3', 'sha256:ccc', ${await newBooking()})
    `).resolves.toBeDefined()
  })

  it('releases the key when the booking transaction rolls back', async () => {
    // The row is written in the booking's own transaction, which is what makes a genuine retry after
    // a failure possible rather than permanently refused.
    await stateOf(
      sql.begin(async (tx) => {
        const bookingId = await newBooking(tx as unknown as Sql)
        await tx`insert into booking_idempotency (idempotency_key, request_fingerprint, booking_id)
                 values ('bavail01-retry', 'sha256:ddd', ${bookingId})`
        throw new Error('the booking failed after claiming its key')
      }),
    )
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from booking_idempotency where idempotency_key = 'bavail01-retry'
    `
    expect(row?.n).toBe('0')

    // Control: the same statements without the failure do leave the claim behind.
    await sql.begin(async (tx) => {
      const bookingId = await newBooking(tx as unknown as Sql)
      await tx`insert into booking_idempotency (idempotency_key, request_fingerprint, booking_id)
               values ('bavail01-retry', 'sha256:ddd', ${bookingId})`
    })
    const [after] = await sql<{ n: string }[]>`
      select count(*)::text as n from booking_idempotency where idempotency_key = 'bavail01-retry'
    `
    expect(after?.n).toBe('1')
  })
})

describe('booking — the commercial container', () => {
  it('attaches the customer B-LIFE-02 created and refuses to let one be deleted from under it', async () => {
    const bookingId = await newBooking()
    const [row] = await sql<{ customer_id: string }[]>`
      select customer_id from booking where id = ${bookingId}
    `
    expect(row?.customer_id).toBe(customerId)

    const refused = await stateOf(sql`delete from customer where id = ${customerId}`)
    expect(refused.code).toBe('23503')
    expect(refused.message).toContain('booking_customer_id_fkey')

    // Control: a customer with no bookings deletes, so the refusal is the reference and not a
    // customer table that has stopped accepting deletes.
    //
    // `+971500000145` and not `+971500000143`, which is `catalogue.itest.ts`'s own `PROBE_PHONE`.
    // `customer.phone_e164` is UNIQUE (B-LIFE-02), so the two suites sharing one number is a collision
    // that hides while both clean up after themselves and surfaces the moment one of them does not — which
    // is exactly what happened when B-MSG-03's new foreign key made that file's `afterAll` truncate throw
    // before it reached its `delete from customer`. The number left behind then failed THIS insert, in a
    // file that had nothing to do with either change. Brief rule 12: one writer, one value.
    const [spare] = await sql<{ id: string }[]>`
      insert into customer (phone_e164, created_via) values ('+971500000145', 'front_desk')
      returning id
    `
    const spareId = spare?.id as string
    await expect(sql`delete from customer where id = ${spareId}`).resolves.toBeDefined()
  })

  it('refuses an appointment on a date the premises does not trade', async () => {
    // business_day is a table, not a derivation (0011). A booking on a date with no row has nothing
    // for the cash-up, the rota or the commission calculation to join to.
    const bookingId = await newBooking()
    const refused = await stateOf(sql`
      insert into appointment
        (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period,
         status, turnaround_minutes, therapist_buffer_minutes, gross_price_fils, net_fils, vat_fils)
      values (${bookingId}, '2099-12-25', ${variantId}, 'solo', ${THERAPIST_A}, ${standardRoomId},
              ${period('19', '20')}::tstzrange, 'confirmed', ${TURNAROUND_MINUTES},
              ${BUFFER_MINUTES}, 20000, 19048, 952)
    `)
    expect(refused.code).toBe('23503')
    expect(refused.message).toContain('appointment_trading_date_fkey')

    // Control: the seeded trading date is accepted.
    await expect(
      insertAppointment(sql, {
        bookingId,
        roomId: standardRoomId,
        therapistId: THERAPIST_A,
        period: period('19', '20'),
      }),
    ).resolves.toBeTruthy()
  })

  it('refuses a zero or negative snapshotted price', async () => {
    const bookingId = await newBooking()
    for (const price of [0, -1]) {
      const refused = await stateOf(sql`
        insert into appointment
          (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period,
           status, turnaround_minutes, therapist_buffer_minutes, gross_price_fils, net_fils,
           vat_fils)
        values (${bookingId}, ${TRADING_DATE}, ${variantId}, 'solo', ${THERAPIST_A},
                ${standardRoomId}, ${period('19', '20')}::tstzrange, 'confirmed',
                ${TURNAROUND_MINUTES}, ${BUFFER_MINUTES}, ${price}, greatest(${price}, 0), 0)
      `)
      expect(refused.code).toBe(CHECK_VIOLATION)
      expect(refused.message).toContain('appointment_price_positive')
    }

    // Control: one fils is accepted. Zero is a missing price, not a free treatment.
    await expect(sql`
      insert into appointment
        (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period,
         status, turnaround_minutes, therapist_buffer_minutes, gross_price_fils, net_fils, vat_fils)
      values (${bookingId}, ${TRADING_DATE}, ${variantId}, 'solo', ${THERAPIST_A},
              ${standardRoomId}, ${period('19', '20')}::tstzrange, 'confirmed',
              ${TURNAROUND_MINUTES}, ${BUFFER_MINUTES}, 1, 1, 0)
    `).resolves.toBeDefined()
  })
})
