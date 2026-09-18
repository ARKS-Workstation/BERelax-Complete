import { createRunBudget, instantFromIso } from '@berelax/core'
import {
  agentsWithHeartbeat,
  createConnection,
  findAgent,
  openAlerts,
  raiseAlert,
  type Sql,
  setEnabled,
  setKillSwitch,
  withAgentRun,
} from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * G-AGT-01 — the heartbeat contract, against a real PostgreSQL.
 *
 * Every claim here is a claim about what survives: a heartbeat that outlives a throwing body, a partial
 * cost that outlives an aborted run, an alert that is not inserted twice. A mock would assert that the
 * mock works.
 *
 * It lives in `packages/fixtures` rather than beside the repository it exercises because it needs both
 * halves: `withAgentRun` from `@berelax/db` and `createRunBudget` from `@berelax/core`. `db` may not
 * import `core` — the dependency runs the other way and `pnpm boundaries` enforces it — and the pairing is
 * the thing under test: `withAgentRun` classifies an abort as `budget_exceeded` by recognising the error
 * the real budget throws, so a test that supplied its own budget would prove nothing about the pair.
 * `fixtures` may depend on both, which makes it the right home.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const NOW = instantFromIso(NOW_ISO)
const HOUR = 60 * 60 * 1000

let sql: Sql

/** The agent used for the write-path tests. Its heartbeat is reset before each one. */
const AGENT = 'nightly_rollups'

beforeAll(() => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
})

afterAll(async () => {
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql`delete from agent_alert`
  await sql`delete from agent_run`
  await sql`
    update agent_heartbeat
    set last_run_at = null, last_success_at = null, last_failure_at = null,
        last_error = null, last_outcome = null, consecutive_failures = 0
  `
  await sql`update agent_definition set enabled = true, kill_switch = false, enabled_since = now()`
})

async function heartbeat(agentKey = AGENT) {
  const all = await agentsWithHeartbeat(sql)
  const found = all.find((agent) => agent.agentKey === agentKey)
  if (found === undefined) throw new Error(`no agent ${agentKey}`)
  return found.heartbeat
}

async function runs(agentKey = AGENT) {
  return (await sql`
    select outcome, cost_fils::text as cost_fils, error
    from agent_run where agent_key = ${agentKey} order by started_at
  `) as unknown as { outcome: string; cost_fils: string; error: string | null }[]
}

describe('acceptance — the eight declared agents exist, and every cron has a row', () => {
  it('seeds every agent the manifest names', async () => {
    const keys = new Set((await agentsWithHeartbeat(sql)).map((agent) => agent.agentKey))
    for (const expected of [
      'seo_agent',
      'review_autoresponder',
      'reminder_scheduler',
      'campaign_sender',
      'analytics_dispatcher',
      'nightly_rollups',
      'compliance_calendar',
      'google_health',
    ]) {
      expect(keys.has(expected), `agent_definition is missing ${expected}`).toBe(true)
    }
  })

  it('gives every agent a heartbeat row, so the watchdog never skips one for want of a join', async () => {
    // `agentsWithHeartbeat` inner-joins. An agent with no heartbeat row would simply not appear, and an
    // agent that does not appear is an agent the watchdog silently never checks.
    const [row] = (await sql`
      select count(*)::int as n from agent_definition d
      where not exists (select 1 from agent_heartbeat h where h.agent_key = d.agent_key)
    `) as unknown as { n: number }[]
    expect(row?.n).toBe(0)
  })

  it('declares a positive interval and a non-negative budget for every agent', async () => {
    for (const agent of await agentsWithHeartbeat(sql)) {
      expect(agent.expectedIntervalSeconds, agent.agentKey).toBeGreaterThan(0)
      expect(agent.budgetFilsPerRun, agent.agentKey).toBeGreaterThanOrEqual(0)
      expect(agent.purpose.trim().length, agent.agentKey).toBeGreaterThan(0)
    }
  })
})

describe('acceptance — the heartbeat is written on failure as well as success', () => {
  it('moves last_run_at and records the error while leaving last_success_at alone', async () => {
    // This asymmetry is the contract. A heartbeat recording only successes cannot tell "running and
    // failing every time" from "not running at all", and those two want different people woken up.
    await withAgentRun(
      sql,
      { agentKey: AGENT, startedAtIso: NOW_ISO },
      async () => {
        throw new Error('the rollup query timed out')
      },
      createRunBudget,
    )

    const beat = await heartbeat()
    expect(beat.lastRunAt).toBe(NOW)
    expect(beat.lastSuccessAt).toBeUndefined()
    expect(beat.lastOutcome).toBe('failed')
    expect(beat.lastError).toContain('the rollup query timed out')
    expect(beat.consecutiveFailures).toBe(1)
    expect((await runs())[0]?.outcome).toBe('failed')
  })

  it('sets last_success_at, clears the error and resets the failure count on a success', async () => {
    await withAgentRun(
      sql,
      { agentKey: AGENT, startedAtIso: NOW_ISO },
      async () => {
        throw new Error('first attempt')
      },
      createRunBudget,
    )
    expect((await heartbeat()).consecutiveFailures).toBe(1)

    const later = new Date(NOW + HOUR).toISOString()
    await withAgentRun(
      sql,
      { agentKey: AGENT, startedAtIso: later },
      async () => {},
      createRunBudget,
    )

    const beat = await heartbeat()
    expect(beat.lastSuccessAt).toBe(instantFromIso(later))
    expect(beat.lastError).toBeUndefined()
    expect(beat.consecutiveFailures).toBe(0)
    expect(beat.lastOutcome).toBe('succeeded')
  })

  it('counts consecutive failures, which is how "failing every time" is told from "late once"', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await withAgentRun(
        sql,
        { agentKey: AGENT, startedAtIso: new Date(NOW + attempt * HOUR).toISOString() },
        async () => {
          throw new Error(`attempt ${attempt}`)
        },
        createRunBudget,
      )
    }
    expect((await heartbeat()).consecutiveFailures).toBe(3)
    expect(await runs()).toHaveLength(3)
  })

  it('records the run even though the body threw, because a transaction would have rolled it back', async () => {
    // The reason `withAgentRun` is deliberately not one transaction: the evidence must survive the
    // failure it is evidence of.
    await withAgentRun(
      sql,
      { agentKey: AGENT, startedAtIso: NOW_ISO },
      async () => {
        throw new Error('boom')
      },
      createRunBudget,
    )
    const rows = await runs()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.error).toContain('boom')
  })
})

describe('acceptance — the kill switch stops the body, and says so', () => {
  it('does not execute the body and records stopped_by_kill_switch', async () => {
    await setKillSwitch(sql, AGENT, true)
    let executions = 0
    const result = await withAgentRun(
      sql,
      { agentKey: AGENT, startedAtIso: NOW_ISO },
      async () => {
        executions += 1
      },
      createRunBudget,
    )

    expect(executions).toBe(0)
    expect(result.outcome).toBe('stopped_by_kill_switch')
    expect((await runs())[0]?.outcome).toBe('stopped_by_kill_switch')
    // Not an error. An operator who flipped this wants the work stopped, and a console showing a stack
    // trace would send somebody looking for a bug that does not exist.
    expect((await heartbeat()).lastError).toBeUndefined()
    expect((await heartbeat()).lastSuccessAt).toBeUndefined()
  })

  it('runs the body once the switch is off, so the counter is measuring the switch', async () => {
    // The control. Without it, a body that never ran for an unrelated reason would pass the test above.
    await setKillSwitch(sql, AGENT, true)
    let executions = 0
    const body = async () => {
      executions += 1
    }
    await withAgentRun(sql, { agentKey: AGENT, startedAtIso: NOW_ISO }, body, createRunBudget)
    expect(executions).toBe(0)

    await setKillSwitch(sql, AGENT, false)
    await withAgentRun(sql, { agentKey: AGENT, startedAtIso: NOW_ISO }, body, createRunBudget)
    expect(executions).toBe(1)
  })
})

describe('acceptance — the per-run budget aborts mid-run and keeps the partial cost', () => {
  it('stops the body, records budget_exceeded and persists what was spent', async () => {
    await sql`update agent_definition set budget_fils_per_run = 1000 where agent_key = ${AGENT}`
    let stepsCompleted = 0

    const result = await withAgentRun(
      sql,
      { agentKey: AGENT, startedAtIso: NOW_ISO },
      async (charge) => {
        charge(600)
        stepsCompleted += 1
        charge(300)
        stepsCompleted += 1
        // Over the cap. The body must not reach the line after this.
        charge(400)
        stepsCompleted += 1
      },
      createRunBudget,
    )

    expect(stepsCompleted).toBe(2)
    expect(result.outcome).toBe('budget_exceeded')
    // 900, not 1300. The refused charge is not counted, or the persisted figure would exceed the money
    // actually spent on the one row an auditor reads.
    expect(result.costFils).toBe(900)

    const [row] = await runs()
    expect(row?.outcome).toBe('budget_exceeded')
    expect(row?.cost_fils).toBe('900')
    expect((await heartbeat()).lastSuccessAt).toBeUndefined()
    await sql`update agent_definition set budget_fils_per_run = 0 where agent_key = ${AGENT}`
  })

  it('completes and records the full cost when the run stays inside its cap', async () => {
    await sql`update agent_definition set budget_fils_per_run = 1000 where agent_key = ${AGENT}`
    const result = await withAgentRun(
      sql,
      { agentKey: AGENT, startedAtIso: NOW_ISO },
      async (charge) => {
        charge(400)
        charge(400)
      },
      createRunBudget,
    )
    expect(result.outcome).toBe('succeeded')
    expect(result.costFils).toBe(800)
    expect((await heartbeat()).lastSuccessAt).toBe(NOW)
    await sql`update agent_definition set budget_fils_per_run = 0 where agent_key = ${AGENT}`
  })
})

describe('acceptance — an agent with no definition is refused rather than run unwatched', () => {
  it('throws, because an undeclared agent has no interval and no budget', async () => {
    await expect(
      withAgentRun(
        sql,
        { agentKey: 'not_an_agent', startedAtIso: NOW_ISO },
        async () => {},
        createRunBudget,
      ),
    ).rejects.toThrow(/No agent_definition row for 'not_an_agent'/)
    expect(await findAgent(sql, 'not_an_agent')).toBeUndefined()
  })
})

describe('acceptance — one alert per unbroken silence', () => {
  const incident = 'nightly_rollups:1758189600000'

  it('inserts the first alert and discards the second for the same incident', async () => {
    expect(
      await raiseAlert(sql, {
        agentKey: AGENT,
        incidentKey: incident,
        silentForSeconds: 180_000,
        raisedAtIso: NOW_ISO,
      }),
    ).toBe(true)

    // The second watchdog pass, fifteen minutes later, same silence.
    expect(
      await raiseAlert(sql, {
        agentKey: AGENT,
        incidentKey: incident,
        silentForSeconds: 180_900,
        raisedAtIso: new Date(NOW + 15 * 60 * 1000).toISOString(),
      }),
    ).toBe(false)

    expect(await openAlerts(sql)).toHaveLength(1)
  })

  it('inserts a new alert once the incident key changes', async () => {
    // The control: dedup by incident, not dedup forever. A second genuine outage must alert.
    await raiseAlert(sql, {
      agentKey: AGENT,
      incidentKey: incident,
      silentForSeconds: 100,
      raisedAtIso: NOW_ISO,
    })
    expect(
      await raiseAlert(sql, {
        agentKey: AGENT,
        incidentKey: 'nightly_rollups:1758999999999',
        silentForSeconds: 100,
        raisedAtIso: NOW_ISO,
      }),
    ).toBe(true)
    expect(await openAlerts(sql)).toHaveLength(2)
  })
})

describe('acceptance — re-enabling moves the clock, so no backdated alert is possible', () => {
  it('sets enabled_since when an agent goes from disabled to enabled', async () => {
    const disabledAt = new Date(NOW - 7 * 24 * HOUR).toISOString()
    await setEnabled(sql, AGENT, false, disabledAt)
    const before = await findAgent(sql, AGENT)
    expect(before?.enabled).toBe(false)

    await setEnabled(sql, AGENT, true, NOW_ISO)
    const after = await findAgent(sql, AGENT)
    expect(after?.enabled).toBe(true)
    expect(after?.enabledSince).toBe(NOW)
  })

  it('leaves enabled_since alone when an already-enabled agent is enabled again', async () => {
    // Otherwise an idempotent settings save would silently reset every agent's silence clock, and the
    // watchdog would report the whole system healthy for two intervals after any admin page was saved.
    const original = (await findAgent(sql, AGENT))?.enabledSince
    await setEnabled(sql, AGENT, true, new Date(NOW + HOUR).toISOString())
    expect((await findAgent(sql, AGENT))?.enabledSince).toBe(original)
  })
})
