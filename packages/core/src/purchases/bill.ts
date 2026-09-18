import { AppError } from '@berelax/shared'
import type { AccountCode } from '../ledger/account.ts'
import { ACCOUNTS } from '../ledger/chart-of-accounts.ts'
import { credit, debit, type EntryDraft, type EntryLineDraft, entryId } from '../ledger/entry.ts'
import {
  add,
  type Money,
  splitGross,
  subtract,
  sum,
  UAE_STANDARD_VAT_BP,
  type VatRateBp,
  ZERO_AED,
  ZERO_RATED_BP,
} from '../money.ts'
import type { LocalDate } from '../time.ts'

/**
 * The purchase side of VAT: what a supplier bill costs, and what of it may be reclaimed.
 *
 * Pure. Everything here takes its inputs as arguments — including the date, which the caller resolved
 * on `business_day` — and returns values. The writes are `packages/db/src/services/post-bill.ts`.
 *
 * ## Gross is authoritative, VAT is the remainder
 *
 * A supplier invoice states a gross amount, and that is the amount that will be paid. Net is derived
 * from it and VAT is derived as `gross - net`, never rounded independently (ADR 0007), so
 * `net + vat === gross` holds for every input rather than for almost every input. The one-fils
 * discrepancy the alternative produces has to be explained to an auditor line by line.
 *
 * ## Recovery is a property of the line, not of the bill
 *
 * One bill routinely mixes treatments: a utilities invoice carrying a standard-rated supply and an
 * out-of-scope government fee is the ordinary case. A bill-level treatment would force the preparer
 * either to split the invoice by hand or to claim the wrong figure, and the second is what happens.
 *
 * ## What is deliberately not here
 *
 * The rule that a supplier with no TRN cannot support a claim is **not** stated in this module. It is
 * enforced in the database — a CHECK on `bill`, a trigger on `bill_line` — and explained by
 * `postBill`, which names the supplier and the line. A third statement of it here would be a third
 * thing to keep in agreement with the other two, and this module cannot see a supplier's TRN anyway:
 * what matters is the TRN **at the time of the bill**, which is a snapshot on the row.
 *
 * Blocked input VAT (entertainment, M-VAT-02) and the imported-services reverse charge (M-VAT-03) are
 * absent for the same reason the database vocabulary omits them: a treatment nothing posts correctly
 * would produce a bill that looks complete and understates the return.
 */

/**
 * Where a supplier is established for VAT. Stated on every supplier, never defaulted.
 *
 * The vocabulary lives here because it is a tax concept rather than a storage detail, and
 * `packages/db/src/schema/supplier.ts` mirrors it structurally — db may not import this package. There is
 * no third value: "unknown" is what a `not null` with no default exists to make impossible, because
 * defaulting to domestic drops the reverse charge on every offshore bill.
 */
export const SUPPLIER_RESIDENCIES = ['domestic', 'offshore'] as const
export type SupplierResidency = (typeof SUPPLIER_RESIDENCIES)[number]

/**
 * How a supplier's supply is treated for UAE VAT.
 *
 * Stated rather than derived from residency: an offshore supplier's supply is either an imported service
 * (reverse charge, in both VAT201 boxes) or outside the scope of UAE VAT entirely, and nothing about the
 * supplier's address says which.
 */
export const PLACE_OF_SUPPLY_RULES = [
  'domestic_uae',
  'imported_services_reverse_charge',
  'outside_scope',
] as const
export type PlaceOfSupplyRule = (typeof PLACE_OF_SUPPLY_RULES)[number]

/** The treatments this unit can derive and post. Mirrors the CHECK on `bill_line.tax_treatment`. */
export const BILL_TAX_TREATMENTS = [
  /** 5% UAE VAT from a TRN-holding supplier. The VAT is recoverable input tax. */
  'standard_recoverable',
  /** The supplier is not registered, so nothing is claimable and the whole amount is cost. */
  'no_trn_not_recoverable',
  /** A zero-rated supply: the rate is 0 and there is nothing to claim. */
  'zero_rated',
  /** An exempt supply: no VAT was chargeable. */
  'exempt',
  /** Outside the scope of UAE VAT, e.g. a supply made and consumed abroad. */
  'out_of_scope',
] as const
export type BillTaxTreatment = (typeof BILL_TAX_TREATMENTS)[number]

/** True for the one treatment that carries VAT and supports a claim. */
export function isRecoverable(treatment: BillTaxTreatment): boolean {
  return treatment === 'standard_recoverable'
}

export interface BillLineDraft {
  readonly description: string
  /** The expense this line is. A chart code, so a typo is a compile-time or FK failure, not a report. */
  readonly account: AccountCode
  /** VAT-inclusive, and the only amount the caller supplies. */
  readonly gross: Money
  readonly treatment: BillTaxTreatment
  /**
   * The rate the supplier charged, in basis points. Optional, and the default is the treatment's own:
   * 500 for a standard-rated line and 0 for every other. Passing a non-zero rate with a treatment that
   * cannot carry VAT is refused rather than ignored — a 5% rate on a line recorded `exempt` is a
   * preparer who described the line wrongly, and it is the description that decides what is claimed.
   */
  readonly rateBp?: VatRateBp
}

export interface DerivedBillLine {
  readonly description: string
  readonly account: AccountCode
  readonly treatment: BillTaxTreatment
  readonly rateBp: VatRateBp
  readonly gross: Money
  readonly net: Money
  /** `gross - net`. Zero for every treatment but `standard_recoverable`. */
  readonly vat: Money
  /** The input tax this line supports a claim for. Zero unless the line is recoverable. */
  readonly recoverableInputVat: Money
}

export interface DerivedBill {
  readonly lines: readonly DerivedBillLine[]
  readonly net: Money
  readonly vat: Money
  readonly gross: Money
  readonly recoverableInputVat: Money
}

/**
 * Splits one line's gross into net, VAT and the recoverable claim.
 *
 * Only a standard-rated line has VAT to split. For every other treatment `net === gross`: an
 * unregistered supplier cannot charge VAT at all, and a zero-rated, exempt or out-of-scope supply has
 * none — so there is nothing to carve out, and carving something out anyway would claim tax nobody
 * charged.
 */
export function deriveBillLine(draft: BillLineDraft): DerivedBillLine {
  if (draft.description.trim().length === 0) {
    throw new AppError('validation', 'A bill line needs a description')
  }
  if (draft.gross.fils <= 0) {
    // Zero is a missing amount, not a free supply: it would pass a non-negative check, post nothing
    // and reconcile to nothing, and the bill would still look entered.
    throw new AppError(
      'validation',
      `Bill line "${draft.description}" has a gross of ${draft.gross.fils} fils; a bill line is a positive amount`,
    )
  }

  if (!isRecoverable(draft.treatment)) {
    if (draft.rateBp !== undefined && draft.rateBp !== 0) {
      throw new AppError(
        'validation',
        `Bill line "${draft.description}" is ${draft.treatment} but carries a rate of ` +
          `${draft.rateBp} bp. A line that cannot carry VAT carries none.`,
      )
    }
    return {
      description: draft.description,
      account: draft.account,
      treatment: draft.treatment,
      rateBp: ZERO_RATED_BP,
      gross: draft.gross,
      net: draft.gross,
      vat: ZERO_AED,
      recoverableInputVat: ZERO_AED,
    }
  }

  const rateBp = draft.rateBp ?? UAE_STANDARD_VAT_BP
  if (rateBp === 0) {
    throw new AppError(
      'validation',
      `Bill line "${draft.description}" is standard_recoverable at 0 bp. A recoverable line is one ` +
        'the supplier charged VAT on; at zero rate the treatment is zero_rated.',
    )
  }
  const breakdown = splitGross(draft.gross, rateBp)
  return {
    description: draft.description,
    account: draft.account,
    treatment: draft.treatment,
    rateBp,
    gross: breakdown.gross,
    net: breakdown.net,
    vat: breakdown.vat,
    // The claim IS the line's VAT. Stated as its own field rather than read off `vat` at report time,
    // because M-VAT-02 adds a treatment where the two differ — blocked VAT is charged and not
    // recoverable — and a report that reads `vat` would silently claim it.
    recoverableInputVat: breakdown.vat,
  }
}

/** Derives every line and totals them. The totals are sums of the derived lines, never re-derived. */
export function deriveBill(drafts: readonly BillLineDraft[]): DerivedBill {
  if (drafts.length === 0) {
    throw new AppError(
      'validation',
      'A bill needs at least one line: an empty bill describes nothing',
    )
  }
  const lines = drafts.map(deriveBillLine)
  const gross = sum(lines.map((line) => line.gross))
  const net = sum(lines.map((line) => line.net))
  return {
    lines,
    net,
    // `gross - net` again at the total, which is the same figure as the sum of the line VATs because
    // each line's VAT is its own remainder. Asserted both ways in bill.test.ts: a total VAT computed
    // from the total gross would differ from the sum of the lines by a fils whenever the rounding of
    // two lines went the same way, and that difference is what appears on a VAT201 as unexplained.
    vat: subtract(gross, net),
    gross,
    recoverableInputVat: sum(lines.map((line) => line.recoverableInputVat)),
  }
}

export interface BillEntryInput {
  /** Allocated by the caller. This module never invents an id. */
  readonly entryId: string
  /** The **business day**, resolved by the caller with `resolveTradingDate`. */
  readonly entryDate: LocalDate
  readonly narrative: string
  readonly bill: DerivedBill
}

/**
 * The journal entry a bill posts: **Dr expense (net) per line, Dr recoverable input VAT (total VAT
 * recoverable), Cr trade payables (gross)**.
 *
 * One credit, not one per line: the payable is what is owed to the supplier for this invoice, and a
 * per-line credit would make the payables ledger a list of line items nobody can pay against. One
 * VAT debit for the same reason — the claim is a period figure, and per-line debits would make the
 * VAT201 a thousand rows that have to be summed anyway.
 *
 * The result is a draft, not a `JournalEntry`: pass it through `postEntry(draft, chart)` to get the
 * balance check and the chart validation. `postBill` in `@berelax/db` writes the same shape, because
 * `packages/db` may not import this package; `packages/fixtures/src/purchases.itest.ts` posts a bill
 * through the service and compares the stored lines against this function, which is what stops the
 * two from drifting.
 */
export function billEntryDraft(input: BillEntryInput): EntryDraft {
  const lines: EntryLineDraft[] = input.bill.lines.map((line) =>
    debit(line.account, line.net, line.description),
  )
  if (input.bill.recoverableInputVat.fils > 0) {
    lines.push(
      debit(
        ACCOUNTS.recoverableInputVat,
        input.bill.recoverableInputVat,
        'Recoverable input VAT on supplier bill',
      ),
    )
  }
  lines.push(credit(ACCOUNTS.tradePayables, input.bill.gross, input.narrative))
  return {
    entryId: entryId(input.entryId),
    entryDate: input.entryDate,
    narrative: input.narrative,
    source: 'supplier_bill',
    lines,
  }
}

/**
 * The debit side of the entry, as a figure a caller can assert against without building the draft.
 *
 * Equal to the gross by construction: the non-recoverable lines have `net === gross`, and the
 * recoverable ones contribute their net plus their VAT. Exported because "it balances" is the property
 * every later gate asserts, and a test that re-adds the lines itself would be asserting its own
 * arithmetic.
 */
export function billDebitTotal(bill: DerivedBill): Money {
  return add(bill.net, bill.recoverableInputVat)
}

/** The account a recoverable claim is debited to. Exported so a caller need not spell '1080'. */
export const RECOVERABLE_INPUT_VAT_ACCOUNT: AccountCode = ACCOUNTS.recoverableInputVat
/** The account a bill credits. Exported for the same reason. */
export const TRADE_PAYABLES_ACCOUNT: AccountCode = ACCOUNTS.tradePayables
