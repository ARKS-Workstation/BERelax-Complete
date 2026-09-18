import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * The append-only double-entry journal (ADR 0017), mirroring `0018_ledger.sql`.
 *
 * Migrations are SQL-first (ADR 0006): the hand-written `.sql` is the schema and this is a mirror
 * that `pnpm db:drift` compares against the live database in both directions. Nothing in this package
 * writes through Drizzle — the write path is `repositories/journal.ts` — so what is mirrored here is
 * the *shape*, so a drifting column fails the build rather than a query at the till.
 *
 * Three things this mirror cannot express, and which therefore live only in the migration:
 *
 *   - the **refusal triggers** that make UPDATE and DELETE raise `ZL001` for every role;
 *   - the **deferred constraint trigger** that checks debits equal credits at COMMIT rather than at
 *     each INSERT, because the lines of one entry arrive as separate statements;
 *   - the **grants**, which are what stop an injected statement reaching UPDATE at all.
 *
 * All three are proved against a real PostgreSQL in `repositories/journal.itest.ts`, because a grant
 * and a deferred trigger cannot be tested against a mock.
 */

/**
 * One row per chart of accounts, carrying the provisional marker.
 *
 * The marker is data, not a comment: Y8-coa is open, and an accountant reading the database has to be
 * able to see that the classification is a standing-in assumption rather than a confirmed decision.
 */
export const chartOfAccounts = pgTable(
  'chart_of_accounts',
  {
    /** 'standard-spa-uae'. Matches `ChartOfAccounts.id` in @berelax/core. */
    id: text('id').primaryKey(),
    /** The open question this chart stands in for, or null once an owner has confirmed it. */
    provisionalOpenQuestionId: text('provisional_open_question_id'),
    /** What standing in for it assumes. Null exactly when the question id is null. */
    provisionalNote: text('provisional_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('chart_of_accounts_id_check', sql`btrim(${t.id}) <> ''`),
    check(
      'chart_of_accounts_provisional_pair',
      sql`(${t.provisionalOpenQuestionId} is null) = (${t.provisionalNote} is null)`,
    ),
  ],
)

/**
 * The chart of accounts. Every classification is stated and none of them has a default.
 *
 * `normalBalance` is stored rather than derived from `type`, because the sign of a balance is not
 * derivable from the type alone: accumulated depreciation is an asset on the credit side and owner's
 * drawings is equity on the debit side. "Asset implies debit" is right for most accounts and produces
 * a balance sheet with the wrong sign for the rest — an error that still reconciles to zero while
 * misstating the figure a reader cares about.
 *
 * The rows are **generated** from `STANDARD_SPA_CHART` in @berelax/core and compared back field by
 * field by `packages/fixtures/src/ledger-chart.itest.ts`, so this table and that chart cannot drift.
 */
export const account = pgTable(
  'account',
  {
    /** Four digits, e.g. '1010'. Never renumbered: entries reference codes. */
    code: text('code').primaryKey(),
    chartId: text('chart_id')
      .notNull()
      .references(() => chartOfAccounts.id),
    name: text('name').notNull(),
    /** 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'. */
    type: text('type').notNull(),
    /** 'debit' | 'credit'. Constrained in the migration to agree with type and contra. */
    normalBalance: text('normal_balance').notNull(),
    /** True for a contra account: under one type, carrying the opposite side. Stated, not inferred. */
    contra: boolean('contra').notNull(),
    /**
     * The VAT201 grouping this account feeds, or null for "feeds none".
     *
     * Nullable but explicit. Null is a decision and never "not yet classified" — a distinction SQL
     * cannot enforce, which is why the round-trip test compares this column against a chart whose
     * `defineAccount()` refuses an omitted `vatBox` at construction.
     */
    vatBox: text('vat_box'),
    inputVatRecoverable: boolean('input_vat_recoverable').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('account_type_idx').on(t.type, t.code),
    check('account_code_check', sql`${t.code} ~ '^[0-9]{4}$'`),
    check('account_name_check', sql`btrim(${t.name}) <> ''`),
    check(
      'account_type_check',
      sql`${t.type} in ('asset', 'liability', 'equity', 'revenue', 'expense')`,
    ),
    check('account_normal_balance_check', sql`${t.normalBalance} in ('debit', 'credit')`),
    check(
      'account_vat_box_check',
      sql`${t.vatBox} in ('standard_rated_supplies', 'zero_rated_supplies', 'exempt_supplies',
                          'reverse_charge', 'output_tax', 'recoverable_input_tax', 'blocked_input_tax')`,
    ),
    check(
      'account_normal_balance_matches_type',
      sql`${t.normalBalance} = case when (${t.type} in ('asset', 'expense')) <> ${t.contra}
                                    then 'debit' else 'credit' end`,
    ),
    check(
      'account_blocked_input_vat_is_not_recoverable',
      sql`not (${t.vatBox} = 'blocked_input_tax' and ${t.inputVatRecoverable})`,
    ),
  ],
)

/**
 * One journal entry. Append-only: UPDATE and DELETE raise `ZL001`.
 *
 * There is no `updated_at` and no `set_updated_at` trigger, deliberately. A row here has no second
 * version, so a column promising one would be a promise the table cannot keep — and the first person
 * to see it would reasonably conclude that an edit path exists somewhere.
 */
export const journalEntry = pgTable(
  'journal_entry',
  {
    /**
     * Allocated by the caller, not by the database.
     *
     * @berelax/core constructs an entry around an id it was given; a surrogate key generated here
     * would leave the id core validated with nothing to match against on the way back.
     */
    entryId: text('entry_id').primaryKey(),
    /**
     * The **business day** the entry belongs to, already resolved by the caller.
     *
     * Trading runs 11:00–02:00, so a 01:30 sale belongs to the previous trading date. Not a foreign
     * key to `business_day`: a closed date is absent from that table, and the journal must still be
     * able to record the rent for a month containing days the premises were shut.
     */
    entryDate: date('entry_date').notNull(),
    narrative: text('narrative').notNull(),
    /** Why the entry exists. Carried, because a refund and a cancelled sale have identical lines. */
    source: text('source').notNull(),
    /** 'AED'. One entry, one currency; widening this is a migration and a decision. */
    currency: text('currency').notNull(),
    /** The entry this one reverses, or null. A correction is a new entry pointing at the old one. */
    reverses: text('reverses'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('journal_entry_date_idx').on(t.entryDate, t.entryId),
    index('journal_entry_source_idx').on(t.source, t.entryDate),
    check('journal_entry_entry_id_check', sql`btrim(${t.entryId}) <> ''`),
    check('journal_entry_narrative_check', sql`btrim(${t.narrative}) <> ''`),
    check(
      'journal_entry_source_check',
      sql`${t.source} in ('sale', 'refund', 'payment', 'payout', 'cash_up', 'supplier_bill',
                          'payroll', 'gratuity_accrual', 'commission_accrual', 'package_sale',
                          'package_redemption', 'voucher_sale', 'voucher_redemption',
                          'depreciation', 'opening_balance', 'adjustment', 'reversal')`,
    ),
    check('journal_entry_currency_check', sql`${t.currency} = 'AED'`),
    check(
      'journal_entry_is_not_its_own_reversal',
      sql`${t.reverses} is distinct from ${t.entryId}`,
    ),
  ],
)

/**
 * One line of one entry. Append-only: UPDATE and DELETE raise `ZL001`.
 *
 * Balance is **not** a constraint on this table — it is a property of the set of lines belonging to an
 * entry, checked at COMMIT by a deferred constraint trigger. See `0018_ledger.sql`.
 */
export const journalLine = pgTable(
  'journal_line',
  {
    entryId: text('entry_id')
      .notNull()
      .references(() => journalEntry.entryId),
    /** Position within the entry, so two runs over the same entry produce identical working papers. */
    lineNo: smallint('line_no').notNull(),
    accountCode: text('account_code')
      .notNull()
      .references(() => account.code),
    /**
     * Integer fils, VAT-inclusive gross (ADR 0007), on the `fils_nonneg` domain.
     *
     * `mode: 'bigint'` rather than `'number'`: the driver returns bigint as a string precisely so an
     * amount cannot silently lose precision (see connection.ts), and a mirror that re-introduced a JS
     * number here would undo that for the columns a tax authority adds up.
     */
    debitFils: bigint('debit_fils', { mode: 'bigint' }).notNull(),
    creditFils: bigint('credit_fils', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    memo: text('memo'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('journal_line_account_idx').on(t.accountCode, t.entryId),
    check('journal_line_line_no_check', sql`${t.lineNo} >= 1`),
    check('journal_line_currency_check', sql`${t.currency} = 'AED'`),
    // Direction is the side, never the sign: a negative debit and a positive credit both balance, and
    // only one of them is what the poster meant.
    check('journal_line_exactly_one_side', sql`(${t.debitFils} = 0) <> (${t.creditFils} = 0)`),
  ],
)

/**
 * A closed accounting period. Nothing may be posted with an `entry_date` inside one.
 *
 * Period locking is what makes a VAT return meaningful: without it, a return filed on the 28th
 * describes a period that can still change on the 29th. M-TILL-01 exports no period-lock predicate
 * for exactly this reason — two answers to "is February closed" is one answer plus a future
 * disagreement, so the lock lives next to the rows it protects.
 */
export const periodLock = pgTable(
  'period_lock',
  {
    /** '2026-08', '2026-Q3'. Appears in the PeriodLocked message, so a human must recognise it. */
    periodId: text('period_id').primaryKey(),
    startsOn: date('starts_on').notNull(),
    /** The last day **of** the period, not the first day after it. The lock range is inclusive. */
    endsOn: date('ends_on').notNull(),
    reason: text('reason').notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }).notNull(),
    /** 'staff' | 'system'. Only those two close a period. */
    lockedByActorKind: text('locked_by_actor_kind').notNull(),
    lockedByActorId: uuid('locked_by_actor_id'),
  },
  (t) => [
    index('period_lock_range_idx').on(t.startsOn, t.endsOn),
    check('period_lock_period_id_check', sql`btrim(${t.periodId}) <> ''`),
    check('period_lock_reason_check', sql`btrim(${t.reason}) <> ''`),
    check(
      'period_lock_locked_by_actor_kind_check',
      sql`${t.lockedByActorKind} in ('staff', 'system')`,
    ),
    check('period_lock_ends_on_or_after_starts', sql`${t.endsOn} >= ${t.startsOn}`),
    // The overlap exclusion constraint is not expressible here; it lives in 0018_ledger.sql, and
    // journal.itest.ts asserts a second overlapping lock is refused.
  ],
)
