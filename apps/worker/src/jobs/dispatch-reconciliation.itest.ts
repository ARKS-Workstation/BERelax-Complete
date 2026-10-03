import { analyticsEventId, DISPATCH_DESTINATIONS, dispatchPayloadBytes } from '@berelax/analytics'
import { buildEgressPayload, type InternalConversion } from '@berelax/core'
import {
  createConnection,
  dispatchReconciliationRefusalOf,
  dispatchReconciliationsForDay,
  enqueueAnalyticsDispatch,
  pushedDispatchesForDay,
  type Sql,
  writeDispatchReconciliation,
} from '@berelax/db'
import { FUNNEL_TERMINAL_STAGE, type FunnelStage } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  NO_INTERNAL_TRUTH_ON_FILE,
  runDispatchReconciliationPass,
} from './dispatch-reconciliation.ts'

/**
 * The daily reconciliation against a real PostgreSQL (A-MEAS-07).
 *
 * ## The fixture is the acceptance line, built out of real dispatch rows
 *
 * *"a fixture with 10 paid bookings and 9 successful dispatches reports exactly one missing item, named by
 * event_id, per destination"*. Ten conversions are enqueued through `enqueueAnalyticsDispatch` — the one
 * writer, which asks the consent gate — and nine of them are transmitted. The tenth is left `queued`, and
 * the pass has to report exactly one missing item per destination and name it.
 *
 * The classification is proved pure in `reconciliation.test.ts`. What this file adds is everything the
 * pure function cannot see: that `pushedDispatchesForDay` finds the rows through the trading day's own
 * window, that the figure read back off the stored payload is the figure that was pushed, that ZY471 and
 * ZY472 fire, and that a second run produces identical rows — which is the acceptance line a pure test
 * cannot make a claim about at all.
 *
 * ## Why it is here and not at `packages/core`
 *
 * It needs `@berelax/core`'s classification, `@berelax/db`'s reads and writes, and the worker's pass in one
 * file. `packages/db` may never import `packages/core` and `nothing-imports-an-app` refuses a package
 * reaching into `apps/`, so a suite about a worker pass lives beside the pass.
 *
 * ## What it deletes
 *
 * Its own visitor (ADR 0050), which takes the session and every dispatch row with it by `on delete
 * cascade` — and the reconciliation items with them, because `analytics_dispatch_reconciliation_item`
 * references `analytics_dispatch (dispatch_id) on delete cascade`. The summaries it wrote are removed by
 * key, because nothing else in this build writes a reconciliation for the day it uses.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
const createdVisitors: string[] = []
const touchedDays = new Set<string>()

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
})

afterAll(async () => {
  if (sql !== undefined) {
    if (touchedDays.size > 0) {
      await sql`
        delete from analytics_dispatch_reconciliation
         where business_day = any(${[...touchedDays]}::date[])
      `
    }
    if (createdVisitors.length > 0) {
      await sql`delete from analytics.visitor where visitor_id = any(${createdVisitors}::uuid[])`
    }
  }
  await sql?.end({ timeout: 5 })
})

const TERMINAL: FunnelStage = ((stage: FunnelStage | undefined): FunnelStage => {
  if (stage === undefined) throw new Error('FUNNEL_STAGES is empty, so no stage is terminal.')
  return stage
})(FUNNEL_TERMINAL_STAGE)

const CONVERSION_FILS = 32_010

/**
 * A closed trading day, and the instants inside it a dispatch may be decided at.
 *
 * `offset` is which closed day to take, counting back from the most recent, and **every case in this file
 * takes a different one**. That is not tidiness: the pass reconciles every dispatch decided inside the
 * day's window against the internal truth it is given, so two cases sharing a day make each other's rows
 * look like pushes with no internal record behind them — and the second case to run then fails naming the
 * state rather than the collision. The first version of this file shared one day and three cases failed
 * exactly that way, which is the brief's rule 12 arriving inside one file instead of across two.
 */
async function closedDay(offset: number): Promise<{
  readonly tradingDate: string
  readonly decidedAtIso: string
  readonly ranAtIso: string
}> {
  const [day] = await sql<{ trading_date: string; opens_at: Date; closes_at: Date }[]>`
    select trading_date::text as trading_date, opens_at, closes_at
      from public.business_day
     where closes_at <= now()
     order by closes_at desc
     offset ${offset}
     limit 1
  `
  const tradingDate = day?.trading_date as string
  expect(tradingDate, 'the calendar must hold a day that has already closed').toBeDefined()
  touchedDays.add(tradingDate)
  const opensAt = day?.opens_at as Date
  const closesAt = day?.closes_at as Date
  return {
    tradingDate,
    // Inside the day's own window, which is what `pushedDispatchesForDay` keys on.
    decidedAtIso: new Date(opensAt.getTime() + 60 * 60 * 1000).toISOString(),
    // After the close, which is what ZY472 requires of a reconciliation.
    ranAtIso: new Date(closesAt.getTime() + 60 * 60 * 1000).toISOString(),
  }
}

async function grantingSession(): Promise<string> {
  const [visitor] = await sql<{ visitor_id: string }[]>`
    insert into analytics.visitor (first_seen_at, last_seen_at) values (now(), now())
    returning visitor_id
  `
  const visitorId = visitor?.visitor_id as string
  createdVisitors.push(visitorId)
  const [session] = await sql<{ session_id: string }[]>`
    insert into analytics.session (
      visitor_id, started_at, last_event_at, trading_date, trading_date_basis, landing_path,
      device_kind, breakpoint, bot,
      consent_ad_storage, consent_ad_user_data, consent_ad_personalization, consent_analytics_storage
    )
    select ${visitorId}::uuid, b.opens_at, b.opens_at, b.trading_date, 'trading', '/en/recon-fixture',
           'desktop', 'lg', false, true, true, true, true
      from public.business_day b
     order by abs(extract(epoch from (b.opens_at - now())))
     limit 1
    returning session_id
  `
  return session?.session_id as string
}

const eventIdFor = (n: number, prefix: string) =>
  analyticsEventId({
    kind: 'invoice',
    aggregateId: `0193f2c1-0000-7000-8000-${prefix}${String(n).padStart(4, '0')}`,
    stage: TERMINAL,
  })

/**
 * Enqueues `count` conversions and transmits the first `sent` of them, for every destination.
 *
 * Transmission is performed by this fixture rather than by A-MEAS-03's pass, deliberately: the pass drains
 * everything that is due, including rows other cases in this file left behind, so driving it here would
 * make which rows are `sent` depend on the order the cases ran in — and the whole claim is about a precise
 * count.
 */
async function enqueueAndTransmit(options: {
  readonly count: number
  readonly sent: number
  readonly prefix: string
  readonly decidedAtIso: string
}): Promise<{ readonly internal: readonly InternalConversion[]; readonly sessionId: string }> {
  const sessionId = await grantingSession()
  const internal: InternalConversion[] = []
  const { payload } = buildEgressPayload({
    ref: { kind: 'package_template' },
    eventType: TERMINAL,
    quantity: 1,
    valueFils: CONVERSION_FILS,
  })
  for (let n = 1; n <= options.count; n += 1) {
    const eventId = eventIdFor(n, options.prefix)
    internal.push({ eventId, valueFils: CONVERSION_FILS })
    for (const destination of DISPATCH_DESTINATIONS) {
      const enqueued = await enqueueAnalyticsDispatch(sql, {
        sessionId,
        destination,
        funnelStage: TERMINAL,
        decidedAtIso: options.decidedAtIso,
        eventId,
        payload: dispatchPayloadBytes(payload),
        actionSource: 'website',
        occurredAtIso: options.decidedAtIso,
      })
      expect(enqueued.state, 'the fixture must have something queued').toBe('queued')
      if (n <= options.sent) {
        await sql`
          update analytics_dispatch
             set state = 'sent', attempts = 1, transmitted_at = ${options.decidedAtIso}::timestamptz
           where dispatch_id = ${enqueued.dispatchId}::uuid
        `
      }
    }
  }
  return { internal, sessionId }
}

describe('ten paid conversions and nine successful dispatches', () => {
  it('reports exactly ONE missing item, named by event_id, per destination', async () => {
    const day = await closedDay(0)
    const { internal } = await enqueueAndTransmit({
      count: 10,
      sent: 9,
      prefix: 'aa',
      decidedAtIso: day.decidedAtIso,
    })
    const result = await runDispatchReconciliationPass(sql, {
      businessDay: day.tradingDate,
      nowIso: day.ranAtIso,
      destinations: DISPATCH_DESTINATIONS,
      resolveInternalTruth: () => internal,
    })
    expect(result.unreconciled).toBe(DISPATCH_DESTINATIONS.length)
    expect(result.reconciled).toBe(0)

    const stored = await dispatchReconciliationsForDay(sql, { businessDay: day.tradingDate })
    expect(stored.map((row) => row.destination)).toEqual([...DISPATCH_DESTINATIONS].sort())
    const missingEventId = eventIdFor(10, 'aa')
    for (const summary of stored) {
      expect(summary.state).toBe('unreconciled')
      expect(summary.internalCount).toBe(10)
      expect(summary.pushedCount).toBe(9)
      expect(summary.missingCount).toBe(1)
      expect(summary.duplicateCount).toBe(0)
      // Named by event_id, which is the acceptance line's own wording.
      const items = summary.items.filter((item) => item.classification === 'missing')
      expect(items).toHaveLength(1)
      expect(items[0]?.eventId).toBe(missingEventId)
      expect(items[0]?.dispatchId).toBeNull()
      // And the money difference is the one conversion, signed so that "the platform is short" is legible.
      expect(summary.differenceFils).toBe(CONVERSION_FILS)
    }
  })

  it('is idempotent per business day: two runs produce identical rows', async () => {
    const day = await closedDay(1)
    const { internal } = await enqueueAndTransmit({
      count: 3,
      sent: 2,
      prefix: 'bb',
      decidedAtIso: day.decidedAtIso,
    })
    const run = () =>
      runDispatchReconciliationPass(sql, {
        businessDay: day.tradingDate,
        nowIso: day.ranAtIso,
        destinations: DISPATCH_DESTINATIONS,
        resolveInternalTruth: () => internal,
      })
    await run()
    const first = await dispatchReconciliationsForDay(sql, { businessDay: day.tradingDate })
    await run()
    const second = await dispatchReconciliationsForDay(sql, { businessDay: day.tradingDate })
    // Identical ROWS, including the items and their order — the acceptance line in full. The key is what
    // makes it true: a second run cannot ADD a row, and the items are replaced rather than upserted.
    expect(second).toEqual(first)
    const [{ n } = { n: '0' }] = await sql<{ n: string }[]>`
      select count(*)::text as n from analytics_dispatch_reconciliation
       where business_day = ${day.tradingDate}::date
    `
    expect(n).toBe(String(DISPATCH_DESTINATIONS.length))
  })

  it('reconciles once the tenth dispatch lands, and removes the missing item', async () => {
    const day = await closedDay(2)
    const { internal } = await enqueueAndTransmit({
      count: 2,
      sent: 1,
      prefix: 'cc',
      decidedAtIso: day.decidedAtIso,
    })
    const run = () =>
      runDispatchReconciliationPass(sql, {
        businessDay: day.tradingDate,
        nowIso: day.ranAtIso,
        destinations: DISPATCH_DESTINATIONS,
        resolveInternalTruth: () => internal,
      })
    await run()
    const before = await dispatchReconciliationsForDay(sql, { businessDay: day.tradingDate })
    expect(before.every((summary) => summary.state === 'unreconciled')).toBe(true)

    // The retry lands. Every row for the second conversion is transmitted.
    await sql`
      update analytics_dispatch
         set state = 'sent', attempts = attempts + 1,
             transmitted_at = ${day.decidedAtIso}::timestamptz
       where event_id = ${eventIdFor(2, 'cc')} and state = 'queued'
    `
    await run()
    const after = await dispatchReconciliationsForDay(sql, { businessDay: day.tradingDate })
    for (const summary of after) {
      expect(summary.state).toBe('reconciled')
      expect(summary.missingCount).toBe(0)
      expect(summary.differenceFils).toBe(0)
      // The earlier `missing` item is GONE, which is what the delete-then-insert write is for: an upsert
      // would have left it behind and ZY471 would then refuse the whole write.
      expect(summary.items.filter((item) => item.classification === 'missing')).toHaveLength(0)
    }
  })
})

describe('a consent-denied conversion and a duplicate', () => {
  it("classifies a suppression 'intentionally_not_pushed' and does not count it as a discrepancy", async () => {
    const day = await closedDay(3)
    // A session granting ONLY analytics_storage: the advertising destination requires ad_user_data, so
    // 0125's gate writes the suppression and the push correctly never happens.
    const [visitor] = await sql<{ visitor_id: string }[]>`
      insert into analytics.visitor (first_seen_at, last_seen_at) values (now(), now())
      returning visitor_id
    `
    const visitorId = visitor?.visitor_id as string
    createdVisitors.push(visitorId)
    const [session] = await sql<{ session_id: string }[]>`
      insert into analytics.session (
        visitor_id, started_at, last_event_at, trading_date, trading_date_basis, landing_path,
        device_kind, breakpoint, bot,
        consent_ad_storage, consent_ad_user_data, consent_ad_personalization, consent_analytics_storage
      )
      select ${visitorId}::uuid, b.opens_at, b.opens_at, b.trading_date, 'trading', '/en/recon-denied',
             'desktop', 'lg', false, false, false, false, true
        from public.business_day b
       order by abs(extract(epoch from (b.opens_at - now())))
       limit 1
      returning session_id
    `
    const sessionId = session?.session_id as string
    const eventId = eventIdFor(1, 'dd')
    const { payload } = buildEgressPayload({
      ref: { kind: 'package_template' },
      eventType: TERMINAL,
      quantity: 1,
      valueFils: CONVERSION_FILS,
    })
    const suppressed = await enqueueAnalyticsDispatch(sql, {
      sessionId,
      destination: 'advertising_conversion_push',
      funnelStage: TERMINAL,
      decidedAtIso: day.decidedAtIso,
      eventId,
      payload: dispatchPayloadBytes(payload),
      actionSource: 'website',
      occurredAtIso: day.decidedAtIso,
    })
    expect(suppressed).toMatchObject({ state: 'suppressed', reason: 'consent_denied' })

    const result = await runDispatchReconciliationPass(sql, {
      businessDay: day.tradingDate,
      nowIso: day.ranAtIso,
      destinations: ['advertising_conversion_push'],
      resolveInternalTruth: () => [{ eventId, valueFils: CONVERSION_FILS }],
    })
    // RECONCILED: the conversion happened, the push correctly did not, and nothing is owed.
    expect(result.reconciled).toBe(1)
    expect(result.unreconciled).toBe(0)
    const [summary] = await dispatchReconciliationsForDay(sql, { businessDay: day.tradingDate })
    expect(summary?.state).toBe('reconciled')
    expect(summary?.missingCount).toBe(0)
    expect(summary?.intentionallyNotPushedCount).toBe(1)
    const item = summary?.items.find(
      (candidate) => candidate.classification === 'intentionally_not_pushed',
    )
    expect(item?.eventId).toBe(eventId)
    // The suppression NAMES the row that records it, which is the whole reason 0125 writes one.
    expect(item?.dispatchId).toBe(suppressed.dispatchId)
    expect(item?.valueFils).toBe(0)
  })

  it('stores a duplicate with BOTH row ids, and refuses one id written twice', async () => {
    /*
     * A duplicate is UNREACHABLE through this build's writer, and that is the index doing its job: 0137's
     * unique `(event_id, destination)` refuses a second row for the pair, whichever call site inserts it,
     * and `analytics-dispatch.itest.ts` asserts that. What A-MEAS-07 still has to be able to do is REPORT
     * the state — rows written before 0137 would not have had the index, and a reconciliation that could
     * not express a duplicate would answer `reconciled` about one.
     *
     * So the classification is proved pure in `reconciliation.test.ts`, over a pushed list containing two
     * rows for one event id, and what is proved HERE is the storage: both ids land, both resolve to real
     * dispatch rows, and the CHECK refuses one id written twice — which is one row reported as two.
     */
    const day = await closedDay(4)
    const sessionId = await grantingSession()
    const { payload } = buildEgressPayload({
      ref: { kind: 'package_template' },
      eventType: TERMINAL,
      quantity: 1,
      valueFils: CONVERSION_FILS,
    })
    const rows = await Promise.all(
      [1, 2].map(async (n) => {
        const enqueued = await enqueueAnalyticsDispatch(sql, {
          sessionId,
          destination: 'analytics_measurement_push',
          funnelStage: TERMINAL,
          decidedAtIso: day.decidedAtIso,
          eventId: eventIdFor(n, 'ee'),
          payload: dispatchPayloadBytes(payload),
          actionSource: 'website',
          occurredAtIso: day.decidedAtIso,
        })
        return enqueued.dispatchId
      }),
    )
    const [firstId, secondId] = rows as [string, string]

    // The index refuses a second row for the pair, which is why a duplicate cannot be built here.
    await expect(
      enqueueAnalyticsDispatch(sql, {
        sessionId,
        destination: 'analytics_measurement_push',
        funnelStage: TERMINAL,
        decidedAtIso: day.decidedAtIso,
        eventId: eventIdFor(1, 'ee'),
        payload: dispatchPayloadBytes(payload),
        actionSource: 'website',
        occurredAtIso: day.decidedAtIso,
      }),
    ).resolves.toMatchObject({ alreadyPresent: true, dispatchId: firstId })

    await writeDispatchReconciliation(sql, {
      summary: {
        businessDay: day.tradingDate,
        destination: 'analytics_measurement_push',
        internalCount: 1,
        pushedCount: 1,
        missingCount: 0,
        duplicateCount: 1,
        intentionallyNotPushedCount: 0,
        differenceFils: 0,
        state: 'unreconciled',
        ranAtIso: day.ranAtIso,
      },
      items: [
        {
          eventId: eventIdFor(1, 'ee'),
          classification: 'duplicate',
          dispatchId: firstId,
          otherDispatchId: secondId,
          valueFils: CONVERSION_FILS,
        },
      ],
    })
    const [summary] = await dispatchReconciliationsForDay(sql, { businessDay: day.tradingDate })
    const item = summary?.items.find((candidate) => candidate.classification === 'duplicate')
    expect(item?.dispatchId).toBe(firstId)
    expect(item?.otherDispatchId).toBe(secondId)
    expect(item?.dispatchId).not.toBe(item?.otherDispatchId)
    // The state is `unreconciled` even though the MONEY agrees, which is the duplicate's whole point: the
    // figure is right and the records are not.
    expect(summary?.state).toBe('unreconciled')
    expect(summary?.differenceFils).toBe(0)

    // And one id written twice is refused: "there is a duplicate" is not actionable, and one row reported
    // as two is worse than that — it is a second conversion that does not exist.
    await expect(
      writeDispatchReconciliation(sql, {
        summary: {
          businessDay: day.tradingDate,
          destination: 'analytics_measurement_push',
          internalCount: 1,
          pushedCount: 1,
          missingCount: 0,
          duplicateCount: 1,
          intentionallyNotPushedCount: 0,
          differenceFils: 0,
          state: 'unreconciled',
          ranAtIso: day.ranAtIso,
        },
        items: [
          {
            eventId: eventIdFor(1, 'ee'),
            classification: 'duplicate',
            dispatchId: firstId,
            otherDispatchId: firstId,
            valueFils: CONVERSION_FILS,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('the two refusals the database makes', () => {
  it('refuses a summary that disagrees with its own items (ZY471)', async () => {
    const day = await closedDay(5)
    await expect(
      writeDispatchReconciliation(sql, {
        summary: {
          businessDay: day.tradingDate,
          destination: 'analytics_measurement_push',
          internalCount: 1,
          pushedCount: 0,
          // The lie: a summary claiming a missing conversion with no item to name it. The panel renders
          // the COUNTS, so this is a screen showing a number the rows underneath it contradict.
          missingCount: 1,
          duplicateCount: 0,
          intentionallyNotPushedCount: 0,
          differenceFils: CONVERSION_FILS,
          state: 'unreconciled',
          ranAtIso: day.ranAtIso,
        },
        items: [],
      }),
    ).rejects.toSatisfy(
      (error: unknown) => dispatchReconciliationRefusalOf(error) === 'summary_disagrees_with_items',
    )
  })

  it('refuses a reconciliation for a day that had not closed (ZY472)', async () => {
    const [day] = await sql<{ trading_date: string; opens_at: Date }[]>`
      select trading_date::text as trading_date, opens_at
        from public.business_day
       order by opens_at desc
       limit 1
    `
    const tradingDate = day?.trading_date as string
    const opensAt = day?.opens_at as Date
    expect(tradingDate, 'the calendar must hold a day at all').toBeDefined()
    touchedDays.add(tradingDate)
    await expect(
      writeDispatchReconciliation(sql, {
        summary: {
          businessDay: tradingDate,
          destination: 'analytics_measurement_push',
          internalCount: 0,
          pushedCount: 0,
          missingCount: 0,
          duplicateCount: 0,
          intentionallyNotPushedCount: 0,
          differenceFils: 0,
          state: 'reconciled',
          // Inside the day, before it closes: a run that compares internal figures against dispatches the
          // consumer has not attempted yet and reports every one of them as missing.
          ranAtIso: opensAt.toISOString(),
        },
        items: [],
      }),
    ).rejects.toSatisfy(
      (error: unknown) => dispatchReconciliationRefusalOf(error) === 'day_has_not_closed',
    )
  })
})

describe('the refusals the pass makes rather than guessing', () => {
  it('writes NOTHING when this build has no internal truth, and counts that', async () => {
    const day = await closedDay(6)
    const result = await runDispatchReconciliationPass(sql, {
      businessDay: day.tradingDate,
      nowIso: day.ranAtIso,
      destinations: DISPATCH_DESTINATIONS,
      resolveInternalTruth: NO_INTERNAL_TRUTH_ON_FILE,
    })
    // A reconciliation written from an empty internal side would report every dispatch as a push with
    // nothing behind it — a screen saying the money does not add up, every morning, about a question
    // nobody has asked yet. A-FIRST-09 owns the rollups.
    expect(result.withoutInternalTruth).toBe(DISPATCH_DESTINATIONS.length)
    expect(result.reconciled).toBe(0)
    expect(result.unreconciled).toBe(0)
  })

  it('refuses a pass with no destinations, which would write nothing and report a clean day', async () => {
    const day = await closedDay(7)
    await expect(
      runDispatchReconciliationPass(sql, {
        businessDay: day.tradingDate,
        nowIso: day.ranAtIso,
        destinations: [],
        resolveInternalTruth: () => [],
      }),
    ).rejects.toThrow(/no destinations at all/)
  })

  it('refuses an instant where a business DATE belongs, in both the read and the write', async () => {
    await expect(
      pushedDispatchesForDay(sql, {
        businessDay: '2026-10-21T00:00:00.000Z',
        destination: 'analytics_measurement_push',
      }),
    ).rejects.toThrow(/not a YYYY-MM-DD date/)
    await expect(
      dispatchReconciliationsForDay(sql, { businessDay: '2026-10-21T00:00:00.000Z' }),
    ).rejects.toThrow(/not a YYYY-MM-DD date/)
  })
})

describe("the read finds the day's own dispatches and not another day's", () => {
  it('keys on the DECISION instant inside the trading window', async () => {
    const day = await closedDay(8)
    const { internal } = await enqueueAndTransmit({
      count: 1,
      sent: 1,
      prefix: 'ff',
      decidedAtIso: day.decidedAtIso,
    })
    const rows = await pushedDispatchesForDay(sql, {
      businessDay: day.tradingDate,
      destination: 'analytics_measurement_push',
    })
    const mine = rows.find((row) => row.eventId === internal[0]?.eventId)
    expect(mine, 'the read must find a dispatch decided inside the day').toBeDefined()
    expect(mine?.state).toBe('sent')
    // The figure comes off the STORED payload, which is the whole point of the comparison.
    expect(mine?.valueFils).toBe(CONVERSION_FILS)

    // And a different trading day does not see it, which is the control: a read with no window would
    // return every dispatch ever written and reconcile every day against all of them.
    const [other] = await sql<{ trading_date: string }[]>`
      select trading_date::text as trading_date
        from public.business_day
       where trading_date <> ${day.tradingDate}::date and closes_at <= now()
       order by closes_at desc
       limit 1
    `
    const elsewhere = await pushedDispatchesForDay(sql, {
      businessDay: other?.trading_date as string,
      destination: 'analytics_measurement_push',
    })
    expect(elsewhere.some((row) => row.eventId === internal[0]?.eventId)).toBe(false)
  })
})
