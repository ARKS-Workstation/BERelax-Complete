import { createConnection, recordSupplier, type Sql, withUnitOfWork } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cronRegistrations, JOB_REGISTRY } from '../registry.ts'
import {
  REVERSE_CHARGE_LOOK_BACK_MONTHS,
  REVERSE_CHARGE_REPORT_EVENT,
  runReverseChargeExceptionReport,
} from './reverse-charge-exceptions.ts'

/**
 * M-VAT-03 — the nightly pass, driven end to end against real PostgreSQL.
 *
 * Two properties can only be proved by running the job twice against a database, and they are the two the
 * acceptance is about:
 *
 *   1. **Two runs over the same period produce identical output.** The report accumulates nothing, so this is
 *      a property of the query's ordering and of the window being derived from the trading calendar rather
 *      than from a clock.
 *   2. **An outbox event is written even when the report is empty**, and the second run of the same day
 *      writes none — the *database* deduplicates by idempotency key, not the job's memory of what it did.
 *
 * The exceptions themselves are `packages/fixtures/src/reverse-charge.itest.ts`'s: it owns the bills, the
 * worked example and the misclassified supplier. What is proved here is the pass — the business day it scans
 * up to, the window it derives, the event it writes, and that it writes one when there is nothing to say.
 *
 * Every row this file writes is scoped to the run, because the integration suite runs sequentially against one
 * database and `outbox_event` is append-only. The window is deliberately chosen in a month no other file
 * posts into, so "the report is empty" is an assertion about this file's own data rather than about whatever
 * ran before it.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const ACTOR = { kind: 'system', label: 'reverse-charge-exceptions-itest' } as const
const RUN = Date.now().toString(36)

/**
 * 04:15 on 9 June 2028, Gulf time — the cron's own hour, and the case that makes reading the trading calendar
 * load-bearing. Trading closed at 02:00, so this instant belongs to the **8th**: a calendar truncation would
 * scan up to the 9th, and at a month boundary into a period already filed.
 *
 * 2028 rather than 2027, and the year is load-bearing. This file asserts an **empty** report, and the pass
 * scans twelve months back — so the window has to start after every bill any other file in this suite posts.
 * `packages/fixtures/src/reverse-charge.itest.ts` owns March 2027 and deliberately leaves a missing pair and
 * a broken ledger there; a window opening in June 2027 excludes both. Choosing 2027 here instead put those
 * rows inside the window and the empty-report assertion failed, which is the isolation trap
 * `docs/CONTRIBUTING-AGENT-BRIEF.md` rule 12 describes.
 */
const AT_ISO = '2028-06-09T04:15:00+04:00'
const EXPECTED_AS_OF = '2028-06-08'
/** Twelve months back from the business day, clamped. What `REVERSE_CHARGE_LOOK_BACK_MONTHS` produces. */
const EXPECTED_FROM = '2027-06-08'

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })

  // The trading session the pass must resolve to. `on conflict do nothing` rather than
  // `generateBusinessDays`, which deletes rows inside its horizon that it did not generate — and other files
  // in this suite own business_day rows. 2028-06-08 is outside the 400-day horizon those files generate.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source) values
      ('2028-06-08', '2028-06-08T07:00:00Z', '2028-06-08T22:00:00Z', 'weekly')
    on conflict (trading_date) do nothing
  `

  // One offshore supplier that owes the reverse charge and has no bills in the window. It makes the empty
  // report mean something: a report that scanned nothing because the supplier population was empty would
  // satisfy "the report is empty" without the query having worked at all.
  await withUnitOfWork(sql, ACTOR, (uow) =>
    recordSupplier(uow, {
      code: `itest-rcx-cloud-${RUN}`,
      legalName: 'FIXTURE (not a real supplier) — offshore cloud hosting',
      residency: 'offshore',
      placeOfSupplyRule: 'imported_services_reverse_charge',
      trn: null,
    }),
  )
}, 120_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

async function eventsFor(asOf: string) {
  return (await sql`
    select id::text as id, payload
      from outbox_event
     where event_type = ${REVERSE_CHARGE_REPORT_EVENT}
       and idempotency_key = ${`${REVERSE_CHARGE_REPORT_EVENT}:${asOf}`}
     order by occurred_at
  `) as unknown as { id: string; payload: Record<string, unknown> }[]
}

describe('acceptance — the pass dates itself on the business day and derives its window', () => {
  it('resolves the trading session that has just closed, not the calendar date of the clock', async () => {
    const result = await runReverseChargeExceptionReport(sql, AT_ISO)
    // 04:15 on the 9th belongs to the 8th's session, because trading runs 11:00–02:00.
    expect(result.asOf).toBe(EXPECTED_AS_OF)
    expect(result.from).toBe(EXPECTED_FROM)
    expect(REVERSE_CHARGE_LOOK_BACK_MONTHS).toBe(12)
    // The control: the window is not the calendar date of `AT_ISO`, which is what a truncated timestamp
    // would have produced.
    expect(result.asOf).not.toBe('2028-06-09')
  })

  it('refuses rather than guessing when the trading calendar holds nothing before the instant', async () => {
    // Before `business_day` starts, so there is no session to date the scan on. A pass that fell back to the
    // calendar date would scan a window nobody could reconcile to a VAT period.
    await expect(runReverseChargeExceptionReport(sql, '2019-01-01T04:15:00+04:00')).rejects.toThrow(
      /no trading session at or before it/,
    )
  })
})

describe('acceptance — an empty report is evidence, and a second pass is not a second event', () => {
  it('writes an outbox event on a pass that finds nothing, carrying the count and the window', async () => {
    const result = await runReverseChargeExceptionReport(sql, AT_ISO)
    // Empty, because no bill in this window is missing a pair — and the offshore supplier created above is in
    // the population the scan reads, so the query did run over something.
    expect(result.exceptions).toEqual([])
    const events = await eventsFor(EXPECTED_AS_OF)
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({
      from: EXPECTED_FROM,
      to: EXPECTED_AS_OF,
      exceptionCount: 0,
      bills: [],
    })
    // The point of the row: "0 exceptions over this window" is a statement somebody can read. A job that
    // published only on failure would be indistinguishable from a job that had stopped running.
    expect(events[0]?.payload['exceptionCount']).toBe(0)
  })

  it('produces identical output on a second pass, and writes no second event', async () => {
    const first = await runReverseChargeExceptionReport(sql, AT_ISO)
    const second = await runReverseChargeExceptionReport(sql, AT_ISO)
    // Identical, field for field. The report is derived rather than accumulated, so this is a property of the
    // query rather than of the job remembering anything.
    expect(second.asOf).toBe(first.asOf)
    expect(second.from).toBe(first.from)
    expect(second.exceptions).toEqual(first.exceptions)

    // And exactly one event for the day, however many times the pass runs. The unique index on the
    // idempotency key is what enforces that — a job tracking "already reported" in its own state would
    // publish a second copy the first time that state was lost.
    expect(await eventsFor(EXPECTED_AS_OF)).toHaveLength(1)
    expect(second.eventId).toBeNull()
  })
})

describe('acceptance — the cron is declared in the registry and names an agent with a heartbeat', () => {
  it('declares one nightly cron for the report, after the recurring-cost pass', () => {
    const crons = cronRegistrations(JOB_REGISTRY)
    const mine = crons.find((cron) => cron.name === 'vat.reverse-charge-exceptions')
    expect(mine?.cron).toBe('15 4 * * *')
    expect(mine?.agent).toBe('reverse_charge_exceptions')
    // After `recurring-cost.check` at 03:45, and the order is load-bearing: that pass can post a recurring
    // offshore bill, and a report run before it would miss the bill it had just created and wait a day.
    const recurring = crons.find((cron) => cron.name === 'recurring-cost.check')
    expect(recurring?.cron).toBe('45 3 * * *')
    expect(mine?.agent).not.toBe(recurring?.agent)
  })

  it('has an agent_definition row AND an agent_heartbeat row, because the watchdog inner-joins', async () => {
    const rows = (await sql`
      select d.agent_key, d.expected_interval_seconds,
             (h.agent_key is not null) as has_heartbeat
        from agent_definition d
        left join agent_heartbeat h on h.agent_key = d.agent_key
       where d.agent_key = 'reverse_charge_exceptions'
    `) as unknown as {
      agent_key: string
      expected_interval_seconds: number
      has_heartbeat: boolean
    }[]
    expect(rows).toHaveLength(1)
    // `agentsWithHeartbeat` INNER joins, so an agent with no heartbeat row does not appear — and an agent that
    // does not appear is one the watchdog silently never checks.
    expect(rows[0]?.has_heartbeat).toBe(true)
    // A day, so the watchdog alerts after two missed passes rather than after one late one.
    expect(rows[0]?.expected_interval_seconds).toBe(86_400)
  })
})
