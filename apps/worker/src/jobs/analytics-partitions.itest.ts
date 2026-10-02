import { createConnection, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  countByAction,
  ensureAnalyticsPartitions,
  RETENTION_ACTIONS,
  runAnalyticsRetention,
} from './analytics-partitions.ts'

/**
 * A-FIRST-01's two passes as the WORKER calls them, against real PostgreSQL.
 *
 * `packages/db/src/analytics.itest.ts` proves the SQL: the partitions, the refusals, the retention window.
 * What only this file can prove is the seam between the two, and it holds one claim that nothing else can:
 * **`RETENTION_ACTIONS` is exactly the set of actions `analytics.run_retention` reports.**
 *
 * That pair matters because `countByAction` deliberately ignores an action it does not know — the
 * alternative, incrementing whatever key arrives, lets a typo in the SQL create a sixth count nobody reads
 * while the figure it was meant to be part of stays at zero. Ignoring is the right behaviour and it is also
 * how an action added in SQL alone becomes a figure that silently stops being logged. So the set is held
 * equal here, over a fixture that exercises EVERY branch of the pass, and an action added on either side
 * alone is a red test.
 *
 * Every case runs inside a transaction that is rolled back, for `analytics.itest.ts`'s reasons: the subject
 * is DDL, and a case that dropped a live partition would take the schema's ability to accept rows with it.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '') {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 2 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

const ROLLBACK = 'A-FIRST-01 rolled this fixture back'

/**
 * Runs `body` inside a transaction and rolls it back. `packages/db/src/analytics.itest.ts`'s helper, with
 * its reasoning: the marker is compared exactly so a genuine failure propagates rather than being swallowed
 * as an intended rollback, and the result is collected in an array whose length is CHECKED so a body that
 * never ran cannot be read as a passing case.
 */
async function rolledBack<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  const captured: T[] = []
  try {
    await sql.begin(async (tx) => {
      captured.push(await body(tx as unknown as Sql))
      throw new Error(ROLLBACK)
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error
  }
  if (captured.length !== 1) {
    throw new Error(
      `rolledBack captured ${captured.length} results and expected exactly 1, so the fixture body did ` +
        'not run to completion and whatever asserts next would be asserting on nothing.',
    )
  }
  return captured[0] as T
}

describe('ensureAnalyticsPartitions', () => {
  it('is idempotent, asserted against pg_catalog rather than by its return value', async () => {
    const outcome = await rolledBack(async (tx) => {
      const names = async (): Promise<readonly string[]> => {
        const rows = await tx<{ name: string }[]>`
          select c.relname as name
            from pg_inherits i join pg_class c on c.oid = i.inhrelid
           where i.inhparent in ('analytics.event'::regclass, 'analytics.funnel_step'::regclass)
           order by c.relname
        `
        return rows.map((r) => r.name)
      }
      const before = await names()
      // 12 months ahead, so the call certainly has something to create whatever the date and however
      // recently the cron last ran — the shipped look-ahead is 3 and would create nothing most days.
      const first = await ensureAnalyticsPartitions(tx, 12)
      const afterFirst = await names()
      const second = await ensureAnalyticsPartitions(tx, 12)
      const afterSecond = await names()
      return { before, afterFirst, afterSecond, first, second }
    })

    // The catalogue: the second call changed nothing. This is the assertion; the counts corroborate it.
    expect(outcome.afterSecond).toEqual(outcome.afterFirst)
    expect(outcome.afterFirst.length).toBeGreaterThan(outcome.before.length)
    // And the control that makes `second === 0` mean something: the first call DID create partitions, so a
    // function that never creates anything fails here rather than passing the idempotence assertion.
    expect(outcome.first).toBeGreaterThan(0)
    expect(outcome.second).toBe(0)
  })
})

describe('runAnalyticsRetention', () => {
  it('reports exactly the actions RETENTION_ACTIONS names, over a fixture that reaches every branch', async () => {
    const asOfMs = Date.now()
    const at = (daysAgo: number) => new Date(asOfMs - daysAgo * 86_400_000).toISOString()
    const report = await rolledBack(async (tx) => {
      // `dropped_partition` and `kept_partition`: one partition each side of the 90-day cutoff. Anchored on
      // the real clock so neither can overlap a live monthly partition, and so no live one falls due.
      await tx.unsafe(`
        create table analytics.event_worker_old partition of analytics.event
          for values from ('${at(92)}') to ('${at(91)}')
      `)
      await tx.unsafe(`
        create table analytics.event_worker_young partition of analytics.event
          for values from ('${at(90)}') to ('${at(89)}')
      `)
      // `purged_rows`: a visitor and a session past the window. The trading date has to be one the seed's
      // `business_day` table holds, because the session carries a real foreign key to it.
      // The trading date and the basis come from ONE query, because `analytics.session` carries both and
      // `analytics.assert_session_trading_basis` (ZY222) refuses a pair that disagree. Two things made the
      // old `max(trading_date)` wrong: A-FIRST-05 made `trading_date_basis` `not null`, so an insert
      // omitting it fails outright, and R-REP-05 reserved a far-future span in `business_day`, so `max`
      // stopped meaning "the newest day the salon trades" and started meaning a date in 2415. The day
      // nearest this session's own instant is what the row is actually about.
      const [day] = await tx<{ trading_date: string; basis: string }[]>`
        select to_char(trading_date, 'YYYY-MM-DD') as trading_date,
               case
                 when ${at(200)}::timestamptz >= opens_at and ${at(200)}::timestamptz < closes_at
                   then 'trading'
                 when ${at(200)}::timestamptz < opens_at then 'before_opening'
                 else 'after_closing'
               end as basis
          from business_day
         order by abs(extract(epoch from (opens_at - ${at(200)}::timestamptz)))
         limit 1
      `
      const [visitor] = await tx<{ visitor_id: string }[]>`
        insert into analytics.visitor (first_seen_at, last_seen_at)
        values (${at(200)}::timestamptz, ${at(200)}::timestamptz) returning visitor_id
      `
      await tx`
        insert into analytics.session
          (visitor_id, started_at, last_event_at, trading_date, trading_date_basis,
           landing_path, device_kind, breakpoint, bot)
        values (${visitor?.visitor_id as string}, ${at(200)}::timestamptz, ${at(200)}::timestamptz,
                ${day?.trading_date as string}, ${day?.basis as string},
                '/', 'mobile', 'sm', false)
      `
      // `exempt` and `guarded_default_partition` need no fixture: the rollups and the default partitions are
      // in the committed schema, which is the point of asserting them here rather than constructing them.
      return await runAnalyticsRetention(tx, new Date(asOfMs).toISOString())
    })

    const reported = [...new Set(report.map((row) => row.action))].sort()
    expect(
      reported,
      'the actions analytics.run_retention reports and RETENTION_ACTIONS must be the same set — an ' +
        'action added in SQL alone is a figure countByAction silently stops logging',
    ).toEqual([...RETENTION_ACTIONS].sort())

    // And the counts are all non-zero, which is what makes the set equality above evidence rather than a
    // coincidence: every branch of the pass was reached by this fixture.
    const counts = countByAction(report)
    for (const action of RETENTION_ACTIONS) {
      expect(
        counts[action],
        `${action} was never reported, so the set equality proves less`,
      ).toBeGreaterThan(0)
    }
    expect(report.length).toBe(Object.values(counts).reduce((total, n) => total + n, 0))
  })
})
