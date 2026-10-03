import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The dispatch queue's reads and its outcome writes (A-MEAS-03), over migration 0137.
 *
 * ## What is deliberately NOT here
 *
 * **There is no consent check in this file.** `enqueueAnalyticsDispatch` in `./analytics-consent.ts` asks
 * `dispatch_consent_gap`, the ZY312 trigger asks the same function, and a dispatch cannot reach `queued`
 * or `sent` without the signals its destination needs — for every role including the owner. So the
 * consumer reads the decision and does not re-make it: a second consent check here is the defect
 * A-MEAS-02 was built to prevent (ADR 0076), and the shape it would take is exactly a `where` clause in
 * {@link dueAnalyticsDispatches} that looked plausible, agreed with the gate for a year, and then did not.
 *
 * **There is no enqueue here either**, for the same reason: one writer, and it is the one that asks the
 * gate.
 *
 * **And there is no derivation of the action source here.** Nothing in this schema links an analytics
 * session to the booking it produced — A-FIRST-08 owns attribution and A-FIRST-09 the funnel
 * materialisation — so a consumer that joined the two through anything available today would be joining
 * on nothing and producing a confident answer. `action_source` and `occurred_at` are STORED by whoever
 * enqueued the dispatch, which is the one caller that knows, and this module reads them.
 *
 * ## Why the retry eligibility is computed in SQL and not in the worker
 *
 * {@link dueAnalyticsDispatches} takes the backoff ladder as an argument — an array of seconds — and
 * compares `decided_at` plus the delay for the row's own attempt count against the instant it is given.
 * The ladder comes from `@berelax/analytics`, because `packages/db` may not import it (it may not import
 * `packages/core` either, ADR 0001) and a copy of the numbers here would be the second statement of a
 * schedule. What is in SQL is the COMPARISON, so a pass does not read ten thousand rows to discard the
 * ones that are not due yet.
 *
 * ## `for update skip locked`, and why that is not an optimisation
 *
 * Two worker processes draining this queue would otherwise both read the same `queued` row and both
 * transmit it. The unique index cannot stop that — it is the same row, not a second one — so the lock is
 * what makes "exactly one successful delivery per (event_id, destination)" true under concurrency rather
 * than true in a single-process test. `skip locked` rather than a plain `for update`, because the second
 * worker should take the next row rather than wait for the first to finish an HTTPS call.
 */

/**
 * The two refusals migration 0137 adds, so a caller can branch on the RULE and not on prose.
 *
 * Spelled here and nowhere else: a code is an identity (ADR 0043), and a second literal of one in another
 * module makes the registry entry's translator list wrong — which is what `pnpm sqlstate` caught in
 * `analytics-consent.ts` for `ZP002`. Neither is translated into a named refusal by a function in this
 * file, because neither can arise from a call this module makes: `recordDispatchAttempt` never edits a
 * `sent` row and never lowers `attempts`. They are registered so that a caller which DOES hit one — a
 * later unit, a psql session, a correction written as an edit instead of as a new statement (A-MEAS-05) —
 * gets a code it can name rather than a constraint message.
 */
export const ANALYTICS_DISPATCH_SQLSTATE = {
  transmissionIsFrozen: 'ZY451',
  attemptsAreMonotonic: 'ZY452',
} as const

/** A dispatch the consumer may act on, with everything it needs and nothing it does not. */
export interface DueDispatch {
  readonly dispatchId: string
  readonly sessionId: string
  readonly destination: string
  readonly funnelStage: string
  readonly state: 'queued' | 'failed'
  readonly eventId: string
  /** The serialised egress payload as stored. Re-parsed by the consumer, never rebuilt. */
  readonly payload: string
  readonly attempts: number
  readonly decidedAtIso: string
  /** Where the conversion happened, as the enqueuer recorded it. One of the three platform values. */
  readonly actionSource: string
  /**
   * When the conversion HAPPENED. For an offline upload, days before `decidedAtIso`.
   *
   * ISO-8601 by `Date.toISOString()` and NOT by `occurred_at::text`, which was the first spelling and is
   * the convention every other repository here avoids for a reason the integration suite measured:
   * `timestamptz::text` is PostgreSQL's own display form (`2026-09-30 09:00:00+00`), so the field was
   * named `...Iso` and did not hold one. Both adapters put this value through `new Date(...)`, and a
   * space-separated instant is outside the format `Date.parse` is specified for — it happens to work in
   * V8 and is the shape that dates a conversion wrongly where it does not.
   */
  readonly occurredAtIso: string
}

export interface DueDispatchQuery {
  /** The instant the pass is running at. Supplied, never `now()`: every suite here is frozen-clock. */
  readonly nowIso: string
  /**
   * The backoff ladder in seconds, index 0 being the wait after the first attempt.
   *
   * `ANALYTICS_RETRY_DELAYS` is derived from `analyticsRetryDelaySeconds` in `@berelax/analytics` by the
   * caller. An EMPTY ladder is refused rather than treated as "retry immediately": an empty array makes
   * every `failed` row due on every pass, which is the hammering a backoff exists to prevent, and it is
   * also what a mis-wired caller would pass.
   */
  readonly backoffSeconds: readonly number[]
  readonly limit: number
}

export async function dueAnalyticsDispatches(
  sql: Sql,
  query: DueDispatchQuery,
): Promise<readonly DueDispatch[]> {
  if (query.backoffSeconds.length === 0) {
    throw new AppError(
      'invariant_violated',
      'The dispatch queue was read with an empty backoff ladder. Every failed row would then be due on ' +
        'every pass, which is the hammering a backoff exists to prevent — and an empty array is exactly ' +
        'what a mis-wired caller passes.',
    )
  }
  if (!Number.isInteger(query.limit) || query.limit < 1) {
    throw new AppError(
      'invariant_violated',
      `The dispatch queue was read with a limit of ${query.limit}. A limit of zero drains nothing and ` +
        'reports a clean pass, which is ADR 0002\'s failure: a pass over nothing answering "all sent".',
      { details: { limit: query.limit } },
    )
  }
  const rows = await sql<
    {
      dispatch_id: string
      session_id: string
      destination: string
      funnel_stage: string
      state: string
      event_id: string
      payload: string
      attempts: number
      decided_at: Date
      action_source: string
      occurred_at: Date
    }[]
  >`
    select d.dispatch_id,
           d.session_id,
           d.destination,
           d.funnel_stage::text  as funnel_stage,
           d.state::text         as state,
           d.event_id,
           d.payload::text       as payload,
           d.attempts,
           d.decided_at,
           d.action_source,
           d.occurred_at
      from analytics_dispatch d
     where d.state in ('queued', 'failed')
       /*
        * Due now. A queued row with no attempt is due immediately; a row that has failed waits the
        * ladder's delay for its own attempt count, and one past the end of the ladder is never due
        * again -- which is what makes giving up a state somebody can see rather than a row that keeps
        * being retried for ever.
        */
       and (
         d.attempts = 0
         or (
           d.attempts <= ${query.backoffSeconds.length}
           and d.decided_at
               + make_interval(secs => (${query.backoffSeconds}::int[])[d.attempts])
               <= ${query.nowIso}::timestamptz
         )
       )
     order by d.decided_at
     limit ${query.limit}
     for no key update of d skip locked
  `
  return rows.map((row) => ({
    dispatchId: row.dispatch_id,
    sessionId: row.session_id,
    destination: row.destination,
    funnelStage: row.funnel_stage,
    state: row.state === 'queued' ? 'queued' : 'failed',
    eventId: row.event_id,
    payload: row.payload,
    attempts: row.attempts,
    decidedAtIso: row.decided_at.toISOString(),
    actionSource: row.action_source,
    occurredAtIso: row.occurred_at.toISOString(),
  }))
}

/** What a transport attempt came back with. `diverted` is an attempt that was never permitted to leave. */
export const DISPATCH_ATTEMPT_OUTCOMES = ['sent', 'diverted', 'failed'] as const
export type DispatchAttemptOutcome = (typeof DISPATCH_ATTEMPT_OUTCOMES)[number]

/**
 * Records one transport attempt on one dispatch.
 *
 * ## `diverted` is recorded as `sent` and says so in the row, and that is the hard call here
 *
 * Off production nothing transmits (`guardAnalyticsEgress`), and the question is what state the row should
 * then be in. Three answers were considered:
 *
 *   * **leave it `queued`** — then every development and test database accumulates a queue that grows for
 *     ever, every pass re-attempts every row, and the attempt counter climbs until the ladder runs out and
 *     the row reads as a transport failure. The symptom is a staging environment that reports hundreds of
 *     failed conversions.
 *   * **a fifth state, `diverted`** — honest, and it would mean A-MEAS-07 has a fourth classification to
 *     carry and every query about "what went out" has two spellings of no.
 *   * **`sent`, with the local outbox row as the receipt** — which is what this does. The dispatch is
 *     COMPLETE: the payload was built, the adapter recorded exactly what it would have posted, and there
 *     is nothing left to retry. `transmitted_at` is the instant the attempt finished, which is what the
 *     table's own CHECK requires of a `sent` row, and whether a request actually left the building is the
 *     `transmitted` flag on the outbox record — the one place that can answer it, because it is the only
 *     thing that knows about the guard.
 *
 * It is recorded rather than inferred: a reader of this table alone cannot tell a transmitted dispatch
 * from a diverted one, and that is deliberate, because APP_ENV is a property of the deployment and not of
 * the row. A production database contains only transmitted ones.
 *
 * ## A retryable failure goes back to `queued`; a permanent one stays `failed`
 *
 * And the retryable one is re-judged by the ZY312 trigger on the way, which is the half worth stating: a
 * dispatch that failed while consent stood and is retried after a withdrawal is REFUSED on the retry.
 * That is not a check this function makes — it is the trigger, on the UPDATE, for every role.
 */
export async function recordDispatchAttempt(
  sql: Sql,
  input: {
    readonly dispatchId: string
    readonly outcome: DispatchAttemptOutcome
    readonly atIso: string
    /** Non-null exactly for `failed`. The table's CHECK refuses the other combination. */
    readonly error: string | null
    /** Whether a `failed` row may be tried again. Ignored for the other outcomes. */
    readonly retryable: boolean
  },
): Promise<{ readonly state: string; readonly attempts: number }> {
  const terminal = input.outcome === 'sent' || input.outcome === 'diverted'
  const nextState = terminal ? 'sent' : input.retryable ? 'queued' : 'failed'
  if (!terminal && input.error === null) {
    throw new AppError(
      'invariant_violated',
      'A failed dispatch attempt was recorded with no error. The table refuses it (a failure with no ' +
        'message is indistinguishable from a consumer that stopped running), and the refusal would ' +
        'arrive as a constraint violation naming a column rather than as this sentence.',
      { details: { dispatchId: input.dispatchId } },
    )
  }
  const rows = await sql<{ state: string; attempts: number }[]>`
    update analytics_dispatch
       set attempts       = attempts + 1,
           state          = ${nextState}::analytics_dispatch_state,
           -- transmitted_at is present exactly when the row is sent, which the table's own CHECK
           -- enforces; written here rather than left to a second statement, and CLEARED on the way back
           -- to queued so a retried row cannot keep an instant from an attempt that did not land.
           transmitted_at = case when ${nextState} = 'sent' then ${input.atIso}::timestamptz end,
           -- A queued retry carries no reason, because the table's bijection says a live row has none.
           reason         = case when ${nextState} = 'failed' then 'transport_failed' end,
           last_error     = ${input.error}
     where dispatch_id = ${input.dispatchId}::uuid
    returning state::text as state, attempts
  `
  const row = rows[0]
  if (row === undefined) {
    throw new AppError(
      'not_found',
      `analytics_dispatch ${input.dispatchId} does not exist, so the attempt was not recorded. A pass ` +
        'that swallowed this would report a delivery nothing stored.',
      { details: { dispatchId: input.dispatchId } },
    )
  }
  return row
}

/** How many dispatches are in each state. The consumer's log line and the watchdog's evidence. */
export async function analyticsDispatchStateCounts(
  sql: Sql,
): Promise<Readonly<Record<string, number>>> {
  const rows = await sql<{ state: string; n: string }[]>`
    select state::text as state, count(*)::text as n from analytics_dispatch group by state
  `
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.state] = Number(row.n)
  return counts
}
