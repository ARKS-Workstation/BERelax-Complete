import type { Config } from '@berelax/config'
import { createJobQueue, PGBOSS_SCHEMA } from '@berelax/db'
import type { PgBoss } from 'pg-boss'

/**
 * The worker's pg-boss instance.
 *
 * Thin on purpose. `@berelax/db` already owns the construction — F04 put it there because the queue
 * lives in the same database as everything else and its connection settings are the database's
 * settings. This module exists for the two things that belong to the *process* rather than to the
 * queue: how long a shutdown waits, and the fact that there is exactly one instance per process.
 *
 * Why Postgres and not Redis is locked decision 4, and it comes down to one property: `send` can run
 * inside the same transaction as the write that caused it, so a job cannot outlive a rolled-back
 * booking and a booking cannot commit without its reminder. See `enqueue.ts`, which is where that
 * property is actually used, and `worker.itest.ts`, which proves it both ways.
 */
export { PGBOSS_SCHEMA }

/**
 * How long `shutdown` waits for in-flight handlers before giving up.
 *
 * Picked against the platform rather than by feel: a container orchestrator sends SIGTERM and then
 * SIGKILL after its own grace period, so a drain deadline longer than that is a drain that never
 * finishes. 25 seconds sits inside DigitalOcean App Platform's 30-second default with room for the
 * connection teardown that follows.
 */
export const DRAIN_DEADLINE_MS = 25_000

export interface BossOptions {
  readonly config: Pick<Config, 'DATABASE_URL'>
  readonly max?: number
}

export function createBoss(options: BossOptions): PgBoss {
  return createJobQueue({ connectionString: options.config.DATABASE_URL, max: options.max ?? 4 })
}

/**
 * Stops accepting work, waits for in-flight handlers, and resolves.
 *
 * `graceful: true` is the whole point: without it `stop()` tears the workers down and the process exits
 * with a handler halfway through a send — the job is left `active`, and pg-boss will not reissue it
 * until `expireInSeconds` has passed. A campaign message that arrives twenty minutes late looks like a
 * bug in the campaign.
 *
 * `stop()` resolves before the drain finishes, so the `stopped` event is what actually says the workers
 * are done. Awaiting `stop()` alone is the mistake this wrapper exists to stop anyone making.
 */
export async function shutdown(boss: PgBoss, deadlineMs = DRAIN_DEADLINE_MS): Promise<void> {
  const stopped = new Promise<void>((resolve) => {
    boss.once('stopped', () => resolve())
  })
  await boss.stop({ graceful: true, timeout: deadlineMs, close: true })
  // The deadline is pg-boss's own, and it honours it — but a hung handler that ignores its AbortSignal
  // would leave this promise pending forever, and a process that will not exit is worse than one that
  // exits with a job to retry.
  await Promise.race([
    stopped,
    new Promise<void>((resolve) => setTimeout(resolve, deadlineMs + 2_000).unref()),
  ])
}
