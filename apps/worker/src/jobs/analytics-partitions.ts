import type { Sql } from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * The two scheduled passes that make the `analytics` schema's storage discipline real (A-FIRST-01).
 *
 * Both jobs live in one module because they are two halves of one obligation and share one connection:
 * partitions have to exist BEFORE a row can land, and partitions past the window have to go. A schema whose
 * partitions are created by hand is a schema that stops accepting rows on the first of some month, and a
 * 90-day retention that nothing runs is a sentence in a document (docs/03, "Volume discipline").
 *
 * ## What each pass is, and what the database does when it stops
 *
 * `analytics.ensure-partitions` calls `analytics.ensure_partitions()`, which creates the monthly partition
 * of every partitioned table in the schema for this month and three months after it, idempotently. If this
 * job stops running, the first insert past the last partition routes to a guarded DEFAULT partition whose
 * BEFORE INSERT trigger raises `ZY061` naming the month and this function — not `23514 no partition of
 * relation "event" found for row`, which names neither. 0096's header records why the refusal needed a
 * default partition to fire on: a row is ROUTED before any row-level trigger runs, so a guard on the parent
 * is unreachable code on exactly the day it is needed.
 *
 * `analytics.retention` calls `analytics.run_retention(as_of)`, which detaches and drops every raw
 * partition whose upper bound is at or before `as_of` minus `analytics.raw_retention_days()`, purges the
 * unpartitioned raw rows past the same cutoff in declared order, and REPORTS the three rollups as exempt.
 * If this job stops running, nothing breaks and nothing says so — which is the whole reason both handlers
 * log their counts even when every count is zero, and why both crons name an `agent_definition` whose
 * 24-hour declared interval makes the watchdog's "no success within twice the interval" alert mean
 * something for them.
 *
 * ## Why the two cannot race each other, or the rollup job
 *
 * Retention only ever removes a partition whose newest possible row is 90 days old, and
 * `analytics.ensure_partitions` only ever creates months at or after the one it is called for — so the two
 * never touch the same partition, whatever order they run in. The same argument covers A-FIRST-09's nightly
 * rollup, which reads the business day that has just closed: three months separate what it reads from what
 * this pass removes. That is deliberate rather than lucky, and it is why the ordering of the nightly ladder
 * is a contention question here rather than a correctness one.
 *
 * ## The clock is an argument
 *
 * `runAnalyticsRetention` takes the instant, because every assertion about which partition falls due is
 * made under a frozen clock in `packages/db/src/analytics.itest.ts`. The handler is the only thing that
 * reads a real one, and it reads it once — from the job context, which is what makes the suite able to ask
 * the one question a job reading `new Date()` cannot be asked.
 */

export const ANALYTICS_PARTITIONS_JOB = 'analytics.ensure-partitions'
export const ANALYTICS_RETENTION_JOB = 'analytics.retention'

/** The `agent_definition` rows migration 0096 inserts. Spelled here once and read by the registry. */
export const ANALYTICS_PARTITIONS_AGENT = 'analytics_partitions'
export const ANALYTICS_RETENTION_AGENT = 'analytics_retention'

/** One row of `analytics.run_retention`'s report, which is its whole output. */
export interface RetentionAction {
  readonly relation: string
  readonly action: string
  readonly detail: string
}

/**
 * The actions `analytics.run_retention` can report, as a closed set.
 *
 * Not decoration: the handler's log line counts by action, and a typo in an action name would count zero of
 * something and read as a quiet night. `analytics.itest.ts` asserts this set equals what the function
 * actually returns across a fixture that exercises every branch, so a new action added in SQL alone is a
 * red test rather than a figure that silently stops being logged.
 */
export const RETENTION_ACTIONS = [
  'dropped_partition',
  'kept_partition',
  'guarded_default_partition',
  'purged_rows',
  'exempt',
] as const
export type RetentionActionName = (typeof RETENTION_ACTIONS)[number]

/**
 * Creates this month's partitions and the next `ahead` months', returning how many were created.
 *
 * The count is the return value and NOT the evidence: a second run in the same month returns 0 whether it
 * created nothing because everything existed or because it did nothing at all, so the suite asserts the
 * partitions against `pg_catalog`. What the count is for is the log line, where 0 on the second night of a
 * month is the healthy answer and 1 on the first of a month is the pass doing its job.
 */
export async function ensureAnalyticsPartitions(sql: Sql, monthsAhead = 3): Promise<number> {
  const [row] = await sql<{ created: number }[]>`
    select analytics.ensure_partitions(
      (date_trunc('month', now()))::date, ${monthsAhead}::integer
    ) as created
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'analytics.ensure_partitions() returned no row, which a function returning integer cannot do. ' +
        'Read this as the statement not having run rather than as nothing needing to be created.',
    )
  }
  return row.created
}

/**
 * Runs the retention pass as of `nowIso` and returns everything it reports.
 *
 * Every row is returned, including `kept_partition` and `exempt`. A pass that returned only what it removed
 * would be indistinguishable from a pass that had stopped, and the three exempt rollups are the claim
 * A-FIRST-01's fourth acceptance line is about — so the pass says out loud that it looked at them.
 */
export async function runAnalyticsRetention(
  sql: Sql,
  nowIso: string,
): Promise<readonly RetentionAction[]> {
  const rows = await sql<RetentionAction[]>`
    select relation, action, detail from analytics.run_retention(${nowIso}::timestamptz)
  `
  return Object.freeze([...rows])
}

/** How many of each action a report holds, with a 0 for every action it does not. */
export function countByAction(
  report: readonly RetentionAction[],
): Readonly<Record<RetentionActionName, number>> {
  const counts = Object.fromEntries(RETENTION_ACTIONS.map((action) => [action, 0])) as Record<
    RetentionActionName,
    number
  >
  for (const row of report) {
    // An action the SQL reports and this module does not know about is a defect in one of the two, and
    // silently dropping it is how a figure stops being logged. `analytics.itest.ts` holds the two equal.
    if ((RETENTION_ACTIONS as readonly string[]).includes(row.action)) {
      counts[row.action as RetentionActionName] += 1
    }
  }
  return Object.freeze(counts)
}

/**
 * The connection both handlers use.
 *
 * Set by `run.ts` before `startWorkers`, for `setRetentionPurgeSql`'s reason: a handler that attached first
 * would take a job off the queue and fail on a missing dependency, burning a retry on nothing. A module
 * that opened its own connection would bypass whatever the process was configured with and do DDL against
 * a database nobody meant.
 */
let configured: Sql | undefined

export function setAnalyticsMaintenanceSql(sql: Sql): void {
  configured = sql
}

function runtime(job: string): Sql {
  if (configured === undefined) {
    throw new AppError(
      'invariant_violated',
      `${job} ran before setAnalyticsMaintenanceSql() supplied a connection. run.ts calls it before ` +
        'startWorkers().',
    )
  }
  return configured
}

async function ensurePartitionsHandler(_data: never, context: JobContext): Promise<void> {
  const created = await ensureAnalyticsPartitions(runtime(ANALYTICS_PARTITIONS_JOB))
  // Logged even when it is 0, which is the normal night: a pass that logged only when it created
  // something would be indistinguishable from a pass that had stopped running, which is docs/10 §6's
  // failure and the reason `agent_heartbeat` exists.
  console.log(
    `${ANALYTICS_PARTITIONS_JOB} ${context.now()}: ${created} partition(s) created across the ` +
      'partitioned analytics tables',
  )
}

async function retentionHandler(_data: never, context: JobContext): Promise<void> {
  const report = await runAnalyticsRetention(runtime(ANALYTICS_RETENTION_JOB), context.now())
  const counts = countByAction(report)
  console.log(
    `${ANALYTICS_RETENTION_JOB} ${context.now()}: ${counts.dropped_partition} partition(s) dropped, ` +
      `${counts.kept_partition} within the window, ${counts.purged_rows} raw table(s) purged, ` +
      `${counts.exempt} rollup(s) exempt, ` +
      `${counts.guarded_default_partition} guarded default partition(s)`,
  )
}

/**
 * The partition pass's definition.
 *
 * 03:20 Asia/Dubai. After trading closes at 02:00 and just after `audit.ensure-partitions` at 03:00, which
 * is the same obligation for `audit_event` — the two are the quietest point in the day and each takes brief
 * DDL locks on one table. Deliberately off the quarter hour: `agent.watchdog` and the scheduled-step sweep
 * both run every fifteen minutes, and there is nothing to gain from sharing a minute with them.
 *
 * Daily rather than monthly, and the look-ahead is what makes that the cheap option: the pass creates this
 * month and three after it, so 30 of every 31 runs create nothing and the one that matters has already
 * happened weeks before the month it is for. A monthly cron would put the whole schema's ability to accept
 * rows on one firing.
 */
export const ANALYTICS_PARTITIONS_JOB_DEFINITION: JobDefinition<never> = {
  name: ANALYTICS_PARTITIONS_JOB,
  purpose:
    'Keeps the monthly partitions of analytics.event and analytics.funnel_step three months ahead of the ' +
    'clock (A-FIRST-01, docs/03). The parents have no partition a row can fall back into: a month nobody ' +
    'created routes to a guarded default partition that raises ZY061 naming this pass, so a partition ' +
    'creation that stops running is a refused insert rather than a row nobody prunes.',
  cron: '20 3 * * *',
  agent: ANALYTICS_PARTITIONS_AGENT,
  retryLimit: 3,
  retryDelaySeconds: 60,
  retryBackoff: true,
  // DDL against two tables, four months each, and almost every run creates nothing. A minute is generous;
  // a run still going after that is blocked on a lock, and reclaiming it is the right answer — the pass is
  // idempotent, so a reclaimed one cannot create a partition twice.
  expireInSeconds: 60,
  handler: ensurePartitionsHandler,
}

/**
 * The retention pass's definition.
 *
 * 05:50 Asia/Dubai, after every other nightly pass — `retention-purge` at 05:15 and `package.expiry-sweep`
 * and `seo.url-inspection` at 05:30 — because this one takes an ACCESS EXCLUSIVE lock on a partitioned
 * parent for each partition it detaches, and the nightly work should not contend for it. It is not a
 * correctness ordering: what this pass removes is 90 days older than anything the rollups read, so it
 * cannot race them whatever time either runs.
 *
 * Its declared interval in 0096 is 24 hours, which is what makes the watchdog's "no success within twice
 * the interval" alert mean something for it.
 */
export const ANALYTICS_RETENTION_JOB_DEFINITION: JobDefinition<never> = {
  name: ANALYTICS_RETENTION_JOB,
  purpose:
    'The 90-day raw analytics retention (A-FIRST-01, docs/03): detaches and drops every raw partition past ' +
    'the window, purges the unpartitioned raw rows past the same cutoff, and leaves the three daily ' +
    'rollups alone because they are on an explicit exemption list it REPORTS rather than passes over. ' +
    'Refuses the whole pass on an analytics table with no retention policy (ZY062), a policy for a ' +
    'relation that is not there (ZY063), or a partition bound it cannot read (ZY064) — because a pass ' +
    'that skipped any of the three would report success having removed nothing.',
  cron: '50 5 * * *',
  agent: ANALYTICS_RETENTION_AGENT,
  retryLimit: 3,
  retryDelaySeconds: 120,
  retryBackoff: true,
  // One catalogue walk per partitioned parent plus one DROP per due partition and one DELETE per purged
  // table. Five minutes is generous, and a reclaimed pass is safe: dropping a partition that is already
  // gone is not attempted, because the pass re-reads pg_inherits.
  expireInSeconds: 300,
  handler: retentionHandler,
}
