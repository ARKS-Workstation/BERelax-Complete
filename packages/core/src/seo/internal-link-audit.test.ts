import { describe, expect, it } from 'vitest'
import {
  auditInternalLinks,
  INTERNAL_LINK_AUDIT_RULES,
  pathOnOrigin,
  sitemapLocations,
  type TherapistRouteExpectation,
} from './internal-link-audit.ts'
import type { LinkGraph, LinkNode } from './link-graph.ts'
import type { TherapistCandidate } from './therapist-publishable.ts'
import { encloseUntrustedSeoData } from './untrusted-envelope.ts'

/**
 * The sitemap-against-crawl audit, and the acceptance line that is really about an ABSENCE.
 *
 * *"Internal-link audit against the live sitemap reports orphan treatment and therapist routes; a
 * therapist without a display name or without recorded photography consent is correctly absent from the
 * sitemap and is therefore NOT reported as an orphan, asserted for both missing-field cases."*
 *
 * Both missing-field cases get their own assertion, because they are different columns and a rule that
 * checked only the display name would pass a single combined fixture.
 */

const ORIGIN = 'https://example.test'

function sitemapOf(paths: readonly string[]) {
  const urls = paths.map((path) => `  <url><loc>${ORIGIN}${path}</loc></url>`).join('\n')
  return encloseUntrustedSeoData({
    source: 'fetched_html',
    text: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${urls}\n</urlset>`,
  })
}

function node(
  path: string,
  kind: LinkNode['kind'],
  links: readonly string[],
  indexable = true,
): LinkNode {
  return { path, kind, links, status: 200, indexable }
}

/** A graph where `/` links to one treatment page and the second treatment page is unlinked. */
function graphOf(nodes: readonly LinkNode[]): LinkGraph {
  return { nodes, home: '/', maxClickDepth: 3 }
}

/** A therapist the guard refuses for a stated reason. The handle is a LABEL, never a name. */
function therapist(
  staffReference: string,
  overrides: Partial<TherapistCandidate> = {},
): TherapistCandidate {
  return {
    staffReference,
    displayName: 'Therapist Record 07',
    photographyConsentRecordedAt: '2026-02-01T00:00:00.000Z',
    retiredAt: null,
    ...overrides,
  }
}

describe('sitemapLocations and pathOnOrigin', () => {
  it('reads every <loc> and nothing else', () => {
    const xml =
      '<urlset><url><loc>https://a.test/x</loc><lastmod>2026-01-01</lastmod></url>' +
      '<url><loc>\n  https://a.test/y\n</loc></url></urlset>'
    expect(sitemapLocations(xml)).toEqual(['https://a.test/x', 'https://a.test/y'])
    // The control: a document with no <loc> yields nothing rather than an empty string, which would
    // normalise to `/` and be audited as the home page.
    expect(sitemapLocations('<urlset></urlset>')).toEqual([])
  })

  it('refuses a loc that is not a plain path on the origin', () => {
    expect(pathOnOrigin(`${ORIGIN}/treatments/x`, ORIGIN)).toBe('/treatments/x')
    expect(pathOnOrigin(ORIGIN, ORIGIN)).toBe('/')
    expect(pathOnOrigin('https://other.test/treatments/x', ORIGIN)).toBeNull()
    expect(pathOnOrigin(`${ORIGIN}/treatments/x?utm_source=a`, ORIGIN)).toBeNull()
    expect(pathOnOrigin(`${ORIGIN}/treatments/x#book`, ORIGIN)).toBeNull()
    // The near-miss that a `startsWith(origin)` test alone would accept: a host whose name begins with
    // ours. Without the slash in the prefix this is read as the path `.evil.test/x` on our own origin.
    expect(pathOnOrigin('https://example.test.evil.test/x', ORIGIN)).toBeNull()
  })
})

describe('auditInternalLinks', () => {
  it('reports a declared treatment route nothing links to', () => {
    const report = auditInternalLinks({
      sitemap: sitemapOf(['/', '/treatments/deep-tissue', '/treatments/aromatherapy']),
      origin: ORIGIN,
      graph: graphOf([
        node('/', 'home', ['/treatments/deep-tissue']),
        node('/treatments/deep-tissue', 'treatment', ['/']),
        node('/treatments/aromatherapy', 'treatment', ['/']),
      ]),
      therapistRoutes: [],
    })
    expect(report.findings.map((finding) => finding.rule)).toEqual(['orphan_in_sitemap'])
    expect(report.findings[0]?.path).toBe('/treatments/aromatherapy')
    // The control for the rule: the page that IS linked is not reported, and the home page — which
    // nothing links to by construction — is not either.
    expect(report.coverage.orphan_in_sitemap).toBe(3)
  })

  it('does not count a link from a non-indexable page as an internal signal', () => {
    const report = auditInternalLinks({
      sitemap: sitemapOf(['/', '/treatments/aromatherapy']),
      origin: ORIGIN,
      graph: graphOf([
        node('/', 'home', []),
        // The kitchen sink: it links to the treatment page and carries noindex, so a crawler never sees
        // the link. Counting it would excuse exactly the orphan a preview page happens to mention.
        node('/kitchen-sink', 'other', ['/treatments/aromatherapy'], false),
        node('/treatments/aromatherapy', 'treatment', ['/']),
      ]),
      therapistRoutes: [],
    })
    expect(report.findings.map((finding) => finding.rule)).toEqual(['orphan_in_sitemap'])
    // And the control, in the direction a refusal cannot state: the same link from an INDEXABLE page
    // clears the finding. Without this the case above is satisfied by ignoring every link there is.
    const cleared = auditInternalLinks({
      sitemap: sitemapOf(['/', '/treatments/aromatherapy']),
      origin: ORIGIN,
      graph: graphOf([
        node('/', 'home', ['/treatments/aromatherapy']),
        node('/treatments/aromatherapy', 'treatment', ['/']),
      ]),
      therapistRoutes: [],
    })
    expect(cleared.findings).toEqual([])
  })

  it('reports a declared path the crawl found no page at, and an undeclared indexable treatment page', () => {
    const report = auditInternalLinks({
      sitemap: sitemapOf(['/', '/treatments/retired']),
      origin: ORIGIN,
      graph: graphOf([
        node('/', 'home', ['/treatments/deep-tissue']),
        node('/treatments/deep-tissue', 'treatment', ['/']),
      ]),
      therapistRoutes: [],
    })
    expect(report.findings.map((finding) => finding.rule).sort()).toEqual([
      'crawled_but_absent_from_sitemap',
      'sitemap_path_not_crawled',
    ])
  })

  it('reports a loc on another host rather than silently dropping it', () => {
    const sitemap = encloseUntrustedSeoData({
      source: 'fetched_html',
      text: `<urlset><url><loc>${ORIGIN}/</loc></url><url><loc>https://other.test/x</loc></url></urlset>`,
    })
    const report = auditInternalLinks({
      sitemap,
      origin: ORIGIN,
      graph: graphOf([node('/', 'home', [])]),
      therapistRoutes: [],
    })
    expect(report.findings.map((finding) => finding.rule)).toEqual(['sitemap_loc_off_origin'])
    expect(report.findings[0]?.path).toBe('https://other.test/x')
    expect(report.declaredPaths).toEqual(['/'])
  })

  it('refuses an origin with a trailing slash rather than matching no crawled node', () => {
    expect(() =>
      auditInternalLinks({
        sitemap: sitemapOf(['/']),
        origin: `${ORIGIN}/`,
        graph: graphOf([node('/', 'home', [])]),
        therapistRoutes: [],
      }),
    ).toThrow(/ends with a slash/)
  })
})

describe('auditInternalLinks: a therapist absent from the sitemap', () => {
  const graph = graphOf([node('/', 'home', [])])
  const sitemap = sitemapOf(['/'])

  /** Both refusals, one case each. See the file header. */
  const missingFieldCases: readonly {
    readonly label: string
    readonly candidate: TherapistCandidate
    readonly refusal: string
  }[] = [
    {
      label: 'no display name',
      candidate: therapist('Therapist 07', { displayName: null }),
      refusal: 'no_display_name',
    },
    {
      label: 'no recorded photography consent',
      candidate: therapist('Therapist 11', { photographyConsentRecordedAt: null }),
      refusal: 'no_photography_consent',
    },
  ]

  for (const missing of missingFieldCases) {
    it(`is EXCUSED and not an orphan when the therapist has ${missing.label}`, () => {
      const expectation: TherapistRouteExpectation = {
        path: '/therapists/record-07',
        candidate: missing.candidate,
      }
      const report = auditInternalLinks({
        sitemap,
        origin: ORIGIN,
        graph,
        therapistRoutes: [expectation],
      })
      expect(report.findings).toEqual([])
      expect(report.excusedTherapistRoutes).toHaveLength(1)
      expect(report.excusedTherapistRoutes[0]?.refusals).toContain(missing.refusal)
      // The handle and not a name (brief rule 10): what the report shows an admin is the record label.
      expect(report.excusedTherapistRoutes[0]?.staffReference).toBe(
        missing.candidate.staffReference,
      )
      // The rule was JUDGED. Without this the excused case is indistinguishable from a rule with no
      // subjects, which is the vacuous pass ADR 0002 exists to refuse.
      expect(report.coverage.publishable_therapist_absent_from_sitemap).toBe(1)
    })
  }

  it('IS a finding when the therapist may be published and the sitemap omits the route', () => {
    const report = auditInternalLinks({
      sitemap,
      origin: ORIGIN,
      graph,
      therapistRoutes: [{ path: '/therapists/record-07', candidate: therapist('Therapist 07') }],
    })
    // The control the two cases above need: a rule that excused every absent therapist would pass both
    // of them, and the day an admin sets a display name the missing page would stay invisible.
    expect(report.findings.map((finding) => finding.rule)).toEqual([
      'publishable_therapist_absent_from_sitemap',
    ])
    expect(report.excusedTherapistRoutes).toEqual([])
  })

  it('is neither when the sitemap declares the route', () => {
    const report = auditInternalLinks({
      sitemap: sitemapOf(['/', '/therapists/record-07']),
      origin: ORIGIN,
      graph: graphOf([
        node('/', 'home', ['/therapists/record-07']),
        node('/therapists/record-07', 'therapist', ['/']),
      ]),
      therapistRoutes: [{ path: '/therapists/record-07', candidate: therapist('Therapist 07') }],
    })
    expect(report.findings).toEqual([])
    expect(report.excusedTherapistRoutes).toEqual([])
  })
})

describe('the rule list', () => {
  it('has a coverage counter for every rule and no counter for anything else', () => {
    const report = auditInternalLinks({
      sitemap: sitemapOf([]),
      origin: ORIGIN,
      graph: graphOf([]),
      therapistRoutes: [],
    })
    expect(Object.keys(report.coverage).sort()).toEqual([...INTERNAL_LINK_AUDIT_RULES].sort())
  })
})
