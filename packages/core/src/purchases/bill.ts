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
 * ## The imported-services reverse charge is TWO figures
 *
 * `imported_services_reverse_charge` is the treatment for a supply an offshore supplier made to us. They
 * charged no UAE VAT — they are not established here and issue no UAE tax invoice — so the line's
 * `gross === net` and its `vat` is zero. The tax is not absent: on an imported service the recipient
 * accounts for it, which produces an **output** figure (VAT declared as though we had charged ourselves)
 * and an **input** figure (the same VAT reclaimed, where the category allows recovery). Both are carried,
 * never one: a reverse charge recorded as a single net-zero figure declares nothing in the output box and
 * claims nothing in the input box, which is wrong on both sides while the ledger still balances.
 *
 * The pair is supplied by the caller from `reverseChargeOn` in `../tax/reverse-charge.ts` rather than
 * computed here, because the input side depends on the classification of the **account** — a chart fact
 * this module is not given — and because the dependency runs `tax` -> `purchases` and not back.
 *
 * ## Blocked input VAT is charged, is not recoverable, and is cost
 *
 * `blocked_not_recoverable` is the one treatment where the VAT a supplier charged and the VAT that may
 * be reclaimed differ. UAE VAT denies recovery on some categories of spend — entertainment, and a staff
 * benefit the business is not obliged to provide (docs/04 §4, §7) — and which accounts those are is
 * `../tax/recoverability.ts`. The consequence here is arithmetic: the line's VAT lands in
 * `blockedInputVat` rather than `recoverableInputVat`, and the expense is debited with the **gross**,
 * because tax the business cannot reclaim is part of what the thing cost. It is disclosed rather than
 * dropped: {@link DerivedBill.blockedInputVat} is the figure the non-recoverable line of the VAT201
 * working papers is summed from.
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
  /**
   * 5% UAE VAT the supplier charged on a category recovery is denied on: entertainment, or a staff
   * benefit the business is not obliged to provide (docs/04 §4, §7). The VAT is cost, and disclosed.
   */
  'blocked_not_recoverable',
  /** The supplier is not registered, so nothing is claimable and the whole amount is cost. */
  'no_trn_not_recoverable',
  /** A zero-rated supply: the rate is 0 and there is nothing to claim. */
  'zero_rated',
  /** An exempt supply: no VAT was chargeable. */
  'exempt',
  /**
   * A service imported from an offshore supplier: they charged no UAE VAT, and we account for it
   * ourselves in two entries (docs/04 §4). The line carries no supplier VAT and its own
   * {@link ReverseChargePair}.
   */
  'imported_services_reverse_charge',
  /** Outside the scope of UAE VAT, e.g. a supply made and consumed abroad. */
  'out_of_scope',
] as const
export type BillTaxTreatment = (typeof BILL_TAX_TREATMENTS)[number]

/** True for the one treatment that carries VAT and supports a claim. */
export function isRecoverable(treatment: BillTaxTreatment): boolean {
  return treatment === 'standard_recoverable'
}

/** True for the one treatment that carries VAT and supports no claim. */
export function isBlocked(treatment: BillTaxTreatment): boolean {
  return treatment === 'blocked_not_recoverable'
}

/**
 * True for the two treatments a supplier charged VAT under.
 *
 * The split that matters to the arithmetic is "was VAT charged", not "may it be claimed": an exempt,
 * zero-rated, out-of-scope or TRN-less line has no VAT to carve out of its gross, and a blocked line
 * does. Deriving the gross of a blocked line as if no VAT had been charged would lose the figure the
 * non-recoverable disclosure is made of.
 */
export function carriesVat(treatment: BillTaxTreatment): boolean {
  return isRecoverable(treatment) || isBlocked(treatment)
}

/**
 * True for the one treatment where the business accounts for the VAT itself.
 *
 * Deliberately NOT part of {@link carriesVat}. The question `carriesVat` answers is "did the supplier
 * charge VAT inside this gross", and for an imported service the answer is no — the gross is the
 * consideration and the tax is owed to the FTA rather than to the vendor. Folding the reverse charge into
 * `carriesVat` would carve the tax out of the amount the supplier is owed, and the payment run would then
 * underpay every offshore vendor by 5%.
 */
export function selfAccountsVat(treatment: BillTaxTreatment): boolean {
  return treatment === 'imported_services_reverse_charge'
}

/**
 * The two sides of one reverse charge, as the caller derived them.
 *
 * Declared here, on the bill, and produced by `reverseChargeOn` in `../tax/reverse-charge.ts`: the shape
 * belongs to the document and the arithmetic belongs to the tax module, and stating the type here is what
 * keeps the import running one way.
 *
 * `inputVat` is the whole of `outputVat` or nothing. Recovery is a property of the account, so a line is
 * coded either to a category that allows it or to one that does not; a partial claim would be an
 * apportionment nothing in this system computes.
 */
export interface ReverseChargePair {
  /** Declared: the VAT the business accounts for as though it had charged itself. */
  readonly outputVat: Money
  /** Reclaimed: equal to `outputVat` on a recoverable category, and zero on a blocked one. */
  readonly inputVat: Money
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
  /**
   * The reverse charge this line self-accounts, from `reverseChargeOn` in `../tax/reverse-charge.ts`.
   *
   * Required for `imported_services_reverse_charge` and refused for every other treatment. Required
   * rather than defaulted, because the input side depends on the account's recovery classification and a
   * default would have to guess it — and the guess that claims the tax back is the over-claim.
   */
  readonly reverseCharge?: ReverseChargePair
}

export interface DerivedBillLine {
  readonly description: string
  readonly account: AccountCode
  readonly treatment: BillTaxTreatment
  readonly rateBp: VatRateBp
  readonly gross: Money
  readonly net: Money
  /** `gross - net`. Zero for every treatment but the two that carry VAT. */
  readonly vat: Money
  /** The input tax this line supports a claim for. Zero unless the line is recoverable. */
  readonly recoverableInputVat: Money
  /**
   * The VAT charged on this line that may not be reclaimed. Zero unless the line is blocked.
   *
   * Its own field rather than "the VAT that is not the claim", because the difference between a blocked
   * line and a line that was never charged VAT is the whole content of the non-recoverable disclosure:
   * one is tax the business bore and the other is tax that never existed.
   */
  readonly blockedInputVat: Money
  /** The VAT this imported service declares. Zero for every other treatment. */
  readonly reverseChargeOutputVat: Money
  /** The same VAT reclaimed. Zero on a blocked or out-of-scope category, where the tax is a real cost. */
  readonly reverseChargeInputVat: Money
  /**
   * `reverseChargeOutputVat - reverseChargeInputVat`: the reverse-charge tax the business bore.
   *
   * Zero wherever the input is recoverable, which is why the obligation is the one most commonly missed —
   * nothing is owed, so nothing prompts anybody. Non-zero is the case that costs money, and it is derived
   * from the pair rather than stored, because a third figure is a third thing that can disagree with the
   * two it is made of.
   */
  readonly reverseChargeBorneVat: Money
  /**
   * What the expense account is debited: the net, plus any blocked VAT, plus any reverse-charge VAT the
   * business bore.
   *
   * Carried rather than recomputed by each caller, because "the expense is the net" is true for every
   * treatment but two, and the caller that forgets an exception posts an entry that does not balance —
   * or, worse, balances by dropping tax that cannot be reclaimed into the claim.
   */
  readonly expenseDebit: Money
}

export interface DerivedBill {
  readonly lines: readonly DerivedBillLine[]
  readonly net: Money
  readonly vat: Money
  readonly gross: Money
  readonly recoverableInputVat: Money
  /** The period's non-recoverable disclosure figure, summed from the lines. */
  readonly blockedInputVat: Money
  /** The reverse-charge VAT this bill declares: the output side, summed from the lines. */
  readonly reverseChargeOutputVat: Money
  /** The reverse-charge VAT it reclaims: the input side. Below the output by the tax it bore. */
  readonly reverseChargeInputVat: Money
  /** `output - input`. Zero where every reverse-charge line is recoverable, which is the usual case. */
  readonly reverseChargeBorneVat: Money
}

/**
 * The imported-services branch of {@link deriveBillLine}, extracted so neither is hard to read.
 *
 * Its own function because it is a different derivation, not a special case of the same one: there is no
 * gross to split, the rate survives, and the two figures come from the caller rather than from arithmetic
 * here.
 */
function deriveImportedServiceLine(draft: BillLineDraft): DerivedBillLine {
  // The consideration IS the gross: the supplier charged nothing, so nothing is carved out of it and the
  // payable to them is the whole amount. The rate survives, unlike every other non-VAT-bearing
  // treatment, because it is what the self-assessed figure was computed at and a filed line keeps it.
  const rateBp = draft.rateBp ?? UAE_STANDARD_VAT_BP
  if (rateBp === 0) {
    throw new AppError(
      'validation',
      `Bill line "${draft.description}" is an imported service at 0 bp, which would account for no ` +
        'VAT at all. A supply outside the scope of UAE VAT is out_of_scope, not a nil reverse charge.',
    )
  }
  const pair = draft.reverseCharge
  if (pair === undefined) {
    throw new AppError(
      'validation',
      `Bill line "${draft.description}" is an imported service and states no reverse charge. Derive ` +
        'the pair with reverseChargeOn(): the output side is declared whatever the category, and the ' +
        'input side is claimable only where the account allows recovery.',
    )
  }
  if (pair.outputVat.fils <= 0) {
    throw new AppError(
      'validation',
      `Bill line "${draft.description}" declares ${pair.outputVat.fils} fils of reverse-charge VAT. ` +
        'An imported service that declares nothing is the missing pair this treatment exists to make ' +
        'impossible.',
    )
  }
  if (pair.inputVat.fils !== 0 && pair.inputVat.fils !== pair.outputVat.fils) {
    throw new AppError(
      'validation',
      `Bill line "${draft.description}" declares ${pair.outputVat.fils} fils of reverse-charge VAT ` +
        `and reclaims ${pair.inputVat.fils}. Recovery is a property of the account, so the input side ` +
        'is the whole of the output or none of it; anything between is an apportionment nothing here ' +
        'computes.',
    )
  }
  const borne = subtract(pair.outputVat, pair.inputVat)
  return {
    description: draft.description,
    account: draft.account,
    treatment: draft.treatment,
    rateBp,
    gross: draft.gross,
    net: draft.gross,
    vat: ZERO_AED,
    // Not `recoverableInputVat`: that claim rests on a supplier's tax invoice, and the document behind
    // this one is our own self-assessment. Keeping them apart is what lets the no-TRN rule go on
    // applying unchanged to the claim it was written for.
    recoverableInputVat: ZERO_AED,
    // Nor `blockedInputVat`, which is tax a supplier charged and we may not reclaim. Here nobody
    // charged us: the borne figure is the difference between the two sides of our own pair.
    blockedInputVat: ZERO_AED,
    reverseChargeOutputVat: pair.outputVat,
    reverseChargeInputVat: pair.inputVat,
    reverseChargeBorneVat: borne,
    expenseDebit: add(draft.gross, borne),
  }
}

/**
 * Splits one line's gross into net, VAT, the recoverable claim and the blocked remainder.
 *
 * Only a VAT-bearing line has VAT to split. For every other treatment `net === gross`: an unregistered
 * supplier cannot charge VAT at all, and a zero-rated, exempt or out-of-scope supply has none — so there
 * is nothing to carve out, and carving something out anyway would claim tax nobody charged.
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

  if (selfAccountsVat(draft.treatment)) return deriveImportedServiceLine(draft)

  if (!carriesVat(draft.treatment)) {
    if (draft.rateBp !== undefined && draft.rateBp !== 0) {
      throw new AppError(
        'validation',
        `Bill line "${draft.description}" is ${draft.treatment} but carries a rate of ` +
          `${draft.rateBp} bp. A line that cannot carry VAT carries none.`,
      )
    }
    if (draft.reverseCharge !== undefined) {
      throw new AppError(
        'validation',
        `Bill line "${draft.description}" is ${draft.treatment} and states a reverse charge. Only an ` +
          'imported service self-accounts VAT: on a domestic supply it would declare tax the supplier ' +
          'already charged and then claim it twice.',
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
      blockedInputVat: ZERO_AED,
      reverseChargeOutputVat: ZERO_AED,
      reverseChargeInputVat: ZERO_AED,
      reverseChargeBorneVat: ZERO_AED,
      expenseDebit: draft.gross,
    }
  }
  if (draft.reverseCharge !== undefined) {
    throw new AppError(
      'validation',
      `Bill line "${draft.description}" is ${draft.treatment} and states a reverse charge. A supplier ` +
        'who charged UAE VAT is registered here, so there is nothing to self-account.',
    )
  }

  const rateBp = draft.rateBp ?? UAE_STANDARD_VAT_BP
  if (rateBp === 0) {
    throw new AppError(
      'validation',
      `Bill line "${draft.description}" is ${draft.treatment} at 0 bp. A line under that treatment is ` +
        'one the supplier charged VAT on; at zero rate the treatment is zero_rated.',
    )
  }
  const breakdown = splitGross(draft.gross, rateBp)
  const blocked = isBlocked(draft.treatment)
  return {
    description: draft.description,
    account: draft.account,
    treatment: draft.treatment,
    rateBp,
    gross: breakdown.gross,
    net: breakdown.net,
    vat: breakdown.vat,
    // The claim is the line's VAT, or nothing. Stated as its own field rather than read off `vat` at
    // report time, because the blocked treatment is exactly the case where the two differ — the VAT was
    // charged and may not be reclaimed — and a report that read `vat` would silently claim it.
    recoverableInputVat: blocked ? ZERO_AED : breakdown.vat,
    blockedInputVat: blocked ? breakdown.vat : ZERO_AED,
    reverseChargeOutputVat: ZERO_AED,
    reverseChargeInputVat: ZERO_AED,
    reverseChargeBorneVat: ZERO_AED,
    // A blocked line's tax is part of the cost, so the expense carries the whole gross.
    expenseDebit: blocked ? breakdown.gross : breakdown.net,
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
    blockedInputVat: sum(lines.map((line) => line.blockedInputVat)),
    // Summed from the lines, both sides separately. Summing only the net effect would hide exactly the
    // case that costs money: one blocked reverse-charge line inside a bill of recoverable ones nets to a
    // figure that looks like the blocked line is not there.
    reverseChargeOutputVat: sum(lines.map((line) => line.reverseChargeOutputVat)),
    reverseChargeInputVat: sum(lines.map((line) => line.reverseChargeInputVat)),
    reverseChargeBorneVat: sum(lines.map((line) => line.reverseChargeBorneVat)),
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
 * The journal entry a bill posts: **Dr expense (net, plus any blocked VAT, plus any reverse-charge VAT
 * borne) per line, Dr recoverable input VAT, Dr recoverable input VAT again for the reverse-charge claim,
 * Cr reverse-charge VAT payable, Cr trade payables (gross)**.
 *
 * One credit to the payable, not one per line: the payable is what is owed to the supplier for this
 * invoice, and a per-line credit would make the payables ledger a list of line items nobody can pay
 * against. One VAT debit per kind for the same reason — the claim is a period figure, and per-line debits
 * would make the VAT201 a thousand rows that have to be summed anyway.
 *
 * ## The reverse charge is two lines, and they are not netted
 *
 * The credit to `2035 Reverse-charge VAT payable` is the output side and the debit to `1080` is the input
 * side, and they are posted separately even though they are equal on a recoverable category. Netting them
 * to nothing would leave the output box empty and the input box short by the same amount: a return that is
 * wrong twice and a ledger that balances. Where the category is blocked, the input side is absent
 * altogether and the output stands against the expense — which is the one case a reverse charge costs
 * money, and the reason the pair is never collapsed into a single figure.
 *
 * The reverse-charge claim is its own line rather than added to the ordinary one. The two cannot co-occur
 * in practice — an offshore supplier holds no UAE TRN, so no line on its bill can be `standard_recoverable`
 * — and keeping them apart is what lets the drill-down from the input box say which document supports
 * which claim: a supplier's tax invoice, or our own self-assessment.
 *
 * The result is a draft, not a `JournalEntry`: pass it through `postEntry(draft, chart)` to get the
 * balance check and the chart validation. `postBill` in `@berelax/db` writes the same shape, because
 * `packages/db` may not import this package; `packages/fixtures/src/purchases.itest.ts` posts a bill
 * through the service and compares the stored lines against this function, which is what stops the
 * two from drifting.
 */
export function billEntryDraft(input: BillEntryInput): EntryDraft {
  const lines: EntryLineDraft[] = input.bill.lines.map((line) =>
    // `expenseDebit`, not `net`: a blocked line's VAT is cost and belongs in the expense. Reading `net`
    // here would leave the entry short by the blocked tax, and the deferred balance trigger would refuse
    // the whole bill at COMMIT with an arithmetic message that named no category.
    debit(line.account, line.expenseDebit, line.description),
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
  if (input.bill.reverseChargeInputVat.fils > 0) {
    lines.push(
      debit(
        ACCOUNTS.recoverableInputVat,
        input.bill.reverseChargeInputVat,
        'Reverse-charge input VAT on imported services',
      ),
    )
  }
  if (input.bill.reverseChargeOutputVat.fils > 0) {
    lines.push(
      credit(
        ACCOUNTS.reverseChargeVatPayable,
        input.bill.reverseChargeOutputVat,
        'Reverse-charge output VAT on imported services',
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
 * Equal to the credit side by construction for every mix of treatments: a line with no VAT has
 * `net === gross`, a recoverable line contributes its net plus its claim, a blocked line contributes its
 * net plus its blocked tax — which is its gross — and an imported service contributes its net, the tax it
 * bore and the tax it reclaimed, which together are its net plus the whole output side. The credit side is
 * `gross + reverseChargeOutputVat`, so the two agree. Exported because "it balances" is the property every
 * later gate asserts, and a test that re-adds the lines itself would be asserting its own arithmetic.
 */
export function billDebitTotal(bill: DerivedBill): Money {
  return add(
    add(add(bill.net, bill.recoverableInputVat), bill.blockedInputVat),
    bill.reverseChargeOutputVat,
  )
}

/**
 * The credit side: the payable plus the reverse-charge VAT declared.
 *
 * Stated because a reverse charge is the first thing a bill credits that is not owed to the supplier, and a
 * caller comparing {@link billDebitTotal} against the gross alone would find every offshore bill out of
 * balance by exactly the tax it declared.
 */
export function billCreditTotal(bill: DerivedBill): Money {
  return add(bill.gross, bill.reverseChargeOutputVat)
}

/** The account a recoverable claim is debited to. Exported so a caller need not spell '1080'. */
export const RECOVERABLE_INPUT_VAT_ACCOUNT: AccountCode = ACCOUNTS.recoverableInputVat
/** The account a bill credits. Exported for the same reason. */
export const TRADE_PAYABLES_ACCOUNT: AccountCode = ACCOUNTS.tradePayables
