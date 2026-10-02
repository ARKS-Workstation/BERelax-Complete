import {
  type DatedHoursOverride,
  forecastBytes,
  type HolidayImpactReport,
  type HolidayObservance,
  holidayConfirmationImpact,
  holidayImpactBytes,
  holidayPayCalendar,
  hoursWithOverrides,
  type Instant,
  type LocalDate,
  lastBookableStart,
  localDate,
  localTime,
  publicHolidayMinutes,
  publishHolidayFigure,
  type RosteredShift,
  summariseWorkedHours,
  type TradingHours,
  toLocal,
  type WorkingHoursRules,
} from '@berelax/core'
import {
  type ConfirmedObservance,
  confirmHolidayObservance,
  createConnection,
  HOLIDAY_CALENDAR_SQLSTATE,
  type HolidayObservanceRow,
  isHolidayOverrideStrandingRefusal,
  readHolidayConfirmation,
  readHolidayImpactRows,
  readHolidayObservances,
  readPremisesHoursOverrides,
  readRosteredShifts,
  readWorkingHoursRules,
  recordHolidayObservance,
  type Sql,
  saveHoursOverride,
  type WorkingHoursRuleRow,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * P-HR-10 — the holiday calendar, the confirmation that reports and mutates nothing, and the Ramadan
 * override the availability engine honours.
 *
 * The **rows** live in PostgreSQL and are read and written by `@berelax/db`; every **judgement** is pure
 * and lives in `@berelax/core`. `packages/db` may never import `packages/core` (brief rule 4), so nothing
 * but `@berelax/fixtures` can assert that the pair works — the same reason `hr-working-hours.itest.ts` is
 * in this package.
 *
 * Six claims need both halves, and each is a separate acceptance line:
 *
 *   1. **A provisional holiday changes no availability.** Asserted as a measurement rather than as a
 *      property of a code path nobody took: the `business_day` rows and the `availability_epoch` rows for
 *      the suite's dates are read before and after the observance is recorded and must be identical. The
 *      CONTROL is a `shift` insert over the same date, which DOES bump the epoch — so the first assertion
 *      is not satisfied by a table nothing ever writes to.
 *   2. **Confirming onto a different date reports its impact and mutates nothing.** Every appointment,
 *      shift assignment and leave row the report is about is snapshotted before the confirmation and
 *      compared byte for byte after it. The control is the report itself being non-empty: "nothing moved"
 *      over a report of nothing is vacuous.
 *   3. **The last bookable start recomputes from the override**, at the first and the last date of the
 *      window, from the hours the DATABASE holds rather than from a literal — which is what makes it a
 *      claim about `premises_hours_override` and not about arithmetic the pure suite already pins.
 *   4. **An override that would strand a booking is refused at save time, with the ids.** Both layers:
 *      `saveHoursOverride` returns the report, and a raw insert that bypasses it raises ZY294.
 *   5. **The public-holiday bucket is distinct**, over a shift this suite rosters on an observance date,
 *      with the calendar read from the database. The control is the same shift on a date with no
 *      observance, whose minutes are all ordinary.
 *   6. **The impact report is byte-identical across two independent reads**, and its canonical form is
 *      held equal to `forecastBytes` — the third statement of one serialiser, with the check in the one
 *      package that may import both.
 *
 * ## Isolation (brief rules 12 and 50)
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind. So
 * every date here is in 2076, and 2076 was MEASURED to be unused: no date literal under `packages`,
 * `apps` or `scripts` contains it. Every read narrows to the suite's own dates or its own ids, and
 * `afterAll` removes only rows this file created, in foreign-key order. `holiday_confirmation` is
 * append-only (ZY292) and `holiday_observance` has no DELETE grant for the application role — this suite
 * connects as the owner, so it can and does remove its own, which keeps the file re-runnable; that is the
 * one place it reaches past the application's own privileges and it does so only for rows it inserted.
 *
 * No employee here has a name (brief rule 10), and no date in this file is a claim about when any lunar
 * observance falls: the real dates are `Y9-holiday-calendar`.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The span this suite may write into.
 *
 * Measured rather than chosen: `grep -rn "'2076-"` over `packages`, `apps` and `scripts` found nothing
 * before this unit, where 2079 through 2089 are held by eleven other suites and gate blocks.
 */
const RESERVED_YEAR = '2076'
/** 2076-03-01 is a Sunday, so the span to the 7th is one whole week. */
const DAY_1 = localDate(`${RESERVED_YEAR}-03-01`)
const DAY_2 = localDate(`${RESERVED_YEAR}-03-02`)
const DAY_3 = localDate(`${RESERVED_YEAR}-03-03`)
const DAY_4 = localDate(`${RESERVED_YEAR}-03-04`)
const SPAN = [DAY_1, DAY_2, DAY_3, DAY_4] as const
const RANGE = { fromTradingDate: DAY_1 as string, toTradingDate: DAY_4 as string }

/** 11:00–02:00, which is what `premises_hours` holds: 900 minutes. */
const WEEKLY_MINUTES = 900

const PREFIX = 'PHR10 CAL'

let sql: Sql
let employeeId = ''
let secondEmployeeId = ''
let customerId = ''
let roomId = ''
let variantId = ''
let bookingId = ''
const appointmentIds: string[] = []
const shiftIds: string[] = []
const leaveRequestIds: string[] = []
const observanceIds: string[] = []
const overrideIds: string[] = []

const instantAt = (date: LocalDate | string, time: string): Date =>
  new Date(
    new Date(`${date}T${time}:00+04:00`).toISOString(), // Asia/Dubai has no DST, so +04:00 is exact.
  )

const wall = (instant: Instant | undefined): string =>
  instant === undefined ? 'none' : toLocal(instant).time.slice(0, 5)

/** Materialises the suite's four trading dates from the hours that govern them. */
async function generateSpanBusinessDays(): Promise<void> {
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    select d::date,
           (d::date + coalesce(o.open_time, w.open_time)) at time zone 'Asia/Dubai',
           (d::date + 1 + coalesce(o.close_time, w.close_time)) at time zone 'Asia/Dubai',
           case when o.id is null then 'weekly' else 'override' end
      from generate_series(${DAY_1 as string}::date, ${DAY_4 as string}::date, interval '1 day') d
      join premises_hours w
        on w.day_of_week = extract(dow from d::date)::smallint
      left join premises_hours_override o
        on d::date between o.starts_on and o.ends_on
       and (o.day_of_week is null or o.day_of_week = extract(dow from d::date)::smallint)
     where not w.is_closed
    on conflict (trading_date) do update
       set opens_at  = excluded.opens_at,
           closes_at = excluded.closes_at,
           source    = excluded.source
  `
}

/** The `business_day` and `availability_epoch` state of the span, as a comparable string. */
async function calendarFingerprint(): Promise<string> {
  const [days, epochs] = await Promise.all([
    sql<{ row: string }[]>`
      select trading_date::text || '|' || opens_at::text || '|' || closes_at::text || '|' ||
             duration_seconds::text || '|' || source as row
        from business_day
       where trading_date between ${DAY_1 as string}::date and ${DAY_4 as string}::date
       order by trading_date
    `,
    sql<{ row: string }[]>`
      select trading_date::text || '|' || epoch::text || '|' || last_cause::text as row
        from availability_epoch
       where trading_date between ${DAY_1 as string}::date and ${DAY_4 as string}::date
       order by trading_date
    `,
  ])
  return JSON.stringify({ days: days.map((d) => d.row), epochs: epochs.map((e) => e.row) })
}

/**
 * Every appointment, shift assignment and approved leave row over the span, as a comparable string.
 *
 * Takes the connection rather than closing over `sql`, so a case inside {@link probe} compares the rows
 * its OWN transaction can see. Reading through the pool from inside a transaction would compare the
 * pre-confirmation rows with themselves and pass whatever the confirmation had done.
 */
async function bookingFingerprint(on: Sql): Promise<string> {
  const [appointments, assignments, leave] = await Promise.all([
    on<{ row: string }[]>`
      select id::text || '|' || trading_date::text || '|' || period::text || '|' || status::text ||
             '|' || room_id::text || '|' || therapist_id::text as row
        from appointment
       where trading_date between ${DAY_1 as string}::date and ${DAY_4 as string}::date
       order by id
    `,
    on<{ row: string }[]>`
      select sa.shift_id::text || '|' || sa.employee_id::text || '|' || s.trading_date::text ||
             '|' || s.period::text as row
        from shift_assignment sa join shift s on s.id = sa.shift_id
       where s.trading_date between ${DAY_1 as string}::date and ${DAY_4 as string}::date
       order by sa.shift_id, sa.employee_id
    `,
    on<{ row: string }[]>`
      select id::text || '|' || employee_id::text || '|' || period::text || '|' || status::text as row
        from leave_request
       where id = any(${leaveRequestIds}::uuid[])
       order by id
    `,
  ])
  return JSON.stringify({
    appointments: appointments.map((r) => r.row),
    assignments: assignments.map((r) => r.row),
    leave: leave.map((r) => r.row),
  })
}

/** Thrown to roll a probe back. Any error rolls `sql.begin` back; a named one cannot be mistaken. */
const ROLLBACK = 'phr10-probe-rollback'

/**
 * Runs `body` in a transaction, forces the deferred constraints, and rolls the transaction back.
 *
 * Every case that records an ANNOUNCEMENT runs in one, and that is the SCHEMA's doing rather than
 * tidiness. `holiday_confirmation` is append-only (ZY292) and it pins its observance `on delete
 * restrict`, so a confirmed observance cannot be removed by anybody — including the owner this suite
 * connects as. The first draft of this file deleted in `afterAll` behind `.catch(() => undefined)` and
 * left one observance per run behind; the `catch` hid it and a count of the table found it. Inside a
 * rolled-back transaction the confirmation is real, every read in the case sees it, and nothing survives.
 * `hr-gratuity.itest.ts` takes the same shape for the same reason.
 *
 * **`set constraints all immediate` is not optional here.** ZY291, ZY293 and ZY294 are DEFERRED
 * constraint triggers, so they fire at COMMIT — and a transaction that is deliberately rolled back never
 * reaches one. Without this statement a probe would prove nothing and a happy-path case would pass with
 * the rule turned off. It is ADR 0061's dry run doing the same thing for the same reason: a rehearsal
 * that skipped the deferred checks would be weaker than the run.
 */
async function probe<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  let carried: T | undefined
  try {
    await sql.begin(async (tx) => {
      carried = await body(tx as unknown as Sql)
      await tx`set constraints all immediate`
      throw new Error(ROLLBACK)
    })
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK) throw err
  }
  return carried as T
}

const asObservance = (row: HolidayObservanceRow): HolidayObservance => ({
  id: row.id,
  kind: row.kind as HolidayObservance['kind'],
  name: row.name,
  dateBasis: row.dateBasis as HolidayObservance['dateBasis'],
  confirmationState: row.confirmationState as HolidayObservance['confirmationState'],
  startsOn: localDate(row.startsOn),
  endsOn: localDate(row.endsOn),
  openQuestionId: row.openQuestionId,
})

const asWorkingHoursRules = (row: WorkingHoursRuleRow): WorkingHoursRules => ({
  effectiveFrom: localDate(row.effectiveFrom),
  ordinaryMinutesPerDay: row.ordinaryMinutesPerDay,
  ordinaryMinutesPerWeek: row.ordinaryMinutesPerWeek,
  weekStartsOn: row.weekStartsOn,
  overtimeDailyCapMinutes: row.overtimeDailyCapMinutes,
  minimumRestMinutes: row.minimumRestMinutes,
  nightWindow: { from: localTime(row.nightWindowFrom), until: localTime(row.nightWindowUntil) },
  multiplierBp: {
    ordinary: row.ordinaryMultiplierBp,
    overtime: row.overtimeMultiplierBp,
    night: row.nightMultiplierBp,
    publicHoliday: row.publicHolidayMultiplierBp,
  },
})

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 4 })

  const [customer] = await sql<{ id: string }[]>`
    select id::text as id from customer order by id limit 1
  `
  const [room] = await sql<{ id: string }[]>`select id::text as id from rooms order by id limit 1`
  const [variant] = await sql<{ id: string }[]>`
    select id::text as id from service_variant order by id limit 1
  `
  const employees = await sql<{ id: string }[]>`
    select id::text as id from employee order by staff_reference limit 2
  `
  customerId = customer?.id ?? ''
  roomId = room?.id ?? ''
  variantId = variant?.id ?? ''
  employeeId = employees[0]?.id ?? ''
  secondEmployeeId = employees[1]?.id ?? ''
  if (!customerId || !roomId || !variantId || !employeeId || !secondEmployeeId) {
    throw new Error('the fixture salon is not seeded: run `pnpm seed` (brief rule 24)')
  }

  await generateSpanBusinessDays()

  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}::uuid, 'walk_in', ${`${PREFIX} holiday calendar itest`})
    returning id::text as id
  `
  bookingId = booking?.id ?? ''

  // One appointment on each of three dates: the one the holiday is predicted on, the one it keeps, and
  // the one it moves onto.
  //
  // 15:00-16:30 with a 20-minute turnaround, and the time is chosen rather than arbitrary: it is inside
  // BOTH the weekly 11:00-02:00 and the 14:00-04:00 override the hours case saves, so that case is about
  // the last bookable start and not about a stranded booking. The first draft booked them at 12:00 and
  // the override was refused by ZY294 — which is the refusal working, in the test that is not about it.
  for (const date of [DAY_1, DAY_2, DAY_3]) {
    const [row] = await sql<{ id: string }[]>`
      insert into appointment (
        booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
        delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
        gross_price_fils, net_fils, vat_fils, vat_rate_bp
      ) values (
        ${bookingId}::uuid, ${date as string}::date, ${variantId}::uuid, 'solo'::service_shape,
        ${employeeId}::uuid, ${roomId}::uuid,
        tstzrange(${instantAt(date, '15:00')}, ${instantAt(date, '16:30')}, '[)'),
        'confirmed'::appointment_status,
        gen_random_uuid(), 1, 20, 10, 100000, 95238, 4762, 500
      )
      returning id::text as id
    `
    if (row?.id !== undefined) appointmentIds.push(row.id)
  }

  // Three shifts of eight hours each, 11:00-19:00, one on each date the pay-bucket case needs: DAY_1 is
  // covered by the PROVISIONAL observance, DAY_3 by none, DAY_4 by the settled Gregorian one. Eight
  // hours, so the whole shift is inside the day's ordinary allowance and no minute lands in overtime —
  // which is what makes "480 in one bucket and 0 in the other" a statement about the holiday flag.
  for (const [date, employee] of [
    [DAY_1, employeeId],
    [DAY_3, secondEmployeeId],
    [DAY_4, employeeId],
  ] as const) {
    const [shift] = await sql<{ id: string }[]>`
      insert into shift (trading_date, period, label)
      values (
        ${date as string}::date,
        tstzrange(${instantAt(date, '11:00')}, ${instantAt(date, '19:00')}, '[)'),
        ${`${PREFIX} ${date}`}
      )
      returning id::text as id
    `
    const shiftId = shift?.id ?? ''
    if (!shiftId) throw new Error('the shift insert returned no row')
    shiftIds.push(shiftId)
    await sql`
      insert into shift_assignment (shift_id, employee_id)
      values (${shiftId}::uuid, ${employee}::uuid)
    `
  }

  // One approved leave day on the predicted date, so the report has something on every one of its three
  // collections.
  //
  // The period is the trading SESSION and not the calendar day, and the first draft of this file got it
  // wrong: P-HR-09's `leave_request_covers_its_trading_session` refused a midnight-to-midnight range by
  // name, because trading crosses midnight — a calendar-aligned leave day starts in the middle of the
  // previous session and leaves the last two hours of its own rostered. So the bounds come from
  // `business_day`, which is the one place they are stated.
  const [leave] = await sql<{ id: string }[]>`
    insert into leave_request (employee_id, period, kind, status, decided_at, reason)
    select ${secondEmployeeId}::uuid,
           tstzrange(bd.opens_at, bd.closes_at, '[)'),
           'annual'::leave_kind, 'approved'::leave_status, now(), ${`${PREFIX} itest`}
      from business_day bd
     where bd.trading_date = ${DAY_1 as string}::date
    returning id::text as id
  `
  if (leave?.id !== undefined) leaveRequestIds.push(leave.id)
}, 60_000)

afterAll(async () => {
  if (sql === undefined) return
  // Only rows this suite created, in foreign-key order. `holiday_confirmation` first, because
  // `holiday_observance.id` is referenced by it `on delete restrict`.
  for (const id of observanceIds) {
    await sql`delete from holiday_confirmation where observance_id = ${id}::uuid`.catch(
      () => undefined,
    )
    await sql`delete from holiday_observance where id = ${id}::uuid`.catch(() => undefined)
  }
  for (const id of overrideIds) {
    await sql`delete from premises_hours_override where id = ${id}::uuid`.catch(() => undefined)
  }
  for (const id of leaveRequestIds) {
    await sql`delete from leave_request where id = ${id}::uuid`.catch(() => undefined)
  }
  for (const id of appointmentIds) {
    await sql`delete from appointment where id = ${id}::uuid`.catch(() => undefined)
  }
  for (const id of shiftIds) {
    await sql`delete from shift_assignment where shift_id = ${id}::uuid`.catch(() => undefined)
    await sql`delete from shift where id = ${id}::uuid`.catch(() => undefined)
  }
  if (bookingId) await sql`delete from booking where id = ${bookingId}::uuid`.catch(() => undefined)
  for (const date of SPAN) {
    await sql`delete from availability_epoch where trading_date = ${date as string}::date`.catch(
      () => undefined,
    )
    await sql`delete from business_day where trading_date = ${date as string}::date`.catch(
      () => undefined,
    )
  }
  await sql.end()
}, 60_000)
// --- 1. a provisional holiday changes no availability --------------------------------------------

describe('acceptance — a provisional holiday changes no availability', () => {
  it('leaves business_day and availability_epoch untouched, where a shift does not', async () => {
    const before = await calendarFingerprint()
    const id = await recordHolidayObservance(sql, {
      kind: 'public_holiday',
      name: 'Fixture holiday, date not announced',
      dateBasis: 'lunar',
      confirmationState: 'provisional',
      startsOn: DAY_1 as string,
      endsOn: DAY_2 as string,
      openQuestionId: 'Y9-holiday-calendar',
      source: `${PREFIX}: a reserved-year fixture range, not a real date`,
    })
    observanceIds.push(id)
    expect(await calendarFingerprint()).toBe(before)

    // The CONTROL. Without it the assertion above is satisfied by a fingerprint nothing can move: 0045's
    // trigger bumps the epoch on a shift write, so a shift insert over the same date MUST change it.
    const [probe] = await sql<{ id: string }[]>`
      insert into shift (trading_date, period, label)
      values (
        ${DAY_2 as string}::date,
        tstzrange(${instantAt(DAY_2, '11:00')}, ${instantAt(DAY_2, '15:00')}, '[)'),
        ${`${PREFIX} epoch control`}
      )
      returning id::text as id
    `
    const probeId = probe?.id ?? ''
    expect(probeId).not.toBe('')
    expect(await calendarFingerprint()).not.toBe(before)
    await sql`delete from shift where id = ${probeId}::uuid`
  })

  it('is readable as provisional, and the question that owns the date is on the row', async () => {
    const rows = await readHolidayObservances(sql, RANGE)
    const mine = rows.filter((row) => observanceIds.includes(row.id))
    expect(mine).toHaveLength(1)
    expect(mine[0]?.confirmationState).toBe('provisional')
    expect(mine[0]?.openQuestionId).toBe('Y9-holiday-calendar')
    // And the pure calendar reports it as PREDICTED, which is the figure's own marking.
    const calendar = holidayPayCalendar(mine.map(asObservance))
    expect([...calendar.predictedDates].sort()).toEqual([DAY_1, DAY_2])
    expect(calendar.confirmedDates.size).toBe(0)
  })

  it('refuses a provisional observance that names no open question', async () => {
    await expect(
      recordHolidayObservance(sql, {
        kind: 'public_holiday',
        name: 'Fixture unflagged provisional',
        dateBasis: 'lunar',
        confirmationState: 'provisional',
        startsOn: DAY_4 as string,
        endsOn: DAY_4 as string,
        openQuestionId: null,
        source: `${PREFIX}: probe`,
      }),
    ).rejects.toThrow(/holiday_observance_provisional_names_a_question/)
  })

  it('refuses a confirmed LUNAR observance with no announcement on file (ZY291)', async () => {
    // The successor to 0110's `calendar_observance_lunar_is_provisional`, which refused this case
    // outright because nothing in the build could record an announcement. The claim survives: a lunar
    // date presented as settled with nothing behind it is still unstorable.
    let raised: unknown
    try {
      await recordHolidayObservance(sql, {
        kind: 'public_holiday',
        name: 'Fixture lunar presented as settled',
        dateBasis: 'lunar',
        confirmationState: 'confirmed',
        startsOn: DAY_4 as string,
        endsOn: DAY_4 as string,
        openQuestionId: null,
        source: `${PREFIX}: probe`,
      })
    } catch (err) {
      raised = err
    }
    expect(raised).toBeDefined()
    expect(String((raised as { code?: string }).code)).toBe(
      HOLIDAY_CALENDAR_SQLSTATE.lunarNotAnnounced,
    )
    // And the control: the SAME row with a GREGORIAN basis is storable, so the refusal is about the
    // lunar calendar rather than about confirmed observances in general.
    const id = await recordHolidayObservance(sql, {
      kind: 'public_holiday',
      name: 'Fixture settled gregorian holiday',
      dateBasis: 'gregorian',
      confirmationState: 'confirmed',
      startsOn: DAY_4 as string,
      endsOn: DAY_4 as string,
      openQuestionId: null,
      source: `${PREFIX}: a date fixed in the Gregorian calendar`,
    })
    observanceIds.push(id)
  })
})
// --- 3 and 6. the override's hours, and the bytes ------------------------------------------------

describe('acceptance — the last bookable start recomputes from the override', () => {
  it('moves at the first and the last date of the window, from the hours the database holds', async () => {
    const weeklyRows = await sql<
      { dayOfWeek: number; open: string; close: string; closed: boolean }[]
    >`
      select day_of_week as "dayOfWeek", to_char(open_time, 'HH24:MI') as "open",
             to_char(close_time, 'HH24:MI') as "close", is_closed as "closed"
        from premises_hours order by day_of_week
    `
    const weekly: (TradingHours | undefined)[] = Array.from({ length: 7 }, () => undefined)
    for (const row of weeklyRows) {
      if (row.closed) continue
      weekly[row.dayOfWeek] = { open: localTime(row.open), close: localTime(row.close) }
    }
    const request = { closures: [], durationMinutes: 120, turnaroundMinutes: 20 } as const

    const baseline = hoursWithOverrides({ weekly, overrides: [] })
    expect(wall(lastBookableStart({ date: DAY_1, hoursFor: baseline, ...request }))).toBe('23:40')

    // The one change: a row in `premises_hours_override`, saved through the application's own path.
    const saved = await saveHoursOverride(sql, {
      startsOn: DAY_1 as string,
      endsOn: DAY_2 as string,
      dayOfWeek: null,
      openTime: '14:00',
      closeTime: '04:00',
      reason: `${PREFIX}: reduced hours over a reserved year`,
    })
    expect(saved.saved).toBe(true)
    if (saved.saved) overrideIds.push(saved.overrideId)

    const overrides = (await readPremisesHoursOverrides(sql, RANGE))
      .filter((row) => overrideIds.includes(row.id))
      .map(
        (row): DatedHoursOverride => ({
          startsOn: localDate(row.startsOn),
          endsOn: localDate(row.endsOn),
          dayOfWeek: row.dayOfWeek,
          hours: { open: localTime(row.openTime), close: localTime(row.closeTime) },
          reason: row.reason,
        }),
      )
    expect(overrides).toHaveLength(1)
    const withOverride = hoursWithOverrides({ weekly, overrides })

    // 04:00 close − 120 − 20 = 01:40, at the FIRST date of the window and at the LAST.
    expect(wall(lastBookableStart({ date: DAY_1, hoursFor: withOverride, ...request }))).toBe(
      '01:40',
    )
    expect(wall(lastBookableStart({ date: DAY_2, hoursFor: withOverride, ...request }))).toBe(
      '01:40',
    )
    // And the control: one day past the end of the window is the weekly answer again, so the two figures
    // above are about the override's range rather than about a lookup that ignores it.
    expect(wall(lastBookableStart({ date: DAY_3, hoursFor: withOverride, ...request }))).toBe(
      '23:40',
    )

    // The hours chain the reporting side already proves, from this side: regenerating `business_day`
    // moves the generated duration, with no code change anywhere.
    await generateSpanBusinessDays()
    const minutes = await sql<{ day: string; minutes: number }[]>`
      select trading_date::text as day, duration_seconds / 60 as minutes
        from business_day
       where trading_date between ${DAY_1 as string}::date and ${DAY_4 as string}::date
       order by trading_date
    `
    expect(minutes.map((row) => row.minutes)).toEqual([840, 840, WEEKLY_MINUTES, WEEKLY_MINUTES])
  }, 30_000)
})

describe('acceptance — an override that would strand a booked appointment is refused', () => {
  it('returns the conflicting appointment ids as a report rather than throwing a message', async () => {
    // Opening at 17:00 strands all three 15:00 appointments this suite booked, on the opening side.
    const refused = await saveHoursOverride(sql, {
      startsOn: DAY_1 as string,
      endsOn: DAY_3 as string,
      dayOfWeek: null,
      openTime: '17:00',
      closeTime: '23:00',
      reason: `${PREFIX}: an override that strands bookings`,
    })
    expect(refused.saved).toBe(false)
    if (refused.saved) throw new Error('expected the override to be refused')
    expect(refused.strandedAppointments.map((row) => row.appointmentId).sort()).toEqual(
      [...appointmentIds].sort(),
    )
    // And nothing was written: the report is not a side effect of a row that landed anyway.
    const stored = await readPremisesHoursOverrides(sql, RANGE)
    expect(stored.filter((row) => row.reason.includes('strands bookings'))).toEqual([])
  })

  it('is refused by the DATABASE for a caller that bypasses the repository (ZY294)', async () => {
    // The repository's report is the useful answer and the trigger is what makes it impossible to get
    // round by calling something else. Rolled back, so nothing is left behind either way.
    let raised: unknown
    try {
      await probe(async (tx) => {
        await tx`
          insert into premises_hours_override (starts_on, ends_on, open_time, close_time, reason)
          values (${DAY_1 as string}::date, ${DAY_3 as string}::date, time '17:00', time '23:00',
                  ${`${PREFIX}: raw insert probe`})
        `
      })
    } catch (err) {
      raised = err
    }
    expect(raised).toBeDefined()
    expect(isHolidayOverrideStrandingRefusal(raised)).toBe(true)
    // The message names every stranded appointment, because "some bookings are in the way" is not an
    // answer anybody can act on.
    for (const id of appointmentIds) expect(String(raised)).toContain(id)
  })

  it('accepts an override that leaves every booking inside the hours — the control', async () => {
    const saved = await saveHoursOverride(sql, {
      startsOn: DAY_1 as string,
      endsOn: DAY_3 as string,
      dayOfWeek: null,
      openTime: '11:30',
      closeTime: '01:00',
      reason: `${PREFIX}: a narrowing that strands nothing`,
    })
    expect(saved.saved).toBe(true)
    if (saved.saved) overrideIds.push(saved.overrideId)
  })
})
// --- the deferral, MEASURED rather than left to be discovered -----------------------------------

describe('reporting.dim_date does not yet read this calendar, and that is measured', () => {
  it('answers is_public_holiday = false for an observance the operational calendar holds', async () => {
    // 0110 deferred to this unit the job of re-pointing `dim_date` at the operational calendar and
    // dropping `reporting.calendar_observance`. It is NOT done, and ADR 0075 records why with the
    // measurement: thirteen files read that table, `cash-forecast.itest.ts` asserts
    // `calendar_observance_lunar_is_provisional` by name, gate block 151 rests on that assertion and two
    // ADRs describe it — so the re-point is an integrating change across three units' committed work.
    //
    // This case exists so the gap is a FACT in a test rather than a sentence in a comment. The day
    // somebody does the re-point, it fails and names the record that explains it. A comment would not.
    const observances = (await readHolidayObservances(sql, RANGE)).filter((row) =>
      observanceIds.includes(row.id),
    )
    const settled = observances.filter((row) => row.confirmationState === 'confirmed')
    expect(settled).toHaveLength(1)
    expect(settled[0]?.startsOn).toBe(DAY_4)

    await sql`select * from reporting.refresh('dim_date', 'on_demand')`
    const [row] = await sql<{ isPublicHoliday: boolean; names: string | null }[]>`
      select is_public_holiday as "isPublicHoliday", public_holiday_names as "names"
        from reporting.dim_date
       where business_day = ${DAY_4 as string}::date
    `
    // The control first: the trading date IS in dim_date, so the `false` below is the flag's answer and
    // not a missing row.
    expect(row).toBeDefined()
    expect(row?.isPublicHoliday).toBe(false)
    expect(row?.names).toBeNull()
    // And `reporting.calendar_observance` is empty, which is the source dim_date reads and the reason the
    // flag is false. It ships empty on purpose (Y9-holiday-calendar) and this unit seeds no row into it.
    const [count] = await sql<{ rows: string }[]>`
      select count(*)::text as rows from reporting.calendar_observance
    `
    expect(count?.rows).toBe('0')
  }, 30_000)
})

// --- 2. the confirmation reports and mutates nothing ----------------------------------------------
//
// Every case here runs inside a rolled-back transaction, and that is the SCHEMA's doing rather than
// tidiness. See {@link probe}.

describe('acceptance — confirming onto a different date reports its impact and mutates nothing', () => {
  /**
   * Records a provisional observance over DAY_1..DAY_2 and confirms it onto DAY_2..DAY_3.
   *
   * One date released, one retained, one acquired — which is the shape that makes every branch of the
   * report reachable from one move.
   */
  async function confirmOnto(
    tx: Sql,
    dates: { readonly startsOn: string; readonly endsOn: string },
  ): Promise<{ readonly observanceId: string; readonly moved: ConfirmedObservance }> {
    const observanceId = await recordHolidayObservance(tx, {
      kind: 'public_holiday',
      name: 'Fixture holiday, awaiting its announcement',
      dateBasis: 'lunar',
      confirmationState: 'provisional',
      startsOn: DAY_1 as string,
      endsOn: DAY_2 as string,
      openQuestionId: 'Y9-holiday-calendar',
      source: `${PREFIX}: a reserved-year fixture range, not a real date`,
    })
    const moved = await confirmHolidayObservance(tx, {
      observanceId,
      confirmedStartsOn: dates.startsOn,
      confirmedEndsOn: dates.endsOn,
      announcementSource: `${PREFIX}: a fixture announcement, not a real notice`,
      recordedBy: `${PREFIX} operator`,
    })
    return { observanceId, moved }
  }

  /** Builds the report the way the admin surface would: rows from `db`, judgement from `core`. */
  async function reportFor(
    tx: Sql,
    observanceId: string,
    moved: ConfirmedObservance,
  ): Promise<HolidayImpactReport> {
    const [row] = (await readHolidayObservances(tx, RANGE)).filter(
      (candidate) => candidate.id === observanceId,
    )
    if (row === undefined) throw new Error('the confirmed observance is not readable')
    const rows = await readHolidayImpactRows(tx, {
      previousStartsOn: moved.previousStartsOn,
      previousEndsOn: moved.previousEndsOn,
      confirmedStartsOn: moved.confirmedStartsOn,
      confirmedEndsOn: moved.confirmedEndsOn,
    })
    return holidayConfirmationImpact({
      observance: asObservance(row),
      previousStartsOn: localDate(moved.previousStartsOn),
      previousEndsOn: localDate(moved.previousEndsOn),
      appointments: rows.appointments.map((r) => ({
        appointmentId: r.appointmentId,
        tradingDate: localDate(r.tradingDate),
      })),
      shiftAssignments: rows.shiftAssignments.map((r) => ({
        shiftId: r.shiftId,
        employeeId: r.employeeId,
        tradingDate: localDate(r.tradingDate),
      })),
      approvedLeave: rows.approvedLeave.map((r) => ({
        leaveRequestId: r.leaveRequestId,
        employeeId: r.employeeId,
        tradingDate: localDate(r.tradingDate),
      })),
    })
  }

  it('produces the report and leaves every row it names byte-identical', async () => {
    await probe(async (tx) => {
      const bookingsBefore = await bookingFingerprint(tx)
      const { observanceId, moved } = await confirmOnto(tx, {
        startsOn: DAY_2 as string,
        endsOn: DAY_3 as string,
      })
      expect(moved.previousStartsOn).toBe(DAY_1)
      expect(moved.previousEndsOn).toBe(DAY_2)

      const [row] = (await readHolidayObservances(tx, RANGE)).filter(
        (candidate) => candidate.id === observanceId,
      )
      expect(row?.confirmationState).toBe('confirmed')
      // The question that owned the provisional date is cleared, which the database holds to the state:
      // a confirmed observance naming an open question would say the date is still unanswered.
      expect(row?.openQuestionId).toBeNull()

      const report = await reportFor(tx, observanceId, moved)
      expect(report.releasedDates).toEqual([DAY_1])
      expect(report.retainedDates).toEqual([DAY_2])
      expect(report.acquiredDates).toEqual([DAY_3])

      // The report is non-empty, which is the control for "nothing moved": over an empty report a
      // byte-comparison of the rows is satisfied by a confirmation that did nothing at all.
      const mine = report.appointments.filter((r) => appointmentIds.includes(r.reference))
      expect(mine.map((r) => r.side).sort()).toEqual(['acquired', 'released'])
      expect(
        report.shiftAssignments.filter((r) => shiftIds.some((id) => r.reference.startsWith(id))),
      ).toHaveLength(2)
      expect(
        report.approvedLeave.filter((r) =>
          leaveRequestIds.some((id) => r.reference.startsWith(id)),
        ),
      ).toHaveLength(1)
      expect(report.figures.appointments.basis).toBe('confirmed')
      expect(publishHolidayFigure(report.figures.appointments).qualifier).toBe('')

      // And the acceptance line itself: nothing it reported on moved.
      expect(await bookingFingerprint(tx)).toBe(bookingsBefore)

      // The announcement is on file, and it carries BOTH ranges — which is what makes the report
      // reproducible from the row rather than stored beside it (ADR 0075).
      const confirmation = await readHolidayConfirmation(tx, observanceId)
      expect(confirmation?.previousStartsOn).toBe(DAY_1)
      expect(confirmation?.confirmedStartsOn).toBe(DAY_2)
      expect(confirmation?.recordedBy).toBe(`${PREFIX} operator`)
    })
  }, 30_000)

  it('is byte-identical across two independent reads, and serialises as forecastBytes does', async () => {
    await probe(async (tx) => {
      const { observanceId, moved } = await confirmOnto(tx, {
        startsOn: DAY_2 as string,
        endsOn: DAY_3 as string,
      })
      const first = holidayImpactBytes(await reportFor(tx, observanceId, moved))
      const second = holidayImpactBytes(await reportFor(tx, observanceId, moved))
      expect(second).toBe(first)
      // The control: the bytes carry the figures, so the equality is not an equality of two empty
      // strings. And no instant anywhere, which is what makes the clock irrelevant rather than frozen.
      expect(first).toContain('"formatVersion":"holiday-impact-1"')
      expect(first.length).toBeGreaterThan(500)
      expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/)

      // `holidayImpactBytes`, `forecastBytes` and `statementBytes` are one canonical form written three
      // times, because `packages/core` may not import `packages/db` and the two halves of core are in
      // different modules. This is the check that holds two of them equal, in a package that may import
      // both — the drift it guards is a report whose bytes stop being comparable with nothing failing.
      expect(forecastBytes(JSON.parse(first) as unknown)).toBe(first)
    })
  }, 30_000)

  it('reports nothing when the announcement confirms the dates the observance already had', async () => {
    // The control for the move: the same code path over a confirmation that moved nothing must produce
    // an empty report, so the rows above are a function of the DATES rather than of a confirmation
    // having happened at all.
    await probe(async (tx) => {
      const { observanceId, moved } = await confirmOnto(tx, {
        startsOn: DAY_1 as string,
        endsOn: DAY_2 as string,
      })
      const report = await reportFor(tx, observanceId, moved)
      expect(report.releasedDates).toEqual([])
      expect(report.acquiredDates).toEqual([])
      expect(report.appointments).toEqual([])
      expect(report.figures.appointments).toEqual({ basis: 'confirmed', count: 0 })
    })
  }, 30_000)

  /**
   * Runs `body` in a rolled-back transaction and returns the error it raised, or undefined.
   *
   * The refusal is read from OUTSIDE the probe and not from an `expect(...).rejects` inside it, and the
   * first draft of this file got that wrong: a statement that PostgreSQL refuses aborts the transaction
   * it is in, and `postgres.js` rejects the whole `begin` with that error whatever an inner `catch`
   * does — so the assertion passed and the error escaped the case anyway. `merge.itest.ts` records the
   * same behaviour one subject along.
   */
  async function refusalFrom(body: (tx: Sql) => Promise<unknown>): Promise<unknown> {
    try {
      await probe(body)
      return undefined
    } catch (err) {
      return err
    }
  }

  it('refuses to EDIT the announcement (ZY292)', async () => {
    const raised = await refusalFrom(async (tx) => {
      const { observanceId } = await confirmOnto(tx, {
        startsOn: DAY_2 as string,
        endsOn: DAY_3 as string,
      })
      await tx`update holiday_confirmation set announcement_source = 'edited'
                 where observance_id = ${observanceId}::uuid`
    })
    expect(String((raised as { code?: string } | undefined)?.code)).toBe(
      HOLIDAY_CALENDAR_SQLSTATE.announcementAppendOnly,
    )
  }, 30_000)

  it('refuses to DELETE the announcement (ZY292)', async () => {
    const raised = await refusalFrom(async (tx) => {
      const { observanceId } = await confirmOnto(tx, {
        startsOn: DAY_2 as string,
        endsOn: DAY_3 as string,
      })
      await tx`delete from holiday_confirmation where observance_id = ${observanceId}::uuid`
    })
    expect(String((raised as { code?: string } | undefined)?.code)).toBe(
      HOLIDAY_CALENDAR_SQLSTATE.announcementAppendOnly,
    )
  }, 30_000)

  it('refuses a confirmation whose dates disagree with its observance (ZY293)', async () => {
    // A copy somebody keeps in step, refused.
    const raised = await refusalFrom(async (tx) => {
      const observanceId = await recordHolidayObservance(tx, {
        kind: 'public_holiday',
        name: `${PREFIX} mismatch probe`,
        dateBasis: 'gregorian',
        confirmationState: 'confirmed',
        startsOn: DAY_4 as string,
        endsOn: DAY_4 as string,
        openQuestionId: null,
        source: `${PREFIX}: probe`,
      })
      await tx`
          insert into holiday_confirmation
            (observance_id, previous_starts_on, previous_ends_on, confirmed_starts_on,
             confirmed_ends_on, announcement_source, recorded_by)
          values (${observanceId}::uuid, ${DAY_3 as string}::date, ${DAY_3 as string}::date,
                  ${DAY_1 as string}::date, ${DAY_1 as string}::date,
                  ${`${PREFIX}: probe`}, ${`${PREFIX} operator`})
        `
    })
    expect(String((raised as { code?: string } | undefined)?.code)).toBe(
      HOLIDAY_CALENDAR_SQLSTATE.confirmationMismatch,
    )
  })

  it('refuses a second confirmation of one observance, naming what to do instead', async () => {
    await probe(async (tx) => {
      const { observanceId } = await confirmOnto(tx, {
        startsOn: DAY_2 as string,
        endsOn: DAY_3 as string,
      })
      await expect(
        confirmHolidayObservance(tx, {
          observanceId,
          confirmedStartsOn: DAY_3 as string,
          confirmedEndsOn: DAY_3 as string,
          announcementSource: `${PREFIX}: a second announcement`,
          recordedBy: `${PREFIX} operator`,
        }),
      ).rejects.toThrow(/already confirmed/)
    })
  }, 30_000)
})

// --- 5. the public-holiday pay bucket ------------------------------------------------------------

describe('acceptance — public-holiday hours are a distinct bucket, never folded into ordinary', () => {
  it('puts the whole shift in the publicHoliday bucket on an observance date', async () => {
    const observances = (await readHolidayObservances(sql, RANGE))
      .filter((row) => observanceIds.includes(row.id))
      .map(asObservance)
    const calendar = holidayPayCalendar(observances)
    // DAY_4 carries the settled Gregorian observance the first describe records; DAY_3 carries none.
    expect(calendar.dates.has(DAY_4)).toBe(true)
    expect(calendar.dates.has(DAY_3)).toBe(false)

    const ruleVersions = (await readWorkingHoursRules(sql)).map(asWorkingHoursRules)
    expect(ruleVersions.length).toBeGreaterThan(0)

    // The real rostered rows, read back through the repository rather than built here: the claim is
    // about the pair, and a shift literal would make it about the pure function alone.
    const rostered = (await readRosteredShifts(sql, RANGE))
      .filter((row) => shiftIds.includes(row.shiftId))
      .map(
        (row): RosteredShift => ({
          shiftId: row.shiftId,
          employeeId: row.employeeId,
          tradingDate: localDate(row.tradingDate),
          period: { startsAt: row.startsAt as Instant, endsAt: row.endsAt as Instant },
        }),
      )
    const onHoliday = rostered.filter((shift) => shift.tradingDate === DAY_4)
    expect(onHoliday).toHaveLength(1)

    const summary = summariseWorkedHours({
      shifts: onHoliday,
      ruleVersions,
      publicHolidays: calendar.dates,
    })
    const day = summary.days[0]
    expect(day?.minutes.publicHoliday).toBe(480)
    expect(day?.minutes.ordinary).toBe(0)
    expect(day?.totalMinutes).toBe(480)

    // The CONTROL, and it is the acceptance line's real subject: the same eight hours on a date with no
    // observance are ORDINARY. Without it, an implementation that put every minute in the holiday
    // bucket would pass the assertions above.
    const offHoliday = summariseWorkedHours({
      shifts: rostered.filter((shift) => shift.tradingDate === DAY_3),
      ruleVersions,
      publicHolidays: calendar.dates,
    })
    expect(offHoliday.days).toHaveLength(1)
    expect(offHoliday.days[0]?.minutes.publicHoliday).toBe(0)
    expect(offHoliday.days[0]?.minutes.ordinary).toBe(480)

    // And the figure says what it rests on: these minutes fell on an ANNOUNCED date.
    expect(publicHolidayMinutes({ days: summary.days, calendar })).toEqual({
      basis: 'confirmed',
      count: 480,
    })
  }, 30_000)

  it('marks the same minutes PREDICTED when the date is a provisional observance', async () => {
    // The other half of the acceptance line, and the dispatch's own requirement: a report over predicted
    // dates says so IN the figure. Identical minutes, different claim.
    const observances = (await readHolidayObservances(sql, RANGE))
      .filter((row) => observanceIds.includes(row.id))
      .map(asObservance)
    const provisional = observances.filter((row) => row.confirmationState === 'provisional')
    expect(provisional).toHaveLength(1)
    const calendar = holidayPayCalendar(observances)
    const ruleVersions = (await readWorkingHoursRules(sql)).map(asWorkingHoursRules)
    const rostered = (await readRosteredShifts(sql, RANGE))
      .filter((row) => shiftIds.includes(row.shiftId) && row.tradingDate === (DAY_1 as string))
      .map(
        (row): RosteredShift => ({
          shiftId: row.shiftId,
          employeeId: row.employeeId,
          tradingDate: localDate(row.tradingDate),
          period: { startsAt: row.startsAt as Instant, endsAt: row.endsAt as Instant },
        }),
      )
    expect(rostered).toHaveLength(1)
    const summary = summariseWorkedHours({
      shifts: rostered,
      ruleVersions,
      publicHolidays: calendar.dates,
    })
    expect(summary.days[0]?.minutes.publicHoliday).toBe(480)
    const figure = publicHolidayMinutes({ days: summary.days, calendar })
    expect(figure).toEqual({
      basis: 'predicted',
      count: 480,
      openQuestionIds: ['Y9-holiday-calendar'],
    })
    expect(publishHolidayFigure(figure).qualifier).not.toBe('')
  }, 30_000)
})
