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
   * A FILE holding the server's certificate authority, when the deployment has one.
   *
   * A path and not the PEM itself, because `sslrootcert` in a connection string names a file and that is
   * the only channel pg-boss passes through. `apps/worker/src/boss.ts` writes `DATABASE_CA_CERT` out and
   * hands over the path. DigitalOcean's managed PostgreSQL presents a certificate signed by its own CA,
   * which is in no default trust store, so supplying it is what makes the connection VERIFIED rather than
   * merely encrypted — docs/02 §2 says "TLS verify-full" and this is the half of it that is in code.
   */
  readonly caCertificatePath?: string
}

/**
 * The connection string pg-boss's driver should be given, which is not the one the rest of the app uses.
 *
 * ## Why this is a URL rewrite and not an `ssl` option
 *
 * It was an `ssl` option first, and that was wrong: **pg-boss does not forward one.** The string "ssl"
 * does not appear anywhere in its distributed build, so the option was accepted, ignored, and the worker
 * went on failing in exactly the same way — which is the worst kind of fix, because the code reads as
 * though it addresses the problem. What pg-boss does pass through is the connection string, so that is
 * where the setting has to go, and `pg-connection-string` understands `sslmode`, `sslrootcert` and
 * libpq's `no-verify`.
 *
 * ## The failure this exists for
 *
 * The worker died at boot with `SELF_SIGNED_CERT_IN_CHAIN` against the very cluster the web app was
 * serving pages from. The difference is the driver: `postgres` reads `sslmode=require` the way libpq
 * defines it — encrypt, do not verify — while `pg`, under pg-boss, verifies the chain anyway. So a
 * connection string that asked for no verification got it from one driver and not the other, and the one
 * that refused had no page to serve and nothing to fall back to.
 *
 * With a CA on disk the answer is the strong one: `verify-full`, against that file. Without one it is what
 * the connection string actually asked for and no more, which is a deliberate choice to make the two
 * drivers agree rather than to have the queue hold a stricter policy than the application it serves.
 * `.do/README.md` has the one `doctl` command that prints the certificate.
 */
export function jobQueueConnectionString(connectionString: string, caPath?: string): string {
  const url = new URL(connectionString)
  const mode = url.searchParams.get('sslmode')
  // Local development and the integration suite: no TLS was asked for, so nothing is changed. Forcing a
  // mode here would attempt a handshake against a cluster that has none.
  if (mode === null || mode === 'disable') return connectionString
  if (caPath !== undefined && caPath.length > 0) {
    url.searchParams.set('sslmode', 'verify-full')
    url.searchParams.set('sslrootcert', caPath)
    return url.toString()
  }
  url.searchParams.set('sslmode', 'no-verify')
  url.searchParams.delete('sslrootcert')
  return url.toString()
}

export function createJobQueue(options: JobQueueOptions): PgBoss {
  return new PgBoss({
    connectionString: jobQueueConnectionString(options.connectionString, options.caCertificatePath),
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
