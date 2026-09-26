import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { employee, leaveRequest, staffLanguage } from './staff.ts'

/**
 * Drizzle mirror of the two tables `packages/db/migrations/0050_employee.sql` creates, the one
 * `packages/db/migrations/0059_hr_shift.sql` adds, the two `packages/db/migrations/0066_hr_leave.sql`
 * adds, and the six `packages/db/migrations/0081_hr_rota_version.sql` adds. The four tables 0086 adds are in
 * `./attendance.ts`, because this file mirrors the ROSTER — what the business intends people to work — and
 * those four are the record of what actually happened and what was paid for it.
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
 * `tstzrange`, which Drizzle has no built-in column type for.
 *
 * Declared here as well as in `./staff.ts`, `./rooms.ts` and `./booking.ts` rather than shared, which is
 * the convention those three already set: the text form is carried unparsed, so there is nothing for four
 * copies of five lines to disagree about, and a shared helper that grew a parser would put range
 * semantics in the ORM layer where a caller could build an inclusive upper bound without noticing. The
 * database refuses anything but `[)` (`rota_version_assignment_period_half_open`).
 */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType: () => 'tstzrange',
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

/**
 * The five kinds of leave-balance movement (migration 0066).
 *
 * The sign is fixed per kind and held at the database by `leave_movement_sign_matches_kind`:
 * `opening_balance`, `accrual` and `released` add, `reserved` and `carry_over_forfeited` take away.
 * That is what makes the balance the plain sum of one column, and therefore what lets `leave_balance`
 * be a view rather than a stored figure.
 *
 * There is deliberately **no `taken`**. A request reserves when it is made and the reservation only
 * stops being refundable when it is approved, so an approval moves no balance and writes no row. A
 * `taken` row at approval would have to be paired with a reversal of the reservation in the same breath,
 * which is two rows saying one thing — the classic way a ledger comes to disagree with itself.
 */
export const leaveMovementKind = pgEnum('leave_movement_kind', [
  'opening_balance',
  'accrual',
  'carry_over_forfeited',
  'reserved',
  'released',
])

/**
 * The versioned leave policy (migration 0066): entitlement, accrual, probation, carry-over and the
 * sick-leave bands.
 *
 * One row per **version**, keyed on the first date it governs, and the version that applies to a date is
 * the latest row at or before it. The same decision `workingHoursRule` above records, for the same
 * reason: leave is asked about the past. A disputed month recomputed after a policy change must use the
 * policy that applied then, and a single current value — an `app_setting` row, a `superseded_at` column —
 * answers it with today's figures, which are plausible and wrong.
 *
 * Every quantity is integer **day-hundredths**; 250 is 2.5 days. ADR 0007's rule that money is integer is
 * about reconciliation rather than about money, and
 * `leave_entitlement_rule_annual_total_matches_monthly_accrual` is what it buys: the headline entitlement
 * and twelve months of accrual are the same figure stated twice, so the database refuses a version where
 * they disagree.
 *
 * `carryOverExpiresAfterOneLeaveYear` is a boolean and not a month count on purpose — a count could state
 * an expiry the pure engine has no per-day ledger to honour, and a policy the code silently rounds is
 * worse than one it cannot express. Version 1 seeds it FALSE, which is where the two recorded provisional
 * answers conflict; 0066's header states the conflict and why not-expiring is the safe direction.
 *
 * Every figure is provisional against **Y9-leave-detail**, so `unconfirmedAssumptionRows()` lists the
 * version the same way it lists `app_setting` — per VERSION and not per figure, because the whole policy
 * is one decision somebody makes in one sitting.
 */
export const leaveEntitlementRule = pgTable(
  'leave_entitlement_rule',
  {
    /** The first date this version governs. Not a foreign key into `business_day`: see 0059's reason. */
    effectiveFrom: date('effective_from').primaryKey(),
    /** Whole calendar days. A leave day is a calendar day, never a working day. */
    annualEntitlementDays: integer('annual_entitlement_days').notNull(),
    /** Day-hundredths earned by a whole month of service. 250 is 2.5 days. */
    monthlyAccrualHundredths: integer('monthly_accrual_hundredths').notNull(),
    probationMonths: integer('probation_months').notNull(),
    /** Whether accrual RUNS during probation. Whether leave may be TAKEN is not a column; see 0066. */
    accruesDuringProbation: boolean('accrues_during_probation').notNull(),
    carryOverCapHundredths: integer('carry_over_cap_hundredths').notNull(),
    carryOverExpiresAfterOneLeaveYear: boolean('carry_over_expires_after_one_leave_year').notNull(),
    leaveYearStartsOnAnniversary: boolean('leave_year_starts_on_anniversary').notNull(),
    unpaidLeaveReducesAccrual: boolean('unpaid_leave_reduces_accrual').notNull(),
    absentDayReducesAccrual: boolean('absent_day_reduces_accrual').notNull(),
    /** With 15 here, day 15 is full pay and day 16 is the first half-pay day. */
    sickFullPayDays: integer('sick_full_pay_days').notNull(),
    sickHalfPayDays: integer('sick_half_pay_days').notNull(),
    sickUnpaidDays: integer('sick_unpaid_days').notNull(),
    isProvisional: boolean('is_provisional').notNull(),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    /** Where the figures came from. NOT NULL and never a placeholder, for brief rule 15's reason. */
    sourceNote: text('source_note').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'leave_entitlement_rule_annual_entitlement_plausible',
      sql`${t.annualEntitlementDays} > 0 and ${t.annualEntitlementDays} <= 366`,
    ),
    check(
      'leave_entitlement_rule_monthly_accrual_plausible',
      sql`${t.monthlyAccrualHundredths} >= 0 and ${t.monthlyAccrualHundredths} <= 36600`,
    ),
    // The contract figure and the ledger figure are the same entitlement stated twice. Without this, one
    // goes on the contract and a different one into the ledger, both look reasonable, and the discrepancy
    // is found a year later by an employee counting their own days.
    check(
      'leave_entitlement_rule_annual_total_matches_monthly_accrual',
      sql`${t.annualEntitlementDays} * 100 = ${t.monthlyAccrualHundredths} * 12`,
    ),
    check(
      'leave_entitlement_rule_probation_plausible',
      sql`${t.probationMonths} >= 0 and ${t.probationMonths} <= 60`,
    ),
    check(
      'leave_entitlement_rule_carry_over_cap_plausible',
      sql`${t.carryOverCapHundredths} >= 0 and ${t.carryOverCapHundredths} <= 36600`,
    ),
    check(
      'leave_entitlement_rule_sick_full_plausible',
      sql`${t.sickFullPayDays} >= 0 and ${t.sickFullPayDays} <= 366`,
    ),
    check(
      'leave_entitlement_rule_sick_half_plausible',
      sql`${t.sickHalfPayDays} >= 0 and ${t.sickHalfPayDays} <= 366`,
    ),
    check(
      'leave_entitlement_rule_sick_unpaid_plausible',
      sql`${t.sickUnpaidDays} >= 0 and ${t.sickUnpaidDays} <= 366`,
    ),
    // A tier set with nothing in any band answers `exhausted` to every day of every illness, which
    // satisfies any boundary test written against it while entitling nobody to anything.
    check(
      'leave_entitlement_rule_sick_tiers_are_not_all_empty',
      sql`${t.sickFullPayDays} + ${t.sickHalfPayDays} + ${t.sickUnpaidDays} > 0`,
    ),
    check(
      'leave_entitlement_rule_provisional_names_a_question',
      sql`not ${t.isProvisional} or ${t.openQuestionId} is not null`,
    ),
    check(
      'leave_entitlement_rule_source_note_not_placeholder',
      sql`not is_placeholder_text(${t.sourceNote})`,
    ),
  ],
)

/**
 * Every movement of every leave balance (migration 0066), signed, in day-hundredths.
 *
 * **Append-only: UPDATE and DELETE raise ZH001 for every role**, by `refuse_leave_movement_change()`. A
 * balance that could be edited is one nobody can reconcile, so a correction is a further movement and
 * never an edit — the same rule `journalLine` (0018) and `recurringCostInstance` (0031) follow, for the
 * same reason.
 *
 * The balance has no other home. `leave_balance` is a VIEW summing this table, which is what makes "the
 * sum of the movements equals the balance" true by construction instead of by a reconciliation job nobody
 * runs — and a leave balance is the figure in an HR system most often corrected retrospectively, so a
 * stored column would disagree with the movements the first time a month was re-accrued or a holiday
 * withdrawn.
 *
 * Neither trigger, neither partial unique index nor the view is expressible in Drizzle. All of them live
 * in the migration and are asserted against real PostgreSQL by
 * `apps/worker/src/jobs/leave-accrual.itest.ts` — in particular `leave_movement_one_accrual_per_month`,
 * which IS the accrual job's idempotency guarantee rather than a check on it.
 */
export const leaveMovement = pgTable(
  'leave_movement',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /**
     * `RESTRICT`, for 0030's reason: somebody who has accrued leave has a history, and deleting the
     * person to clear the balance is the delete this refuses. Ending employment is `employedUntil`.
     */
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    kind: leaveMovementKind('kind').notNull(),
    /** Signed day-hundredths. The balance is the SUM of this column and nothing else. */
    hundredths: integer('hundredths').notNull(),
    /**
     * A date and not an instant, because a leave movement is a fact about a day and never about a moment
     * inside one — the opposite of `shift.period`, which is instants for exactly the opposite reason.
     */
    occurredOn: date('occurred_on').notNull(),
    /**
     * Computed once by `leaveYearStart()` in `@berelax/core` and stored, because the anchor is a POLICY
     * (the employment anniversary, or 1 January) and re-deriving it in SQL would be a second reading of
     * that policy which disagrees for every employee not engaged on 1 January.
     */
    leaveYearStart: date('leave_year_start').notNull(),
    /** Set on `accrual` and nothing else. With `employeeId` it is the accrual job's idempotency key. */
    accrualMonth: date('accrual_month'),
    /** Set on `reserved` and `released` and nothing else. */
    leaveRequestId: uuid('leave_request_id').references(() => leaveRequest.id),
    /**
     * The policy version that produced the figure. The AMOUNT is snapshotted on this row, so editing a
     * version cannot change a balance already earned — only the explanation of how it was reached.
     */
    ruleEffectiveFrom: date('rule_effective_from').references(
      () => leaveEntitlementRule.effectiveFrom,
    ),
    /** A label, not a uuid: the audit row written in the same transaction carries the actor (F06). */
    createdBy: text('created_by').notNull(),
    /** NOT NULL for an opening balance and null otherwise, held by a CHECK in the migration. */
    sourceNote: text('source_note'),
    isProvisional: boolean('is_provisional').notNull(),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('leave_movement_employee_idx').on(t.employeeId, t.occurredOn),
    // The sign is the kind's, always. A positive `reserved` row would credit leave the employee asked to
    // spend, and the balance would still be the sum of the column, so nothing else could notice.
    check(
      'leave_movement_sign_matches_kind',
      sql`case ${t.kind}
            when 'carry_over_forfeited' then ${t.hundredths} <= 0
            when 'reserved'             then ${t.hundredths} <= 0
            else ${t.hundredths} >= 0
          end`,
    ),
    // Biconditionals throughout: an accrual with no month is as wrong as a forfeiture with one, and one
    // named constraint catches both directions.
    check(
      'leave_movement_accrual_month_matches_kind',
      sql`(${t.kind} = 'accrual') = (${t.accrualMonth} is not null)`,
    ),
    check(
      'leave_movement_accrual_month_is_a_first',
      sql`${t.accrualMonth} is null or extract(day from ${t.accrualMonth}) = 1`,
    ),
    check(
      'leave_movement_request_matches_kind',
      sql`(${t.kind} in ('reserved', 'released')) = (${t.leaveRequestId} is not null)`,
    ),
    check(
      'leave_movement_rule_matches_kind',
      sql`(${t.kind} in ('accrual', 'carry_over_forfeited')) = (${t.ruleEffectiveFrom} is not null)`,
    ),
    check(
      'leave_movement_opening_balance_has_provenance',
      sql`(${t.kind} = 'opening_balance') = (${t.sourceNote} is not null)
       and (${t.sourceNote} is null or not is_placeholder_text(${t.sourceNote}))`,
    ),
    check(
      'leave_movement_provisional_names_a_question',
      sql`not ${t.isProvisional} or ${t.openQuestionId} is not null`,
    ),
    check(
      'leave_movement_created_by_not_placeholder',
      sql`not is_placeholder_text(${t.createdBy})`,
    ),
  ],
)

/**
 * The versioned coverage and fatigue thresholds (0081).
 *
 * Versioned rows and not `app_setting` values, because a rota is asked about the PAST: raising the floor
 * minimum in April must not make March's published rota retroactively non-compliant, and one current
 * value cannot say what the threshold was when the rota was published. `rota_version` names the row that
 * judged it, so the record is "this rota satisfied THESE thresholds" rather than "this rota was valid",
 * and only the first stays true. 0081's header argues it at length.
 */
export const rotaCoverageRule = pgTable(
  'rota_coverage_rule',
  {
    /** The first trading date this version governs. No FK to `business_day`, for 0059's reason. */
    effectiveFrom: date('effective_from').primaryKey(),
    /** The grid the floor is counted on. A judgement about how short a gap in cover may be, not a constant. */
    coverageSegmentMinutes: smallint('coverage_segment_minutes').notNull(),
    /** Therapists, not employees: a receptionist on shift covers no treatment. */
    minimumTherapistsOnFloor: smallint('minimum_therapists_on_floor').notNull(),
    minimumWetRoomCapable: smallint('minimum_wet_room_capable').notNull(),
    /** TREATMENT minutes, not rostered minutes. The rostered side is `working_hours_rule`'s. */
    treatmentMinutesCapPerDay: smallint('treatment_minutes_cap_per_day').notNull(),
    highIntensityMinutesCapPerDay: smallint('high_intensity_minutes_cap_per_day').notNull(),
    /**
     * EMPTY in version 1, which makes the sub-cap inert rather than absent. No treatment in the catalogue
     * is recorded as heavy work and 0004 refuses "Therapeutic Deep Tissue" as a claim, so a list here
     * would be invented (Y9-coverage, brief rule 15).
     */
    highIntensityTreatmentCodes: text('high_intensity_treatment_codes').array().notNull(),
    isProvisional: boolean('is_provisional').notNull(),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    sourceNote: text('source_note').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('rota_coverage_rule_floor_minimum_is_positive', sql`${t.minimumTherapistsOnFloor} >= 1`),
    check(
      'rota_coverage_rule_wet_minimum_not_above_floor',
      sql`${t.minimumWetRoomCapable} >= 0
       and ${t.minimumWetRoomCapable} <= ${t.minimumTherapistsOnFloor}`,
    ),
    check(
      'rota_coverage_rule_treatment_cap_plausible',
      sql`${t.treatmentMinutesCapPerDay} > 0 and ${t.treatmentMinutesCapPerDay} <= 1440`,
    ),
    // A sub-cap above the total cap could never fire, because the total would refuse first — which reads
    // as a rule that passes.
    check(
      'rota_coverage_rule_high_intensity_cap_within_total',
      sql`${t.highIntensityMinutesCapPerDay} >= 0
       and ${t.highIntensityMinutesCapPerDay} <= ${t.treatmentMinutesCapPerDay}`,
    ),
    check(
      'rota_coverage_rule_provisional_names_a_question',
      sql`not ${t.isProvisional} or ${t.openQuestionId} is not null`,
    ),
    check(
      'rota_coverage_rule_source_note_not_placeholder',
      sql`not is_placeholder_text(${t.sourceNote})`,
    ),
  ],
)

/**
 * The versioned monthly-wage divisors the forecast needs (0081).
 *
 * A separate table from `working_hours_rule` although both are versioned on a trading date: the divisor
 * answers what an hour of a monthly salary is worth and the multipliers answer what an uplift is, they
 * will be answered by different people, and two units' figures in one row would mean confirming
 * Y9-overtime's multipliers also restated a divisor nobody asked about.
 */
export const labourCostRule = pgTable(
  'labour_cost_rule',
  {
    effectiveFrom: date('effective_from').primaryKey(),
    /** Calendar days a monthly wage is taken to cover. 30 — the MOHRE convention, not a confirmed figure. */
    monthlyWageDaysDivisor: smallint('monthly_wage_days_divisor').notNull(),
    /**
     * The DENOMINATOR, and deliberately not `working_hours_rule.ordinary_minutes_per_day` although
     * version 1 carries the same 480: that figure is a CAP, and reading a cap as a denominator makes
     * every hour cheaper the day somebody raises the daily cap.
     */
    paidMinutesPerDay: smallint('paid_minutes_per_day').notNull(),
    isProvisional: boolean('is_provisional').notNull(),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    sourceNote: text('source_note').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'labour_cost_rule_days_divisor_plausible',
      sql`${t.monthlyWageDaysDivisor} between 1 and 31`,
    ),
    check(
      'labour_cost_rule_paid_minutes_plausible',
      sql`${t.paidMinutesPerDay} between 1 and 1440`,
    ),
    check(
      'labour_cost_rule_provisional_names_a_question',
      sql`not ${t.isProvisional} or ${t.openQuestionId} is not null`,
    ),
    check(
      'labour_cost_rule_source_note_not_placeholder',
      sql`not is_placeholder_text(${t.sourceNote})`,
    ),
  ],
)

/**
 * One PUBLISHED rota, immutable (0081).
 *
 * There is no status column and no draft row, and that is 0030's decision rather than a simplification:
 * the draft already exists as `shift` plus `shift_assignment`, which "is rewritten" freely, and a draft
 * version row would be a second draft for the two to disagree about. An edit to a published rota is a NEW
 * row carrying `supersedesId`.
 *
 * Four triggers and two of this file's constraints are not expressible in Drizzle and live in the
 * migration: `refuse_published_rota_change` (ZW001) refuses every UPDATE and DELETE for every role
 * including the owner, `assert_rota_version_sequence` (ZW005) keeps the numbering unbroken, and the
 * DEFERRED `rota_version_changes_something` (ZW003) refuses a re-publish whose assignment set is
 * identical to its predecessor's — which is how an unchanged re-publish emits no staff notification: it
 * creates no version at all. `packages/fixtures/src/hr-rota.itest.ts` asserts all four against real
 * PostgreSQL.
 */
export const rotaVersion = pgTable(
  'rota_version',
  {
    id: uuid('id').primaryKey(),
    /**
     * Inclusive at both ends, because a trading date is a whole session and a half-open date range
     * invites the off-by-one that drops the last day. NOT foreign-keyed into `business_day`: the period
     * is a label for what was published and its ends may fall on a closed date, while every
     * ASSIGNMENT's trading date is constrained, which is where the claim is true.
     */
    fromTradingDate: date('from_trading_date').notNull(),
    toTradingDate: date('to_trading_date').notNull(),
    /**
     * Forward-only supersession, and UNIQUE is the load-bearing part: two concurrent publishes both
     * superseding version 3 would otherwise leave two rival current rotas with nothing able to choose.
     */
    supersedesId: uuid('supersedes_id').references((): AnyPgColumn => rotaVersion.id, {
      onDelete: 'restrict',
    }),
    versionNo: integer('version_no').notNull(),
    /**
     * The three rule versions that judged and priced it. Plain dates and NOT foreign keys.
     *
     * A row in an immutable table records what was true and holds nothing else hostage: `rota_version` can
     * never be deleted, so a RESTRICT reference from it makes its parent undeletable for ever from the first
     * rota published. These three began as references and stopped
     * `packages/fixtures/src/hr-working-hours.itest.ts` emptying `working_hours_rule` in a probe, which is
     * how P-HR-05 proves its reader throws rather than inventing rates.
     */
    coverageRuleEffectiveFrom: date('coverage_rule_effective_from').notNull(),
    workingHoursRuleEffectiveFrom: date('working_hours_rule_effective_from').notNull(),
    labourCostRuleEffectiveFrom: date('labour_cost_rule_effective_from').notNull(),
    /** Integer fils on the `fils_nonneg` domain, VAT-free: a wage is not a supply. */
    forecastLabourCostFils: bigint('forecast_labour_cost_fils', { mode: 'bigint' }).notNull(),
    /**
     * Assigned employees with no `basic_wage_fils` on file when the forecast was made. NOT NULL on every
     * version, because an unpriced employee contributes nothing to a sum: a forecast over a rota of
     * unpriced therapists is 0 fils and reads as a free rota. All nineteen seeded employees are unpriced.
     */
    forecastUnpricedEmployees: smallint('forecast_unpriced_employees').notNull(),
    /** sha-256 of `rotaAssignmentCanonicalForm()` in `@berelax/core`, hashed by `publishRota`. */
    assignmentDigest: text('assignment_digest').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    /** A label, not a uuid: there is no admin session until W-SYS-01 and the audit row carries the actor. */
    publishedBy: text('published_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('rota_version_supersedes_key').on(t.supersedesId),
    uniqueIndex('rota_version_number_unique_per_period').on(
      t.fromTradingDate,
      t.toTradingDate,
      t.versionNo,
    ),
    index('rota_version_period_idx').on(t.fromTradingDate, t.toTradingDate, t.versionNo),
    check('rota_version_period_ordered', sql`${t.toTradingDate} >= ${t.fromTradingDate}`),
    check('rota_version_number_is_positive', sql`${t.versionNo} >= 1`),
    check('rota_version_unpriced_count_nonneg', sql`${t.forecastUnpricedEmployees} >= 0`),
    check('rota_version_digest_is_a_sha256_hex', sql`${t.assignmentDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      'rota_version_published_by_not_placeholder',
      sql`not is_placeholder_text(${t.publishedBy}) and btrim(${t.publishedBy}) <> ''`,
    ),
  ],
)

/**
 * The published rota, snapshotted (0081).
 *
 * Copies rather than references `shift_assignment`, because `shift_assignment.shift_id` is ON DELETE
 * CASCADE and a published rota that lost rows when a draft shift was deleted would not be immutable —
 * which is the one claim this table exists to make. `sourceShiftId` is a plain uuid and NOT a foreign key,
 * which is 0077's decision for `pipeline_stage_transition.customer_id` verbatim and for exactly its reason:
 * an immutable table cannot reference a mutable parent, because the referential action arrives as an UPDATE
 * and ZW001 refuses every UPDATE — so `delete from shift` would become impossible and the draft roster
 * could never be rewritten again.
 */
export const rotaVersionAssignment = pgTable(
  'rota_version_assignment',
  {
    rotaVersionId: uuid('rota_version_id')
      .notNull()
      .references(() => rotaVersion.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /**
     * Snapshotted, and deliberately NOT foreign-keyed into `business_day` — the opposite of
     * `shift.trading_date`, because a shift row is mutable and this one is not. `business_day` is GENERATED:
     * a row is deleted when a date stops trading, and `business-days.itest.ts` empties the table to prove it.
     * A RESTRICT reference from a row that can never be deleted pinned every date it named and broke the
     * generator. The guard lives on `shift.trading_date`, where the row is mutable and the error is fixable.
     */
    tradingDate: date('trading_date').notNull(),
    period: tstzrange('period').notNull(),
    sourceShiftId: uuid('source_shift_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // Two identical rows would be counted twice by the coverage read and would double the forecast.
    primaryKey({ columns: [t.rotaVersionId, t.employeeId, t.period] }),
    index('rota_version_assignment_employee_idx').on(t.employeeId, t.tradingDate),
    index('rota_version_assignment_date_idx').on(t.rotaVersionId, t.tradingDate),
    check('rota_version_assignment_period_nonempty', sql`not isempty(${t.period})`),
    check(
      'rota_version_assignment_period_bounded',
      sql`lower(${t.period}) is not null and upper(${t.period}) is not null`,
    ),
    check(
      'rota_version_assignment_period_half_open',
      sql`lower_inc(${t.period}) and not upper_inc(${t.period})`,
    ),
  ],
)

/**
 * Swaps and open-shift claims, append-only, each decided in the transaction that made it (0081).
 *
 * No pending state: a pending request needs an APPROVER and there is no admin session until W-SYS-01, so
 * a pending row would wait for an identity that does not exist and the first thing built on it would be a
 * way to approve without one. The refused rows are the point of the table — "why can't I swap with her on
 * Thursday?" has one answer and it is the rule name the validator returned.
 */
export const rotaChangeRequest = pgTable(
  'rota_change_request',
  {
    id: uuid('id').primaryKey(),
    /** `swap` or `open_shift_claim`. */
    kind: text('kind').notNull(),
    rotaVersionId: uuid('rota_version_id')
      .notNull()
      .references(() => rotaVersion.id, { onDelete: 'restrict' }),
    /** The DRAFT shift, because that is what a swap or a claim moves. */
    shiftId: uuid('shift_id'),
    /** Null for a claim: an open shift has no assignment, so there is nobody to take it from. */
    fromEmployeeId: uuid('from_employee_id').references(() => employee.id, {
      onDelete: 'restrict',
    }),
    toEmployeeId: uuid('to_employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /** `applied` or `refused`, decided in the same transaction. */
    decision: text('decision').notNull(),
    /**
     * The rule name `@berelax/core` returned. TEXT and not an enum: the rule set is `packages/core`'s and
     * a migration per new rule would put the vocabulary in two places.
     */
    refusedRule: text('refused_rule'),
    refusalDetail: text('refusal_detail'),
    appliedRotaVersionId: uuid('applied_rota_version_id').references(() => rotaVersion.id, {
      onDelete: 'restrict',
    }),
    requestedBy: text('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('rota_change_request_applied_version_key').on(t.appliedRotaVersionId),
    index('rota_change_request_version_idx').on(t.rotaVersionId, t.requestedAt),
    index('rota_change_request_employee_idx').on(t.toEmployeeId, t.requestedAt),
    check('rota_change_request_kind_known', sql`${t.kind} in ('swap', 'open_shift_claim')`),
    check(
      'rota_change_request_swap_has_two_sides',
      sql`(${t.kind} = 'swap') = (${t.fromEmployeeId} is not null)`,
    ),
    check(
      'rota_change_request_sides_differ',
      sql`${t.fromEmployeeId} is null or ${t.fromEmployeeId} <> ${t.toEmployeeId}`,
    ),
    check('rota_change_request_decision_known', sql`${t.decision} in ('applied', 'refused')`),
    // Biconditionals both ways: a refusal with no rule is a refusal nobody can answer, and an applied
    // request carrying one is a row two readers would count differently.
    check(
      'rota_change_request_refusal_names_a_rule',
      sql`(${t.decision} = 'refused') = (${t.refusedRule} is not null)`,
    ),
    check(
      'rota_change_request_refusal_detail_follows_the_rule',
      sql`${t.refusedRule} is not null or ${t.refusalDetail} is null`,
    ),
    check(
      'rota_change_request_application_names_a_version',
      sql`(${t.decision} = 'applied') = (${t.appliedRotaVersionId} is not null)`,
    ),
    check(
      'rota_change_request_requested_by_not_placeholder',
      sql`not is_placeholder_text(${t.requestedBy}) and btrim(${t.requestedBy}) <> ''`,
    ),
  ],
)

/**
 * One row per assigned employee per published version: the staff notification (0081).
 *
 * A notice row rather than a `message` row alone, because **nothing in this build holds a staff contact
 * detail** — `employee` has no phone and no email, there is no `employee_contact` table, and a plausible
 * address would be indistinguishable from a configured one in the one place it would actually reach a
 * stranger (brief rule 15). 0075 had to record the same thing for the Google re-auth ladder and answers it
 * the same way: the outcome is `skipped` with `no_recipient_on_file`, which says what was attempted, for
 * whom and against which template, rather than being a no-op that reports success (docs/12 §1).
 *
 * UNIQUE on (version, employee) is what makes it one per EMPLOYEE rather than one per shift: somebody
 * rostered on four days of the week is told once about the week, and a publisher that looped over
 * assignments would be refused here rather than sending four messages.
 */
export const rotaPublicationNotice = pgTable(
  'rota_publication_notice',
  {
    id: uuid('id').primaryKey(),
    rotaVersionId: uuid('rota_version_id')
      .notNull()
      .references(() => rotaVersion.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /** Pinned to `hr.rota_published` by a CHECK: a rota is a fact about somebody's working week, so the
     * marketing kill switch and the promotional sender identity must not be able to reach it. */
    templateKey: text('template_key').notNull(),
    /** `sent` or `skipped`. */
    outcome: text('outcome').notNull(),
    /** `no_recipient_on_file` is the shipped state rather than an edge case. */
    skippedReason: text('skipped_reason'),
    /** Nullable even for `sent`, for 0075's reason: F03 diverts every send outside production. */
    messageId: uuid('message_id'),
    notifiedAt: timestamp('notified_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('rota_publication_notice_one_per_employee_per_version').on(
      t.rotaVersionId,
      t.employeeId,
    ),
    index('rota_publication_notice_employee_idx').on(t.employeeId, t.notifiedAt),
    check(
      'rota_publication_notice_template_is_the_rota_one',
      sql`${t.templateKey} = 'hr.rota_published'`,
    ),
    check('rota_publication_notice_outcome_known', sql`${t.outcome} in ('sent', 'skipped')`),
    check(
      'rota_publication_notice_skipped_reason_known',
      sql`${t.skippedReason} in ('no_recipient_on_file', 'send_refused')`,
    ),
    check(
      'rota_publication_notice_skip_carries_a_reason',
      sql`(${t.outcome} = 'skipped') = (${t.skippedReason} is not null)`,
    ),
    check(
      'rota_publication_notice_skip_produced_no_message',
      sql`${t.skippedReason} is null or ${t.messageId} is null`,
    ),
  ],
)
