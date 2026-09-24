import { AppError } from '@berelax/shared'
import type { Account, AccountCode } from '../ledger/account.ts'
import type { ChartOfAccounts } from '../ledger/chart-of-accounts.ts'
import { ACCOUNTS, accountFor } from '../ledger/chart-of-accounts.ts'
import type { EntryDraft, EntryId, EntryLineDraft, JournalEntry } from '../ledger/entry.ts'
import { credit, debit, postEntry } from '../ledger/entry.ts'
import type { Fils, Money } from '../money.ts'
import { add, filsFrom, money, sum } from '../money.ts'
import type { LocalDate } from '../time.ts'
import type { Basket, ChargeableAmount } from './basket.ts'
import { isRedemptionLine, isServiceLine } from './basket.ts'
import { isTipLine } from './tip.ts'

/**
 * The posting rule for a checkout: the one balanced journal entry a finalised basket produces.
 *
 * Pure, like everything else under `packages/core/src/checkout` — no clock, no I/O, and
 * `scripts/check-core-purity.mjs` forbids `Date` and `Intl` in this directory outright. `entryDate` is
 * the **business day** the caller already resolved with `resolveTradingDate`; trading runs 11:00-02:00,
 * so a 01:30 sale belongs to the previous trading date and a date re-derived here would be a second
 * opinion about it.
 *
 * It lives in `packages/core` and not beside the service that writes it because `packages/db` may never
 * import `packages/core` and because a posting rule is arithmetic: which accounts move, in which
 * direction, by how much. `packages/db/src/services/checkout-finalise.ts` maps the result field for
 * field onto `JournalEntryInput` and writes it.
 *
 * ## Nothing here re-derives a figure the basket already holds
 *
 * Every amount below is read off `Basket` — `line.tax.net`, `line.tax.vat`, `charge.gross`. Not one of
 * them is a `splitGross` of anything. The basket derived them once, from the price snapshotted on the
 * appointment (M-TILL-05), and a second derivation at posting time would be a second reading of the
 * same question — which is how a journal comes to disagree with the invoice printed from the same
 * basket. `packages/fixtures/src/checkout-snapshot.itest.ts` already fails a basket that re-derives.
 *
 * ## The four movements, and the one that is not a sale
 *
 * For a basket of services, discounts and tips paid for with one or more tenders:
 *
 * ```
 *   Dr  1010 / 1040 / 1020   each tender, at what was handed over
 *     Cr  4010              the service lines' NET, at the price they were sold at
 *     Cr  2030              the output VAT actually charged
 *     Cr  2040              the tips, which the salon owes on and never earned
 *   Dr  4095                 the discounts' net, as contra revenue
 *   Dr  2030                 the VAT the discounts took off
 * ```
 *
 * Debits equal credits **by construction** rather than by a check: `net + vat === gross` holds on every
 * basket line including a discount's negative figures (ADR 0007, and `applyDiscounts` derives the
 * discount's tax as a difference of two splits precisely so that it does), the tenders are required to
 * equal `basket.totals.grossTotal`, and `grossTotal` is the sum of the lines. So the debit side is the
 * sum of the line grosses and the credit side is the sum of their net-plus-VAT, which is the same
 * number. `postEntry` still checks it, the deferred trigger in `0018_ledger.sql` checks it again at
 * COMMIT, and neither is redundant: this module is not the only thing that can reach the journal.
 *
 * The discount posts to **4095 Discounts and allowances** and not as a reduction of 4010, which is the
 * decision `REQUIRED_ACCOUNT` in `basket.ts` states from the other end: netting a discount off
 * treatment revenue erases the only evidence that a discount was given.
 *
 * A **package redemption** line moves nothing here. Its gross is zero and its tax is `null`, so it
 * contributes to no total; releasing `2050 Deferred revenue` into `4020` is M-TILL-09's, on the balance
 * the redemption consumed, because the entitlement's worth is what the package was SOLD for and not a
 * figure on this document. A basket with nothing but redemptions therefore has nothing for this rule to
 * post, and {@link NothingToPost} says so rather than writing a zero-value invoice.
 *
 * ## One line per account, and why the lines are merged rather than listed
 *
 * Two service lines on one revenue account become one credit. The per-line detail is on the invoice,
 * which is the document a customer disputes and an auditor reads; the journal's job is the account
 * movement, and an entry with forty lines for a forty-line basket is forty rows nobody reconciles. The
 * merge is per **account**, and a merged account whose debits and credits cancel exactly is omitted:
 * `journal_line_exactly_one_side` refuses a zero line, and a zero line is a posting that did not
 * happen.
 *
 * Lines come out sorted by account code, for the reason `trialBalance` sorts: two runs over the same
 * basket produce byte-identical working papers, and an insertion-ordered entry diffs everywhere the
 * moment a basket's line order changes.
 */

/**
 * How the money arrived. Three ways today, each with the account it lands in.
 *
 * The full registry — every tender type with a declared posting account, over-tender change, and the
 * adapter interface a card gateway will implement — is M-TILL-07's. What is here is the minimum a
 * finalisation cannot do without: a checkout has to debit *something*, and the something has to be
 * chosen by rule rather than by whoever is at the till.
 */
export const TENDER_KINDS = ['cash', 'card_in_salon', 'bank_transfer'] as const
export type TenderKind = (typeof TENDER_KINDS)[number]

/**
 * Where each tender is debited.
 *
 * `card_in_salon` goes to **1040 Card terminal clearing** and not to the bank, because the money is not
 * in the bank yet: the terminal settles in a batch, net of fees, days later, and a checkout that
 * debited `1020` would make the bank reconciliation permanently out by every unsettled batch and by
 * every processing fee. `bank_transfer` does debit `1020`, because a transfer that has landed is in the
 * account.
 */
export const TENDER_ACCOUNT: Readonly<Record<TenderKind, AccountCode>> = Object.freeze({
  cash: ACCOUNTS.cashInDrawer,
  card_in_salon: ACCOUNTS.cardTerminalClearing,
  bank_transfer: ACCOUNTS.bankCurrent,
})

/** Where the output VAT on a checkout is credited. */
export const OUTPUT_VAT_ACCOUNT: AccountCode = ACCOUNTS.outputVatPayable

/** One tender, as the till records it. */
export interface TenderLine {
  readonly kind: TenderKind
  /** Positive. What the customer actually handed over in this form. */
  readonly amount: Money
  /**
   * The terminal's approval code, the transfer reference, or absent for cash.
   *
   * Carried because it is the field a disputed card payment is settled with, and absent rather than
   * blank for cash: there is no reference, and an empty string reads as one that was not captured.
   */
  readonly reference?: string
}

/** Raised when a tender is not a payment: zero, negative, or of an unknown kind. */
export class MalformedTender extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('validation', `MalformedTender: ${message}`, { details })
    this.name = 'MalformedTender'
  }
}

/**
 * Raised when the tenders do not add up to the basket.
 *
 * Both directions are refused, and neither is a rounding problem. Under-tendering is a partial payment
 * — which leaves a receivable, and is M-TILL-07's — and over-tendering is change, which has to be
 * recorded as change rather than netted into the payment (also M-TILL-07's). A finalisation that
 * accepted either would post a journal entry that balances against the wrong cash.
 */
export class TendersDoNotCoverBasket extends AppError {
  readonly basketFils: number
  readonly tenderedFils: number
  constructor(basketId: string, basketFils: number, tenderedFils: number) {
    super(
      'validation',
      `TendersDoNotCoverBasket: basket "${basketId}" comes to ${basketFils} fils and the tenders ` +
        `come to ${tenderedFils} fils, a difference of ${tenderedFils - basketFils}. A partial ` +
        "payment leaves a receivable and an over-tender gives change; both are M-TILL-07's, and " +
        'neither may be absorbed into a posting that then balances against the wrong cash.',
      { details: { basketId, basketFils, tenderedFils } },
    )
    this.name = 'TendersDoNotCoverBasket'
    this.basketFils = basketFils
    this.tenderedFils = tenderedFils
  }
}

/**
 * Raised when a basket has nothing this rule can post or invoice.
 *
 * The reachable case is a checkout made entirely of package redemptions: every line is worth zero here
 * because the customer paid when the package was sold, so there is no gross to tender, no supply to
 * invoice and no entry to balance. The movement that *should* happen — `2050` released into `4020` at
 * the value on the balance — is M-TILL-09's, and inventing a figure for it here would be a second
 * opinion about what the package was sold for.
 */
export class NothingToPost extends AppError {
  constructor(basketId: string, why: string) {
    super('validation', `NothingToPost: basket "${basketId}" ${why}`, {
      details: { basketId, why },
    })
    this.name = 'NothingToPost'
  }
}

export interface CheckoutPostingInput {
  /** Allocated by the caller. Core never invents an id. */
  readonly entryId: EntryId
  /** The business day, already resolved on `business_day`. Never a calendar date. */
  readonly entryDate: LocalDate
  readonly basket: Basket
  readonly tenders: readonly TenderLine[]
  /** Overrides the default, which names the basket and counts its lines and tenders. */
  readonly narrative?: string
}

/** One tender, with the account it posts to resolved. What the caller records per payment row. */
export interface PostedTender extends TenderLine {
  readonly account: AccountCode
}

export interface CheckoutPosting {
  /** Balanced, frozen, and the only thing that reaches `journal_entry`. */
  readonly entry: JournalEntry
  /**
   * One per chargeable line, at the gross actually charged. Copied from `basket.charges`.
   *
   * The invoice is built from exactly these: `invoice_line.unit_gross_fils` is a `fils_nonneg` domain,
   * so the discount cannot be an invoice line at all and reaches the document as a reduced line price.
   */
  readonly charges: readonly ChargeableAmount[]
  /** `netTotal + vatTotal`: the taxable part of the basket, and the document's gross. */
  readonly invoiceGross: Money
  readonly invoiceNet: Money
  readonly invoiceVat: Money
  /** Collected, owed on, and on no tax invoice: a gratuity is not consideration for a supply. */
  readonly tipTotal: Money
  /** What was handed over. `invoiceGross + tipTotal`, and equal to `basket.totals.grossTotal`. */
  readonly tenderTotal: Money
  readonly tenders: readonly PostedTender[]
}

/** Debits and credits accumulated against one account before they become a single line. */
interface AccountMovement {
  debit: number
  credit: number
  /** What the movement is, for the line memo. Deduplicated, in first-seen order. */
  readonly reasons: string[]
}

function movementFor(
  movements: Map<string, AccountMovement>,
  account: AccountCode,
): AccountMovement {
  const existing = movements.get(account as string)
  if (existing !== undefined) return existing
  const fresh: AccountMovement = { debit: 0, credit: 0, reasons: [] }
  movements.set(account as string, fresh)
  return fresh
}

/**
 * Records `fils` against `account`, on the credit side when positive and the debit side when negative.
 *
 * The sign convention is confined to this function on purpose. A discount's net and VAT are negative
 * `Money` by construction (`applyDiscounts` builds them as differences), and the alternative — a
 * caller negating them and choosing a side — is the shape in which a negative credit and a positive
 * debit both balance while only one of them is what the poster meant.
 */
function record(
  movements: Map<string, AccountMovement>,
  account: AccountCode,
  fils: number,
  reason: string,
): void {
  if (fils === 0) return
  const movement = movementFor(movements, account)
  if (fils > 0) movement.credit += fils
  else movement.debit += -fils
  if (!movement.reasons.includes(reason)) movement.reasons.push(reason)
}

function requireTenders(basket: Basket, tenders: readonly TenderLine[]): readonly PostedTender[] {
  const posted: PostedTender[] = []
  for (const [index, tender] of tenders.entries()) {
    const account = TENDER_ACCOUNT[tender.kind]
    if (account === undefined) {
      // Reachable only through a cast past `TenderKind`, which is what a request body arriving from
      // the till has been through. A tender with no account would silently post nowhere.
      throw new MalformedTender(`tender ${index + 1} is of unknown kind "${String(tender.kind)}"`, {
        index: index + 1,
        kind: tender.kind,
      })
    }
    if (!Number.isInteger(tender.amount.fils) || tender.amount.fils <= 0) {
      // Zero is a tender somebody started and did not fill in; negative is a refund, which is a
      // different transaction with a different document (M-TILL-08) and a different posting.
      throw new MalformedTender(
        `tender ${index + 1} (${tender.kind}) carries ${tender.amount.fils} fils`,
        { index: index + 1, kind: tender.kind, fils: tender.amount.fils },
      )
    }
    posted.push(Object.freeze({ ...tender, account }))
  }

  const tendered = sum(posted.map((tender) => tender.amount))
  if (tendered.fils !== basket.totals.grossTotal.fils) {
    throw new TendersDoNotCoverBasket(
      basket.basketId as string,
      basket.totals.grossTotal.fils,
      tendered.fils,
    )
  }
  return Object.freeze(posted)
}

/**
 * Turns a basket and its tenders into the one balanced entry the checkout posts.
 *
 * Throws rather than returning a result union, for the reason `postEntry` and `buildBasket` do: the
 * caller's only useful response to any of these refusals is to abandon the checkout, and an ignored
 * result union posts whatever the variable was initialised to.
 *
 * The chart is an argument with no default, so the accounts the entry is validated against are the ones
 * the caller is posting to rather than a copy this module happened to import.
 */
export function checkoutPosting(
  input: CheckoutPostingInput,
  chart: ChartOfAccounts,
): CheckoutPosting {
  const { basket } = input
  const basketId = basket.basketId as string

  if (basket.charges.length === 0) {
    throw new NothingToPost(
      basketId,
      'has no chargeable line. A checkout made entirely of package redemptions releases deferred ' +
        'revenue against the balance it consumed (M-TILL-09) and issues no document here.',
    )
  }

  const tenders = requireTenders(basket, input.tenders)

  const movements = new Map<string, AccountMovement>()
  let serviceLines = 0
  let discountLines = 0
  let tipLines = 0
  let redemptionLines = 0

  for (const tender of tenders) {
    // Negative, so `record` puts it on the DEBIT side: cash in the drawer is an asset increasing.
    record(movements, tender.account, -tender.amount.fils, `Tendered (${tender.kind})`)
  }

  for (const line of basket.lines) {
    if (isRedemptionLine(line)) {
      // Worth nothing on this document by construction — gross 0, tax null. Counted for the narrative
      // and deliberately posted nowhere; see the module note.
      redemptionLines += 1
      continue
    }
    if (isTipLine(line)) {
      tipLines += 1
      record(movements, line.account, line.gross.fils, 'Gratuities collected')
      continue
    }
    if (isServiceLine(line)) {
      serviceLines += 1
      record(movements, line.account, line.tax.net.fils, 'Treatments delivered')
      record(movements, OUTPUT_VAT_ACCOUNT, line.tax.vat.fils, 'Output VAT on supplies')
      continue
    }
    // A priced discount: negative net and negative VAT, so both land on the debit side — the net
    // against contra revenue and the VAT against output VAT, which is what makes the credited VAT the
    // tax on what was actually charged rather than on what was asked for.
    discountLines += 1
    record(movements, line.account, line.tax.net.fils, 'Discounts and allowances')
    record(movements, OUTPUT_VAT_ACCOUNT, line.tax.vat.fils, 'VAT relieved by discounts')
  }

  const lines: EntryLineDraft[] = []
  // Sorted by account code so two runs over one basket produce byte-identical working papers.
  for (const [code, movement] of [...movements.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const account: Account = accountFor(chart, code as AccountCode)
    const net = movement.credit - movement.debit
    // Exactly cancelled. Omitted rather than posted as zero: `journal_line_exactly_one_side` refuses a
    // zero line, and an account that moved nothing did not take part in this sale. The reachable case
    // is a discount that relieves precisely the VAT the supply carried.
    if (net === 0) continue
    const memo = movement.reasons.join('; ')
    const amount = money(filsFrom(Math.abs(net)), basket.totals.grossTotal.currency)
    lines.push(net > 0 ? credit(account.code, amount, memo) : debit(account.code, amount, memo))
  }

  const narrative =
    input.narrative ??
    `Checkout ${basketId}: ${serviceLines} treatment(s), ${discountLines} discount(s), ` +
      `${tipLines} gratuity line(s), ${redemptionLines} redemption(s), ${tenders.length} tender(s)`

  const draft: EntryDraft = {
    entryId: input.entryId,
    entryDate: input.entryDate,
    narrative,
    source: 'sale',
    lines,
  }

  return Object.freeze({
    entry: postEntry(draft, chart),
    charges: basket.charges,
    // Read off the basket's own totals, never re-summed from the charges: two additions of one set of
    // numbers is one addition plus a future disagreement.
    invoiceGross: basket.totals.taxableGross,
    invoiceNet: basket.totals.netTotal,
    invoiceVat: basket.totals.vatTotal,
    tipTotal: basket.totals.tipTotal,
    tenderTotal: basket.totals.grossTotal,
    tenders,
  })
}

/**
 * The three identities an auditor checks, as values, over one posting.
 *
 * Returned rather than asserted, so both a test and a runtime guard read the same arithmetic instead of
 * two spellings of it. Every field is a difference that must be **zero**; naming them individually is
 * what makes a failure say which of the three broke.
 */
export interface PostingReconciliation {
  /** `sum(debit) - sum(credit)` over the entry. */
  readonly imbalanceFils: number
  /** The entry's net credit to revenue accounts, less the invoice's net. Contra counts against. */
  readonly revenueVersusInvoiceNetFils: number
  /** The entry's net credit to output VAT, less the invoice's VAT. */
  readonly vatVersusInvoiceVatFils: number
  /** The tenders' total, less the invoice's gross plus the tips. */
  readonly tenderVersusInvoiceAndTipsFils: number
}

export function reconcilePosting(
  posting: CheckoutPosting,
  chart: ChartOfAccounts,
): PostingReconciliation {
  let debits = 0
  let credits = 0
  let revenueCredit = 0
  let vatCredit = 0
  for (const line of posting.entry.lines) {
    debits += line.debitFils
    credits += line.creditFils
    const account = accountFor(chart, line.account)
    // Signed as a credit, because revenue and output VAT are credit-normal: a debit to 4095 reduces
    // revenue and a debit to 2030 reduces the tax due, which is exactly what a discount does to both.
    const signed = line.creditFils - line.debitFils
    if (account.type === 'revenue') revenueCredit += signed
    if (account.code === OUTPUT_VAT_ACCOUNT) vatCredit += signed
  }
  const tendered: Fils = filsFrom(
    posting.tenders.reduce((total, tender) => total + tender.amount.fils, 0),
  )
  return {
    imbalanceFils: debits - credits,
    revenueVersusInvoiceNetFils: revenueCredit - posting.invoiceNet.fils,
    vatVersusInvoiceVatFils: vatCredit - posting.invoiceVat.fils,
    tenderVersusInvoiceAndTipsFils: tendered - add(posting.invoiceGross, posting.tipTotal).fils,
  }
}
