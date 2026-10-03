import { loadConfig } from '@berelax/config'
import { createConnection, createPostgresMessageStore } from '@berelax/db'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import { FLOW_TICK_JOB, setInterpreterRuntime } from './automation/interpreter.ts'
import {
  interpreterCaps,
  messageNodeDepsFor,
  raiseLoopDetectedAlert,
} from './automation/runtime.ts'
import { createBoss, shutdown } from './boss.ts'
import { enqueue, transactionalEnqueue } from './enqueue.ts'
import { setAnalyticsDispatchSql } from './jobs/analytics-dispatch.ts'
import { setAnalyticsMaintenanceSql } from './jobs/analytics-partitions.ts'
import { setAnalyticsRollupSql } from './jobs/analytics-rollup.ts'
import { createMediaStorageFor, setMediaStorage } from './jobs/build-derivatives.ts'
import { setVideoRenditionStorage } from './jobs/build-video-renditions.ts'
import { setCashForecastSql } from './jobs/cash-forecast.ts'
import { setDispatchReconciliationSql } from './jobs/dispatch-reconciliation.ts'
import {
  obligationNoticeRuntimeFor,
  SEND_OBLIGATION_NOTICE_JOB,
  setObligationNoticeEnqueue,
  setObligationNoticeRuntime,
} from './jobs/obligation-reminders.ts'
import { setOfflineConversionSql } from './jobs/offline-conversions.ts'
import { setReceiptSources } from './jobs/reconcile-dlr.ts'
import { setReportingRefreshSql } from './jobs/reporting-refresh.ts'
import { setRetentionPurgeSql } from './jobs/retention-purge.ts'
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
  setRetentionPurgeSql(sql)
  // A-FIRST-01's partition and retention passes, before `startWorkers` for the reason every runtime above
  // is: a handler that attached first would take a job off the queue and fail on a missing connection,
  // burning a retry on nothing. Both passes are DDL against the analytics schema and neither reads the
  // clock itself — the instant comes from the job context, which is what lets the suite drive them frozen.
  setAnalyticsMaintenanceSql(sql)
  // R-REP-01's nightly reporting refresh, before `startWorkers` for the same reason. It calls
  // `reporting.refresh_all()`, whose SECURITY DEFINER is what lets the application role refresh a
  // materialised view it does not own, and it reads no clock: the durations come from the instants the
  // function recorded inside the transaction that did the work.
  setReportingRefreshSql(sql)
  // R-REP-06's weekly cash forecast, before `startWorkers` for the same reason. It reads no clock either:
  // the business day comes from `tradingDateAt` over the job context's instant, and it THROWS rather than
  // truncating a timestamp when the trading calendar holds nothing for it.
  setCashForecastSql(sql)
  // A-MEAS-03's dispatch consumer, before `startWorkers` for the same reason. It builds its provider
  // registry per RUN rather than here, because `ANALYTICS_PROVIDER` decides whether the pass talks to a
  // stand-in and a value captured at boot would survive a restart-free configuration change while the log
  // line went on claiming a real push.
  setAnalyticsDispatchSql(sql)
  // A-FIRST-09's nightly rollup, before `startWorkers` for the same reason: it reads the day that has just
  // closed out of the trading calendar rather than from arithmetic on the clock.
  setAnalyticsRollupSql(sql)
  // A-MEAS-05's producer, before `startWorkers` for the same reason. It takes its trading date from the
  // calendar through `tradingDateAt` rather than from arithmetic on the clock, so it needs the connection
  // before its first fire rather than at import.
  setOfflineConversionSql(sql)
  // A-MEAS-07's reconciliation, before `startWorkers` for the same reason: it reads the closed day out of
  // the trading calendar rather than from arithmetic on the clock, so it needs the connection before its
  // first fire.
  setDispatchReconciliationSql(sql)
  // `singletonKey` is the notice id, so a pass overlapping the previous one does not queue the same notice
  // twice. It is not the guarantee — the notice's own `state = 'pending'` and 0060's
  // `obligation_notice_one_send_per_step` are — but it keeps the queue from filling with work the first
  // job already has.
  setObligationNoticeEnqueue((data) =>
    enqueue(boss).send(SEND_OBLIGATION_NOTICE_JOB, data, { singletonKey: data.noticeId }),
  )
  // C-AUTO-07: the interpreter, before `startWorkers` for the reason every other runtime is — a handler
  // that attached first would take a tick off the queue and fail on a missing dependency, burning a retry
  // on nothing. The caps are read from `app_setting` HERE and not captured: `Y9-frequency-cap` is answered
  // by an audited settings change, so the figure is re-read per boot and the send path re-reads it per
  // tick through `messageDeps.caps`.
  setInterpreterRuntime({
    sql,
    messageDeps: { ...messageNodeDepsFor(sql), caps: await interpreterCaps(sql) },
    // TRANSACTIONAL, and it is the acceptance line: the next tick's job row commits with the side effects
    // the current tick performed, so a tick that rolled back leaves no tick behind and a tick that
    // committed cannot lose the one it queued.
    enqueueTick: (uow, data, options) =>
      transactionalEnqueue(boss, uow).send(FLOW_TICK_JOB, data, {
        ...(options?.startAfterSeconds === undefined
          ? {}
          : { startAfterSeconds: options.startAfterSeconds }),
        // The run id, so a tick queued while one is already pending for the same run is discarded. Not the
        // guarantee — the run's row lock and the idempotency tokens are — but it keeps the queue from
        // filling with work the first tick already has.
        singletonKey: data.runId,
      }),
    alertLoopDetected: raiseLoopDetectedAlert,
  })
  await boss.start()
  const registered = await registerJobs(boss, JOB_REGISTRY)
  await startWorkers(boss, () => new Date().toISOString(), JOB_REGISTRY)

  console.log(
    `worker ready — ${registered.queues.length} queue(s), ${registered.schedules.length} schedule(s)`,
  )
}

await main()
