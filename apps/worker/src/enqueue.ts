import type { Sql, UnitOfWork } from '@berelax/db'
import type { PgBoss } from 'pg-boss'
import type { JobDefinition } from './registry.ts'

/**
 * Enqueue inside the caller's transaction.
 *
 * This is the property locked decision 4 chose pg-boss for, and the only reason the queue is not Redis.
 * Consider a booking: the appointment row, its audit row, its domain event and its reminder job all have
 * to be durable together. With a separate broker there are exactly two orderings and both are wrong —
 * enqueue before commit and a rolled-back booking leaves a reminder for an appointment that does not
 * exist; enqueue after commit and a process that dies in the window between them loses the reminder
 * silently, with a committed booking as the only evidence.
 *
 * pg-boss's `send` accepts a `db` — anything with `executeSql` — so handing it the unit of work's own
 * transaction puts the job row in the same commit as the write. Both failures stop being possible, and
 * `worker.itest.ts` asserts both directions: the rollback case reads the job row back *inside* the
 * transaction first, so a passing test cannot be a test that never enqueued anything.
 *
 * `boss.send` still needs a started `PgBoss` for its queue metadata, but the insert itself travels on
 * the transaction given here.
 */
export interface TransactionalEnqueue {
  send<Data extends object>(
    job: JobDefinition<Data>,
    data: Data,
    options?: { readonly startAfterSeconds?: number; readonly singletonKey?: string },
  ): Promise<string | null>
}

/**
 * Adapts a postgres.js transaction to the shape pg-boss wants.
 *
 * `unsafe` with parameters, not string interpolation: the text arrives from pg-boss with `$1`-style
 * placeholders already in it, and postgres.js's tagged template would treat the whole thing as one
 * literal. The values are pg-boss's own, but the parameterisation is what keeps it that way if a future
 * version starts passing job data through.
 */
function asPgBossDb(sql: Sql): {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
} {
  return {
    async executeSql(text, values = []) {
      const rows = await sql.unsafe(text, values as never[])
      return { rows: rows as unknown as unknown[] }
    },
  }
}

export function transactionalEnqueue(boss: PgBoss, uow: UnitOfWork): TransactionalEnqueue {
  const db = asPgBossDb(uow.sql)
  return {
    send(job, data, options) {
      return boss.send(job.name, data, {
        db,
        ...(options?.startAfterSeconds === undefined
          ? {}
          : { startAfter: options.startAfterSeconds }),
        ...(options?.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
      })
    },
  }
}

/**
 * Enqueue outside a transaction.
 *
 * Present, and named so that using it is a visible choice. Some jobs genuinely have no write to be
 * atomic with — a manually triggered health check, a re-run of a report. Everything caused by a state
 * change uses `transactionalEnqueue` instead.
 */
export function enqueue(boss: PgBoss): TransactionalEnqueue {
  return {
    send(job, data, options) {
      return boss.send(job.name, data, {
        ...(options?.startAfterSeconds === undefined
          ? {}
          : { startAfter: options.startAfterSeconds }),
        ...(options?.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
      })
    },
  }
}
