import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  date,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { account, journalEntry } from './ledger.ts'
import { businessDay } from './trading.ts'

/**
 * The cash drawer reconciliation, mirroring `0076_cash_session.sql`.
 *
 * One file for all four tables, deliberately: `pnpm db:drift` keys its map on the table name, and
 * 0063's NOTE asked for one mirror per unit rather than a file per table.
 *
 * ## The key is the BUSINESS DAY
 *
 * `cashSession.tradingDate` is a foreign key into `business_day` (0011). Trading runs 11:00–02:00, so a
 * shift that opens at 23:00 and ends at 02:00 is ONE row here: 02:00 is the close instant of the 23:00
 * date's session, so both instants resolve to the same trading date through `resolveTradingDate`. A
 * reconciliation keyed on the calendar date would split that shift across two rows and balance neither
 * half — the money taken before midnight counted against a drawer still in use, and the money after it
 * counted against an opening float nobody declared.
 *
 * There is deliberately no generated `openedOn` date beside `openedAt`. A second derivation of the
 * trading date is a second answer, and this column plus `resolveTradingDate` are the only two.
 *
 * ## The discrepancy is a signed stored figure
 *
 * `counted - expected`, generated in SQL, negative for a short drawer and positive for an over one. Not
 * a boolean: a till out by 5 fils and one out by 500 dirhams are the same boolean and different events,
 * and a boolean cannot be summed over a month to tell a process problem from a person problem. Both
 * derived columns go through `cash_session_expected_float_fils()` so the cash-up formula exists once —
 * PostgreSQL forbids a generation expression referencing another generated column, so without the
 * function `discrepancyFils` would have to repeat it.
 *
 * Nothing writes through Drizzle. The mirror exists so `pnpm db:drift` can compare the two directions.
 */

/**
 * Every physical cash drawer, with the asset account its cash sits in.
 *
 * A registry table rather than a text column on `cashSession`, and the reason is the uniqueness rule:
 * `cash_session_one_open_per_drawer_per_day` is a partial unique index on `(drawerCode, tradingDate)`, so
 * a mistyped code would not collide with the row it was meant to collide with. `'Reception'` beside
 * `'reception'` would be a second OPEN session on one physical till, which is the state that index exists
 * to make impossible.
 */
export const cashDrawer = pgTable('cash_drawer', {
  /** Lower snake case, so a display-label change cannot silently become a new drawer. */
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  /**
   * Which asset account this drawer's cash sits in.
   *
   * `1010 Cash in drawer` for a till; a second drawer kept in the safe would be `1015 Petty cash float`.
   * The cash-up posting reads this column rather than assuming 1010, so a safe float and a till float
   * cannot be reconciled into one balance by accident.
   */
  postingAccountCode: text('posting_account_code')
    .notNull()
    .references(() => account.code),
  /** Retired rather than deleted: a drawer that was once counted has rows that must keep resolving. */
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

/**
 * One shift on one drawer on one business day, opened with a declared float and closed with a counted
 * one.
 *
 * The four snapshotted figures are NULL while the session is open and all present once it closes
 * (`cash_session_closed_is_complete`). They are snapshotted rather than read live because a
 * reconciliation is evidence **as at** the count: a payment back-dated afterwards must not restate a
 * figure somebody has signed. `ZU005` holds them equal to the rows at COMMIT, and `ZU006` refuses cash
 * dated on a business day whose drawer has already been counted — without which `ZU005`'s guarantee
 * would hold only until the transaction that took the snapshot committed.
 */
export const cashSession = pgTable(
  'cash_session',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    drawerCode: text('drawer_code')
      .notNull()
      .references(() => cashDrawer.code),
    /**
     * The business day this shift belongs to, resolved by the caller with `resolveTradingDate`.
     *
     * `on update cascade` so a regenerated trading calendar moves its sessions with it; `on delete
     * restrict` because a counted drawer is evidence about a day that happened.
     */
    tradingDate: date('trading_date')
      .notNull()
      .references(() => businessDay.tradingDate, { onUpdate: 'cascade', onDelete: 'restrict' }),
    /** Which shift of that business day. A day may hold an early and a late, each counted. */
    shiftNo: smallint('shift_no').notNull(),
    status: text('status').notNull().default('open'),
    /**
     * What was in the drawer when the shift started — declared, never posted.
     *
     * The float is the previous close's counted cash left in the till, so it never left `1010` and there
     * is nothing to post. An entry here would double-count the float on every shift.
     */
    openingFloatFils: bigint('opening_float_fils', { mode: 'bigint' }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    openedByActorKind: text('opened_by_actor_kind').notNull(),
    /**
     * Sum of `payment.amountFils` for cash on this business day — the notes that went IN.
     *
     * Stored separately from {@link cashSession.changeGivenFils} and never netted into it. That is what
     * 0068 separated the two columns for: a cash-up sheet is checked against the till roll in both
     * directions, and `sum(applied_fils)` alone reconciles against neither.
     */
    cashReceivedFils: bigint('cash_received_fils', { mode: 'bigint' }),
    /** Sum of `payment.changeGivenFils` — the notes that came OUT. */
    changeGivenFils: bigint('change_given_fils', { mode: 'bigint' }),
    cashRefundedFils: bigint('cash_refunded_fils', { mode: 'bigint' }),
    /** Snapshotted from `cashDrop`, whose rows carry the posting that moved the money out of `1010`. */
    dropsFils: bigint('drops_fils', { mode: 'bigint' }).notNull(),
    /** What was physically counted. Without it there is no reconciliation, which `ZU001` refuses. */
    countedFloatFils: bigint('counted_float_fils', { mode: 'bigint' }),
    /**
     * `opening + received - change - refunded - drops`, generated and stored.
     *
     * Mirrored as an ordinary column because `pnpm db:drift` compares presence and nullability, and
     * nothing writes through Drizzle. NULL while the session is open, because the SQL function is
     * `strict` and the counts are NULL — a `coalesce(…, 0)` there would state an expected float for a
     * shift that is still running.
     */
    expectedFloatFils: bigint('expected_float_fils', { mode: 'bigint' }),
    /** `counted - expected`, generated and SIGNED. Negative is short, positive is over. */
    discrepancyFils: bigint('discrepancy_fils', { mode: 'bigint' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedByActorKind: text('closed_by_actor_kind'),
    /**
     * Why the drawer was out. Mandatory for a non-zero discrepancy.
     *
     * The close is RECORDED rather than refused: the count is a measurement of the physical world and
     * the expectation is a derivation from rows, so refusing would destroy the evidence and leave the
     * operator typing in the expected figure to finish the day.
     */
    countNote: text('count_note'),
    /** The `cash_up` entry that moved the discrepancy to `6140`. NULL exactly when the drawer balanced. */
    journalEntryId: text('journal_entry_id').references(() => journalEntry.entryId),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('cash_session_one_row_per_shift').on(t.drawerCode, t.tradingDate, t.shiftNo),
    check('cash_session_shift_no_positive', sql`${t.shiftNo} >= 1`),
    check('cash_session_status_known', sql`${t.status} in ('open', 'closed')`),
    check(
      'cash_session_opened_by_known',
      sql`${t.openedByActorKind} in ('staff', 'customer', 'system', 'agent')`,
    ),
    check(
      'cash_session_closed_by_known',
      sql`${t.closedByActorKind} is null or ${t.closedByActorKind} in ('staff', 'customer', 'system', 'agent')`,
    ),
    check(
      'cash_session_count_note_nonempty',
      sql`${t.countNote} is null or btrim(${t.countNote}) <> ''`,
    ),
    /**
     * A closed session carries every figure the reconciliation is made of; an open one carries none.
     *
     * One constraint over the set rather than five nullability rules, because the state that must not
     * exist is a HALF-counted close: a counted float with no receipts total against it is a figure that
     * reconciles to nothing.
     */
    check(
      'cash_session_closed_is_complete',
      sql`case ${t.status}
      when 'closed' then
        ${t.countedFloatFils} is not null and ${t.cashReceivedFils} is not null
        and ${t.changeGivenFils} is not null and ${t.cashRefundedFils} is not null
        and ${t.closedAt} is not null and ${t.closedByActorKind} is not null
      else
        ${t.countedFloatFils} is null and ${t.cashReceivedFils} is null
        and ${t.changeGivenFils} is null and ${t.cashRefundedFils} is null
        and ${t.closedAt} is null and ${t.closedByActorKind} is null
        and ${t.journalEntryId} is null and ${t.countNote} is null
    end`,
    ),
    /** A drawer that is out needs a sentence. Reads the generated figure, not the inputs. */
    check(
      'cash_session_variance_needs_a_reason',
      sql`${t.status} <> 'closed' or ${t.discrepancyFils} = 0 or ${t.countNote} is not null`,
    ),
    check(
      'cash_session_change_not_more_than_received',
      sql`${t.changeGivenFils} is null or ${t.changeGivenFils} <= ${t.cashReceivedFils}`,
    ),
    index('cash_session_trading_date_idx').on(t.tradingDate, t.drawerCode),
  ],
)

/**
 * Cash taken out of a drawer mid-shift, with the entry that moved it.
 *
 * A row and not a column on `cashSession`: `1010` is debited as each payment is taken (0068's manual
 * adapter), so a drop recorded only at the close would leave `1010` overstated for the rest of the
 * shift — and a trial balance taken mid-shift is exactly when somebody is looking.
 *
 * Append-only for every role (`ZU002`). A drop that could be edited is a drawer whose history changes
 * after it was counted.
 */
export const cashDrop = pgTable(
  'cash_drop',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    cashSessionId: uuid('cash_session_id')
      .notNull()
      .references(() => cashSession.id),
    dropNo: smallint('drop_no').notNull(),
    amountFils: bigint('amount_fils', { mode: 'bigint' }).notNull(),
    /** `1020 Bank current` for a banking, `1015 Petty cash float` for the safe. Snapshotted. */
    destinationAccountCode: text('destination_account_code')
      .notNull()
      .references(() => account.code),
    /** The deposit slip or safe-log reference. Absent rather than blank (0063's reason). */
    reference: text('reference'),
    reason: text('reason').notNull(),
    /** Mandatory, and a real key: nothing truncates the journal, so it costs nothing. */
    journalEntryId: text('journal_entry_id')
      .notNull()
      .references(() => journalEntry.entryId),
    droppedAt: timestamp('dropped_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('cash_drop_one_row_per_number').on(t.cashSessionId, t.dropNo),
    check('cash_drop_no_positive', sql`${t.dropNo} >= 1`),
    check('cash_drop_amount_positive', sql`${t.amountFils} > 0`),
    check(
      'cash_drop_reference_nonempty',
      sql`${t.reference} is null or btrim(${t.reference}) <> ''`,
    ),
    check('cash_drop_reason_nonempty', sql`btrim(${t.reason}) <> ''`),
    index('cash_drop_session_idx').on(t.cashSessionId, t.dropNo),
  ],
)

/**
 * A dated correction to a session that has been counted and closed.
 *
 * The remedy `cash_session_close_is_terminal` leaves. A new row on its OWN business day with its own
 * entry — the shape a credit note has to an invoice (0072) and a dated reversal has to a filed period
 * (0073), and the only shape that leaves the original count readable.
 */
export const cashSessionAdjustment = pgTable(
  'cash_session_adjustment',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    cashSessionId: uuid('cash_session_id')
      .notNull()
      .references(() => cashSession.id),
    adjustmentNo: smallint('adjustment_no').notNull(),
    /**
     * The business day the CORRECTION posts under, which is not the session's.
     *
     * A discrepancy found on Tuesday against Saturday's drawer is Tuesday's entry, because Saturday may
     * be filed (0073).
     */
    tradingDate: date('trading_date')
      .notNull()
      .references(() => businessDay.tradingDate, { onUpdate: 'cascade', onDelete: 'restrict' }),
    /** Signed: positive means the drawer held more than the close recorded. */
    amountFils: bigint('amount_fils', { mode: 'bigint' }).notNull(),
    reason: text('reason').notNull(),
    journalEntryId: text('journal_entry_id')
      .notNull()
      .references(() => journalEntry.entryId),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('cash_session_adjustment_one_row_per_number').on(t.cashSessionId, t.adjustmentNo),
    check('cash_session_adjustment_no_positive', sql`${t.adjustmentNo} >= 1`),
    check('cash_session_adjustment_amount_nonzero', sql`${t.amountFils} <> 0`),
    check('cash_session_adjustment_reason_nonempty', sql`btrim(${t.reason}) <> ''`),
    index('cash_session_adjustment_session_idx').on(t.cashSessionId, t.adjustmentNo),
  ],
)
