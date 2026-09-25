import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '../audit.ts'
import { createConnection, type Sql } from '../connection.ts'
import type { HandlerRegistration, StoredEvent } from '../outbox.ts'
import { drainOutbox } from '../outbox.ts'
import type { IssueInvoiceInput } from '../repositories/invoice.ts'
import { issueInvoice } from '../repositories/invoice.ts'
import type { JournalEntryInput } from '../repositories/journal.ts'
import { lockAccountingPeriod, postJournalEntry } from '../repositories/journal.ts'
import { withUnitOfWork } from '../tx.ts'
import type { FinaliseCheckoutInput } from './checkout-finalise.ts'
import {
  AppointmentAlreadyBilled,
  CHECKOUT_CONSTRAINT,
  CheckoutAppointmentsNotOneBooking,
  finaliseCheckout,
  IdempotencyKeyReused,
  isCheckoutAlreadyFinalised,
  readFinalisedCheckout,
  TenderPostingDisagrees,
} from './checkout-finalise.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * M-TILL-06 — one transaction, idempotent by constraint, and a journal that balances.
 *
 * Three things are proved here, each in the only way that proves anything:
 *
 *   1. **One transaction.** A failure is INJECTED between the writes — after the invoice, after the
 *      journal, after the tenders, and at COMMIT itself — and every one of the tables the transaction
 *      touches is counted before and after. A test that committed successfully would prove nothing
 *      about atomicity, so each of the four cases also runs the SAME checkout with the injection
 *      removed and watches it commit.
 *   2. **Idempotent.** Two finalisations with one key produce one invoice, one entry and one tender
 *      set, and the refusal is asserted **by constraint name**: `checkout_finalisation_key_pk`, with
 *      `checkout_finalisation_one_invoice` and `checkout_finalisation_one_entry` beside it so that each
 *      probe is about the constraint it names rather than about "a conflict". A second call that merely
 *      returned early would be lucky, not idempotent.
 *   3. **The journal balances.** Every figure below is computed **by hand in this file** and written as
 *      a constant with its arithmetic beside it. `packages/db` may not import `packages/core`
 *      (dependency-cruiser's `db-must-not-import-core`), which is convenient here rather than
 *      inconvenient: nothing in this file can be derived by the code under test.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind
 * (brief rule 12). So:
 *
 *   - the trading date `2099-11-19` is used by no other suite, and the rooms, service, variant,
 *     customer, bookings and appointments are this file's own and carry {@link MARKER};
 *   - every row count narrows to ONE CASE's rows. `invoice.notes` carries the case's idempotency key,
 *     so `invoice: 0` after an aborted finalisation is a statement about that case and not about a
 *     table 188 seeded documents and a dozen suites also write to. A `count(*)` would be a different
 *     number on every run;
 *   - the keys carry a per-run nonce, so a run that crashed half way cannot make the next one look
 *     already-finalised;
 *   - `afterAll` truncates the invoice family as the OWNER before deleting the customer, which is
 *     `tax-document.itest.ts`'s reason and decision: `invoice.customer_id` is ON DELETE RESTRICT and
 *     `customer-identity.itest.ts` clears the table with a bare `delete from customer`, so a document
 *     left pointing at this file's customer would fail THAT suite's statement. The journal entries are
 *     left: they are append-only, and every suite that reads the journal reads a delta.
 */

const MARKER = 'mtill06 checkout finalise itest'
const TRADING_DATE = '2099-11-19'
const PROBE = 'mtill06_finalise_probe'
const PROBE_PHONE = '+971590000619'

/** Fifteen digits. A test value: the real TRN is unknown (Y1-trn) and the placeholder is refused. */
const TEST_TRN = '100123456700003'

const TILL: Actor = {
  kind: 'staff',
  id: '55555555-5555-4555-8555-555555555555',
  label: 'M-TILL-06 finalise itest',
}

const ISSUER = {
  legalName: 'BE RELAX SPA - L.L.C - O.P.C',
  tradingName: 'BE RELAX - Massage Center and Spa',
  trn: TEST_TRN,
  addressSnapshot: '250 Al Meena Street\nTower Block A/B, M-Floor\nAl Zahiyah, Abu Dhabi',
  emirate: 'Abu Dhabi',
} as const

// --- the figures, computed by hand --------------------------------------------------------------
//
// Two treatments at AED 262.50 each, one of them 10% off, plus a gratuity of AED 30.00.
//
//   line 1, undiscounted:  gross 26_250   net = roundHalfUp(26_250 x 10_000 / 10_500) = 25_000
//                                         vat = 26_250 - 25_000                       =  1_250
//   line 2, 10% off:       discount = roundHalfUp(26_250 x 1_000 / 10_000)             =  2_625
//                          charged  = 26_250 - 2_625                                  = 23_625
//                          net      = roundHalfUp(23_625 x 10_000 / 10_500)            = 22_500
//                          vat      = 23_625 - 22_500                                  =  1_125
//
// The DOCUMENT states what was charged, per line, and its totals are the SUMS of those lines:
//
//   net_total   = 25_000 + 22_500 = 47_500
//   vat_total   =  1_250 +  1_125 =  2_375
//   gross_total = 26_250 + 23_625 = 49_875          (and 47_500 + 2_375 = 49_875, exactly)
//
// The JOURNAL posts the discount as contra revenue rather than netting it off 4010, so revenue is
// credited at the prices the treatments were SOLD at and the reduction stays visible:
//
//   revenue credited (4010) = 25_000 + 25_000                    = 50_000
//   discount debited (4095) = 25_000 - 22_500                    =  2_500
//   output VAT   (2030) Cr  = 1_250 + 1_250 - (1_250 - 1_125)    =  2_375
//   tips         (2040) Cr  =                                       3_000
//   cash         (1010) Dr  = 49_875 + 3_000                     = 52_875
//
//   debits  = 52_875 + 2_500          = 55_375
//   credits = 50_000 + 2_375 + 3_000  = 55_375
//
// and the three identities: revenue net of contra is 50_000 - 2_500 = 47_500, the document's net; the
// output VAT credited is 2_375, the document's VAT; the tenders are 52_875, the document's gross plus
// the gratuity, which is on no tax invoice because it is not consideration for a supply.
const FULL_GROSS = 26_250
const FULL_NET = 25_000
const FULL_VAT = 1_250
const DISCOUNTED_GROSS = 23_625
const DISCOUNTED_NET = 22_500
const DISCOUNTED_VAT = 1_125
const DOC_NET = 47_500
const DOC_VAT = 2_375
const DOC_GROSS = 49_875
const TIP = 3_000
const TENDERED = 52_875
const REVENUE_CREDITED = 50_000
const DISCOUNT_DEBITED = 2_500
const SIDE_TOTAL = 55_375

/** The chart codes this unit posts to, written out rather than imported: db may not import core. */
const CASH_IN_DRAWER = '1010'
const CARD_CLEARING = '1040'
const OUTPUT_VAT = '2030'
const TIPS_PAYABLE = '2040'
const TREATMENT_REVENUE = '4010'
const DISCOUNTS_GIVEN = '4095'
/** A code the chart does not contain, for the foreign-key injection. */
const NO_SUCH_ACCOUNT = '9999'

/** Four rooms of one client each, and the trading window, so no two appointments contend. */
const ROOM_COUNT = 4
const FIRST_HOUR = 11
const LAST_HOUR = 23

let sql: Sql
let customerId: string
let bookingId: string
let otherBookingId: string
let variantId: string
let roomIds: string[] = []
/** How many appointments this run has created. Decides the room and the hour of the next one. */
let allotted = 0
let otherBookingAppointment: string
/** A per-run nonce: a crashed run must not make the next one look already-finalised. */
let nonce: string

interface Counts {
  readonly invoice: number
  readonly invoiceLine: number
  readonly journalEntry: number
  readonly journalLine: number
  readonly payment: number
  readonly finalisation: number
  readonly link: number
}

const ZERO: Counts = {
  invoice: 0,
  invoiceLine: 0,
  journalEntry: 0,
  journalLine: 0,
  payment: 0,
  finalisation: 0,
  link: 0,
}

/**
 * One completed appointment, at the price the booking was taken at.
 *
 * Each one gets its own therapist id and its own (room, hour) slot: `appointment_therapist_no_overlap`
 * is an exclusion constraint on (therapist, period) and the capacity trigger counts client places per
 * room, and `completed` still HOLDS its room and therapist (0024) — a finished treatment occupied them,
 * and a second booking over the same past period is a double booking that happened, not a free slot.
 * Four rooms across the 11:00-23:00 window is 52 slots, which is more than this file uses.
 */
async function newAppointment(booking: string): Promise<string> {
  const index = allotted
  allotted += 1
  const room = roomIds[index % ROOM_COUNT] as string
  const hour = FIRST_HOUR + Math.floor(index / ROOM_COUNT)
  if (hour > LAST_HOUR) {
    // Louder than an over-capacity refusal from a trigger three frames away, and it names the fix.
    throw new Error(
      `the itest ran out of (room, hour) slots after ${index} appointments — raise ROOM_COUNT`,
    )
  }
  const start = `${TRADING_DATE} ${String(hour).padStart(2, '0')}:00:00+04`
  const end = `${TRADING_DATE} ${String(hour).padStart(2, '0')}:59:00+04`
  const therapistId = `22222222-3333-4444-8555-${String(index).padStart(12, '0')}`
  const [appointment] = await sql<{ id: string }[]>`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes,
       therapist_buffer_minutes)
    values (${booking}, ${TRADING_DATE}, ${variantId}, 'solo'::service_shape, ${therapistId},
            ${room}, ${`[${start},${end})`}::tstzrange,
            'completed'::appointment_status, ${FULL_GROSS}, ${FULL_NET}, ${FULL_VAT}, 500, 20, 10)
    returning id
  `
  return appointment?.id as string
}

/** A fresh pair of appointments on this file's booking. Two, because the document has two lines. */
async function newPair(): Promise<readonly [string, string]> {
  return [await newAppointment(bookingId), await newAppointment(bookingId)]
}

beforeAll(async () => {
  sql = createConnection({ url, max: 8 })
  nonce = `${Date.now()}`

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = customer?.id as string

  // `appointment.trading_date` is a foreign key into the trading calendar (0011), so no fixture can
  // invent a date the premises does not trade on. 11:00-02:00 in Asia/Dubai.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${`${TRADING_DATE} 11:00:00+04`}::timestamptz,
            ${'2099-11-20 02:00:00+04'}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  roomIds = []
  for (let index = 1; index <= ROOM_COUNT; index += 1) {
    const [room] = await sql<{ id: string }[]>`
      insert into rooms (code, name, room_type, capacity, display_order, notes)
      values (${`mtill06-r${index}`}, ${`Probe room ${index}`}, 'standard'::room_type, 1,
              ${90 + index}, ${MARKER})
      on conflict (code) do update set capacity = excluded.capacity
      returning id
    `
    roomIds.push(room?.id as string)
  }

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, 'mtill06-finalise-probe', 'Probe massage',
            'Normal Massage (Asian)', 20, 96)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${service?.id as string}, 60, ${FULL_GROSS}, ${MARKER})
    on conflict (service_id, duration_minutes)
      do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = variant?.id as string

  const newBooking = async (): Promise<string> => {
    const [booking] = await sql<{ id: string }[]>`
      insert into booking (customer_id, source, notes)
      values (${customerId}, 'front_desk', ${MARKER})
      returning id
    `
    return booking?.id as string
  }
  bookingId = await newBooking()
  otherBookingId = await newBooking()
  otherBookingAppointment = await newAppointment(otherBookingId)

  await sweepOrphanedDocumentEvents()
})

/**
 * Removes `invoice.issued` and `payment.recorded` rows whose document no longer exists.
 *
 * Not tidiness — without it the outbox cases below assert on rows that were never written, and the
 * reason is a genuine cross-suite hazard (brief rule 12) rather than anything about this file:
 *
 *   - both events derive their idempotency key from the STATUTORY DISPLAY NUMBER, deliberately, so that
 *     a retry of one finalisation cannot enqueue twice;
 *   - `publishEvent` is `on conflict (idempotency_key) do nothing`, so a key already in the table means
 *     "already recorded" and inserts nothing;
 *   - three suites (`invoice.itest.ts`, `invoice-document.itest.ts` and `tax-document.itest.ts`) reset
 *     `document_series.next_number` to 1 in their own `beforeEach`, and every suite that truncates
 *     `invoice` — including this one — removes the documents while the events stay. So the SAME display
 *     number is issued again on the next run, its key is already claimed by a row whose document was
 *     truncated away, and the events are silently not written.
 *
 * The sweep is therefore narrow by construction: it removes only rows whose `aggregate_id` names no
 * invoice at all. Such a row can never be delivered to anything useful — a handler would be told about a
 * document that does not exist — and no live document can depend on one. `outbox_delivery` is
 * `on delete cascade`, so the claims go with them.
 */
async function sweepOrphanedDocumentEvents(): Promise<void> {
  await sql`
    delete from outbox_event e
     where e.event_type in ('invoice.issued', 'payment.recorded')
       and not exists (select 1 from invoice i where i.id::text = e.aggregate_id)
  `
}

afterAll(async () => {
  // The invoice family goes first, as the OWNER. `invoice` refuses DELETE for every role including the
  // owner (ZI003), so `truncate` is the only legal removal — and it has to happen before the customer
  // is deleted, because `invoice.customer_id` is ON DELETE RESTRICT and `customer-identity.itest.ts`
  // clears the table with a bare `delete from customer`. Every referencing table is NAMED rather than
  // reached with CASCADE, so the next one to reference `invoice` fails loudly here instead of having
  // its rows removed by a statement that never mentioned it.
  await sql?.unsafe(
    'truncate refund, checkout_finalisation, payment, invoice_appointment, invoice_line, invoice',
  )
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from period_lock where reason = ${MARKER}`
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await sql?.end({ timeout: 5 })
})

/** The document, exactly as the hand-computed figures state it. Two lines, at what was charged. */
function invoiceInput(
  notes: string,
  overrides: Partial<IssueInvoiceInput> = {},
): IssueInvoiceInput {
  return {
    documentKind: 'tax_invoice',
    seriesCode: 'TAX-INV',
    issuer: ISSUER,
    customer: { customerId, nameSnapshot: 'Customer 0042' },
    issueDate: TRADING_DATE,
    issueTradingDate: TRADING_DATE,
    taxPointDate: TRADING_DATE,
    lines: [
      {
        descriptionEn: 'Normal Massage (Asian), 60 min',
        quantity: 1,
        unitGrossFils: FULL_GROSS,
        vatRateBp: 500,
        netFils: FULL_NET,
        vatFils: FULL_VAT,
      },
      {
        descriptionEn: 'Normal Massage (Asian), 60 min — service recovery 10%',
        quantity: 1,
        unitGrossFils: DISCOUNTED_GROSS,
        vatRateBp: 500,
        netFils: DISCOUNTED_NET,
        vatFils: DISCOUNTED_VAT,
      },
    ],
    // The SUMS of the per-line figures. Passing a split of the 49_875 total instead is the change
    // M-TILL-04's deferred trigger exists to refuse (ZI001).
    netTotalFils: DOC_NET,
    vatTotalFils: DOC_VAT,
    grossTotalFils: DOC_GROSS,
    // How every count in this file narrows to one case. Not decoration: `count(*)` over `invoice` is a
    // different number on every run of a sequential suite that twelve other files write to.
    notes,
    ...overrides,
  }
}

/** The entry, exactly as the hand-computed figures state it. Five lines, sorted by account code. */
function journalInput(
  entryId: string,
  overrides: Partial<JournalEntryInput> = {},
): JournalEntryInput {
  return {
    entryId,
    entryDate: TRADING_DATE,
    narrative: 'Checkout, two treatments with one service recovery and a gratuity',
    source: 'sale',
    lines: [
      { accountCode: CASH_IN_DRAWER, debitFils: TENDERED, creditFils: 0, memo: 'Tendered (cash)' },
      {
        accountCode: OUTPUT_VAT,
        debitFils: 0,
        creditFils: DOC_VAT,
        memo: 'Output VAT on supplies',
      },
      { accountCode: TIPS_PAYABLE, debitFils: 0, creditFils: TIP, memo: 'Gratuities collected' },
      {
        accountCode: TREATMENT_REVENUE,
        debitFils: 0,
        creditFils: REVENUE_CREDITED,
        memo: 'Treatments delivered',
      },
      {
        accountCode: DISCOUNTS_GIVEN,
        debitFils: DISCOUNT_DEBITED,
        creditFils: 0,
        memo: 'Discounts and allowances',
      },
    ],
    ...overrides,
  }
}

interface CheckoutOptions {
  readonly key: string
  readonly appointmentIds: readonly string[]
  readonly invoice?: Partial<IssueInvoiceInput>
  readonly journal?: Partial<JournalEntryInput>
  readonly tenders?: FinaliseCheckoutInput['tenders']
  readonly fingerprint?: string
  readonly tradingDate?: string
}

function checkoutInput(options: CheckoutOptions): FinaliseCheckoutInput {
  const key = `mtill06-${nonce}-${options.key}`
  return {
    idempotencyKey: key,
    basketId: `basket-${key}`,
    requestFingerprint: options.fingerprint ?? `fp-${key}`,
    tradingDate: options.tradingDate ?? TRADING_DATE,
    invoice: invoiceInput(key, options.invoice),
    journal: journalInput(`je-${key}`, options.journal),
    tenders: options.tenders ?? [
      { tenderKind: 'cash', postingAccountCode: CASH_IN_DRAWER, amountFils: TENDERED },
    ],
    appointments: options.appointmentIds.map((appointmentId, index) => ({
      appointmentId,
      lineNo: index + 1,
    })),
    customerId,
  }
}

/**
 * Row counts for ONE case, in every table the transaction touches.
 *
 * Scoped through `invoice.notes`, which carries the case's idempotency key, and through the entry ids
 * the case used. Never `count(*)`: the suite runs sequentially against one database, the seed writes
 * documents and a dozen other files write more, so a global count would report this unit's atomicity as
 * somebody else's rows (brief rule 12).
 */
async function countsOf(
  input: FinaliseCheckoutInput,
  extraEntryIds: readonly string[] = [],
): Promise<Counts> {
  const entryIds = [input.journal.entryId, ...extraEntryIds]
  const [row] = await sql<Record<string, string>[]>`
    with mine as (select id from invoice where notes = ${input.idempotencyKey})
    select (select count(*)::text from mine)                                          as invoice,
           (select count(*)::text from invoice_line
             where invoice_id in (select id from mine))                               as invoice_line,
           (select count(*)::text from journal_entry where entry_id = any(${entryIds}))
                                                                                      as journal_entry,
           (select count(*)::text from journal_line where entry_id = any(${entryIds}))
                                                                                      as journal_line,
           (select count(*)::text from payment
             where invoice_id in (select id from mine))                               as payment,
           (select count(*)::text from checkout_finalisation
             where idempotency_key = ${input.idempotencyKey})                         as finalisation,
           (select count(*)::text from invoice_appointment
             where invoice_id in (select id from mine))                               as link
  `
  const counts = row as Record<string, string>
  return {
    invoice: Number(counts['invoice']),
    invoiceLine: Number(counts['invoice_line']),
    journalEntry: Number(counts['journal_entry']),
    journalLine: Number(counts['journal_line']),
    payment: Number(counts['payment']),
    finalisation: Number(counts['finalisation']),
    link: Number(counts['link']),
  }
}

const COMMITTED: Counts = {
  invoice: 1,
  invoiceLine: 2,
  journalEntry: 1,
  journalLine: 5,
  payment: 1,
  finalisation: 1,
  link: 2,
}

async function statusOf(appointmentId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`
    select status::text as status from appointment where id = ${appointmentId}
  `
  return row?.status as string
}

/** The SQLSTATE, constraint and message of a rejected promise. Never "an error was raised" (ADR 0003). */
async function refusalOf(promise: Promise<unknown>): Promise<{
  readonly code: string | undefined
  readonly constraint: string | undefined
  readonly message: string
  readonly error: unknown
}> {
  try {
    await promise
    return { code: undefined, constraint: undefined, message: 'the call succeeded', error: null }
  } catch (err) {
    const direct = (err as { code?: unknown }).code
    const carried = (err as { details?: { sqlState?: unknown } }).details?.sqlState
    const code = typeof direct === 'string' ? direct : carried
    const name = (err as { constraint_name?: unknown }).constraint_name
    const carriedName = (err as { details?: { constraint?: unknown } }).details?.constraint
    const constraint = typeof name === 'string' ? name : carriedName
    return {
      code: typeof code === 'string' ? code : undefined,
      constraint: typeof constraint === 'string' ? constraint : undefined,
      message: err instanceof Error ? err.message : String(err),
      error: err,
    }
  }
}

describe('one finalisation writes all five records, and the journal balances', () => {
  it('stores the document, the entry, the tenders and the links, at the hand-computed figures', async () => {
    const input = checkoutInput({ key: 'happy', appointmentIds: await newPair() })
    expect(await countsOf(input)).toEqual(ZERO)

    const finalised = await finaliseCheckout(sql, TILL, input)
    expect(finalised.created).toBe(true)

    // --- the document -------------------------------------------------------------------------
    expect(finalised.invoice.netTotalFils).toBe(DOC_NET)
    expect(finalised.invoice.vatTotalFils).toBe(DOC_VAT)
    expect(finalised.invoice.grossTotalFils).toBe(DOC_GROSS)
    expect(DOC_NET + DOC_VAT).toBe(DOC_GROSS)
    expect(finalised.invoice.bookingId).toBe(bookingId)
    expect(finalised.invoice.customerId).toBe(customerId)
    expect(finalised.invoice.lines.map((line) => line.lineGrossFils)).toEqual([
      FULL_GROSS,
      DISCOUNTED_GROSS,
    ])
    // Per-line VAT, summed. The document's 2_375 is 1_250 + 1_125 and is never a split of 49_875.
    expect(finalised.invoice.lines.reduce((total, line) => total + line.vatFils, 0)).toBe(DOC_VAT)

    // --- the entry ----------------------------------------------------------------------------
    const debits = finalised.journalEntry.lines.reduce((t, line) => t + line.debitFils, 0)
    const credits = finalised.journalEntry.lines.reduce((t, line) => t + line.creditFils, 0)
    expect(debits).toBe(SIDE_TOTAL)
    expect(credits).toBe(SIDE_TOTAL)
    expect(debits - credits).toBe(0)

    /** Credit-positive movement per account: revenue and VAT are credit-normal accounts. */
    const credited = new Map(
      finalised.journalEntry.lines.map((line) => [
        line.accountCode,
        line.creditFils - line.debitFils,
      ]),
    )
    // The three identities, each against a figure computed by hand at the top of this file.
    //
    //   revenue net of contra: 50_000 credited to 4010, 2_500 debited to 4095 -> 47_500
    expect((credited.get(TREATMENT_REVENUE) ?? 0) + (credited.get(DISCOUNTS_GIVEN) ?? 0)).toBe(
      DOC_NET,
    )
    expect(credited.get(TREATMENT_REVENUE)).toBe(REVENUE_CREDITED)
    expect(credited.get(DISCOUNTS_GIVEN)).toBe(-DISCOUNT_DEBITED)
    //   output VAT: the tax on what was charged
    expect(credited.get(OUTPUT_VAT)).toBe(DOC_VAT)
    //   the tenders: the document's gross plus the gratuity
    expect(-(credited.get(CASH_IN_DRAWER) ?? 0)).toBe(DOC_GROSS + TIP)
    //   and the gratuity, in a liability and nowhere near revenue or VAT
    expect(credited.get(TIPS_PAYABLE)).toBe(TIP)
    expect(REVENUE_CREDITED - DISCOUNT_DEBITED).toBe(DOC_NET)

    // --- the tenders and the links ------------------------------------------------------------
    expect(finalised.tenders).toHaveLength(1)
    expect(finalised.tenders[0]).toMatchObject({
      tenderNo: 1,
      tenderKind: 'cash',
      postingAccountCode: CASH_IN_DRAWER,
      amountFils: TENDERED,
      reference: null,
      tradingDate: TRADING_DATE,
    })
    expect(finalised.tenderTotalFils).toBe(TENDERED)
    expect(finalised.bookingId).toBe(bookingId)
    expect(finalised.appointmentIds).toHaveLength(2)

    expect(await countsOf(input)).toEqual(COMMITTED)

    // Read back through the public reader, so the rows really are in the database and not only in
    // the value the writer returned.
    const reRead = await readFinalisedCheckout(sql, input.idempotencyKey)
    expect(reRead?.created).toBe(false)
    expect(reRead?.invoice.id).toBe(finalised.invoice.id)
    expect(reRead?.journalEntry.entryId).toBe(finalised.journalEntry.entryId)
    expect(reRead?.tenderTotalFils).toBe(TENDERED)
    expect(reRead?.appointmentIds).toEqual([...finalised.appointmentIds].sort())
  }, 20_000)

  it('splits one checkout across two tenders and debits each account its own share', async () => {
    const input = checkoutInput({
      key: 'split',
      appointmentIds: await newPair(),
      tenders: [
        { tenderKind: 'cash', postingAccountCode: CASH_IN_DRAWER, amountFils: 2_875 },
        {
          tenderKind: 'card_in_salon',
          postingAccountCode: CARD_CLEARING,
          amountFils: 50_000,
          reference: 'APPROVAL-99',
        },
      ],
      journal: {
        lines: [
          {
            accountCode: CASH_IN_DRAWER,
            debitFils: 2_875,
            creditFils: 0,
            memo: 'Tendered (cash)',
          },
          {
            accountCode: CARD_CLEARING,
            debitFils: 50_000,
            creditFils: 0,
            memo: 'Tendered (card_in_salon)',
          },
          { accountCode: OUTPUT_VAT, debitFils: 0, creditFils: DOC_VAT, memo: 'Output VAT' },
          { accountCode: TIPS_PAYABLE, debitFils: 0, creditFils: TIP, memo: 'Gratuities' },
          {
            accountCode: TREATMENT_REVENUE,
            debitFils: 0,
            creditFils: REVENUE_CREDITED,
            memo: 'Treatments',
          },
          {
            accountCode: DISCOUNTS_GIVEN,
            debitFils: DISCOUNT_DEBITED,
            creditFils: 0,
            memo: 'Discounts',
          },
        ],
      },
    })
    expect(2_875 + 50_000).toBe(TENDERED)

    const finalised = await finaliseCheckout(sql, TILL, input)
    expect(finalised.tenders.map((tender) => tender.amountFils)).toEqual([2_875, 50_000])
    expect(finalised.tenders.map((tender) => tender.tenderNo)).toEqual([1, 2])
    expect(finalised.tenders[1]?.reference).toBe('APPROVAL-99')
    // Card money lands in the CLEARING account, not the bank: the terminal settles in a batch, net
    // of fees, days later, and debiting 1020 would leave the bank reconciliation permanently out.
    expect(finalised.tenders[1]?.postingAccountCode).toBe(CARD_CLEARING)
    expect(finalised.tenderTotalFils).toBe(TENDERED)
  }, 20_000)
})

describe('one transaction: a failure injected between the writes leaves nothing behind', () => {
  /**
   * Three injection points, each caused by DATA the service accepts — not by a hook or a spy, which
   * would prove that the hook works. The fourth seam, the appointment link, is the case after these.
   *
   *   - **after the invoice and five journal lines**: a sixth line on an account the chart does not
   *     contain, so `journal_line`'s foreign key refuses it with everything before it inserted;
   *   - **after the whole journal entry**: a tender kind the tender-type REGISTRY does not hold.
   *     0063 made that a CHECK and 0068 replaced it with a foreign key into `tender_type`, keeping the
   *     constraint's name — so the seam is unchanged and the SQLSTATE moved from 23514 to 23503;
   *   - **at COMMIT**: an entry one fils out, which every statement accepts and the DEFERRED trigger
   *     refuses at COMMIT. The strongest of the three, because nothing failed until the transaction
   *     did.
   */
  const injections = [
    {
      key: 'abort-account',
      name: 'a line on an account the chart does not contain, after the invoice and five lines',
      code: '23503',
      options: (): Pick<CheckoutOptions, 'journal'> => ({
        journal: {
          lines: [
            ...journalInput('x').lines,
            {
              accountCode: NO_SUCH_ACCOUNT,
              debitFils: 1,
              creditFils: 0,
              memo: 'an account nobody created',
            },
          ],
        },
      }),
    },
    {
      key: 'abort-tender',
      // `payment_tender_kind_known` is a FOREIGN KEY into `tender_type` since 0068 — under the same
      // name, because the name is the contract — so the refusal arrives as 23503 rather than 23514. The
      // injection point is the same one: the tender insert is the first statement after the whole
      // journal entry has been posted.
      name: 'a tender kind the tender-type registry does not hold, after the whole journal entry is posted',
      code: '23503',
      options: (): Pick<CheckoutOptions, 'tenders'> => ({
        tenders: [
          { tenderKind: 'gift_card', postingAccountCode: CASH_IN_DRAWER, amountFils: TENDERED },
        ],
      }),
    },
    {
      key: 'abort-commit',
      name: 'an entry that is one fils out, which only COMMIT can refuse',
      code: 'ZL003',
      options: (): Pick<CheckoutOptions, 'journal'> => ({
        journal: {
          lines: journalInput('x').lines.map((line) =>
            line.accountCode === TIPS_PAYABLE ? { ...line, creditFils: TIP + 1 } : line,
          ),
        },
      }),
    },
  ] as const

  for (const injection of injections) {
    it(`rolls back everything when the finalisation hits ${injection.name}`, async () => {
      const pair = await newPair()
      const input = checkoutInput({
        key: injection.key,
        appointmentIds: pair,
        ...injection.options(),
      })

      expect(await countsOf(input)).toEqual(ZERO)
      expect(await statusOf(pair[0])).toBe('completed')

      const refusal = await refusalOf(finaliseCheckout(sql, TILL, input))
      // By SQLSTATE, never by "it threw": a typo in a column name also throws, and a check that
      // accepts any failure stops being a check (ADR 0003).
      expect(refusal.code).toBe(injection.code)

      // Nothing in any of the tables, and both appointments untouched.
      expect(await countsOf(input)).toEqual(ZERO)
      expect(await statusOf(pair[0])).toBe('completed')
      expect(await statusOf(pair[1])).toBe('completed')

      // No outbox event either. `issueInvoice` and `postJournalEntry` publish inside this same
      // transaction, so an event that survived would mean the outbox is not transactional — which is
      // the entire reason the queue lives in PostgreSQL (docs/01 decision 4).
      const [events] = await sql<{ n: string }[]>`
          select count(*)::text as n from outbox_event
           where idempotency_key in (
             ${`ledger.entry.posted:${input.journal.entryId}`},
             ${`payment.recorded:${input.idempotencyKey}`}
           )
        `
      expect(Number(events?.n)).toBe(0)

      // And no audit row, which is the record whose absence an investigation cannot recover from.
      const [audits] = await sql<{ n: string }[]>`
          select count(*)::text as n from audit_event
           where action = 'checkout.finalise' and entity_id = ${input.idempotencyKey}
        `
      expect(Number(audits?.n)).toBe(0)

      // THE control, and it is not a formality: the SAME checkout with the injection removed and the
      // SAME two appointments commits. Without it, a renamed column or a broken connection string
      // would roll everything back and this case would report a pass having examined nothing.
      const clean = checkoutInput({ key: `${injection.key}-control`, appointmentIds: pair })
      const committed = await finaliseCheckout(sql, TILL, clean)
      expect(committed.created).toBe(true)
      expect(await countsOf(clean)).toEqual(COMMITTED)
    }, 20_000)
  }

  it('rolls back everything when the appointment link is refused, after the tenders and the claim', async () => {
    // The fourth seam. The link is the LAST write, so at the moment it is refused the invoice, its
    // lines, the entry, its lines, the tenders and the idempotency claim are all present in the
    // transaction — and none of them survives.
    const [shared, other] = await newPair()
    const firstRun = checkoutInput({ key: 'link-first', appointmentIds: [shared, other] })
    await finaliseCheckout(sql, TILL, firstRun)
    expect(await countsOf(firstRun)).toEqual(COMMITTED)

    const again = checkoutInput({
      key: 'link-second',
      appointmentIds: [shared, await newAppointment(bookingId)],
    })
    expect(await countsOf(again)).toEqual(ZERO)

    const refusal = await refusalOf(finaliseCheckout(sql, TILL, again))
    // By CONSTRAINT NAME, not by SQLSTATE alone: 23505 is also what a duplicate display number
    // raises, and the two failures need different answers.
    expect(refusal.constraint).toBe(CHECKOUT_CONSTRAINT.appointmentOnce)
    expect(refusal.error).toBeInstanceOf(AppointmentAlreadyBilled)
    // The message says what to do, because a bare 23505 in a log tells the front desk nothing.
    expect(refusal.message).toContain('credit note')

    expect(await countsOf(again)).toEqual(ZERO)
    // The control: the first finalisation is still there, so the rollback removed the SECOND
    // transaction's rows and not both.
    expect(await countsOf(firstRun)).toEqual(COMMITTED)
  }, 20_000)

  it('refuses a finalisation dated inside a locked period and writes nothing', async () => {
    const pair = await newPair()
    const periodId = `2099-11 (${nonce})`
    await withUnitOfWork(sql, TILL, (uow) =>
      lockAccountingPeriod(uow, {
        periodId,
        startsOn: '2099-11-01',
        endsOn: '2099-11-30',
        reason: MARKER,
        lockedByActorKind: 'system',
      }),
    )

    const input = checkoutInput({ key: 'locked', appointmentIds: pair })
    expect(await countsOf(input)).toEqual(ZERO)

    const refusal = await refusalOf(finaliseCheckout(sql, TILL, input))
    // ZL002, and the period identifier is IN the message: "posting refused" without it sends the
    // bookkeeper to the wrong month, and the entry they then chase is usually correct.
    expect(refusal.code).toBe('ZL002')
    expect(refusal.message).toContain('PeriodLocked')
    expect(refusal.message).toContain(periodId)

    // The invoice was already inserted when the journal was refused, so this is an atomicity
    // assertion as well as a period-lock one.
    expect(await countsOf(input)).toEqual(ZERO)
    expect(await statusOf(pair[0])).toBe('completed')

    // The control: with the lock removed the same checkout commits, so the refusal was the lock and
    // not something else about this input.
    await sql`delete from period_lock where reason = ${MARKER}`
    const retry = checkoutInput({ key: 'locked-control', appointmentIds: pair })
    const committed = await finaliseCheckout(sql, TILL, retry)
    expect(committed.created).toBe(true)
    expect(committed.journalEntry.entryDate).toBe(TRADING_DATE)
  }, 20_000)
})

describe('idempotent: the DATABASE refuses the second claim, by name', () => {
  it('produces one invoice, one entry and one tender set when the same key is finalised twice', async () => {
    const input = checkoutInput({ key: 'twice', appointmentIds: await newPair() })
    const winner = await finaliseCheckout(sql, TILL, input)
    expect(winner.created).toBe(true)

    // The second call is the SAME request replayed: same key, same fingerprint, and a fresh entry id,
    // because a retry generates its own. It must not issue a second document.
    const replay: FinaliseCheckoutInput = {
      ...input,
      journal: { ...input.journal, entryId: `${input.journal.entryId}-replay` },
    }
    const loser = await finaliseCheckout(sql, TILL, replay)

    expect(loser.created).toBe(false)
    expect(loser.invoice.id).toBe(winner.invoice.id)
    expect(loser.invoice.displayNumber).toBe(winner.invoice.displayNumber)
    expect(loser.journalEntry.entryId).toBe(winner.journalEntry.entryId)
    expect(loser.tenders.map((tender) => tender.id)).toEqual(
      winner.tenders.map((tender) => tender.id),
    )

    // One of everything — counting BOTH entry ids, so the zero rows for the replay's own entry are
    // what prove the second transaction rolled back rather than adding an orphan entry.
    expect(await countsOf(input, [replay.journal.entryId])).toEqual(COMMITTED)
    const [orphan] = await sql<{ n: string }[]>`
        select count(*)::text as n from journal_entry where entry_id = ${replay.journal.entryId}
      `
    expect(Number(orphan?.n)).toBe(0)
  }, 20_000)

  it('refuses the second claim at the constraint, and names a different one for a different mistake', async () => {
    const input = checkoutInput({ key: 'by-name', appointmentIds: await newPair() })
    const winner = await finaliseCheckout(sql, TILL, input)

    /**
     * Claims a key against a FRESH invoice and entry, inside a transaction that always rolls back.
     *
     * Fresh, so that exactly ONE constraint is in play: inserting the winner's own invoice id would
     * violate `checkout_finalisation_one_invoice` as well as the primary key, and which of two unique
     * indexes PostgreSQL reports is not a contract. The deliberate throw at the end is what keeps the
     * probe from leaving a document behind, and asserting on its message is what proves the claim
     * INSERT itself succeeded in the control case.
     */
    const claim = (key: string, override: { invoiceId?: string; entryId?: string } = {}) =>
      withUnitOfWork(sql, TILL, async (uow) => {
        const invoiceId =
          override.invoiceId ?? (await issueInvoice(uow, invoiceInput(`probe-${key}`))).id
        const entryId =
          override.entryId ?? (await postJournalEntry(uow, journalInput(`je-probe-${key}`))).entryId
        await uow.sql`
            insert into checkout_finalisation (
              idempotency_key, request_fingerprint, basket_id, invoice_id, journal_entry_id,
              trading_date, tender_total_fils
            ) values (
              ${key}, 'a different basket', 'basket-probe', ${invoiceId}, ${entryId},
              ${TRADING_DATE}::date, ${TENDERED}
            )
          `
        throw new Error('rollback the probe')
      })

    // 1. The claimed key, against a fresh invoice and entry. Only the primary key can refuse this.
    const duplicateKey = await refusalOf(claim(input.idempotencyKey))
    expect(duplicateKey.code).toBe('23505')
    expect(duplicateKey.constraint).toBe(CHECKOUT_CONSTRAINT.idempotencyKey)
    expect(isCheckoutAlreadyFinalised(duplicateKey.error)).toBe(true)

    // 2. A fresh key against the winner's INVOICE. A different mistake, a different constraint —
    //    which is what proves the first probe was about the key.
    const duplicateInvoice = await refusalOf(
      claim(`${input.idempotencyKey}-inv`, { invoiceId: winner.invoice.id }),
    )
    expect(duplicateInvoice.constraint).toBe(CHECKOUT_CONSTRAINT.oneInvoice)

    // 3. A fresh key against the winner's ENTRY.
    const duplicateEntry = await refusalOf(
      claim(`${input.idempotencyKey}-je`, { entryId: winner.journalEntry.entryId }),
    )
    expect(duplicateEntry.constraint).toBe(CHECKOUT_CONSTRAINT.oneEntry)

    // 4. The control for all three: an unclaimed key against a fresh invoice and entry reaches the
    //    deliberate throw, so the INSERT succeeded and the three refusals above are about their
    //    constraints rather than about anything else in the statement.
    const accepted = await refusalOf(claim(`${input.idempotencyKey}-unclaimed`))
    expect(accepted.message).toBe('rollback the probe')
    expect(accepted.constraint).toBeUndefined()
  }, 20_000)

  it('two concurrent finalisations of one checkout produce exactly one invoice', async () => {
    const input = checkoutInput({ key: 'concurrent', appointmentIds: await newPair() })
    const rival: FinaliseCheckoutInput = {
      ...input,
      journal: { ...input.journal, entryId: `${input.journal.entryId}-rival` },
    }

    // Both at once, on separate connections from the pool. One blocks on the document series' row
    // lock, then on the claim's index, and comes back with the winner's invoice.
    const [a, b] = await Promise.all([
      finaliseCheckout(sql, TILL, input),
      finaliseCheckout(sql, TILL, rival),
    ])

    expect(a.invoice.id).toBe(b.invoice.id)
    expect(a.journalEntry.entryId).toBe(b.journalEntry.entryId)
    // Exactly one did the work. `created` is the flag, and one true plus one false is the only legal
    // pair: two trues would be two sales and two falses would be none.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1)
    expect(await countsOf(input, [rival.journal.entryId])).toEqual(COMMITTED)

    // The loser consumed no statutory number: its allocation rolled back with it, so the range stays
    // gap-free. Asserted on the counter against the highest issued number, because the counter is
    // where a leaked number would show.
    const [series] = await sql<{ next_number: string }[]>`
        select next_number from document_series where code = 'TAX-INV'
      `
    const [issued] = await sql<{ highest: string }[]>`
        select coalesce(max(number), 0)::text as highest from invoice where series_code = 'TAX-INV'
      `
    expect(Number(series?.next_number)).toBe(Number(issued?.highest) + 1)
  }, 30_000)

  it('refuses a key replayed with a different basket rather than answering with the first invoice', async () => {
    const input = checkoutInput({
      key: 'fingerprint',
      appointmentIds: await newPair(),
      fingerprint: 'the basket that claimed the key',
    })
    await finaliseCheckout(sql, TILL, input)

    const refusal = await refusalOf(
      finaliseCheckout(sql, TILL, {
        ...input,
        requestFingerprint: 'a completely different basket',
        journal: { ...input.journal, entryId: `${input.journal.entryId}-other` },
      }),
    )
    expect(refusal.error).toBeInstanceOf(IdempotencyKeyReused)
    expect(refusal.message).toContain('a completely different basket')

    // The control: the SAME fingerprint is answered with the first invoice, so the refusal is about
    // the fingerprint and not about the replay.
    const replay = await finaliseCheckout(sql, TILL, {
      ...input,
      journal: { ...input.journal, entryId: `${input.journal.entryId}-same` },
    })
    expect(replay.created).toBe(false)
  }, 20_000)
})

describe('what the service refuses before it writes anything', () => {
  it('refuses a checkout whose appointments span two bookings', async () => {
    const input = checkoutInput({
      key: 'two-bookings',
      appointmentIds: [await newAppointment(bookingId), otherBookingAppointment],
    })
    const refusal = await refusalOf(finaliseCheckout(sql, TILL, input))
    expect(refusal.error).toBeInstanceOf(CheckoutAppointmentsNotOneBooking)
    expect(refusal.message).toContain('2 bookings')
    expect(await countsOf(input)).toEqual(ZERO)
  })

  it('refuses an appointment the diary does not have', async () => {
    const input = checkoutInput({
      key: 'ghost',
      appointmentIds: [await newAppointment(bookingId), '00000000-0000-4000-8000-000000000000'],
    })
    const refusal = await refusalOf(finaliseCheckout(sql, TILL, input))
    expect(refusal.error).toBeInstanceOf(CheckoutAppointmentsNotOneBooking)
    expect(refusal.message).toContain('2 appointment(s) were named and 1 exist')
    expect(await countsOf(input)).toEqual(ZERO)
  })

  it('refuses tenders that do not agree with the entry about where the money went', async () => {
    // The mis-mapping this cross-check exists for: the money is recorded against the CARD clearing
    // account while the entry debits CASH. Both sides balance, and the drawer does not.
    const input = checkoutInput({
      key: 'mismapped',
      appointmentIds: await newPair(),
      tenders: [{ tenderKind: 'cash', postingAccountCode: CARD_CLEARING, amountFils: TENDERED }],
    })
    const refusal = await refusalOf(finaliseCheckout(sql, TILL, input))
    expect(refusal.error).toBeInstanceOf(TenderPostingDisagrees)
    expect(refusal.message).toContain(CARD_CLEARING)
    expect(await countsOf(input)).toEqual(ZERO)
  })

  it('refuses a blank key, a non-ISO trading date, no tender and no appointment', async () => {
    const base = checkoutInput({ key: 'validation', appointmentIds: await newPair() })
    const first = base.appointments[0]?.appointmentId as string
    const cases: readonly (readonly [string, FinaliseCheckoutInput])[] = [
      ['idempotencyKey may not be blank', { ...base, idempotencyKey: '   ' }],
      ['requestFingerprint may not be blank', { ...base, requestFingerprint: '' }],
      ['tradingDate must be an ISO business day', { ...base, tradingDate: '19/11/2099' }],
      ['has no tender', { ...base, tenders: [] }],
      ['names no appointment', { ...base, appointments: [] }],
      [
        'carries 0 fils',
        {
          ...base,
          tenders: [{ tenderKind: 'cash', postingAccountCode: CASH_IN_DRAWER, amountFils: 0 }],
        },
      ],
      [
        'is named twice on one checkout',
        {
          ...base,
          appointments: [
            { appointmentId: first, lineNo: 1 },
            { appointmentId: first, lineNo: 2 },
          ],
        },
      ],
    ]
    for (const [expected, input] of cases) {
      const refusal = await refusalOf(finaliseCheckout(sql, TILL, input))
      expect(refusal.message).toContain(expected)
    }
    expect(await countsOf(base)).toEqual(ZERO)
    // The control: the unmodified input commits, so each refusal above is about the one field it
    // changed and not about the checkout being unfinalisable in the first place.
    expect((await finaliseCheckout(sql, TILL, base)).created).toBe(true)
    expect(await countsOf(base)).toEqual(COMMITTED)
  }, 20_000)
})

describe('the outbox: one invoice.issued and one payment.recorded, consumed once per handler', () => {
  it('writes both events in the same transaction, each carrying booking_id and customer_id', async () => {
    const input = checkoutInput({ key: 'events', appointmentIds: await newPair() })
    const finalised = await finaliseCheckout(sql, TILL, input)

    const rows = await sql<
      {
        id: string
        event_type: string
        payload: Record<string, unknown>
        idempotency_key: string
        published_at: Date | null
      }[]
    >`
        select id, event_type, payload, idempotency_key, published_at
          from outbox_event
         where aggregate_id = ${finalised.invoice.id}
           and event_type in ('invoice.issued', 'payment.recorded')
         order by event_type
      `
    // Exactly one of each, and no third. The keys are derived from the statutory identifier, which is
    // unique by constraint, so a retry of the same finalisation cannot enqueue a second one.
    expect(rows.map((row) => row.event_type)).toEqual(['invoice.issued', 'payment.recorded'])
    for (const row of rows) {
      // Both ids, on both events. `invoice.issued` reads them off the STORED document (0026, 0063),
      // so its payload cannot name a booking the document does not carry.
      expect(row.payload['bookingId']).toBe(bookingId)
      expect(row.payload['customerId']).toBe(customerId)
      // Written, not yet delivered: the transaction publishes and the worker drains.
      expect(row.published_at).toBeNull()
    }
    expect(rows[0]?.idempotency_key).toBe(`invoice.issued:${finalised.invoice.displayNumber}`)
    expect(rows[1]?.idempotency_key).toBe(`payment.recorded:${finalised.invoice.displayNumber}`)
    expect(rows[1]?.payload['tenderTotalFils']).toBe(TENDERED)
    expect(rows[1]?.payload['journalEntryId']).toBe(finalised.journalEntry.entryId)
  }, 20_000)

  it('delivers each event exactly once per handler, and skips a second delivery', async () => {
    const input = checkoutInput({ key: 'drain', appointmentIds: await newPair() })
    const finalised = await finaliseCheckout(sql, TILL, input)
    const events = await sql<{ id: string }[]>`
        select id from outbox_event
         where aggregate_id = ${finalised.invoice.id}
           and event_type in ('invoice.issued', 'payment.recorded')
         order by event_type
      `
    expect(events).toHaveLength(2)

    // Backdated before draining, and that is isolation rather than convenience. `drainOutbox` claims
    // `where published_at is null order by occurred_at limit batchSize`, and these two events are the
    // NEWEST in the queue — so a fixed batch would claim whatever every earlier suite left pending and
    // stop before reaching them (brief rule 12, in another form: a batch is a cap, not a filter). 1960
    // is earlier than the epoch the other backdating suite uses, so `batchSize: 2` claims exactly these
    // two and nothing else — narrowing what the code under test can SEE, rather than publishing
    // another suite's events as a side effect.
    await sql`
        update outbox_event set occurred_at = '1960-01-01T00:00:00Z'
         where id = ${events[0]?.id as string}
      `
    await sql`
        update outbox_event set occurred_at = '1960-01-01T00:00:01Z'
         where id = ${events[1]?.id as string}
      `

    const seen: Record<string, StoredEvent[]> = { ledger: [], notifier: [] }
    const handlers: readonly HandlerRegistration[] = [
      {
        name: `mtill06-ledger-${nonce}`,
        eventTypes: ['invoice.issued', 'payment.recorded'],
        handle: async (event) => {
          if (event.aggregateId === finalised.invoice.id) seen['ledger']?.push(event)
        },
      },
      {
        name: `mtill06-notifier-${nonce}`,
        eventTypes: ['payment.recorded'],
        handle: async (event) => {
          if (event.aggregateId === finalised.invoice.id) seen['notifier']?.push(event)
        },
      },
    ]

    const drain = await drainOutbox(sql, handlers, { batchSize: 2 })
    expect(drain.claimed).toBe(2)
    expect(drain.failed).toBe(0)
    // Two events to the ledger handler and one to the notifier: three deliveries, each claimed once.
    expect(drain.delivered).toBe(3)
    expect(seen['ledger']?.map((event) => event.eventType)).toEqual([
      'invoice.issued',
      'payment.recorded',
    ])
    expect(seen['notifier']?.map((event) => event.eventType)).toEqual(['payment.recorded'])

    // EXACTLY once per handler, and the mechanism is `outbox_delivery`'s primary key rather than the
    // published flag. Proving it needs the events claimed a second time, so `published_at` goes back
    // to null — which is not a contrived state: it is a worker that delivered and was killed before it
    // could mark them published, the at-least-once case 0007 exists for.
    await sql`
        update outbox_event set published_at = null
         where id = any(${events.map((event) => event.id)})
      `
    const second = await drainOutbox(sql, handlers, { batchSize: 2 })
    expect(second.claimed).toBe(2)
    expect(second.delivered).toBe(0)
    expect(second.skippedAlreadyDelivered).toBe(3)
    expect(seen['ledger']).toHaveLength(2)
    expect(seen['notifier']).toHaveLength(1)
  }, 30_000)
})

describe('the grants: a tender is not corrected in place', () => {
  it('holds INSERT and SELECT on the three tables and neither UPDATE nor DELETE nor TRUNCATE', async () => {
    const [privileges] = await sql<Record<string, boolean>[]>`
      select
        has_table_privilege('berelax_app', 'payment', 'INSERT')                as payment_insert,
        has_table_privilege('berelax_app', 'payment', 'SELECT')                as payment_select,
        has_table_privilege('berelax_app', 'payment', 'UPDATE')                as payment_update,
        has_table_privilege('berelax_app', 'payment', 'DELETE')                as payment_delete,
        has_table_privilege('berelax_app', 'payment', 'TRUNCATE')              as payment_truncate,
        has_table_privilege('berelax_app', 'checkout_finalisation', 'INSERT')   as claim_insert,
        has_table_privilege('berelax_app', 'checkout_finalisation', 'UPDATE')   as claim_update,
        has_table_privilege('berelax_app', 'checkout_finalisation', 'DELETE')   as claim_delete,
        has_table_privilege('berelax_app', 'checkout_finalisation', 'TRUNCATE') as claim_truncate,
        has_table_privilege('berelax_app', 'invoice_appointment', 'INSERT')     as link_insert,
        has_table_privilege('berelax_app', 'invoice_appointment', 'UPDATE')     as link_update,
        has_table_privilege('berelax_app', 'invoice_appointment', 'DELETE')     as link_delete
    `
    expect(privileges).toMatchObject({
      payment_insert: true,
      payment_select: true,
      payment_update: false,
      payment_delete: false,
      payment_truncate: false,
      claim_insert: true,
      claim_update: false,
      claim_delete: false,
      claim_truncate: false,
      link_insert: true,
      link_update: false,
      link_delete: false,
    })
  })

  it('refuses an UPDATE of a tender as the application role, and still lets it be read', async () => {
    const input = checkoutInput({ key: 'grants', appointmentIds: await newPair() })
    const finalised = await finaliseCheckout(sql, TILL, input)
    const tenderId = finalised.tenders[0]?.id as string

    const refusal = await refusalOf(
      sql.begin(async (tx) => {
        await tx`set local role berelax_app`
        await tx`update payment set amount_fils = 1 where id = ${tenderId}`
      }),
    )
    // 42501 is the grant layer refusing, which is the layer a request can actually reach.
    expect(refusal.code).toBe('42501')

    // The control: the same role CAN read the row, so the refusal is about UPDATE and not about the
    // role being unable to see it at all.
    const readable = (await sql.begin(async (tx) => {
      await tx`set local role berelax_app`
      return tx<{ n: string }[]>`
          select count(*)::text as n from payment where id = ${tenderId}
        `
    })) as unknown as { n: string }[]
    expect(Number(readable[0]?.n)).toBe(1)

    // And the amount is unchanged, which is the fact the grant exists to keep true: a tender
    // reconciled against a counted drawer cannot move afterwards.
    const [unchanged] = await sql<{ amount_fils: string }[]>`
        select amount_fils from payment where id = ${tenderId}
      `
    expect(Number(unchanged?.amount_fils)).toBe(TENDERED)
  }, 20_000)
})
