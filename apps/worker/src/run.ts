import { loadConfig } from '@berelax/config'
import { createConnection } from '@berelax/db'
import { createBoss, shutdown } from './boss.ts'
import { JOB_REGISTRY, registerJobs, setMaintenanceSql, startWorkers } from './registry.ts'

/**
 * The worker process.
 *
 * One instance, separate from the web app, for the reason docs/02 §2 gives: a campaign send would
 * compete with page rendering for CPU, and a rolling web deploy would kill in-flight jobs mid-send.
 *
 * The order here is deliberate. Queues and schedules are created *before* any handler starts, so a
 * fresh database cannot have a handler attach to a queue that does not exist yet; and the signal
 * handlers are installed before `start()`, so a SIGTERM arriving during boot drains rather than being
 * ignored until the process is ready to receive it.
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 4 })
  const boss = createBoss({ config })

  let stopping = false
  const stop = (signal: string) => {
    void (async () => {
      // A second signal during a drain is an operator who has decided not to wait. Honour it rather
      // than swallowing it: the first SIGTERM drains, the second exits.
      if (stopping) process.exit(130)
      stopping = true
      console.log(`${signal}: draining in-flight jobs`)
      try {
        await shutdown(boss)
        await sql.end({ timeout: 5 })
      } finally {
        process.exit(0)
      }
    })()
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))

  boss.on('error', (error: unknown) => {
    // pg-boss emits rather than throws for background failures — a supervisor poll that could not
    // reach the database, for instance. Unhandled, they are invisible, and a worker that has lost its
    // connection looks exactly like a worker with nothing to do.
    console.error('pg-boss error', error)
  })

  setMaintenanceSql(sql)
  await boss.start()
  const registered = await registerJobs(boss, JOB_REGISTRY)
  await startWorkers(boss, () => new Date().toISOString(), JOB_REGISTRY)

  console.log(
    `worker ready — ${registered.queues.length} queue(s), ${registered.schedules.length} schedule(s)`,
  )
}

await main()
