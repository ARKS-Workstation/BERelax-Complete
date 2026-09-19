import {
  GSC_SNAPSHOT_WINDOW_DAYS,
  type GscWindow,
  gscRequestWindow,
  type Instant,
  instantToIso,
  windowRespectsGscLag,
} from '@berelax/core'
import type { GscDailyRow } from '@berelax/db'
// Subpath import, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type { SearchAnalyticsRow, SearchConsoleProvider } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import {
  fetchSearchAnalyticsRows,
  GSC_PAGE_SIZE,
  type GscPageRecord,
  type GscTotals,
  PAGE_DIMENSIONS,
  QUERY_DIMENSIONS,
  totalsOf,
} from '../adapters/search-analytics.ts'
import { parseGscResourceRef } from '../capability-resolver.ts'
import type { DegradedMode } from '../consumers.ts'
import type { DegradationCause, WithGoogleDeps } from '../with-google.ts'
import { withGoogle } from '../with-google.ts'

/**
 * The nightly Search Console collection: everything that talks to Google, and nothing that persists.
 *
 * ## What this function is for
 *
 * It answers one question — *what did Search Console say about this property for this window* — and
 * returns the answer as a value. The caller (the worker's `gsc-nightly-snapshot` job) writes it, wraps it
 * in an agent run and logs it. The split is what lets the paging and the rare-query gap be tested against
 * a fake with no database, and the persistence be tested against a database with no Google.
 *
 * ## Where each refusal lives, and why that is not arbitrary
 *
 * G-CONN-05 recorded a defect worth not repeating: a refusal of *ours* thrown inside a `withGoogle` body
 * comes back classified through the Google taxonomy, so *"this account is not verified on that property"*
 * was reported as `TransientUpstream` and wrote a failure row onto the owner's connection dashboard for
 * something Google had not done. So:
 *
 *   - **The window and the lag are checked outside the body.** They are our judgement about what to ask
 *     for, made before anything is asked, and a bad window is a bug in this system.
 *   - **The row-shape refusals are inside it**, deliberately. A response missing a dimension it was asked
 *     to group by, or reporting more clicks than impressions, is a statement about what Google returned —
 *     so being classified as an upstream failure, retried with backoff, and recorded against the
 *     connection is the correct outcome rather than a misattribution.
 *
 * ## Why only one property per pass
 *
 * `withGoogle` resolves the connection from the *capability*, which is the whole reason it exists: the
 * account verified on the Search Console property is frequently not the one that owns the Business Profile
 * listing (docs/10 §2), and a consumer that picked a connection itself would be the place that guess lives.
 * One pass therefore collects the primary `gsc` resource. A second property is a second primary row and a
 * decision for whoever adds one, not something to be inferred here.
 */

export const GSC_WINDOW_BREACHES_LAG = 'gsc_window_breaches_lag'

export interface GscSnapshotDeps {
  readonly google: WithGoogleDeps
  readonly searchConsole: Pick<SearchConsoleProvider, 'queryAnalytics'>
}

export interface GscCollected {
  readonly kind: 'collected'
  readonly siteUrl: string
  readonly window: GscWindow
  readonly rows: readonly GscDailyRow[]
  readonly queryTotals: GscTotals
  readonly pageTotals: GscTotals
  readonly pages: readonly GscPageRecord[]
  readonly lastStartRow: number
  readonly rowLimit: number
  /** Device strings this system does not recognise, for the caller to log. Never a reason to refuse. */
  readonly unknownDevices: readonly string[]
  readonly correlationId: string
  readonly connectionId: string
}

export interface GscDegraded {
  readonly kind: 'degraded'
  readonly mode: DegradedMode
  readonly cause: DegradationCause
  readonly correlationId: string
  readonly connectionId: string | null
}

export type GscCollection = GscCollected | GscDegraded

/** Average position as integer hundredths. Half-up, so 6.785 stores as 679 rather than 678. */
export function positionCenti(position: number): number {
  return Math.round(position * 100)
}

/**
 * Converts one Search Console row into one warehouse row.
 *
 * Every dimension is read from the row and none is defaulted. A default here would be the exact failure
 * `assertRowCarriesDimensions` exists to prevent, one layer further on: a `?? 'DESKTOP'` would turn a
 * missing device into a plausible one, and the row would then collide with the genuine desktop row for the
 * same query and day. The adapter has already refused the case, so this throws only if the two ever
 * disagree — which is why it throws rather than defaulting.
 */
export function toWarehouseRow(siteUrl: string, row: SearchAnalyticsRow): GscDailyRow {
  if (row.date === undefined || row.device === undefined || row.country === undefined) {
    throw new AppError(
      'invariant_violated',
      'A Search Console row reached the warehouse converter without its date, device or country. The ' +
        'adapter refuses such a row; reaching here means the two have come apart.',
      { details: { reason: 'gsc_row_dimension_missing_at_conversion', page: row.page } },
    )
  }
  return {
    siteUrl,
    date: row.date,
    page: row.page,
    query: row.query,
    device: row.device,
    country: row.country,
    clicks: row.clicks,
    impressions: row.impressions,
    avgPositionCenti: positionCenti(row.position),
  }
}

/**
 * Refuses a window that reaches into the 2–3 day lag.
 *
 * Outside the `withGoogle` body, and before the token is even obtained: asking for today is a bug in the
 * caller, and a warehouse that stored today would record a traffic collapse every night and a recovery
 * every morning. The predicate itself is `windowRespectsGscLag` in `@berelax/core`, so the same rule
 * governs a window computed here and one assembled by hand for a backfill.
 */
export function assertWindowRespectsLag(window: GscWindow, at: Instant): void {
  if (windowRespectsGscLag(window, at)) return
  throw new AppError(
    'validation',
    `The window ${window.startDate}..${window.endDate} reaches into the Search Console lag at ` +
      `${instantToIso(at)}. The last two to three days are incomplete and keep changing, so a window ` +
      'that includes them stores a collapse in traffic that never happened.',
    {
      details: {
        reason: GSC_WINDOW_BREACHES_LAG,
        startDate: window.startDate,
        endDate: window.endDate,
      },
    },
  )
}

export interface CollectOptions {
  readonly windowDays?: number
  /** Only a test lowers this, to reach the paging loop without 25,000 rows. */
  readonly pageSize?: number
}

/**
 * Collects one window, or reports the consumer's declared degraded mode.
 *
 * Degradation is not an error and is not thrown: before the owner has chosen a property there is nothing
 * to read, and docs/10 §6 is explicit that the fallback is the launch mode rather than an error state. The
 * caller records the degradation and completes, which is what keeps a cron from failing every night for
 * the weeks before onboarding finishes — and the SEO agent's declared mode is `disabled`, because Search
 * Console data has no manual substitute.
 */
export async function collectGscSnapshot(
  deps: GscSnapshotDeps,
  at: Instant,
  options: CollectOptions = {},
): Promise<GscCollection> {
  const window = gscRequestWindow(at, options.windowDays ?? GSC_SNAPSHOT_WINDOW_DAYS)
  assertWindowRespectsLag(window, at)
  const pageSize = options.pageSize ?? GSC_PAGE_SIZE

  const outcome = await withGoogle(deps.google, 'gsc', async (context) => {
    const { siteUrl } = parseGscResourceRef(context.resourceRef)

    // The query breakdown, paged. This is the call the 25,000-row page size applies to and the one whose
    // cursor has to be right: everything the analyses read comes from here.
    const queryPages = await fetchSearchAnalyticsRows(deps.searchConsole, {
      siteUrl,
      startDate: window.startDate,
      endDate: window.endDate,
      dimensions: QUERY_DIMENSIONS,
      pageSize,
    })

    // The same window with no query dimension. Google withholds a query too rare to be anonymous from the
    // breakdown above while still counting its clicks here, so this is the only way to measure what was
    // withheld — and it is why the snapshot stores two totals rather than one (docs/10 §7).
    const pageRows = await fetchSearchAnalyticsRows(deps.searchConsole, {
      siteUrl,
      startDate: window.startDate,
      endDate: window.endDate,
      dimensions: PAGE_DIMENSIONS,
      pageSize,
    })

    return {
      siteUrl,
      rows: queryPages.rows.map((row) => toWarehouseRow(siteUrl, row)),
      queryTotals: totalsOf(queryPages.rows),
      pageTotals: totalsOf(pageRows.rows),
      pages: queryPages.pages,
      lastStartRow: queryPages.lastStartRow,
      unknownDevices: queryPages.unknownDevices,
    }
  })

  if (outcome.kind === 'degraded') {
    return {
      kind: 'degraded',
      mode: outcome.mode,
      cause: outcome.cause,
      correlationId: outcome.correlationId,
      connectionId: outcome.connectionId,
    }
  }
  return {
    kind: 'collected',
    window,
    rowLimit: pageSize,
    correlationId: outcome.correlationId,
    connectionId: outcome.connectionId,
    ...outcome.value,
  }
}
