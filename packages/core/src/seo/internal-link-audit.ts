import { AppError } from '@berelax/shared'
import {
  type TherapistCandidate,
  type TherapistPublishingRefusal,
  therapistPublishingRefusals,
} from './jsonld/content.ts'
import { type LinkGraph, type LinkNode, normaliseLinkPath } from './link-graph.ts'
import type { SeoUntrustedEnvelope } from './untrusted-envelope.ts'

/**
 * The sitemap against the crawl: which published routes nothing links to, and which links go nowhere.
 *
 * ## Why this is a second module and not six more rules in `link-graph.ts`
 *
 * W-SITE-07's `judgeLinkGraph` judges a graph: hub-and-spoke, click depth, and an `orphan_route` rule over
 * the pages the crawler found. This asks a different question with a different authority. The **sitemap**
 * is the list of URLs this site asks Google to index, so a route in it that nothing links to is an orphan
 * *in the sense that matters to a crawler* — Google will fetch it, find no internal signal of its
 * importance, and rank it as an island — while a page the crawl found but the sitemap omits is the
 * opposite defect and is invisible to a graph rule, because the graph has no idea what was declared.
 *
 * Two inputs that can disagree is the whole subject. One module over one of them cannot have it.
 *
 * ## The rule that is really an absence, and why it needs the therapist rows
 *
 * There are nineteen therapists and none of them has a display name or a recorded photography consent
 * (ADR 0020, Y12-consent-photo), so `mayPublishTherapist` refuses every one and the sitemap carries no
 * therapist route at all. A naive audit reports nineteen orphans — or, worse, a later version reports
 * nineteen *missing pages* — and an owner reading that report learns to scroll past the therapist section,
 * which is where the real defect will eventually appear.
 *
 * So an absent therapist route is only a finding when **no refusal explains it**. The refusals come from
 * `therapistPublishingRefusals`, which is the same function the JSON-LD builder gates on, imported rather
 * than restated: a second copy of "may this therapist be published" is a second answer, and the day they
 * disagree the sitemap and the structured data describe different staff. The excused routes are on the
 * report rather than dropped, with the refusal named, because an absence nothing records is an absence
 * nobody can audit — and the day an admin sets a display name the route must appear, which is a change in
 * this report rather than in a comment.
 *
 * ## The sitemap arrives inside the untrusted envelope
 *
 * It is bytes fetched over HTTP from a server. In this build that server is ours, which is exactly the
 * assumption worth refusing to make: the audit runs against a `baseUrl` a setting supplies, a staging host
 * answers it, and a `<loc>` is a string somebody else wrote. G-SEO-02's envelope is how every byte the SEO
 * agent did not write enters this package, and
 * `.dependency-cruiser.cjs`'s `seo-site-analysis-must-take-the-untrusted-envelope` is what keeps the
 * argument that shape rather than a convention that holds until the next caller.
 *
 * ## Pure, and the crawl is somebody else's job
 *
 * `packages/core` may not do I/O. The caller fetches the sitemap and crawls the site; this decides. The
 * rules are the part that has to be provable on a fixture whose answer is known, which is `link-graph.ts`'s
 * own argument for living here.
 */

/** The rules, by name. A finding names one of these, so a reworded message is not a reworded rule. */
export const INTERNAL_LINK_AUDIT_RULES = [
  /** Declared in the sitemap, and no indexable page links to it. */
  'orphan_in_sitemap',
  /** Declared in the sitemap, and the crawl found no page there at all. */
  'sitemap_path_not_crawled',
  /** An indexable treatment or therapist page the crawl found and the sitemap does not declare. */
  'crawled_but_absent_from_sitemap',
  /** A therapist whose page may be published is absent from the sitemap with nothing to explain it. */
  'publishable_therapist_absent_from_sitemap',
  /** A `<loc>` that is not a path on this origin: another host, a scheme, or unparseable. */
  'sitemap_loc_off_origin',
] as const
export type InternalLinkAuditRule = (typeof INTERNAL_LINK_AUDIT_RULES)[number]

export interface InternalLinkAuditFinding {
  readonly rule: InternalLinkAuditRule
  /** The path, or the raw `<loc>` for `sitemap_loc_off_origin`. */
  readonly path: string
  /** Why, in a sentence, for the report an owner reads. */
  readonly why: string
}

/** A therapist route the site would serve if the therapist were publishable. */
export interface TherapistRouteExpectation {
  /** The path, in the spelling the sitemap would carry. The route registry's, not derived here. */
  readonly path: string
  readonly candidate: TherapistCandidate
}

/** An absent therapist route and the recorded reasons it is absent. Never a finding. */
export interface ExcusedTherapistRoute {
  readonly path: string
  /** The internal handle — `Therapist 07`. Never a name (brief rule 10). */
  readonly staffReference: string
  readonly refusals: readonly TherapistPublishingRefusal[]
}

export interface InternalLinkAuditInput {
  /**
   * The fetched `sitemap.xml`, enclosed. See the module header.
   *
   * `fetched_html` is the source label: the envelope's four labels are the four KINDS of byte the agent
   * did not write, and a sitemap is a document fetched from a web server. Adding a fifth label for the
   * same kind of byte would widen a closed enum that three other modules switch on, for a distinction that
   * changes nothing about how the bytes are treated.
   */
  readonly sitemap: SeoUntrustedEnvelope
  /** The origin the sitemap's `<loc>` values must be on, with no trailing slash. */
  readonly origin: string
  readonly graph: LinkGraph
  /** Every therapist the roster holds, with the route the registry would serve for each. */
  readonly therapistRoutes: readonly TherapistRouteExpectation[]
}

/** How many subjects each rule judged. Zero is legitimate and has to be visible. */
export type InternalLinkAuditCoverage = Readonly<Record<InternalLinkAuditRule, number>>

export interface InternalLinkAuditReport {
  readonly findings: readonly InternalLinkAuditFinding[]
  readonly coverage: InternalLinkAuditCoverage
  /** Every path the sitemap declared, normalised, in the order it declared them. */
  readonly declaredPaths: readonly string[]
  /** The therapist routes absent for a recorded reason. See the module header. */
  readonly excusedTherapistRoutes: readonly ExcusedTherapistRoute[]
}

/**
 * Every `<loc>` in a sitemap, as written.
 *
 * A regular expression and not an XML parser, deliberately. `packages/core` may not take a dependency for
 * this and a sitemap is a flat list of one element — but the reason it is SAFE is the envelope: the text
 * being scanned has already been stripped of control and format characters and capped, so the pathological
 * inputs a hand-rolled scanner is rightly feared for cannot arrive. What it does NOT do is resolve entities
 * or namespaces, which is why anything that is not a plain path on the expected origin becomes
 * `sitemap_loc_off_origin` rather than being interpreted generously.
 */
export function sitemapLocations(xml: string): readonly string[] {
  const found: string[] = []
  const pattern = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/g
  let match = pattern.exec(xml)
  while (match !== null) {
    found.push(match[1] as string)
    match = pattern.exec(xml)
  }
  return found
}

/**
 * The path a `<loc>` names on this origin, or null when it names something else.
 *
 * Null rather than a thrown error: a sitemap carrying one bad entry is a sitemap worth auditing, and a
 * throw here would make a single typo hide every other finding. The caller turns each null into
 * `sitemap_loc_off_origin`, so nothing is silently dropped.
 */
export function pathOnOrigin(loc: string, origin: string): string | null {
  if (!loc.startsWith(`${origin}/`) && loc !== origin) return null
  const rest = loc.slice(origin.length)
  if (rest.includes('#') || rest.includes('?')) return null
  return normaliseLinkPath(rest === '' ? '/' : rest)
}

/** A mutable tally, so the helpers below can count what they judged. */
type Tally = Record<InternalLinkAuditRule, number>

/** Every path the sitemap declares, with a finding for each `<loc>` that is not one. */
function declaredPathsOf(
  input: InternalLinkAuditInput,
  findings: InternalLinkAuditFinding[],
  coverage: Tally,
): readonly string[] {
  const declaredPaths: string[] = []
  for (const loc of sitemapLocations(input.sitemap.fenced)) {
    coverage.sitemap_loc_off_origin += 1
    const path = pathOnOrigin(loc, input.origin)
    if (path === null) {
      findings.push({
        rule: 'sitemap_loc_off_origin',
        path: loc,
        why:
          `the sitemap declares ${loc}, which is not a plain path on ${input.origin}. A sitemap may only ` +
          'declare URLs on the host that serves it, and a query string or a fragment is not a page.',
      })
      continue
    }
    declaredPaths.push(path)
  }
  return declaredPaths
}

/**
 * How many INDEXABLE pages link to each path.
 *
 * Indexable only, and both halves of that matter. A link from a `noindex` surface — the kitchen sink, an
 * admin page — is not an internal signal, because a crawler never sees it; counting it would excuse
 * exactly the orphan a non-indexable preview page happens to link to. A self-link is not a signal either.
 */
function inboundCounts(graph: LinkGraph): ReadonlyMap<string, number> {
  const inbound = new Map<string, number>()
  for (const node of graph.nodes) {
    if (!node.indexable) continue
    const from = normaliseLinkPath(node.path)
    for (const link of node.links) {
      const to = normaliseLinkPath(link)
      if (to === from) continue
      inbound.set(to, (inbound.get(to) ?? 0) + 1)
    }
  }
  return inbound
}

/** The rule that is really an absence. See the module header. */
function judgeTherapistRoutes(
  input: InternalLinkAuditInput,
  declared: ReadonlySet<string>,
  findings: InternalLinkAuditFinding[],
  coverage: Tally,
): readonly ExcusedTherapistRoute[] {
  const excused: ExcusedTherapistRoute[] = []
  for (const expectation of input.therapistRoutes) {
    coverage.publishable_therapist_absent_from_sitemap += 1
    const path = normaliseLinkPath(expectation.path)
    if (declared.has(path)) continue
    const refusals = therapistPublishingRefusals(expectation.candidate)
    if (refusals.length > 0) {
      excused.push({ path, staffReference: expectation.candidate.staffReference, refusals })
      continue
    }
    findings.push({
      rule: 'publishable_therapist_absent_from_sitemap',
      path,
      why:
        `${expectation.candidate.staffReference} has a display name and a recorded photography consent, ` +
        `so ${path} may be published, and the sitemap does not declare it. ADR 0020's refusals explain an ` +
        'absent therapist page; this one has none.',
    })
  }
  return excused
}

/**
 * The audit.
 *
 * The order of the rules is the order a reader wants them: what was declared and is unreachable, what was
 * declared and does not exist, what exists and was not declared, and what should exist and does not.
 */
export function auditInternalLinks(input: InternalLinkAuditInput): InternalLinkAuditReport {
  if (input.origin.endsWith('/')) {
    throw new AppError(
      'validation',
      `the audit origin ${input.origin} ends with a slash, so every path derived from a <loc> would ` +
        'carry a double one and match no crawled node. Pass the origin without it.',
      { details: { origin: input.origin } },
    )
  }
  const findings: InternalLinkAuditFinding[] = []
  const coverage: Tally = {
    orphan_in_sitemap: 0,
    sitemap_path_not_crawled: 0,
    crawled_but_absent_from_sitemap: 0,
    publishable_therapist_absent_from_sitemap: 0,
    sitemap_loc_off_origin: 0,
  }

  const declaredPaths = declaredPathsOf(input, findings, coverage)
  const declared = new Set(declaredPaths)

  const nodes = new Map<string, LinkNode>()
  for (const node of input.graph.nodes) nodes.set(normaliseLinkPath(node.path), node)

  /*
   * The home page is exempt from the orphan rule, and it is nothing's target by construction: the walk
   * starts there, so a rule that asked what links to the home page would report the one page every
   * crawler reaches first. Why inbound links are counted from indexable pages only is on `inboundCounts`.
   */
  const inbound = inboundCounts(input.graph)
  const home = normaliseLinkPath(input.graph.home)

  for (const path of declaredPaths) {
    const node = nodes.get(path)
    if (node === undefined) {
      coverage.sitemap_path_not_crawled += 1
      findings.push({
        rule: 'sitemap_path_not_crawled',
        path,
        why:
          `the sitemap declares ${path} and the crawl found no page there. Google fetches what a sitemap ` +
          'declares, so a declared path that does not answer is a crawl budget spent on a 404.',
      })
      continue
    }
    coverage.orphan_in_sitemap += 1
    if (path === home) continue
    /*
     * Zero inbound links, and NOT "unreachable from home". Reachability was the first draft's second
     * condition and it is a different rule that already exists: `judgeLinkGraph`'s `route_beyond_click_depth`
     * and its own `orphan_route`. Worse, `||`-ing the two made the second condition unreachable — a page
     * with no inbound link is never reached by the walk — so it was a clause that could not change an
     * answer, which is the vacuous half of an assertion the brief's rule 3 is about.
     */
    if ((inbound.get(path) ?? 0) === 0) {
      findings.push({
        rule: 'orphan_in_sitemap',
        path,
        why:
          `${path} is declared in the sitemap and no indexable page links to it. A crawler reaches it and ` +
          'finds no internal signal of its importance, which is how a page that exists never ranks.',
      })
    }
  }

  for (const node of input.graph.nodes) {
    if (!node.indexable) continue
    // Treatment and therapist routes only, which is the acceptance criterion's own scope. `other` covers
    // the home page, `/spa` and `/faq`, whose presence in a sitemap is a route-registry decision rather
    // than this audit's — and reporting on them would bury the two kinds that matter in a list of ten.
    if (node.kind !== 'treatment' && node.kind !== 'therapist') continue
    const path = normaliseLinkPath(node.path)
    coverage.crawled_but_absent_from_sitemap += 1
    if (declared.has(path)) continue
    findings.push({
      rule: 'crawled_but_absent_from_sitemap',
      path,
      why:
        `the crawl found the indexable ${node.kind} page ${path} and the sitemap does not declare it. A ` +
        'page Google has to discover by following a link is a page it discovers late and re-crawls rarely.',
    })
  }

  const excusedTherapistRoutes = judgeTherapistRoutes(input, declared, findings, coverage)

  return { findings, coverage, declaredPaths, excusedTherapistRoutes }
}

/** The findings as lines, for a report and for a failing test's message. */
export function formatInternalLinkAuditFindings(
  findings: readonly InternalLinkAuditFinding[],
): string {
  return findings.map((finding) => `${finding.rule}  ${finding.path}  ${finding.why}`).join('\n')
}
