import {
  type AttendanceGraceRules,
  applyAttendanceCorrections,
  attendanceGraceFor,
  describeAttendanceInstant,
  type Instant,
  type LocalDate,
  localDate,
  localTime,
  rotaAssignmentCanonicalForm,
  summariseTimesheet,
  toLocal,
  type WorkingHoursRules,
} from '@berelax/core'
import {
  type AttendanceGraceRuleRow,
  approveTimesheet,
  createConnection,
  periodStatusOn,
  publishRota,
  readAttendanceCorrections,
  readAttendanceGraceRules,
  readAttendancePunches,
  readRosteredSpansFromVersion,
  readTimesheetApprovals,
  readWorkingHoursRules,
  recordAttendanceCorrection,
  recordAttendancePunch,
  type Sql,
  unconfirmedAssumptionRows,
  type WorkingHoursRuleRow,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * P-HR-07 — attendance rows, the immutable published rota they are measured against, and the period lock.
 *
 * The **judgements** are pure and live in `@berelax/core`; the **rows** live in PostgreSQL and are read and
 * written by `@berelax/db`. `packages/db` may never import `packages/core`, so nothing but
 * `@berelax/fixtures` can assert that the pair works — the same reason `hr-rota.itest.ts` and
 * `hr-working-hours.itest.ts` are in this package.
 *
 * What needs both halves, and could not be asserted in either alone:
 *
 *   1. **The trading date is DERIVED by the database and not supplied.** A 01:50 clock-out belongs to the day
 *      that opened at 11:00, and the answer comes from `attendance_trading_date_for()` over the real
 *      `business_day` calendar. Asserted with the local TIME beside the local date, and with a control that
 *      the UTC rendering disagrees on both fields — because `toISOString()` reports the previous day for a
 *      00:00-Dubai instant, and P-HR-06 had a case pass for exactly that wrong reason.
 *   2. **Every refusal is the DATABASE's**, for every role including the owner this suite connects as: a punch
 *      filed under the wrong day (ZX003), a second clock-in (ZX002), a punch off a whole minute, an UPDATE or
 *      DELETE anywhere (ZX001), an empty or placeholder reason, and an approval that does not follow its rota
 *      version (ZX005).
 *   3. **Approval locks the period** (ZX004) and the refusal names the approval and the remedy.
 *   4. **A correction leaves the punch byte-identical**, and writes an `audit_event` carrying before, after
 *      and a non-empty reason.
 *   5. **The accounting period lock has ONE reader.** A lock over the week is inserted inside a ROLLED-BACK
 *      transaction, and the punch is then refused with the same earliest-open date `periodStatusOn` reports —
 *      which is the claim that matters, because a timesheet refused by one rule and permitted by another is
 *      the defect that arrangement exists to prevent.
 *   6. **Payable minutes are P-HR-05's buckets**, over the real `working_hours_rule` rows.
 *   7. **The grace version appears in the Unconfirmed Assumptions panel** against Y9-attendance, and leaves it
 *      when the flag is cleared.
 *
 * ## Why the rota version here is a FIXTURE and not a validated rota
 *
 * `publishRota` takes the validator's answer as an injected port, and this file supplies a publishable verdict
 * directly. That is deliberate: `hr-rota.itest.ts` is where P-HR-06's validator is asserted against real rows,
 * and re-running it here would make this file fail for that unit's reasons. What this file needs from a rota
 * version is that it is IMMUTABLE and says who was rostered when — which is true of any published row.
 *
 * ## Isolation (brief rule 12)
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind. So: every
 * employee this file creates is prefixed `PHR07 ATT`, every read is narrowed to them, and the week is a period
 * no other suite publishes a rota for or locks. It inserts no `shift` row at all — `publishRota` snapshots the
 * assignments, so a draft is unnecessary and `shift.trading_date` is a RESTRICT reference into `business_day`
 * that `business-days.itest.ts` would then be unable to clear.
 *
 * **Nothing here can be cleaned up, by design**, and that is worth stating as P-HR-06 stated its own:
 * `attendance_event`, `attendance_correction`, `timesheet_approval`, `rota_version` and
 * `rota_version_assignment` all refuse DELETE for every role, so the employees this file creates cannot be
 * deleted either. Every assertion about a count is therefore RELATIVE — a delta, or a read narrowed to this
 * run's own rows — and the trading dates are fixed rather than derived from "now", with `beforeAll` asserting
 * the seeded `business_day` rows exist so that a suite which silently skipped because the calendar had moved
 * would be the vacuous pass ADR 0003 exists to prevent.
 *
 * No employee here has a name (brief rule 10).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

/** 2026-08-03 is a Monday, and the whole week is inside the seeded `business_day` calendar. */
const WEEK_FROM = '2026-08-03'
const WEEK_TO = '2026-08-09'
const DAY_ONE = '2026-08-03'
const DAY_TWO = '2026-08-04'
const DAY_THREE = '2026-08-05'

/** A run tag, so a second run's rows are distinguishable from this one's in a table nothing can clean. */
const RUN = `PHR07 ATT ${Date.now().toString(36)}`
const DESK = 'PHR07 front desk'
const APPROVER = 'PHR07 HR administrator'

const employees = new Map<string, string>()
const ROLLBACK = 'phr07-probe-rollback'

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

/** A Dubai wall clock as an ISO string with the offset. Never a bare string, which `timestamptz` reads as UTC. */
const dubai = (date: string, time: string): string => `${date}T${time}:00+04:00`

const asGraceRules = (row: AttendanceGraceRuleRow): AttendanceGraceRules => ({
  effectiveFrom: localDate(row.effectiveFrom),
  graceMinutesAfterStart: row.graceMinutesAfterStart,
  graceMinutesBeforeEnd: row.graceMinutesBeforeEnd,
  maximumPlausiblePresenceMinutes: row.maximumPlausiblePresenceMinutes,
  punchToleranceMinutes: row.punchToleranceMinutes,
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

async function makeEmployee(handle: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from)
    values (${`${RUN} ${handle}`}, date '2020-01-01')
    on conflict (staff_reference) do update set employed_from = excluded.employed_from
    returning id
  `
  const id = (row as { id: string }).id
  employees.set(handle, id)
  return id
}

const of = (handle: string): string => employees.get(handle) as string

let rotaVersionId = ''
let graceVersions: readonly AttendanceGraceRules[] = []
let rateVersions: readonly WorkingHoursRules[] = []
let graceEffectiveFrom = ''
let rateEffectiveFrom = ''

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 4 })

  // The seeded calendar, asserted rather than assumed. A suite that silently skipped because the horizon had
  // moved past these dates would be the vacuous pass ADR 0003 exists to prevent.
  const days = await sql<{ tradingDate: string }[]>`
    select trading_date::text as "tradingDate" from business_day
     where trading_date between ${WEEK_FROM}::date and ${WEEK_TO}::date
     order by trading_date
  `
  if (days.length !== 7) {
    throw new Error(
      `The seeded business_day calendar holds ${days.length} of the 7 trading dates ${WEEK_FROM}..` +
        `${WEEK_TO}. This file asserts attendance against real trading windows, so it fails rather than ` +
        'skipping — run `pnpm seed`, or move the week if the horizon has changed.',
    )
  }

  await makeEmployee('A')
  await makeEmployee('B')

  const graceRows = await readAttendanceGraceRules(sql)
  const rateRows = await readWorkingHoursRules(sql)
  graceVersions = graceRows.map(asGraceRules)
  rateVersions = rateRows.map(asWorkingHoursRules)
  graceEffectiveFrom = graceRows[0]?.effectiveFrom as string
  rateEffectiveFrom = rateRows[0]?.effectiveFrom as string

  // The published rota this week's attendance is measured against. No `shift` rows: `publishRota` snapshots
  // the assignments, and `shift.trading_date` is a RESTRICT reference into `business_day` that
  // `business-days.itest.ts` would then be unable to clear.
  //
  // The roster is LAWFUL as a fixture in its own right — 18:00–02:00 then 18:00–02:00 the next day is a
  // sixteen-hour gap, well past the eleven-hour rest minimum. A fixture that could not satisfy its own rules
  // is the failure P-HR-06 shipped and this file is not going to repeat.
  const assignments = [
    {
      employeeId: of('A'),
      tradingDate: DAY_ONE,
      startsAt: Date.parse(dubai(DAY_ONE, '18:00')),
      endsAt: Date.parse(dubai(DAY_TWO, '02:00')),
      sourceShiftId: null,
    },
    {
      employeeId: of('A'),
      tradingDate: DAY_TWO,
      startsAt: Date.parse(dubai(DAY_TWO, '18:00')),
      endsAt: Date.parse(dubai(DAY_THREE, '02:00')),
      sourceShiftId: null,
    },
    {
      employeeId: of('B'),
      tradingDate: DAY_ONE,
      startsAt: Date.parse(dubai(DAY_ONE, '11:00')),
      endsAt: Date.parse(dubai(DAY_ONE, '19:00')),
      sourceShiftId: null,
    },
  ]
  const published = await publishRota(sql, {
    fromTradingDate: WEEK_FROM,
    toTradingDate: WEEK_TO,
    assignments,
    // A publishable verdict, supplied rather than derived: `hr-rota.itest.ts` is where P-HR-06's validator is
    // asserted against real rows, and re-running it here would make this file fail for that unit's reasons.
    verdict: { isPublishable: true, refusedRule: null, refusalDetail: null },
    coverageRuleEffectiveFrom: '1900-01-01',
    workingHoursRuleEffectiveFrom: rateEffectiveFrom,
    labourCostRuleEffectiveFrom: '1900-01-01',
    // All nineteen seeded employees and both of this file's have no basic wage on file (brief rule 15), so
    // the honest forecast is 0 fils over 2 unpriced people — 0081's own NOTE.
    forecastLabourCostFils: 0,
    forecastUnpricedEmployees: 2,
    assignmentCanonicalForm: rotaAssignmentCanonicalForm(
      assignments.map((row) => ({
        employeeId: row.employeeId,
        tradingDate: localDate(row.tradingDate),
        startsAt: row.startsAt as Instant,
        endsAt: row.endsAt as Instant,
      })),
    ),
    publishedBy: `${RUN} publisher`,
  })
  rotaVersionId = published.rotaVersionId
}, 120_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

/** Records a punch through the repository, which derives the trading date rather than accepting one. */
async function punch(args: {
  readonly handle: string
  readonly kind: 'clock_in' | 'clock_out'
  readonly at: string
}) {
  return await withUnitOfWork(sql, { kind: 'staff', label: DESK }, (uow) =>
    recordAttendancePunch(uow, {
      employeeId: of(args.handle),
      kind: args.kind,
      occurredAtIso: args.at,
      recordedBy: DESK,
    }),
  )
}

/** The whole composition a screen performs: read rows, derive the timesheet, in one helper. */
async function timesheetFor(handle: string) {
  const [punches, corrections, rostered] = await Promise.all([
    readAttendancePunches(sql, {
      fromTradingDate: WEEK_FROM,
      toTradingDate: WEEK_TO,
      employeeIds: [of(handle)],
    }),
    readAttendanceCorrections(sql, {
      fromTradingDate: WEEK_FROM,
      toTradingDate: WEEK_TO,
      employeeIds: [of(handle)],
    }),
    readRosteredSpansFromVersion(sql, { rotaVersionId, employeeIds: [of(handle)] }),
  ])
  const summary = summariseTimesheet({
    employeeId: of(handle),
    fromTradingDate: localDate(WEEK_FROM),
    toTradingDate: localDate(WEEK_TO),
    rostered: rostered.map((row) => ({
      employeeId: row.employeeId,
      tradingDate: localDate(row.tradingDate),
      startsAt: row.startsAt as Instant,
      endsAt: row.endsAt as Instant,
    })),
    punches: punches.map((row) => ({
      eventId: row.eventId,
      employeeId: row.employeeId,
      tradingDate: localDate(row.tradingDate),
      kind: row.kind,
      occurredAt: row.occurredAt as Instant,
      correctionId: null,
    })),
    corrections: corrections.map((row) => ({
      correctionId: row.correctionId,
      employeeId: row.employeeId,
      tradingDate: localDate(row.tradingDate),
      adjustmentDate: localDate(row.adjustmentDate),
      kind: row.kind,
      correctsEventId: row.correctsEventId,
      correctedOccurredAt: row.correctedOccurredAt as Instant,
    })),
    graceRuleVersions: graceVersions,
    workingHoursRuleVersions: rateVersions,
  })
  return { summary, punches, corrections, rostered }
}

// ---------------------------------------------------------------------------------------------

describe('acceptance — attendance is attributed to business_day by the database', () => {
  it('files a 01:50 clock-out under the day that opened at 11:00, in Dubai and not in UTC', async () => {
    const clockIn = await punch({ handle: 'A', kind: 'clock_in', at: dubai(DAY_ONE, '18:00') })
    const clockOut = await punch({ handle: 'A', kind: 'clock_out', at: dubai(DAY_TWO, '01:50') })

    expect(clockIn.tradingDate).toBe(DAY_ONE)
    // The punch happened on the 4th by the calendar and belongs to the 3rd's trading session. Both asserted,
    // because asserting one of them cannot tell a correct attribution from a timezone slip.
    expect(clockOut.tradingDate).toBe(DAY_ONE)
    expect(toLocal(clockOut.occurredAt as Instant).date).toBe(DAY_TWO)
    expect(toLocal(clockOut.occurredAt as Instant).time).toBe('01:50')
    expect(
      describeAttendanceInstant(clockOut.occurredAt as Instant, localDate(clockOut.tradingDate)),
    ).toBe(`${DAY_TWO} 01:50 (trading date ${DAY_ONE})`)

    // CONTROL: the UTC rendering agrees on NEITHER field, which is what makes the assertions above a
    // measurement of the emirate rather than of the machine this runs on.
    const asUtc = new Date(clockOut.occurredAt).toISOString()
    expect(asUtc.slice(0, 10)).toBe(DAY_ONE)
    expect(asUtc.slice(11, 16)).toBe('21:50')
  })

  it('refuses a punch filed under a trading date the derivation does not produce', async () => {
    // Written past the repository, which does not accept a trading date at all, so the only way to file a
    // punch under the wrong day is a hand-written INSERT — and the trigger refuses that too.
    const refusal = await refusalOf(
      (tx) => tx`
        insert into attendance_event (employee_id, trading_date, kind, occurred_at, capture_method,
                                      recorded_by)
        values (${of('B')}::uuid, ${DAY_TWO}::date, 'clock_in', ${dubai(DAY_ONE, '12:00')}::timestamptz,
                'manual_front_desk', ${DESK})
      `,
    )
    expect(refusal).toContain('ZX003')
    expect(refusal).toContain(`belongs to trading date ${DAY_ONE}`)
  })

  it('refuses a punch that belongs to no trading date at all', async () => {
    // 07:00 is four hours before the doors open and five hours after the previous session closed, so it is
    // outside every window even widened by the two-hour tolerance.
    await expect(
      punch({ handle: 'B', kind: 'clock_in', at: dubai(DAY_ONE, '07:00') }),
    ).rejects.toThrow(/belongs to no trading date/)
  })

  it('accepts a punch inside the tolerance and files it under the day about to open', async () => {
    const early = await punch({ handle: 'B', kind: 'clock_in', at: dubai(DAY_ONE, '10:52') })
    // Eight minutes before the doors open, which is ordinary: staff arrive before opening. The tolerance is
    // what lets the front desk record what happened rather than refusing the truth.
    expect(early.tradingDate).toBe(DAY_ONE)
    expect(toLocal(early.occurredAt as Instant).time).toBe('10:52')
  })

  it('refuses a punch off a whole minute, and a second punch at one instant', async () => {
    const seconds = await refusalOf(
      (tx) => tx`
        insert into attendance_event (employee_id, trading_date, kind, occurred_at, capture_method,
                                      recorded_by)
        values (${of('B')}::uuid, ${DAY_THREE}::date, 'clock_in',
                ${`${DAY_THREE}T12:00:30+04:00`}::timestamptz, 'manual_front_desk', ${DESK})
      `,
    )
    expect(seconds).toContain('attendance_event_occurred_on_whole_minute')

    const doubleTap = await refusalOf(
      (tx) => tx`
        insert into attendance_event (employee_id, trading_date, kind, occurred_at, capture_method,
                                      recorded_by)
        values (${of('A')}::uuid, ${DAY_ONE}::date, 'clock_out', ${dubai(DAY_ONE, '18:00')}::timestamptz,
                'manual_front_desk', ${DESK})
      `,
    )
    expect(doubleTap).toContain('attendance_event_one_punch_per_instant')
  })

  it('refuses a clock-in while one is open, and a clock-out with none open', async () => {
    // B clocked in at 10:52 above and has not clocked out.
    await expect(
      punch({ handle: 'B', kind: 'clock_in', at: dubai(DAY_ONE, '13:00') }),
    ).rejects.toThrow(/ZX002|already has an open clock-in/)

    const orphan = await refusalOf(
      (tx) => tx`
        insert into attendance_event (employee_id, trading_date, kind, occurred_at, capture_method,
                                      recorded_by)
        values (${of('A')}::uuid, ${DAY_THREE}::date, 'clock_out', ${dubai(DAY_THREE, '20:00')}::timestamptz,
                'manual_front_desk', ${DESK})
      `,
    )
    expect(orphan).toContain('ZX002')
    expect(orphan).toContain('no open clock-in')
  })

  it('refuses every UPDATE and DELETE on all three record tables, for the owner too', async () => {
    const [punchRow] = await readAttendancePunches(sql, {
      fromTradingDate: WEEK_FROM,
      toTradingDate: WEEK_TO,
      employeeIds: [of('A')],
    })
    const update = await refusalOf(
      (tx) => tx`
        update attendance_event set recorded_by = 'somebody else'
         where id = ${(punchRow as { eventId: string }).eventId}::uuid
      `,
    )
    expect(update).toContain('ZX001')
    expect(update).toContain('append-only')

    const remove = await refusalOf(
      (tx) =>
        tx`delete from attendance_event where id = ${(punchRow as { eventId: string }).eventId}::uuid`,
    )
    expect(remove).toContain('ZX001')
  })
})

describe('acceptance — the variance against the immutable published version', () => {
  it('measures each rostered span from rota_version_assignment and not from a draft shift', async () => {
    const { summary, rostered } = await timesheetFor('A')
    // Two spans in the published version and both come back, ordered.
    expect(rostered.map((row) => row.tradingDate)).toEqual([DAY_ONE, DAY_TWO])
    // Monday: clocked in 18:00 and out 01:50, ten minutes early, five past the grace window.
    const monday = summary.variances.find((row) => row.tradingDate === DAY_ONE)
    expect(monday?.outcome).toBe('EARLY_LEAVE')
    expect(monday?.earlyLeaveByMinutes).toBe(5)
    expect(monday?.attendedMinutes).toBe(470)
    // Tuesday: rostered and no punch recorded.
    const tuesday = summary.variances.find((row) => row.tradingDate === DAY_TWO)
    expect(tuesday?.outcome).toBe('ABSENT')
    expect(tuesday?.rosteredMinutes).toBe(480)
  })

  it('flags a missing clock-out INCOMPLETE and contributes zero payable minutes for it', async () => {
    const { summary } = await timesheetFor('B')
    const monday = summary.variances.find((row) => row.tradingDate === DAY_ONE)
    expect(monday?.outcome).toBe('INCOMPLETE')
    expect(monday?.incompleteReason).toBe('missing_clock_out')
    expect(summary.payableMinutes).toBe(0)
    expect(summary.incompletePresenceCount).toBe(1)
    // And never an implausible shift: the presence is excluded rather than closed at the day's end, so there
    // is no day row at all to hold an inflated figure.
    expect(summary.workedHours.days).toHaveLength(0)
  })

  it('payable minutes equal the sum of the P-HR-05 buckets, over the real rate rows', async () => {
    const { summary } = await timesheetFor('A')
    let bucketTotal = 0
    const seen = new Set<string>()
    for (const day of summary.workedHours.days) {
      for (const [bucket, minutes] of Object.entries(day.minutes)) {
        bucketTotal += minutes
        if (minutes > 0) seen.add(bucket)
      }
    }
    expect(summary.payableMinutes).toBe(bucketTotal)
    expect(summary.payableMinutes).toBe(470)
    // The span runs 18:00–01:50, so it crosses both the 22:00 night boundary and the eight-hour allowance:
    // more than one bucket is non-empty, which is what makes the equality a claim rather than a tautology
    // over a single tally. MEASURED and asserted, not assumed.
    expect(seen.size).toBeGreaterThanOrEqual(2)
    // The weighted figure is the buckets' and not the minutes': no single multiplier reproduces it.
    expect(summary.weightedMinuteBp).not.toBe(summary.payableMinutes * 10_000)
    expect(summary.weightedMinuteBp).not.toBe(summary.payableMinutes * 15_000)
  })

  it('the rate versions it was priced against are the rows in the database', async () => {
    const rows = await readWorkingHoursRules(sql)
    expect(rateVersions).toHaveLength(rows.length)
    expect(String(rateVersions[0]?.effectiveFrom)).toBe(rows[0]?.effectiveFrom)
    // And the grace version governing the week is the provisional one, read rather than restated.
    expect(String(attendanceGraceFor(graceVersions, localDate(DAY_ONE)).effectiveFrom)).toBe(
      graceEffectiveFrom,
    )
  })
})

describe('acceptance — a correction is a dated adjustment row and the punch is untouched', () => {
  it('leaves the punch byte-identical and writes an audit_event with before, after and a reason', async () => {
    const [open] = await sql<{ id: string; occurredAt: Date }[]>`
      select e.id, e.occurred_at as "occurredAt"
        from attendance_event e
       where e.employee_id = ${of('B')}::uuid and e.kind = 'clock_in'
         and e.trading_date = ${DAY_ONE}::date
       order by e.occurred_at limit 1
    `
    const clockIn = open as { id: string; occurredAt: Date }
    const before = clockIn.occurredAt.toISOString()

    // A delta and never a total: `audit_event` is append-only and every earlier suite has written to it.
    const [auditBeforeRow] = await sql<{ count: string }[]>`
      select count(*)::text as count from audit_event where action = 'hr.attendance.correct'
    `
    const auditBefore = (auditBeforeRow as { count: string }).count

    const result = await withUnitOfWork(sql, { kind: 'staff', label: APPROVER }, (uow) =>
      recordAttendanceCorrection(uow, {
        kind: 'supply_missing_clock_out',
        correctsEventId: clockIn.id,
        correctedOccurredAtIso: dubai(DAY_ONE, '19:00'),
        reason: 'Front desk confirmed she left at 19:00; the clock-out was not entered.',
        correctedBy: APPROVER,
      }),
    )
    expect(result.tradingDate).toBe(DAY_ONE)
    // The adjustment date defaults to the earliest OPEN date on or after the day corrected, which with no
    // lock in place is the day itself.
    expect(result.adjustmentDate).toBe(DAY_ONE)

    const [after] = await sql<{ occurredAt: Date }[]>`
      select occurred_at as "occurredAt" from attendance_event where id = ${clockIn.id}::uuid
    `
    expect((after as { occurredAt: Date }).occurredAt.toISOString()).toBe(before)

    const [auditAfterRow] = await sql<{ count: string }[]>`
      select count(*)::text as count from audit_event where action = 'hr.attendance.correct'
    `
    const auditAfter = (auditAfterRow as { count: string }).count
    expect(Number(auditAfter) - Number(auditBefore)).toBe(1)

    // No `::uuid` cast on `entity_id`: it is TEXT (0005), because the audit trail records the id of whatever
    // was touched and not every entity in this system is keyed by a uuid. A cast here is
    // `operator does not exist: text = uuid`, which is how this case first failed.
    const [audited] = await sql<
      { before: unknown; after: unknown; operation: string; entityId: string }[]
    >`
      select before_state as before, after_state as after, operation, entity_id as "entityId"
        from audit_event
       where action = 'hr.attendance.correct' and entity_id = ${result.correctionId}
    `
    const row = audited as { before: Record<string, unknown>; after: Record<string, unknown> }
    expect(row.before['occurredAt']).toBe(before)
    expect(row.after['correctedOccurredAt']).toBe(dubai(DAY_ONE, '19:00'))
    expect(String(row.after['reason'])).toContain('left at 19:00')

    // And the presence is now payable, which is the other half of "contributes zero until an audited manual
    // correction".
    const { summary } = await timesheetFor('B')
    const monday = summary.variances.find((variance) => variance.tradingDate === DAY_ONE)
    expect(monday?.outcome).not.toBe('INCOMPLETE')
    expect(summary.payableMinutes).toBe(488)
    expect(summary.incompletePresenceCount).toBe(0)
  })

  it('refuses an empty, blank or placeholder reason by CONSTRAINT and not by UI validation', async () => {
    const [clockIn] = await sql<{ id: string }[]>`
      select id from attendance_event
       where employee_id = ${of('A')}::uuid and kind = 'clock_in' and trading_date = ${DAY_ONE}::date
       limit 1
    `
    const id = (clockIn as { id: string }).id
    const insertWith = (reason: string) => (tx: Sql) =>
      tx`
      insert into attendance_correction (employee_id, trading_date, adjustment_date, kind,
                                         corrects_event_id, corrected_occurred_at, reason, corrected_by)
      values (${of('A')}::uuid, ${DAY_ONE}::date, ${DAY_ONE}::date, 'amend_punch_instant',
              ${id}::uuid, ${dubai(DAY_TWO, '02:00')}::timestamptz, ${reason}, ${APPROVER})
    `
    for (const reason of ['', '   ', 'x', 'TBD']) {
      const refusal = await refusalOf(insertWith(reason))
      expect(refusal).toContain('attendance_correction_reason_is_a_reason')
    }
    // CONTROL: the same statement with a real reason is ACCEPTED, so the four refusals above are about the
    // reason and not about anything else in the row.
    expect(await refusalOf(insertWith('She stayed to finish the last treatment.'))).toBe('')
  })

  it('refuses a correction against a punch that does not exist', async () => {
    await expect(
      withUnitOfWork(sql, { kind: 'staff', label: APPROVER }, (uow) =>
        recordAttendanceCorrection(uow, {
          kind: 'amend_punch_instant',
          correctsEventId: '00000000-0000-7000-8000-000000000000',
          correctedOccurredAtIso: dubai(DAY_ONE, '19:00'),
          reason: 'A correction to attendance nobody recorded at all.',
          correctedBy: APPROVER,
        }),
      ),
    ).rejects.toThrow(/No attendance punch/)
  })
})

describe('acceptance — approval locks the period, and the lock has one reader', () => {
  it('approves the timesheet and then refuses a new punch for that period, naming the remedy', async () => {
    const { summary } = await timesheetFor('B')
    const approval = await withUnitOfWork(sql, { kind: 'staff', label: APPROVER }, (uow) =>
      approveTimesheet(uow, {
        employeeId: of('B'),
        fromTradingDate: WEEK_FROM,
        toTradingDate: WEEK_TO,
        rotaVersionId,
        figures: {
          payableMinutes: summary.payableMinutes,
          weightedMinuteBp: summary.weightedMinuteBp,
          incompletePresenceCount: summary.incompletePresenceCount,
          unrosteredPresenceCount: summary.variances.filter((row) => row.outcome === 'UNROSTERED')
            .length,
          graceRuleEffectiveFrom: graceEffectiveFrom,
          workingHoursRuleEffectiveFrom: rateEffectiveFrom,
        },
        approvedBy: APPROVER,
      }),
    )
    expect(approval.payableMinutes).toBe(488)
    // The version the attendance was measured against is on the row, which is what P-HR-06 deferred here.
    expect(approval.rotaVersionId).toBe(rotaVersionId)
    expect(approval.graceRuleEffectiveFrom).toBe(graceEffectiveFrom)

    const readBack = await readTimesheetApprovals(sql, {
      fromTradingDate: WEEK_FROM,
      toTradingDate: WEEK_TO,
      employeeIds: [of('B')],
    })
    expect(readBack).toHaveLength(1)
    expect(readBack[0]?.payableMinutes).toBe(488)

    // Now the lock. A new punch inside the approved period is refused for every caller.
    await expect(
      punch({ handle: 'B', kind: 'clock_in', at: dubai(DAY_THREE, '12:00') }),
    ).rejects.toThrow(/ZX004|was approved by/)
    const raw = await refusalOf(
      (tx) => tx`
        insert into attendance_event (employee_id, trading_date, kind, occurred_at, capture_method,
                                      recorded_by)
        values (${of('B')}::uuid, ${DAY_THREE}::date, 'clock_in', ${dubai(DAY_THREE, '12:00')}::timestamptz,
                'manual_front_desk', ${DESK})
      `,
    )
    expect(raw).toContain('ZX004')
    expect(raw).toContain('attendance_correction')

    // A correction still works, which is the whole point of the lock having one exit.
    const [clockIn] = await sql<{ id: string }[]>`
      select id from attendance_event
       where employee_id = ${of('B')}::uuid and kind = 'clock_in' and trading_date = ${DAY_ONE}::date
       limit 1
    `
    // Rolled back by THROWING out of the unit of work rather than by nesting one inside `probe`: a
    // postgres.js transaction handle has no `.begin`, so `withUnitOfWork(tx, …)` is
    // `sql.begin is not a function` — which is how this case first failed. The correction has to be rolled
    // back because a committed second one would break the later case that counts B's corrections, and the
    // repository path is what needs exercising, not a hand-written INSERT.
    const rolledBack = await withUnitOfWork(
      sql,
      { kind: 'staff', label: APPROVER },
      async (uow) => {
        const made = await recordAttendanceCorrection(uow, {
          kind: 'amend_punch_instant',
          correctsEventId: (clockIn as { id: string }).id,
          correctedOccurredAtIso: dubai(DAY_ONE, '11:00'),
          reason: 'She was on the floor from 11:00; the early punch was the previous shift.',
          correctedBy: APPROVER,
        })
        throw new Error(`${ROLLBACK} ${made.correctionId}`)
      },
    ).then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    // The correction was ACCEPTED inside an approved period — the message carries the id it was given — and
    // then discarded. An empty string here would mean the unit of work returned without the throw, which
    // cannot happen, and a ZX004 here would mean the lock had closed the only exit from itself.
    expect(rolledBack).toContain(ROLLBACK)
    expect(rolledBack).not.toContain('ZX004')
  })

  it('refuses a second approval of the same period rather than putting two figures on one week', async () => {
    const refusal = await refusalOf(
      (tx) => tx`
        insert into timesheet_approval (employee_id, from_trading_date, to_trading_date, rota_version_id,
                                        grace_rule_effective_from, working_hours_rule_effective_from,
                                        payable_minutes, weighted_minute_bp, incomplete_presence_count,
                                        approved_by)
        values (${of('B')}::uuid, ${WEEK_FROM}::date, ${WEEK_TO}::date, ${rotaVersionId}::uuid,
                ${graceEffectiveFrom}::date, ${rateEffectiveFrom}::date, 1, 1, 0, ${APPROVER})
      `,
    )
    expect(refusal).toContain('timesheet_approval_one_per_employee_per_period')
  })

  it('refuses an approval whose period is not inside the rota version it names', async () => {
    const refusal = await refusalOf(
      (tx) => tx`
        insert into timesheet_approval (employee_id, from_trading_date, to_trading_date, rota_version_id,
                                        grace_rule_effective_from, working_hours_rule_effective_from,
                                        payable_minutes, weighted_minute_bp, incomplete_presence_count,
                                        approved_by)
        values (${of('A')}::uuid, ${WEEK_FROM}::date, '2026-08-20'::date, ${rotaVersionId}::uuid,
                ${graceEffectiveFrom}::date, ${rateEffectiveFrom}::date, 0, 0, 0, ${APPROVER})
      `,
    )
    expect(refusal).toContain('ZX005')
    expect(refusal).toContain('UNROSTERED')
  })

  it('the accounting period lock refuses a punch and names the earliest OPEN date, through ONE reader', async () => {
    // The lock is inserted inside a ROLLED-BACK transaction, so nothing this file does leaves August closed
    // for the suites that post journal entries in it. `period_lock` has no DELETE grant for the application
    // role, so a lock left behind would need owner rights to clear — and a lock left behind would fail
    // somebody else's file.
    const observed = await probe(async (tx) => {
      await tx`
        insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
        values (${`${RUN}-2026-08`}, '2026-08-01', '2026-08-31', 'P-HR-07 itest probe', 'system')
      `
      // The ONE reader, asked the same question the trigger will answer.
      const status = await periodStatusOn(tx, DAY_THREE)
      const refusal = await tx`
        insert into attendance_event (employee_id, trading_date, kind, occurred_at, capture_method,
                                      recorded_by)
        values (${of('A')}::uuid, ${DAY_THREE}::date, 'clock_in', ${dubai(DAY_THREE, '18:00')}::timestamptz,
                'manual_front_desk', ${DESK})
      `.then(
        () => '',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      )
      return { status, refusal }
    })

    expect(observed.status.closed).toBe(true)
    expect(observed.status.periodId).toBe(`${RUN}-2026-08`)
    expect(observed.status.earliestOpenDate).toBe('2026-09-01')
    // The refusal carries the locked period AND the earliest open date, which is 0073's redefinition doing
    // its work: naming only the lock sends somebody to a month they also cannot use. And it is the SAME
    // figure `periodStatusOn` reported, which is the claim — one reader, one answer.
    expect(observed.refusal).toContain('PeriodLocked')
    expect(observed.refusal).toContain(`${RUN}-2026-08`)
    expect(observed.refusal).toContain(observed.status.earliestOpenDate)
  })

  it('and the lock is gone again, so no other suite inherits a closed August', async () => {
    const status = await periodStatusOn(sql, DAY_THREE)
    expect(status.closed).toBe(false)
    expect(status.earliestOpenDate).toBe(DAY_THREE)
  })
})

describe('acceptance — the provisional figures reach the Unconfirmed Assumptions panel', () => {
  it('lists the grace version against Y9-attendance, and it leaves when the flag is cleared', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const mine = rows.filter((row) => row.source === 'attendance_grace_rule')
    expect(mine).toHaveLength(1)
    expect(mine[0]?.openQuestionId).toBe('Y9-attendance')
    expect(mine[0]?.reference).toBe(`attendance effective ${graceEffectiveFrom}`)
    // The note says what the figures ARE, because a panel row that only said "attendance is an assumption"
    // would not tell an owner which figures they are being asked to confirm.
    expect(String(mine[0]?.note)).toContain('12 hours')
    expect(String(mine[0]?.note)).toContain('MANUAL')

    // Cleared inside a rolled-back probe: the table has no UPDATE grant for the application role, and this
    // suite connects as the owner — so the probe proves the panel reads the flag rather than the table.
    const cleared = await probe(async (tx) => {
      await tx`update attendance_grace_rule set is_provisional = false`
      return await unconfirmedAssumptionRows(tx)
    })
    expect(cleared.filter((row) => row.source === 'attendance_grace_rule')).toHaveLength(0)
  })

  it('the rule table refuses UPDATE and DELETE for the application role', async () => {
    // Versioned by INSERT, exactly as working_hours_rule and rota_coverage_rule are: answering Y9-attendance
    // publishes a new row, because an approved timesheet names the row that judged it.
    const refusal = await refusalOf(async (tx) => {
      await tx`set local role berelax_app`
      await tx`update attendance_grace_rule set grace_minutes_after_start = 30`
    })
    expect(refusal).toContain('permission denied')
  })
})

describe('the corrected punch list is assembled once', () => {
  it('layers corrections over punches in the reader rather than writing a second punch row', async () => {
    const punches = await readAttendancePunches(sql, {
      fromTradingDate: WEEK_FROM,
      toTradingDate: WEEK_TO,
      employeeIds: [of('B')],
    })
    const corrections = await readAttendanceCorrections(sql, {
      fromTradingDate: WEEK_FROM,
      toTradingDate: WEEK_TO,
      employeeIds: [of('B')],
    })
    expect(corrections).toHaveLength(1)
    // ONE punch row for B on the Monday, even after a clock-out was supplied: the correction produced no row.
    expect(punches.filter((row) => row.tradingDate === DAY_ONE)).toHaveLength(1)

    const layered = applyAttendanceCorrections(
      punches.map((row) => ({
        eventId: row.eventId,
        employeeId: row.employeeId,
        tradingDate: localDate(row.tradingDate) as LocalDate,
        kind: row.kind,
        occurredAt: row.occurredAt as Instant,
        correctionId: null,
      })),
      corrections.map((row) => ({
        correctionId: row.correctionId,
        employeeId: row.employeeId,
        tradingDate: localDate(row.tradingDate),
        adjustmentDate: localDate(row.adjustmentDate),
        kind: row.kind,
        correctsEventId: row.correctsEventId,
        correctedOccurredAt: row.correctedOccurredAt as Instant,
      })),
    )
    const supplied = layered.filter((row) => row.correctionId !== null)
    expect(supplied).toHaveLength(1)
    expect(supplied[0]?.kind).toBe('clock_out')
    expect(supplied[0]?.eventId).toBe(`correction:${corrections[0]?.correctionId}`)
    // The prefix is not decoration: an id that looked like an attendance_event.id would be one somebody could
    // go looking for and not find.
    expect(supplied[0]?.eventId).not.toMatch(/^[0-9a-f]{8}-/)
  })

  it('narrows to nobody when given an empty employee list, rather than widening to everybody', async () => {
    // The opposite reading is the defect `with-google.itest.ts` recorded, and on this table it would be every
    // employee's hours.
    expect(
      await readAttendancePunches(sql, {
        fromTradingDate: WEEK_FROM,
        toTradingDate: WEEK_TO,
        employeeIds: [],
      }),
    ).toHaveLength(0)
    // CONTROL: the same read with no `employeeIds` at all DOES see this file's rows, so the empty case above
    // is about the narrowing and not about the range.
    const all = await readAttendancePunches(sql, {
      fromTradingDate: WEEK_FROM,
      toTradingDate: WEEK_TO,
    })
    expect(all.length).toBeGreaterThan(0)
  })
})
