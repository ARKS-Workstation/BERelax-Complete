import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  type ContentGap,
  compareContentGap,
  contentGaps,
  dedicatedRouteFor,
  queryTerms,
  routeSubjectTerms,
} from './content-gaps.ts'
import type { SeoQueryRow } from './query-rows.ts'

const SITE = 'https://gseo03-fixture.invalid'

const row = (query: string, impressions: number, over: Partial<SeoQueryRow> = {}): SeoQueryRow => ({
  page: `${SITE}/`,
  query,
  clicks: 0,
  impressions,
  avgPositionCenti: 1200,
  ...over,
})

describe('routeSubjectTerms', () => {
  it('is the last segment split on hyphens, so the locale prefix is irrelevant', () => {
    expect(routeSubjectTerms('/treatments/asian-normal-massage')).toEqual([
      'asian',
      'normal',
      'massage',
    ])
    expect(routeSubjectTerms('/ar/treatments/asian-normal-massage')).toEqual(
      routeSubjectTerms('/treatments/asian-normal-massage'),
    )
    expect(routeSubjectTerms('/pricing')).toEqual(['pricing'])
  })

  it('is empty for the homepage and for a pattern, so neither is dedicated to anything', () => {
    // The homepage's subject set must be empty or the subset test matches every query ever made, and "the
    // homepage ranks for it" is the symptom of a content gap rather than the refutation of one.
    expect(routeSubjectTerms('/')).toEqual([])
    expect(routeSubjectTerms('')).toEqual([])
    // A pattern is not a URL — the registry's own `fillParams` exists for this. Here it would otherwise
    // claim a dedicated page for the query "slug".
    expect(routeSubjectTerms('/treatments/[slug]')).toEqual([])
    expect(routeSubjectTerms('/blog/[...rest]')).toEqual([])
  })
})

describe('queryTerms', () => {
  it('splits on anything that is not a letter or a number, in any script', () => {
    expect(queryTerms('Best THAI massage, near me!')).toEqual([
      'best',
      'thai',
      'massage',
      'near',
      'me',
    ])
    // An ASCII-only character class would reduce this to nothing, and an empty term set matches every
    // route through the subset test — a silent false negative across half the site's traffic.
    expect(queryTerms('مساج آسيوي')).toEqual(['مساج', 'آسيوي'])
    expect(queryTerms('   ')).toEqual([])
  })
})

describe('dedicatedRouteFor', () => {
  const routes = ['/', '/treatments', '/treatments/[slug]', '/treatments/asian-normal-massage']

  it('matches when every term of the route slug appears in the query', () => {
    expect(dedicatedRouteFor('asian normal massage', routes)).toBe(
      '/treatments/asian-normal-massage',
    )
    // Extra query terms never break a match: that is the direction the rule runs in, and it is what makes
    // a locality, a qualifier or a fixture marker harmless.
    expect(dedicatedRouteFor('best asian normal massage near me', routes)).toBe(
      '/treatments/asian-normal-massage',
    )
  })

  it('does not match when a route slug term is missing from the query', () => {
    expect(dedicatedRouteFor('hot stone massage', routes)).toBe(null)
    // The reverse direction would have matched this: every query term appears in some slug, and the page
    // still does not exist.
    expect(dedicatedRouteFor('asian massage', routes)).toBe(null)
  })

  it('matches a single-term route by its own term', () => {
    expect(dedicatedRouteFor('treatments', routes)).toBe('/treatments')
  })

  it('expands a query term through the alias map, one hop and no further', () => {
    const aliases = { مساج: ['massage'], آسيوي: ['asian'], عادي: ['normal'] }
    expect(dedicatedRouteFor('مساج آسيوي عادي', routes)).toBe(null)
    expect(dedicatedRouteFor('مساج آسيوي عادي', routes, aliases)).toBe(
      '/treatments/asian-normal-massage',
    )
    // One hop: an alias of an alias is not reachable, so the map means what it says and two entries
    // naming each other cannot make the answer depend on iteration order.
    expect(dedicatedRouteFor('alpha', ['/beta'], { alpha: ['gamma'], gamma: ['beta'] })).toBe(null)
  })
})

describe('contentGaps', () => {
  it('reports a query with demand and no page, and counts what it considered', () => {
    const report = contentGaps(
      [row('gseo03 fixture hot stone massage', 600), row('gseo03 fixture quiet query', 10)],
      ['/treatments/asian-normal-massage'],
      { minImpressions: 300 },
    )
    expect(report.findings.map((finding) => finding.query)).toEqual([
      'gseo03 fixture hot stone massage',
    ])
    // The 10-impression query was never considered, which is a different statement from "was considered
    // and had a page".
    expect(report.queriesConsidered).toBe(1)
  })

  it('sums a query over every page it appeared on and names them best position first', () => {
    const report = contentGaps(
      [
        row('gseo03 fixture gap', 400, { page: `${SITE}/deep`, clicks: 1, avgPositionCenti: 1800 }),
        row('gseo03 fixture gap', 300, {
          page: `${SITE}/shallow`,
          clicks: 4,
          avgPositionCenti: 620,
        }),
      ],
      [],
      { minImpressions: 300 },
    )
    expect(report.findings[0]).toEqual({
      query: 'gseo03 fixture gap',
      clicks: 5,
      impressions: 700,
      // 5/700 = 71.43 bp.
      ctrBp: 71,
      bestPositionCenti: 620,
      rankingPages: [`${SITE}/shallow`, `${SITE}/deep`],
    })
  })

  it('orders the ranking pages of one query at the same position by their URL', () => {
    // The tie-break inside a finding, for the reason the ordering comment gives: two pages at one position
    // must not be listed in the order the rows arrived in, or the brief diffs without having changed.
    const rows = [
      row('gseo03 fixture gap', 300, { page: `${SITE}/z` }),
      row('gseo03 fixture gap', 300, { page: `${SITE}/a` }),
    ]
    const pages = contentGaps(rows, [], { minImpressions: 300 }).findings[0]?.rankingPages
    expect(pages).toEqual([`${SITE}/a`, `${SITE}/z`])
    expect(
      contentGaps([...rows].reverse(), [], { minImpressions: 300 }).findings[0]?.rankingPages,
    ).toEqual(pages)
  })

  it('is ordered by impressions and then clicks, whatever order the rows arrived in', () => {
    // The three queries are deliberately in the OPPOSITE alphabetical order to the declared one. Without
    // that, the aggregate this reads is already sorted by query, so dropping the comparator entirely would
    // leave this assertion passing — which is how an ordering test goes vacuous.
    const rows = [
      row('gseo03 fixture a', 400, { clicks: 1 }),
      row('gseo03 fixture c', 900),
      row('gseo03 fixture b', 400, { clicks: 9 }),
    ]
    const queries = contentGaps(rows, [], { minImpressions: 300 }).findings.map(
      (finding) => finding.query,
    )
    expect(queries).toEqual(['gseo03 fixture c', 'gseo03 fixture b', 'gseo03 fixture a'])
    expect(
      contentGaps([...rows].reverse(), [], { minImpressions: 300 }).findings.map(
        (finding) => finding.query,
      ),
    ).toEqual(queries)
  })

  it('refuses a fractional or negative impression floor', () => {
    for (const minImpressions of [1.5, -1]) {
      let thrown: unknown
      try {
        contentGaps([], [], { minImpressions })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(AppError)
      expect((thrown as AppError).details).toMatchObject({
        reason: 'seo_content_gap_config_invalid',
      })
    }
    expect(contentGaps([], [], { minImpressions: 0 }).findings).toEqual([])
  })
})

describe('compareContentGap', () => {
  it('ranks by impressions, then clicks, then the query', () => {
    const gap = (over: Partial<ContentGap>): ContentGap => ({
      query: 'q',
      clicks: 1,
      impressions: 100,
      ctrBp: 100,
      bestPositionCenti: 600,
      rankingPages: [],
      ...over,
    })
    expect(compareContentGap(gap({ impressions: 900 }), gap({}))).toBeLessThan(0)
    expect(compareContentGap(gap({ clicks: 9 }), gap({}))).toBeLessThan(0)
    expect(compareContentGap(gap({ query: 'a' }), gap({ query: 'b' }))).toBeLessThan(0)
    expect(compareContentGap(gap({}), gap({}))).toBe(0)
  })
})
