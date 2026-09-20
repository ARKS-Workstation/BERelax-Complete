import { describe, expect, it } from 'vitest'
import {
  ARABIC_TERM_ALIASES,
  CANNIBALISATION_CONFIG,
  CANNIBALISATION_ROWS,
  CONTENT_GAP_CONFIG,
  CONTENT_GAP_ROWS,
  ROUTE_FIXTURE,
  ROUTE_FIXTURE_WITHOUT_ASIAN_NORMAL,
  WAREHOUSE_ROWS,
  WORKED_EXAMPLE_CANDIDATE_COUNT,
  WORKED_EXAMPLE_CTR_CONFIG,
  WORKED_EXAMPLE_CTR_OUTLIERS,
  WORKED_EXAMPLE_ROWS,
} from './analyses.worked-examples.fixture.ts'
import { cannibalisation } from './cannibalisation.ts'
import { contentGaps } from './content-gaps.ts'
import { CTR_OUTLIER_POSITION_WINDOW, ctrOutlierCandidates, ctrOutliers } from './ctr-outliers.ts'
import type { SeoQueryRow } from './query-rows.ts'

/**
 * G-SEO-03's acceptance criteria, one describe block each.
 *
 * Every expectation here comes from `analyses.worked-examples.fixture.ts`, which a human computed with a
 * calculator before this file was run. That is the point of the split: an expectation recorded from a run
 * of the code asserts only that the code is itself, and it keeps passing after the arithmetic goes wrong.
 */

const SITE = 'https://gseo03-fixture.invalid'

describe('the worked example', () => {
  it('matches the hand-computed CTR outliers to the basis point', () => {
    expect(WORKED_EXAMPLE_ROWS).toHaveLength(20)
    expect(ctrOutliers(WORKED_EXAMPLE_ROWS, WORKED_EXAMPLE_CTR_CONFIG)).toEqual(
      WORKED_EXAMPLE_CTR_OUTLIERS,
    )
  })

  it('admitted sixteen of the twenty rows, so the four exclusions are the window and the floor', () => {
    expect(ctrOutlierCandidates(WORKED_EXAMPLE_ROWS, WORKED_EXAMPLE_CTR_CONFIG)).toHaveLength(
      WORKED_EXAMPLE_CANDIDATE_COUNT,
    )
  })

  /*
    The control that stops the assertion above passing vacuously.

    `toEqual` against a four-element array would also pass if the implementation happened to agree with a
    fixture that was wrong, so here the fixture is deliberately falsified one basis point at a time and the
    comparison must fail. One basis point is the smallest lie the format can tell, and it is exactly the
    size of the error a switch from half-up rounding to truncation would introduce.
  */
  it('fails against the same fixture with any single figure moved by one basis point', () => {
    const findings = ctrOutliers(WORKED_EXAMPLE_ROWS, WORKED_EXAMPLE_CTR_CONFIG)
    for (const [index, finding] of WORKED_EXAMPLE_CTR_OUTLIERS.entries()) {
      for (const field of ['ctrBp', 'peerCtrBp', 'shortfallBp'] as const) {
        const falsified = WORKED_EXAMPLE_CTR_OUTLIERS.map((expected, at) =>
          at === index ? { ...expected, [field]: finding[field] + 1 } : expected,
        )
        expect(findings).not.toEqual(falsified)
      }
    }
  })

  it('reports the two rounding cases the fixture exists to pin: 12.5 and 112.5 basis points', () => {
    const findings = ctrOutliers(WORKED_EXAMPLE_ROWS, WORKED_EXAMPLE_CTR_CONFIG)
    // 1 click in 800 impressions is exactly 12.5 bp, and 27 in 2,400 is exactly 112.5. Half-up rounding
    // makes them 13 and 113; truncation would make them 12 and 112 and move every rate in the weekly
    // report down by a basis point without failing anything else here.
    expect(findings.find((finding) => finding.query.endsWith('b12-d'))?.ctrBp).toBe(13)
    expect(findings.find((finding) => finding.query.endsWith('b19-a'))?.peerCtrBp).toBe(113)
  })

  it('leaves band 19 with one finding, which is the case an absolute threshold gets wrong', () => {
    const findings = ctrOutliers(WORKED_EXAMPLE_ROWS, WORKED_EXAMPLE_CTR_CONFIG)
    // Three of band 19's four pairs sit at 113 bp. Against an invented industry curve every one of them
    // is a catastrophe; against their own neighbours they are normal, and the one at zero is the finding.
    expect(findings.filter((finding) => finding.positionBand === 19)).toHaveLength(1)
  })
})

describe('the position window, at both edges', () => {
  /**
   * Three pairs for one query at the same position, so the band has a baseline and one pair is an outlier.
   *
   * The same shape at all four positions, which is what makes the four cases comparable: nothing changes
   * between them but the position, so a difference in the result can only be the window.
   */
  const rowsAt = (avgPositionCenti: number): readonly SeoQueryRow[] =>
    [
      { page: `${SITE}/edge/a`, clicks: 0, impressions: 1000 },
      { page: `${SITE}/edge/b`, clicks: 20, impressions: 1000 },
      { page: `${SITE}/edge/c`, clicks: 20, impressions: 1000 },
    ].map((pair) => ({ ...pair, query: 'gseo03 fixture edge query', avgPositionCenti }))

  it('admits position 5.00 and 20.00 and refuses 4.90 and 20.10', () => {
    // The specification's window (docs/03 §9), in the units 0042 stores: 500 and 2000, both inclusive.
    expect(CTR_OUTLIER_POSITION_WINDOW).toEqual({ minPositionCenti: 500, maxPositionCenti: 2000 })
    const config = { ...WORKED_EXAMPLE_CTR_CONFIG, ...CTR_OUTLIER_POSITION_WINDOW }

    // Inside, at each edge exactly: one finding, and its position is the edge.
    for (const edge of [500, 2000]) {
      const findings = ctrOutliers(rowsAt(edge), config)
      expect(findings).toHaveLength(1)
      expect(findings[0]?.avgPositionCenti).toBe(edge)
      expect(findings[0]?.shortfallBp).toBe(200)
    }

    // Outside, one centi-position beyond each edge: no finding, and nothing was even admitted — which is
    // the difference between "the window excluded it" and "it was admitted and failed something else".
    for (const beyond of [490, 2010]) {
      expect(ctrOutliers(rowsAt(beyond), config)).toHaveLength(0)
      expect(ctrOutlierCandidates(rowsAt(beyond), config)).toHaveLength(0)
    }
  })

  it('is inclusive because of the comparison and not because of the fixture', () => {
    // The control for the four cases above. If the window were exclusive at both ends, 501 and 1999 would
    // still produce findings and the test above would be the only thing that noticed — so assert the
    // inside of the window too, and that the edges behave identically to it.
    const config = { ...WORKED_EXAMPLE_CTR_CONFIG, ...CTR_OUTLIER_POSITION_WINDOW }
    expect(ctrOutliers(rowsAt(501), config)).toHaveLength(1)
    expect(ctrOutliers(rowsAt(1999), config)).toHaveLength(1)
  })
})

describe('cannibalisation', () => {
  it('reports two URLs for one query as one finding and one URL for two variants as none', () => {
    const findings = cannibalisation(CANNIBALISATION_ROWS, CANNIBALISATION_CONFIG)

    // Two distinct URLs inside the position gap: ONE finding for the query, naming both pages — never one
    // finding per pair, because three competing pages are one consolidation decision.
    const competing = findings.filter((finding) => finding.query === 'gseo03 fixture compete')
    expect(competing).toHaveLength(1)
    expect(competing[0]?.pages.map((page) => page.page)).toEqual([
      `${SITE}/treatments/asian-normal-massage`,
      `${SITE}/pricing`,
    ])
    expect(competing[0]?.positionGapCenti).toBe(95)

    // One URL ranking for two query variants: zero. That is a page working, not a defect.
    expect(
      findings.filter((finding) => finding.query.startsWith('gseo03 fixture variant')),
    ).toEqual([])

    // And two URLs too far apart to be competing: the hub-and-spoke shape, also zero.
    expect(findings.filter((finding) => finding.query === 'gseo03 fixture far-apart')).toEqual([])

    // The whole fixture therefore yields exactly the one finding, which is what stops the two assertions
    // above passing because the analysis returned nothing at all.
    expect(findings).toHaveLength(1)
  })

  it('finds the far-apart pair the moment the configured gap is widened past it', () => {
    // The control for "far apart produces zero": the pages ARE two distinct URLs for one query, so the
    // reason for the zero must be the gap and nothing else. 6.10 to 18.00 is 1,190 centi-positions.
    const findings = cannibalisation(CANNIBALISATION_ROWS, {
      ...CANNIBALISATION_CONFIG,
      maxPositionGapCenti: 1190,
    })
    expect(findings.map((finding) => finding.query)).toContain('gseo03 fixture far-apart')
  })
})

describe('content gaps', () => {
  it('reports no gap for a query with a dedicated treatment route and one when it is withdrawn', () => {
    const query = 'gseo03 fixture asian normal massage near me'

    const withRoute = contentGaps(CONTENT_GAP_ROWS, ROUTE_FIXTURE, CONTENT_GAP_CONFIG)
    expect(withRoute.findings.map((finding) => finding.query)).not.toContain(query)

    const withoutRoute = contentGaps(
      CONTENT_GAP_ROWS,
      ROUTE_FIXTURE_WITHOUT_ASIAN_NORMAL,
      CONTENT_GAP_CONFIG,
    )
    expect(withoutRoute.findings.filter((finding) => finding.query === query)).toHaveLength(1)

    // Exactly one query moved. Without this the toggle would also pass if withdrawing a route emptied or
    // flooded the analysis, and the criterion is that the route set decides one query's answer.
    expect(withoutRoute.findings).toHaveLength(withRoute.findings.length + 1)
  })

  it('carries the evidence a brief needs: the pages absorbing the query today', () => {
    const findings = contentGaps(
      CONTENT_GAP_ROWS,
      ROUTE_FIXTURE_WITHOUT_ASIAN_NORMAL,
      CONTENT_GAP_CONFIG,
    ).findings
    const gap = findings.find((finding) => finding.query.includes('asian normal massage'))
    expect(gap?.rankingPages).toEqual([`${SITE}/`])
    expect(gap?.impressions).toBe(900)
    expect(gap?.clicks).toBe(4)
    // 4 clicks in 900 impressions is 44.44 bp, which rounds to 44.
    expect(gap?.ctrBp).toBe(44)
  })

  it('keeps reporting the query no route covers, in both route fixtures', () => {
    // The control for the toggle: a query that is a gap whichever fixture is used proves the toggle moved
    // one answer rather than switching the analysis on and off.
    for (const routes of [ROUTE_FIXTURE, ROUTE_FIXTURE_WITHOUT_ASIAN_NORMAL]) {
      const findings = contentGaps(CONTENT_GAP_ROWS, routes, CONTENT_GAP_CONFIG).findings
      expect(findings.map((finding) => finding.query)).toContain('gseo03 fixture hot stone massage')
    }
  })

  it('says how much of the query report Search Console withheld, and never scales it away', () => {
    // The rare-query gap, and why it belongs in this report. A withheld query is absent from these rows
    // entirely — Google removes it, it does not shrink it — so it cannot produce a finding, and a finding
    // list presented as complete would be a stronger claim than the data supports.
    const report = contentGaps(CONTENT_GAP_ROWS, ROUTE_FIXTURE, {
      ...CONTENT_GAP_CONFIG,
      withheld: {
        queryClicks: 7,
        pageClicks: 29,
        queryImpressions: 2330,
        pageImpressions: 3100,
      },
    })
    expect(report.withheld?.withheldClicks).toBe(22)
    expect(report.withheld?.withheldImpressions).toBe(770)
    expect(report.queriesAreComplete).toBe(false)

    // Nothing withheld is a real state and says so; no snapshot at all is a third answer, because "we know
    // nothing is missing" and "we do not know" must not collapse into the same boolean.
    const complete = contentGaps(CONTENT_GAP_ROWS, ROUTE_FIXTURE, {
      ...CONTENT_GAP_CONFIG,
      withheld: {
        queryClicks: 29,
        pageClicks: 29,
        queryImpressions: 3100,
        pageImpressions: 3100,
      },
    })
    expect(complete.queriesAreComplete).toBe(true)
    expect(
      contentGaps(CONTENT_GAP_ROWS, ROUTE_FIXTURE, CONTENT_GAP_CONFIG).queriesAreComplete,
    ).toBe(null)

    // The findings themselves are identical whatever the withheld figures say, which is the honest half:
    // the gap is reported beside the list and never used to adjust it.
    expect(report.findings).toEqual(
      contentGaps(CONTENT_GAP_ROWS, ROUTE_FIXTURE, CONTENT_GAP_CONFIG).findings,
    )
  })

  it('treats a bilingual query as a gap until the alias map says it is the same intent', () => {
    const arabic = 'gseo03 fixture مساج آسيوي عادي'
    const withoutAliases = contentGaps(CONTENT_GAP_ROWS, ROUTE_FIXTURE, CONTENT_GAP_CONFIG)
    expect(withoutAliases.findings.map((finding) => finding.query)).toContain(arabic)

    const withAliases = contentGaps(CONTENT_GAP_ROWS, ROUTE_FIXTURE, {
      ...CONTENT_GAP_CONFIG,
      queryTermAliases: ARABIC_TERM_ALIASES,
    })
    expect(withAliases.findings.map((finding) => finding.query)).not.toContain(arabic)
  })
})

describe('determinism', () => {
  /** Every analysis, over one warehouse, as the weekly report would run them. */
  const analyse = (rows: readonly SeoQueryRow[]) => ({
    ctrOutliers: ctrOutliers(rows, WORKED_EXAMPLE_CTR_CONFIG),
    contentGaps: contentGaps(rows, ROUTE_FIXTURE, CONTENT_GAP_CONFIG),
    cannibalisation: cannibalisation(rows, CANNIBALISATION_CONFIG),
  })

  it('produces byte-identical findings across three runs, including their order', () => {
    const runs = [1, 2, 3].map(() => JSON.stringify(analyse(WAREHOUSE_ROWS)))
    expect(runs[1]).toBe(runs[0])
    expect(runs[2]).toBe(runs[0])
    // And the run is not vacuously identical because it found nothing: the weekly report has something in
    // it, or "byte-identical" would be a property of the empty string.
    const found = analyse(WAREHOUSE_ROWS)
    expect(found.ctrOutliers.length).toBeGreaterThan(0)
    expect(found.contentGaps.findings.length).toBeGreaterThan(0)
    expect(found.cannibalisation.length).toBeGreaterThan(0)
  })

  it('does not depend on the order the rows arrived in', () => {
    // THE defect this criterion exists for. Rows arrive from SQL, and a `select` with no `order by`
    // promises nothing — so an analysis that iterated a Map in insertion order would produce a different
    // ordering every time the planner changed its mind, and the weekly report would diff with no row
    // having changed. Two fixed permutations rather than a shuffle, because `Math.random` is forbidden in
    // packages/core and a seeded generator here would only be testing the generator.
    const reversed = [...WAREHOUSE_ROWS].reverse()
    const rotated = [...WAREHOUSE_ROWS.slice(7), ...WAREHOUSE_ROWS.slice(0, 7)]
    const baseline = JSON.stringify(analyse(WAREHOUSE_ROWS))
    expect(JSON.stringify(analyse(reversed))).toBe(baseline)
    expect(JSON.stringify(analyse(rotated))).toBe(baseline)
  })

  it('orders two findings that tie on every ranked figure by query and page', () => {
    // The tie-break, which is what makes the declared order TOTAL. Without it two findings with the same
    // shortfall and the same impressions would be left in the order they were built in, and that order is
    // the order the rows arrived in.
    const tied: readonly SeoQueryRow[] = [
      {
        page: `${SITE}/tie/b`,
        query: 'gseo03 fixture tie beta',
        clicks: 0,
        impressions: 1000,
        avgPositionCenti: 900,
      },
      {
        page: `${SITE}/tie/a`,
        query: 'gseo03 fixture tie alpha',
        clicks: 0,
        impressions: 1000,
        avgPositionCenti: 900,
      },
      {
        page: `${SITE}/tie/c`,
        query: 'gseo03 fixture tie gamma',
        clicks: 30,
        impressions: 1000,
        avgPositionCenti: 900,
      },
      {
        page: `${SITE}/tie/d`,
        query: 'gseo03 fixture tie delta',
        clicks: 30,
        impressions: 1000,
        avgPositionCenti: 900,
      },
    ]
    const queries = ctrOutliers(tied, WORKED_EXAMPLE_CTR_CONFIG).map((finding) => finding.query)
    expect(queries).toEqual(['gseo03 fixture tie alpha', 'gseo03 fixture tie beta'])
    expect(
      ctrOutliers([...tied].reverse(), WORKED_EXAMPLE_CTR_CONFIG).map((finding) => finding.query),
    ).toEqual(queries)
  })
})
