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

/**
 * The issued tax document, mirroring `0026_invoice.sql`.
 *
 * Migrations are SQL-first (ADR 0006): the hand-written `.sql` is the schema and this is a mirror
 * that `pnpm db:drift` compares against the live database in both directions. Nothing writes through
 * Drizzle — the write path is `repositories/invoice.ts` — so what is mirrored here is the *shape*, and
 * a drifting column fails the build rather than a query at the till.
 *
 * Four things this mirror cannot express, which therefore live only in the migration and are proved
 * against a real PostgreSQL in `repositories/invoice.itest.ts`:
 *
 *   - the **refusal triggers** that make UPDATE and DELETE raise `ZI003` for every role, including the
 *     owner — a correction is a credit note, never an edit (docs/04 §4);
 *   - the **deferred constraint trigger** that checks the header totals against the sum of the lines
 *     at COMMIT rather than at each INSERT, because the header is inserted before its lines exist;
 *   - the **grants**, which are what stop an injected statement reaching UPDATE at all;
 *   - the **composite foreign key** to `document_series (code, document_kind)`, which is what stops a
 *     tax invoice being numbered out of the credit-note range.
 *
 * Note what is absent: there is no `updated_at`, and no trigger to maintain one. A row with no second
 * version has no update time, and a column claiming otherwise is the first step towards an edit.
 */
export const invoice = pgTable(
  'invoice',
  {
    id: uuid('id').primaryKey(),
    /** 'tax_invoice' or 'simplified_invoice'. A credit note is a different document. */
    documentKind: text('document_kind').notNull(),

    /**
     * The statutory number, exactly as `allocate_document_number()` handed it over.
     *
     * All four columns are stored and none is re-derived: `number` is what the gap report counts and
     * `display_number` is the string on the document. Recomposing the string later from the integer
     * would let an admin renaming a prefix renumber an invoice that has already been filed.
     */
    seriesCode: text('series_code').notNull(),
    periodKey: text('period_key').notNull(),
    number: bigint('number', { mode: 'bigint' }).notNull(),
    displayNumber: text('display_number').notNull(),

    /**
     * The issuer, snapshotted from `legal_entity` and `premises` at issue.
     *
     * Not a join. A relocation or a change of legal name would otherwise rewrite every historic
     * document, silently, in the direction that makes a filed return disagree with its evidence.
     */
    issuerLegalName: text('issuer_legal_name').notNull(),
    issuerTradingName: text('issuer_trading_name').notNull(),
    /** Fifteen digits, and refused if it is the Y1-trn placeholder. */
    issuerTrn: text('issuer_trn').notNull(),
    /** Newline-separated, in the order it prints. */
    issuerAddressSnapshot: text('issuer_address_snapshot').notNull(),
    issuerEmirate: text('issuer_emirate').notNull(),
    issuerPhone: text('issuer_phone'),
    issuerLicenceNumber: text('issuer_licence_number'),
    /**
     * Nullable, and the one mandatory-field gap in this schema. docs/04 §4 states the Arabic-language
     * requirement and the F10 PDF renders an Arabic party block, but `legal_entity` and `premises`
     * carry no Arabic columns to snapshot from. See the NOTE on M-TILL-04.
     */
    issuerLegalNameAr: text('issuer_legal_name_ar'),
    issuerAddressSnapshotAr: text('issuer_address_snapshot_ar'),

    /** Provenance, and null for a cash sale at the desk. `on delete restrict`. */
    customerId: uuid('customer_id').references(() => customer.id),
    /** A record label — `Customer 0042` — never an invented name (ADR 0020). */
    customerNameSnapshot: text('customer_name_snapshot').notNull(),
    customerTrn: text('customer_trn'),
    customerAddressSnapshot: text('customer_address_snapshot'),
    customerPhone: text('customer_phone'),

    /** Date of issue: the calendar date the document was written. */
    issueDate: date('issue_date').notNull(),
    /** The trading date of issue, null when the document was raised while the premises was shut. */
    issueTradingDate: date('issue_trading_date'),
    /**
     * Date of supply, and the tax point. The **trading** date the supply belongs to, so a 01:30
     * treatment carries the previous calendar date. Separate from `issueDate` because a supply on D
     * invoiced on D+1 keeps its tax point at D.
     */
    taxPointDate: date('tax_point_date').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),

    currency: char('currency', { length: 3 }).notNull(),
    /**
     * Integer fils, VAT-inclusive gross authoritative (ADR 0007), each the SUM of the per-line amount.
     *
     * `mode: 'bigint'` rather than `'number'`: the driver returns bigint as a string precisely so an
     * amount cannot silently lose precision, and a mirror that re-introduced a JS number here would
     * undo that for the columns a tax return is built from.
     */
    netTotal: bigint('net_total', { mode: 'bigint' }).notNull(),
    /** Never a re-derivation from `grossTotal`: two lines at 11 fils store 2 here, not 1. */
    vatTotal: bigint('vat_total', { mode: 'bigint' }).notNull(),
    grossTotal: bigint('gross_total', { mode: 'bigint' }).notNull(),

    notes: text('notes'),
    /** 'Y11-vat-invoice' while the mandatory field list is an assumption rather than a confirmation. */
    provisionalOpenQuestionId: text('provisional_open_question_id'),
    provisionalNote: text('provisional_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('invoice_series_period_number_unique').on(t.seriesCode, t.periodKey, t.number),
    unique('invoice_display_number_unique').on(t.displayNumber),
    check(
      'invoice_document_kind_check',
      sql`${t.documentKind} in ('tax_invoice', 'simplified_invoice')`,
    ),
    check('invoice_number_check', sql`${t.number} >= 1`),
    check('invoice_currency_check', sql`${t.currency} = 'AED'`),
    check('invoice_totals_reconcile', sql`${t.netTotal} + ${t.vatTotal} = ${t.grossTotal}`),
    check('invoice_issuer_trn_is_fifteen_digits', sql`${t.issuerTrn} ~ '^[0-9]{15}$'`),
    check('invoice_issuer_trn_not_placeholder', sql`not is_placeholder_text(${t.issuerTrn})`),
    check(
      'invoice_issuer_name_not_placeholder',
      sql`not is_placeholder_text(${t.issuerLegalName})`,
    ),
    check(
      'invoice_issuer_address_not_placeholder',
      sql`not is_placeholder_text(${t.issuerAddressSnapshot})`,
    ),
    check('invoice_customer_name_present', sql`btrim(${t.customerNameSnapshot}) <> ''`),
    check('invoice_tax_point_not_after_issue', sql`${t.taxPointDate} <= ${t.issueDate}`),
    check(
      'invoice_provisional_pair',
      sql`(${t.provisionalOpenQuestionId} is null) = (${t.provisionalNote} is null)`,
    ),
    index('invoice_tax_point_date_idx').on(t.taxPointDate),
    index('invoice_issue_trading_date_idx').on(t.issueTradingDate),
  ],
)

/**
 * One line of an issued document — and the authoritative place VAT is stated.
 *
 * The document's totals are sums of these. Two lines at 11 fils gross carry 1 fils of VAT each, so
 * the document carries 2; splitting the 22-fils document total would give 1, and 1 is a figure no
 * line supports.
 */
export const invoiceLine = pgTable(
  'invoice_line',
  {
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoice.id),
    lineNo: integer('line_no').notNull(),
    /** A snapshot: renaming a service must not restate what a customer was told they bought. */
    descriptionEn: text('description_en').notNull(),
    /** Nullable — the catalogue carries no Arabic display name yet. */
    descriptionAr: text('description_ar'),
    quantity: integer('quantity').notNull(),
    unitGrossFils: bigint('unit_gross_fils', { mode: 'bigint' }).notNull(),
    /**
     * Generated in the database as `unit_gross_fils * quantity`.
     *
     * Multiplication involves no rounding, so it has exactly one correct value and no caller can
     * disagree with it. The *split* is not generated, because half-up rounding has one definition — in
     * `@berelax/core` — and a plpgsql copy of it would be a second.
     */
    lineGrossFils: bigint('line_gross_fils', { mode: 'bigint' }).notNull(),
    vatRateBp: smallint('vat_rate_bp').notNull(),
    lineNetFils: bigint('line_net_fils', { mode: 'bigint' }).notNull(),
    /** Rounded on the LINE gross, not per unit: 3 at 11 fils is 33 gross carrying 2 fils of VAT. */
    lineVatFils: bigint('line_vat_fils', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.invoiceId, t.lineNo] }),
    check('invoice_line_line_no_check', sql`${t.lineNo} >= 1`),
    check('invoice_line_quantity_check', sql`${t.quantity} >= 1`),
    check('invoice_line_vat_rate_bp_check', sql`${t.vatRateBp} between 0 and 10000`),
    check('invoice_line_description_en_check', sql`btrim(${t.descriptionEn}) <> ''`),
    check(
      'invoice_line_totals_reconcile',
      sql`${t.lineNetFils} + ${t.lineVatFils} = ${t.unitGrossFils} * ${t.quantity}`,
    ),
    index('invoice_line_invoice_id_idx').on(t.invoiceId),
  ],
)
