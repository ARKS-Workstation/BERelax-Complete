/**
 * The internal link graph, as an invariant rather than an intention.
 *
 * docs/09 §"Technical SEO" asks for "hub-and-spoke internal linking" and W-SITE-07's acceptance criterion
 * turns that phrase into six claims about the built site: every treatment page links to at least one
 * therapist page and at least one journal post, every journal post links to at least one treatment page,
 * every public route is reachable from `/` within three clicks, there are no orphans, and no internal link
 * answers anything but 200.
 *
 * Every one of those is a property of the *whole* graph, which is why this is a function over a graph and
 * not a rule in a template. A page can only be checked for "links to a journal post" by something that
 * knows which pages are journal posts; a page can only be checked for "reachable in three clicks" by
 * something that has walked the site from the home page. A convention that each page author remembers to
 * add the links is exactly what this replaces — the failure is silent, it is invisible in review, and it
 * is only ever noticed as a page that never ranked.
 *
 * ## Pure, and why the crawl is somebody else's job
 *
 * `packages/core` may not do I/O, and that division is load-bearing here rather than incidental: the crawl
 * is slow, needs a running server and can only run in the integration suite, while the *rules* are the
 * part that has to be provable on a fixture where the answer is known. So the caller fetches the site,
 * describes what it found as a {@link LinkGraph}, and this decides. `apps/web/src/content.itest.ts` is the
 * crawler; `link-graph.test.ts` is the fixture that proves each rule fires.
 *
 * ## Why the report carries coverage as well as findings
 *
 * Because five of the six rules have no subjects on this site today — there are no therapist pages
 * (W-SITE-06, and the 19 therapists have no display name: ADR 0020, Y12-consent-photo) and no publishable
 * journal post (a post needs an author and a reviewer byline, and those are names of real people this
 * build must not invent). A rule with no subjects returns no findings, which is indistinguishable from a
 * rule that passed — and that is precisely the vacuous pass ADR 0003 exists to refuse. {@link judgeLinkGraph}
 * therefore reports, per rule, how many subjects it judged, so a caller asserts the subject count it
 * expects and the day a journal post lands the count changes and the assertion is updated deliberately.
 */

/** The rules, by name. A finding names one of these, so a reworded message is not a reworded rule. */
export const LINK_GRAPH_RULES = [
  'internal_link_not_200',
  'orphan_route',
  'route_beyond_click_depth',
  'treatment_without_therapist_link',
  'treatment_without_journal_link',
  'journal_post_without_treatment_link',
] as const
export type LinkGraphRule = (typeof LINK_GRAPH_RULES)[number]

/**
 * What kind of page a node is, for the rules that are about a kind.
 *
 * `other` covers every page whose outbound links no rule constrains — the home page, `/spa`, `/faq`. It is
 * named rather than left optional so that a node added without a kind is a type error at the call site
 * rather than a page silently exempt from every hub-and-spoke rule.
 */
export const LINK_NODE_KINDS = ['home', 'treatment', 'therapist', 'journal_post', 'other'] as const
export type LinkNodeKind = (typeof LINK_NODE_KINDS)[number]

/** One page of the built site, as the crawler found it. */
export interface LinkNode {
  /** The path, exactly as the site serves it: locale prefix included, no origin, no trailing slash. */
  readonly path: string
  readonly kind: LinkNodeKind
  /**
   * The internal paths this page links to, in document order, deduplicated by the caller or not.
   *
   * Outbound only, and internal only: an external link cannot be checked for a 200 by a gate that must run
   * offline, and `Organization.sameAs` is where the external identity of this business is published.
   */
  readonly links: readonly string[]
  /**
   * The status the path itself answered.
   *
   * Carried on the node rather than assumed to be 200, because "zero internal links returning non-200" is
   * a claim about the *target* of a link: a page that links to a 404 is the defect, and the 404 is what the
   * crawler found when it followed it.
   */
  readonly status: number
  /**
   * Whether this page is one the invariant is about at all.
   *
   * False for a route the registry marks non-indexable — the kitchen sink, an admin surface. Those carry
   * `noindex, nofollow`, so a crawler never reaches them and a link to one from a public page would be the
   * mistake rather than the absence of one. They are still nodes, because a link *to* one still has to
   * answer 200 if a public page makes it.
   */
  readonly indexable: boolean
}

export interface LinkGraph {
  /** Every page of one locale's tree, including the locale's home page. */
  readonly nodes: readonly LinkNode[]
  /**
   * The path the walk starts from: `/` for English, `/ar` for Arabic.
   *
   * One graph per locale rather than one graph for the site, and the reason is what reachability means: an
   * Arabic page reached only by following the locale switch out of an English page is not reachable *in
   * Arabic*, and a reader who arrives on `/ar` from a search result would never find it.
   */
  readonly home: string
  /** How many clicks from {@link home} a page may be. Three, from the acceptance criterion. */
  readonly maxClickDepth: number
}

export interface LinkGraphFinding {
  readonly rule: LinkGraphRule
  /** The page the finding is about. */
  readonly path: string
  /** Why it fails, in a sentence, for the message the failing test prints. */
  readonly why: string
}

/**
 * How many subjects each rule judged.
 *
 * Zero is a legitimate answer and it is the one that has to be visible: see the module header.
 */
export type LinkGraphCoverage = Readonly<Record<LinkGraphRule, number>>

export interface LinkGraphReport {
  readonly findings: readonly LinkGraphFinding[]
  readonly coverage: LinkGraphCoverage
  /** Every indexable page's click distance from home, for a caller that wants to report the worst. */
  readonly depths: ReadonlyMap<string, number>
}

/** A path with no trailing slash and no fragment, so two spellings of one page are one node. */
export function normaliseLinkPath(path: string): string {
  const withoutFragment = path.split('#')[0] ?? ''
  const withoutQuery = withoutFragment.split('?')[0] ?? ''
  if (withoutQuery === '' || withoutQuery === '/') return '/'
  return withoutQuery.endsWith('/') ? withoutQuery.slice(0, -1) : withoutQuery
}

/**
 * Click distance from the home page, following outbound links breadth-first.
 *
 * Breadth-first rather than a recursive walk: the question is the *shortest* number of clicks, and a
 * depth-first walk finds a path rather than the shortest one — a page one click from home reached late down
 * a long chain would be reported at depth nine and fail a rule it satisfies.
 *
 * Links to a page the graph does not contain are ignored here. They are not lost: `internal_link_not_200`
 * is what judges them, because a link to a path nothing serves is a broken link rather than a depth
 * problem, and reporting it as both would make one defect two findings.
 */
export function clickDepths(graph: LinkGraph): ReadonlyMap<string, number> {
  const byPath = new Map(graph.nodes.map((node) => [normaliseLinkPath(node.path), node]))
  const depths = new Map<string, number>()
  const home = normaliseLinkPath(graph.home)
  if (!byPath.has(home)) return depths
  depths.set(home, 0)
  let frontier = [home]
  let depth = 0
  while (frontier.length > 0) {
    depth += 1
    const next: string[] = []
    for (const path of frontier) {
      const node = byPath.get(path)
      if (node === undefined) continue
      for (const raw of node.links) {
        const target = normaliseLinkPath(raw)
        if (depths.has(target) || !byPath.has(target)) continue
        depths.set(target, depth)
        next.push(target)
      }
    }
    frontier = next
  }
  return depths
}

/** Every path linked to from somewhere in the graph. The inbound half of the orphan rule. */
function linkedPaths(graph: LinkGraph): ReadonlySet<string> {
  const linked = new Set<string>()
  for (const node of graph.nodes) {
    for (const raw of node.links) linked.add(normaliseLinkPath(raw))
  }
  return linked
}

/**
 * The kinds one node links to.
 *
 * A link to a path the graph does not hold contributes nothing, for the reason {@link clickDepths} gives:
 * it is a broken link, judged once, by the rule that is about broken links.
 */
function linkedKinds(
  node: LinkNode,
  byPath: ReadonlyMap<string, LinkNode>,
): ReadonlySet<LinkNodeKind> {
  const kinds = new Set<LinkNodeKind>()
  for (const raw of node.links) {
    const target = byPath.get(normaliseLinkPath(raw))
    if (target !== undefined) kinds.add(target.kind)
  }
  return kinds
}

/** A mutable tally the three judges share. Written by them, frozen by {@link judgeLinkGraph}. */
interface Tally {
  readonly findings: LinkGraphFinding[]
  readonly coverage: Record<LinkGraphRule, number>
}

/**
 * Rule 1: every internal link answers 200.
 *
 * The subject of this rule is a LINK, not a page: a page linking to three paths is judged three times,
 * which is what makes its coverage count mean "how many links were checked".
 */
function judgeLinkTargets(
  graph: LinkGraph,
  byPath: ReadonlyMap<string, LinkNode>,
  tally: Tally,
): void {
  for (const node of graph.nodes) {
    for (const raw of node.links) {
      const target = normaliseLinkPath(raw)
      tally.coverage.internal_link_not_200 += 1
      const found = byPath.get(target)
      if (found === undefined) {
        tally.findings.push({
          rule: 'internal_link_not_200',
          path: node.path,
          why:
            `links to '${target}', which the crawl could not fetch at all. A link to a path nothing ` +
            'serves spends a crawler’s budget on a 404 and loses the signal the link was worth.',
        })
        continue
      }
      if (found.status !== 200) {
        tally.findings.push({
          rule: 'internal_link_not_200',
          path: node.path,
          why: `links to '${target}', which answered ${found.status} rather than 200.`,
        })
      }
    }
  }
}

/**
 * Rules 2 and 3: no orphans, and nothing beyond the click budget.
 *
 * Two rules rather than one, and the distinction is the case that motivates it: a page linked only from
 * another orphan HAS an inbound link and is still unreachable from the home page.
 */
function judgeReachability(
  graph: LinkGraph,
  node: LinkNode,
  context: { readonly linked: ReadonlySet<string>; readonly depths: ReadonlyMap<string, number> },
  tally: Tally,
): void {
  const path = normaliseLinkPath(node.path)
  // The home page is exempt from the orphan rule by definition: it is the entry point, and nothing on the
  // site has to link back to it for it to be found.
  if (path !== normaliseLinkPath(graph.home)) {
    tally.coverage.orphan_route += 1
    if (!context.linked.has(path)) {
      tally.findings.push({
        rule: 'orphan_route',
        path: node.path,
        why:
          'no page in this locale links to it. An indexable page with no inbound internal link is one ' +
          'a crawler finds only through the sitemap, and one no reader can navigate to.',
      })
    }
  }

  tally.coverage.route_beyond_click_depth += 1
  const depth = context.depths.get(path)
  if (depth === undefined) {
    tally.findings.push({
      rule: 'route_beyond_click_depth',
      path: node.path,
      why: `is not reachable from '${graph.home}' by following internal links at all.`,
    })
    return
  }
  if (depth > graph.maxClickDepth) {
    tally.findings.push({
      rule: 'route_beyond_click_depth',
      path: node.path,
      why: `is ${depth} clicks from '${graph.home}', and the budget is ${graph.maxClickDepth}.`,
    })
  }
}

/** Rules 4, 5 and 6: the spokes. A treatment page carries both layers, and a post comes back. */
function judgeHubAndSpoke(node: LinkNode, kinds: ReadonlySet<LinkNodeKind>, tally: Tally): void {
  if (node.kind === 'treatment') {
    tally.coverage.treatment_without_therapist_link += 1
    if (!kinds.has('therapist')) {
      tally.findings.push({
        rule: 'treatment_without_therapist_link',
        path: node.path,
        why:
          'links to no therapist page. docs/09 §2 makes the therapist page the strongest asset on the ' +
          'site and the best E-E-A-T signal in a health-adjacent category; a treatment page that does ' +
          'not reach one sells the service without the person who delivers it.',
      })
    }
    tally.coverage.treatment_without_journal_link += 1
    if (!kinds.has('journal_post')) {
      tally.findings.push({
        rule: 'treatment_without_journal_link',
        path: node.path,
        why:
          'links to no journal post. The journal is the informational half of the topic cluster ' +
          '(docs/09 §1), and a commercial page with no link into it is a cluster with no spokes.',
      })
    }
  }

  if (node.kind === 'journal_post') {
    tally.coverage.journal_post_without_treatment_link += 1
    if (!kinds.has('treatment')) {
      tally.findings.push({
        rule: 'journal_post_without_treatment_link',
        path: node.path,
        why:
          'links to no treatment page. A post that answers an informational query and offers no route ' +
          'to the thing it describes is the half of a topic cluster that earns nothing.',
      })
    }
  }
}

/**
 * The whole invariant, in one pass.
 *
 * Every finding, not the first: a site with four broken links and two orphans is six edits, and they are
 * worth making in one pass. The order is the rule order above, so a diff of two runs is readable.
 */
export function judgeLinkGraph(graph: LinkGraph): LinkGraphReport {
  const byPath = new Map(graph.nodes.map((node) => [normaliseLinkPath(node.path), node]))
  const depths = clickDepths(graph)
  const linked = linkedPaths(graph)
  const tally: Tally = {
    findings: [],
    coverage: {
      internal_link_not_200: 0,
      orphan_route: 0,
      route_beyond_click_depth: 0,
      treatment_without_therapist_link: 0,
      treatment_without_journal_link: 0,
      journal_post_without_treatment_link: 0,
    },
  }

  judgeLinkTargets(graph, byPath, tally)
  for (const node of graph.nodes) {
    // A non-indexable route is judged as a link TARGET above and as a subject of nothing below: it carries
    // `noindex, nofollow`, so a crawler never reaches it and a link to one from a public page would be the
    // mistake rather than the absence of one.
    if (!node.indexable) continue
    judgeReachability(graph, node, { linked, depths }, tally)
    judgeHubAndSpoke(node, linkedKinds(node, byPath), tally)
  }

  return {
    findings: Object.freeze(tally.findings),
    coverage: Object.freeze(tally.coverage),
    depths,
  }
}

/** The findings as one message, for the assertion that prints it. Rule name first, always. */
export function formatLinkGraphFindings(findings: readonly LinkGraphFinding[]): string {
  return findings.map((finding) => `${finding.rule}: ${finding.path} ${finding.why}`).join('\n')
}
