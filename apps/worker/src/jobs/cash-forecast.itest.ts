import { FORECAST_WEEKS, forecastFindings } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cronRegistrations, JOB_REGISTRY } from '../registry.ts'
import {
  buildCashForecastReport,
  CASH_FORECAST_AGENT,
  CASH_FORECAST_JOB,
  describeCashForecast,
} from './cash-forecast.ts'

/**
 * R-REP-06 — the weekly pass, driven end to end against real PostgreSQL.
 *
 * The arithmetic and the refusals are proved in `packages/core` and in
 * `packages/fixtures/src/cash-forecast.itest.ts`. What is left for this file is the three things a pure
 * test cannot reach, and each of them has been a real failure in some unit of this build:
 *
 *   1. **the pass composes.** `buildCashForecastReport` reads five sources, two settings and the chart,
 *      and a pure test of any of them says nothing about whether the composition runs at all. The first
 *      version of this module passed `ACCOUNTS.cashDrawer`, which does not exist — a name `pnpm
 *      typecheck` caught, and the next such name would not be caught by any suite that never calls this.
 *   2. **the log line survives a refusal.** Every figure this build can produce for the payroll line is
 *      `unattributable`, so `describeCashForecast` runs against an artefact whose closing cash has no
 *      `fils` field at all. A format string that reached for one would throw inside the handler, and the
 *      symptom would be a retried job rather than a reporting defect.
 *   3. **the cron has an agent row.** `apps/worker/src/job.ts` requires one on any job with a `cron`, and
 *      migration 0122 inserts it along with the heartbeat row the watchdog INNER JOINs to. An
 *      `agent_definition` with no `agent_heartbeat` is an agent the watchdog cannot see at all.
 *
 * Nothing here writes. The pass itself writes nothing either — the forecast is recomputed at read time
 * (ADR 0073) — so there is no teardown and the suite cannot leave a row behind.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
let asOf: string

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 2 })
  // A trading date the calendar actually holds, read rather than chosen: the pass takes `asOf` as an
  // argument precisely so this suite can hand it one, and a date with no `business_day` row would make
  // every figure empty for a reason that is not the unit's.
  const [row] = await sql<{ day: string }[]>`
    select max(trading_date)::text as day from business_day where trading_date <= current_date
  `
  asOf = row?.day ?? ''
  if (asOf === '') {
    throw new Error('business_day holds no trading date at or before today: run `pnpm seed`')
  }
}, 60_000)

afterAll(async () => {
  if (sql !== undefined) await sql.end({ timeout: 5 })
})

describe('the weekly cash-forecast pass', () => {
  it('composes the whole report from the database and the two provisional settings', async () => {
    const report = await buildCashForecastReport(sql, asOf)
    expect(report.asOf).toBe(asOf)
    expect(report.forecast.weeks).toHaveLength(FORECAST_WEEKS)
    expect(report.forecast.asOf).toBe(asOf)
    // The artefact articulates over the figures it has, refusals and all.
    expect(forecastFindings(report.forecast)).toEqual([])
    // Both halves are present: the forecast and the seasonality report that is published BESIDE it and
    // never multiplied into it.
    expect(report.seasonality).toHaveLength(3)
    expect(Object.keys(report.observance).sort()).toEqual(['confirmed', 'provisional'])
    // The caveat no input can remove.
    expect(report.forecast.caveats[0]).toContain('No figure here has been measured')
  }, 60_000)

  it('writes a log line that survives every figure being a refusal', async () => {
    const report = await buildCashForecastReport(sql, asOf)
    // Measured rather than assumed: the payroll line refuses against this build's own data, so this is
    // the state the log line has to be able to describe.
    expect(report.forecast.total.closingCash.state).toBe('unattributable')
    const line = describeCashForecast(report)
    expect(line).toContain(asOf)
    expect(line).toContain('closing cash UNATTRIBUTABLE')
    expect(line).toContain(`${FORECAST_WEEKS} week(s)`)
    // Every seasonality bucket is named with its state, so a bucket that stopped being measured is
    // visible beside one that never was.
    for (const entry of report.seasonality) expect(line).toContain(`${entry.bucket}=`)
    expect(line).not.toContain('undefined')
    expect(line).not.toContain('NaN')
  }, 60_000)

  it('is registered as a cron with an agent definition and a heartbeat row', async () => {
    const definition = JOB_REGISTRY.find((job) => job.name === CASH_FORECAST_JOB)
    expect(definition?.cron).toBe('37 4 * * 0')
    expect(definition?.agent).toBe(CASH_FORECAST_AGENT)
    expect(cronRegistrations().map((entry) => entry.name)).toContain(CASH_FORECAST_JOB)

    const [agent] = await sql<{ interval: number }[]>`
      select expected_interval_seconds as interval
        from agent_definition where agent_key = ${CASH_FORECAST_AGENT}
    `
    // Seven days, which is what makes the watchdog's "no success within twice the interval" mean two
    // Sundays with no forecast rather than a number the migration picked.
    expect(agent?.interval).toBe(60 * 60 * 24 * 7)
    const [heartbeat] = await sql<{ key: string }[]>`
      select agent_key as key from agent_heartbeat where agent_key = ${CASH_FORECAST_AGENT}
    `
    expect(heartbeat?.key).toBe(CASH_FORECAST_AGENT)
  }, 60_000)
})
