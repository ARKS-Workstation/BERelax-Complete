import { loadConfig } from '@berelax/config'
import { ASIA_DUBAI, createRunBudget, type Instant, toLocal } from '@berelax/core'
import {
  type AgentOutcome,
  countReviewsReportedBetween,
  createConnection,
  listReviewIntakeTargets,
  type Sql,
  withAgentRun,
} from '@berelax/db'
import { placeReviewsDeepLink } from '@berelax/google'
import {
  AppError,
  REVIEW_FALLBACK_TEMPLATE_KEYS,
  REVIEW_MONDAY_NUDGE_AGENT,
  REVIEW_NUDGE_LOOKBACK_DAYS,
} from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'
import {
  NO_OWNER_CONTACT_ON_FILE,
  PROVISIONAL_EMAIL_SENDER,
  type ReviewNoticeNotifier,
  type ReviewNoticeRecipientResolver,
  reviewNoticeNotifierFor,
} from './review-notice-sender.ts'

/**
 * The Monday 09:00 Asia/Dubai nudge (G-REV-02, docs/10 §6).
 *
 * *"A Monday 09:00 nudge with a direct link, if nothing has been reported. Low tech, and it turns an invisible
 * task into a habit."* The whole of the design, and three things in it are decisions:
 *
 * **09:00 in Asia/Dubai, not in UTC.** Asia/Dubai is UTC+4 with no DST, so the cron `0 9 * * 1` fires at 05:00
 * UTC — and the same expression read as UTC would fire at 13:00 local, in the middle of the working day
 * instead of at the start of it. The zone is not this file's to apply: `registerJobs` passes
 * `SCHEDULE_TIMEZONE` to pg-boss, and this file states the expression once. There is deliberately NO
 * wall-clock guard inside the pass — a second statement of the schedule is a second thing to keep in step
 * with the cron, and it would drift. `review-monday-nudge.test.ts` asserts the expression, the zone and the
 * instant those two produce, which is the claim without the duplicate.
 *
 * **"Nothing has been reported" means no `google_reviews` row was created in the window.** Defined once, in
 * `countReviewsReportedBetween`. An unresolved `needs_paste` intake item is deliberately NOT a report: it is a
 * review that is still unrecorded, which is a reason to nudge rather than a reason to stay quiet — dealing
 * with it is exactly the work the nudge exists to prompt.
 *
 * **The heartbeat is written either way.** `withAgentRun` records the attempt and the heartbeat whatever the
 * body decides, so *"a quiet Monday"* and *"the worker did not run on Monday"* are different facts with
 * different rows. That asymmetry is the whole of G-AGT-01's contract, and it is why the not-fired branch is a
 * successful run rather than an early return before the wrapper.
 */

export type MondayNudgeOutcome =
  /** Something was reported in the window, so there is nothing to nudge about. */
  | { readonly kind: 'reported_recently'; readonly reported: number }
  /** Nothing reported, and no address to tell anybody. The shipped state — see the sender module. */
  | { readonly kind: 'no_recipient_on_file' }
  /** Nothing reported, an address, and a send the choke point would not make. */
  | { readonly kind: 'send_refused'; readonly reason: string }
  | {
      readonly kind: 'nudged'
      /** `null` when F03's staging guard diverted the send, which off production is ordinary. */
      readonly messageId: string | null
    }

export interface MondayNudgePassResult {
  readonly connectionId: string
  readonly placeId: string
  /** The window that was examined, so a result can be read without recomputing it. */
  readonly sinceIso: string
  readonly untilIso: string
  readonly outcome: MondayNudgeOutcome
}

export interface MondayNudgeDeps {
  readonly sql: Sql
  readonly notifier: ReviewNoticeNotifier
  readonly recipientFor: ReviewNoticeRecipientResolver
  /** The instant of the pass, injected. Every assertion about this job is made on a frozen clock. */
  readonly now: Instant
  /** pg-boss's job id, when there is one. Recorded on the `agent_run` row. */
  readonly jobId?: string
}

export interface MondayNudgePass {
  /** What `withAgentRun` recorded. `succeeded` even when the pass decided to stay quiet. */
  readonly runOutcome: AgentOutcome
  readonly results: readonly MondayNudgePassResult[]
}

/** Milliseconds in the lookback window. Derived from the one constant, never restated as a number. */
export const NUDGE_WINDOW_MS = REVIEW_NUDGE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000

/**
 * One pass over every listing the fallback intake is about.
 *
 * The window is `[now - 7 days, now)` as INSTANTS rather than as dates. A date window would need a zone and a
 * trading-date resolution, and neither is what this question is about: "has anything been reported in the last
 * seven days" is about elapsed time, and 09:00 Monday to 09:00 Monday is exactly seven days whatever the
 * calendar did in between.
 */
export async function runReviewMondayNudge(deps: MondayNudgeDeps): Promise<MondayNudgePass> {
  const results: MondayNudgePassResult[] = []
  // The wrapper is INSIDE the pass rather than around it in the handler, which is the arrangement
  // `runGscNightlySnapshot` takes and for the same reason: *"writes a heartbeat either way"* is a claim about
  // this function, so it has to be a claim a test driving this function can make. With the wrapper in the
  // handler, the only thing a test could assert was that `withAgentRun` works — which is G-AGT-01's claim and
  // not this unit's.
  const run = await withAgentRun(
    deps.sql,
    {
      agentKey: REVIEW_MONDAY_NUDGE_AGENT,
      startedAtIso: new Date(deps.now).toISOString(),
      ...(deps.jobId === undefined ? {} : { jobId: deps.jobId }),
    },
    async () => {
      results.push(...(await nudgeEveryListing(deps)))
    },
    createRunBudget,
  )
  return { runOutcome: run.outcome, results }
}

/** The decision, per listing. Separated so the wrapper above has one body and this has one subject. */
async function nudgeEveryListing(deps: MondayNudgeDeps): Promise<readonly MondayNudgePassResult[]> {
  const untilIso = new Date(deps.now).toISOString()
  const sinceIso = new Date(deps.now - NUDGE_WINDOW_MS).toISOString()
  const results: MondayNudgePassResult[] = []

  for (const target of await listReviewIntakeTargets(deps.sql)) {
    const reported = await countReviewsReportedBetween(deps.sql, {
      connectionId: target.connectionId,
      placeId: target.placeId,
      sinceIso,
      untilIso,
    })
    const window = { sinceIso, untilIso }
    if (reported > 0) {
      results.push({ ...target, ...window, outcome: { kind: 'reported_recently', reported } })
      continue
    }
    const recipient = deps.recipientFor()
    if (recipient === null || recipient.trim() === '') {
      results.push({ ...target, ...window, outcome: { kind: 'no_recipient_on_file' } })
      continue
    }
    const outcome = await deps.notifier.notify({
      deepLink: placeReviewsDeepLink(target.placeId),
      // Keyed on the listing and the local DATE of the pass, so a reclaimed job on the same Monday computes
      // the same key: the fake derives the same provider message id from it and `message_provider_id_unique`
      // refuses the second row. There is no reading row to key on here — unlike the tripwire, this pass
      // writes none — and the date is the only thing that distinguishes one nudge from the next.
      idempotencyKey: `review-nudge-${target.placeId}-${toLocal(deps.now, ASIA_DUBAI).date}`,
      recipient: recipient.trim(),
    })
    results.push({
      ...target,
      ...window,
      outcome:
        outcome.kind === 'refused'
          ? { kind: 'send_refused', reason: outcome.reason }
          : { kind: 'nudged', messageId: outcome.messageId },
    })
  }
  return results
}

/**
 * `0 9 * * 1` — Monday, 09:00, in the zone `registerJobs` passes to pg-boss.
 *
 * Exported so the test asserts the expression this job actually declares rather than its own copy of it.
 */
export const REVIEW_MONDAY_NUDGE_CRON = '0 9 * * 1'

export const REVIEW_MONDAY_NUDGE_JOB: JobDefinition = {
  name: 'review.monday-nudge',
  purpose:
    'At 09:00 Asia/Dubai on a Monday, emails the owner a direct link to their reviews if nothing has been ' +
    'reported in the preceding seven days. Low tech, and it turns an invisible task into a habit ' +
    '(docs/10 SS6). Writes its heartbeat whether or not it sends, because a quiet Monday and a worker that ' +
    'did not run are different facts.',
  // 09:00 Asia/Dubai on a Monday, which is 05:00 UTC every week of the year (UTC+4, no DST). Deliberately
  // INSIDE nobody's nightly window and deliberately not at 08:00 or 09:30: the owner is at the salon before
  // it opens at 11:00, and a nudge that arrives while they are not is a nudge that is read as a summary.
  cron: REVIEW_MONDAY_NUDGE_CRON,
  agent: REVIEW_MONDAY_NUDGE_AGENT,
  retryLimit: 3,
  retryDelaySeconds: 300,
  retryBackoff: true,
  // One count query and at most one email per listing. Sixty seconds is generous; a pass still running past it
  // is blocked rather than slow, and reclaiming it is safe because the idempotency key is derived from the
  // listing and the local date, so the second send is refused by `message_provider_id_unique`.
  expireInSeconds: 60,
  handler: mondayNudgeHandler,
}

/**
 * The handler: the only thing here that reads a real clock, and it reads it once.
 *
 * `withAgentRun` writes the heartbeat on every outcome, which is the acceptance line's *"writes a heartbeat
 * either way"* — and it is why the not-fired branch is a completed run rather than an early return.
 */
async function mondayNudgeHandler(_data: unknown, context: JobContext): Promise<void> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    const startedAtIso = context.now()
    const pass = await runReviewMondayNudge({
      sql,
      notifier: reviewNoticeNotifierFor(sql, config, {
        from: PROVISIONAL_EMAIL_SENDER,
        templateKey: REVIEW_FALLBACK_TEMPLATE_KEYS.mondayNudge,
        now: () => context.now(),
      }),
      recipientFor: NO_OWNER_CONTACT_ON_FILE,
      now: Date.parse(startedAtIso) as Instant,
      jobId: context.jobId,
    })
    if (pass.runOutcome === 'failed' || pass.runOutcome === 'budget_exceeded') {
      // Re-thrown so pg-boss retries with backoff. The run row and the heartbeat are already written, which
      // is the point: a failed pass is visible whether or not anybody reads `pgboss.job`.
      throw new AppError(
        'provider_unavailable',
        `The Monday review nudge failed: the run was recorded as ${pass.runOutcome}`,
        { details: { reason: 'review_monday_nudge_failed', outcome: pass.runOutcome } },
      )
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}
