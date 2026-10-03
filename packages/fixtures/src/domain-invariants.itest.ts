import {
  DOMAIN_INVARIANT_RULES,
  type DomainBreach,
  type DomainInvariantCensus,
  domainInvariantProblems,
} from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { censusDomainInvariants } from './domain-invariants.ts'

/**
 * The domain invariant census shown to be able to FAIL, one planted breach per claim. B-M1.
 *
 * This is the acceptance line *"a deliberately broken fixture (an appointment inserted past close) is
 * proven to fail the invariant job, so the gate itself is shown to fire"* — generalised, because a
 * census that could only be seen to fire on one of its four claims is three claims nobody has watched.
 *
 * ## Why the database's own guards are DROPPED inside a transaction
 *
 * Two of the four breaches cannot be inserted at all: `appointment_therapist_no_overlap` is an
 * exclusion constraint and `assert_room_capacity` is a trigger raising ZB001. That is correct, and it
 * is exactly why a census that merely restated them would be worth nothing — the rows this check
 * exists to find are the ones written while a guard was absent: before it existed, with it deferred,
 * or imported from the previous arrangement (`appointment.migrated`). So each case drops the guard,
 * plants the row, runs the census **inside the same transaction**, and rolls the whole thing back.
 * DDL is transactional in PostgreSQL, so the constraint is back before the next case runs and nothing
 * is left behind.
 *
 * `censusDomainInvariants` takes a `Sql` for that reason: handed the transaction, it sees the planted
 * row; handed the pool, it would not.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind
 * (brief rule 12). So no case here asserts that the census is CLEAN — another suite's rows are in it
 * and that is the census's whole point. Every assertion is that the breach THIS file planted appears,
 * by the id it minted, under the rule it should be reported under; and the control for each is the
 * same census over the same transaction before the planting, which must not mention that id.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (url === '') {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const MARKER = 'bm1 domain invariant census'
const PROBE_PHONE = '+971500000741'

let sql: Sql
let bookingId = ''
let customerId = ''
let variantId = ''
let therapists: string[] = []
let rooms: { id: string; code: string; capacity: number }[] = []
/** A trading date inside the seeded calendar, with its own window. */
let day = { tradingDate: '', opensAt: '', closesAt: '' }

/** `[start, end)` as a tstzrange literal, from two ISO instants. */
const range = (startIso: string, endIso: string): string => `[${startIso},${endIso})`

const plusMinutes = (iso: string, minutes: number): string =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString()

interface Planted {
  readonly tradingDate: string
  readonly startsAt: string
  readonly endsAt: string
  readonly therapist: string
  readonly room: string
  readonly turnaroundMinutes?: number
}

/** One appointment, inserted on whatever handle it is given. Returns the id. */
async function insertAppointment(handle: Sql, planted: Planted): Promise<string> {
  const [row] = await handle<{ id: string }[]>`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
       gross_price_fils, net_fils, vat_fils)
    values (${bookingId}, ${planted.tradingDate}, ${variantId}, 'solo', ${planted.therapist},
            ${planted.room}, ${range(planted.startsAt, planted.endsAt)}::tstzrange, 'confirmed',
            uuid_generate_v7(), 1, ${planted.turnaroundMinutes ?? 20}, 10,
            21000, 20000, 1000)
    returning id::text as id
  `
  return (row as { id: string }).id
}

/** Every breach of every kind the census found, flattened. */
const allBreaches = (census: DomainInvariantCensus): readonly DomainBreach[] => [
  ...census.therapistOverlaps,
  ...census.roomsOverCapacity,
  ...census.pastClose,
  ...census.wrongBusinessDay,
  ...census.daysNotTrading,
]

const mentioning = (census: DomainInvariantCensus, id: string): readonly DomainBreach[] =>
  allBreaches(census).filter((breach) => breach.detail.includes(id))

/**
 * Runs `body` inside a transaction and rolls it back, whatever it returns.
 *
 * Every case plants a row the database would normally refuse, so nothing here may commit. The throw is
 * how `postgres.js` is told to roll back, and the sentinel is re-thrown by nothing: a real failure
 * inside the body surfaces as itself.
 */
async function inRolledBackTransaction<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  const ROLLBACK = Symbol('rollback')
  let result: T | undefined
  try {
    await sql.begin(async (tx) => {
      result = await body(tx as unknown as Sql)
      throw ROLLBACK
    })
  } catch (error) {
    if (error !== ROLLBACK) throw error
  }
  return result as T
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'front_desk')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id::text as id
  `
  customerId = (customer as { id: string }).id
  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes) values (${customerId}, 'front_desk', ${MARKER})
    returning id::text as id
  `
  bookingId = (booking as { id: string }).id

  const [variant] = await sql<{ id: string }[]>`
    select sv.id::text as id from service_variant sv
      join service s on s.id = sv.service_id
     where s.published_at is not null and s.archived_at is null
     order by sv.duration_minutes limit 1
  `
  variantId = (variant as { id: string }).id

  therapists = (
    await sql<
      { id: string }[]
    >`select id::text as id from employee order by staff_reference limit 4`
  ).map((row) => row.id)

  rooms = await sql<{ id: string; code: string; capacity: number }[]>`
    select id::text as id, code, capacity from rooms where is_bookable order by code
  `

  // A trading date well inside the seeded calendar and in the future, so nothing here collides with a
  // suite that books "tomorrow". The window comes from `business_day` rather than from a literal,
  // because the close is what three of the four claims are measured against.
  const [row] = await sql<{ trading_date: string; opens_at: string; closes_at: string }[]>`
    select trading_date::text as trading_date,
           to_char(opens_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as opens_at,
           to_char(closes_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as closes_at
      from business_day
     where trading_date > current_date + 3
     order by trading_date limit 1
  `
  const found = row as { trading_date: string; opens_at: string; closes_at: string }
  day = { tradingDate: found.trading_date, opensAt: found.opens_at, closesAt: found.closes_at }
}, 60_000)

afterAll(async () => {
  // Only rows this file created. Every planted appointment was rolled back, so the booking and the
  // customer are all that is left — and the appointments are deleted first in case a case failed
  // between an insert and its rollback.
  if (sql !== undefined) {
    await sql`delete from appointment where booking_id = ${bookingId}`
    await sql`delete from booking where id = ${bookingId}`
    await sql.end({ timeout: 5 })
  }
})

describe('the census counts what it examined, which is what makes an empty answer visible', () => {
  it('reports the appointment, room and trading-date populations and the after-midnight subset', async () => {
    const census = await censusDomainInvariants(sql)
    expect(census.roomsExamined).toBeGreaterThan(0)
    expect(census.tradingDatesExamined).toBeGreaterThan(0)
    // Not asserted as a positive: the appointment population depends on which suites have run before
    // this one, and a file that required rows another file wrote would be the brief's rule 12 defect.
    expect(census.appointmentsExamined).toBeGreaterThanOrEqual(0)
    expect(census.afterMidnightExamined).toBeLessThanOrEqual(census.appointmentsExamined)
  }, 30_000)

  it('refuses a census that examined no appointment, over a figure rather than over a query', () => {
    // The pure floor, stated here as well as in the unit test because this is the file that would
    // otherwise pass four claims over an empty estate and report success.
    const empty: DomainInvariantCensus = {
      appointmentsExamined: 0,
      roomsExamined: 5,
      tradingDatesExamined: 149,
      afterMidnightExamined: 0,
      therapistOverlaps: [],
      roomsOverCapacity: [],
      pastClose: [],
      wrongBusinessDay: [],
      daysNotTrading: [],
    }
    expect(domainInvariantProblems(empty).map((problem) => problem.rule)).toEqual([
      DOMAIN_INVARIANT_RULES.examinedNothing,
    ])
  })
})

describe('each of the four claims is watched failing on a planted row', () => {
  it('1. finds a double-booked therapist the exclusion constraint would have refused', async () => {
    const { before, after, firstId, secondId } = await inRolledBackTransaction(async (tx) => {
      // The guard is dropped FIRST, before any insert: `ALTER TABLE` is refused in a transaction that
      // already has pending deferred trigger events, and every insert into this table leaves some.
      await tx`alter table appointment drop constraint appointment_therapist_no_overlap`
      const start = plusMinutes(day.opensAt, 60)
      const firstId = await insertAppointment(tx, {
        tradingDate: day.tradingDate,
        startsAt: start,
        endsAt: plusMinutes(start, 60),
        therapist: therapists[0] ?? '',
        room: rooms[0]?.id ?? '',
      })
      // The control: one appointment on its own, with the constraint already gone, is not an overlap.
      const before = await censusDomainInvariants(tx)
      // And this is the row the census exists for: one written while the constraint was absent. DDL is
      // transactional, so the constraint is back when this rolls back.
      const secondId = await insertAppointment(tx, {
        tradingDate: day.tradingDate,
        startsAt: plusMinutes(start, 30),
        endsAt: plusMinutes(start, 90),
        therapist: therapists[0] ?? '',
        room: rooms[1]?.id ?? '',
      })
      const after = await censusDomainInvariants(tx)
      return { before, after, firstId, secondId }
    })
    // The control: one appointment on its own is not an overlap, and the census says so.
    expect(mentioning(before, firstId)).toEqual([])
    const found = mentioning(after, secondId)
    expect(found.map((breach) => breach.rule)).toContain(
      DOMAIN_INVARIANT_RULES.doubleBookedTherapist,
    )
    expect(found[0]?.detail).toContain(firstId)
  }, 60_000)

  it('2. finds a room over capacity through the function the trigger itself calls', async () => {
    const capacityOne = rooms.find((room) => room.capacity === 1)
    expect(capacityOne, 'the seed holds a capacity-1 room').toBeDefined()
    const { before, after, secondId } = await inRolledBackTransaction(async (tx) => {
      // Disabled FIRST, for the reason above: an insert leaves pending deferred trigger events and
      // `ALTER TABLE` is then refused. `disable trigger user` rather than `all`, because disabling the
      // internal ones would also drop the foreign keys these inserts still have to satisfy.
      await tx`alter table appointment disable trigger user`
      const start = plusMinutes(day.opensAt, 180)
      await insertAppointment(tx, {
        tradingDate: day.tradingDate,
        startsAt: start,
        endsAt: plusMinutes(start, 60),
        therapist: therapists[0] ?? '',
        room: capacityOne?.id ?? '',
      })
      // The control: one appointment in a capacity-1 room is not over capacity.
      const before = await censusDomainInvariants(tx)
      const secondId = await insertAppointment(tx, {
        tradingDate: day.tradingDate,
        startsAt: plusMinutes(start, 15),
        endsAt: plusMinutes(start, 75),
        // A DIFFERENT therapist, so the breach under test is the room's capacity and not the exclusion
        // constraint arriving first and answering a test about one rule with another.
        therapist: therapists[1] ?? '',
        room: capacityOne?.id ?? '',
      })
      const after = await censusDomainInvariants(tx)
      return { before, after, secondId }
    })
    expect(
      before.roomsOverCapacity.filter((breach) => breach.detail.includes(capacityOne?.code ?? '')),
    ).toEqual([])
    const found = after.roomsOverCapacity.filter((breach) => breach.detail.includes(secondId))
    expect(found.map((breach) => breach.rule)).toEqual([DOMAIN_INVARIANT_RULES.roomOverCapacity])
    expect(found[0]?.detail).toContain(capacityOne?.code ?? '')
  }, 60_000)

  it('3. finds an appointment past close, and one that fits only until turnaround is counted', async () => {
    // The acceptance line's own fixture, and the half that makes it the right fixture: the second
    // appointment's TREATMENT ends exactly at close and is correct; it breaks the claim only because
    // the room is held for its turnaround afterwards. A check that compared the treatment's end alone
    // would pass it, which is what "once turnaround is counted" is there to prevent.
    const { pastClose, turnaroundOnly, cleanId } = await inRolledBackTransaction(async (tx) => {
      const pastCloseId = await insertAppointment(tx, {
        tradingDate: day.tradingDate,
        startsAt: plusMinutes(day.closesAt, -30),
        endsAt: plusMinutes(day.closesAt, 30),
        therapist: therapists[0] ?? '',
        room: rooms[0]?.id ?? '',
        turnaroundMinutes: 0,
      })
      const turnaroundOnlyId = await insertAppointment(tx, {
        tradingDate: day.tradingDate,
        startsAt: plusMinutes(day.closesAt, -60),
        endsAt: day.closesAt,
        therapist: therapists[1] ?? '',
        room: rooms[1]?.id ?? '',
        turnaroundMinutes: 20,
      })
      // The control: the same shape with no turnaround ends exactly at close and is CORRECT — the
      // close is inclusive on the closing side (hours-override.ts), so an exclusive comparison here
      // would strand the last booking of every day.
      const cleanId = await insertAppointment(tx, {
        tradingDate: day.tradingDate,
        startsAt: plusMinutes(day.closesAt, -60),
        endsAt: day.closesAt,
        therapist: therapists[2] ?? '',
        room: rooms[2]?.id ?? '',
        turnaroundMinutes: 0,
      })
      const census = await censusDomainInvariants(tx)
      return {
        pastClose: mentioning(census, pastCloseId),
        turnaroundOnly: mentioning(census, turnaroundOnlyId),
        cleanId: mentioning(census, cleanId),
      }
    })
    expect(pastClose.map((breach) => breach.rule)).toContain(DOMAIN_INVARIANT_RULES.pastClose)
    expect(turnaroundOnly.map((breach) => breach.rule)).toEqual([DOMAIN_INVARIANT_RULES.pastClose])
    expect(turnaroundOnly[0]?.detail).toContain('holds its room for 20 more minute(s)')
    expect(cleanId).toEqual([])
  }, 60_000)

  it('4. finds an after-midnight appointment filed on the wrong business day', async () => {
    // Trading runs 11:00-02:00, so a start at 01:30 belongs to the PREVIOUS trading date. The planted
    // row is the calendar-truncation mistake: a 01:30 start filed on the calendar date it falls on.
    const { wrong, right } = await inRolledBackTransaction(async (tx) => {
      // 01:30 Asia/Dubai on the morning AFTER this trading date, which is 21:30 UTC on the date itself
      // — inside the window of `day` and outside the window of the next one.
      const afterMidnight = plusMinutes(day.closesAt, -30)
      const nextDay = await tx<{ trading_date: string }[]>`
        select trading_date::text as trading_date from business_day
         where trading_date > ${day.tradingDate} order by trading_date limit 1
      `
      const wrongId = await insertAppointment(tx, {
        tradingDate: (nextDay[0] as { trading_date: string }).trading_date,
        startsAt: afterMidnight,
        endsAt: plusMinutes(afterMidnight, 15),
        therapist: therapists[0] ?? '',
        room: rooms[0]?.id ?? '',
        turnaroundMinutes: 0,
      })
      // The control: the same instant, filed on the trading date it actually belongs to.
      const rightId = await insertAppointment(tx, {
        tradingDate: day.tradingDate,
        startsAt: afterMidnight,
        endsAt: plusMinutes(afterMidnight, 15),
        therapist: therapists[1] ?? '',
        room: rooms[1]?.id ?? '',
        turnaroundMinutes: 0,
      })
      const census = await censusDomainInvariants(tx)
      return { wrong: mentioning(census, wrongId), right: mentioning(census, rightId) }
    })
    expect(wrong.map((breach) => breach.rule)).toContain(DOMAIN_INVARIANT_RULES.wrongBusinessDay)
    expect(wrong[0]?.detail).toContain('filed on the wrong business day')
    expect(right).toEqual([])
  }, 60_000)

  it('finds an appointment whose trading date business_day does not hold at all', async () => {
    // The one way a row could pass every window comparison by being invisible to it: the join to
    // `business_day` drops it silently. Unreachable through the foreign key, which is why the key is
    // dropped here — and checked anyway, because an import is the one writer that has ever had a
    // foreign key dropped for it.
    const { found, examined } = await inRolledBackTransaction(async (tx) => {
      await tx`alter table appointment drop constraint appointment_trading_date_fkey`
      const start = '2097-04-18T08:00:00.000Z'
      const id = await insertAppointment(tx, {
        tradingDate: '2097-04-18',
        startsAt: start,
        endsAt: plusMinutes(start, 60),
        therapist: therapists[0] ?? '',
        room: rooms[0]?.id ?? '',
      })
      const census = await censusDomainInvariants(tx)
      return { found: mentioning(census, id), examined: census.appointmentsExamined }
    })
    expect(examined).toBeGreaterThan(0)
    expect(found.map((breach) => breach.rule)).toEqual([DOMAIN_INVARIANT_RULES.dayNotTrading])
  }, 60_000)
})
