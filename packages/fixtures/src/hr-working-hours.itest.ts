import {
  type Instant,
  type LocalDate,
  localDate,
  localTime,
  publicHolidayTradingDates,
  type RosteredShift,
  summariseWorkedHours,
  toLocal,
  tradingWeekStart,
  type WorkingHoursRules,
  workedMinutes,
} from '@berelax/core'
import {
  createConnection,
  readPublicHolidayClosures,
  readRosteredShifts,
  readWorkingHoursRules,
  type Sql,
  unconfirmedAssumptionRows,
  type WorkingHoursRuleRow,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * P-HR-05 — the shift rows, the business day they hang off, the rate table and the maths, joined.
 *
 * The **arithmetic** is pure and lives in `@berelax/core`; the **rows** live in PostgreSQL and are read by
 * `@berelax/db`. `packages/db` may never import `packages/core`, so nothing but `@berelax/fixtures` can
 * assert that the pair works — the same reason `hr-credentials.itest.ts` is in this package.
 *
 * Six claims need both halves:
 *
 *   1. **A 18:00–02:00 shift belongs to the business day that opened at 11:00 on the EARLIER calendar
 *      date**, asserted in both directions: from the shift to the day (its `trading_date` resolves,
 *      through the foreign key, to a `business_day` whose `opens_at` is 11:00 on the earlier date) and
 *      from the day to the shifts (querying the trading date returns it, and querying the calendar date
 *      it ends on returns nothing). Either direction alone passes for an implementation that files every
 *      shift under the date it ends on.
 *   2. **No fixture can invent a date the premises does not trade on.** `shift.trading_date` is a foreign
 *      key, and the refusal is asserted rather than assumed.
 *   3. **The multipliers come from the row.** The split of a real shift is computed from the real rate
 *      table and compared against minutes worked out by hand.
 *   4. **Weekly aggregation keys on `business_day`**: a 23:00 Friday to 02:00 Saturday shift counts wholly
 *      in Friday's week, over rows that made the round trip through `tstzrange` and back.
 *   5. **A rest breach names both shift ids**, over two real rows whose gap crosses midnight.
 *   6. **Every figure is listed by the Unconfirmed Assumptions panel** against Y9-overtime, and leaves it
 *      when the flag is cleared.
 *
 * ## Isolation (brief rule 12)
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind. So
 * every read is narrowed to the two employees this file creates, their staff references are prefixed
 * `PHR05 HOURS`, and every shift this file inserts is deleted in `afterAll` — a shift left behind would
 * put an uncredentialled therapist on the roster of whichever availability suite runs next. Nothing here
 * deletes a row it did not create, and the two probes that change the rate table or the closure calendar
 * run inside a transaction that is rolled back.
 *
 * The trading dates are fixed rather than derived from "now", and `beforeAll` asserts the seeded
 * `business_day` rows for them exist: a suite that silently skipped because the calendar had moved would
 * be the vacuous pass ADR 0003 exists to prevent. No employee here has a name (brief rule 10).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

/** 2026-06-01 is a Monday, 2026-06-05 a Friday, 2026-06-06 a Saturday. All inside the seeded calendar. */
const MONDAY = '2026-06-01'
const TUESDAY = '2026-06-02'
const FRIDAY = '2026-06-05'
const SATURDAY = '2026-06-06'

/** `employee.id` by handle, and `shift.id` by handle. */
const employees = new Map<string, string>()
const shifts = new Map<string, string>()

/** Thrown to roll a probe back. Any error rolls `sql.begin` back; a named one cannot be mistaken. */
const ROLLBACK = 'phr05-probe-rollback'

async function probe<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  let carried: T | undefined
  try {
    await sql.begin(async (tx) => {
      carried = await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK) throw err
  }
  return carried as T
}

/** The message a statement was refused with, or '' when it was accepted. Always rolled back. */
async function refusalOf(body: (tx: Sql) => Promise<unknown>): Promise<string> {
  try {
    await sql.begin(async (tx) => {
      await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
    return ''
  } catch (err) {
    if (err instanceof Error && err.message === ROLLBACK) return ''
    return err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err)
  }
}

async function makeEmployee(handle: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from)
    values (${`PHR05 HOURS ${handle}`}, date '2020-01-01')
    on conflict (staff_reference) do update set employed_from = excluded.employed_from
    returning id
  `
  const id = (row as { id: string }).id
  employees.set(handle, id)
  return id
}

/** Rosters one employee on one trading date, `[from, to)` as instants built from local wall-clock times. */
async function roster(args: {
  handle: string
  employee: string
  tradingDate: string
  fromDate: string
  fromTime: string
  toDate: string
  toTime: string
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period)
    values (${args.tradingDate}::date,
            tstzrange((${`${args.fromDate} ${args.fromTime}:00+04`})::timestamptz,
                      (${`${args.toDate} ${args.toTime}:00+04`})::timestamptz, '[)'))
    returning id
  `
  const id = (row as { id: string }).id
  await sql`
    insert into shift_assignment (shift_id, employee_id)
    values (${id}, ${employees.get(args.employee) as string})
  `
  shifts.set(args.handle, id)
  return id
}

/** The rate table's rows in the shape the pure arithmetic takes. */
const asRules = (row: WorkingHoursRuleRow): WorkingHoursRules => ({
  effectiveFrom: localDate(row.effectiveFrom),
  ordinaryMinutesPerDay: row.ordinaryMinutesPerDay,
  ordinaryMinutesPerWeek: row.ordinaryMinutesPerWeek,
  weekStartsOn: row.weekStartsOn,
  overtimeDailyCapMinutes: row.overtimeDailyCapMinutes,
  minimumRestMinutes: row.minimumRestMinutes,
  nightWindow: {
    from: localTime(row.nightWindowFrom),
    until: localTime(row.nightWindowUntil),
  },
  multiplierBp: {
    ordinary: row.ordinaryMultiplierBp,
    overtime: row.overtimeMultiplierBp,
    night: row.nightMultiplierBp,
    publicHoliday: row.publicHolidayMultiplierBp,
  },
})

/** Repository rows in the shape the pure arithmetic takes. */
const asRosteredShifts = (
  rows: readonly {
    shiftId: string
    employeeId: string
    tradingDate: string
    startsAt: number
    endsAt: number
  }[],
): readonly RosteredShift[] =>
  rows.map((row) => ({
    shiftId: row.shiftId,
    employeeId: row.employeeId,
    tradingDate: localDate(row.tradingDate),
    period: { startsAt: row.startsAt as Instant, endsAt: row.endsAt as Instant },
  }))

async function readMine(fromTradingDate: string, toTradingDate: string) {
  return readRosteredShifts(sql, {
    fromTradingDate,
    toTradingDate,
    employeeIds: [...employees.values()],
  })
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  const days = await sql<{ tradingDate: string }[]>`
    select trading_date::text as "tradingDate" from business_day
     where trading_date = any(${[MONDAY, TUESDAY, FRIDAY, SATURDAY]}::date[])
     order by trading_date
  `
  if (days.length !== 4) {
    throw new Error(
      `business_day is missing one of ${MONDAY}, ${TUESDAY}, ${FRIDAY}, ${SATURDAY} (found ` +
        `${days.length}). The fixture calendar is seeded around FIXTURE_TODAY; if that moved, move ` +
        'these dates with it rather than letting this file skip.',
    )
  }

  await makeEmployee('a')
  await makeEmployee('b')
  // A shift that crosses midnight: 18:00 Monday to 02:00 Tuesday, filed under MONDAY.
  await roster({
    handle: 'monday-night',
    employee: 'a',
    tradingDate: MONDAY,
    fromDate: MONDAY,
    fromTime: '18:00',
    toDate: TUESDAY,
    toTime: '02:00',
  })
  // The next morning's shift, nine hours after the one above ended.
  await roster({
    handle: 'tuesday-day',
    employee: 'a',
    tradingDate: TUESDAY,
    fromDate: TUESDAY,
    fromTime: '11:00',
    toDate: TUESDAY,
    toTime: '19:00',
  })
  // The week case: 23:00 Friday to 02:00 Saturday, filed under FRIDAY.
  await roster({
    handle: 'friday-night',
    employee: 'b',
    tradingDate: FRIDAY,
    fromDate: FRIDAY,
    fromTime: '23:00',
    toDate: SATURDAY,
    toTime: '02:00',
  })
})

afterAll(async () => {
  // Every shift this file created, and nothing else. `shift_assignment` cascades from `shift`.
  if (sql !== undefined && shifts.size > 0) {
    await sql`delete from shift where id = any(${[...shifts.values()]}::uuid[])`
  }
  await sql?.end({ timeout: 5 })
})

describe('a shift that crosses midnight and the business day it belongs to', () => {
  it('hangs off the day that opened at 11:00 on the EARLIER calendar date', async () => {
    const [row] = await readMine(MONDAY, MONDAY)
    expect(row?.shiftId).toBe(shifts.get('monday-night'))
    const shift = row as NonNullable<typeof row>

    // 480 minutes, from instants. Not 02:00 minus 18:00.
    expect(
      workedMinutes({ startsAt: shift.startsAt as Instant, endsAt: shift.endsAt as Instant }),
    ).toBe(480)

    // Shift -> business_day. The trading date is Monday and the day it names opened at 11:00 on Monday.
    expect(shift.tradingDate).toBe(MONDAY)
    expect(toLocal(shift.dayOpensAt as Instant)).toEqual({
      date: MONDAY,
      time: '11:00',
    })
    // And the day closes at 02:00 on TUESDAY, which is what makes the shift fit inside it.
    expect(toLocal(shift.dayClosesAt as Instant)).toEqual({ date: TUESDAY, time: '02:00' })
    expect(shift.startsAt).toBeGreaterThanOrEqual(shift.dayOpensAt)
    expect(shift.endsAt).toBeLessThanOrEqual(shift.dayClosesAt)

    // The thing that makes all of the above worth asserting: the shift ENDS on the next calendar date.
    // An implementation that filed a shift under the date it ends on would put this one on Tuesday, and
    // every figure derived from it would still look ordinary.
    expect(toLocal(shift.endsAt as Instant).date).toBe(TUESDAY)
  })

  it('does not come back when the CALENDAR date it ends on is queried', async () => {
    // business_day -> shifts, and the control on the direction above. Tuesday's trading date holds the
    // 11:00-19:00 shift and does not hold the one that merely finished at 02:00 that morning.
    const onTuesday = await readMine(TUESDAY, TUESDAY)
    expect(onTuesday.map((row) => row.shiftId)).toEqual([shifts.get('tuesday-day')])
    expect(onTuesday.map((row) => row.shiftId)).not.toContain(shifts.get('monday-night'))
  })

  it('cannot be filed under a date the premises does not trade on', async () => {
    const message = await refusalOf(
      (tx) => tx`
        insert into shift (trading_date, period)
        values (date '1999-01-01',
                tstzrange(timestamptz '1999-01-01 18:00:00+04',
                          timestamptz '1999-01-02 02:00:00+04', '[)'))
      `,
    )
    expect(message).toContain('shift_trading_date_fkey')
  })

  it('accepts the same shift on a date the premises DOES trade on, which is the control', async () => {
    const accepted = await refusalOf(
      (tx) => tx`
        insert into shift (trading_date, period)
        values (${SATURDAY}::date,
                tstzrange((${`${SATURDAY} 18:00:00+04`})::timestamptz,
                          (${'2026-06-07 02:00:00+04'})::timestamptz, '[)'))
      `,
    )
    expect(accepted).toBe('')
  })
})

describe('the rate table drives the split', () => {
  it('carries the provisional figures 0059 seeds, read back from the database', async () => {
    const [version] = await readWorkingHoursRules(sql)
    const row = version as WorkingHoursRuleRow
    expect(row.effectiveFrom).toBe('1900-01-01')
    expect(row.ordinaryMinutesPerDay).toBe(480)
    expect(row.ordinaryMinutesPerWeek).toBe(2880)
    expect(row.weekStartsOn).toBe(1)
    expect(row.overtimeDailyCapMinutes).toBe(120)
    expect(row.minimumRestMinutes).toBe(660)
    expect(row.nightWindowFrom).toBe('22:00')
    expect(row.nightWindowUntil).toBe('04:00')
    expect(row.ordinaryMultiplierBp).toBe(10_000)
    expect(row.overtimeMultiplierBp).toBe(12_500)
    expect(row.nightMultiplierBp).toBe(15_000)
    expect(row.publicHolidayMultiplierBp).toBe(15_000)
    expect(row.isProvisional).toBe(true)
    expect(row.openQuestionId).toBe('Y9-overtime')
  })

  it('splits the real 18:00-02:00 row into 240 ordinary and 240 night minutes', async () => {
    const versions = (await readWorkingHoursRules(sql)).map(asRules)
    const rows = await readMine(MONDAY, MONDAY)
    const summary = summariseWorkedHours({ shifts: asRosteredShifts(rows), ruleVersions: versions })
    const [day] = summary.days
    // 18:00-22:00 is 240 minutes outside the night window; 22:00-02:00 is 240 inside [22:00, 04:00).
    expect(day?.totalMinutes).toBe(480)
    expect(day?.minutes.ordinary).toBe(240)
    expect(day?.minutes.night).toBe(240)
    expect(day?.minutes.overtime).toBe(0)
    expect(day?.minutes.publicHoliday).toBe(0)
    // 240 x 10000 + 240 x 15000 = 6,000,000 basis-point-minutes.
    expect(day?.weightedMinuteBp).toBe(6_000_000)
    // The day is exactly the ordinary allowance, so nothing breached the cap.
    expect(summary.violations.filter((v) => v.kind === 'daily_overtime_cap')).toEqual([])
  })

  it('throws rather than inventing rates when the table is empty', async () => {
    const message = await probe(async (tx) => {
      await tx`delete from working_hours_rule`
      try {
        await readWorkingHoursRules(tx)
        return ''
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    })
    expect(message).toContain('No working-hours rule version exists')
    // The control: the row is back, because the probe rolled back.
    expect((await readWorkingHoursRules(sql)).length).toBeGreaterThan(0)
  })

  it('refuses a read argument that would quietly widen the query', async () => {
    await expect(
      readRosteredShifts(sql, {
        fromTradingDate: MONDAY,
        toTradingDate: MONDAY,
        employeeIds: [],
      }),
    ).rejects.toThrow(/empty employee list/)
    await expect(
      readRosteredShifts(sql, { fromTradingDate: FRIDAY, toTradingDate: MONDAY }),
    ).rejects.toThrow(/ends before it starts/)
  })
})

describe('weekly aggregation keys on the business day', () => {
  it('counts a 23:00 Friday to 02:00 Saturday shift wholly in Friday’s week', async () => {
    const versions = (await readWorkingHoursRules(sql)).map(asRules)
    const rows = (await readMine(FRIDAY, SATURDAY)).filter(
      (row) => row.shiftId === shifts.get('friday-night'),
    )
    expect(rows).toHaveLength(1)
    // It ends on Saturday by the calendar, and Saturday is a trading date of its own.
    expect(toLocal(rows[0]?.endsAt as Instant).date).toBe(SATURDAY)
    expect(rows[0]?.tradingDate).toBe(FRIDAY)

    const summary = summariseWorkedHours({ shifts: asRosteredShifts(rows), ruleVersions: versions })
    expect(summary.weeks).toHaveLength(1)
    const week = summary.weeks[0]
    expect(week?.weekStartTradingDate).toBe(tradingWeekStart(localDate(FRIDAY), 1))
    expect(week?.weekStartTradingDate).toBe(MONDAY)
    // All 180 minutes in one week. A calendar-date key would leave 60 here and move 120 to the next week.
    expect(week?.totalMinutes).toBe(180)
    expect(week?.tradingDates).toEqual([FRIDAY])
    expect(summary.weeks.map((w) => w.weekStartTradingDate)).not.toContain('2026-06-08')
  })

  it('pays the whole shift at the holiday rate when FRIDAY is the holiday, and none when Saturday is', async () => {
    const versions = (await readWorkingHoursRules(sql)).map(asRules)
    const rows = (await readMine(FRIDAY, SATURDAY)).filter(
      (row) => row.shiftId === shifts.get('friday-night'),
    )

    const splitWith = async (holidayOn: string) =>
      probe(async (tx) => {
        await tx`
          insert into premises_closure (starts_on, ends_on, reason, kind, is_confirmed)
          values (${holidayOn}::date, ${holidayOn}::date, 'PHR05 probe', 'public_holiday', false)
        `
        const closures = await readPublicHolidayClosures(tx, {
          fromDate: FRIDAY,
          toDate: SATURDAY,
        })
        return summariseWorkedHours({
          shifts: asRosteredShifts(rows),
          ruleVersions: versions,
          publicHolidays: publicHolidayTradingDates(
            closures.map((closure) => ({
              startsOn: localDate(closure.startsOn),
              endsOn: localDate(closure.endsOn),
              kind: closure.kind,
              isConfirmed: closure.isConfirmed,
            })),
          ) as ReadonlySet<LocalDate>,
        })
      })

    const holidayIsFriday = await splitWith(FRIDAY)
    expect(holidayIsFriday.days[0]?.minutes.publicHoliday).toBe(180)

    // 120 of those 180 minutes fall on Saturday by the calendar. The trading date is Friday, so a
    // Saturday holiday pays nothing here — and a per-minute calendar reading would report 120.
    const holidayIsSaturday = await splitWith(SATURDAY)
    expect(holidayIsSaturday.days[0]?.minutes.publicHoliday).toBe(0)
    expect(holidayIsSaturday.days[0]?.minutes.night).toBe(180)
  })
})

describe('the rest period between two real shifts', () => {
  it('names both shift ids when the gap across midnight is under the minimum', async () => {
    const versions = (await readWorkingHoursRules(sql)).map(asRules)
    const rows = (await readMine(MONDAY, TUESDAY)).filter(
      (row) => row.employeeId === employees.get('a'),
    )
    const summary = summariseWorkedHours({ shifts: asRosteredShifts(rows), ruleVersions: versions })
    // Monday's shift ends at 02:00 on Tuesday; Tuesday's starts at 11:00. Nine hours, against eleven.
    expect(summary.violations.filter((v) => v.kind === 'minimum_rest')).toEqual([
      {
        kind: 'minimum_rest',
        employeeId: employees.get('a'),
        earlierShiftId: shifts.get('monday-night'),
        laterShiftId: shifts.get('tuesday-day'),
        gapMinutes: 540,
        minimumMinutes: 660,
      },
    ])
  })

  it('reports nothing for the employee with one shift, which is the control', async () => {
    const versions = (await readWorkingHoursRules(sql)).map(asRules)
    const rows = (await readMine(MONDAY, SATURDAY)).filter(
      (row) => row.employeeId === employees.get('b'),
    )
    const summary = summariseWorkedHours({ shifts: asRosteredShifts(rows), ruleVersions: versions })
    expect(summary.violations).toEqual([])
  })
})

describe('the Unconfirmed Assumptions panel', () => {
  it('lists the rate table against Y9-overtime, with a note that says nothing is confirmed', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const listed = rows.filter((row) => row.source === 'working_hours_rule')
    expect(listed.map((row) => row.reference)).toEqual(['rules effective 1900-01-01'])
    expect(listed[0]?.openQuestionId).toBe('Y9-overtime')
    expect(listed[0]?.note ?? '').toContain('none is confirmed')
  })

  it('drops the row the moment the flag is cleared, which is the control', async () => {
    const afterConfirming = await probe(async (tx) => {
      await tx`
        update working_hours_rule
           set is_provisional = false, open_question_id = null, provisional_note = null
      `
      const listed = await unconfirmedAssumptionRows(tx)
      return listed.filter((row) => row.source === 'working_hours_rule')
    })
    expect(afterConfirming).toEqual([])
    // And the seeded state is back, because the probe rolled back.
    expect(
      (await unconfirmedAssumptionRows(sql)).filter((row) => row.source === 'working_hours_rule'),
    ).toHaveLength(1)
  })
})
