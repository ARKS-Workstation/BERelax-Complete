import { type Instant, instantFromIso } from '@berelax/core'
import {
  agentsWithHeartbeat,
  createConnection,
  openAlerts,
  type Sql,
  setEnabled,
} from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cronRegistrations, JOB_REGISTRY } from '../registry.ts'
import { runWatchdog } from './agent-watchdog.ts'

/**
 * G-AGT-01 — the watchdog pass, and the registry-completeness check.
 *
 * The boundary cases are the ones worth having, and they are exactly the ones a unit test of the pure
 * function already covers. What this file adds is the two things that function cannot see: whether the
 * alert is actually one row rather than ninety-six, and whether every cron this system registers has an
 * agent to report to.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const NOW = instantFromIso(NOW_ISO)
const HOUR = 60 * 60 * 1000
const AGENT = 'nightly_rollups'

let sql: Sql

beforeAll(() => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
})

afterAll(async () => {
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql`delete from agent_alert`
  await sql`delete from agent_run`
  // Every agent succeeded a minute ago, so nothing is overdue unless a test makes it so. Without this
  // the watchdog would alert on all ten and every assertion below would be about the wrong agent.
  await sql`
    update agent_heartbeat
    set last_run_at = ${NOW_ISO}::timestamptz - interval '1 minute',
        last_success_at = ${NOW_ISO}::timestamptz - interval '1 minute',
        last_failure_at = null, last_error = null, last_outcome = 'succeeded', consecutive_failures = 0
  `
  await sql`
    update agent_definition
    set enabled = true, kill_switch = false,
        enabled_since = ${NOW_ISO}::timestamptz - interval '90 days'
  `
})

async function silentFor(milliseconds: number, agentKey = AGENT): Promise<void> {
  const at = new Date(NOW - milliseconds).toISOString()
  await sql`
    update agent_heartbeat set last_success_at = ${at}::timestamptz where agent_key = ${agentKey}
  `
}

/**
 * Marks every agent as having just succeeded, at the instant a test is about to treat as "now".
 *
 * Needed by any test that moves the clock forward: `beforeEach` sets every heartbeat relative to `NOW`,
 * so a pass evaluated two days after `NOW` finds all ten agents overdue and the assertion is no longer
 * about the one agent under test. Caught exactly that way.
 */
async function everyAgentHealthyAt(instant: Instant): Promise<void> {
  const at = new Date(instant - 60 * 1000).toISOString()
  await sql`update agent_heartbeat set last_success_at = ${at}::timestamptz, last_outcome = 'succeeded'`
}

describe('acceptance — the 2x boundary, against the real table', () => {
  it('raises nothing at 47h59m on a 24h interval', async () => {
    await silentFor(47 * HOUR + 59 * 60 * 1000)
    const result = await runWatchdog(sql, NOW)
    expect(result.overdue).toEqual([])
    expect(await openAlerts(sql)).toHaveLength(0)
    // And it did look: ten agents checked, none overdue.
    expect(result.checked).toBeGreaterThanOrEqual(9)
  })

  it('raises exactly one at 48h01m', async () => {
    await silentFor(48 * HOUR + 60 * 1000)
    const result = await runWatchdog(sql, NOW)
    expect(result.overdue).toEqual([AGENT])
    expect(result.raised).toEqual([AGENT])
    const alerts = await openAlerts(sql)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.agentKey).toBe(AGENT)
  })

  it('raises nothing further on a second pass in the same incident', async () => {
    await silentFor(48 * HOUR + 60 * 1000)
    await runWatchdog(sql, NOW)

    // Fifteen minutes later. Every other agent is marked healthy at that instant first: the dispatcher's
    // declared interval is five minutes, so at NOW+15m it is genuinely overdue and the assertion would
    // stop being about the agent under test. Caught exactly that way.
    const secondPass = (NOW + 15 * 60 * 1000) as Instant
    const stillSilent = new Date(NOW - (48 * HOUR + 60 * 1000)).toISOString()
    await everyAgentHealthyAt(secondPass)
    await sql`
      update agent_heartbeat set last_success_at = ${stillSilent}::timestamptz where agent_key = ${AGENT}
    `

    const second = await runWatchdog(sql, secondPass)
    // Still overdue — the agent has not recovered — but nothing new was inserted.
    expect(second.overdue).toEqual([AGENT])
    expect(second.raised).toEqual([])
    expect(await openAlerts(sql)).toHaveLength(1)
  })

  it('raises again once a success has landed and a new silence has grown', async () => {
    // The control for the deduplication. A watchdog that deduplicated forever would pass the test above
    // and then never report a second outage.
    await silentFor(48 * HOUR + 60 * 1000)
    await runWatchdog(sql, NOW)
    expect(await openAlerts(sql)).toHaveLength(1)

    const recovered = instantFromIso(new Date(NOW + HOUR).toISOString())
    const later = (recovered + 49 * HOUR) as Instant
    await everyAgentHealthyAt(later)
    await sql`
      update agent_heartbeat
      set last_success_at = ${new Date(recovered).toISOString()}::timestamptz
      where agent_key = ${AGENT}
    `

    const third = await runWatchdog(sql, later)
    expect(third.raised).toEqual([AGENT])
    expect(await openAlerts(sql)).toHaveLength(2)
  })

  it('records why it alerted, so the console can tell a failing agent from an absent one', async () => {
    // Two shapes of silence needing different action: `failed` means read a stack trace, null means
    // nothing has run at all — a cron that was never registered.
    await silentFor(72 * HOUR)
    await sql`
      update agent_heartbeat
      set last_outcome = 'failed', last_error = 'the rollup query timed out', consecutive_failures = 12
      where agent_key = ${AGENT}
    `
    await runWatchdog(sql, NOW)
    const [row] = (await sql`
      select detail from agent_alert where agent_key = ${AGENT}
    `) as unknown as { detail: Record<string, unknown> }[]
    expect(row?.detail['lastOutcome']).toBe('failed')
    expect(row?.detail['lastError']).toContain('timed out')
    expect(row?.detail['consecutiveFailures']).toBe(12)
  })
})

describe('acceptance — disabled, and re-enabled', () => {
  it('raises nothing for a disabled agent however long the silence', async () => {
    await silentFor(365 * 24 * HOUR)
    await setEnabled(sql, AGENT, false, new Date(NOW - 300 * 24 * HOUR).toISOString())
    const result = await runWatchdog(sql, NOW)
    expect(result.overdue).toEqual([])
    expect(result.disabled).toContain(AGENT)
    expect(await openAlerts(sql)).toHaveLength(0)
  })

  it('raises no backdated alert for the window it was switched off', async () => {
    // A week off, re-enabled a minute ago. Measured from the last success this is a week of silence, and
    // alerting on it means an alarm that fires the moment somebody finishes fixing something.
    await silentFor(7 * 24 * HOUR)
    await setEnabled(sql, AGENT, false, new Date(NOW - 7 * 24 * HOUR).toISOString())
    await setEnabled(sql, AGENT, true, new Date(NOW - 60 * 1000).toISOString())

    const result = await runWatchdog(sql, NOW)
    expect(result.overdue).toEqual([])
    expect(await openAlerts(sql)).toHaveLength(0)
  })

  it('alerts once the re-enabled agent has itself been silent for two intervals', async () => {
    // The control: re-enabling suppresses the backdated alert, not every future alert.
    await silentFor(7 * 24 * HOUR)
    await setEnabled(sql, AGENT, false, new Date(NOW - 7 * 24 * HOUR).toISOString())
    await setEnabled(sql, AGENT, true, new Date(NOW - 72 * HOUR).toISOString())

    const result = await runWatchdog(sql, NOW)
    expect(result.overdue).toEqual([AGENT])
  })
})

describe('acceptance — an agent that has never succeeded is not mistaken for a healthy one', () => {
  it('alerts on a null last_success_at once two intervals have passed since it was enabled', async () => {
    // The failure this catches: an agent added in a deploy whose cron was never registered. A watchdog
    // that skipped rows with a null last_success_at would report the whole system healthy on exactly the
    // day a new agent was silently never scheduled.
    await sql`
      update agent_heartbeat
      set last_success_at = null, last_run_at = null, last_outcome = null
      where agent_key = ${AGENT}
    `
    await sql`
      update agent_definition
      set enabled_since = ${NOW_ISO}::timestamptz - interval '72 hours'
      where agent_key = ${AGENT}
    `
    expect((await runWatchdog(sql, NOW)).overdue).toEqual([AGENT])
  })
})

describe('acceptance — registry completeness: every cron has an agent_definition row', () => {
  it('finds a row for every registered cron, naming any that is missing', async () => {
    const keys = new Set((await agentsWithHeartbeat(sql)).map((agent) => agent.agentKey))
    const missing = cronRegistrations(JOB_REGISTRY)
      .filter((cron) => cron.agent === undefined || !keys.has(cron.agent))
      .map((cron) => `${cron.name} -> ${cron.agent ?? '(none declared)'}`)

    expect(missing, `cron(s) with no agent_definition row: ${missing.join(', ')}`).toEqual([])
    // And it did look at something. An empty registry would satisfy the filter above vacuously.
    expect(cronRegistrations(JOB_REGISTRY).length).toBeGreaterThan(0)
  })

  it('would name a cron whose agent does not exist', () => {
    // The control, in the same shape as the check above. A completeness test that could not fail is the
    // ADR 0003 failure in the gate that exists to prevent it.
    const keys = new Set(['audit_partitions'])
    const fabricated = [{ name: 'seo.weekly-report', cron: '0 6 * * 1', agent: 'not_an_agent' }]
    const missing = fabricated
      .filter((cron) => !keys.has(cron.agent))
      .map((cron) => `${cron.name} -> ${cron.agent}`)
    expect(missing).toEqual(['seo.weekly-report -> not_an_agent'])
  })

  it('has a row for the watchdog itself, which is the one failure it cannot report', async () => {
    const keys = new Set((await agentsWithHeartbeat(sql)).map((agent) => agent.agentKey))
    expect(keys.has('agent_watchdog')).toBe(true)
  })
})
