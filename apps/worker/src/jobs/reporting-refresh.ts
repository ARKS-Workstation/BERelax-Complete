import type { Sql } from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * The nightly reporting refresh (R-REP-01).
 *
 * `reporting.refresh_all()` does the work — every materialised view, in the registry's declared order,
 * each with `REFRESH MATERIALIZED VIEW CONCURRENTLY`, each writing a `reporting.refresh_run` row. This
 * module is the pass that calls it once a night and says out loud what it found.
 *
 * ## Why so little is in TypeScript
 *
 * Everything that could be wrong about a refresh is a database fact: the registry agreeing with the
 * catalogue (ZY181), a unique index existing so the concurrent form is legal (ZY182), a fact's key
 * resolving in `business_day` (ZY185). Each is checked inside the function, against the same snapshot the
 * refresh runs in. A handler that re-checked any of them here would be asking a second connection about a
 * state that had already moved.
 *
 * So this file owns exactly three things: the connection, the log line, and the refusal to report success
 * over a pass that returned nothing.
 *
 * ## The log line reports every view, including the ones that came back empty
 *
 * `fact_appointment`, `fact_sale` and `fact_shift` are empty on a seeded database and will be empty on the
 * real one until the salon trades. A pass that logged only what changed would be indistinguishable from a
 * pass that had stopped — which is `analytics.run_retention`'s argument for reporting its exemptions out
 * loud, and the reason `agent_heartbeat` exists at all (docs/10 section 6).
 *
 * ## What it is NOT
 *
 * It is not a freshness monitor. "This view is older than 26 hours, so its tiles are stale" is R-REP-07's
 * rule, and it reads `reporting.refresh_run` — which is why this pass writes a row per view per night
 * whether or not anything moved, and why that table is append-only.
 */

export const REPORTING_REFRESH_JOB = 'reporting.refresh'

/** The `agent_definition` row migration 0110 inserts. Spelled here once and read by the registry. */
export const REPORTING_REFRESH_AGENT = 'reporting_refresh'

/** Which pass a refresh was: the two values `reporting.refresh_run.refresh_trigger` accepts. */
export const REFRESH_TRIGGERS = ['nightly', 'on_demand'] as const
export type RefreshTrigger = (typeof REFRESH_TRIGGERS)[number]

/** One row of `reporting.refresh_all` — one view, refreshed. */
export interface ViewRefresh {
  readonly viewName: string
  readonly rowCount: number
  readonly checksum: string
  readonly ranConcurrently: boolean
  readonly durationMs: number
}

/**
 * Refreshes every registered reporting view and returns what the database reported.
 *
 * The duration comes from the row's own `started_at` and `finished_at` — the instants the function
 * recorded inside the transaction that did the work — rather than from a clock read here. A handler
 * bracketing the call with `Date.now()` would be measuring its own round trip as well, and the figure a
 * freshness rule cares about is the database's.
 */
export async function refreshReportingViews(
  sql: Sql,
  trigger: RefreshTrigger = 'nightly',
): Promise<readonly ViewRefresh[]> {
  const rows = await sql<ViewRefresh[]>`
    select view_name                                                     as "viewName",
           row_count                                                     as "rowCount",
           checksum,
           ran_concurrently                                              as "ranConcurrently",
           (extract(epoch from (finished_at - started_at)) * 1000)::integer as "durationMs"
      from reporting.refresh_all(${trigger})
  `
  if (rows.length === 0) {
    // `reporting.refresh_all` returns one row per registry row, and the registry is seeded by 0110 with
    // seven. Zero rows therefore means the registry is EMPTY, which `assert_views_are_refreshable` cannot
    // refuse — an empty registry agrees with an empty catalogue in both directions, and would agree with a
    // schema whose seven views had been dropped. Reporting success here is the ADR 0002 failure exactly.
    throw new AppError(
      'invariant_violated',
      'reporting.refresh_all() refreshed no views at all. reporting.materialised_view is empty, so ' +
        'nothing was refreshed and nothing refused it: an empty registry agrees with an empty catalogue. ' +
        'Migration 0110 seeds seven rows.',
    )
  }
  return Object.freeze([...rows])
}

/** One line per pass: how many views, how many rows, and which of them came back empty. */
export function describeRefresh(runs: readonly ViewRefresh[]): string {
  const rows = runs.reduce((total, run) => total + run.rowCount, 0)
  const blocking = runs.filter((run) => !run.ranConcurrently).map((run) => run.viewName)
  const empty = runs.filter((run) => run.rowCount === 0).map((run) => run.viewName)
  const slowest = [...runs].sort((a, b) => b.durationMs - a.durationMs)[0]
  return (
    `${runs.length} view(s) refreshed, ${rows} row(s) in total; ` +
    `empty: ${empty.length === 0 ? '(none)' : empty.join(', ')}; ` +
    `slowest: ${slowest === undefined ? '(none)' : `${slowest.viewName} ${slowest.durationMs}ms`}` +
    // Named rather than counted, because a blocking refresh is a thing to go and fix and a count is not.
    (blocking.length > 0 ? `; NOT concurrent: ${blocking.join(', ')}` : '')
  )
}

/**
 * The connection the handler uses.
 *
 * Set by `run.ts` before `startWorkers`, for `setAnalyticsMaintenanceSql`'s reason: a handler that
 * attached first would take a job off the queue and fail on a missing dependency, burning a retry on
 * nothing. A module that opened its own connection would refresh views in a database nobody meant.
 */
let configured: Sql | undefined

export function setReportingRefreshSql(sql: Sql): void {
  configured = sql
}

async function reportingRefreshHandler(_data: never, context: JobContext): Promise<void> {
  if (configured === undefined) {
    throw new AppError(
      'invariant_violated',
      `${REPORTING_REFRESH_JOB} ran before setReportingRefreshSql() supplied a connection. run.ts ` +
        'calls it before startWorkers().',
    )
  }
  const runs = await refreshReportingViews(configured, 'nightly')
  console.log(`${REPORTING_REFRESH_JOB} ${context.now()}: ${describeRefresh(runs)}`)
}

/**
 * The nightly pass's definition.
 *
 * 03:55 Asia/Dubai. After trading closes at 02:00 — a refresh during trading would be rebuilding
 * yesterday's figures over a day that is still happening — and after the three passes that write rows a
 * fact reads: the compliance calendar at 02:30, `audit.ensure-partitions` at 03:00 and
 * `analytics.ensure-partitions` at 03:20. Before 04:15's reverse-charge report, which a person reads.
 *
 * Deliberately off the quarter hour: `agent.watchdog` and the scheduled-step sweep both run every fifteen
 * minutes, and there is nothing to gain from sharing a minute with them.
 *
 * Its declared interval in 0110 is 24 hours, which is what makes the watchdog's "no success within twice
 * the interval" alert mean something for it — and R-REP-07's 26-hour staleness rule is the same claim one
 * layer up, read from `reporting.refresh_run` instead of from a heartbeat.
 */
export const REPORTING_REFRESH_JOB_DEFINITION: JobDefinition<never> = {
  name: REPORTING_REFRESH_JOB,
  purpose:
    'Refreshes every materialised view in the reporting schema, concurrently and in the registry order, ' +
    'once a night after trading closes, and records a reporting.refresh_run row per view (R-REP-01, ' +
    'docs/02 section 4). Nothing here states a fact of its own, so a pass that stops running is stale ' +
    'numbers with nothing saying so — which is exactly what R-REP-07 reads refresh_run to decide.',
  cron: '55 3 * * *',
  agent: REPORTING_REFRESH_AGENT,
  retryLimit: 3,
  retryDelaySeconds: 120,
  retryBackoff: true,
  // Seven concurrent refreshes over the whole commercial estate. Ten minutes is generous at this size; a
  // pass still going after that is blocked on another refresh of the same view rather than slow, and
  // reclaiming it is safe — a refresh is idempotent by construction, which is this unit's own acceptance.
  expireInSeconds: 600,
  handler: reportingRefreshHandler,
}
