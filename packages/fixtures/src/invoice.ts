/**
 * The committed invoice fixtures, and the mapping between `@berelax/core` and `@berelax/db`.
 *
 * Two jobs, in one file because they are the same job seen from either end.
 *
 * **The fixture.** {@link TWO_LINES_AT_ELEVEN_FILS} is the document M-TILL-04 exists for: two lines at
 * 11 fils gross each. Per line the VAT is 1 fils, so the document's VAT is **2**. Re-derive from the
 * 22-fils document total and the answer is **1**. Committed as data rather than written inline in one
 * test, because the same two lines have to be derived in `packages/core`, stored by `packages/db` and
 * read back — and three copies of a fixture is two chances for them to stop being the same fixture.
 *
 * **The mapping.** `packages/db` may not import `packages/core`, so something has to turn a
 * `DocumentTax` into an `IssueInvoiceInput` field by field. `packages/fixtures` is the package allowed
 * to depend on both, which makes it the right home for that mapping until M-TILL-06 has a service
 * layer to own it. {@link invoiceFixture} is that mapping, and it is deliberately the *only* place the
 * two shapes meet.
 */
import {
  type DocumentTax,
  deriveDocumentTax,
  deriveTaxLine,
  filsFrom,
  type HoursForDate,
  type Instant,
  type IssuerSnapshot,
  issuerAddressSnapshot,
  localTime,
  money,
  requireIssuerSnapshot,
  resolveTaxPoint,
  type TaxPointDates,
  type TradingHours,
  UAE_STANDARD_VAT_BP,
  type VatRateBp,
} from '@berelax/core'
import { type InvoiceLineInput, type IssueInvoiceInput, PREMISES_NAP } from '@berelax/db'
import { AppError } from '@berelax/shared'
import { customerLabel } from './synthetic.ts'

/** The real hours: 11:00 to 02:00, daily. A 01:30 supply belongs to the previous trading date. */
export const FIXTURE_TRADING_HOURS: TradingHours = {
  open: localTime('11:00'),
  close: localTime('02:00'),
}
export const FIXTURE_HOURS: HoursForDate = () => FIXTURE_TRADING_HOURS

/**
 * A fifteen-digit TRN for fixtures only.
 *
 * The real one is unknown (Y1-trn) and the seeded placeholder is refused by the schema, so a fixture
 * that needs to prove an invoice *can* be issued needs a value of the right shape. Unlike a phone
 * number there is no unallocated range to draw it from — a TRN is opaque — so this one is flagged here
 * and nowhere else: only `legal_entity.trn` reaches a real document, and until an owner sets it, it
 * holds the placeholder.
 */
export const FIXTURE_TRN = '100000000000003'

/**
 * The issuer as a document carries it, composed from the seeded `premises` values.
 *
 * The address and the phone used to be literals here, which made this file a second spelling of the one
 * fact `premises` is supposed to be the only source of — and it was the *prototype's* WhatsApp number,
 * which docs/13 §3 shows the live site contradicting. B-CAT-06 put the values in
 * `packages/db/src/seed/premises.ts` and left this composition, so a corrected address reaches the
 * document fixtures without anybody editing them.
 *
 * The TRN stays a fixture constant: `legal_entity.trn` holds a placeholder the schema refuses, and a
 * document that proves issuance *works* needs fifteen digits. The phone is the **landline**, not the
 * WhatsApp number: which WhatsApp number is canonical is Y1-nap, so the seeded value is a placeholder
 * and cannot be printed on anything.
 */
export const FIXTURE_ISSUER: IssuerSnapshot = {
  legalName: 'BE RELAX SPA - L.L.C - O.P.C',
  tradingName: PREMISES_NAP.displayName,
  trn: FIXTURE_TRN,
  addressLines: [
    PREMISES_NAP.addressLine1,
    `${PREMISES_NAP.addressLine2}, ${PREMISES_NAP.floor}`,
    `${PREMISES_NAP.area}, ${PREMISES_NAP.emirate}`,
  ],
  emirate: PREMISES_NAP.emirate,
  phone: PREMISES_NAP.phoneLandline,
}

/** A line as a fixture states it: a description, a quantity and a VAT-inclusive unit price. */
export interface InvoiceFixtureLine {
  readonly descriptionEn: string
  readonly descriptionAr?: string
  readonly quantity: number
  readonly unitGrossFils: number
  readonly rateBp?: VatRateBp
}

/**
 * **The unit's central fixture.** Two lines at 11 fils gross, one unit each, at 5%.
 *
 * 11 - round(11 * 20 / 21) = 11 - 10 = 1 fils of VAT per line, so the document's VAT total is 2.
 * 22 - round(22 * 20 / 21) = 22 - 21 = 1, which is what a re-derivation from the document total would
 * store — and is therefore the number a test looks for and must not find.
 *
 * 11 fils is not a realistic price and that is the point: it is the smallest amount at which the two
 * methods disagree, so the fixture fails loudly against an implementation that aggregates.
 */
export const TWO_LINES_AT_ELEVEN_FILS: readonly InvoiceFixtureLine[] = [
  { descriptionEn: 'Rounding probe, line 1', quantity: 1, unitGrossFils: 11 },
  { descriptionEn: 'Rounding probe, line 2', quantity: 1, unitGrossFils: 11 },
]

/** What the fixture must store. Stated as data so a test cannot quietly assert the implementation. */
export const ELEVEN_FILS_EXPECTED = {
  vatPerLineFils: 1,
  /** The sum of the per-line VAT. What the document stores. */
  documentVatFils: 2,
  /** What splitting the 22-fils document total gives. What must appear nowhere on the document. */
  reDerivedVatFils: 1,
  netTotalFils: 20,
  grossTotalFils: 22,
} as const

export interface InvoiceFixtureOptions {
  readonly documentKind?: 'tax_invoice' | 'simplified_invoice'
  readonly seriesCode?: string
  readonly issuer?: IssuerSnapshot
  /** `Customer 0042` by default. A record label, never an invented name (ADR 0020). */
  readonly customerIndex?: number
  readonly customerId?: string
  /** When the treatment happened. Its trading date becomes the tax point. */
  readonly supplyAt: Instant
  /** When the document is written. Later than the supply for an invoice raised the next day. */
  readonly issuedAt: Instant
  readonly hoursFor?: HoursForDate
  readonly lines?: readonly InvoiceFixtureLine[]
}

export interface InvoiceFixture {
  /** Ready for `issueInvoice`. */
  readonly input: IssueInvoiceInput
  /** What core derived, so a test can compare stored against derived rather than against a literal. */
  readonly tax: DocumentTax
  readonly taxPoint: TaxPointDates
}

/**
 * Derives a document with `@berelax/core` and maps it to `@berelax/db`'s input, field for field.
 *
 * Every rule this unit is about is visible in the body: the issuer snapshot is validated (so the Y1-trn
 * placeholder cannot reach a document), the tax point comes from the supply's **trading** date rather
 * than the issue date, the per-line net and VAT are the line's own, and the totals passed to the
 * database are the ones core summed — never a re-derivation from the gross.
 */
export function invoiceFixture(options: InvoiceFixtureOptions): InvoiceFixture {
  const issuer = requireIssuerSnapshot(options.issuer ?? FIXTURE_ISSUER)
  const hoursFor = options.hoursFor ?? FIXTURE_HOURS
  const fixtureLines = options.lines ?? TWO_LINES_AT_ELEVEN_FILS

  const taxPoint = resolveTaxPoint({
    supplyAt: options.supplyAt,
    issuedAt: options.issuedAt,
    hoursFor,
  })
  if (taxPoint.kind !== 'resolved') {
    // A fixture that silently picked a nearby date would produce a document with a tax point the
    // business did not trade on, which is the failure resolveTaxPoint exists to make visible.
    throw new AppError(
      'validation',
      `The fixture's supply instant belongs to no trading date (${taxPoint.reason} on ` +
        `${taxPoint.calendarDate}); pick an instant inside 11:00-02:00`,
    )
  }

  // Each fixture line is derived beside the line it came from, rather than derived as a batch and then
  // matched back by index. An index lookup would need a "what if there is no line at this index"
  // branch that cannot happen, and a branch that cannot happen is a branch no test can cover.
  const derived = fixtureLines.map((line) => ({
    line,
    tax: deriveTaxLine({
      quantity: line.quantity,
      unitGross: money(filsFrom(line.unitGrossFils)),
      rateBp: line.rateBp ?? UAE_STANDARD_VAT_BP,
    }),
  }))
  // A DerivedTaxLine IS a TaxableLine, so the document re-derives from the same inputs and the totals
  // are sums of exactly these figures.
  const tax = deriveDocumentTax(derived.map((d) => d.tax))

  const lines: readonly InvoiceLineInput[] = derived.map(({ line, tax: lineTax }) => ({
    descriptionEn: line.descriptionEn,
    ...(line.descriptionAr === undefined ? {} : { descriptionAr: line.descriptionAr }),
    quantity: line.quantity,
    unitGrossFils: line.unitGrossFils,
    vatRateBp: lineTax.rateBp,
    netFils: lineTax.net.fils,
    vatFils: lineTax.vat.fils,
  }))

  const input: IssueInvoiceInput = {
    documentKind: options.documentKind ?? 'tax_invoice',
    seriesCode: options.seriesCode ?? 'TAX-INV',
    issuer: {
      legalName: issuer.legalName,
      tradingName: issuer.tradingName,
      trn: issuer.trn,
      addressSnapshot: issuerAddressSnapshot(issuer.addressLines),
      emirate: issuer.emirate,
      ...(issuer.phone === undefined ? {} : { phone: issuer.phone }),
      ...(issuer.licenceNumber === undefined ? {} : { licenceNumber: issuer.licenceNumber }),
      ...(issuer.legalNameAr === undefined ? {} : { legalNameAr: issuer.legalNameAr }),
      ...(issuer.addressLinesAr === undefined
        ? {}
        : { addressSnapshotAr: issuerAddressSnapshot(issuer.addressLinesAr) }),
    },
    customer: {
      nameSnapshot: customerLabel(options.customerIndex ?? 42),
      ...(options.customerId === undefined ? {} : { customerId: options.customerId }),
    },
    issueDate: taxPoint.issueDate,
    ...(taxPoint.issueTradingDate === null ? {} : { issueTradingDate: taxPoint.issueTradingDate }),
    taxPointDate: taxPoint.taxPointDate,
    lines,
    // The three figures core SUMMED from the lines. Passing splitGross(gross).vat here instead is the
    // one-character change this whole unit exists to make impossible.
    netTotalFils: tax.net.fils,
    vatTotalFils: tax.vat.fils,
    grossTotalFils: tax.gross.fils,
    provisionalOpenQuestionId: 'Y11-vat-invoice',
    provisionalNote:
      'The mandatory tax-invoice field list is a superset of docs/04 §4 and the fields the F10 PDF ' +
      'renders, pending review by an FTA-registered tax agent.',
  }

  return { input, tax, taxPoint }
}
