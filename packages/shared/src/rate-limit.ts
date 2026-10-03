/**
 * The public endpoints' rate limits: the policy, the decision, and the figures that are provisional
 * (H-HARD-01).
 *
 * ## Why the limit is a FIXED WINDOW and not a token bucket
 *
 * A token bucket is the better algorithm and it needs state that moves continuously, which means either a
 * row updated on every request or an in-process counter. The second is refused by the acceptance line —
 * *"rate-limit state is server-side and survives a worker restart"* — and the first buys smoothness this
 * build has no use for: the endpoints below are a booking form, an SMS code, an analytics beacon and a
 * gateway webhook, and what each one needs is a ceiling per window rather than a smooth rate.
 *
 * A fixed window also has the property that matters most here: the stored state is the OBSERVATION. One
 * row per (scope, key, window) holding the hits, the refusals and the first and last instant means the
 * question "is this limit right" is answerable from the table, which is what makes it a measurement
 * rather than a guess. A bucket's state is a level and a timestamp, from which nothing about the past can
 * be read.
 *
 * The cost, stated: a caller can take `limit` requests at the end of one window and `limit` again at the
 * start of the next, so the worst case over a window's length is twice the limit. That is acceptable for
 * every scope below and would not be for a payment authorisation, which has no rate limit here because it
 * is behind a session.
 *
 * ## The figures are PROVISIONAL and say so
 *
 * {@link RATE_LIMIT_OPEN_QUESTION} is on every policy. Nobody has measured what a normal Friday looks
 * like on this estate, so every number here is a ceiling somebody chose rather than a figure somebody
 * observed — and the honest thing is to say so and to record the hits, not to pick a round number and
 * present it as tuned. `readRateLimitWindows` in `@berelax/db` is what makes the measurement possible
 * later, and `rate_limit_window` is append-mostly: the counters move, the windows accumulate.
 *
 * Each number is nonetheless chosen in the direction that fails safely for THAT endpoint, and the reason
 * is beside it, because a limit with no reason is a limit somebody raises when it fires.
 */

/** The scopes, one per public endpoint. A new unauthenticated endpoint adds one here. */
export const RATE_LIMIT_SCOPES = [
  'booking',
  'collect',
  'payment_webhook',
  'consent',
  'payment_intent',
  'whatsapp_ref',
] as const

export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number]

/** Nobody has measured a normal day on this estate. Every figure below is a ceiling, not an observation. */
export const RATE_LIMIT_OPEN_QUESTION = 'Y13-rate-limits' as const

/**
 * How long a closed window is kept, and why there is a figure here at all.
 *
 * The key is a caller's IP address, which is personal data under the PDPL (docs/04 §8). A rate limit is
 * about the only purpose for which keeping one is plainly proportionate — it is the control, and it cannot
 * work without a bucket per caller — but that argument covers keeping it for the length of a WINDOW, not
 * for ever. A counter table that is never swept is an access log nobody declared, and
 * `check-processor-register.mjs` asks every processor row for a retention sentence precisely because an
 * unstated retention is the one that turns out to be infinite.
 *
 * So: fourteen days, and the number is bounded rather than chosen. It has to outlast the longest window
 * (ten minutes) by enough that the measurement `Y13-rate-limits` asks for is still answerable — "did this
 * ceiling fire last week" is the question that decides whether a figure is right — and it has to be short
 * enough that the table is not a history of who visited. Two weeks is one of each.
 *
 * `deleteRateLimitWindowsBefore` in `@berelax/db` is the sweep, and it runs as the OWNER because
 * `berelax_app` holds no DELETE on this table — a caller who could delete their own window could reset
 * their own ceiling. **Nothing schedules it yet**, and that is stated rather than implied: the worker's
 * retention pass belongs to C-CRM-10 and is driven by a retention profile and legal holds, which is a
 * different machine from "drop rows older than N days". H-HARD-01 ships the mechanism and the proof it
 * works; the schedule is `Y13-rate-limits`' second half.
 */
export const RATE_LIMIT_RETENTION_DAYS = 14

export interface RateLimitPolicy {
  readonly scope: RateLimitScope
  /** Requests permitted per window, per key. */
  readonly limit: number
  readonly windowSeconds: number
  /** Why this number rather than another, and which direction it fails in. */
  readonly why: string
}

/**
 * The policies.
 *
 * Per IP, one scope per CLASS of endpoint. `/api/v1/book` and `/api/v1/bookings` are the same operation
 * under two spellings and share `booking`, because two ceilings over one operation is two ways to be wrong
 * about it.
 *
 * ## There is no `otp` scope, and that is the same rule applied to this unit's own work
 *
 * `/api/v1/otp` is the one endpoint the acceptance line names that is NOT here. A-FIRST-02 already holds
 * both of its ceilings — `OTP_MAX_REQUESTS_PER_PHONE = 3` and `OTP_MAX_REQUESTS_PER_IP = 10` in
 * `packages/db/src/repositories/otp.ts` — counted over `otp_challenge` rows inside `issueOtpChallenge`'s
 * own transaction, with an `otp.rate_limited` audit row and an integration test per ceiling. That state is
 * in PostgreSQL and survives a worker restart, which is what acceptance line 5 asks for.
 *
 * This unit added an `otp` policy of 10 per ten minutes per IP before anybody looked, which is the SAME
 * NUMBER in a second table under a second window definition. Two counters that agree today disagree the
 * first time one is tuned, and the loser is the stricter one — so `OTP_MAX_REQUESTS_PER_IP` would have
 * become a constant that still had a passing test and no longer decided anything. It was removed.
 * `scripts/check-headers.mjs` classifies that endpoint `own_rate_limit` and names the constant, so the
 * exemption is checkable rather than remembered.
 */
export const RATE_LIMIT_POLICIES: Readonly<Record<RateLimitScope, RateLimitPolicy>> = Object.freeze(
  {
    booking: {
      scope: 'booking',
      limit: 20,
      windowSeconds: 600,
      why:
        'A customer books once and corrects it twice. Twenty in ten minutes from one address is generous ' +
        'for a household and a salon terminal sharing a connection, and far below the rate at which ' +
        'enumerating slots becomes useful. It fails towards PERMITTING, because a refused booking is lost ' +
        'revenue and the transaction behind it has its own idempotency key and its own row lock.',
    },
    collect: {
      scope: 'collect',
      limit: 240,
      windowSeconds: 60,
      why:
        'An analytics beacon fires several times per page view, so the ceiling is per minute and high. Four ' +
        'a second from one address is well above a real visitor and well below what would make the endpoint ' +
        'a write amplifier. It fails towards PERMITTING: a dropped beacon is a gap in a chart, and the ' +
        'consent gate in front of it is the control that matters.',
    },
    consent: {
      scope: 'consent',
      limit: 60,
      windowSeconds: 600,
      why:
        'A visitor decides consent once and changes their mind twice. Sixty in ten minutes from one ' +
        'address is far above a household and far below the rate at which an unauthenticated INSERT ' +
        'becomes a write amplifier — and this endpoint is an unauthenticated write, which is the class ' +
        'the acceptance line is about even though it does not name this URL. The ceiling is high on ' +
        'purpose: a refused consent decision is a visitor who cannot withdraw consent, so it fails ' +
        'towards PERMITTING and exists against a flood rather than to shape traffic.',
    },
    payment_intent: {
      scope: 'payment_intent',
      limit: 60,
      windowSeconds: 600,
      why:
        'An interim control, and the honest reason is `Y7-intent-endpoint-auth`: nobody has decided who ' +
        'may call this endpoint, so today it is an unauthenticated POST that creates a payment intent. A ' +
        'ceiling is not the answer to that question and this policy does not pretend to be — it bounds ' +
        'the damage until the question is answered. Sixty in ten minutes is well above one front desk ' +
        'taking payments and well below enumerating intents, and it fails towards PERMITTING because a ' +
        'refused intent is a customer standing at the till.',
    },
    whatsapp_ref: {
      scope: 'whatsapp_ref',
      limit: 60,
      windowSeconds: 600,
      why:
        'A tap on a link, which writes a reference-code row. Unauthenticated and a write, so the same ' +
        'argument as `consent`, and the same high ceiling for the same reason — a refused tap is a ' +
        'customer who reaches WhatsApp with no reference code, which is A-FIRST-06s attribution gap ' +
        'rather than a refusal anybody sees. It fails towards PERMITTING.',
    },
    payment_webhook: {
      scope: 'payment_webhook',
      limit: 600,
      windowSeconds: 60,
      why:
        'A gateway retries, sometimes hard, and refusing its delivery is how an event is lost — which is ' +
        'the quietest failure in the payments estate (ADR 0101). Ten a second is far above any real ' +
        'settlement burst and the signature check in front of it is the real gate, so this is a ceiling ' +
        'against an unsigned flood rather than a throttle. It fails towards PERMITTING, deliberately.',
    },
  },
)

/** The state a window holds, which is also the observation. */
export interface RateLimitWindow {
  readonly scope: RateLimitScope
  readonly key: string
  /** The window's start, as epoch milliseconds. */
  readonly windowStartedAtMs: number
  readonly hits: number
  readonly refusals: number
}

export type RateLimitDecision =
  | { readonly kind: 'allow'; readonly hits: number; readonly remaining: number }
  | {
      readonly kind: 'refuse'
      readonly hits: number
      readonly retryAfterSeconds: number
    }

/** The window an instant belongs to, floored to the policy's length. */
export function windowStartFor(policy: RateLimitPolicy, atMs: number): number {
  const length = policy.windowSeconds * 1000
  return Math.floor(atMs / length) * length
}

/**
 * The decision, from the policy and the window's own counters.
 *
 * Pure, and it takes the window rather than reading one: the read and the increment are a single
 * statement in `@berelax/db` (`recordRateLimitHit`), because two statements is how two workers both see
 * `hits = limit - 1` and both allow. This function is what that statement's answer MEANS, and it is
 * separate so the arithmetic — the boundary, the retry-after — is provable without a database.
 *
 * `hits` is the count INCLUDING this request, which is the shape the one-statement upsert returns. The
 * boundary is therefore `hits > limit`: a policy of 20 permits the twentieth request and refuses the
 * twenty-first. Written as `>` rather than `>=` with a comment, because this is the off-by-one that is
 * only ever found by a test at the boundary.
 */
export function decideRateLimit(args: {
  readonly policy: RateLimitPolicy
  readonly hits: number
  readonly windowStartedAtMs: number
  readonly atMs: number
}): RateLimitDecision {
  const { policy, hits, windowStartedAtMs, atMs } = args
  if (hits <= policy.limit) {
    return { kind: 'allow', hits, remaining: policy.limit - hits }
  }
  const endsAtMs = windowStartedAtMs + policy.windowSeconds * 1000
  // At least one second, always. A `Retry-After: 0` is a header that invites an immediate retry, which is
  // the opposite of what a refusal means — and the last millisecond of a window rounds to zero.
  const retryAfterSeconds = Math.max(1, Math.ceil((endsAtMs - atMs) / 1000))
  return { kind: 'refuse', hits, retryAfterSeconds }
}

/**
 * The response headers a rate-limited endpoint carries, refused or not.
 *
 * On the ALLOWED response too, which is the half that makes the limit observable from outside: a client
 * that can see its own remaining budget can slow down, and an operator debugging "the booking form is
 * refusing" can see the ceiling without reading the table. `RateLimit-*` rather than the `X-` spellings,
 * because the un-prefixed names are what the IETF draft settled on and the `X-` ones differ per vendor.
 */
export function rateLimitHeaders(
  policy: RateLimitPolicy,
  decision: RateLimitDecision,
): Readonly<Record<string, string>> {
  const base = {
    'ratelimit-limit': String(policy.limit),
    'ratelimit-remaining': String(decision.kind === 'allow' ? decision.remaining : 0),
    'ratelimit-policy': `${policy.limit};w=${policy.windowSeconds}`,
  }
  return decision.kind === 'allow'
    ? Object.freeze(base)
    : Object.freeze({ ...base, 'retry-after': String(decision.retryAfterSeconds) })
}

/**
 * The key a scope is counted per, or null when there is nothing to count.
 *
 * Null when the caller's address could not be read, and the consequence is stated rather than hidden: an
 * unidentifiable caller is NOT rate-limited by this module. The alternative — a placeholder key — puts
 * every such request in one bucket and refuses them as if they were one caller, which is
 * `callerAddress`'s own argument in `apps/web/app/api/v1/otp/handler.ts` and is the worse failure: a
 * misconfigured proxy would take the public endpoints down for everybody at once.
 */
export function rateLimitKey(address: string | null): string | null {
  if (address === null) return null
  const trimmed = address.trim().toLowerCase()
  return trimmed.length === 0 ? null : trimmed
}
