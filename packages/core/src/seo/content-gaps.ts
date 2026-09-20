import { AppError } from '@berelax/shared'
import {
  aggregateQueryPages,
  compareQuery,
  ctrBasisPoints,
  type SeoQueryRow,
} from './query-rows.ts'
import { type RareQueryGap, type RareQueryGapInput, rareQueryGap } from './rare-query-gap.ts'

/**
 * Content gaps: queries the site is shown for and has no page dedicated to.
 *
 * ## The claim, stated narrowly
 *
 * docs/03 §9 asks for "queries with impressions but no dedicated page as content-gap briefs". The value
 * is real and the failure mode is obvious once stated: a query with demand is answered today by whichever
 * page Google thought closest — usually the homepage or the treatments index — and a page whose subject
 * is that query would rank better and convert better. docs/09 §1 makes the same argument one level up:
 * `#services` will never rank for "hot oil massage abu dhabi", because an anchor is not a document.
 *
 * ## "A dedicated page exists" is the route registry's question, not a new one
 *
 * W-SITE-05 landed the eight treatment routes and `apps/web/src/routes/registry.ts` already answers
 * "which pages does this site serve": `publishedTreatmentSlugs()` expands `/treatments/[slug]` into the
 * concrete published paths, `isParameterised` marks the pattern that is not a URL, and `sitemapEntries`
 * is the same list with a property attached. Inventing a third expression of the same set is how the
 * sitemap and the `hreflang` set drift apart, so this function takes **the route paths** as an argument
 * and the caller builds them from the registry. `packages/core` may not import `apps/web` in any case.
 *
 * The match is deliberately one rule, in one direction: **a route is dedicated to a query when every
 * term of the route's own slug appears in the query.** `/treatments/thai-massage` is dedicated to "thai
 * massage near me" and to "best thai massage", and is not dedicated to "hot stone massage" — which is
 * the answer a reader would give. The direction matters and the reverse does not work: requiring every
 * query term to appear in the slug would make every locality, qualifier and misspelling defeat the
 * match, and the analysis would report a gap for every page on the site.
 *
 * Two consequences of that rule are load-bearing rather than incidental, and both are asserted:
 *
 *   - **A route with no slug terms is dedicated to nothing.** The homepage's path is `/`, so its term set
 *     is empty and the subset test would otherwise match every query ever made. "The homepage ranks for
 *     it" is the *symptom* of a content gap, not the refutation of one.
 *   - **A parameterised path is not a page.** `/treatments/[slug]` is a pattern; `fillParams` exists in
 *     the registry because a pattern published as a URL is a page announcing its own address is a 404.
 *     Here it would claim a dedicated page for the query "slug".
 *
 * ## The rare-query gap decides what this analysis is allowed to claim
 *
 * Search Console **withholds** queries too rare to be anonymous — it does not return them at all
 * (0042's header, `rare-query-gap.ts`). So a query that is missing from these rows is not a query with no
 * demand: it may be a query Google declined to name. That cuts both ways and only one way is a defect:
 *
 *   - A withheld query cannot produce a finding, because nothing here can see it. That is a limit of the
 *     data and not something to correct — scaling the visible rows up to close the gap would put clicks
 *     on queries that did not earn them, and every finding would be an artefact of the scaling.
 *   - So the report must not be presented as the complete list. `withheld` carries the snapshot's own
 *     figures through `rareQueryGap`, and `queriesAreComplete` is true only when the two totals agree
 *     exactly. A weekly report that said "3 content gaps" while 13% of clicks were withheld would be
 *     read as "3 content gaps exist", which is a stronger claim than the data can support.
 */

/** One route path, as the registry spells it: `/treatments/thai-massage`, `/ar/pricing`, `/`. */
export type SeoRoutePath = string

export interface ContentGapConfig {
  /**
   * Below this many impressions over the window, a query is not a brief.
   *
   * A query with three impressions may be one person looking, and a content brief is a page somebody has
   * to write. The floor is the caller's policy and has no default, so the weekly report can say what it
   * was.
   */
  readonly minImpressions: number
  /**
   * The snapshot's two pairs of totals, when the caller has them, so the finding list can say how much
   * of the query report it could not see. `null` when no snapshot is to hand, and the result then says
   * the completeness is unknown rather than asserting it.
   */
  readonly withheld?: RareQueryGapInput | null
  /**
   * Query terms that also mean a route term — the bilingual case, and nothing else.
   *
   * The site serves every document in English and Arabic (W-SITE-01), and both share one ASCII slug:
   * `/ar/treatments/thai-massage`. An Arabic query therefore shares no term with any route and every
   * Arabic query would be reported as a gap, which would bury the real ones. The map turns that
   * structural defect into a visible configuration gap: it is empty until somebody authors it, the
   * report says so, and authoring it is translation rather than judgement.
   *
   * Keyed by query term, valued by the route terms it also means.
   */
  readonly queryTermAliases?: Readonly<Record<string, readonly string[]>>
}

export interface ContentGap {
  readonly query: string
  readonly clicks: number
  readonly impressions: number
  readonly ctrBp: number
  /** The best position any page reached for this query, in centi-positions. */
  readonly bestPositionCenti: number
  /**
   * The pages Search Console attributed this query to today, best position first.
   *
   * The brief's evidence: these are the pages absorbing the query, and the first of them is what a
   * searcher currently lands on.
   */
  readonly rankingPages: readonly string[]
}

export interface ContentGapReport {
  readonly findings: readonly ContentGap[]
  /** How many distinct queries cleared `minImpressions` and were therefore considered. */
  readonly queriesConsidered: number
  /** The withheld figures, when the caller supplied the snapshot totals. */
  readonly withheld: RareQueryGap | null
  /**
   * True only when the snapshot proves nothing was withheld.
   *
   * `false` when a gap was withheld, and `null` when no snapshot was supplied — three states, because
   * "we know nothing is missing" and "we do not know whether anything is missing" are different claims
   * and a boolean would collapse them into the weaker one silently.
   */
  readonly queriesAreComplete: boolean | null
}

/**
 * The terms a path's own slug is made of: its last segment, split on hyphens.
 *
 * The last segment and not the whole path, so the locale prefix and the section are irrelevant —
 * `/treatments/thai-massage` and `/ar/treatments/thai-massage` are the same subject in two languages, and
 * both are dedicated to the same query. Empty for `/` and for a parameterised pattern, which is what
 * makes neither of them dedicated to anything.
 */
export function routeSubjectTerms(path: SeoRoutePath): readonly string[] {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  const last = segments.at(-1)
  if (last === undefined) return []
  // A dynamic segment in any of Next's three spellings — `[slug]`, `[...rest]`, `[[...all]]`. The
  // registry's `isParameterised` is the same test; it lives in apps/web, which core may not import.
  if (last.includes('[')) return []
  return last
    .toLowerCase()
    .split('-')
    .filter((term) => term.length > 0)
}

/**
 * The terms a query is made of.
 *
 * Split on anything that is not a letter or a number, with the Unicode property escapes rather than
 * `[^a-z0-9]`: an Arabic query is letters, and an ASCII-only class would reduce it to nothing and make
 * every Arabic query match every route with the empty-set subset test — a silent false negative on half
 * the site's traffic, which is the opposite of the failure the homepage rule above prevents.
 */
export function queryTerms(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0)
}

/**
 * The first route dedicated to this query, or `null`.
 *
 * Routes are considered in the order given and the first match wins, so the answer does not depend on
 * how many routes match — a caller that wants the most specific match sorts its own list. Exported
 * because "this query has a page" is worth asserting directly: the toggled-route fixture then proves the
 * matcher changed its answer, rather than proving only that the finding count changed.
 */
export function dedicatedRouteFor(
  query: string,
  routePaths: readonly SeoRoutePath[],
  queryTermAliases: Readonly<Record<string, readonly string[]>> = {},
): SeoRoutePath | null {
  const spelled = queryTerms(query)
  const terms = new Set(spelled)
  // Expanded from a snapshot of the query's own terms, never from the growing set: an alias of an alias
  // would otherwise be reachable, and two aliases naming each other would make the expansion depend on
  // iteration order. One hop, so the map means what it says.
  for (const term of spelled) {
    for (const alias of queryTermAliases[term] ?? []) terms.add(alias.toLowerCase())
  }
  for (const path of routePaths) {
    const subject = routeSubjectTerms(path)
    if (subject.length === 0) continue
    if (subject.every((term) => terms.has(term))) return path
  }
  return null
}

/**
 * The queries with demand and no page, biggest first.
 *
 * ## The declared ordering
 *
 * `impressions` descending, then `clicks` descending, then the query ascending by codepoint. The query is
 * unique after aggregation, so the order is total and cannot depend on the order the rows arrived in.
 */
export function contentGaps(
  rows: readonly SeoQueryRow[],
  routePaths: readonly SeoRoutePath[],
  config: ContentGapConfig,
): ContentGapReport {
  if (!Number.isInteger(config.minImpressions) || config.minImpressions < 0) {
    throw new AppError(
      'validation',
      'The content-gap impression floor must be a whole, non-negative number, received ' +
        `${config.minImpressions}.`,
      {
        details: {
          reason: 'seo_content_gap_config_invalid',
          minImpressions: config.minImpressions,
        },
      },
    )
  }

  // One entry per query, summed over every page it appeared on. The grain of the analysis is the query:
  // a gap is a missing page, so which existing pages absorbed it is evidence rather than the subject.
  const byQuery = new Map<
    string,
    { clicks: number; impressions: number; pages: { page: string; positionCenti: number }[] }
  >()
  for (const pair of aggregateQueryPages(rows)) {
    const entry = byQuery.get(pair.query) ?? { clicks: 0, impressions: 0, pages: [] }
    entry.clicks += pair.clicks
    entry.impressions += pair.impressions
    entry.pages.push({ page: pair.page, positionCenti: pair.avgPositionCenti })
    byQuery.set(pair.query, entry)
  }

  const findings: ContentGap[] = []
  let queriesConsidered = 0
  // Iterated as entries rather than by looking each key up again: the map's own order is the order the rows
  // arrived in, and rows arrive from SQL with no `order by` as often as not — so the findings are put in
  // the declared order by the comparator below before anything downstream sees them.
  for (const [query, entry] of byQuery) {
    if (entry.impressions < config.minImpressions) continue
    queriesConsidered += 1
    if (dedicatedRouteFor(query, routePaths, config.queryTermAliases ?? {}) !== null) continue
    const pages = [...entry.pages].sort(
      (a, b) =>
        a.positionCenti - b.positionCenti || (a.page < b.page ? -1 : a.page > b.page ? 1 : 0),
    )
    findings.push({
      query,
      clicks: entry.clicks,
      impressions: entry.impressions,
      ctrBp: ctrBasisPoints(entry.clicks, entry.impressions),
      // `Math.min` over the pages rather than `pages[0]`, which the type system can only offer as
      // possibly-undefined: `entry.pages` is non-empty because a query is in this map only because a row
      // carried it, and the guard that would satisfy the type is a line no test can ever reach.
      bestPositionCenti: Math.min(...pages.map((ranking) => ranking.positionCenti)),
      rankingPages: pages.map((ranking) => ranking.page),
    })
  }

  const withheld = config.withheld == null ? null : rareQueryGap(config.withheld)
  return {
    findings: findings.sort(compareContentGap),
    queriesConsidered,
    withheld,
    queriesAreComplete:
      withheld === null
        ? null
        : withheld.withheldClicks === 0 && withheld.withheldImpressions === 0,
  }
}

/** The declared ordering, exported so a test can assert the comparator rather than infer it. */
export function compareContentGap(a: ContentGap, b: ContentGap): number {
  if (a.impressions !== b.impressions) return b.impressions - a.impressions
  if (a.clicks !== b.clicks) return b.clicks - a.clicks
  return compareQuery(a.query, b.query)
}
