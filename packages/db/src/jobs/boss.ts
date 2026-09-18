import { PgBoss } from 'pg-boss'

/**
 * The durable job queue, on the same PostgreSQL as everything else.
 *
 * Why Postgres and not Redis (docs/01 decision 4): a job enqueued in the SAME transaction as the
 * state change that caused it cannot be orphaned by a rollback, and cannot be lost between the
 * commit and the enqueue. Redis cannot offer that without a two-phase dance. Peak load here is a
 * few jobs per second during a campaign send, which is nowhere near the point where a dedicated
 * broker earns its keep.
 *
 * pg-boss owns the `pgboss` schema and migrates it itself, so it is deliberately NOT part of the
 * SQL migration chain — but it IS asserted present by an integration test, so a deployment cannot
 * quietly come up without a queue.
 */
export const PGBOSS_SCHEMA = 'pgboss' as const

export interface JobQueueOptions {
  readonly connectionString: string
  /** Keep small: PgBouncer multiplexes and the connection ceiling is shared with the app. */
  readonly max?: number
  readonly schema?: string
}

export function createJobQueue(options: JobQueueOptions): PgBoss {
  return new PgBoss({
    connectionString: options.connectionString,
    schema: options.schema ?? PGBOSS_SCHEMA,
    max: options.max ?? 4,
    // pg-boss owns and migrates its schema. Explicit rather than implicit, so a deployment that
    // lacks permission to create it fails at boot with a clear error.
    createSchema: true,
    migrate: true,
    supervise: true,
  })
}

/**
 * Retention is a PER-QUEUE option in pg-boss 12, not a constructor option, so it is applied at
 * `createQueue` time via this policy rather than globally.
 *
 * Seven days of completed-job history is the point of it: when a client says their reminder never
 * arrived, the job row is the evidence. `retryLimit` and exponential backoff exist because SMSala
 * and Resend both fail transiently.
 */
export const DEFAULT_QUEUE_OPTIONS = {
  retentionSeconds: 60 * 60 * 24 * 7,
  deleteAfterSeconds: 60 * 60 * 24 * 30,
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 60 * 30,
} as const

/**
 * Scheduled maintenance jobs registered on every worker boot.
 *
 * `ensure_audit_partitions` is the one that must not be forgotten: migration 0005 deliberately
 * creates no DEFAULT partition, so if partition creation stops running, audit inserts FAIL LOUDLY
 * rather than landing somewhere nobody prunes.
 */
export const MAINTENANCE_JOBS = [
  {
    name: 'audit.ensure-partitions',
    cron: '0 3 * * *',
    timezone: 'Asia/Dubai',
    sql: 'select ensure_audit_partitions()',
  },
] as const
