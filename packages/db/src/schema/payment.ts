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
import { invoice } from './invoice.ts'
import { account } from './ledger.ts'

/**
 * What was tendered against an issued document, mirroring `0063_checkout.sql`.
 *
 * Migrations are SQL-first (ADR 0006): the hand-written `.sql` is the schema and this is a mirror that
 * `pnpm db:drift` compares against the live database in both directions. Nothing writes through
 * Drizzle — the write path is `services/checkout-finalise.ts`, inside the checkout's own transaction.
 *
 * ## Why it is created by M-TILL-06 and extended by M-TILL-07
 *
 * M-TILL-06's first acceptance line names this table: aborting a finalisation must leave zero rows in
 * `invoice`, `invoice_line`, `journal_entry`, `journal_line` **and `payment`**. So the tender rows are
 * part of the one transaction that unit exists to prove, and they have to exist for it to prove
 * anything.
 *
 * What is here is therefore minimal on purpose. M-TILL-07 owns the tender-type **registry** — a table
 * with a declared posting account per type, which replaces `payment_tender_kind_known` with a foreign
 * key — plus refunds, over-tender change and the gateway adapter interface. It extends this table
 * rather than adding a second one beside it, because two tables recording money received is two
 * answers to "what has this invoice been paid".
 *
 * Two things this mirror cannot express, which therefore live only in the migration:
 *
 *   - the **grants**: the application role holds INSERT and SELECT and neither UPDATE nor DELETE, so a
 *     tender is not corrected in place. A mis-keyed payment is answered by a refund (M-TILL-07) and an
 *     over-charge by a credit note (M-TILL-08), both new rows with their own dates;
 *   - the reason `posting_account_code` is snapshotted rather than joined, which the column comment
 *     states: re-mapping `card_in_salon` from 1040 to 1020 must not restate a posting already filed.
 *
 * Note what is absent: there is no `updated_at` and no `set_updated_at` trigger. A tender has no second
 * version — the drawer was counted against the first one.
 */
export const payment = pgTable(
  'payment',
  {
    id: uuid('id').primaryKey(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoice.id),
    /** Position within the checkout, so two reads of one sale list the tenders in the same order. */
    tenderNo: smallint('tender_no').notNull(),
    /** 'cash', 'card_in_salon' or 'bank_transfer'. M-TILL-07 turns the CHECK into a registry. */
    tenderKind: text('tender_kind').notNull(),
    /**
     * Where this tender was debited, snapshotted from `TENDER_ACCOUNT` in `@berelax/core`.
     *
     * `card_in_salon` is `1040 Card terminal clearing` and **not** the bank: the terminal settles in a
     * batch, net of fees, days later, so debiting `1020` would leave the bank reconciliation out by
     * every unsettled batch and every processing fee.
     */
    postingAccountCode: text('posting_account_code')
      .notNull()
      .references(() => account.code),
    /**
     * Integer fils (ADR 0007), strictly positive.
     *
     * `mode: 'bigint'` rather than `'number'`: the driver returns bigint as a string precisely so an
     * amount cannot silently lose precision, and a mirror that re-introduced a JS number here would
     * undo that for the column a cash-up reconciles against.
     */
    amountFils: bigint('amount_fils', { mode: 'bigint' }).notNull(),
    /** The terminal's approval code or the transfer reference. NULL for cash, which has none. */
    reference: text('reference'),
    /**
     * The **business day** the money was taken on, resolved by the caller.
     *
     * Trading runs 11:00–02:00, so a 01:30 payment belongs to the previous trading date. A date
     * truncated from `receivedAt` would move it into the next day's drawer, which is the error
     * `resolveTradingDate` exists to prevent (ADR 0007).
     */
    tradingDate: date('trading_date').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('payment_one_row_per_tender').on(t.invoiceId, t.tenderNo),
    check('payment_tender_no_positive', sql`${t.tenderNo} >= 1`),
    check(
      'payment_tender_kind_known',
      sql`${t.tenderKind} in ('cash', 'card_in_salon', 'bank_transfer')`,
    ),
    /** Strictly positive: `fils_nonneg` alone would accept a zero, which is a tender nobody made. */
    check('payment_amount_positive', sql`${t.amountFils} > 0`),
    check('payment_reference_nonempty', sql`${t.reference} is null or btrim(${t.reference}) <> ''`),
    index('payment_invoice_idx').on(t.invoiceId),
    index('payment_trading_date_idx').on(t.tradingDate, t.tenderKind),
  ],
)
