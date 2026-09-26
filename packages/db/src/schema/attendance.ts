import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { rotaVersion } from './hr.ts'
import { employee } from './staff.ts'

/**
 * Drizzle mirror of the four tables `packages/db/migrations/0086_attendance.sql` creates.
 *
 * A file of its own rather than four more tables in `./hr.ts`, and the reason is the subject rather than the
 * size: `./hr.ts` mirrors the ROSTER — who the business employs and what it intends them to work — and these
 * four are the record of what actually happened and what was paid for it. The two are read by different code
 * and change for different reasons, and 0086's header turns on that distinction the whole way through.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`.
 *
 * **Every table here is append-only.** `refuse_attendance_change` (ZX001) refuses UPDATE and DELETE on all
 * three record tables for every role including the owner, which Drizzle cannot express — so nothing in
 * `packages/db` issues an UPDATE against them, and if something did the database would refuse it. A
 * correction is a new dated row.
 */

/**
 * Versioned attendance figures (0086).
 *
 * Versioned rather than held in `app_setting` for `workingHoursRule`'s and `rotaCoverageRule`'s reason, and
 * this is the sharpest instance of it: attendance is asked about the PAST more insistently than anything else
 * in this build, so widening the grace window in April must not make March's lateness retroactively disappear.
 * `timesheetApproval` snapshots `graceRuleEffectiveFrom`, so an approved timesheet records "this attendance
 * was on time against THESE windows" rather than "this attendance was on time" — and only the first stays
 * true.
 */
export const attendanceGraceRule = pgTable(
  'attendance_grace_rule',
  {
    effectiveFrom: date('effective_from').primaryKey(),
    /** Minutes after the rostered start a clock-in may be and still be ON_TIME. */
    graceMinutesAfterStart: smallint('grace_minutes_after_start').notNull(),
    /**
     * Minutes before the rostered end a clock-out may be and still be ON_TIME. A separate figure from the
     * arrival grace although version 1 carries the same 5: how long a client may be kept waiting and how
     * early the floor may be left are different questions, and one column would mean confirming one figure
     * also restated the other.
     */
    graceMinutesBeforeEnd: smallint('grace_minutes_before_end').notNull(),
    /**
     * The span above which a clock-in and a clock-out are not believed to be one presence. A forgotten
     * clock-out closed the next morning would otherwise be paid as an eighteen-hour shift; instead the span
     * is INCOMPLETE and contributes zero payable minutes until an audited correction says what happened.
     */
    maximumPlausiblePresenceMinutes: smallint('maximum_plausible_presence_minutes').notNull(),
    /**
     * How far outside its trading day's window a punch may fall and still be attributed to it. Bounded at 240
     * by the CHECK, because one day's 02:00 close and the next day's 11:00 open are nine hours apart and a
     * wider tolerance would make two days' widened windows overlap — a punch in the overlap would belong to
     * two trading dates with nothing able to choose.
     */
    punchToleranceMinutes: smallint('punch_tolerance_minutes').notNull(),
    /** `manual_front_desk`, which is Y9-attendance's provisional answer: no biometric and no device. */
    captureMethod: text('capture_method').notNull(),
    isProvisional: boolean('is_provisional').notNull().default(true),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    sourceNote: text('source_note').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'attendance_grace_rule_start_grace_plausible',
      sql`${t.graceMinutesAfterStart} between 0 and 120`,
    ),
    check(
      'attendance_grace_rule_end_grace_plausible',
      sql`${t.graceMinutesBeforeEnd} between 0 and 120`,
    ),
    check(
      'attendance_grace_rule_plausible_span_is_a_span',
      sql`${t.maximumPlausiblePresenceMinutes} between 1 and 1440`,
    ),
    check(
      'attendance_grace_rule_tolerance_cannot_overlap_two_days',
      sql`${t.punchToleranceMinutes} between 0 and 240`,
    ),
    check(
      'attendance_grace_rule_capture_method_known',
      sql`${t.captureMethod} in ('manual_front_desk')`,
    ),
    check(
      'attendance_grace_rule_provisional_names_a_question',
      sql`not ${t.isProvisional} or ${t.openQuestionId} is not null`,
    ),
    check(
      'attendance_grace_rule_source_note_not_placeholder',
      sql`not is_placeholder_text(${t.sourceNote})`,
    ),
  ],
)

/**
 * One attendance punch, append-only (0086).
 *
 * A pair of rows rather than a presence row with a nullable clock-out, and that is forced rather than chosen:
 * filling a clock-out in later is an UPDATE, which ZX001 refuses. So INCOMPLETE is a SHAPE — a clock-in with
 * nothing after it — instead of a null every reader has to remember to check.
 *
 * Four triggers are not expressible in Drizzle and live in the migration: `assert_attendance_trading_date`
 * (ZX003) refuses a `tradingDate` that `attendance_trading_date_for()` does not derive or that `business_day`
 * does not hold, `assert_attendance_punch_alternates` (ZX002) refuses a clock-in while one is open,
 * `assert_attendance_period_not_approved` (ZX004) refuses a punch inside an approved period, and
 * `attendance_event_period_guard` calls `raise_if_period_locked()` for the accounting lock.
 * `packages/fixtures/src/hr-attendance.itest.ts` asserts all of them against real PostgreSQL.
 */
export const attendanceEvent = pgTable(
  'attendance_event',
  {
    id: uuid('id').primaryKey(),
    /**
     * A KEY, and the one reference in this file that pins a parent anybody might otherwise delete. 0030
     * already decided that deleting a person to erase their roster is the delete worth refusing, and this is
     * the stronger case: the row is the evidence of what somebody worked, which is the input to their pay.
     */
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /**
     * Materialised by `attendance_trading_date_for()` and deliberately NOT foreign-keyed into `business_day`.
     * That table is GENERATED — `generateBusinessDays` deletes a row when a date stops trading and
     * `business-days.itest.ts` empties the whole table in a `beforeEach` — and nothing here can ever be
     * deleted, so a RESTRICT reference would pin every date named for ever, for every caller, from the first
     * punch recorded. That is the failure P-HR-06 found in eleven cases of another unit's suite.
     *
     * `cash_session.trading_date` IS such a key (0076) and the difference is the mechanism rather than the
     * meaning: a cash session can be deleted to release the pin and its own suite releases it. The guard
     * therefore lives at INSERT, where the row is still fixable.
     */
    tradingDate: date('trading_date').notNull(),
    /** `clock_in` or `clock_out`. */
    kind: text('kind').notNull(),
    /**
     * On a whole minute, refused otherwise. `workedMinutes` in `@berelax/core` refuses a span that is not,
     * because rounding one creates or destroys paid time by a few seconds per shift — so seconds admitted
     * here would surface as a thrown pricing call on a screen rather than as a rejected punch at the desk.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /**
     * When the front desk typed it, as against `occurredAt`, when it happened. Both, because the gap between
     * them is the only signal that a punch was entered after the fact.
     */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    captureMethod: text('capture_method').notNull(),
    /** A label, not a uuid: there is no admin session until W-SYS-01 and the audit row carries the actor. */
    recordedBy: text('recorded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // Two punches at one instant is a double-tap on the admin device. It pairs into a zero-length presence,
    // which `workedMinutes` refuses — so this turns a mis-click at the desk into a refusal at the desk.
    uniqueIndex('attendance_event_one_punch_per_instant').on(t.employeeId, t.occurredAt),
    index('attendance_event_employee_day_idx').on(t.employeeId, t.tradingDate, t.occurredAt),
    index('attendance_event_day_idx').on(t.tradingDate, t.occurredAt),
    check('attendance_event_kind_known', sql`${t.kind} in ('clock_in', 'clock_out')`),
    check(
      'attendance_event_occurred_on_whole_minute',
      sql`date_trunc('minute', ${t.occurredAt}) = ${t.occurredAt}`,
    ),
    check(
      'attendance_event_capture_method_known',
      sql`${t.captureMethod} in ('manual_front_desk')`,
    ),
    check(
      'attendance_event_recorded_by_not_placeholder',
      sql`not is_placeholder_text(${t.recordedBy}) and btrim(${t.recordedBy}) <> ''`,
    ),
  ],
)

/**
 * One approved timesheet, append-only (0086), and the lock it puts on a period.
 *
 * After it exists, a new `attendanceEvent` for that employee and period is refused (ZX004) for every caller
 * including a `psql` session, and the only way to change what the period says is a dated
 * `attendanceCorrection` — the journal rule from 0018 applied to hours rather than to money.
 */
export const timesheetApproval = pgTable(
  'timesheet_approval',
  {
    id: uuid('id').primaryKey(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /**
     * Inclusive at both ends, because a trading date is a whole session and a half-open date range invites
     * the off-by-one that drops the last day. NOT foreign-keyed into `business_day`: the period is a LABEL
     * for what was approved and its ends may fall on a closed date.
     */
    fromTradingDate: date('from_trading_date').notNull(),
    toTradingDate: date('to_trading_date').notNull(),
    /**
     * The published rota the attendance was measured against. A KEY, which is what P-HR-06 deferred here in
     * its own words — the immutable version exists to be compared against — and a PRECONDITION rather than
     * provenance: a plain column would let a timesheet be approved against a version nobody published, which
     * is the after-the-fact variance the immutability was built to prevent. The pin costs nothing because
     * `rotaVersion` can never be deleted either (ZW001), which is the case 0081 describes for its own
     * self-references.
     */
    rotaVersionId: uuid('rota_version_id')
      .notNull()
      .references(() => rotaVersion.id, { onDelete: 'restrict' }),
    /**
     * The two rule versions that judged and priced it. Plain dates and NOT foreign keys, which is 0081's
     * decision verbatim: a row in an immutable table records what was true and holds nothing else hostage,
     * and `hr-working-hours.itest.ts` empties `working_hours_rule` inside a rolled-back probe to prove
     * P-HR-05's reader throws rather than inventing rates.
     */
    graceRuleEffectiveFrom: date('grace_rule_effective_from').notNull(),
    workingHoursRuleEffectiveFrom: date('working_hours_rule_effective_from').notNull(),
    /**
     * P-HR-05's bucket total over the ATTENDED presences, computed by `summariseTimesheet` in
     * `@berelax/core` and never recomputed in this package — which is how "approved payable minutes equal
     * the sum of the P-HR-05 buckets" holds by construction rather than as an agreement between two
     * implementations that will drift.
     */
    payableMinutes: integer('payable_minutes').notNull(),
    /**
     * `sum(minutes x multiplierBp)`, whole basis-point-minutes. Deliberately not money: what an hour of a
     * monthly salary is worth is a forecast's figure (0081's `labour_cost_rule`, unanswered against
     * Y9-overtime), and 0081's own comment says a forecast is a forecast while payroll pays attendance.
     */
    weightedMinuteBp: bigint('weighted_minute_bp', { mode: 'bigint' }).notNull(),
    /**
     * Spans that contributed nothing because an end was unknown or not believed. NOT NULL on every row, for
     * `rotaVersion.forecastUnpricedEmployees`'s reason exactly: a timesheet whose clock-outs were all missed
     * is 0 payable minutes and reads as a therapist who never came in, so a screen printing the total must
     * print this beside it.
     */
    incompletePresenceCount: smallint('incomplete_presence_count').notNull(),
    /**
     * Spans attended with nothing rostered for them, recorded with the opposite sign to the count above:
     * unrostered minutes ARE payable — somebody who worked is paid, which is the strict reading — so a period
     * of entirely unrostered work approves silently, and a figure nobody prints is a roster nobody fixes.
     */
    unrosteredPresenceCount: smallint('unrostered_presence_count').notNull().default(0),
    approvedBy: text('approved_by').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // Approving one period twice would put two payable figures on one week with nothing able to choose, and a
    // correction is a dated row rather than a re-approval.
    uniqueIndex('timesheet_approval_one_per_employee_per_period').on(
      t.employeeId,
      t.fromTradingDate,
      t.toTradingDate,
    ),
    index('timesheet_approval_period_idx').on(t.fromTradingDate, t.toTradingDate),
    index('timesheet_approval_version_idx').on(t.rotaVersionId),
    check('timesheet_approval_period_ordered', sql`${t.toTradingDate} >= ${t.fromTradingDate}`),
    check('timesheet_approval_payable_minutes_nonneg', sql`${t.payableMinutes} >= 0`),
    check('timesheet_approval_weighted_bp_nonneg', sql`${t.weightedMinuteBp} >= 0`),
    check('timesheet_approval_incomplete_count_nonneg', sql`${t.incompletePresenceCount} >= 0`),
    check('timesheet_approval_unrostered_count_nonneg', sql`${t.unrosteredPresenceCount} >= 0`),
    check(
      'timesheet_approval_approved_by_not_placeholder',
      sql`not is_placeholder_text(${t.approvedBy}) and btrim(${t.approvedBy}) <> ''`,
    ),
  ],
)

/**
 * A dated adjustment to attendance, append-only (0086).
 *
 * The acceptance criterion's "a correction inserts a dated adjustment row while the original row is
 * unchanged", and unchanged is literal in the strongest sense available: no UPDATE is issued, ZX001 would
 * refuse one, and no second punch row is written either. `correctedOccurredAt` IS the corrected instant and
 * `applyAttendanceCorrections` in `@berelax/core` layers it over the punches when the timesheet is read. The
 * obvious alternative — inserting the supplied clock-out as an `attendanceEvent` — is wrong twice over: the
 * punch would be dated inside the very period the correction works around, so the accounting guard and ZX004
 * would both refuse the row the remedy depends on, and the same fact in two places means a reader that found
 * the punch and not the correction reports a corrected day as an ordinary one.
 *
 * `adjustmentDate` is distinct from `tradingDate` and that distinction is the mechanism, copied from
 * `postDatedCorrection` (M-VAT-06): the correction is ABOUT a day in a closed period and is RECORDED on a day
 * in an open one, enforced by a trigger through `raise_if_period_locked()` — the same function every posting
 * path in this database reaches, so no second reader of the lock exists to disagree with it.
 */
export const attendanceCorrection = pgTable(
  'attendance_correction',
  {
    id: uuid('id').primaryKey(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /** A plain column, for `attendanceEvent.tradingDate`'s reason: this table is append-only too. */
    tradingDate: date('trading_date').notNull(),
    /** The day the adjustment is POSTED on, which must fall in an OPEN accounting period. */
    adjustmentDate: date('adjustment_date').notNull(),
    /** `supply_missing_clock_out` or `amend_punch_instant`. */
    kind: text('kind').notNull(),
    /**
     * The punch being corrected. A KEY, and the pin costs nothing because both ends are append-only — 0081
     * kept its self-references for exactly this reason. NOT NULL, because attendance nobody recorded at all
     * is not something a correction can invent: that gap is a ledger-side adjustment and P-HR-12's.
     */
    correctsEventId: uuid('corrects_event_id')
      .notNull()
      .references(() => attendanceEvent.id, { onDelete: 'restrict' }),
    correctedOccurredAt: timestamp('corrected_occurred_at', { withTimezone: true }).notNull(),
    /**
     * Why. Refused blank, placeholder (0026) or under eight characters by CONSTRAINT rather than by UI
     * validation alone, which the acceptance criterion names: a correction with no reason is a changed
     * payslip nobody can be asked about.
     */
    reason: text('reason').notNull(),
    correctedBy: text('corrected_by').notNull(),
    correctedAt: timestamp('corrected_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // A second supplied clock-out against one clock-in would produce two ends for one presence, and the
    // alternation trigger would then refuse the second with a message about alternation rather than about the
    // duplicate correction that caused it.
    uniqueIndex('attendance_correction_one_per_event_per_kind').on(t.correctsEventId, t.kind),
    index('attendance_correction_employee_day_idx').on(t.employeeId, t.tradingDate),
    index('attendance_correction_adjustment_idx').on(t.adjustmentDate),
    check(
      'attendance_correction_kind_known',
      sql`${t.kind} in ('supply_missing_clock_out', 'amend_punch_instant')`,
    ),
    check(
      'attendance_correction_instant_on_whole_minute',
      sql`date_trunc('minute', ${t.correctedOccurredAt}) = ${t.correctedOccurredAt}`,
    ),
    check(
      'attendance_correction_reason_is_a_reason',
      sql`btrim(${t.reason}) <> '' and not is_placeholder_text(${t.reason}) and length(btrim(${t.reason})) >= 8`,
    ),
    check(
      'attendance_correction_corrected_by_not_placeholder',
      sql`not is_placeholder_text(${t.correctedBy}) and btrim(${t.correctedBy}) <> ''`,
    ),
  ],
)
