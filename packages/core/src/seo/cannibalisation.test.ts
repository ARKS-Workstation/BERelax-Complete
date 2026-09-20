import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  type Cannibalisation,
  type CannibalisationConfig,
  cannibalisation,
  compareCannibalisation,
} from './cannibalisation.ts'
import type { SeoQueryRow } from './query-rows.ts'

const SITE = 'https://gseo03-fixture.invalid'

const CONFIG: CannibalisationConfig = { minImpressions: 300, maxPositionGapCenti: 300 }

const row = (
  page: string,
  query: string,
  avgPositionCenti: number,
  over: Partial<SeoQueryRow> = {},
): SeoQueryRow => ({
  page: `${SITE}/${page}`,
  query,
  clicks: 2,
  impressions: 500,
  avgPositionCenti,
  ...over,
})

describe('cannibalisation', () => {
  it('is one finding per query however many pages are competing', () => {
    // Three pages inside the gap are one consolidation decision. Three findings would be that decision
    // three times in a report of five prioritised actions.
    const findings = cannibalisation(
      [
        row('a', 'gseo03 fixture q', 800),
        row('b', 'gseo03 fixture q', 850),
        row('c', 'gseo03 fixture q', 1000),
      ],
      CONFIG,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.pages.map((page) => page.page)).toEqual([
      `${SITE}/a`,
      `${SITE}/b`,
      `${SITE}/c`,
    ])
    expect(findings[0]?.positionGapCenti).toBe(200)
    expect(findings[0]?.bestPositionCenti).toBe(800)
    expect(findings[0]?.worstPositionCenti).toBe(1000)
    expect(findings[0]?.impressions).toBe(1500)
    expect(findings[0]?.clicks).toBe(6)
  })

  it('measures the gap from the best position, so a third page beyond it is left out', () => {
    const findings = cannibalisation(
      [
        row('a', 'gseo03 fixture q', 800),
        row('b', 'gseo03 fixture q', 900),
        row('far', 'gseo03 fixture q', 1600),
      ],
      CONFIG,
    )
    expect(findings[0]?.pages.map((page) => page.page)).toEqual([`${SITE}/a`, `${SITE}/b`])
    // The deepest position reported is the competing set's, not the query's — `far` is a hub or a spoke
    // and reporting it as part of the split would name a page nobody should consolidate.
    expect(findings[0]?.worstPositionCenti).toBe(900)
  })

  it('reports nothing for one page ranking for many query variants', () => {
    // A page working, and docs/09 §1 records the decision that made it so: the 32 priced durations are
    // rows on eight pages precisely so they do not compete for one query.
    expect(
      cannibalisation(
        [
          row('a', 'gseo03 fixture variant one', 800),
          row('a', 'gseo03 fixture variant two', 810),
          row('a', 'gseo03 fixture variant three', 820),
        ],
        CONFIG,
      ),
    ).toEqual([])
  })

  it('reports nothing when the second page is outside the gap', () => {
    const rows = [row('a', 'gseo03 fixture q', 610), row('b', 'gseo03 fixture q', 1800)]
    expect(cannibalisation(rows, CONFIG)).toEqual([])
    // The control: the pages ARE two distinct URLs for one query, so the reason must be the gap. 6.10 to
    // 18.00 is 1,190 centi-positions.
    expect(cannibalisation(rows, { ...CONFIG, maxPositionGapCenti: 1190 })).toHaveLength(1)
    expect(cannibalisation(rows, { ...CONFIG, maxPositionGapCenti: 1189 })).toEqual([])
  })

  it('reports nothing when only one page clears the impression floor', () => {
    const rows = [
      row('a', 'gseo03 fixture q', 800),
      row('thin', 'gseo03 fixture q', 810, { impressions: 20, clicks: 0 }),
    ]
    expect(cannibalisation(rows, CONFIG)).toEqual([])
    // The control: with the floor lowered, the same two rows are a finding.
    expect(cannibalisation(rows, { ...CONFIG, minImpressions: 20 })).toHaveLength(1)
  })

  it('sums a page over the window before comparing it, so devices are not two pages', () => {
    // The warehouse's grain is (date, page, query, device, country), so one page over one week is many
    // rows. Two of them are not two competing URLs.
    const rows = [
      row('a', 'gseo03 fixture q', 800, { impressions: 200, clicks: 1 }),
      row('a', 'gseo03 fixture q', 820, { impressions: 200, clicks: 3 }),
    ]
    expect(cannibalisation(rows, { ...CONFIG, minImpressions: 300 })).toEqual([])
  })

  it('orders two pages sitting at the same position by their URL', () => {
    // The tie-break inside a finding. Two pages at the same average position is the ordinary shape of
    // cannibalisation rather than an edge case, and without the tie-break the pair would be listed in the
    // order the rows arrived in — so the weekly report would diff on the same two pages.
    const rows = [row('z', 'gseo03 fixture q', 800), row('a', 'gseo03 fixture q', 800)]
    const pages = cannibalisation(rows, CONFIG)[0]?.pages.map((page) => page.page)
    expect(pages).toEqual([`${SITE}/a`, `${SITE}/z`])
    expect(cannibalisation([...rows].reverse(), CONFIG)[0]?.pages.map((page) => page.page)).toEqual(
      pages,
    )
  })

  it('is ordered by impressions and then by how many pages are competing', () => {
    // `zebra` carries more impressions than `ant`, so the declared order is the opposite of the
    // alphabetical one. The aggregate this reads is already sorted by query, so without that the
    // comparator could be dropped entirely and this assertion would still pass.
    const rows = [
      row('a', 'gseo03 fixture ant', 800, { impressions: 400 }),
      row('b', 'gseo03 fixture ant', 810, { impressions: 400 }),
      row('a', 'gseo03 fixture zebra', 800, { impressions: 900 }),
      row('b', 'gseo03 fixture zebra', 810, { impressions: 900 }),
    ]
    const queries = cannibalisation(rows, CONFIG).map((finding) => finding.query)
    expect(queries).toEqual(['gseo03 fixture zebra', 'gseo03 fixture ant'])
    expect(cannibalisation([...rows].reverse(), CONFIG).map((finding) => finding.query)).toEqual(
      queries,
    )
  })

  it('refuses a configuration that is not whole and non-negative', () => {
    for (const over of [{ minImpressions: -1 }, { maxPositionGapCenti: 1.5 }]) {
      let thrown: unknown
      try {
        cannibalisation([], { ...CONFIG, ...over })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(AppError)
      expect((thrown as AppError).details).toMatchObject({
        reason: 'seo_cannibalisation_config_invalid',
      })
    }
    // A zero gap is legal and means "the same position exactly", which is the strictest reading of
    // competing rather than an unusable one.
    expect(cannibalisation([], { minImpressions: 0, maxPositionGapCenti: 0 })).toEqual([])
  })
})

describe('compareCannibalisation', () => {
  it('ranks by impressions, then by the number of competing pages, then the query', () => {
    const finding = (over: Partial<Cannibalisation>): Cannibalisation => ({
      query: 'q',
      pages: [],
      bestPositionCenti: 800,
      worstPositionCenti: 900,
      positionGapCenti: 100,
      clicks: 1,
      impressions: 100,
      ...over,
    })
    expect(compareCannibalisation(finding({ impressions: 900 }), finding({}))).toBeLessThan(0)
    expect(
      compareCannibalisation(
        finding({
          pages: [{ page: 'p', clicks: 0, impressions: 0, avgPositionCenti: 800, ctrBp: 0 }],
        }),
        finding({}),
      ),
    ).toBeLessThan(0)
    expect(compareCannibalisation(finding({ query: 'a' }), finding({ query: 'b' }))).toBeLessThan(0)
    expect(compareCannibalisation(finding({}), finding({}))).toBe(0)
  })
})
