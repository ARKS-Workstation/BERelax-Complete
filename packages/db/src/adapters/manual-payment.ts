import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { journalError, postJournalEntry } from '../repositories/journal.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The manual tender adapter: taking money at the till, and giving it back.
 *
 * Real, not a fake. It is the only implementation of {@link PaymentAdapter} today and it does the whole
 * job — it records the tender, hands back change, posts the entry and refuses an overpayment — because a
 * "manual adapter" that only stood in for a gateway would mean the cash, card and transfer the business
 * actually takes went through something nobody tested.
 *
 * ## It makes no network calls, and that is enforced rather than intended
 *
 * `dependency-cruiser`'s `payments-must-not-reach-the-network` rule forbids every HTTP client and every
 * socket module under `packages/db/src/adapters/`, and `scripts/test-boundaries.mjs` plus gate block 92
 * each write a known-bad fixture that must be rejected by that rule name. `manual-payment.itest.ts`
 * then runs the adapter with `fetch`, `http.request` and `https.request` replaced by throwing stubs and
 * requires it to succeed, with a control proving the sabotage bites.
 *
 * The reason is not tidiness. Money is being recorded, and a module that could reach out over the
 * network is a module whose failure mode is a payment recorded in one place and not the other. Y-PAY's
 * adapter WILL make network calls; it will live under `packages/providers`, behind this interface, and
 * the rule keeps that boundary where it can be seen.
 *
 * ## The interface is defined by what a card gateway needs
 *
 * `authorise`, `capture`, `refund`, `reconcileWebhook` — the four things a card gateway does, and not
 * one member that only makes sense for cash. `manual-payment.test.ts` asserts that: the members are
 * enumerated in {@link PAYMENT_ADAPTER_MEMBERS}, a type-level check holds that list exactly equal to
 * `keyof PaymentAdapter` so it cannot go stale, and no member name may mention a drawer, a float, a
 * note or change. A cash-shaped interface is the thing that makes the gateway's adapter a set of
 * no-op methods and a comment apologising for them.
 *
 * The manual adapter implements all four honestly:
 *
 *   - `authorise` — checks what the document can still take, and reserves nothing. There is nothing to
 *     reserve: the customer is standing there with the money.
 *   - `capture` — records the `payment` rows, the change, and posts `Dr tender / Cr 1050`.
 *   - `refund` — records a `refund` row and posts the reverse. It refuses without a credit note.
 *   - `reconcileWebhook` — answers "no such payment reference is pending" for every input, because
 *     nothing ever is. Stated as an answer rather than a `throw`: a gateway that mis-routes a webhook to
 *     the manual adapter must get a usable "not mine", not a 500.
 *
 * ## What a payment posts, and what it does not
 *
 * `Dr` the tender's own account at what the tender **applied**, `Cr 1050 Trade receivables`. The change
 * handed back never reaches the journal, which is why `applied_fils` exists: the money that stayed is
 * what moved. So the receivable a document raised is settled by the payment, and the debit to `1050`
 * that raised it belongs to whoever issued the unpaid document.
 *
 * A finalised **checkout** does not come through here. `finaliseCheckout` debits the tender accounts
 * directly against revenue in one transaction, because the customer paid in full at the counter, and
 * `ZT001` is what stops a second payment being recorded against such a document: it is already paid up
 * to what it is payable for, so its outstanding figure is zero and a payment through this adapter is an
 * overpayment. That refusal is deliberate and it is the useful direction — the mistake it catches is a
 * till operator taking payment twice for one sale.
 *
 * A refund posts the reverse — `Dr 1050`, `Cr` the tender account — and is a NEW entry with its own
 * `entryDate`, never an edit of the sale's. The credit note that authorises it posts the other half of
 * the correction (`Dr` revenue and output VAT, `Cr 1050`), which is M-TILL-08's.
 */

/**
 * `1050 Trade receivables`, spelled here because `packages/db` may never import `packages/core`.
 *
 * `postBill` states `TRADE_PAYABLES_ACCOUNT_CODE = '2010'` in this package for the same reason and it is
 * the same trade-off: the code is a literal in two packages, and the pair is asserted together in
 * `packages/fixtures/src/payment.itest.ts`, which may depend on both.
 */
export const TRADE_RECEIVABLES_ACCOUNT_CODE = '1050'

/** The SQLSTATEs `0068_payment_tender.sql` raises. Matched on the code, never on the message. */
export const PAYMENT_SQLSTATE = {
  /** The payments applied to a document exceed what it is payable for. Deferred to COMMIT. */
  overpayment: 'ZT001',
  /** Change recorded against a tender type that gives none. */
  changeOnATenderThatGivesNone: 'ZT002',
  /** A tender of a type that requires a reference carries none, or names no registered type. */
  tenderReference: 'ZT003',
  /** The refunds against a document exceed what was applied to it. Deferred to COMMIT. */
  refundExceedsPayments: 'ZT004',
} as const

/** `23503`: a tender named a type the registry does not hold. */
const FOREIGN_KEY_VIOLATION = '23503'
/** `23505`: a tender number or a refund number used twice on one document. */
const UNIQUE_VIOLATION = '23505'

/** The constraints `0068_payment_tender.sql` adds, by name. */
export const PAYMENT_CONSTRAINT = {
  /** 0063's CHECK, now a foreign key into `tender_type` — and deliberately under the same name. */
  tenderKindKnown: 'payment_tender_kind_known',
  refundTenderKindKnown: 'refund_tender_kind_known',
  changeNotMoreThanTendered: 'payment_change_not_more_than_tendered',
  oneRowPerTender: 'payment_one_row_per_tender',
  oneRowPerRefund: 'refund_one_row_per_number',
} as const

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

const constraintName = (err: unknown): string | undefined => {
  const name = (err as { constraint_name?: unknown } | null)?.constraint_name
  if (typeof name === 'string') return name
  const carried = (err as { details?: { constraint?: unknown } } | null)?.details?.constraint
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Raised when a payment would take a document above what it is payable for.
 *
 * Stated in two layers, for `postBill`'s reason. This one refuses **before** anything is written and
 * names the figures, which is the layer a person reads; `ZT001` is a DEFERRED constraint trigger and is
 * the layer that holds when two tills take payment for one document at the same moment — a check that
 * reads a total and then writes has a gap, and the second tap lands in it.
 *
 * "Payable for" is the document's gross **plus** the gratuity its own posting collected: a tip is not
 * consideration for a supply, so it is on no tax invoice and absent from `gross_total`, and the customer
 * handed it over all the same.
 */
export class Overpayment extends AppError {
  readonly payableFils: number
  readonly appliedFils: number
  constructor(invoiceId: string, payableFils: number, appliedFils: number, offeredFils: number) {
    super(
      'conflict',
      `Overpayment: invoice ${invoiceId} is payable for ${payableFils} fils and has ${appliedFils} ` +
        `already applied, so ${payableFils - appliedFils} fils is outstanding and ${offeredFils} was ` +
        'offered. The answer to money genuinely over-collected is change recorded on the tender, or a ' +
        'credit note — never a payment that takes a document above its own value.',
      { details: { invoiceId, payableFils, appliedFils, offeredFils, sqlState: 'ZT001' } },
    )
    this.name = 'Overpayment'
    this.payableFils = payableFils
    this.appliedFils = appliedFils
  }
}

/**
 * Raised when a refund names no credit note.
 *
 * The one refusal this module exists to make impossible to route around. An issued invoice is never
 * edited or voided; a correction is a credit note (docs/04 §4), and that is only true while money cannot
 * leave the business against an invoice alone. `refund.credit_note_id` is NOT NULL, so the database
 * refuses it too — this is the layer that says which id is missing before a statutory number is
 * allocated for the entry.
 */
export class RefundRequiresCreditNote extends AppError {
  constructor(invoiceId: string) {
    super(
      'validation',
      `RefundRequiresCreditNote: a refund against invoice ${invoiceId} named no credit note. A refund ` +
        'from an invoice alone is money leaving the business with no document behind it, which is the ' +
        'invoice-void path under another name (docs/04 §4). Issue the credit note first (M-TILL-08) ' +
        'and refund against it.',
      { details: { invoiceId } },
    )
    this.name = 'RefundRequiresCreditNote'
  }
}

/** Raised when the refunds against a document would exceed what was applied to it. */
export class RefundExceedsPayments extends AppError {
  constructor(invoiceId: string, appliedFils: number, refundedFils: number, offeredFils: number) {
    super(
      'conflict',
      `RefundExceedsPayments: invoice ${invoiceId} has ${appliedFils} fils applied and ` +
        `${refundedFils} already refunded, and ${offeredFils} more was asked for. Refunding money ` +
        'that was never taken is not a correction of anything.',
      { details: { invoiceId, appliedFils, refundedFils, offeredFils, sqlState: 'ZT004' } },
    )
    this.name = 'RefundExceedsPayments'
  }
}

/** Raised when a tender names a type `tender_type` does not hold. */
export class TenderTypeNotRegistered extends AppError {
  constructor(kind: string) {
    super(
      'validation',
      `TenderTypeNotRegistered: "${kind}" is not in the tender-type registry. Adding a way of taking ` +
        'money is a migration: it needs a posting account, and whether it may give change is a ' +
        'decision about the drawer rather than a form field.',
      { details: { kind, sqlState: FOREIGN_KEY_VIOLATION } },
    )
    this.name = 'TenderTypeNotRegistered'
  }
}

/**
 * Translates a PostgreSQL error raised by the payment schema into an `AppError`, or `null`.
 *
 * Falls through to {@link journalError}, because a payment posts an entry and a locked period or an
 * unknown account arrives from there. Exported for the same reason `journalError` is: `ZT001` and
 * `ZT004` are DEFERRED and therefore arrive from COMMIT, which is outside every function here, so a
 * caller composing this adapter into a larger transaction is the layer that sees them.
 */
export function paymentError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case PAYMENT_SQLSTATE.overpayment:
      return new AppError('conflict', message, { details: { sqlState: code } })
    case PAYMENT_SQLSTATE.refundExceedsPayments:
      return new AppError('conflict', message, { details: { sqlState: code } })
    case PAYMENT_SQLSTATE.changeOnATenderThatGivesNone:
    case PAYMENT_SQLSTATE.tenderReference:
      return new AppError('validation', message, { details: { sqlState: code } })
    case FOREIGN_KEY_VIOLATION: {
      const constraint = constraintName(err)
      if (
        constraint === PAYMENT_CONSTRAINT.tenderKindKnown ||
        constraint === PAYMENT_CONSTRAINT.refundTenderKindKnown
      ) {
        return new AppError('validation', message, {
          details: { sqlState: code, constraint },
        })
      }
      return null
    }
    case UNIQUE_VIOLATION: {
      const constraint = constraintName(err)
      if (
        constraint === PAYMENT_CONSTRAINT.oneRowPerTender ||
        constraint === PAYMENT_CONSTRAINT.oneRowPerRefund
      ) {
        return new AppError('conflict', message, { details: { sqlState: code, constraint } })
      }
      return null
    }
    default:
      return journalError(err)
  }
}

/** True when `err` is the `ZT001` overpayment ceiling. */
export function isOverpayment(err: unknown): boolean {
  return sqlState(err) === PAYMENT_SQLSTATE.overpayment
}

/** True when `err` is the `ZT004` refund ceiling. */
export function isRefundExceedingPayments(err: unknown): boolean {
  return sqlState(err) === PAYMENT_SQLSTATE.refundExceedsPayments
}

/** One way the business takes money, as the registry holds it. */
export interface RegisteredTenderType {
  readonly code: string
  readonly label: string
  readonly postingAccountCode: string
  readonly givesChange: boolean
  readonly requiresReference: boolean
  readonly settlesImmediately: boolean
  readonly adapter: string
  readonly sortOrder: number
  readonly retiredAt: Date | null
}

/** What a document has been tendered, applied, given back and still owes. Reads `invoice_settlement`. */
export interface InvoiceSettlement {
  readonly invoiceId: string
  readonly displayNumber: string
  /** The document's own gross. Excludes a gratuity, which is on no tax invoice. */
  readonly grossFils: number
  /** The gross plus the gratuity the document's posting collected: what it may be paid in total. */
  readonly payableFils: number
  readonly tenderedFils: number
  readonly changeGivenFils: number
  readonly appliedFils: number
  readonly refundedFils: number
  /**
   * `payableFils - appliedFils`. Exactly the figure `ZT001` refuses to let go negative.
   *
   * Deliberately NOT reduced by credit notes, which is the question 0068 left to M-TILL-08 and the
   * answer 0072 gave: lowering this under payments that have already been applied would make a payment
   * reconciled against a counted drawer read as an overpayment, and the cash in that drawer would stop
   * being explainable by any row. What a credit note changes is {@link receivableFils}.
   */
  readonly outstandingFils: number
  /** 0072. What the credit notes against this document take off it, positive fils. */
  readonly creditedFils: number
  /**
   * `payableFils - creditedFils - appliedFils + refundedFils`: what the customer still owes.
   *
   * NEGATIVE when the business holds money it owes back — a document paid in full and then credited in
   * full — which is the honest reading rather than a defect.
   */
  readonly receivableFils: number
}

/** One tender to record, already settled against the outstanding figure by `settleTenders` in core. */
export interface TenderToRecord {
  /** A code from `tender_type`. */
  readonly tenderKind: string
  /** Snapshotted onto the row from the registry. */
  readonly postingAccountCode: string
  /** What the customer handed over. Strictly positive. */
  readonly amountFils: number
  /** What was handed back. Zero unless the type gives change. Never netted into `amountFils`. */
  readonly changeGivenFils?: number
  readonly reference?: string | null
}

export interface CapturePaymentInput {
  readonly invoiceId: string
  /** The business day, `YYYY-MM-DD`, resolved with `resolveTradingDate`. Never a calendar date. */
  readonly tradingDate: string
  /** Allocated by the caller, like every entry id in this system. */
  readonly entryId: string
  readonly tenders: readonly TenderToRecord[]
  /** Overrides the default, which names the document and counts the tenders. */
  readonly narrative?: string
}

export interface RecordedPayment {
  readonly id: string
  readonly invoiceId: string
  readonly tenderNo: number
  readonly tenderKind: string
  readonly postingAccountCode: string
  readonly amountFils: number
  readonly changeGivenFils: number
  /** `amountFils - changeGivenFils`, read back from the generated column rather than recomputed. */
  readonly appliedFils: number
  readonly reference: string | null
  readonly tradingDate: string
  readonly receivedAt: Date
}

export interface CapturedPayment {
  readonly invoiceId: string
  readonly journalEntryId: string
  readonly payments: readonly RecordedPayment[]
  readonly appliedFils: number
  readonly changeGivenFils: number
  /** What the document still owes after this capture. Zero when it is settled. */
  readonly outstandingFils: number
}

export interface RefundInput {
  readonly invoiceId: string
  /**
   * The credit note that authorises this refund. **Required.**
   *
   * `undefined` and the empty string are both refused with {@link RefundRequiresCreditNote} before the
   * database is touched, which is what the export-surface test in `manual-payment.test.ts` proves: no
   * exported function here can create a refund from an invoice alone.
   */
  readonly creditNoteId?: string | null
  readonly tradingDate: string
  readonly entryId: string
  readonly tenderKind: string
  readonly postingAccountCode: string
  readonly amountFils: number
  readonly reference?: string | null
  readonly narrative?: string
}

export interface RecordedRefund {
  readonly id: string
  readonly invoiceId: string
  readonly creditNoteId: string
  readonly refundNo: number
  readonly tenderKind: string
  readonly postingAccountCode: string
  readonly amountFils: number
  readonly reference: string | null
  readonly tradingDate: string
  readonly refundedAt: Date
  readonly journalEntryId: string
}

/** What `authorise` answers: whether this document can take that money, and what is left. */
export interface Authorisation {
  readonly invoiceId: string
  readonly outstandingFils: number
  readonly offeredFils: number
  /** True when the whole offer fits inside the outstanding figure. */
  readonly acceptable: boolean
}

/** What `reconcileWebhook` answers. */
export interface WebhookReconciliation {
  /** `matched` for a payment this adapter recognises, `not_mine` for one it never took. */
  readonly outcome: 'matched' | 'not_mine'
  readonly reason: string
}

/**
 * The port a card gateway implements, and the manual adapter does too.
 *
 * Four members, each named after something a gateway does. Nothing here is cash-specific: there is no
 * `openDrawer`, no `floatCount`, no `changeDue`, and `manual-payment.test.ts` asserts that by name
 * rather than by review. An interface shaped around the drawer is the shape in which a gateway's
 * implementation becomes four no-ops and an apology.
 *
 * Every method takes a {@link UnitOfWork} except `authorise`, which reads. The write methods therefore
 * compose into a caller's transaction, which is the convention everywhere in `packages/db` except
 * `finaliseCheckout` — and that one has a structural reason this does not.
 */
export interface PaymentAdapter {
  /** The adapter's registry name, matching `tender_type.adapter`. */
  readonly name: string
  /**
   * Can this document take this money, and what is outstanding?
   *
   * Reserves nothing for the manual adapter — the customer is standing there with the money, so there
   * is nothing to hold — and is a real authorisation hold for a gateway.
   */
  authorise(sql: Sql, input: { invoiceId: string; offeredFils: number }): Promise<Authorisation>
  /** Records the money and posts the entry. */
  capture(uow: UnitOfWork, input: CapturePaymentInput): Promise<CapturedPayment>
  /** Sends money back against a credit note, and posts the reverse entry. */
  refund(uow: UnitOfWork, input: RefundInput): Promise<RecordedRefund>
  /**
   * Answers an inbound settlement notification.
   *
   * The manual adapter never has one pending, and says so rather than throwing: a gateway webhook
   * mis-routed here has to get a usable "not mine" instead of a 500 that gets retried for a day.
   */
  reconcileWebhook(
    uow: UnitOfWork,
    notification: { reference: string; amountFils: number },
  ): Promise<WebhookReconciliation>
}

/**
 * Every member of {@link PaymentAdapter}, enumerated so a test can read them at runtime.
 *
 * A TypeScript interface does not exist at run time, so "the interface has no cash-specific member" can
 * only be asserted over a value. {@link PaymentAdapterMembersAreExact} below holds this list exactly
 * equal to `keyof PaymentAdapter` in both directions, so a member added to the interface and not to this
 * tuple fails `tsc` — which is what stops the assertion going vacuous.
 */
export const PAYMENT_ADAPTER_MEMBERS = [
  'name',
  'authorise',
  'capture',
  'refund',
  'reconcileWebhook',
] as const

type Member = (typeof PAYMENT_ADAPTER_MEMBERS)[number]
/**
 * Fails to compile unless {@link PAYMENT_ADAPTER_MEMBERS} names exactly the members of
 * {@link PaymentAdapter}. Both directions: a missing name and a surplus one are each an error.
 */
export type PaymentAdapterMembersAreExact = [Member] extends [keyof PaymentAdapter]
  ? [keyof PaymentAdapter] extends [Member]
    ? true
    : never
  : never
export const PAYMENT_ADAPTER_MEMBERS_ARE_EXACT: PaymentAdapterMembersAreExact = true

interface PaymentRow {
  readonly id: string
  readonly invoice_id: string
  readonly tender_no: number
  readonly tender_kind: string
  readonly posting_account_code: string
  readonly amount_fils: string
  readonly change_given_fils: string
  readonly applied_fils: string
  readonly reference: string | null
  readonly trading_date: string
  readonly received_at: Date
}

// The driver returns bigint as a string so a fils amount cannot lose precision in transit; `Number()` is
// applied once, here, where the value re-enters TypeScript.
function toPayment(row: PaymentRow): RecordedPayment {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    tenderNo: row.tender_no,
    tenderKind: row.tender_kind,
    postingAccountCode: row.posting_account_code,
    amountFils: Number(row.amount_fils),
    changeGivenFils: Number(row.change_given_fils),
    appliedFils: Number(row.applied_fils),
    reference: row.reference,
    tradingDate: row.trading_date,
    receivedAt: row.received_at,
  }
}

/** The tender-type registry, in the order a till offers it. Retired types included, and flagged. */
export async function readTenderTypes(sql: Sql): Promise<readonly RegisteredTenderType[]> {
  const rows = await sql<
    {
      code: string
      label: string
      posting_account_code: string
      gives_change: boolean
      requires_reference: boolean
      settles_immediately: boolean
      adapter: string
      sort_order: number
      retired_at: Date | null
    }[]
  >`
    select code, label, posting_account_code, gives_change, requires_reference,
           settles_immediately, adapter, sort_order, retired_at
      from tender_type order by sort_order
  `
  return rows.map((row) => ({
    code: row.code,
    label: row.label,
    postingAccountCode: row.posting_account_code,
    givesChange: row.gives_change,
    requiresReference: row.requires_reference,
    settlesImmediately: row.settles_immediately,
    adapter: row.adapter,
    sortOrder: row.sort_order,
    retiredAt: row.retired_at,
  }))
}

/**
 * What a document has been paid, from the `invoice_settlement` view.
 *
 * A view and not a stored column, for the reason `leave_balance` is one (0066): a stored paid total
 * disagrees with the payments the first time one is corrected. Counted in SQL rather than by summing a
 * paged read, which is the defect `settings-store.itest.ts` recorded — a limit is right for a panel and
 * wrong for a total.
 */
export async function readInvoiceSettlement(
  sql: Sql,
  invoiceId: string,
): Promise<InvoiceSettlement | null> {
  const [row] = await sql<
    {
      invoice_id: string
      display_number: string
      gross_fils: string
      payable_fils: string
      tendered_fils: string
      change_given_fils: string
      applied_fils: string
      refunded_fils: string
      outstanding_fils: string
      credited_fils: string
      receivable_fils: string
    }[]
  >`
    select invoice_id, display_number, gross_fils, payable_fils, tendered_fils, change_given_fils,
           applied_fils, refunded_fils, outstanding_fils, credited_fils, receivable_fils
      from invoice_settlement where invoice_id = ${invoiceId}
  `
  if (!row) return null
  return {
    invoiceId: row.invoice_id,
    displayNumber: row.display_number,
    grossFils: Number(row.gross_fils),
    payableFils: Number(row.payable_fils),
    tenderedFils: Number(row.tendered_fils),
    changeGivenFils: Number(row.change_given_fils),
    appliedFils: Number(row.applied_fils),
    refundedFils: Number(row.refunded_fils),
    outstandingFils: Number(row.outstanding_fils),
    // 0072's two columns. One reader of one view: a second `readInvoiceSettlement` in the credit-note
    // service would have been a second answer to "what has this document been paid", which is the
    // whole reason 0063 refused a second money-received table.
    creditedFils: Number(row.credited_fils),
    receivableFils: Number(row.receivable_fils),
  }
}

/** The settlement, or an error naming the document. Used wherever a missing document is a caller bug. */
async function requireSettlement(sql: Sql, invoiceId: string): Promise<InvoiceSettlement> {
  const settlement = await readInvoiceSettlement(sql, invoiceId)
  if (settlement === null) {
    throw new AppError(
      'not_found',
      `no invoice ${invoiceId}. Money cannot be taken against a document that does not exist: the ` +
        'payment would be unattributable the moment the drawer was counted.',
      { details: { invoiceId } },
    )
  }
  return settlement
}

function requireTradingDate(field: string, value: string): void {
  if (!ISO_DATE.test(value)) {
    throw new AppError(
      'validation',
      `${field} must be an ISO business day (YYYY-MM-DD), received "${value}". Trading runs ` +
        '11:00-02:00, so a 01:30 payment belongs to the previous trading date and the cash-up that ' +
        'reconciles it cuts on this column.',
    )
  }
}

function requireWholePositiveFils(what: string, fils: number): void {
  if (!Number.isInteger(fils) || fils <= 0) {
    // The `fils_nonneg` domain is bigint, so PostgreSQL would ROUND a fractional value rather than
    // refuse it, and half a fils reconciled against a drawer cannot be explained by anyone.
    throw new AppError(
      'validation',
      `${what} is ${fils} fils, which is not a whole positive amount`,
    )
  }
}

/**
 * Everything about a capture that can be refused from the arguments alone.
 *
 * Separate from `capture` so the refusals read as a list rather than as the first third of a long
 * method, and because every one of them must happen BEFORE a statutory entry id is used: failing here
 * is the difference between a rejected request and a rolled-back allocation.
 */
function requireCapturable(input: CapturePaymentInput): void {
  requireTradingDate('capture: tradingDate', input.tradingDate)
  if (input.tenders.length === 0) {
    throw new AppError(
      'validation',
      `capture: invoice ${input.invoiceId} was given no tender. A capture that collected nothing is ` +
        'not a payment, and it would post an entry with no debit.',
    )
  }
  for (const [index, tender] of input.tenders.entries()) {
    requireWholePositiveFils(`tender ${index + 1} (${tender.tenderKind})`, tender.amountFils)
    const change = tender.changeGivenFils ?? 0
    if (!Number.isInteger(change) || change < 0) {
      throw new AppError(
        'validation',
        `capture: tender ${index + 1} (${tender.tenderKind}) gives ${change} fils of change`,
      )
    }
    if (change > tender.amountFils) {
      throw new AppError(
        'validation',
        `capture: tender ${index + 1} (${tender.tenderKind}) hands back ${change} fils out of ` +
          `${tender.amountFils} tendered`,
      )
    }
  }
}

/** The next tender number for a document. Read inside the transaction; the UNIQUE is the authority. */
async function nextTenderNo(uow: UnitOfWork, invoiceId: string): Promise<number> {
  const [row] = await uow.sql<{ next: string }[]>`
    select coalesce(max(tender_no), 0)::text as next from payment where invoice_id = ${invoiceId}
  `
  return Number(row?.next ?? 0) + 1
}

async function nextRefundNo(uow: UnitOfWork, invoiceId: string): Promise<number> {
  const [row] = await uow.sql<{ next: string }[]>`
    select coalesce(max(refund_no), 0)::text as next from refund where invoice_id = ${invoiceId}
  `
  return Number(row?.next ?? 0) + 1
}

/**
 * The manual tender adapter.
 *
 * A function returning the object rather than a module-level constant, so a test can hold two and so the
 * adapter's name is a value rather than a string repeated at every call site.
 */
export function manualPaymentAdapter(): PaymentAdapter {
  return {
    name: 'manual',

    async authorise(sql, input) {
      requireWholePositiveFils('the amount offered', input.offeredFils)
      const settlement = await requireSettlement(sql, input.invoiceId)
      return {
        invoiceId: input.invoiceId,
        outstandingFils: settlement.outstandingFils,
        offeredFils: input.offeredFils,
        acceptable: input.offeredFils <= settlement.outstandingFils,
      }
    },

    async capture(uow, input) {
      requireCapturable(input)

      const settlement = await requireSettlement(uow.sql, input.invoiceId)
      const appliedFils = input.tenders.reduce(
        (total, tender) => total + tender.amountFils - (tender.changeGivenFils ?? 0),
        0,
      )
      const changeGivenFils = input.tenders.reduce(
        (total, tender) => total + (tender.changeGivenFils ?? 0),
        0,
      )
      if (appliedFils > settlement.outstandingFils) {
        // Refused here so the message names the figures; `ZT001` is the layer that holds under two
        // tills taking payment for one document at once.
        throw new Overpayment(
          input.invoiceId,
          settlement.payableFils,
          settlement.appliedFils,
          appliedFils,
        )
      }

      const firstTenderNo = await nextTenderNo(uow, input.invoiceId)
      const payments: RecordedPayment[] = []
      for (const [index, tender] of input.tenders.entries()) {
        // One statement per tender, like `issueInvoice`'s lines: a multi-row INSERT would hide a
        // per-tender refusal behind whichever row the planner reached first.
        const [row] = await uow.sql<PaymentRow[]>`
          insert into payment (
            invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
            change_given_fils, reference, trading_date
          ) values (
            ${input.invoiceId}, ${firstTenderNo + index}, ${tender.tenderKind},
            ${tender.postingAccountCode}, ${tender.amountFils}, ${tender.changeGivenFils ?? 0},
            ${tender.reference ?? null}, ${input.tradingDate}::date
          )
          returning id, invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                    change_given_fils, applied_fils, reference,
                    trading_date::text as trading_date, received_at
        `
        if (!row) throw new AppError('invariant_violated', 'insert into payment returned no row')
        payments.push(toPayment(row))
      }

      // Dr each tender account at what it APPLIED, Cr 1050 at the total. The change never reaches the
      // journal: the money that stayed is the money that moved, which is why `applied_fils` exists.
      // Merged per account for the reason `checkoutPosting` merges: the per-tender detail is on the
      // `payment` rows, and an entry with one line per tender is rows nobody reconciles.
      const perAccount = new Map<string, number>()
      for (const payment of payments) {
        perAccount.set(
          payment.postingAccountCode,
          (perAccount.get(payment.postingAccountCode) ?? 0) + payment.appliedFils,
        )
      }
      const lines = [...perAccount.entries()]
        // Sorted by account code, for `trialBalance`'s reason: two runs over one capture produce
        // byte-identical working papers.
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([accountCode, debitFils]) => ({
          accountCode,
          debitFils,
          creditFils: 0,
          memo: `Payment received (${payments
            .filter((payment) => payment.postingAccountCode === accountCode)
            .map((payment) => payment.tenderKind)
            .join(', ')})`,
        }))
      lines.push({
        accountCode: TRADE_RECEIVABLES_ACCOUNT_CODE,
        debitFils: 0,
        creditFils: appliedFils,
        memo: `Settled against ${settlement.displayNumber}`,
      })

      const entry = await postJournalEntry(uow, {
        entryId: input.entryId,
        entryDate: input.tradingDate,
        narrative:
          input.narrative ??
          `Payment on ${settlement.displayNumber}: ${payments.length} tender(s), ${appliedFils} fils ` +
            'applied',
        source: 'payment',
        lines,
      })

      await uow.audit.record({
        action: 'payment.capture',
        entityType: 'payment',
        entityId: input.invoiceId,
        operation: 'create',
        // No `before`: a payment has no prior version, and a fabricated one would be a record of
        // something that never existed.
        after: { payments, appliedFils, changeGivenFils, journalEntryId: entry.entryId },
      })

      await uow.publish({
        eventType: 'payment.recorded',
        aggregateType: 'invoice',
        aggregateId: input.invoiceId,
        payload: {
          displayNumber: settlement.displayNumber,
          journalEntryId: entry.entryId,
          tradingDate: input.tradingDate,
          appliedFils,
          changeGivenFils,
          outstandingFils: settlement.outstandingFils - appliedFils,
          tenders: payments.map((payment) => ({
            tenderKind: payment.tenderKind,
            amountFils: payment.amountFils,
            changeGivenFils: payment.changeGivenFils,
            appliedFils: payment.appliedFils,
            postingAccountCode: payment.postingAccountCode,
          })),
        },
        // Derived from the business fact — the document and the tender numbers this capture wrote — so
        // a retry of one capture cannot enqueue twice and neither can a second drain. Not random: a
        // random key is a key that deduplicates nothing.
        idempotencyKey:
          `payment.recorded:${settlement.displayNumber}:` +
          `${payments.map((payment) => payment.tenderNo).join('-')}`,
      })

      return {
        invoiceId: input.invoiceId,
        journalEntryId: entry.entryId,
        payments,
        appliedFils,
        changeGivenFils,
        outstandingFils: settlement.outstandingFils - appliedFils,
      }
    },

    async refund(uow, input) {
      // FIRST, and before anything else is validated: a refund with no credit note is refused before
      // the database is reached at all. `manual-payment.test.ts` proves it by passing a `sql` that
      // throws if it is touched, with a control showing that a refund WITH a credit note does reach it.
      const creditNoteId = input.creditNoteId?.trim() ?? ''
      if (creditNoteId === '') throw new RefundRequiresCreditNote(input.invoiceId)

      requireTradingDate('refund: tradingDate', input.tradingDate)
      requireWholePositiveFils('the refund', input.amountFils)

      const settlement = await requireSettlement(uow.sql, input.invoiceId)
      if (settlement.refundedFils + input.amountFils > settlement.appliedFils) {
        throw new RefundExceedsPayments(
          input.invoiceId,
          settlement.appliedFils,
          settlement.refundedFils,
          input.amountFils,
        )
      }

      const refundNo = await nextRefundNo(uow, input.invoiceId)
      const [row] = await uow.sql<
        {
          id: string
          invoice_id: string
          credit_note_id: string
          refund_no: number
          tender_kind: string
          posting_account_code: string
          amount_fils: string
          reference: string | null
          trading_date: string
          refunded_at: Date
        }[]
      >`
        insert into refund (
          invoice_id, credit_note_id, refund_no, tender_kind, posting_account_code, amount_fils,
          reference, trading_date
        ) values (
          ${input.invoiceId}, ${creditNoteId}, ${refundNo}, ${input.tenderKind},
          ${input.postingAccountCode}, ${input.amountFils}, ${input.reference ?? null},
          ${input.tradingDate}::date
        )
        returning id, invoice_id, credit_note_id, refund_no, tender_kind, posting_account_code,
                  amount_fils, reference, trading_date::text as trading_date, refunded_at
      `
      if (!row) throw new AppError('invariant_violated', 'insert into refund returned no row')

      // The reverse of a payment, as a NEW entry: Dr 1050, Cr the tender account. Never an edit of the
      // sale's entry — `journal_entry` refuses UPDATE for every role including the owner (ADR 0017),
      // and a correction that edited history would leave the filed period disagreeing with itself.
      const entry = await postJournalEntry(uow, {
        entryId: input.entryId,
        entryDate: input.tradingDate,
        narrative:
          input.narrative ??
          `Refund on ${settlement.displayNumber} against credit note ${creditNoteId}`,
        source: 'refund',
        lines: [
          {
            accountCode: TRADE_RECEIVABLES_ACCOUNT_CODE,
            debitFils: input.amountFils,
            creditFils: 0,
            memo: `Refunded against ${settlement.displayNumber}`,
          },
          {
            accountCode: input.postingAccountCode,
            debitFils: 0,
            creditFils: input.amountFils,
            memo: `Refund paid out (${input.tenderKind})`,
          },
        ],
      })

      const refunded: RecordedRefund = {
        id: row.id,
        invoiceId: row.invoice_id,
        creditNoteId: row.credit_note_id,
        refundNo: row.refund_no,
        tenderKind: row.tender_kind,
        postingAccountCode: row.posting_account_code,
        amountFils: Number(row.amount_fils),
        reference: row.reference,
        tradingDate: row.trading_date,
        refundedAt: row.refunded_at,
        journalEntryId: entry.entryId,
      }

      await uow.audit.record({
        action: 'payment.refund',
        entityType: 'refund',
        entityId: refunded.id,
        operation: 'create',
        after: refunded,
      })

      await uow.publish({
        eventType: 'payment.refunded',
        aggregateType: 'invoice',
        aggregateId: input.invoiceId,
        payload: {
          displayNumber: settlement.displayNumber,
          creditNoteId: refunded.creditNoteId,
          journalEntryId: entry.entryId,
          tradingDate: refunded.tradingDate,
          amountFils: refunded.amountFils,
          tenderKind: refunded.tenderKind,
        },
        idempotencyKey: `payment.refunded:${settlement.displayNumber}:${refundNo}`,
      })

      return refunded
    },

    async reconcileWebhook(_uow, notification) {
      // Nothing is ever pending here, and saying so is the honest answer. A `throw` would turn a
      // gateway's mis-routed webhook into a 500 that gets retried for a day, and the sender cannot tell
      // "I sent this to the wrong adapter" from "the right adapter is broken".
      return {
        outcome: 'not_mine',
        reason:
          `the manual adapter holds no pending authorisation, so reference "${notification.reference}" ` +
          `for ${notification.amountFils} fils is not one of its settlements. Money taken at the till ` +
          'is captured in the same request it is authorised in: there is nothing for a webhook to ' +
          'reconcile.',
      }
    },
  }
}
