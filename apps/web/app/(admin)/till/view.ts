import { type DiscountReason, DOCUMENT_FIELDS, type DocumentFieldKey } from '@berelax/core'
import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'

/**
 * What the till screen is, as data (M-TILL-13).
 *
 * The view types, the form field names and the sentences, with no HTML and no database. `render.ts` turns a
 * {@link TillView} into a document and `handler.ts` builds one; both this and `render.ts` are pure, which is
 * what lets `apps/web/src/till-render.test.ts` assert the screen byte for byte without a server.
 *
 * ## What this screen can and cannot do today, and why the refusal is the deliverable
 *
 * It can price a basket — delivered treatments pulled through, a gratuity, a discount that must say why,
 * split across up to three tenders — and it shows the balanced journal entry the basket would post, computed
 * by `checkoutPosting` in `@berelax/core`.
 *
 * It **cannot issue the document**, and the reason is not this screen's. `legal_entity.trn` holds
 * `TRN-PENDING-Y1-TRN` (Y1-trn), which fails `invoice_issuer_trn_is_fifteen_digits`,
 * `invoice_issuer_trn_not_placeholder` and `requireIssuerTrn()`. A tax invoice AND a simplified invoice both
 * state the supplier's TRN — a simplified tax invoice is still a tax document, and `invoice.document_kind`'s
 * two values share those CHECK constraints — and `payment` may only name an `invoice_id` or a
 * `package_sale_id` (`payment_settles_exactly_one_document`, 0083). **So the till cannot take money for a
 * treatment until the TRN is entered.** That is a fact about the business and not about the code: nothing
 * provisional is rendered onto a document to work around it, because a plausible TRN is indistinguishable
 * from a configured one (brief rule 15, M-TILL-12's NOTE).
 *
 * What the screen does instead is state the obligation and name the question, which is the answer M-TILL-04
 * and M-TILL-12 both give. {@link TillRefusal} carries it, {@link TillMandatoryField} shows the field list
 * with the TRN marked absent, and the ISSUE step stops at `requireIssuerSnapshot` before anything is
 * composed — so there is no half-written document for a retry to trip over.
 *
 * Money the till CAN take today is a package sale, which issues no document at all. That is `/packages`.
 *
 * ## Why there is no walk-in LINE
 *
 * "Walk-in" here is a customer with no record, not a basket line with no appointment. B-LIFE-01 makes
 * `completed` the only status that emits revenue and `invoice_appointment` is how "was this appointment
 * billed" is answered, so a chargeable line with no appointment row could never be linked and could never be
 * stopped from being billed twice. The walk-in path is therefore quick-book (which creates the booking and
 * the appointment with no customer), the treatment, and then this screen — where the line shows as `Walk-in`
 * and the basket carries `customerId: null` (ADR 0014).
 */

/** `/till`, and the preview is a state of it rather than a route of its own. */
export const TILL_PATH = '/till'
export const TILL_CASH_UP_PATH = '/till/cash-up'
export const PACKAGES_PATH = '/packages'

/**
 * The form field names, in one place.
 *
 * Short, because the whole basket travels in the request: this screen keeps no server-side session, so a
 * reload, a back button and a second tab all show the same basket, and the operator cannot lose one by
 * pressing anything. The alternative — a `basket` row written on the first keystroke — is a table of
 * abandoned baskets and a second answer to "what is being billed".
 */
export const TILL_FIELDS = {
  step: 's',
  day: 'day',
  appointment: 'a',
  tip: 'tip',
  discount: 'disc',
  discountReason: 'why',
  cash: 'cash',
  card: 'card',
  bank: 'bank',
  cardRef: 'cardref',
  bankRef: 'bankref',
  view: 'view',
  direction: 'dir',
} as const

/** `price` recomputes the basket; `issue` attempts the document and the money. */
export const TILL_STEPS = ['price', 'issue'] as const
export type TillStep = (typeof TILL_STEPS)[number]

export const TILL_VIEWS = ['till', 'preview'] as const
export type TillScreen = (typeof TILL_VIEWS)[number]

/** Exactly the statuses `BILLABLE_APPOINTMENT_STATUSES` holds. Held equal in `till-render.test.ts`. */
export const TILL_BILLABLE_STATUSES = ['completed'] as const

/** The three tender kinds, in the order the desk meets them, with the field each one's amount arrives in. */
export const TILL_TENDER_FIELDS = [
  { kind: 'cash', field: TILL_FIELDS.cash, referenceField: null, label: 'Cash' },
  {
    kind: 'card_in_salon',
    field: TILL_FIELDS.card,
    referenceField: TILL_FIELDS.cardRef,
    label: 'Card',
  },
  {
    kind: 'bank_transfer',
    field: TILL_FIELDS.bank,
    referenceField: TILL_FIELDS.bankRef,
    label: 'Bank transfer',
  },
] as const

/**
 * Why the till would not take the money, as a closed set.
 *
 * A code and not a message, so a test can assert the refusal the screen gives rather than a phrase two
 * layers might share — the defect M-TILL-09 recorded M-TILL-11 measuring, where a test asserting wording
 * both the service and the database emit passes after either is deleted.
 */
export const TILL_REFUSALS = [
  /** `legal_entity.trn` is absent or the placeholder. Y1-trn. Nothing was written. */
  'issuer_trn_not_configured',
  /** The basket has no chargeable line, so there is nothing to take. */
  'nothing_to_bill',
  /** A figure the operator typed is not a figure. */
  'not_a_figure',
  /** The tenders do not add up to the basket's gross. */
  'tender_does_not_cover',
  /** A discount was entered with no reason. */
  'discount_needs_a_reason',
  /** The day named has no `business_day` row: the premises did not trade. */
  'not_a_trading_day',
  /** The POST body was not form-encoded, or named no step. */
  'unreadable_request',
  /** Anything the services refused by name, carried through with its own sentence. */
  'refused_by_the_ledger',
] as const
export type TillRefusalCode = (typeof TILL_REFUSALS)[number]

export interface TillRefusal {
  readonly code: TillRefusalCode
  /** The sentence shown. For `refused_by_the_ledger` it is the service's own. */
  readonly sentence: string
  /** The open question the operator is waiting on, when there is one. */
  readonly openQuestionId: string | null
}

/** One delivered treatment the desk may pull through, and whether it is in the basket. */
export interface TillBillableView {
  readonly appointmentId: string
  readonly description: string
  readonly grossLabel: string
  readonly startLabel: string
  readonly customerLabel: string
  readonly inBasket: boolean
}

/** A line as the basket holds it, already priced. */
export interface TillBasketLineView {
  readonly kind: 'service' | 'discount' | 'tip' | 'package_redemption'
  readonly description: string
  readonly grossLabel: string
  readonly reason: DiscountReason | null
}

export interface TillBasketView {
  readonly lines: readonly TillBasketLineView[]
  readonly netLabel: string
  readonly vatLabel: string
  readonly documentGrossLabel: string
  readonly tipLabel: string
  readonly dueLabel: string
  readonly dueFils: number
  readonly tenderedLabel: string
  readonly outstandingLabel: string
  readonly balanced: boolean
}

/** One line of the entry the basket would post. */
export interface TillPostingLineView {
  readonly accountCode: string
  readonly memo: string
  readonly debitLabel: string
  readonly creditLabel: string
}

export interface TillPostingView {
  readonly lines: readonly TillPostingLineView[]
  readonly debitTotalLabel: string
  readonly creditTotalLabel: string
  /** `0 AED` whenever the entry balances, which `postEntry` guarantees before this is built. */
  readonly differenceLabel: string
  readonly balanced: boolean
}

/** One mandatory field of the document form, and whether the system can state it. */
export interface TillMandatoryField {
  readonly key: DocumentFieldKey
  readonly label: string
  /** The value, or null when the system holds none. */
  readonly value: string | null
  /** Set when the value is absent or a placeholder; the id is what the owner has to answer. */
  readonly openQuestionId: string | null
}

export interface TillIssuerView {
  readonly legalName: string
  readonly tradingName: string
  readonly addressLabel: string
  readonly emirate: string
  /** Null whenever the TRN is absent or the placeholder: the screen states the absence, never a stand-in. */
  readonly trn: string | null
}

/** A document that was issued, for the state after a successful checkout. */
export interface TillIssuedView {
  readonly displayNumber: string
  readonly documentKind: string
  readonly seriesCode: string
  readonly grossLabel: string
  readonly tenderLabels: readonly string[]
}

export interface TillAssumption {
  readonly what: string
  readonly openQuestionId: string
}

/** Everything the operator typed, echoed so a refusal does not empty the form. */
export interface TillForm {
  readonly day: string
  readonly appointments: readonly string[]
  readonly tip: string
  readonly discount: string
  readonly discountReason: string
  readonly cash: string
  readonly card: string
  readonly bank: string
  readonly cardRef: string
  readonly bankRef: string
}

export interface TillView {
  readonly screen: TillScreen
  readonly direction: 'ltr' | 'rtl'
  readonly chrome: AdminChrome
  /** The POST target, carrying the direction so a mirrored page stays mirrored across a submit. */
  readonly action: string
  readonly previewHref: string
  readonly tillHref: string
  readonly cashUpHref: string
  readonly packagesHref: string
  readonly dayLabel: string
  readonly tradingDate: string
  readonly lede: string
  readonly announcement: string
  readonly billable: readonly TillBillableView[]
  readonly basket: TillBasketView | null
  readonly posting: TillPostingView | null
  readonly refusal: TillRefusal | null
  readonly issued: TillIssuedView | null
  readonly issuer: TillIssuerView
  readonly mandatory: readonly TillMandatoryField[]
  readonly assumptions: readonly TillAssumption[]
  readonly form: TillForm
}

/** The sentence each refusal shows. One place, so the screen and its tests read the same words. */
export const TILL_REFUSAL_SENTENCES: Record<TillRefusalCode, string> = {
  issuer_trn_not_configured:
    'No document can be issued and no money can be taken for a treatment: the business Tax ' +
    'Registration Number has not been entered, and every invoice form states it. Nothing was written.',
  nothing_to_bill: 'There is nothing in the basket to bill.',
  not_a_figure: 'One of the amounts is not a whole number of fils.',
  tender_does_not_cover: 'The tenders do not add up to what is due.',
  discount_needs_a_reason: 'A discount has to say why it was given.',
  not_a_trading_day: 'The premises did not trade on that day, so nothing can be dated on it.',
  unreadable_request: 'That request could not be read as a till submission.',
  refused_by_the_ledger: 'The ledger refused this checkout.',
}

/** The refusal sentence, with a service's own message appended where it has one. */
export function tillRefusalSentence(code: TillRefusalCode, detail?: string): string {
  const base = TILL_REFUSAL_SENTENCES[code]
  return detail === undefined || detail === '' ? base : `${base} ${detail}`
}

/**
 * The label the preview prints for each document field.
 *
 * Every key of `DOCUMENT_FIELDS` has one, asserted in `till-render.test.ts` in BOTH directions — a key with
 * no label would print as `issuerTrn` on a screen somebody reviews, and a label for a key that no longer
 * exists is a field the preview claims the document states. That check is what makes answering
 * Y11-vat-invoice a compile-and-test failure here rather than a silent omission.
 */
export const TILL_FIELD_LABELS: Record<DocumentFieldKey, string> = {
  documentTitle: 'Document title',
  issuerLegalName: 'Supplier legal name',
  issuerTradingName: 'Supplier trading name',
  issuerAddress: 'Supplier address',
  issuerEmirate: 'Supplier emirate',
  issuerTrn: 'Supplier TRN',
  issuerPhone: 'Supplier telephone',
  documentNumber: 'Document number',
  documentSeries: 'Number series',
  issueDate: 'Date of issue',
  taxPointDate: 'Date of supply',
  customerName: 'Customer',
  customerAddress: 'Customer address',
  customerTrn: 'Customer TRN',
  lineDescription: 'Description per line',
  lineQuantity: 'Quantity per line',
  lineUnitGross: 'Unit price per line',
  lineNet: 'Net per line',
  lineVatRate: 'VAT rate per line',
  lineVat: 'VAT per line',
  lineGross: 'Gross per line',
  netTotal: 'Net total',
  vatTotal: 'VAT total',
  grossTotal: 'Gross total',
  currency: 'Currency',
  arabicText: 'Arabic text',
  notATaxInvoice: 'Not-a-tax-invoice statement',
}

/** Every field key, so the label map above can be held to it. */
export const TILL_DOCUMENT_FIELD_KEYS: readonly DocumentFieldKey[] = DOCUMENT_FIELDS
