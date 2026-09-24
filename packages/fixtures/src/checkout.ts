import type {
  Basket,
  CheckoutPosting,
  EntryId,
  Instant,
  IssuerSnapshot,
  LocalDate,
  TenderLine,
} from '@berelax/core'
import {
  checkoutPosting,
  deriveDocumentTax,
  deriveTaxLine,
  issuerAddressSnapshot,
  localDate,
  requireIssuerSnapshot,
  resolveTaxPoint,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import type {
  CheckoutAppointmentInput,
  CheckoutTenderInput,
  FinaliseCheckoutInput,
  InvoiceLineInput,
  IssueInvoiceInput,
  JournalEntryInput,
  JournalLineInput,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import { FIXTURE_HOURS, FIXTURE_ISSUER } from './invoice.ts'
import { customerLabel } from './synthetic.ts'

/**
 * The mapping between `@berelax/core`'s checkout and `@berelax/db`'s finalisation.
 *
 * `packages/db` may never import `packages/core` — the dependency runs the other way — so something has
 * to turn a `Basket` and a `CheckoutPosting` into the three structural mirrors `finaliseCheckout` takes.
 * `packages/fixtures` is the package allowed to depend on both, which is what `invoice.ts` in this
 * directory already says of `invoiceFixture`: "the right home for that mapping until M-TILL-06 has a
 * service layer to own it". M-TILL-06's service layer is in `packages/db`, so it cannot be that home;
 * this is, and the till route will call it.
 *
 * ## Field for field, and not one figure re-derived
 *
 * Every amount below is copied out of the basket or the posting. The document's per-line net and VAT
 * come from `deriveTaxLine` on the **charged** gross — which is the one derivation that has to happen
 * here, because a tax invoice states the tax on what was actually charged and the basket's
 * `ChargeableAmount` is exactly that gross — and the header's totals are `deriveDocumentTax`'s SUMS of
 * those lines, never a `splitGross` of the document total. The journal lines are `posting.entry.lines`
 * with `Money` flattened to integer fils and the branded `EntryId` to a string.
 *
 * {@link assertMappingReconciles} then checks the two halves against each other before anything is
 * written. It is not a re-derivation: it is the one disagreement no constraint can see, because the
 * document's totals and the entry's movements live in different tables and the deferred triggers each
 * check only their own.
 */

/** A treatment on the basket, and the appointment row it came from. */
export interface CheckoutLineOrigin {
  /** The basket line id, as it appears in `basket.charges`. */
  readonly lineId: string
  readonly appointmentId: string
}

export interface CheckoutMappingInput {
  readonly basket: Basket
  readonly tenders: readonly TenderLine[]
  /** Allocated by the caller. Core never invents an id, and neither does this. */
  readonly entryId: EntryId
  /** The till's request id. The same value on a retry — that is the whole contract. */
  readonly idempotencyKey: string
  /** A stable digest of what is being billed. Compared on a replay, never interpreted. */
  readonly requestFingerprint: string
  /** When the treatments were delivered. Its TRADING date becomes the tax point. */
  readonly supplyAt: Instant
  /** When the document is written. Later than the supply for a checkout closed after midnight. */
  readonly issuedAt: Instant
  /** Which appointment each chargeable line bills, plus any redemption lines' appointments. */
  readonly origins: readonly CheckoutLineOrigin[]
  readonly issuer?: IssuerSnapshot
  /** `Customer 0042` by default. A record label, never an invented name (ADR 0020). */
  readonly customerIndex?: number
  readonly customerId?: string
  readonly hoursFor?: typeof FIXTURE_HOURS
  readonly narrative?: string
}

export interface CheckoutMapping {
  /** What core decided: the balanced entry, the charges, and the three totals. */
  readonly posting: CheckoutPosting
  /** Ready for `finaliseCheckout`. */
  readonly input: FinaliseCheckoutInput
  /** The business day the entry and the tenders are dated on. */
  readonly tradingDate: LocalDate
}

/**
 * Maps a priced basket and its tenders onto `finaliseCheckout`'s input.
 *
 * The tax point comes from the **supply's** trading date and not from the issue date, which is
 * `resolveTaxPoint`'s whole job: a treatment delivered at 01:30 belongs to the previous trading date,
 * and a checkout closed the next morning keeps the supply's tax point.
 */
export function checkoutMapping(options: CheckoutMappingInput): CheckoutMapping {
  const issuer = requireIssuerSnapshot(options.issuer ?? FIXTURE_ISSUER)
  const hoursFor = options.hoursFor ?? FIXTURE_HOURS

  const taxPoint = resolveTaxPoint({
    supplyAt: options.supplyAt,
    issuedAt: options.issuedAt,
    hoursFor,
  })
  if (taxPoint.kind !== 'resolved') {
    // A mapping that silently picked a nearby date would produce a document with a tax point the
    // business did not trade on, which is the failure `resolveTaxPoint` exists to make visible.
    throw new AppError(
      'validation',
      `the supply instant belongs to no trading date (${taxPoint.reason} on ` +
        `${taxPoint.calendarDate}); the tax point cannot be resolved`,
    )
  }
  // The journal is dated on the trading day the MONEY was taken, which is the issue trading date when
  // there is one. A document raised while the premises was shut has none, and then the supply's own
  // trading date is the only honest answer — an entry dated on a day the till was not open would sit in
  // a cash-up nobody ran.
  const tradingDate = localDate(taxPoint.issueTradingDate ?? taxPoint.taxPointDate)

  const posting = checkoutPosting(
    {
      entryId: options.entryId,
      entryDate: tradingDate,
      basket: options.basket,
      tenders: options.tenders,
      ...(options.narrative === undefined ? {} : { narrative: options.narrative }),
    },
    STANDARD_SPA_CHART,
  )

  // Derived on the CHARGED gross, per line, and summed. `deriveDocumentTax` over these lines is what
  // produces the header's three totals; a `splitGross(documentGross)` here is the one-line change
  // M-TILL-04's deferred trigger raises ZI001 for.
  const derived = posting.charges.map((charge) => ({
    charge,
    tax: deriveTaxLine({
      quantity: charge.quantity,
      unitGross: charge.gross,
      rateBp: charge.rateBp,
    }),
  }))
  const documentTax = deriveDocumentTax(derived.map((line) => line.tax))

  const lines: readonly InvoiceLineInput[] = derived.map(({ charge, tax }) => ({
    descriptionEn: charge.description,
    quantity: charge.quantity,
    unitGrossFils: charge.gross.fils,
    vatRateBp: tax.rateBp,
    netFils: tax.net.fils,
    vatFils: tax.vat.fils,
  }))

  const invoice: IssueInvoiceInput = {
    documentKind: 'tax_invoice',
    seriesCode: 'TAX-INV',
    issuer: {
      legalName: issuer.legalName,
      tradingName: issuer.tradingName,
      trn: issuer.trn,
      addressSnapshot: issuerAddressSnapshot(issuer.addressLines),
      emirate: issuer.emirate,
      ...(issuer.phone === undefined ? {} : { phone: issuer.phone }),
      ...(issuer.licenceNumber === undefined ? {} : { licenceNumber: issuer.licenceNumber }),
    },
    customer: {
      nameSnapshot: customerLabel(options.customerIndex ?? 42),
      ...(options.customerId === undefined ? {} : { customerId: options.customerId }),
    },
    issueDate: taxPoint.issueDate,
    ...(taxPoint.issueTradingDate === null ? {} : { issueTradingDate: taxPoint.issueTradingDate }),
    taxPointDate: taxPoint.taxPointDate,
    lines,
    // The three figures core SUMMED from the lines above.
    netTotalFils: documentTax.net.fils,
    vatTotalFils: documentTax.vat.fils,
    grossTotalFils: documentTax.gross.fils,
    provisionalOpenQuestionId: 'Y11-vat-invoice',
    provisionalNote:
      'The mandatory tax-invoice field list is a superset of docs/04 §4 and the fields the F10 PDF ' +
      'renders, pending review by an FTA-registered tax agent.',
  }

  const journalLines: readonly JournalLineInput[] = posting.entry.lines.map((line) => ({
    accountCode: line.account as string,
    debitFils: line.debitFils,
    creditFils: line.creditFils,
    memo: line.memo,
  }))

  const journal: JournalEntryInput = {
    entryId: posting.entry.entryId as string,
    entryDate: posting.entry.entryDate as string,
    narrative: posting.entry.narrative,
    source: posting.entry.source,
    lines: journalLines,
  }

  const tenders: readonly CheckoutTenderInput[] = posting.tenders.map((tender) => ({
    tenderKind: tender.kind,
    postingAccountCode: tender.account as string,
    amountFils: tender.amount.fils,
    ...(tender.reference === undefined ? {} : { reference: tender.reference }),
  }))

  // One link per origin, carrying the invoice line number the charge became — or none, for an
  // appointment the document does not state as a line (a package redemption's gross is zero).
  const lineNoOf = new Map(
    posting.charges.map((charge, index) => [charge.lineId as string, index + 1]),
  )
  const appointments: readonly CheckoutAppointmentInput[] = options.origins.map((origin) => {
    const lineNo = lineNoOf.get(origin.lineId)
    return lineNo === undefined
      ? { appointmentId: origin.appointmentId }
      : { appointmentId: origin.appointmentId, lineNo }
  })

  const input: FinaliseCheckoutInput = {
    idempotencyKey: options.idempotencyKey,
    basketId: options.basket.basketId as string,
    requestFingerprint: options.requestFingerprint,
    tradingDate,
    invoice,
    journal,
    tenders,
    appointments,
    customerId: options.basket.customerId,
  }

  return { posting, input, tradingDate }
}

/**
 * The disagreements between the document and the entry that nothing else can see.
 *
 * Returned as differences that must all be **zero**, for `reconcilePosting`'s reason: a test and a
 * runtime guard then read the same arithmetic rather than two spellings of it, and naming each field
 * individually is what makes a failure say which half is wrong.
 *
 * `0026_invoice.sql` checks the header against its own lines at COMMIT and `0018_ledger.sql` checks the
 * entry's balance at COMMIT, and neither can check the document against the ENTRY — they are different
 * tables and each trigger sees only its own. That gap is what this closes.
 */
export interface CheckoutMappingReconciliation {
  /** The document's stated net, less the sum of its lines' net. */
  readonly documentNetVersusLinesFils: number
  readonly documentVatVersusLinesFils: number
  /** The document's gross, less the basket's taxable gross. */
  readonly documentGrossVersusBasketFils: number
  /** The entry's `sum(debit) - sum(credit)`. */
  readonly entryImbalanceFils: number
  /** The tenders recorded, less the total the entry debits to those same accounts. */
  readonly tendersVersusEntryFils: number
}

export function reconcileCheckoutMapping(mapping: CheckoutMapping): CheckoutMappingReconciliation {
  const { input, posting } = mapping
  const lineNet = input.invoice.lines.reduce((total, line) => total + line.netFils, 0)
  const lineVat = input.invoice.lines.reduce((total, line) => total + line.vatFils, 0)
  const debits = input.journal.lines.reduce((total, line) => total + line.debitFils, 0)
  const credits = input.journal.lines.reduce((total, line) => total + line.creditFils, 0)

  const tenderAccounts = new Set(input.tenders.map((tender) => tender.postingAccountCode))
  const tendered = input.tenders.reduce((total, tender) => total + tender.amountFils, 0)
  const postedToTenderAccounts = input.journal.lines.reduce(
    (total, line) =>
      tenderAccounts.has(line.accountCode) ? total + line.debitFils - line.creditFils : total,
    0,
  )

  return {
    documentNetVersusLinesFils: input.invoice.netTotalFils - lineNet,
    documentVatVersusLinesFils: input.invoice.vatTotalFils - lineVat,
    documentGrossVersusBasketFils: input.invoice.grossTotalFils - posting.invoiceGross.fils,
    entryImbalanceFils: debits - credits,
    tendersVersusEntryFils: tendered - postedToTenderAccounts,
  }
}

/** Throws unless every difference {@link reconcileCheckoutMapping} measures is zero. */
export function assertMappingReconciles(mapping: CheckoutMapping): CheckoutMapping {
  const reconciliation = reconcileCheckoutMapping(mapping)
  const broken = Object.entries(reconciliation).filter(([, difference]) => difference !== 0)
  if (broken.length > 0) {
    throw new AppError(
      'invariant_violated',
      `the checkout mapping does not reconcile: ${broken
        .map(([field, difference]) => `${field} is out by ${difference} fils`)
        .join(', ')}`,
      { details: { reconciliation } },
    )
  }
  return mapping
}
