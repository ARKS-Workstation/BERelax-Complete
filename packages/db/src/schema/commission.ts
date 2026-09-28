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
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { invoice } from './invoice.ts'
import { periodLock } from './ledger.ts'
import { packageRedemption } from './package.ts'
import { employee } from './staff.ts'

/**
 * Drizzle mirror of the four tables `packages/db/migrations/0097_hr_commission.sql` creates.
 *
 * A file of its own rather than four more tables in `./hr.ts` or `./attendance.ts`, for the reason
 * `./attendance.ts` gives about itself: `./hr.ts` mirrors the ROSTER and `./attendance.ts` the record of
 * what was worked, and these four are the record of what a completed, PAID treatment earns. The three are
 * read by different code and change for different reasons.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`.
 *
 * **Every table here is append-only and the rule tables are immutable.** `refuse_commission_rule_change`
 * (ZY071) and `refuse_commission_run_change` (ZY072) refuse UPDATE and DELETE for every role including the
 * owner, which Drizzle cannot express — so nothing in `packages/db` issues one, and if something did the
 * database would refuse it. A rate that is wrong is a new VERSION; a run that is wrong is a new RUN.
 *
 * The `commission_derivation` VIEW is deliberately not mirrored: `pnpm db:drift` compares base tables, and
 * `regulatory_profile_current` sets the precedent.
 */

/**
 * One published, immutable commission rule version (0097).
 *
 * A uuid primary key rather than `effectiveFrom`, which is what `workingHoursRule`, `rotaCoverageRule` and
 * `attendanceGraceRule` use: a `commissionLine` pins the version it was computed from for ever, and a date
 * is the one key a later correction of a commencement date would move under it. The date stays UNIQUE, so
 * the ambiguity those tables refuse — two versions commencing on one date — is still refused.
 *
 * **Nothing is seeded.** Y9-commission is open and its provisional answer is "none configured; the module
 * ships disabled", so the empty table is the strictest safe option: with no version published the engine
 * produces no lines and nothing can be paid at a rate nobody chose.
 */
export const commissionRule = pgTable(
  'commission_rule',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** Monotonic from 1. Data rather than a count of rows, because every reader prints it. */
    version: integer('version').notNull(),
    /** The first trading date this version governs. No `business_day` reference: see the migration. */
    effectiveFrom: date('effective_from').notNull(),
    /**
     * Whether a percentage applies to the net or to the VAT-inclusive gross. No default: nobody has stated
     * which, and a default would be a guess indistinguishable from a decision.
     */
    basis: text('basis').notNull(),
    /**
     * `floor` or `half_up`, stated on the version. One fil per line and real money over a month, and both
     * answers are defensible — so the version names one rather than the code assuming one.
     */
    roundingMode: text('rounding_mode').notNull(),
    /**
     * The version this one replaces. Superseded-ness is DERIVED from a later version naming this one,
     * never stored: a column saying so would need an UPDATE, and this table refuses every UPDATE.
     */
    supersedesId: uuid('supersedes_id').references((): AnyPgColumn => commissionRule.id, {
      onDelete: 'restrict',
    }),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    publishedByActorKind: text('published_by_actor_kind').notNull(),
    publishedByActorId: uuid('published_by_actor_id'),
    isProvisional: boolean('is_provisional').notNull().default(true),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    sourceNote: text('source_note').notNull(),
  },
  (table) => [
    unique('commission_rule_one_version_per_date').on(table.effectiveFrom),
    unique('commission_rule_version_unique').on(table.version),
    check('commission_rule_version_starts_at_one', sql`${table.version} >= 1`),
    index('commission_rule_effective_from_idx').on(table.effectiveFrom),
  ],
)

/**
 * The rates of one version, as ordered rows (0097).
 *
 * Rows and not columns so that flat and tiered are the same mechanism: one band from zero is a flat
 * percentage. Basis points and never a decimal — a "rate" of 0.125 is a float in a costume (ADR 0007).
 *
 * `assert_commission_bands_cover_from_zero` (ZY073) holds a version's bands to starting at 0 and ascending
 * with `bandNo`, so "some band applies" is true by construction and the engine has no unanswered case.
 */
export const commissionRuleBand = pgTable(
  'commission_rule_band',
  {
    ruleVersionId: uuid('rule_version_id')
      .notNull()
      .references(() => commissionRule.id),
    bandNo: smallint('band_no').notNull(),
    /**
     * Inclusive lower bound of the appointment value, integer fils. The upper bound is the next band's
     * `fromFils`; the last band has none — an absence rather than a sentinel maximum somebody chose.
     */
    fromFils: bigint('from_fils', { mode: 'number' }).notNull(),
    rateBp: integer('rate_bp').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'commission_rule_band_pk',
      columns: [table.ruleVersionId, table.bandNo],
    }),
    unique('commission_rule_band_one_per_threshold').on(table.ruleVersionId, table.fromFils),
    check('commission_rule_band_rate_bounded', sql`${table.rateBp} between 0 and 10000`),
  ],
)

/**
 * One computation of one period under one rule version (0097).
 *
 * `ruleVersionId` is the pin that makes a recompute reproduce rather than restate: the version that judged
 * a run is the version stored on it, never the one in force today. `sourceAsOf` is the instant the source
 * figures were read at, and for a period a `periodLock` covers it is the lock's own `lockedAt` (ZY076) —
 * so a payment applied after the close, or a sale backdated into the month, cannot move a figure that has
 * already been paid.
 */
export const commissionRun = pgTable(
  'commission_run',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    ruleVersionId: uuid('rule_version_id')
      .notNull()
      .references(() => commissionRule.id),
    periodStartsOn: date('period_starts_on').notNull(),
    periodEndsOn: date('period_ends_on').notNull(),
    /** The instant the source figures were read at. The books as filed, for a locked period. */
    sourceAsOf: timestamp('source_as_of', { withTimezone: true }).notNull(),
    /** The lock whose figures this run read, or null when the period was open. */
    lockedPeriodId: text('locked_period_id').references(() => periodLock.periodId),
    /**
     * Whether the module was enabled when this ran. Recorded because "no lines because the module is off"
     * and "no lines because nobody worked" are the same empty table and very different facts.
     */
    moduleEnabled: boolean('module_enabled').notNull(),
    totalFils: bigint('total_fils', { mode: 'number' }).notNull(),
    lineCount: integer('line_count').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    computedByActorKind: text('computed_by_actor_kind').notNull(),
    computedByActorId: uuid('computed_by_actor_id'),
  },
  (table) => [
    // What `commissionLine`'s composite foreign key points at, so a line cannot name a version its run
    // does not name: the pin is ONE fact rather than a copy of it that drifts.
    unique('commission_run_rule_version_pin').on(table.id, table.ruleVersionId),
    check(
      'commission_run_period_ends_on_or_after_it_starts',
      sql`${table.periodEndsOn} >= ${table.periodStartsOn}`,
    ),
    index('commission_run_period_idx').on(table.periodStartsOn, table.periodEndsOn),
    index('commission_run_version_idx').on(table.ruleVersionId),
  ],
)

/**
 * One appointment's commission under one run's rule version (0097).
 *
 * `ruleVersionId` is NOT NULL and held EQUAL to the run's by `commission_line_pins_its_runs_rule_version`,
 * a composite foreign key — so the pin is one fact rather than a second column somebody keeps in step. The
 * band, the rate and the basis are snapshotted so "why is this figure" is one row with no join, and
 * `assert_commission_line_follows_its_rule` (ZY077) holds all three to the version named.
 *
 * `appointmentId` carries no foreign key, for `invoiceAppointment`'s reason (0063): PostgreSQL refuses
 * `truncate appointment` while a referencing table is absent from the statement and four suites truncate
 * it by list. The UNIQUE on (run, appointment) still bites, because it constrains the id.
 */
export const commissionLine = pgTable(
  'commission_line',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => commissionRun.id),
    ruleVersionId: uuid('rule_version_id').notNull(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id),
    appointmentId: uuid('appointment_id').notNull(),
    /** `invoice_line` or `package_redemption`. A vocabulary, not an inference from which id is null. */
    source: text('source').notNull(),
    invoiceId: uuid('invoice_id').references(() => invoice.id),
    packageRedemptionId: uuid('package_redemption_id').references(() => packageRedemption.id),
    /** The appointment's trading date, materialised. No `business_day` reference: see the migration. */
    tradingDate: date('trading_date').notNull(),
    basisFils: bigint('basis_fils', { mode: 'number' }).notNull(),
    bandNo: smallint('band_no').notNull(),
    rateBp: integer('rate_bp').notNull(),
    commissionFils: bigint('commission_fils', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('commission_line_once_per_run').on(table.runId, table.appointmentId),
    check('commission_line_rate_bounded', sql`${table.rateBp} between 0 and 10000`),
    check(
      'commission_line_not_more_than_its_basis',
      sql`${table.commissionFils} <= ${table.basisFils}`,
    ),
    index('commission_line_run_idx').on(table.runId),
    index('commission_line_employee_day_idx').on(table.employeeId, table.tradingDate),
  ],
)
