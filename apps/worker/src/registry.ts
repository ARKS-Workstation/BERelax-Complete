/**
 * The job registry: the single place a queue or a cron exists.
 *
 * Declaring a job is not the same as it running, and the gap between the two is where scheduled work
 * quietly stops. The usual shape — `boss.schedule(...)` scattered through whatever module owns the
 * feature — means a job can be deleted, renamed or never registered and nothing says so; the symptom
 * is a report that stopped arriving three weeks ago.
 *
 * So registration is derived from this array and nothing else, and `worker.itest.ts` asserts the set of
 * queues in `pgboss.queue` and the set of names in `pgboss.schedule` equal the registry exactly — in
 * both directions. A job in the registry that was not registered fails; a queue registered that the
 * registry does not declare fails too.
 *
 * `G-AGT-01` builds the heartbeat contract on top of this: the `agent` field names the
 * `agent_definition` row a job belongs to, and its registry-completeness gate enumerates
 * `cronRegistrations()` and fails naming any cron with no such row.
 */
import { instantFromIso } from '@berelax/core'
import { DEFAULT_QUEUE_OPTIONS, MAINTENANCE_JOBS, type Sql } from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { Job, PgBoss } from 'pg-boss'
import type { JobContext, JobDefinition, JobHandler } from './job.ts'
import { runWatchdog } from './jobs/agent-watchdog.ts'
import { BUILD_DERIVATIVES_JOB } from './jobs/build-derivatives.ts'

export type { JobContext, JobDefinition, JobHandler } from './job.ts'

/** Asia/Dubai for every schedule. The business day is 11:00–02:00 local; UTC would split it. */
export const SCHEDULE_TIMEZONE = 'Asia/Dubai'

/**
 * A 5-field cron expression, field by field, rather than one unreadable alternation.
 *
 * pg-boss accepts a 6-field expression with seconds; this refuses one. A seconds field is either a
 * mistake — `0 3 * * *` read as "every minute at second 0 of hour 3" is a plausible misreading of a
 * daily job — or a job that should be a queue with a `startAfter` instead.
 */
const CRON_FIELD = [
  /^(\*|([0-5]?\d)([-/,]([0-5]?\d))*)$/, // minute
  /^(\*|([01]?\d|2[0-3])([-/,]([01]?\d|2[0-3]))*)$/, // hour
  /^(\*|([12]?\d|3[01])([-/,]([12]?\d|3[01]))*)$/, // day of month
  /^(\*|([1-9]|1[0-2])([-/,]([1-9]|1[0-2]))*)$/, // month
  /^(\*|[0-6]([-/,][0-6])*)$/, // day of week
] as const

export function isValidCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== CRON_FIELD.length) return false
  return fields.every((field, index) => {
    const pattern = CRON_FIELD[index]
    if (pattern === undefined) return false
    // A step applies to a range or a wildcard: `*/15` and `0-30/5` are the two legal shapes.
    const [base = '', step] = field.split('/')
    if (step !== undefined && !/^[1-9]\d?$/.test(step)) return false
    return pattern.test(base === '*' ? '*' : base)
  })
}

/**
 * Validates the whole registry, at import time.
 *
 * Every failure here is one that is otherwise invisible: a duplicate name silently overwrites a queue's
 * options, a malformed cron never fires, and a zero retry limit on a job that talks to a provider turns
 * one timeout into a lost message.
 */
export function assertRegistry(jobs: readonly JobDefinition<never>[]): void {
  const problems: string[] = []
  const seen = new Set<string>()

  for (const job of jobs) {
    if (seen.has(job.name)) problems.push(`${job.name}: declared twice`)
    seen.add(job.name)

    // A dot namespaces a job to the subsystem that owns it (`audit.ensure-partitions`); hyphens
    // separate words inside a segment. Both are already in use and neither is decorative: the
    // dead-letter queue name is derived from this string, so a space or a capital would produce a
    // queue name that differs from the one a watchdog looks for.
    if (!/^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/.test(job.name)) {
      problems.push(`${job.name}: name must be lower-case, dot- or hyphen-separated`)
    }
    if (job.purpose.trim().length === 0) {
      problems.push(
        `${job.name}: purpose is empty — an unexplained cron is one nobody dares delete`,
      )
    }
    if (job.cron !== undefined && !isValidCron(job.cron)) {
      problems.push(
        `${job.name}: '${job.cron}' is not a 5-field cron expression. ` +
          'pg-boss accepts a malformed one and then never fires it.',
      )
    }
    if (job.cron !== undefined && (job.agent ?? '').trim().length === 0) {
      problems.push(
        `${job.name}: a cron job must name the agent_definition it reports to. Without one it has no ` +
          'declared interval and no budget, so nothing is watching it and nothing is capping it.',
      )
    }
    if (job.retryLimit < 1) {
      problems.push(`${job.name}: retryLimit must be at least 1`)
    }
    if (job.expireInSeconds < 1) {
      problems.push(`${job.name}: expireInSeconds must be at least 1`)
    }
  }

  if (problems.length > 0) {
    throw new AppError(
      'invariant_violated',
      `Job registry is invalid:\n  ${problems.join('\n  ')}`,
      {
        details: { problems },
      },
    )
  }
}

/**
 * The jobs this application runs.
 *
 * Deliberately not empty. An empty registry makes every assertion in `worker.itest.ts` pass
 * vacuously — the declared set and the registered set are equal because both are empty — and the
 * first unit to add a job would discover the harness had never worked.
 *
 * `@berelax/db`'s `MAINTENANCE_JOBS` is the first entry, and it is the right one to start with because
 * it is already load-bearing and was already unregistered. Migration 0005 creates the audit table with
 * **no DEFAULT partition**, deliberately, so that if partition creation stops running then audit
 * inserts fail loudly rather than landing somewhere nobody prunes. F04 declared the cron; nothing had
 * ever registered it, because until now there was no worker to register it in.
 */
export const JOB_REGISTRY: readonly JobDefinition<never>[] = [
  ...MAINTENANCE_JOBS.map((job) => ({
    name: job.name,
    purpose:
      'Migration 0005 creates no DEFAULT partition on audit_event, so a missing partition fails the ' +
      'insert rather than hiding the row. This keeps the next month ahead of the clock.',
    cron: job.cron,
    agent: 'audit_partitions',
    retryLimit: DEFAULT_QUEUE_OPTIONS.retryLimit,
    retryDelaySeconds: DEFAULT_QUEUE_OPTIONS.retryDelay,
    retryBackoff: DEFAULT_QUEUE_OPTIONS.retryBackoff,
    // Partition creation is DDL against one table. A minute is generous; a job still running after that
    // is blocked on a lock, and reclaiming it is the right answer.
    expireInSeconds: 60,
    handler: maintenanceHandler(job.sql),
  })),
  {
    name: 'agent.watchdog',
    purpose:
      'Alerts when any enabled agent has had no success within twice its declared interval, whatever ' +
      'the cause. The absence of a success is the signal; docs/10 §6.',
    // Every fifteen minutes. The alert itself is deduplicated by incident, so a frequent pass costs a
    // query rather than ninety-six notifications — and the shortest declared interval in the registry is
    // five minutes, so a slower watchdog would be the thing delaying its own alert.
    cron: '*/15 * * * *',
    agent: 'agent_watchdog',
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 120,
    handler: watchdogHandler,
  },
  // A queue with no cron, and therefore no agent. W-SYS-05: a derivative build is announced by the
  // upload that produced the original, so the thing being watched is the request that accepted the file.
  BUILD_DERIVATIVES_JOB,
]

/**
 * The watchdog's own handler.
 *
 * It watches itself, which is not circular in the way it first looks: if this job stops running, its own
 * heartbeat goes stale and no pass raises the alert — so something outside this process has to notice,
 * which is the alerting ladder in H-HARD-05. What this unit guarantees is that the evidence exists and is
 * a row rather than a log line nobody reads.
 */
async function watchdogHandler(_data: never, context: JobContext): Promise<void> {
  const sql = maintenanceSql
  if (sql === undefined) {
    throw new AppError(
      'invariant_violated',
      'The watchdog ran before setMaintenanceSql() supplied a connection. run.ts calls it before ' +
        'startWorkers().',
    )
  }
  const result = await runWatchdog(sql, instantFromIso(context.now()))
  if (result.raised.length > 0) {
    console.warn(
      `agent watchdog raised ${result.raised.length} alert(s): ${result.raised.join(', ')}`,
    )
  }
}

/**
 * A handler that runs one statement.
 *
 * The statement is a constant from `MAINTENANCE_JOBS`, never job data — a handler that interpolated
 * `data.sql` would be a queue anybody who can enqueue can execute arbitrary SQL through, and a queue is
 * reachable from every feature in the system.
 */
function maintenanceHandler(statement: string): JobHandler<never> {
  return async () => {
    const sql = maintenanceSql
    if (sql === undefined) {
      throw new AppError(
        'invariant_violated',
        'A maintenance job ran before setMaintenanceSql() supplied a connection. ' +
          'run.ts calls it before startWorkers().',
      )
    }
    await sql.unsafe(statement)
  }
}

let maintenanceSql: Sql | undefined

/**
 * Hands the maintenance handlers their database connection.
 *
 * A module-level binding rather than a parameter threaded through `JobDefinition`, because the registry
 * is a module constant that G-AGT-01's completeness gate imports and enumerates *without* a database —
 * making the handler's dependency a constructor argument would make the registry a function, and then
 * "every cron is declared here" stops being checkable statically.
 */
export function setMaintenanceSql(sql: Sql): void {
  maintenanceSql = sql
}

export interface RegisterResult {
  readonly queues: readonly string[]
  readonly schedules: readonly string[]
}

/**
 * Creates every queue and schedules every cron in the registry, and unschedules anything it does not
 * declare.
 *
 * The unschedule half is the part that matters on a redeploy. `boss.schedule` is an upsert, so a job
 * removed from the registry keeps firing from the old row forever — a cron nothing in the codebase
 * mentions, which is the worst kind to debug.
 */
export async function registerJobs(
  boss: PgBoss,
  jobs: readonly JobDefinition<never>[] = JOB_REGISTRY,
): Promise<RegisterResult> {
  assertRegistry(jobs)

  for (const job of jobs) {
    // The dead-letter queue first: `createQueue` validates that the queue named in `deadLetter` already
    // exists and throws if it does not, so the obvious order fails on a fresh database.
    await boss.createQueue(deadLetterFor(job.name))
    await boss.createQueue(job.name, {
      retryLimit: job.retryLimit,
      retryDelay: job.retryDelaySeconds,
      retryBackoff: job.retryBackoff,
      expireInSeconds: job.expireInSeconds,
      deadLetter: deadLetterFor(job.name),
    })
  }

  const declared = new Set(jobs.filter((job) => job.cron !== undefined).map((job) => job.name))
  for (const existing of await boss.getSchedules()) {
    if (!declared.has(existing.name)) await boss.unschedule(existing.name)
  }

  for (const job of jobs) {
    if (job.cron === undefined) continue
    await boss.schedule(job.name, job.cron, null, { tz: SCHEDULE_TIMEZONE })
  }

  return {
    queues: jobs.map((job) => job.name),
    schedules: [...declared],
  }
}

/**
 * A job's dead-letter queue.
 *
 * Every job has one, unconditionally. pg-boss's default is to leave an exhausted job in the `failed`
 * state, where it is a row in a table nobody reads — docs/10 §6 states the rule plainly: a pg-boss job
 * failure is not evidence anybody has seen, because nobody reads `pgboss.job`. A dead-letter queue is a
 * place a watchdog can look.
 */
export function deadLetterFor(name: string): string {
  return `${name}-dead-letter`
}

/** Attaches every handler in the registry to its queue. */
export async function startWorkers(
  boss: PgBoss,
  now: () => string,
  jobs: readonly JobDefinition<never>[] = JOB_REGISTRY,
): Promise<void> {
  for (const job of jobs) {
    await boss.work<never>(job.name, async (received: readonly Job<never>[]) => {
      const first = received[0]
      if (first === undefined) return
      await job.handler(first.data, { jobId: first.id, now })
    })
  }
}

/** The cron registrations, for G-AGT-01's registry-completeness gate. */
export function cronRegistrations(
  jobs: readonly JobDefinition<never>[] = JOB_REGISTRY,
): readonly { name: string; cron: string; agent: string | undefined }[] {
  return jobs
    .filter((job) => job.cron !== undefined)
    .map((job) => ({ name: job.name, cron: job.cron as string, agent: job.agent }))
}
