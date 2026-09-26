import { AppError } from '@berelax/shared'
import { TRADE_RECEIVABLES_ACCOUNT_CODE } from '../adapters/manual-payment.ts'
import type { Sql } from '../connection.ts'
import type { CustomerSnapshotInput, IssuerSnapshotInput } from '../repositories/invoice.ts'
import { type JournalEntryInput, postJournalEntry } from '../repositories/journal.ts'
import { allocateDocumentNumber } from '../repositories/numbering.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The credit note service: the only write path for a correction to an issued document.
 *
 * ## There is no update, no edit, no void and no delete — here either
 *
 * `repositories/invoice.ts` exports one writer because docs/04 §4 says "Credit notes only for
 * corrections. Never edit or delete an issued invoice." This module is the other half of that
 * sentence, and it is under the same rule: one writer, two readers, and nothing whose name carries a
 * mutating verb. `issue-credit-note.test.ts` enumerates the exports and fails on one;
 * `scripts/test-no-invoice-mutation.mjs` does the same over every money module at once and would
 * notice a symbol added in a module no test happens to import.
 *
 * The database says it twice more: `berelax_app` holds no UPDATE or DELETE on either table, and a pair
 * of BEFORE triggers raises `ZD009` for every role including the owner.
 *
 * ## Why the reversing entry arrives already computed
 *
 * `packages/db` must never import `packages/core` — the dependency runs the other way — so this module
 * decides no account and rounds nothing. The caller builds the entry with `creditNoteReversal` from
 * `@berelax/core` and maps it field for field; `packages/fixtures/src/credit-note.ts` is that mapping,
 * and `packages/fixtures/src/credit-note.itest.ts` exercises the pair.
 *
 * What this module DOES do is refuse an entry that disagrees with the note it is supposed to post —
 * {@link assertReversalMatches} — and it does that **before** a statutory number is allocated. That is
 * the difference between a refused request and a rolled-back allocation, and although a rollback
 * returns the number to the pool (0013), a request that never needed one should not take the counter's
 * row lock at all. The database checks the same three facts again at COMMIT (`ZD011`), because this
 * module is not the only thing that can reach a psql prompt.
 *
 * ## The order of the two inserts is load-bearing
 *
 * The note is written BEFORE its reversal is posted, and `credit_note_reversal_fk` is DEFERRED so that
 * it can be. Post the entry first and `journal_entry`'s own period guard (`ZL002`, 0018) refuses a
 * locked period with a message about a journal entry, on a request that was about a document — and the
 * acceptance for this unit asks for a refusal that names the earliest OPEN period, which is `ZD003`,
 * on `credit_note`.
 */

/**
 * The SQLSTATEs `0072_credit_note.sql` raises.
 *
 * Class 'ZD'. 'ZC' is 0029's (canonical paths and redirects) and one class with two meanings is how a
 * caller comes to handle a redirect defect as a credit-note defect.
 */
export const CREDIT_NOTE_SQLSTATE = {
  /** The note names an invoice that does not exist. */
  withoutInvoice: 'ZD001',
  /** The note is dated before the supply it corrects. */
  beforeTheSupply: 'ZD002',
  /** The note's date is inside a locked period. The message names the earliest OPEN date. */
  periodLocked: 'ZD003',
  /** The credited line is not a line of the note's invoice. */
  withoutInvoiceLine: 'ZD004',
  /** A credit at a different unit price or rate, or a full credit whose figures are re-derived. */
  priceDisagrees: 'ZD005',
  /** The cumulative credited quantity would exceed the invoiced quantity. */
  overCredits: 'ZD006',
  /** The header's totals do not equal the sum of its lines. Raised at COMMIT. */
  totalsDisagree: 'ZD007',
  /** A note was committed with no lines. Raised at COMMIT. */
  withoutLines: 'ZD008',
  /** A credit note row was UPDATEd or DELETEd. */
  appendOnly: 'ZD009',
  /** A refund named a credit note that corrects a different invoice. */
  refundNoteMismatch: 'ZD010',
  /** The reversal is misdated, misclassified, or credits an amount the note does not state. */
  reversalDisagrees: 'ZD011',
  /** The refunds against one credit note exceed what it credits. Raised at COMMIT. */
  refundExceedsNote: 'ZD012',
} as const

/** `23514`: a CHECK refused the row — the issuer snapshot placeholders live here. */
const CHECK_VIOLATION = '23514'
/** `23505`: a number or a display number was issued twice. */
const UNIQUE_VIOLATION = '23505'
/** `23503`: the note names a journal entry or a customer the database does not have. */
const FOREIGN_KEY_VIOLATION = '23503'
/** `42501`: the application role holds no such privilege. This is the grant layer refusing. */
const INSUFFICIENT_PRIVILEGE = '42501'

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a PostgreSQL error raised by the credit-note schema into an `AppError`, or `null` if it is
 * not one of ours.
 *
 * Idempotent, for `invoiceError`'s reason: the failures that matter most here arrive from `COMMIT` and
 * are therefore translated at a different layer from the one that issued the statement.
 */
export function creditNoteError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case CREDIT_NOTE_SQLSTATE.withoutInvoice:
    case CREDIT_NOTE_SQLSTATE.beforeTheSupply:
    case CREDIT_NOTE_SQLSTATE.withoutInvoiceLine:
    case CREDIT_NOTE_SQLSTATE.priceDisagrees:
    case CREDIT_NOTE_SQLSTATE.refundNoteMismatch:
      return new AppError('validation', message, { details: { sqlState: code } })
    case CREDIT_NOTE_SQLSTATE.periodLocked:
      // `forbidden` and not `validation`: the request is well formed and the period is shut. The
      // message carries the earliest open date, which is the one thing the caller can act on.
      return new AppError('forbidden', message, { details: { sqlState: code } })
    case CREDIT_NOTE_SQLSTATE.overCredits:
    case CREDIT_NOTE_SQLSTATE.refundExceedsNote:
      return new AppError('conflict', message, { details: { sqlState: code } })
    case CREDIT_NOTE_SQLSTATE.totalsDisagree:
    case CREDIT_NOTE_SQLSTATE.withoutLines:
    case CREDIT_NOTE_SQLSTATE.reversalDisagrees:
      return new AppError('invariant_violated', message, { details: { sqlState: code } })
    case CREDIT_NOTE_SQLSTATE.appendOnly:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    case CHECK_VIOLATION:
      return new AppError('validation', message, { details: { sqlState: code } })
    case UNIQUE_VIOLATION:
      return new AppError('conflict', message, { details: { sqlState: code } })
    case FOREIGN_KEY_VIOLATION:
      return new AppError('validation', message, { details: { sqlState: code } })
    case INSUFFICIENT_PRIVILEGE:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    default:
      return null
  }
}

/** True when `err` is the append-only refusal. A note in error is answered by re-invoicing. */
export function isCreditNoteAppendOnly(err: unknown): boolean {
  return sqlState(err) === CREDIT_NOTE_SQLSTATE.appendOnly
}

/** True when `err` is the cumulative quantity ceiling. Exactly one of two racing notes sees it. */
export function isOverCredited(err: unknown): boolean {
  return sqlState(err) === CREDIT_NOTE_SQLSTATE.overCredits
}

/** True when `err` is the locked-period refusal. Its message names the earliest OPEN date. */
export function isCreditNotePeriodLocked(err: unknown): boolean {
  return sqlState(err) === CREDIT_NOTE_SQLSTATE.periodLocked
}

/** One credited line, naming the invoiced line it corrects. */
export interface CreditNoteLineInput {
  /** The `line_no` of the invoice line being credited. */
  readonly invoiceLineNo: number
  readonly descriptionEn: string
  readonly descriptionAr?: string
  /** How much of the invoiced quantity is credited. The cumulative figure is capped by `ZD006`. */
  readonly quantity: number
  /** Must equal the invoiced line's: a credit at another price is a repricing, not a correction. */
  readonly unitGrossFils: number
  readonly vatRateBp: number
  /** From `splitGross` in `@berelax/core`. A FULL credit must carry the line's own figures exactly. */
  readonly netFils: number
  readonly vatFils: number
}

export interface IssueCreditNoteInput {
  /** The document being corrected. */
  readonly invoiceId: string
  /** 'CR-NOTE'. The series' own kind must be `credit_note`. */
  readonly seriesCode: string
  readonly issuer: IssuerSnapshotInput
  readonly customer: CustomerSnapshotInput
  /** Calendar date of issue, ISO `YYYY-MM-DD`. */
  readonly issueDate: string
  /** The trading date of issue, absent when the note is raised while the premises is shut. */
  readonly issueTradingDate?: string
  /**
   * The date of the ADJUSTMENT, and the date the reversal posts under.
   *
   * Not the invoice's tax point: a note raised in October for a September invoice posts in October,
   * because September may be filed.
   */
  readonly taxPointDate: string
  /** Why the supply was credited. Mandatory: a correction nobody can review is not evidence. */
  readonly reason: string
  readonly lines: readonly CreditNoteLineInput[]
  /** Sums of the per-line figures. Never a re-derivation from `grossTotalFils`. */
  readonly netTotalFils: number
  readonly vatTotalFils: number
  readonly grossTotalFils: number
  /** The entry `creditNoteReversal` built. Dated on `taxPointDate`, source `reversal`. */
  readonly reversal: JournalEntryInput
  readonly notes?: string
  readonly provisionalOpenQuestionId?: string
  readonly provisionalNote?: string
}

export interface IssuedCreditNoteLine {
  readonly lineNo: number
  readonly invoiceLineNo: number
  readonly descriptionEn: string
  readonly descriptionAr: string | null
  readonly quantity: number
  readonly unitGrossFils: number
  /** Generated by the database, and returned so the caller never recomputes it. */
  readonly lineGrossFils: number
  readonly vatRateBp: number
  readonly netFils: number
  readonly vatFils: number
}

export interface IssuedCreditNote {
  readonly id: string
  readonly invoiceId: string
  readonly seriesCode: string
  readonly periodKey: string
  readonly number: number
  readonly displayNumber: string
  readonly issuerLegalName: string
  readonly issuerTradingName: string
  readonly issuerTrn: string
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
  readonly issueTradingDate: string | null
  readonly taxPointDate: string
  readonly issuedAt: Date
  readonly currency: string
  readonly netTotalFils: number
  readonly vatTotalFils: number
  readonly grossTotalFils: number
  readonly reason: string
  readonly journalEntryId: string
  readonly notes: string | null
  readonly lines: readonly IssuedCreditNoteLine[]
}

interface CreditNoteRow {
  readonly id: string
  readonly invoice_id: string
  readonly series_code: string
  readonly period_key: string
  readonly number: string
  readonly display_number: string
  readonly issuer_legal_name: string
  readonly issuer_trading_name: string
  readonly issuer_trn: string
  readonly issuer_address_snapshot: string
  readonly issuer_emirate: string
  readonly issuer_phone: string | null
  readonly issuer_licence_number: string | null
  readonly issuer_legal_name_ar: string | null
  readonly issuer_address_snapshot_ar: string | null
  readonly customer_id: string | null
  readonly customer_name_snapshot: string
  readonly customer_trn: string | null
  readonly customer_address_snapshot: string | null
  readonly customer_phone: string | null
  readonly issue_date: string
  readonly issue_trading_date: string | null
  readonly tax_point_date: string
  readonly issued_at: Date
  readonly currency: string
  readonly net_total: string
  readonly vat_total: string
  readonly gross_total: string
  readonly reason: string
  readonly journal_entry_id: string
  readonly notes: string | null
}

interface CreditNoteLineRow {
  readonly line_no: number
  readonly invoice_line_no: number
  readonly description_en: string
  readonly description_ar: string | null
  readonly quantity: number
  readonly unit_gross_fils: string
  readonly line_gross_fils: string
  readonly vat_rate_bp: number
  readonly line_net_fils: string
  readonly line_vat_fils: string
}

const CREDIT_NOTE_COLUMNS = (sql: Sql) => sql`
  id, invoice_id, series_code, period_key, number, display_number,
  issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate,
  issuer_phone, issuer_licence_number, issuer_legal_name_ar, issuer_address_snapshot_ar,
  customer_id, customer_name_snapshot, customer_trn, customer_address_snapshot, customer_phone,
  issue_date::text as issue_date, issue_trading_date::text as issue_trading_date,
  tax_point_date::text as tax_point_date, issued_at, currency,
  net_total, vat_total, gross_total, reason, journal_entry_id, notes
`

function toLine(row: CreditNoteLineRow): IssuedCreditNoteLine {
  return {
    lineNo: row.line_no,
    invoiceLineNo: row.invoice_line_no,
    descriptionEn: row.description_en,
    descriptionAr: row.description_ar,
    quantity: row.quantity,
    unitGrossFils: Number(row.unit_gross_fils),
    lineGrossFils: Number(row.line_gross_fils),
    vatRateBp: row.vat_rate_bp,
    netFils: Number(row.line_net_fils),
    vatFils: Number(row.line_vat_fils),
  }
}

function toCreditNote(row: CreditNoteRow): Omit<IssuedCreditNote, 'lines'> {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    seriesCode: row.series_code,
    periodKey: row.period_key,
    number: Number(row.number),
    displayNumber: row.display_number,
    issuerLegalName: row.issuer_legal_name,
    issuerTradingName: row.issuer_trading_name,
    issuerTrn: row.issuer_trn,
    issuerAddressSnapshot: row.issuer_address_snapshot,
    issuerEmirate: row.issuer_emirate,
    issuerPhone: row.issuer_phone,
    issuerLicenceNumber: row.issuer_licence_number,
    issuerLegalNameAr: row.issuer_legal_name_ar,
    issuerAddressSnapshotAr: row.issuer_address_snapshot_ar,
    customerId: row.customer_id,
    customerNameSnapshot: row.customer_name_snapshot,
    customerTrn: row.customer_trn,
    customerAddressSnapshot: row.customer_address_snapshot,
    customerPhone: row.customer_phone,
    issueDate: row.issue_date,
    issueTradingDate: row.issue_trading_date,
    taxPointDate: row.tax_point_date,
    issuedAt: row.issued_at,
    currency: row.currency,
    netTotalFils: Number(row.net_total),
    vatTotalFils: Number(row.vat_total),
    grossTotalFils: Number(row.gross_total),
    reason: row.reason,
    journalEntryId: row.journal_entry_id,
    notes: row.notes,
  }
}

/**
 * Refuses a reversal that disagrees with the note it is supposed to post.
 *
 * Three facts, all of which `ZD011` checks again at COMMIT. They are checked here as well because the
 * database's copy arrives from `COMMIT`, outside every function in this module, and because failing
 * before `allocateDocumentNumber` means a malformed request never takes the counter's row lock.
 *
 * The settlement figure is read off the entry rather than trusted: the note's gross and the entry's
 * credit to `1050 Trade receivables` are two statements of one amount, and a document whose posting says
 * something else is the defect this exists to catch. `1050` is 0068's own choice — a payment clears that
 * receivable and a refund re-creates it, and its module comment names the credit note's half of the
 * correction as `Cr 1050` — so the constant is imported from there rather than restated here.
 */
export function assertReversalMatches(input: IssueCreditNoteInput): void {
  const { reversal } = input
  if (reversal.entryDate !== input.taxPointDate) {
    throw new AppError(
      'invariant_violated',
      `The credit note is dated ${input.taxPointDate} and its reversal "${reversal.entryId}" is ` +
        `dated ${reversal.entryDate}. A correction posts in the period the NOTE falls in, or a filed ` +
        'period gets restated.',
    )
  }
  if (reversal.source !== 'reversal') {
    throw new AppError(
      'invariant_violated',
      `The credit note's entry "${reversal.entryId}" is classified as "${reversal.source}". A refund ` +
        'and a credited sale produce identical lines and are answered differently when a customer ' +
        'asks, which is why the source is carried rather than inferred.',
    )
  }
  const credited = reversal.lines
    .filter((line) => line.accountCode === TRADE_RECEIVABLES_ACCOUNT_CODE)
    .reduce((total, line) => total + line.creditFils - line.debitFils, 0)
  if (credited !== input.grossTotalFils) {
    throw new AppError(
      'invariant_violated',
      `The credit note states ${input.grossTotalFils} fils and its reversal "${reversal.entryId}" ` +
        `credits ${credited} fils to ${TRADE_RECEIVABLES_ACCOUNT_CODE}. The note and its posting ` +
        'are two statements of one amount.',
    )
  }
}

/**
 * Allocates the statutory number and inserts the header, returning the row as stored.
 *
 * Its own function to keep {@link issueCreditNote} under the complexity ceiling `biome.json` sets: the
 * thirteen `?? null` coalescings of an optional snapshot field each count towards it, and a writer
 * whose every branch is "this column is nullable" is not the complexity that ceiling exists to catch.
 *
 * ## Which date the number is allocated against
 *
 * The **issue** trading date, falling back to the issue date — `issueInvoice`'s choice, for
 * `issueInvoice`'s reason. Under the `annual` reset policy `allocate_document_number()` restarts the
 * counter whenever the period key it computes differs from the stored one, so allocation dates have to
 * move forward: allocating against the INVOICE's tax point would hand a January note for a December
 * supply the period key '2026' against a counter already on '2027', reset it to 1, and start issuing
 * numbers the December range has already used.
 */
async function insertCreditNote(
  uow: UnitOfWork,
  input: IssueCreditNoteInput,
): Promise<CreditNoteRow> {
  const numberingDate = input.issueTradingDate ?? input.issueDate
  const allocated = await allocateDocumentNumber(uow, input.seriesCode, numberingDate)

  const [row] = await uow.sql<CreditNoteRow[]>`
    insert into credit_note (
      invoice_id, series_code, period_key, number, display_number,
      issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate,
      issuer_phone, issuer_licence_number, issuer_legal_name_ar, issuer_address_snapshot_ar,
      customer_id, customer_name_snapshot, customer_trn, customer_address_snapshot, customer_phone,
      issue_date, issue_trading_date, tax_point_date,
      net_total, vat_total, gross_total, reason, journal_entry_id, notes,
      provisional_open_question_id, provisional_note
    ) values (
      ${input.invoiceId}, ${allocated.seriesCode}, ${allocated.periodKey},
      ${allocated.number}, ${allocated.displayNumber},
      ${input.issuer.legalName}, ${input.issuer.tradingName}, ${input.issuer.trn},
      ${input.issuer.addressSnapshot}, ${input.issuer.emirate},
      ${input.issuer.phone ?? null}, ${input.issuer.licenceNumber ?? null},
      ${input.issuer.legalNameAr ?? null}, ${input.issuer.addressSnapshotAr ?? null},
      ${input.customer.customerId ?? null}, ${input.customer.nameSnapshot},
      ${input.customer.trn ?? null}, ${input.customer.addressSnapshot ?? null},
      ${input.customer.phone ?? null},
      ${input.issueDate}::date, ${input.issueTradingDate ?? null}::date, ${input.taxPointDate}::date,
      ${input.netTotalFils}, ${input.vatTotalFils}, ${input.grossTotalFils},
      ${input.reason}, ${input.reversal.entryId}, ${input.notes ?? null},
      ${input.provisionalOpenQuestionId ?? null}, ${input.provisionalNote ?? null}
    )
    returning ${CREDIT_NOTE_COLUMNS(uow.sql)}
  `
  if (!row) {
    throw new AppError('invariant_violated', 'insert into credit_note returned no row')
  }
  return row
}

/**
 * Issues a credit note: allocates its number, inserts it and its lines, and posts the reversal, all in
 * `uow`'s transaction.
 *
 * ## What is returned before COMMIT
 *
 * The rows as inserted. The deferred triggers have not run yet, so a note whose totals disagree with
 * its lines, or whose reversal credits the wrong figure, is returned here and then fails at COMMIT; see
 * {@link creditNoteError}.
 */
export async function issueCreditNote(
  uow: UnitOfWork,
  input: IssueCreditNoteInput,
): Promise<IssuedCreditNote> {
  if (input.lines.length === 0) {
    // Caught here as well as at COMMIT (`ZD008`), because failing before a number is allocated is the
    // difference between a refused request and a rolled-back statutory allocation.
    throw new AppError('validation', 'A credit note needs at least one line')
  }
  assertReversalMatches(input)

  // The entry the invoice posted, when it had one. A checkout writes `checkout_finalisation`; a
  // document raised by the accountant outside a checkout does not, and then there is nothing for the
  // reversal to name. Read here rather than accepted from the caller, so `journal_entry.reverses` on a
  // credited checkout cannot point at an entry that belongs to another document.
  const [finalisation] = await uow.sql<{ journal_entry_id: string }[]>`
    select journal_entry_id from checkout_finalisation where invoice_id = ${input.invoiceId}
  `
  if (finalisation && input.reversal.reverses !== finalisation.journal_entry_id) {
    throw new AppError(
      'invariant_violated',
      `The credit note's reversal "${input.reversal.entryId}" reverses ` +
        `"${String(input.reversal.reverses)}"; invoice ${input.invoiceId} was posted as ` +
        `"${finalisation.journal_entry_id}". A reversal that names another document's entry corrects ` +
        'that document instead of this one.',
    )
  }

  // The note FIRST, and the entry after it. `credit_note_reversal_fk` is DEFERRED so that this order
  // is possible, and the order is what makes `ZD003` — the refusal that names the earliest open date —
  // the one a caller sees for a locked period, rather than the journal's own ZL002.
  const row = await insertCreditNote(uow, input)

  const lines: IssuedCreditNoteLine[] = []
  for (const [index, line] of input.lines.entries()) {
    // One statement per line, for `issueInvoice`'s reason: the totals invariant is deferred to COMMIT
    // precisely so the lines may arrive separately, and a single multi-row statement would hide a
    // per-line failure behind whichever row the planner reached first.
    const [stored] = await uow.sql<CreditNoteLineRow[]>`
      insert into credit_note_line (
        credit_note_id, line_no, invoice_line_no, description_en, description_ar, quantity,
        unit_gross_fils, vat_rate_bp, line_net_fils, line_vat_fils
      ) values (
        ${row.id}, ${index + 1}, ${line.invoiceLineNo}, ${line.descriptionEn},
        ${line.descriptionAr ?? null}, ${line.quantity}, ${line.unitGrossFils},
        ${line.vatRateBp}, ${line.netFils}, ${line.vatFils}
      )
      returning line_no, invoice_line_no, description_en, description_ar, quantity, unit_gross_fils,
                line_gross_fils, vat_rate_bp, line_net_fils, line_vat_fils
    `
    if (!stored) {
      throw new AppError('invariant_violated', 'insert into credit_note_line returned no row')
    }
    lines.push(toLine(stored))
  }

  await postJournalEntry(uow, input.reversal)

  const issued = { ...toCreditNote(row), lines }

  // A credit note is the one document in this schema that DOES have a `before`: the invoice it
  // corrects. `issueInvoice`'s own comment says so — "A credit note, when M-TILL owns one, is the
  // shape that does have one" — and the pair is what an investigation reads. It is the invoice's id
  // and display number rather than the whole document: the note itself carries the figures, and
  // copying the invoice into the audit row would store a second version of a row that cannot change.
  await uow.audit.record({
    action: 'credit_note.issue',
    entityType: 'credit_note',
    entityId: issued.id,
    operation: 'create',
    after: issued,
  })

  await uow.publish({
    eventType: 'credit_note.issued',
    aggregateType: 'credit_note',
    aggregateId: issued.id,
    payload: {
      displayNumber: issued.displayNumber,
      invoiceId: issued.invoiceId,
      taxPointDate: issued.taxPointDate,
      grossTotalFils: issued.grossTotalFils,
      vatTotalFils: issued.vatTotalFils,
      lineCount: issued.lines.length,
      journalEntryId: issued.journalEntryId,
      customerId: issued.customerId,
    },
    // The ROW's id, not its display number, and the difference is the whole point.
    //
    // This used to read `credit_note.issued:${issued.displayNumber}`, on the argument that the statutory
    // identifier is unique by constraint. It is — WITHIN a series and a period, which is not the scope
    // this key lives in. `document_number_display` (migration 0013) puts `period_key` in the string, so
    // an `annual` series cannot repeat a number across years and the argument holds in production; it
    // stops holding the moment the counter restarts against an empty period key, which is what a
    // TRUNCATE of `credit_note` does. `on conflict (idempotency_key) do nothing` then drops the second
    // event in silence and `publishEvent` returns null, which this call site discards — so a fixture
    // that truncates and re-issues gets no event and fails two layers from the cause, or asserts a
    // delivery that never had anything to deliver.
    //
    // The row id is the identity of the business fact "this document was issued": unique for ever,
    // never reset, and immutable. The display number is a LABEL, and it is already in the payload
    // above, so nothing that reads this event loses anything by the change.
    idempotencyKey: `credit_note.issued:${issued.id}`,
  })

  return issued
}

async function withLines(
  sql: Sql,
  row: CreditNoteRow | undefined,
): Promise<IssuedCreditNote | null> {
  if (!row) return null
  const lines = await sql<CreditNoteLineRow[]>`
    select line_no, invoice_line_no, description_en, description_ar, quantity, unit_gross_fils,
           line_gross_fils, vat_rate_bp, line_net_fils, line_vat_fils
    from credit_note_line where credit_note_id = ${row.id} order by line_no
  `
  return { ...toCreditNote(row), lines: lines.map(toLine) }
}

/** Reads one note with its lines in `line_no` order, or `null`. */
export async function readCreditNote(sql: Sql, id: string): Promise<IssuedCreditNote | null> {
  const [row] = await sql<CreditNoteRow[]>`
    select ${CREDIT_NOTE_COLUMNS(sql)} from credit_note where id = ${id}
  `
  return withLines(sql, row)
}

/**
 * Reads one note by the identifier printed on it.
 *
 * `display_number` is UNIQUE, which is what makes this a lookup rather than a search.
 */
export async function readCreditNoteByDisplayNumber(
  sql: Sql,
  displayNumber: string,
): Promise<IssuedCreditNote | null> {
  const [row] = await sql<CreditNoteRow[]>`
    select ${CREDIT_NOTE_COLUMNS(sql)} from credit_note where display_number = ${displayNumber}
  `
  return withLines(sql, row)
}

/** Every note against one document, oldest number first. */
export async function readCreditNotesForInvoice(
  sql: Sql,
  invoiceId: string,
): Promise<readonly IssuedCreditNote[]> {
  const rows = await sql<CreditNoteRow[]>`
    select ${CREDIT_NOTE_COLUMNS(sql)} from credit_note
     where invoice_id = ${invoiceId} order by number
  `
  const notes: IssuedCreditNote[] = []
  for (const row of rows) {
    const note = await withLines(sql, row)
    if (note) notes.push(note)
  }
  return notes
}
