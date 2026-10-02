import { describe, expect, it } from 'vitest'
import { CLEAN_PAGE, KNOWN_BAD_PAGES, pageServing } from './structured-data.fixtures/index.ts'
import {
  formatStructuredDataFindings,
  jsonLdBlocks,
  validatePageStructuredData,
} from './structured-data-validate.ts'
import { encloseUntrustedSeoData } from './untrusted-envelope.ts'

/**
 * The site-side structured-data validator: the three known-bad pages, by rule name, and the control.
 *
 * *"Structured-data validation rejects three known-bad fixtures by rule name: a DaySpa block missing
 * OpeningHoursSpecification, a MedicalClinic type the regulatory profile does not permit, and an
 * AggregateRating built from the site's own testimonials."*
 *
 * By rule NAME and not by a non-empty finding list. ADR 0003's argument, and it bites here specifically:
 * every one of these three pages is a mutation of the specimen graph, so a mutation that broke something
 * else as well would produce findings and the case would pass having proved nothing about the rule it
 * names.
 */

const enclose = (html: string) => encloseUntrustedSeoData({ source: 'fetched_html', text: html })

describe('jsonLdBlocks', () => {
  it('reads an ld+json block and ignores a script that is not one', () => {
    expect(
      jsonLdBlocks('<script type="application/json">{"a":1}</script><script>var x = 1</script>'),
    ).toEqual([])
    expect(jsonLdBlocks('<script type="application/ld+json">{"a":1}</script>')).toEqual(['{"a":1}'])
    // Attribute order and spelling as a real document writes them.
    expect(jsonLdBlocks("<script id='x' TYPE='application/ld+json' >{\"a\":2}</script >")).toEqual([
      '{"a":2}',
    ])
  })
})

describe('validatePageStructuredData: the control', () => {
  it('finds nothing on the unmutated specimen page', () => {
    const report = validatePageStructuredData({
      html: enclose(CLEAN_PAGE.html),
      pagePath: '/',
      licence: CLEAN_PAGE.licence,
      evidencedReviewCount: CLEAN_PAGE.evidencedReviewCount,
      requireTypes: ['DaySpa', 'Organization', 'Service'],
    })
    /*
     * The case the three refusals below cannot do without. Three fixtures refused by name is consistent
     * with a validator that refuses every page there is — which would be a gate that fails the real site
     * on the day it is wired up, and would have passed every other assertion in this file.
     */
    expect(formatStructuredDataFindings(report.findings)).toBe('')
    expect(report.coverage.blocksFound).toBe(1)
    expect(report.coverage.blocksParsed).toBe(1)
    // And the nodes were actually judged: a validator handed an empty graph reports nothing either.
    expect(report.coverage.nodesJudged).toBeGreaterThan(5)
  })
})

describe('validatePageStructuredData: the three known-bad pages', () => {
  it('has a fixture for every rule it claims to prove, and no duplicates', () => {
    expect(KNOWN_BAD_PAGES).toHaveLength(3)
    expect(new Set(KNOWN_BAD_PAGES.map((page) => page.rule)).size).toBe(3)
  })

  for (const page of KNOWN_BAD_PAGES) {
    it(`refuses ${page.id} by the rule ${page.rule}`, () => {
      const report = validatePageStructuredData({
        html: enclose(page.html),
        pagePath: '/',
        licence: page.licence,
        evidencedReviewCount: page.evidencedReviewCount,
      })
      expect(
        report.findings.map((finding) => finding.rule),
        `${page.id} was not refused by ${page.rule}: ${formatStructuredDataFindings(report.findings)}`,
      ).toContain(page.rule)
    })
  }
})

describe('validatePageStructuredData: the rules that are properties of the page', () => {
  it('reports a page serving no ld+json block at all', () => {
    const report = validatePageStructuredData({
      html: enclose('<!doctype html><html><body><h1>No markup</h1></body></html>'),
      pagePath: '/treatments/deep-tissue',
      licence: 'unconfirmed',
      evidencedReviewCount: 0,
    })
    expect(report.findings.map((finding) => finding.rule)).toEqual(['jsonld_block_absent'])
    expect(report.coverage.blocksFound).toBe(0)
  })

  it('reports a block that does not parse, and counts it as found but not parsed', () => {
    const report = validatePageStructuredData({
      html: enclose(pageServing('{"@context":"https://schema.org","@graph":[')),
      pagePath: '/',
      licence: 'unconfirmed',
      evidencedReviewCount: 0,
    })
    expect(report.findings.map((finding) => finding.rule)).toEqual(['jsonld_not_parseable'])
    expect(report.coverage.blocksFound).toBe(1)
    expect(report.coverage.blocksParsed).toBe(0)
  })

  it('reports a type the route owes once for the PAGE and not once per block', () => {
    const twoBlocks = [
      '<!doctype html><html><head>',
      `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [{ '@type': 'BreadcrumbList', '@id': 'https://e.test/#b', itemListElement: [] }],
      })}</script>`,
      `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [{ '@type': 'FAQPage', '@id': 'https://e.test/#f', mainEntity: [] }],
      })}</script>`,
      '</head><body></body></html>',
    ].join('')
    const report = validatePageStructuredData({
      html: enclose(twoBlocks),
      pagePath: '/treatments/deep-tissue',
      licence: 'unconfirmed',
      evidencedReviewCount: 0,
      requireTypes: ['Service'],
    })
    const required = report.findings.filter((finding) => finding.rule === 'required_type_absent')
    // ONE, over two blocks. Forwarding `requireTypes` into the per-block call was the first draft and
    // would report a missing Service twice on a page whose second tag carries it — which is a finding an
    // owner fixes by adding a second copy of the node.
    expect(required).toHaveLength(1)
    // And the control: a type one of the blocks DOES carry is not reported.
    const satisfied = validatePageStructuredData({
      html: enclose(twoBlocks),
      pagePath: '/',
      licence: 'unconfirmed',
      evidencedReviewCount: 0,
      requireTypes: ['FAQPage'],
    })
    expect(satisfied.findings.filter((finding) => finding.rule === 'required_type_absent')).toEqual(
      [],
    )
  })
})

describe('validatePageStructuredData: the aggregateRating evidence rule', () => {
  const ratingPage = (reviewCount: unknown) =>
    pageServing(
      JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'Organization',
            '@id': 'https://e.test/#org',
            name: 'Specimen Wellness Rooms',
            url: 'https://e.test/',
            aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.90', reviewCount },
          },
        ],
      }),
    )

  it('refuses a count larger than what is evidenced outside this site', () => {
    const report = validatePageStructuredData({
      html: enclose(ratingPage(14)),
      pagePath: '/',
      licence: 'unconfirmed',
      evidencedReviewCount: 0,
    })
    expect(report.findings.map((finding) => finding.rule)).toContain(
      'aggregate_rating_not_evidenced',
    )
  })

  it('accepts the same count once that many reviews are evidenced', () => {
    const report = validatePageStructuredData({
      html: enclose(ratingPage(14)),
      pagePath: '/',
      licence: 'unconfirmed',
      // Not this build's answer — there is no Business Profile API access (ADR 0005) — and that is why
      // this control exists: a rule that refused every rating would be a rule this site could never
      // satisfy, and nobody would find out until reviews started arriving.
      evidencedReviewCount: 14,
    })
    expect(report.findings.map((finding) => finding.rule)).not.toContain(
      'aggregate_rating_not_evidenced',
    )
  })

  it('leaves a rating with no usable count to the graph validator, and does not report it twice', () => {
    const report = validatePageStructuredData({
      html: enclose(ratingPage('lots')),
      pagePath: '/',
      licence: 'unconfirmed',
      evidencedReviewCount: 0,
    })
    const rules = report.findings.map((finding) => finding.rule)
    expect(rules).toContain('aggregate_rating_without_reviews')
    expect(rules).not.toContain('aggregate_rating_not_evidenced')
  })

  it('finds a rating hung off a nested node, not just off the business', () => {
    const nested = pageServing(
      JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'Service',
            '@id': 'https://e.test/#s',
            name: 'Deep tissue',
            serviceType: 'Massage',
            provider: {
              '@id': 'https://e.test/#org',
              aggregateRating: { '@type': 'AggregateRating', ratingValue: '5.00', reviewCount: 3 },
            },
            offers: [],
          },
        ],
      }),
    )
    const report = validatePageStructuredData({
      html: enclose(nested),
      pagePath: '/',
      licence: 'unconfirmed',
      evidencedReviewCount: 0,
    })
    const finding = report.findings.find((f) => f.rule === 'aggregate_rating_not_evidenced')
    expect(finding).toBeDefined()
    // The path names the block as well as the property, so a fix is applied to the right script tag.
    expect(finding?.path).toContain('block[0]')
    expect(finding?.path).toContain('aggregateRating')
  })

  it('refuses an evidenced count that is not a whole number of reviews', () => {
    expect(() =>
      validatePageStructuredData({
        html: enclose(CLEAN_PAGE.html),
        pagePath: '/',
        licence: 'unconfirmed',
        evidencedReviewCount: -1,
      }),
    ).toThrow(/evidencedReviewCount/)
  })
})
