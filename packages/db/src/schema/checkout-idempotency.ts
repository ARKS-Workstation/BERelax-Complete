import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  date,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { invoice } from './invoice.ts'
import { journalEntry } from './ledger.ts'

/**
 * The two keys that make a checkout unrepeatable, mirroring `0063_checkout.sql`.
 *
 * Migrations are SQL-first (ADR 0006); this is a mirror `pnpm db:drift` compares against the live
 * database in both directions. Nothing writes through Drizzle — the write path is
 * `services/checkout-finalise.ts`.
 *
 * ## Why idempotency is a key and not a check
 *
 * `finaliseCheckout` could read `checkout_finalisation` first and return early when a row is already
 * there. That is a read followed by a write, and the double-tapped Pay button lands in the gap between
 * them: both requests read nothing, both post, and the salon has two invoices for one treatment. A
 * second call that returns early is not idempotent — it is lucky.
 *
 * So the property lives in {@link checkoutFinalisation}'s primary key, on a value the **caller**
 * supplies. Two concurrent finalisations of one checkout serialise on that index: the second INSERT
 * blocks until the first commits — and is then refused by `checkout_finalisation_key_pk`, which is the
 * refusal `checkout-finalise.itest.ts` asserts *by constraint name* — or until it rolls back, in which
 * case the second succeeds and the retry gets a fresh attempt. That is `booking_idempotency`'s
 * mechanism (0024) applied to the till, and it is why the row is written inside the checkout's own
 * transaction rather than before it.
 *
 * Two things these mirrors cannot express, which live only in the migration:
 *
 *   - the **grants**: the application role holds SELECT and INSERT and neither UPDATE nor DELETE. A
 *     DELETE would erase the claim that makes the key work, which turns a resolved double tap back into
 *     two sales;
 *   - the absence of a foreign key on `appointmentId`, `bookingId` and `customerId`, which the column
 *     comments state: PostgreSQL refuses `truncate appointment` while a referencing table is missing
 *     from the statement, and four integration suites truncate it (and `booking`) by an explicit list.
 */

/**
 * Which appointments an issued document billed — and the constraint that makes "twice" impossible.
 *
 * This is the wiring M-TILL-04's NOTE deferred to this unit. A separate table rather than a column on
 * `invoice_line`, because the constraint that matters is UNIQUE on the **appointment**: a column on
 * `invoice_line` could not carry it without also claiming that every invoice line is an appointment,
 * which a retail line and a package sale are not.
 *
 * "Billed" is this row existing, and there is deliberately no appointment status for it.
 * `appointment_status` is B-LIFE-01's nine states and `appointment.holds_resources` is GENERATED from
 * it (0024), so a tenth label would change what holds a room — and a `billed_at` column beside this
 * table would be a second answer to one question.
 */
export const invoiceAppointment = pgTable(
  'invoice_appointment',
  {
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoice.id),
    /**
     * No foreign key, on purpose — 0055's decision, 0058's, and 0024's for `appointment.therapist_id`.
     *
     * The link may therefore be orphaned by a deleted appointment, which is the right direction: the
     * document is statutory and the diary row is not. The UNIQUE still bites, because it constrains the
     * id rather than the row.
     */
    appointmentId: uuid('appointment_id').notNull(),
    /**
     * Which line of the document billed it, or NULL.
     *
     * Nullable and not a reference to `invoice_line`, because a package redemption bills an appointment
     * that appears on no invoice line at all: its gross is zero and the document does not state it.
     */
    lineNo: smallint('line_no'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'invoice_appointment_pk', columns: [t.invoiceId, t.appointmentId] }),
    /** THE constraint. Named, so a caller can tell "already billed" from any other conflict. */
    unique('invoice_appointment_appointment_once').on(t.appointmentId),
    check('invoice_appointment_line_no_positive', sql`${t.lineNo} is null or ${t.lineNo} >= 1`),
    index('invoice_appointment_invoice_idx').on(t.invoiceId),
  ],
)

/** One finalised checkout: the key that claimed it and the three records it produced. */
export const checkoutFinalisation = pgTable(
  'checkout_finalisation',
  {
    /** Supplied by the caller. A key generated here could not deduplicate the retry that generated it. */
    idempotencyKey: text('idempotency_key').primaryKey(),
    /**
     * A hash of the basket that claimed the key.
     *
     * 0024's second column and for 0024's reason: replaying a key with a **different** basket is a bug
     * in the caller, not a retry, and handing back the first invoice for it would be read as success.
     */
    requestFingerprint: text('request_fingerprint').notNull(),
    basketId: text('basket_id').notNull(),
    /** UNIQUE. One invoice per finalisation, as schema rather than as a promise about the writer. */
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoice.id),
    /** UNIQUE. One journal entry per finalisation, for the same reason. */
    journalEntryId: text('journal_entry_id')
      .notNull()
      .references(() => journalEntry.entryId),
    /** No foreign key: the suites that truncate `appointment` truncate `booking` in one statement. */
    bookingId: uuid('booking_id'),
    /** No foreign key either — 0005, 0016, 0024 and 0056 all make the same choice for `customer`. */
    customerId: uuid('customer_id'),
    /** The trading date the checkout was finalised on, and the date its journal entry carries. */
    tradingDate: date('trading_date').notNull(),
    /** What was handed over, in integer fils. `mode: 'bigint'`, for `payment.amountFils`'s reason. */
    tenderTotalFils: bigint('tender_total_fils', { mode: 'bigint' }).notNull(),
    finalisedAt: timestamp('finalised_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('checkout_finalisation_one_invoice').on(t.invoiceId),
    unique('checkout_finalisation_one_entry').on(t.journalEntryId),
    check('checkout_finalisation_key_nonempty', sql`btrim(${t.idempotencyKey}) <> ''`),
    check('checkout_finalisation_fingerprint_nonempty', sql`btrim(${t.requestFingerprint}) <> ''`),
    check('checkout_finalisation_basket_nonempty', sql`btrim(${t.basketId}) <> ''`),
    check('checkout_finalisation_tender_total_positive', sql`${t.tenderTotalFils} > 0`),
    index('checkout_finalisation_trading_date_idx').on(t.tradingDate, t.finalisedAt),
    index('checkout_finalisation_booking_idx').on(t.bookingId),
  ],
)
