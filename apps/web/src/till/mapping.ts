import type {
  Basket,
  EntryId,
  HoursForDate,
  Instant,
  IssuerSnapshot,
  JournalEntry,
  LocalDate,
  Money,
  PackageBalanceState,
  PackageRedemptionPosting,
  PackageSaleLineDraft,
  PackageSalePosting,
  TenderLine,
  VatRateBp,
} from '@berelax/core'
import {
  type CheckoutPosting,
  checkoutPosting,
  deriveDocumentTax,
  deriveTaxLine,
  filsFrom,
  issuerAddressSnapshot,
  localDate,
  money,
  packageRedemptionPosting,
  packageSalePosting,
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
  PackageBalanceInput,
  PackageTenderInput,
  RedeemPackageInput,
  SellPackageInput,
} from '@berelax/db'
import { AppError } from '@berelax/shared'

/**
 * The till's mapping from `@berelax/core`'s rules onto `@berelax/db`'s writers (M-TILL-13).
 *
 * `packages/db` may never import `packages/core` — the dependency runs the other way — so something has to
 * turn a priced `Basket`, a package version and a drawn-down balance into the structural mirrors
 * `finaliseCheckout`, `sellPackage` and `redeemPackage` take. `apps/web` is allowed to see both, and this is
 * the module that does it for the SCREENS.
 *
 * ## Why this is not `packages/fixtures/src/{checkout,package,package-redemption}.ts`
 *
 * Those three exist and are the same three mappings, and `checkout.ts`'s own header says "the till route
 * will call it". **The till route cannot call it**: `@berelax/fixtures` is a *devDependency* of
 * `@berelax/web` (see `apps/web/package.json`), its public entry is a barrel that re-exports the salon
 * generator, the synthetic-data builders and every loader, and a route importing it would pull that whole
 * graph into the Next server bundle — which `pnpm budgets` measures. Promoting a test-support package to a
 * runtime dependency of the application to reach three field-copying functions is the wrong trade.
 *
 * So the till has its own transcription, and the two are held EQUAL rather than left to drift:
 * `apps/web/src/till-mapping.test.ts` builds the same inputs through both and asserts deep equality on all
 * three, with a control that a deliberately wrong flattening is detected. That file can do it because a
 * TEST in `apps/web` may import the devDependency that a route may not.
 *
 * This is the shape the repository already uses at this seam rather than a new idea: `toEntryInput` is
 * transcribed three times inside `packages/fixtures` alone (`checkout.ts`, `package.ts`,
 * `package-redemption.ts`, `cash-up.ts`), because the alternative is a fourth package between `core` and
 * `db` whose only content is field names. What must never be transcribed is an *arithmetic rule*, and none
 * is: every account, every allocation, every split and every tax figure below comes out of `@berelax/core`.
 *
 * The proper fix — one implementation, in a package the application may depend on — is recorded in the
 * manifest as a NOTE, because moving `packages/fixtures/src/checkout.ts` would break gate case 101 for the
 * three `done` units that declare it.
 */

/** `JournalEntry` flattened to the structural mirror `postJournalEntry` writes. */
export const toEntryInput = (entry: JournalEntry): JournalEntryInput => ({
  entryId: entry.entryId as string,
  entryDate: entry.entryDate as string,
  narrative: entry.narrative,
  source: entry.source,
  lines: entry.lines.map((line) => ({
    accountCode: line.account as string,
    debitFils: line.debitFils,
    creditFils: line.creditFils,
    memo: line.memo,
  })),
})

// --- the service checkout ------------------------------------------------------------------------

/** A treatment on the basket, and the appointment row it came from. */
export interface TillLineOrigin {
  readonly lineId: string
  readonly appointmentId: string
}

export interface TillCheckoutMappingInput {
  readonly basket: Basket
  readonly tenders: readonly TenderLine[]
  readonly entryId: EntryId
  readonly idempotencyKey: string
  readonly requestFingerprint: string
  /** When the treatments were delivered. Its TRADING date becomes the tax point. */
  readonly supplyAt: Instant
  /** When the document is written. Later than the supply for a checkout closed after midnight. */
  readonly issuedAt: Instant
  readonly origins: readonly TillLineOrigin[]
  /**
   * The issuer, read out of `legal_entity` and `premises`.
   *
   * Required and never defaulted. `requireIssuerSnapshot` is applied to it below, so a placeholder TRN is
   * refused with `TrnNotConfigured` before anything is composed — which is the state the real business
   * profile is in today (Y1-trn).
   */
  readonly issuer: IssuerSnapshot
  /** The document form the rule chose, and the series it draws its number from. */
  readonly documentKind: 'tax_invoice' | 'simplified_invoice'
  readonly seriesCode: string
  /** `Customer 0042`. A record label, never an invented name (ADR 0020, brief rule 10). */
  readonly customerLabel: string
  readonly customerId?: string
  readonly hoursFor: HoursForDate
  readonly narrative?: string
}

export interface TillCheckoutMapping {
  readonly posting: CheckoutPosting
  readonly input: FinaliseCheckoutInput
  readonly tradingDate: LocalDate
}

/**
 * Maps a priced basket and its tenders onto `finaliseCheckout`'s input.
 *
 * The tax point comes from the **supply's** trading date and not from the issue date, which is
 * `resolveTaxPoint`'s whole job: a treatment delivered at 01:30 belongs to the previous trading date, and a
 * checkout closed the next morning keeps the supply's tax point.
 */
export function tillCheckoutMapping(options: TillCheckoutMappingInput): TillCheckoutMapping {
  // FIRST, so a refusal happens before anything is composed: a caller holding a half-built document is a
  // caller who will be tempted to write it. `invoice-template.ts` orders it the same way for the same reason.
  const issuer = requireIssuerSnapshot(options.issuer)

  const taxPoint = resolveTaxPoint({
    supplyAt: options.supplyAt,
    issuedAt: options.issuedAt,
    hoursFor: options.hoursFor,
  })
  if (taxPoint.kind !== 'resolved') {
    // A mapping that silently picked a nearby date would produce a document with a tax point the business
    // did not trade on, which is the failure `resolveTaxPoint` exists to make visible.
    throw new AppError(
      'validation',
      `the supply instant belongs to no trading date (${taxPoint.reason} on ` +
        `${taxPoint.calendarDate}); the tax point cannot be resolved`,
    )
  }
  // The journal is dated on the trading day the MONEY was taken, which is the issue trading date when there
  // is one. A document raised while the premises was shut has none, and then the supply's own trading date
  // is the only honest answer — an entry dated on a day the till was not open would sit in a cash-up nobody
  // ran.
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
    documentKind: options.documentKind,
    seriesCode: options.seriesCode,
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
      nameSnapshot: options.customerLabel,
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

  // One link per origin, carrying the invoice line number the charge became — or none, for an appointment
  // the document does not state as a line (a package redemption's gross is zero).
  const lineNoOf = new Map(
    posting.charges.map((charge, index) => [charge.lineId as string, index + 1]),
  )
  const appointments: readonly CheckoutAppointmentInput[] = options.origins.map((origin) => {
    const lineNo = lineNoOf.get(origin.lineId)
    return lineNo === undefined
      ? { appointmentId: origin.appointmentId }
      : { appointmentId: origin.appointmentId, lineNo }
  })

  const tenders: readonly CheckoutTenderInput[] = posting.tenders.map((tender) => ({
    tenderKind: tender.kind,
    postingAccountCode: tender.account as string,
    amountFils: tender.amount.fils,
    ...(tender.reference === undefined ? {} : { reference: tender.reference }),
  }))

  return {
    posting,
    tradingDate,
    input: {
      idempotencyKey: options.idempotencyKey,
      basketId: options.basket.basketId as string,
      requestFingerprint: options.requestFingerprint,
      tradingDate,
      invoice,
      journal: toEntryInput(posting.entry),
      tenders,
      appointments,
      customerId: options.basket.customerId,
    },
  }
}

// --- the package sale ----------------------------------------------------------------------------

export interface TillPackageLineOrigin {
  readonly lineNo: number
  readonly serviceVariantId: string
  readonly sessionCount: number
  /** The variant's gross price × the session count. The allocation WEIGHT, never an amount posted. */
  readonly listGrossFils: number
}

export interface TillPackageSaleMappingInput {
  readonly entryId: EntryId
  readonly tradingDate: LocalDate
  readonly customerId: string
  readonly templateVersionId: string
  readonly priceGross: Money
  readonly lines: readonly TillPackageLineOrigin[]
  readonly tenders: readonly TenderLine[]
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: 'retained' | 'forfeited'
  readonly packageLabel: string
}

export interface TillPackageSaleMapping {
  readonly input: SellPackageInput
  readonly posting: PackageSalePosting
}

export class TillMappingMismatch extends Error {
  constructor(message: string) {
    super(`TillMappingMismatch: ${message}`)
    this.name = 'TillMappingMismatch'
  }
}

export function tillPackageSaleMapping(
  options: TillPackageSaleMappingInput,
): TillPackageSaleMapping {
  const drafts: readonly PackageSaleLineDraft[] = options.lines.map((line) => ({
    lineId: String(line.lineNo),
    sessionCount: line.sessionCount,
    listGross: money(filsFrom(line.listGrossFils), options.priceGross.currency),
  }))

  const posting = packageSalePosting(
    {
      entryId: options.entryId,
      entryDate: options.tradingDate,
      priceGross: options.priceGross,
      lines: drafts,
      tenders: options.tenders,
      packageLabel: options.packageLabel,
    },
    STANDARD_SPA_CHART,
  )

  if (posting.balances.length !== options.lines.length) {
    throw new TillMappingMismatch(
      `the rule returned ${posting.balances.length} balance(s) for ${options.lines.length} line(s)`,
    )
  }

  const balances: readonly PackageBalanceInput[] = options.lines.map((line, index) => {
    const balance = posting.balances[index]
    if (balance === undefined) {
      throw new TillMappingMismatch(`no allocated share for line ${line.lineNo}`)
    }
    // Paired by POSITION, and the id is checked rather than trusted: `lineId` is this mapping's own
    // `String(line_no)`, so a mismatch here means the rule reordered the lines — which would put one line's
    // money on another line's entitlement, and both would still sum to the price.
    if (balance.lineId !== String(line.lineNo)) {
      throw new TillMappingMismatch(
        `share ${index + 1} is for line "${balance.lineId}" and line ${index + 1} is ${line.lineNo}`,
      )
    }
    return {
      lineNo: line.lineNo,
      serviceVariantId: line.serviceVariantId,
      sessionsTotal: balance.sessionsTotal,
      valueFils: balance.valueGross.fils,
    }
  })

  const tenders: readonly PackageTenderInput[] = posting.tenders.map((tender) => ({
    tenderKind: tender.kind,
    postingAccountCode: tender.account as string,
    amountFils: tender.amount.fils,
    ...(tender.reference === undefined ? {} : { reference: tender.reference }),
  }))

  return {
    posting,
    input: {
      customerId: options.customerId,
      templateVersionId: options.templateVersionId,
      tradingDate: options.tradingDate as string,
      priceFils: options.priceGross.fils,
      sessionCount: posting.sessionsTotal,
      validityMonths: options.validityMonths,
      transferable: options.transferable,
      unredeemedBalancePolicy: options.unredeemedBalancePolicy,
      journal: toEntryInput(posting.entry),
      balances,
      tenders,
    },
  }
}

// --- the package redemption ----------------------------------------------------------------------

export interface TillPackageRedemptionMappingInput {
  readonly entryId: EntryId
  readonly tradingDate: LocalDate
  readonly balance: PackageBalanceState
  readonly appointmentId: string
  readonly units: number
  readonly rateBp?: VatRateBp
  readonly packageLabel: string
}

export interface TillPackageRedemptionMapping {
  readonly input: RedeemPackageInput
  readonly posting: PackageRedemptionPosting
}

export function tillPackageRedemptionMapping(
  options: TillPackageRedemptionMappingInput,
): TillPackageRedemptionMapping {
  const posting = packageRedemptionPosting(
    {
      entryId: options.entryId,
      entryDate: options.tradingDate,
      balance: options.balance,
      units: options.units,
      packageLabel: options.packageLabel,
      ...(options.rateBp === undefined ? {} : { rateBp: options.rateBp }),
    },
    STANDARD_SPA_CHART,
  )

  return {
    posting,
    input: {
      packageBalanceId: options.balance.balanceId,
      appointmentId: options.appointmentId,
      units: options.units,
      tradingDate: options.tradingDate as string,
      releasedFils: posting.releasedGross.fils,
      vatFils: posting.vat.fils,
      vatRateBp: posting.rateBp,
      journal: toEntryInput(posting.entry),
    },
  }
}
