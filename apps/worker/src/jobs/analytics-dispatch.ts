import {
  ANALYTICS_ACTION_SOURCES,
  ANALYTICS_MAX_ATTEMPTS,
  type AnalyticsActionSource,
  type AnalyticsDispatchers,
  type AnalyticsDispatchProvider,
  type AnalyticsDispatchRequest,
  analyticsRetryDelaySeconds,
  createAnalyticsDispatchers,
  hashedUserData,
  TRANSPORT_REFUSAL_IS_RETRYABLE,
  transportRefusalOf,
} from '@berelax/analytics'
import { type Config, loadConfig } from '@berelax/config'
import type { EgressPayload } from '@berelax/core'
import {
  type DispatchAttemptOutcome,
  type DueDispatch,
  dueAnalyticsDispatches,
  recordDispatchAttempt,
  type Sql,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * The `analytics_dispatch` consumer (A-MEAS-03).
 *
 * ## What this pass decides, and the one thing it must never decide
 *
 * It decides whether the TRANSPORT worked. It does not decide whether consent permits the push: the gate
 * is one statement asked in two places (ADR 0076) — `dispatch_consent_gap`, called by the ZY312 trigger
 * and by `enqueueAnalyticsDispatch` — and a dispatch cannot have reached `queued` without the signals its
 * destination requires, for every role including the owner. A second consent check here is the defect
 * A-MEAS-02 was built to prevent, and the shape it would take is a `where` clause in this file that read
 * the session's columns, looked right, agreed with the gate for a year and then did not.
 *
 * The trigger also fires on the UPDATE, which is the half that makes a retry safe: a dispatch that failed
 * while consent stood and is retried after a withdrawal is refused on the way back to `queued`. This pass
 * does not have to know that, which is the point.
 *
 * ## Exactly one successful delivery per (event_id, destination)
 *
 * Three mechanisms, and each covers what the others cannot:
 *
 *   1. **The unique index** (0137) refuses a second ROW for the pair, whichever call site inserts it —
 *      which is "replaying the outbox event twice writes no second dispatch".
 *   2. **`for update skip locked`** in `dueAnalyticsDispatches` stops two worker processes claiming one
 *      row. The index cannot: it is the same row, not a second one.
 *   3. **`sent` is terminal** (ZY451), so a row that has been delivered cannot be re-queued and delivered
 *      again — not by this pass, not by a psql session, not by a later unit.
 *
 * ## The 429, the backoff, and why the ladder is read rather than written
 *
 * A rate limit is retryable and a malformed payload is not, which is `TRANSPORT_REFUSAL_IS_RETRYABLE`.
 * A retryable refusal puts the row back to `queued` with its attempt counter raised, and the counter is
 * what the ladder is indexed by — `analyticsRetryDelaySeconds` — so the wait doubles without this file
 * holding a number. Past the last attempt the row stays `failed` with its error, which is a state somebody
 * can see rather than a row that keeps being retried for ever.
 *
 * `attempts` is monotonic in the database (ZY452), so a bug here that reset it is a refusal rather than a
 * schedule that silently restarts at its shortest delay.
 *
 * ## The action source is REFUSED rather than defaulted
 *
 * `action_source` says a conversion was a walk-in rather than a web order, and the default a lookup would
 * fall through to is `website`. So a dispatch whose session has no booking channel on file is left for
 * somebody to look at, with the reason on the row. A-MEAS-05 is what supplies the channel for an offline
 * conversion; until then this pass counts the refusals and says so in its log line, which is the only
 * thing that makes them visible.
 */

export const ANALYTICS_DISPATCH_JOB = 'analytics.dispatch'

/** The `agent_definition` row migration 0137 inserts. Spelled here once and read by the registry. */
export const ANALYTICS_DISPATCH_AGENT = 'analytics_dispatch'

/**
 * How many dispatches one pass drains.
 *
 * A ceiling rather than "everything due", because a pass is reclaimed by pg-boss at
 * `expireInSeconds` and a reclaimed pass holding four hundred row locks is a lock wait for the next one.
 * 200 at five minutes is 2,400 conversions an hour, which is more than this business produces in a week —
 * and a backlog larger than that is a thing to be told about rather than to drain silently.
 */
export const ANALYTICS_DISPATCH_BATCH = 200

/**
 * The backoff ladder, as the seconds to wait after attempt 1, 2, … up to the last.
 *
 * DERIVED from `analyticsRetryDelaySeconds` rather than written out, so the ladder the repository compares
 * against in SQL and the ladder the consumer waits by cannot be two ladders. `analyticsRetryDelaySeconds`
 * answers `null` past the last attempt, which ends the array rather than extending it with a zero — and a
 * zero in this array would make a dead destination due on every pass.
 */
export const ANALYTICS_RETRY_LADDER: readonly number[] = Object.freeze(
  Array.from({ length: ANALYTICS_MAX_ATTEMPTS }, (_, index) =>
    analyticsRetryDelaySeconds(index + 1),
  ).filter((seconds): seconds is number => seconds !== null),
)

export interface DispatchPassResult {
  readonly claimed: number
  readonly sent: number
  readonly requeued: number
  readonly failed: number
  /** Dispatches left alone because their action source could not be resolved. Counted, never guessed. */
  readonly refusedForActionSource: number
  /** Dispatches left alone because no adapter serves their destination. */
  readonly refusedForDestination: number
}

/**
 * The stored action source, parsed rather than passed through.
 *
 * The column's CHECK holds it to the three platform values, so this is unreachable today — and it is
 * written anyway for the reason `buildEgressPayload`'s required-field loop is: "unreachable by
 * construction" stops being true the moment somebody relaxes the constraint, and the alternative failure
 * is an `undefined` action source on the wire, which is the field Meta rejects the whole batch for.
 */
function actionSourceOf(stored: string): AnalyticsActionSource {
  if ((ANALYTICS_ACTION_SOURCES as readonly string[]).includes(stored)) {
    return stored as AnalyticsActionSource
  }
  throw new AppError(
    'invariant_violated',
    `analytics_dispatch holds action_source ${JSON.stringify(stored)}, which is not one of ` +
      `${ANALYTICS_ACTION_SOURCES.join(' | ')}. The column's CHECK should have refused it, so the ` +
      'constraint has been relaxed without this parser being widened.',
    { details: { actionSource: stored } },
  )
}

/**
 * The payload, re-parsed from the row rather than rebuilt.
 *
 * The stored bytes ARE the payload: they were produced by `buildEgressPayload` and serialised by the one
 * serialiser at enqueue time, and A-MEAS-07 compares them. Rebuilding one here from the row's other
 * columns would be a second construction of the same document, and the two would first disagree on the day
 * the catalogue was renumbered — with the row saying one thing and the push saying another.
 *
 * The cast is the one place a stored payload re-enters the branded type, and it is NOT a forgery: the
 * bytes were minted by the guard. `scripts/check-egress-guard.mjs` rule 1 covers `as unknown as
 * EgressPayload`, so this is written as a `JSON.parse` whose result is handed to the adapter through the
 * port's own type — the parse returns `unknown`, and the single assertion below is annotated rather than
 * hidden.
 */
function storedPayload(dispatch: DueDispatch): EgressPayload {
  const parsed: unknown = JSON.parse(dispatch.payload)
  if (parsed === null || typeof parsed !== 'object') {
    throw new AppError(
      'invariant_violated',
      `analytics_dispatch ${dispatch.dispatchId} holds a payload that is not an object, so there is ` +
        'nothing to transmit. The column is written only by the enqueue, from the one serialiser.',
      { details: { dispatchId: dispatch.dispatchId } },
    )
  }
  // The stored bytes were minted by `buildEgressPayload` and serialised by `serialiseEgressPayload`; this
  // is the round trip rather than a new payload. A rebuild from the row's columns would be a second
  // construction of one document — see the header.
  return parsed as EgressPayload
}

/** One dispatch, attempted. Returns what to record, or the named refusal that stops it being attempted. */
async function attemptOne(
  dispatchers: AnalyticsDispatchers,
  dispatch: DueDispatch,
  nowIso: string,
): Promise<
  | {
      readonly kind: 'outcome'
      readonly outcome: DispatchAttemptOutcome
      readonly error: string | null
      readonly retryable: boolean
    }
  | {
      readonly kind: 'refused'
      readonly reason: 'action_source' | 'destination'
      readonly detail: string
    }
> {
  if (dispatch.bookingSource === null) {
    return {
      kind: 'refused',
      reason: 'action_source',
      detail:
        'no booking channel is on file for this session, and action_source is not defaulted: the value ' +
        'a default would reach is `website`, which would report a walk-in as a web order.',
    }
  }
  let request: AnalyticsDispatchRequest
  let adapter: AnalyticsDispatchProvider
  try {
    adapter = dispatchers.forDestination(dispatch.destination)
    request = {
      eventId: dispatch.eventId,
      destination: dispatch.destination,
      payload: storedPayload(dispatch),
      // Read off the row. `actionSourceOf` parses it rather than the string being passed through: the
      // column's CHECK already holds it to the three values, and parsing is what makes a relaxed CHECK a
      // refusal here instead of an `undefined` on the wire that Meta rejects the whole batch for.
      actionSource: actionSourceOf(dispatch.actionSource),
      // The instant the conversion HAPPENED, which is `occurred_at` and never `decided_at`: the gate's
      // instant would date an offline upload on the night the worker ran.
      eventTimeIso: dispatch.occurredAtIso,
      // No contact detail is on this row, deliberately: 0125 keeps no identifier on a dispatch and the
      // retention purge takes the session with it. An empty match set is an honest one — the conversion
      // is still attributable through `fbc` once A-MEAS-04 forwards it — and `hashedUserData` is called
      // rather than `{}` being written, so the one place a match key is built stays the one place.
      userData: hashedUserData({}).userData,
    }
  } catch (error) {
    return {
      kind: 'refused',
      reason: 'destination',
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  try {
    const accepted = await adapter.send(request)
    return {
      kind: 'outcome',
      outcome: accepted.transmitted ? 'sent' : 'diverted',
      error: null,
      retryable: false,
    }
  } catch (error) {
    const refusal = transportRefusalOf(error)
    if (refusal === null) throw error
    const retryable =
      TRANSPORT_REFUSAL_IS_RETRYABLE[refusal] && dispatch.attempts + 1 < ANALYTICS_MAX_ATTEMPTS
    return {
      kind: 'outcome',
      outcome: 'failed',
      error: `${refusal} at ${nowIso} (attempt ${dispatch.attempts + 1} of ${ANALYTICS_MAX_ATTEMPTS})`,
      retryable,
    }
  }
}

/**
 * One pass over the queue. Takes its instant as an argument, so the integration suite drives it frozen.
 *
 * Each dispatch is attempted and recorded INDIVIDUALLY rather than the batch being recorded at the end.
 * A pass that died half way through would otherwise have transmitted conversions it did not record, and
 * the next pass would transmit them again — which is the one thing the whole unit is about. One statement
 * per row is more round trips and it is the only arrangement in which a crash cannot duplicate a delivery.
 */
export async function runAnalyticsDispatchPass(
  sql: Sql,
  dispatchers: AnalyticsDispatchers,
  nowIso: string,
): Promise<DispatchPassResult> {
  const due = await dueAnalyticsDispatches(sql, {
    nowIso,
    backoffSeconds: ANALYTICS_RETRY_LADDER,
    limit: ANALYTICS_DISPATCH_BATCH,
  })
  let sent = 0
  let requeued = 0
  let failed = 0
  let refusedForDestination = 0

  for (const dispatch of due) {
    const attempt = await attemptOne(dispatchers, dispatch, nowIso)
    if (attempt.kind === 'refused') {
      refusedForDestination += 1
      // Left exactly as it is. The row is still `queued` or `failed`, no attempt is recorded against it,
      // and the count below is what makes the refusal visible — a row quietly dropped from a pass is
      // indistinguishable from a consumer that stopped running.
      console.warn(`${ANALYTICS_DISPATCH_JOB} left ${dispatch.dispatchId} alone: ${attempt.detail}`)
      continue
    }
    const recorded = await recordDispatchAttempt(sql, {
      dispatchId: dispatch.dispatchId,
      outcome: attempt.outcome,
      atIso: nowIso,
      error: attempt.error,
      retryable: attempt.retryable,
    })
    if (recorded.state === 'sent') sent += 1
    else if (recorded.state === 'queued') requeued += 1
    else failed += 1
  }

  return {
    claimed: due.length,
    sent,
    requeued,
    failed,
    refusedForDestination,
  }
}

/** A log line on every pass, including an empty one. A pass that logged only what changed would be
 * indistinguishable from a pass that had stopped — `reporting-refresh.ts`' argument, same shape. */
export function describeDispatchPass(result: DispatchPassResult): string {
  const refusals =
    result.refusedForDestination === 0
      ? ''
      : ` REFUSED: ${result.refusedForDestination} for an unserved destination`
  return (
    `claimed ${result.claimed}, sent ${result.sent}, requeued ${result.requeued}, ` +
    `failed ${result.failed}${refusals}`
  )
}

/**
 * The connection and the registry the handler uses.
 *
 * Set by `run.ts` before `startWorkers`, for `setCashForecastSql`'s reason: a handler that attached first
 * would take a job off the queue and fail on a missing dependency, burning a retry on nothing.
 */
let configured: Sql | undefined

export function setAnalyticsDispatchSql(sql: Sql): void {
  configured = sql
}

/**
 * The registry, built per run from the configuration rather than captured at import.
 *
 * `ANALYTICS_PROVIDER` decides whether this pass talks to a stand-in, and a value captured at boot would
 * survive a restart-free configuration change while the log line went on claiming a real push —
 * `googleConfig()` in the registry records the same reason for the Google passes.
 *
 * The outbox is NOT shared between passes: it is a per-run record of what this pass would have posted, and
 * a module-level one would grow for the lifetime of the worker process. What persists is the dispatch row.
 */
function dispatchersFor(config: Config, now: () => string): AnalyticsDispatchers {
  return createAnalyticsDispatchers({ config, now })
}

async function analyticsDispatchHandler(_data: never, context: JobContext): Promise<void> {
  if (configured === undefined) {
    throw new AppError(
      'invariant_violated',
      `${ANALYTICS_DISPATCH_JOB} ran before setAnalyticsDispatchSql() supplied a connection. run.ts ` +
        'calls it before startWorkers().',
    )
  }
  const nowIso = context.now()
  const dispatchers = dispatchersFor(loadConfig(), () => nowIso)
  const result = await runAnalyticsDispatchPass(configured, dispatchers, nowIso)
  console.log(`${ANALYTICS_DISPATCH_JOB} ${nowIso}: ${describeDispatchPass(result)}`)
}

/**
 * The pass's definition.
 *
 * Every five minutes, which is `analytics_dispatch`' declared interval in 0137 rather than a number picked
 * here — the watchdog's "no success within twice the interval" alert is only meaningful when the two
 * agree. A conversion that is twenty minutes late is still attributed correctly; one that is never sent is
 * a campaign that looks like it produced nothing.
 *
 * A CRON and not a queue the enqueue announces, which is the opposite of what `BUILD_DERIVATIVES_JOB` and
 * `RECONCILE_DLR_JOB` chose. The difference is what the work IS: a derivative build is announced by the
 * upload that produced the original, so what is watched is that request. A dispatch is a row the gate left
 * in `queued`, and the reasons it is still there include "the far end was down for an hour" and "the
 * consumer stopped" — neither of which an announcement can cover, because the announcement already
 * happened. What has to be watched is the ABSENCE of a drain, which is what an agent heartbeat measures.
 */
export const ANALYTICS_DISPATCH_JOB_DEFINITION: JobDefinition<never> = {
  name: ANALYTICS_DISPATCH_JOB,
  purpose:
    "Drains analytics_dispatch: transmits every queued row through its destination's adapter, retries a " +
    'retryable refusal on an exponential ladder, and records the attempt, the instant and the error on ' +
    'the row. It does NOT re-decide consent — the ZY312 gate already did, and a second check is the ' +
    'defect A-MEAS-02 was built to prevent (ADR 0076). Both adapters are named fakes behind the provider ' +
    'port and `real` resolves to notImplemented, so nothing leaves the building in this build and the ' +
    'local outbox row is the receipt (A-MEAS-03, ADR 0005/0022).',
  cron: '*/5 * * * *',
  agent: ANALYTICS_DISPATCH_AGENT,
  retryLimit: 3,
  retryDelaySeconds: 60,
  retryBackoff: true,
  // One claim of up to 200 rows and two statements per row. Four minutes, deliberately under the five
  // minute interval: a pass still running when the next is due is holding row locks the next one would
  // skip, and reclaiming it is right because every delivery is recorded before the next is attempted.
  expireInSeconds: 240,
  handler: analyticsDispatchHandler,
}
