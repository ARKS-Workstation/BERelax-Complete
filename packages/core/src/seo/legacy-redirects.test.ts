import { describe, expect, it } from 'vitest'
import {
  AREA_PAGE_SIMILARITY_CEILING,
  baselinePaths,
  formatRedirectMapFindings,
  LEGACY_BASELINE,
  type LegacyRedirect,
  normaliseLegacyPath,
  pairwiseSimilarity,
  RANKING_PATHS,
  RETAINED_AREA_PAGES,
  redirectMapFindings,
  resolveLegacyRedirect,
  tooSimilarPairs,
} from './legacy-redirects.ts'

/** Every path the committed baseline targets, plus the registry routes it needs. */
const SERVED = new Set([
  '/treatments',
  ...LEGACY_BASELINE.map((row) => row.target).filter((target) => target.startsWith('/treatments/')),
])
const isServedPage = (path: string): boolean => SERVED.has(path)

const judge = (
  rows: readonly LegacyRedirect[],
  baseline: readonly string[] = rows.map((row) => row.source),
) => redirectMapFindings({ rows, baseline, isServedPage })

describe('the committed baseline is a function with no gaps and no loops', () => {
  it('has no findings at all', () => {
    const findings = judge(LEGACY_BASELINE, baselinePaths())
    expect(formatRedirectMapFindings(findings)).toBe('')
  })

  it('declares the ranking paths SEPARATELY from the rows, or totality is vacuous', () => {
    /*
      The two lists are different facts — "these URLs have traffic" and "this URL goes there" — and the
      coverage check is the relation between them. Derived from each other, removing a row would remove it
      from both sides and the check would hold over a map that had just lost a page. That is not
      hypothetical: it is how this module was first written, and gate case 191g found it.
    */
    expect([...RANKING_PATHS].sort()).toEqual([...LEGACY_BASELINE.map((row) => row.source)].sort())
    // And the control for the separation: dropping a ROW is a finding, where dropping it from both would
    // not be.
    const short = LEGACY_BASELINE.filter((row) => row.source !== RANKING_PATHS[0])
    expect(judge(short, RANKING_PATHS).map((finding) => finding.rule)).toEqual([
      'baseline_path_without_a_row',
    ])
  })

  it('covers the four patterns docs/13 §6 names', () => {
    const sources = [...baselinePaths()]
    expect(sources).toContain('/product-category/arabic-massage-abu-dhabi')
    expect(sources).toContain('/product-category/thai-massage-abu-dhabi')
    expect(sources.some((path) => path.startsWith('/product-tag/'))).toBe(true)
    expect(sources.filter((path) => path.startsWith('/product/'))).toHaveLength(8)
  })

  it('resolves a path in one hop, and resolves nothing else', () => {
    expect(resolveLegacyRedirect('/product/asian-normal-massage')?.target).toBe(
      '/treatments/asian-normal-massage',
    )
    // Trailing slash and case are normalised, because that is the spelling the live WordPress site
    // serves — `/product-category/arabic-massage-abu-dhabi/` — and proxy.ts canonicalises before asking.
    expect(resolveLegacyRedirect('/product-category/Arabic-Massage-Abu-Dhabi/')?.target).toBe(
      '/treatments',
    )
    expect(resolveLegacyRedirect('/treatments')).toBeNull()
    expect(resolveLegacyRedirect('/product/something-nobody-sold')).toBeNull()
  })

  it('normalises a path the way the table stores one', () => {
    expect(normaliseLegacyPath('/Product-Tag/X/')).toBe('/product-tag/x')
    expect(normaliseLegacyPath('/product/x?utm_source=a#b')).toBe('/product/x')
    expect(normaliseLegacyPath('/')).toBe('/')
  })
})

describe('each of the four properties can be broken, and each is named', () => {
  it('reports a baseline path with no row', () => {
    const findings = judge(LEGACY_BASELINE, [...baselinePaths(), '/product/ninth-product'])
    expect(findings.map((finding) => finding.rule)).toEqual(['baseline_path_without_a_row'])
    expect(formatRedirectMapFindings(findings)).toContain('/product/ninth-product')
  })

  it('reports a source mapped twice', () => {
    const rows: LegacyRedirect[] = [
      { source: '/product/a', target: '/treatments', reason: 'r' },
      { source: '/product/a', target: '/treatments/asian-normal-massage', reason: 'r' },
    ]
    expect(judge(rows).map((finding) => finding.rule)).toContain('source_mapped_twice')
  })

  it('reports a chain, and does not also report its target as a dead page', () => {
    // A chain's target is a path this site does not serve BY DESIGN — it redirects — so reporting both
    // would name one row twice with two different fixes.
    const rows: LegacyRedirect[] = [
      { source: '/product/a', target: '/product/b', reason: 'r' },
      { source: '/product/b', target: '/treatments', reason: 'r' },
    ]
    const rules = judge(rows).map((finding) => finding.rule)
    expect(rules).toContain('redirect_is_a_chain')
    expect(rules).not.toContain('target_is_not_a_page')
  })

  it('reports a loop as well as the chain that makes it', () => {
    const rows: LegacyRedirect[] = [
      { source: '/product/a', target: '/product/b', reason: 'r' },
      { source: '/product/b', target: '/product/a', reason: 'r' },
    ]
    const rules = judge(rows).map((finding) => finding.rule)
    expect(rules).toContain('redirect_is_a_loop')
    expect(rules).toContain('redirect_is_a_chain')
  })

  it('reports a row pointing at itself separately, because the fix differs', () => {
    const rows: LegacyRedirect[] = [{ source: '/product/a', target: '/product/a', reason: 'r' }]
    expect(judge(rows).map((finding) => finding.rule)).toContain('redirect_to_itself')
  })

  it('reports a target no route serves', () => {
    const rows: LegacyRedirect[] = [
      { source: '/product/a', target: '/treatments/retired', reason: 'r' },
    ]
    expect(judge(rows).map((finding) => finding.rule)).toContain('target_is_not_a_page')
  })

  it('reports a path that is not normalised', () => {
    const rows: LegacyRedirect[] = [{ source: '/Product/A/', target: '/treatments', reason: 'r' }]
    expect(judge(rows).map((finding) => finding.rule)).toContain('path_is_not_normalised')
  })
})

describe('the similarity rule the retained area pages will be held to', () => {
  const TEMPLATE_FILL_A =
    'Looking for a relaxing massage in Khalidiya? Our therapists in Khalidiya offer hot oil and balm ' +
    'treatments every day. Book a massage in Khalidiya today and arrive at a quiet room on the first ' +
    'floor. Our Khalidiya customers rate us highly for a calm welcome.'
  const TEMPLATE_FILL_B = TEMPLATE_FILL_A.replace(/Khalidiya/g, 'Al Bateen')
  const DIFFERENTIATED =
    'Morocco bath is a steam and black-soap scrub finished with a rinse, and it needs the wet room ' +
    'rather than an ordinary treatment room. Allow two hours including the jacuzzi. Bring nothing; ' +
    'towels, slippers and a locker are provided at reception.'

  it('scores a place-name swap as nearly identical', () => {
    // What template fill actually looks like: the same sentences with the place name changed. The word
    // SET is almost unchanged, which is why a cheap set measure catches it.
    expect(pairwiseSimilarity(TEMPLATE_FILL_A, TEMPLATE_FILL_B)).toBeGreaterThan(
      AREA_PAGE_SIMILARITY_CEILING,
    )
  })

  it('scores two genuinely different pages well below the ceiling', () => {
    expect(pairwiseSimilarity(TEMPLATE_FILL_A, DIFFERENTIATED)).toBeLessThan(0.3)
  })

  it('is 1 for identical text and symmetric', () => {
    expect(pairwiseSimilarity(DIFFERENTIATED, DIFFERENTIATED)).toBe(1)
    expect(pairwiseSimilarity(TEMPLATE_FILL_A, DIFFERENTIATED)).toBe(
      pairwiseSimilarity(DIFFERENTIATED, TEMPLATE_FILL_A),
    )
  })

  it('refuses an empty body rather than answering 0', () => {
    // The one input where a set measure lies: two empty pages are identical and would score as maximally
    // different.
    expect(() => pairwiseSimilarity('', DIFFERENTIATED)).toThrow(/similarity over an empty body/)
  })

  it('finds the one template-filled pair inside a set that is otherwise fine', () => {
    const pairs = tooSimilarPairs([
      { path: '/a', body: TEMPLATE_FILL_A },
      { path: '/b', body: DIFFERENTIATED },
      { path: '/c', body: TEMPLATE_FILL_B },
    ])
    expect(pairs.map((pair) => [pair.left, pair.right])).toEqual([['/a', '/c']])
  })

  it('has nothing to judge today, and says so rather than passing silently', () => {
    /*
      `RETAINED_AREA_PAGES` is empty because `Y1-woo-baseline` is open: which legacy URLs have genuine
      demand is what the crawl and rank export would say, and writing area pages before it would be
      writing the template fill docs/09's own sentence forbids. The emptiness is asserted HERE, beside the
      rule that will judge them, so this test fails the day a page is added without one — rather than
      passing over an empty list for ever.
    */
    expect(RETAINED_AREA_PAGES).toEqual([])
    expect(tooSimilarPairs(RETAINED_AREA_PAGES)).toEqual([])
  })
})
