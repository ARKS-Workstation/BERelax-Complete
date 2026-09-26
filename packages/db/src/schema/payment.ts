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
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { invoice } from './invoice.ts'
import { account } from './ledger.ts'
import { packageSale } from './package.ts'

/**
 * Every way the business takes money, with the account each one is debited to. Mirrors
 * `0068_payment_tender.sql`.
 *
 * This is the registry M-TILL-06 deferred to M-TILL-07: `payment.tender_kind` was a CHECK over three
 * literals and is now a foreign key into this table. The constraint keeps its NAME,
 * `payment_tender_kind_known`, because the name is the contract a caller recognises "that is not a
 * tender type we take" by — and because a gate probe has asserted on it since 0063.
 *
 * ## Why the posting account is here when `TENDER_ACCOUNT` is in `@berelax/core`
 *
 * It is not a second opinion. `packages/db` may never import `packages/core` (brief rule 4), so the
 * write path cannot see that map, and `payment.posting_account_code` is snapshotted onto every row on
 * purpose: re-mapping `card_in_salon` from 1040 to 1020 in two years must not restate a posting already
 * filed. A snapshot has to be taken from something, and this table is what it is taken from.
 * `packages/fixtures/src/payment.itest.ts` — the one package allowed to depend on both — holds the two
 * equal, with a control proving the comparison can fail.
 *
 * ## The three facts a CHECK on `payment` could not express
 *
 *   - `givesChange` — cash only. A card is authorised for an amount and a transfer arrives for an
 *     amount, so a surplus on either is a mis-keyed figure rather than a twenty-dirham note, and paying
 *     change against one takes money out of the drawer that nobody over-paid.
 *   - `requiresReference` — 0063 could refuse a *blank* reference and had no way to refuse a **missing**
 *     one, so a card payment with nothing to settle a dispute with was a storable row.
 *   - `settlesImmediately` — cash is in the drawer; a card batch and a transfer arrive later through a
 *     clearing account. `tender_type_change_needs_immediate_settlement` is the consequence: change
 *     cannot be handed back out of money that has not arrived.
 *
 * Nothing writes through Drizzle. The registry is configuration: the application role holds SELECT and
 * nothing else, because adding a tender type needs a posting account chosen by somebody who knows what
 * a clearing account is for.
 */
export const tenderType = pgTable(
  'tender_type',
  {
    /** Lower snake case, so renaming a display label cannot silently become a new tender type. */
    code: text('code').primaryKey(),
    label: text('label').notNull(),
    /** What `payment.posting_account_code` is snapshotted from, and never joined to afterwards. */
    postingAccountCode: text('posting_account_code')
      .notNull()
      .references(() => account.code),
    givesChange: boolean('gives_change').notNull(),
    requiresReference: boolean('requires_reference').notNull(),
    settlesImmediately: boolean('settles_immediately').notNull(),
    /** `manual` or `gateway`. All three types are `manual` today: there is no gateway yet. */
    adapter: text('adapter').notNull(),
    sortOrder: smallint('sort_order').notNull(),
    /**
     * Retired rather than deleted: `payment.tender_kind` references this row, and a type that once
     * took money has documents that must keep resolving. NULL means available.
     */
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('tender_type_one_row_per_position').on(t.sortOrder),
    check('tender_type_code_is_snake_case', sql`${t.code} ~ '^[a-z][a-z0-9_]*$'`),
    check('tender_type_label_nonempty', sql`btrim(${t.label}) <> ''`),
    check('tender_type_adapter_known', sql`${t.adapter} in ('manual', 'gateway')`),
    check('tender_type_sort_order_positive', sql`${t.sortOrder} >= 1`),
    /** Change cannot be handed back out of money that has not arrived. */
    check(
      'tender_type_change_needs_immediate_settlement',
      sql`not ${t.givesChange} or ${t.settlesImmediately}`,
    ),
  ],
)

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
    /**
     * The document this tender settled, or NULL for a package sale (0083).
     *
     * Nullable since 0083, and the reason is a defect rather than a feature: 0078 took money for a package
     * and wrote no `payment` row at all, because this column was NOT NULL and a package sale issues no
     * invoice — [UNVERIFIED] Y11-vat-package puts the date of supply at redemption, so there is nothing to
     * state as a supply on the day the money is taken. `readDrawerTakings` and `ZU005` (0076) both sum this
     * table for the business day, so package cash was invisible to the cash-up and the drawer read as OVER
     * by it.
     *
     * Exactly one of this and `packageSaleId` is set (`payment_settles_exactly_one_document`). Merely
     * dropping the NOT NULL was the other option and is worse twice over: the row would name no document at
     * all, and `payment_one_row_per_tender` is `unique (invoice_id, tender_no)` with NULLs distinct, so
     * every package payment would have escaped the one-row-per-tender rule too.
     */
    invoiceId: uuid('invoice_id').references(() => invoice.id),
    /** The package sale this tender paid for, or NULL for a checkout (0083). */
    packageSaleId: uuid('package_sale_id').references(() => packageSale.id),
    /** Position within the checkout, so two reads of one sale list the tenders in the same order. */
    tenderNo: smallint('tender_no').notNull(),
    /**
     * A code from {@link tenderType}. 0063's CHECK over three literals, now a foreign key.
     *
     * The constraint is still called `payment_tender_kind_known`, which is deliberate: the name is what
     * lets a caller tell "that is not a tender type we take" from every other refusal in the same
     * transaction, and a constraint cannot be both a CHECK and a foreign key, so 0068 drops and re-adds
     * it under the same name rather than renaming it.
     */
    tenderKind: text('tender_kind')
      .notNull()
      .references(() => tenderType.code),
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
    /**
     * What was handed back to the customer out of this tender (0068).
     *
     * A second column and not a net figure, which is the whole of "change given is recorded separately
     * rather than netted into the payment": a drawer counted at the end of the day is reconciled
     * against the notes that went in and the notes that came out, and one net figure reconciles against
     * neither. `tender_type.gives_change` decides whether it may be non-zero at all — change against a
     * card is a mis-keyed amount, not a surplus, and `ZT002` refuses it.
     */
    changeGivenFils: bigint('change_given_fils', { mode: 'bigint' }).notNull(),
    /**
     * What this tender settled: `amount_fils - change_given_fils`, **generated and stored** (0068).
     *
     * Mirrored as an ordinary column because `pnpm db:drift` compares presence and nullability, and
     * because nothing writes through Drizzle anyway. It is the one place the netting happens, so the
     * `invoice_settlement` view and the `ZT001` ceiling read a column instead of each subtracting for
     * themselves — two subtractions of one pair of numbers is one subtraction plus a future
     * disagreement.
     *
     * Its domain in SQL is `fils` and not `fils_nonneg`, deliberately: a generated column's domain is
     * checked BEFORE the table's CHECK constraints, so `fils_nonneg` there refused an over-large change
     * with `fils_nonneg_check` and `payment_change_not_more_than_tendered` never fired — a refusal
     * naming no constraint a caller could recognise. 0068's column comment records the measurement.
     */
    appliedFils: bigint('applied_fils', { mode: 'bigint' }).notNull(),
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
    /**
     * The package side's twin of the rule above (0083).
     *
     * Needed because NULLs are DISTINCT in a unique index, so `payment_one_row_per_tender` constrains none
     * of the rows a package sale writes — a retry could write tender 1 twice and the drawer would then
     * expect the money twice.
     */
    unique('payment_one_row_per_package_tender').on(t.packageSaleId, t.tenderNo),
    /** One document, never none and never both (0083). */
    check(
      'payment_settles_exactly_one_document',
      sql`num_nonnulls(${t.invoiceId}, ${t.packageSaleId}) = 1`,
    ),
    check('payment_tender_no_positive', sql`${t.tenderNo} >= 1`),
    /** Strictly positive: `fils_nonneg` alone would accept a zero, which is a tender nobody made. */
    check('payment_amount_positive', sql`${t.amountFils} > 0`),
    /**
     * Change may not exceed what was handed over (0068).
     *
     * `applied_fils` is a `fils_nonneg` domain, so a domain violation would also refuse it — and a
     * domain violation carries no constraint name for a caller, or a gate probe, to recognise.
     */
    check('payment_change_not_more_than_tendered', sql`${t.changeGivenFils} <= ${t.amountFils}`),
    check('payment_reference_nonempty', sql`${t.reference} is null or btrim(${t.reference}) <> ''`),
    index('payment_invoice_idx').on(t.invoiceId),
    index('payment_trading_date_idx').on(t.tradingDate, t.tenderKind),
  ],
)

/**
 * Money returned against an issued document, mirroring `0068_payment_tender.sql`.
 *
 * A refund is a **new row** with its own `tradingDate`, never an edit of a `payment` — 0063 revoked
 * UPDATE and DELETE on `payment` for exactly this reason, and 0068 makes the same revocation here. Its
 * posting is a new journal entry crediting the tender account, never an edit of the sale's debit to it.
 *
 * ## The one column with no foreign key
 *
 * `creditNoteId` is NOT NULL and references nothing yet. A refund from an invoice alone is money leaving
 * the business with no document behind it, and "an issued invoice is never edited or voided; a
 * correction is a credit note" (docs/04 §4) is only true while the refund path cannot be used to undo a
 * sale. `credit_note` is M-TILL-08's table and does not exist, so this column is the *requirement*,
 * enforced today; the referential half — that the id names a real credit note, for **this** invoice,
 * whose value covers the amount — is M-TILL-08's to add. Said here rather than left to be discovered.
 *
 * `ZT004` caps the refunds against a document at what was applied to it: refunding money that was never
 * taken is not a correction of anything.
 */
export const refund = pgTable(
  'refund',
  {
    id: uuid('id').primaryKey(),
    /**
     * The document being refunded. Still NOT NULL, and 0083 deliberately did not widen it.
     *
     * `payment.invoice_id` became nullable because a package SALE takes money against no invoice. A REFUND
     * is different: 0068's reason for the column is that money leaving with no document behind it is how
     * "an issued invoice is never edited or voided" stops being true, and a package refund is M-TILL-08's
     * credit-note question rather than a nullable column.
     */
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoice.id),
    /** Mandatory, and deliberately without a foreign key until M-TILL-08 creates `credit_note`. */
    creditNoteId: uuid('credit_note_id').notNull(),
    /** Position within the document's refunds, so two reads list them in the same order. */
    refundNo: smallint('refund_no').notNull(),
    tenderKind: text('tender_kind')
      .notNull()
      .references(() => tenderType.code),
    /** Snapshotted, for `payment.postingAccountCode`'s reason. */
    postingAccountCode: text('posting_account_code')
      .notNull()
      .references(() => account.code),
    /** `mode: 'bigint'`, for `payment.amountFils`'s reason: a fils amount may not lose precision. */
    amountFils: bigint('amount_fils', { mode: 'bigint' }).notNull(),
    reference: text('reference'),
    /** The business day the money went back, resolved with `resolveTradingDate`. */
    tradingDate: date('trading_date').notNull(),
    refundedAt: timestamp('refunded_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('refund_one_row_per_number').on(t.invoiceId, t.refundNo),
    check('refund_no_positive', sql`${t.refundNo} >= 1`),
    check('refund_amount_positive', sql`${t.amountFils} > 0`),
    check('refund_reference_nonempty', sql`${t.reference} is null or btrim(${t.reference}) <> ''`),
    index('refund_invoice_idx').on(t.invoiceId),
    index('refund_trading_date_idx').on(t.tradingDate, t.tenderKind),
    index('refund_credit_note_idx').on(t.creditNoteId),
  ],
)
