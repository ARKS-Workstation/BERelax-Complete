import { sql } from 'drizzle-orm'
import { check, date, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Drizzle mirrors of 0153_parallel_run.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps them honest.
 *
 * The parallel run, in three tables, and the division between them is the whole design: the paper day
 * sheet is a CLAIM a named person makes about the outside world, the system count is a MEASUREMENT the
 * daily job takes, and the cutover decision is a claim that nothing in this build makes.
 *
 * Four things these mirrors cannot say:
 *
 *   - **a paper count is attributable or it cannot COMMIT.** ZY742, a deferred constraint trigger, needs
 *     an `audit_event` in the same transaction with `actor_kind = 'staff'` and `actor_id` not null.
 *     Nothing here can see the sheet, so the row's value is that a named person read it.
 *   - **a paper count and a decision are append-only.** ZY743 and ZY745, on UPDATE and on DELETE for
 *     every role. A claim that can be rewritten is not a record of what was claimed.
 *   - **a reconciliation outside its own window cannot be written.** ZY741, which names the two setting
 *     keys and the open question in its message — a day before or after the window would carry a
 *     misleading zero, because "the paper and the system agree" is then a statement about which of the
 *     two was switched off.
 *   - **the decision's evidence is held to the rows.** ZY746, at COMMIT, holds `unreconciledDays` equal
 *     to the `parallel_run_variance` rows up to `asOfBusinessDay`, because the variance rows are
 *     upsertable and a day corrected afterwards would otherwise change what the decision looks like it
 *     was taken in the light of.
 *
 * There is no mirror for `parallel_run_variance`, and that is not an omission: it is a VIEW, the one
 * statement of what the difference and the state are, and `pnpm db:drift` compares base tables. A mirror
 * of it would be a second statement of the arithmetic the view exists to hold in one place.
 *
 * **Nothing here holds a date.** The window is two settings with no default
 * (`migration.parallel_run_window_start`, `migration.parallel_run_window_end`, provisional against
 * `Y8-parallel-run-window`), and the reconciliation refuses to run while they are unset: a plausible
 * cutover date in this build would be indistinguishable from a configured one (brief rule 15).
 */

export const parallelRunPaperCount = pgTable('parallel_run_paper_count', {
  /**
   * The trading date. A real foreign key to `public.business_day (trading_date)` in the migration, and
   * declared here WITHOUT `.references()` — the arrangement `analytics.session.tradingDate` and
   * `analytics_dispatch_reconciliation.businessDay` both record for the same table: `business_day` is
   * mirrored in another module, and importing it for a constraint neither file enforces in TypeScript
   * would couple the two.
   */
  businessDay: date('business_day').primaryKey(),
  /** What the sheet recorded. `0` is a real reading of a real sheet; an ABSENT reading has no row. */
  sheetCount: integer('sheet_count').notNull(),
  /** Who read it, as they identify themselves. Refused if it is placeholder text (0026). */
  countedBy: text('counted_by').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

export const parallelRunReconciliation = pgTable(
  'parallel_run_reconciliation',
  {
    /**
     * Keyed to the PAPER COUNT and not to `business_day`, which is what makes "one variance row per
     * business_day comparing the paper count with the system count" true by construction: a
     * reconciliation cannot exist without the claim it is a comparison against, so the job emits nothing
     * for a day nobody has counted rather than a row whose paper figure is zero.
     */
    businessDay: date('business_day')
      .primaryKey()
      .references(() => parallelRunPaperCount.businessDay, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),

    systemCount: integer('system_count').notNull(),
    /** The window in force when the job ran, so the figure can be attributed to it afterwards. */
    windowStart: date('window_start').notNull(),
    windowEnd: date('window_end').notNull(),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('parallel_run_reconciliation_window_is_ordered', sql`${t.windowStart} <= ${t.windowEnd}`),
  ],
)

export const parallelRunDecision = pgTable(
  'parallel_run_decision',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /**
     * `proceed` | `roll_back`, and NOTHING in this build computes it.
     *
     * No trigger derives it from the variance rows, no view recommends one and no job writes a row.
     * Deciding whether a business cuts over to this system from a rule nobody wrote down is the one
     * thing this schema must not do, and the absence of that mechanism is what this table records.
     */
    decision: text('decision').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    decidedBy: text('decided_by').notNull(),
    rationale: text('rationale').notNull(),
    /** The last trading date the decision was taken in the light of. FK as above, in prose. */
    asOfBusinessDay: date('as_of_business_day').notNull(),
    /** The evidence, held equal to the variance rows by ZY746 rather than taken on trust. */
    unreconciledDays: integer('unreconciled_days').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('parallel_run_decision_decided').on(t.decidedAt.desc())],
)
