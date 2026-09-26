import {
  ACCOUNTS,
  type AccountCode,
  entryId,
  expectedFloat,
  hoursFromSchedule,
  instantFromIso,
  issuerAddressSnapshot,
  localDate,
  localTime,
  resolveTradingDate,
  type TradingHours,
} from '@berelax/core'
import type { Actor, DrawerTakingsRow, Sql } from '@berelax/db'
import {
  closeCashSession,
  createConnection,
  issueInvoice,
  openCashSession,
  postCashSessionAdjustment,
  readCashSession,
  readDrawerTakings,
  recordCashDrop,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cashDropMapping, cashSessionCorrectionMapping, cashUpMapping } from './cash-up.ts'
import { FIXTURE_ISSUER } from './invoice.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * M-TILL-11's pair: the cash-up rule in `@berelax/core` against the rows PostgreSQL holds.
 *
 * `packages/db` may never import `packages/core`, so the two halves are proved separately — the
 * arithmetic and the posting in `packages/core/src/money/cash-up.test.ts`, the schema and the transaction
 * in `packages/db/src/services/cash-session.itest.ts` — and the PAIR can only be proved here, in the
 * package allowed to depend on both. The same arrangement `credit-note.itest.ts` has for M-TILL-08 and
 * `period-close.itest.ts` for M-VAT-06.
 *
 * What only this file can show:
 *
 *   - **the acceptance line about a day that crosses midnight.** Payments taken at 23:30 and at 01:30 are
 *     assigned to ONE business day by `resolveTradingDate`, and the session keyed on that day reconciles
 *     to the sum of those `payment` rows exact to the fils. Neither half can do this: core has no rows and
 *     `packages/db` cannot call the resolver.
 *   - that core's `expectedFloat` and SQL's `cash_session_expected_float_fils()` are ONE formula, over a
 *     table of takings, with a control proving the comparison can fail.
 *   - that `ACCOUNTS.cashOverShort`, `cash_over_short_account_code()` and the account the posting actually
 *     debits are one account and not three.
 *   - a real, NON-ZERO discrepancy end to end: counted, reconciled, posted and read back off
 *     `journal_line`.
 *
 * ## Isolation
 *
 * The business days are in 2089, which no other suite posts into (`journal.itest.ts` locks 2088,
 * `period-close.itest.ts` uses 2091, `credit-note.itest.ts` 2097–2098, `checkout-finalise.itest.ts` 2099,
 * gate 98 uses 2094, and `cash-session.itest.ts` 2087). A CLOSED `cash_session` refuses DELETE for every
 * role including the owner — the unit's own guarantee — so the sessions are cleared with TRUNCATE by the
 * owner, per test, which fires no row-level trigger. That is 0072's arrangement for `credit_note`, and it
 * has to be per test rather than per run because `ZU006` refuses cash dated on a business day whose
 * drawer has been counted, and `ZU005` sums the cash of a business day rather than of a drawer.
 */

const TILL: Actor = { kind: 'staff', label: 'M-TILL-11 pair itest' }

/** The real hours: 11:00 to 02:00 (docs/13 §2), as the resolver takes them. */
const OPEN_11_TO_02: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const HOURS = hoursFromSchedule({ weekly: Array.from({ length: 7 }, () => OPEN_11_TO_02) })

const DRAWER = 'mtill11_pair'
const CASH_IN_DRAWER = ACCOUNTS.cashInDrawer as string
const CASH_OVER_SHORT = ACCOUNTS.cashOverShort as string

/** The business day the midnight-crossing shift belongs to, and the day a correction posts on. */
const SHIFT_DAY = localDate('2089-04-10')
const NEXT_DAY = localDate('2089-04-11')
const DAYS = [SHIFT_DAY, NEXT_DAY, localDate('2089-04-12')] as const

/** One line at AED 262.50 gross, 5% VAT: net 25,000, VAT 1,250 (ADR 0007). */
const GROSS = 26_250
const NET = 25_000
const VAT = 1_250

/**
 * The issuer snapshot in `@berelax/db`'s spelling.
 *
 * `FIXTURE_ISSUER` carries `addressLines` because a document renders them as lines; the repository takes
 * one `addressSnapshot`, which is what `issuerAddressSnapshot` joins them into. Mapped here rather than
 * typed out, so the fixture stays the single statement of who the issuer is.
 */
const ISSUER = {
  legalName: FIXTURE_ISSUER.legalName,
  tradingName: FIXTURE_ISSUER.tradingName,
  trn: FIXTURE_ISSUER.trn,
  addressSnapshot: issuerAddressSnapshot(FIXTURE_ISSUER.addressLines),
  emirate: FIXTURE_ISSUER.emirate,
} as const

let sql: Sql
const RUN = Date.now().toString(36)
let nonce = 0
const idFor = (label: string) => entryId(`je-mtill11-pair-${label}-${RUN}-${nonce}`)

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  for (const day of DAYS) {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (
        ${day}::date,
        (${day}::date + time '11:00') at time zone 'Asia/Dubai',
        (${day}::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
        'weekly'
      )
      on conflict (trading_date) do nothing
    `
  }
  await sql`
    insert into cash_drawer (code, label, posting_account_code)
    values (${DRAWER}, 'M-TILL-11 pair itest drawer', ${CASH_IN_DRAWER})
    on conflict (code) do nothing
  `
})

afterAll(async () => {
  await sql?.unsafe('truncate cash_session_adjustment, cash_drop, cash_session')
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql.unsafe(
    'truncate credit_note_line, credit_note, refund, checkout_finalisation, payment, ' +
      'invoice_appointment, invoice_line, invoice',
  )
  await sql.unsafe('truncate cash_session_adjustment, cash_drop, cash_session')
  await sql`
    update document_series
       set next_number = 1, period_key = '', prefix = 'TI-', padding = 5, reset_policy = 'annual'
     where code = 'TAX-INV'
  `
  nonce += 1
})

/**
 * A cash payment taken at `receivedAtIso`, filed on the business day `resolveTradingDate` gives.
 *
 * THE thing this file exists to show. The trading date is not truncated from the instant and is not
 * passed in: it is resolved, here, from the real 11:00–02:00 hours, so an instant at 01:30 files itself
 * on the previous date the way the till would.
 */
async function cashTakenAt(
  receivedAtIso: string,
  amountFils: number,
  changeGivenFils = 0,
): Promise<{ readonly tradingDate: string; readonly appliedFils: number }> {
  const resolved = resolveTradingDate(instantFromIso(receivedAtIso), HOURS)
  if (resolved.kind !== 'trading') {
    throw new Error(
      `${receivedAtIso} resolves to no trading date (${resolved.reason}), so no drawer took it`,
    )
  }
  const tradingDate = resolved.date
  const invoice = await withUnitOfWork(sql, TILL, (uow) =>
    issueInvoice(uow, {
      documentKind: 'tax_invoice',
      seriesCode: 'TAX-INV',
      issuer: ISSUER,
      customer: { nameSnapshot: 'Customer 0042' },
      issueDate: tradingDate,
      issueTradingDate: tradingDate,
      taxPointDate: tradingDate,
      lines: [
        {
          descriptionEn: 'Asian Normal Massage, 60 minutes',
          quantity: 1,
          unitGrossFils: GROSS,
          vatRateBp: 500,
          netFils: NET,
          vatFils: VAT,
        },
      ],
      netTotalFils: NET,
      vatTotalFils: VAT,
      grossTotalFils: GROSS,
    }),
  )
  await sql`
    insert into payment (
      invoice_id, tender_no, tender_kind, posting_account_code, amount_fils, change_given_fils,
      trading_date, received_at
    ) values (
      ${invoice.id}::uuid, 1, 'cash', ${CASH_IN_DRAWER}, ${amountFils}, ${changeGivenFils},
      ${tradingDate}::date, ${receivedAtIso}::timestamptz
    )
  `
  return { tradingDate, appliedFils: amountFils - changeGivenFils }
}

async function openOn(tradingDate: string, openingFloatFils: number) {
  return withUnitOfWork(sql, TILL, (uow) =>
    openCashSession(uow, { drawerCode: DRAWER, tradingDate, openingFloatFils }, 'staff'),
  )
}

describe('a shift that crosses midnight is ONE business day, and it reconciles', () => {
  /**
   * The acceptance line, end to end.
   *
   * Four tenders across the shift: two before midnight, two after. Every one of them resolves to
   * 2089-04-10 through `resolveTradingDate`, so one session covers the shift — and the session's cash
   * total equals the sum of the `payment` rows for that business day, exact to the fils.
   */
  const TENDERS = [
    { at: '2089-04-10T15:05:00+04:00', amount: 26_250, change: 0 },
    { at: '2089-04-10T23:30:00+04:00', amount: 30_000, change: 3_750 },
    { at: '2089-04-11T00:40:00+04:00', amount: 26_250, change: 0 },
    { at: '2089-04-11T01:55:00+04:00', amount: 50_000, change: 23_750 },
  ] as const
  const RECEIVED = 132_500
  const CHANGE = 27_500
  const OPENING = 50_000

  it('files every tender of the shift on one business day, including the ones after midnight', async () => {
    const dates = new Set<string>()
    for (const tender of TENDERS) {
      const { tradingDate } = await cashTakenAt(tender.at, tender.amount, tender.change)
      dates.add(tradingDate)
    }
    expect([...dates]).toEqual([SHIFT_DAY as string])
    // The control: the CALENDAR dates of those instants are TWO, so the assertion above is about the
    // resolver rather than about four instants that happened to share a date. A reconciliation keyed on
    // the calendar date would have split this shift across two counts.
    expect(new Set(TENDERS.map((tender) => tender.at.slice(0, 10))).size).toBe(2)
  })

  it('reconciles the session to the sum of the cash payment rows, exact to the fils', async () => {
    for (const tender of TENDERS) await cashTakenAt(tender.at, tender.amount, tender.change)
    const session = await openOn(SHIFT_DAY, OPENING)

    const takings = (await readDrawerTakings(sql, session.id)) as DrawerTakingsRow
    // Read independently out of `payment`, so the reader and the rows are two answers compared rather
    // than one answer asserted against itself.
    const [rows] = await sql<{ received: string; change: string; n: string }[]>`
      select sum(amount_fils)::text as received, sum(change_given_fils)::text as change,
             count(*)::text as n
        from payment where trading_date = ${SHIFT_DAY}::date and tender_kind = 'cash'
    `
    expect(Number(rows?.n)).toBe(TENDERS.length)
    expect(takings.cashReceivedFils).toBe(Number(rows?.received))
    expect(takings.changeGivenFils).toBe(Number(rows?.change))
    expect([takings.cashReceivedFils, takings.changeGivenFils]).toEqual([RECEIVED, CHANGE])

    const mapping = cashUpMapping({
      cashSessionId: session.id,
      drawerCode: DRAWER,
      drawerAccount: ACCOUNTS.cashInDrawer,
      businessDay: SHIFT_DAY,
      takings,
      // 50,000 + 132,500 - 27,500 = 155,000 in the drawer.
      countedFloatFils: 155_000,
      entryId: idFor('balanced'),
    })
    expect(mapping.reconciliation.expectedFils).toBe(155_000)
    expect(mapping.reconciliation.discrepancyFils).toBe(0)
    expect(mapping.posting).toBeUndefined()

    const closed = await withUnitOfWork(sql, TILL, (uow) =>
      closeCashSession(uow, mapping.input, 'staff'),
    )
    // The DATABASE's own arithmetic, from the generated columns, against core's.
    expect(closed.expectedFloatFils).toBe(mapping.reconciliation.expectedFils)
    expect(closed.discrepancyFils).toBe(0)
    expect(closed.journalEntryId).toBeNull()
  })
})

describe('a real non-zero discrepancy, end to end', () => {
  it('counts short, posts the difference to 6140 and stores the signed figure', async () => {
    await cashTakenAt('2089-04-10T23:30:00+04:00', 30_000, 3_750)
    await cashTakenAt('2089-04-11T01:55:00+04:00', 26_250, 0)
    const session = await openOn(SHIFT_DAY, 50_000)
    const takings = (await readDrawerTakings(sql, session.id)) as DrawerTakingsRow
    // 50,000 + 56,250 - 3,750 = 102,500 expected, and 101,300 in the till: 1,200 fils missing.
    const SHORT_BY = -1_200
    const mapping = cashUpMapping({
      cashSessionId: session.id,
      drawerCode: DRAWER,
      drawerAccount: ACCOUNTS.cashInDrawer,
      businessDay: SHIFT_DAY,
      takings,
      countedFloatFils: 101_300,
      entryId: idFor('short'),
      countNote: 'Counted twice against the till roll; 1,200 fils unaccounted for.',
    })
    expect(mapping.reconciliation.expectedFils).toBe(102_500)
    expect(mapping.reconciliation.discrepancyFils).toBe(SHORT_BY)
    expect(mapping.reconciliation.direction).toBe('short')

    const closed = await withUnitOfWork(sql, TILL, (uow) =>
      closeCashSession(uow, mapping.input, 'staff'),
    )
    expect(closed.discrepancyFils).toBe(SHORT_BY)
    expect(closed.countNote).toContain('1,200 fils unaccounted for')

    // The posting, read back off `journal_line` rather than off what the writer returned — which is the
    // only way to know the transaction that closed the drawer also moved the money.
    const lines = await sql<{ account_code: string; debit_fils: string; credit_fils: string }[]>`
      select account_code, debit_fils, credit_fils from journal_line
       where entry_id = ${closed.journalEntryId ?? ''} order by line_no
    `
    expect(lines.map((l) => [l.account_code, Number(l.debit_fils), Number(l.credit_fils)])).toEqual(
      [
        [CASH_OVER_SHORT, 1_200, 0],
        [CASH_IN_DRAWER, 0, 1_200],
      ],
    )
    // And the entry is dated on the BUSINESS day, not on the calendar date the shift ended on.
    const [entry] = await sql<{ entry_date: string; source: string }[]>`
      select entry_date::text as entry_date, source from journal_entry
       where entry_id = ${closed.journalEntryId ?? ''}
    `
    expect(entry?.entry_date).toBe(SHIFT_DAY as string)
    expect(entry?.source).toBe('cash_up')
  })

  it('counts over, and the money in the drawer explains itself the other way', async () => {
    await cashTakenAt('2089-04-10T15:05:00+04:00', 26_250, 0)
    const session = await openOn(SHIFT_DAY, 50_000)
    const takings = (await readDrawerTakings(sql, session.id)) as DrawerTakingsRow
    const mapping = cashUpMapping({
      cashSessionId: session.id,
      drawerCode: DRAWER,
      drawerAccount: ACCOUNTS.cashInDrawer,
      businessDay: SHIFT_DAY,
      takings,
      // 76,250 expected, 76,700 counted.
      countedFloatFils: 76_700,
      entryId: idFor('over'),
      countNote: 'A 450-fils coin float that was never declared.',
    })
    expect(mapping.reconciliation.discrepancyFils).toBe(450)
    const closed = await withUnitOfWork(sql, TILL, (uow) =>
      closeCashSession(uow, mapping.input, 'staff'),
    )
    expect(closed.discrepancyFils).toBe(450)
    const [line] = await sql<{ credit_fils: string }[]>`
      select credit_fils from journal_line
       where entry_id = ${closed.journalEntryId ?? ''} and account_code = ${CASH_OVER_SHORT}
    `
    expect(Number(line?.credit_fils)).toBe(450)
  })

  it('takes a drop out of the drawer, and the expectation follows it', async () => {
    await cashTakenAt('2089-04-10T15:05:00+04:00', 26_250, 0)
    const session = await openOn(SHIFT_DAY, 50_000)
    const drop = cashDropMapping({
      cashSessionId: session.id,
      drawerCode: DRAWER,
      drawerAccount: ACCOUNTS.cashInDrawer,
      businessDay: SHIFT_DAY,
      destinationAccount: ACCOUNTS.bankCurrent,
      amountFils: 40_000,
      reason: 'Mid-shift banking run.',
      reference: 'DEP-000481',
      entryId: idFor('drop'),
    })
    await withUnitOfWork(sql, TILL, (uow) => recordCashDrop(uow, drop.input))

    const takings = (await readDrawerTakings(sql, session.id)) as DrawerTakingsRow
    expect(takings.dropsFils).toBe(40_000)
    // 50,000 + 26,250 - 40,000 = 36,250, and core and the database have to agree about it.
    expect(expectedFloat({ ...takings })).toBe(36_250)
    const closed = await withUnitOfWork(sql, TILL, (uow) =>
      closeCashSession(
        uow,
        cashUpMapping({
          cashSessionId: session.id,
          drawerCode: DRAWER,
          drawerAccount: ACCOUNTS.cashInDrawer,
          businessDay: SHIFT_DAY,
          takings,
          countedFloatFils: 36_250,
          entryId: idFor('after-drop'),
        }).input,
        'staff',
      ),
    )
    expect(closed.expectedFloatFils).toBe(36_250)
    expect(closed.discrepancyFils).toBe(0)
  })
})

describe('the two halves state one formula, and one account', () => {
  /**
   * Core's `expectedFloat` against SQL's `cash_session_expected_float_fils()`, over a table of takings.
   *
   * Two independent statements of one rule — one in TypeScript, one in SQL, each used by its own side —
   * so nothing but this comparison can say they agree. Every row is a case where a wrong sign or a
   * dropped term would show — the third is one fils in every column, where a dropped term moves the
   * answer by one — and the fourth has change EQUAL to refunds, which is the row that shows what this
   * table cannot catch: the two are both subtracted, so no comparison over takings can tell them apart.
   * That is what the control below transposes the opening float against the change for instead.
   */
  const TAKINGS: readonly DrawerTakingsRow[] = [
    {
      openingFloatFils: 0,
      cashReceivedFils: 0,
      changeGivenFils: 0,
      cashRefundedFils: 0,
      dropsFils: 0,
    },
    {
      openingFloatFils: 50_000,
      cashReceivedFils: 137_300,
      changeGivenFils: 8_700,
      cashRefundedFils: 4_100,
      dropsFils: 60_000,
    },
    {
      openingFloatFils: 1,
      cashReceivedFils: 2,
      changeGivenFils: 1,
      cashRefundedFils: 0,
      dropsFils: 2,
    },
    {
      openingFloatFils: 25_000,
      cashReceivedFils: 90_000,
      changeGivenFils: 7_000,
      cashRefundedFils: 7_000,
      dropsFils: 0,
    },
  ]

  it('agrees with the SQL function on every row', async () => {
    for (const takings of TAKINGS) {
      const [row] = await sql<{ expected: string }[]>`
        select cash_session_expected_float_fils(
          ${takings.openingFloatFils}, ${takings.cashReceivedFils}, ${takings.changeGivenFils},
          ${takings.cashRefundedFils}, ${takings.dropsFils}
        )::text as expected
      `
      expect(Number(row?.expected)).toBe(expectedFloat({ ...takings }))
    }
    // The control: the comparison can fail. The OPENING float and the CHANGE given are transposed, and
    // the pair is chosen rather than picked: one is added and the other subtracted, so the answer has to
    // move. Transposing `changeGiven` with `cashRefunded` — the first version of this control — changes
    // nothing at all, because both are subtracted, and it reported PASS while comparing a value to
    // itself.
    const skewed = TAKINGS[1] as DrawerTakingsRow
    const [wrong] = await sql<{ expected: string }[]>`
      select cash_session_expected_float_fils(
        ${skewed.changeGivenFils}, ${skewed.cashReceivedFils}, ${skewed.openingFloatFils},
        ${skewed.cashRefundedFils}, ${skewed.dropsFils}
      )::text as expected
    `
    expect(Number(wrong?.expected)).not.toBe(expectedFloat({ ...skewed }))
  })

  it('is NULL for an uncounted session on both sides of the boundary', async () => {
    // `strict`, so an OPEN session has no expectation rather than one derived from a count nobody took.
    const [row] = await sql<{ expected: string | null }[]>`
      select cash_session_expected_float_fils(50_000, null, 0, 0, 0)::text as expected
    `
    expect(row?.expected).toBeNull()
    const session = await openOn(SHIFT_DAY, 50_000)
    expect((await readCashSession(sql, session.id))?.expectedFloatFils).toBeNull()
  })

  it('holds ACCOUNTS.cashOverShort, the SQL function and the posted line to one account', async () => {
    const [row] = await sql<{ code: string }[]>`select cash_over_short_account_code() as code`
    expect(row?.code).toBe(ACCOUNTS.cashOverShort as string)
    // The control: the assertion is about equality and not about two constants that are both '6140' by
    // coincidence of being read from the same place. A different account of the same chart must differ.
    expect(row?.code).not.toBe(ACCOUNTS.badDebt as string)

    // And the third copy: the account the posting rule actually reaches for.
    await cashTakenAt('2089-04-10T15:05:00+04:00', 26_250, 0)
    const session = await openOn(SHIFT_DAY, 0)
    const takings = (await readDrawerTakings(sql, session.id)) as DrawerTakingsRow
    const mapping = cashUpMapping({
      cashSessionId: session.id,
      drawerCode: DRAWER,
      drawerAccount: ACCOUNTS.cashInDrawer,
      businessDay: SHIFT_DAY,
      takings,
      countedFloatFils: 26_000,
      entryId: idFor('third-copy'),
      countNote: 'Short by 250.',
    })
    const accounts = (mapping.posting?.lines ?? []).map((line) => line.account as string)
    expect(accounts).toContain(row?.code)
  })

  it('reads the drawer account out of the registry, so a safe float is not netted against the till', async () => {
    const [drawer] = await sql<{ posting_account_code: string }[]>`
      select posting_account_code from cash_drawer where code = 'reception'
    `
    expect(drawer?.posting_account_code).toBe(ACCOUNTS.cashInDrawer as string)
    const session = await openOn(SHIFT_DAY, 50_000)
    const takings = (await readDrawerTakings(sql, session.id)) as DrawerTakingsRow
    const mapping = cashUpMapping({
      cashSessionId: session.id,
      drawerCode: DRAWER,
      // The registry's answer for a drawer kept in the safe. Read, never assumed.
      drawerAccount: ACCOUNTS.pettyCash as AccountCode,
      businessDay: SHIFT_DAY,
      takings,
      countedFloatFils: 49_000,
      entryId: idFor('safe'),
      countNote: 'Safe float short after the banking run.',
    })
    expect((mapping.posting?.lines ?? []).map((line) => line.account as string)).toEqual([
      ACCOUNTS.cashOverShort as string,
      ACCOUNTS.pettyCash as string,
    ])
  })
})

describe('the correction to a counted drawer', () => {
  it('nets 6140 back to zero on its own business day, leaving the count readable', async () => {
    await cashTakenAt('2089-04-10T15:05:00+04:00', 26_250, 0)
    const session = await openOn(SHIFT_DAY, 50_000)
    const takings = (await readDrawerTakings(sql, session.id)) as DrawerTakingsRow
    const closed = await withUnitOfWork(sql, TILL, (uow) =>
      closeCashSession(
        uow,
        cashUpMapping({
          cashSessionId: session.id,
          drawerCode: DRAWER,
          drawerAccount: ACCOUNTS.cashInDrawer,
          businessDay: SHIFT_DAY,
          takings,
          countedFloatFils: 74_250,
          entryId: idFor('correction-short'),
          countNote: 'Short by 2,000 at the count.',
        }).input,
        'staff',
      ),
    )
    expect(closed.discrepancyFils).toBe(-2_000)

    const correction = cashSessionCorrectionMapping({
      cashSessionId: closed.id,
      drawerCode: DRAWER,
      drawerAccount: ACCOUNTS.cashInDrawer,
      businessDay: NEXT_DAY,
      correctsBusinessDay: SHIFT_DAY,
      amountFils: 2_000,
      reason: 'The 2,000 was found under the till the next day.',
      entryId: idFor('correction'),
    })
    const posted = await withUnitOfWork(sql, TILL, (uow) =>
      postCashSessionAdjustment(uow, correction.input),
    )
    expect(posted.tradingDate).toBe(NEXT_DAY as string)

    // The original count is UNCHANGED — the correction is a second fact beside it, not a rewrite.
    const after = await readCashSession(sql, closed.id)
    expect([after?.countedFloatFils, after?.discrepancyFils]).toEqual([74_250, -2_000])

    // And across the two entries, 6140 nets to zero: written off, then found.
    const [net] = await sql<{ net: string }[]>`
      select coalesce(sum(debit_fils - credit_fils), 0)::text as net
        from journal_line
       where account_code = ${CASH_OVER_SHORT}
         and entry_id in (${closed.journalEntryId ?? ''}, ${posted.journalEntryId})
    `
    expect(Number(net?.net)).toBe(0)
    // The control: the two entries are dated on DIFFERENT business days, so the netting above is not one
    // entry counted twice. A correction posted on the session's own day would file it in a period the
    // discovery never reached.
    const dates = await sql<{ entry_date: string }[]>`
      select entry_date::text as entry_date from journal_entry
       where entry_id in (${closed.journalEntryId ?? ''}, ${posted.journalEntryId})
       order by entry_date
    `
    expect(dates.map((row) => row.entry_date)).toEqual([SHIFT_DAY as string, NEXT_DAY as string])
  })
})
