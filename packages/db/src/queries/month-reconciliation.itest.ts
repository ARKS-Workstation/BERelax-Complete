import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { manualPaymentAdapter } from '../adapters/manual-payment.ts'
import type { Actor } from '../audit.ts'
import { createConnection, type Sql } from '../connection.ts'
import type { IssueInvoiceInput } from '../repositories/invoice.ts'
import type { JournalEntryInput } from '../repositories/journal.ts'
import { finaliseCheckout } from '../services/checkout-finalise.ts'
import { issueCreditNote } from '../services/issue-credit-note.ts'
import { closeAccountingPeriod } from '../services/period-close.ts'
import { redeemPackage } from '../services/redeem-package.ts'
import { savePackageTemplateVersion, sellPackage } from '../services/sell-package.ts'
import { withUnitOfWork } from '../tx.ts'
import * as reconciliationModule from './month-reconciliation.ts'
import {
  classifyJournalSources,
  exportMonthReconciliation,
  MONTH_RECONCILIATION_CONSUMERS,
  MONTH_RECONCILIATION_CONSUMERS_REQUIRING_SOUNDNESS,
  MONTH_RECONCILIATION_LINE_IDS,
  type MonthReconciliation,
  type MonthReconciliationPeriod,
  monthReconciliation,
  monthReconciliationBytes,
} from './month-reconciliation.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * M-VAT-12 — the closed-month reconciliation, against real PostgreSQL.
 *
 * # Why this file builds its own closed month
 *
 * The acceptance line says "the seeded closed month", and there is not one. Measured on a database
 * created, migrated and seeded from clean in this worktree: `pnpm seed` writes **zero `appointment` rows,
 * zero `invoice` rows and no `period_lock` at all** — `packages/fixtures/src/salon.ts` records the same
 * finding in its own header, and the seeder prints "250 appointments, 188 invoices" from the GENERATOR's
 * counts rather than from what the loaders wrote. A report run over August 2026 would therefore reconcile
 * seven empty figures against seven empty figures and report zero variance, which is the exact failure
 * ADR 0002 is about: a check that passes over nothing is worse than one that fails.
 *
 * So the month this report is asserted against is built here, from a recipe stated once, and
 * `examinedRows` is asserted at a hand-counted figure so an empty month cannot pass as a clean one.
 *
 * # Three months, and what only each one can show
 *
 *   * **the sound month** — the recipe, closed. Every identity holds, the report exports, and the bytes
 *     are stable across two generations and across two different `nowIso` arguments.
 *   * **the defective month** — the same recipe, closed, and then ONE `payment` row removed. This is the
 *     acceptance line's injected defect, and it is what proves the report examines something: the tender
 *     identity goes out by exactly the missing tender, the line is named, and the export refuses.
 *   * **the repeat month** — the same recipe again, read OPEN first and then closed. Open is the only way
 *     to exercise the `sourceAsOf` census, because a re-closed period's `locked_at` is later than
 *     everything in it. Closed, its bytes must equal the sound month's once the period is normalised out,
 *     which is the acceptance line "two seeds produce identical output" done as a claim about the RECIPE
 *     rather than about one month read twice.
 *
 * # Why the window is derived and the figures are absolute
 *
 * `journal_entry` refuses DELETE for every role including the owner (ZL001), so nothing can remove the
 * entries this suite posts and a FIXED month would double every figure on a second run against the same
 * database — M-TILL-10's recorded defect (7), where a delta-free assertion read 430,003 where 33,334 was
 * expected, from its own first run. The window is therefore searched for out of a reserved span and the
 * figures below are absolute for whichever window it got.
 */

/**
 * The span this suite may post into, and why it is above every other one.
 *
 * Measured rather than assumed: the years appearing in any date literal under `packages`, `apps` or
 * `scripts` are 2000-2036, 2080-2100, 2120-2139 and 2150-2199. `vat-return-signoff.itest.ts` holds
 * 2120-2139 and `packages/fixtures/src/vat201.ts` holds 2150-2199, so 2200 onwards is claimed by nothing.
 *
 * Six hundred months is two hundred runs of THIS SUITE at three months each — and about eighteen runs of
 * gate block 131, which is the figure that matters and the one worth measuring rather than reasoning about.
 * Measured: three `pnpm gates:only --only '// 131a'` runs plus a handful of bare suite runs consumed 99
 * months of it (to 2208-03), because eleven of that block's cases invoke this suite once each.
 *
 * So the width is not tidiness. A span of a few years would be exhausted inside a single gate run and the
 * failure would arrive as "the fixture threw" in a case about something else.
 */
export const MONTH_RECONCILIATION_RESERVED_SPAN = { from: '2200-01-01', to: '2249-12-31' } as const

const RUN = Date.now().toString(36)
const PREFIX = 'MVAT12'
const MARKER = 'mvat12 month reconciliation itest'
const PROBE = `mvat12_recon_probe_${RUN}`
const PROBE_PHONE = '+971590001212'

/** Fifteen digits. A test value: the real TRN is unknown (Y1-trn) and the placeholder is refused. */
const TEST_TRN = '100123456700003'

const ACTOR: Actor = { kind: 'system', label: 'm-vat-12 reconciliation itest' }

const ISSUER = {
  legalName: 'BE RELAX SPA - L.L.C - O.P.C',
  tradingName: 'BE RELAX - Massage Center and Spa',
  trn: TEST_TRN,
  addressSnapshot: '250 Al Meena Street\nTower Block A/B, M-Floor\nAl Zahiyah, Abu Dhabi',
  emirate: 'Abu Dhabi',
} as const

// --- the figures, computed by hand --------------------------------------------------------------
//
// One treatment price, chosen so every 5% split is EXACT and any change to the rounding convention shows
// up as a whole fil rather than hiding inside a remainder — M-VAT-03's reason for 100,000 and M-VAT-07's
// for 105,000:
//
//   TREATMENT_GROSS 21_000   net = round(21_000 x 10_000 / 10_500) = 20_000
//                            vat = 21_000 - 20_000                =  1_000
//
// The month, in documents:
//
//   invoice 1   two treatments, cash          gross 42_000   net 40_000   vat 2_000
//   invoice 2   one treatment, card           gross 21_000   net 20_000   vat 1_000
//   credit note against invoice 2, in full    gross 21_000   net 20_000   vat 1_000
//   refund against invoice 2, cash                  21_000
//   package sale, three sessions, cash              63_000   (3 x 21_000, so a session splits exactly)
//   redemption of one session          released      21_000   net 20_000   vat 1_000
//
// and the four identities the acceptance line names, to the fil:
//
//   1. invoice gross - credit-note gross = 42_000 + 21_000 - 21_000            = 42_000
//      revenue and output VAT credited   = 42_000 + 21_000 - 21_000            = 42_000
//   2. tendered - refunded               = 42_000 + 21_000 + 63_000 - 21_000   = 105_000
//      cash and bank debited             = 42_000 + 21_000 - 21_000 + 63_000   = 105_000
//   3. package sold - redeemed           = 63_000 - 21_000                     = 42_000
//      deferred revenue (2050) credited  = 63_000 - 21_000                     = 42_000
//   4. completed appointments 4, of them billed or redeemed 4                  -> 0
//
// plus the last step of the chain, journal to VAT box:
//
//      invoice VAT - credit-note VAT + redemption VAT = 2_000 + 1_000 - 1_000 + 1_000 = 3_000
//      the tax in the box the standard-rated grouping maps to                         = 3_000
const TREATMENT_GROSS = 21_000
const TREATMENT_NET = 20_000
const TREATMENT_VAT = 1_000
const INVOICE_1_GROSS = 42_000
const INVOICE_1_NET = 40_000
const INVOICE_1_VAT = 2_000
const PACKAGE_SESSIONS = 3
const PACKAGE_PRICE = 63_000
const REVENUE_IDENTITY = 42_000
const TENDER_IDENTITY = 105_000
const LIABILITY_IDENTITY = 42_000
const REDEMPTION_IDENTITY = 21_000
const OUTPUT_TAX_IDENTITY = 3_000

/**
 * Every row the report examines, counted by hand.
 *
 * 16 journal lines (3 + 3 + 3 + 2 + 2 + 3), 8 documents (2 invoices, 1 credit note, 3 payments, 1 refund,
 * 1 redemption) and 7 appointments (4 completed, 1 no-show, 2 cancellations). Asserted EXACTLY and not as
 * a floor, because the window is virgin: an assertion of "at least one" would be satisfied by a month
 * holding one row, and an empty month reporting zero variance is what this figure exists to refuse.
 */
const EXAMINED_ROWS = 31

/** The chart codes, written out: `packages/db` may never import `packages/core`. */
const CASH_IN_DRAWER = '1010'
const CARD_CLEARING = '1040'
const TRADE_RECEIVABLES = '1050'
const OUTPUT_VAT = '2030'
const DEFERRED_REVENUE = '2050'
const TREATMENT_REVENUE = '4010'
const PACKAGE_REVENUE = '4020'

/** Four rooms of one client each, and the trading window, so no two appointments contend. */
const ROOM_COUNT = 4
const FIRST_HOUR = 11
const LAST_HOUR = 23

interface Month {
  readonly periodId: string
  readonly startsOn: string
  readonly endsOn: string
  /** The one trading day inside the month that every row in it is dated on. */
  readonly on: string
}

interface BuiltMonth {
  readonly month: Month
  readonly invoiceOneId: string
  readonly invoiceTwoId: string
  readonly cashPaymentId: string
  readonly creditNoteId: string
  readonly packageSaleId: string
}

let sql: Sql
let customerId: string
let variantId: string
let roomIds: string[] = []
let templateVersionId: string
let templatePriceFils = 0
/** How many appointments this run has created on each trading date. Decides the room and the hour. */
const allottedOn = new Map<string, number>()

let soundMonth: BuiltMonth
let defectiveMonth: BuiltMonth

let soundReport: MonthReconciliation
let soundReportAgain: MonthReconciliation
let soundReportOtherNow: MonthReconciliation
let defectiveReport: MonthReconciliation
let repeatReportWhileOpen: MonthReconciliation
let repeatReportStaleAsOf: MonthReconciliation
let repeatReportClosed: MonthReconciliation
let soundLockedAt: string

const NOW_ISO = '2249-12-31T06:00:00.000Z'
/** An instant BEFORE anything this suite writes, so the as-of census has something to find. */
const STALE_NOW_ISO = '2000-01-01T00:00:00.000Z'

const monthAt = (year: number, month: number): Month => {
  const mm = String(month).padStart(2, '0')
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    periodId: `${PREFIX}-${year}-${mm}`,
    startsOn: `${year}-${mm}-01`,
    endsOn: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
    on: `${year}-${mm}-20`,
  }
}

const nextMonthAfter = (isoDate: string) => {
  const year = Number(isoDate.slice(0, 4))
  const month = Number(isoDate.slice(5, 7))
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
}

/**
 * Three consecutive months in the reserved span that no journal entry has ever been dated in.
 *
 * Derived from `max(entry_date)` rather than from the clock, so the choice is a function of the database
 * and two suites in one run cannot pick the same window. It throws rather than wrapping when the span runs
 * out, and the message says what to do: a silent wrap would land on a month that already holds a previous
 * run's entries and every committed figure above would read double.
 */
async function virginWindow(): Promise<readonly [Month, Month, Month]> {
  const [row] = await sql<{ used: string | null }[]>`
    select max(entry_date)::text as used
      from journal_entry
     where entry_date between ${MONTH_RECONCILIATION_RESERVED_SPAN.from}::date
                          and ${MONTH_RECONCILIATION_RESERVED_SPAN.to}::date
  `
  const used = row?.used ?? null
  const first =
    used === null
      ? {
          year: Number(MONTH_RECONCILIATION_RESERVED_SPAN.from.slice(0, 4)),
          month: Number(MONTH_RECONCILIATION_RESERVED_SPAN.from.slice(5, 7)),
        }
      : nextMonthAfter(used)
  const months = [0, 1, 2].map((offset) => {
    const zeroBased = first.month - 1 + offset
    return monthAt(first.year + Math.floor(zeroBased / 12), (zeroBased % 12) + 1)
  })
  const last = months[2] as Month
  if (last.endsOn > MONTH_RECONCILIATION_RESERVED_SPAN.to) {
    throw new Error(
      'The month-reconciliation fixture needs three consecutive months with no journal entry in them, ' +
        `and the reserved span ${MONTH_RECONCILIATION_RESERVED_SPAN.from}..` +
        `${MONTH_RECONCILIATION_RESERVED_SPAN.to} is used up to ${used}. The journal is append-only and ` +
        'refuses the owner, so the entries cannot be removed: run this suite against a fresh database, ' +
        'or widen MONTH_RECONCILIATION_RESERVED_SPAN into a year no other suite posts into. Wrapping ' +
        'round would land on a month that already holds a previous run and every figure would read double.',
    )
  }
  return [months[0] as Month, months[1] as Month, months[2] as Month]
}

const tradingDay = (day: string) => sql`
  insert into business_day (trading_date, opens_at, closes_at, source)
  values (
    ${day}::date,
    (${day}::date + time '11:00') at time zone 'Asia/Dubai',
    (${day}::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
    'weekly'
  )
  on conflict (trading_date) do nothing
`

/**
 * One appointment in the named state, at the treatment price.
 *
 * Each one gets its own therapist id and its own (room, hour) slot: `appointment_therapist_no_overlap` is
 * an exclusion constraint on (therapist, period), the capacity trigger counts client places per room, and
 * `completed` still HOLDS its room and therapist (0024) — a finished treatment occupied them, and a second
 * booking over the same past period is a double booking that happened rather than a free slot.
 */
async function newAppointment(booking: string, day: string, status: string): Promise<string> {
  const index = allottedOn.get(day) ?? 0
  allottedOn.set(day, index + 1)
  const room = roomIds[index % ROOM_COUNT] as string
  const hour = FIRST_HOUR + Math.floor(index / ROOM_COUNT)
  if (hour > LAST_HOUR) {
    // Louder than an over-capacity refusal from a trigger three frames away, and it names the fix.
    throw new Error(`the itest ran out of (room, hour) slots on ${day} after ${index} appointments`)
  }
  const start = `${day} ${String(hour).padStart(2, '0')}:00:00+04`
  const end = `${day} ${String(hour).padStart(2, '0')}:59:00+04`
  const therapistId = `33333333-4444-4555-8666-${String(index).padStart(12, '0')}`
  const [appointment] = await sql<{ id: string }[]>`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes,
       therapist_buffer_minutes)
    values (${booking}, ${day}::date, ${variantId}, 'solo'::service_shape, ${therapistId},
            ${room}, ${`[${start},${end})`}::tstzrange,
            ${sql.unsafe(`'${status}'::appointment_status`)}, ${TREATMENT_GROSS}, ${TREATMENT_NET},
            ${TREATMENT_VAT}, 500, 20, 10)
    returning id
  `
  return appointment?.id as string
}

const invoiceLine = (description: string): IssueInvoiceInput['lines'][number] => ({
  descriptionEn: description,
  quantity: 1,
  unitGrossFils: TREATMENT_GROSS,
  vatRateBp: 500,
  netFils: TREATMENT_NET,
  vatFils: TREATMENT_VAT,
})

/**
 * The recipe, applied to one month.
 *
 * Stated once and called three times, which is what makes "two seeds produce identical output" a claim
 * about the recipe rather than about one month read twice. Every document goes through the real service —
 * `finaliseCheckout`, `issueCreditNote`, `manualPaymentAdapter.refund`, `sellPackage`, `redeemPackage` —
 * because a fixture that inserted rows by hand would reconcile against a ledger it had also written by
 * hand, and the two would agree about a posting rule neither had exercised.
 *
 * `finaliseCheckout` and not `issueInvoice` for the two invoices, and that is load-bearing rather than
 * stylistic: `period_close_blocker()` refuses to close a period containing an invoice with no
 * `checkout_finalisation` row (0073), so a month built with bare `issueInvoice` calls could not be closed
 * at all and this whole suite would be about open periods.
 */
async function buildMonth(month: Month): Promise<BuiltMonth> {
  await tradingDay(month.on)
  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}, 'front_desk', ${MARKER})
    returning id
  `
  const bookingId = booking?.id as string

  const appointmentOne = await newAppointment(bookingId, month.on, 'completed')
  const appointmentTwo = await newAppointment(bookingId, month.on, 'completed')
  const appointmentThree = await newAppointment(bookingId, month.on, 'completed')
  const appointmentFour = await newAppointment(bookingId, month.on, 'completed')
  await newAppointment(bookingId, month.on, 'no_show')
  await newAppointment(bookingId, month.on, 'cancelled_by_customer')
  await newAppointment(bookingId, month.on, 'cancelled_by_salon')

  const key = (what: string) => `mvat12-${RUN}-${month.periodId}-${what}`
  const entry = (what: string): string => `je-${key(what)}`

  // --- invoice 1: two treatments, cash --------------------------------------------------------
  const invoiceOne = await finaliseCheckout(sql, ACTOR, {
    idempotencyKey: key('inv1'),
    basketId: `basket-${key('inv1')}`,
    requestFingerprint: `fp-${key('inv1')}`,
    tradingDate: month.on,
    customerId,
    invoice: {
      documentKind: 'tax_invoice',
      seriesCode: 'TAX-INV',
      issuer: ISSUER,
      customer: { customerId, nameSnapshot: 'Customer 0042' },
      issueDate: month.on,
      issueTradingDate: month.on,
      taxPointDate: month.on,
      lines: [
        invoiceLine('Normal Massage (Asian), 60 min'),
        invoiceLine('Normal Massage (Asian), 60 min'),
      ],
      netTotalFils: INVOICE_1_NET,
      vatTotalFils: INVOICE_1_VAT,
      grossTotalFils: INVOICE_1_GROSS,
      notes: key('inv1'),
    },
    journal: {
      entryId: entry('inv1'),
      entryDate: month.on,
      narrative: 'Checkout, two treatments, cash',
      source: 'sale',
      lines: [
        { accountCode: CASH_IN_DRAWER, debitFils: INVOICE_1_GROSS, creditFils: 0 },
        { accountCode: OUTPUT_VAT, debitFils: 0, creditFils: INVOICE_1_VAT },
        { accountCode: TREATMENT_REVENUE, debitFils: 0, creditFils: INVOICE_1_NET },
      ],
    },
    tenders: [
      { tenderKind: 'cash', postingAccountCode: CASH_IN_DRAWER, amountFils: INVOICE_1_GROSS },
    ],
    appointments: [
      { appointmentId: appointmentOne, lineNo: 1 },
      { appointmentId: appointmentTwo, lineNo: 2 },
    ],
  })

  // --- invoice 2: one treatment, card ---------------------------------------------------------
  const invoiceTwo = await finaliseCheckout(sql, ACTOR, {
    idempotencyKey: key('inv2'),
    basketId: `basket-${key('inv2')}`,
    requestFingerprint: `fp-${key('inv2')}`,
    tradingDate: month.on,
    customerId,
    invoice: {
      documentKind: 'tax_invoice',
      seriesCode: 'TAX-INV',
      issuer: ISSUER,
      customer: { customerId, nameSnapshot: 'Customer 0042' },
      issueDate: month.on,
      issueTradingDate: month.on,
      taxPointDate: month.on,
      lines: [invoiceLine('Normal Massage (Asian), 60 min')],
      netTotalFils: TREATMENT_NET,
      vatTotalFils: TREATMENT_VAT,
      grossTotalFils: TREATMENT_GROSS,
      notes: key('inv2'),
    },
    journal: {
      entryId: entry('inv2'),
      entryDate: month.on,
      narrative: 'Checkout, one treatment, card',
      source: 'sale',
      lines: [
        { accountCode: CARD_CLEARING, debitFils: TREATMENT_GROSS, creditFils: 0 },
        { accountCode: OUTPUT_VAT, debitFils: 0, creditFils: TREATMENT_VAT },
        { accountCode: TREATMENT_REVENUE, debitFils: 0, creditFils: TREATMENT_NET },
      ],
    },
    tenders: [
      {
        tenderKind: 'card_in_salon',
        postingAccountCode: CARD_CLEARING,
        amountFils: TREATMENT_GROSS,
        reference: `APPROVAL-${RUN}`,
      },
    ],
    appointments: [{ appointmentId: appointmentThree, lineNo: 1 }],
  })

  // --- the credit note against invoice 2, in full, and the refund it authorises ---------------
  const note = await withUnitOfWork(sql, ACTOR, (uow) =>
    issueCreditNote(uow, {
      invoiceId: invoiceTwo.invoice.id,
      seriesCode: 'CR-NOTE',
      issuer: ISSUER,
      customer: { customerId, nameSnapshot: 'Customer 0042' },
      issueDate: month.on,
      issueTradingDate: month.on,
      taxPointDate: month.on,
      reason: 'The treatment was not delivered to the standard promised; credited in full.',
      lines: [
        {
          invoiceLineNo: 1,
          descriptionEn: 'Normal Massage (Asian), 60 min',
          quantity: 1,
          unitGrossFils: TREATMENT_GROSS,
          vatRateBp: 500,
          netFils: TREATMENT_NET,
          vatFils: TREATMENT_VAT,
        },
      ],
      netTotalFils: TREATMENT_NET,
      vatTotalFils: TREATMENT_VAT,
      grossTotalFils: TREATMENT_GROSS,
      reversal: {
        entryId: entry('cn'),
        entryDate: month.on,
        narrative: 'Credit note reversal, one treatment',
        // `reversal` and not `refund`: `issue-credit-note.ts` refuses any other source outright, and the
        // report's JOURNAL_SOURCE_CLASSES reads this class for the revenue identity for that reason.
        source: 'reversal',
        // The finalised checkout's own entry. `issueCreditNote` refuses a reversal that names another
        // document's entry, because such a note corrects that document instead of this one.
        reverses: entry('inv2'),
        lines: [
          { accountCode: TREATMENT_REVENUE, debitFils: TREATMENT_NET, creditFils: 0 },
          { accountCode: OUTPUT_VAT, debitFils: TREATMENT_VAT, creditFils: 0 },
          { accountCode: TRADE_RECEIVABLES, debitFils: 0, creditFils: TREATMENT_GROSS },
        ],
      } satisfies JournalEntryInput,
      notes: key('cn'),
    }),
  )

  await withUnitOfWork(sql, ACTOR, (uow) =>
    manualPaymentAdapter().refund(uow, {
      invoiceId: invoiceTwo.invoice.id,
      creditNoteId: note.id,
      tradingDate: month.on,
      entryId: entry('refund'),
      tenderKind: 'cash',
      postingAccountCode: CASH_IN_DRAWER,
      amountFils: TREATMENT_GROSS,
    }),
  )

  // --- the package sale and one redemption ----------------------------------------------------
  const sale = await withUnitOfWork(sql, ACTOR, (uow) =>
    sellPackage(uow, {
      customerId,
      templateVersionId,
      tradingDate: month.on,
      priceFils: templatePriceFils,
      sessionCount: PACKAGE_SESSIONS,
      validityMonths: 12,
      transferable: false,
      unredeemedBalancePolicy: 'retained',
      journal: {
        entryId: entry('pkg'),
        entryDate: month.on,
        narrative: 'Package sale, three sessions, cash',
        source: 'package_sale',
        lines: [
          { accountCode: CASH_IN_DRAWER, debitFils: templatePriceFils, creditFils: 0 },
          { accountCode: DEFERRED_REVENUE, debitFils: 0, creditFils: templatePriceFils },
        ],
      },
      balances: [
        {
          lineNo: 1,
          serviceVariantId: variantId,
          sessionsTotal: PACKAGE_SESSIONS,
          valueFils: templatePriceFils,
        },
      ],
      tenders: [
        { tenderKind: 'cash', postingAccountCode: CASH_IN_DRAWER, amountFils: templatePriceFils },
      ],
    }),
  )

  await withUnitOfWork(sql, ACTOR, (uow) =>
    redeemPackage(uow, {
      packageBalanceId: sale.balanceIds[0] as string,
      appointmentId: appointmentFour,
      units: 1,
      tradingDate: month.on,
      releasedFils: TREATMENT_GROSS,
      vatFils: TREATMENT_VAT,
      vatRateBp: 500,
      journal: {
        entryId: entry('redeem'),
        entryDate: month.on,
        narrative: 'Package redemption, one session',
        source: 'package_redemption',
        lines: [
          { accountCode: DEFERRED_REVENUE, debitFils: TREATMENT_GROSS, creditFils: 0 },
          { accountCode: PACKAGE_REVENUE, debitFils: 0, creditFils: TREATMENT_NET },
          { accountCode: OUTPUT_VAT, debitFils: 0, creditFils: TREATMENT_VAT },
        ],
      },
    }),
  )

  const [cashPayment] = await sql<{ id: string }[]>`
    select id from payment
     where invoice_id = ${invoiceOne.invoice.id}::uuid and tender_kind = 'cash'
  `

  return {
    month,
    invoiceOneId: invoiceOne.invoice.id,
    invoiceTwoId: invoiceTwo.invoice.id,
    cashPaymentId: cashPayment?.id as string,
    creditNoteId: note.id,
    packageSaleId: sale.saleId,
  }
}

const close = (month: Month) =>
  withUnitOfWork(sql, ACTOR, (uow) =>
    closeAccountingPeriod(uow, {
      periodId: month.periodId,
      startsOn: month.startsOn,
      endsOn: month.endsOn,
      reason: MARKER,
      closedByActorKind: 'system',
    }),
  )

const periodOf = (month: Month): MonthReconciliationPeriod => ({
  periodId: month.periodId,
  startsOn: month.startsOn,
  endsOn: month.endsOn,
})

const lineOf = (report: MonthReconciliation, id: string) => {
  const found = report.lines.find((row) => row.id === id)
  if (found === undefined) throw new Error(`the report carries no line called ${id}`)
  return found
}

/** The bytes with the period replaced by a fixed token, so two months of one recipe are comparable. */
const recipeBytes = (report: MonthReconciliation): string =>
  monthReconciliationBytes(report)
    .replaceAll(report.period.periodId, '<periodId>')
    .replaceAll(report.period.startsOn, '<startsOn>')
    .replaceAll(report.period.endsOn, '<endsOn>')
    .replaceAll(report.sourceAsOf, '<sourceAsOf>')
    .replaceAll(report.lockedPeriodId ?? '\u0000never', '<lockedPeriodId>')

beforeAll(async () => {
  sql = createConnection({ url, max: 8 })
  const [first, second, third] = await virginWindow()

  // A lock over the window left behind by an interrupted earlier run would refuse every entry here by
  // ZL002 and every case would report that instead — gate 103's, gate 105's and vat201.itest.ts's reason.
  await sql`delete from period_lock where period_id like ${`${PREFIX}-%`}`

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = customer?.id as string

  roomIds = []
  for (let index = 1; index <= ROOM_COUNT; index += 1) {
    const [room] = await sql<{ id: string }[]>`
      insert into rooms (code, name, room_type, capacity, display_order, notes)
      values (${`mvat12-r${index}`}, ${`Reconciliation probe room ${index}`}, 'standard'::room_type, 1,
              ${190 + index}, ${MARKER})
      on conflict (code) do update set capacity = excluded.capacity
      returning id
    `
    roomIds.push(room?.id as string)
  }

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, ${`mvat12-recon-probe-${RUN}`}, 'Reconciliation probe massage',
            'Normal Massage (Asian)', 20, 196)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  /*
    The compatibility row, and it is not decoration.

    This service is PERMANENT residue — the teardown below says why it cannot go — and a service with no
    `service_room_type_compat` row is one `seedCatalogue`'s publication lint refuses outright
    (`service_publish_without_compat_row`, 0029). So the row left behind poisoned every later suite that
    re-seeds the catalogue: six files failed with a sentence naming a treatment key they had never heard of,
    and `catalogue.itest.ts`'s whole-table orphan check named it as a finding, correctly.

    Keyed on `(service_style, service_treatment_key, room_type)` and NOT on `rooms`, so the probe room this
    file deletes in its teardown takes nothing with it.
  */
  await sql`
    insert into service_room_type_compat (service_style, service_treatment_key, room_type)
    values ('asian', ${PROBE}, 'standard')
    on conflict do nothing
  `
  /*
    And the resource shape, which is the SECOND thing publication requires: `service_publish_without_
    resource_shape` refuses a service that does not state how many therapists or rooms one delivery needs.
    Both lints exist for the same reason — availability over a service with neither would be empty on every
    date rather than refused at publication — and a fixture that satisfied one and not the other moved the
    failure from one sentence to the next.

    `is_provisional` is FALSE, unlike the seeded rows, and deliberately: these figures are this fixture's own
    and nobody is waiting on them, while `unconfirmedAssumptionRows()` reads this table for the operator's
    Unconfirmed Assumptions panel. A flagged fixture row would put "a reconciliation probe needs 1 therapist"
    in front of the owner as a question to answer.
  */
  await sql`
    insert into service_resource_shape
      (service_style, service_treatment_key, shape, therapists_required, rooms_required,
       min_room_capacity, therapist_buffer_minutes, is_provisional)
    values ('asian', ${PROBE}, 'solo', 1, 1, 1, 10, false)
    on conflict do nothing
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${service?.id as string}, 60, ${TREATMENT_GROSS}, ${MARKER})
    on conflict (service_id, duration_minutes)
      do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = variant?.id as string

  // The name carries `[confirm]`, one of the markers `is_placeholder_text()` matches (0026), plus the
  // sentence that it is not a package this business sells: M-TILL-13's arrangement, so a fixture package
  // name can never be printed on a document as though it were a product. The terms are SUPPLIED, which is
  // a deliberate override rather than a defaulted guess — the somebody who typed the numbers in is this
  // fixture, and a defaulted version would be flagged provisional against Y9-package-policy.
  const template = await withUnitOfWork(sql, ACTOR, (uow) =>
    savePackageTemplateVersion(uow, {
      templateKey: `mvat12_recon_${RUN}`,
      internalName: `[confirm] M-VAT-12 reconciliation fixture package (${RUN})`,
      publicDisplayName: '[confirm] Not a package this business sells — reconciliation fixture',
      priceFils: PACKAGE_PRICE,
      lines: [{ serviceVariantId: variantId, sessionCount: PACKAGE_SESSIONS }],
      terms: { validityMonths: 12, transferable: false, unredeemedBalancePolicy: 'retained' },
    }),
  )
  templateVersionId = template.versionId
  templatePriceFils = template.priceFils

  // --- the sound month ------------------------------------------------------------------------
  soundMonth = await buildMonth(first)
  await close(first)
  const [lock] = await sql<{ lockedAt: string }[]>`
    select locked_at::text as "lockedAt" from period_lock where period_id = ${first.periodId}
  `
  soundLockedAt = lock?.lockedAt as string
  soundReport = await monthReconciliation(sql, periodOf(first), NOW_ISO)
  soundReportAgain = await monthReconciliation(sql, periodOf(first), NOW_ISO)
  // A DIFFERENT `nowIso`, which a closed period must ignore in favour of the lock's own instant.
  soundReportOtherNow = await monthReconciliation(sql, periodOf(first), STALE_NOW_ISO)

  // --- the defective month: the same recipe, then ONE payment row removed ---------------------
  defectiveMonth = await buildMonth(second)
  await close(second)
  // The injected defect, and it is injected as the OWNER on purpose. `berelax_app` holds INSERT and
  // SELECT on `payment` and no DELETE, so the application cannot reach this state — which is exactly why
  // the report has to: a row lost to a restore, an import or a `psql` session is the case a reconciliation
  // exists for, and one the application's own guards can say nothing about.
  await sql`delete from payment where id = ${defectiveMonth.cashPaymentId}::uuid`
  defectiveReport = await monthReconciliation(sql, periodOf(second), NOW_ISO)

  // --- the repeat month: read OPEN, then closed ------------------------------------------------
  await buildMonth(third)
  repeatReportWhileOpen = await monthReconciliation(sql, periodOf(third), NOW_ISO)
  repeatReportStaleAsOf = await monthReconciliation(sql, periodOf(third), STALE_NOW_ISO)
  await close(third)
  repeatReportClosed = await monthReconciliation(sql, periodOf(third), NOW_ISO)
}, 180_000)

afterAll(async () => {
  if (!sql) return
  // The locks go, so a later run of this file is not refused its own dates by ZL002.
  await sql`delete from period_lock where period_id like ${`${PREFIX}-%`}`

  /*
    And then as much of this file's footprint as the foreign keys allow, because the integration suite runs
    sequentially against ONE database and earlier files leave rows behind (brief rule 12). Left alone, each
    run of this file would add 21 appointments and 4 rooms to a database other suites read.

    The BOOKINGS are the lever: `appointment.booking_id` is `on delete cascade` (0024), and
    `invoice_appointment.appointment_id` and `package_redemption.appointment_id` deliberately carry no
    foreign key, so removing three bookings removes the 21 appointments without a RESTRICT anywhere. The
    rooms are then unreferenced and go too. `checkout-finalise.itest.ts` uses the same lever.

    What CANNOT go, and is therefore this file's permanent residue — stated rather than left to be
    discovered:

      * the journal entries and lines. ZL001 refuses DELETE for every role including the owner, which is
        why the window is SEARCHED FOR rather than fixed;
      * the invoices, credit notes, payments, refunds, package sales and redemptions. `invoice` refuses
        DELETE (ZI003) and `truncate` is the only legal removal — which this file deliberately does NOT do,
        because a truncate here would take every other suite's documents with it;
      * the customer, pinned by `invoice.customer_id` being ON DELETE RESTRICT against a row nothing can
        delete. One per run, upserted on a phone number no other suite uses;
      * the service, its variant, its compatibility and resource-shape rows and the package template
        version, pinned by
        `package_template_line` and `package_balance` against package rows that are equally undeletable.
        The compatibility row is what makes that residue harmless rather than poisonous: without it the
        service cannot be published, and `seedCatalogue` refuses the whole catalogue rather than this row.

    All of it is dated in 2200 or keyed to this file's own marker, so no suite reading "recent" or "today"
    can see any of it.
  */
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql.end({ timeout: 5 })
})

describe('the sound closed month reconciles with zero variance', () => {
  it('reports no unexplained variance line at all, over a month it demonstrably examined', () => {
    expect(soundReport.unexplainedVarianceLines).toEqual([])
    // The control for every assertion in this file. A report over an empty month would satisfy the line
    // above perfectly, which is ADR 0002's whole subject.
    expect(soundReport.examinedRows).toBe(EXAMINED_ROWS)
    expect(soundReport.closed).toBe(true)
    expect(soundReport.lockedPeriodId).toBe(soundMonth.month.periodId)
    // The lines and their ORDER, against the declared list. The order is part of the contract because the
    // bytes have to be identical between two runs, and `packages/fixtures/src/month-reconciliation.ts`
    // states an expectation per id in this same list from the other side of a boundary db cannot cross.
    expect(soundReport.lines.map((row) => row.id)).toEqual([...MONTH_RECONCILIATION_LINE_IDS])
    // Every caveat, never none: the last one names Y11-tax-agent, whose provisional answer is that an
    // FTA-registered agent's review is not optional and that this build does not assert the report's
    // correctness against FTA practice. A sound report with no caveat would be overclaiming.
    expect(soundReport.caveats.join(' ')).toContain('Y11-tax-agent')
    expect(soundReport.caveats.join(' ')).toContain('Y11-vat201-boxes')
    expect(soundReport.notExportableReasons).toEqual([])
  })

  it('holds the four named identities to the fil, each side non-zero', () => {
    const revenue = lineOf(soundReport, 'invoices_less_credit_notes_against_revenue_and_output_vat')
    expect(revenue.left.fils).toBe(BigInt(REVENUE_IDENTITY))
    expect(revenue.right.fils).toBe(BigInt(REVENUE_IDENTITY))
    expect(revenue.variance).toBe(0n)

    const tenders = lineOf(soundReport, 'payments_less_refunds_against_tender_accounts')
    expect(tenders.left.fils).toBe(BigInt(TENDER_IDENTITY))
    expect(tenders.right.fils).toBe(BigInt(TENDER_IDENTITY))
    expect(tenders.variance).toBe(0n)

    const liability = lineOf(
      soundReport,
      'package_liability_movement_against_sales_less_redemptions',
    )
    expect(liability.left.fils).toBe(BigInt(LIABILITY_IDENTITY))
    expect(liability.right.fils).toBe(BigInt(LIABILITY_IDENTITY))
    expect(liability.variance).toBe(0n)

    const coverage = lineOf(soundReport, 'completed_appointments_without_a_document')
    expect(coverage.left.rowsExamined).toBe(4)
    expect(coverage.right.rowsExamined).toBe(4)
    expect(coverage.variance).toBe(0n)

    // Both sides non-zero on every money identity, because two zeros reconcile perfectly and say nothing
    // — M-VAT-10's argument, restated for a report whose job is to find a difference.
    for (const row of [revenue, tenders, liability]) {
      expect(row.left.fils).not.toBe(0n)
      expect(row.right.fils).not.toBe(0n)
    }
  })

  it('carries the chain to the VAT box and the redemption identity the invoice line cannot make', () => {
    const redemption = lineOf(soundReport, 'package_redemptions_against_revenue_and_output_vat')
    expect(redemption.left.fils).toBe(BigInt(REDEMPTION_IDENTITY))
    expect(redemption.right.fils).toBe(BigInt(REDEMPTION_IDENTITY))

    const box = lineOf(soundReport, 'output_tax_against_the_vat201_box')
    expect(box.left.fils).toBe(BigInt(OUTPUT_TAX_IDENTITY))
    expect(box.right.fils).toBe(BigInt(OUTPUT_TAX_IDENTITY))
    expect(box.variance).toBe(0n)
    // The box NUMBER is read from the mapping and never written here: Y11-vat201-boxes is open, so a test
    // asserting the literal 1 would be asserting the answer instead of reading it.
    expect(box.right.label).toMatch(/^box \d+ tax$/)
  })

  it('ties its own per-source refinement back to the trial balance', () => {
    const tied = lineOf(soundReport, 'ledger_census_against_the_trial_balance')
    expect(tied.variance).toBe(0n)
    // 16 journal lines, both sides of each: 2 x (42_000 + 42_000 + 21_000 + 21_000 + 21_000 + 21_000 +
    // 63_000 + 63_000 + 21_000 + 21_000) is not a figure worth restating, so the claim is the EQUALITY
    // plus a non-zero floor — a census that read nothing would tie to a movement that read nothing.
    expect(tied.left.fils).toBeGreaterThan(0n)
    expect(tied.left.rowsExamined).toBe(16)
  })

  it('states the no-shows and the cancellations as their own lines, excluded from revenue', () => {
    const noShows = lineOf(soundReport, 'no_shows_excluded_from_revenue')
    expect(noShows.kind).toBe('excluded')
    expect(noShows.left.rowsExamined).toBe(1)
    expect(noShows.left.fils).toBe(BigInt(TREATMENT_GROSS))
    expect(noShows.right.rowsExamined).toBe(0)

    const cancellations = lineOf(soundReport, 'cancellations_excluded_from_revenue')
    expect(cancellations.kind).toBe('excluded')
    // TWO, and that is the assertion: `cancelled_by_customer` and `cancelled_by_salon` are different
    // policies and the same reporting treatment, so a report counting one of them would be wrong by half.
    expect(cancellations.left.rowsExamined).toBe(2)
    expect(cancellations.left.fils).toBe(BigInt(TREATMENT_GROSS * 2))
    expect(cancellations.right.rowsExamined).toBe(0)

    // And the value of all three is NOT in the revenue identity, which is what "excluded from revenue"
    // means: 3 x 21_000 = 63_000 of appointment value against a 42_000 revenue figure.
    expect(noShows.left.fils + cancellations.left.fils).toBe(BigInt(TREATMENT_GROSS * 3))
    expect(
      lineOf(soundReport, 'invoices_less_credit_notes_against_revenue_and_output_vat').left.fils,
    ).toBe(BigInt(REVENUE_IDENTITY))
  })
})

describe('the figures are read as of the lock, and the report says when they are not', () => {
  it('reads a closed period at the lock own instant, whatever nowIso the caller passes', () => {
    expect(soundReport.sourceAsOf).toBe(soundLockedAt)
    expect(soundReportOtherNow.sourceAsOf).toBe(soundLockedAt)
    // The control: the two calls were given instants 250 years apart and produced the same bytes, so
    // nothing in this report can be reading a clock.
    expect(NOW_ISO).not.toBe(STALE_NOW_ISO)
    expect(monthReconciliationBytes(soundReportOtherNow)).toBe(
      monthReconciliationBytes(soundReport),
    )
  })

  it('reads an OPEN period at the caller instant, and refuses to call it exportable', () => {
    expect(repeatReportWhileOpen.closed).toBe(false)
    expect(repeatReportWhileOpen.lockedPeriodId).toBeNull()
    expect(repeatReportWhileOpen.sourceAsOf).toBe(NOW_ISO)
    expect(repeatReportWhileOpen.notExportableReasons.join(' ')).toContain('is not closed')
  })

  it('counts the rows written after the instant it read at, and reports zero when there are none', () => {
    // The census over the CLOSED months finds nothing, which is what makes every other figure in them
    // the figure that was filed.
    expect(lineOf(soundReport, 'rows_created_after_the_period_lock').variance).toBe(0n)
    expect(lineOf(repeatReportClosed, 'rows_created_after_the_period_lock').variance).toBe(0n)

    // And the control, which is the half that matters: the same month read at an instant BEFORE it was
    // written finds every row, so the census is a check that has been seen to fire. 16 journal entries is
    // not the figure — 6 entries plus 2 invoices, 1 credit note, 3 payments, 1 refund, 1 package sale and
    // 1 redemption is 15.
    const stale = lineOf(repeatReportStaleAsOf, 'rows_created_after_the_period_lock')
    expect(stale.variance).toBe(15n)
    expect(repeatReportStaleAsOf.notExportableReasons.join(' ')).toContain(
      'were written after 2000-01-01',
    )
  })
})

describe('the injected defect: one payment row absent makes the report fail by name', () => {
  it('names exactly the tender identity, and is out by exactly the missing tender', () => {
    expect(defectiveReport.unexplainedVarianceLines).toEqual([
      'payments_less_refunds_against_tender_accounts',
    ])
    const tenders = lineOf(defectiveReport, 'payments_less_refunds_against_tender_accounts')
    // The documents now say 42_000 less was tendered; the ledger still says the money arrived.
    expect(tenders.left.fils).toBe(BigInt(TENDER_IDENTITY - INVOICE_1_GROSS))
    expect(tenders.right.fils).toBe(BigInt(TENDER_IDENTITY))
    expect(tenders.variance).toBe(BigInt(-INVOICE_1_GROSS))
    // Two payments and one refund. The sound month reads four; this assertion said two, forgetting the
    // refund, and the suite caught it.
    expect(tenders.left.rowsExamined).toBe(3)
  })

  it('leaves every other identity holding, so the report localises the defect', () => {
    // The point of a reconciliation rather than one balance check: a defect in the tender chain must not
    // make the revenue chain look wrong as well, or nobody can tell which figure to go and find.
    for (const id of [
      'invoices_less_credit_notes_against_revenue_and_output_vat',
      'package_liability_movement_against_sales_less_redemptions',
      'package_redemptions_against_revenue_and_output_vat',
      'output_tax_against_the_vat201_box',
      'ledger_census_against_the_trial_balance',
      'completed_appointments_without_a_document',
    ]) {
      const row = lineOf(defectiveReport, id)
      // The line's own measure, in one number. An earlier version of this file asserted a `varianceRows`
      // on a money line, which subtracted three documents from six journal lines and was -3 in a month
      // that balanced to the fil — the defect that collapsed the two variances into one.
      expect({ id, variance: row.variance }).toEqual({ id, variance: 0n })
    }
    expect(defectiveReport.examinedRows).toBe(EXAMINED_ROWS - 1)
  })
})

describe('the artefact: byte-identical, and exportable only when it is sound', () => {
  it('produces identical bytes from two generations of the same closed month', () => {
    expect(monthReconciliationBytes(soundReportAgain)).toBe(monthReconciliationBytes(soundReport))
  })

  it('writes every non-zero figure into the bytes as a quoted decimal string, never a JSON number', () => {
    const bytes = monthReconciliationBytes(soundReport)
    // The defect this refuses is the one M-VAT-07 recorded: two runs of an equally wrong serialiser agree
    // perfectly, so "the bytes are stable" says nothing about what is IN them. Every figure the identities
    // are about has to be findable in the bytes, quoted, because a bigint written as a JSON number rounds
    // silently at 2^53 in whatever reads the artefact years later.
    for (const figure of [
      REVENUE_IDENTITY,
      TENDER_IDENTITY,
      LIABILITY_IDENTITY,
      REDEMPTION_IDENTITY,
      OUTPUT_TAX_IDENTITY,
    ]) {
      expect(bytes).toContain(`"${figure}"`)
      expect(bytes).not.toContain(`:${figure},`)
    }
    // A vacuity floor on the above: five figures, and the bytes have to be big enough to hold a report.
    expect(bytes.length).toBeGreaterThan(2_000)
    expect(bytes).toContain('"month-recon-1"')
  })

  it('produces identical bytes for two months built from the same recipe', () => {
    // The acceptance line "two seeds produce identical output", as a claim about the RECIPE: the same
    // documents in a different month must produce the same report once the period and the lock are
    // normalised out. A report that leaked a uuid, a row order or an instant into its figures fails here
    // and passes the two-generations case above.
    expect(recipeBytes(repeatReportClosed)).toBe(recipeBytes(soundReport))
    // The control, which stops the normalisation from being the thing that makes them equal: the
    // DEFECTIVE month is the same recipe too, and must NOT match.
    expect(recipeBytes(defectiveReport)).not.toBe(recipeBytes(soundReport))
  })

  it('exports the sound month, hashes the bytes it hands over and writes one audit_event', async () => {
    const before = await exportCount()
    const exported = await withUnitOfWork(sql, ACTOR, (uow) =>
      exportMonthReconciliation(
        uow,
        soundReport,
        'Y11-tax-agent: the FTA-registered agent, unnamed',
      ),
    )
    expect(exported.bytes).toBe(monthReconciliationBytes(soundReport))
    expect(exported.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(exported.byteLength).toBe(exported.bytes.length)
    expect(exported.examinedRows).toBe(EXAMINED_ROWS)
    // A DELTA and never a total: `audit_event` is append-only (ADR 0008) and the seed and a dozen other
    // suites write to it, and it is counted in SQL rather than through a capped reader —
    // `settings-store.itest.ts` recorded three changes reading as zero because both sides of the
    // subtraction pinned at a limit of 500.
    expect((await exportCount()) - before).toBe(1)
    const [row] = await sql<{ hash: string; forWhom: string; rowCount: string }[]>`
      select after_state->>'contentHash' as hash,
             after_state->>'exportedFor' as "forWhom",
             after_state->>'examinedRows' as "rowCount"
        from audit_event
       where action = 'money.month_reconciliation.export'
         and entity_id = ${soundMonth.month.periodId}
       order by occurred_at desc limit 1
    `
    expect(row?.hash).toBe(exported.contentHash)
    expect(row?.forWhom).toContain('Y11-tax-agent')
    expect(Number(row?.rowCount)).toBe(EXAMINED_ROWS)
  })

  it('refuses to export the defective month, names the line, and writes NO audit_event', async () => {
    const before = await exportCount()
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        exportMonthReconciliation(uow, defectiveReport, 'Y11-tax-agent'),
      ),
    ).rejects.toThrow(/payments_less_refunds_against_tender_accounts/)
    // The refusal is before the audit row, not after it: an export recorded for an export that did not
    // happen is a trail that lies, and `audit_event` cannot be corrected afterwards.
    expect((await exportCount()) - before).toBe(0)
  })

  it('refuses an export with no recipient, and refuses the open month', async () => {
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) => exportMonthReconciliation(uow, soundReport, '   ')),
    ).rejects.toThrow(/who the export is for/)
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        exportMonthReconciliation(uow, repeatReportWhileOpen, 'Y11-tax-agent'),
      ),
    ).rejects.toThrow(/is not closed/)
  })
})

describe('the report cannot quietly stop examining something', () => {
  it('classifies every journal source the schema permits, in both directions', async () => {
    const census = await classifyJournalSources(sql)
    expect(census).toEqual({ unclassified: [], notPermitted: [] })
    // The vacuity floor, which is the half that matters: a parse of the CHECK that matched nothing would
    // produce two empty arrays and the assertion above would pass. 0018 declares seventeen sources.
    const claimed = Object.values(reconciliationModule.JOURNAL_SOURCE_CLASSES).flat()
    expect(claimed).toHaveLength(17)
    expect(new Set(claimed).size).toBe(17)
  })

  it('enumerates its consumers against its own real export list', () => {
    // M-VAT-08's arrangement: an export added and not classified fails HERE rather than passing silently.
    const real = Object.entries(reconciliationModule)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      // The error class is a constructor and not a consumer; it is the refusal, not a door.
      .filter((name) => name !== 'MonthReconciliationNotExportable')
      .sort()
    expect(real).toEqual([...MONTH_RECONCILIATION_CONSUMERS].sort())
    expect(MONTH_RECONCILIATION_CONSUMERS_REQUIRING_SOUNDNESS).toEqual([
      'exportMonthReconciliation',
    ])
  })

  it('refuses a period whose dates are not dates, or which ends before it starts', async () => {
    await expect(
      monthReconciliation(
        sql,
        { periodId: 'x', startsOn: 'August', endsOn: '2200-01-31' },
        NOW_ISO,
      ),
    ).rejects.toThrow(/must be an ISO date/)
    await expect(
      monthReconciliation(
        sql,
        { periodId: 'x', startsOn: '2200-01-31', endsOn: '2200-01-01' },
        NOW_ISO,
      ),
    ).rejects.toThrow(/ends \(2200-01-01\) before it starts/)
  })
})

/** Export rows for this unit's action, counted in SQL. Never through a reader that takes a limit. */
async function exportCount(): Promise<number> {
  const [row] = await sql<{ total: string }[]>`
    select count(*)::text as total from audit_event
     where action = 'money.month_reconciliation.export'
  `
  return Number(row?.total ?? 0)
}
