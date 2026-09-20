import { AppError } from '@berelax/shared'
import {
  aggregateQueryPages,
  compareQuery,
  ctrBasisPoints,
  type SeoQueryRow,
} from './query-rows.ts'

/**
 * Cannibalisation: two of our own URLs competing for one query.
 *
 * ## What it is, and the thing it is constantly confused with
 *
 * Cannibalisation is **two pages of ours ranking for the same query at similar positions**. It costs
 * something real: the link equity, the engagement signals and the clicks for that query are split across
 * two documents, and Google swaps between them, so neither accumulates the history that would lift either
 * one. The fix is a consolidation — merge, or canonicalise one to the other, or differentiate the intent.
 *
 * The confusion worth stating plainly, because the discriminating fixtures in this unit's tests exist for
 * it: **one page ranking for many query variants is not cannibalisation.** It is a page working. A
 * treatment page ranking for "thai massage", "thai massage near me" and "best thai massage" is exactly
 * what W-SITE-05 built it to do, and docs/09 §1 records the deliberate decision underneath — the 32
 * priced durations are rows on eight pages and not 32 routes, precisely so they do not compete with each
 * other for one query. An analysis that reported that shape as a defect would advise deleting the
 * structure the site is designed around, so the discrimination is asserted in both directions.
 *
 * ## Why "within the position gap" and not simply "two pages"
 *
 * Almost every query in the warehouse has more than one page against it: the homepage picks up a share of
 * nearly everything, and a treatments index appears behind its own children. Reporting all of those as
 * cannibalisation would report most of the site. Two pages are only competing when they are at
 * **comparable** positions — position 6 and position 7 swap week to week, position 6 and position 84 do
 * not, and the second is the ordinary shape of a site with a hub and a spoke.
 *
 * So the competing set is the pages within `maxPositionGapCenti` of the best position for that query, and
 * the finding needs at least two of them. That makes the analysis one finding **per query**, never one
 * per pair: three pages inside the window are one consolidation decision, and three findings would be the
 * same decision three times in a report of five prioritised actions.
 *
 * No clock, no I/O: the rows and the gap arrive as arguments.
 */

export interface CannibalisationConfig {
  /**
   * Below this many impressions over the window, a page is not competing for the query.
   *
   * A page with two impressions against a query is not splitting anything; it is a page Google tried
   * once. Without the floor, a busy query on a large site produces a finding naming a dozen pages, eleven
   * of which have no measurable share of it.
   */
  readonly minImpressions: number
  /**
   * How close to the best position a page must be to count as competing, in centi-positions.
   *
   * 300 is three positions. It is the caller's policy and has no default: a wider gap finds more
   * consolidations and more hub-and-spoke pairs that are working as designed, and the weekly report
   * should be able to say which was chosen.
   */
  readonly maxPositionGapCenti: number
}

export interface CompetingPage {
  readonly page: string
  readonly clicks: number
  readonly impressions: number
  readonly avgPositionCenti: number
  readonly ctrBp: number
}

export interface Cannibalisation {
  readonly query: string
  /** The competing pages, best position first. At least two, by construction. */
  readonly pages: readonly CompetingPage[]
  readonly bestPositionCenti: number
  /** The deepest position inside the competing set, not on the query as a whole. */
  readonly worstPositionCenti: number
  /** `worstPositionCenti - bestPositionCenti`. At most `maxPositionGapCenti`. */
  readonly positionGapCenti: number
  /** Clicks and impressions summed over the competing pages — the split being reported. */
  readonly clicks: number
  readonly impressions: number
}

function assertConfig(config: CannibalisationConfig): void {
  const problems: string[] = []
  if (!Number.isInteger(config.minImpressions) || config.minImpressions < 0) {
    problems.push('minImpressions must be a whole, non-negative number')
  }
  if (!Number.isInteger(config.maxPositionGapCenti) || config.maxPositionGapCenti < 0) {
    problems.push('maxPositionGapCenti must be a whole, non-negative number')
  }
  if (problems.length > 0) {
    throw new AppError(
      'validation',
      `The cannibalisation configuration is unusable: ${problems.join('; ')}.`,
      { details: { reason: 'seo_cannibalisation_config_invalid', problems } },
    )
  }
}

/**
 * The queries two or more of our own pages are competing for, biggest split first.
 *
 * ## The declared ordering
 *
 * `impressions` descending over the competing set, then the number of competing pages descending, then
 * the query ascending by codepoint. The query is unique after aggregation, so the order is total and
 * cannot depend on the order the rows arrived in.
 */
export function cannibalisation(
  rows: readonly SeoQueryRow[],
  config: CannibalisationConfig,
): readonly Cannibalisation[] {
  assertConfig(config)
  const byQuery = new Map<string, CompetingPage[]>()
  for (const pair of aggregateQueryPages(rows)) {
    if (pair.impressions < config.minImpressions) continue
    const pages = byQuery.get(pair.query) ?? []
    pages.push({
      page: pair.page,
      clicks: pair.clicks,
      impressions: pair.impressions,
      avgPositionCenti: pair.avgPositionCenti,
      ctrBp: ctrBasisPoints(pair.clicks, pair.impressions),
    })
    byQuery.set(pair.query, pages)
  }

  const findings: Cannibalisation[] = []
  // Iterated as entries rather than by looking each key up again: the map's own order is the order the
  // rows arrived in, and nothing upstream promises one, so the findings are sorted by the declared total
  // comparator below before anything downstream sees them.
  for (const [query, pages] of byQuery) {
    const ranked = [...pages].sort(
      (a, b) =>
        a.avgPositionCenti - b.avgPositionCenti || (a.page < b.page ? -1 : a.page > b.page ? 1 : 0),
    )
    // `Math.min` over the members rather than `ranked[0]`, which the type system can only offer as
    // possibly-undefined: the guard that would satisfy it is unreachable code, and unreachable code in a
    // hot path is a line nobody can ever prove right.
    const bestPositionCenti = Math.min(...ranked.map((page) => page.avgPositionCenti))
    const competing = ranked.filter(
      (page) => page.avgPositionCenti - bestPositionCenti <= config.maxPositionGapCenti,
    )
    // One page inside the gap is a page ranking on its own, which is the ordinary case and not a finding.
    //
    // The ONLY test of how many pages are competing, deliberately. An earlier `pages.length < 2` fast path
    // sat above the filter and made this line untestable: a mutation to either guard was masked by the
    // other, so "one URL ranking for two query variants produces zero" could not be broken by changing one
    // condition — which is the same as saying neither condition was proved. One condition, one mutation.
    if (competing.length < 2) continue
    const worstPositionCenti = Math.max(...competing.map((page) => page.avgPositionCenti))
    findings.push({
      query,
      pages: competing,
      bestPositionCenti,
      worstPositionCenti,
      positionGapCenti: worstPositionCenti - bestPositionCenti,
      clicks: competing.reduce((total, page) => total + page.clicks, 0),
      impressions: competing.reduce((total, page) => total + page.impressions, 0),
    })
  }

  return findings.sort(compareCannibalisation)
}

/** The declared ordering, exported so a test can assert the comparator rather than infer it. */
export function compareCannibalisation(a: Cannibalisation, b: Cannibalisation): number {
  if (a.impressions !== b.impressions) return b.impressions - a.impressions
  if (a.pages.length !== b.pages.length) return b.pages.length - a.pages.length
  return compareQuery(a.query, b.query)
}
