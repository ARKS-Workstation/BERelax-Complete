import { describe, expect, it } from 'vitest'
import {
  clickDepths,
  formatLinkGraphFindings,
  judgeLinkGraph,
  LINK_GRAPH_RULES,
  type LinkGraph,
  type LinkGraphRule,
  type LinkNode,
  normaliseLinkPath,
} from './link-graph.ts'

/**
 * W-SITE-07 — the link-graph invariant, on fixtures whose answer is known.
 *
 * Every rule is asserted twice: once on a graph that satisfies it and once on a graph that breaks it, and
 * the breaking case asserts the RULE NAME rather than the message (ADR 0003). That pairing is the whole
 * point of testing the rules here rather than only over the crawl: five of the six have no subjects on the
 * site as it stands — no therapist page exists and no journal post can be published without an author and
 * a reviewer byline, which are names of real people this build must not invent — so the crawl alone would
 * report six passes over one subject and nothing would have been checked.
 */

/** A node with the fields most cases do not care about filled in. */
function node(partial: Partial<LinkNode> & Pick<LinkNode, 'path'>): LinkNode {
  return {
    kind: 'other',
    links: [],
    status: 200,
    indexable: true,
    ...partial,
  }
}

function graphOf(nodes: readonly LinkNode[], home = '/'): LinkGraph {
  return { nodes, home, maxClickDepth: 3 }
}

const rulesIn = (report: { findings: readonly { rule: LinkGraphRule }[] }): LinkGraphRule[] => [
  ...new Set(report.findings.map((finding) => finding.rule)),
]

describe('a path is one node however a link spells it', () => {
  it('drops the fragment, the query and one trailing slash', () => {
    expect(normaliseLinkPath('/treatments/x#how-much')).toBe('/treatments/x')
    expect(normaliseLinkPath('/treatments/')).toBe('/treatments')
    expect(normaliseLinkPath('/treatments?utm_source=a')).toBe('/treatments')
    expect(normaliseLinkPath('/')).toBe('/')
    expect(normaliseLinkPath('')).toBe('/')
  })

  it('treats a heading anchor on the page itself as the page', () => {
    // The real case this exists for: every question-shaped `<h2>` on a treatment page has a stable id, and
    // a table of contents linking `#how-much-does-it-cost` must not read as a link to a page that 404s.
    const report = judgeLinkGraph(
      graphOf([
        node({ path: '/', kind: 'home', links: ['/spa'] }),
        node({ path: '/spa', links: ['/spa#parking'] }),
      ]),
    )
    expect(report.findings).toEqual([])
  })
})

describe('reachability is the shortest number of clicks, not any number', () => {
  it('reports the shortest path when a page is reachable two ways', () => {
    // Depth-first would find `/d` at 3 through the chain and at 1 directly, and which one it reported would
    // depend on link order — so a page one click from home could fail a three-click budget.
    const depths = clickDepths(
      graphOf([
        node({ path: '/', kind: 'home', links: ['/a', '/d'] }),
        node({ path: '/a', links: ['/b'] }),
        node({ path: '/b', links: ['/c'] }),
        node({ path: '/c', links: ['/d'] }),
        node({ path: '/d', links: [] }),
      ]),
    )
    expect(depths.get('/d')).toBe(1)
    expect(depths.get('/c')).toBe(3)
  })

  it('starts from the locale home, so /ar is its own tree', () => {
    const depths = clickDepths(
      graphOf(
        [
          node({ path: '/ar', kind: 'home', links: ['/ar/spa'] }),
          node({ path: '/ar/spa', links: [] }),
        ],
        '/ar',
      ),
    )
    expect(depths.get('/ar')).toBe(0)
    expect(depths.get('/ar/spa')).toBe(1)
  })

  it('returns nothing when the home page is not in the graph', () => {
    // A crawl that failed to fetch the home page must not report every page as unreachable *and* pass the
    // orphan rule: the caller sees an empty depth map, and every indexable node then fails the depth rule
    // by name rather than the whole report being empty.
    const report = judgeLinkGraph(graphOf([node({ path: '/spa' })]))
    expect(clickDepths(graphOf([node({ path: '/spa' })])).size).toBe(0)
    expect(rulesIn(report)).toContain('route_beyond_click_depth')
  })
})

describe('acceptance — each rule fires by name, and passes on the graph that satisfies it', () => {
  it('passes a hub-and-spoke site with every kind present', () => {
    // The control for all six. Without a graph that satisfies every rule, an implementation that always
    // reported a finding would pass every case below.
    const report = judgeLinkGraph(
      graphOf([
        node({ path: '/', kind: 'home', links: ['/treatments', '/journal', '/therapists'] }),
        node({ path: '/treatments', links: ['/treatments/a'] }),
        node({
          path: '/treatments/a',
          kind: 'treatment',
          links: ['/therapists/t', '/journal/p'],
        }),
        node({ path: '/therapists', links: ['/therapists/t'] }),
        node({ path: '/therapists/t', kind: 'therapist', links: ['/treatments/a'] }),
        node({ path: '/journal', links: ['/journal/p'] }),
        node({ path: '/journal/p', kind: 'journal_post', links: ['/treatments/a'] }),
      ]),
    )
    expect(formatLinkGraphFindings(report.findings)).toBe('')
    expect(report.findings).toEqual([])
    // And every rule had a subject, which is the other half of "this passed for a reason".
    for (const rule of LINK_GRAPH_RULES) expect(report.coverage[rule], rule).toBeGreaterThan(0)
  })

  it('internal_link_not_200 — a link to a 404 and a link to a path nothing serves', () => {
    const report = judgeLinkGraph(
      graphOf([
        node({ path: '/', kind: 'home', links: ['/gone', '/never'] }),
        node({ path: '/gone', status: 404 }),
      ]),
    )
    const links = report.findings.filter((finding) => finding.rule === 'internal_link_not_200')
    expect(links).toHaveLength(2)
    expect(links.map((finding) => finding.why).join(' ')).toContain('404')
    // Two links, two subjects: the rule counts links rather than pages, or a page with ten links would be
    // one subject and the count would say nothing about how much was checked.
    expect(report.coverage.internal_link_not_200).toBe(2)
  })

  it('orphan_route — an indexable page nothing links to', () => {
    const report = judgeLinkGraph(
      graphOf([node({ path: '/', kind: 'home', links: [] }), node({ path: '/spa' })]),
    )
    expect(rulesIn(report)).toContain('orphan_route')
    expect(report.findings.some((finding) => finding.path === '/spa')).toBe(true)
  })

  it('orphan_route exempts the home page and every non-indexable route', () => {
    // Two controls in one. The home page has no inbound link by definition; the kitchen sink carries
    // `noindex, nofollow`, so a public page linking to it would be the mistake rather than the absence.
    const report = judgeLinkGraph(
      graphOf([
        node({ path: '/', kind: 'home', links: [] }),
        node({ path: '/kitchen-sink', indexable: false }),
      ]),
    )
    expect(report.findings).toEqual([])
    expect(report.coverage.orphan_route).toBe(0)
  })

  it('route_beyond_click_depth — four clicks is one too many, three is not', () => {
    const chain = [
      node({ path: '/', kind: 'home', links: ['/a'] }),
      node({ path: '/a', links: ['/b'] }),
      node({ path: '/b', links: ['/c'] }),
      node({ path: '/c', links: ['/d'] }),
      node({ path: '/d', links: [] }),
    ]
    const report = judgeLinkGraph(graphOf(chain))
    const deep = report.findings.filter((finding) => finding.rule === 'route_beyond_click_depth')
    expect(deep.map((finding) => finding.path)).toEqual(['/d'])
    expect(deep[0]?.why).toContain('4 clicks')
    // The control: `/c` is exactly at the budget and is not reported, so the comparison is `>` and not `>=`.
    expect(report.depths.get('/c')).toBe(3)
  })

  it('route_beyond_click_depth catches a page linked only from another orphan', () => {
    // The reason this is a separate rule from the orphan one: `/b` has an inbound link, so the orphan rule
    // is satisfied, and nothing reaches it from home.
    const report = judgeLinkGraph(
      graphOf([
        node({ path: '/', kind: 'home', links: [] }),
        node({ path: '/a', links: ['/b'] }),
        node({ path: '/b', links: ['/a'] }),
      ]),
    )
    const deep = report.findings.filter((finding) => finding.rule === 'route_beyond_click_depth')
    expect(deep.map((finding) => finding.path).sort()).toEqual(['/a', '/b'])
    expect(deep.some((finding) => finding.why.includes('not reachable'))).toBe(true)
  })

  it('treatment_without_therapist_link and treatment_without_journal_link', () => {
    const report = judgeLinkGraph(
      graphOf([
        node({ path: '/', kind: 'home', links: ['/treatments/a'] }),
        node({ path: '/treatments/a', kind: 'treatment', links: [] }),
      ]),
    )
    expect(rulesIn(report)).toContain('treatment_without_therapist_link')
    expect(rulesIn(report)).toContain('treatment_without_journal_link')
    expect(report.coverage.treatment_without_therapist_link).toBe(1)
  })

  it('a treatment page satisfies the rules by the KIND it links to, not by the path shape', () => {
    // The control that matters most: a page could link to `/therapists/x` and still fail if that path were
    // not a therapist page, and — the real hazard — a link to a path the crawl never fetched must not count.
    const report = judgeLinkGraph(
      graphOf([
        node({ path: '/', kind: 'home', links: ['/treatments/a'] }),
        node({
          path: '/treatments/a',
          kind: 'treatment',
          links: ['/therapists/ghost', '/journal/ghost'],
        }),
      ]),
    )
    expect(rulesIn(report)).toContain('treatment_without_therapist_link')
    expect(rulesIn(report)).toContain('treatment_without_journal_link')
    expect(rulesIn(report)).toContain('internal_link_not_200')
  })

  it('journal_post_without_treatment_link', () => {
    const report = judgeLinkGraph(
      graphOf([
        node({ path: '/', kind: 'home', links: ['/journal/p'] }),
        node({ path: '/journal/p', kind: 'journal_post', links: [] }),
      ]),
    )
    expect(rulesIn(report)).toEqual(['journal_post_without_treatment_link'])
    expect(report.coverage.journal_post_without_treatment_link).toBe(1)
  })

  it('reports zero coverage for a rule with no subjects, rather than a pass', () => {
    // The site as it stands: no therapist page, no journal post. Four of the six rules judge nothing, and a
    // caller that asserted only `findings === []` would be asserting nothing about four of them.
    const report = judgeLinkGraph(
      graphOf([
        node({ path: '/', kind: 'home', links: ['/spa'] }),
        node({ path: '/spa', links: ['/'] }),
      ]),
    )
    expect(report.findings).toEqual([])
    expect(report.coverage.treatment_without_therapist_link).toBe(0)
    expect(report.coverage.treatment_without_journal_link).toBe(0)
    expect(report.coverage.journal_post_without_treatment_link).toBe(0)
    expect(report.coverage.orphan_route).toBe(1)
    expect(report.coverage.route_beyond_click_depth).toBe(2)
  })

  it('names the rule in the formatted message, because that is what a failing test prints', () => {
    const report = judgeLinkGraph(
      graphOf([node({ path: '/', kind: 'home', links: [] }), node({ path: '/spa' })]),
    )
    const message = formatLinkGraphFindings(report.findings)
    expect(message).toContain('orphan_route')
    expect(message).toContain('/spa')
  })
})
