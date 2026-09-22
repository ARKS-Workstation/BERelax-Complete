import {
  type AppointmentBillingSnapshot,
  type Basket,
  basketId,
  buildBasket,
  discountLine,
  type Fils,
  filsFrom,
  filsFromStoredDigits,
  instantFromIso,
  localDate,
  money,
  resolvePrice,
  STANDARD_SPA_CHART,
  serviceLineFromAppointment,
  splitGross,
  type VatRateBp,
} from '@berelax/core'
import {
  type Actor,
  createConnection,
  type IssuedInvoice,
  issueInvoice,
  readInvoiceByDisplayNumber,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { invoiceFixture } from './invoice.ts'

/**
 * M-TILL-05 — the price on the appointment is the price on the document, and a price rise cannot move
 * either.
 *
 * The acceptance criterion this file exists for is one sentence: change `service_variant` between the
 * snapshot and the checkout, and neither the basket nor the issued invoice may move. A test that only
 * *read* the snapshot would prove nothing — the column it read would be the column a re-pricing
 * implementation also read, and the assertion would pass either way. So the price really is raised
 * here, against a real PostgreSQL, between the booking and the till.
 *
 * It lives in `packages/fixtures` because it needs both halves of a boundary: `@berelax/core` builds
 * the basket and derives the tax, `@berelax/db` stores the document, and `packages/db` may never import
 * `packages/core`. The same arrangement `invoice-document.itest.ts` has for the tax derivation and
 * `booking-transaction.itest.ts` for the booking rule.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind. The
 * trading date `2099-11-17` is used by no other suite; the service, variant, room, customer, booking and
 * appointment are this file's own and carry {@link MARKER}; and every read narrows to those ids. The
 * invoice row is **not** cleaned up and must not be: `invoice` is append-only and `refuse_invoice_change`
 * raises ZI003 for every role including the owner, so the only legal removal is the `truncate` that
 * `invoice-document.itest.ts` performs as owner in its own setup. Nothing here counts invoices.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'mtill05 checkout snapshot itest'
const TRADING_DATE = '2099-11-17'
const PROBE = 'mtill05_snapshot_probe'
const PROBE_PHONE = '+971590000517'
const PROBE_ROOM = 'mtill05-single'
const THERAPIST_ID = '11111111-2222-4333-8444-555555555555'

/** What the variant cost when the booking was taken, and what the appointment therefore snapshotted. */
const PRICE_AT_BOOKING = 26_250
/** The rise published after the treatment was delivered. Must appear on no basket and no document. */
const PRICE_AFTER_THE_RISE = 31_500

const TILL: Actor = { kind: 'staff', label: 'M-TILL-05 snapshot itest' }

/** 19:00 on the trading date, and the document written the same evening. */
const SUPPLY_AT = instantFromIso(`${TRADING_DATE}T19:00:00+04:00`)
const ISSUED_AT = instantFromIso(`${TRADING_DATE}T21:30:00+04:00`)

let sql: Sql
let variantId: string
let appointmentId: string

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

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  // The trading calendar is a TABLE (0011) and `appointment.trading_date` is a foreign key into it, so
  // no fixture can invent a date the premises does not trade on. 11:00-02:00 in Asia/Dubai.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${`${TRADING_DATE} 11:00:00+04`}::timestamptz,
            ${'2099-11-18 02:00:00+04'}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `
  const [room] = await sql<{ id: string }[]>`
    insert into rooms (code, name, room_type, capacity, display_order, notes)
    values (${PROBE_ROOM}, 'Probe room', 'standard'::room_type, 1, 97, ${MARKER})
    on conflict (code) do update set capacity = excluded.capacity
    returning id
  `
  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, 'mtill05-snapshot-probe', 'Probe massage',
            'Normal Massage (Asian)', 20, 97)
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
    values (${customer?.id as string}, 'front_desk', ${MARKER})
    returning id
  `
  // The price is snapshotted onto the appointment at the moment the booking is taken (B-AVAIL-06), and
  // the split is core's: net is derived and VAT is the remainder, which is what
  // `appointment_price_split_exact` then holds the row to.
  const split = splitGross(money(filsFrom(PRICE_AT_BOOKING)))
  const [appointment] = await sql<{ id: string }[]>`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes,
       therapist_buffer_minutes)
    values (${booking?.id as string}, ${TRADING_DATE}, ${variantId}, 'solo'::service_shape,
            ${THERAPIST_ID}, ${room?.id as string},
            ${`[${TRADING_DATE} 19:00:00+04,${TRADING_DATE} 20:00:00+04)`}::tstzrange,
            'completed'::appointment_status, ${PRICE_AT_BOOKING}, ${split.net.fils},
            ${split.vat.fils}, ${split.rateBp}, 20, 10)
    returning id
  `
  appointmentId = appointment?.id as string
})

afterAll(async () => {
  // The booking cascades to its appointment. The invoice is append-only and is deliberately left.
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await sql?.end({ timeout: 5 })
})

/** The variant's catalogue gross, as the database holds it now. */
async function livePriceFils(): Promise<Fils> {
  const [row] = await sql<{ gross_price_fils: string }[]>`
    select gross_price_fils from service_variant where id = ${variantId}
  `
  return filsFromStoredDigits(row?.gross_price_fils as string, 'service_variant.gross_price_fils')
}

/**
 * The appointment row, read back and mapped into the shape the till bills from.
 *
 * `filsFromStoredDigits` rather than `Number(...)`: the driver returns a `bigint` column as a string
 * precisely so that nothing rounds a money figure on the way here, and this is the boundary where a
 * value that does not survive the round trip has to be refused rather than published.
 */
async function snapshotFromDatabase(): Promise<AppointmentBillingSnapshot> {
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

/** The basket the till builds from that appointment: the treatment, less 10% for a cold room. */
async function basketFromDatabase(): Promise<Basket> {
  const line = serviceLineFromAppointment('line-1', await snapshotFromDatabase())
  return buildBasket(
    {
      basketId: basketId('mtill05-basket'),
      lines: [
        line,
        discountLine({
          lineId: 'disc-1',
          targetLineId: 'line-1',
          reason: 'service_recovery',
          kind: 'percentage_bp',
          value: 1_000,
          note: 'Room was cold at the start of the treatment',
        }),
      ],
    },
    STANDARD_SPA_CHART,
  )
}

/** Every money figure of a basket, flattened, so two baskets can be compared figure for figure. */
const figuresOf = (basket: Basket): readonly number[] => [
  ...basket.lines.map((line) => line.gross.fils),
  ...basket.lines.flatMap((line) =>
    line.tax === null ? [] : [line.tax.net.fils, line.tax.vat.fils],
  ),
  ...basket.charges.flatMap((charge) => [
    charge.grossBeforeDiscount.fils,
    charge.discount.fils,
    charge.gross.fils,
    charge.net.fils,
    charge.vat.fils,
  ]),
  basket.totals.grossTotal.fils,
  basket.totals.netTotal.fils,
  basket.totals.vatTotal.fils,
  basket.totals.discountTotal.fils,
]

/** Every money figure of an issued document, header and lines. */
const figuresOfInvoice = (invoice: IssuedInvoice): readonly number[] => [
  invoice.netTotalFils,
  invoice.vatTotalFils,
  invoice.grossTotalFils,
  ...invoice.lines.flatMap((line) => [
    line.unitGrossFils,
    line.lineGrossFils,
    line.netFils,
    line.vatFils,
  ]),
]

describe('the snapshotted price survives a price rise, on the basket and on the document', () => {
  it('bills the price that was agreed, not the price that is published now', async () => {
    const before = await basketFromDatabase()
    expect(before.charges[0]?.grossBeforeDiscount.fils).toBe(PRICE_AT_BOOKING)
    expect(before.charges[0]?.gross.fils).toBe(23_625)
    const charged = before.charges[0]?.gross ?? money(filsFrom(0))
    expect(before.totals.vatTotal.fils).toBe(splitGross(charged).vat.fils)

    // The document, derived from the basket's charges and stored by @berelax/db. The two derivations
    // are independent — the basket folded differences, `deriveDocumentTax` splits each charged gross —
    // and they must agree to the fils before anything is issued.
    const { input, tax } = invoiceFixture({
      supplyAt: SUPPLY_AT,
      issuedAt: ISSUED_AT,
      lines: before.charges.map((charge) => ({
        descriptionEn: charge.description,
        quantity: charge.quantity,
        unitGrossFils: charge.gross.fils,
        rateBp: charge.rateBp,
      })),
    })
    expect(tax.vat.fils).toBe(before.totals.vatTotal.fils)
    expect(tax.gross.fils).toBe(before.totals.taxableGross.fils)

    const issued = await withUnitOfWork(sql, TILL, (uow) => issueInvoice(uow, input))
    expect(issued.grossTotalFils).toBe(23_625)
    expect(issued.vatTotalFils).toBe(before.totals.vatTotal.fils)

    // --- the price rise, after the treatment was delivered and the document was written -----------
    await sql`
      update service_variant set gross_price_fils = ${PRICE_AFTER_THE_RISE} where id = ${variantId}
    `
    // The control for the whole test: the catalogue really did change, and the new figure really is a
    // different number. Without this, every assertion below would pass against an UPDATE that did
    // nothing.
    expect(await livePriceFils()).toBe(PRICE_AFTER_THE_RISE)
    expect(PRICE_AFTER_THE_RISE).not.toBe(PRICE_AT_BOOKING)

    // And the figure a re-pricing implementation would produce, named so it can be looked for. This is
    // what `resolvePrice` answers from the live variant today — a correct answer to a different
    // question, and the wrong one for a treatment already delivered.
    const rePriced = resolvePrice(
      { variant: { grossFils: await livePriceFils(), durationMinutes: 60 } },
      { on: localDate(TRADING_DATE) },
    )
    expect(rePriced.gross.fils).toBe(PRICE_AFTER_THE_RISE)

    const after = await basketFromDatabase()
    expect(figuresOf(after)).toEqual(figuresOf(before))
    expect(after.charges[0]?.grossBeforeDiscount.fils).toBe(PRICE_AT_BOOKING)
    expect(figuresOf(after)).not.toContain(PRICE_AFTER_THE_RISE)
    expect(figuresOf(after)).not.toContain(rePriced.net.fils)

    const reRead = await readInvoiceByDisplayNumber(sql, issued.displayNumber)
    expect(reRead).not.toBeNull()
    expect(figuresOfInvoice(reRead as IssuedInvoice)).toEqual(figuresOfInvoice(issued))
    expect(figuresOfInvoice(reRead as IssuedInvoice)).not.toContain(PRICE_AFTER_THE_RISE)
    // Every `fils` column of the stored row, by name, so a re-priced figure hiding in a column this
    // test does not read would still be found.
    const [stored] = await sql<{ doc: Record<string, string> }[]>`
      select to_jsonb(i) as doc from invoice i where i.id = ${issued.id}
    `
    const amounts = Object.entries((stored as { doc: Record<string, string> }).doc)
      .filter(([column]) => column.endsWith('_total'))
      .map(([, value]) => Number(value))
    expect(amounts).toEqual([22_500, 1_125, 23_625])
    expect(amounts).not.toContain(PRICE_AFTER_THE_RISE)
  })

  it('and the appointment row itself is untouched by the rise', async () => {
    // The snapshot is a column, not a join: the proof is that the appointment still holds the old
    // price while the variant holds the new one. If these were the same number, the test above would
    // be asserting nothing about snapshots at all.
    const snapshot = await snapshotFromDatabase()
    expect(snapshot.gross.fils).toBe(PRICE_AT_BOOKING)
    expect(await livePriceFils()).toBe(PRICE_AFTER_THE_RISE)
    expect(snapshot.net.fils + snapshot.vat.fils).toBe(snapshot.gross.fils)
  })
})
