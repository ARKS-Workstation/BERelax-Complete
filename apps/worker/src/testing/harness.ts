import type { Sql } from '@berelax/db'
import type { PgBoss } from 'pg-boss'
import type { JobDefinition } from '../job.ts'

/**
 * Runs a job body directly, with an injected clock and a real database.
 *
 * Two things this is *not*. It is not a mock — the handler talks to a real PostgreSQL, because every
 * interesting property of these jobs is a property of the database: a partition exists, a row was
 * written once rather than twice, an append-only trigger refused. And it does not go through the queue,
 * because a test that enqueues and then waits is a test whose failure mode is a timeout, and a timeout
 * tells you nothing about which of the ten things went wrong.
 *
 * Going through the queue is the subject of its own test in `worker.itest.ts`. This is for the body.
 */
export interface HarnessOptions {
  readonly now: string
  readonly jobId?: string
}

export async function runJobBody<Data>(
  job: JobDefinition<Data>,
  data: Data,
  options: HarnessOptions,
): Promise<void> {
  await job.handler(data, {
    jobId: options.jobId ?? 'harness-00000000-0000-0000-0000-000000000000',
    now: () => options.now,
  })
}

/**
 * Fetches and completes exactly one job from a queue, returning what the handler saw.
 *
 * For the tests that genuinely are about the queue — retry counts, dead-lettering, the state a job is
 * left in. `boss.fetch` then `boss.complete`/`boss.fail` rather than `boss.work`, because `work` is a
 * polling loop and a test that starts one has to decide how long to wait.
 */
export interface DrainedJob<Data> {
  readonly id: string
  readonly data: Data
  readonly outcome: 'completed' | 'failed'
  readonly error?: unknown
}

export async function drainOne<Data>(
  boss: PgBoss,
  job: JobDefinition<Data>,
  now: () => string,
): Promise<DrainedJob<Data> | undefined> {
  const fetched = await boss.fetch<Data>(job.name)
  const received = fetched?.[0]
  if (received === undefined) return undefined

  try {
    await job.handler(received.data, { jobId: received.id, now })
  } catch (error) {
    // `fail` is what moves a job towards its retry limit and then its dead-letter queue. Swallowing the
    // error here and calling `complete` would make every retry test pass while proving nothing.
    await boss.fail(job.name, received.id, { message: String(error) })
    return { id: received.id, data: received.data, outcome: 'failed', error }
  }
  await boss.complete(job.name, received.id)
  return { id: received.id, data: received.data, outcome: 'completed' }
}

/** Every job row for a queue, newest first. The evidence for anything about retries or state. */
export interface JobRow {
  readonly id: string
  readonly state: string
  readonly retry_count: number
  readonly output: unknown
}

export async function jobRows(sql: Sql, queue: string): Promise<JobRow[]> {
  // One table. pg-boss 12 retains completed and failed jobs in `pgboss.job` itself — there is no
  // `job_archive`, which earlier versions had and which is the first place anyone looks.
  return (await sql`
    select id::text, state::text, retry_count, output
    from pgboss.job
    where name = ${queue}
    order by retry_count desc
  `) as unknown as JobRow[]
}
