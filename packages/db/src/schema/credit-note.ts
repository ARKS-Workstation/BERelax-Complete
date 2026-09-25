import { sql } from 'drizzle-orm'
import {
  bigint,
  char,
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
import { customer } from './customer.ts'
import { journalEntry } from './ledger.ts'

/**
 * The credit note, mirroring `0072_credit_note.sql`.
 *
 * Migrations are SQL-first (ADR 0006): the hand-written `.sql` is the schema and this is a mirror that
 * `pnpm db:drift` compares against the live database in both directions. Nothing writes through
 * Drizzle — the write path is `services/issue-credit-note.ts`.
 *
 * Six things this mirror cannot express, which therefore live only in the migration and are proved
 * against a real PostgreSQL in `services/issue-credit-note.itest.ts`:
 *
 *   - the **refusal triggers** that make UPDATE and DELETE raise `ZD009` for every role including the
 *     owner — a credit note issued in error is answered by re-invoicing the supply;
 *   - the **cumulative quantity ceiling** (`ZD006`), which takes an advisory lock on the invoice line
 *     first, because two transactions each summing the credited quantity see none of the other's
 *     uncommitted rows and both would pass;
 *   - the **period refusal** (`ZD003`), whose message names the earliest OPEN date rather than only
 *     the locked period;
 *   - the **reversal agreement** (`ZD011`), which holds the entry's date, source and 1050 credit to
 *     what the note states;
 *   - the **deferred totals trigger**, which checks the header against the sum of its lines at COMMIT
 *     because the header is inserted before its lines exist;
 *   - the **grants**, which are what stop an injected statement reaching UPDATE at all.
 *
 * As on `invoice`, there is no `updated_at` and no trigger to maintain one. A row with no second
 * version has no update time, and a column claiming otherwise is the first step towards an edit.
 */
export const creditNote = pgTable(
  'credit_note',
  {
    id: uuid('id').primaryKey(),

    /**
     * The document corrected.
     *
     * No foreign key, and the reason is in 0072's header: `invoice` refuses DELETE for every role
     * (`ZI003`), so the only statement a key would guard against is a TRUNCATE by the owner — which is
     * the teardown in seven integration suites across six units that the key would break. The
     * reference is enforced at INSERT by `credit_note_corrects_a_real_invoice()`.
     */
    invoiceId: uuid('invoice_id').notNull(),

    /**
     * Always 'credit_note'. A constant column, held by a CHECK and read by the composite foreign key
     * to `document_series (code, document_kind)` — which is what stops a credit note being numbered
     * out of the TAX-INV range. A generated column cannot participate in a foreign key.
     */
    documentKind: text('document_kind').notNull(),

    /** The statutory number, exactly as `allocate_document_number()` handed it over. Never re-derived. */
    seriesCode: text('series_code').notNull(),
    periodKey: text('period_key').notNull(),
    number: bigint('number', { mode: 'bigint' }).notNull(),
    displayNumber: text('display_number').notNull(),

    /**
     * The issuer, snapshotted on the NOTE's date and not copied from the invoice.
     *
     * A credit note is a document in its own right: it is issued later, possibly after a relocation or
     * a change of legal name, and it must print the issuer as it was then. Copying the invoice's
     * snapshot would print September's address on an October document.
     */
    issuerLegalName: text('issuer_legal_name').notNull(),
    issuerTradingName: text('issuer_trading_name').notNull(),
    /** Fifteen digits, and refused if it is the Y1-trn placeholder. */
    issuerTrn: text('issuer_trn').notNull(),
    issuerAddressSnapshot: text('issuer_address_snapshot').notNull(),
    issuerEmirate: text('issuer_emirate').notNull(),
    issuerPhone: text('issuer_phone'),
    issuerLicenceNumber: text('issuer_licence_number'),
    /** Nullable for `invoice`'s reason: there is no Arabic column to snapshot from. */
    issuerLegalNameAr: text('issuer_legal_name_ar'),
    issuerAddressSnapshotAr: text('issuer_address_snapshot_ar'),

    /** Provenance, and null for a cash sale at the desk. `on delete restrict`. */
    customerId: uuid('customer_id').references(() => customer.id),
    /** A record label — `Customer 0042` — never an invented name (ADR 0020). */
    customerNameSnapshot: text('customer_name_snapshot').notNull(),
    customerTrn: text('customer_trn'),
    customerAddressSnapshot: text('customer_address_snapshot'),
    customerPhone: text('customer_phone'),

    issueDate: date('issue_date').notNull(),
    /** Null when the note was raised while the premises was shut. */
    issueTradingDate: date('issue_trading_date'),
    /**
     * The date of the ADJUSTMENT, and the `entry_date` of the reversal.
     *
     * Not the invoice's tax point. A note raised in October for a September invoice posts in October,
     * because September may be filed and restating a filed period is what `period_lock` prevents.
     */
    taxPointDate: date('tax_point_date').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),

    currency: char('currency', { length: 3 }).notNull(),
    /**
     * What the note takes OFF, held positive in the same `fils_nonneg` domain as every other money
     * column. The direction is the journal's — the reversal debits revenue — and a negative amount here
     * would be a second spelling of one fact in every report that sums it.
     *
     * `mode: 'bigint'` for `invoice`'s reason: the driver returns bigint as a string precisely so an
     * amount cannot silently lose precision.
     */
    netTotal: bigint('net_total', { mode: 'bigint' }).notNull(),
    vatTotal: bigint('vat_total', { mode: 'bigint' }).notNull(),
    grossTotal: bigint('gross_total', { mode: 'bigint' }).notNull(),

    /** Mandatory. A correction with no stated reason cannot be reviewed. */
    reason: text('reason').notNull(),

    /**
     * The reversing entry.
     *
     * The foreign key is DEFERRED in the migration, and that is what fixes the order of the two
     * inserts: the note is written FIRST, so its own trigger is what refuses a locked period and names
     * the earliest open date. Post the entry first and `journal_entry`'s own guard gets there instead,
     * with a message about a journal entry on a request that was about a document.
     */
    journalEntryId: text('journal_entry_id')
      .notNull()
      .references(() => journalEntry.entryId),

    notes: text('notes'),
    /** 'Y11-vat-invoice' while the mandatory field list is an assumption rather than a confirmation. */
    provisionalOpenQuestionId: text('provisional_open_question_id'),
    provisionalNote: text('provisional_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('credit_note_series_period_number_unique').on(t.seriesCode, t.periodKey, t.number),
    unique('credit_note_display_number_unique').on(t.displayNumber),
    unique('credit_note_one_reversal_per_entry').on(t.journalEntryId),
    check('credit_note_document_kind_is_credit_note', sql`${t.documentKind} = 'credit_note'`),
    check('credit_note_number_check', sql`${t.number} >= 1`),
    check('credit_note_currency_check', sql`${t.currency} = 'AED'`),
    check('credit_note_totals_reconcile', sql`${t.netTotal} + ${t.vatTotal} = ${t.grossTotal}`),
    check('credit_note_gross_positive', sql`${t.grossTotal} > 0`),
    check('credit_note_reason_present', sql`btrim(${t.reason}) <> ''`),
    check('credit_note_issuer_trn_is_fifteen_digits', sql`${t.issuerTrn} ~ '^[0-9]{15}$'`),
    check('credit_note_issuer_trn_not_placeholder', sql`not is_placeholder_text(${t.issuerTrn})`),
    check(
      'credit_note_issuer_name_not_placeholder',
      sql`not is_placeholder_text(${t.issuerLegalName})`,
    ),
    check(
      'credit_note_issuer_address_not_placeholder',
      sql`not is_placeholder_text(${t.issuerAddressSnapshot})`,
    ),
    check('credit_note_customer_name_present', sql`btrim(${t.customerNameSnapshot}) <> ''`),
    check('credit_note_tax_point_not_after_issue', sql`${t.taxPointDate} <= ${t.issueDate}`),
    check(
      'credit_note_provisional_pair',
      sql`(${t.provisionalOpenQuestionId} is null) = (${t.provisionalNote} is null)`,
    ),
    index('credit_note_invoice_idx').on(t.invoiceId),
    index('credit_note_tax_point_date_idx').on(t.taxPointDate),
  ],
)

/**
 * One credited line, naming the invoiced line it corrects.
 *
 * `invoiceLineNo` is a plain integer for the reason `invoiceId` is a plain uuid, and
 * `credit_note_line_credits_a_real_line()` is what makes it true: it refuses a line the invoice does
 * not have, a credit at a different unit price or rate, a full credit whose figures are a
 * re-derivation, and a cumulative quantity above what was sold.
 */
export const creditNoteLine = pgTable(
  'credit_note_line',
  {
    creditNoteId: uuid('credit_note_id')
      .notNull()
      .references(() => creditNote.id),
    lineNo: integer('line_no').notNull(),
    /** The line of `creditNote.invoiceId` this credits. */
    invoiceLineNo: integer('invoice_line_no').notNull(),
    /** A snapshot: renaming a service must not restate what the customer was refunded for. */
    descriptionEn: text('description_en').notNull(),
    descriptionAr: text('description_ar'),
    /** How much of the invoiced quantity is credited. The CUMULATIVE figure is capped by a trigger. */
    quantity: integer('quantity').notNull(),
    /** Held equal to the invoiced line's: a credit at a different price is a repricing, not a fix. */
    unitGrossFils: bigint('unit_gross_fils', { mode: 'bigint' }).notNull(),
    /** Generated in the database as `unit_gross_fils * quantity`. Multiplication admits no rounding. */
    lineGrossFils: bigint('line_gross_fils', { mode: 'bigint' }).notNull(),
    vatRateBp: smallint('vat_rate_bp').notNull(),
    lineNetFils: bigint('line_net_fils', { mode: 'bigint' }).notNull(),
    /**
     * Rounded on the credited LINE gross by `splitGross` in `@berelax/core`, never generated here.
     *
     * A FULL credit must carry the invoice line's own figures to the fils, and that is enforced. A
     * partial one may legitimately differ: three notes of quantity 1 against a line of 3 at 11 fils
     * gross carry 1 fils of VAT each where the line carries 2.
     */
    lineVatFils: bigint('line_vat_fils', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.creditNoteId, t.lineNo] }),
    unique('credit_note_line_one_per_invoice_line').on(t.creditNoteId, t.invoiceLineNo),
    check('credit_note_line_line_no_check', sql`${t.lineNo} >= 1`),
    check('credit_note_line_invoice_line_no_check', sql`${t.invoiceLineNo} >= 1`),
    check('credit_note_line_quantity_check', sql`${t.quantity} >= 1`),
    check('credit_note_line_vat_rate_bp_check', sql`${t.vatRateBp} between 0 and 10000`),
    check('credit_note_line_description_en_check', sql`btrim(${t.descriptionEn}) <> ''`),
    check(
      'credit_note_line_totals_reconcile',
      sql`${t.lineNetFils} + ${t.lineVatFils} = ${t.unitGrossFils} * ${t.quantity}`,
    ),
    index('credit_note_line_note_idx').on(t.creditNoteId),
  ],
)
