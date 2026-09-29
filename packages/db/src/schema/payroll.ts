import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { timesheetApproval } from './attendance.ts'
import { cashSession } from './cash-session.ts'
import { commissionRun } from './commission.ts'
import { account } from './ledger.ts'
import { employee } from './staff.ts'

/**
 * Drizzle mirror of the five tables `packages/db/migrations/0104_hr_payroll.sql` creates.
 *
 * A file of its own rather than more tables in `./hr.ts`, `./attendance.ts` or `./commission.ts`, for the
 * reason `./commission.ts` gives about itself: `./hr.ts` mirrors the ROSTER, `./attendance.ts` the record of
 * what was worked, `./commission.ts` what a paid treatment earned, and these five the record of what was
 * PAID. The four are read by different code and change for different reasons.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`.
 *
 * **Four of the five are append-only and the fifth is immutable once completed.**
 * `refuse_payroll_record_change` (ZY144) refuses UPDATE and DELETE on `payslip`, `employeeTip`,
 * `payrollDeduction` and `wpsExport` for every role including the owner;
 * `refuse_completed_payroll_run_change` (ZY141) and `refuse_payroll_run_draft_edit` (ZY142) let a
 * `payrollRun` be completed and nothing else. Drizzle cannot express any of that — so nothing in
 * `packages/db` issues a forbidden statement, and if something did the database would refuse it.
 *
 * The `payslip_detail` VIEW is deliberately not mirrored: `pnpm db:drift` compares base tables, and
 * `commission_derivation` and `regulatory_profile_current` set the precedent.
 *
 * Money is `bigint` with `mode: 'number'`, which is `./commission.ts`'s choice for its sibling tables and
 * is stated here because `employee.basicWageFils` next door takes the other one. A payslip's components are
 * one month of one person's pay: far inside exact integer arithmetic, and `computePayslip` in
 * `@berelax/core` refuses a gross that is not a safe integer rather than trusting that.
 */

/**
 * One individually attributed tip: a pass-through liability, never revenue (0104).
 *
 * `liabilityAccountCode` is the acceptance criterion made structural. `assert_tip_is_owed_as_a_liability`
 * (ZY146) refuses any account whose type is not `liability`, so there is no INSERT — through this mirror, a
 * `psql` session or an import — that books a tip as income.
 */
export const employeeTip = pgTable(
  'employee_tip',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /** The trading date, which also decides the payroll period. No `business_day` reference: see 0104. */
    tradingDate: date('trading_date').notNull(),
    amountFils: bigint('amount_fils', { mode: 'number' }).notNull(),
    /** Defaults to 2040 `Tips payable to therapists`, seeded by 0018. This unit invents no account. */
    liabilityAccountCode: text('liability_account_code')
      .notNull()
      .default('2040')
      .references(() => account.code, { onDelete: 'restrict' }),
    /**
     * The till session the cash arrived in, or null.
     *
     * Nullable deliberately: a tip recorded outside a cash-up is a thing to chase rather than to refuse,
     * and refusing it would push the record out of the system altogether — an unrecorded tip being the
     * failure this table exists to prevent.
     */
    cashSessionId: uuid('cash_session_id').references(() => cashSession.id, {
      onDelete: 'restrict',
    }),
    recordedBy: text('recorded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('employee_tip_amount_is_positive', sql`${table.amountFils} > 0`),
    index('employee_tip_employee_day_idx').on(table.employeeId, table.tradingDate),
    index('employee_tip_day_idx').on(table.tradingDate),
  ],
)

/**
 * One authorised, dated reduction of pay (0104).
 *
 * **No `kind` column, deliberately.** Which deductions are lawful and what proportion of pay they may reach
 * is `Y9-deductions` and nobody has answered it, so a closed set would read as the list of deductions this
 * business makes. `authorisedBy` is separate from `recordedBy` because the person who types a deduction and
 * the person who may authorise one are different roles.
 */
export const payrollDeduction = pgTable(
  'payroll_deduction',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    tradingDate: date('trading_date').notNull(),
    amountFils: bigint('amount_fils', { mode: 'number' }).notNull(),
    /** What it is for, in somebody's own words. A deduction nobody explained is unchallengeable. */
    reason: text('reason').notNull(),
    authorisedBy: text('authorised_by').notNull(),
    recordedBy: text('recorded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('payroll_deduction_amount_is_positive', sql`${table.amountFils} > 0`),
    index('payroll_deduction_employee_day_idx').on(table.employeeId, table.tradingDate),
  ],
)

/**
 * One payroll over one period, immutable once completed (0104).
 *
 * `completedAt` IS the immutability boundary: before it, only the completion UPDATE is permitted (ZY142);
 * after it, nothing is (ZY141), and a WPS export of an uncompleted run is refused (ZY149). A run that is
 * wrong is corrected by a NEW dated run naming this one (ZY143) — 0018's journal rule applied to wages.
 *
 * `labourCostRuleEffectiveFrom` is the pin that makes an overtime figure reproducible: the divisor that
 * priced a run is the one stored on it, never the one in force when somebody asks again.
 */
export const payrollRun = pgTable(
  'payroll_run',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    periodStartsOn: date('period_starts_on').notNull(),
    periodEndsOn: date('period_ends_on').notNull(),
    /**
     * The versioned monthly-wage divisor (0081) this run's overtime was priced at.
     *
     * A date, because `labour_cost_rule` keys on `effective_from`. No Drizzle reference is declared: the
     * mirror for that table lives in `./hr.ts` and importing it here would be the only edge between the two
     * files, for a foreign key `pnpm db:drift` reads out of the database anyway.
     */
    labourCostRuleEffectiveFrom: date('labour_cost_rule_effective_from').notNull(),
    /** The run this one corrects, or null for the first run of a period. A self-reference (ZY143). */
    correctsRunId: uuid('corrects_run_id').references((): AnyPgColumn => payrollRun.id, {
      onDelete: 'restrict',
    }),
    /** The header figures, held to the payslips by ZY150 at completion. Independent so they can disagree. */
    payslipCount: integer('payslip_count').notNull().default(0),
    netTotalFils: bigint('net_total_fils', { mode: 'number' }).notNull().default(0),
    /**
     * Employees with no `basicWageFils` on file, counted rather than passed over.
     *
     * All nineteen seeded employees have none (`Y8-staff`), so a run that treated an absent wage as zero
     * would pay nineteen payslips of 0.00 AED with every figure on the screen reconciling.
     */
    unpricedEmployeeCount: integer('unpriced_employee_count').notNull().default(0),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: text('completed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'payroll_run_period_ends_on_or_after_it_starts',
      sql`${table.periodEndsOn} >= ${table.periodStartsOn}`,
    ),
    check('payroll_run_payslip_count_is_nonneg', sql`${table.payslipCount} >= 0`),
    check('payroll_run_net_total_is_nonneg', sql`${table.netTotalFils} >= 0`),
    check('payroll_run_unpriced_count_is_nonneg', sql`${table.unpricedEmployeeCount} >= 0`),
    index('payroll_run_period_idx').on(table.periodStartsOn, table.periodEndsOn),
    index('payroll_run_corrects_idx').on(table.correctsRunId),
  ],
)

/**
 * One employee's figures under one run (0104).
 *
 * `grossFils` and `netFils` are GENERATED in the database — declared here as ordinary columns, the way
 * `employee.isPublishable` and `bill.vatFils` are, because the mirror records the SHAPE and the generation
 * expression lives in the migration that owns it. Generated for `employee.totalWageFils`'s reason: the
 * payslip, the screen and the WPS file must not be able to compute the net differently, and the one that
 * disagrees is discovered by an employee.
 *
 * Every figure it prints is pinned to what decided it — the commission run and its rule version (ZY147),
 * the timesheet approval, and through the run the `labour_cost_rule` version — so a payslip is answerable
 * without recomputing anything.
 */
export const payslip = pgTable(
  'payslip',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => payrollRun.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /** The five additive components, in the order the document prints them. `fils_nonneg` in SQL. */
    basicFils: bigint('basic_fils', { mode: 'number' }).notNull(),
    allowancesFils: bigint('allowances_fils', { mode: 'number' }).notNull(),
    overtimeFils: bigint('overtime_fils', { mode: 'number' }).notNull(),
    commissionFils: bigint('commission_fils', { mode: 'number' }).notNull(),
    tipsFils: bigint('tips_fils', { mode: 'number' }).notNull(),
    deductionsFils: bigint('deductions_fils', { mode: 'number' }).notNull(),
    /** GENERATED. Nothing writes it; see the note above. */
    grossFils: bigint('gross_fils', { mode: 'number' }).notNull(),
    /** GENERATED. The figure the WPS file pays and the one an employee disputes. */
    netFils: bigint('net_fils', { mode: 'number' }).notNull(),
    /** THE commission pin. Both columns or neither (`payslip_commission_pin_is_whole`), and ZY147. */
    commissionRunId: uuid('commission_run_id').references(() => commissionRun.id, {
      onDelete: 'restrict',
    }),
    commissionRuleVersion: integer('commission_rule_version'),
    /** The attendance this payslip priced. NOT NULL: overtime from nowhere is a figure nobody can check. */
    timesheetApprovalId: uuid('timesheet_approval_id')
      .notNull()
      .references(() => timesheetApproval.id, { onDelete: 'restrict' }),
    payableMinutes: integer('payable_minutes').notNull(),
    /** The uplift basis-point-minutes the overtime was priced from, snapshotted. */
    overtimeUpliftMinuteBp: bigint('overtime_uplift_minute_bp', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('payslip_once_per_employee_per_run').on(table.runId, table.employeeId),
    check(
      'payslip_commission_version_starts_at_one',
      sql`${table.commissionRuleVersion} is null or ${table.commissionRuleVersion} >= 1`,
    ),
    check('payslip_payable_minutes_is_nonneg', sql`${table.payableMinutes} >= 0`),
    check('payslip_uplift_bp_is_nonneg', sql`${table.overtimeUpliftMinuteBp} >= 0`),
    index('payslip_run_idx').on(table.runId),
    index('payslip_employee_idx').on(table.employeeId, table.createdAt),
    index('payslip_commission_run_idx').on(table.commissionRunId),
  ],
)

/**
 * One WPS file that left the building (0104).
 *
 * The `audit_event` written in the same transaction says somebody exported and how many rows — 0005's
 * `audit_event_export_idx` is the insider-threat signal. This says which run, which layout, and the sha256
 * of the bytes, without which a file a bank received cannot be told from one somebody edited afterwards.
 *
 * `format`'s closed set matches `WPS_SIF_FORMATS` in `@berelax/core`, restated for
 * `attendanceEvent.captureMethod`'s reason: the day the bank's real spec arrives it is a NEW member, and
 * every file already exported keeps saying which layout wrote it.
 */
export const wpsExport = pgTable(
  'wps_export',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => payrollRun.id, { onDelete: 'restrict' }),
    format: text('format').notNull(),
    recordCount: integer('record_count').notNull(),
    totalFils: bigint('total_fils', { mode: 'number' }).notNull(),
    /** sha256 of the bytes, lower-case hex, 64 characters — constrained, so it can be compared. */
    fileSha256: text('file_sha256').notNull(),
    exportedBy: text('exported_by').notNull(),
    exportedAt: timestamp('exported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('wps_export_format_known', sql`${table.format} in ('generic_mohre_v1')`),
    check('wps_export_record_count_is_nonneg', sql`${table.recordCount} >= 0`),
    check('wps_export_total_is_nonneg', sql`${table.totalFils} >= 0`),
    check('wps_export_sha256_shape', sql`${table.fileSha256} ~ '^[0-9a-f]{64}$'`),
    index('wps_export_run_idx').on(table.runId),
    index('wps_export_exported_at_idx').on(table.exportedAt),
  ],
)
