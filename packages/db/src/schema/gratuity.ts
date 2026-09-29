import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
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
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { journalEntry, periodLock } from './ledger.ts'
import { employee } from './staff.ts'

/**
 * Drizzle mirror of the four tables `packages/db/migrations/0107_hr_gratuity.sql` creates.
 *
 * A file of its own rather than more tables in `./payroll.ts` or `./hr.ts`, for the reason `./payroll.ts`
 * gives about itself one subject along: `./hr.ts` mirrors the ROSTER, `./attendance.ts` the record of what
 * was worked, `./payroll.ts` the record of what was PAID, and these four a LIABILITY that is owed and not
 * paid. They are read by the balance sheet rather than by a payslip, and they change for different reasons.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`.
 *
 * **Three of the four are append-only and the fourth is a policy classification.**
 * `refuse_gratuity_record_change` (ZY171) refuses UPDATE and DELETE on `gratuityAccrual`,
 * `gratuitySettlement` and `closedPeriodLabourAdjustment` for every role including the owner. Drizzle
 * cannot express that, so nothing in `packages/db` issues a forbidden statement and the database would
 * refuse it if something did. `gratuityRule` carries no refusal trigger and the application role holds
 * SELECT alone, which is how `leaveEntitlementRule` and `workingHoursRule` are held: publishing a policy
 * version is a migration, and a mistyped rate must be correctable by one without somebody first dropping a
 * trigger.
 *
 * The `employee_gratuity_liability` VIEW is deliberately not mirrored: `pnpm db:drift` compares base tables
 * (`relkind in ('r', 'p')`), and `commission_derivation`, `payslip_detail` and `regulatory_profile_current`
 * set the precedent.
 *
 * Money is `bigint` with `mode: 'number'`, which is `./payroll.ts`'s and `./commission.ts`'s choice for
 * their sibling tables. A gratuity liability is one person's entitlement over a career: far inside exact
 * integer arithmetic, and `gratuityLiabilityAt` in `@berelax/core` runs the product in `BigInt` and refuses
 * a figure outside the safe range rather than trusting that.
 */

/**
 * One version of the end-of-service gratuity policy (0107).
 *
 * **Every figure here is provisional against `Y9-gratuity`.** docs/04 §7 states only that gratuity is an
 * accruing balance-sheet liability accrued monthly, and no rate, band, cap, divisor or wage basis appears
 * anywhere in the handover. Versioned rather than held in `app_setting` because gratuity is asked about the
 * PAST: a settlement recomputed after a rate change must use the rate that applied then, and one current
 * value cannot say what it was.
 *
 * **There is no cap column**, deliberately. docs/04 names no cap and the SHAPE of one is as unknown as its
 * number — a ceiling on the days earned, on the months that earn, or on the total as a multiple of the wage
 * are three different columns — so a nullable one would be a place to put a figure the engine would then
 * apply to the wrong quantity.
 */
export const gratuityRule = pgTable(
  'gratuity_rule',
  {
    /** The first date this version governs. The primary key: two versions on one date is an ambiguity. */
    effectiveFrom: date('effective_from').primaryKey(),
    daysPerYearFirstBand: integer('days_per_year_first_band').notNull(),
    daysPerYearAfterBand: integer('days_per_year_after_band').notNull(),
    bandBoundaryYears: integer('band_boundary_years').notNull(),
    /**
     * Calendar days a monthly wage is taken to cover.
     *
     * NOT `labour_cost_rule.monthly_wage_days_divisor`, although version 1 of both carries 30. That one is
     * a FORECAST's divisor flagged against `Y9-overtime`; this is a statutory entitlement basis flagged
     * against `Y9-gratuity`. 0081 makes the same distinction between its own `paid_minutes_per_day` and
     * `working_hours_rule.ordinary_minutes_per_day`: two figures that happen to be equal.
     */
    dailyWageDaysDivisor: smallint('daily_wage_days_divisor').notNull(),
    /** `basic` reads `employee.basic_wage_fils`; `gross` reads the generated `total_wage_fils`. */
    wageBasis: text('wage_basis').notNull(),
    probationMonths: integer('probation_months').notNull(),
    /** Whether accrual RUNS during probation. A probation month counts as service either way. */
    accruesDuringProbation: boolean('accrues_during_probation').notNull(),
    unpaidLeaveDaysExcluded: boolean('unpaid_leave_days_excluded').notNull(),
    isProvisional: boolean('is_provisional').notNull().default(true),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    /** Where the figures came from. Never a placeholder: a blank provenance reads as agreed. */
    sourceNote: text('source_note').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'gratuity_rule_first_band_plausible',
      sql`${table.daysPerYearFirstBand} >= 0 and ${table.daysPerYearFirstBand} <= 366`,
    ),
    check(
      'gratuity_rule_after_band_plausible',
      sql`${table.daysPerYearAfterBand} >= 0 and ${table.daysPerYearAfterBand} <= 366`,
    ),
    check(
      'gratuity_rule_earns_something',
      sql`${table.daysPerYearFirstBand} + ${table.daysPerYearAfterBand} > 0`,
    ),
    check(
      'gratuity_rule_band_boundary_plausible',
      sql`${table.bandBoundaryYears} >= 1 and ${table.bandBoundaryYears} <= 50`,
    ),
    check(
      'gratuity_rule_days_divisor_plausible',
      sql`${table.dailyWageDaysDivisor} between 1 and 31`,
    ),
    check('gratuity_rule_wage_basis_known', sql`${table.wageBasis} in ('basic', 'gross')`),
    check(
      'gratuity_rule_probation_plausible',
      sql`${table.probationMonths} >= 0 and ${table.probationMonths} <= 60`,
    ),
    check(
      'gratuity_rule_provisional_names_a_question',
      sql`not ${table.isProvisional} or ${table.openQuestionId} is not null`,
    ),
    check(
      'gratuity_rule_source_note_not_placeholder',
      sql`not is_placeholder_text(${table.sourceNote})`,
    ),
  ],
)

/**
 * One month's movement in one employee's gratuity liability (0107). Append-only (ZY171).
 *
 * `cumulativeFils` is stored beside `accruedFils` because the month's figure IS a difference: the whole
 * liability owed at the month end, minus what is already on the books. ADR 0057 is about why that is the
 * primitive — twelve independently-rounded twelfths do not sum to the year, and the residue is permanent in
 * a journal that cannot be edited.
 *
 * `entryId` is NOT NULL and UNIQUE: an accrual row with no journal entry is a liability the trial balance
 * cannot see, and two rows sharing an entry would each claim the whole of it.
 */
export const gratuityAccrual = pgTable(
  'gratuity_accrual',
  {
    accrualId: uuid('accrual_id').primaryKey().default(sql`uuid_generate_v7()`),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /** The month accrued FOR, always its first day, so one month cannot have two spellings. */
    accrualMonth: date('accrual_month').notNull(),
    /** The last day of that month: what the liability is measured at. */
    accruedTo: date('accrued_to').notNull(),
    /** The wage the figure was struck on, PINNED — ADR 0054's lesson one subject along. */
    wageFils: bigint('wage_fils', { mode: 'number' }).notNull(),
    wageBasis: text('wage_basis').notNull(),
    employedDays: integer('employed_days').notNull(),
    unpaidLeaveDays: integer('unpaid_leave_days').notNull(),
    cumulativeFils: bigint('cumulative_fils', { mode: 'number' }).notNull(),
    accruedFils: bigint('accrued_fils', { mode: 'number' }).notNull(),
    ruleEffectiveFrom: date('rule_effective_from')
      .notNull()
      .references(() => gratuityRule.effectiveFrom),
    entryId: text('entry_id')
      .notNull()
      .unique()
      .references(() => journalEntry.entryId),
    /** Month end when the month is open, a date in the next OPEN period when it is locked (ZY174). */
    entryDate: date('entry_date').notNull(),
    /** The locked period the accrual month fell in, when it did. Null means the month was open. */
    lockedPeriodId: text('locked_period_id').references(() => periodLock.periodId),
    /** The accrual this one SUPERSEDES. Excluded from `employee_gratuity_liability` once named. */
    correctsAccrualId: uuid('corrects_accrual_id').references(
      (): AnyPgColumn => gratuityAccrual.accrualId,
    ),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'gratuity_accrual_month_is_first_of_month',
      sql`${table.accrualMonth} = date_trunc('month', ${table.accrualMonth})::date`,
    ),
    check(
      'gratuity_accrual_accrued_to_is_month_end',
      sql`${table.accruedTo} = (date_trunc('month', ${table.accrualMonth}) + interval '1 month - 1 day')::date`,
    ),
    check('gratuity_accrual_wage_basis_known', sql`${table.wageBasis} in ('basic', 'gross')`),
    check(
      'gratuity_accrual_employed_days_plausible',
      sql`${table.employedDays} >= 0 and ${table.employedDays} <= 31`,
    ),
    check(
      'gratuity_accrual_unpaid_days_plausible',
      sql`${table.unpaidLeaveDays} >= 0 and ${table.unpaidLeaveDays} <= ${table.employedDays}`,
    ),
    check('gratuity_accrual_movement_is_positive', sql`${table.accruedFils} > 0`),
    check(
      'gratuity_accrual_does_not_correct_itself',
      sql`${table.correctsAccrualId} is distinct from ${table.accrualId}`,
    ),
    check(
      'gratuity_accrual_created_by_not_placeholder',
      sql`not is_placeholder_text(${table.createdBy}) and btrim(${table.createdBy}) <> ''`,
    ),
    /** At most one correction per original, so a chain is A <- B <- C and never A <- B and A <- C. */
    unique('gratuity_accrual_one_correction_per_original').on(table.correctsAccrualId),
    index('gratuity_accrual_employee_month_idx').on(table.employeeId, table.accrualMonth),
    index('gratuity_accrual_month_idx').on(table.accrualMonth),
    index('gratuity_accrual_entry_idx').on(table.entryId),
  ],
)

/**
 * A leaver's accrued gratuity discharged (0107). Append-only (ZY171).
 *
 * `settledFils` must equal the employee's LIVE accrued liability exactly (ZY175), so "the liability nets to
 * zero fils" is enforced by the database rather than asserted by a test, and the employment must have ended
 * (ZY176). It credits a PAYABLE and never cash: the money leaves through the payroll run.
 */
export const gratuitySettlement = pgTable(
  'gratuity_settlement',
  {
    settlementId: uuid('settlement_id').primaryKey().default(sql`uuid_generate_v7()`),
    /** One settlement per employee, refused at the index rather than by a count in a trigger. */
    employeeId: uuid('employee_id')
      .notNull()
      .unique()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /** Snapshotted, so a later correction to the employment record cannot restate what was settled. */
    employedUntil: date('employed_until').notNull(),
    settledFils: bigint('settled_fils', { mode: 'number' }).notNull(),
    entryId: text('entry_id')
      .notNull()
      .unique()
      .references(() => journalEntry.entryId),
    entryDate: date('entry_date').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('gratuity_settlement_is_positive', sql`${table.settledFils} > 0`),
    check(
      'gratuity_settlement_created_by_not_placeholder',
      sql`not is_placeholder_text(${table.createdBy}) and btrim(${table.createdBy}) <> ''`,
    ),
    index('gratuity_settlement_entry_idx').on(table.entryId),
  ],
)

/**
 * Work done on a date in a CLOSED accounting period with no punch ever recorded (0107). Append-only.
 *
 * Answers the gap `Y9-attendance` has carried since 0086: `attendance_correction.corrects_event_id` is NOT
 * NULL, so a correction amends a record and cannot invent one, and P-HR-12 re-pointed the gap here because
 * its `payroll_deduction` only ever REDUCES pay while unrecorded work needs an UPWARD adjustment.
 *
 * **No `kind` vocabulary and no derived amount.** The figure is stated by whoever authorises it: deriving
 * it means deciding what a day of a monthly salary is worth, which `Y9-deductions` records as unanswered,
 * and a derived figure would be indistinguishable on the ledger from an authorised one.
 */
export const closedPeriodLabourAdjustment = pgTable(
  'closed_period_labour_adjustment',
  {
    adjustmentId: uuid('adjustment_id').primaryKey().default(sql`uuid_generate_v7()`),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /** The trading date the work was done on, inside the locked period (ZY177). */
    workedOn: date('worked_on').notNull(),
    /** NOT NULL: an adjustment naming no lock is one whose month is still open. */
    lockedPeriodId: text('locked_period_id')
      .notNull()
      .references(() => periodLock.periodId),
    amountFils: bigint('amount_fils', { mode: 'number' }).notNull(),
    /** Why, in the authoriser's own words. The only evidence the work happened. */
    reason: text('reason').notNull(),
    /** Separate from `recordedBy`, because one column lets the recorder stand in for the authoriser. */
    authorisedBy: text('authorised_by').notNull(),
    recordedBy: text('recorded_by').notNull(),
    entryId: text('entry_id')
      .notNull()
      .unique()
      .references(() => journalEntry.entryId),
    entryDate: date('entry_date').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('closed_period_labour_adjustment_is_upward', sql`${table.amountFils} > 0`),
    check(
      'closed_period_labour_adjustment_reason_is_stated',
      sql`not is_placeholder_text(${table.reason}) and btrim(${table.reason}) <> ''`,
    ),
    check(
      'closed_period_labour_adjustment_authorised_by_stated',
      sql`not is_placeholder_text(${table.authorisedBy}) and btrim(${table.authorisedBy}) <> ''`,
    ),
    check(
      'closed_period_labour_adjustment_recorded_by_stated',
      sql`not is_placeholder_text(${table.recordedBy}) and btrim(${table.recordedBy}) <> ''`,
    ),
    check(
      'closed_period_labour_adjustment_dated_after_the_work',
      sql`${table.entryDate} > ${table.workedOn}`,
    ),
    index('closed_period_labour_adjustment_employee_idx').on(table.employeeId, table.workedOn),
    index('closed_period_labour_adjustment_period_idx').on(table.lockedPeriodId),
  ],
)
