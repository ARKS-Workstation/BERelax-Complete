import { AppError } from '@berelax/shared'

/**
 * The rare-query gap: why the two numbers never agree, and the sentence that says so.
 *
 * Search Console **withholds queries that are too rare to be anonymous** — it does not truncate them, it
 * removes them from the query breakdown entirely. So the clicks summed over the query report are always
 * LESS than the clicks reported for the same pages over the same window, and no amount of paging closes
 * the difference (docs/10 §7).
 *
 * This is the whole reason this module exists rather than a reconciliation: the difference is a **fact
 * about the data**, and the only two honest things to do with it are to store it and to explain it. Every
 * other treatment has been tried by somebody and each fails in a way that costs trust:
 *
 *   - **Treat it as an error.** The nightly pass then fails every night on a healthy site.
 *   - **Scale the query rows up to match.** Every query in the report then carries a click it did not
 *     earn, and the CTR outliers G-SEO-03 finds are an artefact of the scaling.
 *   - **Show only one of the two numbers.** The owner compares the report with the Search Console UI on
 *     the first day and finds a number that is missing rather than a number that is explained.
 *
 * So: the gap is a generated column in `seo_gsc_snapshot`, and the sentence below is rendered **from that
 * stored number**. It takes the figures as arguments and reads no clock and no database, which is what
 * lets one test assert the sentence carries the stored value and a second assert that a different stored
 * value produces a different sentence — without which "the string is rendered from the column" would be
 * satisfied by a hardcoded sentence.
 */

export interface RareQueryGapInput {
  /** Clicks summed over the query-level rows the breakdown returned. */
  readonly queryClicks: number
  /** Clicks over the same window with no query dimension, which still counts the withheld queries. */
  readonly pageClicks: number
  readonly queryImpressions: number
  readonly pageImpressions: number
}

export interface RareQueryGap {
  readonly withheldClicks: number
  readonly withheldImpressions: number
  /**
   * The withheld share of page-level clicks, in basis points.
   *
   * Basis points rather than a percentage float, for the reason ADR 0007 gives about money and which
   * applies to any figure a report renders: a float share differs in the last digit between two runs and
   * the weekly report has to diff cleanly. 1,300 bp is 13%.
   */
  readonly withheldShareBp: number
}

/**
 * Derives the gap. Never invents it: both figures come from the two totals.
 *
 * Refuses a query total larger than its page total, which is the same refusal
 * `seo_gsc_snapshot_query_clicks_do_not_exceed_page_clicks` makes in the database — because it cannot be
 * a Google anomaly. Google withholds rows; it does not invent them. A query total that exceeds the page
 * total means this system summed something twice or compared two different windows, and the alternative
 * to refusing is a dashboard sentence reading "-20 clicks are withheld".
 */
export function rareQueryGap(input: RareQueryGapInput): RareQueryGap {
  const problems: string[] = []
  if (input.queryClicks > input.pageClicks) problems.push('clicks')
  if (input.queryImpressions > input.pageImpressions) problems.push('impressions')
  if (problems.length > 0) {
    throw new AppError(
      'invariant_violated',
      `Query-level ${problems.join(' and ')} exceed the page-level total for the same window. Search ` +
        'Console withholds rare queries, so the query breakdown can only ever total less — the other ' +
        'direction means the same rows were summed twice or two different windows were compared.',
      {
        details: {
          reason: 'seo_rare_query_gap_inverted',
          inverted: problems,
          queryClicks: input.queryClicks,
          pageClicks: input.pageClicks,
        },
      },
    )
  }
  const withheldClicks = input.pageClicks - input.queryClicks
  return {
    withheldClicks,
    withheldImpressions: input.pageImpressions - input.queryImpressions,
    // Zero page clicks is an ordinary state for a new property, and dividing by it would render NaN into
    // the sentence below.
    withheldShareBp:
      input.pageClicks === 0 ? 0 : Math.round((withheldClicks / input.pageClicks) * 10_000),
  }
}

/** A share in basis points, as a human reads it: `13%`, or `0.4%` when rounding to a whole point lies. */
function formatShare(shareBp: number): string {
  if (shareBp === 0) return '0%'
  if (shareBp < 100) return `${(shareBp / 100).toFixed(1)}%`
  return `${Math.round(shareBp / 100)}%`
}

/**
 * The sentence the SEO surface shows beside the query report.
 *
 * Written for the owner and not for an engineer: it says what is missing, how much of it there is, and
 * that nothing is wrong — because the question this answers is *"why does this report show fewer clicks
 * than Google does"*, asked once, on the first day, by somebody deciding whether to trust the number.
 *
 * Every figure in it comes from the arguments. There is no clock, no locale lookup and no default: a
 * sentence with a number baked into it would keep reading the same after the data changed, which is the
 * failure the second test in `rare-query-gap.test.ts` exists to catch.
 */
export function rareQueryGapExplanation(input: RareQueryGapInput): string {
  const gap = rareQueryGap(input)
  if (gap.withheldClicks === 0 && gap.withheldImpressions === 0) {
    // Not the same sentence with a zero in it. "0 clicks are withheld" reads as a measurement, and this
    // is the absence of one: a window with no rare queries at all is a very small window or a very quiet
    // site, and saying so is more use than a zero.
    return (
      'Every click in this window is attributed to a query Search Console was willing to name, so the ' +
      'query totals add up to the page totals exactly. That is unusual, and normal only for a short ' +
      'window or a property with little traffic.'
    )
  }
  return (
    `Search Console withholds ${gap.withheldClicks} of these ${input.pageClicks} clicks ` +
    `(${formatShare(gap.withheldShareBp)}) and ${gap.withheldImpressions} impressions from the query ` +
    'breakdown, because those searches were too rare for Google to name without identifying who made ' +
    'them. The query rows below will therefore always add up to less than the page totals. Nothing is ' +
    'missing from the site and nothing is wrong with the data.'
  )
}
