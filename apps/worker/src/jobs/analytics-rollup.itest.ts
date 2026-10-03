import {
  APPOINTMENT_STATUS_FUNNEL,
  COLLECTED_EVENT_FUNNEL,
  conversionRateOf,
  funnelCountsFrom,
  showAdjustedConversionOf,
} from '@berelax/core'
import {
  AuditWriter,
  createConnection,
  type FunnelCountGroup,
  funnelCountRows,
  issueInvoice,
  publishEvent,
  type Sql,
  type UnitOfWork,
} from '@berelax/db'
import { FUNNEL_STAGES, isFunnelStage } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  COLLECTED_STAGE_MAPPINGS,
  runAnalyticsRollupPass,
  STATUS_STAGE_MAPPINGS,
} from './analytics-rollup.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The funnel's arithmetic over a real database (A-FIRST-09): the eight counts, the conversion rate, the
 * no-show exclusion and the bot parameter.
 *
 * ## Why this file is beside the PASS and not in `packages/db`
 *
 * The funnel's two mappings — `COLLECTED_EVENT_FUNNEL` and `APPOINTMENT_STATUS_FUNNEL` — are
 * `@berelax/core`'s, and `packages/db` may never import core (ADR 0001). A copy of either in a `db` suite
 * would be the second statement of the funnel the whole design exists to prevent, and it would be the
 * copy that drifts. `apps/worker` is the one place core's mappings, db's statements and the pass itself
 * are all reachable, which is also why A-MEAS-05 and A-MEAS-07 each recorded that a suite about a worker
 * pass lives beside the pass. The schema's own claims — ZY701, ZY702, the gap counts, the recompute's
 * idempotence, the business-day filing and the revenue reconciliation — are in
 * `packages/db/src/rollup.itest.ts`.
 *
 * ## The fixture, and why its counts are stated before the query runs
 *
 * 520 sessions on one closed trading day: 500 human and 20 declared crawlers. Every count below is a
 * CONSTANT in this file, so the assertions compare the query against a figure a reader can add up by
 * hand — which is what the acceptance line means by "known outcomes". A test that derived its expectation
 * from a second query would agree with the first one's defects.
 *
 * ## Everything runs inside one transaction that is rolled back
 *
 * The pass is handed a pass-through `transact`, because postgres.js' `begin` opens a transaction on the
 * pool and cannot nest inside the one this file holds. `analytics` grants the application role no DELETE
 * and `invoice` refuses it for every role, so a rollback is the only cleanup these tables permit — and it
 * is what lets this suite run twice in a row.
 */
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

// ------------------------------------------------------------------------------------------------
// The fixture's figures. Every one of them is this file's own, added up by hand.
// ------------------------------------------------------------------------------------------------

const HUMAN_SESSIONS = 500
const BOT_SESSIONS = 20
const SERVICE_VIEWED = 300
const PRICE_VIEWED = 150
const CTA_CLICK = 60
/** Bookings, one per session, each in its own half-hour slot with its own therapist. */
const BOOKINGS = 12
/** Of the bookings, how many were confirmed. The other two never left `requested`. */
const CONFIRMED = 10
/** Of the confirmed, how many did not turn up. Excluded from `attended`, `paid` and both rate sides. */
const NO_SHOWS = 2
/** Of the confirmed, how many were completed. `CONFIRMED - NO_SHOWS`, written out to be read. */
const ATTENDED = 8
/** Of the attended, how many settled their document in full. The LEDGER's fact. */
const PAID = 6

const GROSS = 26_250
const NET = 25_000
const VAT = 1_250

const EXPECTED_ENTERED: Readonly<Record<string, number>> = Object.freeze({
  landing: HUMAN_SESSIONS,
  service_viewed: SERVICE_VIEWED,
  price_viewed: PRICE_VIEWED,
  cta_click: CTA_CLICK,
  booking_created: BOOKINGS,
  confirmed: CONFIRMED,
  attended: ATTENDED,
  paid: PAID,
})

const ACTOR = {
  kind: 'system' as const,
  id: '44444444-4444-4444-4444-444444444444',
  label: 'Nightly rollups (A-FIRST-09 funnel itest)',
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

interface Day {
  readonly tradingDate: string
  readonly opensAtMs: number
  readonly closesAtMs: number
}

/** A seeded trading day that has CLOSED, with its raw partitions ensured. `rollup.itest.ts`' helper. */
async function closedTradingDay(tx: Sql): Promise<Day> {
  const [row] = await tx<{ trading_date: string; opens_at: Date; closes_at: Date }[]>`
    select to_char(trading_date, 'YYYY-MM-DD') as trading_date, opens_at, closes_at
      from business_day where closes_at < now() order by closes_at desc limit 1
  `
  if (row === undefined) {
    throw new Error(
      'business_day holds no day that has closed, so ZY702 would refuse every rollup here. `pnpm seed`.',
    )
  }
  // The raw partitions for a PAST month, which `analytics.ensure_partitions` does not keep (it runs three
  // months AHEAD of the clock). Rolled back with the transaction.
  await tx`select analytics.ensure_partitions(date_trunc('month', ${row.trading_date}::date)::date, 1)`
  return {
    tradingDate: row.trading_date,
    opensAtMs: row.opens_at.getTime(),
    closesAtMs: row.closes_at.getTime(),
  }
}

/**
 * 520 sessions, their events, and twelve bookings — built with `generate_series` rather than in a loop.
 *
 * Five hundred round trips would make this file the slowest in the suite for no gain: the claim is about
 * the COUNTS, and a set built in SQL is the same set. The ordering is deterministic (`row_number()` over
 * the series), so "the first 300 sessions also viewed a service" is a fact a reader can check rather than
 * a sample.
 */
async function fixture(tx: Sql, day: Day): Promise<void> {
  const openSec = day.opensAtMs / 1000
  await tx`
    insert into analytics.visitor (first_seen_at, last_seen_at)
    select to_timestamp(${openSec}), to_timestamp(${openSec})
      from generate_series(1, ${HUMAN_SESSIONS + BOT_SESSIONS})
  `
  // The visitors this fixture just created, in insertion order: `uuid_generate_v7` is time-ordered, so
  // `order by visitor_id` is that order. Narrowed to the ones whose instant is this day's opening, which
  // no other fixture in the suite writes.
  await tx`
    insert into analytics.session
      (visitor_id, started_at, last_event_at, trading_date, trading_date_basis, landing_path,
       device_kind, breakpoint, bot, bot_kind)
    select v.visitor_id,
           to_timestamp(${openSec}),
           to_timestamp(${openSec}),
           ${day.tradingDate}::date,
           'trading',
           '/',
           'mobile',
           'sm',
           v.n > ${HUMAN_SESSIONS},
           case when v.n > ${HUMAN_SESSIONS} then 'declared_crawler' end
      from (
        select visitor_id, row_number() over (order by visitor_id) as n
          from analytics.visitor
         where first_seen_at = to_timestamp(${openSec})
      ) v
  `
  await tx`
    insert into analytics.attribution
      (session_id, basis, source, medium, campaign, resolver_version, resolved_at)
    select s.session_id, 'utm', 'google', 'cpc', 'spring', 'origination/1', to_timestamp(${openSec})
      from analytics.session s
     where s.trading_date = ${day.tradingDate}::date and s.started_at = to_timestamp(${openSec})
  `
  /*
   * One page view per session with `entry` TRUE — the flag the ingest overwrites server-side — plus the
   * three further collected events on a prefix of the sessions. `occurred_at` is nudged by the row number
   * so `client_event_id` stays unique per month (0096's `event_client_event_id_unique`).
   */
  for (const [eventName, limit] of [
    ['page_view', HUMAN_SESSIONS + BOT_SESSIONS],
    ['service_viewed', SERVICE_VIEWED],
    ['price_viewed', PRICE_VIEWED],
    ['cta_click', CTA_CLICK],
  ] as const) {
    await tx`
      insert into analytics.event
        (session_id, occurred_at, event_name, path, properties, client_event_id)
      select s.session_id,
             to_timestamp(${openSec}) + make_interval(secs => s.n),
             ${eventName},
             '/',
             ${tx.json({ entry: true })},
             ${`probe-${eventName}-`} || s.n::text || '-' || ${day.tradingDate}
        from (
          select session_id, row_number() over (order by session_id) as n
            from analytics.session
           where trading_date = ${day.tradingDate}::date and started_at = to_timestamp(${openSec})
        ) s
       where s.n <= ${limit}
    `
  }
  await bookings(tx, day)
}

/** The twelve bookings, each on the first twelve sessions, in its own slot with its own therapist. */
async function bookings(tx: Sql, day: Day): Promise<void> {
  const [variant] = await tx<{ id: string }[]>`
    select v.id from service_variant v join service s on s.id = v.service_id
     where s.archived_at is null order by v.id limit 1
  `
  const rooms = await tx<{ id: string }[]>`select id from rooms order by id`
  const staff = await tx<{ id: string }[]>`
    select id from employee order by staff_reference limit ${BOOKINGS}
  `
  if (variant === undefined || rooms.length === 0 || staff.length < BOOKINGS) {
    throw new Error(
      `run \`pnpm seed\`: a priced variant, a room and ${BOOKINGS} employees are needed — the seed ` +
        'creates nineteen therapists.',
    )
  }
  const sessions = await tx<{ session_id: string }[]>`
    select session_id::text as session_id
      from analytics.session
     where trading_date = ${day.tradingDate}::date
       and started_at = to_timestamp(${day.opensAtMs / 1000})
     order by session_id
     limit ${BOOKINGS}
  `
  for (const [index, row] of sessions.entries()) {
    // Its own half-hour slot and its own therapist, so `appointment_therapist_no_overlap` — a real
    // exclusion constraint — has nothing to object to. A fixture that overlapped would fail on a
    // double-booking rule rather than on anything this file is about.
    const startMs = day.opensAtMs + index * 1_800_000
    const [customer] = await tx<{ id: string }[]>`
      insert into customer (phone_e164, created_via)
      values (${`+971594${String(100_000 + index)}`}, 'guest_booking')
      returning id::text as id
    `
    const [booking] = await tx<{ id: string }[]>`
      insert into booking (customer_id, source, created_at)
      values (${customer?.id as string}, 'online', to_timestamp(${startMs / 1000}))
      returning id::text as id
    `
    const bookingId = booking?.id as string
    await tx`
      insert into booking_attribution
        (booking_id, basis, source, medium, campaign, session_reference, occurred_at, recorded_at)
      values (${bookingId}::uuid, 'utm', 'google', 'cpc', 'spring', ${row.session_id}::uuid,
              to_timestamp(${day.opensAtMs / 1000}), to_timestamp(${startMs / 1000}))
    `
    /*
     * The status this booking ends in, and the HISTORY that says how it got there.
     *
     * The history is what makes "a no-show contributes to `confirmed`" provable: the current status alone
     * cannot say the booking was confirmed first, and `appointment_status_history` is append-only (ADR
     * 0008) so the earliest transition into a status is the fact.
     */
    const confirmed = index < CONFIRMED
    const noShow = confirmed && index >= CONFIRMED - NO_SHOWS
    const attended = confirmed && !noShow
    const paid = attended && index < PAID
    const status = noShow
      ? 'no_show'
      : attended
        ? 'completed'
        : confirmed
          ? 'confirmed'
          : 'requested'
    const [appointment] = await tx<{ id: string }[]>`
      insert into appointment
        (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
         gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes,
         therapist_buffer_minutes)
      values (${bookingId}::uuid, ${day.tradingDate}::date, ${variant.id}, 'solo'::service_shape,
              ${staff[index]?.id as string},
              ${rooms[index % rooms.length]?.id as string},
              ${`[${new Date(startMs).toISOString()},${new Date(startMs + 900_000).toISOString()})`}::tstzrange,
              ${status}::appointment_status, ${GROSS}, ${NET}, ${VAT}, 500, 20, 10)
      returning id::text as id
    `
    const appointmentId = appointment?.id as string
    if (confirmed) {
      await tx`
        insert into appointment_status_history (appointment_id, from_status, to_status, occurred_at)
        values (${appointmentId}::uuid, 'requested', 'confirmed',
                to_timestamp(${(startMs - 600_000) / 1000}))
      `
    }
    if (attended) {
      await tx`
        insert into appointment_status_history (appointment_id, from_status, to_status, occurred_at)
        values (${appointmentId}::uuid, 'confirmed', 'completed', to_timestamp(${startMs / 1000}))
      `
    }
    if (noShow) {
      await tx`
        insert into appointment_status_history (appointment_id, from_status, to_status, occurred_at)
        values (${appointmentId}::uuid, 'confirmed', 'no_show', to_timestamp(${startMs / 1000}))
      `
    }
    if (!attended) continue
    const issued = await issueInvoice(unitOfWork(tx), {
      documentKind: 'tax_invoice',
      seriesCode: 'TAX-INV',
      issuer: ISSUER,
      customer: { nameSnapshot: 'Customer 0042' },
      bookingId,
      issueDate: day.tradingDate,
      issueTradingDate: day.tradingDate,
      taxPointDate: day.tradingDate,
      lines: [
        {
          descriptionEn: 'Treatment (funnel fixture)',
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
      values (${issued.id}::uuid, ${appointmentId}::uuid, 1)
    `
    if (paid) {
      await tx`
        insert into payment (
          invoice_id, tender_no, tender_kind, posting_account_code, amount_fils, trading_date,
          received_at
        ) values (
          ${issued.id}::uuid, 1, 'cash', '1010', ${GROSS}, ${day.tradingDate}::date,
          to_timestamp(${(startMs + 900_000) / 1000})
        )
      `
    }
  }
}

/** Totals the query's (stage, origination) groups into one count per stage. */
function enteredByStage(rows: readonly FunnelCountGroup[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const row of rows) totals[row.stage] = (totals[row.stage] ?? 0) + row.entered
  return totals
}

const counts = (rows: readonly FunnelCountGroup[]) =>
  funnelCountsFrom(
    rows.flatMap((row) =>
      isFunnelStage(row.stage)
        ? [
            {
              stage: row.stage,
              entered: row.entered,
              excluded: row.excluded,
              gapEntered: row.gapEntered,
            },
          ]
        : [],
    ),
  )

describe('the two mappings this pass hands down', () => {
  it('are derived from core’s tables and drop only the entries that contribute nothing', () => {
    // The control on the derivation: a mapping written out by hand would not shrink when a rule's stage
    // is null, and `whatsapp_ref_shown` is exactly such a rule — the denominator of the ref-capture rate
    // and not a funnel stage.
    expect(COLLECTED_STAGE_MAPPINGS).toHaveLength(
      Object.values(COLLECTED_EVENT_FUNNEL).filter((rule) => rule.stage !== null).length,
    )
    expect(COLLECTED_STAGE_MAPPINGS.map((m) => m.eventName)).not.toContain('whatsapp_ref_shown')
    expect(COLLECTED_STAGE_MAPPINGS.filter((m) => m.entryOnly).map((m) => m.eventName)).toEqual([
      'page_view',
    ])
    expect(STATUS_STAGE_MAPPINGS).toHaveLength(
      Object.values(APPOINTMENT_STATUS_FUNNEL).filter((o) => o.kind !== 'no_step').length,
    )
    // `checked_in` contributes nothing: arrival is not the treatment delivered, and a client who checked
    // in and left is reachable from there to `no_show`.
    expect(STATUS_STAGE_MAPPINGS.map((m) => m.status)).not.toContain('checked_in')
  })
})

describe('the funnel over 500 human sessions and 20 crawlers', () => {
  it('produces the exact expected count at all eight steps, and conversion is paid over landing', async () => {
    const measured = await rolledBack(async (tx) => {
      const day = await closedTradingDay(tx)
      await fixture(tx, day)
      await runAnalyticsRollupPass(
        tx,
        {
          tradingDate: day.tradingDate,
          nowIso: new Date(day.closesAtMs + 1_800_000).toISOString(),
        },
        (body) => body(tx),
      )
      return {
        rows: await funnelCountRows(tx, { tradingDate: day.tradingDate }),
        day,
      }
    })
    const totals = enteredByStage(measured.rows)
    for (const stage of FUNNEL_STAGES) {
      expect(totals[stage], `stage ${stage}`).toBe(EXPECTED_ENTERED[stage])
    }
    const conversion = conversionRateOf(counts(measured.rows))
    expect(conversion.kind).toBe('rate')
    if (conversion.kind !== 'rate') throw new Error('unreachable')
    // 6 paid over 500 landings is 12 per mille. The control, and the reason the acceptance line names
    // it: `booking_created ÷ landing` is 12/500 too by coincidence of this fixture — so the figure is
    // asserted against the NUMERATOR as well, which only `paid` can produce.
    expect(conversion.numerator).toBe(PAID)
    expect(conversion.denominator).toBe(HUMAN_SESSIONS)
    expect(conversion.perMille).toBe(12)
  })

  it('excludes a no-show from attended, from paid, and from both sides of the show-adjusted rate', async () => {
    const measured = await rolledBack(async (tx) => {
      const day = await closedTradingDay(tx)
      await fixture(tx, day)
      await runAnalyticsRollupPass(
        tx,
        {
          tradingDate: day.tradingDate,
          nowIso: new Date(day.closesAtMs + 1_800_000).toISOString(),
        },
        (body) => body(tx),
      )
      return counts(await funnelCountRows(tx, { tradingDate: day.tradingDate }))
    })
    // Three assertions on one fixture, which is what the acceptance line asks for.
    expect(measured['confirmed'].entered).toBe(CONFIRMED)
    expect(measured['confirmed'].excluded).toBe(NO_SHOWS)
    expect(measured['attended'].entered).toBe(ATTENDED)
    expect(measured['paid'].entered).toBe(PAID)

    const adjusted = showAdjustedConversionOf(measured)
    if (adjusted.kind !== 'rate') throw new Error('unreachable')
    // 6 paid of the 8 that turned up: the no-shows are out of the denominator because they are in
    // `excluded`, and out of the numerator because they never paid. 750 per mille.
    expect(adjusted.denominator).toBe(CONFIRMED - NO_SHOWS)
    expect(adjusted.numerator).toBe(PAID)
    expect(adjusted.perMille).toBe(750)
    // The control: the UNADJUSTED figure over `confirmed` would be 6/10, and a reader shown that would
    // conclude the till loses four bookings in ten.
    expect(adjusted.perMille).not.toBe(600)
  })

  it('excludes bot sessions by default and includes them behind the parameter, by exactly the bot count', async () => {
    const measured = await rolledBack(async (tx) => {
      const day = await closedTradingDay(tx)
      await fixture(tx, day)
      await runAnalyticsRollupPass(
        tx,
        {
          tradingDate: day.tradingDate,
          nowIso: new Date(day.closesAtMs + 1_800_000).toISOString(),
        },
        (body) => body(tx),
      )
      const [seeded] = await tx<{ n: string }[]>`
        select count(*)::text as n from analytics.session
         where trading_date = ${day.tradingDate}::date and bot
      `
      return {
        byDefault: await funnelCountRows(tx, { tradingDate: day.tradingDate }),
        withBots: await funnelCountRows(tx, {
          tradingDate: day.tradingDate,
          includeBots: true,
        }),
        seededBots: Number(seeded?.n ?? '0'),
      }
    })
    expect(measured.seededBots).toBe(BOT_SESSIONS)
    const byDefault = enteredByStage(measured.byDefault)
    const withBots = enteredByStage(measured.withBots)
    // The two queries differ by EXACTLY the seeded bot count, on the stage the crawlers reached — and by
    // nothing at all on the stages they did not, which is the half that makes this a measurement rather
    // than a claim about one number.
    expect((withBots['landing'] ?? 0) - (byDefault['landing'] ?? 0)).toBe(BOT_SESSIONS)
    expect(byDefault['landing']).toBe(HUMAN_SESSIONS)
    expect(withBots['landing']).toBe(HUMAN_SESSIONS + BOT_SESSIONS)
    for (const stage of ['price_viewed', 'booking_created', 'confirmed', 'attended', 'paid']) {
      expect(withBots[stage] ?? 0, `stage ${stage}`).toBe(byDefault[stage] ?? 0)
    }
    // And the crawlers' steps WERE materialised — the verdict is stored and acted on at the count, not
    // at collection (ADR 0062). A pass that filtered them out of `funnel_step` would make this zero and
    // the flag unrecoverable once retention removed the raw events.
    expect(withBots['landing']).toBeGreaterThan(byDefault['landing'] ?? 0)
  })
})
