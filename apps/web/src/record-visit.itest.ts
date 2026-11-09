import { createConnection, readMandatoryDocumentTypes, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  handleRecordVisitRead,
  handleRecordVisitWrite,
} from '../app/(admin)/record-visit/handler.ts'
import { RECORD_VISIT_FIELDS } from '../app/(admin)/record-visit/view.ts'

/**
 * `/record-visit` against real PostgreSQL, with the clock frozen.
 *
 * The handler is driven DIRECTLY rather than through a browser, and that is the whole reason it is split
 * from its route. Every claim below is about rows — a history row per lifecycle step, an outbox event per
 * step, a marker in each one saying the entry was made after the fact — and none of them can be made by
 * reading source or by looking at a rendered page. The keyboard walk, the focus ring and axe belong to the
 * browser suite; they are not here and must not be, because this file's job is the half a document cannot
 * show.
 *
 * ## Why the clock is injected and not stubbed globally
 *
 * The horizon is measured from `now`, and the trading calendar is a TABLE: `appointment.trading_date` is a
 * foreign key into `business_day`, so a fixture cannot invent a date the premises does not trade on. The
 * seeded calendar ends at a date in the past, so a test using the real clock would be outside the horizon
 * on the day it was written and inside it never again. `deps.now` is therefore set to the morning after
 * the last seeded trading day, which makes every assertion below a statement about a FIXED relationship
 * between the clock and the visit rather than about the date somebody ran the suite.
 *
 * ## What this file seeds, and what it borrows
 *
 * It borrows the catalogue, the rooms and the trading calendar from `pnpm seed`, because this is a test of
 * the handler and not of the catalogue. It seeds two things of its own, both of which the seed does not
 * provide: a therapist with a GENDER (the seeded roster has none, and `booking.same_gender_matching` is
 * `strict`, so nobody seeded is eligible for anybody) and a SHIFT (the seed publishes no rota, so
 * `readEligibleTherapists` correctly finds nobody rostered on any date).
 *
 * That second fact is worth stating rather than working around: with no published rota, this screen offers
 * an empty therapist list and says so — and `/quick-book` cannot book either, through the same read model.
 * It is a property of the system, not of this test.
 */

const url = process.env['DATABASE_URL']
if (url === undefined) {
  throw new Error('record-visit.itest.ts needs DATABASE_URL: it asserts rows, not markup.')
}

/** Every row this file writes carries it, so `afterAll` can find them without a date range. */
const MARKER = 'record-visit-itest'
const PROBE_PHONE = '+971500000777'
const PROBE_REFERENCE = 'recvisit-probe'
const FAR_FUTURE = '2099-01-01'

let sql: Sql
let tradingDate: string
let therapistId: string
let strangerId: string
let roomId: string
let variantId: string
/** 12:00 Dubai on the day after `tradingDate`: the visit is yesterday's, well inside a 14-day horizon. */
let frozenNow: number

const chrome = {
  googleReauth: null,
  sendBacklog: null,
  returnTo: '/record-visit',
  role: 'manager' as const,
  staffReference: 'EMP-TEST',
}

interface EntryFields {
  readonly step: 'check' | 'record'
  readonly outcome?: 'completed' | 'no_show'
  readonly date?: string
  readonly time?: string
  readonly therapist?: string
  readonly room?: string
  readonly phone?: string
}

/*
 * Each case that WRITES names its own time, two hours clear of every other.
 *
 * Not tidiness: 0024's exclusion is on `(therapist_id, period)` and the period carries the turnaround and
 * the therapist buffer, so two 60-minute treatments an hour apart for one therapist overlap and the second
 * is refused. One roster is shared by the whole file, so the slots are allocated here where they can be
 * read as a set rather than per case where the next one added would collide.
 */
const SLOT = {
  walk: '14:00',
  role: '16:00',
  markers: '18:00',
  revenue: '20:00',
  noShow: '22:00',
  overlapFirst: '11:30',
  overlapSecond: '12:00',
} as const

/** One POST, as the form sends it. Defaults are the happy path, so a case names only what it changes. */
function body(fields: EntryFields): URLSearchParams {
  const f = RECORD_VISIT_FIELDS
  const form = new URLSearchParams()
  form.set(f.step, fields.step)
  form.set(f.phone, fields.phone ?? PROBE_PHONE)
  form.set(f.variant, variantId)
  form.set(f.gender, 'female')
  form.set(f.date, fields.date ?? tradingDate)
  form.set(f.time, fields.time ?? '19:00')
  form.set(f.outcome, fields.outcome ?? 'completed')
  form.set(f.reason, 'The desk was busy and it was never typed in.')
  form.set(f.notes, MARKER)
  if (fields.therapist !== undefined) form.set(f.therapist, fields.therapist)
  if (fields.room !== undefined) form.set(f.room, fields.room)
  return form
}

async function post(fields: EntryFields): Promise<{ status: number; html: string }> {
  const response = await handleRecordVisitWrite(
    { searchParams: new URLSearchParams(), chrome, body: body(fields), requestId: null },
    { sql, now: () => frozenNow },
  )
  return { status: response.status, html: await response.text() }
}

/** The refusal the document names, or `null` when the screen refused nothing. */
const refusalOf = (html: string): string | null =>
  html.match(/data-record-visit-refusal="([a-z_]+)"/)?.[1] ?? null

const bookingIdOf = (html: string): string | null =>
  html.match(/data-booking="([0-9a-f-]+)"/)?.[1] ?? null

async function addTherapist(reference: string, gender: 'female' | 'male'): Promise<string> {
  // Upserted, not inserted: a run that failed part-way leaves the roster behind, and a fixture that
  // cannot be re-run turns one red test into a suite that never starts again.
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values (${reference}, ${gender}, '2020-01-01', ${MARKER})
    on conflict (staff_reference) do update set gender = excluded.gender, notes = excluded.notes
    returning id::text as id
  `
  const id = (row as { id: string }).id
  await sql`
    insert into employee_skill (employee_id, skill) values (${id}, 'asian_style'::therapist_skill)
    on conflict do nothing
  `
  // Read from `regulatory_profile_current` rather than naming two types: a fixture that names them stops
  // meaning "holds every mandatory document" the moment that answer changes (0058), and the failure shows
  // up as `credential_missing` in a file that mentions no credentials.
  for (const type of await readMandatoryDocumentTypes(sql)) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${type}::employee_document_type, ${FAR_FUTURE})
      on conflict do nothing
    `
  }
  return id
}

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })

  const [day] = await sql<{ trading_date: string }[]>`
    select trading_date::text as trading_date from business_day order by trading_date desc limit 1
  `
  tradingDate = (day as { trading_date: string }).trading_date
  frozenNow = Date.parse(`${tradingDate}T12:00:00+04:00`) + 24 * 60 * 60 * 1000

  const [variant] = await sql<{ id: string }[]>`
    select v.id::text as id from service_variant v join service s on s.id = v.service_id
     where s.style = 'asian' and v.duration_minutes = 60 limit 1
  `
  variantId = (variant as { id: string }).id

  const [room] = await sql<{ id: string }[]>`
    select id::text as id from rooms
     where is_bookable and room_type = 'standard' order by display_order, code limit 1
  `
  roomId = (room as { id: string }).id

  therapistId = await addTherapist(PROBE_REFERENCE, 'female')
  // The second therapist is NEVER given a shift. She is the known-bad fixture for "somebody who was not
  // working" — without her, the refusal below could pass against a uuid that names nobody, which is a
  // different refusal wearing the same name (ADR 0003).
  strangerId = await addTherapist(`${PROBE_REFERENCE}-stranger`, 'female')

  // 11:00 to 02:00 the next day, in Asia/Dubai: the window the whole system is built around, and wide
  // enough that a 19:00 treatment is inside it rather than at its edge.
  const [shift] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (${tradingDate},
            ${`[${tradingDate} 11:00:00+04,${tradingDate} 23:59:00+04)`}::tstzrange, ${MARKER})
    returning id::text as id
  `
  await sql`
    insert into shift_assignment (shift_id, employee_id)
    values (${(shift as { id: string }).id}, ${therapistId})
  `
})

afterAll(async () => {
  // Cascades to `appointment` and to `booking_idempotency`, which is what releases this file's keys.
  // `appointment_status_history`, `audit_event` and `outbox_event` are append-only and are left alone.
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from period_lock where reason = ${MARKER}`
  await sql`delete from shift_assignment where employee_id in (${therapistId}, ${strangerId})`
  await sql`delete from shift where label = ${MARKER}`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await sql.end({ timeout: 5 })
})

describe('the GET', () => {
  it('serves the form with the horizon the setting holds', async () => {
    const response = await handleRecordVisitRead(
      { searchParams: new URLSearchParams(), chrome, body: null, requestId: null },
      { sql, now: () => frozenNow },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const html = await response.text()
    // 14 from `booking.backdated_visit_horizon_days`, which `pnpm seed` writes from the registry's
    // default. The figure is READ, not assumed: a hard-coded 14 here would pass against a screen that
    // never consulted the setting at all.
    const [row] = await sql<{ value: string }[]>`
      select value::text as value from app_setting where key = 'booking.backdated_visit_horizon_days'
    `
    expect(html).toContain(`Up to ${(row as { value: string }).value} days back`)
  })
})

describe('step=check', () => {
  it('resolves the trading date and the price, and offers the therapist who was on shift', async () => {
    const { status, html } = await post({ step: 'check' })
    expect(status).toBe(200)
    expect(refusalOf(html)).toBeNull()
    expect(html).toContain(`data-trading-date="${tradingDate}"`)
    expect(html).toContain('19:00')
    // The therapist is offered BY ID, which is what the confirm posts back. The reference is what the
    // desk reads; asserting the id is what proves the select is wired to the row rather than to a label.
    expect(html).toContain(therapistId)
    expect(html).toContain(PROBE_REFERENCE)
    // And the price came from the catalogue rather than from nowhere.
    expect(html).toMatch(/AED\s[\d,]+\.\d\d/)
  })

  it('does not offer a therapist who was not rostered that day', async () => {
    const { html } = await post({ step: 'check' })
    // The stranger has the skill, the gender and the credentials, and no shift. A list that included her
    // would send the desk to a refusal they could not have predicted.
    expect(html).not.toContain(strangerId)
  })

  it('writes nothing', async () => {
    await post({ step: 'check' })
    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from booking where notes = ${MARKER}
    `
    expect((count as { n: string }).n).toBe('0')
  })
})

describe('step=record — a completed visit', () => {
  it('walks the lifecycle rather than inserting at the final status', async () => {
    const { status, html } = await post({
      step: 'record',
      time: SLOT.walk,
      therapist: therapistId,
      room: roomId,
    })
    expect(status).toBe(200)
    expect(refusalOf(html)).toBeNull()
    const bookingId = bookingIdOf(html)
    expect(bookingId).not.toBeNull()

    const [appointment] = await sql<{ id: string; status: string; trading_date: string }[]>`
      select id::text as id, status::text as status, trading_date::text as trading_date
        from appointment where booking_id = ${bookingId as string}
    `
    expect(appointment).toBeDefined()
    const appointmentId = (appointment as { id: string }).id
    expect((appointment as { status: string }).status).toBe('completed')
    expect((appointment as { trading_date: string }).trading_date).toBe(tradingDate)

    // The history is the claim. An appointment that arrived at `completed` with no rows behind it is a
    // row no audit can account for, in the one table whose history IS the audit trail.
    const history = await sql<{ from_status: string | null; to_status: string }[]>`
      select from_status::text as from_status, to_status::text as to_status
        from appointment_status_history where appointment_id = ${appointmentId}
       order by occurred_at, id
    `
    /*
     * FOUR rows, not three, and the first one is `createBooking`'s.
     *
     * The insert writes its own `null → confirmed` row, so the history reads as the appointment coming
     * into existence and then being walked — which is more than this unit promised and exactly what it
     * wanted: there is no step in the chain, the insert included, that the trail does not account for.
     */
    expect(history.map((row) => [row.from_status, row.to_status])).toEqual([
      [null, 'confirmed'],
      ['confirmed', 'checked_in'],
      ['checked_in', 'in_progress'],
      ['in_progress', 'completed'],
    ])
  })

  it('records the reader’s own role on every step, not the surface’s', async () => {
    const { html } = await post({
      step: 'record',
      time: SLOT.role,
      therapist: therapistId,
      room: roomId,
    })
    expect(refusalOf(html)).toBeNull()
    const [appointment] = await sql<{ id: string }[]>`
      select id::text as id from appointment where booking_id = ${bookingIdOf(html) as string}
    `
    /*
     * The WALKED rows only. `createBooking`'s own `null → confirmed` row carries no role, because the
     * insert is not a transition anybody made — `from_status is not null` is what separates the two, and
     * asserting over all four would make this test fail for the one row it is not about.
     */
    const rows = await sql<{ actor_role: string; actor_label: string }[]>`
      select actor_role, actor_label from appointment_status_history
       where appointment_id = ${(appointment as { id: string }).id} and from_status is not null
    `
    expect(rows.length).toBe(3)
    for (const row of rows) {
      // `manager`, from the session — the role `decideAppointmentTransition` consulted. The LABEL is the
      // surface, because the one thing an audit label must not do is name a person it cannot prove.
      expect(row.actor_role).toBe('manager')
      expect(row.actor_label).toContain('Record a missed visit')
    }
  })

  it('marks every step as entered after the fact, not only the completion', async () => {
    const { html } = await post({
      step: 'record',
      time: SLOT.markers,
      therapist: therapistId,
      room: roomId,
    })
    expect(refusalOf(html)).toBeNull()
    const [appointment] = await sql<{ id: string }[]>`
      select id::text as id from appointment where booking_id = ${bookingIdOf(html) as string}
    `
    const appointmentId = (appointment as { id: string }).id
    const events = await sql<{ event_type: string; payload: Record<string, unknown> }[]>`
      select event_type, payload from outbox_event
       where aggregate_type = 'appointment' and aggregate_id = ${appointmentId}
       order by occurred_at, id
    `
    expect(events.length).toBe(3)
    for (const event of events) {
      // On EVERY step. A reader looking at why a treatment was checked in at 19:00 on a day that has
      // already closed gets the answer on the row they are looking at, rather than having to find the
      // completion to learn that none of it happened live.
      expect(event.payload['recorded_after_the_fact'], event.event_type).toBe(true)
      expect(event.payload['entered_at'], event.event_type).toBeTypeOf('string')
      expect(event.payload['visit_started_at'], event.event_type).toBeTypeOf('string')
    }
    // And the audit row carries it too, which is the half a worker never reads.
    const audits = await sql<{ after_state: Record<string, unknown> }[]>`
      select after_state from audit_event
       where entity_type = 'appointment' and entity_id = ${appointmentId}
         and after_state ? 'recorded_after_the_fact'
    `
    // One per walked step, not merely "at least one": an audit trail that carried the marker on the
    // completion alone is the thing `record-past-visit.ts` put it on every step to avoid.
    expect(audits.length).toBe(3)
    for (const audit of audits) {
      expect(audit.after_state['recorded_after_the_fact']).toBe(true)
    }
  })

  it('emits the revenue event from the completion, the way a live visit does', async () => {
    const { html } = await post({
      step: 'record',
      time: SLOT.revenue,
      therapist: therapistId,
      room: roomId,
    })
    expect(refusalOf(html)).toBeNull()
    const [appointment] = await sql<{ id: string }[]>`
      select id::text as id from appointment where booking_id = ${bookingIdOf(html) as string}
    `
    // `completed` is the one state that emits revenue — "the till knows the truth". A backdated visit
    // that skipped it would be a treatment the ledger never hears about, which is the half of this the
    // owner actually asked for.
    const [event] = await sql<{ event_type: string }[]>`
      select event_type from outbox_event
       where aggregate_type = 'appointment' and aggregate_id = ${(appointment as { id: string }).id}
       order by occurred_at desc, id desc limit 1
    `
    expect((event as { event_type: string }).event_type).toMatch(/completed/)
  })
})

describe('step=record — a no-show', () => {
  it('walks straight to no_show and emits no completion', async () => {
    const { html } = await post({
      step: 'record',
      outcome: 'no_show',
      time: SLOT.noShow,
      therapist: therapistId,
      room: roomId,
    })
    expect(refusalOf(html)).toBeNull()
    const [appointment] = await sql<{ id: string; status: string }[]>`
      select id::text as id, status::text as status
        from appointment where booking_id = ${bookingIdOf(html) as string}
    `
    expect((appointment as { status: string }).status).toBe('no_show')
    const history = await sql<{ to_status: string }[]>`
      select to_status::text as to_status from appointment_status_history
       where appointment_id = ${(appointment as { id: string }).id}
    `
    // `confirmed` is the insert's own row; `no_show` is the one step this outcome walks.
    expect(history.map((row) => row.to_status)).toEqual(['confirmed', 'no_show'])
  })
})

describe('refusals that write nothing', () => {
  const countBookings = async (): Promise<number> => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from booking where notes = ${MARKER}
    `
    return Number((row as { n: string }).n)
  }

  it('refuses a therapist who was not on shift, and leaves no row behind', async () => {
    const before = await countBookings()
    const { html } = await post({ step: 'record', therapist: strangerId, room: roomId })
    // The eligibility read model inside the transaction, not a pre-check on this screen. The whole
    // transaction rolls back, which is why the count is unchanged rather than one higher with a
    // half-walked appointment in it.
    expect(refusalOf(html)).toBe('write_refused')
    expect(html).toContain('therapist_not_eligible')
    expect(await countBookings()).toBe(before)
  })

  it('refuses a visit in a closed period, and says where it may go instead', async () => {
    await sql`
      insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
      values (${`${MARKER}-period`}, ${tradingDate}::date, ${tradingDate}::date, ${MARKER}, 'staff')
    `
    try {
      const before = await countBookings()
      const { html } = await post({ step: 'record', therapist: therapistId, room: roomId })
      expect(refusalOf(html)).toBe('period_closed')
      expect(html).toContain('has NOT been recorded')
      // The whole entry, not the diary row with the money missing. That half-done state is the one this
      // refusal exists to prevent: the money posts from the revenue event, by the worker, after this
      // transaction has already committed.
      expect(await countBookings()).toBe(before)
    } finally {
      await sql`delete from period_lock where reason = ${MARKER}`
    }
  })

  it('refuses an entry further back than the horizon', async () => {
    // Same seeded calendar, a clock moved forward a year. The refusal is about the horizon and not about
    // the date, which the next case pins from the other side.
    const response = await handleRecordVisitWrite(
      {
        searchParams: new URLSearchParams(),
        chrome,
        body: body({ step: 'record', therapist: therapistId, room: roomId }),
        requestId: null,
      },
      { sql, now: () => frozenNow + 365 * 24 * 60 * 60 * 1000 },
    )
    expect(refusalOf(await response.text())).toBe('beyond_the_horizon')
  })

  it('refuses a visit that has not happened yet, because that is a booking', async () => {
    const response = await handleRecordVisitWrite(
      {
        searchParams: new URLSearchParams(),
        chrome,
        body: body({ step: 'record', therapist: therapistId, room: roomId }),
        requestId: null,
      },
      // The clock moved back to before the visit. Nothing about the entry changed, which is what makes
      // this a claim about the gate rather than about the form.
      { sql, now: () => frozenNow - 3 * 24 * 60 * 60 * 1000 },
    )
    expect(refusalOf(await response.text())).toBe('not_in_the_past')
  })

  it('refuses a day the salon does not trade', async () => {
    const [gap] = await sql<{ day: string }[]>`
      select (max(trading_date) + 400)::text as day from business_day
    `
    const { html } = await post({
      step: 'record',
      date: (gap as { day: string }).day,
      therapist: therapistId,
      room: roomId,
    })
    expect(refusalOf(html)).toBe('outside_trading_hours')
  })

  it('refuses a submission with no therapist chosen', async () => {
    const { html } = await post({ step: 'record', room: roomId })
    expect(refusalOf(html)).toBe('therapist_not_chosen')
  })
})

describe('the overlap that cannot have happened', () => {
  it('refuses a second treatment for the same therapist at the same time', async () => {
    const first = await post({
      step: 'record',
      time: SLOT.overlapFirst,
      therapist: therapistId,
      room: roomId,
    })
    expect(refusalOf(first.html)).toBeNull()
    // 0024's exclusion constraint on `(therapist_id, period)`, met by a backdated entry exactly as by a
    // live one. Two overlapping treatments for one therapist cannot have happened, whatever the horizon
    // and the period lock allow — and it is also what makes a double-tapped Record button safe without a
    // derived idempotency key.
    const second = await post({
      step: 'record',
      time: SLOT.overlapSecond,
      therapist: therapistId,
      room: roomId,
    })
    expect(refusalOf(second.html)).toBe('write_refused')
  })
})
