import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { periodStatusOn } from '../services/period-close.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * Attendance and the timesheet: the punches, the dated corrections, and the approval that locks a period.
 *
 * The **judgements** are `packages/core/src/hr/attendance.ts`'s and stay there — `packages/db` must never
 * import `packages/core` — so this module returns ROWS and never an outcome, a variance or a payable figure.
 * `packages/fixtures/src/hr-attendance.itest.ts` is the one place that may import both and is where the pair
 * is asserted to work, the same arrangement `hr-rota.itest.ts` and `hr-working-hours.itest.ts` have.
 *
 * ## The period lock is read in ONE place, and that place is not here
 *
 * "Is this date inside a closed accounting period?" is {@link periodStatusOn} (M-VAT-06), over
 * `period_lock_for()` and `earliest_open_date_from()`. Every function here that writes a dated row calls it,
 * and none of them re-answers it — a timesheet refused by one rule and permitted by another is exactly the
 * defect that arrangement exists to prevent.
 *
 * The check is made HERE *as well as* by the database triggers, and the reason is the MESSAGE rather than the
 * rule. `raise_if_period_locked()` raises ZL002 with the locked period and the earliest open date in a
 * sentence; reading `periodStatusOn` first lets the refusal carry both as DATA, so a screen can render them
 * and a caller can act on them without parsing a string. `openCashSession` (0076) and `postDatedCorrection`
 * (0073) have the same arrangement for the same reason, and the trigger remains the authority: a close that
 * only this module checked is a close a `psql` session walks through.
 *
 * ## Why {@link approveTimesheet} takes the figures rather than computing them
 *
 * A PORT, exactly as `publishRota`'s `RotaVerdict` is one. The payable minutes are P-HR-05's bucket total
 * over the attended presences, computed by `summariseTimesheet` in `@berelax/core`, and this package may not
 * import it. So the figures arrive typed and the row records them — which means a caller who never derived
 * anything has to write numbers into named fields, a lie somebody can find in a diff rather than a call
 * somebody forgot to make.
 *
 * ## What the database enforces without help from here
 *
 *   1. **A punch's trading date is the one there is one definition of** — `assert_attendance_trading_date`
 *      (ZX003) against `attendance_trading_date_for()`. {@link recordAttendancePunch} does not accept a
 *      trading date at all: it reads the same function, so there is nothing for a caller to get wrong.
 *   2. **Punches alternate** — `assert_attendance_punch_alternates` (ZX002), which is what makes INCOMPLETE
 *      mean exactly one thing.
 *   3. **An approved period takes no new punches** — `assert_attendance_period_not_approved` (ZX004), with no
 *      exemption, because a correction changes an approved period without inserting into that table.
 *   4. **Nothing here is editable** — `refuse_attendance_change` (ZX001) for every role including the owner.
 *      No function in this module issues an UPDATE against any of the three tables, and if one did the
 *      database would refuse it.
 */

/** The SQLSTATEs `0086_attendance.sql` raises. Class 'ZX'; every letter to 'ZW' was taken. */
export const ATTENDANCE_SQLSTATE = {
  /** Append-only: UPDATE or DELETE on attendance_event, attendance_correction, timesheet_approval. */
  immutable: 'ZX001',
  /** A clock-in while one is open, or a clock-out with none open. */
  punchesMustAlternate: 'ZX002',
  /** The trading date is not the one `attendance_trading_date_for()` derives, or names no business day. */
  wrongTradingDate: 'ZX003',
  /** The period is closed by an approved timesheet. */
  periodApproved: 'ZX004',
  /** The approval does not follow its rota version: wrong period, or the version is superseded. */
  approvalDoesNotFollow: 'ZX005',
} as const

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertIsoDate(value: string, what: string): void {
  if (!ISO_DATE.test(value)) {
    throw new AppError(
      'validation',
      `${what} must be an ISO trading date (YYYY-MM-DD), got "${value}"`,
    )
  }
}

/** A closed period refused as `forbidden`, carrying the earliest OPEN date as data rather than as text. */
async function assertPeriodOpen(sql: Sql, on: string, what: string): Promise<void> {
  const status = await periodStatusOn(sql, on)
  if (!status.closed) return
  throw new AppError(
    'forbidden',
    `AttendancePeriodLocked: cannot record ${what} dated ${on}; accounting period ` +
      `"${String(status.periodId)}" is locked. The earliest open date is ${status.earliestOpenDate}. A ` +
      'correction to a closed period is an attendance_correction whose adjustment_date falls on or after ' +
      'that date, which leaves the original punch saying what it always said.',
    {
      details: {
        sqlState: 'ZL002',
        periodId: status.periodId,
        earliestOpenDate: status.earliestOpenDate,
      },
    },
  )
}

// ---------------------------------------------------------------------------------------------
// The rule table
// ---------------------------------------------------------------------------------------------

/** One version of `attendance_grace_rule`. Structurally `AttendanceGraceRules` in `@berelax/core`. */
export interface AttendanceGraceRuleRow {
  readonly effectiveFrom: string
  readonly graceMinutesAfterStart: number
  readonly graceMinutesBeforeEnd: number
  readonly maximumPlausiblePresenceMinutes: number
  readonly punchToleranceMinutes: number
  readonly captureMethod: string
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly provisionalNote: string | null
  readonly sourceNote: string
}

/**
 * Every version of the attendance figures, oldest first.
 *
 * Every version and not the current one, which is the whole point of the table: the derivation picks the row
 * governing each trading date, so a day judged in March keeps March's grace window after April widens it. A
 * "current row" read here would undo the versioning one layer up.
 *
 * An empty answer throws rather than returning `[]`, for `readWorkingHoursRules`'s reason: attendance judged
 * against no window is attendance nothing was ever measured against, and a screen showing every day as on
 * time is worse than a screen showing an error.
 */
export async function readAttendanceGraceRules(
  sql: Sql,
): Promise<readonly AttendanceGraceRuleRow[]> {
  const rows = await sql<AttendanceGraceRuleRow[]>`
    select effective_from::text                   as "effectiveFrom",
           grace_minutes_after_start              as "graceMinutesAfterStart",
           grace_minutes_before_end               as "graceMinutesBeforeEnd",
           maximum_plausible_presence_minutes     as "maximumPlausiblePresenceMinutes",
           punch_tolerance_minutes                as "punchToleranceMinutes",
           capture_method                         as "captureMethod",
           is_provisional                         as "isProvisional",
           open_question_id                       as "openQuestionId",
           provisional_note                       as "provisionalNote",
           source_note                            as "sourceNote"
      from attendance_grace_rule
     order by effective_from
  `
  if (rows.length === 0) {
    throw new AppError(
      'invariant_violated',
      'No attendance grace rule version exists, so how late is late, how long a presence may plausibly be ' +
        'and how far outside its trading day a punch may fall are all unknown. 0086 seeds version 1 flagged ' +
        'provisional against Y9-attendance; an empty table means the row was deleted. Attendance measured ' +
        'against no window is attendance nothing refused.',
    )
  }
  return rows
}

// ---------------------------------------------------------------------------------------------
// Reading what happened
// ---------------------------------------------------------------------------------------------

export interface AttendancePunchRow {
  readonly eventId: string
  readonly employeeId: string
  readonly tradingDate: string
  readonly kind: 'clock_in' | 'clock_out'
  /** Epoch milliseconds, which is what `Instant` in `@berelax/core` is. */
  readonly occurredAt: number
  readonly recordedAt: number
  readonly captureMethod: string
  readonly recordedBy: string
}

export interface TradingDateRange {
  readonly fromTradingDate: string
  readonly toTradingDate: string
}

/**
 * Every punch in a range, ordered by employee, trading date and instant.
 *
 * Narrowed by `employeeIds` when given, and an EMPTY array means "nobody" rather than "everybody". The
 * opposite reading is the defect `with-google.itest.ts` recorded: a filter that silently widens when its list
 * is empty turns a narrowed read into a whole-table read, and on this table that is every employee's hours.
 */
export async function readAttendancePunches(
  sql: Sql,
  args: TradingDateRange & { readonly employeeIds?: readonly string[] },
): Promise<readonly AttendancePunchRow[]> {
  assertIsoDate(args.fromTradingDate, 'fromTradingDate')
  assertIsoDate(args.toTradingDate, 'toTradingDate')
  if (args.employeeIds !== undefined && args.employeeIds.length === 0) return []
  const rows = await sql<
    (Omit<AttendancePunchRow, 'occurredAt' | 'recordedAt'> & {
      occurredAt: Date
      recordedAt: Date
    })[]
  >`
    select id              as "eventId",
           employee_id     as "employeeId",
           trading_date::text as "tradingDate",
           kind,
           occurred_at     as "occurredAt",
           recorded_at     as "recordedAt",
           capture_method  as "captureMethod",
           recorded_by     as "recordedBy"
      from attendance_event
     where trading_date between ${args.fromTradingDate}::date and ${args.toTradingDate}::date
       and (${args.employeeIds ?? null}::uuid[] is null or employee_id = any(${args.employeeIds ?? null}::uuid[]))
     order by employee_id, trading_date, occurred_at, id
  `
  return rows.map((row) => ({
    ...row,
    occurredAt: row.occurredAt.getTime(),
    recordedAt: row.recordedAt.getTime(),
  }))
}

export interface AttendanceCorrectionRow {
  readonly correctionId: string
  readonly employeeId: string
  readonly tradingDate: string
  readonly adjustmentDate: string
  readonly kind: 'supply_missing_clock_out' | 'amend_punch_instant'
  readonly correctsEventId: string
  readonly correctedOccurredAt: number
  readonly reason: string
  readonly correctedBy: string
  readonly correctedAt: number
}

/**
 * Every correction ABOUT a trading date in the range, ordered by employee, trading date and instant.
 *
 * Filtered on `trading_date` — the day the correction is about — and never on `adjustment_date`, which is by
 * design in a LATER period. Filtering on the adjustment date would drop every correction to a closed month,
 * which is the only kind of correction there is once a month closes.
 */
export async function readAttendanceCorrections(
  sql: Sql,
  args: TradingDateRange & { readonly employeeIds?: readonly string[] },
): Promise<readonly AttendanceCorrectionRow[]> {
  assertIsoDate(args.fromTradingDate, 'fromTradingDate')
  assertIsoDate(args.toTradingDate, 'toTradingDate')
  if (args.employeeIds !== undefined && args.employeeIds.length === 0) return []
  const rows = await sql<
    (Omit<AttendanceCorrectionRow, 'correctedOccurredAt' | 'correctedAt'> & {
      correctedOccurredAt: Date
      correctedAt: Date
    })[]
  >`
    select id                   as "correctionId",
           employee_id          as "employeeId",
           trading_date::text   as "tradingDate",
           adjustment_date::text as "adjustmentDate",
           kind,
           corrects_event_id    as "correctsEventId",
           corrected_occurred_at as "correctedOccurredAt",
           reason,
           corrected_by         as "correctedBy",
           corrected_at         as "correctedAt"
      from attendance_correction
     where trading_date between ${args.fromTradingDate}::date and ${args.toTradingDate}::date
       and (${args.employeeIds ?? null}::uuid[] is null or employee_id = any(${args.employeeIds ?? null}::uuid[]))
     order by employee_id, trading_date, corrected_occurred_at, id
  `
  return rows.map((row) => ({
    ...row,
    correctedOccurredAt: row.correctedOccurredAt.getTime(),
    correctedAt: row.correctedAt.getTime(),
  }))
}

/** The rostered spans a timesheet is measured against, straight from the PUBLISHED version. */
export interface RosteredSpanRow {
  readonly employeeId: string
  readonly tradingDate: string
  readonly startsAt: number
  readonly endsAt: number
}

/**
 * The published rota's assignments for one employee, as spans.
 *
 * Reads `rota_version_assignment` and NOT `shift`, which is the whole of P-HR-06's deferral: the draft is
 * rewritten freely (0030), so a variance measured against it would change after the fact — move a Tuesday
 * shift next month and a therapist who was on time becomes an hour late on a day already paid. The version is
 * immutable, so the answer this returns for a period is the same answer for ever.
 */
export async function readRosteredSpansFromVersion(
  sql: Sql,
  args: { readonly rotaVersionId: string; readonly employeeIds?: readonly string[] },
): Promise<readonly RosteredSpanRow[]> {
  if (args.employeeIds !== undefined && args.employeeIds.length === 0) return []
  const rows = await sql<
    { employeeId: string; tradingDate: string; startsAt: Date; endsAt: Date }[]
  >`
    select employee_id        as "employeeId",
           trading_date::text as "tradingDate",
           lower(period)      as "startsAt",
           upper(period)      as "endsAt"
      from rota_version_assignment
     where rota_version_id = ${args.rotaVersionId}::uuid
       and (${args.employeeIds ?? null}::uuid[] is null or employee_id = any(${args.employeeIds ?? null}::uuid[]))
     order by employee_id, trading_date, lower(period)
  `
  return rows.map((row) => ({
    employeeId: row.employeeId,
    tradingDate: row.tradingDate,
    startsAt: row.startsAt.getTime(),
    endsAt: row.endsAt.getTime(),
  }))
}

export interface TimesheetApprovalRow {
  readonly id: string
  readonly employeeId: string
  readonly fromTradingDate: string
  readonly toTradingDate: string
  readonly rotaVersionId: string
  readonly graceRuleEffectiveFrom: string
  readonly workingHoursRuleEffectiveFrom: string
  readonly payableMinutes: number
  readonly weightedMinuteBp: number
  readonly incompletePresenceCount: number
  readonly unrosteredPresenceCount: number
  readonly approvedBy: string
  readonly approvedAt: Date
}

const APPROVAL_COLUMNS = (sql: Sql) => sql`
  id,
  employee_id                          as "employeeId",
  from_trading_date::text              as "fromTradingDate",
  to_trading_date::text                as "toTradingDate",
  rota_version_id                      as "rotaVersionId",
  grace_rule_effective_from::text      as "graceRuleEffectiveFrom",
  working_hours_rule_effective_from::text as "workingHoursRuleEffectiveFrom",
  payable_minutes                      as "payableMinutes",
  weighted_minute_bp::text             as "weightedMinuteBp",
  incomplete_presence_count            as "incompletePresenceCount",
  unrostered_presence_count            as "unrosteredPresenceCount",
  approved_by                          as "approvedBy",
  approved_at                          as "approvedAt"
`

type RawApproval = Omit<TimesheetApprovalRow, 'weightedMinuteBp'> & { weightedMinuteBp: string }

// `weighted_minute_bp` is a bigint and the driver hands it back as a string precisely so nothing rounds it.
// Number() rather than BigInt(), for `forecast_labour_cost_fils`'s reason one table along: the figure is
// bounded by minutes in a period times a multiplier, which cannot reach 2^53, and a bigint on the boundary of
// this module would make every arithmetic caller of it a bigint caller too.
const toApproval = (row: RawApproval): TimesheetApprovalRow => ({
  ...row,
  weightedMinuteBp: Number(row.weightedMinuteBp),
})

/** Every approval overlapping a range, ordered by employee then period. */
export async function readTimesheetApprovals(
  sql: Sql,
  args: TradingDateRange & { readonly employeeIds?: readonly string[] },
): Promise<readonly TimesheetApprovalRow[]> {
  assertIsoDate(args.fromTradingDate, 'fromTradingDate')
  assertIsoDate(args.toTradingDate, 'toTradingDate')
  if (args.employeeIds !== undefined && args.employeeIds.length === 0) return []
  const rows = await sql<RawApproval[]>`
    select ${APPROVAL_COLUMNS(sql)}
      from timesheet_approval
     where from_trading_date <= ${args.toTradingDate}::date
       and to_trading_date >= ${args.fromTradingDate}::date
       and (${args.employeeIds ?? null}::uuid[] is null or employee_id = any(${args.employeeIds ?? null}::uuid[]))
     order by employee_id, from_trading_date, to_trading_date
  `
  return rows.map(toApproval)
}

// ---------------------------------------------------------------------------------------------
// Writing what happened
// ---------------------------------------------------------------------------------------------

export interface RecordPunchInput {
  readonly employeeId: string
  readonly kind: 'clock_in' | 'clock_out'
  /** The instant the punch happened, ISO 8601 with an offset. Whole-minute, or the database refuses it. */
  readonly occurredAtIso: string
  /** `manual_front_desk` today, which is Y9-attendance's provisional answer and the only member. */
  readonly captureMethod?: string
  readonly recordedBy: string
}

/**
 * Records one punch, inside `uow`'s transaction, deriving its trading date rather than accepting one.
 *
 * **It takes no trading date, and that is the point.** `attendance_trading_date_for()` is the one definition
 * of which day a punch belongs to, the insert trigger checks the column against it, and a caller that could
 * pass a date could pass a wrong one — which moves paid hours between weeks while every total still balances.
 * So the value is read from the same function the trigger calls, in the same transaction, and there is no
 * second reading to disagree with.
 *
 * A punch belonging to no trading date is refused HERE as well as by ZX003, for `assertPeriodOpen`'s reason:
 * the message can then say what the caller should do about it.
 */
export async function recordAttendancePunch(
  uow: UnitOfWork,
  input: RecordPunchInput,
): Promise<AttendancePunchRow> {
  if (input.kind !== 'clock_in' && input.kind !== 'clock_out') {
    throw new AppError('validation', `A punch is a clock_in or a clock_out, got "${input.kind}"`)
  }

  const [derived] = await uow.sql<{ tradingDate: string | null }[]>`
    select attendance_trading_date_for(${input.occurredAtIso}::timestamptz)::text as "tradingDate"
  `
  const tradingDate = derived?.tradingDate ?? null
  if (tradingDate === null) {
    throw new AppError(
      'validation',
      `A punch at ${input.occurredAtIso} belongs to no trading date: no business_day window contains it, ` +
        'even widened by the grace version’s punch tolerance. Either the premises did not trade that ' +
        'session or the calendar has not been generated that far ahead — and recording attendance on a day ' +
        'with no trading would put hours on a session that never happened.',
      { details: { sqlState: ATTENDANCE_SQLSTATE.wrongTradingDate } },
    )
  }

  await assertPeriodOpen(
    uow.sql,
    tradingDate,
    `the ${input.kind} punch for employee ${input.employeeId}`,
  )

  const [row] = await uow.sql<
    (Omit<AttendancePunchRow, 'occurredAt' | 'recordedAt'> & {
      occurredAt: Date
      recordedAt: Date
    })[]
  >`
    insert into attendance_event (
      employee_id, trading_date, kind, occurred_at, capture_method, recorded_by
    ) values (
      ${input.employeeId}::uuid, ${tradingDate}::date, ${input.kind},
      ${input.occurredAtIso}::timestamptz, ${input.captureMethod ?? 'manual_front_desk'},
      ${input.recordedBy}
    )
    returning id as "eventId", employee_id as "employeeId", trading_date::text as "tradingDate",
              kind, occurred_at as "occurredAt", recorded_at as "recordedAt",
              capture_method as "captureMethod", recorded_by as "recordedBy"
  `
  if (!row) throw new AppError('invariant_violated', 'insert into attendance_event returned no row')

  await uow.audit.record({
    action: 'hr.attendance.punch',
    entityType: 'attendance_event',
    entityId: row.eventId,
    operation: 'create',
    after: {
      employeeId: row.employeeId,
      tradingDate: row.tradingDate,
      kind: row.kind,
      occurredAt: row.occurredAt.toISOString(),
      captureMethod: row.captureMethod,
      recordedBy: row.recordedBy,
    },
  })

  return { ...row, occurredAt: row.occurredAt.getTime(), recordedAt: row.recordedAt.getTime() }
}

export interface RecordCorrectionInput {
  readonly kind: 'supply_missing_clock_out' | 'amend_punch_instant'
  /** The punch this is about. A supplied clock-out names the clock-in it closes. */
  readonly correctsEventId: string
  readonly correctedOccurredAtIso: string
  /**
   * The date the adjustment is POSTED on. Must fall in an OPEN accounting period.
   *
   * Defaulted to the earliest open date on or after the corrected day rather than to "today", which is the
   * arrangement `postDatedCorrection` has: a correction posted on today's date would land in a closed period
   * whenever somebody corrects last month after this month closed too, and the refusal would name a date the
   * caller never chose.
   */
  readonly adjustmentDate?: string
  readonly reason: string
  readonly correctedBy: string
}

export interface AttendanceCorrectionResult {
  readonly correctionId: string
  readonly tradingDate: string
  readonly adjustmentDate: string
}

/**
 * Records a dated correction against a punch, inside `uow`'s transaction. The punch is untouched.
 *
 * This is the acceptance criterion's "a correction inserts a dated adjustment row while the original row is
 * unchanged", and "unchanged" is literal in the strongest sense available: no UPDATE is issued, ZX001 would
 * refuse one, and no second punch row is written either (0086's comment on `corrected_occurred_at` says why).
 * `applyAttendanceCorrections` in `@berelax/core` layers the row over the punches when the timesheet is read.
 *
 * The `audit_event` carries BEFORE and AFTER — the punch's instant as recorded, and the instant the
 * correction says it is — which is the other half of the criterion. The reason is on the row, refused by
 * three CHECK constraints rather than by UI validation alone, and it is repeated into the audit row because
 * an audit trail whose reason lives only in another table is a trail with a join in it.
 */
export async function recordAttendanceCorrection(
  uow: UnitOfWork,
  input: RecordCorrectionInput,
): Promise<AttendanceCorrectionResult> {
  const [punch] = await uow.sql<
    { employeeId: string; tradingDate: string; kind: string; occurredAt: Date }[]
  >`
    select employee_id as "employeeId", trading_date::text as "tradingDate", kind,
           occurred_at as "occurredAt"
      from attendance_event where id = ${input.correctsEventId}::uuid
  `
  if (!punch) {
    throw new AppError(
      'not_found',
      `No attendance punch ${input.correctsEventId} to correct. A correction names the punch it is about ` +
        '(`corrects_event_id` is NOT NULL and a foreign key), because attendance nobody recorded at all is ' +
        'not something a correction can invent.',
    )
  }
  if (input.kind === 'supply_missing_clock_out' && punch.kind !== 'clock_in') {
    throw new AppError(
      'validation',
      `A supplied clock-out closes a CLOCK-IN, and punch ${input.correctsEventId} is a ${punch.kind}. ` +
        'Supplying one against a clock-out would put two ends on one presence, which pairs into nonsense.',
    )
  }

  // The earliest OPEN date on or after the day being corrected, which is what makes the default right rather
  // than merely convenient: a correction to March filed in May, after April closed too, posts in May.
  const status = await periodStatusOn(uow.sql, punch.tradingDate)
  const adjustmentDate = input.adjustmentDate ?? status.earliestOpenDate
  assertIsoDate(adjustmentDate, 'adjustmentDate')
  if (adjustmentDate < punch.tradingDate) {
    throw new AppError(
      'validation',
      `An adjustment dated ${adjustmentDate} cannot correct a day that had not happened yet ` +
        `(${punch.tradingDate}). The adjustment date is when the correction was made, not when the work was.`,
    )
  }
  await assertPeriodOpen(
    uow.sql,
    adjustmentDate,
    `the attendance correction for employee ${punch.employeeId} on ${punch.tradingDate}`,
  )

  const [row] = await uow.sql<{ id: string }[]>`
    insert into attendance_correction (
      employee_id, trading_date, adjustment_date, kind, corrects_event_id,
      corrected_occurred_at, reason, corrected_by
    ) values (
      ${punch.employeeId}::uuid, ${punch.tradingDate}::date, ${adjustmentDate}::date, ${input.kind},
      ${input.correctsEventId}::uuid, ${input.correctedOccurredAtIso}::timestamptz,
      ${input.reason}, ${input.correctedBy}
    )
    returning id
  `
  if (!row) {
    throw new AppError('invariant_violated', 'insert into attendance_correction returned no row')
  }

  await uow.audit.record({
    action: 'hr.attendance.correct',
    entityType: 'attendance_correction',
    entityId: row.id,
    operation: 'create',
    // The punch AS RECORDED, which is what "before" has to mean here: the punch row is never edited, so this
    // is the only place the two instants appear side by side and the only way to see what changed.
    before: {
      attendanceEventId: input.correctsEventId,
      employeeId: punch.employeeId,
      tradingDate: punch.tradingDate,
      kind: punch.kind,
      occurredAt: punch.occurredAt.toISOString(),
    },
    after: {
      kind: input.kind,
      correctedOccurredAt: input.correctedOccurredAtIso,
      adjustmentDate,
      reason: input.reason,
      correctedBy: input.correctedBy,
    },
  })

  return { correctionId: row.id, tradingDate: punch.tradingDate, adjustmentDate }
}

/**
 * The figures a timesheet is approved on, injected.
 *
 * A PORT, because `packages/db` may not import `packages/core` and every one of these is that package's
 * answer. `summariseTimesheet` produces all five together, and they are required rather than optional for
 * `RotaVerdict`'s reason: a caller who never derived anything has to write numbers into named fields, which
 * is a lie somebody can find in a diff rather than a call somebody forgot to make.
 */
export interface TimesheetFigures {
  /** `sum(summariseWorkedHours().days[].totalMinutes)` over the ATTENDED presences. */
  readonly payableMinutes: number
  readonly weightedMinuteBp: number
  readonly incompletePresenceCount: number
  readonly unrosteredPresenceCount: number
  /** The grace version that judged it, as `attendance_grace_rule.effective_from`. */
  readonly graceRuleEffectiveFrom: string
  /** The rate version that priced it, as `working_hours_rule.effective_from`. */
  readonly workingHoursRuleEffectiveFrom: string
}

export interface ApproveTimesheetArgs extends TradingDateRange {
  readonly employeeId: string
  /** The PUBLISHED version the attendance was measured against. ZX005 refuses a superseded one. */
  readonly rotaVersionId: string
  readonly figures: TimesheetFigures
  readonly approvedBy: string
}

/**
 * Approves one employee's timesheet for a period, which LOCKS it.
 *
 * After this returns, `assert_attendance_period_not_approved` (ZX004) refuses a new punch for that employee
 * and period for every caller, including a `psql` session — and the only way to change what the period says
 * is {@link recordAttendanceCorrection}, whose row is dated in an OPEN accounting period.
 *
 * Every figure comes from the injected port and none is recomputed here. The two rule versions are recorded
 * as PLAIN DATES: what a reader wants from them is which standard applied, and a reference from a row that
 * can never be deleted would pin the rule table for ever (0081's lesson, and 0086's header restates it).
 */
export async function approveTimesheet(
  uow: UnitOfWork,
  args: ApproveTimesheetArgs,
): Promise<TimesheetApprovalRow> {
  assertIsoDate(args.fromTradingDate, 'fromTradingDate')
  assertIsoDate(args.toTradingDate, 'toTradingDate')
  if (args.toTradingDate < args.fromTradingDate) {
    throw new AppError(
      'validation',
      `A timesheet period ends (${args.toTradingDate}) before it starts (${args.fromTradingDate})`,
    )
  }
  for (const [name, value] of [
    ['payableMinutes', args.figures.payableMinutes],
    ['weightedMinuteBp', args.figures.weightedMinuteBp],
    ['incompletePresenceCount', args.figures.incompletePresenceCount],
    ['unrosteredPresenceCount', args.figures.unrosteredPresenceCount],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new AppError(
        'validation',
        `Timesheet figure ${name} must be a whole number and not negative, got ${value}. Minutes and ` +
          'basis-point-minutes are integers throughout (ADR 0007 applied to time rather than to money).',
      )
    }
  }

  // The period the approval covers, not the day it is made on: a timesheet for a closed month must not be
  // approvable at all, because the figures it carries are what payroll pays out of a period already filed.
  await assertPeriodOpen(
    uow.sql,
    args.toTradingDate,
    `the timesheet approval for employee ${args.employeeId}`,
  )

  const [row] = await uow.sql<RawApproval[]>`
    insert into timesheet_approval (
      employee_id, from_trading_date, to_trading_date, rota_version_id,
      grace_rule_effective_from, working_hours_rule_effective_from,
      payable_minutes, weighted_minute_bp, incomplete_presence_count, unrostered_presence_count,
      approved_by
    ) values (
      ${args.employeeId}::uuid, ${args.fromTradingDate}::date, ${args.toTradingDate}::date,
      ${args.rotaVersionId}::uuid,
      ${args.figures.graceRuleEffectiveFrom}::date, ${args.figures.workingHoursRuleEffectiveFrom}::date,
      ${args.figures.payableMinutes}, ${args.figures.weightedMinuteBp},
      ${args.figures.incompletePresenceCount}, ${args.figures.unrosteredPresenceCount},
      ${args.approvedBy}
    )
    returning ${APPROVAL_COLUMNS(uow.sql)}
  `
  if (!row) {
    throw new AppError('invariant_violated', 'insert into timesheet_approval returned no row')
  }
  const approval = toApproval(row)

  await uow.audit.record({
    action: 'hr.timesheet.approve',
    entityType: 'timesheet_approval',
    entityId: approval.id,
    operation: 'create',
    after: {
      employeeId: approval.employeeId,
      fromTradingDate: approval.fromTradingDate,
      toTradingDate: approval.toTradingDate,
      rotaVersionId: approval.rotaVersionId,
      payableMinutes: approval.payableMinutes,
      weightedMinuteBp: approval.weightedMinuteBp,
      incompletePresenceCount: approval.incompletePresenceCount,
      unrosteredPresenceCount: approval.unrosteredPresenceCount,
      graceRuleEffectiveFrom: approval.graceRuleEffectiveFrom,
      workingHoursRuleEffectiveFrom: approval.workingHoursRuleEffectiveFrom,
      approvedBy: approval.approvedBy,
    },
  })

  return approval
}

/** Translates an attendance refusal into an `AppError`, or `null` when it is not one of ours. */
export function attendanceError(err: unknown): AppError | null {
  const code =
    typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
      ? ((err as { code: string }).code as string)
      : null
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case ATTENDANCE_SQLSTATE.wrongTradingDate:
    case ATTENDANCE_SQLSTATE.punchesMustAlternate:
    case ATTENDANCE_SQLSTATE.approvalDoesNotFollow:
      // `validation`, not `conflict`: the request describes something that cannot have happened, and a
      // caller told it was a conflict would retry it.
      return new AppError('validation', message, { details: { sqlState: code } })
    case ATTENDANCE_SQLSTATE.periodApproved:
    case ATTENDANCE_SQLSTATE.immutable:
      // `forbidden`: the request is well formed and the period is settled. A caller told this was validation
      // would change the times rather than file the correction that is the actual remedy.
      return new AppError('forbidden', message, { details: { sqlState: code } })
    default:
      return null
  }
}
