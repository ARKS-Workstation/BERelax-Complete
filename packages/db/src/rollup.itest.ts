import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from './audit.ts'
import { createConnection, type Sql } from './connection.ts'
import { publishEvent } from './outbox.ts'
import {
  internalPaidConversions,
  ROLLUP_SQLSTATE,
  rollUpTradingDate,
  rollupDigest,
  rollupRefusalOf,
} from './repositories/analytics-rollup.ts'
import { issueInvoice } from './repositories/invoice.ts'
import type { UnitOfWork } from './tx.ts'

/**
 * Migration 0150 and `repositories/analytics-rollup.ts` — the two refusals, the gap counts, the
 * recompute's idempotence, the business-day filing and the revenue reconciliation (A-FIRST-09), proved
 * against a real database.
 *
 * ## Why this file and not one
 *
 * The funnel's own arithmetic — the eight counts, the conversion rate, the no-show exclusion and the bot
 * parameter — needs `COLLECTED_EVENT_FUNNEL` and `APPOINTMENT_STATUS_FUNNEL` from `@berelax/core`, which
 * `packages/db` may never import (ADR 0001). A copy of either mapping here would be the second statement
 * of the funnel that the whole design exists to prevent, so that half lives beside the pass in
 * `apps/worker/src/jobs/analytics-rollup.itest.ts` — A-MEAS-05's and A-MEAS-07's recorded precedent, for
 * the same reason. What is proved HERE is everything that is a property of the schema and of the
 * statements, which is what this file can assert without knowing what a funnel stage means.
 *
 * ## Why every case runs inside a transaction that is rolled back
 *
 * It writes analytics sessions, invoices and payments. `analytics` grants the application role no DELETE
 * at all (0096) and `invoice` refuses DELETE for every role (ZI003), so truncating their families as the
 * owner is the only legal removal — and that statement is wide enough to take another suite's rows with
 * it, which is why every file that does it carries a declaration in `suite-table-declarations.ts`. A
 * rollback removes exactly what this file wrote, which is also what lets it run twice in a row. It is
 * what makes the partition case possible at all: PostgreSQL rolls DDL back, so `drop table` on a real
 * partition is undone when the case returns.
 *
 * ## Why the trading dates are in the PAST and taken from the seeded calendar
 *
 * ZY702 refuses a rollup for a day that has not closed. Every other fixture suite in this repository
 * books into 2081-2099 — years chosen so no two suites collide — and not one of those days has closed,
 * so a rollup written against one would be refused by the rule this file is here to prove. The dates are
 * therefore read out of `business_day` by age, which also keeps the raw-partition case inside the window
 * `analytics.ensure_partitions` has created.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

const ROLLBACK = 'A-FIRST-09 rolled this fixture back'

async function rolledBack<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  let carried: T | undefined
  try {
    await sql.begin(async (tx) => {
      carried = await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error
  }
  return carried as T
}

/** postgres.js exposes `savepoint` on a transaction and not on the pool. `merge.itest.ts`'s helper. */
interface Savepointing {
  savepoint<T>(cb: (sp: Sql) => Promise<T>): Promise<T>
}

/**
 * The SQLSTATE a probing statement raised, inside a SAVEPOINT.
 *
 * Without the savepoint the first refusal aborts the transaction and every later statement in the case —
 * including the control that must be ACCEPTED — fails as `25P02`, for a reason that has nothing to do
 * with the rule under test.
 */
async function stateOf(
  tx: Sql,
  body: (sp: Sql) => Promise<unknown>,
): Promise<{ code?: string | undefined; message?: string | undefined }> {
  try {
    await (tx as unknown as Savepointing).savepoint(async (sp) => {
      await body(sp)
    })
    return {}
  } catch (error) {
    const err = error as { code?: string; message?: string }
    return { code: err.code, message: err.message }
  }
}

const ACTOR = {
  kind: 'system' as const,
  id: '55555555-5555-5555-5555-555555555555',
  label: 'Nightly rollups (A-FIRST-09 itest)',
}

const unitOfWork = (tx: Sql): UnitOfWork => ({
  sql: tx,
  audit: new AuditWriter(tx, ACTOR),
  publish: (event) => publishEvent(tx, event),
})

const ISSUER = {
  legalName: 'BE RELAX SPA - L.L.C - O.P.C',
  tradingName: 'BE RELAX - Massage Center and Spa',
  trn: '100000000000003',
  addressSnapshot: '250 Al Meena Street\nTower Block A/B, M-Floor\nAl Zahiyah, Abu Dhabi',
  emirate: 'Abu Dhabi',
} as const

/**
 * The fixture document, in integer fils with the VAT taken at the standard 5%.
 *
 * Written out rather than derived, because `packages/db` may not import `splitGross` — and that is what
 * makes the reconciliation case a real check rather than a tautology: these three numbers are this file's
 * claim, `invoice_totals_reconcile` holds the document to them, and the rollup is then asserted to equal
 * the DOCUMENT's own stored totals to the fils.
 */
const GROSS = 26_250
const NET = 25_000
const VAT = 1_250

/** A seeded trading day that has CLOSED, `ageDays` ago or as near to it as the calendar reaches. */
async function closedTradingDay(
  tx: Sql,
  ageDays: number,
): Promise<{ tradingDate: string; opensAtMs: number; closesAtMs: number }> {
  const [row] = await tx<{ trading_date: string; opens_at: Date; closes_at: Date }[]>`
    select to_char(trading_date, 'YYYY-MM-DD') as trading_date, opens_at, closes_at
      from business_day
     where closes_at < now()
     order by abs(extract(epoch from (closes_at - (now() - make_interval(days => ${ageDays})))))
     limit 1
  `
  if (row === undefined) {
    throw new Error(
      'business_day holds no day that has closed, so nothing in this file could be rolled up — ZY702 ' +
        'refuses an open day. Run `pnpm seed`.',
    )
  }
  /*
   * The raw partitions for that month, created here.
   *
   * `analytics.ensure_partitions` keeps three months AHEAD of the clock (0096), so a PAST month has none
   * on a database built today — and ZY702 requires a past day, so every case in this file needs this.
   * Without it the first event insert routes to the guarded default partition and is refused by ZY061,
   * which is that guard working correctly about something no case here is testing. The DDL is rolled back
   * with the transaction.
   */
  await tx`select analytics.ensure_partitions(date_trunc('month', ${row.trading_date}::date)::date, 1)`
  return {
    tradingDate: row.trading_date,
    opensAtMs: row.opens_at.getTime(),
    closesAtMs: row.closes_at.getTime(),
  }
}

let probe = 0
function probePhone(): string {
  probe += 1
  return `+971593${String(100_000 + probe)}`
}

interface Session {
  readonly sessionId: string
  readonly visitorId: string
}

/** One consented visitor and one session on `tradingDate`, with the origination it resolved to. */
async function session(
  tx: Sql,
  input: {
    readonly tradingDate: string
    readonly startedAtMs: number
    readonly source: string
    readonly bot?: boolean
    readonly basis?: 'trading' | 'before_opening'
  },
): Promise<Session> {
  const [visitor] = await tx<{ visitor_id: string }[]>`
    insert into analytics.visitor (first_seen_at, last_seen_at)
    values (to_timestamp(${input.startedAtMs / 1000}), to_timestamp(${input.startedAtMs / 1000}))
    returning visitor_id::text as visitor_id
  `
  const [row] = await tx<{ session_id: string }[]>`
    insert into analytics.session
      (visitor_id, started_at, last_event_at, trading_date, trading_date_basis, landing_path,
       device_kind, breakpoint, bot, bot_kind)
    values (${visitor?.visitor_id as string}::uuid, to_timestamp(${input.startedAtMs / 1000}),
            to_timestamp(${input.startedAtMs / 1000}), ${input.tradingDate}::date,
            ${input.basis ?? 'trading'}, '/', 'mobile', 'sm', ${input.bot === true},
            ${input.bot === true ? 'declared_crawler' : null})
    returning session_id::text as session_id
  `
  await tx`
    insert into analytics.attribution
      (session_id, basis, source, medium, campaign, resolver_version, resolved_at)
    values (${row?.session_id as string}::uuid, 'utm', ${input.source}, 'cpc', 'spring',
            'origination/1', to_timestamp(${input.startedAtMs / 1000}))
  `
  return { sessionId: row?.session_id as string, visitorId: visitor?.visitor_id as string }
}

/** One page view for a session, carrying the server's own `entry` decision. */
async function pageView(tx: Sql, sessionId: string, atMs: number, entry: boolean): Promise<void> {
  await tx`
    insert into analytics.event
      (session_id, occurred_at, event_name, path, properties, client_event_id)
    values (${sessionId}::uuid, to_timestamp(${atMs / 1000}), 'page_view', '/',
            ${tx.json({ entry })}, ${`probe-${sessionId}-${atMs}`})
  `
}

/** A customer, a booking attributed to `sessionId`, one completed appointment and a settled invoice. */
async function paidBooking(
  tx: Sql,
  input: {
    readonly tradingDate: string
    readonly sessionId: string | null
    readonly source: string
    readonly atMs: number
    readonly settle?: boolean
  },
): Promise<{ bookingId: string; invoiceId: string }> {
  const [variant] = await tx<{ id: string }[]>`
    select v.id from service_variant v join service s on s.id = v.service_id
     where s.archived_at is null order by v.id limit 1
  `
  const [room] = await tx<{ id: string }[]>`select id from rooms order by id limit 1`
  const [staff] = await tx<{ id: string }[]>`
    select id from employee order by staff_reference limit 1
  `
  if (variant === undefined || room === undefined || staff === undefined) {
    throw new Error('run `pnpm seed`: a priced variant, a room and an employee are needed')
  }
  const [customer] = await tx<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${probePhone()}, 'guest_booking')
    returning id::text as id
  `
  const [booking] = await tx<{ id: string }[]>`
    insert into booking (customer_id, source, created_at)
    values (${customer?.id as string}, ${input.sessionId === null ? 'walk_in' : 'online'},
            to_timestamp(${input.atMs / 1000}))
    returning id::text as id
  `
  const bookingId = booking?.id as string
  await tx`
    insert into booking_attribution
      (booking_id, basis, source, medium, campaign, session_reference, how_heard, occurred_at,
       recorded_at)
    values (${bookingId}::uuid,
            ${input.sessionId === null ? 'offline' : 'utm'},
            ${input.sessionId === null ? 'offline' : input.source},
            ${input.sessionId === null ? 'direct' : 'cpc'},
            ${input.sessionId === null ? '' : 'spring'},
            ${input.sessionId}::uuid,
            ${input.sessionId === null ? 'Passing the door' : null},
            to_timestamp(${input.atMs / 1000}), to_timestamp(${input.atMs / 1000}))
  `
  // 45 minutes from the booking instant. Callers space their bookings by two hours, because
  // `appointment_therapist_no_overlap` is an EXCLUSION constraint over one therapist's periods and the
  // seed has one employee this file reaches by `staff_reference` — a fixture that overlapped would fail
  // on a real double-booking rule rather than on anything this file is about.
  const start = new Date(input.atMs).toISOString()
  const end = new Date(input.atMs + 2_700_000).toISOString()
  const [appointment] = await tx<{ id: string }[]>`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes,
       therapist_buffer_minutes)
    values (${bookingId}::uuid, ${input.tradingDate}::date, ${variant.id}, 'solo'::service_shape,
            ${staff.id}, ${room.id}, ${`[${start},${end})`}::tstzrange,
            'completed'::appointment_status, ${GROSS}, ${NET}, ${VAT}, 500, 20, 10)
    returning id::text as id
  `
  const issued = await issueInvoice(unitOfWork(tx), {
    documentKind: 'tax_invoice',
    seriesCode: 'TAX-INV',
    issuer: ISSUER,
    customer: { nameSnapshot: 'Customer 0042' },
    bookingId,
    issueDate: input.tradingDate,
    issueTradingDate: input.tradingDate,
    taxPointDate: input.tradingDate,
    lines: [
      {
        descriptionEn: 'Treatment (rollup fixture)',
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
  })
  await tx`
    insert into invoice_appointment (invoice_id, appointment_id, line_no)
    values (${issued.id}::uuid, ${appointment?.id as string}::uuid, 1)
  `
  if (input.settle !== false) {
    await tx`
      insert into payment (
        invoice_id, tender_no, tender_kind, posting_account_code, amount_fils, trading_date, received_at
      ) values (
        ${issued.id}::uuid, 1, 'cash', '1010', ${GROSS}, ${input.tradingDate}::date,
        to_timestamp(${(input.atMs + 7_200_000) / 1000})
      )
    `
  }
  return { bookingId, invoiceId: issued.id }
}

// ------------------------------------------------------------------------------------------------
// ZY701: a session reaches a funnel step at most once
// ------------------------------------------------------------------------------------------------

describe('a funnel step', () => {
  it('is refused a second time for one session and step, by name (ZY701)', async () => {
    const outcomes = await rolledBack(async (tx) => {
      const day = await closedTradingDay(tx, 2)
      const first = await session(tx, {
        tradingDate: day.tradingDate,
        startedAtMs: day.opensAtMs,
        source: 'google',
      })
      await tx`
        insert into analytics.funnel_step (session_id, step, occurred_at)
        values (${first.sessionId}::uuid, 'booking_created', to_timestamp(${day.opensAtMs / 1000}))
      `
      const second = await stateOf(
        tx,
        (sp) => sp`
        insert into analytics.funnel_step (session_id, step, occurred_at)
        values (${first.sessionId}::uuid, 'booking_created',
                to_timestamp(${(day.opensAtMs + 3_600_000) / 1000}))
      `,
      )
      // Two controls. A DIFFERENT step for the same session is the ordinary case — a journey has eight —
      // and the SAME step for a different session is what the funnel counts.
      const otherStep = await stateOf(
        tx,
        (sp) => sp`
        insert into analytics.funnel_step (session_id, step, occurred_at)
        values (${first.sessionId}::uuid, 'confirmed', to_timestamp(${day.opensAtMs / 1000}))
      `,
      )
      const otherSession = await session(tx, {
        tradingDate: day.tradingDate,
        startedAtMs: day.opensAtMs,
        source: 'bing',
      })
      const otherSessionSameStep = await stateOf(
        tx,
        (sp) => sp`
        insert into analytics.funnel_step (session_id, step, occurred_at)
        values (${otherSession.sessionId}::uuid, 'booking_created',
                to_timestamp(${day.opensAtMs / 1000}))
      `,
      )
      return { second, otherStep, otherSessionSameStep }
    })
    expect(outcomes.second.code).toBe(ROLLUP_SQLSTATE.oneStepPerSession)
    expect(rollupRefusalOf({ code: outcomes.second.code })).toBe('one_step_per_session')
    expect(outcomes.second.message).toContain('count one journey twice')
    expect(outcomes.otherStep.code).toBeUndefined()
    expect(outcomes.otherSessionSameStep.code).toBeUndefined()
  })
})

// ------------------------------------------------------------------------------------------------
// ZY702: a trading day that has not closed may not be rolled up
// ------------------------------------------------------------------------------------------------

describe('a rollup row', () => {
  it('is refused for a trading day that has not closed, by name (ZY702)', async () => {
    const outcomes = await rolledBack(async (tx) => {
      const closed = await closedTradingDay(tx, 2)
      // A day that opens tomorrow and closes the morning after, inserted here rather than looked for:
      // the seeded calendar's future days are what a real pass would meet, and this makes the case
      // independent of how far ahead the seed happens to reach.
      const [open] = await tx<{ trading_date: string }[]>`
        insert into business_day (trading_date, opens_at, closes_at, source)
        values ((now() + interval '1 day')::date,
                ((now() + interval '1 day')::date + time '11:00') at time zone 'Asia/Dubai',
                ((now() + interval '2 days')::date + time '02:00') at time zone 'Asia/Dubai',
                'weekly')
        on conflict (trading_date) do update set source = excluded.source
        returning to_char(trading_date, 'YYYY-MM-DD') as trading_date
      `
      const notClosed = await stateOf(
        tx,
        (sp) => sp`
        insert into analytics.daily_traffic
          (trading_date, source, medium, campaign, device_kind, sessions, visitors, bot_sessions,
           events, gap_sessions, computed_at)
        values (${open?.trading_date as string}::date, 'google', 'cpc', 'spring', 'mobile',
                1, 1, 0, 1, 0, now())
      `,
      )
      // The control: the identical row for a day that HAS closed is accepted, so the refusal is about
      // the calendar and not about anything else on the row.
      const hasClosed = await stateOf(
        tx,
        (sp) => sp`
        insert into analytics.daily_traffic
          (trading_date, source, medium, campaign, device_kind, sessions, visitors, bot_sessions,
           events, gap_sessions, computed_at)
        values (${closed.tradingDate}::date, 'google', 'cpc', 'spring', 'mobile', 1, 1, 0, 1, 0, now())
      `,
      )
      // And the same rule on the funnel and the revenue tables, because three narrow triggers fail by
      // name where one shared claim would leave two of the three unproven.
      const funnelOpen = await stateOf(
        tx,
        (sp) => sp`
        insert into analytics.daily_funnel
          (trading_date, step, source, medium, campaign, entered, excluded, gap_entered, computed_at)
        values (${open?.trading_date as string}::date, 'landing', 'google', 'cpc', 'spring',
                1, 0, 0, now())
      `,
      )
      const revenueOpen = await stateOf(
        tx,
        (sp) => sp`
        insert into analytics.daily_source_revenue
          (trading_date, source, medium, campaign, paid_invoices, gross_fils, vat_fils, net_fils,
           computed_at)
        values (${open?.trading_date as string}::date, 'google', 'cpc', 'spring', 1,
                ${GROSS}, ${VAT}, ${NET}, now())
      `,
      )
      return { notClosed, hasClosed, funnelOpen, revenueOpen }
    })
    expect(outcomes.notClosed.code).toBe(ROLLUP_SQLSTATE.dayHasNotClosed)
    expect(rollupRefusalOf({ code: outcomes.notClosed.code })).toBe('day_has_not_closed')
    expect(outcomes.notClosed.message).toContain("half a day's trade")
    expect(outcomes.funnelOpen.code).toBe(ROLLUP_SQLSTATE.dayHasNotClosed)
    expect(outcomes.revenueOpen.code).toBe(ROLLUP_SQLSTATE.dayHasNotClosed)
    expect(outcomes.hasClosed.code).toBeUndefined()
  })
})

// ------------------------------------------------------------------------------------------------
// The recompute: idempotent, and keyed on the business day
// ------------------------------------------------------------------------------------------------

describe('the nightly recompute', () => {
  it('produces byte-identical rows on a second run', async () => {
    const measured = await rolledBack(async (tx) => {
      const day = await closedTradingDay(tx, 2)
      const web = await session(tx, {
        tradingDate: day.tradingDate,
        startedAtMs: day.opensAtMs,
        source: 'google',
      })
      await pageView(tx, web.sessionId, day.opensAtMs, true)
      await paidBooking(tx, {
        tradingDate: day.tradingDate,
        sessionId: web.sessionId,
        source: 'google',
        atMs: day.opensAtMs + 1_800_000,
      })
      const computedAtIso = new Date(day.closesAtMs + 1_800_000).toISOString()
      const first = await rollUpTradingDate(tx, { tradingDate: day.tradingDate, computedAtIso })
      const firstDigest = await rollupDigest(tx, { tradingDate: day.tradingDate })
      const second = await rollUpTradingDate(tx, { tradingDate: day.tradingDate, computedAtIso })
      const secondDigest = await rollupDigest(tx, { tradingDate: day.tradingDate })
      return { first, second, firstDigest, secondDigest }
    })
    // The control the claim rests on: there was something to roll up. A digest comparison over two empty
    // tables is equal and proves nothing, which is ADR 0002's shape.
    expect(measured.first.traffic).toBeGreaterThan(0)
    expect(measured.first.revenue).toBeGreaterThan(0)
    expect(measured.second).toEqual(measured.first)
    expect(measured.secondDigest).toEqual(measured.firstDigest)
    expect(measured.firstDigest.traffic).not.toBe('')
    expect(measured.firstDigest.revenue).not.toBe('')
  })

  it('counts the gap cohort separately rather than reading it as daytime trade', async () => {
    const measured = await rolledBack(async (tx) => {
      const day = await closedTradingDay(tx, 2)
      // One session inside the day's own window, one filed under it out of the 02:00-11:00 gap. 0116
      // files the second under the next date the calendar opens and records WHY in
      // `trading_date_basis`; ZY222 refuses a row whose basis disagrees with the window, in both
      // directions, so the fixture cannot lie about which kind of session it is.
      const inside = await session(tx, {
        tradingDate: day.tradingDate,
        startedAtMs: day.opensAtMs + 3_600_000,
        source: 'google',
      })
      await pageView(tx, inside.sessionId, day.opensAtMs + 3_600_000, true)
      const gap = await session(tx, {
        tradingDate: day.tradingDate,
        // Three hours before the day opens: 08:00 local, squarely in the gap.
        startedAtMs: day.opensAtMs - 3 * 3_600_000,
        source: 'google',
        basis: 'before_opening',
      })
      await pageView(tx, gap.sessionId, day.opensAtMs - 3 * 3_600_000, true)
      await rollUpTradingDate(tx, {
        tradingDate: day.tradingDate,
        computedAtIso: new Date(day.closesAtMs + 1_800_000).toISOString(),
      })
      const [row] = await tx<{ sessions: number; gap_sessions: number }[]>`
        select sum(sessions)::int as sessions, sum(gap_sessions)::int as gap_sessions
          from analytics.daily_traffic where trading_date = ${day.tradingDate}::date
      `
      return row
    })
    expect(measured?.sessions).toBe(2)
    // The whole point: the cohort is visible. A rollup that resolved the gap silently would answer 0
    // here and report nine hours of browsing as daytime trade (ADR 0066, Y5-funnel-gap-bucket).
    expect(measured?.gap_sessions).toBe(1)
  })

  it('files a 01:30 treatment on the PREVIOUS business day, through the calendar', async () => {
    const measured = await rolledBack(async (tx) => {
      const day = await closedTradingDay(tx, 2)
      // 01:30 of the morning AFTER the calendar date — inside this trading day's 11:00-02:00 window, and
      // on the next CALENDAR date. `date(occurred_at)` would file it a day late.
      const atMs = day.closesAtMs - 1_800_000
      const web = await session(tx, {
        tradingDate: day.tradingDate,
        startedAtMs: atMs,
        source: 'google',
      })
      await paidBooking(tx, {
        tradingDate: day.tradingDate,
        sessionId: web.sessionId,
        source: 'google',
        atMs,
      })
      await rollUpTradingDate(tx, {
        tradingDate: day.tradingDate,
        computedAtIso: new Date(day.closesAtMs + 1_800_000).toISOString(),
      })
      const [revenue] = await tx<{ trading_date: string; gross_fils: string }[]>`
        select to_char(trading_date, 'YYYY-MM-DD') as trading_date, sum(gross_fils)::text as gross_fils
          from analytics.daily_source_revenue where trading_date = ${day.tradingDate}::date
         group by trading_date
      `
      // The LOCAL calendar date of the instant, asked of the database. `Date.toISOString()` answers in
      // UTC, where 01:30 Dubai is still the previous day — so the control would have compared the
      // trading date against itself and passed whatever the rollup did.
      const [local] = await tx<{ calendar_date: string }[]>`
        select to_char(to_timestamp(${atMs / 1000}) at time zone 'Asia/Dubai', 'YYYY-MM-DD')
                 as calendar_date
      `
      return { tradingDate: day.tradingDate, calendarDate: local?.calendar_date, revenue }
    })
    // The control that makes this case about the calendar: the instant's own calendar date is NOT the
    // trading date it was filed under, so a truncation would have produced a different answer.
    expect(measured.calendarDate).not.toBe(measured.tradingDate)
    expect(measured.revenue?.trading_date).toBe(measured.tradingDate)
    expect(measured.revenue?.gross_fils).toBe(String(GROSS))
  })
})

// ------------------------------------------------------------------------------------------------
// The revenue rollup: integer fils, reconciling to the document
// ------------------------------------------------------------------------------------------------

describe('daily_source_revenue', () => {
  it('reconciles to the invoice to the fils, in integer fils, attributed by source', async () => {
    const measured = await rolledBack(async (tx) => {
      const day = await closedTradingDay(tx, 2)
      const web = await session(tx, {
        tradingDate: day.tradingDate,
        startedAtMs: day.opensAtMs,
        source: 'google',
      })
      const paid = await paidBooking(tx, {
        tradingDate: day.tradingDate,
        sessionId: web.sessionId,
        source: 'google',
        atMs: day.opensAtMs + 1_800_000,
      })
      // A walk-in, PAID, which is attributed `offline` and must appear as its own row: folding it into
      // the web source would report a walk-in's takings as advertising revenue.
      await paidBooking(tx, {
        tradingDate: day.tradingDate,
        sessionId: null,
        source: 'offline',
        atMs: day.opensAtMs + 3 * 3_600_000,
      })
      // And one web booking NOT settled — the control for "paid invoice lines".
      const unpaidSession = await session(tx, {
        tradingDate: day.tradingDate,
        startedAtMs: day.opensAtMs + 5 * 3_600_000,
        source: 'facebook',
      })
      await paidBooking(tx, {
        tradingDate: day.tradingDate,
        sessionId: unpaidSession.sessionId,
        source: 'facebook',
        atMs: day.opensAtMs + 5 * 3_600_000,
        settle: false,
      })
      await rollUpTradingDate(tx, {
        tradingDate: day.tradingDate,
        computedAtIso: new Date(day.closesAtMs + 1_800_000).toISOString(),
      })
      const rows = await tx<
        {
          source: string
          paid_invoices: number
          gross_fils: string
          vat_fils: string
          net_fils: string
        }[]
      >`
        select source, paid_invoices, gross_fils::text as gross_fils, vat_fils::text as vat_fils,
               net_fils::text as net_fils
          from analytics.daily_source_revenue where trading_date = ${day.tradingDate}::date
         order by source
      `
      const [document] = await tx<{ gross_total: string; vat_total: string; net_total: string }[]>`
        select gross_total::text as gross_total, vat_total::text as vat_total,
               net_total::text as net_total
          from invoice where id = ${paid.invoiceId}::uuid
      `
      const internal = await internalPaidConversions(tx, { tradingDate: day.tradingDate })
      return { rows, document, internal }
    })

    expect(measured.rows.map((row) => row.source)).toEqual(['google', 'offline'])
    const google = measured.rows.find((row) => row.source === 'google')
    expect(google?.paid_invoices).toBe(1)
    // To the fils, against the DOCUMENT's own stored totals rather than against this file's constants:
    // `invoice_totals_reconcile` holds net + vat = gross on the document, and this holds the rollup to
    // the document, so the two cannot drift apart without one of them failing.
    expect(google?.gross_fils).toBe(measured.document?.gross_total)
    expect(google?.vat_fils).toBe(measured.document?.vat_total)
    expect(google?.net_fils).toBe(measured.document?.net_total)
    // Integer fils, so the identity is exact rather than nearly: gross - vat = net, in integers.
    expect(Number(google?.gross_fils) - Number(google?.vat_fils)).toBe(Number(google?.net_fils))
    // The unsettled document is in NO row. The control: `facebook` is a source the day really saw.
    expect(measured.rows.map((row) => row.source)).not.toContain('facebook')
    // And A-MEAS-07's internal side sees exactly the two settled documents, which is the deferral
    // ADR 0093 recorded against this unit by name.
    expect(measured.internal).toHaveLength(2)
    expect(measured.internal.every((row) => row.grossFils === GROSS)).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------
// Retention: the rollups outlive the raw partition they were computed from
// ------------------------------------------------------------------------------------------------

describe('a dropped raw partition', () => {
  it('leaves daily_traffic and daily_funnel for that business day present and unchanged', async () => {
    const measured = await rolledBack(async (tx) => {
      const day = await closedTradingDay(tx, 100)
      const web = await session(tx, {
        tradingDate: day.tradingDate,
        startedAtMs: day.opensAtMs,
        source: 'google',
      })
      await pageView(tx, web.sessionId, day.opensAtMs, true)
      await tx`
        insert into analytics.funnel_step (session_id, step, occurred_at)
        values (${web.sessionId}::uuid, 'landing', to_timestamp(${day.opensAtMs / 1000}))
      `
      await rollUpTradingDate(tx, {
        tradingDate: day.tradingDate,
        computedAtIso: new Date(day.closesAtMs + 1_800_000).toISOString(),
      })
      const before = await rollupDigest(tx, { tradingDate: day.tradingDate })

      // The partition that holds this day's raw events, found in the catalogue rather than named: the
      // month's partition name is `analytics.ensure_partitions`' to choose and a literal here would make
      // this case silently measure nothing the first time that function's naming changed.
      const [partition] = await tx<{ relname: string }[]>`
        select c.relname
          from pg_inherits i
          join pg_class c on c.oid = i.inhrelid
          join pg_class p on p.oid = i.inhparent
          join pg_namespace n on n.oid = p.relnamespace
         where n.nspname = 'analytics' and p.relname = 'event'
           and c.relname <> 'event_default'
           and pg_get_expr(c.relpartbound, c.oid) like
               ${`%${new Date(day.opensAtMs).toISOString().slice(0, 7)}%`}
         limit 1
      `
      if (partition === undefined) {
        throw new Error(
          'no analytics.event partition covers this fixture day, so the case would prove nothing about ' +
            'a rollup outliving one. `analytics.ensure-partitions` creates them; run `pnpm db:apply`.',
        )
      }
      const [rawBefore] = await tx<{ n: string }[]>`
        select count(*)::text as n from analytics.event
         where session_id = ${web.sessionId}::uuid
      `
      // DDL, rolled back with the transaction — which is the only reason a case may drop a real
      // partition of a shared database at all.
      await tx.unsafe(`drop table analytics.${partition.relname}`)
      const [rawAfter] = await tx<{ n: string }[]>`
        select count(*)::text as n from analytics.event
         where session_id = ${web.sessionId}::uuid
      `
      return {
        before,
        after: await rollupDigest(tx, { tradingDate: day.tradingDate }),
        rawBefore: Number(rawBefore?.n ?? '0'),
        rawAfter: Number(rawAfter?.n ?? '0'),
      }
    })
    // The control: the raw events really did go. Without it this case would pass against a drop that
    // removed nothing, which is the whole shape of a retention test that measures the wrong partition.
    expect(measured.rawBefore).toBeGreaterThan(0)
    expect(measured.rawAfter).toBe(0)
    // And the rollups are byte-identical, because they are exempt from retention BY A ROW in
    // `analytics.retention_policy` and hold their own copies of every figure.
    expect(measured.after).toEqual(measured.before)
    expect(measured.before.traffic).not.toBe('')
    expect(measured.before.funnel).not.toBe('')
  })
})
