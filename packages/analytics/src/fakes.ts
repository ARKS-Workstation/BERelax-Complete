/**
 * The local outbox, the egress guard, the retry schedule and the failure script every analytics fake
 * shares (A-MEAS-03).
 *
 * ## Why the guard here is stricter than F03's and has no allowlist
 *
 * `packages/messaging/src/send-guard.ts` (F03) diverts any message outside production unless the
 * recipient is explicitly allowlisted, and the allowlist exists because a developer's own phone is a
 * legitimate test recipient. There is no analogue for a conversion. The recipient of an analytics dispatch
 * is an advertising account, and there is no such thing as a test event in a real one: a staging run's
 * conversions land in the same property the owner reads, inflate the figures a campaign is optimised on,
 * and cannot be removed. GA4's Measurement Protocol has a debug endpoint and Meta has a test event code,
 * and both are properties of a REAL account that does not exist in this build.
 *
 * So {@link guardAnalyticsEgress} takes one argument and has no allowlist, no setting and no override:
 * outside production nothing transmits, full stop. Like F03 it is deliberately not a feature flag — any
 * switch that can be turned off eventually is.
 *
 * This is the acceptance line *"with APP_ENV != production neither adapter transmits"*, and it is asserted
 * for both adapters rather than for the shared function, because a shared guard that one adapter stopped
 * calling is exactly the failure a test of the guard alone cannot see.
 *
 * ## Why the fakes write an outbox row rather than returning bare success
 *
 * docs/12 §1 requires it of every provider, and for a conversion the reason is sharper than for a
 * message: A-MEAS-07 compares internal truth against what was PUSHED, so a dispatch that returned success
 * and left no trace turns that comparison into a comparison of our own records with themselves. The row
 * holds the provider-shaped body the real adapter would have posted, which is also the only way the shape
 * of that body is checkable at all while there is no account to post it to.
 *
 * ## The retry schedule is data and the consumer reads it
 *
 * A schedule inside the consumer's loop would be a schedule that cannot be asserted without running the
 * loop, and the thing worth asserting is that it GROWS. `analyticsRetryDelaySeconds` is total over the
 * attempt number and answers `null` past the last attempt, which is what makes "give up" a value rather
 * than a fall-through.
 */
import { type AppEnv, isProduction } from '@berelax/config'
import { AppError } from '@berelax/shared'
import {
  type AnalyticsActionSource,
  type AnalyticsDispatchRequest,
  dispatchPayloadBytes,
  type LocalDispatchRecord,
} from './port.ts'

// ---------------------------------------------------------------------------------------------
// The egress guard
// ---------------------------------------------------------------------------------------------

export type AnalyticsEgressDecision =
  | { readonly kind: 'transmit' }
  | { readonly kind: 'divert'; readonly reason: string }

/**
 * Whether an analytics dispatch may leave the building at all.
 *
 * One argument and no allowlist. See the module header: an advertising account has no test recipient, so
 * there is nothing an allowlist could name that would make a staging conversion safe.
 */
export function guardAnalyticsEgress(appEnv: AppEnv): AnalyticsEgressDecision {
  if (isProduction(appEnv)) return { kind: 'transmit' }
  return {
    kind: 'divert',
    reason:
      `APP_ENV=${appEnv}, so nothing is transmitted to any analytics destination. There is no test ` +
      "recipient for a conversion: a staging run's events land in the same property the owner reads, " +
      'inflate what a campaign is optimised on, and cannot be removed. Diverted to the local outbox, ' +
      'where the body that would have been posted is inspectable.',
  }
}

// ---------------------------------------------------------------------------------------------
// The local outbox
// ---------------------------------------------------------------------------------------------

export interface DispatchOutboxEntry {
  readonly provider: string
  readonly request: AnalyticsDispatchRequest
  readonly body: Readonly<Record<string, unknown>>
  readonly decision: AnalyticsEgressDecision
}

export interface DispatchOutbox {
  record(entry: DispatchOutboxEntry): LocalDispatchRecord
  /** Every row, in the order they were recorded. */
  all(): readonly LocalDispatchRecord[]
  /** Rows for one adapter. What `drainLocalOutbox` answers. */
  forProvider(provider: string): readonly LocalDispatchRecord[]
}

/**
 * One shared outbox for both adapters, so the owner has a single inbox and a test a single place to look.
 *
 * `now` is injected for the reason every other module in this build injects it: a recorded instant that
 * came from the ambient clock cannot be asserted, and the suites here are frozen-clock.
 *
 * The id is a counter and not a uuid. It is an index into THIS process's outbox and nothing persists it,
 * so a random id would buy nothing and make the row order unassertable.
 */
export function createDispatchOutbox(now: () => string): DispatchOutbox {
  const rows: LocalDispatchRecord[] = []
  return {
    record(entry) {
      const row: LocalDispatchRecord = {
        outboxId: `analytics-outbox-${rows.length + 1}`,
        provider: entry.provider,
        eventId: entry.request.eventId,
        destination: entry.request.destination,
        actionSource: entry.request.actionSource,
        eventTimeIso: entry.request.eventTimeIso,
        serialisedPayload: dispatchPayloadBytes(entry.request.payload),
        body: entry.body,
        transmitted: entry.decision.kind === 'transmit',
        divertedReason: entry.decision.kind === 'divert' ? entry.decision.reason : null,
        recordedAtIso: now(),
      }
      rows.push(row)
      return row
    },
    all: () => [...rows],
    forProvider: (provider) => rows.filter((row) => row.provider === provider),
  }
}

// ---------------------------------------------------------------------------------------------
// The retry schedule
// ---------------------------------------------------------------------------------------------

/** The first delay, in seconds. */
export const ANALYTICS_RETRY_BASE_SECONDS = 30
/** Each retry waits this many times as long as the one before it. */
export const ANALYTICS_RETRY_FACTOR = 2
/**
 * How many attempts a dispatch gets before it is left `failed` for somebody to look at.
 *
 * Five, so the last delay is 480 seconds and the whole ladder spans a little over fifteen minutes. The
 * number is a decision rather than a measurement and is written here so it is one decision: both
 * platforms rate-limit per account rather than per event, so a longer ladder on one row holds a worker
 * slot while every other row waits — and a `failed` row is not lost, because the consumer picks it up on
 * the next pass once an operator has dealt with the cause.
 */
export const ANALYTICS_MAX_ATTEMPTS = 5

/**
 * How long to wait before attempt `n + 1`, given that `n` attempts have been made. `null` means stop.
 *
 * Total over the integers, and it REFUSES a negative or fractional attempt count rather than computing
 * something for it: `2 ** -1` is 0.5 and would retry immediately for ever, which is the one failure mode
 * a backoff exists to prevent.
 */
export function analyticsRetryDelaySeconds(attemptsMade: number): number | null {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 0) {
    throw new AppError(
      'validation',
      `A backoff was asked for after ${attemptsMade} attempts, which is not a whole non-negative ` +
        'number. A fractional or negative exponent yields a delay below the base — which is an immediate ' +
        'retry for ever, the one failure a backoff exists to prevent.',
      { details: { attemptsMade } },
    )
  }
  if (attemptsMade >= ANALYTICS_MAX_ATTEMPTS) return null
  return ANALYTICS_RETRY_BASE_SECONDS * ANALYTICS_RETRY_FACTOR ** attemptsMade
}

// ---------------------------------------------------------------------------------------------
// The failure script
// ---------------------------------------------------------------------------------------------

/**
 * What a transport can refuse with, and whether waiting helps.
 *
 * `rate_limited` is the 429 the acceptance line names and it is RETRYABLE. `invalid_payload` is a 400 and
 * is not: retrying it five times produces five identical refusals and delays every other row behind it,
 * which is how a rate limiter is then hit for a reason that had nothing to do with rate.
 */
export const TRANSPORT_REFUSALS = ['rate_limited', 'server_error', 'invalid_payload'] as const
export type TransportRefusal = (typeof TRANSPORT_REFUSALS)[number]

export const TRANSPORT_REFUSAL_IS_RETRYABLE: Readonly<Record<TransportRefusal, boolean>> =
  Object.freeze({
    rate_limited: true,
    server_error: true,
    invalid_payload: false,
  })

/** The HTTP status each refusal corresponds to, so a fake's message reads like the real one's. */
export const TRANSPORT_REFUSAL_STATUS: Readonly<Record<TransportRefusal, number>> = Object.freeze({
  rate_limited: 429,
  server_error: 503,
  invalid_payload: 400,
})

export class TransportRefusalError extends AppError {
  readonly refusal: TransportRefusal
  readonly retryable: boolean
  constructor(provider: string, refusal: TransportRefusal) {
    super(
      'provider_unavailable',
      `${provider} answered ${TRANSPORT_REFUSAL_STATUS[refusal]} (${refusal}).`,
      { details: { provider, refusal, status: TRANSPORT_REFUSAL_STATUS[refusal] } },
    )
    this.refusal = refusal
    this.retryable = TRANSPORT_REFUSAL_IS_RETRYABLE[refusal]
  }
}

/** The named refusal on an error a fake raised, or null. */
export function transportRefusalOf(error: unknown): TransportRefusal | null {
  return error instanceof TransportRefusalError ? error.refusal : null
}

/**
 * Arms a refusal on the next call, or on the next several.
 *
 * `packages/providers`' `FailureScript` is the same idea for messaging and is deliberately not reused:
 * that class is keyed on `FAILURE_MODES`, which are a message's failures (undeliverable number, bounced
 * address), and an analytics dispatch has none of them. One script with two vocabularies would let a test
 * arm a bounce on a conversion, which is a state that cannot happen and a test that proves nothing.
 *
 * Shared between both adapters by default, because the realistic case is a rate limit hitting everything
 * at once.
 */
export class TransportScript {
  private remaining = 0
  private refusal: TransportRefusal = 'rate_limited'

  /** Refuse the next `times` calls with `refusal`. `times` of 0 disarms. */
  arm(refusal: TransportRefusal, times: number): void {
    if (!Number.isInteger(times) || times < 0) {
      throw new AppError(
        'validation',
        `A transport script was armed for ${times} calls. A fractional or negative count leaves the ` +
          'script in a state whose next answer nobody can predict, which makes the test it serves ' +
          'meaningless rather than failing.',
        { details: { times } },
      )
    }
    this.refusal = refusal
    this.remaining = times
  }

  /** Consumes one armed refusal, or returns null. */
  take(): TransportRefusal | null {
    if (this.remaining <= 0) return null
    this.remaining -= 1
    return this.refusal
  }

  get armed(): number {
    return this.remaining
  }
}

// ---------------------------------------------------------------------------------------------
// The plumbing both named fakes share
// ---------------------------------------------------------------------------------------------

export interface AnalyticsFakeContext {
  readonly appEnv: AppEnv
  readonly now: () => string
  readonly outbox: DispatchOutbox
  readonly script: TransportScript
}

/**
 * The one send path both fakes take: check the script, check the guard, record the row.
 *
 * The ORDER is the design. The script is consulted FIRST, so a test can arm a 429 off production and see
 * the retry — which is the only way the acceptance line *"a fake 429 triggers exponential backoff"* can be
 * exercised at all, since the guard would otherwise divert before any refusal could happen. The guard then
 * decides whether anything is transmitted, and the row is written either way.
 *
 * A refusal writes NO row, deliberately. The outbox is the record of a dispatch that was made; an attempt
 * the far end rejected is recorded on the dispatch ROW as an attempt and an error, where the consumer put
 * it. An outbox row per refused attempt would make A-MEAS-07 count five pushes for one conversion.
 */
export async function performFakeDispatch(
  context: AnalyticsFakeContext,
  provider: string,
  request: AnalyticsDispatchRequest,
  body: Readonly<Record<string, unknown>>,
): Promise<{ readonly record: LocalDispatchRecord; readonly decision: AnalyticsEgressDecision }> {
  const refusal = context.script.take()
  if (refusal !== null) throw new TransportRefusalError(provider, refusal)
  const decision = guardAnalyticsEgress(context.appEnv)
  const record = context.outbox.record({ provider, request, body, decision })
  return { record, decision }
}

/**
 * The event time, validated rather than trusted.
 *
 * Both adapters call it, and it is here rather than in each of them because the rule is about the EVENT
 * and not about either platform: an unparseable instant would be posted as `NaN`, which GA4 accepts and
 * dates on receipt. A-MEAS-05's whole subject is that an offline conversion carries the instant of the
 * actual visit, and the way that claim dies quietly is a bad string becoming "now" inside an adapter.
 */
export function dispatchEventTime(request: AnalyticsDispatchRequest): Date {
  const at = new Date(request.eventTimeIso)
  if (Number.isNaN(at.getTime())) {
    throw new AppError(
      'validation',
      `event_time ${JSON.stringify(request.eventTimeIso)} is not an instant. A platform that cannot ` +
        'parse it dates the conversion on receipt, so a visit two days ago would be reported as today — ' +
        'silently, and against the wrong campaign.',
      { details: { eventId: request.eventId, eventTimeIso: request.eventTimeIso } },
    )
  }
  return at
}

/** The action sources, re-exported so an adapter need not reach past this module for the type. */
export type { AnalyticsActionSource }
