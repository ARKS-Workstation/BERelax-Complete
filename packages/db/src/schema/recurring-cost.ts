import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { bill } from './bill.ts'
import { account } from './ledger.ts'
import { supplier } from './supplier.ts'

/**
 * The recurring cost register — the mirror of 0031.
 *
 * The definition is configuration and stays editable; the three tables under it are **append-only**
 * (UPDATE and DELETE raise, ADR 0008/0017), because each one records what was reported at a moment: what
 * a period expected, which bill satisfied it, and what was alerted on. A period whose expectation could
 * be re-stated would silently rewrite a variance somebody has already been told about.
 *
 * ## Why every expectation appears twice
 *
 * `recurring_cost_instance` carries its own copy of the cost kind, the amount or band, and the
 * tolerance. That is a **snapshot**, not duplication: a rent renegotiated in June must not retroactively
 * change March's variance, in either direction. Same mechanism and same argument as `bill.supplier_trn`
 * in 0028.
 *
 * ## Why every amount is a bigint here
 *
 * The `fils` domain is `bigint`, and `connection.ts` returns bigint as a **string** so nothing can
 * silently round a money figure. `mode: 'number'` in a mirror undoes that for the column it is written
 * on, which is how `trial-balance.ts` came to report a four-fils difference for a ledger that balanced.
 */
export const RECURRING_CADENCES = ['monthly', 'quarterly', 'annual'] as const
export type RecurringCadence = (typeof RECURRING_CADENCES)[number]

/** fixed | variable. Mirrors the CHECK in 0031; it decides what a variance is measured against. */
export const RECURRING_COST_KINDS = ['fixed', 'variable'] as const
export type RecurringCostKind = (typeof RECURRING_COST_KINDS)[number]

/** The two alert kinds. Absence and difference need different actions, so they are different rows. */
export const RECURRING_COST_ALERT_KINDS = ['variance_over_tolerance', 'missing_cost'] as const
export type RecurringCostAlertKind = (typeof RECURRING_COST_ALERT_KINDS)[number]

export const recurringCost = pgTable(
  'recurring_cost',
  {
    recurringCostId: uuid('recurring_cost_id').primaryKey().default(sql`uuid_generate_v7()`),
    /** Stable handle for a seed, a report and a fixture. The uuid is the key. */
    code: text('code').notNull(),
    /** What the cost is, in the words the invoice will use. It becomes the bill line's description. */
    description: text('description').notNull(),
    /** Who bills it. Not null: an unattributed cost cannot be matched against an arriving bill. */
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => supplier.supplierId),
    expenseAccountCode: text('expense_account_code')
      .notNull()
      .references(() => account.code),
    /**
     * The treatment the bill line is **expected** to carry, from `bill_line.tax_treatment`'s
     * vocabulary — including `blocked_not_recoverable` since 0034, because staff transport at 02:00 is a
     * monthly contract and so a recurring cost in a blocked category, and
     * `imported_services_reverse_charge` since 0039, because every offshore vendor in 0028 is a monthly
     * subscription and the reverse charge on them is this register's ordinary offshore row.
     *
     * Expected, not authoritative: `postBill` reads the supplier's TRN snapshot and refuses a claim
     * without one, and the account's own classification decides whether a claim is possible at all.
     */
    taxTreatment: text('tax_treatment').notNull(),

    cadence: text('cadence').notNull(),
    /**
     * The anchor. Every later due date is `first_due_date + n periods`, so the series is a function of
     * the definition alone — a chain from the previous occurrence would shift on one missing row.
     *
     * A `date` column, mirrored as `date`. A timestamp mirror over a date column is drift the drift
     * check cannot see (it compares names and presence) and reads back as midnight in whatever zone the
     * session carried, which moves a due date across a month boundary. `pnpm db:conventions` is what
     * catches that, by scanning this file.
     */
    firstDueDate: date('first_due_date').notNull(),
    /** Null is open-ended, which is the normal case for rent and utilities. */
    finalDueDate: date('final_due_date'),

    /** Decides what the expectation is. Stated, never inferred from the amounts billed so far. */
    costKind: text('cost_kind').notNull(),
    /** A fixed cost's contracted amount. Null for a variable cost. */
    expectedAmountFils: bigint('expected_amount_fils', { mode: 'bigint' }),
    /** A variable cost's normal band. Null for a fixed cost. */
    expectedMinFils: bigint('expected_min_fils', { mode: 'bigint' }),
    expectedMaxFils: bigint('expected_max_fils', { mode: 'bigint' }),
    /**
     * Basis points of the breached expectation. No default in the database and none here: this is the
     * number that decides whether the alert is read, and a default makes "nobody chose" look like a
     * choice.
     */
    varianceToleranceBp: smallint('variance_tolerance_bp').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('recurring_cost_code_key').on(t.code),
    index('recurring_cost_supplier_idx').on(t.supplierId),
    check('recurring_cost_code_check', sql`${t.code} ~ '^[a-z0-9][a-z0-9-]*$'`),
    check('recurring_cost_description_check', sql`btrim(${t.description}) <> ''`),
    // Named by 0034, where the blocked treatment joined the vocabulary: 0031 left the CHECK anonymous,
    // so the next unit extending it had to guess what PostgreSQL had called it. 0039 extended it BY NAME,
    // which is what the rename was for.
    check(
      'recurring_cost_tax_treatment_allowed',
      sql`${t.taxTreatment} in ('standard_recoverable', 'blocked_not_recoverable',
                               'imported_services_reverse_charge',
                               'no_trn_not_recoverable', 'zero_rated', 'exempt', 'out_of_scope')`,
    ),
    check('recurring_cost_cadence_check', sql`${t.cadence} in ('monthly', 'quarterly', 'annual')`),
    check('recurring_cost_cost_kind_check', sql`${t.costKind} in ('fixed', 'variable')`),
    check(
      'recurring_cost_variance_tolerance_bp_check',
      sql`${t.varianceToleranceBp} between 0 and 10000`,
    ),
    // A fixed cost is an amount and nothing else; a variable cost is a band and nothing else. Both
    // directions, so a half-filled definition cannot exist: whichever non-null column a reader reached
    // for first would otherwise decide the variance.
    check(
      'recurring_cost_fixed_needs_an_expected_amount',
      sql`${t.costKind} <> 'fixed' or (${t.expectedAmountFils} is not null
            and ${t.expectedMinFils} is null and ${t.expectedMaxFils} is null)`,
    ),
    check(
      'recurring_cost_variable_needs_an_expected_range',
      sql`${t.costKind} <> 'variable' or (${t.expectedMinFils} is not null
            and ${t.expectedMaxFils} is not null and ${t.expectedAmountFils} is null)`,
    ),
    check(
      'recurring_cost_range_is_ordered',
      sql`${t.expectedMinFils} is null or ${t.expectedMaxFils} is null
            or ${t.expectedMaxFils} >= ${t.expectedMinFils}`,
    ),
    check(
      'recurring_cost_expected_amount_positive',
      sql`${t.expectedAmountFils} is null or ${t.expectedAmountFils} > 0`,
    ),
    check(
      'recurring_cost_expected_range_positive',
      sql`${t.expectedMinFils} is null or ${t.expectedMinFils} > 0`,
    ),
    check(
      'recurring_cost_ends_after_it_starts',
      sql`${t.finalDueDate} is null or ${t.finalDueDate} >= ${t.firstDueDate}`,
    ),
    // 1..28, so the anchor's day exists in every month and `date + interval '1 month'` never clamps.
    // A series that clamps in February has a day of the month that wanders period to period.
    check(
      'recurring_cost_anchor_day_is_in_every_month',
      sql`extract(day from ${t.firstDueDate}) <= 28`,
    ),
  ],
)

export const recurringCostInstance = pgTable(
  'recurring_cost_instance',
  {
    recurringCostId: uuid('recurring_cost_id')
      .notNull()
      .references(() => recurringCost.recurringCostId),
    /** `YYYY-MM` of the due date. A calendar month for every cadence, so cadences can be summed. */
    periodKey: text('period_key').notNull(),
    dueDate: date('due_date').notNull(),

    /** The expectation as it stood when this period was generated. See the file header. */
    costKind: text('cost_kind').notNull(),
    expectedAmountFils: bigint('expected_amount_fils', { mode: 'bigint' }),
    expectedMinFils: bigint('expected_min_fils', { mode: 'bigint' }),
    expectedMaxFils: bigint('expected_max_fils', { mode: 'bigint' }),
    varianceToleranceBp: smallint('variance_tolerance_bp').notNull(),

    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    // No updatedAt: the table is append-only, and a column promising a second version is a promise it
    // cannot keep.
  },
  (t) => [
    // The idempotency of generation as a constraint rather than a habit of the generator: one period per
    // cost, so a job that runs twice a day for a year cannot produce a second September.
    primaryKey({
      name: 'recurring_cost_instance_one_per_period',
      columns: [t.recurringCostId, t.periodKey],
    }),
    index('recurring_cost_instance_due_date_idx').on(t.dueDate),
    check(
      'recurring_cost_instance_period_matches_due_date',
      sql`${t.periodKey} = recurring_cost_period_key(${t.dueDate})`,
    ),
    check('recurring_cost_instance_cost_kind_check', sql`${t.costKind} in ('fixed', 'variable')`),
    check(
      'recurring_cost_instance_variance_tolerance_bp_check',
      sql`${t.varianceToleranceBp} between 0 and 10000`,
    ),
    check(
      'recurring_cost_instance_fixed_needs_an_expected_amount',
      sql`${t.costKind} <> 'fixed' or (${t.expectedAmountFils} is not null
            and ${t.expectedMinFils} is null and ${t.expectedMaxFils} is null)`,
    ),
    check(
      'recurring_cost_instance_variable_needs_an_expected_range',
      sql`${t.costKind} <> 'variable' or (${t.expectedMinFils} is not null
            and ${t.expectedMaxFils} is not null and ${t.expectedAmountFils} is null)`,
    ),
    check(
      'recurring_cost_instance_range_is_ordered',
      sql`${t.expectedMinFils} is null or ${t.expectedMaxFils} is null
            or ${t.expectedMaxFils} >= ${t.expectedMinFils}`,
    ),
  ],
)

export const recurringCostMatch = pgTable(
  'recurring_cost_match',
  {
    matchId: uuid('match_id').primaryKey().default(sql`uuid_generate_v7()`),
    recurringCostId: uuid('recurring_cost_id').notNull(),
    periodKey: text('period_key').notNull(),
    billId: uuid('bill_id')
      .notNull()
      .references(() => bill.billId),
    /** A label. The `audit_event` row written in the same transaction carries the full actor (F06). */
    matchedBy: text('matched_by').notNull(),
    matchedAt: timestamp('matched_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'recurring_cost_match_instance_fk',
      columns: [t.recurringCostId, t.periodKey],
      foreignColumns: [recurringCostInstance.recurringCostId, recurringCostInstance.periodKey],
    }),
    // The acceptance's idempotency: the second match on one period raises rather than being ignored,
    // because two bills against one month's rent is a duplicate invoice or a mis-keyed period.
    unique('recurring_cost_match_one_per_period').on(t.recurringCostId, t.periodKey),
    // And one bill satisfies at most one period, so one invoice cannot silence two missing-cost alerts.
    unique('recurring_cost_match_one_per_bill').on(t.billId),
    index('recurring_cost_match_bill_idx').on(t.billId),
    check('recurring_cost_match_matched_by_check', sql`btrim(${t.matchedBy}) <> ''`),
  ],
)

export const recurringCostAlert = pgTable(
  'recurring_cost_alert',
  {
    alertId: uuid('alert_id').primaryKey().default(sql`uuid_generate_v7()`),
    recurringCostId: uuid('recurring_cost_id').notNull(),
    periodKey: text('period_key').notNull(),
    alertKind: text('alert_kind').notNull(),
    /**
     * Signed — above the expectation is positive, below negative — so the `fils` domain rather than
     * `fils_nonneg`. An under-billing is as much a variance as an over-billing and they are opposite
     * conversations, so folding the sign away loses the first thing the reader needs.
     */
    deltaFils: bigint('delta_fils', { mode: 'bigint' }),
    /** The threshold breached, so the alert explains itself without re-deriving anything. */
    toleranceFils: bigint('tolerance_fils', { mode: 'bigint' }),
    detail: jsonb('detail').notNull(),
    /** The business day the pass was made for, not the wall clock it ran at. */
    raisedForDate: date('raised_for_date').notNull(),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'recurring_cost_alert_instance_fk',
      columns: [t.recurringCostId, t.periodKey],
      foreignColumns: [recurringCostInstance.recurringCostId, recurringCostInstance.periodKey],
    }),
    // Raised once per incident, not once per run. A daily job that re-raised would produce 365 copies of
    // one unbilled September, and the 365th is the one nobody reads.
    unique('recurring_cost_alert_once_per_period_and_kind').on(
      t.recurringCostId,
      t.periodKey,
      t.alertKind,
    ),
    index('recurring_cost_alert_raised_idx').on(t.raisedForDate, t.alertKind),
    check(
      'recurring_cost_alert_alert_kind_check',
      sql`${t.alertKind} in ('variance_over_tolerance', 'missing_cost')`,
    ),
    // An equivalence rather than two one-way checks: a missing-cost alert carrying a delta would invite
    // the reader to treat an absence as a difference.
    check(
      'recurring_cost_alert_variance_carries_a_delta',
      sql`(${t.alertKind} = 'variance_over_tolerance') = (${t.deltaFils} is not null)`,
    ),
    check(
      'recurring_cost_alert_delta_and_tolerance_travel_together',
      sql`(${t.deltaFils} is null) = (${t.toleranceFils} is null)`,
    ),
    check(
      'recurring_cost_alert_variance_delta_is_not_zero',
      sql`${t.deltaFils} is null or ${t.deltaFils} <> 0`,
    ),
  ],
)
