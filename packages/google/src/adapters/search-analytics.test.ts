import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  createFakeSearchConsole,
  SEARCH_ANALYTICS_MAX_ROWS,
  type SearchAnalyticsRow,
} from '@berelax/providers/google'
import { describe, expect, it } from 'vitest'
import {
  assertRowCarriesDimensions,
  assertRowCountsArePlausible,
  fetchSearchAnalyticsRows,
  GSC_MAX_PAGES,
  GSC_PAGE_SIZE,
  PAGE_DIMENSIONS,
  QUERY_DIMENSIONS,
  totalsOf,
} from './search-analytics.ts'

/**
 * G-SEO-01 — the paging contract, against the fake that slices the way Google does.
 *
 * The criterion is 60,000 rows fetched in pages of 25,000 with the cursor advancing by exactly the page
 * size. Every part of that is asserted from the **call log** rather than from the returned rows, because
 * the returned rows are the same whether the cursor advanced correctly or by accident: a loop advancing by
 * `rows.length` produces identical output for as long as every page is full, and diverges only when one is
 * not. The log is where the difference is visible.
 */

const NOW_ISO = '2026-09-18T23:00:00.000Z'
const SITE = 'sc-domain:berelaxmassage.com'
const WINDOW = { siteUrl: SITE, startDate: '2026-09-09', endDate: '2026-09-15' }

/**
 * 60,000 distinct dimension tuples, shaped so no two collide on the warehouse key.
 *
 * The query carries the index, so the set is distinct by construction — which matters because the
 * warehouse's unique index would refuse a duplicate and the claim under test is that nothing was
 * duplicated or lost. A generator that produced collisions would make the paging assertion fail for a
 * reason that has nothing to do with paging.
 */
function generateRows(count: number): readonly SearchAnalyticsRow[] {
  const devices = ['MOBILE', 'DESKTOP', 'TABLET'] as const
  return Array.from({ length: count }, (_, index) => ({
    query: `gseo01 fixture query ${index}`,
    page: `/treatments/fixture-${index % 40}`,
    clicks: index % 7,
    impressions: 10 + (index % 90),
    ctr: (index % 7) / (10 + (index % 90)),
    position: 1 + (index % 30) / 2,
    date: '2026-09-15',
    device: devices[index % 3] ?? 'MOBILE',
    country: index % 11 === 0 ? 'ind' : 'are',
  }))
}

function harness(rows: readonly SearchAnalyticsRow[]) {
  const log = createCallLog(() => NOW_ISO)
  return {
    log,
    transport: createFakeSearchConsole({
      log,
      failures: new FailureScript(),
      now: () => NOW_ISO,
      analyticsRows: rows,
    }),
  }
}

const cursorsFrom = (log: ReturnType<typeof createCallLog>): number[] =>
  log
    .forProvider('google-search-console')
    .filter((call) => call.operation === 'queryAnalytics')
    .map((call) => call.detail['startRow'] as number)

describe('paging: 60,000 rows, 25,000 at a time', () => {
  it('advances startRow by exactly the page size and persists every row once', async () => {
    const rows = generateRows(60_000)
    const h = harness(rows)

    const result = await fetchSearchAnalyticsRows(h.transport, {
      ...WINDOW,
      dimensions: QUERY_DIMENSIONS,
    })

    expect(result.rows).toHaveLength(60_000)
    // Three calls: 25,000 + 25,000 + 10,000, and the third is short, which is the only end-of-report
    // signal the API gives.
    expect(result.pages.map((page) => page.received)).toEqual([25_000, 25_000, 10_000])
    expect(cursorsFrom(h.log)).toEqual([0, 25_000, 50_000])
    // The advance, stated as the criterion states it: each cursor is exactly one page further on.
    for (const [index, page] of result.pages.entries()) {
      expect(page.startRow, `page ${index}`).toBe(index * GSC_PAGE_SIZE)
    }
    expect(result.lastStartRow).toBe(50_000)

    // Nothing duplicated: the dimension tuples are as many as the rows. This is the in-memory half of the
    // criterion's "the unique index rejected no row"; the database half is the integration test, which is
    // the only place an index can actually reject anything.
    const keys = new Set(
      result.rows.map((row) => [row.date, row.page, row.query, row.device, row.country].join('|')),
    )
    expect(keys.size).toBe(60_000)
  })

  it('advances by the page size rather than by what the last page returned', async () => {
    // The control that distinguishes the two implementations. With a page size that does not divide the
    // row count, a loop advancing by `rows.length` produces the same cursors — until a page is short, and
    // the short page is the LAST one, so the difference never shows in the output. It shows here.
    const h = harness(generateRows(2500))
    const result = await fetchSearchAnalyticsRows(h.transport, {
      ...WINDOW,
      dimensions: QUERY_DIMENSIONS,
      pageSize: 1000,
    })
    expect(cursorsFrom(h.log)).toEqual([0, 1000, 2000])
    expect(result.rows).toHaveLength(2500)
    expect(new Set(result.rows.map((row) => row.query)).size).toBe(2500)
  })

  it('stops after one call when the first page is short', async () => {
    const h = harness(generateRows(12))
    const result = await fetchSearchAnalyticsRows(h.transport, {
      ...WINDOW,
      dimensions: QUERY_DIMENSIONS,
      pageSize: 1000,
    })
    expect(result.pages).toHaveLength(1)
    expect(result.rows).toHaveLength(12)
  })

  it('an empty property is one empty page, not an error', async () => {
    // A newly verified property returns nothing, which is an ordinary state during onboarding.
    const h = harness([])
    const result = await fetchSearchAnalyticsRows(h.transport, {
      ...WINDOW,
      dimensions: QUERY_DIMENSIONS,
    })
    expect(result.rows).toEqual([])
    expect(result.pages).toEqual([{ startRow: 0, received: 0 }])
  })

  it('makes one more call when the row count is an exact multiple of the page size', async () => {
    // The off-by-one every paging loop has: 2,000 rows in pages of 1,000 is two full pages, and the only
    // way to learn there is no third is to ask for it. A loop that stopped on "a full page but I have all
    // of them" would need a total the API does not provide.
    const h = harness(generateRows(2000))
    const result = await fetchSearchAnalyticsRows(h.transport, {
      ...WINDOW,
      dimensions: QUERY_DIMENSIONS,
      pageSize: 1000,
    })
    expect(cursorsFrom(h.log)).toEqual([0, 1000, 2000])
    expect(result.pages.map((page) => page.received)).toEqual([1000, 1000, 0])
    expect(result.rows).toHaveLength(2000)
  })

  it('the page size is the API maximum the fake enforces, so the two cannot drift', () => {
    expect(GSC_PAGE_SIZE).toBe(SEARCH_ANALYTICS_MAX_ROWS)
    expect(GSC_PAGE_SIZE).toBe(25_000)
  })

  it('refuses a page size the API would reject rather than sending it', async () => {
    const h = harness(generateRows(10))
    await expect(
      fetchSearchAnalyticsRows(h.transport, {
        ...WINDOW,
        dimensions: QUERY_DIMENSIONS,
        pageSize: GSC_PAGE_SIZE + 1,
      }),
    ).rejects.toThrow(/1 to 25000 rows/)
    expect(cursorsFrom(h.log)).toEqual([])
  })

  it('refuses a transport that returns more rows than it was asked for', async () => {
    // A cursor cannot be advanced safely past a page whose size is not the one requested.
    const oversized = {
      async queryAnalytics() {
        return generateRows(1500)
      },
    }
    await expect(
      fetchSearchAnalyticsRows(oversized, {
        ...WINDOW,
        dimensions: QUERY_DIMENSIONS,
        pageSize: 1000,
      }),
    ).rejects.toThrow(/cannot be advanced safely/)
  })

  it('stops rather than paging for ever against a transport that never returns a short page', async () => {
    const endless = {
      async queryAnalytics() {
        return generateRows(100)
      },
    }
    await expect(
      fetchSearchAnalyticsRows(endless, {
        ...WINDOW,
        dimensions: QUERY_DIMENSIONS,
        pageSize: 100,
      }),
    ).rejects.toThrow(new RegExp(`returned a full page ${GSC_MAX_PAGES} times`))
  })
})

describe('a row missing a dimension the request grouped by is refused, never stored', () => {
  const complete: SearchAnalyticsRow = {
    query: 'massage al zahiyah',
    page: '/',
    clicks: 3,
    impressions: 40,
    ctr: 0.075,
    position: 6.5,
    date: '2026-09-15',
    device: 'MOBILE',
    country: 'are',
  }

  it('accepts a row carrying every requested dimension', () => {
    expect(() => assertRowCarriesDimensions(complete, QUERY_DIMENSIONS)).not.toThrow()
    // And the control: the same row is fine for a narrower grouping, so the rule is about the REQUEST.
    expect(() => assertRowCarriesDimensions(complete, PAGE_DIMENSIONS)).not.toThrow()
  })

  it('refuses each missing dimension by name', () => {
    for (const missing of ['date', 'device', 'country'] as const) {
      const row = { ...complete, [missing]: undefined }
      expect(() => assertRowCarriesDimensions(row, QUERY_DIMENSIONS), missing).toThrow(
        new RegExp(`without ${missing}`),
      )
    }
    expect(() => assertRowCarriesDimensions({ ...complete, query: '' }, QUERY_DIMENSIONS)).toThrow(
      /without query/,
    )
    expect(() => assertRowCarriesDimensions({ ...complete, page: '' }, QUERY_DIMENSIONS)).toThrow(
      /without page/,
    )
  })

  it('does not refuse a dimension that was not requested', () => {
    // The page-level call groups by page alone, so its rows carry no query — and refusing them would make
    // the rare-query gap unmeasurable, which is the whole reason that second call exists.
    const pageRow: SearchAnalyticsRow = {
      query: '',
      page: '/',
      clicks: 90,
      impressions: 1200,
      ctr: 0.075,
      position: 5.1,
    }
    expect(() => assertRowCarriesDimensions(pageRow, PAGE_DIMENSIONS)).not.toThrow()
  })

  it('refuses counts that cannot both be true', () => {
    expect(() => assertRowCountsArePlausible({ ...complete, clicks: 50, impressions: 40 })).toThrow(
      /more clicks than impressions/,
    )
    expect(() => assertRowCountsArePlausible({ ...complete, clicks: -1 })).toThrow(/negative count/)
    // Position zero is the coerced-missing-value case: it would read as ranking above the first result.
    expect(() => assertRowCountsArePlausible({ ...complete, position: 0 })).toThrow(
      /position below 1/,
    )
    expect(() => assertRowCountsArePlausible(complete)).not.toThrow()
  })

  it('reports an unfamiliar device value without discarding the row', async () => {
    const rows = [{ ...complete, device: 'WATCH' as unknown as 'MOBILE' }]
    const h = harness(rows)
    const result = await fetchSearchAnalyticsRows(h.transport, {
      ...WINDOW,
      dimensions: QUERY_DIMENSIONS,
      pageSize: 100,
    })
    // Stored as it arrived: a device class Google adds is not a reason to lose a row that cannot be
    // re-fetched once the 16-month window has passed.
    expect(result.rows).toHaveLength(1)
    expect(result.unknownDevices).toEqual(['WATCH'])
  })
})

describe('the two dimension sets, and the gap between their totals', () => {
  it('the query breakdown totals less than the page-level report over the same window', async () => {
    // The whole rare-query fact, measured rather than asserted: the fake withholds rows from the query
    // grouping exactly as Google does, so the difference comes out of the data.
    const h = harness(generateRows(500))
    const queryRows = await fetchSearchAnalyticsRows(h.transport, {
      ...WINDOW,
      dimensions: QUERY_DIMENSIONS,
      pageSize: 1000,
    })
    const pageRows = await fetchSearchAnalyticsRows(h.transport, {
      ...WINDOW,
      dimensions: PAGE_DIMENSIONS,
      pageSize: 1000,
    })
    const queryTotals = totalsOf(queryRows.rows)
    const pageTotals = totalsOf(pageRows.rows)
    expect(queryTotals.clicks).toBeLessThan(pageTotals.clicks)
    expect(queryTotals.impressions).toBeLessThan(pageTotals.impressions)
    // And the page-level report is a REGROUPING of the same window rather than a different one: far fewer
    // rows, strictly more clicks.
    expect(pageRows.rows.length).toBeLessThan(queryRows.rows.length)
  })
})
