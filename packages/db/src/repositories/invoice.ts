import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import { allocateDocumentNumber } from './numbering.ts'

/**
 * The invoice repository: the only write path for an issued tax document.
 *
 * ## There is no update, no edit, no void and no delete — and that is asserted
 *
 * A correction to an issued invoice is a **credit note**, which is a separate document with its own
 * statutory series (docs/04 §4: "Credit notes only for corrections. Never edit or delete an issued
 * invoice."). So this module exports exactly one writer, {@link issueInvoice}, and two readers.
 *
 * That is not left as a convention. `invoice.test.ts` enumerates this module's exports and fails on
 * any name whose segments include `update`, `edit`, `void` or `delete`, so a `voidInvoice` added in
 * two years' time fails the build rather than the next VAT return. The database says the same thing
 * twice over: `berelax_app` holds no UPDATE or DELETE, and a pair of BEFORE triggers raises `ZI003`
 * for every role including the owner.
 *
 * ## Why `issueInvoice` takes a UnitOfWork
 *
 * Three things must be durable together or not at all: the document, the number allocated to it, and
 * the `audit_event` row saying who issued it. The number especially — `allocateDocumentNumber` takes a
 * `UnitOfWork` for exactly this reason (M-TILL-03), because the counter's row lock is what serialises
 * issuers and the rollback is what returns an unused number to the pool. Allocate first and insert in
 * a second transaction, and every failed insert leaves a permanent hole in a statutory range.
 *
 * There is no overload accepting a pool, so the compiling-but-wrong call cannot be written.
 *
 * ## Why the amounts arrive already derived
 *
 * `packages/db` must never import `packages/core` — the dependency runs the other way — so this module
 * computes no VAT. The caller derives with `deriveDocumentTax` from `@berelax/core` and maps field for
 * field; `packages/fixtures` is the package allowed to depend on both, and
 * `invoice-document.itest.ts` exercises the pair.
 *
 * No TypeScript re-check of the totals is added here either. `0026_invoice.sql` checks them at COMMIT
 * with a deferred constraint trigger, core derives them, and a third statement of one rule is a second
 * opportunity to disagree — this repository is also not the only thing that can reach a psql prompt.
 * The practical consequence is that a caller which re-derives its VAT from the document total fails at
 * **COMMIT**, outside every function in this module, which is why {@link invoiceError} is exported for
 * the caller to wrap its own transaction with rather than hidden in a catch block that can never see
 * it.
 */

export const INVOICE_DOCUMENT_KINDS = ['tax_invoice', 'simplified_invoice'] as const
export type InvoiceDocumentKind = (typeof INVOICE_DOCUMENT_KINDS)[number]

/**
 * The SQLSTATEs `0026_invoice.sql` raises.
 *
 * Custom codes rather than repurposed standard ones, because a caller has to tell them apart and the
 * alternative is matching on message text — which stops working silently the first time somebody
 * improves the wording. Class 'ZI' is unused by PostgreSQL and reserved for user-defined conditions;
 * the ledger uses 'ZL' for the same reason.
 */
export const INVOICE_SQLSTATE = {
  /** The header's totals do not equal the sum of its lines. Raised at COMMIT. */
  totalsDisagree: 'ZI001',
  /** An invoice was committed with no lines. Raised at COMMIT. */
  withoutLines: 'ZI002',
  /** An invoice row was UPDATEd or DELETEd. */
  appendOnly: 'ZI003',
} as const

/** `23514`: a CHECK refused the row — the issuer snapshot placeholders live here. */
const CHECK_VIOLATION = '23514'
/** `23505`: a number or a display number was issued twice. */
const UNIQUE_VIOLATION = '23505'
/** `42501`: the application role holds no such privilege. This is the grant layer refusing. */
const INSUFFICIENT_PRIVILEGE = '42501'

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a PostgreSQL error raised by the invoice schema into an `AppError`, or `null` if it is
 * not one of ours.
 *
 * Idempotent: it reads a SQLSTATE the driver carries or one an earlier translation already recorded,
 * because the failure that matters most here arrives from `COMMIT` and is therefore translated at a
 * different layer from the one that issued the statement.
 */
export function invoiceError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case INVOICE_SQLSTATE.totalsDisagree:
      return new AppError('invariant_violated', message, { details: { sqlState: code } })
    case INVOICE_SQLSTATE.withoutLines:
      return new AppError('invariant_violated', message, { details: { sqlState: code } })
    case INVOICE_SQLSTATE.appendOnly:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    case CHECK_VIOLATION:
      return new AppError('validation', message, { details: { sqlState: code } })
    case UNIQUE_VIOLATION:
      return new AppError('conflict', message, { details: { sqlState: code } })
    case INSUFFICIENT_PRIVILEGE:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    default:
      return null
  }
}

/** True when `err` is the append-only refusal. The only correct response is to raise a credit note. */
export function isInvoiceAppendOnly(err: unknown): boolean {
  return sqlState(err) === INVOICE_SQLSTATE.appendOnly
}

/** True when `err` is the deferred totals failure. It arrives from COMMIT, never from an INSERT. */
export function isInvoiceTotalsDisagreement(err: unknown): boolean {
  return sqlState(err) === INVOICE_SQLSTATE.totalsDisagree
}

/**
 * The issuer, as it is frozen onto the document.
 *
 * Read from `legal_entity` and `premises` at issue and copied, never joined: a relocation or a change
 * of legal name must not rewrite a document already filed (docs/01, docs/04 §4).
 *
 * The Arabic fields are optional because neither source table carries an Arabic column yet — see the
 * NOTE on M-TILL-04 in `build/manifest.yaml`.
 */
export interface IssuerSnapshotInput {
  readonly legalName: string
  readonly tradingName: string
  /** Fifteen digits. The Y1-trn placeholder is refused by two CHECK constraints. */
  readonly trn: string
  /** Newline-separated, in the order it prints. */
  readonly addressSnapshot: string
  readonly emirate: string
  readonly phone?: string
  readonly licenceNumber?: string
  readonly legalNameAr?: string
  readonly addressSnapshotAr?: string
}

/** The customer, as printed. A record label — `Customer 0042` — never an invented name (ADR 0020). */
export interface CustomerSnapshotInput {
  /** Provenance, and absent for a cash sale at the desk. */
  readonly customerId?: string
  readonly nameSnapshot: string
  readonly trn?: string
  readonly addressSnapshot?: string
  readonly phone?: string
}

/**
 * One line, with its tax already derived by `@berelax/core`.
 *
 * `netFils` and `vatFils` are the line's own figures, rounded on the line's gross. The line total is
 * not passed at all: it is generated in the database as `unitGrossFils * quantity`, because
 * multiplication needs no rounding and therefore admits no second opinion.
 */
export interface InvoiceLineInput {
  readonly descriptionEn: string
  readonly descriptionAr?: string
  readonly quantity: number
  readonly unitGrossFils: number
  readonly vatRateBp: number
  readonly netFils: number
  readonly vatFils: number
}

export interface IssueInvoiceInput {
  readonly documentKind: InvoiceDocumentKind
  /** 'TAX-INV' or 'SIMPL-INV'. The series' own kind must match `documentKind`. */
  readonly seriesCode: string
  readonly issuer: IssuerSnapshotInput
  readonly customer: CustomerSnapshotInput
  /** Calendar date of issue, ISO `YYYY-MM-DD`. */
  readonly issueDate: string
  /**
   * The trading date the document is issued on, or absent when it is raised outside trading hours.
   *
   * Also what the number is allocated against — see the note in {@link issueInvoice}.
   */
  readonly issueTradingDate?: string
  /**
   * Date of supply: the **trading** date the supply belongs to, from `resolveTaxPoint` in
   * `@berelax/core`. A supply on trading day D invoiced on D+1 keeps its tax point at D.
   */
  readonly taxPointDate: string
  readonly lines: readonly InvoiceLineInput[]
  /** Sums of the per-line figures. Never a re-derivation from `grossTotalFils`. */
  readonly netTotalFils: number
  readonly vatTotalFils: number
  readonly grossTotalFils: number
  readonly notes?: string
  /**
   * The booking this document bills, or absent for a document raised outside a checkout.
   *
   * The wiring M-TILL-04's NOTE deferred to M-TILL-06, added by `0063_checkout.sql`. It is STORED, not
   * merely carried: `invoice.issued` names it in its payload so A-FIRST can reach PAID, and an id
   * carried on an event but recorded nowhere is a fact with no record.
   *
   * `finaliseCheckout` derives it from the appointments it is billing rather than accepting it, so
   * `invoice.booking_id` cannot disagree with `invoice_appointment`.
   */
  readonly bookingId?: string | null
  /** The open question the field set stands in for, carried as data. Paired with `provisionalNote`. */
  readonly provisionalOpenQuestionId?: string
  readonly provisionalNote?: string
}

export interface IssuedInvoiceLine {
  readonly lineNo: number
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

export interface IssuedInvoice {
  readonly id: string
  readonly documentKind: string
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
  /** The booking this document bills, or `null` for a document raised outside a checkout (0063). */
  readonly bookingId: string | null
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
  readonly notes: string | null
  readonly lines: readonly IssuedInvoiceLine[]
}

interface InvoiceRow {
  readonly id: string
  readonly document_kind: string
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
  readonly booking_id: string | null
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
  readonly notes: string | null
}

interface InvoiceLineRow {
  readonly line_no: number
  readonly description_en: string
  readonly description_ar: string | null
  readonly quantity: number
  readonly unit_gross_fils: string
  readonly line_gross_fils: string
  readonly vat_rate_bp: number
  readonly line_net_fils: string
  readonly line_vat_fils: string
}

/**
 * The Y11-vat-invoice field superset: every field a UAE tax invoice is understood to require, and the
 * NOT NULL column that carries it.
 *
 * Y11-vat-invoice is open — the mandatory list needs an FTA-registered tax agent — so the design
 * carries a **superset** of everything docs/04 §4 names and everything
 * `packages/pdf/src/documents/invoice.ts` already lays out. Written as data rather than as prose so
 * `invoice.itest.ts` can check each entry against `information_schema` and fail on any column that is
 * missing or has become nullable; a list in a comment proves nothing about the applied schema.
 *
 * The one requirement with no NOT NULL column is the Arabic-language one, and it is absent rather than
 * quietly relaxed: `legal_entity`, `premises` and `service` carry no Arabic columns, so there is
 * nothing to snapshot. See the NOTE on M-TILL-04.
 */
export interface MandatoryInvoiceField {
  readonly requirement: string
  readonly table: 'invoice' | 'invoice_line'
  readonly column: string
}

export const Y11_VAT_INVOICE_FIELDS: readonly MandatoryInvoiceField[] = [
  { requirement: 'the words identifying the document', table: 'invoice', column: 'document_kind' },
  { requirement: 'supplier legal name', table: 'invoice', column: 'issuer_legal_name' },
  { requirement: 'supplier trading name', table: 'invoice', column: 'issuer_trading_name' },
  { requirement: 'supplier address', table: 'invoice', column: 'issuer_address_snapshot' },
  { requirement: 'supplier emirate', table: 'invoice', column: 'issuer_emirate' },
  { requirement: 'supplier TRN', table: 'invoice', column: 'issuer_trn' },
  { requirement: 'sequential number, as counted', table: 'invoice', column: 'number' },
  { requirement: 'sequential number, as printed', table: 'invoice', column: 'display_number' },
  { requirement: 'the series it was numbered from', table: 'invoice', column: 'series_code' },
  { requirement: 'the reset period of that series', table: 'invoice', column: 'period_key' },
  { requirement: 'date of issue', table: 'invoice', column: 'issue_date' },
  { requirement: 'date of supply (the tax point)', table: 'invoice', column: 'tax_point_date' },
  { requirement: 'customer details', table: 'invoice', column: 'customer_name_snapshot' },
  { requirement: 'currency, which must be AED', table: 'invoice', column: 'currency' },
  { requirement: 'total excluding VAT, in AED', table: 'invoice', column: 'net_total' },
  { requirement: 'total VAT, in AED', table: 'invoice', column: 'vat_total' },
  { requirement: 'total payable, in AED', table: 'invoice', column: 'gross_total' },
  { requirement: 'per-line description', table: 'invoice_line', column: 'description_en' },
  { requirement: 'per-line quantity', table: 'invoice_line', column: 'quantity' },
  { requirement: 'per-line unit price, gross', table: 'invoice_line', column: 'unit_gross_fils' },
  { requirement: 'per-line amount, gross', table: 'invoice_line', column: 'line_gross_fils' },
  { requirement: 'per-line amount excluding VAT', table: 'invoice_line', column: 'line_net_fils' },
  { requirement: 'per-line VAT rate', table: 'invoice_line', column: 'vat_rate_bp' },
  { requirement: 'per-line VAT amount', table: 'invoice_line', column: 'line_vat_fils' },
]

// The driver returns bigint as a string so a fils amount cannot lose precision in transit; Number()
// is applied once, here, where the value re-enters TypeScript.
function toLine(row: InvoiceLineRow): IssuedInvoiceLine {
  return {
    lineNo: row.line_no,
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

function toInvoice(row: InvoiceRow): Omit<IssuedInvoice, 'lines'> {
  return {
    id: row.id,
    documentKind: row.document_kind,
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
    bookingId: row.booking_id,
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
    notes: row.notes,
  }
}

const INVOICE_COLUMNS = (sql: Sql) => sql`
  id, document_kind, series_code, period_key, number, display_number,
  issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate,
  issuer_phone, issuer_licence_number, issuer_legal_name_ar, issuer_address_snapshot_ar,
  customer_id, booking_id, customer_name_snapshot, customer_trn, customer_address_snapshot,
  customer_phone,
  issue_date::text as issue_date, issue_trading_date::text as issue_trading_date,
  tax_point_date::text as tax_point_date, issued_at, currency,
  net_total, vat_total, gross_total, notes
`

/**
 * Issues a document: allocates its number and inserts it, in `uow`'s transaction.
 *
 * ## Which date the number is allocated against
 *
 * The **issue** trading date, falling back to the issue date when the document was raised while the
 * premises was shut — not the tax point, which is the tempting choice because the tax point is what
 * decides the VAT period.
 *
 * It would be wrong, and destructively so. Under the `annual` reset policy
 * `allocate_document_number()` restarts the counter at 1 whenever the period key it computes differs
 * from the stored one. Allocation dates therefore have to move forward: a January invoice raised for a
 * December supply would compute period key '2026' against a counter already on '2027', reset that
 * counter to 1, and start issuing numbers the December range has already used. Issue dates move
 * forward; tax points do not.
 *
 * A New Year's Eve document issued at 01:30 still joins the previous year's range, because 01:30
 * belongs to the previous trading date — which is the behaviour 0013 was written for.
 *
 * ## What is returned before COMMIT
 *
 * The row as inserted. The deferred constraint trigger has not run yet, so a document whose totals
 * disagree with its lines is returned here and then fails at COMMIT; see {@link invoiceError}.
 */
export async function issueInvoice(
  uow: UnitOfWork,
  input: IssueInvoiceInput,
): Promise<IssuedInvoice> {
  if (input.lines.length === 0) {
    // Caught here as well as at COMMIT, because failing before a number is allocated is the
    // difference between a refused request and a rolled-back statutory allocation.
    throw new AppError('validation', 'An invoice needs at least one line')
  }

  const numberingDate = input.issueTradingDate ?? input.issueDate
  const allocated = await allocateDocumentNumber(uow, input.seriesCode, numberingDate)

  const [row] = await uow.sql<InvoiceRow[]>`
    insert into invoice (
      document_kind, series_code, period_key, number, display_number,
      issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate,
      issuer_phone, issuer_licence_number, issuer_legal_name_ar, issuer_address_snapshot_ar,
      customer_id, booking_id, customer_name_snapshot, customer_trn, customer_address_snapshot,
      customer_phone,
      issue_date, issue_trading_date, tax_point_date,
      net_total, vat_total, gross_total, notes,
      provisional_open_question_id, provisional_note
    ) values (
      ${input.documentKind}, ${allocated.seriesCode}, ${allocated.periodKey},
      ${allocated.number}, ${allocated.displayNumber},
      ${input.issuer.legalName}, ${input.issuer.tradingName}, ${input.issuer.trn},
      ${input.issuer.addressSnapshot}, ${input.issuer.emirate},
      ${input.issuer.phone ?? null}, ${input.issuer.licenceNumber ?? null},
      ${input.issuer.legalNameAr ?? null}, ${input.issuer.addressSnapshotAr ?? null},
      ${input.customer.customerId ?? null}, ${input.bookingId ?? null},
      ${input.customer.nameSnapshot},
      ${input.customer.trn ?? null}, ${input.customer.addressSnapshot ?? null},
      ${input.customer.phone ?? null},
      ${input.issueDate}::date, ${input.issueTradingDate ?? null}::date, ${input.taxPointDate}::date,
      ${input.netTotalFils}, ${input.vatTotalFils}, ${input.grossTotalFils},
      ${input.notes ?? null},
      ${input.provisionalOpenQuestionId ?? null}, ${input.provisionalNote ?? null}
    )
    returning ${INVOICE_COLUMNS(uow.sql)}
  `
  if (!row) {
    throw new AppError('invariant_violated', 'insert into invoice returned no row')
  }

  const lines: IssuedInvoiceLine[] = []
  for (const [index, line] of input.lines.entries()) {
    // One statement per line, on purpose. The totals invariant is deferred to COMMIT precisely so the
    // lines may arrive separately, and a single multi-row statement would hide a per-line failure
    // behind whichever row the planner reached first.
    const [stored] = await uow.sql<InvoiceLineRow[]>`
      insert into invoice_line (
        invoice_id, line_no, description_en, description_ar, quantity, unit_gross_fils,
        vat_rate_bp, line_net_fils, line_vat_fils
      ) values (
        ${row.id}, ${index + 1}, ${line.descriptionEn}, ${line.descriptionAr ?? null},
        ${line.quantity}, ${line.unitGrossFils}, ${line.vatRateBp}, ${line.netFils}, ${line.vatFils}
      )
      returning line_no, description_en, description_ar, quantity, unit_gross_fils,
                line_gross_fils, vat_rate_bp, line_net_fils, line_vat_fils
    `
    if (!stored) {
      throw new AppError('invariant_violated', 'insert into invoice_line returned no row')
    }
    lines.push(toLine(stored))
  }

  const issued = { ...toInvoice(row), lines }

  // No `before` state, and none is fabricated. An issued document has no prior version by
  // construction — that is what append-only means here — and a fabricated `before` would be a record
  // of something that never existed. A credit note, when M-TILL owns one, is the shape that does have
  // one: the invoice it corrects.
  await uow.audit.record({
    action: 'invoice.issue',
    entityType: 'invoice',
    entityId: issued.id,
    operation: 'create',
    after: issued,
  })

  await uow.publish({
    eventType: 'invoice.issued',
    aggregateType: 'invoice',
    aggregateId: issued.id,
    payload: {
      displayNumber: issued.displayNumber,
      documentKind: issued.documentKind,
      taxPointDate: issued.taxPointDate,
      grossTotalFils: issued.grossTotalFils,
      vatTotalFils: issued.vatTotalFils,
      lineCount: issued.lines.length,
      // Both ids read off the STORED row, not off the input: a payload that named a booking the
      // document does not carry would be a claim nothing in the database supports. M-TILL-06's
      // acceptance asks for the pair on this event so A-FIRST can take the booking to PAID; `null`
      // for a document raised outside a checkout, and for a cash sale with no customer record
      // (ADR 0014).
      bookingId: issued.bookingId,
      customerId: issued.customerId,
    },
    // The ROW's id, not its display number, and the difference is the whole point.
    //
    // This used to read `invoice.issued:${issued.displayNumber}`, on the argument that the statutory
    // identifier is unique by constraint. It is — WITHIN a series and a period, which is not the scope
    // this key lives in. `document_number_display` (migration 0013) puts `period_key` in the string, so
    // an `annual` series cannot repeat a number across years and the argument holds in production; it
    // stops holding the moment the counter restarts against an empty period key, which is what a
    // TRUNCATE of `invoice` does. `on conflict (idempotency_key) do nothing` then drops the second
    // event in silence and `publishEvent` returns null, which this call site discards — so a fixture
    // that truncates and re-issues gets no event and fails two layers from the cause, or asserts a
    // delivery that never had anything to deliver.
    //
    // The row id is the identity of the business fact "this document was issued": unique for ever,
    // never reset, and immutable. The display number is a LABEL, and it is already in the payload
    // above, so nothing that reads this event loses anything by the change.
    idempotencyKey: `invoice.issued:${issued.id}`,
  })

  return issued
}

async function withLines(sql: Sql, row: InvoiceRow | undefined): Promise<IssuedInvoice | null> {
  if (!row) return null
  const lines = await sql<InvoiceLineRow[]>`
    select line_no, description_en, description_ar, quantity, unit_gross_fils, line_gross_fils,
           vat_rate_bp, line_net_fils, line_vat_fils
    from invoice_line where invoice_id = ${row.id} order by line_no
  `
  return { ...toInvoice(row), lines: lines.map(toLine) }
}

/** Reads one document with its lines in `line_no` order, or `null`. */
export async function readInvoice(sql: Sql, id: string): Promise<IssuedInvoice | null> {
  const [row] = await sql<InvoiceRow[]>`
    select ${INVOICE_COLUMNS(sql)} from invoice where id = ${id}
  `
  return withLines(sql, row)
}

/**
 * Reads one document by the identifier printed on it.
 *
 * `display_number` is UNIQUE, which is what makes this a lookup rather than a search: the string on
 * the paper a customer is holding identifies exactly one row, or none.
 */
export async function readInvoiceByDisplayNumber(
  sql: Sql,
  displayNumber: string,
): Promise<IssuedInvoice | null> {
  const [row] = await sql<InvoiceRow[]>`
    select ${INVOICE_COLUMNS(sql)} from invoice where display_number = ${displayNumber}
  `
  return withLines(sql, row)
}
