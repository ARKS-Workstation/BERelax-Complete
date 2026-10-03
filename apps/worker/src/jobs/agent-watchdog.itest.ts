import { DISPATCH_DESTINATIONS, dispatchPayloadBytes } from '@berelax/analytics'
import { buildEgressPayload, createRunBudget, type Instant, instantFromIso } from '@berelax/core'
import {
  agentsWithHeartbeat,
  createConnection,
  deadLetteredDispatches,
  enqueueAnalyticsDispatch,
  openAlerts,
  recordDispatchAttempt,
  type Sql,
  setEnabled,
  withAgentRun,
} from '@berelax/db'
import { assertSenderIdRegistry, PROMOTIONAL_SENDER_PREFIX } from '@berelax/messaging'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cronRegistrations, JOB_REGISTRY } from '../registry.ts'
import {
  AGENT_ALERT_MESSAGE_CLASS,
  agentAlertSenderIdentity,
  identityIsPromotional,
  runWatchdog,
} from './agent-watchdog.ts'

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
        -- The fourth field (0151). agent_heartbeat_next_run_accompanies_a_run pairs it to last_run_at
        -- in both directions, so a fixture that set one without the other is REFUSED — which is the
        -- constraint doing its job, and the small cost ADR 0066 records for any fixture that has to be
        -- consistent with the schema it writes into.
        next_run_at = ${NOW_ISO}::timestamptz + interval '1 day',
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
      -- next_run_at goes with last_run_at: the pair is held in both directions (0151), so a
      -- fixture resetting an agent to "has never run" has to clear both.
      set last_success_at = null, last_run_at = null, next_run_at = null, last_outcome = null
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

// ------------------------------------------------------------------------------------------------
// A-MEAS-06 — the fourth heartbeat field, the dead letter, and the alert's class
// ------------------------------------------------------------------------------------------------

/**
 * What this unit adds to the file, and what it deliberately does not.
 *
 * The 2x boundary, the disabled agent and the agent that has never succeeded are ALREADY proved above,
 * against the real table, by G-AGT-01 — and against `nightly_rollups`, which is one of the two agents
 * A-MEAS-06's acceptance line names. Restating those three cases for the second agent would be the same
 * claim asserted twice, so what is added is the half that is genuinely new: that BOTH analytics agents
 * are in the set the watchdog evaluates, and that the four heartbeat fields are written on the success
 * path and the failure path for each.
 *
 * `withAgentRun` is the writer under test in those two pairs rather than `recordHeartbeat`, because the
 * acceptance is about a RUN: the heartbeat must be written when the body throws, and a test that called
 * the writer directly would prove nothing about the wrapper that is supposed to call it either way.
 */
const ANALYTICS_AGENTS = ['analytics_dispatch', 'nightly_rollups'] as const

/** The SQLSTATE a statement raised, or `null` when it was accepted. `merge.itest.ts`' shape. */
async function sqlstateOfStatement(run: Promise<unknown>): Promise<string | null> {
  try {
    await run
    return null
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    return typeof code === 'string' ? code : null
  }
}

/** postgres.js exposes `savepoint` on a transaction and not on the pool. */
interface Savepointing {
  savepoint<T>(cb: (sp: Sql) => Promise<T>): Promise<T>
}

/**
 * The SQLSTATE a probing statement raised, inside a SAVEPOINT.
 *
 * Needed by every refusal proved inside a transaction, and its absence cost this file a run: ZY711 fired
 * exactly as intended, the transaction was then aborted, and the `select` that was supposed to show the
 * row still there failed as `25P02` — a failure that names nothing about the rule under test.
 */
async function refusedInSavepoint(
  tx: Sql,
  body: (sp: Sql) => Promise<unknown>,
): Promise<string | null> {
  try {
    await (tx as unknown as Savepointing).savepoint(async (sp) => {
      await body(sp)
    })
    return null
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    return typeof code === 'string' ? code : null
  }
}

const DEAD_LETTER_ROLLBACK = 'A-MEAS-06 rolled this dispatch fixture back'

/**
 * A queued dispatch, inside a transaction that is ROLLED BACK.
 *
 * The rollback is not tidiness: ZY711 refuses deleting a dead-lettered dispatch for every role including
 * the owner, which is the claim these cases are about — so a fixture that reached `dead_letter` on the
 * pool could never be removed, and every later run of this file would accumulate one. It is also what
 * makes `runWatchdog`'s alert row and the heartbeat it reads disappear with it.
 *
 * The session GRANTS every consent signal, because `dispatch_consent_gap` (0125, ZY312) refuses a row
 * reaching `queued` without them. That is the gate doing its job and is not what is under test here.
 */
async function withDispatchFixture<T>(
  body: (tx: Sql, dispatchId: string) => Promise<T>,
): Promise<T> {
  let carried: T | undefined
  try {
    await sql.begin(async (raw) => {
      const tx = raw as unknown as Sql
      const [visitor] = await tx<{ visitor_id: string }[]>`
        insert into analytics.visitor (first_seen_at, last_seen_at) values (now(), now())
        returning visitor_id::text as visitor_id
      `
      const [session] = await tx<{ session_id: string }[]>`
        insert into analytics.session (
          visitor_id, started_at, last_event_at, trading_date, trading_date_basis, landing_path,
          device_kind, breakpoint, bot,
          consent_ad_storage, consent_ad_user_data, consent_ad_personalization,
          consent_analytics_storage
        )
        select ${visitor?.visitor_id as string}::uuid, b.opens_at, b.opens_at, b.trading_date,
               'trading', '/en/dead-letter-fixture', 'desktop', 'lg', false, true, true, true, true
          from public.business_day b
         where b.closes_at <= now()
         order by b.closes_at desc
         limit 1
        returning session_id::text as session_id
      `
      const { payload } = buildEgressPayload({
        ref: { kind: 'package_template' },
        eventType: 'paid',
        quantity: 1,
        valueFils: 26_250,
      })
      const [day] = await tx<{ opens_at: Date }[]>`
        select opens_at from public.business_day where closes_at <= now()
         order by closes_at desc limit 1
      `
      if (day === undefined) {
        // Named rather than non-null-asserted: ZY702 and the gate both need a day that has CLOSED, and
        // `(day?.x as Date).getTime()` throws several frames from the query that actually found nothing.
        throw new Error('the trading calendar holds no day that has closed; run `pnpm seed`')
      }
      const decidedAtIso = new Date(day.opens_at.getTime() + 3_600_000).toISOString()
      const enqueued = await enqueueAnalyticsDispatch(tx, {
        sessionId: session?.session_id as string,
        // A real destination from `analytics_dispatch_destination`, not a provider's trade name: 0125
        // keys the gate on the CAPABILITY and `dispatch_consent_gap` refuses a destination with no row,
        // which is the refusal this fixture met when it was first written with 'ga4'.
        destination: DISPATCH_DESTINATIONS[0] as string,
        funnelStage: 'paid',
        decidedAtIso,
        eventId: `deadletter${Date.now().toString(16)}`,
        payload: dispatchPayloadBytes(payload),
        actionSource: 'website',
        occurredAtIso: decidedAtIso,
      })
      expect(enqueued.state, 'the fixture must have something queued').toBe('queued')
      carried = await body(tx, enqueued.dispatchId)
      throw new Error(DEAD_LETTER_ROLLBACK)
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== DEAD_LETTER_ROLLBACK) throw error
  }
  return carried as T
}

/** A run of `body` as `agentKey`, through the production wrapper. The budget is the agent's own. */
async function runAs(agentKey: string, atIso: string, body: () => Promise<void>) {
  return await withAgentRun(
    sql,
    { agentKey, startedAtIso: atIso },
    async () => {
      await body()
    },
    createRunBudget,
  )
}

async function heartbeatOf(agentKey: string) {
  const [row] = await sql<
    {
      last_run_at: Date | null
      last_success_at: Date | null
      next_run_at: Date | null
      last_error: string | null
      last_outcome: string | null
    }[]
  >`
    select last_run_at, last_success_at, next_run_at, last_error, last_outcome
      from agent_heartbeat where agent_key = ${agentKey}
  `
  return row
}

describe('A-MEAS-06 — both analytics agents write all four heartbeat fields', () => {
  it('on the SUCCESS path, for each of the two agents', async () => {
    for (const agentKey of ANALYTICS_AGENTS) {
      const at = new Date(NOW + HOUR).toISOString()
      const run = await runAs(agentKey, at, async () => {})
      expect(run.outcome, agentKey).toBe('succeeded')
      const beat = await heartbeatOf(agentKey)
      expect(beat?.last_run_at?.toISOString(), agentKey).toBe(at)
      expect(beat?.last_success_at?.toISOString(), agentKey).toBe(at)
      expect(beat?.last_error, agentKey).toBeNull()
      // The fourth field, and the figure it is derived from: the agent's OWN declared interval, which is
      // the same one the watchdog doubles. Asserted against `agent_definition` rather than against a
      // constant here, so a changed interval moves both or fails.
      const [definition] = await sql<{ expected_interval_seconds: number }[]>`
        select expected_interval_seconds from agent_definition where agent_key = ${agentKey}
      `
      expect(beat?.next_run_at?.getTime(), agentKey).toBe(
        Date.parse(at) + (definition?.expected_interval_seconds ?? 0) * 1000,
      )
    }
  })

  it('on the FAILURE path, for each of the two agents', async () => {
    for (const agentKey of ANALYTICS_AGENTS) {
      const at = new Date(NOW + 2 * HOUR).toISOString()
      const before = await heartbeatOf(agentKey)
      const run = await runAs(agentKey, at, async () => {
        throw new Error(`a deliberate failure in ${agentKey}`)
      })
      expect(run.outcome, agentKey).toBe('failed')
      const beat = await heartbeatOf(agentKey)
      // Written on failure as well, which is the whole point of the contract: a heartbeat that recorded
      // only successes cannot tell "running and failing every time" from "not running at all".
      expect(beat?.last_run_at?.toISOString(), agentKey).toBe(at)
      expect(beat?.last_error, agentKey).toContain('a deliberate failure')
      expect(beat?.last_outcome, agentKey).toBe('failed')
      expect(beat?.next_run_at, agentKey).not.toBeNull()
      // And the success instant did NOT move. The watchdog measures silence from it, so a failing pass
      // that advanced it would make a broken agent report healthy for ever.
      expect(beat?.last_success_at?.toISOString(), agentKey).toBe(
        before?.last_success_at?.toISOString(),
      )
    }
  })

  it('cannot record a run without saying when the next one is due', async () => {
    // The schema half of "all four fields on every run": the pair is held in both directions by
    // `agent_heartbeat_next_run_accompanies_a_run`, so a writer that forgot is REFUSED rather than
    // leaving a console unable to tell a slow agent from a stopped one. 23514 is the CHECK.
    const broken = await sqlstateOfStatement(sql`
      update agent_heartbeat
         set last_run_at = ${NOW_ISO}::timestamptz, next_run_at = null
       where agent_key = ${ANALYTICS_AGENTS[0]}
    `)
    expect(broken).toBe('23514')
  })

  it('has an agent_definition and an agent_heartbeat row for the offline upload (A-MEAS-05’s handover)', async () => {
    const agents = await agentsWithHeartbeat(sql)
    const offline = agents.find((agent) => agent.agentKey === 'offline_conversions')
    expect(
      offline,
      'A-MEAS-05 shared the consumer’s agent and handed the second one here by NOTE: the consumer ' +
        'beats every five minutes, so a shared heartbeat was never more than five minutes old however ' +
        'long the daily upload had been broken.',
    ).not.toBeUndefined()
    // A DAY, not five minutes. The whole point of the second agent is that the watchdog's 2x window is
    // measured against this pass's own cadence.
    expect(offline?.expectedIntervalSeconds).toBe(86_400)
    // `agentsWithHeartbeat` INNER JOINS, so finding it here IS the heartbeat row — 0107 shipped an agent
    // without one and nothing caught it until a suite read the table.
    expect(offline?.heartbeat.agentKey).toBe('offline_conversions')
  })
})

describe('A-MEAS-06 — the alert’s class, and the sender it can never leave from', () => {
  it('is transactional, and no configuration this build accepts lets it leave under AD-', () => {
    expect(AGENT_ALERT_MESSAGE_CLASS).toBe('transactional')
    const registry = assertSenderIdRegistry({
      transactional: { value: 'BERELAX', messageClass: 'transactional' },
      promotional: { value: `${PROMOTIONAL_SENDER_PREFIX}BERELAX`, messageClass: 'promotional' },
    })
    const resolved = agentAlertSenderIdentity(registry)
    expect(resolved.kind).toBe('identity')
    expect(identityIsPromotional(resolved)).toBe(false)
    // The control, and it is the one that makes this a check rather than a restatement: a registry whose
    // TRANSACTIONAL slot carries the promotional prefix is REFUSED at the point it is built, so there is
    // no configuration in which this alert leaves under an `AD-` sender — and `resolveSenderIdentity`
    // does not fall back to the other slot, which is the outcome `sender-identity.ts` exists to prevent.
    expect(() =>
      assertSenderIdRegistry({
        transactional: {
          value: `${PROMOTIONAL_SENDER_PREFIX}BERELAX`,
          messageClass: 'transactional',
        },
        promotional: { value: `${PROMOTIONAL_SENDER_PREFIX}ADS`, messageClass: 'promotional' },
      }),
    ).toThrow()
    // And there is no parameter for the CLASS: the function takes the registry and a channel, and the
    // channel has a default, so a call site cannot name the traffic's class at all.
    expect(agentAlertSenderIdentity.length).toBe(1)
  })
})

describe('A-MEAS-06 — the dead letter', () => {
  it('is what an exhausted retry budget produces, is listed by the console, and cannot be deleted', async () => {
    const seen = await withDispatchFixture(async (tx, dispatchId) => {
      // The LAST attempt the budget allows: `budgetExhausted` is what makes this `dead_letter` rather
      // than `failed`, and the two are different things to go and do — a failed row will be tried again
      // on its own and a dead letter will not be tried again by anybody.
      const recorded = await recordDispatchAttempt(tx, {
        dispatchId,
        outcome: 'failed',
        atIso: NOW_ISO,
        error: 'rate_limited at the last attempt the budget allows',
        retryable: false,
        budgetExhausted: true,
      })
      const listed = await deadLetteredDispatches(tx, { limit: 10 })
      const deleted = await refusedInSavepoint(
        tx,
        (sp) => sp`delete from analytics_dispatch where dispatch_id = ${dispatchId}::uuid`,
      )
      const stillThere = await tx<{ state: string }[]>`
        select state::text as state from analytics_dispatch where dispatch_id = ${dispatchId}::uuid
      `
      return { recorded, listed, deleted, stillThere }
    })
    expect(seen.recorded.state).toBe('dead_letter')
    expect(seen.recorded.attempts).toBe(1)
    // The provider's own last words are retained, which is the only record of WHY it will never go out —
    // and the table's CHECK makes it non-null for this state.
    const row = seen.listed.find((entry) => entry.lastError.includes('rate_limited'))
    expect(row, 'the dead letter must appear in the console query').not.toBeUndefined()
    // Never deleted, and that is the SCHEMA's claim rather than this test's: A-MEAS-07 reconciles against
    // what was pushed, so a deleted dead letter makes a conversion the platform never heard about
    // indistinguishable from one nobody enqueued — and the day would reconcile while the money was short.
    expect(seen.deleted).toBe('ZY711')
    expect(seen.stillThere[0]?.state).toBe('dead_letter')
  })

  it('is NOT what a refusal inside the budget produces — the control', async () => {
    const seen = await withDispatchFixture(async (tx, dispatchId) => {
      const recorded = await recordDispatchAttempt(tx, {
        dispatchId,
        outcome: 'failed',
        atIso: NOW_ISO,
        error: 'invalid_payload, inside the budget',
        retryable: false,
        budgetExhausted: false,
      })
      const deleted = await refusedInSavepoint(
        tx,
        (sp) => sp`delete from analytics_dispatch where dispatch_id = ${dispatchId}::uuid`,
      )
      return { recorded, deleted }
    })
    // `failed`, not `dead_letter`: the row is still inside its ladder and a later pass will try again.
    expect(seen.recorded.state).toBe('failed')
    // And a `failed` row IS deletable, so ZY711 is about the dead letter and not about the table.
    expect(seen.deleted).toBeNull()
  })

  it('is counted onto every alert the watchdog raises', async () => {
    const detail = await withDispatchFixture(async (tx, dispatchId) => {
      await recordDispatchAttempt(tx, {
        dispatchId,
        outcome: 'failed',
        atIso: NOW_ISO,
        error: 'rate_limited at the last attempt',
        retryable: false,
        budgetExhausted: true,
      })
      await tx`
        update agent_heartbeat
           set last_success_at = ${NOW_ISO}::timestamptz - interval '72 hours',
               last_run_at = ${NOW_ISO}::timestamptz - interval '72 hours',
               next_run_at = ${NOW_ISO}::timestamptz - interval '48 hours'
         where agent_key = ${'nightly_rollups'}
      `
      await tx`
        update agent_definition
           set enabled_since = ${NOW_ISO}::timestamptz - interval '90 days'
         where agent_key = ${'nightly_rollups'}
      `
      const result = await runWatchdog(tx, NOW)
      const [alert] = await tx<{ detail: Record<string, unknown> }[]>`
        select detail from agent_alert where agent_key = 'nightly_rollups'
      `
      return { result, alert }
    })
    expect(detail.result.deadLettered).toBeGreaterThan(0)
    // The count travels WITH the alert, so somebody woken about a silent agent is told in the same breath
    // how many conversions have given up — a queue nothing reads is the defect one level down.
    expect(detail.alert?.detail['deadLetteredDispatches']).toBe(detail.result.deadLettered)
    expect(detail.alert?.detail['nextRunAt']).not.toBeUndefined()
  })
})
