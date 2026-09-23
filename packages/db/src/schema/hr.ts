import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { employee, staffLanguage } from './staff.ts'

/**
 * Drizzle mirror of the two tables `packages/db/migrations/0050_employee.sql` creates, plus the one
 * `packages/db/migrations/0059_hr_shift.sql` adds.
 *
 * The columns 0050 ADDS to `employee` and `employee_document` are in `./staff.ts` beside the rest of
 * those tables, because a mirror is a mirror of a table and not of a migration — splitting one table
 * across two files is how a column comes to be declared twice with two nullabilities.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`.
 *
 * **Nothing here decrypts anything, and no key is a parameter of any type in this file.** That is the
 * same rule `./google.ts` and `packages/clinical/src/crypto/postgres-key-store.ts` follow: a mistake in
 * the data layer must not be able to produce a plaintext, not even in an error message. The seal and
 * open live in `packages/hr/src/staff-secret.ts`, which is the only module that holds the
 * `STAFF_PII_KEK`.
 */

/** Ciphertext columns. Same representation as `./google.ts` and migration 0008's clinical payloads. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

/**
 * Staff bank accounts: one sealed JSON payload per row, superseded rather than edited.
 *
 * There is deliberately **no bank name and no last-four**. Either would make a raw `select *` here
 * informative again, and "a raw select returns ciphertext only" is the property this table exists to
 * have (docs/04 §7). `label` is what a person typed to tell two accounts apart ("salary account"),
 * never anything derived from the number.
 *
 * No `updatedAt`, which is a decision rather than an omission: a change of salary account is a new
 * record and the old one stays, because it is the evidence of where money was actually sent and what a
 * WPS file is reconciled against months later. The `employee_bank_detail_sealed_writes` trigger makes
 * superseding the only way — an UPDATE may touch `detailWrappedKey`, `detailKid` and `supersededAt` and
 * nothing else (`StaffSealedRowImmutable`, SQLSTATE ZS002). Neither the trigger nor the partial unique
 * index is expressible in Drizzle; both live in the migration and are asserted against real PostgreSQL
 * by `packages/hr/src/employee.itest.ts`.
 */
export const employeeBankDetail = pgTable(
  'employee_bank_detail',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /**
     * `RESTRICT`, for 0030's reason: somebody who has been paid has a history, and deleting the person
     * to erase the account is the delete this refuses. Ending employment is `employedUntil`.
     */
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    label: text('label'),
    /** AES-256-GCM over `{iban, accountHolder}`, with the GCM tag appended. */
    detailCt: bytea('detail_ct').notNull(),
    detailNonce: bytea('detail_nonce').notNull(),
    /** The per-record data key, wrapped by `STAFF_PII_KEK` and bound to this row by the same AAD. */
    detailWrappedKey: bytea('detail_wrapped_key').notNull(),
    /**
     * The `STAFF_PII_KEK` version, **not** the clinical one.
     *
     * `_kid` follows 0016's spelling rather than 0008's, because this estate has the Google estate's
     * shape — its own key and its own re-wrap primitive — and not the clinical one's. There is no
     * version registry table: its purpose is to refuse a retired key for encryption, and retirement is
     * not a state anything can reach until a rotation command exists to create it (0050's header).
     */
    detailKid: text('detail_kid').notNull(),
    /** sha256 of `table|row id|employee id`, truncated. Checked before a decrypt is attempted. */
    detailAadFp: text('detail_aad_fp').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /** Who filed the account. The audit row records the read; this records the write, on the row. */
    createdBy: text('created_by').notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (t) => [
    index('employee_bank_detail_employee_idx').on(t.employeeId, t.createdAt.desc()),
    // Partial on `supersededAt`: the history is unbounded and the present is unambiguous. Without it,
    // "which account does payroll pay into" has as many answers as the employee has ever had accounts.
    uniqueIndex('employee_bank_detail_one_current')
      .on(t.employeeId)
      .where(sql`${t.supersededAt} is null`),
    check(
      'employee_bank_detail_label_not_placeholder',
      sql`${t.label} is null or not is_placeholder_text(${t.label})`,
    ),
    check(
      'employee_bank_detail_created_by_not_placeholder',
      sql`not is_placeholder_text(${t.createdBy})`,
    ),
    check(
      'employee_bank_detail_sealed_columns_nonempty',
      sql`length(${t.detailCt}) > 0 and length(${t.detailNonce}) > 0 and length(${t.detailWrappedKey}) > 0`,
    ),
    check('employee_bank_detail_kid_shape', sql`${t.detailKid} ~ '^[a-z0-9][a-z0-9._-]{0,31}$'`),
  ],
)

/**
 * Languages spoken, one row per language.
 *
 * One row per language for the reason `employeeSkill` is one row per skill: a therapist speaks several,
 * and a single column forces either a first-language-only answer or an array whose typos match nothing.
 *
 * **Deliberately empty after a seed.** docs/13 §5 publishes no languages and Y8-staff has not been
 * answered, so every row here would be an invented fact about an identifiable person. The provenance
 * pair is present so that a row the build ever does assume is listed by the Unconfirmed Assumptions
 * panel rather than passing as confirmed.
 */
export const employeeLanguage = pgTable(
  'employee_language',
  {
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'cascade' }),
    language: staffLanguage('language').notNull(),
    isProvisional: boolean('is_provisional').notNull(),
    openQuestionId: text('open_question_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.employeeId, t.language] }),
    index('employee_language_language_idx').on(t.language),
    check(
      'employee_language_provisional_names_a_question',
      sql`not ${t.isProvisional} or ${t.openQuestionId} is not null`,
    ),
  ],
)

/**
 * The versioned working-hours rules (migration 0059): ordinary hours, the overtime cap, the minimum rest
 * gap, the night window and the four bucket multipliers in basis points.
 *
 * One row per **version**, keyed on the first trading date it governs, and the version that applies to a
 * trading date is the latest row at or before it. That is the decision this table exists to record, and
 * it is the opposite of `regulatory_profile`'s: a profile is read *in force*, because "may we say this on
 * the website" is only ever asked about the present, while payroll recomputes March in April. A single
 * current value — an `app_setting` row, a `superseded_at` column — answers March with April's rates, and
 * the figures are plausible so nothing looks wrong.
 *
 * `shift` and `shift_assignment` are **not** here: 0030 created both and they live in `./staff.ts` beside
 * the rest of the therapist tables, because a mirror is a mirror of a table and not of a migration. This
 * unit adds no column to either. In particular it adds no constraint tying `shift.period` to its trading
 * date's window — 0030 says why, and this is the unit that would most like such a check and must least
 * add it: `resolveTradingDate` in `@berelax/core` is the one reading of "which day is it".
 *
 * Multipliers are integer **basis points**, 10000 being the ordinary rate. ADR 0007's rule that money is
 * integer applies to the rate as much as to the amount: the figure is multiplied by a minute count and
 * will one day be multiplied by a fils-denominated wage. `ordinary_multiplier_bp` is pinned to 10000 by a
 * CHECK and stored anyway, so the pure splitter in `packages/core/src/hr/working-hours.ts` reads every
 * multiplier from this table and holds no rate literal of its own — which is what the unit's grep test
 * asserts.
 *
 * The provenance trio is on the row and every figure is provisional against **Y9-overtime**, so
 * `unconfirmedAssumptionRows()` lists them the same way it lists `app_setting`.
 */
export const workingHoursRule = pgTable(
  'working_hours_rule',
  {
    /**
     * The first trading date this version governs. Deliberately **not** a foreign key into
     * `business_day`: a labour rule commences on a calendar date whether or not the premises trades that
     * day, and one that could only commence on a trading day would be unrecordable for any change
     * announced over a closure.
     */
    effectiveFrom: date('effective_from').primaryKey(),
    ordinaryMinutesPerDay: integer('ordinary_minutes_per_day').notNull(),
    ordinaryMinutesPerWeek: integer('ordinary_minutes_per_week').notNull(),
    /** 0 = Sunday, the spelling `premises_hours.day_of_week` uses. */
    weekStartsOn: smallint('week_starts_on').notNull(),
    /** Exceeding it is reported as a violation, never priced as a dearer bucket. */
    overtimeDailyCapMinutes: integer('overtime_daily_cap_minutes').notNull(),
    /** Between consecutive PRESENCES, so a rota written in two abutting halves is not a breach. */
    minimumRestMinutes: integer('minimum_rest_minutes').notNull(),
    /** Local wall-clock, half-open `[from, until)`. Wraps midnight when from > until, as 22:00-04:00 does. */
    nightWindowFrom: time('night_window_from').notNull(),
    nightWindowUntil: time('night_window_until').notNull(),
    ordinaryMultiplierBp: integer('ordinary_multiplier_bp').notNull(),
    overtimeMultiplierBp: integer('overtime_multiplier_bp').notNull(),
    nightMultiplierBp: integer('night_multiplier_bp').notNull(),
    publicHolidayMultiplierBp: integer('public_holiday_multiplier_bp').notNull(),
    isProvisional: boolean('is_provisional').notNull(),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    /** Where the figures came from. NOT NULL and never a placeholder, for brief rule 15's reason. */
    sourceNote: text('source_note').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'working_hours_rule_ordinary_day_plausible',
      sql`${t.ordinaryMinutesPerDay} > 0 and ${t.ordinaryMinutesPerDay} <= 1440`,
    ),
    check(
      'working_hours_rule_ordinary_week_plausible',
      sql`${t.ordinaryMinutesPerWeek} > 0 and ${t.ordinaryMinutesPerWeek} <= 10080`,
    ),
    check('working_hours_rule_week_starts_on_is_a_weekday', sql`${t.weekStartsOn} between 0 and 6`),
    check(
      'working_hours_rule_overtime_cap_plausible',
      sql`${t.overtimeDailyCapMinutes} >= 0 and ${t.overtimeDailyCapMinutes} <= 1440`,
    ),
    check(
      'working_hours_rule_minimum_rest_plausible',
      sql`${t.minimumRestMinutes} >= 0 and ${t.minimumRestMinutes} <= 1440`,
    ),
    // An empty night window is not "no night rule", it is a night rule that silently never applies —
    // and a rule that never applies passes every test written to prove the night bucket is separate.
    check(
      'working_hours_rule_night_window_nonempty',
      sql`${t.nightWindowFrom} <> ${t.nightWindowUntil}`,
    ),
    check('working_hours_rule_ordinary_is_the_base_rate', sql`${t.ordinaryMultiplierBp} = 10000`),
    // The dearest applicable bucket is the one a minute is counted in, so an "uplift" below the base
    // rate would send that minute to `ordinary` and read as a defect in the split rather than as a rate
    // somebody typed wrong.
    check(
      'working_hours_rule_uplifts_are_not_reductions',
      sql`${t.overtimeMultiplierBp} >= ${t.ordinaryMultiplierBp}
       and ${t.nightMultiplierBp} >= ${t.ordinaryMultiplierBp}
       and ${t.publicHolidayMultiplierBp} >= ${t.ordinaryMultiplierBp}`,
    ),
    check(
      'working_hours_rule_provisional_names_a_question',
      sql`not ${t.isProvisional} or ${t.openQuestionId} is not null`,
    ),
    check(
      'working_hours_rule_source_note_not_placeholder',
      sql`not is_placeholder_text(${t.sourceNote})`,
    ),
  ],
)
