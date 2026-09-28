import type { AppointmentBillingSnapshot, VatRateBp } from '@berelax/core'
import {
  basketId,
  entryId,
  filsFrom,
  filsFromStoredDigits,
  instantFromIso,
  localDate,
  money,
  requireInvoiceForm,
  splitGross,
} from '@berelax/core'
import type { Actor, Sql } from '@berelax/db'
import {
  createConnection,
  currentPackageTemplateVersion,
  finaliseCheckout,
  redeemPackage,
  savePackageTemplateVersion,
  sellPackage,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertMappingReconciles, checkoutMapping } from './checkout.ts'
import { truncateInvoiceFamily, truncatePackageFamily } from './invoice-family.ts'
import { packageSaleMapping } from './package.ts'
import { packageRedemptionMapping } from './package-redemption.ts'
import {
  assertTillReceiptCarriesEveryKind,
  TILL_RECEIPT_DISCOUNT_FILS,
  TILL_RECEIPT_DISCOUNT_REASON,
  TILL_RECEIPT_TIP_FILS,
  tillReceiptBasket,
} from './till-receipt.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The seeded till receipt, end to end (M-TILL-13).
 *
 * One basket carrying all four line kinds — a charged treatment, a discount that says why, a gratuity and a
 * package redemption — settled by a SPLIT TENDER, with the journal entry balancing to zero against the rows
 * PostgreSQL holds. It is here rather than in `apps/web` because only `packages/fixtures` may depend on both
 * `@berelax/core` and `@berelax/db`.
 *
 * ## Why the redemption line is on the SAME basket as the charged treatment
 *
 * Because that is what happens at a desk: a customer who is part way through a course also has a treatment
 * they are paying for, and one receipt covers the visit. The redemption line's gross is ZERO, so it reaches no
 * invoice line and no journal line — its own release is a separate entry, posted by `redeemPackage` under
 * source `package_redemption`, because a cash treatment and a prepaid one produce revenue on different
 * accounts. What the basket line does is carry the LINK: `invoice_appointment` gets a row with `line_no` null,
 * which is 0063's reason for making that column nullable and what `ZG011` reads to refuse an appointment that
 * is both redeemed and charged.
 *
 * ## Isolation
 *
 * The trading date {@link TRADING_DATE} is used by no other suite (`checkout-finalisation.itest.ts` uses
 * 2099-11-23, `package-redemption.itest.ts` 2085, its pair 2084, the expiry sweep 2083). Every read narrows to
 * this file's own ids, and every ledger assertion is a DELTA rather than a total, because `journal_line` is
 * append-only and truncated by nobody — M-TILL-10's recorded defect 7, which reported 430,003 fils from its
 * own previous run.
 */

const MARKER = 'mtill13 till receipt itest'
/**
 * A SEEDED business day, and this file owns no `business_day` row of its own.
 *
 * Every other suite of this shape invents a date in 2099 and deletes it afterwards. This one cannot, and the
 * reason is worth stating because it is the same reason three times: `package_sale` refuses DELETE for every
 * role (0078) and `package_redemption` does too (0083), so the probe package this file needs is PERMANENT — and
 * a permanent `package_sale` pins its `trading_date` in `business_day`, its `customer_id` in `customer` and its
 * balance's `service_variant_id` in the catalogue. An invented trading date would therefore be undeletable,
 * and an invented customer would break `customer-identity.itest.ts`, whose bare `delete from customer` would
 * hit the ON DELETE RESTRICT.
 *
 * So the package is sold on a seeded day, to a seeded customer, over a seeded variant, and this file deletes
 * only what it can: its booking (which cascades to its appointments), its service and its room.
 *
 * 2026-06-03 rather than the frozen clock's 2026-09-18: `apps/web/src/till.itest.ts` reads the day in
 * progress, and two suites putting billable appointments on one business day would make each one's screen
 * depend on whether the other had run.
 */
const TRADING_DATE = '2026-06-03'
const PROBE = 'mtill13_receipt_probe'
/**
 * This file's own probe customer, in a range nothing else in the repository uses.
 *
 * It was one of the four the consent loader seeds, and the comment here used to read "No suite deletes them".
 * That was false twice over. `apps/web/src/otp-route.itest.ts` clears the whole table with a bare
 * `delete from customer`, seeded rows included — so the row was not there to be read — and this file's own
 * package sale pinned it through 0078's `on delete restrict`, which is what made nine of that file's cases
 * fail on the foreign key. A probe row this file inserts and deletes has neither problem, and deleting it is
 * reachable because `afterAll` truncates the package family first. Deliberately NOT a seeded number: this
 * file deletes it, and deleting a row `pnpm seed` created would damage the fixture salon for every suite
 * after it.
 */
const PROBE_PHONE = '+971559990131'
const PROBE_ROOM = 'mtill13-receipt'
const TEMPLATE_KEY = 'mtill13_receipt_probe_package'
const THERAPIST_ONE = '33333333-4444-4555-8666-999999999911'
const THERAPIST_TWO = '33333333-4444-4555-8666-999999999912'
const PRICE_AT_BOOKING = 20_000
/** Two sessions, at the undiscounted sum of the catalogue price. No figure is invented. */
const PACKAGE_SESSIONS = 2

const TILL: Actor = { kind: 'staff', label: 'M-TILL-13 receipt itest' }
const SUPPLY_AT = instantFromIso(`${TRADING_DATE}T19:00:00+04:00`)
const ISSUED_AT = instantFromIso(`${TRADING_DATE}T21:30:00+04:00`)

let sql: Sql
let customerId: string
let variantId: string
let appointmentIds: string[] = []
let balanceId: string
let packagePriceFils: number
let nonce: string

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  nonce = `${Date.now()}`

  // A previous run that died between its inserts and its `afterAll` leaves appointments behind, and
  // `appointment_therapist_no_overlap` then refuses this file's inserts with a message about an exclusion
  // constraint rather than about the leftovers. Cleared first, by this file's own marker only.
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from rooms where notes = ${MARKER}`

  /*
    This file's OWN customer, inserted rather than read.

    It used to read one of the four the consent loader seeds, on the reasoning that a package sale pins
    whoever it names so an invented customer would be undeletable. The reasoning was right and the conclusion
    was wrong: `apps/web/src/otp-route.itest.ts` clears the table with a bare `delete from customer`, so the
    seeded customers do not survive one integration run and `pnpm seed` is not run again between suites — the
    read returned undefined and the booking insert failed on `UNDEFINED_VALUE`. The pin is the real problem
    and `afterAll` now removes it, by truncating the package family before deleting this row.
  */
  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, display_name, created_via, locale)
    values (${PROBE_PHONE}, ${`${MARKER} receipt probe`}, 'front_desk', 'en')
    on conflict (phone_e164) do update set display_name = excluded.display_name
    returning id
  `
  customerId = customer?.id as string

  // The trading calendar is a TABLE (0011) and `appointment.trading_date` is a foreign key into it, so no
  // fixture can invent a date the premises does not trade on. This one is SEEDED, for the reason above the
  // constant; asserted rather than assumed, because a seed that stopped covering it would otherwise present
  // as a foreign-key violation on the appointment insert.
  const [day] = await sql<{ trading_date: string }[]>`
    select to_char(trading_date, 'YYYY-MM-DD') as trading_date
      from business_day where trading_date = ${TRADING_DATE}::date
  `
  if (day === undefined) {
    throw new Error(
      `The seeded business_day range does not cover ${TRADING_DATE}. Run \`pnpm seed\`; this file ` +
        'deliberately owns no business_day row, because a permanent package_sale would pin it for ever.',
    )
  }
  const [room] = await sql<{ id: string }[]>`
    insert into rooms (code, name, room_type, capacity, display_order, notes)
    values (${PROBE_ROOM}, 'Receipt probe room', 'standard'::room_type, 1, 96, ${MARKER})
    on conflict (code) do update set capacity = excluded.capacity
    returning id
  `
  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes, display_order)
    values ('asian', ${PROBE}, 'mtill13-receipt-probe', 'Receipt probe massage',
            'Normal Massage (Asian)', 20, 96)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${service?.id as string}, 60, ${PRICE_AT_BOOKING}, ${MARKER})
    on conflict (service_id, duration_minutes) do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = variant?.id as string

  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}, 'front_desk', ${MARKER})
    returning id
  `
  // The price is snapshotted onto the appointment when the booking is taken (B-AVAIL-06), and the split is
  // core's: net derived, VAT the remainder, which is what `appointment_price_split_exact` holds the row to.
  const split = splitGross(money(filsFrom(PRICE_AT_BOOKING)))
  appointmentIds = []
  for (const [hour, therapistId] of [
    [19, THERAPIST_ONE],
    [20, THERAPIST_TWO],
  ] as const) {
    const [appointment] = await sql<{ id: string }[]>`
      insert into appointment
        (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
         gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes, therapist_buffer_minutes)
      values (${booking?.id as string}, ${TRADING_DATE}, ${variantId}, 'solo'::service_shape,
              ${therapistId}, ${room?.id as string},
              ${`[${TRADING_DATE} ${hour}:00:00+04,${TRADING_DATE} ${hour}:59:00+04)`}::tstzrange,
              'completed'::appointment_status, ${PRICE_AT_BOOKING}, ${split.net.fils},
              ${split.vat.fils}, ${split.rateBp}, 20, 10)
      returning id
    `
    appointmentIds.push(appointment?.id as string)
  }

  /*
    The package this receipt draws a session from, built over a SEEDED catalogue variant and not over this
    file's probe one. That is forced rather than tidy: `package_template_version` refuses DELETE outright
    (ZG001 — "a sale is a contract"), so a probe template version is PERMANENT, and a version whose line named
    the probe variant would pin the probe service for ever — `service` could then never be deleted and this
    file's `afterAll` would fail on a foreign key every run after the first.

    Named with the same provisional marker the seeded fixture packages carry, so a probe row can never read as
    a product the business sells (brief rule 15).
  */
  const [seededVariant] = await sql<{ id: string; gross_price_fils: string }[]>`
    select v.id, v.gross_price_fils
      from service_variant v
      join service s on s.id = v.service_id
     where s.style = 'asian'::treatment_style and s.treatment_key = 'normal_massage'
       and v.duration_minutes = 60 and s.archived_at is null
  `
  const packageVariantId = seededVariant?.id as string
  packagePriceFils = Number(seededVariant?.gross_price_fils) * PACKAGE_SESSIONS

  /*
    Re-use an existing probe balance if one is left over, and save-and-sell only when there is none.

    Not tidiness: `package_sale` refuses DELETE for every role, so a file that sold unconditionally would add
    one permanent sale and one permanent balance on every run — and `pnpm verify` runs the integration suite on
    every unit by every agent. One probe package with two sessions covers two runs; a third run sells again,
    which is the bound rather than an unbounded leak.

    The TEMPLATE VERSION is inside the same branch, and that was a defect found by reading the rows back after
    six runs: `savePackageTemplateVersion` is an EDIT — it inserts version + 1 — so calling it unconditionally
    left six versions of one probe template, each one undeletable (ZG001). Nothing read the extra versions,
    because every reader takes `max(version)`, which is exactly why nothing noticed.
  */
  const [spare] = await sql<{ id: string }[]>`
    select pb.id
      from package_balance pb
      join package_sale ps on ps.id = pb.package_sale_id
      join package_template_version tv on tv.id = ps.template_version_id
      join package_template t on t.id = tv.template_id
     where t.template_key = ${TEMPLATE_KEY} and pb.sessions_redeemed < pb.sessions_total
     order by pb.id
     limit 1
  `
  if (spare !== undefined) {
    balanceId = spare.id
  } else {
    /*
      The template version is SAVED ONLY WHEN THERE IS NONE, and read back otherwise.

      `savePackageTemplateVersion` is an EDIT: it inserts version + 1, because a template's terms are immutable
      once anything has been sold under them (0078). Calling it on every sale therefore left one undeletable
      version per sale — eight of them after eight runs, read by nothing because every reader takes
      `max(version)`, which is exactly why nothing noticed. A version that already says what this probe needs
      is the version to sell, so the save happens once in the life of a database.
    */
    let version = await currentPackageTemplateVersion(sql, TEMPLATE_KEY)
    if (version === null) {
      await withUnitOfWork(sql, TILL, async (uow) =>
        savePackageTemplateVersion(uow, {
          templateKey: TEMPLATE_KEY,
          internalName: `[confirm] ${PACKAGE_SESSIONS} sessions — probe, Y9-package-catalogue`,
          publicDisplayName: `[confirm] ${PACKAGE_SESSIONS} sessions — probe, Y9-package-catalogue`,
          priceFils: packagePriceFils,
          lines: [{ serviceVariantId: packageVariantId, sessionCount: PACKAGE_SESSIONS }],
        }),
      )
      version = await currentPackageTemplateVersion(sql, TEMPLATE_KEY)
    }
    const saved = version as NonNullable<typeof version>
    // The stored price, not the one computed above: the version is what the sale is held equal to by ZG002,
    // and a catalogue price that moved after the version was published must not change what is sold.
    packagePriceFils = saved.priceFils
    const saleMapping = packageSaleMapping({
      entryId: entryId(`mtill13-receipt-pkg-sale-${nonce}`),
      tradingDate: localDate(TRADING_DATE),
      customerId,
      templateVersionId: saved.versionId,
      priceGross: money(filsFrom(packagePriceFils)),
      lines: [
        {
          lineNo: 1,
          serviceVariantId: packageVariantId,
          sessionCount: PACKAGE_SESSIONS,
          listGrossFils: packagePriceFils,
        },
      ],
      tenders: [{ kind: 'cash', amount: money(filsFrom(packagePriceFils)) }],
      validityMonths: saved.validityMonths,
      transferable: saved.transferable,
      unredeemedBalancePolicy: saved.unredeemedBalancePolicy,
      packageLabel: saved.templateKey,
    })
    const sold = await withUnitOfWork(sql, TILL, async (uow) => sellPackage(uow, saleMapping.input))
    balanceId = sold.balanceIds[0] as string
  }

  // The release, BEFORE the checkout. Order matters: `ZG011`'s pair refuses whichever row arrives second, and
  // an `invoice_appointment` row whose `line_no` is null is exactly the link a redemption is allowed to leave.
  const [balanceRow] = await sql<
    {
      sessions_total: number
      sessions_redeemed: number
      value_fils: string
      released_fils: string
    }[]
  >`
    select sessions_total, sessions_redeemed, value_fils, released_fils
      from package_balance where id = ${balanceId}
  `
  const redemptionMapping = packageRedemptionMapping({
    entryId: entryId(`mtill13-receipt-pkg-redeem-${nonce}`),
    tradingDate: localDate(TRADING_DATE),
    balance: {
      balanceId,
      sessionsTotal: balanceRow?.sessions_total as number,
      sessionsRedeemed: balanceRow?.sessions_redeemed as number,
      valueGross: money(filsFrom(Number(balanceRow?.value_fils))),
      releasedGross: money(filsFrom(Number(balanceRow?.released_fils))),
    },
    appointmentId: appointmentIds[1] as string,
    units: 1,
    packageLabel: TEMPLATE_KEY,
  })
  await withUnitOfWork(sql, TILL, async (uow) => redeemPackage(uow, redemptionMapping.input))
})

afterAll(async () => {
  // The invoice family first, as the OWNER: `invoice` refuses DELETE for every role (ZI003) so truncate is the
  // only legal removal, and it must happen before the customer goes because `invoice.customer_id` is ON DELETE
  // RESTRICT. Every referencing table is NAMED rather than reached with CASCADE, so the next one to reference
  // `invoice` fails loudly here. `package_redemption` and `payment` are in the package truncate for 0083's
  // reason: PostgreSQL refuses a TRUNCATE while a referencing table is absent from the statement.
  if (sql !== undefined) await truncateInvoiceFamily(sql)
  /*
    And the package family, which an earlier version of this file deliberately left standing. That was wrong,
    and the reason it was wrong is worth keeping.

    The argument then was that truncating it would wipe the fixture salon's four seeded packages, which the
    `/packages` screen photographs. That is no longer true and should not have been relied on anyway: the
    seeded SALES are gone from `pnpm seed` altogether, because a `package_sale` pins its `customer_id` through
    an `on delete restrict` foreign key and 0078 refuses DELETE on the sale, so the customer can never be
    deleted again — and `apps/web/src/otp-route.itest.ts` clears the table with a bare `delete from customer`.
    Nine of its cases failed on that foreign key. This file's own probe sale pinned a seeded customer exactly
    the same way, so leaving it standing was the same defect in a second place.

    `truncate` is the only statement that removes an append-only row, so it is the only cleanup available, and
    it is what all five of the other package suites do. `apps/web/src/till.itest.ts` builds the four drawdown
    states in its own `beforeAll` and truncates them again afterwards, so nothing here is photographing rows
    this statement takes away.
  */
  if (sql !== undefined) await truncatePackageFamily(sql)
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  // No `business_day` delete: that is a SEEDED row this file only reads, for the reason stated above
  // TRADING_DATE. The customer IS this file's own and goes last, which is reachable only because the package
  // truncate above released 0078's `on delete restrict` pin on it.
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await sql?.end({ timeout: 5 })
})

async function snapshotOf(appointmentId: string): Promise<AppointmentBillingSnapshot> {
  const [row] = await sql<
    {
      id: string
      service_variant_id: string
      gross_price_fils: string
      net_fils: string
      vat_fils: string
      vat_rate_bp: number
    }[]
  >`
    select id, service_variant_id, gross_price_fils, net_fils, vat_fils, vat_rate_bp
      from appointment where id = ${appointmentId}
  `
  const appointment = row as NonNullable<typeof row>
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

/** Every debit and credit on the ledger right now, so every ledger claim below is a DELTA. */
async function ledgerTotals(): Promise<{ debit: number; credit: number }> {
  const [row] = await sql<{ debit: string; credit: string }[]>`
    select coalesce(sum(debit_fils), 0)::text as debit, coalesce(sum(credit_fils), 0)::text as credit
      from journal_line
  `
  return { debit: Number(row?.debit ?? '0'), credit: Number(row?.credit ?? '0') }
}

describe('acceptance — the seeded receipt carries all four line kinds and a split tender', () => {
  it('issues one document, two payment rows, and an entry that balances to zero', async () => {
    const basket = tillReceiptBasket({
      basketId: basketId(`mtill13-receipt-${nonce}`),
      charged: await snapshotOf(appointmentIds[0] as string),
      redeemedAppointmentId: appointmentIds[1] as string,
      redeemedBalanceId: balanceId,
    })
    // A measurement and not a `toContain`: the census counts each kind, so a basket holding two services and
    // no gratuity fails rather than satisfying "it has a service line".
    const census = assertTillReceiptCarriesEveryKind(basket)
    expect(census).toEqual({ service: 1, discount: 1, tip: 1, redemption: 1 })

    const due = basket.totals.grossTotal.fils
    // The SPLIT tender: cash and a card with its approval code, adding to the due figure exactly.
    const cash = 10_000
    const tenders = [
      { kind: 'cash' as const, amount: money(filsFrom(cash)) },
      {
        kind: 'card_in_salon' as const,
        amount: money(filsFrom(due - cash)),
        reference: 'APPROVAL-913',
      },
    ]
    expect(due - cash).toBeGreaterThan(0)

    // The form the RULE chooses, from the total and the absence of a named customer on the document. Asserted
    // rather than assumed, because the series follows from it — see `till-receipt.ts` on why SIMPL-INV.
    const form = requireInvoiceForm({
      gross: basket.totals.taxableGross,
      customerIdentified: basket.customerId !== null,
    })
    expect(form).toBe('simplified_invoice')

    const mapping = assertMappingReconciles(
      checkoutMapping({
        basket,
        tenders,
        entryId: entryId(`mtill13-receipt-${nonce}`),
        idempotencyKey: `mtill13-receipt-${nonce}`,
        requestFingerprint: `mtill13-receipt-${nonce}`,
        supplyAt: SUPPLY_AT,
        issuedAt: ISSUED_AT,
        origins: [
          { lineId: 'receipt-service', appointmentId: appointmentIds[0] as string },
          { lineId: 'receipt-redemption', appointmentId: appointmentIds[1] as string },
        ],
      }),
    )

    const before = await ledgerTotals()
    const finalised = await finaliseCheckout(sql, TILL, {
      ...mapping.input,
      invoice: { ...mapping.input.invoice, documentKind: form, seriesCode: 'SIMPL-INV' },
    })
    const after = await ledgerTotals()

    // The acceptance line's own claim, as a DELTA over the rows PostgreSQL holds. `journal_line` is
    // append-only and truncated by nobody, so a total here would report a previous run's figures.
    expect(after.debit - before.debit).toBe(after.credit - before.credit)
    expect(after.debit - before.debit).toBeGreaterThan(0)

    const [entry] = await sql<{ debit: string; credit: string; lines: string }[]>`
      select coalesce(sum(debit_fils), 0)::text as debit,
             coalesce(sum(credit_fils), 0)::text as credit,
             count(*)::text as lines
        from journal_line where entry_id = ${finalised.journalEntry.entryId}
    `
    expect(Number(entry?.debit)).toBe(Number(entry?.credit))
    // The gratuity, the revenue, the VAT, the contra-revenue discount and the two tenders: a zero-line entry
    // would satisfy "debits equal credits" perfectly, which is why the count is asserted too.
    expect(Number(entry?.lines)).toBeGreaterThanOrEqual(5)

    // One document line — the redemption's gross is zero, so it reaches no invoice line at all.
    const [doc] = await sql<{ kind: string; series: string; lines: string; gross: string }[]>`
      select i.document_kind as kind, i.series_code as series,
             (select count(*)::text from invoice_line l where l.invoice_id = i.id) as lines,
             i.gross_total as gross
        from invoice i where i.id = ${finalised.invoice.id}
    `
    expect(doc?.kind).toBe('simplified_invoice')
    expect(doc?.series).toBe('SIMPL-INV')
    expect(Number(doc?.lines)).toBe(1)
    expect(Number(doc?.gross)).toBe(basket.totals.taxableGross.fils)

    // Two payment rows, one per tender, with the card's reference kept: that field is what a disputed card
    // payment is settled with, and it is the one a mapping most easily drops.
    const payments = await sql<
      { tender_kind: string; amount_fils: string; reference: string | null }[]
    >`
      select tender_kind, amount_fils, reference from payment
       where invoice_id = ${finalised.invoice.id} order by tender_no
    `
    expect(payments.map((row) => row.tender_kind)).toEqual(['cash', 'card_in_salon'])
    expect(payments[1]?.reference).toBe('APPROVAL-913')
    expect(payments.reduce((total, row) => total + Number(row.amount_fils), 0)).toBe(due)

    // The redeemed appointment is LINKED with no line number, which is what makes it settled-and-not-charged.
    const links = await sql<{ appointment_id: string; line_no: number | null }[]>`
      select appointment_id, line_no from invoice_appointment
       where invoice_id = ${finalised.invoice.id} order by line_no nulls last
    `
    expect(links).toHaveLength(2)
    expect(links.find((row) => row.appointment_id === appointmentIds[1])?.line_no).toBeNull()
    expect(links.find((row) => row.appointment_id === appointmentIds[0])?.line_no).toBe(1)

    // The discount and the gratuity really reached the entry, on the accounts that tell them apart: a
    // gratuity is a liability to the therapist and never revenue, and a discount is contra-revenue.
    const accounts = await sql<{ account_code: string; debit: string; credit: string }[]>`
      select account_code, debit_fils::text as debit, credit_fils::text as credit
        from journal_line where entry_id = ${finalised.journalEntry.entryId}
       order by account_code
    `
    const codes = accounts.map((row) => row.account_code)
    expect(codes).toContain('2040')
    expect(codes).toContain('4095')
    expect(
      accounts.filter((row) => row.account_code === '2040').map((row) => Number(row.credit)),
    ).toEqual([TILL_RECEIPT_TIP_FILS])
    expect(
      accounts.filter((row) => row.account_code === '4095').map((row) => Number(row.debit)),
    ).toEqual([
      TILL_RECEIPT_DISCOUNT_FILS - Math.round((TILL_RECEIPT_DISCOUNT_FILS * 500) / 10_500),
    ])
  }, 60_000)

  it('the control: a basket missing any of the four kinds is refused by name', () => {
    // Without this, `assertTillReceiptCarriesEveryKind` could be a function that never throws and the
    // assertion above would prove nothing about the four kinds (ADR 0003).
    const withoutTip = tillReceiptBasket({
      basketId: basketId(`mtill13-receipt-control-${nonce}`),
      charged: {
        appointmentId: appointmentIds[0] as string,
        serviceVariantId: variantId,
        status: 'completed',
        description: 'Normal Massage (Asian), 60 min',
        gross: money(filsFrom(PRICE_AT_BOOKING)),
        net: money(filsFrom(splitGross(money(filsFrom(PRICE_AT_BOOKING))).net.fils)),
        vat: money(filsFrom(splitGross(money(filsFrom(PRICE_AT_BOOKING))).vat.fils)),
        vatRateBp: 500 as VatRateBp,
        priceListId: null,
        promotionId: null,
      },
      redeemedAppointmentId: appointmentIds[1] as string,
      redeemedBalanceId: balanceId,
    })
    const stripped = {
      ...withoutTip,
      lines: withoutTip.lines.filter((line) => line.kind !== 'tip'),
    }
    expect(() => assertTillReceiptCarriesEveryKind(stripped)).toThrow(/missing tip/)
    // And the discount reason is the enum's, not a free-text note: a reason a report cannot group by is a
    // reason nobody can act on.
    expect(TILL_RECEIPT_DISCOUNT_REASON).toBe('service_recovery')
  })
})
