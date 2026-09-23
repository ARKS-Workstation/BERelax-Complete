import { loadConfig } from '@berelax/config'
import { createConnection, createPostgresMessageStore } from '@berelax/db'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import { createBoss, shutdown } from './boss.ts'
import { enqueue } from './enqueue.ts'
import { createMediaStorageFor, setMediaStorage } from './jobs/build-derivatives.ts'
import { setVideoRenditionStorage } from './jobs/build-video-renditions.ts'
import {
  obligationNoticeRuntimeFor,
  SEND_OBLIGATION_NOTICE_JOB,
  setObligationNoticeEnqueue,
  setObligationNoticeRuntime,
} from './jobs/obligation-reminders.ts'
import { setReceiptSources } from './jobs/reconcile-dlr.ts'
import {
  SEND_SCHEDULED_STEP_JOB,
  scheduledStepRuntimeFor,
  setScheduledStepEnqueue,
  setScheduledStepRuntime,
} from './jobs/send-scheduled-step.ts'
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
  // Before `startWorkers`, for the same reason as the SQL connection: a handler that attached first
  // would take a job off the queue and fail on a missing adapter, burning a retry on nothing.
  const mediaStorage = createMediaStorageFor(config.MEDIA_STORAGE)
  setMediaStorage(mediaStorage)
  // One adapter, two jobs. The video job resolves ffmpeg lazily rather than at boot on purpose: a worker
  // with no video work to do should not refuse to start over a missing encoder, and a worker handed video
  // work must refuse to pretend it has one — which is what `[ffmpeg-not-available]` does.
  setVideoRenditionStorage(mediaStorage)
  // The DLR pass drains the transports the sends went through, which with the fakes means *this*
  // process's instances: a fake queues the receipt it will report inside the instance that accepted the
  // send. SMS only for now, deliberately — the Resend transport takes its verified sending address as a
  // required argument and no address exists yet (OPEN-QUESTIONS Y6-email-sender). Adding it here is one
  // line on the day it does, and until then an email receipt is not silently reported as drained: the
  // pass names the vendors it read.
  setReceiptSources({
    store: createPostgresMessageStore(sql),
    sources: [createSmsalaTransport({ config, now: () => new Date().toISOString() }).receipts],
  })
  // B-MSG-03: the connection, the send context and the magic-link builder, before `startWorkers` for the
  // same reason the media adapters are — a handler that attached first would take a job off the queue and
  // fail on a missing dependency, burning a retry on nothing.
  setScheduledStepRuntime(scheduledStepRuntimeFor(sql))
  // `singletonKey` is the step id, so a sweep overlapping the previous one does not queue the same step
  // twice. It is not the guarantee — the step's own `state = 'pending'` is, and it is what makes a double
  // enqueue harmless — but it keeps the queue from filling with work the first job already has.
  setScheduledStepEnqueue((data) =>
    enqueue(boss).send(SEND_SCHEDULED_STEP_JOB, data, { singletonKey: data.stepId }),
  )
  // M-VAT-11, and the same two calls for the same two reasons. The recipient resolver inside the runtime
  // answers null for every role and that is the shipped value, not a placeholder: no table in this build
  // holds a staff phone number, so every due notice is skipped with `no_recipient_on_file` recorded —
  // which is a row on the calendar rather than a renewal notice sent to a number somebody invented.
  setObligationNoticeRuntime(obligationNoticeRuntimeFor(sql))
  // `singletonKey` is the notice id, so a pass overlapping the previous one does not queue the same notice
  // twice. It is not the guarantee — the notice's own `state = 'pending'` and 0060's
  // `obligation_notice_one_send_per_step` are — but it keeps the queue from filling with work the first
  // job already has.
  setObligationNoticeEnqueue((data) =>
    enqueue(boss).send(SEND_OBLIGATION_NOTICE_JOB, data, { singletonKey: data.noticeId }),
  )
  await boss.start()
  const registered = await registerJobs(boss, JOB_REGISTRY)
  await startWorkers(boss, () => new Date().toISOString(), JOB_REGISTRY)

  console.log(
    `worker ready — ${registered.queues.length} queue(s), ${registered.schedules.length} schedule(s)`,
  )
}

await main()
