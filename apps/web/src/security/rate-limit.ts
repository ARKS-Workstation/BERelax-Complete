import { loadConfig } from '@berelax/config'
import { createConnection, recordRateLimitHit, recordRateLimitRefusal, type Sql } from '@berelax/db'
import {
  decideRateLimit,
  RATE_LIMIT_POLICIES,
  type RateLimitDecision,
  type RateLimitScope,
  rateLimitHeaders,
  rateLimitKey,
  windowStartFor,
} from '@berelax/shared'

/**
 * The one way a public endpoint takes its rate limit (H-HARD-01).
 *
 * ## One function, four call sites, and why it is not middleware
 *
 * The proxy could do this and must not: it cannot reach the database — `apps/web/proxy.ts` says so at
 * length, and `src/session-cookie.ts` records why a driver cannot be imported there — and a rate limit
 * whose state is in the process is the thing the acceptance line refuses. So the limit is taken by the
 * handler, which already has a connection or can open one, and `scripts/check-headers.mjs` is what
 * asserts every declared public endpoint takes it: a route added tomorrow without a limit fails a gate
 * rather than being discovered by a bill.
 *
 * ## The caller's address, and what happens when there is not one
 *
 * `callerAddress` is the OTP endpoint's, re-used rather than re-written, and its decision carries:
 * `x-forwarded-for`'s first entry, validated as an address, and NULL when there is nothing usable. A null
 * key means this module does NOT limit the request, and the consequence is stated rather than hidden — a
 * placeholder key would put every unidentifiable caller in one bucket and refuse them as one, so a
 * misconfigured proxy would take all four public endpoints down at once. The gate asserts the endpoints
 * call this; it cannot assert a proxy is configured, and pretending otherwise would be the worse failure.
 *
 * ## The counting happens before the work, and the refusal records itself
 *
 * `recordRateLimitHit` is one upsert returning the new count; `decideRateLimit` in `@berelax/shared` is
 * what the count means. A refusal then writes `refusals = refusals + 1` as a SECOND statement, which is
 * what makes the ceiling observable: `hits` is the traffic and `refusals` is how often the ceiling fired,
 * and the two together are the only way to tell a limit that is working from one that is too low.
 */

/** What a guarded handler gets back. `refused` carries the response it must return unchanged. */
export type RateLimitOutcome =
  | { readonly kind: 'allowed'; readonly headers: Readonly<Record<string, string>> }
  | { readonly kind: 'refused'; readonly response: Response }
  | {
      /** No usable caller address, so nothing was counted. See the module header. */
      readonly kind: 'unidentified'
      readonly headers: Readonly<Record<string, string>>
    }

/**
 * Reads the caller address from the proxy headers, or returns null.
 *
 * Validated rather than trusted, and NULL rather than a placeholder: a header of free text would put
 * every such request in one bucket and rate-limit them as if they were one caller. This is
 * `apps/web/app/api/v1/otp/handler.ts`'s `callerAddress`, lifted here so the four endpoints share one
 * reading — two readings of "who is calling" is two definitions of a bucket.
 */
export function callerAddressFrom(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for') ?? headers.get('x-real-ip')
  if (forwarded === null) return null
  const first = forwarded.split(',')[0]?.trim() ?? ''
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/
  const ipv6 = /^[0-9a-f:]{2,45}$/i
  return ipv4.test(first) || ipv6.test(first) ? first : null
}

/**
 * The refusal body.
 *
 * JSON with a named error and the retry-after, because every caller of these four endpoints is a program:
 * a booking form's fetch, an SMS client, the analytics beacon and a gateway. The reason is included
 * because the remedy differs from every other 429 in this build — this one is "you are going too fast",
 * not "you have run out of guesses" — and `Retry-After` is what a well-behaved client waits on.
 */
function refusedResponse(headers: Readonly<Record<string, string>>): Response {
  return new Response(JSON.stringify({ error: 'too_many_requests', reason: 'rate_limited' }), {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Never cached and never shared. A CDN in front of one of these routes with a default policy
      // would serve one caller's refusal to another, which is the OTP handler's own note.
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

/**
 * Takes the limit for one scope.
 *
 * `sql` is passed when the caller already has a connection and opened here otherwise, with `max: 1`,
 * which is `guardAdminRoute`'s arrangement and its reason: threading a connection out to the top of four
 * handlers written by other units to add a check is how a mechanical change acquires real defects.
 */
export async function takeRateLimit(args: {
  readonly scope: RateLimitScope
  readonly request: Request
  readonly nowIso: string
  readonly sql?: Sql
}): Promise<RateLimitOutcome> {
  const policy = RATE_LIMIT_POLICIES[args.scope]
  const key = rateLimitKey(callerAddressFrom(args.request.headers))
  if (key === null) {
    // Nothing counted and nothing refused. The headers still go out, so a caller can see the ceiling
    // exists even when this request was not attributed to anybody.
    return {
      kind: 'unidentified',
      headers: {
        'ratelimit-limit': String(policy.limit),
        'ratelimit-policy': `${policy.limit};w=${policy.windowSeconds}`,
      },
    }
  }

  const atMs = Date.parse(args.nowIso)
  const windowStartedAtMs = windowStartFor(policy, atMs)
  const windowStartedAtIso = new Date(windowStartedAtMs).toISOString()

  /*
    The connection this function opened, or null when the caller supplied one — and the only thing the
    `finally` is allowed to close. Assigned on its own line rather than inside the `??`, which is both
    what the linter asks for and clearer about the invariant: a caller's pool must survive this call.
  */
  let own: Sql | null = null
  if (args.sql === undefined) own = createConnection({ url: loadConfig().DATABASE_URL, max: 1 })
  try {
    const sql = args.sql ?? (own as Sql)
    const hit = await recordRateLimitHit(sql, {
      scope: args.scope,
      key,
      windowStartedAtIso,
      atIso: args.nowIso,
    })
    const decision: RateLimitDecision = decideRateLimit({
      policy,
      hits: hit.hits,
      windowStartedAtMs: hit.windowStartedAtMs,
      atMs,
    })
    const headers = rateLimitHeaders(policy, decision)
    if (decision.kind === 'allow') return { kind: 'allowed', headers }
    // The refusal records itself, which is what makes the ceiling measurable: `hits` is the traffic and
    // `refusals` is how often it fired.
    await recordRateLimitRefusal(sql, { scope: args.scope, key, windowStartedAtIso })
    return { kind: 'refused', response: refusedResponse(headers) }
  } finally {
    if (own !== null) await own.end({ timeout: 5 })
  }
}

/**
 * The rate-limit headers added to a response the handler already built.
 *
 * A new `Response` around the old one's body rather than a mutation, because a `Response`'s headers are
 * immutable once it has been constructed in some runtimes and a silent no-op is the worst version of
 * this: the limit would be taken, the refusal would work, and the OBSERVABLE half — a caller seeing its
 * own remaining budget — would be missing with nothing saying so.
 *
 * The handler's own headers win on a collision. There is no overlap today and saying which way round it
 * goes is cheaper than discovering it: a handler that set its own `retry-after` means something more
 * specific by it than "you are going too fast".
 */
export function withRateLimitHeaders(
  response: Response,
  headers: Readonly<Record<string, string>>,
): Response {
  const merged = new Headers(response.headers)
  for (const [name, value] of Object.entries(headers)) {
    if (!merged.has(name)) merged.set(name, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  })
}
