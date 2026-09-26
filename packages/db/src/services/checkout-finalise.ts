import { AppError } from '@berelax/shared'
import type { Actor, RequestContext } from '../audit.ts'
import type { Sql } from '../connection.ts'
import {
  type IssuedInvoice,
  type IssueInvoiceInput,
  invoiceError,
  issueInvoice,
  readInvoice,
} from '../repositories/invoice.ts'
import {
  type JournalEntryInput,
  journalError,
  type PostedJournalEntry,
  postJournalEntry,
  readJournalEntry,
} from '../repositories/journal.ts'
import { type UnitOfWork, withUnitOfWork } from '../tx.ts'

/**
 * Checkout finalisation: the one write path from a priced basket to a filed sale.
 *
 * One transaction produces five things and either all of them are durable or none is: the invoice and
 * its lines, the balanced journal entry and its lines, the tender rows, the link that says which
 * appointments were billed, and the idempotency claim — plus the `audit_event` rows and the outbox
 * events that every mutation in this system writes beside itself (F06).
 *
 * ## Why this function owns its transaction, when `postBill` and `issueInvoice` do not
 *
 * Every other writer in `packages/db` takes a {@link UnitOfWork} so that a caller can compose several
 * writes into one transaction, and `withUnitOfWork` belongs to the caller. This one cannot, for a
 * reason that is the substance of the unit: when the idempotency key has already been claimed, the
 * losing transaction is **aborted** — PostgreSQL will accept nothing further on it — and the answer the
 * caller needs (the winner's invoice) can only be read in a *new* transaction. A function taking a
 * `UnitOfWork` could not open one, so the recovery would have to be written again by every caller, and
 * the caller that forgot would surface a raw `23505` at the till.
 *
 * Owning the transaction is also what lets the COMMIT-time failures be translated at all. The balance
 * invariant (`ZL003`) and the invoice-totals invariant (`ZI001`) are DEFERRED constraint triggers: they
 * fire at COMMIT, which is outside every function in `repositories/`, which is exactly why
 * {@link journalError} and {@link invoiceError} are exported for a caller to wrap a transaction with.
 * This is that caller.
 *
 * ## How idempotency is made a property of the database
 *
 * `checkout_finalisation.idempotency_key` is the primary key, and the value is supplied by the CALLER —
 * the till's request id. A key the database generated could not deduplicate a retry, because the retry
 * would generate a second one.
 *
 * There is deliberately **no** read-then-return-early. A read followed by a write has a gap, and the
 * double-tapped Pay button lands in it: both requests read nothing, both post, and the salon holds two
 * invoices for one treatment. So both requests do the work and the INSERT of the claim is where they
 * serialise — the second blocks on the unique index until the first commits, and is then refused by
 * `checkout_finalisation_key_pk`. The early return in this module is reached only *after* that refusal,
 * which is the difference between idempotent and lucky. `booking_idempotency` (0024) is the same
 * mechanism on the booking side, and its migration says the same thing: "a double tap blocks rather
 * than races".
 *
 * The loser consumes no statutory number. `allocateDocumentNumber` takes the counter's row lock inside
 * this transaction (M-TILL-03), so the loser's rollback returns its number to the pool and the invoice
 * range stays gap-free — which is why the claim is inserted inside the checkout's transaction rather
 * than before it.
 *
 * ## Why the claim goes in before the appointment link
 *
 * Both are unique constraints and they answer different questions. A genuine **retry** must get the
 * winner's invoice back, so `checkout_finalisation_key_pk` has to be the constraint it trips; a
 * different checkout trying to bill an appointment that is already on a document must be **refused**,
 * which is `invoice_appointment_appointment_once`. Writing the claim first makes each failure arrive as
 * itself. The other order would answer a retry with "that appointment is already billed", and the till
 * would show an error for a sale that had in fact gone through.
 *
 * ## What this service does not re-derive, and why
 *
 * Nothing. The amounts arrive already derived: `packages/db` may never import `packages/core`, so the
 * caller builds the basket with `buildBasket`, the entry with `checkoutPosting` and the document tax
 * with `deriveDocumentTax`, and maps all three onto the inputs here field for field
 * (`packages/fixtures` is the package allowed to depend on both, and
 * `checkout-finalisation.itest.ts` there exercises the pair).
 *
 * The three identities an auditor checks — debits equal credits, the revenue movement equals the
 * document's net, the output VAT equals the document's VAT — are not checked here either, and that is
 * deliberate rather than an omission. `postEntry` states the first in core, the deferred trigger in
 * `0018_ledger.sql` states it again at COMMIT, and `0026_invoice.sql`'s deferred trigger states the
 * document's. A fourth statement in TypeScript would be a third opportunity to disagree, and it could
 * not be the authority in any case: this service is not the only thing that can reach a `psql` prompt.
 * They are asserted against figures computed by hand in `checkout-finalise.itest.ts`.
 *
 * One thing IS cross-checked, and it is an agreement between two arguments rather than a derivation:
 * the tenders and the journal entry are mapped separately by the caller from one posting, and
 * {@link TenderPostingDisagrees} refuses a call where they disagree about where the money went. A
 * mis-mapped tender is the defect that puts cash in the card-clearing account with every other figure
 * correct, and no constraint in the database can see across the two tables.
 *
 * ## What is deliberately left to other units
 *
 *   - **The appointment's billable status.** `BILLABLE_APPOINTMENT_STATUSES` in
 *     `packages/core/src/checkout/basket.ts` is the one statement of "only a completed treatment may be
 *     charged for", and `serviceLineFromAppointment` refuses everything else. A second list of statuses
 *     here would be a second list to keep in step with B-LIFE-01's nine.
 *   - **Partial payment and change.** The tenders must add up to the basket, which `checkoutPosting`
 *     enforces in core. A receivable and an over-tender are M-TILL-07's.
 *   - **The `2050 -> 4020` release** a package redemption should make. M-TILL-09's, on the balance.
 */

/** `23505`: a key was claimed twice, or an appointment billed twice. */
const UNIQUE_VIOLATION = '23505'

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
 * The constraints `0063_checkout.sql` adds, by name.
 *
 * Named constants rather than string literals at the call sites, because the whole point of asserting a
 * refusal by constraint name is that the name is the contract: a rename that did not come through here
 * fails to compile instead of turning a recognised conflict into an unrecognised one — which is the
 * error class that gets retried.
 */
export const CHECKOUT_CONSTRAINT = {
  /** Where two finalisations of one checkout serialise. The refusal that means "already done". */
  idempotencyKey: 'checkout_finalisation_key_pk',
  /** One invoice per finalisation. */
  oneInvoice: 'checkout_finalisation_one_invoice',
  /** One journal entry per finalisation. */
  oneEntry: 'checkout_finalisation_one_entry',
  /** An appointment appears on at most one issued document, ever. */
  appointmentOnce: 'invoice_appointment_appointment_once',
} as const

/**
 * Raised when a key is replayed with a different basket.
 *
 * `conflict`, and it must not be answered with the first invoice. 0024 records the same decision for
 * `booking_idempotency.request_fingerprint`: handing back a document for somebody else's basket looks
 * exactly like success to the caller, and the discrepancy is found by a customer.
 */
export class IdempotencyKeyReused extends AppError {
  constructor(key: string, expected: string, received: string) {
    super(
      'conflict',
      `IdempotencyKeyReused: checkout key "${key}" was claimed by a different basket ` +
        `(fingerprint "${expected}", this request "${received}"). A replay with a different basket is ` +
        'a caller bug, not a retry, and returning the first invoice for it would be read as success.',
      { details: { key, expected, received } },
    )
    this.name = 'IdempotencyKeyReused'
  }
}

/** Raised when an appointment is already on an issued document. The answer is a credit note, not a bill. */
export class AppointmentAlreadyBilled extends AppError {
  constructor(message: string) {
    super('conflict', message, {
      details: { sqlState: UNIQUE_VIOLATION, constraint: CHECKOUT_CONSTRAINT.appointmentOnce },
    })
    this.name = 'AppointmentAlreadyBilled'
  }
}

/** Raised when the appointments being billed do not all belong to one booking, or do not exist. */
export class CheckoutAppointmentsNotOneBooking extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('validation', `CheckoutAppointmentsNotOneBooking: ${message}`, { details })
    this.name = 'CheckoutAppointmentsNotOneBooking'
  }
}

/** Raised when the tender rows and the journal entry disagree about where the money went. */
export class TenderPostingDisagrees extends AppError {
  constructor(accountCode: string, tenderedFils: number, postedFils: number) {
    super(
      'invariant_violated',
      `TenderPostingDisagrees: the tenders put ${tenderedFils} fils into account ${accountCode} and ` +
        `the journal entry moves ${postedFils} fils there. The two are mapped separately from one ` +
        'posting, so a disagreement is a mis-mapping — and it is the defect that lands cash in the ' +
        'card-clearing account with every other figure correct.',
      { details: { accountCode, tenderedFils, postedFils } },
    )
    this.name = 'TenderPostingDisagrees'
  }
}

/**
 * Translates a PostgreSQL error raised by the checkout schema into an `AppError`, or `null`.
 *
 * Falls through to {@link invoiceError} and {@link journalError} rather than restating the ZI* and ZL*
 * codes, because a second sentence for one SQLSTATE is a second sentence to keep in agreement. Exported
 * for the same reason those two are: an unbalanced entry and a document whose totals disagree arrive
 * from COMMIT, and a caller composing this service into a larger transaction of its own would be the
 * layer that sees them.
 */
export function checkoutError(err: unknown): AppError | null {
  if (sqlState(err) === UNIQUE_VIOLATION) {
    const constraint = constraintName(err)
    const message = err instanceof Error ? err.message : String(err)
    if (constraint === CHECKOUT_CONSTRAINT.appointmentOnce) {
      return new AppointmentAlreadyBilled(
        `AppointmentAlreadyBilled: that appointment is already on an issued document ` +
          `(${CHECKOUT_CONSTRAINT.appointmentOnce}). An issued invoice is never edited or voided; a ` +
          `correction is a credit note (docs/04 §4). ${message}`,
      )
    }
  }
  return invoiceError(err) ?? journalError(err)
}

/** True when `err` is the idempotency key being claimed twice. */
export function isCheckoutAlreadyFinalised(err: unknown): boolean {
  return (
    sqlState(err) === UNIQUE_VIOLATION && constraintName(err) === CHECKOUT_CONSTRAINT.idempotencyKey
  )
}

/** One tender, as the till records it, with the account the posting put it in. */
export interface CheckoutTenderInput {
  /**
   * A code from the `tender_type` registry — 'cash', 'card_in_salon' or 'bank_transfer' today.
   *
   * 0063 made this a CHECK over three literals and 0068 replaced it with a foreign key under the
   * same constraint name, `payment_tender_kind_known`, so the refusal a caller recognises is
   * unchanged and the SQLSTATE moved from 23514 to 23503.
   */
  readonly tenderKind: string
  /** Snapshotted onto the row, from `TENDER_ACCOUNT` in `@berelax/core`. */
  readonly postingAccountCode: string
  /** Integer fils, strictly positive. */
  readonly amountFils: number
  /** The terminal's approval code or the transfer reference. Absent for cash, which has none. */
  readonly reference?: string | null
}

/** One appointment this checkout bills, and the invoice line that states it. */
export interface CheckoutAppointmentInput {
  readonly appointmentId: string
  /**
   * Which line of the document billed it, or absent.
   *
   * Absent for a package redemption: its gross is zero, so the document does not state it as a line at
   * all, and a line number pointing at somebody else's line would be worse than none.
   */
  readonly lineNo?: number | null
}

export interface FinaliseCheckoutInput {
  /**
   * The caller's key for this checkout — the till's request id. Supplied, never generated here.
   *
   * A retry of the same request must carry the same key. That is the whole contract: the key is what
   * makes the second attempt return the first attempt's invoice instead of issuing another.
   */
  readonly idempotencyKey: string
  readonly basketId: string
  /**
   * A hash of the basket this key is claiming.
   *
   * Any stable digest of what is being billed. It is compared, never interpreted: a replay carrying a
   * different one is refused with {@link IdempotencyKeyReused} rather than answered with the first
   * invoice.
   */
  readonly requestFingerprint: string
  /** The business day, `YYYY-MM-DD`, resolved with `resolveTradingDate`. Never a calendar date. */
  readonly tradingDate: string
  /** Already derived by `@berelax/core`. `bookingId` is filled in here from the appointments. */
  readonly invoice: IssueInvoiceInput
  /** Already balanced by `postEntry`. Mapped field for field from core's `JournalEntry`. */
  readonly journal: JournalEntryInput
  readonly tenders: readonly CheckoutTenderInput[]
  /** At least one. The link rows, and the constraint that stops a second bill. */
  readonly appointments: readonly CheckoutAppointmentInput[]
  /** `null` for a cash sale at the desk with no customer record (ADR 0014). */
  readonly customerId?: string | null
}

export interface RecordedTender {
  readonly id: string
  readonly tenderNo: number
  readonly tenderKind: string
  readonly postingAccountCode: string
  readonly amountFils: number
  readonly reference: string | null
  readonly tradingDate: string
  readonly receivedAt: Date
}

export interface FinalisedCheckout {
  readonly idempotencyKey: string
  readonly basketId: string
  readonly invoice: IssuedInvoice
  readonly journalEntry: PostedJournalEntry
  readonly tenders: readonly RecordedTender[]
  readonly appointmentIds: readonly string[]
  readonly bookingId: string | null
  readonly customerId: string | null
  readonly tradingDate: string
  readonly tenderTotalFils: number
  /**
   * True when THIS call did the work; false when the key was already claimed and this is the winner's
   * result read back.
   *
   * Carried so a caller can tell a fresh sale from a retry without comparing timestamps. It is not a
   * success flag: both values are success.
   */
  readonly created: boolean
}

interface TenderRow {
  readonly id: string
  readonly tender_no: number
  readonly tender_kind: string
  readonly posting_account_code: string
  readonly amount_fils: string
  readonly reference: string | null
  readonly trading_date: string
  readonly received_at: Date
}

// The driver returns bigint as a string so a fils amount cannot lose precision in transit; Number() is
// applied once, here, where the value re-enters TypeScript.
function toTender(row: TenderRow): RecordedTender {
  return {
    id: row.id,
    tenderNo: row.tender_no,
    tenderKind: row.tender_kind,
    postingAccountCode: row.posting_account_code,
    amountFils: Number(row.amount_fils),
    reference: row.reference,
    tradingDate: row.trading_date,
    receivedAt: row.received_at,
  }
}

function requireFinalisable(input: FinaliseCheckoutInput): void {
  for (const [field, value] of [
    ['idempotencyKey', input.idempotencyKey],
    ['basketId', input.basketId],
    ['requestFingerprint', input.requestFingerprint],
  ] as const) {
    if (value.trim().length === 0) {
      throw new AppError('validation', `finaliseCheckout: ${field} may not be blank`)
    }
  }
  if (!ISO_DATE.test(input.tradingDate)) {
    throw new AppError(
      'validation',
      `finaliseCheckout: tradingDate must be an ISO business day (YYYY-MM-DD), received ` +
        `"${input.tradingDate}"`,
    )
  }
  if (input.tenders.length === 0) {
    // Refused before anything is written, because failing here is the difference between a rejected
    // request and a rolled-back statutory number allocation. A checkout that collected nothing is not a
    // sale: a wholly prepaid basket has no gross at all and `NothingToPost` in core refuses it first.
    throw new AppError(
      'validation',
      `finaliseCheckout: checkout "${input.idempotencyKey}" has no tender. A sale that collected ` +
        'nothing is a package redemption (M-TILL-09) or a receivable (M-TILL-07), not a finalisation.',
    )
  }
  for (const [index, tender] of input.tenders.entries()) {
    if (!Number.isInteger(tender.amountFils) || tender.amountFils <= 0) {
      // The `fils_nonneg` domain is bigint, so PostgreSQL would ROUND a fractional value rather than
      // refuse it, and half a fils reconciled against a drawer cannot be explained by anyone.
      throw new AppError(
        'validation',
        `finaliseCheckout: tender ${index + 1} (${tender.tenderKind}) carries ` +
          `${tender.amountFils} fils`,
      )
    }
  }
  if (input.appointments.length === 0) {
    throw new AppError(
      'validation',
      `finaliseCheckout: checkout "${input.idempotencyKey}" names no appointment. The link is what ` +
        'makes a second bill for the same treatment impossible, so a checkout without one is a ' +
        'document nothing protects.',
    )
  }
  const seen = new Set<string>()
  for (const appointment of input.appointments) {
    if (seen.has(appointment.appointmentId)) {
      // Caught here as well as by the primary key, because the primary key's message names two uuids
      // and this one names the mistake: the second row of a couples booking in front of the operator.
      throw new AppError(
        'validation',
        `finaliseCheckout: appointment "${appointment.appointmentId}" is named twice on one checkout`,
      )
    }
    seen.add(appointment.appointmentId)
  }
}

/**
 * Cross-checks the tenders against the entry: same accounts, same amounts.
 *
 * Not a re-derivation — nothing is recomputed from a rate or a gross. It is an agreement check between
 * two structures the caller mapped separately from one `CheckoutPosting`, and it is the one disagreement
 * no constraint in the database can see, because it spans `payment` and `journal_line`.
 *
 * Compared as a NET movement per account (`debit - credit`), not as a sum of debits: an account that
 * both received and gave back within one entry moved the difference, and comparing gross debits would
 * refuse a legitimate entry the first time a checkout needed one.
 */
function requireTendersMatchThePosting(input: FinaliseCheckoutInput): number {
  const tendered = new Map<string, number>()
  let total = 0
  for (const tender of input.tenders) {
    tendered.set(
      tender.postingAccountCode,
      (tendered.get(tender.postingAccountCode) ?? 0) + tender.amountFils,
    )
    total += tender.amountFils
  }
  for (const [accountCode, tenderedFils] of tendered) {
    let posted = 0
    for (const line of input.journal.lines) {
      if (line.accountCode === accountCode) posted += line.debitFils - line.creditFils
    }
    if (posted !== tenderedFils) {
      throw new TenderPostingDisagrees(accountCode, tenderedFils, posted)
    }
  }
  return total
}

/**
 * The booking every named appointment belongs to.
 *
 * Read inside the transaction rather than accepted as an argument, so `invoice.booking_id` and
 * `invoice_appointment` cannot disagree: one is computed from the other. A checkout whose appointments
 * span two bookings is refused — the acceptance asks for one `booking_id` on the events "so A-FIRST can
 * reach PAID", and a document that billed two bookings could only name one of them.
 *
 * An appointment the diary does not have is refused too. Without that check a typo'd id would produce a
 * document linked to nothing, and the UNIQUE that stops a second bill would be protecting a row that
 * describes no treatment.
 */
async function bookingOf(
  uow: UnitOfWork,
  input: FinaliseCheckoutInput,
): Promise<{ bookingId: string | null; customerId: string | null }> {
  const ids = input.appointments.map((appointment) => appointment.appointmentId)
  const rows = await uow.sql<{ booking_id: string; customer_id: string; n: string }[]>`
    select b.id as booking_id, b.customer_id, count(*)::text as n
      from appointment a
      join booking b on b.id = a.booking_id
     where a.id = any(${ids}::uuid[])
     group by b.id, b.customer_id
  `
  const found = rows.reduce((total, row) => total + Number(row.n), 0)
  if (found !== ids.length) {
    throw new CheckoutAppointmentsNotOneBooking(
      `${ids.length} appointment(s) were named and ${found} exist. A document linked to an ` +
        'appointment the diary does not have is protected by a UNIQUE on a row that describes no ' +
        'treatment.',
      { named: ids.length, found, appointmentIds: ids },
    )
  }
  if (rows.length !== 1) {
    throw new CheckoutAppointmentsNotOneBooking(
      `those appointments belong to ${rows.length} bookings. One checkout is one bill: the events ` +
        'carry a single booking id, and a document that billed two could only name one of them.',
      { bookings: rows.map((row) => row.booking_id), appointmentIds: ids },
    )
  }
  const only = rows[0] as { booking_id: string; customer_id: string }
  return {
    bookingId: only.booking_id,
    // The caller's customer id wins when it supplies one — a cash sale at the desk has none (ADR 0014)
    // and passes `null` explicitly — and the booking's is the fallback, read rather than trusted.
    customerId: input.customerId ?? only.customer_id,
  }
}

/** Reads a finalisation back by its key, with the invoice, the entry and the tenders. */
export async function readFinalisedCheckout(
  sql: Sql,
  idempotencyKey: string,
): Promise<FinalisedCheckout | null> {
  const [claim] = await sql<
    {
      idempotency_key: string
      request_fingerprint: string
      basket_id: string
      invoice_id: string
      journal_entry_id: string
      booking_id: string | null
      customer_id: string | null
      trading_date: string
      tender_total_fils: string
    }[]
  >`
    select idempotency_key, request_fingerprint, basket_id, invoice_id, journal_entry_id,
           booking_id, customer_id, trading_date::text as trading_date, tender_total_fils
      from checkout_finalisation where idempotency_key = ${idempotencyKey}
  `
  if (!claim) return null

  const invoice = await readInvoice(sql, claim.invoice_id)
  const journalEntry = await readJournalEntry(sql, claim.journal_entry_id)
  if (invoice === null || journalEntry === null) {
    // Unreachable through the foreign keys, and checked anyway: returning a half-populated
    // `FinalisedCheckout` to a retry would hand the till an invoice id with no document behind it.
    throw new AppError(
      'invariant_violated',
      `checkout "${idempotencyKey}" claims invoice "${claim.invoice_id}" and entry ` +
        `"${claim.journal_entry_id}", and one of them is missing`,
    )
  }

  const tenders = await sql<TenderRow[]>`
    select id, tender_no, tender_kind, posting_account_code, amount_fils, reference,
           trading_date::text as trading_date, received_at
      from payment where invoice_id = ${claim.invoice_id} order by tender_no
  `
  const links = await sql<{ appointment_id: string }[]>`
    select appointment_id from invoice_appointment
     where invoice_id = ${claim.invoice_id} order by appointment_id
  `

  return {
    idempotencyKey: claim.idempotency_key,
    basketId: claim.basket_id,
    invoice,
    journalEntry,
    tenders: tenders.map(toTender),
    appointmentIds: links.map((link) => link.appointment_id),
    bookingId: claim.booking_id,
    customerId: claim.customer_id,
    tradingDate: claim.trading_date,
    tenderTotalFils: Number(claim.tender_total_fils),
    created: false,
  }
}

/** The fingerprint a key was claimed with, or `null` when the key is unclaimed. */
async function claimedFingerprint(sql: Sql, key: string): Promise<string | null> {
  const [row] = await sql<{ request_fingerprint: string }[]>`
    select request_fingerprint from checkout_finalisation where idempotency_key = ${key}
  `
  return row?.request_fingerprint ?? null
}

/**
 * Finalises a checkout in one transaction, or in none.
 *
 * The order of the writes is the design and each step is placed where a failure in it proves something:
 *
 *   1. the invoice and its lines — which allocates the statutory number under the counter's row lock;
 *   2. the journal entry and its lines — a locked period (`ZL002`) or an unknown account refuses HERE,
 *      after the invoice rows exist, which is what makes the rollback visible;
 *   3. the tenders;
 *   4. the idempotency claim — where a concurrent retry serialises, and before the appointment link so
 *      that a retry trips the key rather than the appointment;
 *   5. the appointment links — `invoice_appointment_appointment_once` refuses a second bill;
 *   6. the audit row and the `payment.recorded` event.
 *
 * and then COMMIT, where the deferred triggers check that the entry balances and that the document's
 * totals equal the sum of its lines. A failure at any of the seven leaves nothing behind.
 */
export async function finaliseCheckout(
  sql: Sql,
  actor: Actor,
  input: FinaliseCheckoutInput,
  context: RequestContext = {},
): Promise<FinalisedCheckout> {
  requireFinalisable(input)
  const tenderTotalFils = requireTendersMatchThePosting(input)

  try {
    return await withUnitOfWork(
      sql,
      actor,
      async (uow) => {
        const { bookingId, customerId } = await bookingOf(uow, input)

        const invoice = await issueInvoice(uow, { ...input.invoice, bookingId })
        const journalEntry = await postJournalEntry(uow, input.journal)

        const tenders: RecordedTender[] = []
        for (const [index, tender] of input.tenders.entries()) {
          // One statement per tender, like `issueInvoice`'s lines: a multi-row INSERT would hide a
          // per-tender failure behind whichever row the planner reached first.
          const [row] = await uow.sql<TenderRow[]>`
            insert into payment (
              invoice_id, tender_no, tender_kind, posting_account_code, amount_fils, reference,
              trading_date
            ) values (
              ${invoice.id}, ${index + 1}, ${tender.tenderKind}, ${tender.postingAccountCode},
              ${tender.amountFils}, ${tender.reference ?? null}, ${input.tradingDate}::date
            )
            returning id, tender_no, tender_kind, posting_account_code, amount_fils, reference,
                      trading_date::text as trading_date, received_at
          `
          if (!row) {
            throw new AppError('invariant_violated', 'insert into payment returned no row')
          }
          tenders.push(toTender(row))
        }

        await uow.sql`
          insert into checkout_finalisation (
            idempotency_key, request_fingerprint, basket_id, invoice_id, journal_entry_id,
            booking_id, customer_id, trading_date, tender_total_fils
          ) values (
            ${input.idempotencyKey}, ${input.requestFingerprint}, ${input.basketId},
            ${invoice.id}, ${journalEntry.entryId}, ${bookingId}, ${customerId},
            ${input.tradingDate}::date, ${tenderTotalFils}
          )
        `

        for (const appointment of input.appointments) {
          await uow.sql`
            insert into invoice_appointment (invoice_id, appointment_id, line_no)
            values (${invoice.id}, ${appointment.appointmentId}, ${appointment.lineNo ?? null})
          `
        }

        const finalised: FinalisedCheckout = {
          idempotencyKey: input.idempotencyKey,
          basketId: input.basketId,
          invoice,
          journalEntry,
          tenders,
          appointmentIds: input.appointments.map((appointment) => appointment.appointmentId),
          bookingId,
          customerId,
          tradingDate: input.tradingDate,
          tenderTotalFils,
          created: true,
        }

        // No `before` state, and none is fabricated. A checkout has no prior version — the invoice and
        // the journal entry it produced are both append-only — and a fabricated `before` would be a
        // record of something that never existed. `issueInvoice` and `postJournalEntry` have each
        // written their own audit row already; this one is the row that says the three are one act.
        await uow.audit.record({
          action: 'checkout.finalise',
          entityType: 'checkout_finalisation',
          entityId: input.idempotencyKey,
          operation: 'create',
          after: finalised,
        })

        await uow.publish({
          eventType: 'payment.recorded',
          aggregateType: 'invoice',
          aggregateId: invoice.id,
          payload: {
            // Both ids the acceptance asks for, on both events: `invoice.issued` carries them because
            // `invoice.booking_id` and `invoice.customer_id` are columns on the document (0063, 0026).
            bookingId,
            customerId,
            displayNumber: invoice.displayNumber,
            journalEntryId: journalEntry.entryId,
            tradingDate: input.tradingDate,
            tenderCount: tenders.length,
            tenderTotalFils,
            tenders: tenders.map((tender) => ({
              tenderKind: tender.tenderKind,
              amountFils: tender.amountFils,
              postingAccountCode: tender.postingAccountCode,
            })),
          },
          // The invoice ROW, exactly as `invoice.issued` beside it — and these two are written in ONE
          // transaction, so keying them differently was the defect. `ec561e7` moved `invoice.issued` off
          // the display number because a statutory number is reset by design (the counter restarts with an
          // empty period key, which a TRUNCATE does) and left this one behind: the pair then disagreed
          // about what identifies a finalisation, and `checkout-finalise.itest.ts` went red on the
          // assertion that they match. `aggregateId` on this very event is already `invoice.id`.
          idempotencyKey: `payment.recorded:${invoice.id}`,
        })

        return finalised
      },
      context,
    )
  } catch (err) {
    if (isCheckoutAlreadyFinalised(err)) {
      // The key was claimed while this transaction was running, so this transaction has rolled back:
      // its invoice number went back to the pool and not one of its rows survives. Everything the
      // caller asked for exists — the winner wrote it — so the winner's result is the answer, and the
      // read has to happen in a NEW transaction because the losing one is aborted.
      const fingerprint = await claimedFingerprint(sql, input.idempotencyKey)
      if (fingerprint !== null && fingerprint !== input.requestFingerprint) {
        throw new IdempotencyKeyReused(input.idempotencyKey, fingerprint, input.requestFingerprint)
      }
      const already = await readFinalisedCheckout(sql, input.idempotencyKey)
      if (already !== null) return already
      // The claim was rolled back between the conflict and this read, which is the losing side of two
      // transactions that BOTH failed. Nothing is finalised, and reporting the original refusal is
      // more honest than reporting a success nobody achieved.
    }
    throw checkoutError(err) ?? err
  }
}
