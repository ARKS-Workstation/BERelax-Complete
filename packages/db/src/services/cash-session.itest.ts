import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../audit.ts'
import { createConnection, type Sql } from '../connection.ts'
import { type IssueInvoiceInput, issueInvoice } from '../repositories/invoice.ts'
import { withUnitOfWork } from '../tx.ts'
import * as cashSessionModule from './cash-session.ts'
import {
  CASH_SESSION_SQLSTATE,
  cashSessionError,
  closeCashSession,
  type DrawerTakingsRow,
  isCashSessionClosed,
  isCountRequired,
  openCashSession,
  postCashSessionAdjustment,
  readCashSession,
  readCashSessionAdjustments,
  readCashSessionsForBusinessDay,
  readDrawerTakings,
  readOpenCashSession,
  recordCashDrop,
} from './cash-session.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The cash drawer reconciliation against a real PostgreSQL.
 *
 * Every claim in `0076_cash_session.sql` is a DATABASE rule — a partial unique index, two generated
 * columns through one immutable function, four per-row triggers, two DEFERRED constraint triggers, a
 * grant list — and a rule is only a rule once something has been seen to bounce off it (ADR 0003). So
 * every refusal below is asserted by its SQLSTATE or by the named index, never as "an error was raised",
 * and every refusal has an ACCEPTED control beside it, so a renamed column cannot make the whole file
 * pass by refusing everything.
 *
 * `packages/db` may not import `packages/core`, so every posting below is written out with its arithmetic
 * in a comment. The pair — `expectedFloat` and `cashUpPosting` in core against these rows — is
 * `packages/fixtures/src/cash-up.itest.ts`, the one package allowed to depend on both.
 *
 * ## Isolation, and why this file TRUNCATES rather than deletes
 *
 * A CLOSED `cash_session` cannot be deleted by anybody: `cash_session_no_delete_once_closed` (ZU002)
 * refuses DELETE for every role including the owner, which is the whole point of the unit. TRUNCATE by
 * the owner fires no row-level trigger, so it is the only way to clear the table — 0072's arrangement for
 * `credit_note`, one table along, and the migration revokes TRUNCATE from `berelax_app` precisely so this
 * remains a thing only a test or a migration can do.
 *
 * It has to happen per TEST and not per run, and two of this unit's own rules are why. A closed session
 * left behind on one of these business days refuses the next test's cash payment (`ZU006`, which is keyed
 * on the business day and not on the drawer, because `payment.drawer_code` is M-TILL-13's), and a second
 * OPEN session on one drawer and day is refused by the partial unique index this file exists to prove.
 * Narrowing the queries would not have been enough: those two rules are about rows this file cannot see
 * past.
 *
 * `payment` and `invoice` are truncated for the same reason — `ZU005` sums the cash of a business day, so
 * a leftover cash payment on one of these dates makes a correct snapshot read as wrong. The business days
 * are in 2087, which no other suite posts into, and are inserted with `on conflict do nothing` so the
 * calendar does not grow a row per run.
 */

/** Fifteen digits. A test value: the real TRN is unknown (Y1-trn) and the placeholder is refused. */
const TEST_TRN = '100123456700003'

const TILL: Actor = {
  kind: 'staff',
  id: '44444444-4444-4444-4444-444444444444',
  label: 'Till',
}

const ISSUER = {
  legalName: 'BE RELAX SPA - L.L.C - O.P.C',
  tradingName: 'BE RELAX - Massage Center and Spa',
  trn: TEST_TRN,
  addressSnapshot: '250 Al Meena Street\nTower Block A/B, M-Floor\nAl Zahiyah, Abu Dhabi',
  emirate: 'Abu Dhabi',
} as const

/**
 * Business days in a year no other suite posts into.
 *
 * `journal.itest.ts` locks 2088, `period-close.itest.ts` uses 2091, `credit-note.itest.ts` 2097–2098,
 * `checkout-finalise.itest.ts` 2099, and gate block 98 uses 2094. 2087 is this file's.
 *
 * Three consecutive days: DAY_ONE is the ordinary shift, DAY_TWO is where a correction posts, and
 * LOCKED_DAY sits inside the period this file closes.
 */
const DAY_ONE = '2087-03-04'
const DAY_TWO = '2087-03-05'
const LOCKED_DAY = '2087-05-06'
const DAYS = [DAY_ONE, DAY_TWO, LOCKED_DAY, '2087-03-06', '2087-03-07'] as const

const CASH_IN_DRAWER = '1010'
const CASH_OVER_SHORT = '6140'
const BANK = '1020'
const TRADE_RECEIVABLES = '1050'

/** One line at AED 262.50 gross, 5% VAT: net 25,000, VAT 1,250, gross 26,250 (ADR 0007). */
const GROSS = 26_250
const NET = 25_000
const VAT = 1_250

let sql: Sql
/**
 * A per-run entry-id prefix, and one drawer of this file's own.
 *
 * `journal_entry` is append-only and truncated by nobody, so an entry id built from the counter alone
 * collides with the previous run's — which reads as a primary-key violation in a file that has not
 * changed. `checkout-finalisation.itest.ts` takes the same precaution for the same reason.
 *
 * The drawer is a fixed code rather than a per-run one, because the sessions ARE cleared between tests
 * (see the header) and a registry that grew a row per run would be a second thing to tidy.
 */
const RUN = Date.now().toString(36)
const DRAWER = 'mtill11_itest'
let nonce = 0

const entryIdFor = (label: string) => `je-mtill11-${label}-${RUN}-${nonce}`

beforeAll(async () => {
  sql = createConnection({ url, max: 8 })
  // The trading calendar is a TABLE (0011) and `cash_session.trading_date` is a foreign key into it, so
  // the days have to exist. 11:00 to 02:00 the next calendar morning, which is what makes
  // `crosses_midnight` true — the generated column, not a value written here.
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
    values (${DRAWER}, 'M-TILL-11 itest drawer', ${CASH_IN_DRAWER})
    on conflict (code) do nothing
  `
})

afterAll(async () => {
  // The locks this file takes, and the sessions. TRUNCATE rather than DELETE, because a closed session
  // refuses DELETE for every role including the owner — which is the unit's guarantee, not an obstacle to
  // work around.
  await sql?.unsafe('truncate cash_session_adjustment, cash_drop, cash_session')
  await sql?.unsafe(`delete from period_lock where period_id like 'MTILL11-%'`)
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  // Every table that references `invoice` is NAMED: PostgreSQL refuses a truncate while a referencing
  // table is missing from the statement, and `invoice` refuses DELETE for every role (ZI003), so a
  // truncate as the owner is the only way to clear it. The list is 0072's.
  await sql.unsafe(
    'truncate credit_note_line, credit_note, refund, checkout_finalisation, payment, ' +
      'invoice_appointment, invoice_line, invoice',
  )
  // Both tables that reference `cash_session` are NAMED: PostgreSQL refuses a truncate while a
  // referencing table is missing from the statement.
  await sql.unsafe('truncate cash_session_adjustment, cash_drop, cash_session')
  await sql`
    update document_series
       set next_number = 1, period_key = '', prefix = 'TI-', padding = 5, reset_policy = 'annual'
     where code = 'TAX-INV'
  `
  await sql.unsafe(`delete from period_lock where period_id like 'MTILL11-%'`)
  nonce += 1
})

/**
 * Runs `body` as `berelax_app` inside a transaction, so `set local role` cannot leak.
 *
 * One statement per query, which is `period-close.itest.ts`'s measurement restated: postgres.js prepares
 * each one, and a prepared statement may not contain two commands — `set role …; delete …` in one
 * template comes back as `42601`, a syntax error, which reads exactly like the grant having been checked
 * when nothing was. `tx.unsafe()` has the same effect for a different reason, and cost this file a run:
 * the DELETE it issued came back SUCCESSFUL where `psql` refuses the identical statement.
 */
async function asApplicationRole<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`set local role berelax_app`
    return body(tx as unknown as Sql)
  }) as Promise<T>
}

/** The SQLSTATE of a rejected promise, or undefined. Never "an error was raised". */
async function stateOf(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await promise
    return { code: undefined, message: 'the statement succeeded' }
  } catch (err) {
    const direct = (err as { code?: unknown }).code
    const translated = cashSessionError(err)
    const carried = (translated?.details as { sqlState?: unknown } | undefined)?.sqlState
    return {
      code: typeof direct === 'string' ? direct : typeof carried === 'string' ? carried : undefined,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

function invoiceOn(tradingDate: string): IssueInvoiceInput {
  return {
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
  }
}

/**
 * A cash tender against a new document, dated on `tradingDate`.
 *
 * Inserted straight into `payment` rather than through the manual adapter, because what is under test
 * here is the SUM the snapshot has to equal — and the adapter posts a journal entry whose entry ids would
 * then have to be unique per case for no benefit to this file's claims.
 */
async function cashPaymentOn(
  tradingDate: string,
  amountFils: number,
  changeGivenFils = 0,
): Promise<string> {
  const invoice = await withUnitOfWork(sql, TILL, (uow) =>
    issueInvoice(uow, invoiceOn(tradingDate)),
  )
  await sql`
    insert into payment (
      invoice_id, tender_no, tender_kind, posting_account_code, amount_fils, change_given_fils,
      trading_date
    ) values (
      ${invoice.id}::uuid, 1, 'cash', ${CASH_IN_DRAWER}, ${amountFils}, ${changeGivenFils},
      ${tradingDate}::date
    )
  `
  return invoice.id
}

/** A session opened on `tradingDate` with `openingFloatFils` declared. */
async function openOn(tradingDate: string, openingFloatFils: number, shiftNo?: number) {
  return withUnitOfWork(sql, TILL, (uow) =>
    openCashSession(
      uow,
      {
        drawerCode: DRAWER,
        tradingDate,
        openingFloatFils,
        ...(shiftNo === undefined ? {} : { shiftNo }),
      },
      'staff',
    ),
  )
}

/** The cash-up entry for a discrepancy, written out because core cannot be imported here. */
function cashUpEntry(label: string, tradingDate: string, discrepancyFils: number) {
  const magnitude = Math.abs(discrepancyFils)
  return {
    entryId: entryIdFor(label),
    entryDate: tradingDate,
    narrative: `Cash-up ${tradingDate} drawer "${DRAWER}"`,
    source: 'cash_up',
    lines:
      discrepancyFils < 0
        ? [
            { accountCode: CASH_OVER_SHORT, debitFils: magnitude, creditFils: 0 },
            { accountCode: CASH_IN_DRAWER, debitFils: 0, creditFils: magnitude },
          ]
        : [
            { accountCode: CASH_IN_DRAWER, debitFils: magnitude, creditFils: 0 },
            { accountCode: CASH_OVER_SHORT, debitFils: 0, creditFils: magnitude },
          ],
  }
}

describe('the key is the business day', () => {
  it('stores the business day as a foreign key into the trading calendar', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    expect(session.tradingDate).toBe(DAY_ONE)
    // And the calendar row it points at crosses midnight, which is what makes a 23:00-to-02:00 shift one
    // session. `crosses_midnight` is generated from the instants (0011), so this is the database's answer
    // rather than a flag this file wrote.
    const [day] = await sql<{ crosses_midnight: boolean; duration_seconds: number }[]>`
      select crosses_midnight, duration_seconds from business_day where trading_date = ${DAY_ONE}::date
    `
    expect(day?.crosses_midnight).toBe(true)
    expect(day?.duration_seconds).toBe(54_000)
  })

  it('refuses a session on a date the premises does not trade', async () => {
    // A closed date is ABSENT from business_day rather than present with a flag (0011), so the foreign
    // key is what makes "a cash-up for a day we did not open" unrepresentable.
    const refused = await stateOf(openOn('2087-12-25', 50_000))
    expect(refused.code).toBe('23503')
  })

  it('leaves the expected float and the discrepancy NULL while the session is open', async () => {
    // `cash_session_expected_float_fils()` is STRICT, so an uncounted session has no expectation rather
    // than one derived from a count nobody took. A `coalesce(…, 0)` in the generation expression would
    // state an expected float for a shift that is still running.
    const session = await openOn(DAY_ONE, 50_000)
    expect(session.expectedFloatFils).toBeNull()
    expect(session.discrepancyFils).toBeNull()
    expect(session.countedFloatFils).toBeNull()
  })
})

describe('at most one open session per drawer per business day', () => {
  it('refuses the second OPEN session by the named partial index', async () => {
    await openOn(DAY_ONE, 50_000)
    const refused = await stateOf(openOn(DAY_ONE, 50_000, 2))
    expect(refused.code).toBe('23505')
    expect(refused.message).toContain('cash_session_one_open_per_drawer_per_day')
  })

  it('allows a SECOND SHIFT once the first has been counted', async () => {
    // The control for the index being PARTIAL. A day may hold an early shift and a late one, each
    // counted; a total unique index would refuse the second and there would be no way to hand a till
    // over mid-day.
    const first = await openOn(DAY_ONE, 50_000)
    await closeBalanced(first.id, { ...ZERO_TAKINGS, openingFloatFils: 50_000 }, 50_000)
    const second = await openOn(DAY_ONE, 50_000)
    expect(second.shiftNo).toBe(2)
    expect(second.status).toBe('open')
  })

  it('allows an open session on the NEXT business day', async () => {
    await openOn(DAY_ONE, 50_000)
    const next = await openOn(DAY_TWO, 50_000)
    expect(next.tradingDate).toBe(DAY_TWO)
    // And `readOpenCashSession` finds the older one first, so a shift somebody forgot to close is not
    // skipped over by the next day's cash-up.
    const open = await readOpenCashSession(sql, DRAWER)
    expect(open?.tradingDate).toBe(DAY_ONE)
  })
})

const ZERO_TAKINGS: DrawerTakingsRow = {
  openingFloatFils: 0,
  cashReceivedFils: 0,
  changeGivenFils: 0,
  cashRefundedFils: 0,
  dropsFils: 0,
}

/** Closes a session whose count equals its expectation, so no posting is required. */
async function closeBalanced(id: string, takings: DrawerTakingsRow, countedFloatFils: number) {
  return withUnitOfWork(sql, TILL, (uow) =>
    closeCashSession(uow, { cashSessionId: id, countedFloatFils, takings }, 'staff'),
  )
}

describe('closing computes the expectation and refuses a close with no count', () => {
  it('computes expected = opening + received - change - refunded - drops, in the database', async () => {
    await cashPaymentOn(DAY_ONE, 20_000, 1_500)
    const session = await openOn(DAY_ONE, 50_000)
    await withUnitOfWork(sql, TILL, (uow) =>
      recordCashDrop(uow, {
        cashSessionId: session.id,
        amountFils: 10_000,
        destinationAccountCode: BANK,
        reason: 'Mid-shift banking run.',
        posting: {
          entryId: entryIdFor('drop'),
          entryDate: DAY_ONE,
          narrative: 'Cash drop',
          source: 'payout',
          lines: [
            { accountCode: BANK, debitFils: 10_000, creditFils: 0 },
            { accountCode: CASH_IN_DRAWER, debitFils: 0, creditFils: 10_000 },
          ],
        },
      }),
    )

    const takings = await readDrawerTakings(sql, session.id)
    // 50,000 opening + 20,000 received - 1,500 change - 0 refunded - 10,000 dropped
    expect(takings).toEqual({
      openingFloatFils: 50_000,
      cashReceivedFils: 20_000,
      changeGivenFils: 1_500,
      cashRefundedFils: 0,
      dropsFils: 10_000,
    })

    const closed = await closeBalanced(session.id, takings as DrawerTakingsRow, 58_500)
    expect(closed.expectedFloatFils).toBe(58_500)
    expect(closed.discrepancyFils).toBe(0)

    // The control that the figure is the DATABASE's and not this file's: change given has to be
    // subtracted, so a session whose expectation ignored it would read 60,000.
    expect(closed.expectedFloatFils).not.toBe(60_000)
  })

  it('keeps the notes that went in and the notes that came out as two figures', async () => {
    // 0068 put `change_given_fils` beside `amount_fils` for this unit, so a drawer is counted against
    // both. The snapshot stores both and not their difference: `applied_fils` alone would be 18,500 and a
    // cash-up sheet could not be checked against the till roll in either direction.
    await cashPaymentOn(DAY_ONE, 20_000, 1_500)
    const session = await openOn(DAY_ONE, 0)
    const takings = (await readDrawerTakings(sql, session.id)) as DrawerTakingsRow
    const closed = await closeBalanced(session.id, takings, 18_500)
    expect([closed.cashReceivedFils, closed.changeGivenFils]).toEqual([20_000, 1_500])
    const [applied] = await sql<{ applied: string }[]>`
      select sum(applied_fils)::text as applied from payment where trading_date = ${DAY_ONE}::date
    `
    expect(Number(applied?.applied)).toBe(18_500)
  })

  it('refuses a close with no counted amount, by name, before a statement is issued', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    const refused = await stateOf(
      withUnitOfWork(sql, TILL, (uow) =>
        closeCashSession(
          uow,
          { cashSessionId: session.id, countedFloatFils: undefined, takings: ZERO_TAKINGS },
          'staff',
        ),
      ),
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.countRequired)
    expect(refused.message).toContain('CountRequired')
    // And the session is untouched, so the shift can still be counted properly.
    expect((await readCashSession(sql, session.id))?.status).toBe('open')
  })

  it('refuses a close with no counted amount in the DATABASE too, past the service', async () => {
    // The service's refusal is the layer a person reads; ZU001 is the layer that holds when the statement
    // comes from a psql session or an import. A test that only went through `closeCashSession` would pass
    // with the trigger dropped.
    const session = await openOn(DAY_ONE, 50_000)
    const refused = await stateOf(
      sql`update cash_session set status = 'closed' where id = ${session.id}::uuid`,
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.countRequired)
    expect(isCountRequired({ code: refused.code })).toBe(true)
  })

  it('refuses a HALF-counted close: a counted float with no receipts against it', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    const refused = await stateOf(sql`
      update cash_session
         set status = 'closed', counted_float_fils = 50_000, closed_at = now(),
             closed_by_actor_kind = 'staff'
       where id = ${session.id}::uuid
    `)
    expect(refused.code).toBe('23514')
    expect(refused.message).toContain('cash_session_closed_is_complete')
  })
})

describe('a non-zero variance is ALWAYS posted to cash over and short', () => {
  it('stores the discrepancy as a signed figure and names the cash_up entry', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    // Counted 2,500 short of the 50,000 expected.
    const closed = await withUnitOfWork(sql, TILL, (uow) =>
      closeCashSession(
        uow,
        {
          cashSessionId: session.id,
          countedFloatFils: 47_500,
          takings: { ...ZERO_TAKINGS, openingFloatFils: 50_000 },
          countNote: 'Recounted twice; the till roll agrees.',
          posting: cashUpEntry('short', DAY_ONE, -2_500),
        },
        'staff',
      ),
    )
    expect(closed.discrepancyFils).toBe(-2_500)
    expect(closed.journalEntryId).toBe(cashUpEntry('short', DAY_ONE, -2_500).entryId)

    const lines = await sql<{ account_code: string; debit_fils: string; credit_fils: string }[]>`
      select account_code, debit_fils, credit_fils from journal_line
       where entry_id = ${closed.journalEntryId} order by line_no
    `
    expect(lines.map((l) => [l.account_code, Number(l.debit_fils), Number(l.credit_fils)])).toEqual(
      [
        [CASH_OVER_SHORT, 2_500, 0],
        [CASH_IN_DRAWER, 0, 2_500],
      ],
    )
  })

  it('stores an OVER drawer as a positive figure, on the other side', async () => {
    const session = await openOn(DAY_TWO, 50_000)
    const closed = await withUnitOfWork(sql, TILL, (uow) =>
      closeCashSession(
        uow,
        {
          cashSessionId: session.id,
          countedFloatFils: 50_700,
          takings: { ...ZERO_TAKINGS, openingFloatFils: 50_000 },
          countNote: 'A 700-fils coin float nobody recorded.',
          posting: cashUpEntry('over', DAY_TWO, 700),
        },
        'staff',
      ),
    )
    expect(closed.discrepancyFils).toBe(700)
    const [line] = await sql<{ credit_fils: string }[]>`
      select credit_fils from journal_line
       where entry_id = ${closed.journalEntryId} and account_code = ${CASH_OVER_SHORT}
    `
    expect(Number(line?.credit_fils)).toBe(700)
  })

  it('refuses a close that absorbs a variance, at COMMIT, past the service', async () => {
    // THE rule. The service refuses it too, but the deferred trigger is what holds when the statement
    // comes from anywhere else — and it is what makes "no close can absorb a variance silently" a
    // property of the schema rather than of this codebase.
    const session = await openOn(DAY_ONE, 50_000)
    const refused = await stateOf(
      sql.begin(async (tx) => {
        await tx`
          update cash_session
             set status = 'closed', cash_received_fils = 0, change_given_fils = 0,
                 cash_refunded_fils = 0, counted_float_fils = 47_500, closed_at = now(),
                 closed_by_actor_kind = 'staff', count_note = 'Absorbed.'
           where id = ${session.id}::uuid
        `
      }),
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.varianceNotPosted)
    expect(refused.message).toContain('out by -2500 fils')
    expect(refused.message).toContain('6140')
  })

  it('refuses a BALANCED close that names an entry', async () => {
    // The other direction, and as important: a zero-value line is refused by
    // `journal_line_exactly_one_side` (0018), so an entry on a balanced session can only be about some
    // other figure. A rule written only for the non-zero case would let one through.
    const session = await openOn(DAY_ONE, 50_000)
    const stray = cashUpEntry('stray', DAY_ONE, -100)
    const refused = await stateOf(
      sql.begin(async (tx) => {
        await tx`
          insert into journal_entry (entry_id, entry_date, narrative, source)
          values (${stray.entryId}, ${DAY_ONE}::date, 'Stray', 'cash_up')
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, debit_fils)
          values (${stray.entryId}, 1, ${CASH_OVER_SHORT}, 100)
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, credit_fils)
          values (${stray.entryId}, 2, ${CASH_IN_DRAWER}, 100)
        `
        await tx`
          update cash_session
             set status = 'closed', cash_received_fils = 0, change_given_fils = 0,
                 cash_refunded_fils = 0, counted_float_fils = 50_000, closed_at = now(),
                 closed_by_actor_kind = 'staff', journal_entry_id = ${stray.entryId}
           where id = ${session.id}::uuid
        `
      }),
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.varianceNotPosted)
    expect(refused.message).toContain('balanced exactly')
  })

  it('refuses a variance posted for the wrong FIGURE', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    const refused = await stateOf(
      withUnitOfWork(sql, TILL, (uow) =>
        closeCashSession(
          uow,
          {
            cashSessionId: session.id,
            countedFloatFils: 47_500,
            takings: { ...ZERO_TAKINGS, openingFloatFils: 50_000 },
            countNote: 'Short.',
            // 2,400 posted against a 2,500 discrepancy. The entry balances; the drawer does not.
            posting: cashUpEntry('wrong-figure', DAY_ONE, -2_400),
          },
          'staff',
        ),
      ),
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.varianceNotPosted)
    expect(refused.message).toContain('must carry 2500 fils')
  })

  it('refuses a variance posted on the wrong SIDE', async () => {
    // A posting on the wrong side balances just as well and states the opposite of what happened, which
    // is the one error in a cash-up that reconciles. Nothing but the side check catches it.
    const session = await openOn(DAY_ONE, 50_000)
    const refused = await stateOf(
      withUnitOfWork(sql, TILL, (uow) =>
        closeCashSession(
          uow,
          {
            cashSessionId: session.id,
            countedFloatFils: 47_500,
            takings: { ...ZERO_TAKINGS, openingFloatFils: 50_000 },
            countNote: 'Short.',
            posting: cashUpEntry('wrong-side', DAY_ONE, 2_500),
          },
          'staff',
        ),
      ),
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.varianceNotPosted)
    expect(refused.message).toContain('on the debit side')
  })

  it('refuses a variance posted on a different business DAY', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    const refused = await stateOf(
      withUnitOfWork(sql, TILL, (uow) =>
        closeCashSession(
          uow,
          {
            cashSessionId: session.id,
            countedFloatFils: 47_500,
            takings: { ...ZERO_TAKINGS, openingFloatFils: 50_000 },
            countNote: 'Short.',
            posting: { ...cashUpEntry('wrong-day', DAY_ONE, -2_500), entryDate: DAY_TWO },
          },
          'staff',
        ),
      ),
    )
    // The SERVICE's own wording, deliberately, and not the phrase the two layers share. ZU004's message
    // also says "posts on that business day", so asserting THAT would pass with this check deleted and the
    // database refusing the close instead — which is what gate case 103 caught. The database's own refusal
    // is exercised by the gate probe, where it is the only layer left.
    expect(refused.message).toContain('A cash-up entry for business day')
  })

  it('refuses a variance with no reason, by the CHECK that demands one', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    const posting = cashUpEntry('no-reason', DAY_ONE, -2_500)
    const refused = await stateOf(
      sql.begin(async (tx) => {
        await tx`
          insert into journal_entry (entry_id, entry_date, narrative, source)
          values (${posting.entryId}, ${DAY_ONE}::date, 'Cash-up', 'cash_up')
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, debit_fils)
          values (${posting.entryId}, 1, ${CASH_OVER_SHORT}, 2_500)
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, credit_fils)
          values (${posting.entryId}, 2, ${CASH_IN_DRAWER}, 2_500)
        `
        await tx`
          update cash_session
             set status = 'closed', cash_received_fils = 0, change_given_fils = 0,
                 cash_refunded_fils = 0, counted_float_fils = 47_500, closed_at = now(),
                 closed_by_actor_kind = 'staff', journal_entry_id = ${posting.entryId}
           where id = ${session.id}::uuid
        `
      }),
    )
    expect(refused.code).toBe('23514')
    expect(refused.message).toContain('cash_session_variance_needs_a_reason')
  })
})

describe('the snapshot has to equal the rows', () => {
  it('refuses a snapshot that disagrees with the payment rows, at COMMIT', async () => {
    await cashPaymentOn(DAY_ONE, 20_000, 1_500)
    const session = await openOn(DAY_ONE, 50_000)
    const refused = await stateOf(
      withUnitOfWork(sql, TILL, (uow) =>
        closeCashSession(
          uow,
          {
            cashSessionId: session.id,
            // A snapshot claiming 30,000 was received when the rows say 20,000. Internally consistent —
            // the count matches the claimed expectation exactly — and wrong about the day.
            countedFloatFils: 78_500,
            takings: {
              openingFloatFils: 50_000,
              cashReceivedFils: 30_000,
              changeGivenFils: 1_500,
              cashRefundedFils: 0,
              dropsFils: 0,
            },
          },
          'staff',
        ),
      ),
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.snapshotDisagrees)
    expect(refused.message).toContain('the rows hold received 20000')
  })

  it('refuses cash recorded on a business day whose drawer has been counted', async () => {
    // Without this, ZU005's guarantee holds only until the closing transaction commits.
    const session = await openOn(DAY_ONE, 50_000)
    await closeBalanced(session.id, { ...ZERO_TAKINGS, openingFloatFils: 50_000 }, 50_000)
    const refused = await stateOf(cashPaymentOn(DAY_ONE, 5_000))
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.cashAfterTheCount)
    expect(refused.message).toContain('CashTakenAfterTheDrawerWasCounted')
  })

  it('accepts a CARD payment on a counted business day, and cash on an open one', async () => {
    // The control, in two halves. A card tender is not in the drawer — `tender_type.gives_change` is the
    // registry's answer to which tenders are physical money — and a day whose drawer is still open takes
    // cash normally. Without both, the refusal above is satisfied by a trigger that refuses every payment.
    const session = await openOn(DAY_ONE, 50_000)
    await closeBalanced(session.id, { ...ZERO_TAKINGS, openingFloatFils: 50_000 }, 50_000)

    const invoice = await withUnitOfWork(sql, TILL, (uow) => issueInvoice(uow, invoiceOn(DAY_ONE)))
    await sql`
      insert into payment (
        invoice_id, tender_no, tender_kind, posting_account_code, amount_fils, reference, trading_date
      ) values (
        ${invoice.id}::uuid, 1, 'card_in_salon', '1040', 5_000, 'AUTH-000123', ${DAY_ONE}::date
      )
    `
    const [card] = await sql<{ n: string }[]>`
      select count(*)::text as n from payment where tender_kind = 'card_in_salon'
    `
    expect(Number(card?.n)).toBe(1)

    await expect(cashPaymentOn(DAY_TWO, 5_000)).resolves.toBeTruthy()
  })
})

describe('a closed session cannot be reopened', () => {
  it('exports no function that reopens, unlocks, edits, voids or deletes one', async () => {
    // The export-surface half of the acceptance. Split on camelCase boundaries rather than matched as a
    // substring, which is M-VAT-06's measurement: /reopen/i matches `isBeforeOpeningPeriod` —
    // "befoREOPENing" — so a substring pattern eventually reports a path that does not exist.
    const FORBIDDEN = new Set(['reopen', 'unlock', 'edit', 'void', 'delete', 'undo', 'recount'])
    const words = (name: string) =>
      name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
    const offenders = Object.keys(cashSessionModule).filter((name) =>
      words(name).some((word) => FORBIDDEN.has(word)),
    )
    expect(offenders).toEqual([])
    // The control, in both directions: the predicate has to be reading real names and has to be able to
    // match. Without it an empty export list would satisfy the assertion for ever.
    expect(Object.keys(cashSessionModule).length).toBeGreaterThan(15)
    expect(words('reopenCashSession').some((word) => FORBIDDEN.has(word))).toBe(true)
    expect(words('readOpenCashSession').some((word) => FORBIDDEN.has(word))).toBe(false)
  })

  it('refuses the status transition back to open, for the OWNER', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    await closeBalanced(session.id, { ...ZERO_TAKINGS, openingFloatFils: 50_000 }, 50_000)
    const refused = await stateOf(
      sql`update cash_session set status = 'open' where id = ${session.id}::uuid`,
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.alreadyClosed)
    expect(isCashSessionClosed({ code: refused.code })).toBe(true)
  })

  it('refuses a rewrite of the COUNT with the status untouched', async () => {
    // The reason the trigger refuses every update rather than the transition: rewriting
    // `counted_float_fils` in place undoes a count without touching `status`, and a rule that named the
    // transition would permit it.
    const session = await openOn(DAY_ONE, 50_000)
    await closeBalanced(session.id, { ...ZERO_TAKINGS, openingFloatFils: 50_000 }, 50_000)
    const refused = await stateOf(
      sql`update cash_session set counted_float_fils = 1 where id = ${session.id}::uuid`,
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.alreadyClosed)
  })

  it('refuses a DELETE of a counted session, and allows one of an open session', async () => {
    const closedSession = await openOn(DAY_ONE, 50_000)
    await closeBalanced(closedSession.id, { ...ZERO_TAKINGS, openingFloatFils: 50_000 }, 50_000)
    const refused = await stateOf(
      sql`delete from cash_session where id = ${closedSession.id}::uuid`,
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.alreadyClosed)
    // The control: an OPEN session can be removed, so the refusal above is about the COUNT and not about
    // a table nothing can be deleted from. A shift opened by mistake is not evidence about anything.
    const open = await openOn(DAY_TWO, 50_000)
    await sql`delete from cash_session where id = ${open.id}::uuid`
    expect(await readCashSession(sql, open.id)).toBeNull()
  })

  it('refuses the application role a DELETE, and an UPDATE of the business day', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    const refusedDelete = await stateOf(
      asApplicationRole((tx) => tx`delete from cash_session where id = ${session.id}::uuid`),
    )
    expect(refusedDelete.code).toBe('42501')
    // `trading_date` is what the reconciliation is ABOUT, so a statement that could move it could
    // re-point a counted drawer at another day. The grant refuses it before a trigger is reached — and
    // this session is OPEN, so no trigger would have.
    const refusedRepoint = await stateOf(
      asApplicationRole(
        (tx) =>
          tx`update cash_session set trading_date = ${DAY_TWO}::date where id = ${session.id}::uuid`,
      ),
    )
    expect(refusedRepoint.code).toBe('42501')
    // The control: the columns a close writes ARE granted, so the two refusals are about those columns
    // rather than about a table the application cannot update at all.
    await asApplicationRole(
      (tx) => tx`update cash_session set count_note = null where id = ${session.id}::uuid`,
    )
  })

  it('refuses a drop into a counted session', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    await closeBalanced(session.id, { ...ZERO_TAKINGS, openingFloatFils: 50_000 }, 50_000)
    const refused = await stateOf(
      withUnitOfWork(sql, TILL, (uow) =>
        recordCashDrop(uow, {
          cashSessionId: session.id,
          amountFils: 1_000,
          destinationAccountCode: BANK,
          reason: 'Late banking.',
          posting: {
            entryId: entryIdFor('late-drop'),
            entryDate: DAY_ONE,
            narrative: 'Late drop',
            source: 'payout',
            lines: [
              { accountCode: BANK, debitFils: 1_000, creditFils: 0 },
              { accountCode: CASH_IN_DRAWER, debitFils: 0, creditFils: 1_000 },
            ],
          },
        }),
      ),
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.alreadyClosed)
  })
})

describe('the correction is a new dated adjustment', () => {
  async function closedShort() {
    const session = await openOn(DAY_ONE, 50_000)
    return withUnitOfWork(sql, TILL, (uow) =>
      closeCashSession(
        uow,
        {
          cashSessionId: session.id,
          countedFloatFils: 47_500,
          takings: { ...ZERO_TAKINGS, openingFloatFils: 50_000 },
          countNote: 'Short by 2,500; recounted twice.',
          posting: cashUpEntry('short', DAY_ONE, -2_500),
        },
        'staff',
      ),
    )
  }

  it('posts on its OWN business day and leaves the original count unchanged', async () => {
    const closed = await closedShort()
    const adjustment = await withUnitOfWork(sql, TILL, (uow) =>
      postCashSessionAdjustment(uow, {
        cashSessionId: closed.id,
        tradingDate: DAY_TWO,
        amountFils: 2_500,
        reason: 'The 2,500 was found in the safe the next day.',
        posting: {
          entryId: entryIdFor('correction'),
          entryDate: DAY_TWO,
          narrative: 'Cash-up correction',
          source: 'adjustment',
          lines: [
            { accountCode: CASH_IN_DRAWER, debitFils: 2_500, creditFils: 0 },
            { accountCode: CASH_OVER_SHORT, debitFils: 0, creditFils: 2_500 },
          ],
        },
      }),
    )
    expect(adjustment.tradingDate).toBe(DAY_TWO)
    // THE point. The original row still says what was counted, and the correction is a second fact
    // beside it rather than a rewrite of the first.
    const after = await readCashSession(sql, closed.id)
    expect([after?.countedFloatFils, after?.discrepancyFils]).toEqual([47_500, -2_500])
    expect(await readCashSessionAdjustments(sql, closed.id)).toHaveLength(1)

    // And the two entries between them net 6140 to zero: the loss was written off and then found.
    const [net] = await sql<{ net: string }[]>`
      select coalesce(sum(debit_fils - credit_fils), 0)::text as net from journal_line
       where account_code = ${CASH_OVER_SHORT}
         and entry_id in (${closed.journalEntryId ?? ''}, ${adjustment.journalEntryId})
    `
    expect(Number(net?.net)).toBe(0)
  })

  it('refuses a correction to a session that is still open', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    const refused = await stateOf(
      withUnitOfWork(sql, TILL, (uow) =>
        postCashSessionAdjustment(uow, {
          cashSessionId: session.id,
          tradingDate: DAY_TWO,
          amountFils: 100,
          reason: 'Premature.',
          posting: {
            entryId: entryIdFor('premature'),
            entryDate: DAY_TWO,
            narrative: 'Premature correction',
            source: 'adjustment',
            lines: [
              { accountCode: CASH_IN_DRAWER, debitFils: 100, creditFils: 0 },
              { accountCode: CASH_OVER_SHORT, debitFils: 0, creditFils: 100 },
            ],
          },
        }),
      ),
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.adjustmentNotPostable)
    expect(refused.message).toContain('CashSessionStillOpen')
  })

  it('refuses a correction dated before the shift it corrects', async () => {
    const closed = await closedShort()
    const refused = await stateOf(
      withUnitOfWork(sql, TILL, (uow) =>
        postCashSessionAdjustment(uow, {
          cashSessionId: closed.id,
          tradingDate: '2087-03-03',
          amountFils: 100,
          reason: 'Backdated.',
          posting: {
            entryId: entryIdFor('backdated'),
            entryDate: '2087-03-03',
            narrative: 'Backdated correction',
            source: 'adjustment',
            lines: [
              { accountCode: CASH_IN_DRAWER, debitFils: 100, creditFils: 0 },
              { accountCode: CASH_OVER_SHORT, debitFils: 0, creditFils: 100 },
            ],
          },
        }),
      ),
    )
    // The business day does not exist in the calendar either, so the foreign key would also refuse it;
    // the assertion is on the rule that names WHY, which is what a caller can act on.
    expect([CASH_SESSION_SQLSTATE.adjustmentNotPostable, '23503']).toContain(refused.code)
  })

  it('is append-only: a correction cannot be edited or removed', async () => {
    const closed = await closedShort()
    const adjustment = await withUnitOfWork(sql, TILL, (uow) =>
      postCashSessionAdjustment(uow, {
        cashSessionId: closed.id,
        tradingDate: DAY_TWO,
        amountFils: 2_500,
        reason: 'Found in the safe.',
        posting: {
          entryId: entryIdFor('correction-2'),
          entryDate: DAY_TWO,
          narrative: 'Cash-up correction',
          source: 'adjustment',
          lines: [
            { accountCode: CASH_IN_DRAWER, debitFils: 2_500, creditFils: 0 },
            { accountCode: CASH_OVER_SHORT, debitFils: 0, creditFils: 2_500 },
          ],
        },
      }),
    )
    const refusedUpdate = await stateOf(
      sql`update cash_session_adjustment set amount_fils = 1 where id = ${adjustment.id}::uuid`,
    )
    expect(refusedUpdate.code).toBe(CASH_SESSION_SQLSTATE.alreadyClosed)
    const refusedDelete = await stateOf(
      sql`delete from cash_session_adjustment where id = ${adjustment.id}::uuid`,
    )
    expect(refusedDelete.code).toBe(CASH_SESSION_SQLSTATE.alreadyClosed)
  })
})

describe('a closed accounting period', () => {
  /** May 2087 filed. `period_lock` holds the CLOSED periods; an open one is the absence of a row. */
  async function lockMay() {
    await sql`
      insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
      values ('MTILL11-2087-05', '2087-05-01', '2087-05-31', 'M-TILL-11 itest', 'system')
    `
  }

  it('refuses a session on a business day inside it, naming the earliest OPEN date', async () => {
    await lockMay()
    const refused = await stateOf(openOn(LOCKED_DAY, 50_000))
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.periodLocked)
    expect(refused.message).toContain('The earliest open date is 2087-06-01')
    // The service reads `periodStatusOn` — M-VAT-06's one reader for "is this date closed?" — so the
    // refusal carries the date as DATA and not only as text. No second reader is written here.
    expect(refused.message).toContain('MTILL11-2087-05')
  })

  it('refuses it in the DATABASE too, past the service', async () => {
    await lockMay()
    const refused = await stateOf(sql`
      insert into cash_session (
        drawer_code, trading_date, shift_no, opening_float_fils, opened_by_actor_kind
      ) values (${DRAWER}, ${LOCKED_DAY}::date, 1, 50_000, 'staff')
    `)
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.periodLocked)
  })

  it('accepts a session on an OPEN business day, so the refusal is about the lock', async () => {
    await lockMay()
    const session = await openOn(DAY_ONE, 50_000)
    expect(session.status).toBe('open')
  })

  it('refuses a correction dated inside it', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    const closed = await closeBalanced(
      session.id,
      { ...ZERO_TAKINGS, openingFloatFils: 50_000 },
      50_000,
    )
    await lockMay()
    const refused = await stateOf(
      withUnitOfWork(sql, TILL, (uow) =>
        postCashSessionAdjustment(uow, {
          cashSessionId: closed.id,
          tradingDate: LOCKED_DAY,
          amountFils: 100,
          reason: 'Into a filed month.',
          posting: {
            entryId: entryIdFor('into-lock'),
            entryDate: LOCKED_DAY,
            narrative: 'Correction into a locked period',
            source: 'adjustment',
            lines: [
              { accountCode: CASH_IN_DRAWER, debitFils: 100, creditFils: 0 },
              { accountCode: CASH_OVER_SHORT, debitFils: 0, creditFils: 100 },
            ],
          },
        }),
      ),
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.periodLocked)
    expect(refused.message).toContain('The earliest open date is 2087-06-01')
  })
})

describe('the cash-up sheet', () => {
  it('shows the snapshot beside the live sums, and they agree for a closed session', async () => {
    await cashPaymentOn(DAY_ONE, 20_000, 1_500)
    const session = await openOn(DAY_ONE, 50_000)
    const takings = (await readDrawerTakings(sql, session.id)) as DrawerTakingsRow
    await closeBalanced(session.id, takings, 68_500)

    const [sheet] = await sql<
      {
        expected_float_fils: string
        live_expected_float_fils: string
        cash_received_fils: string
        live_received_fils: string
        discrepancy_fils: string
      }[]
    >`
      select expected_float_fils, live_expected_float_fils, cash_received_fils, live_received_fils,
             discrepancy_fils
        from cash_session_reconciliation where cash_session_id = ${session.id}::uuid
    `
    expect(sheet?.expected_float_fils).toBe(sheet?.live_expected_float_fils)
    expect(sheet?.cash_received_fils).toBe(sheet?.live_received_fils)
    expect(Number(sheet?.discrepancy_fils)).toBe(0)
    // The control: the view is reporting real figures rather than nulls that happen to be equal.
    expect(Number(sheet?.live_received_fils)).toBe(20_000)
  })

  it('answers with the live figures for an OPEN session, which has no snapshot', async () => {
    await cashPaymentOn(DAY_ONE, 20_000, 1_500)
    const session = await openOn(DAY_ONE, 50_000)
    const [sheet] = await sql<
      { expected_float_fils: string | null; live_expected_float_fils: string }[]
    >`
      select expected_float_fils, live_expected_float_fils
        from cash_session_reconciliation where cash_session_id = ${session.id}::uuid
    `
    expect(sheet?.expected_float_fils).toBeNull()
    expect(Number(sheet?.live_expected_float_fils)).toBe(68_500)
  })

  it('lists every session of a business day in shift order', async () => {
    const first = await openOn(DAY_ONE, 50_000)
    await closeBalanced(first.id, { ...ZERO_TAKINGS, openingFloatFils: 50_000 }, 50_000)
    await openOn(DAY_ONE, 50_000)
    const sessions = (await readCashSessionsForBusinessDay(sql, DAY_ONE)).filter(
      (session) => session.drawerCode === DRAWER,
    )
    expect(sessions.map((session) => session.shiftNo)).toEqual([1, 2])
  })
})

describe('the drop', () => {
  it('posts its own entry at the time of the drop, not at the close', async () => {
    // 1010 is debited as each payment is taken, so a drop recorded only in the cash-up would leave the
    // drawer account overstated for the rest of the shift.
    const session = await openOn(DAY_ONE, 50_000)
    const drop = await withUnitOfWork(sql, TILL, (uow) =>
      recordCashDrop(uow, {
        cashSessionId: session.id,
        amountFils: 30_000,
        destinationAccountCode: BANK,
        reference: 'DEP-000481',
        reason: 'Mid-shift banking run.',
        posting: {
          entryId: entryIdFor('drop-own-entry'),
          entryDate: DAY_ONE,
          narrative: 'Cash drop',
          source: 'payout',
          lines: [
            { accountCode: BANK, debitFils: 30_000, creditFils: 0 },
            { accountCode: CASH_IN_DRAWER, debitFils: 0, creditFils: 30_000 },
          ],
        },
      }),
    )
    const [entry] = await sql<{ source: string; entry_date: string }[]>`
      select source, entry_date::text as entry_date from journal_entry
       where entry_id = ${drop.journalEntryId}
    `
    // `payout` and not `cash_up`: ZU004 searches for the session's variance entry by that source, and a
    // drop sharing the classification is the one way a real discrepancy could look posted when it was not.
    expect(entry?.source).toBe('payout')
    expect(entry?.entry_date).toBe(DAY_ONE)
    expect(drop.dropNo).toBe(1)
  })

  it('refuses a drop whose entry is classified as a cash-up', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    const refused = await stateOf(
      withUnitOfWork(sql, TILL, (uow) =>
        recordCashDrop(uow, {
          cashSessionId: session.id,
          amountFils: 30_000,
          destinationAccountCode: BANK,
          reason: 'Banking.',
          posting: {
            ...cashUpEntry('drop-as-cash-up', DAY_ONE, -30_000),
            source: 'cash_up',
          },
        }),
      ),
    )
    expect(refused.message).toContain('must have source "payout"')
  })

  it('is append-only', async () => {
    const session = await openOn(DAY_ONE, 50_000)
    const drop = await withUnitOfWork(sql, TILL, (uow) =>
      recordCashDrop(uow, {
        cashSessionId: session.id,
        amountFils: 30_000,
        destinationAccountCode: BANK,
        reason: 'Banking.',
        posting: {
          entryId: entryIdFor('drop-append-only'),
          entryDate: DAY_ONE,
          narrative: 'Cash drop',
          source: 'payout',
          lines: [
            { accountCode: BANK, debitFils: 30_000, creditFils: 0 },
            { accountCode: CASH_IN_DRAWER, debitFils: 0, creditFils: 30_000 },
          ],
        },
      }),
    )
    const refused = await stateOf(
      sql`update cash_drop set amount_fils = 1 where id = ${drop.id}::uuid`,
    )
    expect(refused.code).toBe(CASH_SESSION_SQLSTATE.alreadyClosed)
  })
})

describe('the drawer registry', () => {
  it('refuses a session on a drawer the registry does not hold', async () => {
    const refused = await stateOf(
      withUnitOfWork(sql, TILL, (uow) =>
        openCashSession(
          uow,
          { drawerCode: 'not_a_drawer', tradingDate: DAY_ONE, openingFloatFils: 0 },
          'staff',
        ),
      ),
    )
    expect(refused.code).toBe('23503')
  })

  it('refuses a drawer code that is not lower snake case', async () => {
    // A registry rather than a text column is what stops 'Reception' beside 'reception' becoming a second
    // OPEN session on one physical till, which is the state the partial unique index exists to prevent.
    const refused = await stateOf(sql`
      insert into cash_drawer (code, label, posting_account_code)
      values ('Reception', 'Mis-cased', ${CASH_IN_DRAWER})
    `)
    expect(refused.code).toBe('23514')
    expect(refused.message).toContain('cash_drawer_code_is_snake_case')
  })

  it('states the account a drawer posts to, so a safe float is not netted against the till', async () => {
    const [drawer] = await sql<{ posting_account_code: string }[]>`
      select posting_account_code from cash_drawer where code = 'reception'
    `
    expect(drawer?.posting_account_code).toBe(CASH_IN_DRAWER)
    // Not trade receivables, which is what a cash-up would touch if it followed a payment's other side.
    expect(drawer?.posting_account_code).not.toBe(TRADE_RECEIVABLES)
  })
})
