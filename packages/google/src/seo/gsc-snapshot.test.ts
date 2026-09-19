import { generateKek } from '@berelax/clinical'
import { fixedClock, instantFromIso, localDate, rareQueryGapExplanation } from '@berelax/core'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  createFakeGoogleOAuth,
  createFakeSearchConsole,
  RARE_QUERY_CLICKS,
  RARE_QUERY_IMPRESSIONS,
  type SearchAnalyticsRow,
} from '@berelax/providers/google'
import { describe, expect, it } from 'vitest'
import { connectionRecord, createMemoryConnectionStore } from '../memory-store.ts'
import { createMemoryRefreshLock } from '../token-refresh.ts'
import { connectionBinding, sealToken } from '../token-store.ts'
import type { WithGoogleDeps } from '../with-google.ts'
import {
  assertWindowRespectsLag,
  collectGscSnapshot,
  type GscSnapshotDeps,
  positionCenti,
  toWarehouseRow,
} from './gsc-snapshot.ts'

/**
 * G-SEO-01 — the collection, without a database.
 *
 * Three claims live here because none of them needs PostgreSQL and all three would be slower and less
 * legible inside the integration suite: the window the job asks Google for (the 2–3 day lag), the
 * rare-query gap coming out of the fake's own withheld rows rather than a constant, and degradation when
 * no property has been selected. The persistence, the heartbeat and the unique index are the integration
 * test's, because each of them is a claim about the database.
 */

const KEK = generateKek('v1')
const NOW_ISO = '2026-09-18T23:00:00.000Z'
const CONNECTION_ID = '01920000-0000-7000-8000-0000000005e0'
const SUB = 'sub-gseo01-collector'
const SITE = 'sc-domain:berelaxmassage.com'
const REFRESH_TOKEN = '1//09-gseo01-collector-refresh-token-never-in-a-row'

function harness(
  options: {
    readonly withResource?: boolean
    readonly rows?: readonly SearchAnalyticsRow[]
    readonly status?: 'active' | 'needs_reauth'
  } = {},
) {
  const log = createCallLog(() => NOW_ISO)
  const store = createMemoryConnectionStore([
    connectionRecord({
      id: CONNECTION_ID,
      googleSub: SUB,
      refreshToken: sealToken(
        KEK,
        connectionBinding({ connectionId: CONNECTION_ID, googleSub: SUB }),
        REFRESH_TOKEN,
      ),
      consentAt: instantFromIso('2026-09-10T10:00:00.000Z'),
      status: options.status ?? 'active',
      statusReason: options.status === 'needs_reauth' ? 'invalid_grant' : null,
    }),
  ])
  store.putCapability({
    connectionId: CONNECTION_ID,
    capability: 'gsc',
    resourceRef: (options.withResource ?? true) ? { siteUrl: SITE } : null,
    health: 'unknown',
    isPrimary: true,
  })
  const google: WithGoogleDeps = {
    store,
    lock: createMemoryRefreshLock(store),
    oauth: createFakeGoogleOAuth({
      log,
      failures: new FailureScript(),
      now: () => NOW_ISO,
      sub: SUB,
    }),
    kek: KEK,
    clock: fixedClock(NOW_ISO),
    logger: { log: () => {} },
    newCorrelationId: () => 'corr-gseo01-collector',
  }
  const deps: GscSnapshotDeps = {
    google,
    searchConsole: createFakeSearchConsole({
      log,
      failures: new FailureScript(),
      now: () => NOW_ISO,
      ...(options.rows === undefined ? {} : { analyticsRows: options.rows }),
    }),
  }
  return { deps, log, store }
}

const analyticsCalls = (log: ReturnType<typeof createCallLog>) =>
  log
    .forProvider('google-search-console')
    .filter((call) => call.operation === 'queryAnalytics')
    .map((call) => call.detail)

describe('the window Google is asked for respects the 2-3 day lag', () => {
  it('requests today minus 3 and never today or yesterday, on a frozen clock', async () => {
    const h = harness()
    const collection = await collectGscSnapshot(h.deps, instantFromIso(NOW_ISO))
    expect(collection.kind).toBe('collected')
    if (collection.kind !== 'collected') throw new Error('unreachable')

    expect(collection.window).toEqual({ startDate: '2026-09-09', endDate: '2026-09-15' })
    // Asserted from what reached the transport, not from the returned value: the window the job computed
    // and the window it asked for are two different claims, and only the second one matters to Google.
    const calls = analyticsCalls(h.log)
    expect(calls.length).toBe(2)
    for (const call of calls) {
      expect(call['startDate']).toBe('2026-09-09')
      expect(call['endDate']).toBe('2026-09-15')
      expect(call['endDate']).not.toBe('2026-09-18')
      expect(call['endDate']).not.toBe('2026-09-17')
    }
  })

  it('refuses a window that reaches into the lag before any call is made', async () => {
    const at = instantFromIso(NOW_ISO)
    expect(() =>
      assertWindowRespectsLag(
        { startDate: localDate('2026-09-12'), endDate: localDate('2026-09-18') },
        at,
      ),
    ).toThrow(/reaches into the Search Console lag/)
    // And the one it computes itself is accepted, so the refusal is not simply always on.
    expect(() =>
      assertWindowRespectsLag(
        { startDate: localDate('2026-09-09'), endDate: localDate('2026-09-15') },
        at,
      ),
    ).not.toThrow()
  })

  it('makes the query-level request with all five warehouse dimensions and the page one with page alone', async () => {
    const h = harness()
    await collectGscSnapshot(h.deps, instantFromIso(NOW_ISO))
    const calls = analyticsCalls(h.log)
    expect(calls[0]?.['dimensions']).toEqual(['date', 'query', 'page', 'device', 'country'])
    expect(calls[1]?.['dimensions']).toEqual(['page'])
    // The second call is the one that still counts the withheld clicks. If both grouped by query there
    // would be no gap to store, and the criterion would be satisfied by a column that is always zero.
    expect(calls[0]?.['withheldIncluded']).toBe(false)
    expect(calls[1]?.['withheldIncluded']).toBe(true)
  })
})

describe('the rare-query gap comes out of the data', () => {
  it('reports a query total below the page total, differing by exactly what the fake withheld', async () => {
    const h = harness()
    const collection = await collectGscSnapshot(h.deps, instantFromIso(NOW_ISO))
    if (collection.kind !== 'collected') throw new Error('unreachable')

    expect(collection.queryTotals.clicks).toBeLessThan(collection.pageTotals.clicks)
    // Derived on both sides: the fake exports the sum of the rows it withholds, so neither this test nor
    // the code under it holds a literal that the other has to be kept in step with.
    expect(collection.pageTotals.clicks - collection.queryTotals.clicks).toBe(RARE_QUERY_CLICKS)
    expect(collection.pageTotals.impressions - collection.queryTotals.impressions).toBe(
      RARE_QUERY_IMPRESSIONS,
    )
  })

  it('the withheld query text never reaches a warehouse row', async () => {
    // The fake marks its withheld rows visibly rather than plausibly, so a leak is a defect rather than
    // data. This is the assertion that would catch one.
    const h = harness()
    const collection = await collectGscSnapshot(h.deps, instantFromIso(NOW_ISO))
    if (collection.kind !== 'collected') throw new Error('unreachable')
    expect(collection.rows.some((row) => row.query.includes('withheld'))).toBe(false)
  })

  it('renders the owner-facing sentence from the collected totals', async () => {
    const h = harness()
    const collection = await collectGscSnapshot(h.deps, instantFromIso(NOW_ISO))
    if (collection.kind !== 'collected') throw new Error('unreachable')
    const sentence = rareQueryGapExplanation({
      queryClicks: collection.queryTotals.clicks,
      pageClicks: collection.pageTotals.clicks,
      queryImpressions: collection.queryTotals.impressions,
      pageImpressions: collection.pageTotals.impressions,
    })
    expect(sentence).toContain(String(RARE_QUERY_CLICKS))
    expect(sentence).toContain('too rare')
  })
})

describe('the rows are converted for the warehouse without inventing a dimension', () => {
  it('carries every dimension across and stores the position as integer hundredths', async () => {
    const h = harness()
    const collection = await collectGscSnapshot(h.deps, instantFromIso(NOW_ISO))
    if (collection.kind !== 'collected') throw new Error('unreachable')
    const brand = collection.rows.find((row) => row.query === 'be relax abu dhabi')
    expect(brand).toEqual({
      siteUrl: SITE,
      date: '2026-09-15',
      page: '/',
      query: 'be relax abu dhabi',
      device: 'MOBILE',
      country: 'are',
      clicks: 142,
      impressions: 310,
      avgPositionCenti: 120,
    })
    // Every row carries the property it was fetched for: two properties for one website are two datasets,
    // and a row with the wrong `siteUrl` would merge them.
    expect(collection.rows.every((row) => row.siteUrl === SITE)).toBe(true)
  })

  it('rounds the position half-up rather than truncating it', () => {
    expect(positionCenti(6.785)).toBe(679)
    expect(positionCenti(1.2)).toBe(120)
    expect(positionCenti(18.3)).toBe(1830)
  })

  it('throws rather than defaulting a missing dimension, if one ever reaches the converter', () => {
    // Unreachable through the adapter, which refuses first — and asserted anyway, because a `?? 'DESKTOP'`
    // here would turn a missing device into a plausible one and collide with the genuine desktop row.
    expect(() =>
      toWarehouseRow(SITE, {
        query: 'q',
        page: '/',
        clicks: 1,
        impressions: 2,
        ctr: 0.5,
        position: 3,
        date: '2026-09-15',
        country: 'are',
      }),
    ).toThrow(/without its date, device or country/)
  })
})

describe('degradation, which is a launch state rather than an error', () => {
  it('degrades to disabled with ResourceNotSelected when no property has been chosen', async () => {
    const h = harness({ withResource: false })
    const collection = await collectGscSnapshot(h.deps, instantFromIso(NOW_ISO))
    expect(collection.kind).toBe('degraded')
    if (collection.kind !== 'degraded') throw new Error('unreachable')
    expect(collection.cause).toBe('ResourceNotSelected')
    // The SEO agent's declared mode: Search Console data has no manual substitute, so there is nothing to
    // fall back to and saying `disabled` is the honest answer.
    expect(collection.mode).toBe('disabled')
    // And nothing was fetched — a degraded pass must not have asked Google anything.
    expect(analyticsCalls(h.log)).toEqual([])
  })

  it('degrades with GoogleReauthRequired on a connection whose grant is dead', async () => {
    const h = harness({ status: 'needs_reauth' })
    const collection = await collectGscSnapshot(h.deps, instantFromIso(NOW_ISO))
    if (collection.kind !== 'degraded') throw new Error('unreachable')
    expect(collection.cause).toBe('GoogleReauthRequired')
    expect(analyticsCalls(h.log)).toEqual([])
  })
})
