import { AppError } from '@berelax/shared'

/**
 * The warehouse row as the three query-side analyses read it, and the two derivations they all share.
 *
 * ## Why this shape rather than `GscDailyRow`
 *
 * `packages/db` owns `GscDailyRow` and `packages/core` may not import it — the dependency runs the other
 * way (ADR 0001, `db-must-not-import-core`). So the analyses declare the fields they read, and nothing
 * more: page, query, the two counts and the stored position. A `GscDailyRow` is structurally assignable
 * to it, which is asserted by a type-level test rather than left to a reader to notice, so the caller
 * hands warehouse rows straight in with no mapping layer to fall out of step.
 *
 * ## Two facts inherited from G-SEO-01, and both shape every line below
 *
 * **`avgPositionCenti` is an integer: the average position times 100.** Migration 0042 has no float
 * column anywhere, for the reason ADR 0007 gives about money and which applies to any figure a report
 * renders — a float read back differs in the last digit between two runs, and the weekly report has to
 * diff cleanly. So the specified window of positions 5.0 to 20.0 is 500 to 2000 in stored units, and
 * every threshold in this directory is in centi-positions.
 *
 * **CTR is deliberately not stored.** It is `clicks / impressions` and a stored copy is a second source
 * of truth that can disagree with the two columns it came from — the same argument 0042's header makes
 * for the rare-query gap being GENERATED. So CTR is computed here, in basis points, once.
 *
 * ## Why basis points and not a ratio
 *
 * A float CTR is not stable to serialise: `0.0571428571428571` and `0.05714285714285714` are the same
 * measurement and different bytes. The weekly report diffs, so every rate crossing the boundary of these
 * functions is an integer number of basis points — 571 bp is 5.71%. Rounding is `Math.round`, which is
 * half-up and total, and that choice is asserted by a worked example containing an exact `.5` case
 * (1 click in 800 impressions is 12.5 bp) so a future switch to truncation fails a test rather than
 * moving every figure in the report down by a basis point.
 */

/**
 * One warehouse row, as the analyses read it.
 *
 * Structurally the subset of `GscDailyRow` these analyses need. `date`, `device`, `country` and
 * `siteUrl` are absent on purpose: an analysis that could read the date would be tempted to weight
 * recent days, which is a judgement and belongs to G-SEO-05, and one that could read `siteUrl` would be
 * tempted to analyse two properties at once — two properties are two datasets (docs/10 §2), so the
 * caller selects one property's window and hands over its rows.
 */
export interface SeoQueryRow {
  /** The page Search Console attributed the impression to, as it returns it: an absolute URL. */
  readonly page: string
  readonly query: string
  readonly clicks: number
  readonly impressions: number
  /** Average position times 100, as 0042 stores it. 500 is position 5.00. */
  readonly avgPositionCenti: number
}

/** One (query, page) pair, summed over every row of the window. */
export interface QueryPageTotals {
  readonly query: string
  readonly page: string
  readonly clicks: number
  readonly impressions: number
  /** Impression-weighted mean of the rows' positions, in centi-positions. */
  readonly avgPositionCenti: number
  /** `clicks / impressions` in basis points. Derived, never stored. */
  readonly ctrBp: number
  /** How many warehouse rows were summed into this pair. Evidence, so a total can be traced. */
  readonly rows: number
}

/** Basis points in a whole rate. 10,000 bp is 100%. */
export const BASIS_POINTS = 10_000

/**
 * Click-through rate in basis points.
 *
 * Zero impressions returns zero rather than throwing: the warehouse permits an impressionless row
 * (0042 constrains the counts to be non-negative, not positive), `clicks <= impressions` makes such a
 * row's clicks zero too, and a division here would put `NaN` into a report.
 */
export function ctrBasisPoints(clicks: number, impressions: number): number {
  if (impressions === 0) return 0
  return Math.round((clicks / impressions) * BASIS_POINTS)
}

/**
 * Compares two (query, page) pairs by the pair itself.
 *
 * The **total** tie-break every ordering in this directory ends with. `query` and `page` together are
 * unique after aggregation, so appending this to any comparator makes the whole order total — which is
 * what "three runs yield byte-identical findings" actually requires. A comparator that leaves two
 * findings equal leaves their order to the sort's internals and to the order the rows arrived in.
 *
 * Codepoint comparison, deliberately NOT `localeCompare`: the latter reads ICU collation data, so the
 * same two Arabic queries can order differently between two Node builds, and a report built in CI would
 * then diff against one built on a laptop with no row having changed.
 */
export function compareQueryPage(
  a: { readonly query: string; readonly page: string },
  b: { readonly query: string; readonly page: string },
): number {
  if (a.query !== b.query) return a.query < b.query ? -1 : 1
  if (a.page !== b.page) return a.page < b.page ? -1 : 1
  return 0
}

/** Codepoint comparison of two queries, for the orderings keyed on the query alone. */
export function compareQuery(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Rejects a row the warehouse could not have produced.
 *
 * The three CHECK constraints of `seo_gsc_daily`, re-asserted at the entrance to the pure half, because
 * these functions are also called over rows a fixture built rather than over rows the database returned.
 * Each of the three corrupts a different output silently:
 *
 *   - `clicks > impressions` produces a CTR above 100%, which reads as the best-performing query on the
 *     site and would sit at the top of the weekly report;
 *   - a fractional count or position defeats the integer discipline the whole directory rests on — one
 *     float in and every figure downstream is a float again;
 *   - `avgPositionCenti < 100` is position zero, which does not exist and would read as ranking ABOVE
 *     the first result, the exact mistake docs/10 §7 names for CrUX.
 */
function assertRow(row: SeoQueryRow, index: number): void {
  const problems: string[] = []
  if (!Number.isInteger(row.clicks) || row.clicks < 0) problems.push('clicks')
  if (!Number.isInteger(row.impressions) || row.impressions < 0) problems.push('impressions')
  if (!Number.isInteger(row.avgPositionCenti) || row.avgPositionCenti < 100) {
    problems.push('avgPositionCenti')
  }
  if (problems.length === 0 && row.clicks > row.impressions)
    problems.push('clicks_exceed_impressions')
  if (problems.length > 0) {
    throw new AppError(
      'validation',
      `Search Console row ${index} is not a shape seo_gsc_daily could hold (${problems.join(', ')}). ` +
        'Counts are whole and non-negative, clicks never exceed impressions, and the position is ' +
        'stored times 100 with no position zero — see migration 0042.',
      {
        details: {
          reason: 'seo_query_row_invalid',
          problems,
          index,
          query: row.query,
          page: row.page,
        },
      },
    )
  }
}

/**
 * Sums the window's rows into one row per (query, page), in a declared order.
 *
 * Every analysis here starts with this, because the warehouse's grain is finer than any of them: a row
 * is one (date, page, query, device, country) tuple, so a single query on a single page over a seven-day
 * window is up to twenty-one rows across three device classes. An analysis reading the raw grain would
 * report the same page three times for one query and would compare a mobile CTR against a desktop one.
 *
 * **The position is impression-weighted**, which is the only correct way to combine two average
 * positions: Search Console's own average position for a group is the mean over impressions, so the
 * unweighted mean of a 10,000-impression day and a 3-impression day would move the figure by more than
 * the three impressions deserve. The one case with no weight to apply — every row impressionless — falls
 * back to the unweighted mean, because the alternative is dividing by zero and reporting `NaN`.
 *
 * The result is sorted by (query, page) rather than left in the order a `Map` happened to iterate.
 * Insertion order is the order the rows arrived in, and rows arrive from a SQL query with no `order by`
 * as often as not — which is the determinism defect this whole unit is asserted against.
 */
export function aggregateQueryPages(rows: readonly SeoQueryRow[]): readonly QueryPageTotals[] {
  // A single key string rather than a nested map: `\u0000` cannot occur in a URL or in a Search Console
  // query, so it cannot collide two different pairs into one — which a separator like `|` could.
  const groups = new Map<
    string,
    {
      query: string
      page: string
      clicks: number
      impressions: number
      positionCentiWeighted: number
      positionCentiSum: number
      rows: number
    }
  >()
  rows.forEach((row, index) => {
    assertRow(row, index)
    const key = `${row.query}\u0000${row.page}`
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        query: row.query,
        page: row.page,
        clicks: row.clicks,
        impressions: row.impressions,
        positionCentiWeighted: row.avgPositionCenti * row.impressions,
        positionCentiSum: row.avgPositionCenti,
        rows: 1,
      })
      return
    }
    existing.clicks += row.clicks
    existing.impressions += row.impressions
    existing.positionCentiWeighted += row.avgPositionCenti * row.impressions
    existing.positionCentiSum += row.avgPositionCenti
    existing.rows += 1
  })

  const totals: QueryPageTotals[] = []
  for (const group of groups.values()) {
    const avgPositionCenti =
      group.impressions === 0
        ? Math.round(group.positionCentiSum / group.rows)
        : Math.round(group.positionCentiWeighted / group.impressions)
    totals.push({
      query: group.query,
      page: group.page,
      clicks: group.clicks,
      impressions: group.impressions,
      avgPositionCenti,
      ctrBp: ctrBasisPoints(group.clicks, group.impressions),
      rows: group.rows,
    })
  }
  return totals.sort(compareQueryPage)
}
