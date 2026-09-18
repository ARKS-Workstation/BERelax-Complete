import { readFileSync } from 'node:fs'
import { createConnection, type Sql, withUnitOfWork } from '@berelax/db'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBoss, PGBOSS_SCHEMA, shutdown } from './boss.ts'
import { enqueue, transactionalEnqueue } from './enqueue.ts'
import {
  assertRegistry,
  cronRegistrations,
  deadLetterFor,
  isValidCron,
  JOB_REGISTRY,
  type JobDefinition,
  registerJobs,
  SCHEDULE_TIMEZONE,
  setMaintenanceSql,
} from './registry.ts'
import { drainOne, jobRows, runJobBody } from './testing/harness.ts'

/**
 * F12 — the worker, proved against a real PostgreSQL and a real pg-boss.
 *
 * None of these claims can be checked any other way. Whether a job survives a rollback is a property of
 * one transaction; whether a retry lands in a dead-letter queue is a property of pg-boss's own state
 * machine; whether a drain waits is a property of the process. A mocked queue would assert that the mock
 * works.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
const FROZEN_NOW = '2026-09-18T10:00:00.000Z'

let sql: Sql
let boss: PgBoss

/** A queue used only by these tests, so nothing here depends on the shipped registry's contents. */
const probe: JobDefinition<{ readonly token: string }> = {
  name: 'f12-probe',
  purpose: 'A test-only queue. Its handler writes nothing; the tests assert on the job row.',
  retryLimit: 3,
  retryDelaySeconds: 0,
  retryBackoff: false,
  expireInSeconds: 60,
  handler: async () => {},
}

const alwaysFails: JobDefinition<{ readonly token: string }> = {
  ...probe,
  name: 'f12-probe-fails',
  handler: async () => {
    throw new Error('deliberate')
  },
}

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  boss = createBoss({ config: { DATABASE_URL } })
  await boss.start()
  setMaintenanceSql(sql)
  await registerJobs(boss, [...JOB_REGISTRY, probe, alwaysFails] as never)
}, 120_000)

afterAll(async () => {
  await shutdown(boss, 5_000)
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  // pg-boss 12 keeps completed and failed jobs in `pgboss.job` under its retention policy; there is no
  // separate archive table to clear.
  await sql`delete from pgboss.job where name like 'f12-probe%'`
})

async function jobCount(queue: string, tx: Sql = sql): Promise<number> {
  const [row] =
    (await tx`select count(*)::int as n from pgboss.job where name = ${queue}`) as unknown as {
      n: number
    }[]
  return row?.n ?? 0
}

describe('acceptance — transactional enqueue, which is why the queue is not Redis', () => {
  it('does not run a job whose transaction rolled back', async () => {
    const token = 'rolled-back'
    await expect(
      withUnitOfWork(sql, { kind: 'system', id: 'f12-itest' }, async (uow) => {
        const id = await transactionalEnqueue(boss, uow).send(probe, { token })
        expect(id).not.toBeNull()
        // Read it back INSIDE the transaction. Without this the test passes when the enqueue silently
        // did nothing at all, which is the same observable result as a correct rollback and is the
        // failure this whole unit exists to prevent.
        expect(await jobCount(probe.name, uow.sql)).toBe(1)
        throw new Error('the booking failed after the reminder was queued')
      }),
    ).rejects.toThrow('the booking failed')

    expect(await jobCount(probe.name)).toBe(0)
  }, 60_000)

  it('runs a job whose transaction committed', async () => {
    await withUnitOfWork(sql, { kind: 'system', id: 'f12-itest' }, async (uow) => {
      await transactionalEnqueue(boss, uow).send(probe, { token: 'committed' })
    })
    expect(await jobCount(probe.name)).toBe(1)

    const drained = await drainOne(boss, probe, () => FROZEN_NOW)
    expect(drained?.outcome).toBe('completed')
    expect(drained?.data.token).toBe('committed')
  }, 60_000)

  it('enqueues outside a transaction when asked, so the choice is visible in the call site', async () => {
    await enqueue(boss).send(probe, { token: 'no-transaction' })
    expect(await jobCount(probe.name)).toBe(1)
  }, 60_000)
})

describe('acceptance — the registry is the only way a job exists', () => {
  it('registers exactly what the registry declares, in both directions', async () => {
    const registered = await registerJobs(boss, JOB_REGISTRY)

    const queues = new Set(
      ((await sql`select name from pgboss.queue`) as unknown as { name: string }[]).map(
        (r) => r.name,
      ),
    )
    for (const name of registered.queues) {
      expect(queues.has(name), `queue ${name} declared but not created`).toBe(true)
      expect(queues.has(deadLetterFor(name)), `${name} has no dead-letter queue`).toBe(true)
    }

    const schedules = new Set((await boss.getSchedules()).map((schedule) => schedule.name))
    // Both directions. A schedule pg-boss holds that the registry does not declare is a cron nothing in
    // the codebase mentions, and `registerJobs` unschedules it — so after registration the two sets are
    // equal, not merely overlapping.
    expect([...schedules].sort()).toEqual([...registered.schedules].sort())
    expect(registered.schedules.length).toBeGreaterThan(0)
  }, 120_000)

  it('schedules every cron in Asia/Dubai, because the trading day is 11:00 to 02:00 local', async () => {
    await registerJobs(boss, JOB_REGISTRY)
    const schedules = await boss.getSchedules()
    expect(schedules.length).toBeGreaterThan(0)
    for (const schedule of schedules) {
      expect(schedule.timezone, schedule.name).toBe(SCHEDULE_TIMEZONE)
    }
  }, 120_000)

  it('removes a schedule the registry no longer declares', async () => {
    // A redeploy that drops a job. `boss.schedule` is an upsert, so without the unschedule half the old
    // row keeps firing forever.
    const retired: JobDefinition<never> = { ...probe, name: 'f12-probe-retired', cron: '0 4 * * *' }
    await registerJobs(boss, [...JOB_REGISTRY, retired] as never)
    expect((await boss.getSchedules()).map((schedule) => schedule.name)).toContain(
      'f12-probe-retired',
    )

    await registerJobs(boss, JOB_REGISTRY)
    expect((await boss.getSchedules()).map((schedule) => schedule.name)).not.toContain(
      'f12-probe-retired',
    )
  }, 120_000)

  it('exposes its crons for the heartbeat registry G-AGT-01 builds on', () => {
    const crons = cronRegistrations(JOB_REGISTRY)
    expect(crons.length).toBe(JOB_REGISTRY.filter((job) => job.cron !== undefined).length)
    for (const cron of crons) expect(isValidCron(cron.cron)).toBe(true)
  })
})

describe('acceptance — a malformed declaration throws at import time, naming the job', () => {
  const bad: readonly { what: string; job: JobDefinition<never>; message: RegExp }[] = [
    {
      what: 'a 6-field cron',
      // pg-boss accepts this and never fires it: read as 5 fields it is nonsense, and the mistake is a
      // plausible one — somebody writes a seconds field out of habit.
      job: { ...probe, name: 'f12-bad', cron: '0 0 3 * * *' } as JobDefinition<never>,
      message: /f12-bad: '0 0 3 \* \* \*' is not a 5-field cron/,
    },
    {
      what: 'an out-of-range hour',
      job: { ...probe, name: 'f12-bad', cron: '0 25 * * *' } as JobDefinition<never>,
      message: /f12-bad: '0 25 \* \* \*' is not a 5-field cron/,
    },
    {
      what: 'a name that is not lower-case',
      job: { ...probe, name: 'F12Bad' } as JobDefinition<never>,
      message: /F12Bad: name must be lower-case/,
    },
    {
      what: 'an empty purpose',
      job: { ...probe, name: 'f12-bad', purpose: '  ' } as JobDefinition<never>,
      message: /f12-bad: purpose is empty/,
    },
    {
      what: 'no retries on a job that talks to a provider',
      job: { ...probe, name: 'f12-bad', retryLimit: 0 } as JobDefinition<never>,
      message: /f12-bad: retryLimit must be at least 1/,
    },
  ]

  for (const { what, job, message } of bad) {
    it(`rejects ${what}`, () => {
      expect(() => assertRegistry([job])).toThrow(message)
    })
  }

  it('rejects the same name twice, which silently overwrites a queue’s options', () => {
    expect(() => assertRegistry([probe, { ...probe }] as never)).toThrow(/declared twice/)
  })

  it('accepts every expression the shipped registry uses, so the validator is not merely strict', () => {
    // The control. A validator that rejected everything would pass all five cases above.
    expect(() => assertRegistry(JOB_REGISTRY)).not.toThrow()
    for (const expression of ['0 3 * * *', '*/15 * * * *', '0 0-6/2 * * 1-5', '30 23 1 1 *']) {
      expect(isValidCron(expression), expression).toBe(true)
    }
  })
})

describe('acceptance — a failing handler retries and then dead-letters', () => {
  it('counts attempts exactly and lands in the dead-letter queue', async () => {
    await enqueue(boss).send(alwaysFails, { token: 'doomed' })

    // retryLimit 3 means the original attempt plus three retries.
    let attempts = 0
    for (let pass = 0; pass < 6; pass += 1) {
      const drained = await drainOne(boss, alwaysFails, () => FROZEN_NOW)
      if (drained === undefined) break
      expect(drained.outcome).toBe('failed')
      attempts += 1
    }
    expect(attempts).toBe(alwaysFails.retryLimit + 1)

    // `supervise` is what moves an exhausted job into its dead-letter queue; without it the row sits in
    // `failed` and the assertion below reads 0 for a reason that has nothing to do with dead-lettering.
    await boss.supervise()
    const dead = await sql`
      select count(*)::int as n from pgboss.job where name = ${deadLetterFor(alwaysFails.name)}
    `
    expect((dead as unknown as { n: number }[])[0]?.n).toBe(1)

    const rows = await jobRows(sql, alwaysFails.name)
    expect(rows.some((row) => row.state === 'failed')).toBe(true)
  }, 120_000)

  it('completes a job whose handler does not throw, so the retry test is not measuring the harness', async () => {
    await enqueue(boss).send(probe, { token: 'fine' })
    expect((await drainOne(boss, probe, () => FROZEN_NOW))?.outcome).toBe('completed')
    expect(await drainOne(boss, probe, () => FROZEN_NOW)).toBeUndefined()
  }, 60_000)
})

describe('acceptance — the harness runs a body, and can fail', () => {
  it('runs a handler with an injected clock', async () => {
    let seen: string | undefined
    const recording: JobDefinition<{ readonly token: string }> = {
      ...probe,
      handler: async (_data, context) => {
        seen = context.now()
      },
    }
    await runJobBody(recording, { token: 'x' }, { now: FROZEN_NOW })
    expect(seen).toBe(FROZEN_NOW)
  })

  it('surfaces a body that did not do its work', async () => {
    // The control for the harness itself. A harness that swallowed the throw would make every job test
    // in the system pass.
    const broken: JobDefinition<{ readonly token: string }> = {
      ...probe,
      handler: async () => {
        throw new Error('did not write its row')
      },
    }
    await expect(runJobBody(broken, { token: 'x' }, { now: FROZEN_NOW })).rejects.toThrow(
      'did not write its row',
    )
  })

  it('runs the shipped maintenance job against the real database', async () => {
    // Migration 0005 creates no DEFAULT partition on audit_event on purpose, so this job stopping is a
    // failed insert rather than a silently misfiled row. It had been declared since F04 and registered
    // by nothing, because until now there was no worker to register it in.
    const job = JOB_REGISTRY.find((candidate) => candidate.name === 'audit.ensure-partitions')
    expect(job, 'the audit partition job is not in the registry').toBeDefined()
    if (job === undefined) return
    await runJobBody(job, undefined as never, { now: FROZEN_NOW })
  }, 60_000)
})

describe('acceptance — a drain waits for the handler that is already running', () => {
  it('lets an in-flight job finish rather than leaving it active', async () => {
    // The failure this prevents: `stop()` without `graceful` tears the workers down mid-handler and the
    // job stays `active`. pg-boss will not reissue it until `expireInSeconds` has passed, so a reminder
    // that should have gone out at 19:00 goes out at 19:01 at the earliest and looks like a bug in the
    // reminder. A deploy does this on every release.
    // Hand-rolled rather than `Promise.withResolvers`, which is ES2024 and the project's lib is ES2023.
    // Raising the lib for one test would change what compiles everywhere else.
    const deferred = () => {
      let resolve = (): void => {}
      const promise = new Promise<void>((r) => {
        resolve = r
      })
      return { promise, resolve }
    }
    const started = deferred()
    const release = deferred()
    let finished = false

    const slow: JobDefinition<{ readonly token: string }> = {
      ...probe,
      name: 'f12-probe-slow',
      handler: async () => {
        started.resolve()
        await release.promise
        finished = true
      },
    }

    // A second instance, because stopping the shared one would end every test after this.
    const draining = createBoss({ config: { DATABASE_URL } })
    await draining.start()
    await registerJobs(draining, [slow] as never)
    await draining.work<never>(
      slow.name,
      async (received: readonly { data: never; id: string }[]) => {
        const first = received[0]
        if (first === undefined) return
        await slow.handler({ token: 'slow' }, { jobId: first.id, now: () => FROZEN_NOW })
      },
    )

    await enqueue(draining).send(slow, { token: 'slow' })
    await started.promise
    expect(finished).toBe(false)

    let drained = false
    const drain = shutdown(draining, 10_000).then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    // The assertion that makes this test a test. The handler is still blocked, so a drain that waits has
    // NOT resolved yet. Without this line, `release.resolve()` below would let the handler finish either
    // way and the test would pass against a `stop()` that did not wait at all.
    expect(drained, 'shutdown resolved while a handler was still running').toBe(false)

    release.resolve()
    await drain

    expect(finished).toBe(true)
    const rows = await jobRows(sql, slow.name)
    expect(rows.length).toBe(1)
    expect(rows[0]?.state).toBe('completed')
    await sql`delete from pgboss.job where name = ${slow.name}`
  }, 120_000)
})

describe('acceptance — pgboss stays out of the drift checker', () => {
  it('is not in the list of schemas pnpm db:drift compares', () => {
    // pg-boss owns and migrates its own nine tables. The drift gate compares every base table in its
    // listed schemas against a Drizzle mirror in BOTH directions, so a pgboss table inside that list
    // fails the build looking like a forgotten migration. Asserting the list here means widening it is
    // a deliberate act with a failing test to explain itself, rather than a surprise on someone else's
    // branch.
    const source = readFileSync('scripts/check-schema-drift.mjs', 'utf8')
    const listed = [...source.matchAll(/schema:\s*'([a-z_]+)'/g)].map((match) => match[1])
    expect(listed.length).toBeGreaterThan(0)
    expect(listed).not.toContain(PGBOSS_SCHEMA)
    // And the control: the schemas it does compare are the ones with mirrors.
    expect(listed).toContain('public')
  })

  it('created its tables in its own schema and none in public', async () => {
    const rows = (await sql`
      select table_schema, count(*)::int as n
      from information_schema.tables
      where table_name like 'job%' or table_name in ('queue', 'schedule', 'subscription', 'version')
      group by table_schema
    `) as unknown as { table_schema: string; n: number }[]
    const bySchema = new Map(rows.map((row) => [row.table_schema, row.n]))
    expect(bySchema.get(PGBOSS_SCHEMA) ?? 0).toBeGreaterThan(0)
    expect(bySchema.get('public') ?? 0).toBe(0)
  }, 60_000)
})
