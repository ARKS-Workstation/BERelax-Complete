import {
  CTR_OUTLIER_POSITION_WINDOW,
  cannibalisation,
  contentGaps,
  ctrOutliers,
  type SeoQueryRow,
} from '@berelax/core'
import type { GscDailyRow } from '@berelax/db'
import { describe, expect, it } from 'vitest'

/**
 * The seam between G-SEO-01's warehouse row and G-SEO-03's analyses, asserted where both are importable.
 *
 * `packages/core` declares its own `SeoQueryRow` because it may not import `packages/db` — the dependency
 * runs the other way (ADR 0001). That leaves one thing unproved by either package's own tests: that a row
 * the warehouse writer and reader use is **actually** accepted by the analyses. Two shapes maintained in
 * two packages drift, and the drift is a type error in a third package that nobody has written yet — or
 * worse, a mapping layer somebody adds to bridge them, which is a second place for a field to be wrong.
 *
 * `packages/fixtures` may depend on both, which the brief names as the reason it exists. So the assertion
 * lives here: a `readonly GscDailyRow[]` is handed to all three analyses with no mapping and no cast, and
 * the day `GscDailyRow` renames `avgPositionCenti` or turns a count into a string, this file fails to
 * compile.
 *
 * Every value is test data. The property is `.invalid` (RFC 2606, and it can never resolve) and every
 * query carries a fixture marker, for the reason the brief's rule 15 gives about invented values: a
 * plausible Search Console row in a fixture is indistinguishable from a measurement.
 */

const SITE = 'sc-domain:gseo03-fixture.invalid'
const PAGE = 'https://gseo03-fixture.invalid'

/**
 * Warehouse rows exactly as `upsertGscDailyRows` takes them — every dimension present, including the three
 * the analyses do not read.
 *
 * One query on two pages at positions 8.00 and 8.50 (which is both a CTR band and a cannibalisation pair),
 * and the same page under two device classes, so the aggregation the analyses begin with has something to
 * sum. A third page fills the band out to three pairs, which is what gives the band a baseline at all.
 */
const WAREHOUSE_ROWS: readonly GscDailyRow[] = [
  {
    siteUrl: SITE,
    date: '2026-09-14',
    page: `${PAGE}/treatments/asian-normal-massage`,
    query: 'gseo03 fixture asian normal massage row',
    device: 'MOBILE',
    country: 'are',
    clicks: 0,
    impressions: 600,
    avgPositionCenti: 800,
  },
  {
    siteUrl: SITE,
    date: '2026-09-14',
    page: `${PAGE}/treatments/asian-normal-massage`,
    query: 'gseo03 fixture asian normal massage row',
    device: 'DESKTOP',
    country: 'are',
    clicks: 0,
    impressions: 400,
    avgPositionCenti: 800,
  },
  {
    siteUrl: SITE,
    date: '2026-09-14',
    page: `${PAGE}/pricing`,
    query: 'gseo03 fixture asian normal massage row',
    device: 'MOBILE',
    country: 'are',
    clicks: 50,
    impressions: 1000,
    avgPositionCenti: 850,
  },
  {
    siteUrl: SITE,
    date: '2026-09-14',
    page: `${PAGE}/treatments`,
    query: 'gseo03 fixture warehouse gap query',
    device: 'MOBILE',
    country: 'zzz',
    clicks: 50,
    impressions: 1000,
    avgPositionCenti: 880,
  },
]

describe('a warehouse row feeds the query-side analyses with no mapping layer', () => {
  it('is accepted by all three, and the dimension columns they ignore do not reach the findings', () => {
    // No cast and no `map`: this is the assignability assertion, and it is a compile-time one as much as a
    // runtime one.
    const rows: readonly SeoQueryRow[] = WAREHOUSE_ROWS

    const outliers = ctrOutliers(rows, {
      ...CTR_OUTLIER_POSITION_WINDOW,
      minImpressions: 300,
      minShortfallBp: 100,
      minPeerGroups: 2,
    })
    // Band 8 holds three pairs. The treatment page's two device rows sum to 1,000 impressions and zero
    // clicks; its peers are 100 clicks in 2,000 impressions, which is 500 bp, so the shortfall is 500.
    expect(outliers.map((finding) => [finding.page, finding.shortfallBp])).toEqual([
      [`${PAGE}/treatments/asian-normal-massage`, 500],
    ])
    // The two device rows were summed rather than counted twice, which is the whole reason the analyses
    // aggregate before they compare.
    expect(outliers[0]?.impressions).toBe(1000)

    // The same rows through the other two, so a shape that only one function tolerated would be visible.
    // The first query names the treatment route's own slug terms, so it has a dedicated page; the second
    // does not, so it is the one gap.
    const gaps = contentGaps(rows, ['/treatments/asian-normal-massage'], { minImpressions: 300 })
    expect(gaps.findings.map((finding) => finding.query)).toEqual([
      'gseo03 fixture warehouse gap query',
    ])

    const competing = cannibalisation(rows, { minImpressions: 300, maxPositionGapCenti: 300 })
    expect(competing.map((finding) => finding.pages.map((page) => page.page))).toEqual([
      [`${PAGE}/treatments/asian-normal-massage`, `${PAGE}/pricing`],
    ])

    // And nothing a finding carries is a dimension the analyses were not given: no date, device, country
    // or site. A finding that leaked one would be a finding whose grain is not the grain it claims.
    for (const finding of outliers) {
      expect(Object.keys(finding).sort()).toEqual([
        'avgPositionCenti',
        'clicks',
        'ctrBp',
        'impressions',
        'page',
        'peerCtrBp',
        'peerGroups',
        'positionBand',
        'query',
        'shortfallBp',
      ])
    }
  })
})
