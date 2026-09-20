import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  aggregateQueryPages,
  BASIS_POINTS,
  compareQuery,
  compareQueryPage,
  ctrBasisPoints,
  type SeoQueryRow,
} from './query-rows.ts'

const SITE = 'https://gseo03-fixture.invalid'

const row = (over: Partial<SeoQueryRow> = {}): SeoQueryRow => ({
  page: `${SITE}/page`,
  query: 'gseo03 fixture query',
  clicks: 4,
  impressions: 100,
  avgPositionCenti: 640,
  ...over,
})

describe('ctrBasisPoints', () => {
  it('is the rate in whole basis points, rounded half-up', () => {
    expect(BASIS_POINTS).toBe(10_000)
    expect(ctrBasisPoints(4, 100)).toBe(400)
    // 40/700 is 5.714285…%, which is 571.43 bp.
    expect(ctrBasisPoints(40, 700)).toBe(571)
    // Exactly 12.5 bp. Half-up, so 13 — the case the worked example pins, because truncation here moves
    // every rate in the weekly report down by a basis point without failing anything else.
    expect(ctrBasisPoints(1, 800)).toBe(13)
    expect(ctrBasisPoints(1000, 1000)).toBe(BASIS_POINTS)
  })

  it('answers zero for an impressionless row rather than NaN', () => {
    // 0042 constrains the counts to be non-negative, not positive, so the row is legal — and a division
    // here would put `NaN` into a rendered report.
    expect(ctrBasisPoints(0, 0)).toBe(0)
  })
})

describe('the comparators', () => {
  it('order by codepoint and are total over (query, page)', () => {
    expect(compareQuery('a', 'b')).toBeLessThan(0)
    expect(compareQuery('b', 'a')).toBeGreaterThan(0)
    expect(compareQuery('a', 'a')).toBe(0)
    expect(compareQueryPage({ query: 'a', page: 'z' }, { query: 'b', page: 'a' })).toBeLessThan(0)
    expect(compareQueryPage({ query: 'a', page: 'z' }, { query: 'a', page: 'a' })).toBeGreaterThan(
      0,
    )
    expect(compareQueryPage({ query: 'a', page: 'a' }, { query: 'a', page: 'a' })).toBe(0)
  })
})

describe('aggregateQueryPages', () => {
  it('sums the rows of a window per (query, page) and weights the position by impressions', () => {
    const totals = aggregateQueryPages([
      row({ clicks: 10, impressions: 1000, avgPositionCenti: 600 }),
      row({ clicks: 2, impressions: 100, avgPositionCenti: 1600 }),
    ])
    expect(totals).toHaveLength(1)
    // (600 x 1000 + 1600 x 100) / 1100 = 760000/1100 = 690.909… -> 691. The unweighted mean would be
    // 1,100 — position 11 for a pair that spent 1,000 of its 1,100 impressions at position 6.
    expect(totals[0]).toEqual({
      query: 'gseo03 fixture query',
      page: `${SITE}/page`,
      clicks: 12,
      impressions: 1100,
      avgPositionCenti: 691,
      ctrBp: 109,
      rows: 2,
    })
  })

  it('keeps two pages for one query apart, and two queries for one page', () => {
    const totals = aggregateQueryPages([
      row({ page: `${SITE}/b` }),
      row({ page: `${SITE}/a` }),
      row({ query: 'gseo03 fixture other' }),
    ])
    expect(totals.map((pair) => [pair.query, pair.page])).toEqual([
      ['gseo03 fixture other', `${SITE}/page`],
      ['gseo03 fixture query', `${SITE}/a`],
      ['gseo03 fixture query', `${SITE}/b`],
    ])
  })

  it('falls back to the unweighted mean when every row is impressionless', () => {
    const totals = aggregateQueryPages([
      row({ clicks: 0, impressions: 0, avgPositionCenti: 500 }),
      row({ clicks: 0, impressions: 0, avgPositionCenti: 701 }),
    ])
    // (500 + 701) / 2 = 600.5 -> 601. There is no weight to apply, and the alternative is dividing by
    // zero and reporting NaN.
    expect(totals[0]?.avgPositionCenti).toBe(601)
    expect(totals[0]?.ctrBp).toBe(0)
  })

  it('is sorted by (query, page) whatever order the rows arrived in', () => {
    const rows = [
      row({ page: `${SITE}/c` }),
      row({ page: `${SITE}/a` }),
      row({ page: `${SITE}/b` }),
    ]
    const forwards = aggregateQueryPages(rows).map((pair) => pair.page)
    expect(forwards).toEqual([`${SITE}/a`, `${SITE}/b`, `${SITE}/c`])
    expect(aggregateQueryPages([...rows].reverse()).map((pair) => pair.page)).toEqual(forwards)
  })

  it('returns nothing for no rows', () => {
    expect(aggregateQueryPages([])).toEqual([])
  })

  /*
    The four shapes `seo_gsc_daily` refuses, refused again here — because these functions are also called
    over rows a fixture built rather than over rows the database returned, and each one corrupts a
    different output silently rather than raising anything.
  */
  const refused: readonly [string, Partial<SeoQueryRow>, string][] = [
    [
      'clicks above impressions, which Google never reports',
      { clicks: 50, impressions: 40 },
      'clicks_exceed_impressions',
    ],
    [
      'a fractional click, which would make every figure downstream a float',
      { clicks: 1.5 },
      'clicks',
    ],
    ['a negative impression count', { impressions: -1 }, 'impressions'],
    [
      'position zero, which would read as ranking above the first result',
      { avgPositionCenti: 0 },
      'avgPositionCenti',
    ],
  ]
  for (const [name, over, problem] of refused) {
    it(`refuses ${name}`, () => {
      let thrown: unknown
      try {
        aggregateQueryPages([row(over)])
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(AppError)
      expect((thrown as AppError).details).toMatchObject({
        reason: 'seo_query_row_invalid',
        problems: [problem],
        index: 0,
      })
    })
  }

  it('names the row that is wrong by its index', () => {
    // The index matters more than it looks: a nightly window is tens of thousands of rows, and "one of
    // them has clicks above impressions" is not a debuggable message.
    let thrown: unknown
    try {
      aggregateQueryPages([row(), row(), row({ clicks: 9, impressions: 2 })])
    } catch (error) {
      thrown = error
    }
    expect((thrown as AppError).details).toMatchObject({ index: 2 })
  })
})
