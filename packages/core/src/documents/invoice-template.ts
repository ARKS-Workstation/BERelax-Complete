/**
 * The document a customer is handed: which form it is, which fields it states, and the figures on it.
 *
 * `packages/db` stores an issued document (migration 0026). `packages/pdf` draws one. This module is
 * the part in between that has to be *pure*: the rule that picks the form, the per-form field list,
 * and the translation from the stored row into something a template can interpolate without making
 * any arithmetic decisions of its own.
 *
 * Three rules carry it, and each exists because the obvious alternative is wrong on a document that
 * has already been handed over.
 *
 * ## 1. Rendering derives nothing. It prints what was stored.
 *
 * `0026_invoice.sql` states it for the database: "a document total is the SUM of its lines, never a
 * re-derivation from the document gross". The same rule binds the renderer, and the tempting mistake
 * is one call: `splitGross(documentGross)`. For the committed two-lines-at-11-fils document that
 * prints VAT of 1 beside a stored `vat_total` of 2, and the PDF is the copy the customer keeps. So
 * {@link buildTaxDocument} contains no split, no rounding and no multiplication of a unit price: every
 * figure it puts on the page is a stored column, and the only arithmetic is `+` over stored per-line
 * figures to produce the per-rate subtotals a mixed-rate document needs.
 *
 * It goes further and *checks*: a stored header whose totals disagree with its own lines is refused
 * rather than printed. The database enforces that at COMMIT, which cannot help a caller that hands
 * this function a hand-built object — and a document is the one artefact where printing a figure
 * nobody can reproduce is worse than failing.
 *
 * ## 2. The form is chosen by a rule, never by an operator
 *
 * {@link INVOICE_FORM_RULE} is a four-row table over (document total, customer presence) and
 * {@link chooseInvoiceForm} is a lookup in it, so the rule and the test that covers it cannot drift
 * into two rules. Nothing in this module accepts a "make it simplified" flag, and
 * {@link buildTaxDocument} re-applies the rule to the *stored* figures: a document whose stored kind
 * is not the kind the rule chooses is refused at render time. That is what makes "no UI path can
 * override it" a property of the system rather than of the screens nobody has written yet.
 *
 * ## 3. A receipt is not a tax invoice, and must not read like one
 *
 * The three forms are not three skins. A **tax invoice** states the supplier's TRN, the customer's
 * details and the tax on every line. A **simplified tax invoice** is the retail form below the
 * threshold: still a tax document, still stating the TRN, but with no customer block. A **receipt** is
 * a proof of payment and no tax document at all: it states no TRN, no VAT and no registration claim,
 * and it carries the sentence saying so. That last form is the only one this business can issue today
 * — `legal_entity.trn` holds the Y1-trn placeholder, and {@link requireIssuerTrn} refuses it — which
 * is exactly why the difference is modelled as data ({@link DOCUMENT_FORM_FIELDS}) rather than left to
 * three templates that happen to differ.
 */
import { AppError } from '@berelax/shared'
import { isPlaceholderText, requireIssuerTrn } from '../money/vat.ts'
import {
  add,
  aed,
  filsFrom,
  type Money,
  money,
  type VatRateBp,
  vatRateBp,
  ZERO_AED,
} from '../money.ts'
import { type LocalDate, localDate } from '../time.ts'

// --- the forms -----------------------------------------------------------------------------------

/**
 * Every form this system can print.
 *
 * `tax_invoice` and `simplified_invoice` are the two `document_kind` values `invoice` stores;
 * `receipt` has no row of its own, because a receipt is not a document the FTA numbers — see the
 * note on {@link RECEIPT_SOURCE}.
 */
export const DOCUMENT_FORMS = ['tax_invoice', 'simplified_invoice', 'receipt'] as const
export type DocumentForm = (typeof DOCUMENT_FORMS)[number]

/** The two forms that are tax documents. A receipt is deliberately not one of them. */
export const INVOICE_FORMS = ['tax_invoice', 'simplified_invoice'] as const
export type InvoiceForm = (typeof INVOICE_FORMS)[number]

export function isInvoiceForm(form: DocumentForm): form is InvoiceForm {
  return form !== 'receipt'
}

/**
 * Where a receipt's figures come from, recorded because the honest answer is "not from its own table".
 *
 * A receipt acknowledges a payment, and the payment lives in the till (M-TILL-05 to M-TILL-11), none of
 * which exists yet. Until it does, a receipt is rendered from the same stored document shape as an
 * invoice with its tax statement suppressed, which is enough to prove the form and to hand a walk-in a
 * piece of paper — and not enough to call it wired up. Stated here rather than in a template comment
 * because the next person to touch this will be the one wiring the till to it.
 */
export const RECEIPT_SOURCE =
  'A receipt has no table of its own: the till sale and tender rows it will be built from are ' +
  'M-TILL-05 to M-TILL-11. Rendered today from the stored document shape with no tax statement.'

// --- the threshold -------------------------------------------------------------------------------

/**
 * The gross total above which a full tax invoice is required.
 *
 * **Provisional.** AED 10,000 is the figure reported for the UAE simplified-invoice concession and it
 * is carried as the working value, not as a confirmed one: the mandatory field list and the threshold
 * are both open questions for an FTA-registered tax agent (OPEN-QUESTIONS Y11-vat-invoice). It is a
 * constant with a flag beside it rather than a number inline, so answering the question is an edit in
 * one place and the flag is what a settings screen shows the owner.
 */
export const SIMPLIFIED_INVOICE_THRESHOLD: Money = aed(10_000)

export const SIMPLIFIED_INVOICE_THRESHOLD_PROVISIONAL = {
  provisional: true,
  openQuestionId: 'Y11-vat-invoice',
  note:
    'Simplified-invoice threshold set to AED 10,000 gross as the provisional value, pending an ' +
    'FTA-registered tax agent. The field list on each form is provisional for the same reason.',
} as const

// --- the rule ------------------------------------------------------------------------------------

/**
 * One row of the rule: the two inputs, the outcome, and why.
 *
 * `outcome` is either a form or the name of the refusal, because "no compliant document can be issued
 * here" is one of the four answers rather than an error case bolted on beside them.
 */
export interface InvoiceFormRuleRow {
  readonly aboveThreshold: boolean
  readonly customerIdentified: boolean
  readonly outcome: InvoiceForm | 'CustomerDetailsRequired'
  readonly reason: string
}

/** The four combinations, as a key, so a lookup cannot miss. */
export type InvoiceFormRuleKey = `${'below' | 'above'}-${'anon' | 'named'}`

/**
 * The whole full-versus-simplified rule, as data.
 *
 * Two inputs, four rows, and one of them is a refusal. Written as a table and read by
 * {@link chooseInvoiceForm} so that the rule, the test that covers it and this documentation are one
 * object: a rule implemented as an `if` and re-stated in a test is two rules, and the test's copy is the
 * one that rots. Keyed rather than searched, so the lookup is total — a `find` would need an
 * "unreachable" branch, and an unreachable branch is a branch no test can cover.
 *
 * The refusal row is the interesting one. Above the threshold the simplified concession does not apply,
 * so a full tax invoice is required — and a full tax invoice states the customer's details. A walk-in
 * who has not been identified therefore cannot be given *any* compliant document, and the right
 * behaviour is to refuse and ask the desk for a name, not to print the form with the customer block
 * left blank.
 */
export const INVOICE_FORM_RULE: Readonly<Record<InvoiceFormRuleKey, InvoiceFormRuleRow>> = {
  'below-anon': {
    aboveThreshold: false,
    customerIdentified: false,
    outcome: 'simplified_invoice',
    reason: 'at or below the simplified threshold and no customer of record',
  },
  'below-named': {
    aboveThreshold: false,
    customerIdentified: true,
    outcome: 'tax_invoice',
    reason: 'a customer of record is named, so the full form is the one they can use',
  },
  'above-anon': {
    aboveThreshold: true,
    customerIdentified: false,
    outcome: 'CustomerDetailsRequired',
    reason:
      'above the simplified threshold a full tax invoice is required, and it must state the ' +
      'customer — identify the customer before issuing',
  },
  'above-named': {
    aboveThreshold: true,
    customerIdentified: true,
    outcome: 'tax_invoice',
    reason: 'above the simplified threshold, so the full form is required',
  },
}

/** The key for one pair of inputs. */
export function invoiceFormRuleKey(
  aboveThreshold: boolean,
  customerIdentified: boolean,
): InvoiceFormRuleKey {
  return `${aboveThreshold ? 'above' : 'below'}-${customerIdentified ? 'named' : 'anon'}`
}

export interface InvoiceFormInput {
  /** The document's gross total — the stored `gross_total`, never a re-derivation. */
  readonly gross: Money
  /**
   * True when the document names a customer of record.
   *
   * `invoice.customer_id is not null`. The customer *name* column is never null — a cash sale carries
   * the label `Customer 0042` — so the name cannot answer this question and the id is what does.
   */
  readonly customerIdentified: boolean
}

export type InvoiceFormDecision =
  | { readonly kind: 'form'; readonly form: InvoiceForm; readonly reason: string }
  | {
      readonly kind: 'refused'
      readonly code: 'CustomerDetailsRequired'
      readonly reason: string
    }

/** True when the gross total is over {@link SIMPLIFIED_INVOICE_THRESHOLD}. */
export function isAboveSimplifiedThreshold(gross: Money): boolean {
  return gross.fils > SIMPLIFIED_INVOICE_THRESHOLD.fils
}

/**
 * Picks the invoice form from the document total and whether a customer is named.
 *
 * There is no third argument, and that is the point: a caller cannot ask for a form, only for the
 * form. A receipt is never returned — a receipt does not discharge the obligation to issue a tax
 * invoice for a taxable supply, so it is not one of the answers to this question.
 */
export function chooseInvoiceForm(input: InvoiceFormInput): InvoiceFormDecision {
  const row =
    INVOICE_FORM_RULE[
      invoiceFormRuleKey(isAboveSimplifiedThreshold(input.gross), input.customerIdentified)
    ]
  if (row.outcome === 'CustomerDetailsRequired') {
    return { kind: 'refused', code: row.outcome, reason: row.reason }
  }
  return { kind: 'form', form: row.outcome, reason: row.reason }
}

/** The form, or an error naming what the desk has to do first. */
export function requireInvoiceForm(input: InvoiceFormInput): InvoiceForm {
  const decision = chooseInvoiceForm(input)
  if (decision.kind === 'refused') {
    throw new AppError(
      'validation',
      `${decision.code}: ${decision.reason}. Document total ${input.gross.fils} fils, threshold ` +
        `${SIMPLIFIED_INVOICE_THRESHOLD.fils} fils.`,
    )
  }
  return decision.form
}

// --- what each form states -----------------------------------------------------------------------

/**
 * Every field a document can state, as a closed set.
 *
 * Named separately from the database's `Y11_VAT_INVOICE_FIELDS`, which enumerates *columns*: this is
 * the printed side, and the two are checked against each other by
 * `packages/fixtures/src/tax-document.itest.ts` — a column nothing prints and a printed field backed
 * by no column are both defects, and neither list can see them alone.
 */
export const DOCUMENT_FIELDS = [
  'documentTitle',
  'issuerLegalName',
  'issuerTradingName',
  'issuerAddress',
  'issuerEmirate',
  'issuerTrn',
  'issuerPhone',
  'documentNumber',
  'documentSeries',
  'issueDate',
  'taxPointDate',
  'customerName',
  'customerAddress',
  'customerTrn',
  'lineDescription',
  'lineQuantity',
  'lineUnitGross',
  'lineNet',
  'lineVatRate',
  'lineVat',
  'lineGross',
  'netTotal',
  'vatTotal',
  'grossTotal',
  'currency',
  'arabicText',
  'notATaxInvoice',
] as const
export type DocumentFieldKey = (typeof DOCUMENT_FIELDS)[number]

/**
 * Which fields each form states (docs/04 §4).
 *
 * The tax invoice list is the Y11 superset: everything docs/04 §4 names, carried generously because
 * the confirmed list is an open question and a field printed unnecessarily costs a line of paper
 * while a field missing costs a re-issue.
 *
 * The simplified list drops the customer block and nothing else. It keeps the TRN and the tax
 * figures, because a simplified *tax* invoice is still a tax document — which is why answering Y1-trn
 * unblocks both invoice forms at once and neither before.
 *
 * The receipt list is the short one, and every omission is deliberate: no TRN, no VAT rate, no VAT
 * amount, no net total. A receipt that showed a VAT breakdown would be claiming a registration this
 * business does not yet hold, and the `notATaxInvoice` sentence is what stops the short form being
 * mistaken for the simplified one.
 */
export const DOCUMENT_FORM_FIELDS: Record<DocumentForm, readonly DocumentFieldKey[]> = {
  tax_invoice: [
    'documentTitle',
    'issuerLegalName',
    'issuerTradingName',
    'issuerAddress',
    'issuerEmirate',
    'issuerTrn',
    'issuerPhone',
    'documentNumber',
    'documentSeries',
    'issueDate',
    'taxPointDate',
    'customerName',
    'customerAddress',
    'customerTrn',
    'lineDescription',
    'lineQuantity',
    'lineUnitGross',
    'lineNet',
    'lineVatRate',
    'lineVat',
    'lineGross',
    'netTotal',
    'vatTotal',
    'grossTotal',
    'currency',
    'arabicText',
  ],
  simplified_invoice: [
    'documentTitle',
    'issuerLegalName',
    'issuerTradingName',
    'issuerAddress',
    'issuerEmirate',
    'issuerTrn',
    'issuerPhone',
    'documentNumber',
    'documentSeries',
    'issueDate',
    'taxPointDate',
    'lineDescription',
    'lineQuantity',
    'lineUnitGross',
    'lineVatRate',
    'lineGross',
    'netTotal',
    'vatTotal',
    'grossTotal',
    'currency',
    'arabicText',
  ],
  receipt: [
    'documentTitle',
    'issuerTradingName',
    'issuerAddress',
    'issuerPhone',
    'documentNumber',
    'issueDate',
    'lineDescription',
    'lineQuantity',
    'lineGross',
    'grossTotal',
    'currency',
    'arabicText',
    'notATaxInvoice',
  ],
}

/** True when `form` states `field`. The one question a template asks of this module. */
export function formStates(form: DocumentForm, field: DocumentFieldKey): boolean {
  return DOCUMENT_FORM_FIELDS[form].includes(field)
}

// --- the stored document, structurally ------------------------------------------------------------

/**
 * One stored line, as `readInvoice` in `@berelax/db` returns it.
 *
 * Declared here rather than imported: `packages/core` may import `@berelax/shared` and nothing else,
 * and the dependency between core and db runs db → core. Structural typing is what makes that safe
 * without a second definition drifting from the first — `IssuedInvoice` is assignable to
 * {@link StoredDocument} or it is a type error, and
 * `packages/fixtures/src/tax-document.itest.ts` performs exactly that assignment, in the one package
 * allowed to see both.
 */
export interface StoredDocumentLine {
  readonly lineNo: number
  readonly descriptionEn: string
  readonly descriptionAr: string | null
  readonly quantity: number
  readonly unitGrossFils: number
  readonly lineGrossFils: number
  readonly vatRateBp: number
  readonly netFils: number
  readonly vatFils: number
}

/** The stored document, as `readInvoice` returns it. Fils are integers; nothing here is derived. */
export interface StoredDocument {
  readonly documentKind: string
  readonly seriesCode: string
  readonly periodKey: string
  readonly displayNumber: string
  readonly issuerLegalName: string
  readonly issuerTradingName: string
  readonly issuerTrn: string
  /** Newline-separated, in the order it prints. */
  readonly issuerAddressSnapshot: string
  readonly issuerEmirate: string
  readonly issuerPhone: string | null
  readonly issuerLicenceNumber: string | null
  readonly issuerLegalNameAr: string | null
  readonly issuerAddressSnapshotAr: string | null
  readonly customerId: string | null
  readonly customerNameSnapshot: string
  readonly customerTrn: string | null
  readonly customerAddressSnapshot: string | null
  readonly customerPhone: string | null
  readonly issueDate: string
  readonly taxPointDate: string
  readonly currency: string
  readonly netTotalFils: number
  readonly vatTotalFils: number
  readonly grossTotalFils: number
  readonly notes: string | null
  readonly lines: readonly StoredDocumentLine[]
}

// --- the view a template interpolates -------------------------------------------------------------

export interface DocumentParty {
  readonly name: string
  readonly nameAr: string | undefined
  /**
   * The trading name, for the issuer only.
   *
   * Both names are on an invoice and they are not interchangeable: the masthead carries the trading
   * name, because that is what the customer walked into and what they will recognise on a statement,
   * and the supplier block carries the legal name, because that is the entity the TRN belongs to. A
   * receipt has only the one.
   */
  readonly tradingName: string | undefined
  readonly addressLines: readonly string[]
  readonly addressLinesAr: readonly string[]
  readonly trn: string | undefined
  readonly phone: string | undefined
  /**
   * The emirate, for the issuer only.
   *
   * A column of its own on the stored document rather than the address block's last line, because the
   * licensing authority follows from it (ADDED and Abu Dhabi Municipality, docs/04 §1) and a document
   * whose emirate is inferred from a string is a document whose authority is inferred from a string.
   */
  readonly emirate: string | undefined
}

export interface DocumentLine {
  readonly descriptionEn: string
  readonly descriptionAr: string | undefined
  readonly quantity: number
  readonly unitGross: Money
  readonly net: Money
  readonly vat: Money
  readonly gross: Money
  readonly rateBp: VatRateBp
}

export interface DocumentRateSubtotal {
  readonly rateBp: VatRateBp
  readonly net: Money
  readonly vat: Money
  readonly gross: Money
}

export interface DocumentTotals {
  readonly net: Money
  readonly vat: Money
  readonly gross: Money
  /** Ascending by rate. One entry for a single-rate document, which is the ordinary case. */
  readonly byRate: readonly DocumentRateSubtotal[]
}

/** Everything a template needs and nothing it has to compute. */
export interface TaxDocumentView {
  readonly form: DocumentForm
  readonly documentNumber: string
  readonly seriesCode: string
  readonly periodKey: string
  readonly issueDate: LocalDate
  readonly taxPointDate: LocalDate
  readonly issuer: DocumentParty
  /** Absent on the forms that state no customer, which is not the same as an empty block. */
  readonly customer: DocumentParty | undefined
  readonly lines: readonly DocumentLine[]
  readonly totals: DocumentTotals
  readonly notes: string | undefined
  readonly notesAr: string | undefined
  /** The single VAT rate, or undefined when the lines disagree and no footnote can name one. */
  readonly singleRateBp: VatRateBp | undefined
}

// --- building it ----------------------------------------------------------------------------------

/**
 * Arabic text the source tables cannot supply yet.
 *
 * `legal_entity` has no Arabic legal name, `premises` no Arabic address and `service` no Arabic public
 * display name (the NOTE on M-TILL-04), so the stored Arabic columns are nullable and are null for
 * every document issued today. The Arabic-language requirement is real, so the renderer needs
 * *something* — and the only honest something is a value supplied by the caller and visibly marked as
 * not coming from the record. B-CAT-06 seeds the source columns; after that these options go unused
 * and the stored values win.
 */
export interface ArabicFallbacks {
  readonly issuerLegalName?: string
  readonly issuerAddressLines?: readonly string[]
  /** By `line_no`, so a partial catalogue translation is expressible. */
  readonly lineDescriptions?: Readonly<Record<number, string>>
  readonly customerName?: string
  readonly customerAddressLines?: readonly string[]
  readonly notes?: string
}

export interface BuildTaxDocumentOptions {
  readonly form: DocumentForm
  readonly arabic?: ArabicFallbacks
}

const splitAddress = (snapshot: string | null): readonly string[] =>
  snapshot === null
    ? []
    : snapshot
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')

/**
 * Sums one stored column across the lines.
 *
 * The only arithmetic in this module, and it is addition over stored values. `filsFrom` validates that
 * the column really is an integer number of fils: a float there would be a driver or migration defect,
 * and a tax document is the wrong place to discover one.
 */
function sumStored(
  lines: readonly StoredDocumentLine[],
  pick: (line: StoredDocumentLine) => number,
): Money {
  return lines.reduce<Money>((total, line) => add(total, money(filsFrom(pick(line)))), ZERO_AED)
}

function assertFigureAgreement(stored: StoredDocument): void {
  const net = sumStored(stored.lines, (line) => line.netFils)
  const vat = sumStored(stored.lines, (line) => line.vatFils)
  const gross = sumStored(stored.lines, (line) => line.lineGrossFils)
  const disagreements: string[] = []
  if (net.fils !== stored.netTotalFils) {
    disagreements.push(`net_total ${stored.netTotalFils} against lines summing to ${net.fils}`)
  }
  if (vat.fils !== stored.vatTotalFils) {
    disagreements.push(`vat_total ${stored.vatTotalFils} against lines summing to ${vat.fils}`)
  }
  if (gross.fils !== stored.grossTotalFils) {
    disagreements.push(
      `gross_total ${stored.grossTotalFils} against lines summing to ${gross.fils}`,
    )
  }
  if (stored.netTotalFils + stored.vatTotalFils !== stored.grossTotalFils) {
    disagreements.push(
      `net_total ${stored.netTotalFils} + vat_total ${stored.vatTotalFils} is not gross_total ` +
        `${stored.grossTotalFils}`,
    )
  }
  if (disagreements.length > 0) {
    // The same invariant `assert_invoice_totals_match_lines()` enforces at COMMIT, checked again here
    // because a caller can hand this function an object no database ever saw — and because the figure
    // a re-derivation produces is exactly the figure that would otherwise be printed and filed.
    throw new AppError(
      'invariant_violated',
      `DocumentFiguresDisagree: document "${stored.displayNumber}" cannot be printed — ` +
        `${disagreements.join('; ')}. A document total is the SUM of its lines.`,
    )
  }
}

/** Everything that must hold of the stored row before any form of it can be printed. */
function assertPrintable(stored: StoredDocument): void {
  if (stored.currency !== 'AED') {
    throw new AppError(
      'invariant_violated',
      `A UAE tax document states AED; document "${stored.displayNumber}" stores ${stored.currency}.`,
    )
  }
  if (stored.lines.length === 0) {
    throw new AppError(
      'invariant_violated',
      `Document "${stored.displayNumber}" has no lines, so it states nothing.`,
    )
  }
  assertFigureAgreement(stored)
  if (isPlaceholderText(stored.issuerLegalName)) {
    throw new AppError(
      'invariant_violated',
      `IssuerNotConfigured: the issuer legal name is "${stored.issuerLegalName}", a placeholder. ` +
        'A document states who supplied the service.',
    )
  }
  if (isPlaceholderText(stored.issuerAddressSnapshot)) {
    throw new AppError(
      'invariant_violated',
      'IssuerNotConfigured: the issuer address is blank or a placeholder (docs/04 §4).',
    )
  }
}

/**
 * The three things that must hold before a *tax* document of this form can be printed.
 *
 * Not called for a receipt, which states no TRN and is not a form the rule chooses.
 */
function assertInvoiceFormPermitted(stored: StoredDocument, form: InvoiceForm): void {
  // Throws TrnNotConfigured. First, so that a refusal happens before anything is composed: a caller
  // writing the result to a file must not be able to end up with a half-built document.
  requireIssuerTrn(stored.issuerTrn)

  if (stored.documentKind !== form) {
    throw new AppError(
      'invariant_violated',
      `DocumentKindMismatch: document "${stored.displayNumber}" was issued as ` +
        `${stored.documentKind} and cannot be printed as ${form}.`,
    )
  }
  const required = requireInvoiceForm({
    gross: money(filsFrom(stored.grossTotalFils)),
    customerIdentified: stored.customerId !== null,
  })
  if (required !== form) {
    throw new AppError(
      'invariant_violated',
      `DocumentFormNotPermitted: document "${stored.displayNumber}" is stored as ${form}, but a ` +
        `gross of ${stored.grossTotalFils} fils with ` +
        `${stored.customerId === null ? 'no customer of record' : 'a customer of record'} ` +
        `requires ${required}. The form is a rule, not a choice.`,
    )
  }
}

/** The per-rate subtotals, summed from stored per-line figures. Ascending by rate. */
function subtotalsByRate(lines: readonly DocumentLine[]): readonly DocumentRateSubtotal[] {
  const rates = [...new Set(lines.map((line) => line.rateBp))].sort((a, b) => a - b)
  return rates.map((rateBp) => {
    const atRate = lines.filter((line) => line.rateBp === rateBp)
    return {
      rateBp,
      net: atRate.reduce<Money>((total, line) => add(total, line.net), ZERO_AED),
      vat: atRate.reduce<Money>((total, line) => add(total, line.vat), ZERO_AED),
      gross: atRate.reduce<Money>((total, line) => add(total, line.gross), ZERO_AED),
    }
  })
}

function buildIssuer(
  stored: StoredDocument,
  form: DocumentForm,
  arabic: ArabicFallbacks,
): DocumentParty {
  return {
    // A receipt is issued by the business the customer walked into, so the trading name leads; the
    // invoice forms lead with the legal entity, which is the name the TRN belongs to.
    name: form === 'receipt' ? stored.issuerTradingName : stored.issuerLegalName,
    nameAr: stored.issuerLegalNameAr ?? arabic.issuerLegalName,
    tradingName: stored.issuerTradingName,
    addressLines: splitAddress(stored.issuerAddressSnapshot),
    addressLinesAr:
      stored.issuerAddressSnapshotAr === null
        ? (arabic.issuerAddressLines ?? [])
        : splitAddress(stored.issuerAddressSnapshotAr),
    // Suppressed rather than absent by accident: the field list says a receipt states no TRN, and this
    // is where that becomes true of the data the template can see. A template cannot print what it was
    // not given.
    trn: formStates(form, 'issuerTrn') ? stored.issuerTrn : undefined,
    phone: stored.issuerPhone ?? undefined,
    emirate: formStates(form, 'issuerEmirate') ? stored.issuerEmirate : undefined,
  }
}

function buildCustomer(
  stored: StoredDocument,
  form: DocumentForm,
  arabic: ArabicFallbacks,
): DocumentParty | undefined {
  if (!formStates(form, 'customerName')) return undefined
  return {
    name: stored.customerNameSnapshot,
    nameAr: arabic.customerName,
    tradingName: undefined,
    addressLines: splitAddress(stored.customerAddressSnapshot),
    addressLinesAr: arabic.customerAddressLines ?? [],
    trn: stored.customerTrn ?? undefined,
    phone: stored.customerPhone ?? undefined,
    // A customer has no emirate on this document: their address is printed as snapshotted, and the
    // emirate is a statement about the SUPPLIER's licence (docs/04 §1).
    emirate: undefined,
  }
}

/**
 * Turns a stored document into a view a template can interpolate.
 *
 * Refuses, rather than printing, when:
 *
 *   - an invoice form is asked for and the issuer's TRN is missing, malformed or the Y1-trn
 *     placeholder ({@link requireIssuerTrn}, `TrnNotConfigured`) — which is the state the real
 *     `legal_entity` row is in today, so today this function cannot produce either invoice form from
 *     the real business profile at all;
 *   - the issuer's legal name or address is a placeholder;
 *   - the stored header's totals disagree with its own lines;
 *   - the stored `document_kind` is not the kind {@link chooseInvoiceForm} picks for those figures,
 *     which is the check that makes the form rule unoverridable from a screen;
 *   - the currency is not AED.
 */
export function buildTaxDocument(
  stored: StoredDocument,
  options: BuildTaxDocumentOptions,
): TaxDocumentView {
  const { form } = options
  const arabic = options.arabic ?? {}

  assertPrintable(stored)
  if (isInvoiceForm(form)) assertInvoiceFormPermitted(stored, form)

  const lines: readonly DocumentLine[] = stored.lines.map((line) => ({
    descriptionEn: line.descriptionEn,
    descriptionAr: line.descriptionAr ?? arabic.lineDescriptions?.[line.lineNo],
    quantity: line.quantity,
    unitGross: money(filsFrom(line.unitGrossFils)),
    net: money(filsFrom(line.netFils)),
    vat: money(filsFrom(line.vatFils)),
    gross: money(filsFrom(line.lineGrossFils)),
    rateBp: vatRateBp(line.vatRateBp),
  }))

  const byRate = subtotalsByRate(lines)

  return {
    form,
    documentNumber: stored.displayNumber,
    seriesCode: stored.seriesCode,
    periodKey: stored.periodKey,
    issueDate: localDate(stored.issueDate),
    taxPointDate: localDate(stored.taxPointDate),
    issuer: buildIssuer(stored, form, arabic),
    customer: buildCustomer(stored, form, arabic),
    lines,
    totals: {
      // The stored header columns, printed as stored. Not `sumStored(...)`, although
      // assertFigureAgreement() has just proved the two are equal: if they ever stop being equal the
      // document must fail rather than quietly print the sum, and printing the sum here is how that
      // failure would be hidden.
      net: money(filsFrom(stored.netTotalFils)),
      vat: money(filsFrom(stored.vatTotalFils)),
      gross: money(filsFrom(stored.grossTotalFils)),
      byRate,
    },
    notes: stored.notes ?? undefined,
    notesAr: arabic.notes,
    singleRateBp: byRate.length === 1 ? byRate[0]?.rateBp : undefined,
  }
}
