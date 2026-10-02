import {
  type BookedAppointmentPeriod,
  type DatedHoursOverride,
  hoursOverrideStrandedAppointments,
  type Instant,
  localDate,
  localTime,
} from '@berelax/core'
import { createConnection, readStrandedAppointmentsForOverride, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * "Stranded by an hours override" is stated twice, and this is the check that holds the two equal
 * (P-HR-10).
 *
 * `hoursOverrideStrandedAppointments` in `packages/core/src/availability/hours-override.ts` is the
 * availability engine's rule. `holiday_override_stranded_appointments(...)` in migration 0123 is the
 * database's, and it exists because `packages/core` is pure and SQL cannot read TypeScript — a refusal
 * that lived only in the application is one `if` away from being skipped (ADR 0056's argument, applied to
 * a date range).
 *
 * The brief's rule is that a second statement of a fact drifts and the check that holds the two equal
 * ships in the same commit. **The direction the drift would take is the dangerous one**: a database still
 * accepting what the availability engine had started refusing, so a screen would offer a slot the hours
 * do not cover and the test asserting the refusal would be satisfied by the wrong layer with nothing
 * saying which.
 *
 * ## The corpus, and why it is shaped like this
 *
 * Four appointments on one reserved trading date, chosen so that every boundary in the rule is reachable
 * by some probe: the first treatment of the day, one in the middle, one whose ROOM period ends exactly at
 * the weekly close, and one whose room period ends one minute past it. Then eleven hour pairs, each
 * stranding a different subset — including the two that strand nothing and the one that strands all four,
 * because an agreement check over a corpus where both sides always answer "none" agrees about nothing.
 *
 * Every probe records which ids it expects, so the suite also proves that the two implementations agree
 * with the HAND-COMPUTED answer rather than merely with each other. Two identically wrong readings agree
 * perfectly.
 *
 * ## Isolation (brief rules 12 and 50)
 *
 * One trading date in 2077, measured to be unused: `grep -rn "'2077-"` over `packages`, `apps` and
 * `scripts` found nothing before this unit. Every row is removed in `afterAll`, and the suite writes no
 * `premises_hours_override` row at all — it calls the SQL function directly, which is what the refusal
 * calls, so there is nothing to insert and nothing to refuse.
 */

/** The reserved trading date. 2077-05-02 is a Sunday. */
const DATE = localDate('2077-05-02')
/** A second date inside the probes' range, to prove the range predicate rather than assume it. */
const NEXT = localDate('2077-05-03')

const PREFIX = 'PHR10 AGREE'

let sql: Sql
let bookingId = ''
let customerId = ''
let variantId = ''
/**
 * One room and one therapist PER SHAPE, and that is the schema's requirement rather than thoroughness.
 *
 * Two of the shapes overlap in time by design — `exact` and `past` both run through 01:40 — and
 * `appointment_therapist_no_overlap` is an exclusion constraint while `appointment_room_capacity` counts
 * places in a room. Both refuse an overlap on one resource, so the corpus needs five of each. The
 * fixture salon has five rooms and nineteen employees, which is where the floor of five comes from.
 */
const roomIds: string[] = []
const employeeIds: string[] = []
const booked: BookedAppointmentPeriod[] = []

const instantAt = (date: string, time: string): Date =>
  // Asia/Dubai has no daylight saving, so +04:00 is exact for every date in the build.
  new Date(`${date}T${time}:00+04:00`)

/**
 * The appointments, by hand.
 *
 * `[start, end)` local, plus the room turnaround. The weekly hours are 11:00–02:00, so:
 *
 *   * `first` 11:00–12:30 (+20) is the first treatment of the day — the only one a later OPENING strands
 *     that a middling one does not;
 *   * `middle` 15:00–16:30 (+20) is strandable from either side;
 *   * `exact` 00:10–01:40 (+20) has a room period ending at 02:00 EXACTLY, which is the inclusive
 *     boundary — an implementation with `>=` instead of `>` strands this one and is wrong;
 *   * `past` 00:15–01:45 (+20) ends at 02:05, five minutes past the weekly close, so it is stranded by
 *     the weekly hours themselves. That is not a defect in the fixture: an appointment outside the hours
 *     is exactly what a narrowing override has to be able to name, and a corpus where the weekly hours
 *     strand nothing cannot tell a working rule from one that answers "none".
 */
const SHAPES = [
  { handle: 'first', date: DATE, from: '11:00', to: '12:30', turnaround: 20, nextDay: false },
  { handle: 'middle', date: DATE, from: '15:00', to: '16:30', turnaround: 20, nextDay: false },
  { handle: 'exact', date: DATE, from: '00:10', to: '01:40', turnaround: 20, nextDay: true },
  { handle: 'past', date: DATE, from: '00:15', to: '01:45', turnaround: 20, nextDay: true },
  { handle: 'nextDate', date: NEXT, from: '15:00', to: '16:30', turnaround: 20, nextDay: false },
] as const

/**
 * The hour pairs, stated ONCE, each with the handles it must strand.
 *
 * `expected` is the hand-computed answer over `SHAPES` and the probe's own range, and it is what makes
 * this an agreement with the RULE rather than between two readings of it.
 */
const PROBES = [
  {
    why: 'the weekly hours themselves: only the room period that runs past 02:00 is outside',
    open: '11:00',
    close: '02:00',
    from: DATE,
    to: NEXT,
    dayOfWeek: null,
    expected: ['past'],
  },
  {
    why: 'a later opening strands every treatment that starts before it',
    open: '14:00',
    close: '04:00',
    from: DATE,
    to: NEXT,
    dayOfWeek: null,
    expected: ['first'],
  },
  {
    why: 'a wider window strands nothing at all — the control for a rule that always answers "some"',
    open: '08:00',
    close: '06:00',
    from: DATE,
    to: NEXT,
    dayOfWeek: null,
    expected: [],
  },
  {
    why: 'an afternoon-only window strands everything — the control for one that always answers "none"',
    open: '17:00',
    close: '20:00',
    from: DATE,
    to: NEXT,
    dayOfWeek: null,
    expected: ['first', 'middle', 'exact', 'past', 'nextDate'],
  },
  {
    why: 'closing at 01:59 strands the room period that ends exactly at 02:00',
    open: '11:00',
    close: '01:59',
    from: DATE,
    to: NEXT,
    dayOfWeek: null,
    expected: ['exact', 'past'],
  },
  {
    why: 'closing at 02:00 does NOT strand it, because a room period may end exactly at close',
    open: '11:00',
    close: '02:00',
    from: DATE,
    to: DATE,
    dayOfWeek: null,
    expected: ['past'],
  },
  {
    why: 'a range covering only the second date leaves the first one alone',
    open: '17:00',
    close: '20:00',
    from: NEXT,
    to: NEXT,
    dayOfWeek: null,
    expected: ['nextDate'],
  },
  {
    why: 'a Sunday-only override (0) reaches 2077-05-02 and not 2077-05-03',
    open: '17:00',
    close: '20:00',
    from: DATE,
    to: NEXT,
    dayOfWeek: 0,
    expected: ['first', 'middle', 'exact', 'past'],
  },
  {
    why: 'a Monday-only override (1) reaches 2077-05-03 and not 2077-05-02',
    open: '17:00',
    close: '20:00',
    from: DATE,
    to: NEXT,
    dayOfWeek: 1,
    expected: ['nextDate'],
  },
  {
    why: 'a Tuesday-only override (2) reaches neither date in the range',
    open: '17:00',
    close: '20:00',
    from: DATE,
    to: NEXT,
    dayOfWeek: 2,
    expected: [],
  },
  {
    why: 'a window that opens at 00:05 and closes at 23:00 strands the after-midnight pair, which belong to the day before',
    open: '00:05',
    close: '23:00',
    from: DATE,
    to: NEXT,
    dayOfWeek: null,
    expected: ['exact', 'past'],
  },
] as const

const idOf = (handle: string): string => {
  const index = SHAPES.findIndex((shape) => shape.handle === handle)
  const row = booked[index]
  if (row === undefined) throw new Error(`no appointment for handle ${handle}`)
  return row.appointmentId
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 4 })

  const [customer] = await sql<{ id: string }[]>`
    select id::text as id from customer order by id limit 1
  `
  const rooms = await sql<{ id: string }[]>`select id::text as id from rooms order by id`
  const [variant] = await sql<{ id: string }[]>`
    select id::text as id from service_variant order by id limit 1
  `
  const employees = await sql<{ id: string }[]>`
    select id::text as id from employee order by staff_reference limit ${SHAPES.length}
  `
  customerId = customer?.id ?? ''
  variantId = variant?.id ?? ''
  roomIds.push(...rooms.map((row) => row.id))
  employeeIds.push(...employees.map((row) => row.id))
  if (
    !customerId ||
    !variantId ||
    roomIds.length < SHAPES.length ||
    employeeIds.length < SHAPES.length
  ) {
    throw new Error(
      `the fixture salon is not seeded with ${SHAPES.length} rooms and ${SHAPES.length} employees: ` +
        'run `pnpm seed` (brief rule 24)',
    )
  }

  // The trading dates, from the weekly hours. `appointment.trading_date` is a foreign key into
  // `business_day`, so the rows cannot exist without them.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    select d::date,
           (d::date + w.open_time) at time zone 'Asia/Dubai',
           (d::date + 1 + w.close_time) at time zone 'Asia/Dubai',
           'weekly'
      from generate_series(${DATE as string}::date, ${NEXT as string}::date, interval '1 day') d
      join premises_hours w on w.day_of_week = extract(dow from d::date)::smallint
     where not w.is_closed
    on conflict (trading_date) do nothing
  `

  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}::uuid, 'walk_in', ${`${PREFIX} agreement itest`})
    returning id::text as id
  `
  bookingId = booking?.id ?? ''

  for (const [index, shape] of SHAPES.entries()) {
    // A date's session runs past midnight, so an after-midnight treatment sits on the NEXT calendar date
    // and the PREVIOUS trading date. `nextDay` is which, and it is stated per shape rather than derived
    // from the clock time — deriving it here would be a second reading of `resolveTradingDate`.
    const startDate = shape.nextDay ? nextCalendarDate(shape.date) : (shape.date as string)
    const endDate = startDate
    const startsAt = instantAt(startDate, shape.from)
    const endsAt = instantAt(endDate, shape.to)
    const [row] = await sql<{ id: string }[]>`
      insert into appointment (
        booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
        delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
        gross_price_fils, net_fils, vat_fils, vat_rate_bp
      ) values (
        ${bookingId}::uuid, ${shape.date as string}::date, ${variantId}::uuid, 'solo'::service_shape,
        ${employeeIds[index] as string}::uuid, ${roomIds[index] as string}::uuid,
        tstzrange(${startsAt}, ${endsAt}, '[)'),
        'confirmed'::appointment_status,
        gen_random_uuid(), 1, ${shape.turnaround}, 10, 100000, 95238, 4762, 500
      )
      returning id::text as id
    `
    const id = row?.id
    if (id === undefined) throw new Error(`the ${shape.handle} appointment insert returned no row`)
    booked.push({
      appointmentId: id,
      tradingDate: shape.date,
      startsAt: startsAt.getTime() as Instant,
      endsAt: endsAt.getTime() as Instant,
      turnaroundMinutes: shape.turnaround,
    })
  }
}, 60_000)

function nextCalendarDate(date: string): string {
  const stepped = new Date(`${date}T00:00:00Z`)
  stepped.setUTCDate(stepped.getUTCDate() + 1)
  return stepped.toISOString().slice(0, 10)
}

afterAll(async () => {
  if (sql === undefined) return
  for (const row of booked) {
    await sql`delete from appointment where id = ${row.appointmentId}::uuid`.catch(() => undefined)
  }
  if (bookingId) await sql`delete from booking where id = ${bookingId}::uuid`.catch(() => undefined)
  for (const date of [DATE, NEXT]) {
    await sql`delete from business_day where trading_date = ${date as string}::date`.catch(
      () => undefined,
    )
  }
  await sql.end()
}, 60_000)

const overrideFor = (probe: (typeof PROBES)[number]): DatedHoursOverride => ({
  startsOn: localDate(probe.from as string),
  endsOn: localDate(probe.to as string),
  dayOfWeek: probe.dayOfWeek,
  hours: { open: localTime(probe.open), close: localTime(probe.close) },
  reason: `${PREFIX}: ${probe.why}`,
})

describe('the two statements of "stranded by an hours override" agree', () => {
  it('agrees with each other AND with the hand-computed answer on every probe', async () => {
    const disagreements: string[] = []
    for (const probe of PROBES) {
      const expected = [...probe.expected].map(idOf).sort()
      const fromSql = (
        await readStrandedAppointmentsForOverride(sql, {
          startsOn: probe.from as string,
          endsOn: probe.to as string,
          dayOfWeek: probe.dayOfWeek,
          openTime: probe.open,
          closeTime: probe.close,
          reason: `${PREFIX}: ${probe.why}`,
        })
      )
        .map((row) => row.appointmentId)
        // The database holds every suite's appointments, so the comparison is narrowed to this file's
        // own rows. Without this an unrelated suite's booking would make every probe disagree.
        .filter((id) => booked.some((row) => row.appointmentId === id))
        .sort()
      const fromTs = hoursOverrideStrandedAppointments({
        override: overrideFor(probe),
        appointments: booked,
      })
        .map((row) => row.appointmentId)
        .sort()
      if (
        JSON.stringify(fromSql) !== JSON.stringify(fromTs) ||
        JSON.stringify(fromTs) !== JSON.stringify(expected)
      ) {
        const name = (ids: readonly string[]): string =>
          ids
            .map((id) => SHAPES[booked.findIndex((row) => row.appointmentId === id)]?.handle ?? id)
            .sort()
            .join(',')
        disagreements.push(
          `${probe.open}-${probe.close} ${probe.from}..${probe.to} dow=${probe.dayOfWeek}: ` +
            `expected [${name(expected)}], TypeScript [${name(fromTs)}], SQL [${name(fromSql)}]`,
        )
      }
    }
    expect(
      disagreements,
      'the availability engine and the database disagree about which bookings an hours override strands',
    ).toEqual([])
  }, 30_000)

  it('exercises both verdicts, so the agreement is not an agreement about nothing', async () => {
    // Non-vacuity, measured against the corpus as it is: eleven probes, two of which strand nothing and
    // one of which strands all five. A corpus that had lost its positive or its negative entries would
    // make the loop above pass over nothing, which is the shape of failure ADR 0002 is about.
    expect(PROBES.length).toBeGreaterThanOrEqual(11)
    expect(PROBES.filter((probe) => probe.expected.length === 0).length).toBeGreaterThanOrEqual(2)
    expect(PROBES.filter((probe) => probe.expected.length === SHAPES.length).length).toBe(1)
    expect(booked).toHaveLength(SHAPES.length)
  })

  it('reads the ROOM period and not the treatment, in both statements', async () => {
    // The named boundary, asserted on its own rather than only inside the loop: `exact` ends at 01:40 and
    // holds its room to 02:00, `past` ends at 01:45 and holds it to 02:05. Weekly hours of 11:00-02:00
    // strand the second and not the first — which an implementation comparing the TREATMENT would get
    // the other way round for both.
    const weekly = {
      startsOn: DATE as string,
      endsOn: DATE as string,
      dayOfWeek: null,
      openTime: '11:00',
      closeTime: '02:00',
      reason: `${PREFIX}: the weekly hours, read back through the SQL function`,
    }
    const fromSql = (await readStrandedAppointmentsForOverride(sql, weekly))
      .map((row) => row.appointmentId)
      .filter((id) => booked.some((row) => row.appointmentId === id))
    expect(fromSql).toEqual([idOf('past')])
    expect(fromSql).not.toContain(idOf('exact'))
    const fromTs = hoursOverrideStrandedAppointments({
      override: overrideFor(PROBES[5] as (typeof PROBES)[number]),
      appointments: booked,
    })
    expect(fromTs.map((row) => row.appointmentId)).toEqual([idOf('past')])
    expect(fromTs[0]?.reason).toBe('after_closing')
  }, 30_000)
})
