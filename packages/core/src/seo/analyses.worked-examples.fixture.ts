import type { CannibalisationConfig } from './cannibalisation.ts'
import type { ContentGapConfig, SeoRoutePath } from './content-gaps.ts'
import type { CtrOutlier, CtrOutlierConfig } from './ctr-outliers.ts'
import type { SeoQueryRow } from './query-rows.ts'

/**
 * The reviewed worked example: twenty seeded Search Console rows and the CTR-outlier findings a human
 * computed from them, by hand, before the implementation was run over them once.
 *
 * ## Why the numbers are written here rather than recorded from a run
 *
 * This is the criterion that makes the unit worth anything. An expectation captured from the code under
 * test asserts that the code does what it does; it passes the day the arithmetic is wrong and goes on
 * passing. So every figure below was worked out from the row counts with a calculator, the arithmetic is
 * written out beside it so a reviewer can check it without running anything, and the implementation was
 * then run against it. If the two disagree, one of them is wrong and finding out which is the point.
 *
 * ## The two things that make the arithmetic checkable at all
 *
 * **Positions are integers times 100** (migration 0042: no float column anywhere), so the specified
 * window of 5.0 to 20.0 is 500 to 2000 and every position below is in those units.
 *
 * **CTR is derived, never stored**, and crosses every boundary as whole basis points. Two rows exist to
 * pin the rounding rather than to add a case: `b12-d` is 1 click in 800 impressions, which is exactly
 * 12.5 bp, and `b19-a`'s peer baseline is 27 clicks in 2,400 impressions, which is exactly 112.5 bp.
 * `Math.round` is half-up, so both land on 13 and 113 — a switch to truncation, or to a float CTR with
 * its own rounding, fails here rather than moving every rate in the weekly report down by a basis point.
 *
 * ## Every value here is test data and says so
 *
 * The property is `gseo03-fixture.invalid` (`.invalid` is reserved by RFC 2606 and can never resolve),
 * and every query begins `gseo03 fixture`. A Search Console row is a measurement: a plausible-looking one
 * in a fixture is indistinguishable from a real one the next reader finds in a report, which is the
 * brief's rule 15 applied to a number instead of to an address. The marker term is also harmless to the
 * content-gap matcher, which asks whether a route's slug terms all appear in the query and not the
 * reverse — so an extra term can never break a match.
 */

const SITE = 'https://gseo03-fixture.invalid'

/** One row, spelled so a reviewer reads counts rather than punctuation. */
const row = (
  id: string,
  clicks: number,
  impressions: number,
  avgPositionCenti: number,
): SeoQueryRow => ({
  page: `${SITE}/ctr/${id}`,
  query: `gseo03 fixture query ${id}`,
  clicks,
  impressions,
  avgPositionCenti,
})

/**
 * The twenty rows, one per (query, page) pair so no aggregation stands between the counts and the CTR.
 *
 * Grouped by the whole position they sit at, which is the band the leave-one-out baseline is computed
 * over. Four rows are deliberately outside the analysis, and each is placed where its wrongful inclusion
 * would change a figure asserted below rather than merely add one:
 *
 *   - `out-a` and `out-b` are at positions 20.10 and 20.50. `floor(centi / 100)` puts both in band 20
 *     alongside `b20-a`, `b20-b` and `b20-c` at exactly 20.00 — so a window that closed at `< 2100`, or
 *     an `>` where `>=` was meant, would drag band 20's baseline from 200 bp to over 1,400 bp.
 *   - `thin-a` and `thin-b` are inside the window with 100 and 150 impressions, below the 200 floor, and
 *     sit in bands 5 and 19. `thin-a` is 50 clicks in 100 impressions — a 5,000 bp CTR that is noise, and
 *     the single figure most able to wreck a baseline it was admitted to.
 */
export const WORKED_EXAMPLE_ROWS: readonly SeoQueryRow[] = [
  // Band 5 — positions 5.00 to 5.99. Clicks 157, impressions 3,400 over four pairs.
  row('b05-a', 60, 1000, 512),
  row('b05-b', 45, 900, 530),
  row('b05-c', 12, 800, 555),
  row('b05-d', 40, 700, 588),
  // Band 12 — positions 12.00 to 12.99. Clicks 30, impressions 2,200 over five pairs.
  row('b12-a', 10, 500, 1205),
  row('b12-b', 9, 400, 1230),
  row('b12-c', 7, 300, 1250),
  row('b12-d', 1, 800, 1270),
  row('b12-e', 3, 200, 1299),
  // Band 19 — positions 19.00 to 19.99. Clicks 27, impressions 3,400 over four pairs.
  row('b19-a', 0, 1000, 1905),
  row('b19-b', 9, 800, 1930),
  row('b19-c', 9, 800, 1960),
  row('b19-d', 9, 800, 1990),
  // Band 20 — exactly position 20.00, the inclusive far edge. Clicks 40, impressions 3,000 over three.
  row('b20-a', 0, 1000, 2000),
  row('b20-b', 20, 1000, 2000),
  row('b20-c', 20, 1000, 2000),
  // Outside the window, and in band 20 by floor, so their exclusion is load-bearing.
  row('out-a', 300, 1000, 2010),
  row('out-b', 250, 1000, 2050),
  // Inside the window, below the impression floor, in bands 5 and 19.
  row('thin-a', 50, 100, 540),
  row('thin-b', 0, 150, 1950),
]

/**
 * The configuration the expectations below were computed under.
 *
 * The window is the specification's (docs/03 §9, positions 5 to 20). The other three are this worked
 * example's policy, chosen to be checkable by hand: a 200-impression floor, a one-percentage-point
 * shortfall, and two peers before a band has a baseline at all.
 */
export const WORKED_EXAMPLE_CTR_CONFIG: CtrOutlierConfig = {
  minPositionCenti: 500,
  maxPositionCenti: 2000,
  minImpressions: 200,
  minShortfallBp: 100,
  minPeerGroups: 2,
}

/**
 * How many pairs the window and the impression floor admit: sixteen of the twenty.
 *
 * Asserted on its own because "the row at position 20.10 produced no finding" and "the row at position
 * 20.10 was admitted and then failed some other condition" are the same empty array, and only the first
 * is what the criterion claims.
 */
export const WORKED_EXAMPLE_CANDIDATE_COUNT = 16

/**
 * The four findings, hand-computed, in the order the declared comparator puts them.
 *
 * The arithmetic, band by band. `ctrBp = round(clicks / impressions x 10,000)`, and
 * `peerCtrBp = round((bandClicks - clicks) / (bandImpressions - impressions) x 10,000)` — the band's own
 * rate with the pair being judged taken out of it, because a pair left inside its own baseline drags the
 * baseline onto itself and can never be flagged.
 *
 * **Band 5** — clicks 157, impressions 3,400 over four pairs (`thin-a` excluded):
 *   - `b05-a`  60/1,000 = 600 bp; peers 97/2,400 = 404.17 -> 404; shortfall -196, so not a finding.
 *   - `b05-b`  45/900 = 500 bp; peers 112/2,500 = 448 exactly; shortfall -52, not a finding.
 *   - `b05-c`  12/800 = 150 bp; peers 145/2,600 = 557.69 -> 558; shortfall **408**, a finding.
 *   - `b05-d`  40/700 = 571.43 -> 571 bp; peers 117/2,700 = 433.33 -> 433; shortfall -138, not a finding.
 *
 * **Band 12** — clicks 30, impressions 2,200 over five pairs:
 *   - `b12-a`  10/500 = 200 bp; peers 20/1,700 = 117.65 -> 118; shortfall -82.
 *   - `b12-b`  9/400 = 225 bp; peers 21/1,800 = 116.67 -> 117; shortfall -108.
 *   - `b12-c`  7/300 = 233.33 -> 233 bp; peers 23/1,900 = 121.05 -> 121; shortfall -112.
 *   - `b12-d`  1/800 = **12.5 -> 13 bp**; peers 29/1,400 = 207.14 -> 207; shortfall **194**, a finding.
 *   - `b12-e`  3/200 = 150 bp; peers 27/2,000 = 135 exactly; shortfall -15.
 *
 * **Band 19** — clicks 27, impressions 3,400 over four pairs (`thin-b` excluded):
 *   - `b19-a`  0/1,000 = 0 bp; peers 27/2,400 = **112.5 -> 113**; shortfall **113**, a finding.
 *   - `b19-b`  9/800 = 12.5 x 9 = 112.5 -> 113 bp; peers 18/2,600 = 69.23 -> 69; shortfall -44.
 *   - `b19-c`, `b19-d` are `b19-b` at deeper positions in the same band: identical arithmetic, no finding.
 *
 * **Band 20** — clicks 40, impressions 3,000 over the three pairs at exactly position 20.00:
 *   - `b20-a`  0/1,000 = 0 bp; peers 40/2,000 = 200 exactly; shortfall **200**, a finding.
 *   - `b20-b`, `b20-c`  20/1,000 = 200 bp; peers 20/2,000 = 100; shortfall -100.
 *
 * Band 19 earning exactly one finding is worth reading twice: three of its four pairs sit at 113 bp, which
 * an absolute threshold would condemn as a terrible CTR. At position 19 it is the normal rate, and the
 * pair that stands out is the one at zero. That is the whole argument for a relative baseline over an
 * invented industry curve, and it is visible in these numbers.
 *
 * The order is the declared one — shortfall descending, then impressions descending, then (query, page) —
 * so it is 408, 200, 194, 113, which is neither the input order nor the band order.
 */
export const WORKED_EXAMPLE_CTR_OUTLIERS: readonly CtrOutlier[] = [
  {
    query: 'gseo03 fixture query b05-c',
    page: `${SITE}/ctr/b05-c`,
    clicks: 12,
    impressions: 800,
    avgPositionCenti: 555,
    positionBand: 5,
    ctrBp: 150,
    peerCtrBp: 558,
    shortfallBp: 408,
    peerGroups: 3,
  },
  {
    query: 'gseo03 fixture query b20-a',
    page: `${SITE}/ctr/b20-a`,
    clicks: 0,
    impressions: 1000,
    avgPositionCenti: 2000,
    positionBand: 20,
    ctrBp: 0,
    peerCtrBp: 200,
    shortfallBp: 200,
    peerGroups: 2,
  },
  {
    query: 'gseo03 fixture query b12-d',
    page: `${SITE}/ctr/b12-d`,
    clicks: 1,
    impressions: 800,
    avgPositionCenti: 1270,
    positionBand: 12,
    ctrBp: 13,
    peerCtrBp: 207,
    shortfallBp: 194,
    peerGroups: 4,
  },
  {
    query: 'gseo03 fixture query b19-a',
    page: `${SITE}/ctr/b19-a`,
    clicks: 0,
    impressions: 1000,
    avgPositionCenti: 1905,
    positionBand: 19,
    ctrBp: 0,
    peerCtrBp: 113,
    shortfallBp: 113,
    peerGroups: 3,
  },
]

/**
 * The route set, as `apps/web/src/routes/registry.ts` spells it.
 *
 * Paths and not slugs, because paths are what the registry produces: `routePaths()` for the declared
 * routes and `treatmentSitemapEntries` for the eight concrete treatment paths `/treatments/[slug]`
 * expands into. The two slugs here are real catalogue slugs (migration 0017 seeds the eight
 * style x treatment services), so nothing about the page set is invented.
 *
 * Three entries earn their place beyond the match itself:
 *
 *   - `/` — the homepage, whose subject term set is empty. It must be dedicated to nothing, or the subset
 *     test matches every query ever made.
 *   - `/treatments/[slug]` — the pattern. The registry's own `isParameterised` marks it as not a URL;
 *     here it must not be read as a page dedicated to the query "slug".
 *   - `/ar/treatments/asian-normal-massage` — the same document in the other locale. Its subject is the
 *     same slug, which is why the matcher reads the last segment and ignores the prefix.
 */
export const ROUTE_FIXTURE: readonly SeoRoutePath[] = [
  '/',
  '/treatments',
  '/treatments/[slug]',
  '/treatments/asian-normal-massage',
  '/treatments/arabic-normal-massage',
  '/ar/treatments/asian-normal-massage',
  '/pricing',
]

/**
 * The same route set with the `asian-normal-massage` page withdrawn — the toggle the criterion asks for.
 *
 * **Both locales go together**, which is why this filters on the slug rather than removing one string.
 * W-SITE-01's registry test requires every document to be served in both locales (an `hreflang` set with
 * one locale pointing at a 404 invalidates the whole set), and archiving a service removes its page from
 * the prerendered set and the sitemap in both. A fixture that withdrew only the English path would be
 * toggling something the site cannot do.
 */
export const ROUTE_FIXTURE_WITHOUT_ASIAN_NORMAL: readonly SeoRoutePath[] = ROUTE_FIXTURE.filter(
  (path) => !path.endsWith('/asian-normal-massage'),
)

/**
 * Content-gap rows: four queries, three shapes.
 *
 * `asian-normal` names a published route and is not a gap until the route is withdrawn. `hot-stone` names
 * a treatment no route covers, so it is a gap in either fixture — the control that proves the toggle moved
 * one query rather than emptying the analysis. `arabic-normal` is the second published route, so a
 * matcher that only ever checked the first entry of the list fails. `arabic-script` is the bilingual case:
 * the same intent as `asian-normal` written in Arabic, which shares no term with an ASCII slug and is
 * therefore a gap until `queryTermAliases` says otherwise.
 */
export const CONTENT_GAP_ROWS: readonly SeoQueryRow[] = [
  {
    page: `${SITE}/`,
    query: 'gseo03 fixture asian normal massage near me',
    clicks: 4,
    impressions: 900,
    avgPositionCenti: 720,
  },
  {
    page: `${SITE}/`,
    query: 'gseo03 fixture hot stone massage',
    clicks: 1,
    impressions: 600,
    avgPositionCenti: 1540,
  },
  {
    page: `${SITE}/treatments`,
    query: 'gseo03 fixture arabic normal massage',
    clicks: 2,
    impressions: 450,
    avgPositionCenti: 830,
  },
  {
    page: `${SITE}/`,
    // "massage asian normal", the same intent as the first row in Arabic. Letters only: no bidi
    // formatting characters, which `pnpm invisibles` forbids in source.
    query: 'gseo03 fixture مساج آسيوي عادي',
    clicks: 0,
    impressions: 380,
    avgPositionCenti: 1460,
  },
]

/** The one-hop alias map the bilingual case needs, as a caller would supply it. */
export const ARABIC_TERM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  مساج: ['massage'],
  آسيوي: ['asian'],
  عادي: ['normal'],
}

export const CONTENT_GAP_CONFIG: ContentGapConfig = { minImpressions: 300 }

/**
 * Cannibalisation rows: the finding, and both shapes that must not be one.
 *
 *   - `compete` — two distinct pages for one query at 8.10 and 9.05, a gap of 95 centi-positions, inside
 *     a configured 300. One finding, naming both pages.
 *   - `far-apart` — two distinct pages for one query at 6.10 and 18.00. A hub and a spoke, which is most
 *     queries on most sites, and zero findings.
 *   - `variant one` / `variant two` — one page ranking for two query variants. Zero findings: that is a
 *     page working, and docs/09 §1 records the decision that made it so.
 */
export const CANNIBALISATION_ROWS: readonly SeoQueryRow[] = [
  {
    page: `${SITE}/treatments/asian-normal-massage`,
    query: 'gseo03 fixture compete',
    clicks: 5,
    impressions: 400,
    avgPositionCenti: 810,
  },
  {
    page: `${SITE}/pricing`,
    query: 'gseo03 fixture compete',
    clicks: 3,
    impressions: 350,
    avgPositionCenti: 905,
  },
  {
    page: `${SITE}/treatments/arabic-normal-massage`,
    query: 'gseo03 fixture far-apart',
    clicks: 7,
    impressions: 500,
    avgPositionCenti: 610,
  },
  {
    page: `${SITE}/treatments`,
    query: 'gseo03 fixture far-apart',
    clicks: 0,
    impressions: 320,
    avgPositionCenti: 1800,
  },
  {
    page: `${SITE}/treatments/asian-normal-massage`,
    query: 'gseo03 fixture variant one',
    clicks: 6,
    impressions: 700,
    avgPositionCenti: 700,
  },
  {
    page: `${SITE}/treatments/asian-normal-massage`,
    query: 'gseo03 fixture variant two',
    clicks: 4,
    impressions: 640,
    avgPositionCenti: 715,
  },
]

export const CANNIBALISATION_CONFIG: CannibalisationConfig = {
  minImpressions: 300,
  maxPositionGapCenti: 300,
}

/**
 * The whole seeded warehouse: every row above, in one window, as a single property's rows would arrive.
 *
 * This is what the determinism criterion is asserted over, and it is deliberately the union rather than
 * three separate arrays — the weekly report runs all three analyses over one window, so the ordering that
 * has to be byte-identical is the ordering each one produces from the same mixed set. The Arabic query in
 * it is not decoration: codepoint ordering and `localeCompare` disagree about it, so a comparator that
 * reached for ICU collation would order the findings differently on a machine with different collation
 * data and the weekly report would diff with no row having changed.
 */
export const WAREHOUSE_ROWS: readonly SeoQueryRow[] = [
  ...WORKED_EXAMPLE_ROWS,
  ...CONTENT_GAP_ROWS,
  ...CANNIBALISATION_ROWS,
]
