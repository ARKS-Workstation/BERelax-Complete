import { generateKek } from '@berelax/clinical'
import { fixedClock, type Instant, instantFromIso } from '@berelax/core'
import { agentsWithHeartbeat, createConnection, openAlerts, type Sql } from '@berelax/db'
import {
  createPostgresConnectionStore,
  createPostgresRefreshLock,
  type HealthCheckDeps,
  type LivenessDeps,
  type SealedToken,
} from '@berelax/google'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  createFakeSearchConsole,
  SEARCH_CONSOLE_SITE_FIXTURES,
} from '@berelax/providers/google'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runWatchdog } from './agent-watchdog.ts'
import {
  GBP_ACCESS_SETTING,
  GOOGLE_HEALTH_AGENT,
  GOOGLE_LIVENESS_AGENT,
  googleHealthSettings,
  PUBLISHING_STATUS_SETTING,
  runGoogleHealthCheck,
  runGoogleLiveness,
} from './google-connection-health.ts'

/**
 * G-CONN-06 — the heartbeat contract, end to end on a frozen clock.
 *
 * The acceptance line this file exists for: *the run writes an agent heartbeat through G-AGT-01, so a
 * missed daily check is caught by the watchdog at 48h.* That is three separate things that can each be
 * true without the others, so each is asserted:
 *
 *  1. the pass writes the heartbeat and an `agent_run` row, whatever the body did;
 *  2. the watchdog is silent at 47h59m and alerts at 48h01m — the boundary, from both sides;
 *  3. **the hourly probe's heartbeat is a different heartbeat.** This is the one that would otherwise go
 *     unnoticed: if both crons reported to `google_health`, the hourly pass would keep it minutes old for
 *     ever and a daily check that had stopped running entirely would be invisible. Migration 0033 exists
 *     for it, and here it is proved by running only the probe and asserting the deep check's silence grows.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const KEK = generateKek('v1')
/**
 * A sealed-token shape that will never open, built by hand.
 *
 * `sealToken` lives behind the chokepoint: only the five modules inside `packages/google` may name it, and
 * this file is not one of them (`google-tokens-only-in-with-google`, plus the identifier rule in
 * `scripts/check-google-token-chokepoint.mjs`). `SealedToken` is a *type* — five columns, decrypting
 * nothing — so a value of that shape can be constructed here, and what comes of it is a token the pass
 * cannot open. That is not a limitation of this file, it is the test it can uniquely make: a pass that
 * aborted on one unreadable connection would leave no heartbeat at all, and the watchdog would then alert
 * two days later for the wrong reason. Every claim needing a token that DOES open lives in
 * `packages/google/src/google-health.itest.ts`, inside the boundary that may seal one.
 */
const UNOPENABLE_TOKEN: SealedToken = {
  ct: Buffer.from([0]),
  nonce: Buffer.from([0]),
  wrappedKey: Buffer.from([0]),
  kid: 'v1',
  aadFingerprint: 'not-a-real-fingerprint',
}
const NOW_ISO = '2026-09-19T03:00:00.000Z'
const NOW = instantFromIso(NOW_ISO)
const HOUR = 60 * 60 * 1000
const SUB = 'sub-worker-google-health'

let sql: Sql
let store: ReturnType<typeof createPostgresConnectionStore>

beforeAll(() => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  store = createPostgresConnectionStore(sql)
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  // Only this file's own agents, so the watchdog suite's fixtures and the recurring-cost register's are
  // left alone. Deleting every alert would make the assertions below depend on file order.
  await sql`
    delete from agent_alert where agent_key in (${GOOGLE_HEALTH_AGENT}, ${GOOGLE_LIVENESS_AGENT})
  `
  await sql`
    delete from agent_run where agent_key in (${GOOGLE_HEALTH_AGENT}, ${GOOGLE_LIVENESS_AGENT})
  `
  // Every agent succeeded a minute ago, so nothing is overdue unless a test makes it so — the same
  // precaution `agent-watchdog.itest.ts` records, and for the same reason: without it the watchdog alerts
  // on all twelve and no assertion below is about the agent under test.
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
  // `withGoogle` resolves from the capability across every connection that is not disconnected, so this
  // file narrows what the pass can see rather than deleting rows a foreign key protects:
  // `google_reviews.connection_id` is ON DELETE RESTRICT.
  await sql`update google_connections set status = 'disconnected' where google_sub <> ${SUB}`
  await sql`delete from google_connections where google_sub = ${SUB}`
})

/** Marks every agent as having just succeeded at an instant a test is about to treat as "now". */
async function everyAgentHealthyAt(instant: Instant): Promise<void> {
  const at = new Date(instant - 60 * 1000).toISOString()
  await sql`update agent_heartbeat set last_success_at = ${at}::timestamptz, last_outcome = 'succeeded'`
}

async function seedConnection(): Promise<string> {
  const id = await store.allocateId()
  await store.insert({
    id,
    googleSub: SUB,
    googleEmail: 'google-admin@berelax.ae',
    grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    refreshToken: UNOPENABLE_TOKEN,
    consentAt: instantFromIso('2026-09-18T14:00:00.000Z'),
  })
  await store.upsertCapability({
    connectionId: id,
    capability: 'gsc',
    resourceRef: { siteUrl: SEARCH_CONSOLE_SITE_FIXTURES[0]?.siteUrl ?? '' },
    health: 'unknown',
    isPrimary: true,
  })
  return id
}

function fakes(atIso: string) {
  const log = createCallLog(() => atIso)
  const failures = new FailureScript()
  return {
    oauth: createFakeGoogleOAuth({
      log,
      failures: new FailureScript(),
      now: () => atIso,
      sub: SUB,
    }),
    profile: createFakeBusinessProfile({ log, failures, now: () => atIso }),
    searchConsole: createFakeSearchConsole({ log, failures, now: () => atIso }),
  }
}

function deepDeps(atIso: string): HealthCheckDeps {
  const fake = fakes(atIso)
  return {
    google: {
      store,
      oauth: fake.oauth,
      kek: KEK,
      clock: fixedClock(atIso),
      lock: createPostgresRefreshLock(sql),
      logger: { log: () => {} },
    },
    health: store,
    profile: fake.profile,
    searchConsole: fake.searchConsole,
    publishingStatus: 'production',
    gbpAccessGranted: false,
  }
}

function livenessDepsFor(atIso: string): LivenessDeps {
  const fake = fakes(atIso)
  return {
    google: {
      store,
      oauth: fake.oauth,
      kek: KEK,
      clock: fixedClock(atIso),
      lock: createPostgresRefreshLock(sql),
      logger: { log: () => {} },
    },
    health: store,
    profile: fake.profile,
    searchConsole: fake.searchConsole,
  }
}

async function heartbeat(agentKey: string): Promise<{ lastSuccessAt: number | undefined }> {
  const agents = await agentsWithHeartbeat(sql)
  const agent = agents.find((candidate) => candidate.agentKey === agentKey)
  if (agent === undefined) throw new Error(`no agent_definition row for ${agentKey}`)
  return { lastSuccessAt: agent.heartbeat.lastSuccessAt }
}

describe('acceptance — both agents exist, with a heartbeat each', () => {
  it('finds a definition and a heartbeat for the deep check and the liveness probe', async () => {
    // `agentsWithHeartbeat` INNER joins, so an agent with no heartbeat row is one the watchdog silently
    // never checks. Asserting presence in the joined view is the only way to see the difference.
    const keys = new Set((await agentsWithHeartbeat(sql)).map((agent) => agent.agentKey))
    expect(keys.has(GOOGLE_HEALTH_AGENT)).toBe(true)
    expect(keys.has(GOOGLE_LIVENESS_AGENT)).toBe(true)
  })

  it('declares a 24h interval for the deep check and 1h for the probe', async () => {
    const agents = await agentsWithHeartbeat(sql)
    const byKey = new Map(agents.map((agent) => [agent.agentKey, agent.expectedIntervalSeconds]))
    // The intervals are what set the watchdog's two thresholds: 48h and 2h.
    expect(byKey.get(GOOGLE_HEALTH_AGENT)).toBe(24 * 60 * 60)
    expect(byKey.get(GOOGLE_LIVENESS_AGENT)).toBe(60 * 60)
  })
})

describe('acceptance — the run writes a heartbeat, and the watchdog catches a missed pass at 48h', () => {
  it('records a succeeded run and moves last_success_at', async () => {
    // No connection, deliberately. This file owns the heartbeat contract and cannot seal a token — every
    // claim that needs a token which opens lives in `packages/google/src/google-health.itest.ts`, inside
    // the boundary that may seal one. A pass over zero connections is still the real pass through the real
    // `withAgentRun`, which is what the acceptance line is about.
    const result = await runGoogleHealthCheck(sql, deepDeps(NOW_ISO), NOW_ISO, { jobId: 'job-1' })
    expect(result.connections).toEqual([])

    expect((await heartbeat(GOOGLE_HEALTH_AGENT)).lastSuccessAt).toBe(NOW)
    const [run] = (await sql`
      select outcome, job_id, cost_fils::text as cost from agent_run
      where agent_key = ${GOOGLE_HEALTH_AGENT} order by started_at desc limit 1
    `) as unknown as { outcome: string; job_id: string | null; cost: string }[]
    expect(run?.outcome).toBe('succeeded')
    expect(run?.job_id).toBe('job-1')
    // Zero fils: this pass calls Google and writes rows, and nothing in it calls a model.
    expect(run?.cost).toBe('0')
  }, 60_000)

  it('raises nothing at 47h59m and exactly one alert at 48h01m', async () => {
    await runGoogleHealthCheck(sql, deepDeps(NOW_ISO), NOW_ISO)

    const justBefore = (NOW + 47 * HOUR + 59 * 60 * 1000) as Instant
    await everyAgentHealthyAt(justBefore)
    await sql`
      update agent_heartbeat set last_success_at = ${NOW_ISO}::timestamptz
      where agent_key = ${GOOGLE_HEALTH_AGENT}
    `
    const silent = await runWatchdog(sql, justBefore)
    expect(silent.overdue).not.toContain(GOOGLE_HEALTH_AGENT)

    const justAfter = (NOW + 48 * HOUR + 60 * 1000) as Instant
    await everyAgentHealthyAt(justAfter)
    await sql`
      update agent_heartbeat set last_success_at = ${NOW_ISO}::timestamptz
      where agent_key = ${GOOGLE_HEALTH_AGENT}
    `
    const overdue = await runWatchdog(sql, justAfter)
    expect(overdue.overdue).toContain(GOOGLE_HEALTH_AGENT)
    expect(overdue.raised).toContain(GOOGLE_HEALTH_AGENT)
    const alerts = (await openAlerts(sql)).filter((alert) => alert.agentKey === GOOGLE_HEALTH_AGENT)
    expect(alerts).toHaveLength(1)
  }, 60_000)

  it('does not abort on a connection it cannot read, and asks the queue to try again', async () => {
    // The pass's product is the record, not the read. A connection whose stored token cannot be opened
    // classifies as a transient upstream failure — `withGoogle` THROWS for that class, so a pass that let
    // it propagate would abandon every connection after it and leave no summary row at all. Here the pass
    // completes, the heartbeat is written, the run is `succeeded` because it did its job, and the throw
    // that follows is purely the queue's retry signal.
    await seedConnection()
    await expect(runGoogleHealthCheck(sql, deepDeps(NOW_ISO), NOW_ISO)).rejects.toThrow(
      /queue being asked to try again/,
    )
    expect((await heartbeat(GOOGLE_HEALTH_AGENT)).lastSuccessAt).toBe(NOW)
    const [run] = (await sql`
      select outcome from agent_run where agent_key = ${GOOGLE_HEALTH_AGENT}
      order by started_at desc limit 1
    `) as unknown as { outcome: string }[]
    expect(run?.outcome).toBe('succeeded')
  }, 60_000)

  it('records a failed run and does NOT move last_success_at when the pass throws', async () => {
    // The other half of the heartbeat contract, and the reason it is written outside a transaction: a
    // heartbeat that only recorded successes cannot tell "running and failing every time" from "not
    // running at all", and those two want different people woken up.
    const broken = deepDeps(NOW_ISO)
    await expect(
      runGoogleHealthCheck(
        sql,
        {
          ...broken,
          // A store that cannot be read at all: the pass throws before it writes anything.
          health: {
            ...broken.health,
            listAll: async () => {
              throw new Error('the database went away mid-pass')
            },
          },
        },
        NOW_ISO,
      ),
    ).rejects.toThrow(/health check failed/)

    expect((await heartbeat(GOOGLE_HEALTH_AGENT)).lastSuccessAt).not.toBe(NOW)
    const [run] = (await sql`
      select outcome, error from agent_run where agent_key = ${GOOGLE_HEALTH_AGENT}
      order by started_at desc limit 1
    `) as unknown as { outcome: string; error: string | null }[]
    expect(run?.outcome).toBe('failed')
    expect(run?.error).toContain('database went away')
  }, 60_000)
})

describe('acceptance — the two passes have independent heartbeats', () => {
  it('lets the deep check go overdue while the hourly probe keeps succeeding', async () => {
    // The claim migration 0033 exists for, and the one that would be invisible if both crons shared an
    // agent: the probe runs every hour and the deep check has not run for two days. With one heartbeat the
    // watchdog would see a five-minute-old success and report the whole thing healthy.
    await seedConnection()
    const twoDaysOn = (NOW + 49 * HOUR) as Instant
    const probeIso = new Date(twoDaysOn).toISOString()

    await everyAgentHealthyAt(twoDaysOn)
    // The deep check last succeeded at NOW; the probe succeeds now.
    await sql`
      update agent_heartbeat set last_success_at = ${NOW_ISO}::timestamptz
      where agent_key = ${GOOGLE_HEALTH_AGENT}
    `
    await runGoogleLiveness(sql, livenessDepsFor(probeIso), probeIso)
    expect((await heartbeat(GOOGLE_LIVENESS_AGENT)).lastSuccessAt).toBe(twoDaysOn)

    const result = await runWatchdog(sql, twoDaysOn)
    expect(result.overdue).toContain(GOOGLE_HEALTH_AGENT)
    expect(result.overdue).not.toContain(GOOGLE_LIVENESS_AGENT)
  }, 60_000)

  it('and the control: the probe goes overdue on its own two-hour threshold', async () => {
    // Without this, "the probe is not overdue" is satisfied by an agent the watchdog never checks at all —
    // which is exactly what a missing `agent_heartbeat` row produces, silently.
    await seedConnection()
    const threeHoursOn = (NOW + 3 * HOUR) as Instant
    await everyAgentHealthyAt(threeHoursOn)
    await sql`
      update agent_heartbeat set last_success_at = ${NOW_ISO}::timestamptz
      where agent_key = ${GOOGLE_LIVENESS_AGENT}
    `
    const result = await runWatchdog(sql, threeHoursOn)
    expect(result.overdue).toContain(GOOGLE_LIVENESS_AGENT)
    expect(result.overdue).not.toContain(GOOGLE_HEALTH_AGENT)
  }, 60_000)
})

describe('the settings the pass reads come back as the declared defaults', () => {
  it('reads testing and not-approved from an unseeded database', async () => {
    // `readSetting` falls back to the declared default for an unseeded key, so a fresh database behaves
    // like a seeded one — and both defaults are the strict answer. Asserted here rather than in the unit
    // test because the fallback is the store's behaviour, not the registry's.
    await sql`delete from app_setting where key in (${PUBLISHING_STATUS_SETTING}, ${GBP_ACCESS_SETTING})`
    expect(await googleHealthSettings(sql)).toEqual({
      publishingStatus: 'testing',
      gbpAccessGranted: false,
    })
  }, 60_000)

  it('refuses a publishing status it cannot interpret rather than assuming there is no expiry', async () => {
    // The strict branch. Coercing an unknown status would coerce it to something, and the only two
    // candidates are the value that shows the seven-day expiry and the value that hides it.
    await sql`
      insert into app_setting (key, value, tier) values (${PUBLISHING_STATUS_SETTING}, '"internal"'::jsonb, 'operational')
      on conflict (key) do update set value = '"internal"'::jsonb
    `
    await expect(googleHealthSettings(sql)).rejects.toThrow(/not a publishing status/)
    await sql`delete from app_setting where key = ${PUBLISHING_STATUS_SETTING}`
  }, 60_000)
})
