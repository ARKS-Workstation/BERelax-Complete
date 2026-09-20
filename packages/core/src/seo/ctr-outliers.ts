import { AppError } from '@berelax/shared'
import {
  aggregateQueryPages,
  compareQueryPage,
  ctrBasisPoints,
  type QueryPageTotals,
  type SeoQueryRow,
} from './query-rows.ts'

/**
 * CTR outliers at positions 5 to 20: the title and meta rewrite candidates.
 *
 * ## What the analysis claims, and why the window is 5 to 20
 *
 * docs/03 §9 puts this first in value order after the warehouse itself, and the reasoning is specific: a
 * (page, query) pair ranking between 5 and 20 has **already earned the impression**. Google is showing it
 * to people who searched for that thing. If it earns far fewer clicks than its neighbours at the same
 * position do, the ranking is not the problem — the title and the meta description are, and a rewrite is
 * a cheap change with a measurable outcome. Above position 5 the snippet is competing with a featured
 * result and a map pack; below 20 nobody is looking, so a better title changes nothing.
 *
 * The window is inclusive at both ends, and that is asserted at all four edges (4.9, 5.0, 20.0, 20.1)
 * because an off-by-one at an inclusive boundary is the defect this criterion exists to catch: `>` where
 * `>=` was meant silently drops every pair sitting exactly on the edge, and position 5.00 and 20.00 are
 * where the rounding of a stored centi-position lands most often.
 *
 * ## The baseline is the site's own data, leave-one-out
 *
 * "Far fewer clicks than it should get" needs a number to compare against, and there are two ways to get
 * one. The first is an industry CTR-by-position curve. This system does not have one, and writing a
 * plausible curve into the source would be inventing a measurement — the brief's rule 15, and worse here
 * than usual, because every finding in the weekly report would inherit invented figures the owner would
 * read as measured. So the second: **compare a pair against the other pairs of this property at the same
 * position.** Nothing is invented, and the comparison is more honest anyway, since it is made against the
 * same brand, the same SERP furniture and the same country mix.
 *
 * Two details make that comparison mean what it says:
 *
 *   1. **The band is the whole position.** Position 5 and position 19 have genuinely different click
 *      rates, so one baseline across the window would flag everything deep in it and nothing near the
 *      top. `floor(centi / 100)` groups 5.00–5.99 together, which is the finest grain the stored
 *      precision supports.
 *   2. **The baseline excludes the pair being judged.** Impression-weighted is the only correct way to
 *      combine CTRs, and a pair holding most of its band's impressions would otherwise drag the baseline
 *      onto its own CTR and could never be flagged however badly it performed — the classic
 *      self-inclusion defect, and it hides exactly the biggest opportunity on the site. So the baseline
 *      is `(bandClicks - clicks) / (bandImpressions - impressions)`: the peers, and only the peers.
 *
 * `minPeerGroups` is the other half of that: with one peer, each of the two pairs is compared against the
 * other and the pair with the lower CTR is always "an outlier", which is a coin toss dressed as a
 * finding. Two peers is the smallest number for which the baseline is a distribution rather than a rival.
 *
 * ## Everything is an argument
 *
 * No clock, no I/O, no configuration read from anywhere: the rows and the thresholds arrive as arguments,
 * which is what lets a hand-computed expectation be checked against this code to the basis point. There
 * is deliberately no default config object — a threshold that arrives by default is a threshold nobody
 * chose, and the caller stating its own is what makes the weekly report's figures explicable.
 */

/**
 * The position window docs/03 §9 specifies, in the units 0042 stores.
 *
 * Exported as a named constant because the two numbers are the specification and not a preference: a
 * caller passing its own window is backfilling or experimenting, and a caller passing this one is doing
 * what the document says. 500 is position 5.00 and 2000 is position 20.00, both inclusive.
 */
export const CTR_OUTLIER_POSITION_WINDOW = {
  minPositionCenti: 500,
  maxPositionCenti: 2000,
} as const

export interface CtrOutlierConfig {
  /** Inclusive. 500 is position 5.00. */
  readonly minPositionCenti: number
  /** Inclusive. 2000 is position 20.00. */
  readonly maxPositionCenti: number
  /**
   * Below this, a pair is excluded from the analysis **and from its band's baseline**.
   *
   * Both halves matter. A pair with 9 impressions and 1 click has a CTR of 1,111 bp, which is noise
   * rather than performance; as a finding it wastes a rewrite, and as a peer it moves the baseline every
   * other pair in the band is judged against.
   */
  readonly minImpressions: number
  /** How far below its peers a pair must sit, in basis points, before it is a finding. */
  readonly minShortfallBp: number
  /** How many other pairs a band needs before it has a baseline at all. Two is the floor. */
  readonly minPeerGroups: number
}

export interface CtrOutlier {
  readonly query: string
  readonly page: string
  readonly clicks: number
  readonly impressions: number
  readonly avgPositionCenti: number
  /** The whole position the pair sits at: `floor(avgPositionCenti / 100)`, so 5 through 20. */
  readonly positionBand: number
  /** This pair's CTR in basis points. */
  readonly ctrBp: number
  /** The band's CTR excluding this pair, impression-weighted, in basis points. */
  readonly peerCtrBp: number
  /** `peerCtrBp - ctrBp`. Always at least `minShortfallBp`. */
  readonly shortfallBp: number
  /** How many other pairs the baseline was computed over. */
  readonly peerGroups: number
}

function assertConfig(config: CtrOutlierConfig): void {
  const problems: string[] = []
  for (const [name, value] of [
    ['minPositionCenti', config.minPositionCenti],
    ['maxPositionCenti', config.maxPositionCenti],
    ['minImpressions', config.minImpressions],
    ['minShortfallBp', config.minShortfallBp],
    ['minPeerGroups', config.minPeerGroups],
  ] as const) {
    if (!Number.isInteger(value)) problems.push(`${name} must be a whole number`)
  }
  if (problems.length === 0) {
    // 100 is position 1.00: the first result, and the lowest position that exists. A window opening
    // below it would be a window opening above the first result.
    if (config.minPositionCenti < 100) problems.push('minPositionCenti is below position 1.00')
    if (config.maxPositionCenti < config.minPositionCenti) {
      problems.push('maxPositionCenti is below minPositionCenti')
    }
    if (config.minImpressions < 0) problems.push('minImpressions cannot be negative')
    // Zero would make a pair exactly level with its peers a "shortfall", and every band's lower half
    // would become a finding — a report of half the site, which is a report of nothing.
    if (config.minShortfallBp < 1) problems.push('minShortfallBp must be at least 1 basis point')
    if (config.minPeerGroups < 1) problems.push('minPeerGroups must be at least 1')
  }
  if (problems.length > 0) {
    throw new AppError(
      'validation',
      `The CTR-outlier configuration is unusable: ${problems.join('; ')}.`,
      {
        details: { reason: 'seo_ctr_outlier_config_invalid', problems },
      },
    )
  }
}

/** The whole position a stored centi-position sits at. 500 and 599 are both band 5. */
export function positionBandOf(avgPositionCenti: number): number {
  return Math.floor(avgPositionCenti / 100)
}

/**
 * The (page, query) pairs whose snippet is underperforming its neighbours, worst shortfall first.
 *
 * ## The declared ordering
 *
 * `shortfallBp` descending, then `impressions` descending, then (query, page) ascending. The first two
 * are the report's own priority — the biggest gap on the most-seen pair is the first rewrite worth doing
 * — and the third exists solely to make the order **total**: after aggregation (query, page) is unique,
 * so no two findings can compare equal, and the order therefore cannot depend on the order the rows
 * arrived in or on the sort's internals. That is what "byte-identical across three runs" needs.
 */
export function ctrOutliers(
  rows: readonly SeoQueryRow[],
  config: CtrOutlierConfig,
): readonly CtrOutlier[] {
  // Bucketed by band once, and every pair then judged against the bucket it is in. Holding the members
  // rather than running totals is what lets the leave-one-out baseline be a subtraction: the band's totals
  // are computed once and each pair takes itself out of them.
  const bands = new Map<number, QueryPageTotals[]>()
  for (const pair of ctrOutlierCandidates(rows, config)) {
    const band = positionBandOf(pair.avgPositionCenti)
    const members = bands.get(band) ?? []
    members.push(pair)
    bands.set(band, members)
  }

  const findings: CtrOutlier[] = []
  // The map's iteration order is irrelevant: every finding is sorted by the declared total comparator
  // below, which is the only order anything downstream sees.
  for (const [band, members] of bands) {
    const peerGroups = members.length - 1
    // With one peer, each of the two pairs is judged against the other and the lower one is always "an
    // outlier". The whole band is skipped rather than half of it reported.
    if (peerGroups < config.minPeerGroups) continue
    const bandClicks = members.reduce((total, pair) => total + pair.clicks, 0)
    const bandImpressions = members.reduce((total, pair) => total + pair.impressions, 0)
    for (const pair of members) {
      const peerImpressions = bandImpressions - pair.impressions
      // A band whose every other pair is impressionless has no baseline to offer. Not reachable while
      // `minImpressions` is positive, and not an error when it is zero.
      if (peerImpressions <= 0) continue
      const peerCtrBp = ctrBasisPoints(bandClicks - pair.clicks, peerImpressions)
      const shortfallBp = peerCtrBp - pair.ctrBp
      if (shortfallBp < config.minShortfallBp) continue
      findings.push({
        query: pair.query,
        page: pair.page,
        clicks: pair.clicks,
        impressions: pair.impressions,
        avgPositionCenti: pair.avgPositionCenti,
        positionBand: band,
        ctrBp: pair.ctrBp,
        peerCtrBp,
        shortfallBp,
        peerGroups,
      })
    }
  }

  return findings.sort(compareCtrOutlier)
}

/** The declared ordering, exported so a test can assert the comparator rather than infer it. */
export function compareCtrOutlier(a: CtrOutlier, b: CtrOutlier): number {
  if (a.shortfallBp !== b.shortfallBp) return b.shortfallBp - a.shortfallBp
  if (a.impressions !== b.impressions) return b.impressions - a.impressions
  return compareQueryPage(a, b)
}

/**
 * The eligible pairs, exposed so a test can assert what the window and the impression floor admitted.
 *
 * Without it, "the row at position 4.9 produced no finding" and "the row at position 4.9 was admitted and
 * then failed some other condition" are the same empty array — and only the first is the criterion.
 */
export function ctrOutlierCandidates(
  rows: readonly SeoQueryRow[],
  config: CtrOutlierConfig,
): readonly QueryPageTotals[] {
  assertConfig(config)
  return aggregateQueryPages(rows).filter(
    (pair) =>
      pair.impressions >= config.minImpressions &&
      pair.avgPositionCenti >= config.minPositionCenti &&
      pair.avgPositionCenti <= config.maxPositionCenti,
  )
}
