/**
 * The job registry: the single place a queue or a cron exists.
 *
 * Declaring a job is not the same as it running, and the gap between the two is where scheduled work
 * quietly stops. The usual shape — `boss.schedule(...)` scattered through whatever module owns the
 * feature — means a job can be deleted, renamed or never registered and nothing says so; the symptom
 * is a report that stopped arriving three weeks ago.
 *
 * So registration is derived from this array and nothing else, and `worker.itest.ts` asserts the set of
 * queues in `pgboss.queue` and the set of names in `pgboss.schedule` equal the registry exactly — in
 * both directions. A job in the registry that was not registered fails; a queue registered that the
 * registry does not declare fails too.
 *
 * `G-AGT-01` builds the heartbeat contract on top of this: the `agent` field names the
 * `agent_definition` row a job belongs to, and its registry-completeness gate enumerates
 * `cronRegistrations()` and fails naming any cron with no such row.
 */
import { type Config, loadConfig } from '@berelax/config'
import { instantFromIso } from '@berelax/core'
import { DEFAULT_QUEUE_OPTIONS, MAINTENANCE_JOBS, type Sql } from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { Job, PgBoss } from 'pg-boss'
import { FLOW_TICK_JOB } from './automation/interpreter.ts'
import type { JobContext, JobDefinition, JobHandler } from './job.ts'
import { runWatchdog } from './jobs/agent-watchdog.ts'
import { runAlertEvaluation } from './jobs/alert-evaluator.ts'
import { ANALYTICS_DISPATCH_JOB_DEFINITION } from './jobs/analytics-dispatch.ts'
import {
  ANALYTICS_PARTITIONS_JOB_DEFINITION,
  ANALYTICS_RETENTION_JOB_DEFINITION,
} from './jobs/analytics-partitions.ts'
import { BUILD_DERIVATIVES_JOB } from './jobs/build-derivatives.ts'
import { BUILD_VIDEO_RENDITIONS_JOB } from './jobs/build-video-renditions.ts'
import { CASH_FORECAST_JOB_DEFINITION } from './jobs/cash-forecast.ts'
import { CREDENTIAL_SWEEP_AGENT, runCredentialSweep } from './jobs/credential-sweep.ts'
import { DISPATCH_RECONCILIATION_JOB_DEFINITION } from './jobs/dispatch-reconciliation.ts'
import {
  GOOGLE_HEALTH_AGENT,
  GOOGLE_LIVENESS_AGENT,
  googleHealthHandler,
  googleLivenessHandler,
} from './jobs/google-connection-health.ts'
import { GOOGLE_REVOKE_RETRY_JOB } from './jobs/google-revoke-retry.ts'
import { GRATUITY_ACCRUAL_AGENT, runGratuityAccrual } from './jobs/gratuity-accrual.ts'
import { gscNightlySnapshotHandler, SEO_GSC_SNAPSHOT_AGENT } from './jobs/gsc-nightly-snapshot.ts'
import {
  gscUrlInspectionHandler,
  SEO_URL_INSPECTION_AGENT,
} from './jobs/gsc-url-inspection-rotation.ts'
import { LEAVE_ACCRUAL_AGENT, runLeaveAccrual } from './jobs/leave-accrual.ts'
import {
  COMPLIANCE_CALENDAR_JOB,
  REBUILD_OBLIGATION_NOTICES_JOB,
  SEND_OBLIGATION_NOTICE_JOB,
} from './jobs/obligation-reminders.ts'
import { OFFLINE_CONVERSIONS_JOB_DEFINITION } from './jobs/offline-conversions.ts'
import {
  PACKAGE_EXPIRY_ACTOR,
  PACKAGE_EXPIRY_AGENT,
  runPackageExpirySweep,
} from './jobs/package-expiry.ts'
import { PAYMENT_RECONCILIATION_JOB_DEFINITION } from './jobs/payment-reconciliation.ts'
import { RECONCILE_DLR_JOB } from './jobs/reconcile-dlr.ts'
import { runRecurringCostCheck } from './jobs/recurring-cost-check.ts'
import { REPORTING_REFRESH_JOB_DEFINITION } from './jobs/reporting-refresh.ts'
import { RETENTION_PURGE_JOB_DEFINITION } from './jobs/retention-purge.ts'
import { runReverseChargeExceptionReport } from './jobs/reverse-charge-exceptions.ts'
import { REVIEW_COUNT_TRIPWIRE_JOB } from './jobs/review-count-tripwire.ts'
import { REVIEW_MONDAY_NUDGE_JOB } from './jobs/review-monday-nudge.ts'
import {
  REBUILD_SCHEDULED_STEPS_JOB,
  SCHEDULED_STEP_SWEEP_JOB,
  SEND_SCHEDULED_STEP_JOB,
} from './jobs/send-scheduled-step.ts'
import { SETTLEMENT_IMPORT_JOB_DEFINITION } from './jobs/settlement-import.ts'

export type { JobContext, JobDefinition, JobHandler } from './job.ts'

/** Asia/Dubai for every schedule. The business day is 11:00–02:00 local; UTC would split it. */
export const SCHEDULE_TIMEZONE = 'Asia/Dubai'

/**
 * A 5-field cron expression, field by field, rather than one unreadable alternation.
 *
 * pg-boss accepts a 6-field expression with seconds; this refuses one. A seconds field is either a
 * mistake — `0 3 * * *` read as "every minute at second 0 of hour 3" is a plausible misreading of a
 * daily job — or a job that should be a queue with a `startAfter` instead.
 */
const CRON_FIELD = [
  /^(\*|([0-5]?\d)([-/,]([0-5]?\d))*)$/, // minute
  /^(\*|([01]?\d|2[0-3])([-/,]([01]?\d|2[0-3]))*)$/, // hour
  /^(\*|([12]?\d|3[01])([-/,]([12]?\d|3[01]))*)$/, // day of month
  /^(\*|([1-9]|1[0-2])([-/,]([1-9]|1[0-2]))*)$/, // month
  /^(\*|[0-6]([-/,][0-6])*)$/, // day of week
] as const

export function isValidCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== CRON_FIELD.length) return false
  return fields.every((field, index) => {
    const pattern = CRON_FIELD[index]
    if (pattern === undefined) return false
    // A step applies to a range or a wildcard: `*/15` and `0-30/5` are the two legal shapes.
    const [base = '', step] = field.split('/')
    if (step !== undefined && !/^[1-9]\d?$/.test(step)) return false
    return pattern.test(base === '*' ? '*' : base)
  })
}

/**
 * Validates the whole registry, at import time.
 *
 * Every failure here is one that is otherwise invisible: a duplicate name silently overwrites a queue's
 * options, a malformed cron never fires, and a zero retry limit on a job that talks to a provider turns
 * one timeout into a lost message.
 */
export function assertRegistry(jobs: readonly JobDefinition<never>[]): void {
  const problems: string[] = []
  const seen = new Set<string>()

  for (const job of jobs) {
    if (seen.has(job.name)) problems.push(`${job.name}: declared twice`)
    seen.add(job.name)

    // A dot namespaces a job to the subsystem that owns it (`audit.ensure-partitions`); hyphens
    // separate words inside a segment. Both are already in use and neither is decorative: the
    // dead-letter queue name is derived from this string, so a space or a capital would produce a
    // queue name that differs from the one a watchdog looks for.
    if (!/^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/.test(job.name)) {
      problems.push(`${job.name}: name must be lower-case, dot- or hyphen-separated`)
    }
    if (job.purpose.trim().length === 0) {
      problems.push(
        `${job.name}: purpose is empty — an unexplained cron is one nobody dares delete`,
      )
    }
    if (job.cron !== undefined && !isValidCron(job.cron)) {
      problems.push(
        `${job.name}: '${job.cron}' is not a 5-field cron expression. ` +
          'pg-boss accepts a malformed one and then never fires it.',
      )
    }
    if (job.cron !== undefined && (job.agent ?? '').trim().length === 0) {
      problems.push(
        `${job.name}: a cron job must name the agent_definition it reports to. Without one it has no ` +
          'declared interval and no budget, so nothing is watching it and nothing is capping it.',
      )
    }
    if (job.retryLimit < 1) {
      problems.push(`${job.name}: retryLimit must be at least 1`)
    }
    if (job.expireInSeconds < 1) {
      problems.push(`${job.name}: expireInSeconds must be at least 1`)
    }
  }

  if (problems.length > 0) {
    throw new AppError(
      'invariant_violated',
      `Job registry is invalid:\n  ${problems.join('\n  ')}`,
      {
        details: { problems },
      },
    )
  }
}

/**
 * The jobs this application runs.
 *
 * Deliberately not empty. An empty registry makes every assertion in `worker.itest.ts` pass
 * vacuously — the declared set and the registered set are equal because both are empty — and the
 * first unit to add a job would discover the harness had never worked.
 *
 * `@berelax/db`'s `MAINTENANCE_JOBS` is the first entry, and it is the right one to start with because
 * it is already load-bearing and was already unregistered. Migration 0005 creates the audit table with
 * **no DEFAULT partition**, deliberately, so that if partition creation stops running then audit
 * inserts fail loudly rather than landing somewhere nobody prunes. F04 declared the cron; nothing had
 * ever registered it, because until now there was no worker to register it in.
 */
export const JOB_REGISTRY: readonly JobDefinition<never>[] = [
  ...MAINTENANCE_JOBS.map((job) => ({
    name: job.name,
    purpose:
      'Migration 0005 creates no DEFAULT partition on audit_event, so a missing partition fails the ' +
      'insert rather than hiding the row. This keeps the next month ahead of the clock.',
    cron: job.cron,
    agent: 'audit_partitions',
    retryLimit: DEFAULT_QUEUE_OPTIONS.retryLimit,
    retryDelaySeconds: DEFAULT_QUEUE_OPTIONS.retryDelay,
    retryBackoff: DEFAULT_QUEUE_OPTIONS.retryBackoff,
    // Partition creation is DDL against one table. A minute is generous; a job still running after that
    // is blocked on a lock, and reclaiming it is the right answer.
    expireInSeconds: 60,
    handler: maintenanceHandler(job.sql),
  })),
  {
    name: 'agent.watchdog',
    purpose:
      'Alerts when any enabled agent has had no success within twice its declared interval, whatever ' +
      "the cause. The absence of a success is the signal; docs/10 §6. It also runs H-HARD-05's alert " +
      "ladder over ALERT_REGISTRY in the same pass, so the alerting path inherits this agent's declared " +
      'interval and heartbeat rather than being a cron nobody watches.',
    // Every fifteen minutes. The alert itself is deduplicated by incident, so a frequent pass costs a
    // query rather than ninety-six notifications — and the shortest declared interval in the registry is
    // five minutes, so a slower watchdog would be the thing delaying its own alert.
    cron: '*/15 * * * *',
    agent: 'agent_watchdog',
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 120,
    handler: watchdogHandler,
  },
  {
    name: 'recurring-cost.check',
    purpose:
      'Generates the expected periods of every recurring cost, then raises a variance alert for a bill ' +
      'outside its declared tolerance and a missing-cost alert for a period that passed its due date ' +
      'unbilled. Two failures nothing else in the system can see: a cost that stops arriving, and a ' +
      'cost that changes (M-VAT-04).',
    // 03:45 Asia/Dubai, after trading closes at 02:00 and after audit.ensure-partitions at 03:00. The
    // pass reads the trading calendar for the session that has just ended, so running it inside trading
    // hours would date its alerts on a business day that is not over yet.
    cron: '45 3 * * *',
    agent: 'recurring_cost_register',
    retryLimit: 3,
    retryDelaySeconds: 60,
    retryBackoff: true,
    // Generation is one INSERT over a 24-month window and the sweep is two more. Five minutes is
    // generous; a pass still running past it is blocked on a lock rather than slow.
    expireInSeconds: 300,
    handler: recurringCostHandler,
  },
  {
    name: 'vat.reverse-charge-exceptions',
    purpose:
      'Scans every offshore bill in the last twelve months for a missing reverse-charge pair, a pair whose ' +
      'two sides do not agree, and a pair the ledger does not carry — then writes an outbox event whether ' +
      'or not it found any. The failure is silent: a bill with no reverse charge posts, balances and ' +
      'reconciles to the supplier invoice, and understates the return (M-VAT-03, docs/04 §4).',
    // 04:15 Asia/Dubai, after trading closes at 02:00 and after recurring-cost.check at 03:45 — that pass
    // can POST a recurring offshore bill, and a report run before it would miss the bill it just created
    // and then wait a day. The window ends on the business day that has just closed, so running inside
    // trading hours would date the scan on a session that is not over yet.
    cron: '15 4 * * *',
    agent: 'reverse_charge_exceptions',
    retryLimit: 3,
    retryDelaySeconds: 60,
    retryBackoff: true,
    // One query over twelve months of bills plus one outbox insert. Five minutes is generous; a pass still
    // running past it is blocked on a lock rather than slow, and reclaiming it is the right answer.
    expireInSeconds: 300,
    handler: reverseChargeHandler,
  },
  {
    name: 'hr.credential-sweep',
    purpose:
      'Re-applies the credential gate to every FUTURE appointment and flags the ones whose therapist may ' +
      'no longer take them as needs_reassignment, clearing the flag again once the document is renewed. ' +
      'Never cancels and never unassigns. The availability query already refuses to OFFER a therapist ' +
      'whose mandatory credentials lapsed; this is the half that covers the bookings already in the ' +
      'diary, which nothing else in the system can see (P-HR-03, docs/04 §7).',
    // 04:45 Asia/Dubai, after trading closes at 02:00. Later than recurring-cost.check at 03:45 and
    // vat.reverse-charge-exceptions at 04:15, and deliberately not at the same minute as
    // seo.gsc-snapshot: the four nightly passes should not contend, and this one reads the whole future
    // diary. Inside trading hours it would judge the session that is still running, which is legal — the
    // window's floor is the trading date, not midnight — but it would also flag an appointment two hours
    // before the therapist turns up for it, which is the reassignment nobody can make.
    cron: '45 4 * * *',
    agent: CREDENTIAL_SWEEP_AGENT,
    retryLimit: 3,
    retryDelaySeconds: 60,
    retryBackoff: true,
    // One read of the future diary, one read of those therapists' documents, and two writes. Five
    // minutes is generous; a pass still running past it is blocked on a lock rather than slow, and the
    // flags are idempotent so reclaiming it cannot double-raise.
    expireInSeconds: 300,
    handler: credentialSweepHandler,
  },
  {
    name: 'hr.leave-accrual',
    purpose:
      'Monthly: accrues annual leave for every complete month that has no accrual row yet, from the ' +
      'employment date or the 24-month catch-up window, pro-rated for a part month and reduced by ' +
      'approved unpaid leave. The only thing in this system that adds to a leave balance; everything ' +
      'else reads one. Idempotent per (employee, accrual_month) by a partial unique index, so a second ' +
      'pass writes nothing and the balance — a view over the movements — cannot move (P-HR-08, ' +
      'docs/04 SS7).',
    // 05:00 Asia/Dubai on the 1st. After trading closes at 02:00 and after the four nightly passes at
    // 03:00, 03:45, 04:15 and 04:45, so nothing contends. Deliberately NOT inside 00:00-02:00: the
    // session in force then opened the previous day, which for the 1st of a month means the month being
    // accrued has not finished — `latestCompletedAccrualMonth` gets that right and would accrue the month
    // before, which is correct and a month late. Running after close removes the question.
    //
    // The day-of-month field is 1 and the pass is a CATCH-UP sweep, which is what makes one firing a
    // month safe: a missed month has no row, so the next run accrues it. A daily cron would reach the
    // same state and ask the database the same question 30 times for nothing.
    cron: '0 5 1 * *',
    agent: LEAVE_ACCRUAL_AGENT,
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: true,
    // Four reads over the roster and one insert. Ten minutes is generous for nineteen employees and two
    // years of catch-up; a pass still running past it is blocked on a lock rather than slow, and
    // reclaiming it cannot double-accrue because the unique index refuses the second row.
    expireInSeconds: 600,
    handler: leaveAccrualHandler,
  },
  {
    name: 'hr.gratuity-accrual',
    purpose:
      'Monthly: posts one balanced journal entry per employee for the DIFFERENCE between the ' +
      'end-of-service gratuity liability owed at the month end and what is already accrued (expense ' +
      'debit, liability credit). The only thing in this system that grows that liability. Idempotent per ' +
      '(employee, accrual_month) by a partial unique index, so a second pass posts no journal line and no ' +
      'accrual row. An accrual for a month whose accounting period has since been LOCKED still accrues ' +
      'and lands in the next open period naming the locked one, because ADR 0026 will not reopen a filed ' +
      'period. An unpriced employee, and one whose employment record is still provisional, are counted ' +
      'and NAMED rather than accrued at zero (P-HR-13, docs/04 SS7).',
    // 05:15 Asia/Dubai on the 1st. After trading closes at 02:00, after the four nightly passes at 03:00,
    // 03:45, 04:15 and 04:45, and fifteen minutes after the leave accrual at 05:00 — deliberately not at
    // the same minute as that pass, because both read the whole roster and both write into append-only
    // tables, and two passes contending for the same rows is a lock wait that presents as a slow job.
    //
    // Deliberately NOT inside 00:00-02:00: the session in force then opened the previous day, which for
    // the 1st of a month means the month being accrued has not finished. `latestCompletedAccrualMonth`
    // gets that right and would accrue the month before — correct, and a month late. Running after close
    // removes the question.
    //
    // The day-of-month field is 1 and the pass is a CATCH-UP sweep, which is what makes one firing a month
    // safe: a missed month has no accrual row, so the next run posts it.
    cron: '15 5 1 * *',
    agent: GRATUITY_ACCRUAL_AGENT,
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: true,
    // Five reads over the roster and one insert per employee-month. Ten minutes is generous for nineteen
    // employees and two years of catch-up; a pass still running past it is blocked on a lock rather than
    // slow, and reclaiming it cannot double-accrue because the partial unique index refuses the second row.
    expireInSeconds: 600,
    handler: gratuityAccrualHandler,
  },
  {
    name: 'package.expiry-sweep',
    purpose:
      'Daily: measures the packages whose validity has run out and what is still unreleased against ' +
      'them — the liability 2050 holds for entitlements nobody can draw on any more. Posts NOTHING: ' +
      '[UNVERIFIED] Y9-package-policy provisionally RETAINS an unredeemed balance, so the customer is ' +
      'still owed the treatments and moving 2050 into revenue would recognise money the business owes, ' +
      'on a VAT box, for a supply that has not happened. The measurement is what makes the question ' +
      'answerable; a sale sold under FORFEITED terms is refused rather than guessed at (M-TILL-10).',
    // 05:30 Asia/Dubai. After trading closes at 02:00, after the four nightly passes at 03:00, 03:45,
    // 04:15 and 04:45, and after the monthly accrual at 05:00 — nothing contends and the figure it reports
    // is a whole trading day behind it. Deliberately NOT inside 00:00-02:00: the session in force then
    // opened the previous day, so a package expiring at midnight would be reported live for one more pass.
    cron: '30 5 * * *',
    agent: PACKAGE_EXPIRY_AGENT,
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: true,
    // One read of a view and one audit insert. Sixty seconds is generous; a pass still running past it is
    // blocked on a lock rather than slow, and the pass writes nothing a reclaim could double.
    expireInSeconds: 60,
    handler: packageExpiryHandler,
  },
  {
    name: 'google-connection.health',
    purpose:
      'Forces a token refresh, makes one cheap read per granted capability, diffs granted scopes ' +
      'against required, re-resolves the stored placeId and compares the title and postal address ' +
      'against what the owner confirmed, reads Voice of Merchant, and writes last_ok_at plus ' +
      'per-capability health. Every invalidation in docs/10 §4 is silent; this is the thing that ' +
      'looks (G-CONN-06).',
    // 03:00 Asia/Dubai. After trading closes at 02:00 and at the same hour as audit.ensure-partitions,
    // which is the quietest point in the day — and a forced token refresh holds an advisory lock for the
    // length of an HTTPS call to Google, which is not something to do while the booking flow is busy.
    // Asia/Dubai is UTC+4 with no DST, so this is 23:00 UTC every night of the year; `registerJobs`
    // passes the zone to pg-boss rather than this file pre-computing an offset.
    cron: '0 3 * * *',
    agent: GOOGLE_HEALTH_AGENT,
    retryLimit: 3,
    retryDelaySeconds: 120,
    retryBackoff: true,
    // One forced refresh plus one read per capability per connection, each with a 10-second lock
    // timeout. Ten minutes is generous for the single connection this business has; a pass still running
    // past it is blocked rather than slow, and reclaiming it is the right answer.
    expireInSeconds: 600,
    handler: googleHealthHandler_,
  },
  {
    name: 'google-connection.liveness',
    purpose:
      'One cheap authenticated call per connection, so a revoked or expired grant is found within the ' +
      'hour rather than at 03:00 the following morning. Search Console first, because it is not behind ' +
      'the Business Profile application (G-CONN-06, docs/10 §9).',
    // Minute 0 of every hour. A separate agent from the deep check on purpose: sharing one heartbeat
    // would keep it minutes old for ever and make a dead daily pass invisible (migration 0033).
    cron: '0 * * * *',
    agent: GOOGLE_LIVENESS_AGENT,
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryBackoff: true,
    // One read per connection and no forced refresh. A minute is ample; the next pass is an hour away,
    // so a run that outlives its window is better reclaimed than left holding a connection.
    expireInSeconds: 120,
    handler: googleLivenessHandler_,
  },
  {
    name: 'seo.gsc-snapshot',
    purpose:
      'Mirrors the Search Console query report into seo_gsc_daily: a seven-day window ending at today ' +
      'minus 3, paged 25,000 rows at a time, with the rare-query gap stored as the difference between ' +
      'the query-level and page-level totals. The API keeps 16 months and discards the seventeenth, so ' +
      'this pass IS the history (G-SEO-01, docs/10 §7).',
    // 04:45 Asia/Dubai. After trading closes at 02:00, and after the Google health check at 03:00 —
    // deliberately, because that pass forces a token refresh and records a dead grant: a snapshot that
    // ran first would be the thing that discovered it, an hour before the job whose purpose is to. It is
    // also after 03:45 and 04:15, so the four nightly passes do not contend for the same connections.
    // Asia/Dubai is UTC+4 with no DST; `registerJobs` passes the zone to pg-boss rather than this file
    // pre-computing an offset.
    cron: '45 4 * * *',
    agent: SEO_GSC_SNAPSHOT_AGENT,
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: true,
    // Two paged fetches plus up to sixty upsert statements. Twenty minutes is generous for a property this
    // size; a pass still running past it is blocked rather than slow, and reclaiming it is right — the
    // window overlaps the next six nights, so a lost pass repairs itself.
    expireInSeconds: 1200,
    handler: gscSnapshotHandler_,
  },
  {
    name: 'seo.url-inspection',
    purpose:
      'Inspects a rotating priority subset of URLs inside the 2,000-a-day per-site cap, ordered by the ' +
      'persisted cursor so every candidate is covered before any is re-inspected. The cap belongs to Google ' +
      'and cannot be raised, so the rotation is the feature (G-SEO-01, docs/10 §7).',
    // 05:30 Asia/Dubai, after the snapshot at 04:45 that registers its candidates. Running first would
    // rotate over yesterday's candidate list — which is only wrong on the first night after a new page
    // starts earning impressions, and that is exactly the page worth inspecting soonest.
    cron: '30 5 * * *',
    agent: SEO_URL_INSPECTION_AGENT,
    retryLimit: 3,
    retryDelaySeconds: 300,
    retryBackoff: true,
    // Up to 2,000 sequential inspections. Thirty minutes at a modest rate; a retry after that reads the
    // day ledger and takes only the remainder of the cap, so a reclaimed pass cannot double-spend.
    expireInSeconds: 1800,
    handler: gscUrlInspectionHandler_,
  },
  // Y-PAY-05's hourly reconciliation, and the one payments cron in this registry. Hourly rather than
  // nightly because the gap between a lost capture and its repair is a window in which an invoice reads
  // unpaid and a customer is chased for money they have already handed over. It has an agent, because
  // every cron does — and what the watchdog watches here is the ABSENCE of a success: a reconciliation
  // that stopped running is invisible in every other way, since its output in the healthy case is
  // nothing at all.
  PAYMENT_RECONCILIATION_JOB_DEFINITION,
  // Y-PAY-09's settlement import, and the third queue in this registry with no cron. A payout file is
  // DELIVERED; a schedule here would be a poller looking for work whatever accepted the file already
  // announced, and it would either run constantly doing nothing or leave a payout unimported until it next
  // fired. So no `agent_definition` either — `assertRegistry` demands one only for a cron, because what
  // G-AGT-01 watches is a schedule nobody is looking at. Y-PAY-05's reconciliation job is the one with a
  // cron, and it brings its own agent row in its own migration.
  SETTLEMENT_IMPORT_JOB_DEFINITION,
  // A queue with no cron, and therefore no agent. W-SYS-05: a derivative build is announced by the
  // upload that produced the original, so the thing being watched is the request that accepted the file.
  BUILD_DERIVATIVES_JOB,
  // W-SYS-06, and the same shape again: a hero video master is written to the private bucket by the
  // request that accepted it, and that request enqueues this. Separate from the image build rather than a
  // branch inside it — four ffmpeg encodes at `veryslow` need an hour of `expireInSeconds` where
  // twenty-four sharp encodes need ten minutes, and one queue cannot hold both ceilings.
  BUILD_VIDEO_RENDITIONS_JOB,
  // The same shape, for the same reason. B-MSG-04: a delivery receipt is announced by the vendor's
  // webhook, so a cron here would be a poller looking for work an enqueue already announced.
  RECONCILE_DLR_JOB,
  // And again. G-CONN-09: an unconfirmed revocation is announced by the disconnect that could not finish
  // it, and the *row* is the work item rather than the job — `status_reason = 'revoke_failed'` with a
  // retained ciphertext, a pair migration 0040 guarantees — so the sweep is safe to reclaim, safe to
  // repeat and healthy when it finds nothing.
  GOOGLE_REVOKE_RETRY_JOB,
  // B-MSG-03's three. The SWEEP is the only one with a cron, and its fifteen minutes is
  // `reminder_scheduler`'s declared interval in 0021 rather than a number picked here — the watchdog's
  // "no success within twice the interval" alert is only meaningful when the two agree.
  //
  // The other two are announced: a due step by the sweep, and a rebuild by the settings change that made
  // the old plan wrong (the F09 registry's `rerunJobs` on `booking.reminder_offsets_hours`). Neither is a
  // poller, so neither declares an agent — the thing being watched is the sweep, and the caller.
  SCHEDULED_STEP_SWEEP_JOB,
  SEND_SCHEDULED_STEP_JOB,
  REBUILD_SCHEDULED_STEPS_JOB,
  // M-VAT-11's three, and the same arrangement one more time. The CALENDAR is the only one with a cron,
  // and its 02:30 is after trading closes at 02:00 rather than a number picked for tidiness: inside
  // trading hours the compliance calendar's as-of date is still the previous trading date, so a pass that
  // ran at 23:00 would plan tomorrow's notices against yesterday. Its declared interval in 0060 is 24
  // hours, which is what makes the watchdog's "no success within twice the interval" alert mean something.
  //
  // The other two are announced: a due notice by the calendar pass, and a rebuild by the settings change
  // that made the old plan wrong (the F09 registry's `rerunJobs` on both compliance ladder keys). Neither
  // is a poller, so neither declares an agent — the thing being watched is the calendar, and the caller.
  COMPLIANCE_CALENDAR_JOB,
  SEND_OBLIGATION_NOTICE_JOB,
  REBUILD_OBLIGATION_NOTICES_JOB,
  // C-CRM-10's retention purge. 05:15, after trading closes at 02:00 and after the other three nightly
  // passes, because the nightly work should not contend and this one takes row locks on tables the booking
  // path writes to. Its declared interval in 0085 is 24 hours, which is what makes the watchdog's "no
  // success within twice the interval" alert mean something for it.
  RETENTION_PURGE_JOB_DEFINITION,
  // C-AUTO-07's one queue, and the same shape again: a tick is ANNOUNCED — by the enrolment that started
  // the run, by the previous tick's own delay, or by the instant the GATE named when it held a message —
  // so a cron here would be a poller looking for work an enqueue already named. No cron therefore no
  // agent: what is watched is the caller. The run row is the durable record of where a flow got to, so a
  // worker outage is self-healing in the same way B-MSG-03's `scheduled_step` rows are — nothing moved,
  // and `flow_run.resume_at` says what was owed.
  FLOW_TICK_JOB,
  // A-FIRST-01's two, and they are the other half of what `audit.ensure-partitions` does for `audit_event`.
  // Partition creation at 03:20 and retention at 05:50, each with its OWN agent: sharing one heartbeat
  // between them would keep it fresh while one of the two was dead (0033's reason). Neither is announced by
  // a caller — they are obligations of the STORAGE rather than of anything a request did — so each declares
  // a cron and therefore an agent, and what the watchdog watches is the absence of a success.
  ANALYTICS_PARTITIONS_JOB_DEFINITION,
  ANALYTICS_RETENTION_JOB_DEFINITION,
  // G-REV-02's two, and they are the first crons in this registry whose subject is something that happened
  // OUTSIDE the system. The tripwire at 06:15 reads the Places aggregate and reports an increase; the nudge at
  // 09:00 on a Monday reports a week of silence. Separate agents rather than one, for migration 0033's reason:
  // a shared heartbeat would be minutes old for ever and would make a dead weekly pass invisible behind a
  // healthy daily one. Their declared intervals in 0094 are 24 hours and 7 days respectively, which is what
  // makes the watchdog's "no success within twice the interval" alert mean something for each.
  REVIEW_COUNT_TRIPWIRE_JOB,
  REVIEW_MONDAY_NUDGE_JOB,
  // R-REP-01's nightly reporting refresh at 03:55, and it is the first cron here whose subject is a CACHE
  // rather than a record: nothing in the `reporting` schema states a fact of its own, so a pass that stops
  // running breaks nothing and reports nothing — which is why it writes a `reporting.refresh_run` row per
  // view per night even when a view comes back empty, and why R-REP-07 reads that table rather than a
  // heartbeat to decide whether a tile may render a number. One agent and one cron: refreshing seven views
  // is one obligation with one snapshot, and splitting it would be seven heartbeats for one pass.
  REPORTING_REFRESH_JOB_DEFINITION,
  // R-REP-06's weekly 13-week cash forecast at 04:37 on a Sunday, after that refresh because its
  // seasonality half reads `reporting.dim_date`. WEEKLY and not nightly, because the artefact is a weekly
  // horizon: thirteen windows that only move on the day the first one does, so a nightly pass would
  // re-log almost the same thing six times and bury the one that changed. It writes nothing at all (ADR
  // 0064's argument for the statements, inherited), so what the cron buys is that the figures this build
  // REFUSES to produce are seen rather than silently rendered as zero (ADR 0073).
  CASH_FORECAST_JOB_DEFINITION,
  // A-MEAS-03's dispatch consumer at every fifth minute, and the first cron here whose subject is an
  // OUTBOUND queue rather than a report or a sweep. A cron and not a queue the enqueue announces, which is
  // the opposite of what BUILD_DERIVATIVES_JOB and RECONCILE_DLR_JOB chose: a dispatch is a row the consent
  // gate left in `queued`, and the reasons it is still there include "the far end was down for an hour"
  // and "the consumer stopped" — neither of which an announcement can cover, because the announcement
  // already happened. What has to be watched is the absence of a drain. Its declared interval in 0137 is
  // 300 seconds, which is what makes the watchdog's "no success within twice the interval" mean something.
  ANALYTICS_DISPATCH_JOB_DEFINITION,
  // A-MEAS-05's producer, nightly at 03:17 — after trading closes at 02:00, so the trading date it uploads
  // is COMPLETE. A conversion is not a figure that can be topped up: it is a new statement with its own
  // event_id, so a pass over a day still in progress would upload the evening as a correction to the
  // morning. It reports to `analytics_dispatch`' agent rather than declaring a second one, because the two
  // passes are one pipeline — and the limit of sharing is stated in the job's own header and handed to
  // A-MEAS-06, which owns the heartbeat and the watchdog for this dispatcher.
  OFFLINE_CONVERSIONS_JOB_DEFINITION,
  // A-MEAS-07's reconciliation at 04:23, AFTER the 03:17 upload and after the five-minute consumer has had
  // time to drain it. The ordering is the design: a reconciliation that ran before the upload would report
  // every offline conversion as missing, which is the same failure ZY472 refuses for a day that is still
  // open. Its own agent and its own heartbeat row (0138), because a reconciliation nobody ran looks
  // exactly like one that found nothing.
  DISPATCH_RECONCILIATION_JOB_DEFINITION,
]

/**
 * The watchdog's own handler, and the alert ladder's pass.
 *
 * It watches itself, which is not circular in the way it first looks: if this job stops running, its own
 * heartbeat goes stale and no pass raises the alert — so something outside this process has to notice,
 * which is the alerting ladder in H-HARD-05. What G-AGT-01 guarantees is that the evidence exists and is
 * a row rather than a log line nobody reads.
 *
 * **H-HARD-05's pass runs here, in the same handler, and that is a decision rather than convenience.**
 * `ALERT_REGISTRY` is the alerting ladder's table and `runAlertEvaluation` is what reads it; giving it a
 * cron of its own would have meant a new `agent_definition` row, which is a migration (0021 says so in as
 * many words: adding an agent is a reviewable act and not a row somebody inserted on production), and
 * H-HARD-05 holds no migration number. The alternative to a new agent row is not "no agent row" — a cron
 * with no agent is refused by `pnpm jobs`, because a cron nobody watches is the failure G-AGT-01 exists
 * to remove. So the pass runs inside the one job whose subject is already *finding what nothing is
 * looking at*, and inherits its declared interval, its budget and its heartbeat.
 *
 * The two results are reported separately and the alert pass runs even when the watchdog raised nothing:
 * they measure different things, and an exception from one must not discard the other's findings, which
 * is why each is awaited on its own line rather than in a `Promise.all`.
 */
async function watchdogHandler(_data: never, context: JobContext): Promise<void> {
  const sql = maintenanceSql
  if (sql === undefined) {
    throw new AppError(
      'invariant_violated',
      'The watchdog ran before setMaintenanceSql() supplied a connection. run.ts calls it before ' +
        'startWorkers().',
    )
  }
  const now = instantFromIso(context.now())
  const result = await runWatchdog(sql, now)
  if (result.raised.length > 0) {
    console.warn(
      `agent watchdog raised ${result.raised.length} alert(s): ${result.raised.join(', ')}`,
    )
  }
  const alerts = await runAlertEvaluation(sql, now)
  if (alerts.raised.length > 0) {
    console.warn(`alert ladder raised ${alerts.raised.length}: ${alerts.raised.join(', ')}`)
  }
  // A threshold nobody can read is louder than a firing alert, because it means the pass cannot answer
  // the question at all for that condition — and the one outcome that must never be reachable is a
  // corrupt setting reading as all-clear.
  if (alerts.faulted.length > 0) {
    console.error(
      `alert ladder could not read the threshold for: ${alerts.faulted.join(', ')}. Those conditions ` +
        'were NOT evaluated and are not clear.',
    )
  }
}

/**
 * The two Google passes' handlers.
 *
 * Each loads its own configuration and opens its own connection rather than using `maintenanceSql`, and
 * that is deliberate: a forced token refresh holds an advisory transaction lock for the duration of an
 * HTTPS call to Google, and a four-connection pool shared with the audit partition job is how one slow
 * Google call becomes `53300 too_many_connections` for something unrelated (G-CONN-04's `lock_timeout`
 * note). The instant comes from the job context so the pass never reads the clock itself.
 */
async function googleHealthHandler_(_data: never, context: JobContext): Promise<void> {
  await googleHealthHandler(googleConfig(), context.now(), context.jobId)
}

async function googleLivenessHandler_(_data: never, context: JobContext): Promise<void> {
  await googleLivenessHandler(googleConfig(), context.now(), context.jobId)
}

/**
 * The two SEO passes' handlers.
 *
 * Each opens its own connection for the same reason the Google health passes do: a token refresh holds an
 * advisory transaction lock for the length of an HTTPS call, and a 60,000-row upsert holds a connection for
 * sixty statements. Sharing the four-connection maintenance pool is how one slow pass becomes
 * `53300 too_many_connections` for the audit partition job.
 */
async function gscSnapshotHandler_(_data: never, context: JobContext): Promise<void> {
  await gscNightlySnapshotHandler(googleConfig(), context.now(), context.jobId)
}

async function gscUrlInspectionHandler_(_data: never, context: JobContext): Promise<void> {
  await gscUrlInspectionHandler(googleConfig(), context.now(), context.jobId)
}

/**
 * Configuration for the Google handlers.
 *
 * Read per run rather than captured at import, because `GOOGLE_PROVIDER` decides whether this pass talks
 * to a stand-in — and a value captured at boot would survive a restart-free configuration change while
 * the log line went on claiming a real check.
 */
function googleConfig(): Config {
  return loadConfig()
}

/**
 * The recurring cost register's pass.
 *
 * Thin on purpose: the business day is resolved and the three steps are taken by
 * `runRecurringCostCheck`, which takes its instant as an argument so the integration suite can drive it
 * at the frozen clock. What this wrapper adds is the connection and the log line — and the log line
 * reports the count of alerts *newly* raised, which on a healthy register is zero every night. Zero is
 * the evidence, not the silence: the alert rows are what a reader looks at.
 */
async function recurringCostHandler(_data: never, context: JobContext): Promise<void> {
  const sql = maintenanceSql
  if (sql === undefined) {
    throw new AppError(
      'invariant_violated',
      'The recurring cost check ran before setMaintenanceSql() supplied a connection. run.ts calls it ' +
        'before startWorkers().',
    )
  }
  const result = await runRecurringCostCheck(sql, context.now())
  console.log(
    `recurring-cost.check ${result.asOf}: ${result.generated} period(s) generated, ` +
      `${result.raised.length} alert(s) raised`,
  )
}

/**
 * The credential sweep's pass.
 *
 * Thin for the same reason the two above are: the window and the trading date are resolved by
 * `runCredentialSweep`, which takes its instant as an argument so the integration suite can drive it at a
 * frozen clock and ask it the one question a job reading `new Date()` cannot be asked — whether the second
 * run of the same day flags anything. The log line reports both counts because a night with nothing to do
 * is the normal night: a pass that logged only when it flagged something would be indistinguishable from a
 * pass that had stopped running, which is docs/10 §6's failure and the reason `agent_heartbeat` exists.
 */
async function credentialSweepHandler(_data: never, context: JobContext): Promise<void> {
  const sql = maintenanceSql
  if (sql === undefined) {
    throw new AppError(
      'invariant_violated',
      'The credential sweep ran before setMaintenanceSql() supplied a connection. run.ts calls it ' +
        'before startWorkers().',
    )
  }
  const result = await runCredentialSweep(sql, context.now())
  console.log(
    `hr.credential-sweep ${result.asOf}: ${result.considered} future appointment(s) considered, ` +
      `${result.flagged.length} flagged, ${result.cleared.length} cleared`,
  )
}

/**
 * The monthly leave accrual pass.
 *
 * Thin, like the sweeps above: which month has completed is resolved by `runLeaveAccrual` from
 * `business_day`, and it takes its instant as an argument so the integration suite can drive it at a
 * frozen clock and ask the one question a job reading `new Date()` cannot be asked — whether the second
 * run of the same month writes anything. The log line reports the employees considered as well as the
 * accruals written, because a month where everybody already has their row is the normal second run: a
 * pass that logged only when it wrote something would be indistinguishable from a pass that had stopped,
 * which is docs/10 SS6's failure and the reason `agent_heartbeat` exists.
 */
async function leaveAccrualHandler(_data: never, context: JobContext): Promise<void> {
  const sql = maintenanceSql
  if (sql === undefined) {
    throw new AppError(
      'invariant_violated',
      'The leave accrual pass ran before setMaintenanceSql() supplied a connection. run.ts calls it ' +
        'before startWorkers().',
    )
  }
  const result = await runLeaveAccrual(sql, context.now())
  console.log(
    `hr.leave-accrual through ${result.throughMonth}: ${result.considered} employee(s) considered, ` +
      `${result.written.length} accrual(s) written, ${result.accruedHundredths} day-hundredths added`,
  )
}

/**
 * The monthly gratuity accrual pass.
 *
 * Thin, like the sweeps around it: `runGratuityAccrual` resolves the trading session and the month from the
 * instant this passes it, so the integration suite can drive it at a frozen clock and ask the one question a
 * job reading `new Date()` cannot be asked — whether a second run of the same month posts anything.
 *
 * **The log line reports the EXCLUSIONS, and that is the half that matters.** A roster where every employee
 * is unpriced or still provisional accrues nothing, which is the correct answer and is indistinguishable
 * from a pass that has stopped — and the figure it is hiding is a balance-sheet liability rather than a
 * report nobody reads. So the counts are printed even when the accrual count is zero, which is docs/10 §6's
 * reasoning and the reason `agent_heartbeat` exists. The over-accrual list is printed for the same reason
 * one step along: those employees need a human to decide which figure was wrong, and a pass that noticed
 * silently would leave the liability overstated indefinitely.
 */
async function gratuityAccrualHandler(_data: never, context: JobContext): Promise<void> {
  const sql = maintenanceSql
  if (sql === undefined) {
    throw new AppError(
      'invariant_violated',
      'The gratuity accrual pass ran before setMaintenanceSql() supplied a connection. run.ts calls it ' +
        'before startWorkers().',
    )
  }
  const result = await runGratuityAccrual(sql, context.now())
  const excluded = result.excluded.length
  const unpriced = result.excluded.filter((e) => e.reason === 'unpriced').length
  console.log(
    `hr.gratuity-accrual through ${result.throughMonth}: ${result.considered} employee(s) considered, ` +
      `${result.written.length} accrual(s) posted, ${result.accruedFils} fils added, ` +
      `${excluded} excluded (${unpriced} unpriced, ${excluded - unpriced} provisional employment ` +
      `record), ${result.rebasedMonths.length} month(s) rebased past a locked period` +
      (result.overAccrued.length === 0
        ? ''
        : `; OVER-ACCRUED and needing a correction: ${result.overAccrued.join(', ')}`),
  )
}

/**
 * The package expiry sweep.
 *
 * Thin, like the sweeps above: the business date is resolved inside `runPackageExpirySweep` from the instant
 * this passes it, so the integration suite can drive it at a frozen clock and ask what the sweep saw on a
 * given day. What this wrapper adds is the connection and the log line.
 *
 * The log line reports the figure even when it is ZERO, and that is the point rather than noise: this pass
 * posts nothing, so its only visible output is the audit row and this line. A pass that logged only when
 * there was exposure would be indistinguishable from a pass that had stopped, which is docs/10 §6's failure
 * and the reason `agent_heartbeat` exists.
 */
async function packageExpiryHandler(_data: never, context: JobContext): Promise<void> {
  const sql = maintenanceSql
  if (sql === undefined) {
    throw new AppError(
      'invariant_violated',
      'The package expiry sweep ran before setMaintenanceSql() supplied a connection. run.ts calls it ' +
        'before startWorkers().',
    )
  }
  const result = await runPackageExpirySweep(sql, PACKAGE_EXPIRY_ACTOR, context.now())
  console.log(
    `package.expiry-sweep as at ${result.asAt}: ${result.exposure.expired.length} expired sale(s), ` +
      `${result.exposure.unreleasedFils} fils still unreleased, ` +
      `${result.journalEntriesPosted} journal entries posted (Y9-package-policy: balance RETAINED)`,
  )
}

/**
 * The reverse-charge exception report's pass.
 *
 * Thin, like the recurring register's: the business day and the window are resolved by
 * `runReverseChargeExceptionReport`, which takes its instant as an argument so the integration suite can
 * drive it at a frozen clock. What this wrapper adds is the connection and the log line — and the log line
 * reports the count, which on a healthy ledger is zero every night. Zero is the evidence, not the silence:
 * the outbox row is what a reader looks at, and one is written on every pass.
 */
async function reverseChargeHandler(_data: never, context: JobContext): Promise<void> {
  const sql = maintenanceSql
  if (sql === undefined) {
    throw new AppError(
      'invariant_violated',
      'The reverse-charge exception report ran before setMaintenanceSql() supplied a connection. run.ts ' +
        'calls it before startWorkers().',
    )
  }
  const result = await runReverseChargeExceptionReport(sql, context.now())
  const summary =
    result.exceptions.length === 0
      ? 'no exceptions'
      : result.exceptions.map((row) => `${row.reference} ${row.kind}`).join(', ')
  console.log(
    `vat.reverse-charge-exceptions ${result.from}..${result.asOf}: ` +
      `${result.exceptions.length} exception(s) — ${summary}`,
  )
}

/**
 * A handler that runs one statement.
 *
 * The statement is a constant from `MAINTENANCE_JOBS`, never job data — a handler that interpolated
 * `data.sql` would be a queue anybody who can enqueue can execute arbitrary SQL through, and a queue is
 * reachable from every feature in the system.
 */
function maintenanceHandler(statement: string): JobHandler<never> {
  return async () => {
    const sql = maintenanceSql
    if (sql === undefined) {
      throw new AppError(
        'invariant_violated',
        'A maintenance job ran before setMaintenanceSql() supplied a connection. ' +
          'run.ts calls it before startWorkers().',
      )
    }
    await sql.unsafe(statement)
  }
}

let maintenanceSql: Sql | undefined

/**
 * Hands the maintenance handlers their database connection.
 *
 * A module-level binding rather than a parameter threaded through `JobDefinition`, because the registry
 * is a module constant that G-AGT-01's completeness gate imports and enumerates *without* a database —
 * making the handler's dependency a constructor argument would make the registry a function, and then
 * "every cron is declared here" stops being checkable statically.
 */
export function setMaintenanceSql(sql: Sql): void {
  maintenanceSql = sql
}

export interface RegisterResult {
  readonly queues: readonly string[]
  readonly schedules: readonly string[]
}

/**
 * Creates every queue and schedules every cron in the registry, and unschedules anything it does not
 * declare.
 *
 * The unschedule half is the part that matters on a redeploy. `boss.schedule` is an upsert, so a job
 * removed from the registry keeps firing from the old row forever — a cron nothing in the codebase
 * mentions, which is the worst kind to debug.
 */
export async function registerJobs(
  boss: PgBoss,
  jobs: readonly JobDefinition<never>[] = JOB_REGISTRY,
): Promise<RegisterResult> {
  assertRegistry(jobs)

  for (const job of jobs) {
    // The dead-letter queue first: `createQueue` validates that the queue named in `deadLetter` already
    // exists and throws if it does not, so the obvious order fails on a fresh database.
    await boss.createQueue(deadLetterFor(job.name))
    await boss.createQueue(job.name, {
      retryLimit: job.retryLimit,
      retryDelay: job.retryDelaySeconds,
      retryBackoff: job.retryBackoff,
      expireInSeconds: job.expireInSeconds,
      deadLetter: deadLetterFor(job.name),
    })
  }

  const declared = new Set(jobs.filter((job) => job.cron !== undefined).map((job) => job.name))
  for (const existing of await boss.getSchedules()) {
    if (!declared.has(existing.name)) await boss.unschedule(existing.name)
  }

  for (const job of jobs) {
    if (job.cron === undefined) continue
    await boss.schedule(job.name, job.cron, null, { tz: SCHEDULE_TIMEZONE })
  }

  return {
    queues: jobs.map((job) => job.name),
    schedules: [...declared],
  }
}

/**
 * A job's dead-letter queue.
 *
 * Every job has one, unconditionally. pg-boss's default is to leave an exhausted job in the `failed`
 * state, where it is a row in a table nobody reads — docs/10 §6 states the rule plainly: a pg-boss job
 * failure is not evidence anybody has seen, because nobody reads `pgboss.job`. A dead-letter queue is a
 * place a watchdog can look.
 */
export function deadLetterFor(name: string): string {
  return `${name}-dead-letter`
}

/** Attaches every handler in the registry to its queue. */
export async function startWorkers(
  boss: PgBoss,
  now: () => string,
  jobs: readonly JobDefinition<never>[] = JOB_REGISTRY,
): Promise<void> {
  for (const job of jobs) {
    await boss.work<never>(job.name, async (received: readonly Job<never>[]) => {
      const first = received[0]
      if (first === undefined) return
      await job.handler(first.data, { jobId: first.id, now })
    })
  }
}

/** The cron registrations, for G-AGT-01's registry-completeness gate. */
export function cronRegistrations(
  jobs: readonly JobDefinition<never>[] = JOB_REGISTRY,
): readonly { name: string; cron: string; agent: string | undefined }[] {
  return jobs
    .filter((job) => job.cron !== undefined)
    .map((job) => ({ name: job.name, cron: job.cron as string, agent: job.agent }))
}
