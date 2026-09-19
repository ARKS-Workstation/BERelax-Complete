import { generateKek } from '@berelax/clinical'
import {
  fixedClock,
  GOOGLE_CAPABILITIES,
  instantFromIso,
  rareQueryGapExplanation,
} from '@berelax/core'
import {
  agentsWithHeartbeat,
  createConnection,
  readGscSnapshot,
  type Sql,
  upsertGscDailyRows,
} from '@berelax/db'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  createFakeSearchConsole,
  RARE_QUERY_CLICKS,
  RARE_QUERY_IMPRESSIONS,
  type SearchAnalyticsRow,
} from '@berelax/providers/google'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GSC_PAGE_SIZE } from '../adapters/search-analytics.ts'
import { enumerateGbpChoices, type PickerDeps } from '../capability-resolver.ts'
import { createPostgresConnectionStore } from '../postgres-store.ts'
import { createPostgresRefreshLock } from '../token-refresh.ts'
import { connectionBinding, sealToken } from '../token-store.ts'
import type { WithGoogleDeps } from '../with-google.ts'
import type { GscSnapshotDeps } from './gsc-snapshot.ts'
import { runGscNightlySnapshot, SEO_GSC_SNAPSHOT_AGENT } from './nightly-pass.ts'

/**
 * G-SEO-01 — the nightly pass, end to end against real PostgreSQL.
 *
 * Five of this unit's criteria are claims about the database and cannot be made anywhere else:
 *
 *  1. **Paging.** 60,000 rows are fully persisted, the cursor advanced by exactly 25,000 per call, and the
 *     unique index on the five dimensions rejected nothing — the last of which only a real index can say.
 *  2. **Idempotent re-run.** The same night twice leaves the row count unchanged and raises no
 *     duplicate-key error, asserted before and after.
 *  3. **The rare-query gap** is a stored, GENERATED column, and the owner-facing sentence is rendered from
 *     the value read back rather than from the fetch.
 *  4. **The ordering fact.** The whole pass completes on a connection whose every Business Profile
 *     capability is refused with `access_not_granted`, which is the launch-day state (docs/10 §9).
 *  5. **The heartbeat** is written on success and on failure, through G-AGT-01's `withAgentRun`.
 *
 * ## Why here and not in apps/worker
 *
 * All five need a Google token that OPENS, and `sealToken` is behind the G-CONN-03 chokepoint: only a test
 * inside `packages/google` may seal one, and the allow-list was not widened for this unit. That is why the
 * pass itself lives in this package and the worker keeps the wiring — see `nightly-pass.ts`.
 *
 * ## Isolation
 *
 * `withGoogle` resolves a connection from the capability across every connection that is not
 * disconnected, ordering by id — so a completed consent left behind by an earlier file in the sequential
 * suite would win every resolution here (the brief's rule 12, and `with-google.itest.ts`'s recorded
 * failure). This file therefore disconnects the others rather than deleting rows a foreign key protects.
 *
 * Its own warehouse rows ARE deleted, and that is not the thing rule 9 forbids: `seo_gsc_daily` and
 * `seo_gsc_snapshot` are mutable tables this unit owns, every row is keyed by a `site_url` no other suite
 * writes, and the paging criterion is a claim about an exact count rather than a delta — "60,000 rows
 * persisted" cannot be expressed as a delta over a table another test may also have written to.
 */

const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!DATABASE_URL)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const KEK = generateKek('v1')
/**
 * 03:00 Asia/Dubai on 19 September 2026, in UTC.
 *
 * Google's calendar day at that instant is the 18th, so the 3-day lag puts the window at 09-09..09-15 —
 * seven days ending three days back. The two constants below are written out rather than derived from
 * `gscRequestWindow`, deliberately: a test that computed the window with the same function as the code
 * would agree with it however wrong both were.
 */
const NOW_ISO = '2026-09-18T23:00:00.000Z'
const WINDOW_START = '2026-09-09'
const WINDOW_END = '2026-09-15'
const SUB = 'sub-gseo01-nightly-pass'
const REFRESH_TOKEN = '1//09-gseo01-nightly-refresh-token-never-in-a-row'
/**
 * A property only this file writes.
 *
 * Visibly a fixture rather than plausible (the brief's rule 15): a warehouse row carrying a real-looking
 * property nobody selected would be indistinguishable from data.
 */
const SITE = 'sc-domain:gseo01-nightly.invalid'

let sql: Sql
let store: ReturnType<typeof createPostgresConnectionStore>

beforeAll(() => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  store = createPostgresConnectionStore(sql)
}, 120_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql`update google_connections set status = 'disconnected' where google_sub <> ${SUB}`
  await sql`delete from google_connections where google_sub = ${SUB}`
  await sql`delete from seo_gsc_daily where site_url = ${SITE}`
  await sql`delete from seo_gsc_snapshot where site_url = ${SITE}`
  await sql`delete from seo_url_inspection where site_url = ${SITE}`
  await sql`delete from agent_run where agent_key = ${SEO_GSC_SNAPSHOT_AGENT}`
  // A heartbeat in a known state, so an assertion about this pass is not about the previous file's.
  await sql`
    update agent_heartbeat
    set last_run_at = null, last_success_at = null, last_failure_at = null, last_error = null,
        last_outcome = null, consecutive_failures = 0
    where agent_key = ${SEO_GSC_SNAPSHOT_AGENT}
  `
  await sql`
    update agent_definition set enabled = true, kill_switch = false
    where agent_key = ${SEO_GSC_SNAPSHOT_AGENT}
  `
})

/** A connection in the state a completed consent plus a Search Console selection leaves. */
async function seedConnection(options: { readonly gscSelected?: boolean } = {}): Promise<string> {
  const id = await store.allocateId()
  await store.insert({
    id,
    googleSub: SUB,
    googleEmail: 'google-admin@berelax.ae',
    grantedScopes: [
      'https://www.googleapis.com/auth/business.manage',
      'https://www.googleapis.com/auth/webmasters.readonly',
    ],
    refreshToken: sealToken(
      KEK,
      connectionBinding({ connectionId: id, googleSub: SUB }),
      REFRESH_TOKEN,
    ),
    consentAt: instantFromIso('2026-09-12T10:00:00.000Z'),
  })
  for (const capability of GOOGLE_CAPABILITIES) {
    await store.upsertCapability({
      connectionId: id,
      capability,
      // Only `gsc` has a resource: the Business Profile listing cannot be picked until Google approves the
      // API access application, which is precisely the launch-day state the ordering fact is about.
      resourceRef: capability === 'gsc' && (options.gscSelected ?? true) ? { siteUrl: SITE } : null,
      health: capability === 'gsc' ? 'unknown' : 'permission_missing',
      isPrimary: true,
    })
  }
  return id
}

/**
 * 60,000 distinct dimension tuples.
 *
 * Distinct by construction: the query carries the index. That matters twice — the unique index would refuse
 * a duplicate, and the criterion is that it rejected nothing, so a generator producing collisions would
 * make the assertion fail for a reason unrelated to paging.
 */
function generateRows(count: number): readonly SearchAnalyticsRow[] {
  const devices = ['MOBILE', 'DESKTOP', 'TABLET'] as const
  const dates = [WINDOW_START, '2026-09-12', WINDOW_END]
  return Array.from({ length: count }, (_, index) => ({
    query: `gseo01 fixture query ${index}`,
    page: `/treatments/fixture-${index % 40}`,
    clicks: index % 7,
    impressions: 10 + (index % 90),
    ctr: (index % 7) / (10 + (index % 90)),
    position: 1 + (index % 30) / 2,
    date: dates[index % dates.length] ?? WINDOW_END,
    device: devices[index % 3] ?? 'MOBILE',
    country: index % 11 === 0 ? 'ind' : 'are',
  }))
}

interface Harness {
  readonly deps: GscSnapshotDeps
  readonly google: WithGoogleDeps
  readonly picker: PickerDeps
  readonly log: ReturnType<typeof createCallLog>
  readonly gscFailures: FailureScript
  readonly gbpFailures: FailureScript
}

function harness(rows?: readonly SearchAnalyticsRow[]): Harness {
  const log = createCallLog(() => NOW_ISO)
  const gscFailures = new FailureScript()
  const gbpFailures = new FailureScript()
  const google: WithGoogleDeps = {
    store,
    // The real advisory transaction lock (G-CONN-04): the token below is obtained through it.
    lock: createPostgresRefreshLock(sql),
    oauth: createFakeGoogleOAuth({
      log,
      failures: new FailureScript(),
      now: () => NOW_ISO,
      sub: SUB,
    }),
    kek: KEK,
    clock: fixedClock(NOW_ISO),
    logger: { log: () => {} },
    newCorrelationId: () => 'corr-gseo01-nightly',
  }
  const searchConsole = createFakeSearchConsole({
    log,
    failures: gscFailures,
    now: () => NOW_ISO,
    ...(rows === undefined ? {} : { analyticsRows: rows }),
  })
  const profile = createFakeBusinessProfile({ log, failures: gbpFailures, now: () => NOW_ISO })
  return {
    log,
    google,
    gscFailures,
    gbpFailures,
    deps: { google, searchConsole },
    picker: { google, selections: store, profile, searchConsole },
  }
}

const cursors = (log: ReturnType<typeof createCallLog>): number[] =>
  log
    .forProvider('google-search-console')
    .filter(
      (call) =>
        call.operation === 'queryAnalytics' &&
        (call.detail['dimensions'] as string[]).includes('query'),
    )
    .map((call) => call.detail['startRow'] as number)

async function storedRowCount(): Promise<number> {
  const [row] = (await sql`
    select count(*)::text as n from seo_gsc_daily where site_url = ${SITE}
  `) as unknown as { n: string }[]
  return Number(row?.n ?? '0')
}

async function heartbeat(): Promise<{
  lastRunAt: number | undefined
  lastSuccessAt: number | undefined
  lastError: string | undefined
  lastOutcome: string | undefined
}> {
  const agents = await agentsWithHeartbeat(sql)
  const agent = agents.find((candidate) => candidate.agentKey === SEO_GSC_SNAPSHOT_AGENT)
  if (agent === undefined) {
    throw new Error(`no agent_definition row for ${SEO_GSC_SNAPSHOT_AGENT} — migration 0042`)
  }
  return {
    lastRunAt: agent.heartbeat.lastRunAt,
    lastSuccessAt: agent.heartbeat.lastSuccessAt,
    lastError: agent.heartbeat.lastError,
    lastOutcome: agent.heartbeat.lastOutcome,
  }
}

describe('acceptance — 60,000 rows are fully persisted, paged 25,000 at a time', () => {
  it('advances the cursor by exactly the page size and stores every row once', async () => {
    await seedConnection()
    const h = harness(generateRows(60_000))

    const result = await runGscNightlySnapshot(sql, h.deps, NOW_ISO, { jobId: 'job-gseo01-paging' })

    if (result.collection.kind !== 'collected') {
      throw new Error(`expected a collection, got ${result.collection.cause}`)
    }
    // The cursor, from the call log rather than from the code's own report: 0, 25,000, 50,000.
    expect(cursors(h.log)).toEqual([0, GSC_PAGE_SIZE, 2 * GSC_PAGE_SIZE])
    expect(result.collection.pages.map((page) => page.received)).toEqual([25_000, 25_000, 10_000])

    // And the database agrees. This is the half the unique index decides: every one of the 60,000 rows
    // was either inserted or updated, so nothing was duplicated and — the defect this criterion exists to
    // catch — nothing was swallowed by an `on conflict do nothing`.
    expect(result.rowsWritten).toBe(60_000)
    expect(result.rowsInserted).toBe(60_000)
    expect(result.rowsUpdated).toBe(0)
    expect(await storedRowCount()).toBe(60_000)

    // The evidence is on the snapshot row too, so "one page, exactly 25,000 rows" is visible to a person.
    const snapshot = await readGscSnapshot(sql, {
      siteUrl: SITE,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    })
    expect(snapshot?.pagesFetched).toBe(3)
    expect(snapshot?.rowLimit).toBe(GSC_PAGE_SIZE)
    expect(snapshot?.lastStartRow).toBe(2 * GSC_PAGE_SIZE)
    expect(snapshot?.rowsPersisted).toBe(60_000)
  }, 300_000)

  it('refuses a batch that carries the same dimension tuple twice, rather than keeping one of them', async () => {
    // The control for the count above, and the reason the writer uses `do update` rather than `do nothing`:
    // a duplicate inside one batch means the cursor read the same rows twice, and silently keeping one of
    // the pair would store the day at less than its real value while reporting success.
    //
    // Probed against the writer directly rather than through the fake, because the fake **cannot** produce
    // the case: it regroups by the requested dimensions, exactly as the API does, so a duplicated fixture
    // row arrives merged. That is the right behaviour for a stand-in for Google and it is why this refusal
    // needs a batch assembled by hand — the defect being guarded against is in this system, not upstream.
    const row = {
      siteUrl: SITE,
      date: WINDOW_END,
      page: '/',
      query: 'gseo01 duplicate tuple',
      device: 'MOBILE',
      country: 'are',
      clicks: 3,
      impressions: 40,
      avgPositionCenti: 650,
    }
    await expect(upsertGscDailyRows(sql, [row, row])).rejects.toThrow(
      /carried the same \(date, page, query, device, country\) twice/,
    )
    // Nothing partial was left behind: the chunk was one statement, so it committed or it did not.
    expect(await storedRowCount()).toBe(0)
  }, 120_000)
})

describe('acceptance — running the same day twice changes nothing and raises nothing', () => {
  it('leaves the row count unchanged, updating every row instead of inserting a second copy', async () => {
    await seedConnection()
    const rows = generateRows(2500)

    const first = await runGscNightlySnapshot(sql, harness(rows).deps, NOW_ISO)
    const countAfterFirst = await storedRowCount()
    expect(countAfterFirst).toBe(2500)
    expect(first.rowsInserted).toBe(2500)

    // The assertion "before and after", and the second run is a real run rather than a skip: it inserted
    // nothing and updated everything, which is the only shape that proves the dimension key decided.
    const second = await runGscNightlySnapshot(sql, harness(rows).deps, NOW_ISO)
    expect(await storedRowCount()).toBe(countAfterFirst)
    expect(second.rowsUpdated).toBe(2500)
    expect(second.rowsInserted).toBe(0)
    expect(second.collection.kind).toBe('collected')

    // One snapshot row for the window, updated rather than appended.
    const [snapshots] = (await sql`
      select count(*)::text as n from seo_gsc_snapshot where site_url = ${SITE}
    `) as unknown as { n: string }[]
    expect(Number(snapshots?.n)).toBe(1)
  }, 300_000)

  it('stores a revised figure for a day Google has changed its mind about', async () => {
    // Why the re-fetch exists at all: the last two to three days keep changing, so the upsert has to be an
    // update and the newer figure has to win. A writer that ignored the conflict would freeze the first
    // version of every number for ever.
    await seedConnection()
    const original = generateRows(5)
    const revised = original.map((row, index) =>
      index === 0 ? { ...row, clicks: row.clicks + 40, impressions: row.impressions + 200 } : row,
    )
    await runGscNightlySnapshot(sql, harness(original).deps, NOW_ISO)
    await runGscNightlySnapshot(sql, harness(revised).deps, NOW_ISO)
    const [row] = (await sql`
      select clicks, impressions from seo_gsc_daily
      where site_url = ${SITE} and query = ${original[0]?.query ?? ''}
    `) as unknown as { clicks: number; impressions: number }[]
    expect(row?.clicks).toBe((original[0]?.clicks ?? 0) + 40)
    expect(row?.impressions).toBe((original[0]?.impressions ?? 0) + 200)
  }, 120_000)
})

describe('acceptance — the rare-query gap is a stored fact and the sentence is rendered from it', () => {
  it('persists the withheld figures in generated columns and explains them to the owner', async () => {
    await seedConnection()
    const result = await runGscNightlySnapshot(sql, harness().deps, NOW_ISO)
    if (result.collection.kind !== 'collected') throw new Error('unreachable')

    const snapshot = await readGscSnapshot(sql, {
      siteUrl: SITE,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    })
    // The fixture's own gap, derived on both sides: the fake exports the sum of the rows it withholds, so
    // neither the assertion nor the code holds a literal the other has to be kept in step with.
    expect(snapshot?.queryClicks).toBeLessThan(snapshot?.pageClicks ?? 0)
    expect(snapshot?.rareQueryClicks).toBe(RARE_QUERY_CLICKS)
    expect(snapshot?.rareQueryImpressions).toBe(RARE_QUERY_IMPRESSIONS)
    // GENERATED, so it cannot disagree with the two totals it is made of.
    expect(snapshot?.rareQueryClicks).toBe(
      (snapshot?.pageClicks ?? 0) - (snapshot?.queryClicks ?? 0),
    )

    // The owner-facing string comes from the STORED number. Rendering it from the fetch would let the
    // sentence and the column drift apart, which is the whole reason the column exists.
    expect(result.rareQueryExplanation).toBe(
      rareQueryGapExplanation({
        queryClicks: snapshot?.queryClicks ?? 0,
        pageClicks: snapshot?.pageClicks ?? 0,
        queryImpressions: snapshot?.queryImpressions ?? 0,
        pageImpressions: snapshot?.pageImpressions ?? 0,
      }),
    )
    expect(result.rareQueryExplanation).toContain(String(RARE_QUERY_CLICKS))
    expect(result.rareQueryExplanation).toContain('too rare')
    // Not an error, and nothing recorded as one: the pass succeeded with the gap in it.
    expect((await heartbeat()).lastOutcome).toBe('succeeded')
  }, 120_000)

  it('refuses to store an inverted gap, which could not come from Google', async () => {
    // The constraint, probed through the writer rather than by hand: query-level clicks above page-level
    // would mean the same rows were summed twice, and the generated column would hold a negative withheld
    // figure that the sentence above would render as "-20 clicks are withheld".
    await expect(sql`
      insert into seo_gsc_snapshot
        (site_url, window_start, window_end, requested_at, pages_fetched, row_limit, last_start_row,
         rows_persisted, query_clicks, query_impressions, page_clicks, page_impressions)
      values (${SITE}, ${WINDOW_START}::date, ${WINDOW_END}::date, ${NOW_ISO}::timestamptz,
              1, 25000, 0, 1, 500, 9000, 400, 8000)
    `).rejects.toThrow(/seo_gsc_snapshot_query_clicks_do_not_exceed_page_clicks/)
  })
})

describe('acceptance — the ordering fact: the SEO pass works while Business Profile is refused', () => {
  it('completes the whole nightly pass on a connection whose every GBP capability is access_not_granted', async () => {
    const connectionId = await seedConnection()
    const h = harness(generateRows(1200))
    // The launch-day state: a valid token, both scopes granted, and Business Profile refusing every call
    // because Google has not approved the Basic API Access application yet (docs/10 §1, §9).
    h.gbpFailures.failAlways('access_not_granted')

    const gbp = await enumerateGbpChoices(h.picker, { connectionId })
    expect(gbp.state).toBe('access_not_granted')
    expect(gbp.choices).toEqual([])

    // And the SEO pass, on the same connection, in the same database, at the same instant.
    const result = await runGscNightlySnapshot(sql, h.deps, NOW_ISO, {
      jobId: 'job-gseo01-ordering',
    })
    expect(result.collection.kind).toBe('collected')
    expect(result.rowsWritten).toBe(1200)
    expect(await storedRowCount()).toBe(1200)
    expect((await heartbeat()).lastOutcome).toBe('succeeded')

    // The control: the Business Profile capabilities are still unselected and refused, so the pass did not
    // succeed because GBP had quietly started working.
    for (const capability of ['gbp_reviews', 'gbp_location', 'gbp_performance']) {
      const [row] = (await sql`
        select resource_ref, health from google_capabilities
        where connection_id = ${connectionId} and capability = ${capability} and is_primary
      `) as unknown as { resource_ref: unknown; health: string }[]
      expect(row?.resource_ref, capability).toBeNull()
    }
  }, 180_000)
})

describe('acceptance — the heartbeat is written on success and on failure', () => {
  it('records a succeeded run and moves last_success_at', async () => {
    await seedConnection()
    const before = await heartbeat()
    expect(before.lastSuccessAt).toBeUndefined()

    await runGscNightlySnapshot(sql, harness(generateRows(20)).deps, NOW_ISO, {
      jobId: 'job-gseo01-heartbeat',
    })

    const after = await heartbeat()
    expect(after.lastSuccessAt).toBe(instantFromIso(NOW_ISO))
    expect(after.lastOutcome).toBe('succeeded')
    const [run] = (await sql`
      select outcome, job_id, cost_fils::text as cost from agent_run
      where agent_key = ${SEO_GSC_SNAPSHOT_AGENT} order by started_at desc limit 1
    `) as unknown as { outcome: string; job_id: string | null; cost: string }[]
    expect(run?.outcome).toBe('succeeded')
    expect(run?.job_id).toBe('job-gseo01-heartbeat')
    // Zero fils: this pass calls Google and writes rows, and nothing in it calls a model.
    expect(run?.cost).toBe('0')
  }, 120_000)

  it('records a failed run without touching last_success_at, so the watchdog still sees silence', async () => {
    await seedConnection()
    const h = harness(generateRows(20))
    // A 5xx from Google. `TransientUpstream` does not degrade — the queue is meant to retry it — so this is
    // the path where the pass throws, and the heartbeat has to exist anyway. That asymmetry IS the
    // contract: a heartbeat written only on success cannot tell "running and failing" from "not running".
    h.gscFailures.failAlways('server_error')

    await expect(runGscNightlySnapshot(sql, h.deps, NOW_ISO)).rejects.toThrow(
      /Search Console nightly snapshot failed/,
    )

    const after = await heartbeat()
    expect(after.lastRunAt).toBe(instantFromIso(NOW_ISO))
    expect(after.lastSuccessAt).toBeUndefined()
    expect(after.lastOutcome).toBe('failed')
    expect(after.lastError ?? '').not.toBe('')
    // Nothing half-written: a failed fetch stores no warehouse rows and no snapshot.
    expect(await storedRowCount()).toBe(0)
    expect(
      await readGscSnapshot(sql, {
        siteUrl: SITE,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
      }),
    ).toBeUndefined()
  }, 120_000)

  it('succeeds and writes a heartbeat when no property has been selected, rather than failing nightly', async () => {
    // docs/10 §6: the fallback is the launch mode, not an error state. A degraded pass that failed the run
    // would alert the owner every 48 hours for the whole of onboarding — and an alert that fires for an
    // expected state is one nobody reads by the time a real one arrives.
    await seedConnection({ gscSelected: false })
    const result = await runGscNightlySnapshot(sql, harness().deps, NOW_ISO)
    expect(result.collection.kind).toBe('degraded')
    if (result.collection.kind !== 'degraded') throw new Error('unreachable')
    expect(result.collection.cause).toBe('ResourceNotSelected')
    expect(result.rowsWritten).toBe(0)
    expect((await heartbeat()).lastOutcome).toBe('succeeded')
    // And it wrote nothing, which is what makes the succeeded run honest rather than a claim of work.
    expect(await storedRowCount()).toBe(0)
  }, 120_000)
})

describe('the pass registers the inspection candidates the rotation will read', () => {
  it('registers every page that earned impressions, priority-ordered by clicks', async () => {
    await seedConnection()
    const result = await runGscNightlySnapshot(sql, harness(generateRows(800)).deps, NOW_ISO)
    if (result.collection.kind !== 'collected') throw new Error('unreachable')

    const rows = (await sql`
      select url, priority, last_inspected_at from seo_url_inspection
      where site_url = ${SITE} order by priority
    `) as unknown as { url: string; priority: number; last_inspected_at: Date | null }[]
    // 40 distinct pages in the generator, and the candidate set is the page set rather than the row set.
    expect(rows).toHaveLength(40)
    expect(result.candidatesRegistered).toBe(40)
    expect(rows.map((row) => row.priority)).toEqual([...Array(40).keys()])
    // Registered, never inspected: the rotation is the only thing that moves the cursor.
    expect(rows.every((row) => row.last_inspected_at === null)).toBe(true)
  }, 180_000)

  it('re-registering does not reset the rotation cursor', async () => {
    // The failure this guards: a nightly re-registration that touched `last_inspected_at` would make the
    // rotation start from the beginning every night, and the tail would never be inspected at all.
    await seedConnection()
    await runGscNightlySnapshot(sql, harness(generateRows(80)).deps, NOW_ISO)
    await sql`
      update seo_url_inspection set last_inspected_at = ${NOW_ISO}::timestamptz, inspections = 1
      where site_url = ${SITE}
    `
    await runGscNightlySnapshot(sql, harness(generateRows(80)).deps, NOW_ISO)
    const [row] = (await sql`
      select count(*)::text as n from seo_url_inspection
      where site_url = ${SITE} and last_inspected_at is null
    `) as unknown as { n: string }[]
    expect(Number(row?.n)).toBe(0)
  }, 180_000)
})
