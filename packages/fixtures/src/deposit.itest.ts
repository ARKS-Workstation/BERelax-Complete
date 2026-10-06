import { DEPOSIT_ENABLED_SETTING_KEY, provisionalSettings } from '@berelax/config'
import type { AppointmentBillingSnapshot, Basket, VatRateBp } from '@berelax/core'
import {
  ACCOUNTS,
  applyDepositToInvoice,
  basketId,
  buildBasket,
  classifyCancellation,
  DEPOSIT_TENDER_KIND,
  depositReceiptEntry,
  depositRefundEntry,
  depositRefundOnCancellation,
  depositReleaseTender,
  entryId,
  filsFrom,
  filsFromStoredDigits,
  instantFromIso,
  localDate,
  money,
  STANDARD_SPA_CHART,
  serviceLineFromAppointment,
  splitGross,
} from '@berelax/core'
import type { Actor, FinalisedCheckout, Sql } from '@berelax/db'
import {
  appendDepositMovement,
  createConnection,
  DEPOSIT_SQLSTATE,
  depositError,
  finaliseCheckout,
  isDepositRule,
  postJournalEntry,
  readDepositBalance,
  readDepositMovements,
  readDepositPolicy,
  readJournalEntry,
  unconfirmedAssumptionRows,
  withUnitOfWork,
  writeSetting,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertMappingReconciles, checkoutMapping } from './checkout.ts'
import { truncateInvoiceFamily } from './invoice-family.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * Y-PAY-06 end to end: a deposit is a liability until the treatment is delivered, and it belongs to ONE
 * appointment.
 *
 * `packages/db` may never import `packages/core`, so the two halves are proved separately — the
 * arithmetic in `packages/core/src/payments/deposit.test.ts` and the 500-case property beside it, the
 * rows in this file — and the PAIR can only be proved here, in the package allowed to depend on both.
 *
 * What only this file can show:
 *
 *   - the acceptance line *"a deposit posts to a payment-on-account liability account and leaves every
 *     revenue account untouched until the invoice is issued"*, read back from `journal_line` rather than
 *     from the entry the poster returned, and over EVERY revenue account the chart contains;
 *   - that the six refusals `ZY301`-`ZY306` actually fire against a real PostgreSQL, by code, each with
 *     the row that survived;
 *   - the acceptance line *"cancelling inside the provisional 24h window refunds the deposit in full and
 *     returns that appointment's liability balance to zero"*, read from
 *     `appointment_deposit_balance`;
 *   - that `customer_deposit_account_code()` in SQL and `ACCOUNTS.customerDepositsHeld` in TypeScript are
 *     one account — the `tips_payable_account_code()` arrangement (0068) one account along;
 *   - the whole life of a deposit through `finaliseCheckout`: received, released as a tender, and the
 *     document settled in full with revenue recognised exactly once.
 *
 * ## Isolation
 *
 * The trading date `2099-11-26` is used by no other suite; the customer, room, service, variant, booking
 * and appointments are this file's own and carry {@link MARKER}; every read narrows to those ids. The
 * invoice family is truncated as the OWNER in `afterAll` before the customer is deleted — `invoice`
 * refuses DELETE for every role (ZI003) and `deposit_movement` refuses it too (ZY301), so truncate is the
 * only legal removal, and `invoice.customer_id` is ON DELETE RESTRICT. The statement is declared in
 * `packages/db/src/suite-table-declarations.ts`, where `deposit_movement` was added in the same commit as
 * the migration.
 *
 * `audit_event` is append-only (ADR 0008), so the audit assertion is a DELTA and never a total (brief
 * rule 9). `app_setting` is restored to its seeded value at the end of the case that changes it, because
 * `writeSetting` clears `is_provisional` — which is the whole point of the Unconfirmed Assumptions panel
 * and would make this file's first case fail for every later run.
 */

const MARKER = 'ypay06 deposit itest'
const TRADING_DATE = '2099-11-26'
const PROBE = 'ypay06_deposit_probe'
const PROBE_PHONE = '+971590000626'
const PROBE_ROOM = 'ypay06-deposit'
const THERAPIST_ONE = '33333333-4444-4555-8666-aaaaaaaaaaaa'

/** AED 262.50, the menu price every other posting suite in this build uses. */
const PRICE = 26_250
const PRICE_NET = 25_000
const PRICE_VAT = 1_250
/** AED 52.50 of deposit. A figure the operator keyed; no policy produced it (Y9-deposits). */
const DEPOSIT = 5_250

const TILL: Actor = { kind: 'staff', label: 'Y-PAY-06 deposit itest' }

/** 19:00 on the trading date, and the checkout closed at 21:30 the same evening. */
const SUPPLY_AT = instantFromIso(`${TRADING_DATE}T19:00:00+04:00`)
const ISSUED_AT = instantFromIso(`${TRADING_DATE}T21:30:00+04:00`)

let sql: Sql
let customerId: string
let bookingId: string
let variantId: string
let roomId: string
/** One appointment per case that needs its own untouched deposit history. */
let appointmentIds: string[] = []
let nonce: string

interface AppointmentRow {
  readonly id: string
  readonly service_variant_id: string
  readonly gross_price_fils: string
  readonly net_fils: string
  readonly vat_fils: string
  readonly vat_rate_bp: number
}

/** How many appointments the suite needs. One per case, so no case can see another's movements. */
const APPOINTMENTS = 7

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  nonce = `${Date.now()}`

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = customer?.id as string

  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${`${TRADING_DATE} 11:00:00+04`}::timestamptz,
            ${'2099-11-27 02:00:00+04'}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `
  const [room] = await sql<{ id: string }[]>`
    insert into rooms (code, name, room_type, capacity, display_order, notes)
    values (${PROBE_ROOM}, 'Deposit probe room', 'standard'::room_type, 1, 96, ${MARKER})
    on conflict (code) do update set capacity = excluded.capacity
    returning id
  `
  roomId = room?.id as string
  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, 'ypay06-deposit-probe', 'Deposit probe massage',
            'Normal Massage (Asian)', 20, 96)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${service?.id as string}, 60, ${PRICE}, ${MARKER})
    on conflict (service_id, duration_minutes)
      do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = variant?.id as string

  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes) values (${customerId}, 'front_desk', ${MARKER})
    returning id
  `
  bookingId = booking?.id as string

  // The price is snapshotted onto the appointment when the booking is taken (B-AVAIL-06) and the split
  // is core's: net derived, VAT the remainder, which `appointment_price_split_exact` then holds it to.
  const split = splitGross(money(filsFrom(PRICE)))
  appointmentIds = []
  for (let index = 0; index < APPOINTMENTS; index += 1) {
    // One per hour from 12:00, so the exclusion constraint on (room, period) is satisfied.
    const hour = 12 + index
    const [appointment] = await sql<{ id: string }[]>`
      insert into appointment
        (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
         gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes,
         therapist_buffer_minutes)
      values (${bookingId}, ${TRADING_DATE}, ${variantId}, 'solo'::service_shape, ${THERAPIST_ONE},
              ${roomId}, ${`[${TRADING_DATE} ${hour}:00:00+04,${TRADING_DATE} ${hour}:30:00+04)`}::tstzrange,
              'completed'::appointment_status, ${PRICE}, ${split.net.fils}, ${split.vat.fils},
              ${split.rateBp}, 20, 10)
      returning id
    `
    appointmentIds.push(appointment?.id as string)
  }
})

afterAll(async () => {
  // The invoice family first, as the OWNER: `invoice` refuses DELETE for every role (ZI003) and
  // `deposit_movement` refuses it too (ZY301), so truncate is the only legal removal — and it must
  // happen before the customer goes, because `invoice.customer_id` is ON DELETE RESTRICT.
  if (sql !== undefined) await truncateInvoiceFamily(sql)
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await sql?.end({ timeout: 5 })
})

const appointment = (index: number): string => appointmentIds[index] as string

/** Posts one entry and returns its id. The entry is the caller's; nothing here derives a figure. */
async function post(
  id: string,
  lines: readonly { account: string; debitFils: number; creditFils: number }[],
  source: string,
  narrative: string,
): Promise<string> {
  await withUnitOfWork(sql, TILL, async (uow) => {
    await postJournalEntry(uow, {
      entryId: id,
      entryDate: TRADING_DATE,
      narrative,
      source,
      lines: lines.map((line) => ({
        accountCode: line.account,
        debitFils: line.debitFils,
        creditFils: line.creditFils,
        memo: null,
      })),
    })
  })
  return id
}

/** A deposit received for `appointmentId`, with its entry. Returns the movement row. */
async function receiveDeposit(appointmentId: string, amountFils: number, tag: string) {
  const entry = depositReceiptEntry(
    {
      entryId: entryId(`je-ypay06-${tag}-${nonce}`),
      entryDate: localDate(TRADING_DATE),
      appointmentId,
      amount: money(filsFrom(amountFils)),
      tenderKind: 'cash',
    },
    STANDARD_SPA_CHART,
  )
  return await withUnitOfWork(sql, TILL, async (uow) => {
    await postJournalEntry(uow, {
      entryId: entry.entryId as string,
      entryDate: entry.entryDate as string,
      narrative: entry.narrative,
      source: entry.source,
      lines: entry.lines.map((line) => ({
        accountCode: line.account as string,
        debitFils: line.debitFils,
        creditFils: line.creditFils,
        memo: line.memo,
      })),
    })
    return await appendDepositMovement(uow, {
      appointmentId,
      seq: 1,
      kind: 'received',
      heldBeforeFils: 0,
      amountFils,
      journalEntryId: entry.entryId as string,
      tenderKind: 'cash',
      tradingDate: TRADING_DATE,
    })
  })
}

async function snapshotOf(appointmentId: string): Promise<AppointmentBillingSnapshot> {
  const [row] = await sql<AppointmentRow[]>`
    select id, service_variant_id, gross_price_fils, net_fils, vat_fils, vat_rate_bp
      from appointment where id = ${appointmentId}
  `
  const a = row as AppointmentRow
  return {
    appointmentId: a.id,
    serviceVariantId: a.service_variant_id,
    status: 'completed',
    description: 'Normal Massage (Asian), 60 min',
    gross: money(filsFromStoredDigits(a.gross_price_fils, 'appointment.gross_price_fils')),
    net: money(filsFromStoredDigits(a.net_fils, 'appointment.net_fils')),
    vat: money(filsFromStoredDigits(a.vat_fils, 'appointment.vat_fils')),
    vatRateBp: a.vat_rate_bp as VatRateBp,
    priceListId: null,
    promotionId: null,
  }
}

async function basketFor(appointmentId: string, tag: string): Promise<Basket> {
  return buildBasket(
    {
      basketId: basketId(`ypay06-${tag}-${nonce}`),
      customerId,
      lines: [serviceLineFromAppointment('line-1', await snapshotOf(appointmentId))],
    },
    STANDARD_SPA_CHART,
  )
}

/** `sum(credit - debit)` per account over one stored entry, read back from PostgreSQL. */
async function storedMovements(id: string): Promise<Map<string, number>> {
  const entry = await readJournalEntry(sql, id)
  expect(entry, `entry ${id} was not stored`).not.toBeNull()
  return new Map(
    (entry?.lines ?? []).map((line) => [line.accountCode, line.creditFils - line.debitFils]),
  )
}

describe('a deposit posts to the payment-on-account liability and to nothing else', () => {
  it('credits 2045 by the whole gross and leaves every revenue account and 2030 untouched', async () => {
    const movement = await receiveDeposit(appointment(0), DEPOSIT, 'receipt')
    expect(movement.kind).toBe('received')
    expect(movement.heldAfterFils).toBe(DEPOSIT)

    const moved = await storedMovements(movement.journalEntryId)
    expect(moved.get(ACCOUNTS.customerDepositsHeld)).toBe(DEPOSIT)
    expect(moved.get(ACCOUNTS.cashInDrawer)).toBe(-DEPOSIT)
    // The acceptance line, over EVERY revenue account the chart contains rather than over the two a
    // treatment happens to use.
    const revenue = STANDARD_SPA_CHART.accounts.filter((a) => a.type === 'revenue')
    expect(
      revenue.length,
      'the chart holds no revenue accounts, so this loop measures nothing',
    ).toBeGreaterThan(3)
    for (const account of revenue) {
      expect(moved.get(account.code), `${account.code} must not move`).toBeUndefined()
    }
    expect(moved.get(ACCOUNTS.outputVatPayable)).toBeUndefined()
    // And it is not the PACKAGE liability, which is the near-enough code decision 19b forbids.
    expect(moved.get(ACCOUNTS.packageDeferredRevenue)).toBeUndefined()
    // The control: exactly the two lines, so the loop above is not satisfied by an empty entry.
    expect([...moved.keys()].sort()).toEqual(
      [ACCOUNTS.cashInDrawer, ACCOUNTS.customerDepositsHeld].sort(),
    )

    const balance = await readDepositBalance(sql, appointment(0))
    expect(balance).toMatchObject({ heldFils: DEPOSIT, movements: 1, lastMovement: 'received' })
  })

  it('holds the SQL account code and the chart constant to one account', async () => {
    const [row] = await sql<{ code: string }[]>`select customer_deposit_account_code() as code`
    expect(row?.code).toBe(ACCOUNTS.customerDepositsHeld)
    // The control: the comparison would notice a disagreement. 2050 is the plausible wrong answer —
    // both are liabilities for customer money held before a supply.
    expect(row?.code).not.toBe(ACCOUNTS.packageDeferredRevenue)
    // And the account is really in the chart the database holds, classified as a liability.
    const [stored] = await sql<{ type: string; vat_box: string | null }[]>`
      select type, vat_box from account where code = ${ACCOUNTS.customerDepositsHeld}
    `
    expect(stored).toMatchObject({ type: 'liability', vat_box: null })
  })

  it('reports an appointment with no deposit as ABSENT rather than as zero', async () => {
    // "No deposit was ever taken" and "a deposit was taken and returned" are different facts, and the
    // second one has rows. A caller deciding whether to offer a release has to tell them apart.
    expect(await readDepositBalance(sql, appointment(6))).toBeNull()
    expect(await readDepositMovements(sql, appointment(6))).toHaveLength(0)
  })
})

describe('applying a deposit settles the document and recognises revenue once', () => {
  it('releases the liability as a tender and the invoice is paid in full', async () => {
    const appointmentId = appointment(1)
    const received = await receiveDeposit(appointmentId, DEPOSIT, 'applied')

    const basket = await basketFor(appointmentId, 'applied')
    expect(basket.totals.taxableGross.fils).toBe(PRICE)
    const application = applyDepositToInvoice({
      invoiceGrossFils: basket.totals.taxableGross.fils,
      heldFils: received.heldAfterFils,
    })
    expect(application).toEqual({
      appliedFils: DEPOSIT,
      amountDueFils: PRICE - DEPOSIT,
      remainingHeldFils: 0,
    })

    const release = depositReleaseTender(application, received.id)
    expect(release).not.toBeNull()
    const mapping = assertMappingReconciles(
      checkoutMapping({
        basket,
        tenders: [
          release as NonNullable<typeof release>,
          { kind: 'cash', amount: money(filsFrom(application.amountDueFils)) },
        ],
        entryId: entryId(`je-ypay06-sale-${nonce}`),
        idempotencyKey: `ypay06-sale-${nonce}`,
        requestFingerprint: `fp-ypay06-${nonce}`,
        supplyAt: SUPPLY_AT,
        issuedAt: ISSUED_AT,
        origins: [{ lineId: 'line-1', appointmentId }],
        customerId,
      }),
    )

    const finalised: FinalisedCheckout = await finaliseCheckout(sql, TILL, mapping.input)
    expect(finalised.created).toBe(true)

    // The movement, written against the document the checkout issued.
    const applied = await withUnitOfWork(sql, TILL, (uow) =>
      appendDepositMovement(uow, {
        appointmentId,
        seq: 2,
        kind: 'applied',
        heldBeforeFils: received.heldAfterFils,
        amountFils: application.appliedFils,
        journalEntryId: finalised.journalEntry.entryId,
        invoiceId: finalised.invoice.id,
        tradingDate: TRADING_DATE,
      }),
    )
    expect(applied.heldAfterFils).toBe(0)
    expect(await readDepositBalance(sql, appointmentId)).toMatchObject({
      heldFils: 0,
      movements: 2,
      lastMovement: 'applied',
    })

    // --- the figures, read back from PostgreSQL ------------------------------------------------
    const receipt = await storedMovements(received.journalEntryId)
    const sale = await storedMovements(finalised.journalEntry.entryId)
    // Revenue and output VAT, summed across BOTH entries: the document's net and VAT, exactly once.
    expect(
      (receipt.get(ACCOUNTS.treatmentRevenue) ?? 0) + (sale.get(ACCOUNTS.treatmentRevenue) ?? 0),
    ).toBe(PRICE_NET)
    expect(
      (receipt.get(ACCOUNTS.outputVatPayable) ?? 0) + (sale.get(ACCOUNTS.outputVatPayable) ?? 0),
    ).toBe(PRICE_VAT)
    // The liability nets to zero across the two: taken and released, nothing left behind.
    expect(
      (receipt.get(ACCOUNTS.customerDepositsHeld) ?? 0) +
        (sale.get(ACCOUNTS.customerDepositsHeld) ?? 0),
    ).toBe(0)
    // The control for "exactly once": the receipt touched no revenue at all, so the sum above is the
    // sale's figure and not two halves that happened to add up.
    expect(receipt.get(ACCOUNTS.treatmentRevenue)).toBeUndefined()
    expect(sale.get(ACCOUNTS.treatmentRevenue)).toBe(PRICE_NET)

    // --- the document is SETTLED, which is the whole reason a release is a tender ---------------
    const [settlement] = await sql<{ payable: string; paid: string }[]>`
      select gross_total::text as payable,
             coalesce((select sum(applied_fils) from payment p where p.invoice_id = i.id), 0)::text
               as paid
        from invoice i where i.id = ${finalised.invoice.id}
    `
    expect(settlement?.payable).toBe(String(PRICE))
    expect(settlement?.paid).toBe(String(PRICE))
    // And the deposit really is one of the two tenders, posting to 2045.
    const tenders = await sql<{ tender_kind: string; posting_account_code: string }[]>`
      select tender_kind, posting_account_code from payment where invoice_id = ${finalised.invoice.id}
       order by tender_no
    `
    expect(tenders.map((t) => t.tender_kind)).toContain(DEPOSIT_TENDER_KIND)
    expect(tenders.find((t) => t.tender_kind === DEPOSIT_TENDER_KIND)?.posting_account_code).toBe(
      ACCOUNTS.customerDepositsHeld,
    )
  })
})

describe('cancelling inside the window refunds the deposit in full', () => {
  it('returns the whole balance and the appointment holds nothing', async () => {
    const appointmentId = appointment(2)
    const received = await receiveDeposit(appointmentId, DEPOSIT, 'refund-receipt')

    // 19:00 on the trading date, cancelled at 09:00 the same morning: ten hours' notice, inside the
    // provisional 24h window.
    const verdict = classifyCancellation({
      startsAt: SUPPLY_AT,
      at: instantFromIso(`${TRADING_DATE}T09:00:00+04:00`),
      windowHours: 24,
    })
    expect(verdict.late).toBe(true)
    expect(verdict.windowHours).toBe(24)

    const refund = depositRefundOnCancellation({ heldFils: received.heldAfterFils, verdict })
    expect(refund.refundFils).toBe(DEPOSIT)
    expect(refund.retainedFils).toBe(0)

    const entry = depositRefundEntry(
      {
        entryId: entryId(`je-ypay06-refund-${nonce}`),
        entryDate: localDate(TRADING_DATE),
        appointmentId,
        refund,
        tenderKind: 'cash',
      },
      STANDARD_SPA_CHART,
    )
    const movement = await withUnitOfWork(sql, TILL, async (uow) => {
      await postJournalEntry(uow, {
        entryId: entry.entryId as string,
        entryDate: entry.entryDate as string,
        narrative: entry.narrative,
        source: entry.source,
        lines: entry.lines.map((line) => ({
          accountCode: line.account as string,
          debitFils: line.debitFils,
          creditFils: line.creditFils,
          memo: line.memo,
        })),
      })
      return await appendDepositMovement(uow, {
        appointmentId,
        seq: 2,
        kind: 'refunded',
        heldBeforeFils: received.heldAfterFils,
        amountFils: refund.refundFils,
        journalEntryId: entry.entryId as string,
        tenderKind: 'cash',
        tradingDate: TRADING_DATE,
        insideWindow: refund.insideWindow,
        windowHours: refund.windowHours,
      })
    })

    // The acceptance line: the appointment's liability balance is zero.
    expect(movement.heldAfterFils).toBe(0)
    expect(await readDepositBalance(sql, appointmentId)).toMatchObject({
      heldFils: 0,
      movements: 2,
      lastMovement: 'refunded',
    })
    // The verdict is RECORDED on the row, so Y-PAY-07 reads a fact rather than re-deriving one.
    expect(movement.insideWindow).toBe(true)
    expect(movement.windowHours).toBe(24)

    // The ledger: 2045 debited by the whole balance, the drawer credited, no revenue either way.
    const moved = await storedMovements(movement.journalEntryId)
    expect(moved.get(ACCOUNTS.customerDepositsHeld)).toBe(-DEPOSIT)
    expect(moved.get(ACCOUNTS.cashInDrawer)).toBe(DEPOSIT)
    for (const account of STANDARD_SPA_CHART.accounts.filter((a) => a.type === 'revenue')) {
      expect(moved.get(account.code)).toBeUndefined()
    }

    // And the history is still there: the balance is zero because of two movements, not because the
    // receipt was removed.
    const history = await readDepositMovements(sql, appointmentId)
    expect(history.map((row) => row.kind)).toEqual(['received', 'refunded'])
  })
})

describe('the six refusals fire against a real PostgreSQL, by code', () => {
  it('ZY301 — a movement is append-only, and the row survives both attempts', async () => {
    const movement = await receiveDeposit(appointment(3), DEPOSIT, 'appendonly')
    for (const statement of [
      sql`update deposit_movement set amount_fils = 1 where id = ${movement.id}`,
      sql`delete from deposit_movement where id = ${movement.id}`,
    ]) {
      let thrown: unknown
      try {
        await statement
      } catch (error) {
        thrown = error
      }
      expect(isDepositRule(thrown, 'movementAppendOnly')).toBe(true)
      expect(depositError(thrown)?.details).toMatchObject({
        sqlState: DEPOSIT_SQLSTATE.movementAppendOnly,
      })
    }
    // The control: the row is still exactly what it was, so the refusals above refused rather than
    // partially applied.
    const [row] = await sql<{ amount_fils: string }[]>`
      select amount_fils from deposit_movement where id = ${movement.id}
    `
    expect(row?.amount_fils).toBe(String(DEPOSIT))
  })

  it('ZY302 — an entry that does not move the liability by this movement is refused', async () => {
    // An entry that moves 2045 by 1,000 fils against a movement claiming 5,250. It BALANCES, which is
    // why no other constraint in the database can see it.
    const id = `je-ypay06-wrongsize-${nonce}`
    await post(
      id,
      [
        { account: ACCOUNTS.cashInDrawer, debitFils: 1_000, creditFils: 0 },
        { account: ACCOUNTS.customerDepositsHeld, debitFils: 0, creditFils: 1_000 },
      ],
      'payment',
      'a deposit entry of the wrong size',
    )
    let thrown: unknown
    try {
      await withUnitOfWork(sql, TILL, (uow) =>
        appendDepositMovement(uow, {
          appointmentId: appointment(4),
          seq: 1,
          kind: 'received',
          heldBeforeFils: 0,
          amountFils: DEPOSIT,
          journalEntryId: id,
          tenderKind: 'cash',
          tradingDate: TRADING_DATE,
        }),
      )
    } catch (error) {
      thrown = error
    }
    expect(isDepositRule(thrown, 'entryIsNotTheMovement')).toBe(true)
    expect(await readDepositBalance(sql, appointment(4))).toBeNull()
  })

  it('ZY303 — a deposit receipt that recognises revenue is refused', async () => {
    // The mistake: the money came in, so something looks earned. The entry balances and the deposit
    // account moves by exactly the right figure; what is wrong is the 2030 and 4010 lines beside it.
    const id = `je-ypay06-revenue-${nonce}`
    await post(
      id,
      [
        { account: ACCOUNTS.cashInDrawer, debitFils: DEPOSIT, creditFils: 0 },
        { account: ACCOUNTS.customerDepositsHeld, debitFils: 0, creditFils: DEPOSIT },
        { account: ACCOUNTS.cardTerminalClearing, debitFils: 1_050, creditFils: 0 },
        { account: ACCOUNTS.treatmentRevenue, debitFils: 0, creditFils: 1_000 },
        { account: ACCOUNTS.outputVatPayable, debitFils: 0, creditFils: 50 },
      ],
      'payment',
      'a deposit entry that recognises revenue',
    )
    let thrown: unknown
    try {
      await withUnitOfWork(sql, TILL, (uow) =>
        appendDepositMovement(uow, {
          appointmentId: appointment(4),
          seq: 1,
          kind: 'received',
          heldBeforeFils: 0,
          amountFils: DEPOSIT,
          journalEntryId: id,
          tenderKind: 'cash',
          tradingDate: TRADING_DATE,
        }),
      )
    } catch (error) {
      thrown = error
    }
    expect(isDepositRule(thrown, 'depositRecognisedRevenue')).toBe(true)
    expect(String((thrown as Error).message)).toMatch(/Y11-vat-deposit/)
  })

  it('ZY304 — a movement that does not continue the chain is refused', async () => {
    const received = await receiveDeposit(appointment(5), DEPOSIT, 'chain-receipt')
    const id = `je-ypay06-chain-${nonce}`
    await post(
      id,
      [
        { account: ACCOUNTS.customerDepositsHeld, debitFils: 1_000, creditFils: 0 },
        { account: ACCOUNTS.cashInDrawer, debitFils: 0, creditFils: 1_000 },
      ],
      'refund',
      'a refund opening at the wrong balance',
    )
    let thrown: unknown
    try {
      // Opens at 9,000 when the previous movement closed at 5,250. Each row is internally consistent
      // either way — 9,000 less 1,000 is 8,000 — which is exactly why a CHECK cannot see it.
      await withUnitOfWork(sql, TILL, (uow) =>
        appendDepositMovement(uow, {
          appointmentId: appointment(5),
          seq: 2,
          kind: 'refunded',
          heldBeforeFils: 9_000,
          amountFils: 1_000,
          journalEntryId: id,
          tenderKind: 'cash',
          tradingDate: TRADING_DATE,
          insideWindow: true,
          windowHours: 24,
        }),
      )
    } catch (error) {
      thrown = error
    }
    expect(isDepositRule(thrown, 'chainIsBroken')).toBe(true)
    // The control: the balance is untouched, and the honest movement IS accepted.
    expect(await readDepositBalance(sql, appointment(5))).toMatchObject({ heldFils: DEPOSIT })
    const honest = await withUnitOfWork(sql, TILL, (uow) =>
      appendDepositMovement(uow, {
        appointmentId: appointment(5),
        seq: 2,
        kind: 'refunded',
        heldBeforeFils: received.heldAfterFils,
        amountFils: 1_000,
        journalEntryId: id,
        tenderKind: 'cash',
        tradingDate: TRADING_DATE,
        insideWindow: true,
        windowHours: 24,
      }),
    )
    expect(honest.heldAfterFils).toBe(DEPOSIT - 1_000)
  })

  it('ZY305 — a deposit may not settle another appointment’s document', async () => {
    const appointmentId = appointment(3)
    // A document for appointment(6), which holds no deposit of its own.
    const basket = await basketFor(appointment(6), 'other')
    const mapping = assertMappingReconciles(
      checkoutMapping({
        basket,
        tenders: [{ kind: 'cash', amount: money(filsFrom(PRICE)) }],
        entryId: entryId(`je-ypay06-other-${nonce}`),
        idempotencyKey: `ypay06-other-${nonce}`,
        requestFingerprint: `fp-ypay06-other-${nonce}`,
        supplyAt: SUPPLY_AT,
        issuedAt: ISSUED_AT,
        origins: [{ lineId: 'line-1', appointmentId: appointment(6) }],
        customerId,
      }),
    )
    const finalised = await finaliseCheckout(sql, TILL, mapping.input)

    const id = `je-ypay06-crossapply-${nonce}`
    await post(
      id,
      [
        { account: ACCOUNTS.customerDepositsHeld, debitFils: DEPOSIT, creditFils: 0 },
        { account: ACCOUNTS.cashInDrawer, debitFils: 0, creditFils: DEPOSIT },
      ],
      'sale',
      'a deposit applied to another appointment’s document',
    )
    let thrown: unknown
    try {
      await withUnitOfWork(sql, TILL, (uow) =>
        appendDepositMovement(uow, {
          appointmentId,
          seq: 2,
          kind: 'applied',
          heldBeforeFils: DEPOSIT,
          amountFils: DEPOSIT,
          journalEntryId: id,
          invoiceId: finalised.invoice.id,
          tradingDate: TRADING_DATE,
        }),
      )
    } catch (error) {
      thrown = error
    }
    expect(isDepositRule(thrown, 'appliedToAnotherAppointment')).toBe(true)
    expect(String((thrown as Error).message)).toMatch(/decision 19b/)
    expect(depositError(thrown)?.kind).toBe('validation')
    // The balance is untouched: the deposit is still the customer's, against their own appointment.
    expect(await readDepositBalance(sql, appointmentId)).toMatchObject({ heldFils: DEPOSIT })
  })

  it('ZY306 — a deposit may not become a package', async () => {
    // The conversion decision 19b forbids, written as what it actually is: an entry moving 2045 into
    // 2050. It balances, it has a narrative, and it writes no deposit_movement at all — which is why
    // the refusal is on `journal_line` and not on this unit's own table.
    let thrown: unknown
    try {
      await post(
        `je-ypay06-convert-${nonce}`,
        [
          { account: ACCOUNTS.customerDepositsHeld, debitFils: DEPOSIT, creditFils: 0 },
          { account: ACCOUNTS.packageDeferredRevenue, debitFils: 0, creditFils: DEPOSIT },
        ],
        'adjustment',
        'a deposit converted into a package',
      )
    } catch (error) {
      thrown = error
    }
    expect(isDepositRule(thrown, 'wouldBecomeAPrepaidProduct')).toBe(true)
    expect(String((thrown as Error).message)).toMatch(/decision 19b/)
    expect(await readJournalEntry(sql, `je-ypay06-convert-${nonce}`)).toBeNull()

    // The control, in the direction that matters: the SAME shape against a different liability is legal,
    // so the refusal is about 2050 and 2055 rather than about moving 2045 at all.
    const legal = `je-ypay06-notconvert-${nonce}`
    await post(
      legal,
      [
        { account: ACCOUNTS.customerDepositsHeld, debitFils: DEPOSIT, creditFils: 0 },
        { account: ACCOUNTS.cashInDrawer, debitFils: 0, creditFils: DEPOSIT },
      ],
      'refund',
      'a deposit refunded, which moves the same account',
    )
    expect(await readJournalEntry(sql, legal)).not.toBeNull()

    // And the voucher liability is refused too, which the single-direction trigger has to cover.
    let voucher: unknown
    try {
      await post(
        `je-ypay06-voucher-${nonce}`,
        [
          { account: ACCOUNTS.customerDepositsHeld, debitFils: DEPOSIT, creditFils: 0 },
          { account: ACCOUNTS.voucherDeferredRevenue, debitFils: 0, creditFils: DEPOSIT },
        ],
        'adjustment',
        'a deposit converted into a voucher',
      )
    } catch (error) {
      voucher = error
    }
    expect(isDepositRule(voucher, 'wouldBecomeAPrepaidProduct')).toBe(true)
  })
})

describe('the deposit policy is a provisional setting and changing it is audited', () => {
  it('is on the Unconfirmed Assumptions query, in the registry and in the database', async () => {
    const declared = provisionalSettings().find((s) => s.key === DEPOSIT_ENABLED_SETTING_KEY)
    expect(declared?.openQuestionId).toBe('Y9-deposits')
    expect(declared?.defaultValue).toBe(false)

    const stored = await unconfirmedAssumptionRows(sql)
    const row = stored.find(
      (s) => s.source === 'app_setting' && s.reference === DEPOSIT_ENABLED_SETTING_KEY,
    )
    expect(row, 'the seed wrote no provisional row for the deposit flag').toBeDefined()
    expect(row?.openQuestionId).toBe('Y9-deposits')
    // The percentage is on the panel too: both halves of the policy, or the panel clears for an answer
    // nobody gave.
    expect(
      stored.find(
        (s) => s.source === 'app_setting' && s.reference === 'payments.deposit_percent_bp',
      )?.openQuestionId,
    ).toBe('Y9-deposits')
    // The reader `packages/db` exposes agrees with the rows, which is the pairing only this file makes.
    expect(await readDepositPolicy(sql)).toEqual({ enabled: false, percentBp: 0 })
  })

  it('writes an audit_event when the flag is enabled, and clears the provisional marker', async () => {
    // A DELTA, never a total: `audit_event` is append-only (ADR 0008, brief rule 9).
    const countAudits = async (): Promise<number> => {
      const [row] = await sql<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where entity_type = 'app_setting' and entity_id = ${DEPOSIT_ENABLED_SETTING_KEY}
      `
      return Number(row?.n ?? '0')
    }
    const before = await countAudits()
    await withUnitOfWork(sql, TILL, (uow) =>
      writeSetting(uow, {
        key: DEPOSIT_ENABLED_SETTING_KEY,
        value: true,
        role: 'owner' as const,
        actorLabel: 'Y-PAY-06 deposit itest',
      }),
    )
    expect(await countAudits()).toBe(before + 1)
    expect(await readDepositPolicy(sql)).toEqual({ enabled: true, percentBp: 0 })
    // Confirming a value clears the provisional flag, which is the whole point of the panel.
    const stored = await unconfirmedAssumptionRows(sql)
    expect(
      stored.find((s) => s.source === 'app_setting' && s.reference === DEPOSIT_ENABLED_SETTING_KEY),
    ).toBeUndefined()

    // Restored, so this file leaves the database as it found it (brief rule 12): the case above would
    // otherwise fail on every later run, and `Y9-deposits` is still open.
    await sql`
      update app_setting
         set value = 'false'::jsonb, is_provisional = true, open_question_id = 'Y9-deposits'
       where key = ${DEPOSIT_ENABLED_SETTING_KEY}
    `
    expect(await readDepositPolicy(sql)).toEqual({ enabled: false, percentBp: 0 })
  })
})
