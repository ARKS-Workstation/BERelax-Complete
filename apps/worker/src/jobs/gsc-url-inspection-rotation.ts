import type { Config } from '@berelax/config'
import { createConnection, type Sql } from '@berelax/db'
import { runUrlInspectionRotation, type UrlInspectionDeps } from '@berelax/google'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakeSearchConsole, type SearchConsoleProvider } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import { googleDepsFor } from './gsc-nightly-snapshot.ts'

/**
 * The URL Inspection rotation: the wiring, the handler and the log line.
 *
 * The pass itself is `runUrlInspectionRotation` in `@berelax/google`, for the reason
 * `gsc-nightly-snapshot.ts` records: it pairs the day ledger in `@berelax/db` with the cap arithmetic in
 * `@berelax/core`, and only a test inside `packages/google` may seal the Google token the whole path needs.
 */
export { runUrlInspectionRotation, SEO_URL_INSPECTION_AGENT } from '@berelax/google'

function searchConsoleFor(config: Config, nowIso: string): SearchConsoleProvider {
  if (config.GOOGLE_PROVIDER === 'real') {
    throw new AppError(
      'provider_unavailable',
      'The real URL Inspection adapter is not implemented, so this pass would record a stand-in verdict ' +
        'against every page on the site. Set GOOGLE_PROVIDER=fake until it exists.',
    )
  }
  return createFakeSearchConsole({
    log: createCallLog(() => nowIso),
    failures: new FailureScript(),
    now: () => nowIso,
  })
}

export function urlInspectionDeps(sql: Sql, config: Config, nowIso: string): UrlInspectionDeps {
  return {
    google: googleDepsFor(sql, config, nowIso),
    searchConsole: searchConsoleFor(config, nowIso),
  }
}

async function withOwnConnection<T>(config: Config, run: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** The daily handler. */
export async function gscUrlInspectionHandler(
  config: Config,
  atIso: string,
  jobId: string,
): Promise<void> {
  await withOwnConnection(config, async (sql) => {
    const result = await runUrlInspectionRotation(
      sql,
      urlInspectionDeps(sql, config, atIso),
      atIso,
      { jobId },
    )
    if (result.collection?.kind === 'degraded') {
      console.warn(
        `seo.url-inspection ${atIso}: degraded to ${result.collection.mode} ` +
          `(${result.collection.cause}); ${result.claimed.length} URL(s) had been claimed`,
      )
      return
    }
    const failures = result.collection?.kind === 'inspected' ? result.collection.failures.length : 0
    // Counts every night, including zero, and the coverage figure is the one worth reading: `remaining`
    // falling to zero is a completed cycle, and a `remaining` that never falls is a rotation that is not
    // rotating.
    console.log(
      `seo.url-inspection ${atIso}: ${result.claimed.length} claimed of a ${result.dailyCap} cap ` +
        `(${result.spentBefore} already spent today), ${result.newlyCovered.length} newly covered, ` +
        `${result.recorded} recorded, ${failures} failed, ` +
        `${result.coverage.neverInspected} of ${result.coverage.candidates} still uncovered`,
    )
  })
}
