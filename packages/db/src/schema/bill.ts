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
import { supplier } from './supplier.ts'

/**
 * Supplier bills and their lines — the mirror of the second half of 0028.
 *
 * Both tables are **append-only**: `bill` and `bill_line` refuse UPDATE and DELETE for every role
 * (ADR 0017), because they are the evidence behind a filed return. In particular a line's tax
 * treatment is immutable — reclassifying it after the return that included it was filed would change
 * a filed figure with no trace. A wrong bill is answered by a dated reversal of its journal entry plus
 * a fresh bill, and settlement will be an allocation row rather than an UPDATE of this one.
 *
 * ## Why every money column is a bigint here
 *
 * The `fils` domain is `bigint`, and `connection.ts` returns bigint as a **string** so nothing can
 * silently round a money figure. `mode: 'number'` in a mirror undoes that for the column it is
 * written on, which is how `trial-balance.ts` came to report a four-fils difference for a ledger that
 * balanced. So every amount below is `mode: 'bigint'`, including the ones no realistic bill will ever
 * push past 2^53: the argument is not the size of the figure, it is that a money column with a
 * silently lossy mirror is a money column that can be wrong.
 */
export const bill = pgTable(
  'bill',
  {
    billId: uuid('bill_id').primaryKey().default(sql`uuid_generate_v7()`),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => supplier.supplierId),
    /** The supplier's own document number, as printed on their invoice. Their range, not ours. */
    supplierReference: text('supplier_reference').notNull(),

    /**
     * Our own gapless reference, allocated from the `document_series` counter row (0013, ADR 0023)
     * inside the transaction that inserts the bill.
     *
     * The four column names are exactly `NUMBERING_LEDGER_COLUMNS` in
     * `../repositories/numbering.ts`, so `findNumberingGaps(sql, 'bill')` reads this table with no
     * second implementation of the gap report.
     */
    seriesCode: text('series_code').notNull(),
    periodKey: text('period_key').notNull(),
    number: bigint('number', { mode: 'bigint' }).notNull(),
    displayNumber: text('display_number').notNull(),

    /**
     * The supplier's tax position **at the time of the bill**, set by the `bill_supplier_tax_snapshot`
     * trigger from the profile rather than passed in.
     *
     * A supplier that registers for VAT in March must not retroactively make January's bills
     * recoverable, and one that de-registers must not invalidate a claim already filed.
     */
    supplierTrn: text('supplier_trn'),
    supplierResidency: text('supplier_residency').notNull(),

    /** The supplier's invoice date: the tax point, and what their own records call this document. */
    billDate: date('bill_date').notNull(),
    /**
     * When payment falls due — the only input to the payables aging buckets.
     *
     * A `date` column, mirrored as `date`. A timestamp mirror over a date column is drift the drift
     * check cannot see — it compares names and presence — and it reads back as midnight in whatever
     * zone the session happened to carry, which moves a payable between aging buckets at the boundary.
     * `pnpm db:conventions` is what catches that, by scanning this file.
     */
    dueDate: date('due_date').notNull(),

    /**
     * The journal entry this bill posted. One entry per bill, unique: two bills sharing an entry would
     * double the payable. The business day lives on the entry (`journal_entry.entry_date`, resolved by
     * the caller with `resolveTradingDate`) and is deliberately not copied here.
     */
    entryId: text('entry_id')
      .notNull()
      .references(() => journalEntry.entryId),

    currency: text('currency').notNull(),
    netFils: bigint('net_fils', { mode: 'bigint' }).notNull(),
    grossFils: bigint('gross_fils', { mode: 'bigint' }).notNull(),
    /**
     * Derived by the **database** as `gross_fils - net_fils` (a stored generated column), so
     * `net + vat = gross` holds by construction and no caller can round the two sides independently.
     * Declared here as an ordinary column, the way `business_day.duration_seconds` is: the mirror
     * records the shape, and the generation expression lives in the migration that owns it.
     */
    vatFils: bigint('vat_fils', { mode: 'bigint' }).notNull(),
    /** The claim this bill supports: the sum of its recoverable lines, zero without a supplier TRN. */
    recoverableInputVatFils: bigint('recoverable_input_vat_fils', { mode: 'bigint' }).notNull(),
    /**
     * The VAT this bill was charged and cannot reclaim: the sum of its blocked lines (0034).
     *
     * A summary of the lines like every other header figure, and the figure the non-recoverable
     * disclosure line of the VAT201 working papers is summed from — never dropped, because a category
     * the business bore tax on and cannot claim is a disclosure rather than an absence.
     */
    blockedInputVatFils: bigint('blocked_input_vat_fils', { mode: 'bigint' }).notNull(),
    /**
     * The reverse-charge VAT this bill declares (0039): the sum of its imported-services lines.
     *
     * It is NOT inside `grossFils`. An offshore supplier charges no UAE VAT and is owed none, so the
     * payable is the consideration and this tax is owed to the FTA — adding it to the gross would overpay
     * every offshore vendor by 5% on the next payment run.
     */
    reverseChargeOutputVatFils: bigint('reverse_charge_output_vat_fils', {
      mode: 'bigint',
    }).notNull(),
    /**
     * The same VAT reclaimed, where the chart allows recovery on the category.
     *
     * Two columns rather than one net figure, which is the whole of M-VAT-03: where the input is
     * recoverable the pair is equal and the net effect is nil, and a single figure of zero is
     * indistinguishable from a bill that declared nothing at all. Below the output total by exactly the tax
     * the business bore on blocked categories.
     */
    reverseChargeInputVatFils: bigint('reverse_charge_input_vat_fils', {
      mode: 'bigint',
    }).notNull(),
    /** A label. The `audit_event` row written in the same transaction carries the full actor (F06). */
    receivedBy: text('received_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    // No updatedAt: the table is append-only, and a column promising a second version is a promise it
    // cannot keep.
  },
  (t) => [
    // The duplicate every accounts-payable process exists to catch: the same supplier invoice entered
    // twice, which pays it twice and claims its VAT twice. Scoped per supplier, because two suppliers
    // numbering their invoices '001' is not a duplicate.
    unique('bill_supplier_reference_unique').on(t.supplierId, t.supplierReference),
    unique('bill_internal_number_unique').on(t.seriesCode, t.periodKey, t.number),
    index('bill_supplier_idx').on(t.supplierId, t.billDate),
    index('bill_due_date_idx').on(t.dueDate),
    // The population the nightly exception report scans: an offshore bill accounting for no reverse charge.
    index('bill_reverse_charge_missing_idx')
      .on(t.supplierId, t.entryId)
      .where(sql`${t.supplierResidency} = 'offshore' and ${t.reverseChargeOutputVatFils} = 0`),
    check('bill_gross_positive', sql`${t.grossFils} > 0`),
    check('bill_net_positive', sql`${t.netFils} > 0`),
    check('bill_gross_not_below_net', sql`${t.grossFils} >= ${t.netFils}`),
    check(
      'bill_recoverable_not_above_vat',
      sql`${t.recoverableInputVatFils} <= ${t.grossFils} - ${t.netFils}`,
    ),
    check('bill_due_not_before_bill_date', sql`${t.dueDate} >= ${t.billDate}`),
    // Nothing beyond the bill's own VAT can be claimed or blocked. Over the SUM, because the two figures
    // partition the VAT: every line's VAT is recoverable, blocked or zero.
    check(
      'bill_blocked_not_above_vat',
      sql`${t.recoverableInputVatFils} + ${t.blockedInputVatFils} <= ${t.grossFils} - ${t.netFils}`,
    ),
    // Blocked VAT is VAT somebody charged us, and only a registered supplier can charge it. The same
    // rule and the same shape as bill_recoverable_needs_a_trn: without a tax invoice the whole amount is
    // cost, and a blocked figure standing on none would overstate the disclosure a tax agent reads.
    check(
      'bill_blocked_needs_a_trn',
      sql`${t.blockedInputVatFils} = 0 or ${t.supplierTrn} is not null`,
    ),
    // No TRN, no claim — as a row-level CHECK so it holds for every role and survives any trigger
    // being dropped.
    check(
      'bill_recoverable_needs_a_trn',
      sql`${t.recoverableInputVatFils} = 0 or ${t.supplierTrn} is not null`,
    ),
    // The header cannot claim more reverse-charge VAT than it declares. NOT all-or-nothing here, unlike the
    // line: one offshore invoice may legitimately mix a recoverable line with a blocked one.
    check(
      'bill_reverse_charge_input_not_above_output',
      sql`${t.reverseChargeInputVatFils} <= ${t.reverseChargeOutputVatFils}`,
    ),
    // Asserted against the SNAPSHOT, so a later correction to the supplier cannot undo it: a reverse charge
    // on a domestic supply would declare VAT the supplier already charged and then claim it twice.
    check(
      'bill_reverse_charge_needs_an_offshore_supplier',
      sql`${t.reverseChargeOutputVatFils} = 0 or ${t.supplierResidency} = 'offshore'`,
    ),
    check('bill_currency_check', sql`${t.currency} = 'AED'`),
    check('bill_number_check', sql`${t.number} >= 1`),
    check('bill_supplier_reference_check', sql`btrim(${t.supplierReference}) <> ''`),
    check('bill_received_by_check', sql`btrim(${t.receivedBy}) <> ''`),
    check(
      'bill_supplier_trn_check',
      sql`${t.supplierTrn} is null or ${t.supplierTrn} ~ '^[0-9]{15}$'`,
    ),
    check('bill_supplier_residency_check', sql`${t.supplierResidency} in ('domestic', 'offshore')`),
  ],
)

/**
 * The tax treatment of one bill line, stored on the line and never recomputed.
 *
 * Two of them carry VAT: `standard_recoverable`, whose VAT is claimed, and `blocked_not_recoverable`
 * (0034), whose VAT is cost because UAE VAT denies recovery on the category — entertainment, or a staff
 * benefit the business is not obliged to provide (docs/04 §4, §7).
 *
 * `imported_services_reverse_charge` (0039) carries neither: an offshore supplier charges no UAE VAT, so
 * the line's `grossFils === netFils`, and the business declares the tax itself and reclaims it where the
 * category allows recovery. Two figures, on their own columns, never one — a single net figure is zero for
 * every recoverable import, which is indistinguishable from a bill that declared nothing.
 */
export const BILL_TAX_TREATMENTS = [
  'standard_recoverable',
  'blocked_not_recoverable',
  'imported_services_reverse_charge',
  'no_trn_not_recoverable',
  'zero_rated',
  'exempt',
  'out_of_scope',
] as const
export type BillTaxTreatment = (typeof BILL_TAX_TREATMENTS)[number]

export const billLine = pgTable(
  'bill_line',
  {
    billId: uuid('bill_id')
      .notNull()
      .references(() => bill.billId),
    /** Position within the bill, so two runs over one bill produce byte-identical working papers. */
    lineNo: smallint('line_no').notNull(),
    description: text('description').notNull(),
    expenseAccountCode: text('expense_account_code')
      .notNull()
      .references(() => account.code),
    /**
     * Immutable once written. Stated per line and not per bill because one bill routinely mixes
     * treatments: a utilities invoice carrying a standard-rated supply and an out-of-scope government
     * fee is the ordinary case.
     */
    taxTreatment: text('tax_treatment').notNull(),
    /** The rate the supplier charged, in basis points: 500 is 5%. Data, not an assumption. */
    vatRateBp: smallint('vat_rate_bp').notNull(),
    netFils: bigint('net_fils', { mode: 'bigint' }).notNull(),
    grossFils: bigint('gross_fils', { mode: 'bigint' }).notNull(),
    /** Database-generated as `gross_fils - net_fils`. See the note on `bill.vatFils`. */
    vatFils: bigint('vat_fils', { mode: 'bigint' }).notNull(),
    recoverableInputVatFils: bigint('recoverable_input_vat_fils', { mode: 'bigint' }).notNull(),
    /**
     * The VAT this line was charged and cannot recover, and the reason the claim and the tax are two
     * columns rather than one: for a blocked line they differ, and a report reading `vatFils` would
     * claim it.
     */
    blockedInputVatFils: bigint('blocked_input_vat_fils', { mode: 'bigint' }).notNull(),
    /** The reverse-charge VAT this imported service declares: `Cr 2035`, whose `vat_box` is `reverse_charge`. */
    reverseChargeOutputVatFils: bigint('reverse_charge_output_vat_fils', {
      mode: 'bigint',
    }).notNull(),
    /**
     * The same VAT reclaimed: `Dr 1080`, whose `vat_box` is `recoverable_input_tax`.
     *
     * Zero on a blocked or out-of-scope category, which is the one case a reverse charge costs real money —
     * and the case a single net figure hides completely.
     */
    reverseChargeInputVatFils: bigint('reverse_charge_input_vat_fils', {
      mode: 'bigint',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('bill_line_account_idx').on(t.expenseAccountCode, t.billId),
    // The population the non-recoverable disclosure line is derived from.
    index('bill_line_blocked_idx').on(t.billId).where(sql`${t.blockedInputVatFils} > 0`),
    check('bill_line_net_positive', sql`${t.netFils} > 0`),
    check('bill_line_gross_not_below_net', sql`${t.grossFils} >= ${t.netFils}`),
    // Only a VAT-bearing treatment carries VAT: an unregistered supplier cannot charge it, and a
    // zero-rated, exempt or out-of-scope supply has none. Renamed in 0034 with the second treatment that
    // carries it — the old name asserted something that had stopped being true.
    check(
      'bill_line_only_a_vat_bearing_treatment_carries_vat',
      sql`${t.taxTreatment} in ('standard_recoverable', 'blocked_not_recoverable')
            or ${t.grossFils} = ${t.netFils}`,
    ),
    // An imported service carries a RATE although it carries no supplier VAT: the rate is what the
    // self-accounted figure was computed at, and a filed line keeps the rate it was filed at.
    check(
      'bill_line_rate_matches_treatment',
      sql`${t.taxTreatment} in ('standard_recoverable', 'blocked_not_recoverable',
                               'imported_services_reverse_charge')
            or ${t.vatRateBp} = 0`,
    ),
    check(
      'bill_line_reverse_charge_carries_a_rate',
      sql`${t.taxTreatment} <> 'imported_services_reverse_charge' or ${t.vatRateBp} > 0`,
    ),
    check(
      'bill_line_reverse_charge_only_on_an_imported_service',
      sql`${t.taxTreatment} = 'imported_services_reverse_charge'
            or (${t.reverseChargeOutputVatFils} = 0 and ${t.reverseChargeInputVatFils} = 0)`,
    ),
    // The rule of 0039 at row level: an imported service that declares nothing posts, balances, reconciles
    // to the supplier's invoice to the fils — and declares its output VAT nowhere.
    check(
      'bill_line_imported_service_accounts_for_output_vat',
      sql`${t.taxTreatment} <> 'imported_services_reverse_charge'
            or ${t.reverseChargeOutputVatFils} > 0`,
    ),
    // The rate applied to the consideration, rounded half-up in `numeric` so nothing is a float. The same
    // rule as `reverseChargeOn` in @berelax/core, which packages/db may not import.
    check(
      'bill_line_reverse_charge_output_matches_the_rate',
      sql`${t.reverseChargeOutputVatFils} = round(${t.netFils}::numeric * ${t.vatRateBp} / 10000)
            or ${t.taxTreatment} <> 'imported_services_reverse_charge'`,
    ),
    // Recovery is a property of the account, so the input side is all of the output or none of it. Anything
    // between is an apportionment nothing here computes and nobody could reproduce from the row.
    check(
      'bill_line_reverse_charge_input_is_all_or_nothing',
      sql`${t.reverseChargeInputVatFils} in (0, ${t.reverseChargeOutputVatFils})`,
    ),
    // A blocked line is one the supplier DID charge VAT on. With no VAT there is nothing blocked, and
    // the treatment would be a preparer using it as a catch-all for "not recoverable".
    check(
      'bill_line_blocked_line_carries_vat',
      sql`${t.taxTreatment} <> 'blocked_not_recoverable' or ${t.grossFils} > ${t.netFils}`,
    ),
    check(
      'bill_line_blocked_matches_treatment',
      sql`${t.blockedInputVatFils} = case when ${t.taxTreatment} = 'blocked_not_recoverable'
            then ${t.grossFils} - ${t.netFils} else 0 end`,
    ),
    check(
      'bill_line_recoverable_matches_treatment',
      sql`${t.recoverableInputVatFils} = case when ${t.taxTreatment} = 'standard_recoverable'
            then ${t.grossFils} - ${t.netFils} else 0 end`,
    ),
    check('bill_line_line_no_check', sql`${t.lineNo} >= 1`),
    check('bill_line_description_check', sql`btrim(${t.description}) <> ''`),
    check('bill_line_vat_rate_bp_check', sql`${t.vatRateBp} between 0 and 10000`),
    check(
      'bill_line_tax_treatment_check',
      sql`${t.taxTreatment} in ('standard_recoverable', 'blocked_not_recoverable',
                               'imported_services_reverse_charge',
                               'no_trn_not_recoverable', 'zero_rated', 'exempt', 'out_of_scope')`,
    ),
  ],
)
