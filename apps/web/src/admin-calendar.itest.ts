import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  calendarAxes,
  decideAppointmentTransition,
  type Instant,
  recheckShapeAssignment,
  rescheduleTradingDate,
} from '@berelax/core'
import {
  type Actor,
  bookSlot,
  createConnection,
  readAdjacentTradingDates,
  readCalendarDay,
  readMandatoryDocumentTypes,
  rescheduleAppointmentTx,
  type SlotRecheck,
  type Sql,
} from '@berelax/db'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
} from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CALENDAR_WRITE_PATHS,
  type CalendarDeps,
  handleCalendarRead,
  handleCalendarWrite,
} from '../app/(admin)/calendar/handler.ts'

/**
 * B-UI-03 — the front-desk diary, driven two ways against one seeded day.
 *
 * Both ways are here because the unit's claims split cleanly in two and neither half can make the other's:
 *
 *  - **The handler, directly, with a frozen clock.** *"With the frozen clock at 01:30 the calendar header
 *    and query both resolve to the previous trading date"* cannot be asserted through `next start`, which
 *    has its own clock. The same split `manage-booking.itest.ts` takes, and the reason it gives.
 *  - **The built application, in a browser.** A drag is a sequence of pointer events, a card returning to
 *    its origin is a `getBoundingClientRect`, a live region is a DOM change, and axe needs a rendered DOM.
 *    None of those can be checked by reading source.
 *
 * One file rather than two, because both halves need the same seeded day and a second copy of the fixture is
 * a second day that would drift from this one. The band `admin-calendar` in `@berelax/harness/ports` is
 * this file's (brief rules 18 and 19).
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind. The
 * trading dates `2099-06-17` and `2099-06-18` are used by no other suite and no gate; every room, employee,
 * service and appointment is this file's own and carries {@link MARKER}; every assertion narrows to those
 * ids. The ROOM axis is global by design — a diary shows every bookable room — so what is asserted about it
 * is this file's rooms and never a count of all of them.
 *
 * `appointment_status_history`, `audit_event` and `outbox_event` are append-only (ADR 0008) and nothing here
 * deletes from them or counts them as totals.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'bui03 admin calendar itest'
/** 11:00–02:00, so its session ends on the 18th at 02:00. The midnight cases are about that. */
const TRADING_DATE = '2099-06-17'
const NEXT_TRADING_DATE = '2099-06-18'
const FAR_FUTURE = '2099-12-31'
const PROBE = 'bui03_probe'
const PROBE_PHONE = '+971590000603'
const ROOM_ONE = 'bui03-one'
const ROOM_TWO = 'bui03-two'

/** 20000 fils gross and the exact split `splitGross` produces. Written out, never re-derived here. */
const GROSS_FILS = 20_000
const NET_FILS = 19_048
const VAT_FILS = 952
/** Deliberately unequal: the difference between the two is one of the acceptance lines. */
const TURNAROUND_MINUTES = 20
const BUFFER_MINUTES = 10

const CALLER: Actor = { kind: 'staff', label: MARKER }
const recheck = recheckShapeAssignment satisfies SlotRecheck

const SCREENS = new URL('../../../artifacts/screens', import.meta.url).pathname

let sql: Sql
let server: WebServer
let browser: Browser
let BASE = ''
const rooms = new Map<string, string>()
const staff = new Map<string, string>()
/** The four appointments, by the name this file calls them. Ids change when one is rescheduled. */
const booked = new Map<string, string>()

let customerId: string
let variantId: string

const roomId = (code: string): string => {
  const id = rooms.get(code)
  if (id === undefined) throw new Error(`no fixture room ${code}`)
  return id
}
const staffId = (reference: string): string => {
  const id = staff.get(reference)
  if (id === undefined) throw new Error(`no fixture employee ${reference}`)
  return id
}
const appointmentOf = (name: string): string => {
  const id = booked.get(name)
  if (id === undefined) throw new Error(`no fixture appointment ${name}`)
  return id
}

/** A Dubai wall-clock instant on a calendar date, as epoch milliseconds. */
const at = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+04:00`)
const dubai = (date: string, hhmm: string): string => `${date} ${hhmm}:00+04`
const iso = (date: string, hhmm: string): string => new Date(at(date, hhmm)).toISOString()
const MINUTE = 60_000

/** The handler's deps with the clock frozen at a Dubai wall-clock instant. */
function deps(frozen: { readonly date: string; readonly hhmm: string }): CalendarDeps {
  return { sql, now: () => at(frozen.date, frozen.hhmm) as Instant }
}

/** The document a read answered, as text. Status asserted here so every caller does not repeat it. */
async function readPage(
  query: string,
  frozen: { readonly date: string; readonly hhmm: string },
): Promise<string> {
  const response = await handleCalendarRead(
    { searchParams: new URLSearchParams(query) },
    deps(frozen),
  )
  expect(response.status, query).toBe(200)
  return await response.text()
}

async function addEmployee(reference: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values (${reference}, 'female', '2099-01-01', ${MARKER})
    on conflict (staff_reference) do update set notes = excluded.notes
    returning id
  `
  const id = (row as { id: string }).id
  staff.set(reference, id)
  await sql`
    insert into employee_skill (employee_id, skill) values (${id}, 'asian_style'::therapist_skill)
    on conflict do nothing
  `
  // The mandatory set IN FORCE rather than two named types, for the reason 0058 gives: a fixture naming
  // `professional_licence` and `health_certificate` stops meaning "holds every mandatory document" the
  // moment that answer changes, and the failure is `credential_missing` in a file that mentions none.
  for (const type of await readMandatoryDocumentTypes(sql)) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${type}::employee_document_type, ${FAR_FUTURE})
      on conflict do nothing
    `
  }
  return id
}

/** One booking through `createBooking`, so every appointment this file draws was really sold. */
async function book(args: {
  readonly name: string
  readonly room: string
  readonly therapist: string
  readonly startsAt: number
  readonly minutes: number
  readonly tradingDate?: string
}): Promise<void> {
  const created = await bookSlot(
    sql,
    CALLER,
    {
      idempotencyKey: `${MARKER}:${args.name}`,
      customerId,
      source: 'front_desk',
      notes: MARKER,
      clientGender: 'female',
      deliveries: [
        {
          tradingDate: args.tradingDate ?? TRADING_DATE,
          serviceVariantId: variantId,
          shape: 'solo',
          roomId: roomId(args.room),
          therapistIds: [staffId(args.therapist)],
          treatment: {
            startsAt: args.startsAt,
            endsAt: args.startsAt + args.minutes * MINUTE,
          },
          price: {
            grossFils: GROSS_FILS,
            netFils: NET_FILS,
            vatFils: VAT_FILS,
            vatRateBp: 500,
            priceListId: null,
            promotionId: null,
          },
          status: 'confirmed',
        },
      ],
    },
    { recheck },
  )
  const id = created.deliveries[0]?.appointmentIds[0]
  if (id === undefined) throw new Error(`the fixture booking ${args.name} wrote no appointment`)
  booked.set(args.name, id)
}

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = (customer as { id: string }).id

  // The trading calendar is a TABLE (0011) and `appointment.trading_date` is a foreign key into it, so a
  // fixture cannot invent a date the premises does not trade on. Two consecutive dates, both 11:00–02:00,
  // because the midnight case is the difference between them.
  for (const [date, nextCalendarDate] of [
    [TRADING_DATE, NEXT_TRADING_DATE],
    [NEXT_TRADING_DATE, '2099-06-19'],
  ] as const) {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (${date}, ${dubai(date, '11')}::timestamptz,
              ${dubai(nextCalendarDate, '02')}::timestamptz, 'weekly')
      on conflict (trading_date) do nothing
    `
  }

  for (const code of [ROOM_ONE, ROOM_TWO]) {
    const [room] = await sql<{ id: string }[]>`
      insert into rooms (code, name, room_type, capacity, display_order, notes)
      values (${code}, ${`Probe ${code}`}, 'standard'::room_type, 1, 96, ${MARKER})
      on conflict (code) do update set capacity = excluded.capacity
      returning id
    `
    rooms.set(code, (room as { id: string }).id)
  }

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, 'bui03-probe', 'Probe massage', 'Normal Massage (Asian)',
            ${TURNAROUND_MINUTES}, 96)
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
    values ('asian', ${PROBE}, 'solo'::service_shape, 1, 1, 1, null, ${BUFFER_MINUTES})
    on conflict do nothing
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${serviceId}, 45, ${GROSS_FILS}, ${MARKER})
    on conflict (service_id, duration_minutes) do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = (variant as { id: string }).id

  await addEmployee('bui03-a')
  await addEmployee('bui03-b')

  for (const [date, nextCalendarDate] of [
    [TRADING_DATE, NEXT_TRADING_DATE],
    [NEXT_TRADING_DATE, '2099-06-19'],
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

  // Four appointments, each one there for a case: `evening` is dragged, `late-evening` is the occupied
  // target a drop is refused onto, `crossing` runs through midnight, and `afternoon` is what the
  // handler-driven writes move so the browser cases keep their own rows.
  await book({
    name: 'evening',
    room: ROOM_ONE,
    therapist: 'bui03-a',
    startsAt: at(TRADING_DATE, '19'),
    minutes: 45,
  })
  await book({
    name: 'late-evening',
    room: ROOM_ONE,
    therapist: 'bui03-b',
    startsAt: at(TRADING_DATE, '21'),
    minutes: 45,
  })
  await book({
    name: 'crossing',
    room: ROOM_TWO,
    therapist: 'bui03-a',
    startsAt: at(TRADING_DATE, '23:50'),
    minutes: 45,
  })
  await book({
    name: 'afternoon',
    room: ROOM_TWO,
    therapist: 'bui03-b',
    startsAt: at(TRADING_DATE, '16'),
    minutes: 45,
  })

  server = await startWebServer({
    suite: 'admin-calendar',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: `/calendar?date=${TRADING_DATE}`,
    readyWithinMs: 90_000,
    env: {
      // This route calls `loadConfig()`, so the two values it needs are declared rather than assumed: CI
      // exports both, and a local run that exported only TEST_DATABASE_URL would get a 503 that reads like
      // a broken route.
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url,
    },
  })
  BASE = server.origin
  // The shared list, not a hand-written one: these flags are what make the repeat capture below
  // byte-identical. See `packages/harness/src/determinism.ts`.
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
  // Cascades to `appointment` — including every successor a reschedule wrote, which is why this deletes by
  // booking rather than by the ids this file remembers.
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
  await sql?.end({ timeout: 5 })
})

describe('acceptance — the move is B-LIFE-03’s function, by reference', () => {
  it('holds the same exports the staff pair suite and the customer’s own link call', () => {
    // The acceptance line is "drag to reschedule calls the B-LIFE-03 reschedule", and this is that claim as
    // identity. A wrapper around the right function passes every behavioural test and fails this; two
    // implementations that agree today is how two implementations come to disagree quietly.
    expect(CALENDAR_WRITE_PATHS.reschedule).toBe(rescheduleAppointmentTx)
    expect(CALENDAR_WRITE_PATHS.decide).toBe(decideAppointmentTransition)
    expect(CALENDAR_WRITE_PATHS.recheck).toBe(recheckShapeAssignment)
    expect(CALENDAR_WRITE_PATHS.resolveTradingDate).toBe(rescheduleTradingDate)

    // The control on the assertion itself: a function that merely delegates is NOT the same reference, so
    // the four above can fail. Without it, `toBe` against anything truthy would look like a proof.
    const delegate: typeof rescheduleAppointmentTx = (...args) => rescheduleAppointmentTx(...args)
    expect(delegate).not.toBe(rescheduleAppointmentTx)
    // And every path this surface uses is enumerated rather than spot-checked, so a rule added to the write
    // and not to this record is visible to a reader of the expectation.
    expect(Object.keys(CALENDAR_WRITE_PATHS).sort()).toEqual([
      'decide',
      'recheck',
      'reschedule',
      'resolveTradingDate',
    ])
  })
})

describe('acceptance — “today” is the business day, not the calendar date', () => {
  it('resolves 01:30 to the PREVIOUS trading date, in the header and in the query', async () => {
    // 01:30 on the 18th is inside the 17th's 11:00–02:00 session. The header and the rows must agree,
    // which is why both are asserted from one render: a header that said the 17th over the 18th's
    // appointments would be worse than either mistake alone.
    const html = await readPage('', { date: NEXT_TRADING_DATE, hhmm: '01:30' })
    expect(html).toContain(`Business day ${TRADING_DATE}`)
    expect(html).not.toContain(`Business day ${NEXT_TRADING_DATE}`)
    expect(html).toContain('data-testid="calendar-today"')
    // The rows, not just the words: the 17th's appointments are drawn and the query resolved to the 17th.
    expect(html).toContain(`appointment-${appointmentOf('evening')}`)

    // The control, and it is the whole point of `resolveTradingDate`: twelve hours later on the SAME
    // calendar date the answer is the 18th, whose diary is empty of this fixture's evening appointment.
    const noon = await readPage('', { date: NEXT_TRADING_DATE, hhmm: '12:00' })
    expect(noon).toContain(`Business day ${NEXT_TRADING_DATE}`)
    expect(noon).not.toContain(`appointment-${appointmentOf('evening')}`)
  })

  it('shows a browsed date as a browsed date, with the way back', async () => {
    // A diary showing a date that is not today must say so, or a receptionist reads yesterday's room plan
    // as tonight's.
    const html = await readPage(`date=${TRADING_DATE}`, { date: NEXT_TRADING_DATE, hhmm: '12:00' })
    expect(html).toContain(`Business day ${TRADING_DATE}`)
    expect(html).toContain('data-testid="calendar-not-today"')
    expect(html).toContain(`/calendar?date=${NEXT_TRADING_DATE}`)
    expect(html).not.toContain('data-testid="calendar-today"')
  })

  it('names a closed date rather than drawing an empty diary for it', async () => {
    // A closure is an ABSENT `business_day` row rather than a flag, so "no rows" and "not a trading day"
    // are the same query result and must not be the same screen.
    const html = await readPage('date=2099-06-20', { date: TRADING_DATE, hhmm: '19:00' })
    expect(html).toContain('data-testid="calendar-closed"')
    expect(html).toContain('2099-06-20')
    expect(html).not.toContain('data-testid="axis-room"')
  })
})

describe('acceptance — both axes are two readings of ONE query result', () => {
  it('reads the whole day in a single statement', async () => {
    // The acceptance line says "no second fetch, no second source of truth". Counted rather than asserted
    // by reading the source: a wrapper around the tagged template counts every statement the reader issues,
    // and one is the answer.
    let statements = 0
    const counting = ((...args: Parameters<Sql>) => {
      statements += 1
      return (sql as (...inner: Parameters<Sql>) => unknown)(...args)
    }) as unknown as Sql
    const read = await readCalendarDay(counting, TRADING_DATE)
    expect(statements).toBe(1)
    expect(read).not.toBeNull()
    if (read === null) return

    // The control on the counter, so "one" is a measurement rather than a constant: the navigation read is
    // a second statement and the counter sees it.
    await readAdjacentTradingDates(counting, TRADING_DATE)
    expect(statements).toBe(2)

    // And the two axes come out of that one object, carrying its appointments BY REFERENCE.
    const axes = calendarAxes({
      tradingDate: read.tradingDate,
      opensAt: read.opensAt,
      closesAt: read.closesAt,
      rooms: read.rooms,
      therapists: read.therapists,
      appointments: read.appointments.map((row) => ({
        id: row.id,
        bookingId: row.bookingId,
        roomId: row.roomId,
        therapistIds: row.therapistIds,
        delivery: row.delivery,
        treatment: {
          startsAt: row.treatment.startsAt as Instant,
          endsAt: row.treatment.endsAt as Instant,
        },
        turnaroundMinutes: row.turnaroundMinutes,
        therapistBufferMinutes: row.therapistBufferMinutes,
        status: row.status,
        shape: row.shape,
        serviceLabel: row.serviceLabel,
      })),
    })
    const onRooms = axes.rooms.flatMap((lane) => lane.cards).map((card) => card.appointment.id)
    const onTherapists = axes.therapists
      .flatMap((lane) => lane.cards)
      .map((card) => card.appointment.id)
    for (const name of ['evening', 'late-evening', 'crossing', 'afternoon']) {
      expect(onRooms, name).toContain(appointmentOf(name))
      expect(onTherapists, name).toContain(appointmentOf(name))
    }
    // Two lanes of this file's own rooms, and the therapist axis holds both of its therapists.
    expect(axes.rooms.filter((lane) => lane.label.includes('bui03'))).toHaveLength(2)
    expect(axes.therapists.map((lane) => lane.id).sort()).toEqual([...staff.values()].sort())
  })

  it('draws the same appointments on both axes of one document', async () => {
    const html = await readPage(`date=${TRADING_DATE}`, { date: TRADING_DATE, hhmm: '19:00' })
    expect(html).toContain('data-testid="axis-room"')
    expect(html).toContain('data-testid="axis-therapist"')
    for (const name of ['evening', 'late-evening', 'crossing', 'afternoon']) {
      // Twice: once per axis. The count is the assertion — a therapist section that had lost its cards
      // would still contain the section and its heading.
      const id = appointmentOf(name)
      const occurrences = html.split(`data-testid="appointment-${id}"`).length - 1
      expect(occurrences, name).toBe(2)
    }
    // Only the room axis is a drop target: a card dropped on a therapist lane would be a therapist change,
    // which needs the client gender no table holds (B-AVAIL-05). Counted over the GRID and not the
    // document, because the stylesheet and the inline script both mention the attribute — a count over the
    // page would read six where four cards exist, and would go on passing if a card lost it.
    const grid = await readPage(`date=${TRADING_DATE}&fragment=grid`, {
      date: TRADING_DATE,
      hhmm: '19:00',
    })
    expect(grid.split('data-draggable="true"').length - 1).toBe(4)
    expect(grid.split('data-draggable="false"').length - 1).toBe(4)
  })

  it('leaves a cancelled appointment off both axes, by the same rule the constraints use', async () => {
    // `holds_resources` is GENERATED, so the grid and the exclusion constraint cannot disagree about which
    // rows hold a room. Asserted through a status change rather than by trusting the predicate.
    const id = appointmentOf('afternoon')
    const before = await readPage(`date=${TRADING_DATE}`, { date: TRADING_DATE, hhmm: '19:00' })
    expect(before).toContain(`appointment-${id}`)
    await sql`update appointment set status = 'cancelled_by_salon' where id = ${id}::uuid`
    const during = await readPage(`date=${TRADING_DATE}`, { date: TRADING_DATE, hhmm: '19:00' })
    expect(during).not.toContain(`appointment-${id}`)
    // Put it back: the later cases move this row, and a status written by an UPDATE here is not a
    // lifecycle transition — it is the shortest way to exercise the generated column and nothing else.
    await sql`update appointment set status = 'confirmed' where id = ${id}::uuid`
    const after = await readPage(`date=${TRADING_DATE}`, { date: TRADING_DATE, hhmm: '19:00' })
    expect(after).toContain(`appointment-${id}`)
  })
})

describe('acceptance — the turnaround is the room’s band, the buffer is the therapist’s', () => {
  it('draws two bands with their own test ids and different lengths', async () => {
    const html = await readPage(`date=${TRADING_DATE}`, { date: TRADING_DATE, hhmm: '19:00' })
    expect(html).toContain('data-testid="room-turnaround-band"')
    expect(html).toContain('data-testid="therapist-buffer-band"')
    // The minutes each band carries, from the configured values and not from a literal in the page: 20 for
    // the room, 10 either side for the therapist.
    expect(html).toContain('data-band="turnaround" data-axis="room"')
    const turnarounds = [
      ...html.matchAll(/data-testid="room-turnaround-band"[^>]*data-minutes="(\d+)"/g),
    ]
    const buffers = [
      ...html.matchAll(/data-testid="therapist-buffer-band"[^>]*data-minutes="(\d+)"/g),
    ]
    expect(turnarounds.map((match) => match[1])).toEqual(['20', '20', '20', '20'])
    // Two per card, because the therapist is held either side and the leading half is the one that gets
    // forgotten.
    expect(buffers).toHaveLength(8)
    expect(new Set(buffers.map((match) => match[1]))).toEqual(new Set(['10']))

    // The drawn LENGTHS differ, which is the acceptance line: the two bands are not one rule rendered
    // twice. Read out of the style attribute the server wrote, so this is the geometry and not the label.
    const lengthsOf = (testId: string): readonly string[] =>
      [...html.matchAll(new RegExp(`data-testid="${testId}"[^>]*--l:([0-9.]+)`, 'g'))].map(
        (match) => match[1] ?? '',
      )
    const [turnaroundLength] = lengthsOf('room-turnaround-band')
    const [bufferLength] = lengthsOf('therapist-buffer-band')
    expect(turnaroundLength).toBeDefined()
    expect(bufferLength).toBeDefined()
    expect(turnaroundLength).not.toBe(bufferLength)
    // And the ratio is the ratio of the configured minutes, so the difference is the rule rather than a
    // rounding artefact.
    expect(Number(turnaroundLength) / Number(bufferLength)).toBeCloseTo(
      TURNAROUND_MINUTES / BUFFER_MINUTES,
      3,
    )
  })
})

describe('acceptance — an appointment crossing midnight is one block on the day it belongs to', () => {
  it('draws it once on the 17th and not at all on the 18th', async () => {
    const id = appointmentOf('crossing')
    const seventeenth = await readPage(`date=${TRADING_DATE}`, {
      date: TRADING_DATE,
      hhmm: '19:00',
    })
    // One card per axis and one treatment band inside it: a grid whose coordinate space was the calendar
    // date would have to split this into two blocks, and the second would be drawn at the far left.
    expect(seventeenth.split(`data-testid="appointment-${id}"`).length - 1).toBe(2)
    // The card says 23:50–00:35, which is the continuity as a reader sees it.
    expect(seventeenth).toContain('23:50–00:35')

    // Absent from the FOLLOWING calendar date's diary, which is the other half of the criterion.
    const eighteenth = await readPage(`date=${NEXT_TRADING_DATE}`, {
      date: TRADING_DATE,
      hhmm: '19:00',
    })
    expect(eighteenth).toContain(`Business day ${NEXT_TRADING_DATE}`)
    expect(eighteenth).not.toContain(`appointment-${id}`)
    // The control on that absence: the 18th's diary is a real grid, not a failed read.
    expect(eighteenth).toContain('data-testid="axis-room"')
    const row = await sql<{ trading_date: string }[]>`
      select trading_date::text as trading_date from appointment where id = ${id}::uuid
    `
    expect(row[0]?.trading_date).toBe(TRADING_DATE)
  })
})

describe('acceptance — a drop the diary cannot honour is refused by name', () => {
  it('refuses a time, a room or an appointment that is not on this day’s grid', async () => {
    const cases: readonly [string, Record<string, string>][] = [
      [
        'unknown_slot',
        {
          appointmentId: appointmentOf('evening'),
          roomId: roomId(ROOM_ONE),
          // 19:07 is a real instant and not one of the day's quarter-hour targets, so the grid never
          // offered it: a caller cannot post a time the page does not draw.
          startsAt: iso(TRADING_DATE, '19:07'),
        },
      ],
      [
        'unknown_room',
        {
          appointmentId: appointmentOf('evening'),
          roomId: '00000000-0000-4000-8000-000000000999',
          startsAt: iso(TRADING_DATE, '18'),
        },
      ],
      [
        'unknown_appointment',
        {
          appointmentId: '00000000-0000-4000-8000-000000000998',
          roomId: roomId(ROOM_ONE),
          startsAt: iso(TRADING_DATE, '18'),
        },
      ],
      ['new_period_invalid', { appointmentId: appointmentOf('evening'), roomId: roomId(ROOM_ONE) }],
    ]
    for (const [refusal, body] of cases) {
      const response = await handleCalendarWrite(
        { searchParams: new URLSearchParams(`date=${TRADING_DATE}`), body, wantsJson: true },
        deps({ date: TRADING_DATE, hhmm: '19:00' }),
      )
      const answer = (await response.json()) as {
        ok: boolean
        refusal: string
        announcement: string
      }
      expect(answer.refusal, refusal).toBe(refusal)
      expect(answer.ok, refusal).toBe(false)
      // Words a receptionist can act on, and never a constraint name.
      expect(answer.announcement.length, refusal).toBeGreaterThan(10)
      expect(answer.announcement, refusal).not.toContain(refusal)
    }
  })

  it('names a lifecycle refusal rather than logging it as unknown', async () => {
    // A `completed` treatment still HOLDS its resources, so it is drawn on the grid — and it is terminal, so
    // the decider refuses every move from it. The refusal belongs to the LIFECYCLE's vocabulary rather than
    // the reschedule's, which is why the handler consults both translators: with only one, this reached the
    // reader as words that claim nothing and the log as `unknown`.
    const id = appointmentOf('crossing')
    await sql`update appointment set status = 'completed' where id = ${id}::uuid`
    try {
      const response = await handleCalendarWrite(
        {
          searchParams: new URLSearchParams(`date=${TRADING_DATE}`),
          body: { appointmentId: id, roomId: roomId(ROOM_TWO), startsAt: iso(TRADING_DATE, '22') },
          wantsJson: true,
        },
        deps({ date: TRADING_DATE, hhmm: '19:00' }),
      )
      const answer = (await response.json()) as {
        ok: boolean
        refusal: string
        announcement: string
      }
      expect(answer.ok).toBe(false)
      expect(answer.refusal).toBe('illegal_transition')
      expect(answer.announcement).toContain('cannot be moved from the state it is in')
      // And the card is on the grid without being offered as a move, so the refusal is one a reader cannot
      // reach by dragging.
      const grid = await readPage(`date=${TRADING_DATE}&fragment=grid`, {
        date: TRADING_DATE,
        hhmm: '19:00',
      })
      expect(grid).toContain(`appointment-${id}`)
      expect(grid.split('data-draggable="true"').length - 1).toBe(3)
    } finally {
      // Restored, because the browser cases below read this day. An UPDATE is not a lifecycle transition —
      // it is the shortest way to put a row in a terminal state and nothing else.
      await sql`update appointment set status = 'confirmed' where id = ${id}::uuid`
    }
  })

  it('refuses a drop onto an occupied period with slot_taken and leaves the row byte-identical', async () => {
    const moving = appointmentOf('evening')
    const before = await snapshotOf(moving)
    const response = await handleCalendarWrite(
      {
        searchParams: new URLSearchParams(`date=${TRADING_DATE}`),
        body: {
          appointmentId: moving,
          roomId: roomId(ROOM_ONE),
          // 21:00 in the same room is where `late-evening` is. One room, capacity one.
          startsAt: iso(TRADING_DATE, '21'),
        },
        wantsJson: true,
      },
      deps({ date: TRADING_DATE, hhmm: '19:00' }),
    )
    expect(response.status).toBe(409)
    const answer = (await response.json()) as { ok: boolean; refusal: string; announcement: string }
    expect(answer.ok).toBe(false)
    expect(answer.refusal).toBe('slot_taken')
    expect(answer.announcement).toContain('already taken')
    // `to_jsonb(appointment.*)::text` and not a column list, which is the point: a refused move must leave
    // `updated_at` and every other column exactly as it was, and a snapshot of the columns a test expects
    // to change cannot see the one it did not expect.
    expect(await snapshotOf(moving)).toBe(before)
    expect(await snapshotOf(appointmentOf('late-evening'))).not.toBeNull()
  })
})

/** The WHOLE row as canonical JSON text, for the byte-identical comparison. */
async function snapshotOf(id: string): Promise<string | null> {
  const [row] = await sql<{ snapshot: string }[]>`
    select to_jsonb(a.*)::text as snapshot from appointment a where a.id = ${id}::uuid
  `
  return row?.snapshot ?? null
}

/** The successor of one appointment, which is the row that still exists after a reschedule. */
async function successorOf(id: string): Promise<{ id: string; startsAt: Date; roomId: string }> {
  const [row] = await sql<{ id: string; starts_at: Date; room_id: string }[]>`
    select id::text as id, lower(period) as starts_at, room_id::text as room_id
      from appointment where rescheduled_from_id = ${id}::uuid
  `
  if (row === undefined) throw new Error(`no successor for ${id}`)
  return { id: row.id, startsAt: row.starts_at, roomId: row.room_id }
}

describe('acceptance — a move the diary can honour goes through the transaction', () => {
  it('moves it, answers the repainted grid, and supersedes the row it moved', async () => {
    const moving = appointmentOf('afternoon')
    const response = await handleCalendarWrite(
      {
        searchParams: new URLSearchParams(`date=${TRADING_DATE}`),
        body: {
          appointmentId: moving,
          roomId: roomId(ROOM_TWO),
          startsAt: iso(TRADING_DATE, '16:30'),
        },
        wantsJson: true,
      },
      deps({ date: TRADING_DATE, hhmm: '19:00' }),
    )
    expect(response.status).toBe(200)
    const answer = (await response.json()) as {
      ok: boolean
      movedId: string
      announcement: string
      grid: string
    }
    expect(answer.ok).toBe(true)
    // "Moved to 16:30 in …": the words come from where the appointment now IS, read back after the write,
    // so a reader cannot be told a time the diary does not hold.
    expect(answer.announcement).toContain('Moved to 16:30 in')
    expect(answer.announcement).toContain(ROOM_TWO)

    // The predecessor moved to `rescheduled`, which makes its GENERATED `holds_resources` false and
    // releases the room and the therapist in that one statement (B-LIFE-03).
    const [predecessor] = await sql<{ status: string; holds_resources: boolean }[]>`
      select status::text as status, holds_resources from appointment where id = ${moving}::uuid
    `
    expect(predecessor?.status).toBe('rescheduled')
    expect(predecessor?.holds_resources).toBe(false)
    const successor = await successorOf(moving)
    expect(successor.startsAt.getTime()).toBe(at(TRADING_DATE, '16:30'))
    expect(successor.id).toBe(answer.movedId)
    booked.set('afternoon', successor.id)

    // The grid the browser is handed is the grid a fresh GET would serve — the same renderer, not a second
    // opinion about the "after" state.
    expect(answer.grid).toContain(`appointment-${successor.id}`)
    expect(answer.grid).not.toContain(`appointment-${moving}"`)
    const fresh = await readPage(`date=${TRADING_DATE}&fragment=grid`, {
      date: TRADING_DATE,
      hhmm: '19:00',
    })
    expect(fresh).toBe(answer.grid)
  })

  it('works with no JavaScript at all: a form POST, a 303, and the announcement on the way back', async () => {
    const moving = appointmentOf('afternoon')
    const response = await handleCalendarWrite(
      {
        searchParams: new URLSearchParams(`date=${TRADING_DATE}`),
        body: new URLSearchParams({
          appointmentId: moving,
          roomId: roomId(ROOM_TWO),
          startsAt: iso(TRADING_DATE, '17'),
        }),
        wantsJson: false,
      },
      deps({ date: TRADING_DATE, hhmm: '19:00' }),
    )
    // A 303 rather than a rendered 200, so a reload does not re-submit the move: "it moved" shown twice is
    // a receptionist who thinks it moved twice.
    expect(response.status).toBe(303)
    const location = response.headers.get('location') ?? ''
    expect(location).toContain(`/calendar?date=${TRADING_DATE}`)
    expect(location).toContain('&moved=')
    const successor = await successorOf(moving)
    expect(location).toContain(successor.id)
    booked.set('afternoon', successor.id)

    // The redirect target renders the announcement, composed from the rows rather than from the URL.
    const html = await readPage(location.slice(location.indexOf('?') + 1), {
      date: TRADING_DATE,
      hhmm: '19:00',
    })
    expect(html).toContain('Moved to 17:00 in')
    expect(html).toContain('data-testid="calendar-live"')

    // The control: the same parameter naming an appointment this day does not hold announces nothing rather
    // than announcing a move that did not happen.
    const stale = await readPage(
      `date=${TRADING_DATE}&moved=00000000-0000-4000-8000-000000000997`,
      { date: TRADING_DATE, hhmm: '19:00' },
    )
    expect(stale).toContain('Nothing has been moved.')
  })

  it('refuses a form POST the same way and says so on the way back', async () => {
    const response = await handleCalendarWrite(
      {
        searchParams: new URLSearchParams(`date=${TRADING_DATE}`),
        body: new URLSearchParams({
          appointmentId: appointmentOf('evening'),
          roomId: roomId(ROOM_ONE),
          startsAt: iso(TRADING_DATE, '21'),
        }),
        wantsJson: false,
      },
      deps({ date: TRADING_DATE, hhmm: '19:00' }),
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('&refused=slot_taken')
    const html = await readPage(`date=${TRADING_DATE}&refused=slot_taken`, {
      date: TRADING_DATE,
      hhmm: '19:00',
    })
    expect(html).toContain('already taken')
  })
})

// --- the browser half -----------------------------------------------------------------------------

interface Cell {
  readonly width: number
  readonly height: number
  readonly theme: 'light' | 'dark'
}

/** Two viewports x two themes, which is what the acceptance line asks for: the desk and the laptop. */
const CELLS: readonly Cell[] = (['light', 'dark'] as const).flatMap((theme) =>
  [
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ].map((viewport) => ({ ...viewport, theme })),
)

const PATH = `/calendar?date=${TRADING_DATE}`

async function withCell<T>(cell: Cell, body: (page: Page) => Promise<T>): Promise<T> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: cell.width, height: cell.height },
    deviceScaleFactor: 1,
    colorScheme: cell.theme,
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
    reducedMotion: 'reduce',
  })
  try {
    // The esbuild `keepNames` shim: Playwright serialises a callback's compiled source into the page.
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
    })
    const page = await context.newPage()
    await page.goto(`${BASE}${PATH}`, { waitUntil: 'networkidle' })
    await page.addStyleTag({ content: DETERMINISM_CSS })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    return await body(page)
  } finally {
    await context.close()
  }
}

/** One desk-width page for the interaction cases, which are not about the viewport. */
async function withDesk<T>(body: (page: Page) => Promise<T>): Promise<T> {
  return await withCell({ width: 1440, height: 900, theme: 'light' }, body)
}

describe('acceptance — the built application serves the diary', () => {
  it('answers HTML with the robots header the registry declares', async () => {
    const response = await fetch(`${BASE}${PATH}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // Derived from the registry by the proxy: `/calendar` is `indexable: false`, so NOINDEX_PATTERNS covers
    // it without a prefix claiming paths nothing serves.
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response.headers.get('cache-control')).toContain('no-store')
    const html = await response.text()
    expect(html).toContain(`Business day ${TRADING_DATE}`)
    expect(html).toContain('data-testid="axis-room"')
    expect(html).toContain('data-testid="axis-therapist"')
  }, 60_000)
})

describe('acceptance — axe reports nothing serious or critical, in four renders', () => {
  it('audits 768/1440 x light/dark, and each render is the cell it claims to be', async () => {
    // Four, stated rather than counted after the fact: a matrix that lost an axis would report a pass over
    // two renders.
    expect(CELLS).toHaveLength(4)
    const luminance: Record<string, number> = {}
    for (const cell of CELLS) {
      const label = `${cell.theme} ${cell.width}px`
      const { violations, width, lum } = await withCell(cell, async (page) => {
        const result = await auditPage(page, {
          page: '/calendar',
          viewport: {
            name: `${cell.width}`,
            width: cell.width,
            height: cell.height,
            scale: 1,
            why: 'B-UI-03 acceptance',
          },
          theme: cell.theme,
          direction: 'ltr',
        })
        return {
          violations: result.violations,
          width: await page.evaluate(() => globalThis.innerWidth),
          lum: await page.evaluate(() => {
            const colour = globalThis.getComputedStyle(document.body).backgroundColor
            const [r = 0, g = 0, b = 0] = (colour.match(/\d+(\.\d+)?/g) ?? []).map(Number)
            return 0.2126 * r + 0.7152 * g + 0.0722 * b
          }),
        }
      })
      expect(width, `${label}: viewport`).toBe(cell.width)
      luminance[label] = lum
      const blocking = blockingViolations(violations)
      expect(
        blocking.map(describeViolation),
        `${label}: ${blocking.length} serious/critical violation(s)`,
      ).toEqual([])
    }
    // The theme axis is real: the dark cell resolved a darker ground at both widths. Without this, four
    // identical light renders would satisfy every assertion above.
    for (const width of [768, 1440]) {
      expect(luminance[`dark ${width}px`], `dark ${width}px is darker than light`).toBeLessThan(
        luminance[`light ${width}px`] ?? 0,
      )
    }
  }, 600_000)

  it('reports the two defects a known-bad version of this page has, by rule id', async () => {
    // The control on the audit itself. A sweep that reported zero because axe never ran would pass the case
    // above for ever (ADR 0003), so the same page is audited again with an unlabelled button and body text
    // on the decorative gold — the two failures docs/08 fences off — injected into the DOM.
    const violations = await withDesk(async (page) => {
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.type = 'button'
        document.body.append(button)
        const text = document.createElement('p')
        text.textContent = 'Move this appointment'
        const root = globalThis.getComputedStyle(document.documentElement)
        text.style.color = root.getPropertyValue('--color-decor-gold')
        text.style.backgroundColor = root.getPropertyValue('--color-surface-sand')
        document.body.append(text)
      })
      const result = await auditPage(page, {
        page: '/calendar (known-bad)',
        viewport: { name: '1440', width: 1440, height: 900, scale: 1, why: 'the control' },
        theme: 'light',
        direction: 'ltr',
      })
      return result.violations
    })
    const ids = violations.map((violation) => violation.id)
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('button-name')
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('color-contrast')
  }, 300_000)
})

describe('acceptance — the same day photographed twice is byte-identical', () => {
  it('captures 2 viewports x 2 themes twice, with zero pixel diff between the runs', async () => {
    mkdirSync(SCREENS, { recursive: true })
    const shots = new Map<string, Uint8Array>()
    for (const cell of CELLS) {
      const label = `${cell.theme}-${cell.width}`
      /*
        The claim is about the PAGE: it renders from a database and lays every card out with a percentage,
        and a document printing a relative time or an id as text could not render identically twice. Through
        `captureUntilStable` rather than comparing capture one to capture two, because that also asserts
        paint had settled by the first capture.
      */
      const stable = await captureUntilStable(
        () =>
          withCell(cell, (page) =>
            page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' }),
          ),
        { label },
      )
      expect(stable.png.byteLength, label).toBeGreaterThan(1000)
      expect(stable.attemptsUsed, `${label} settled in`).toBeLessThanOrEqual(5)
      shots.set(label, stable.png)
      writeFileSync(join(SCREENS, `admin-calendar__${label}__ltr.png`), stable.png)
    }
    expect(shots.size).toBe(4)
    // The control on the comparison: two DIFFERENT cells are not identical. Without it, a screenshot
    // function that returned the same bytes every time would pass every assertion above.
    const compare = (a: string, b: string): number =>
      Buffer.compare(
        Buffer.from(shots.get(a) ?? new Uint8Array()),
        Buffer.from(shots.get(b) ?? new Uint8Array()),
      )
    expect(compare('light-768', 'dark-768')).not.toBe(0)
    expect(compare('light-768', 'light-1440')).not.toBe(0)
  }, 600_000)
})

/** The rect of one card, as the browser laid it out. The coordinates the drag cases are asserted on. */
async function rectOf(page: Page, appointmentId: string): Promise<{ x: number; width: number }> {
  const box = await page
    .locator(`[data-axis="room"][data-testid="appointment-${appointmentId}"]`)
    .boundingBox()
  if (box === null) throw new Error(`no room-axis card for ${appointmentId}`)
  return { x: box.x, width: box.width }
}

/** The box of one quarter hour in the room lane a card is in. The drop target, as the browser laid it out. */
async function slotBoxOf(
  page: Page,
  appointmentId: string,
  label: string,
): Promise<{ x: number; width: number }> {
  const box = await page
    .locator(`[data-axis="room"] [data-slot][data-label="${label}"]`)
    .nth(await laneIndexOf(page, appointmentId))
    .boundingBox()
  if (box === null) throw new Error(`no ${label} slot in the lane holding ${appointmentId}`)
  return { x: box.x, width: box.width }
}

/** Drags a card onto the slot at `label` in its own room lane, by real pointer events. */
async function dragTo(page: Page, appointmentId: string, label: string): Promise<void> {
  const card = page.locator(`[data-axis="room"][data-testid="appointment-${appointmentId}"]`)
  const box = await card.boundingBox()
  const target = await slotBoxOf(page, appointmentId, label)
  if (box === null) throw new Error('nothing to drag')
  await page.mouse.move(box.x + 4, box.y + box.height / 2)
  await page.mouse.down()
  // Several steps, because one jump is not a drag: the pointermove handler has to be exercised.
  await page.mouse.move(target.x + target.width / 2, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
}

/** Which room lane a card is in, so the slot picked is that lane's rather than the first one on the page. */
async function laneIndexOf(page: Page, appointmentId: string): Promise<number> {
  return await page.evaluate((id) => {
    const lanes = [...document.querySelectorAll('[data-axis="room"][data-track]')]
    return lanes.findIndex((lane) => lane.querySelector(`[data-appointment="${id}"]`) !== null)
  }, appointmentId)
}

describe('acceptance — a refused drop returns the card to its origin', () => {
  it('drops onto an occupied period, is refused slot_taken, and the card is where it was', async () => {
    await withDesk(async (page) => {
      const moving = appointmentOf('evening')
      const before = await rectOf(page, moving)
      const card = page.locator(`[data-axis="room"][data-testid="appointment-${moving}"]`)
      const box = await card.boundingBox()
      const target = await slotBoxOf(page, moving, '21:00')
      if (box === null) throw new Error('no card')

      // ONE drag, measured in the middle of it. Two drags would be two drops, and the first one would have
      // been a real move — which is how this case first passed its own control and then failed on an
      // appointment that was no longer where the fixture put it.
      await page.mouse.move(box.x + 4, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + 240, box.y + box.height / 2, { steps: 6 })
      // The control on the drag itself, which is the assertion that can fail: the card really does move
      // under the pointer before it is let go, so "it came back" is not "it never went anywhere".
      const during = await rectOf(page, moving)
      expect(during.x, 'the card moved under the pointer').toBeGreaterThan(before.x + 100)

      // 21:00 in the same room is where `late-evening` is, so the server refuses. The refusal is the
      // server's: nothing in the page decided it.
      await page.mouse.move(target.x + target.width / 2, box.y + box.height / 2, { steps: 8 })
      await page.mouse.up()
      await page.waitForFunction(
        () => document.documentElement.dataset['calendarRefusal'] !== undefined,
      )
      expect(await page.evaluate(() => document.documentElement.dataset['calendarRefusal'])).toBe(
        'slot_taken',
      )
      const live = await page.locator('[data-testid="calendar-live"]').textContent()
      expect(live).toContain('already taken')

      // Final DOM coordinates, which is what the acceptance line asks for. The same element, unmoved to the
      // pixel — not a re-rendered grid that happens to look similar.
      const after = await rectOf(page, moving)
      expect(after.x).toBeCloseTo(before.x, 1)
      expect(after.width).toBeCloseTo(before.width, 1)
      expect(
        await page.evaluate(
          (id) =>
            document
              .querySelector(`[data-axis="room"][data-testid="appointment-${id}"]`)
              ?.getAttribute('style') ?? '',
          moving,
        ),
      ).not.toContain('translateX')
    })
  }, 120_000)
})

describe('acceptance — an appointment can be rescheduled by keyboard alone', () => {
  it('picks a card up, moves it a quarter hour, and announces the new time in the live region', async () => {
    const moved = await withDesk(async (page) => {
      const moving = appointmentOf('late-evening')
      const card = page.locator(`[data-axis="room"][data-testid="appointment-${moving}"]`)
      // Focus by the keyboard and nothing else: no click, no pointer event anywhere in this case.
      await card.focus()
      expect(await card.getAttribute('aria-pressed')).toBe('false')
      await page.keyboard.press('Enter')
      expect(await card.getAttribute('aria-pressed')).toBe('true')
      expect(await page.locator('[data-testid="calendar-live"]').textContent()).toContain(
        'Picked up',
      )
      await page.keyboard.press('ArrowRight')
      // The proposal is announced before it is committed, so a reader knows what Enter will do.
      expect(await page.locator('[data-testid="calendar-live"]').textContent()).toContain(
        'Proposed 21:15',
      )
      // And the control on Escape, which must put it back rather than move it.
      await page.keyboard.press('Escape')
      expect(await page.locator('[data-testid="calendar-live"]').textContent()).toContain(
        'Move cancelled',
      )
      expect(await card.getAttribute('aria-pressed')).toBe('false')

      await page.keyboard.press('Enter')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() =>
        (document.querySelector('[data-testid="calendar-live"]')?.textContent ?? '').startsWith(
          'Moved to',
        ),
      )
      const live = await page.locator('[data-testid="calendar-live"]').textContent()
      // The live region carries the NEW time, which is the acceptance line, and it changed in this document
      // rather than arriving with a reload.
      expect(live).toContain('Moved to 21:15')
      expect(await page.evaluate(() => document.documentElement.dataset['calendarMoves'])).toBe('1')
      return moving
    })

    // The server did it, and it did it through the reschedule: the predecessor is superseded and the
    // successor holds 21:15.
    const successor = await successorOf(moved)
    expect(successor.startsAt.getTime()).toBe(at(TRADING_DATE, '21:15'))
    booked.set('late-evening', successor.id)
  }, 120_000)
})

describe('acceptance — a successful drag moves it and repaints from the server', () => {
  it('drops onto a free slot, and the grid afterwards is the grid a fresh read would serve', async () => {
    const moving = appointmentOf('evening')
    const successorId = await withDesk(async (page) => {
      const before = await rectOf(page, moving)
      await dragTo(page, moving, '18:00')
      await page.waitForFunction(() => document.documentElement.dataset['calendarMoves'] === '1')
      const live = await page.locator('[data-testid="calendar-live"]').textContent()
      expect(live).toContain('Moved to 18:00')
      // The card that exists afterwards is the SUCCESSOR — a reschedule is the old row moving to
      // `rescheduled` and a new row acquiring the period — so the old test id is gone from the repainted
      // grid rather than sitting in its old slot.
      expect(
        await page.locator(`[data-axis="room"][data-testid="appointment-${moving}"]`).count(),
      ).toBe(0)
      const id = await page.evaluate(
        () =>
          document
            .querySelector('[data-axis="room"] .card[data-label^="18:00"]')
            ?.getAttribute('data-appointment') ?? '',
      )
      expect(id).not.toBe('')
      // Final DOM coordinates again, from the other side: the successor is to the LEFT of where the
      // predecessor was, because 18:00 is an hour earlier than 19:00.
      const after = await rectOf(page, id)
      expect(after.x).toBeLessThan(before.x)
      expect(after.width).toBeCloseTo(before.width, 1)
      return id
    })

    const successor = await successorOf(moving)
    expect(successor.id).toBe(successorId)
    expect(successor.startsAt.getTime()).toBe(at(TRADING_DATE, '18:00'))
    expect(successor.roomId).toBe(roomId(ROOM_ONE))
    booked.set('evening', successor.id)

    // And the reload agrees with the repaint, which is what "repainted from the server" has to mean.
    const reloaded = await withDesk(
      async (page) =>
        await page.evaluate(
          (id) =>
            document.querySelector(`[data-axis="room"][data-testid="appointment-${id}"]`) !== null,
          successorId,
        ),
    )
    expect(reloaded).toBe(true)
  }, 120_000)
})
