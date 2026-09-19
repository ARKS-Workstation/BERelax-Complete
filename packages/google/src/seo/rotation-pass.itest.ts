import { generateKek } from '@berelax/clinical'
import { fixedClock, GOOGLE_CAPABILITIES, instantFromIso } from '@berelax/core'
import {
  agentsWithHeartbeat,
  claimUrlInspectionBatch,
  createConnection,
  inspectionCoverage,
  openInspectionRun,
  registerInspectionCandidates,
  type Sql,
} from '@berelax/db'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakeGoogleOAuth, createFakeSearchConsole } from '@berelax/providers/google'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPostgresConnectionStore } from '../postgres-store.ts'
import { createPostgresRefreshLock } from '../token-refresh.ts'
import { connectionBinding, sealToken } from '../token-store.ts'
import type { WithGoogleDeps } from '../with-google.ts'
import { runUrlInspectionRotation, SEO_URL_INSPECTION_AGENT } from './rotation-pass.ts'
import type { UrlInspectionDeps } from './url-inspection.ts'

/**
 * G-SEO-01 — the URL Inspection rotation: 5,000 candidates, a 2,000-a-day cap, three runs.
 *
 * The criterion is precise and every clause of it is a separate way to get this wrong:
 *
 *   *exactly 2,000 are inspected per run* — the cap does not carry over, so a run that stopped at the end
 *   of a coverage cycle would throw away the rest of the day's quota for ever;
 *
 *   *all 5,000 are covered within three runs* — which needs the selection to prefer what it has never
 *   inspected, not what a shuffle happens to pick;
 *
 *   *no URL inspected twice before full coverage completes* — the one that a random or hash-based subset
 *   fails silently, because the symptom is a URL nobody has looked at rather than an error.
 *
 * So the whole three-day rotation is driven here and compared **by set**: the union of the three runs, the
 * intersection of the first two, and the exact identity of the 1,000 URLs the third run covers first.
 *
 * The cap is enforced by the fake as well as by the arithmetic: its 2,001st call in one of Google's days
 * throws `quota_exhausted`, the way the real API does. A rotation tested against a fake with no cap proves
 * only that its own accounting agrees with itself.
 */

const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!DATABASE_URL)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const KEK = generateKek('v1')
const SUB = 'sub-gseo01-rotation'
const REFRESH_TOKEN = '1//09-gseo01-rotation-refresh-token-never-in-a-row'
/** Visibly a fixture (the brief's rule 15), and a property no other suite writes. */
const SITE = 'sc-domain:gseo01-rotation.invalid'
/** Three consecutive nights at 05:30 Asia/Dubai, which is 01:30 UTC — three different Google days. */
const NIGHTS = [
  '2026-09-17T01:30:00.000Z',
  '2026-09-18T01:30:00.000Z',
  '2026-09-19T01:30:00.000Z',
] as const
const CANDIDATES = 5000
const CAP = 2000

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
  // Narrowing what the code under test can SEE rather than deleting rows a foreign key protects — the
  // brief's rule 12 and `with-google.itest.ts`'s recorded failure.
  await sql`update google_connections set status = 'disconnected' where google_sub <> ${SUB}`
  await sql`delete from google_connections where google_sub = ${SUB}`
  await sql`delete from seo_url_inspection where site_url = ${SITE}`
  await sql`delete from seo_url_inspection_run where site_url = ${SITE}`
  await sql`delete from agent_run where agent_key = ${SEO_URL_INSPECTION_AGENT}`
  await sql`
    update agent_heartbeat
    set last_run_at = null, last_success_at = null, last_failure_at = null, last_error = null,
        last_outcome = null, consecutive_failures = 0
    where agent_key = ${SEO_URL_INSPECTION_AGENT}
  `
  await sql`
    update agent_definition set enabled = true, kill_switch = false
    where agent_key = ${SEO_URL_INSPECTION_AGENT}
  `
})

async function seedConnection(): Promise<string> {
  const id = await store.allocateId()
  await store.insert({
    id,
    googleSub: SUB,
    googleEmail: 'google-admin@berelax.ae',
    grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
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
      resourceRef: capability === 'gsc' ? { siteUrl: SITE } : null,
      health: capability === 'gsc' ? 'unknown' : 'permission_missing',
      isPrimary: true,
    })
  }
  return id
}

/**
 * 5,000 candidate URLs with a distinct priority each.
 *
 * A distinct priority is what makes the rotation reproducible: with ties, two runs holding the same state
 * could choose different subsets and every set comparison below would be about luck. The real candidate
 * list is priority-ordered by the clicks each page earned, which the nightly snapshot writes.
 */
function candidates(count = CANDIDATES): readonly { url: string; priority: number }[] {
  return Array.from({ length: count }, (_, index) => ({
    url: `https://gseo01-rotation.invalid/page-${String(index).padStart(4, '0')}`,
    priority: index,
  }))
}

function deps(atIso: string, options: { readonly cap?: number } = {}): UrlInspectionDeps {
  const log = createCallLog(() => atIso)
  const google: WithGoogleDeps = {
    store,
    lock: createPostgresRefreshLock(sql),
    oauth: createFakeGoogleOAuth({
      log,
      failures: new FailureScript(),
      now: () => atIso,
      sub: SUB,
    }),
    kek: KEK,
    clock: fixedClock(atIso),
    logger: { log: () => {} },
    newCorrelationId: () => `corr-gseo01-rotation-${atIso}`,
  }
  return {
    google,
    searchConsole: createFakeSearchConsole({
      log,
      failures: new FailureScript(),
      now: () => atIso,
      // The cap the fake ENFORCES, which is Google's own unless a test lowers it to reach the refusal
      // without 2,000 calls.
      urlInspectionCap: options.cap ?? CAP,
    }),
  }
}

async function uncoveredUrls(): Promise<readonly string[]> {
  const rows = (await sql`
    select url from seo_url_inspection
    where site_url = ${SITE} and last_inspected_at is null
    order by priority
  `) as unknown as { url: string }[]
  return rows.map((row) => row.url)
}

async function ledgerFor(runDate: string): Promise<{ inspected: number; cap: number }> {
  const [row] = (await sql`
    select inspected, daily_cap from seo_url_inspection_run
    where site_url = ${SITE} and run_date = ${runDate}::date
  `) as unknown as { inspected: number; daily_cap: number }[]
  return { inspected: row?.inspected ?? 0, cap: row?.daily_cap ?? 0 }
}

describe('acceptance — 5,000 candidates, 2,000 a day, covered within three runs', () => {
  it('inspects exactly 2,000 per run, covers every URL by the third, and repeats none before it', async () => {
    await seedConnection()
    expect(
      await registerInspectionCandidates(sql, { siteUrl: SITE, candidates: candidates() }),
    ).toBe(CANDIDATES)

    const first = await runUrlInspectionRotation(sql, deps(NIGHTS[0]), NIGHTS[0], {
      dailyCap: CAP,
    })
    const second = await runUrlInspectionRotation(sql, deps(NIGHTS[1]), NIGHTS[1], {
      dailyCap: CAP,
    })
    // Captured BEFORE the third run: these are the 1,000 the rotation has never touched, and the criterion
    // is that the third run takes exactly these before it re-inspects anything.
    const uncoveredBeforeThird = await uncoveredUrls()
    expect(uncoveredBeforeThird).toHaveLength(1000)
    const third = await runUrlInspectionRotation(sql, deps(NIGHTS[2]), NIGHTS[2], {
      dailyCap: CAP,
    })

    // Exactly 2,000 per run. The third takes a full 2,000 too: the cap does not carry over, so the honest
    // use of the remainder after coverage completes is to begin the next cycle with it.
    expect([first.claimed.length, second.claimed.length, third.claimed.length]).toEqual([
      CAP,
      CAP,
      CAP,
    ])
    // Every run claimed 2,000 DISTINCT URLs — a claim that handed the same URL twice inside one run would
    // spend two calls on one answer.
    for (const [index, run] of [first, second, third].entries()) {
      expect(new Set(run.claimed).size, `run ${index + 1}`).toBe(CAP)
    }

    // Runs one and two are disjoint: 4,000 distinct URLs between them.
    expect(new Set([...first.claimed, ...second.claimed]).size).toBe(4000)

    // The third run's first 1,000 are exactly the URLs nothing had inspected — by set comparison, which is
    // what the criterion asks for.
    expect(new Set(third.claimed.slice(0, 1000))).toEqual(new Set(uncoveredBeforeThird))
    expect(new Set(third.newlyCovered)).toEqual(new Set(uncoveredBeforeThird))

    // Full coverage, and nothing inspected twice before it: 5,000 inspections, 5,000 distinct URLs.
    const beforeCoverageCompleted = [
      ...first.claimed,
      ...second.claimed,
      ...third.claimed.slice(0, 1000),
    ]
    expect(beforeCoverageCompleted).toHaveLength(CANDIDATES)
    expect(new Set(beforeCoverageCompleted).size).toBe(CANDIDATES)
    expect(new Set(beforeCoverageCompleted)).toEqual(new Set(candidates().map((c) => c.url)))

    // And the database agrees, which is the claim the persisted cursor makes: nothing is uncovered.
    const coverage = await inspectionCoverage(sql, SITE)
    expect(coverage).toEqual({
      candidates: CANDIDATES,
      everInspected: CANDIDATES,
      neverInspected: 0,
    })

    // The 1,000 re-inspections are the beginning of the next cycle, and they are the ones inspected
    // EARLIEST — the least recently inspected, which is what the cursor orders by.
    const [twice] = (await sql`
      select count(*)::text as n from seo_url_inspection
      where site_url = ${SITE} and inspections = 2
    `) as unknown as { n: string }[]
    expect(Number(twice?.n)).toBe(1000)
    const repeated = third.claimed.slice(1000)
    expect(new Set(repeated).size).toBe(1000)
    expect(repeated.every((url) => first.claimed.includes(url))).toBe(true)

    // Nothing failed and the cap was never breached: the fake refuses the 2,001st call in a day, so a
    // silent overspend would have thrown rather than passed.
    for (const run of [first, second, third]) {
      expect(run.collection?.kind).toBe('inspected')
      if (run.collection?.kind !== 'inspected') throw new Error('unreachable')
      expect(run.collection.failures).toEqual([])
      expect(run.collection.quotaExhausted).toBe(false)
      expect(run.recorded).toBe(CAP)
    }
    // One ledger row per Google day, each at exactly the cap.
    expect(await ledgerFor('2026-09-17')).toEqual({ inspected: CAP, cap: CAP })
    expect(await ledgerFor('2026-09-18')).toEqual({ inspected: CAP, cap: CAP })
    expect(await ledgerFor('2026-09-19')).toEqual({ inspected: CAP, cap: CAP })
  }, 600_000)

  it('a second run on the same day takes nothing, because the cap is per day and not per run', async () => {
    // The retry case. A pass that treated the cap as per run would spend a second 2,000 on the day it had
    // already spent, and the back of the rotation would never be reached.
    await seedConnection()
    await registerInspectionCandidates(sql, { siteUrl: SITE, candidates: candidates(300) })
    const first = await runUrlInspectionRotation(sql, deps(NIGHTS[0]), NIGHTS[0], {
      dailyCap: 100,
    })
    expect(first.claimed).toHaveLength(100)

    const retry = await runUrlInspectionRotation(sql, deps(NIGHTS[0]), NIGHTS[0], {
      dailyCap: 100,
    })
    expect(retry.claimed).toEqual([])
    expect(retry.capReached).toBe(true)
    expect(retry.spentBefore).toBe(100)
    // A run that took nothing is still a successful run: the quota is spent, which is not a fault.
    const agents = await agentsWithHeartbeat(sql)
    expect(
      agents.find((agent) => agent.agentKey === SEO_URL_INSPECTION_AGENT)?.heartbeat.lastOutcome,
    ).toBe('succeeded')
    expect(await ledgerFor('2026-09-17')).toEqual({ inspected: 100, cap: 100 })
  }, 300_000)
})

describe('the rotation state is persisted, not computed', () => {
  it('claims the least recently inspected first, with never-inspected ahead of everything', async () => {
    await seedConnection()
    await registerInspectionCandidates(sql, { siteUrl: SITE, candidates: candidates(10) })
    // Two rows inspected long ago, two inspected recently, six never — deliberately in an order that
    // disagrees with priority, so the cursor is what decides rather than the priority tie-break.
    await sql`
      update seo_url_inspection set last_inspected_at = ${NIGHTS[0]}::timestamptz, inspections = 1
      where site_url = ${SITE} and priority in (0, 1)
    `
    await sql`
      update seo_url_inspection set last_inspected_at = ${NIGHTS[1]}::timestamptz, inspections = 1
      where site_url = ${SITE} and priority in (2, 3)
    `
    await openInspectionRun(sql, { siteUrl: SITE, runDate: '2026-09-19', dailyCap: 100 })
    const claimed = await claimUrlInspectionBatch(sql, {
      siteUrl: SITE,
      runDate: '2026-09-19',
      nowIso: NIGHTS[2],
      take: 10,
    })
    // Six never-inspected first, in priority order, then the two oldest, then the two newest.
    expect(claimed.slice(0, 6).map((row) => row.priority)).toEqual([4, 5, 6, 7, 8, 9])
    expect(claimed.slice(0, 6).every((row) => row.previouslyInspectedAtIso === null)).toBe(true)
    expect(claimed.slice(6).map((row) => row.priority)).toEqual([0, 1, 2, 3])
    expect(claimed[6]?.previouslyInspectedAtIso).toBe(NIGHTS[0])
    expect(claimed[8]?.previouslyInspectedAtIso).toBe(NIGHTS[1])
  }, 120_000)

  it('the database refuses a claim that would breach the day cap', async () => {
    // The caller computes the budget in `@berelax/core` because `packages/db` may not import it — so the
    // cap is ALSO a CHECK constraint, and this is the probe that makes the pairing checkable rather than
    // trusted. A miscomputed `take` fails here instead of spending a quota Google will refuse.
    await seedConnection()
    await registerInspectionCandidates(sql, { siteUrl: SITE, candidates: candidates(50) })
    await openInspectionRun(sql, { siteUrl: SITE, runDate: '2026-09-19', dailyCap: 10 })
    await expect(
      claimUrlInspectionBatch(sql, {
        siteUrl: SITE,
        runDate: '2026-09-19',
        nowIso: NIGHTS[2],
        take: 40,
      }),
    ).rejects.toThrow(/seo_url_inspection_run_stays_within_the_daily_cap/)
    // And nothing was marked: the claim and the ledger increment are one transaction, so a refused
    // increment rolls the cursor back with it. Without that, 40 URLs would have been spent against a
    // ledger that says 0 and the rotation would skip them for a whole cycle.
    expect(await uncoveredUrls()).toHaveLength(50)
  }, 120_000)

  it('a rotation state row cannot claim an inspection it has no timestamp for', async () => {
    // `seo_url_inspection_inspected_rows_carry_a_timestamp`: a row counted as inspected with no timestamp
    // sorts as never-inspected under NULLS FIRST, so it would be handed to the very next run — inspected
    // twice while another URL had not been inspected at all.
    await registerInspectionCandidates(sql, { siteUrl: SITE, candidates: candidates(1) })
    await expect(sql`
      update seo_url_inspection set inspections = 1
      where site_url = ${SITE}
    `).rejects.toThrow(/seo_url_inspection_inspected_rows_carry_a_timestamp/)
  })
})

describe('what Google said is recorded, including the case it has never crawled', () => {
  it('stores a verdict and a coverage state per URL, and no crawl date for one never crawled', async () => {
    await seedConnection()
    await registerInspectionCandidates(sql, { siteUrl: SITE, candidates: candidates(120) })
    const run = await runUrlInspectionRotation(sql, deps(NIGHTS[0]), NIGHTS[0], {
      dailyCap: 120,
    })
    expect(run.recorded).toBe(120)

    const rows = (await sql`
      select verdict, coverage_state, last_crawled_at from seo_url_inspection
      where site_url = ${SITE}
    `) as unknown as {
      verdict: string | null
      coverage_state: string | null
      last_crawled_at: Date | null
    }[]
    expect(rows).toHaveLength(120)
    expect(rows.every((row) => row.verdict !== null && row.coverage_state !== null)).toBe(true)
    // The fake's verdicts are deterministic per URL and deliberately not uniformly PASS: the two states
    // worth acting on are "crawled and not indexed" and "discovered and not crawled".
    const verdicts = new Set(rows.map((row) => row.verdict))
    expect(verdicts.has('PASS')).toBe(true)
    expect(verdicts.has('NEUTRAL')).toBe(true)
    // The empty case, handled rather than zeroed (docs/10 §7): a URL Google has never crawled carries no
    // crawl date, and inventing one would read as a crawl that happened.
    const discovered = rows.filter((row) => row.coverage_state?.startsWith('Discovered'))
    expect(discovered.length).toBeGreaterThan(0)
    expect(discovered.every((row) => row.last_crawled_at === null)).toBe(true)
    const crawled = rows.filter((row) => row.coverage_state?.startsWith('Crawled'))
    expect(crawled.length).toBeGreaterThan(0)
    expect(crawled.every((row) => row.last_crawled_at !== null)).toBe(true)
  }, 300_000)

  it('stops the batch when Google refuses on quota, rather than spending the rest of the day on refusals', async () => {
    // The fake's cap is lower than the run's here, which is the shape of a quota somebody else has already
    // spent — a manual inspection in the Search Console UI, or a second tool on the same property.
    await seedConnection()
    await registerInspectionCandidates(sql, { siteUrl: SITE, candidates: candidates(60) })
    const run = await runUrlInspectionRotation(sql, deps(NIGHTS[0], { cap: 25 }), NIGHTS[0], {
      dailyCap: 60,
    })
    expect(run.claimed).toHaveLength(60)
    if (run.collection?.kind !== 'inspected') throw new Error('unreachable')
    expect(run.collection.quotaExhausted).toBe(true)
    // 25 answers, and the batch stopped rather than making 35 calls that would each be refused.
    expect(run.collection.outcomes).toHaveLength(25)
    expect(run.recorded).toBe(25)
    // The claim is not rolled back, deliberately: Google charged the quota for the requests it answered,
    // and the 35 it refused are at the FRONT of the next run's order because their cursor moved with the
    // rest. Re-opening the cursor here is the beginning of a loop that spends a cap on the same URLs.
    expect(await uncoveredUrls()).toHaveLength(0)
    // A run that hit somebody else's quota is still a successful run: it recorded what it learned.
    const agents = await agentsWithHeartbeat(sql)
    expect(
      agents.find((agent) => agent.agentKey === SEO_URL_INSPECTION_AGENT)?.heartbeat.lastOutcome,
    ).toBe('succeeded')
  }, 300_000)

  it('degrades rather than failing when no property has been selected', async () => {
    // docs/10 §6 again: before the owner has chosen a property there is nothing to inspect, and a cron that
    // failed nightly through onboarding is a cron whose alerts nobody reads.
    const id = await store.allocateId()
    await store.insert({
      id,
      googleSub: SUB,
      googleEmail: 'google-admin@berelax.ae',
      grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      refreshToken: sealToken(
        KEK,
        connectionBinding({ connectionId: id, googleSub: SUB }),
        REFRESH_TOKEN,
      ),
      consentAt: instantFromIso('2026-09-12T10:00:00.000Z'),
    })
    await store.upsertCapability({
      connectionId: id,
      capability: 'gsc',
      resourceRef: null,
      health: 'unknown',
      isPrimary: true,
    })
    const run = await runUrlInspectionRotation(sql, deps(NIGHTS[0]), NIGHTS[0], {
      dailyCap: 10,
    })
    expect(run.collection?.kind).toBe('degraded')
    expect(run.claimed).toEqual([])
    const agents = await agentsWithHeartbeat(sql)
    expect(
      agents.find((agent) => agent.agentKey === SEO_URL_INSPECTION_AGENT)?.heartbeat.lastOutcome,
    ).toBe('succeeded')
  }, 120_000)
})
