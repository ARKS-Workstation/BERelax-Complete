import type { MonthReconciliationLineId, ReconciliationLineKind } from '@berelax/db'

/**
 * The committed worked example for the closed-month reconciliation (M-VAT-12).
 *
 * One month of documents, chosen so that every 5% split is exact at the fil and a reader can check each
 * identity by hand from the table below. It is the thing a tax agent is shown first, and it is a
 * TypeScript constant rather than the `artifacts/fixtures/closed-month-reconciliation.json` the manifest
 * declared, for M-VAT-07's recorded reason: `artifacts/` holds no tracked file in this repository — it is
 * where `scripts/screenshots.mjs` and the media outbox WRITE — while this build's convention for a
 * committed worked example is a constant in `packages/fixtures` (`RECOVERABILITY_WORKED_EXAMPLE`,
 * `REVERSE_CHARGE_WORKED_EXAMPLE` and `VAT201_WORKED_EXAMPLE_BOXES` are all that shape). A constant is
 * typechecked and importable; a JSON blob is neither.
 *
 * ## What this file is NOT
 *
 * It is not a second derivation of the report. Nothing here computes a figure from the database: the
 * numbers are the ones somebody typed, stated as the arithmetic that produced them, and
 * `packages/db/src/queries/month-reconciliation.itest.ts` builds exactly this month through the real
 * services and requires the real report to agree. So one side is a claim a human can check and the other
 * is a measurement, which is the only arrangement in which a worked example is worth anything.
 *
 * The line IDS come from `@berelax/db`, not from a list here, and {@link WORKED_EXAMPLE_EXPECTATIONS} is
 * required to cover every one of them. `packages/db` may never import `packages/fixtures`, so that import
 * is the one direction available and it is the right one: a line added to the report without an
 * expectation here fails `month-reconciliation.test.ts` instead of arriving unexamined.
 */

/** VAT-inclusive gross, and authoritative (ADR 0007). Net and VAT are derived from it, never the reverse. */
export const WORKED_TREATMENT_GROSS = 21_000
/** `round(21_000 x 10_000 / 10_500)`. Exact — no remainder, at any rounding convention. */
export const WORKED_TREATMENT_NET = 20_000
/** `gross - net`, which is how VAT is derived everywhere in this build, so `net + vat === gross`. */
export const WORKED_TREATMENT_VAT = 1_000

/** One document or movement of the worked month, with the case it is the only cover for. */
export interface WorkedExampleDocument {
  /** Why this document exists — the thing the month could not show without it. */
  readonly why: string
  readonly what: string
  readonly grossFils: number
  readonly vatFils: number
}

/**
 * The month, in documents. Six, and each one is the only cover for something.
 *
 * The package is three sessions at exactly the treatment price, so a single session releases 21,000 and
 * splits to 20,000/1,000 with no remainder: a package priced at anything else would put a rounding
 * question inside an identity that is supposed to be about the liability.
 */
export const WORKED_EXAMPLE_DOCUMENTS: readonly WorkedExampleDocument[] = [
  {
    why: 'the ordinary sale: two treatments billed together, so the document total is a SUM of lines',
    what: 'invoice 1, two treatments, cash',
    grossFils: WORKED_TREATMENT_GROSS * 2,
    vatFils: WORKED_TREATMENT_VAT * 2,
  },
  {
    why:
      'a second sale on a DIFFERENT tender, so the tender identity is over two accounts rather than ' +
      'one. Card money lands in 1040 Card terminal clearing and not the bank, because the terminal ' +
      'settles in a batch days later',
    what: 'invoice 2, one treatment, card',
    grossFils: WORKED_TREATMENT_GROSS,
    vatFils: WORKED_TREATMENT_VAT,
  },
  {
    why:
      'the correction: a credit note has to REDUCE revenue and output VAT, so an identity that only ' +
      'ever added would pass on a month with a credit note in it and be wrong by its gross',
    what: 'credit note against invoice 2, in full',
    grossFils: -WORKED_TREATMENT_GROSS,
    vatFils: -WORKED_TREATMENT_VAT,
  },
  {
    why:
      'money OUT. A refund is not a negative payment — it is its own row with its own trading date and ' +
      'its own entry — and the tender identity has to subtract it rather than net it away',
    what: 'refund against invoice 2, cash',
    grossFils: -WORKED_TREATMENT_GROSS,
    vatFils: 0,
  },
  {
    why:
      'a package sale takes money and recognises NO revenue and NO output VAT: under [UNVERIFIED] ' +
      'Y11-vat-package the supply is at redemption, so the whole gross sits in 2050 deferred revenue',
    what: 'package sale, three sessions, cash',
    grossFils: WORKED_TREATMENT_GROSS * 3,
    vatFils: 0,
  },
  {
    why:
      'a redemption recognises revenue and output VAT with NO document behind it, which is the one ' +
      'thing the invoice identity cannot reach and the reason there is a second identity for it',
    what: 'redemption of one session',
    grossFils: WORKED_TREATMENT_GROSS,
    vatFils: WORKED_TREATMENT_VAT,
  },
]

/**
 * The bookings, which are what makes the report a chain rather than a ledger check.
 *
 * Two cancellation states and not one: `cancelled_by_customer` and `cancelled_by_salon` differ in policy
 * and agree in reporting treatment, so a month carrying one of them cannot show that the report counts
 * both.
 */
export const WORKED_EXAMPLE_APPOINTMENTS = {
  /** Two on invoice 1, one on invoice 2, one redeemed. All four therefore reach a document. */
  completed: 4,
  noShow: 1,
  cancelled: 2,
} as const

/**
 * The four identities the acceptance line names, plus the two the month needs to be honest, as ARITHMETIC.
 *
 * Written as the sum rather than as the answer on purpose: `42_000` is a number to take on trust, and
 * `21_000 * 2 + 21_000 - 21_000` is a claim a reader can check against the table above.
 */
export const WORKED_EXAMPLE_IDENTITIES = {
  /** Invoice gross less credit-note gross, against revenue plus output VAT credited. */
  revenueFils: WORKED_TREATMENT_GROSS * 2 + WORKED_TREATMENT_GROSS - WORKED_TREATMENT_GROSS,
  /** Tendered less refunded, against the net debit to the tender accounts. */
  tenderFils:
    WORKED_TREATMENT_GROSS * 2 +
    WORKED_TREATMENT_GROSS +
    WORKED_TREATMENT_GROSS * 3 -
    WORKED_TREATMENT_GROSS,
  /** Package sold less redeemed, against the movement in 2050. */
  packageLiabilityFils: WORKED_TREATMENT_GROSS * 3 - WORKED_TREATMENT_GROSS,
  /** What redemptions released, against the revenue and output VAT the redemption entries credited. */
  redemptionFils: WORKED_TREATMENT_GROSS,
  /**
   * The output tax the documents carry, against the tax in the VAT201 box the tax tag maps to.
   *
   * The redemption's VAT is in this sum and that is the term this file first left out: a redemption
   * recognises output tax with no invoice behind it, so the box figure is a thousand fils larger than the
   * invoices and the credit note account for. `month-reconciliation.test.ts` re-derives this from
   * WORKED_EXAMPLE_DOCUMENTS and is what caught it, which is the only reason a worked example is worth
   * committing at all.
   */
  outputTaxFils:
    WORKED_TREATMENT_VAT * 2 + WORKED_TREATMENT_VAT - WORKED_TREATMENT_VAT + WORKED_TREATMENT_VAT,
  /** Completed appointments reaching neither an invoice nor a redemption. Zero, and never anything else. */
  appointmentsWithoutADocument: 0,
} as const

/** What the worked month expects of one line of the report. */
export interface WorkedExampleExpectation {
  readonly kind: ReconciliationLineKind
  readonly measure: 'fils' | 'rows'
  /**
   * The figure on the LEFT of the line, or null where the month states no committed figure for it.
   *
   * Null for the ledger census line alone: its figure is the sum of both sides of sixteen journal lines,
   * which is arithmetic over a posting convention rather than over the documents, and committing it here
   * would be committing to how many lines each entry happens to have.
   */
  readonly leftFils: number | null
  /** Every line holds in the worked month. That is the acceptance line, restated as data. */
  readonly variance: 0
}

/**
 * One expectation per line, required to cover exactly `MONTH_RECONCILIATION_LINE_IDS`.
 *
 * `Record<MonthReconciliationLineId, …>` and not a partial: TypeScript refuses this object the moment a
 * line id is added to the report and not to this table, which is a compile error rather than a test that
 * passes over a line nobody stated an expectation for.
 */
export const WORKED_EXAMPLE_EXPECTATIONS: Record<
  MonthReconciliationLineId,
  WorkedExampleExpectation
> = {
  completed_appointments_without_a_document: {
    kind: 'identity',
    measure: 'rows',
    leftFils: WORKED_TREATMENT_GROSS * WORKED_EXAMPLE_APPOINTMENTS.completed,
    variance: 0,
  },
  invoices_less_credit_notes_against_revenue_and_output_vat: {
    kind: 'identity',
    measure: 'fils',
    leftFils: WORKED_EXAMPLE_IDENTITIES.revenueFils,
    variance: 0,
  },
  payments_less_refunds_against_tender_accounts: {
    kind: 'identity',
    measure: 'fils',
    leftFils: WORKED_EXAMPLE_IDENTITIES.tenderFils,
    variance: 0,
  },
  package_liability_movement_against_sales_less_redemptions: {
    kind: 'identity',
    measure: 'fils',
    leftFils: WORKED_EXAMPLE_IDENTITIES.packageLiabilityFils,
    variance: 0,
  },
  package_redemptions_against_revenue_and_output_vat: {
    kind: 'identity',
    measure: 'fils',
    leftFils: WORKED_EXAMPLE_IDENTITIES.redemptionFils,
    variance: 0,
  },
  output_tax_against_the_vat201_box: {
    kind: 'identity',
    measure: 'fils',
    leftFils: WORKED_EXAMPLE_IDENTITIES.outputTaxFils,
    variance: 0,
  },
  ledger_census_against_the_trial_balance: {
    kind: 'identity',
    measure: 'fils',
    leftFils: null,
    variance: 0,
  },
  no_shows_excluded_from_revenue: {
    kind: 'excluded',
    measure: 'rows',
    leftFils: WORKED_TREATMENT_GROSS * WORKED_EXAMPLE_APPOINTMENTS.noShow,
    variance: 0,
  },
  cancellations_excluded_from_revenue: {
    kind: 'excluded',
    measure: 'rows',
    leftFils: WORKED_TREATMENT_GROSS * WORKED_EXAMPLE_APPOINTMENTS.cancelled,
    variance: 0,
  },
  treasury_movements_excluded_from_receipts: {
    kind: 'stated',
    measure: 'fils',
    // The worked month banks nothing and pays nothing out of the drawer, so the movement is zero — and
    // this is the ONE line where a zero says something rather than nothing: it is why the tender identity
    // above may be read as "everything that touched a tender account was a receipt".
    leftFils: 0,
    variance: 0,
  },
  rows_created_after_the_period_lock: {
    kind: 'census',
    measure: 'rows',
    leftFils: 0,
    variance: 0,
  },
}

/**
 * What the worked month does NOT cover, stated rather than left to be discovered.
 *
 * Every entry is a case the report would reach and this month does not put in front of it. A worked
 * example that listed only what it covers is how a gap comes to read as a guarantee.
 */
export const WORKED_EXAMPLE_NOT_COVERED: readonly string[] = [
  'A purchase. `supplier_bill` is a source class this report excludes by name: M-VAT-02 owns the ' +
    'payables reconciliation and M-VAT-03 the input-tax working paper, and duplicating either here is ' +
    'the second derivation this unit exists not to make.',
  'A reverse charge. It posts to 2035, which maps to its own VAT201 box and is on the purchase side, ' +
    'and M-VAT-03 owns the working paper that reconciles it.',
  'A zero-rated or exempt SALE. The provisional chart carries no zero-rated revenue account, and adding ' +
    'one would be a claim about what this business sells ([UNVERIFIED] Y11-vat201-boxes).',
  'A gratuity. It credits 2040 Tips payable, which is tagged with no VAT box and reaches no identity ' +
    'here — correctly, because a tip is not consideration for a supply — but this month contains none, ' +
    'so nothing in it proves the exclusion. M-TILL-06 owns the posting and its own itest asserts that ' +
    'the tip stays out of revenue and out of the VAT box.',
  'A dated correction posted from a LATER period into this one. ADR 0017 makes that impossible while the ' +
    'period is locked, and the case the report answers instead is a period reopened by migration, which ' +
    'is what `rows_created_after_the_period_lock` counts.',
  'A cash-up. The treasury line is the mechanism and this month exercises it at zero; M-TILL-11 owns the ' +
    'drawer reconciliation itself.',
]
