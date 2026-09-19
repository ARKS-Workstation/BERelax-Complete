import {
  createRunBudget,
  GSC_SNAPSHOT_WINDOW_DAYS,
  instantFromIso,
  rareQueryGapExplanation,
} from '@berelax/core'
import {
  type GscSnapshotRow,
  recordGscSnapshot,
  registerInspectionCandidates,
  type Sql,
  upsertGscDailyRows,
  withAgentRun,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import { collectGscSnapshot, type GscCollection, type GscSnapshotDeps } from './gsc-snapshot.ts'

/**
 * The nightly Search Console snapshot, as an agent run.
 *
 * ## Why this job exists at all, when the API can be queried live
 *
 * Search Console keeps **16 months** and discards the seventeenth. Everything a year-on-year comparison
 * or a trend needs is therefore gone unless something mirrors it, and nothing can recover it afterwards —
 * so the mirror is the product, and the pass that fills it running every night is the whole feature. The
 * one failure that matters is this job quietly not running, which is why it is wrapped in `withAgentRun`:
 * the heartbeat is written whether the body succeeds or throws, and the watchdog alerts at twice the
 * declared interval (48h) however the pass stopped.
 *
 * ## Why the pass reports to `seo_gsc_snapshot` and not to `seo_agent`
 *
 * `seo_agent` declares a seven-day interval, because it is the weekly review and its five prioritised
 * actions. A nightly pass writing that heartbeat would keep it hours old for ever, and a weekly report
 * that had stopped being produced entirely would be invisible — the watchdog measures the absence of a
 * success **per agent**. Migration 0042 seeds the agent this pass owns, with the same argument 0033 made
 * for the hourly Google liveness probe.
 *
 * ## Why a degraded outcome is a SUCCESSFUL run
 *
 * Before the owner has chosen a Search Console property there is nothing to read, and `withGoogle`
 * degrades rather than throwing (docs/10 §6: the fallback is the launch mode, not an error state). If that
 * degradation failed the run, the watchdog would alert every 48 hours for the whole of onboarding, and an
 * alert that fires for an expected state is one the owner learns to ignore before the first real one
 * arrives. The onboarding state is already visible where it belongs — on the connection panel — so this
 * pass records what it saw, logs the cause, and succeeds.
 *
 * ## Why the pass is here rather than in apps/worker
 *
 * It is the pairing of three packages — `withAgentRun` from `@berelax/db`, `createRunBudget` from
 * `@berelax/core` and the collection from this one — and `packages/db` may not import `packages/core`, so
 * the pairing needs a home that may import both. This package is also the only place a test may **seal a
 * Google token**: `sealToken` is behind the chokepoint and the allow-list was not widened for this unit, so
 * a pass living in `apps/worker` could only ever be integration-tested over zero connections. Every one of
 * this unit's end-to-end criteria needs a token that opens, so the pass lives here and the worker keeps the
 * wiring: the configuration, the provider adapters, the connection and the log line.
 */

/** The `agent_definition` row this pass reports to. Seeded by migration 0042. */
export const SEO_GSC_SNAPSHOT_AGENT = 'seo_gsc_snapshot'

export interface SnapshotPassResult {
  readonly collection: GscCollection
  /** Present only when something was collected. */
  readonly snapshot?: GscSnapshotRow
  readonly rowsWritten: number
  readonly rowsInserted: number
  readonly rowsUpdated: number
  readonly candidatesRegistered: number
  /** The owner-facing sentence, rendered from the STORED withheld figure rather than from the fetch. */
  readonly rareQueryExplanation?: string
}

export interface SnapshotPassOptions {
  readonly jobId?: string
  readonly windowDays?: number
  readonly pageSize?: number
}

/**
 * Collects a window and persists it: the rows, the run's evidence, and the inspection candidates.
 *
 * The candidate registration is here rather than in the rotation job on purpose. The rotation may only
 * spend 2,000 calls a day, so it must never also be the thing that discovers what exists — a rotation that
 * enumerated its own candidates would either re-enumerate 5,000 URLs every night or drift out of date with
 * the pages that actually earn impressions. The snapshot already knows every page Search Console has
 * impressions for, which is precisely the priority order the rotation wants, so it registers them and the
 * rotation reads a list somebody else maintains.
 */
export async function runGscNightlySnapshot(
  sql: Sql,
  deps: GscSnapshotDeps,
  atIso: string,
  options: SnapshotPassOptions = {},
): Promise<SnapshotPassResult> {
  let result: SnapshotPassResult = {
    collection: {
      kind: 'degraded',
      mode: 'disabled',
      cause: 'NotConnected',
      correlationId: 'not-started',
      connectionId: null,
    },
    rowsWritten: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    candidatesRegistered: 0,
  }

  const run = await withAgentRun(
    sql,
    {
      agentKey: SEO_GSC_SNAPSHOT_AGENT,
      startedAtIso: atIso,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    },
    async () => {
      const collection = await collectGscSnapshot(deps, instantFromIso(atIso), {
        windowDays: options.windowDays ?? GSC_SNAPSHOT_WINDOW_DAYS,
        ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      })
      if (collection.kind === 'degraded') {
        result = { ...result, collection }
        return
      }

      const written = await upsertGscDailyRows(sql, collection.rows)
      const snapshot = await recordGscSnapshot(sql, {
        siteUrl: collection.siteUrl,
        windowStart: collection.window.startDate,
        windowEnd: collection.window.endDate,
        requestedAtIso: atIso,
        pagesFetched: collection.pages.length,
        rowLimit: collection.rowLimit,
        lastStartRow: collection.lastStartRow,
        rowsPersisted: written.written,
        queryClicks: collection.queryTotals.clicks,
        queryImpressions: collection.queryTotals.impressions,
        pageClicks: collection.pageTotals.clicks,
        pageImpressions: collection.pageTotals.impressions,
      })

      // Candidates, priority-ordered by the clicks each page earned in this window. The rotation then
      // inspects what matters first, and the order comes from data rather than from a hand-kept list.
      const clicksByPage = new Map<string, number>()
      for (const row of collection.rows) {
        clicksByPage.set(row.page, (clicksByPage.get(row.page) ?? 0) + row.clicks)
      }
      const candidates = [...clicksByPage.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        // `priority` is the rank, so the busiest page sorts first. Deriving it from the rank rather than
        // from the click count keeps the values dense and stable: a page whose clicks doubled does not
        // jump past nine others, it moves one place.
        .map(([page], rank) => ({ url: page, priority: rank }))
      const candidatesRegistered = await registerInspectionCandidates(sql, {
        siteUrl: collection.siteUrl,
        candidates,
      })

      result = {
        collection,
        snapshot,
        rowsWritten: written.written,
        rowsInserted: written.inserted,
        rowsUpdated: written.updated,
        candidatesRegistered,
        // Rendered from the PERSISTED row: `recordGscSnapshot` returns the two totals it wrote together
        // with the withheld figure the database GENERATED from them, so the sentence and the column cannot
        // disagree. Rendering it from `collection` would render it from the fetch instead, and the screen
        // would then be able to say one thing while the stored row said another — which is the whole
        // reason the criterion asks for a named column rather than a computed string.
        rareQueryExplanation: rareQueryGapExplanation({
          queryClicks: snapshot.queryClicks,
          pageClicks: snapshot.pageClicks,
          queryImpressions: snapshot.queryImpressions,
          pageImpressions: snapshot.pageImpressions,
        }),
      }
    },
    createRunBudget,
  )

  if (run.outcome === 'failed' || run.outcome === 'budget_exceeded') {
    // Re-thrown so pg-boss retries with backoff. The run row and the heartbeat are already written, which
    // is the point: a failed pass is visible whether or not anybody reads `pgboss.job`.
    throw new AppError(
      'provider_unavailable',
      `The Search Console nightly snapshot failed: ${run.error ?? 'no error recorded'}`,
      { details: { reason: 'seo_gsc_snapshot_failed', runId: run.runId } },
    )
  }
  return result
}
