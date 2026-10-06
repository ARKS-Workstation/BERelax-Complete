import { createConnection, readCalendarDay, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderDaySheetHtml } from '../app/(admin)/day-sheet/print/render.ts'
import { daySheetViewFor } from '../app/(admin)/day-sheet/print/view.ts'
import type { AdminChrome } from './components/admin/google-reauth-banner.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * H-HARD-08 — the printed day sheet, against real PostgreSQL.
 *
 * Two claims and they are both about the DATA rather than the template:
 *
 *   1. **Every appointment of a business day is on it, including the ones after midnight.** Trading runs
 *      11:00–02:00, so a treatment at 01:30 has a calendar date of the NEXT day and a trading date of
 *      this one. A sheet built from `lower(period)::date` would silently lose it — the two hours of every
 *      day with the fewest people on the floor and the most need for a printed list.
 *   2. **Two runs produce the same bytes.** Asserted by reading the day twice, building the view twice and
 *      comparing the whole document, not a projection of it. An exclusion list is a second statement that
 *      the first nested timestamp somebody adds falls outside, which is ADR 0105's argument for comparing
 *      a report WHOLE.
 *
 * The control for both: a treatment at 20:00 on the same day is on the sheet and is NOT marked after
 * midnight, so "the 01:30 one is there" is not satisfied by a sheet that marks everything, and the
 * byte-identity is asserted over a document that has rows in it rather than over an empty one.
 *
 * ## Why it inserts appointment rows directly
 *
 * The subject is the READER and the view, not the booking transaction — `createBooking` has its own suite
 * and this file driving it would make a failure in the availability rule present as a day-sheet defect.
 * The rows are inserted with every column the schema requires, so the exclusion constraints and the
 * generated `holds_resources` are all in force; what is skipped is the assignment decision, which is
 * B-AVAIL-06's.
 *
 * ## Isolation
 *
 * The trading date `2097-11-21` is used by no other suite. Every room, service, variant and employee
 * carries {@link MARKER}, and `afterAll` removes exactly those rows — `appointment` and `booking` are
 * deletable, which is why this file can clean up where `packages/fixtures/src/aborted-transaction.itest.ts`
 * cannot.
 */

const MARKER = 'hhard08 day sheet itest'
const TRADING_DATE = '2097-11-21'
const NEXT_CALENDAR_DATE = '2097-11-22'
const PROBE = 'hhard08_sheet_probe'
const PROBE_PHONE = '+971590000821'
const ROOM_CODE = 'hhard08-sheet-room'

/** No banner to show, which is the ordinary state. G-CONN-08 requires the CALL, not the banner. */
const CHROME: AdminChrome = {
  googleReauth: null,
  sendBacklog: null,
  role: 'owner' as const,
  returnTo: '/day-sheet/print',
}

let sql: Sql
let bookingId = ''

const dubai = (date: string, time: string): string => `${date} ${time}:00+04`

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })

  // Anything a previous run left, removed first. A run whose `afterAll` did not reach would otherwise put
  // two copies of each treatment on the sheet, and the byte-identity assertion would still pass — about a
  // sheet nobody meant.
  await sql`delete from appointment where trading_date = ${TRADING_DATE}::date`
  await sql`delete from booking where notes = ${MARKER}`

  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${dubai(TRADING_DATE, '11:00')}::timestamptz,
            ${dubai(NEXT_CALENDAR_DATE, '02:00')}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  const [room] = await sql<{ id: string }[]>`
    insert into rooms (code, name, room_type, capacity, display_order, notes)
    values (${ROOM_CODE}, ${`Probe ${ROOM_CODE}`}, 'standard'::room_type, 1, 93, ${MARKER})
    on conflict (code) do update set notes = excluded.notes
    returning id
  `
  const roomId = (room as { id: string }).id

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, 'hhard08-sheet-probe', 'Probe massage', 'Normal Massage (Asian)', 20, 93)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${(service as { id: string }).id}, 45, 20000, ${MARKER})
    on conflict (service_id, duration_minutes) do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  const variantId = (variant as { id: string }).id

  const [employee] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values ('hhard08-sheet-a', 'female', '2097-01-01', ${MARKER})
    on conflict (staff_reference) do update set notes = excluded.notes
    returning id
  `
  const therapistId = (employee as { id: string }).id

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${(customer as { id: string }).id}::uuid, 'front_desk', ${MARKER})
    returning id
  `
  bookingId = (booking as { id: string }).id

  /*
    Two treatments on ONE trading day, and the second is the whole point.

    20:00–20:45 has a calendar date of the 21st, which is the trading date. 01:30–02:15 has a calendar date
    of the 22nd and a trading date of the 21st, because the session that opened at 11:00 on the 21st has
    not closed. Both must be on the sheet; only the second is after midnight.
  */
  for (const [startsAt, endsAt] of [
    [dubai(TRADING_DATE, '20:00'), dubai(TRADING_DATE, '20:45')],
    [dubai(NEXT_CALENDAR_DATE, '01:30'), dubai(NEXT_CALENDAR_DATE, '02:15')],
  ] as const) {
    await sql`
      insert into appointment
        (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
         gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes,
         therapist_buffer_minutes)
      values (
        ${bookingId}::uuid, ${TRADING_DATE}::date, ${variantId}::uuid, 'solo'::service_shape,
        ${therapistId}::uuid, ${roomId}::uuid,
        ${`[${startsAt},${endsAt})`}::tstzrange, 'confirmed'::appointment_status,
        20000, 19048, 952, 500, 20, 10
      )
    `
  }
}, 60_000)

afterAll(async () => {
  if (sql !== undefined) {
    await sql`delete from appointment where trading_date = ${TRADING_DATE}::date`
    await sql`delete from booking where notes = ${MARKER}`
    await sql`delete from employee where notes = ${MARKER}`
    await sql`delete from service where treatment_key = ${PROBE}`
    await sql`delete from rooms where notes = ${MARKER}`
    await sql`delete from business_day where trading_date = ${TRADING_DATE}::date`
    await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
    await sql.end({ timeout: 5 })
  }
})

const sheetFor = async (): Promise<string> =>
  renderDaySheetHtml(
    daySheetViewFor({
      chrome: CHROME,
      tradingDate: TRADING_DATE,
      day: await readCalendarDay(sql, TRADING_DATE),
    }),
  )

describe('the printed day sheet', () => {
  it('lists every treatment of the business day, after-midnight ones included', async () => {
    const html = await sheetFor()
    expect(html).toContain('2 treatment(s)')
    // The 20:00 one and the 01:30 one, both present. The second is the claim: its calendar date is the
    // 22nd and its trading date is the 21st, so a sheet built from `lower(period)::date` would lose it.
    expect(html).toContain('<td>20:00</td>')
    expect(html).toContain('<td>01:30</td>')
    expect(html).toContain('<td>02:15</td>')
    // And the session the heading names is `business_day`'s own, not a clock reading.
    expect(html).toContain('data-day-sheet-session="open"')
    expect(html).toContain('Open 11:00 to 02:00 Dubai')
  })

  it('marks the after-midnight treatment and ONLY that one, which is the control', async () => {
    const html = await sheetFor()
    /*
      Matched on the ROW's opening tag and not on the attribute alone.

      The stylesheet carries `tr[data-after-midnight="true"]` — the rule that shades the row — so a bare
      attribute match found three occurrences for two rows and the case failed about the CSS. The lesson
      is the one brief rule "a check must measure what its name claims" states: this case is about the
      rows, so it reads the rows.
    */
    const marked = [...html.matchAll(/<tr data-after-midnight="(true|false)"/g)].map(
      (match) => match[1],
    )
    // Exactly two rows, exactly one of them marked. A rule that marked everything, or nothing, fails
    // here — and that is the only assertion that distinguishes a correct comparison from a constant.
    expect(marked).toHaveLength(2)
    expect(marked.filter((value) => value === 'true')).toHaveLength(1)
    expect(marked.filter((value) => value === 'false')).toHaveLength(1)
    // The marked row is the 01:30 one.
    expect(html).toMatch(/<tr data-after-midnight="true"><td>01:30<\/td>/)
  })

  it('produces byte-identical documents on two runs', async () => {
    // Two full reads and two full renders, compared WHOLE. No exclusion list: an exclusion is a second
    // statement that the first nested timestamp somebody adds falls outside, which is ADR 0105's reason
    // for comparing a report entire.
    const first = await sheetFor()
    const second = await sheetFor()
    expect(second).toBe(first)
    // Not vacuous: the document has the day's rows in it, and a length floor catches a renderer that
    // started returning the empty string on both runs.
    expect(first.length).toBeGreaterThan(2000)
    expect(first).toContain('<td>01:30</td>')
  })

  it('holds no instant of its own, which is what makes the two runs comparable', async () => {
    const html = await sheetFor()
    // No ISO instant anywhere. Every other admin screen prints the instant it was read at, deliberately;
    // this one is the exception and the exception is the point.
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    // The only date on it is the trading date, which is `business_day`'s column.
    expect(html).toContain(TRADING_DATE)
  })

  it('names no customer and no person, only handles', async () => {
    const html = await sheetFor()
    expect(html).toContain('hhard08-sheet-a')
    expect(html).not.toContain(PROBE_PHONE)
    expect(html).toContain('names no customer')
    // The "paid" column is blank: a figure this system filled in would be a claim it cannot make while
    // the network is down, and the paper side is a named person's claim (ADR 0107).
    expect(html).toContain('<td class="tender"></td>')
  })

  it('says a date with no session is CLOSED rather than answering an empty sheet', async () => {
    const closed = renderDaySheetHtml(
      daySheetViewFor({
        chrome: CHROME,
        tradingDate: '2097-11-20',
        day: await readCalendarDay(sql, '2097-11-20'),
      }),
    )
    expect(closed).toContain('data-day-sheet-session="closed"')
    expect(closed).toContain('data-day-sheet-appointments="none"')
    // The distinction that matters: an empty day and an unreadable one are a quiet evening and an outage.
    expect(closed).toContain('not "the sheet could not be read"')
  })
})
