import { type Config, loadConfig } from '@berelax/config'
import {
  ASIA_DUBAI,
  createRunBudget,
  type HoursForDate,
  type Instant,
  type LocalDate,
  localTime,
  resolveTradingDate,
  reviewCountPhrase,
} from '@berelax/core'
import {
  type AgentOutcome,
  createConnection,
  listReviewIntakeTargets,
  readPreviousPlaceAggregate,
  readTradingHoursAround,
  recordAggregateNotification,
  recordPlaceAggregateReading,
  type Sql,
  withAgentRun,
  withUnitOfWork,
} from '@berelax/db'
import {
  PLACES_AGGREGATE_FIELD_MASK,
  placeReviewsDeepLink,
  readPlaceAggregate,
} from '@berelax/google'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakePlaces, type PlacesProvider } from '@berelax/providers/google'
import {
  AppError,
  REVIEW_COUNT_TRIPWIRE_AGENT,
  REVIEW_FALLBACK_TEMPLATE_KEYS,
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
 * The count tripwire: the cheapest honest trigger there is while the Business Profile API is unapproved.
 *
 * docs/10 §6 states the whole design in one sentence — *"a daily call, and on an increase, email 'you have 2
 * new reviews' with a deep link built from the stored placeId"* — and each clause of it is a decision rather
 * than a detail:
 *
 * **A daily call, not a poll.** Places API (New) is separately billed per call and is not a review feed. One
 * call a day per listing is the whole budget, and the `agent_definition` row caps it.
 *
 * **On an INCREASE.** Not on a change. A count that goes down means a reviewer deleted a review or Google
 * removed one, and there is nothing for the owner to read — an email about it would be one whose single
 * action does not exist.
 *
 * **The stored placeId.** `listReviewIntakeTargets` reads it from the connection's `gbp_reviews` capability,
 * which is where the owner's own selection landed. A configured id keeps working after the capability is
 * re-pointed and then sends the owner to another business's reviews.
 *
 * ## The aggregate and nothing else
 *
 * `readPlaceAggregate` returns a value with no field that can hold a review body, and `google_place_aggregate`
 * has no text column at all (ADR 0043). So *nothing may be cached* is a property of the schema and of the
 * adapter's return type rather than of this pass remembering — which is what makes the acceptance line's scan
 * of every text column in the database a check with teeth.
 *
 * ## Idempotency is the unique index, not a flag
 *
 * One reading per listing per TRADING DATE, refused by `google_place_aggregate_one_reading_per_trading_date`.
 * A reclaimed job — pg-boss expires and re-runs one — reaches `already_read_today`, sends nothing, and cannot
 * email the owner about the same reviews twice. A boolean "notified" column would have needed a read before
 * the write, and a check-then-write has a window exactly wide enough for the second pass to land in it.
 */

/** What the pass decided about one listing. A closed union: every outcome is a named state. */
export type CountTripwireOutcome =
  /** A reading already exists for this trading date. Nothing further was read and nothing was sent. */
  | { readonly kind: 'already_read_today' }
  /** The first reading for this listing. Nothing to compare against, so nothing can have gone up. */
  | { readonly kind: 'no_previous_reading' }
  /** Places returned no count at all — a listing nobody has rated. Recorded, not reported. */
  | { readonly kind: 'count_unavailable' }
  | { readonly kind: 'unchanged'; readonly reviewCount: number }
  /** The count went down: a review was deleted or removed, and there is nothing to read. */
  | { readonly kind: 'decreased'; readonly from: number; readonly to: number }
  /** An increase, and no address to tell anybody about it. The shipped state — see the sender module. */
  | { readonly kind: 'no_recipient_on_file'; readonly newReviews: number }
  /** An increase, an address, and a send the choke point would not make. */
  | { readonly kind: 'send_refused'; readonly newReviews: number; readonly reason: string }
  | {
      readonly kind: 'notified'
      readonly newReviews: number
      /** `null` when F03's staging guard diverted the send, which off production is ordinary. */
      readonly messageId: string | null
    }

export interface CountTripwirePassResult {
  readonly connectionId: string
  readonly placeId: string
  readonly outcome: CountTripwireOutcome
}

export interface CountTripwireDeps {
  readonly sql: Sql
  readonly places: Pick<PlacesProvider, 'getPlace'>
  readonly notifier: ReviewNoticeNotifier
  readonly recipientFor: ReviewNoticeRecipientResolver
  /** The instant of the pass, injected. Every assertion about this job is made on a frozen clock. */
  readonly now: Instant
  /** pg-boss's job id, when there is one. Recorded on the `agent_run` row. */
  readonly jobId?: string
}

export interface CountTripwirePass {
  /** What `withAgentRun` recorded. A throw inside the pass is a `failed` run with a heartbeat. */
  readonly runOutcome: AgentOutcome
  readonly results: readonly CountTripwirePassResult[]
}

/**
 * The actor every tripwire write is recorded under.
 *
 * `system`, and the label names the pass. This is a cron with nobody at a keyboard, so a staff label would
 * name a person who did not do it.
 */
export const TRIPWIRE_ACTOR = { kind: 'system', label: 'Review count tripwire' } as const

/**
 * The trading date an instant belongs to, composed here because the composition needs both packages.
 *
 * The same six lines `complianceAsOf` writes in `obligation-reminders.ts`, and its comment gives the reason
 * they are not shared: the rows are `packages/db`'s, the rule that picks which row contains the instant is
 * `packages/core`'s, and the only package that may hold both is test-only.
 */
export async function tripwireTradingDate(sql: Sql, now: Instant): Promise<LocalDate> {
  const hours = await readTradingHoursAround(sql, now)
  const hoursFor: HoursForDate = (date) => {
    const row = hours.find((entry) => entry.tradingDate === date)
    return row === undefined
      ? undefined
      : { open: localTime(row.open), close: localTime(row.close) }
  }
  const resolved = resolveTradingDate(now, hoursFor, ASIA_DUBAI)
  if (resolved.kind === 'trading') return resolved.date
  // Outside trading is not an error here and must not become one: the cron runs at 06:15, four hours after
  // the session closes, so EVERY ordinary run lands on this branch. `resolveTradingDate` is still what
  // decides — at 01:30 it answers the PREVIOUS date, because the session that closes at 02:00 opened the day
  // before, and that is the nine-hours-either-side-of-midnight case a `slice(0, 10)` would get wrong.
  return resolved.calendarDate
}

/**
 * One pass over every listing the fallback intake is about.
 *
 * Sequential rather than concurrent, over a list this business has exactly one of. A `Promise.all` would make
 * two billed Places calls at once against a per-minute quota for no benefit.
 */
export async function runReviewCountTripwire(deps: CountTripwireDeps): Promise<CountTripwirePass> {
  const results: CountTripwirePassResult[] = []
  // The wrapper is INSIDE the pass, the arrangement `runGscNightlySnapshot` takes: a pass that recorded no
  // heartbeat would be a daily cron nobody is watching, and that claim has to be one a test driving THIS
  // function can make rather than one about the handler's boilerplate.
  const run = await withAgentRun(
    deps.sql,
    {
      agentKey: REVIEW_COUNT_TRIPWIRE_AGENT,
      startedAtIso: new Date(deps.now).toISOString(),
      ...(deps.jobId === undefined ? {} : { jobId: deps.jobId }),
    },
    async () => {
      results.push(...(await readEveryListing(deps)))
    },
    createRunBudget,
  )
  return { runOutcome: run.outcome, results }
}

/** One reading and one decision per listing. Separated so the wrapper above has one body. */
async function readEveryListing(
  deps: CountTripwireDeps,
): Promise<readonly CountTripwirePassResult[]> {
  const observedOn = await tripwireTradingDate(deps.sql, deps.now)
  const observedAtIso = new Date(deps.now).toISOString()
  const results: CountTripwirePassResult[] = []

  for (const target of await listReviewIntakeTargets(deps.sql)) {
    // The previous reading is read BEFORE today's is written. The predicate is `<` on the trading date, so it
    // would still be correct afterwards — but reading first keeps the two statements in the order the
    // comparison is about, and makes the query independent of the write that follows it.
    const previous = await readPreviousPlaceAggregate(deps.sql, {
      connectionId: target.connectionId,
      placeId: target.placeId,
      beforeTradingDate: observedOn,
    })
    const reading = await readPlaceAggregate(deps.places, {
      placeId: target.placeId,
      fieldMask: PLACES_AGGREGATE_FIELD_MASK,
    })

    const written = await withUnitOfWork(deps.sql, TRIPWIRE_ACTOR, (uow) =>
      recordPlaceAggregateReading(uow, {
        connectionId: target.connectionId,
        placeId: target.placeId,
        observedOn,
        observedAtIso,
        ratingTenths: reading.ratingTenths,
        reviewCount: reading.reviewCount,
        curatedReviewsDiscarded: reading.curatedReviewsDiscarded,
      }),
    )
    if (written.kind === 'already_read_today') {
      results.push({ ...target, outcome: { kind: 'already_read_today' } })
      continue
    }

    results.push({
      ...target,
      outcome: await decide({
        deps,
        target,
        readingId: written.readingId,
        previousCount: previous?.reviewCount ?? null,
        currentCount: reading.reviewCount,
        hadPreviousReading: previous !== undefined,
      }),
    })
  }
  return results
}

async function decide(args: {
  readonly deps: CountTripwireDeps
  readonly target: { readonly connectionId: string; readonly placeId: string }
  readonly readingId: string
  readonly previousCount: number | null
  readonly currentCount: number | null
  readonly hadPreviousReading: boolean
}): Promise<CountTripwireOutcome> {
  const { deps, target, currentCount, previousCount } = args
  if (currentCount === null) return { kind: 'count_unavailable' }
  if (!args.hadPreviousReading || previousCount === null) return { kind: 'no_previous_reading' }
  if (currentCount === previousCount) return { kind: 'unchanged', reviewCount: currentCount }
  if (currentCount < previousCount) {
    return { kind: 'decreased', from: previousCount, to: currentCount }
  }

  const newReviews = currentCount - previousCount
  const recipient = deps.recipientFor()
  if (recipient === null || recipient.trim() === '') {
    return { kind: 'no_recipient_on_file', newReviews }
  }

  const outcome = await deps.notifier.notify({
    // English, and the reason is migration 0075's verbatim: no table records which language a member of staff
    // reads, and picking one per role would be a guess about a person (ADR 0020).
    reviewsPhrase: reviewCountPhrase(newReviews, 'en'),
    deepLink: placeReviewsDeepLink(target.placeId),
    // The reading's own row id. Keyed on the row and never on a display number or on the count itself
    // (`outbox-keys.test.ts` enforces the same discipline for outbox rows): a count repeats when a review is
    // deleted and another is left, and two different notices must not share a key.
    idempotencyKey: `review-count-${args.readingId}`,
    recipient: recipient.trim(),
  })
  if (outcome.kind === 'refused') {
    return { kind: 'send_refused', newReviews, reason: outcome.reason }
  }

  await withUnitOfWork(deps.sql, TRIPWIRE_ACTOR, (uow) =>
    recordAggregateNotification(uow, {
      readingId: args.readingId,
      reportedNewReviews: newReviews,
      messageId: outcome.messageId,
    }),
  )
  return { kind: 'notified', newReviews, messageId: outcome.messageId }
}

/**
 * The Places adapter for a configured mode.
 *
 * The arrangement `searchConsoleFor` in `gsc-nightly-snapshot.ts` uses, and for the same reasons: the subpath
 * import rather than the `@berelax/providers` barrel, because the barrel re-exports the SMS and email ports
 * and `messaging-providers-only-inside-a-transport` closes that loophole; and `real` THROWS rather than
 * falling back, because a pass that silently read a fake would write fixture counts into
 * `google_place_aggregate` and every later comparison would be about a listing that does not exist.
 */
function placesFor(config: Config, nowIso: string): PlacesProvider {
  if (config.GOOGLE_PROVIDER === 'real') {
    throw new AppError(
      'provider_unavailable',
      'The real Places API (New) adapter is not implemented, so this pass would compare fixture counts and ' +
        'email the owner about reviews that do not exist. Set GOOGLE_PROVIDER=fake until it exists.',
    )
  }
  return createFakePlaces({
    log: createCallLog(() => nowIso),
    failures: new FailureScript(),
    now: () => nowIso,
  })
}

/** 06:15 Asia/Dubai. See the definition below for why that hour. */
export const REVIEW_COUNT_TRIPWIRE_CRON = '15 6 * * *'

export const REVIEW_COUNT_TRIPWIRE_JOB: JobDefinition = {
  name: 'review.count-tripwire',
  purpose:
    'Reads the Places API (New) aggregate for every listing once a day, compares the review count with the ' +
    'last reading, and emails the owner "N new reviews" with a deep link built from the stored placeId when ' +
    'it has gone up. The only programmatic signal that a review exists while the Business Profile ' +
    'application is unapproved (docs/10 SS6, Y3-gbp-api). Stores the aggregate only (ADR 0043).',
  // 06:15 Asia/Dubai. After trading closes at 02:00 and after every existing nightly pass (03:00, 03:45,
  // 04:15, 04:45, 05:00, 05:15 and 05:30), so nothing contends — and before anybody is at a desk, so the
  // email is waiting rather than arriving mid-morning. Asia/Dubai is UTC+4 with no DST; `registerJobs` passes
  // the zone to pg-boss rather than this file pre-computing an offset.
  cron: REVIEW_COUNT_TRIPWIRE_CRON,
  agent: REVIEW_COUNT_TRIPWIRE_AGENT,
  retryLimit: 3,
  retryDelaySeconds: 300,
  retryBackoff: true,
  // One Places call, one read of the previous reading, one insert and at most one email per listing. Sixty
  // seconds is generous; a pass still running past it is blocked rather than slow, and reclaiming it is safe
  // because the unique index on (connection, place, trading date) refuses the second reading.
  expireInSeconds: 60,
  handler: countTripwireHandler,
}

/**
 * The handler: the only thing in this unit that reads a real clock, and it reads it once.
 *
 * Wrapped in `withAgentRun`, which records the attempt and the heartbeat whatever the outcome — so a pass that
 * threw is visibly a failure rather than silence, and the watchdog's "no success within twice the declared
 * interval" alert means something. The failure is re-thrown so pg-boss retries with backoff, and the run row
 * and heartbeat are already written by then, which is the point.
 */
async function countTripwireHandler(_data: unknown, context: JobContext): Promise<void> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    const startedAtIso = context.now()
    const pass = await runReviewCountTripwire({
      sql,
      places: placesFor(config, startedAtIso),
      notifier: reviewNoticeNotifierFor(sql, config, {
        from: PROVISIONAL_EMAIL_SENDER,
        templateKey: REVIEW_FALLBACK_TEMPLATE_KEYS.countIncrease,
        now: () => context.now(),
      }),
      recipientFor: NO_OWNER_CONTACT_ON_FILE,
      now: Date.parse(startedAtIso) as Instant,
      jobId: context.jobId,
    })
    if (pass.runOutcome === 'failed' || pass.runOutcome === 'budget_exceeded') {
      // Re-thrown so pg-boss retries with backoff. The run row and the heartbeat are already written.
      throw new AppError(
        'provider_unavailable',
        `The review count tripwire failed: the run was recorded as ${pass.runOutcome}`,
        { details: { reason: 'review_count_tripwire_failed', outcome: pass.runOutcome } },
      )
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}
