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
  /**
   * The PEM of the server's certificate authority, when the deployment has one.
   *
   * DigitalOcean's managed PostgreSQL presents a certificate signed by its own CA, which is not in any
   * default trust store. Supplying it here is what makes the connection VERIFIED rather than merely
   * encrypted — docs/02 §2 says "TLS verify-full" and this is the half of it that is in code.
   */
  readonly caCertificate?: string
}

/**
 * The TLS settings for pg-boss's driver, which are not the same as postgres.js's.
 *
 * This exists because of a failure that only appeared on a real deployment: the worker died at boot with
 * `SELF_SIGNED_CERT_IN_CHAIN` against the same cluster the web app was serving from happily. The
 * difference is the driver. `postgres` reads `sslmode=require` the way libpq defines it — encrypt, do not
 * verify — while `pg`, which pg-boss uses, verifies the chain anyway. So a connection string that asked
 * for no verification got it from one driver and not the other, and the one that refused was the one with
 * no page to serve and nothing to fall back to.
 *
 * With a CA the answer is the strong one: verify against it. Without a CA it is what the connection string
 * actually asked for, and no more — which is a deliberate choice to make the two drivers agree rather than
 * to have the queue hold a stricter policy than the application it serves. A deployment that wants
 * verification supplies `DATABASE_CA_CERT`; `.do/README.md` has the one `doctl` command that prints it.
 */
export function jobQueueSsl(
  connectionString: string,
  caCertificate?: string,
): { ca: string; rejectUnauthorized: true } | { rejectUnauthorized: false } | undefined {
  const mode = new URL(connectionString).searchParams.get('sslmode')
  // Local development and the integration suite: no TLS was asked for, so none is configured. Passing
  // `rejectUnauthorized: false` here would still attempt TLS and fail against a cluster that has none.
  if (mode === null || mode === 'disable') return undefined
  if (caCertificate !== undefined && caCertificate.length > 0) {
    return { ca: caCertificate, rejectUnauthorized: true }
  }
  return { rejectUnauthorized: false }
}

export function createJobQueue(options: JobQueueOptions): PgBoss {
  return new PgBoss({
    connectionString: options.connectionString,
    schema: options.schema ?? PGBOSS_SCHEMA,
    max: options.max ?? 4,
    ssl: jobQueueSsl(options.connectionString, options.caCertificate),
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
