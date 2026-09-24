import type { AppointmentBillingSnapshot, Basket, VatRateBp } from '@berelax/core'
import {
  basketId,
  buildBasket,
  discountLine,
  entryId,
  filsFrom,
  filsFromStoredDigits,
  instantFromIso,
  money,
  reconcilePosting,
  STANDARD_SPA_CHART,
  serviceLineFromAppointment,
  splitGross,
  tipLine,
} from '@berelax/core'
import type { Actor, FinalisedCheckout, Sql } from '@berelax/db'
import { createConnection, finaliseCheckout, readInvoice, readJournalEntry } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertMappingReconciles, checkoutMapping } from './checkout.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * M-TILL-06 end to end: the basket core priced is the document the database holds, to the fils.
 *
 * `packages/db` may never import `packages/core`, so the two halves of this unit are proved separately —
 * the posting rule in `packages/core/src/checkout/posting.test.ts`, the transaction in
 * `packages/db/src/services/checkout-finalise.itest.ts` — and the PAIR can only be proved here, in the
 * package allowed to depend on both. The same arrangement `invoice-document.itest.ts` has for the tax
 * derivation and `booking-transaction.itest.ts` for the booking rule.
 *
 * What only this file can show:
 *
 *   - the figures a real appointment row carries reach the stored document and the stored journal entry
 *     **unchanged**, through `checkoutMapping` and `finaliseCheckout`, with no re-derivation on the way;
 *   - the three identities hold against the rows PostgreSQL actually holds, not against the values the
 *     writer returned;
 *   - a price rise published after the treatment moves neither, which is M-TILL-05's criterion followed
 *     one step further than `checkout-snapshot.itest.ts` takes it: through the journal as well as the
 *     document.
 *
 * ## Isolation
 *
 * The trading date `2099-11-23` is used by no other suite; the customer, room, service, variant, booking
 * and appointments are this file's own and carry {@link MARKER}; every read narrows to those ids. The
 * invoice family is truncated as the OWNER in `afterAll` before the customer is deleted — `invoice`
 * refuses DELETE for every role (ZI003) and `invoice.customer_id` is ON DELETE RESTRICT, so a document
 * left pointing at this file's customer would fail `customer-identity.itest.ts`'s bare
 * `delete from customer`. That is `tax-document.itest.ts`'s decision, for its reason.
 */

const MARKER = 'mtill06 checkout finalisation itest'
const TRADING_DATE = '2099-11-23'
const PROBE = 'mtill06_pair_probe'
const PROBE_PHONE = '+971590000623'
const PROBE_ROOM = 'mtill06-pair'
const THERAPIST_ONE = '33333333-4444-4555-8666-777777777777'
const THERAPIST_TWO = '33333333-4444-4555-8666-888888888888'

/** What the variant cost when the bookings were taken, and what the appointments snapshotted. */
const PRICE_AT_BOOKING = 26_250
/** The rise published after the treatments were delivered. Must appear on no row this file reads. */
const PRICE_AFTER_THE_RISE = 31_500
/** A gratuity of AED 30.00, which is on no tax invoice and in no revenue account. */
const TIP = 3_000

const TILL: Actor = { kind: 'staff', label: 'M-TILL-06 pair itest' }

/** 19:00 and 20:00 on the trading date; the checkout is closed at 21:30 the same evening. */
const SUPPLY_AT = instantFromIso(`${TRADING_DATE}T19:00:00+04:00`)
const ISSUED_AT = instantFromIso(`${TRADING_DATE}T21:30:00+04:00`)

let sql: Sql
let customerId: string
let bookingId: string
let variantId: string
let appointmentIds: string[] = []
let nonce: string

interface AppointmentRow {
  readonly id: string
  readonly service_variant_id: string
  readonly status: string
  readonly gross_price_fils: string
  readonly net_fils: string
  readonly vat_fils: string
  readonly vat_rate_bp: number
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  nonce = `${Date.now()}`

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = customer?.id as string

  // The trading calendar is a TABLE (0011) and `appointment.trading_date` is a foreign key into it, so
  // no fixture can invent a date the premises does not trade on. 11:00-02:00 in Asia/Dubai.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${`${TRADING_DATE} 11:00:00+04`}::timestamptz,
            ${'2099-11-24 02:00:00+04'}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `
  const [room] = await sql<{ id: string }[]>`
    insert into rooms (code, name, room_type, capacity, display_order, notes)
    values (${PROBE_ROOM}, 'Pair probe room', 'standard'::room_type, 1, 95, ${MARKER})
    on conflict (code) do update set capacity = excluded.capacity
    returning id
  `
  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, 'mtill06-pair-probe', 'Pair probe massage',
            'Normal Massage (Asian)', 20, 95)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${service?.id as string}, 60, ${PRICE_AT_BOOKING}, ${MARKER})
    on conflict (service_id, duration_minutes)
      do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = variant?.id as string

  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}, 'front_desk', ${MARKER})
    returning id
  `
  bookingId = booking?.id as string

  // The price is snapshotted onto the appointment at the moment the booking is taken (B-AVAIL-06), and
  // the split is core's: net derived, VAT the remainder — which is what
  // `appointment_price_split_exact` then holds the row to.
  const split = splitGross(money(filsFrom(PRICE_AT_BOOKING)))
  appointmentIds = []
  for (const [hour, therapistId] of [
    [19, THERAPIST_ONE],
    [20, THERAPIST_TWO],
  ] as const) {
    const start = `${TRADING_DATE} ${hour}:00:00+04`
    const end = `${TRADING_DATE} ${hour}:59:00+04`
    const [appointment] = await sql<{ id: string }[]>`
      insert into appointment
        (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
         gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes,
         therapist_buffer_minutes)
      values (${bookingId}, ${TRADING_DATE}, ${variantId}, 'solo'::service_shape, ${therapistId},
              ${room?.id as string}, ${`[${start},${end})`}::tstzrange,
              'completed'::appointment_status, ${PRICE_AT_BOOKING}, ${split.net.fils},
              ${split.vat.fils}, ${split.rateBp}, 20, 10)
      returning id
    `
    appointmentIds.push(appointment?.id as string)
  }
})

afterAll(async () => {
  // The invoice family first, as the OWNER: `invoice` refuses DELETE for every role (ZI003) so truncate
  // is the only legal removal, and it must happen before the customer goes because
  // `invoice.customer_id` is ON DELETE RESTRICT. Every referencing table is NAMED rather than reached
  // with CASCADE, so the next one to reference `invoice` fails loudly here.
  await sql?.unsafe(
    'truncate checkout_finalisation, payment, invoice_appointment, invoice_line, invoice',
  )
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await sql?.end({ timeout: 5 })
})

/** The variant's catalogue gross, as the database holds it now. */
async function livePriceFils(): Promise<number> {
  const [row] = await sql<{ gross_price_fils: string }[]>`
    select gross_price_fils from service_variant where id = ${variantId}
  `
  return filsFromStoredDigits(row?.gross_price_fils as string, 'service_variant.gross_price_fils')
}

/**
 * The appointment row, read back and mapped into the shape the till bills from.
 *
 * `filsFromStoredDigits` rather than `Number(...)`: the driver returns a bigint column as a string
 * precisely so nothing rounds a money figure on the way here, and this is the boundary where a value
 * that does not survive the round trip has to be refused rather than billed.
 */
async function snapshotOf(appointmentId: string): Promise<AppointmentBillingSnapshot> {
  const [row] = await sql<AppointmentRow[]>`
    select id, service_variant_id, status, gross_price_fils, net_fils, vat_fils, vat_rate_bp
      from appointment where id = ${appointmentId}
  `
  const appointment = row as AppointmentRow
  return {
    appointmentId: appointment.id,
    serviceVariantId: appointment.service_variant_id,
    status: 'completed',
    description: 'Normal Massage (Asian), 60 min',
    gross: money(
      filsFromStoredDigits(appointment.gross_price_fils, 'appointment.gross_price_fils'),
    ),
    net: money(filsFromStoredDigits(appointment.net_fils, 'appointment.net_fils')),
    vat: money(filsFromStoredDigits(appointment.vat_fils, 'appointment.vat_fils')),
    vatRateBp: appointment.vat_rate_bp as VatRateBp,
    priceListId: null,
    promotionId: null,
  }
}

/**
 * The basket the till builds: two treatments, the second 10% off for a cold room, plus a gratuity.
 *
 * Every figure by hand:
 *   line 1: 26_250 gross, 25_000 net, 1_250 VAT
 *   line 2: 26_250 less roundHalfUp(26_250 x 1_000 / 10_000) = 2_625 -> 23_625 charged,
 *           22_500 net, 1_125 VAT; the discount line therefore carries net -2_500 and VAT -125
 *   document: 47_500 net, 2_375 VAT, 49_875 gross
 *   tendered: 49_875 + 3_000 = 52_875
 */
async function basketFromDatabase(): Promise<Basket> {
  const [first, second] = appointmentIds as [string, string]
  return buildBasket(
    {
      basketId: basketId(`mtill06-pair-${nonce}`),
      customerId,
      lines: [
        serviceLineFromAppointment('line-1', await snapshotOf(first)),
        serviceLineFromAppointment('line-2', await snapshotOf(second)),
        discountLine({
          lineId: 'disc-1',
          targetLineId: 'line-2',
          reason: 'service_recovery',
          kind: 'percentage_bp',
          value: 1_000,
          note: 'Room was cold at the start of the second treatment',
        }),
        // No beneficiary: the gratuity goes to the pool. An id, never a name (ADR 0020).
        tipLine({ lineId: 'tip-1', gross: money(filsFrom(TIP)) }),
      ],
    },
    STANDARD_SPA_CHART,
  )
}

const DOC_NET = 47_500
const DOC_VAT = 2_375
const DOC_GROSS = 49_875
const TENDERED = DOC_GROSS + TIP
const REVENUE_CREDITED = 50_000
const DISCOUNT_DEBITED = 2_500

let finalised: FinalisedCheckout

describe('the basket core priced is the sale the database holds', () => {
  it('finalises once and stores exactly the figures the appointment rows carry', async () => {
    const basket = await basketFromDatabase()
    // The controls for everything below: the basket really does hold the hand-computed figures, so an
    // assertion about a STORED row is about the mapping and the transaction rather than about the
    // basket agreeing with itself.
    expect(basket.totals.netTotal.fils).toBe(DOC_NET)
    expect(basket.totals.vatTotal.fils).toBe(DOC_VAT)
    expect(basket.totals.taxableGross.fils).toBe(DOC_GROSS)
    expect(basket.totals.grossTotal.fils).toBe(TENDERED)
    expect(basket.totals.tipTotal.fils).toBe(TIP)

    const mapping = assertMappingReconciles(
      checkoutMapping({
        basket,
        tenders: [
          { kind: 'cash', amount: money(filsFrom(2_875)) },
          {
            kind: 'card_in_salon',
            amount: money(filsFrom(TENDERED - 2_875)),
            reference: `APPROVAL-${nonce}`,
          },
        ],
        entryId: entryId(`je-mtill06-pair-${nonce}`),
        idempotencyKey: `mtill06-pair-${nonce}`,
        requestFingerprint: `fp-${nonce}`,
        supplyAt: SUPPLY_AT,
        issuedAt: ISSUED_AT,
        origins: [
          { lineId: 'line-1', appointmentId: appointmentIds[0] as string },
          { lineId: 'line-2', appointmentId: appointmentIds[1] as string },
        ],
        customerId,
      }),
    )
    // Core's own reconciliation of the posting, before anything is written.
    expect(reconcilePosting(mapping.posting, STANDARD_SPA_CHART)).toEqual({
      imbalanceFils: 0,
      revenueVersusInvoiceNetFils: 0,
      vatVersusInvoiceVatFils: 0,
      tenderVersusInvoiceAndTipsFils: 0,
    })

    finalised = await finaliseCheckout(sql, TILL, mapping.input)
    expect(finalised.created).toBe(true)

    // --- the document, read back from PostgreSQL ------------------------------------------------
    const stored = await readInvoice(sql, finalised.invoice.id)
    expect(stored).not.toBeNull()
    expect(stored?.netTotalFils).toBe(DOC_NET)
    expect(stored?.vatTotalFils).toBe(DOC_VAT)
    expect(stored?.grossTotalFils).toBe(DOC_GROSS)
    expect(stored?.lines.map((line) => line.unitGrossFils)).toEqual([26_250, 23_625])
    expect(stored?.lines.map((line) => line.vatFils)).toEqual([1_250, 1_125])
    // The tax point is the SUPPLY's trading date, and the booking is on the row.
    expect(stored?.taxPointDate).toBe(TRADING_DATE)
    expect(stored?.bookingId).toBe(bookingId)
    expect(stored?.customerId).toBe(customerId)

    // --- the entry, read back from PostgreSQL --------------------------------------------------
    const entry = await readJournalEntry(sql, finalised.journalEntry.entryId)
    expect(entry).not.toBeNull()
    const credited = new Map(
      (entry?.lines ?? []).map((line) => [line.accountCode, line.creditFils - line.debitFils]),
    )
    // Debits equal credits, on the rows the database holds.
    expect((entry?.lines ?? []).reduce((total, line) => total + line.debitFils, 0)).toBe(
      (entry?.lines ?? []).reduce((total, line) => total + line.creditFils, 0),
    )
    // Revenue net of contra is the document's net; the output VAT is the document's VAT; the tenders
    // are the document's gross plus the gratuity.
    expect((credited.get('4010') ?? 0) + (credited.get('4095') ?? 0)).toBe(DOC_NET)
    expect(credited.get('4010')).toBe(REVENUE_CREDITED)
    expect(credited.get('4095')).toBe(-DISCOUNT_DEBITED)
    expect(credited.get('2030')).toBe(DOC_VAT)
    expect(credited.get('2040')).toBe(TIP)
    expect(-(credited.get('1010') ?? 0) - (credited.get('1040') ?? 0)).toBe(TENDERED)
    // Card money in the CLEARING account, not the bank: the terminal settles in a batch, days later.
    expect(credited.get('1020')).toBeUndefined()

    // --- the tenders and the links ------------------------------------------------------------
    expect(finalised.tenders.map((tender) => tender.tenderKind)).toEqual(['cash', 'card_in_salon'])
    expect(finalised.tenders.map((tender) => tender.amountFils)).toEqual([2_875, TENDERED - 2_875])
    expect(finalised.tenders[1]?.postingAccountCode).toBe('1040')
    expect(finalised.appointmentIds.slice().sort()).toEqual(appointmentIds.slice().sort())
    expect(finalised.bookingId).toBe(bookingId)
  }, 30_000)

  it('and a price rise published afterwards moves neither the document nor the journal', async () => {
    // The whole point, one step further than `checkout-snapshot.itest.ts` takes it: the price really
    // does change, and the journal is checked as well as the document.
    await sql`
        update service_variant set gross_price_fils = ${PRICE_AFTER_THE_RISE} where id = ${variantId}
      `
    // The control for the assertions below: the catalogue really did change, and to a DIFFERENT
    // number. Without it every assertion would pass against an UPDATE that did nothing.
    expect(await livePriceFils()).toBe(PRICE_AFTER_THE_RISE)
    expect(PRICE_AFTER_THE_RISE).not.toBe(PRICE_AT_BOOKING)

    const stored = await readInvoice(sql, finalised.invoice.id)
    const amounts = [
      stored?.netTotalFils,
      stored?.vatTotalFils,
      stored?.grossTotalFils,
      ...(stored?.lines ?? []).flatMap((line) => [
        line.unitGrossFils,
        line.lineGrossFils,
        line.netFils,
        line.vatFils,
      ]),
    ]
    expect(amounts).not.toContain(PRICE_AFTER_THE_RISE)
    expect(stored?.grossTotalFils).toBe(DOC_GROSS)

    const entry = await readJournalEntry(sql, finalised.journalEntry.entryId)
    const posted = (entry?.lines ?? []).flatMap((line) => [line.debitFils, line.creditFils])
    expect(posted).not.toContain(PRICE_AFTER_THE_RISE)
    // And the split of the risen price, which is the other figure a re-pricing implementation would
    // produce: 31_500 - roundHalfUp(31_500 x 20 / 21) = 31_500 - 30_000 = 1_500.
    const risenSplit = splitGross(money(filsFrom(PRICE_AFTER_THE_RISE)))
    expect(risenSplit.net.fils).toBe(30_000)
    expect(risenSplit.vat.fils).toBe(1_500)
    expect(posted).not.toContain(risenSplit.net.fils)
    expect(amounts).not.toContain(risenSplit.net.fils)

    // And the appointment rows themselves: the snapshot is a COLUMN, not a join. If these were the
    // same number, the assertions above would be saying nothing about snapshots at all.
    for (const appointmentId of appointmentIds) {
      const snapshot = await snapshotOf(appointmentId)
      expect(snapshot.gross.fils).toBe(PRICE_AT_BOOKING)
      expect(snapshot.net.fils + snapshot.vat.fils).toBe(snapshot.gross.fils)
    }
  }, 30_000)

  it('refuses a second checkout of the same treatments, by the constraint', async () => {
    const basket = await basketFromDatabase()
    const mapping = checkoutMapping({
      basket,
      tenders: [{ kind: 'cash', amount: money(filsFrom(TENDERED)) }],
      entryId: entryId(`je-mtill06-pair-again-${nonce}`),
      // A DIFFERENT key, so this is a second checkout rather than a retry: the refusal must be the
      // appointment link and not the idempotency key.
      idempotencyKey: `mtill06-pair-again-${nonce}`,
      requestFingerprint: `fp-again-${nonce}`,
      supplyAt: SUPPLY_AT,
      issuedAt: ISSUED_AT,
      origins: [
        { lineId: 'line-1', appointmentId: appointmentIds[0] as string },
        { lineId: 'line-2', appointmentId: appointmentIds[1] as string },
      ],
      customerId,
    })

    const refusal = await finaliseCheckout(sql, TILL, mapping.input).then(
      () => null,
      (err: unknown) => err,
    )
    expect(refusal).not.toBeNull()
    expect((refusal as { details?: { constraint?: string } }).details?.constraint).toBe(
      'invoice_appointment_appointment_once',
    )
    // Nothing was written: one invoice for this booking, still.
    const [count] = await sql<{ n: string }[]>`
        select count(*)::text as n from invoice where booking_id = ${bookingId}
      `
    expect(Number(count?.n)).toBe(1)
  }, 30_000)
})
