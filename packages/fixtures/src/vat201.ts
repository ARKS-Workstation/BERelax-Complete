import type { AccountCode, BillTaxTreatment } from '@berelax/core'
import { ACCOUNTS } from '@berelax/core'

/**
 * The committed worked example for the VAT201 return (M-VAT-07).
 *
 * Three consecutive closed months, each covering something no other one can:
 *
 *   * **the sale month** — a package sold and nothing else. Under [UNVERIFIED] Y11-vat-package's
 *     provisional answer (supply at REDEMPTION) it contributes ZERO to every output-VAT box, which is an
 *     acceptance line, and it is only meaningful in a month with no redemption in it: assert it in a month
 *     that also has one and the assertion passes for the wrong reason.
 *   * **the return month** — the worked example proper. A package REDEMPTION (standard-rated sales and
 *     their output tax), a standard recoverable purchase, a zero-rated purchase, a reverse charge and a
 *     blocked purchase. Four of the five things the acceptance line names, in one closed month.
 *   * **the correction month** — a dated reversal of the return month's rent bill, posted by
 *     `postDatedCorrection` because the month it belongs to is shut. Its box figures are NEGATIVE, which is
 *     the point: a correction has to REDUCE a box, and the drill-down has to reach the document of the
 *     entry it reverses rather than stopping at an entry that has none of its own.
 *
 * ## Why the figures are here and the DATES are not
 *
 * The journal is append-only and refuses the owner (ZL001), so nothing can remove an entry this suite
 * posted. A fixed month would therefore DOUBLE every figure on a second run against the same database —
 * M-TILL-10's recorded defect (7), where a delta-free assertion reported 430,003 fils where 33,334 was
 * expected, from its own first run. So the suite picks a virgin three-month window out of a reserved span
 * (2080-01 .. 2081-12, which nothing else in this build posts into) and the figures below are absolute for
 * whichever window it got. The window is derived, the arithmetic is committed.
 *
 * ## Why no content hash is committed
 *
 * `trialBalanceHashAsAt` is cumulative over the whole ledger, so the working paper's `contentHash` differs
 * between databases and between runs by design — it is evidence about a ledger, not about a fixture. The
 * byte-identical acceptance line is "regenerating the return for a closed period TWICE", which is asserted
 * within one run, where it must hold exactly.
 */

/**
 * The span this fixture may use, and it is deliberately enormous.
 *
 * `journal_entry` and `journal_line` refuse DELETE for every role including the owner (ZL001), so a run of
 * this suite ON ITS OWN consumes its three months FOR GOOD. A narrow span is therefore not a tidiness
 * question: gate block 116 runs this suite once per mutant, so a span of a few years would be exhausted
 * inside a single `pnpm gates:only` and the failure would arrive as "the fixture threw" in a case about
 * something else.
 *
 * The append-only claim is about DELETE and not about TRUNCATE, which is worth stating precisely because
 * several files in this repository say "nothing truncates the journal" and one thing does:
 * `packages/db/src/repositories/journal.itest.ts` runs `truncate journal_line, journal_entry cascade` in
 * its `beforeAll`, and a BEFORE DELETE row trigger cannot see a TRUNCATE. `packages/db` runs before
 * `packages/fixtures` in the integration suite, so a full `pnpm test:integration` empties the span before
 * this file reaches it and the window search starts from the beginning every time — which means the
 * six-hundred-month budget is spent only by running this file repeatedly on its own. The truncate cannot
 * land in the middle of this file either, because the suite is sequential and file-scoped, so the absolute
 * figures below are safe in both orders. If it ever did, every figure would read ZERO and the suite would
 * fail loudly rather than quietly agreeing with itself.
 *
 * 2150-01 to 2199-12 is six hundred months — two hundred runs against one database. Measured free rather
 * than assumed: no date in `packages`, `apps` or `scripts` falls in the 2100s except three unrelated
 * expiry dates in 2100 itself, and the fixture suites cluster in 2083-2099. Nothing bounds a date this far
 * out: `journal_entry.entry_date` is a plain `date` with no FK to `business_day` (0018 says why), and
 * `business_day` carries no range CHECK (0011).
 *
 * Three months is the MINIMUM the acceptance lines need: a sale month BEFORE the return month, and a
 * correction month AFTER it, because a dated reversal posts into the first OPEN period and the return month
 * is shut by then. When the span is used up the suite throws with the remedy rather than wrapping onto a
 * month that already holds a previous run's entries, which would read as every committed figure being
 * double — M-TILL-10's recorded defect (7).
 */
export const VAT201_RESERVED_SPAN = { from: '2150-01-01', to: '2199-12-31' } as const

/** Bills the return month contains, as drafts `deriveBill` turns into figures. */
export interface Vat201FixtureBill {
  /** Why this bill exists — the case it is the only cover for. */
  readonly why: string
  readonly supplierCode: string
  readonly supplierReference: string
  readonly account: AccountCode
  /** VAT-inclusive and authoritative (ADR 0007). Net and VAT are derived from it. */
  readonly grossFils: number
  readonly treatment: BillTaxTreatment
  /** The reverse charge the line self-accounts, where the treatment is the one that needs it. */
  readonly reverseChargeFils?: number
}

/**
 * The four purchases. One per thing that lands somewhere different on the return.
 *
 * 105,000 / 42,000 / 200,000 are chosen so every split is exact at 5% and any change to the rounding
 * convention shows up as a whole fils rather than hiding inside a remainder — the same reason M-VAT-03's
 * cloud-hosting shape uses 100,000.
 */
export const VAT201_FIXTURE_BILLS: readonly Vat201FixtureBill[] = [
  {
    why: 'the ordinary recoverable purchase: the value in the input box and the tax claimed beside it',
    supplierCode: 'fixture-registered-landlord',
    supplierReference: 'FIX-VAT201-RENT-0001',
    account: ACCOUNTS.rent,
    grossFils: 105_000,
    treatment: 'standard_recoverable',
  },
  {
    why:
      'the zero-rated purchase: value in the input box, nothing in its tax column. The acceptance ' +
      "line's zero-rated case — on the PURCHASE side, because the provisional chart carries no " +
      'zero-rated revenue account and inventing one would be a claim about what the business sells',
    supplierCode: 'fixture-registered-consumables',
    supplierReference: 'FIX-VAT201-ZERO-0001',
    account: ACCOUNTS.laundryAndCleaning,
    grossFils: 63_000,
    treatment: 'zero_rated',
  },
  {
    why:
      'the blocked purchase: in scope, and UNALLOCATED because no box number has been given for it. ' +
      'The expense carries the net AND the tax that cannot be reclaimed, so the ledger cannot separate ' +
      'them and the disclosure figure has to come from bill_line',
    supplierCode: 'fixture-registered-landlord',
    supplierReference: 'FIX-VAT201-BLOCKED-0001',
    account: ACCOUNTS.entertainment,
    grossFils: 42_000,
    treatment: 'blocked_not_recoverable',
  },
  {
    why:
      'the reverse charge: declared and reclaimed in equal fils, never netted. One grouping feeding TWO ' +
      'columns of one box from two accounts on opposite sides — the shape account.vat_box alone cannot ' +
      'express, which is why the mapping is keyed on the account',
    supplierCode: 'fixture-offshore-cloud',
    supplierReference: 'FIX-VAT201-RC-0001',
    account: ACCOUNTS.importedServices,
    grossFils: 200_000,
    treatment: 'imported_services_reverse_charge',
    reverseChargeFils: 10_000,
  },
] as const

/** The package sold in the sale month and partly redeemed in the return month. */
export const VAT201_FIXTURE_PACKAGE = {
  priceFils: 210_000,
  sessions: 6,
  redeemedSessions: 2,
  /**
   * `ceil(210_000 × 2 / 6)`, which is `package_release_through_fils` in 0083 and `releaseThrough` in
   * core. Exact here, so the release figure is checkable by eye.
   */
  releasedFils: 70_000,
  /**
   * The split of the released gross at 5%: `roundHalfUp(70_000 / 1.05) = 66_667`, VAT the remainder.
   *
   * [UNVERIFIED] Y11-rounding is exactly this convention, and this is the one figure in the fixture that
   * moves if the owner answers it differently — 66,666 net and 3,334 VAT under truncation. It moves the
   * SPLIT between box 1's two columns and never their sum, which is 70,000 either way.
   */
  netFils: 66_667,
  vatFils: 3_333,
} as const

export interface Vat201WorkedBox {
  /**
   * The GROUPING whose VALUE column this box holds, never a box number.
   *
   * Y11-vat201-boxes is open and the numbers are rows. A committed `1` here would be this fixture
   * asserting the answer instead of reading it, and the test that proves the mapping is data would then
   * have a second hard-coded number to fight.
   */
  readonly grouping: 'standard_rated_supplies' | 'reverse_charge' | 'recoverable_input_tax'
  /**
   * The grouping whose TAX column the SAME box holds, where it is a different one.
   *
   * Only standard-rated supplies need it, and the reason is worth stating: the value of a sale sits on a
   * revenue account tagged `standard_rated_supplies` and the tax on it sits on 2030, whose grouping is
   * `output_tax`. One box, two groupings — which is the second half of why the mapping is keyed on the
   * ACCOUNT. `reverse_charge` is the mirror case: ONE grouping, two accounts (6075 and 2035), two columns
   * and two directions. Neither shape can be expressed by a grouping-to-box table.
   */
  readonly taxGrouping?: 'output_tax'
  readonly netSuppliesFils: number
  readonly taxFils: number
  readonly lineCount: number
}

/**
 * The return month's boxes, exact to the fils.
 *
 *   standard-rated  4020 credited 66,667 (the redemption's net) and 2030 credited 3,333 (its tax).
 *   reverse charge  6075 debited 200,000 (the imported service) and 2035 credited 10,000 (the tax
 *                   declared on it). The 10,000 reclaimed is in the input box, never netted against this.
 *   input tax       6010 debited 100,000 and 6050 debited 63,000 (the values); 1080 debited 5,000 from the
 *                   landlord's tax invoice and 10,000 from our own self-assessment (the tax), which is
 *                   why the reconciliation adds the bill's two columns rather than taking one.
 */
export const VAT201_WORKED_EXAMPLE_BOXES: readonly Vat201WorkedBox[] = [
  {
    grouping: 'standard_rated_supplies',
    taxGrouping: 'output_tax',
    netSuppliesFils: 66_667,
    taxFils: 3_333,
    lineCount: 2,
  },
  { grouping: 'reverse_charge', netSuppliesFils: 200_000, taxFils: 10_000, lineCount: 2 },
  { grouping: 'recoverable_input_tax', netSuppliesFils: 163_000, taxFils: 15_000, lineCount: 4 },
] as const

/**
 * The blocked account's unallocated figure: 42,000, which is the 40,000 net PLUS the 2,000 borne.
 *
 * Committed as one figure because the ledger holds one: `postBill` debits the expense with the net and the
 * blocked VAT together ("blocked VAT is part of what the thing cost"), so 40,000 and 2,000 are not
 * separable from `journal_line` at all. The 2,000 comes from `bill_line.blocked_input_vat_fils`, which is
 * M-VAT-02's working paper, and the return reconciles against it rather than re-deriving it.
 */
export const VAT201_WORKED_EXAMPLE_UNALLOCATED = {
  accountCode: ACCOUNTS.entertainment as string,
  netSuppliesFils: 42_000,
  blockedVatFromBillLine: 2_000,
  lineCount: 1,
} as const

/**
 * The out-of-scope bucket, measured as debits PLUS credits.
 *
 * Never the net. M-TILL-09's `probePackageSalePosting` summed credit minus debit and read the zero as "no
 * revenue posted": 4010 credited against the contra 4095 by the same figure nets to zero and HAS
 * recognised revenue.
 *
 *   2010 Trade payables   105,000 + 63,000 + 42,000 + 200,000 credited by the four bills
 *   2050 Deferred revenue  70,000 debited by the redemption
 */
export const VAT201_WORKED_EXAMPLE_OUT_OF_SCOPE = [
  { accountCode: ACCOUNTS.tradePayables as string, movementFils: 410_000, lineCount: 4 },
  { accountCode: ACCOUNTS.packageDeferredRevenue as string, movementFils: 70_000, lineCount: 1 },
] as const

/** The return month's partition, which every line in it has to satisfy. */
export const VAT201_WORKED_EXAMPLE_CENSUS = {
  /** 3 + 2 + 2 + 4 for the bills, 3 for the redemption. */
  linesInPeriod: 14,
  boxed: 8,
  unallocated: 1,
  outOfScope: 5,
  unattributed: 0,
} as const

/** The sale month: two lines, both out of scope, and nothing in any output-VAT box. */
export const VAT201_SALE_MONTH = {
  linesInPeriod: 2,
  outOfScope: 2,
  boxed: 0,
  outputTaxFils: 0,
  standardRatedNetFils: 0,
} as const

/**
 * The correction month: the rent bill reversed, so every figure is the negative of what it undid.
 *
 * The sign is the assertion. A correction dropped from the return, or added to it, both leave a box that
 * looks plausible; only the sign says the reversal was understood.
 */
export const VAT201_CORRECTION_MONTH = {
  linesInPeriod: 3,
  boxed: 2,
  outOfScope: 1,
  inputTaxNetSuppliesFils: -100_000,
  inputTaxTaxFils: -5_000,
} as const
