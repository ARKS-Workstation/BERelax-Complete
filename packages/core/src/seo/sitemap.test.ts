import { describe, expect, it } from 'vitest'
import {
  escapeXml,
  formatSitemapFindings,
  isSitemapType,
  lastmodFor,
  reciprocityFindings,
  SITEMAP_TYPES,
  type SitemapUrl,
  sitemapIndexXml,
  sitemapXml,
} from './sitemap.ts'

const EN: SitemapUrl = {
  loc: 'https://example.test/treatments/x',
  lastmod: '2026-01-02T03:04:05+04:00',
  changefreq: 'monthly',
  alternates: {
    en: 'https://example.test/treatments/x',
    ar: 'https://example.test/ar/treatments/x',
    'x-default': 'https://example.test/treatments/x',
  },
}
const AR: SitemapUrl = { ...EN, loc: 'https://example.test/ar/treatments/x' }

describe('the lastmod carries a stated offset', () => {
  it('formats an instant in the zone it is given', () => {
    // 08:00Z in a +240-minute zone is noon. The offset is an ARGUMENT (ADR 0009), which is why the same
    // instant has two right answers here.
    expect(lastmodFor('2026-01-02T08:00:00.000Z', 240)).toBe('2026-01-02T12:00:00+04:00')
    expect(lastmodFor('2026-01-02T08:00:00.000Z', 0)).toBe('2026-01-02T08:00:00+00:00')
    expect(lastmodFor('2026-01-02T08:00:00.000Z', -330)).toBe('2026-01-02T02:30:00-05:30')
  })

  it('rolls the date when the offset crosses midnight', () => {
    expect(lastmodFor('2026-01-02T22:00:00.000Z', 240)).toBe('2026-01-03T02:00:00+04:00')
  })

  it('refuses an instant it cannot parse, rather than emitting Invalid Date', () => {
    // A sitemap carrying `Invalid Date` is a document a crawler rejects WHOLE, so every other URL in it
    // is lost too. The failure belongs at the moment the string is built.
    expect(() => lastmodFor('not an instant', 240)).toThrow(/is not an instant/)
  })
})

describe('the hreflang graph', () => {
  it('reports nothing for a reciprocal, self-referential pair', () => {
    expect(reciprocityFindings([EN, AR])).toEqual([])
  })

  it('catches a set that does not list itself', () => {
    const lopsided: SitemapUrl = {
      ...EN,
      alternates: { ar: 'https://example.test/ar/treatments/x' },
    }
    const findings = reciprocityFindings([lopsided, AR])
    expect(findings.map((finding) => finding.rule)).toContain(
      'alternate_set_is_not_self_referential',
    )
  })

  it('catches a one-way pair', () => {
    const oneWay: SitemapUrl = { ...AR, alternates: { ar: AR.loc } }
    const findings = reciprocityFindings([EN, oneWay])
    expect(findings.map((finding) => finding.rule)).toContain('alternate_set_is_not_reciprocal')
  })

  it('catches an alternate naming a URL the sitemap does not contain', () => {
    // The realistic defect, and the one that appears AFTER the code was correct: the other document
    // stopped being published — an archived treatment, a withdrawn photography consent — and the
    // surviving half still points at it.
    const findings = reciprocityFindings([EN])
    expect(findings.map((finding) => finding.rule)).toEqual(['alternate_names_an_absent_url'])
    expect(formatSitemapFindings(findings)).toContain('/ar/treatments/x')
  })

  it('catches two URLs with one location', () => {
    const findings = reciprocityFindings([EN, EN, AR])
    expect(findings.map((finding) => finding.rule)).toContain('duplicate_location')
  })

  it('says nothing about a URL with no alternates at all', () => {
    // One locale and no alternate is legitimate — a handler, a route served in one language — and a rule
    // that reported it would make the honest case indistinguishable from the broken one.
    expect(reciprocityFindings([{ ...EN, alternates: {} }])).toEqual([])
  })
})

describe('the bytes', () => {
  it('refuses to serve a sitemap whose reciprocity is broken', () => {
    // Serving it is worse than serving nothing: a lopsided set makes Google discard the language signal
    // for every page in the group, and a 500 on /sitemaps/treatments is noticed the same day.
    expect(() => sitemapXml([EN])).toThrow(/not reciprocal/)
  })

  it('writes one url per entry with its alternates, sorted', () => {
    const xml = sitemapXml([EN, AR])
    expect(xml).toContain('<loc>https://example.test/treatments/x</loc>')
    expect(xml).toContain('<lastmod>2026-01-02T03:04:05+04:00</lastmod>')
    expect(xml).toContain('<changefreq>monthly</changefreq>')
    // Sorted by hreflang, so two builds of one sitemap are byte-identical and a diff is the change.
    const first = xml.indexOf('hreflang="ar"')
    const second = xml.indexOf('hreflang="en"')
    const third = xml.indexOf('hreflang="x-default"')
    expect(first).toBeLessThan(second)
    expect(second).toBeLessThan(third)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
  })

  it('escapes an ampersand, because one unescaped makes the whole document unparseable', () => {
    expect(escapeXml('a&b<c>"d"')).toBe('a&amp;b&lt;c&gt;&quot;d&quot;')
    // And not doubly: `&` becomes `&amp;` and the `&` inside `&amp;` is not escaped again.
    expect(escapeXml('&')).toBe('&amp;')
  })

  it('refuses an index section with no URLs', () => {
    expect(() =>
      sitemapIndexXml([
        {
          type: 'therapists',
          loc: 'https://example.test/sitemaps/therapists',
          lastmod: 'x',
          urlCount: 0,
        },
      ]),
    ).toThrow(/no URLs/)
  })

  it('writes the index for the sections that hold something, which is the control', () => {
    const xml = sitemapIndexXml([
      {
        type: 'pages',
        loc: 'https://example.test/sitemaps/pages',
        lastmod: '2026-01-02T03:04:05+04:00',
        urlCount: 18,
      },
    ])
    expect(xml).toContain('<sitemapindex')
    expect(xml).toContain('https://example.test/sitemaps/pages')
  })
})

describe('the section vocabulary is closed', () => {
  it('names the four the acceptance criterion does', () => {
    expect([...SITEMAP_TYPES]).toEqual(['pages', 'treatments', 'therapists', 'journal'])
    expect(isSitemapType('treatments')).toBe(true)
    expect(isSitemapType('Treatments')).toBe(false)
    expect(isSitemapType('everything')).toBe(false)
  })
})
