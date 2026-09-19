// Subpath import, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type {
  SearchAnalyticsDimension,
  SearchAnalyticsRow,
  SearchConsoleProvider,
} from '@berelax/providers/google'
import { AppError } from '@berelax/shared'

/**
 * Search Analytics — the paging contract, and the two requests whose difference is the rare-query gap.
 *
 * ## Why paging is an adapter and not three lines at the call site
 *
 * docs/10 §7: the API returns **25,000 rows per request with `startRow` paging**. There is no page token,
 * no total count, and no error when a client fails to page — it simply receives the first 25,000 rows and
 * they look like the whole report. A site with any long tail has more than that in a week, so the
 * difference between a correct client and a broken one is invisible in the response and invisible in the
 * warehouse: the numbers are simply smaller than the truth, and nothing says so.
 *
 * So the loop lives here, once, with its evidence returned rather than logged: `pages`, the cursor each
 * call used, and how many rows each returned. The nightly pass persists that evidence onto the snapshot
 * row, which is what makes "one page, exactly 25,000 rows" — the fingerprint of a silently truncated
 * fetch — a thing a person can see.
 *
 * ## Why two dimension sets rather than one
 *
 * They answer different questions and the difference between the answers is a fact worth storing.
 *
 *   - `QUERY_DIMENSIONS` is the breakdown the analyses read, and Google has removed every query too rare
 *     to be anonymous from it.
 *   - `PAGE_DIMENSIONS` is the same window with no query dimension, where those clicks are still counted.
 *
 * Summed query clicks are therefore **always less** than summed page clicks (docs/10 §7), and the
 * difference is the rare-query gap: a stored fact, not an error, and not something to reconcile.
 *
 * ## What is in here and what is not
 *
 * I/O only, plus the refusals that must happen before a row is trusted. No clock: the window arrives as
 * an argument, resolved by `gscRequestWindow` in `@berelax/core`, and the lag assertion belongs to the
 * caller that holds the instant. No persistence: rows come back as values. And no `withGoogle` — the
 * chokepoint wraps the *call site*, because everything here runs inside a `withGoogle` body where the
 * access token already exists (G-CONN-05's note: the I/O runs inside the chokepoint, the judgement about
 * what came back runs outside it).
 */

/** `details.reason` on each refusal. */
export const GSC_ROW_DIMENSION_MISSING = 'gsc_row_dimension_missing'
export const GSC_PAGE_OVERSIZED = 'gsc_page_oversized'
export const GSC_PAGING_DID_NOT_TERMINATE = 'gsc_paging_did_not_terminate'
export const GSC_ROW_COUNTS_IMPLAUSIBLE = 'gsc_row_counts_implausible'

/**
 * The page size, which is also the API's maximum rows per request.
 *
 * Stated here rather than imported from the fake, because it is a fact about Google and the fake is a
 * stand-in: production code that read its constants from a fake would be a production path that changes
 * when a test fixture does. `search-analytics.test.ts` asserts the two agree, so they cannot drift.
 */
export const GSC_PAGE_SIZE = 25_000

/**
 * The most pages one window may take: 400, or ten million rows.
 *
 * A termination guard, not a limit anybody should reach. The loop's stopping condition is a short page,
 * and a transport that always returned a full page — a fake with a bad slice, a proxy replaying one
 * response — would otherwise spin for ever inside a cron with no output. Ten million rows is far beyond
 * anything this business can produce, so hitting it is a defect and is reported as one.
 */
export const GSC_MAX_PAGES = 400

/**
 * The breakdown the warehouse stores, and the five dimensions of its unique key.
 *
 * `date` first because it is the one that makes the rows a history rather than a snapshot: without it a
 * multi-day window collapses onto one row per query and the warehouse cannot answer "what happened on
 * Tuesday". It is Google's calendar date in UTC and not a trading date — migration 0042's header holds
 * the argument for why this is the one date in the system that is not resolved on `business_day`.
 */
export const QUERY_DIMENSIONS: readonly SearchAnalyticsDimension[] = [
  'date',
  'query',
  'page',
  'device',
  'country',
]

/**
 * The page-level totals the gap is measured against.
 *
 * `page` alone, deliberately: the figure needed is the window total per page, and adding `date` would
 * multiply the number of rows by the window length for a sum that comes out the same. The snapshot row is
 * per window, so this is the grouping that matches it.
 */
export const PAGE_DIMENSIONS: readonly SearchAnalyticsDimension[] = ['page']

/** Device values the API is known to return. An unknown one is reported, never dropped or rewritten. */
export const KNOWN_DEVICES: readonly string[] = ['DESKTOP', 'MOBILE', 'TABLET']

export interface GscWindowArgs {
  readonly siteUrl: string
  readonly startDate: string
  readonly endDate: string
}

export interface GscPageRecord {
  readonly startRow: number
  readonly received: number
}

export interface GscFetchResult {
  readonly rows: readonly SearchAnalyticsRow[]
  /** One record per call, in call order. The paging evidence, returned rather than logged. */
  readonly pages: readonly GscPageRecord[]
  readonly lastStartRow: number
  /**
   * Device strings the API returned that this system does not recognise.
   *
   * Collected rather than refused. A new device class is Google's to add, and refusing the row would
   * discard data that cannot be re-fetched once the 16-month window has passed — so the row is stored as
   * it arrived and the unfamiliar value is reported to the caller, which logs it. That is the opposite
   * decision from a missing dimension below, and for the opposite reason: an unknown value is still an
   * answer, whereas a missing dimension is a row that cannot be keyed.
   */
  readonly unknownDevices: readonly string[]
}

/**
 * Refuses a row that is missing a dimension the request asked for.
 *
 * This is the refusal that protects the warehouse's key. Every dimension in `QUERY_DIMENSIONS` is part of
 * `seo_gsc_daily_dimensions_unique`, so a row arriving without its `device` would be stored under a blank
 * one — and every such row for the same query and day would then collapse onto a single warehouse key,
 * with the last one written winning. The count would look plausible, the clicks would be a fraction of
 * the truth, and nothing would have failed. A response missing a dimension it was asked for is a change
 * in the API, and the right response to a change in the API is to stop.
 */
export function assertRowCarriesDimensions(
  row: SearchAnalyticsRow,
  dimensions: readonly SearchAnalyticsDimension[],
): void {
  const missing = dimensions.filter((dimension) => {
    if (dimension === 'date') return row.date === undefined || row.date === ''
    if (dimension === 'device') return row.device === undefined
    if (dimension === 'country') return row.country === undefined || row.country === ''
    // `query` and `page` are required by the row type, so the only failure they can have is emptiness —
    // and an empty page is not a page. An empty QUERY is different: Search Console does not return one,
    // so it is treated as missing too rather than stored as a query nobody searched for.
    if (dimension === 'query') return row.query === ''
    return row.page === ''
  })
  if (missing.length > 0) {
    throw new AppError(
      'provider_unavailable',
      `A Search Console row arrived without ${missing.join(', ')}, which the request asked to group ` +
        'by. Every one of those dimensions is part of the warehouse key, so storing the row would ' +
        'merge it with every other row missing the same dimension and keep whichever was written last.',
      { details: { reason: GSC_ROW_DIMENSION_MISSING, missing, page: row.page } },
    )
  }
}

/**
 * Refuses counts that cannot both be true.
 *
 * `clicks <= impressions` is the same rule `seo_gsc_daily_clicks_cannot_exceed_impressions` enforces, and
 * it is stated twice on purpose: the database refusal protects the table from any writer, and this one
 * names the API response as the source so the failure is attributed where it happened rather than surfacing
 * as a constraint violation thirty thousand rows into a batch.
 */
export function assertRowCountsArePlausible(row: SearchAnalyticsRow): void {
  const problems: string[] = []
  if (row.clicks < 0 || row.impressions < 0) problems.push('a negative count')
  if (row.clicks > row.impressions) problems.push('more clicks than impressions')
  if (row.position < 1) problems.push('a position below 1')
  if (problems.length > 0) {
    throw new AppError(
      'provider_unavailable',
      `A Search Console row reported ${problems.join(' and ')}. Google reports clicks as a subset of ` +
        'impressions and positions from 1, so this row was mis-parsed rather than merely surprising.',
      {
        details: {
          reason: GSC_ROW_COUNTS_IMPLAUSIBLE,
          problems,
          clicks: row.clicks,
          impressions: row.impressions,
          position: row.position,
        },
      },
    )
  }
}

/**
 * Fetches every page of one window, advancing `startRow` by exactly the page size.
 *
 * `startRow` is **zero-based**, and that is the mistake this loop is written to make impossible rather than
 * the one it is most likely to survive. An off-by-one page — starting the cursor at `pageSize` because the
 * parameter reads like a page number, or because another API in the same codebase is 1-based — silently
 * discards the first 25,000 rows of every window: the busiest queries on the site, which are the ones the
 * report is about. Nothing errors, the row count is merely smaller, and the warehouse looks like a quiet
 * month. The cursor is therefore derived from the page index rather than accumulated, so there is no
 * running total to be one page out, and `search-analytics.test.ts` asserts the exact sequence from the call
 * log rather than from the rows — which are identical either way.
 *
 * Stops on a short page, because that is the only end-of-report signal the API gives: there is no page
 * token and no total count. An empty first page is the same signal, and is what a newly verified property
 * returns.
 */
export async function fetchSearchAnalyticsRows(
  transport: Pick<SearchConsoleProvider, 'queryAnalytics'>,
  args: GscWindowArgs & {
    readonly dimensions: readonly SearchAnalyticsDimension[]
    readonly pageSize?: number
  },
): Promise<GscFetchResult> {
  const pageSize = args.pageSize ?? GSC_PAGE_SIZE
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > GSC_PAGE_SIZE) {
    throw new AppError(
      'validation',
      `A Search Analytics page is 1 to ${GSC_PAGE_SIZE} rows; ${pageSize} was requested. The API ` +
        'refuses a larger page rather than returning one.',
    )
  }
  const rows: SearchAnalyticsRow[] = []
  const pages: GscPageRecord[] = []
  const unknownDevices = new Set<string>()
  let lastStartRow = 0

  for (let page = 0; page < GSC_MAX_PAGES; page += 1) {
    const startRow = page * pageSize
    lastStartRow = startRow
    const received = await transport.queryAnalytics({
      siteUrl: args.siteUrl,
      startDate: args.startDate,
      endDate: args.endDate,
      rowLimit: pageSize,
      startRow,
      dimensions: args.dimensions,
    })
    if (received.length > pageSize) {
      // The API cannot return more rows than were asked for. More means the slice this system believes it
      // is taking is not the slice it is getting, and every cursor after this one is wrong.
      throw new AppError(
        'provider_unavailable',
        `A Search Analytics page returned ${received.length} rows for a limit of ${pageSize}. The ` +
          'cursor cannot be advanced safely past a page whose size is not the one requested.',
        {
          details: {
            reason: GSC_PAGE_OVERSIZED,
            requested: pageSize,
            received: received.length,
            startRow,
          },
        },
      )
    }
    for (const row of received) {
      assertRowCarriesDimensions(row, args.dimensions)
      assertRowCountsArePlausible(row)
      if (row.device !== undefined && !KNOWN_DEVICES.includes(row.device)) {
        unknownDevices.add(row.device)
      }
      rows.push(row)
    }
    pages.push({ startRow, received: received.length })
    // A short page is the end of the report. It is also the end when a page is exactly empty, which is
    // what the first call returns for a property with no data at all — an ordinary state for a newly
    // verified property and not an error (docs/10 §2 on `siteUnverifiedUser` is the related trap).
    if (received.length < pageSize) {
      return { rows, pages, lastStartRow, unknownDevices: [...unknownDevices] }
    }
  }

  throw new AppError(
    'provider_unavailable',
    `Search Analytics returned a full page ${GSC_MAX_PAGES} times for ${args.startDate}..` +
      `${args.endDate}, which is ${GSC_MAX_PAGES * pageSize} rows and beyond anything this property ` +
      'can produce. The paging loop stopped rather than continuing indefinitely inside a cron.',
    {
      details: {
        reason: GSC_PAGING_DID_NOT_TERMINATE,
        pages: GSC_MAX_PAGES,
        pageSize,
        lastStartRow,
      },
    },
  )
}

export interface GscTotals {
  readonly clicks: number
  readonly impressions: number
}

/** Sums a row set. Separate and exported so the two totals are computed by the same code. */
export function totalsOf(rows: readonly SearchAnalyticsRow[]): GscTotals {
  return {
    clicks: rows.reduce((total, row) => total + row.clicks, 0),
    impressions: rows.reduce((total, row) => total + row.impressions, 0),
  }
}
