import { type Kek, parseKek } from '@berelax/clinical'
import type { Config } from '@berelax/config'
import type { Clock, Instant } from '@berelax/core'
import { countGscDailyRows, createConnection, type Sql } from '@berelax/db'
import {
  createPostgresConnectionStore,
  createPostgresRefreshLock,
  type GscSnapshotDeps,
  runGscNightlySnapshot,
  type WithGoogleDeps,
} from '@berelax/google'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  createFakeGoogleOAuth,
  createFakeSearchConsole,
  type SearchConsoleProvider,
} from '@berelax/providers/google'
import { AppError } from '@berelax/shared'

/**
 * The nightly Search Console snapshot: the wiring, the handler and the log line.
 *
 * The pass itself — the agent run, the paging, the upsert and the rare-query gap — is
 * `runGscNightlySnapshot` in `@berelax/google`, and the split is not cosmetic. That function pairs
 * `withAgentRun` from `@berelax/db` with `createRunBudget` from `@berelax/core` and needs a Google token
 * that opens to be tested at all, and only a test inside `packages/google` may seal one (`sealToken` is
 * behind the G-CONN-03 chokepoint and the allow-list was not widened for this unit). So the pass lives
 * where it can be proved end to end, and what is left here is everything that needs the PROCESS: the KEK
 * from the environment, the provider adapters chosen by configuration, a connection of its own, and the
 * line somebody reads at 05:00.
 *
 * `SEO_GSC_SNAPSHOT_AGENT` is re-exported because the registry names it, and a registry that imported it
 * from two places would be a registry where the two could differ.
 */
export { runGscNightlySnapshot, SEO_GSC_SNAPSHOT_AGENT } from '@berelax/google'

/** The process clock. Only the wiring reads it; every pass takes its instant as an argument. */
const systemClock: Clock = { now: () => Date.now() as Instant }

/**
 * The provider adapters for a configured mode.
 *
 * `real` throws rather than falling back, for the reason the health check's own note gives: a pass that
 * silently mirrored a fake would fill the warehouse with fixture traffic, and every analysis built on it
 * afterwards would be about a business that does not exist. Refusing is the only safe answer.
 */
function searchConsoleFor(config: Config, nowIso: string): SearchConsoleProvider {
  if (config.GOOGLE_PROVIDER === 'real') {
    throw new AppError(
      'provider_unavailable',
      'The real Search Console adapter is not implemented, so this pass would mirror a stand-in into the ' +
        'warehouse and every later analysis would be about fixture traffic. Set GOOGLE_PROVIDER=fake ' +
        'until it exists.',
    )
  }
  return createFakeSearchConsole({
    log: createCallLog(() => nowIso),
    failures: new FailureScript(),
    now: () => nowIso,
  })
}

/** The key the stored refresh token is sealed with. The same deferral the health check records (H-HARD-03). */
function googleTokenKek(): Kek {
  const material = process.env['GOOGLE_TOKEN_KEK']
  const version = process.env['GOOGLE_TOKEN_KEK_VERSION'] ?? 'v1'
  if (!material) {
    throw new AppError(
      'provider_unavailable',
      'GOOGLE_TOKEN_KEK is not set, so no stored Google token can be opened and the snapshot cannot tell ' +
        'a dead grant from a missing key. Nothing was fetched.',
    )
  }
  return parseKek(material, version)
}

/** One structured line per Google call, at the level the chokepoint chose. */
const logger = {
  log(line: {
    level: string
    message: string
    correlationId: string
    capability: string
    consumer: string
    connectionId: string | null
    fields: Readonly<Record<string, unknown>>
  }): void {
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

/**
 * The chokepoint's dependencies, with the real advisory transaction lock (G-CONN-04, docs/10 §4).
 *
 * Shared by both SEO passes, because both talk to the same connection through the same capability and a
 * second assembly of these five values is a second place for one of them to be wrong.
 */
export function googleDepsFor(sql: Sql, config: Config, nowIso: string): WithGoogleDeps {
  if (config.GOOGLE_PROVIDER === 'real') {
    // The same refusal `searchConsoleFor` makes, one layer down and for the OAuth half: a pass that
    // refreshed against a stand-in would hold a token that opens nothing and report every connection as
    // healthy while the warehouse filled with fixture traffic.
    throw new AppError(
      'provider_unavailable',
      'The real Google OAuth adapter is not implemented, so this pass would refresh against a stand-in. ' +
        'Set GOOGLE_PROVIDER=fake until it exists.',
    )
  }
  return {
    store: createPostgresConnectionStore(sql),
    oauth: createFakeGoogleOAuth({
      log: createCallLog(() => nowIso),
      failures: new FailureScript(),
      now: () => nowIso,
    }),
    kek: googleTokenKek(),
    clock: systemClock,
    lock: createPostgresRefreshLock(sql),
    logger,
  }
}

export function gscSnapshotDeps(sql: Sql, config: Config, nowIso: string): GscSnapshotDeps {
  return {
    google: googleDepsFor(sql, config, nowIso),
    searchConsole: searchConsoleFor(config, nowIso),
  }
}

/**
 * Its own connection, closed afterwards.
 *
 * Not the shared maintenance pool: a token refresh takes an advisory transaction lock and holds a
 * connection for the length of an HTTPS call to Google, and a 60,000-row upsert holds one for the length of
 * sixty statements. Sharing a four-connection pool with the audit partition job is how one slow Google
 * call becomes `53300 too_many_connections` for something unrelated (G-CONN-04's `lock_timeout` note).
 */
async function withOwnConnection<T>(config: Config, run: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** The nightly handler. Thin: the wiring is above and the collection itself is in `@berelax/google`. */
export async function gscNightlySnapshotHandler(
  config: Config,
  atIso: string,
  jobId: string,
): Promise<void> {
  await withOwnConnection(config, async (sql) => {
    const result = await runGscNightlySnapshot(sql, gscSnapshotDeps(sql, config, atIso), atIso, {
      jobId,
    })
    if (result.collection.kind === 'degraded') {
      // A line every night, naming the cause. The alternative is silence, which is indistinguishable from
      // a cron that has stopped — and this pass deliberately succeeds in this state, so the log line is
      // the only evidence it ran at all.
      console.warn(
        `seo.gsc-snapshot ${atIso}: degraded to ${result.collection.mode} ` +
          `(${result.collection.cause}); nothing was fetched`,
      )
      return
    }
    const held = await countGscDailyRows(sql, { siteUrl: result.collection.siteUrl })
    if (result.collection.unknownDevices.length > 0) {
      // Stored as it arrived and reported here. A device class Google adds is not a reason to discard a
      // row that cannot be re-fetched after 16 months.
      console.warn(
        `seo.gsc-snapshot ${atIso}: unfamiliar device value(s) ` +
          `${result.collection.unknownDevices.join(', ')} stored as returned`,
      )
    }
    console.log(
      `seo.gsc-snapshot ${atIso}: ${result.collection.window.startDate}..` +
        `${result.collection.window.endDate}, ${result.collection.pages.length} page(s) to row ` +
        `${result.collection.lastStartRow}, ${result.rowsWritten} row(s) written ` +
        `(${result.rowsInserted} new, ${result.rowsUpdated} revised), ${held} held for the property, ` +
        `${result.snapshot?.rareQueryClicks ?? 0} click(s) withheld as rare queries, ` +
        `${result.candidatesRegistered} inspection candidate(s)`,
    )
  })
}
