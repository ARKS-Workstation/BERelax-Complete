import { type Kek, parseKek } from '@berelax/clinical'
import type { Config } from '@berelax/config'
import { type Clock, createRunBudget, type Instant, instantFromIso } from '@berelax/core'
import { createConnection, readSetting, type Sql, withAgentRun } from '@berelax/db'
import {
  createPostgresConnectionStore,
  createPostgresRefreshLock,
  type DeepCheckResult,
  type GoogleLogger,
  type GooglePublishingStatus,
  type HealthCheckDeps,
  isGooglePublishingStatus,
  type LivenessDeps,
  type LivenessResult,
  runDeepCheck,
  runLiveness,
  type WithGoogleDeps,
} from '@berelax/google'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  type BusinessProfileProvider,
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  createFakeSearchConsole,
  type GoogleOAuthProvider,
  type SearchConsoleProvider,
} from '@berelax/providers/google'
import { AppError } from '@berelax/shared'

/**
 * The two Google health passes, as agent runs.
 *
 * ## Why two crons and two agents
 *
 * The deep check at 03:00 forces a token refresh and makes one read per capability; the liveness probe
 * runs hourly and makes one cheap read per connection. They answer different questions at different
 * costs, and — the part that is not obvious — they must report to **different** `agent_definition` rows.
 * The watchdog measures the absence of a success per agent, so an hourly job writing the same heartbeat
 * as a daily one would keep it minutes old for ever: a deep check that stopped running entirely would be
 * completely invisible. Migration 0033 is that second agent; see its own note.
 *
 * ## Why the body is wrapped in `withAgentRun`
 *
 * So that a missed pass is an alert rather than a silence. `withAgentRun` records the attempt and the
 * heartbeat **whether or not the body throws** — deliberately not in one transaction, because a single
 * transaction would roll back the evidence along with the work. The watchdog then alerts at twice the
 * declared interval: 48 hours for the deep check, two hours for the liveness probe.
 *
 * ## What is in here rather than in `@berelax/google`
 *
 * Only the wiring that needs the process: the KEK from the environment, the provider adapters chosen by
 * configuration, and the two settings. The passes themselves take their dependencies as arguments, which
 * is what lets the integration test drive them at a frozen clock with a generated KEK and no environment
 * at all.
 */

/** The `agent_definition` rows these passes report to. 0021 seeds the first, 0033 the second. */
export const GOOGLE_HEALTH_AGENT = 'google_health'
export const GOOGLE_LIVENESS_AGENT = 'google_liveness'

/** The settings keys that decide what a Google failure *means*. Declared in `@berelax/config`. */
export const PUBLISHING_STATUS_SETTING = 'google.consent_screen_publishing_status'
export const GBP_ACCESS_SETTING = 'google.business_profile_access_granted'

export interface GoogleHealthSettings {
  readonly publishingStatus: GooglePublishingStatus
  readonly gbpAccessGranted: boolean
}

/**
 * Reads the two settings, refusing a publishing status the tripwire does not understand.
 *
 * `readSetting` falls back to the declared default for an unseeded key, so a fresh database behaves like
 * a seeded one — and the default is `testing`, which is the strict answer. The narrowing is not
 * ceremonial: the value arrives from a jsonb column, and a status this code cannot interpret must stop
 * the pass rather than be coerced to `production`, which is the value that silences the tripwire.
 */
export async function googleHealthSettings(sql: Sql): Promise<GoogleHealthSettings> {
  const status = await readSetting(sql, PUBLISHING_STATUS_SETTING)
  if (!isGooglePublishingStatus(status)) {
    throw new AppError(
      'invariant_violated',
      `${PUBLISHING_STATUS_SETTING} holds ${JSON.stringify(status)}, which is not a publishing status ` +
        'this system understands. The pass stopped rather than assuming the connection has no seven-day ' +
        'expiry — that assumption is what the tripwire exists to refuse.',
      { details: { reason: 'google_publishing_status_unknown' } },
    )
  }
  return {
    publishingStatus: status,
    gbpAccessGranted: (await readSetting(sql, GBP_ACCESS_SETTING)) === true,
  }
}

const systemClock: Clock = { now: () => Date.now() as Instant }

/**
 * One structured line per Google call, at the level the chokepoint chose.
 *
 * Printed as it arrives. The chokepoint emits the fields a query groups by — correlation id, capability,
 * connection id — and a leak detector in `with-google.test.ts` asserts nothing reaching them is a secret,
 * so there is nothing here to filter.
 */
const logger: GoogleLogger = {
  log(line) {
    const payload = JSON.stringify({
      message: line.message,
      correlationId: line.correlationId,
      capability: line.capability,
      consumer: line.consumer,
      connectionId: line.connectionId,
      ...line.fields,
    })
    if (line.level === 'error') console.error(payload)
    else if (line.level === 'warn') console.warn(payload)
    else console.log(payload)
  },
}

interface GoogleFakes {
  readonly oauth: GoogleOAuthProvider
  readonly profile: BusinessProfileProvider
  readonly searchConsole: SearchConsoleProvider
}

/**
 * The provider adapters for a configured mode.
 *
 * `real` throws rather than falling back, for the reason docs/12 §1 gives and the picker route repeats: a
 * production deploy that looked connected and talked to nothing is worse than one that refuses. Here it is
 * worse still — a health check that silently checked a fake would report every connection healthy for ever,
 * which is precisely the shape of failure this unit exists to remove.
 */
function providersFor(config: Config): GoogleFakes {
  if (config.GOOGLE_PROVIDER === 'real') {
    throw new AppError(
      'provider_unavailable',
      'The real Google adapters are not implemented, so the health check would be checking a stand-in ' +
        'and reporting it as the connection. Set GOOGLE_PROVIDER=fake until they exist.',
    )
  }
  const shared = {
    log: createCallLog(() => new Date().toISOString()),
    failures: new FailureScript(),
    now: () => new Date().toISOString(),
  }
  return {
    oauth: createFakeGoogleOAuth(shared),
    profile: createFakeBusinessProfile(shared),
    searchConsole: createFakeSearchConsole(shared),
  }
}

/**
 * The key the stored refresh token is sealed with, read from the environment.
 *
 * The same deferral the consent and picker routes record: nothing in this system loads a KEK at runtime
 * yet, and naming the app-wide key belongs with the secret inventory in H-HARD-03. Refusing loudly is the
 * only safe alternative to inventing one per process — a health check with the wrong key would report
 * every connection broken and send the owner through a re-consent that fixes nothing.
 */
function googleTokenKek(): Kek {
  const material = process.env['GOOGLE_TOKEN_KEK']
  const version = process.env['GOOGLE_TOKEN_KEK_VERSION'] ?? 'v1'
  if (!material) {
    throw new AppError(
      'provider_unavailable',
      'GOOGLE_TOKEN_KEK is not set, so no stored Google token can be opened and the health check cannot ' +
        'tell a dead grant from a missing key. Nothing was checked.',
    )
  }
  return parseKek(material, version)
}

/** The chokepoint's dependencies, with the real advisory transaction lock (G-CONN-04, docs/10 §4). */
function withGoogleDeps(sql: Sql, fakes: GoogleFakes, kek: Kek): WithGoogleDeps {
  return {
    store: createPostgresConnectionStore(sql),
    oauth: fakes.oauth,
    kek,
    clock: systemClock,
    lock: createPostgresRefreshLock(sql),
    logger,
  }
}

/** Everything the deep check needs, assembled from configuration and the environment. */
export async function deepCheckDeps(sql: Sql, config: Config): Promise<HealthCheckDeps> {
  const fakes = providersFor(config)
  const settings = await googleHealthSettings(sql)
  return {
    google: withGoogleDeps(sql, fakes, googleTokenKek()),
    health: createPostgresConnectionStore(sql),
    profile: fakes.profile,
    searchConsole: fakes.searchConsole,
    publishingStatus: settings.publishingStatus,
    gbpAccessGranted: settings.gbpAccessGranted,
  }
}

/** Everything the liveness probe needs. No settings: it asks one question and reports one answer. */
export function livenessDeps(sql: Sql, config: Config): LivenessDeps {
  const fakes = providersFor(config)
  return {
    google: withGoogleDeps(sql, fakes, googleTokenKek()),
    health: createPostgresConnectionStore(sql),
    profile: fakes.profile,
    searchConsole: fakes.searchConsole,
  }
}

/**
 * The daily deep check, as an agent run.
 *
 * `atIso` is injected rather than read here, so the pass is reproducible: the integration test drives it
 * at a frozen clock on either side of the seven-day Testing expiry, which is exactly what a pass reading
 * `new Date()` could not be asked to do.
 */
export async function runGoogleHealthCheck(
  sql: Sql,
  deps: HealthCheckDeps,
  atIso: string,
  options: { readonly jobId?: string } = {},
): Promise<DeepCheckResult> {
  let result: DeepCheckResult = {
    checkedAt: instantFromIso(atIso),
    connections: [],
    retryWorthwhile: false,
  }
  const run = await withAgentRun(
    sql,
    {
      agentKey: GOOGLE_HEALTH_AGENT,
      startedAtIso: atIso,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    },
    async () => {
      result = await runDeepCheck(deps, instantFromIso(atIso))
    },
    createRunBudget,
  )
  if (run.outcome === 'failed' || run.outcome === 'budget_exceeded') {
    // Re-thrown so pg-boss retries with backoff — but the heartbeat and the run row are already written,
    // which is the point: a failed pass is visible whether or not anybody reads `pgboss.job`.
    throw new AppError(
      'provider_unavailable',
      `The Google connection health check failed: ${run.error ?? 'no error recorded'}`,
      { details: { reason: 'google_health_check_failed', runId: run.runId } },
    )
  }
  if (result.retryWorthwhile) {
    // The pass completed and recorded everything it observed, and what it observed is that nothing
    // reached Google at all for a reason another attempt might survive. The run is already marked
    // succeeded — it did its job, which is the record — so this throw is purely the queue's retry signal.
    throw new AppError(
      'provider_unavailable',
      'Every Google connection failed every read, for a reason a retry could survive. The findings are ' +
        'already recorded on each connection; this failure is the queue being asked to try again.',
      { details: { reason: 'google_health_check_retry', runId: run.runId } },
    )
  }
  return result
}

/** The hourly liveness probe, as an agent run. Same shape, same reasons, cheaper body. */
export async function runGoogleLiveness(
  sql: Sql,
  deps: LivenessDeps,
  atIso: string,
  options: { readonly jobId?: string } = {},
): Promise<LivenessResult> {
  let result: LivenessResult = { checkedAt: instantFromIso(atIso), probes: [] }
  const run = await withAgentRun(
    sql,
    {
      agentKey: GOOGLE_LIVENESS_AGENT,
      startedAtIso: atIso,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    },
    async () => {
      result = await runLiveness(deps, instantFromIso(atIso))
    },
    createRunBudget,
  )
  if (run.outcome === 'failed' || run.outcome === 'budget_exceeded') {
    throw new AppError(
      'provider_unavailable',
      `The Google liveness probe failed: ${run.error ?? 'no error recorded'}`,
      { details: { reason: 'google_liveness_failed', runId: run.runId } },
    )
  }
  return result
}

/**
 * A connection for one pass, closed afterwards.
 *
 * Its own pool rather than the maintenance connection the other handlers share, because a forced refresh
 * takes an advisory transaction lock and holds a connection for the duration of an HTTPS call to Google
 * (G-CONN-04's `lock_timeout` note). Sharing a four-connection pool with the audit partition job and the
 * recurring-cost sweep is how one slow Google call becomes `53300 too_many_connections` for something
 * unrelated.
 */
async function withOwnConnection<T>(config: Config, run: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** The 03:00 handler. Thin: the wiring is above and the pass itself is in `@berelax/google`. */
export async function googleHealthHandler(
  config: Config,
  atIso: string,
  jobId: string,
): Promise<void> {
  await withOwnConnection(config, async (sql) => {
    const result = await runGoogleHealthCheck(sql, await deepCheckDeps(sql, config), atIso, {
      jobId,
    })
    const degraded = result.connections.filter((c) => c.health.displayState !== 'healthy').length
    const findings = result.connections.reduce((n, c) => n + c.findings.length, 0)
    // Counts, every night, including zero. Zero is the evidence rather than the silence — the alternative
    // is a log that says nothing when everything is fine and nothing when the job never ran.
    console.log(
      `google-connection.health ${atIso}: ${result.connections.length} connection(s), ` +
        `${degraded} not healthy, ${findings} finding(s)`,
    )
  })
}

/** The hourly handler. */
export async function googleLivenessHandler(
  config: Config,
  atIso: string,
  jobId: string,
): Promise<void> {
  await withOwnConnection(config, async (sql) => {
    const result = await runGoogleLiveness(sql, livenessDeps(sql, config), atIso, { jobId })
    const alive = result.probes.filter((probe) => probe.alive).length
    const skipped = result.probes.filter((probe) => probe.skipped !== null).length
    console.log(
      `google-connection.liveness ${atIso}: ${alive}/${result.probes.length - skipped} alive, ` +
        `${skipped} skipped`,
    )
  })
}
