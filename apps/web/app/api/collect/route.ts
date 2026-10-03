import { loadConfig } from '@berelax/config'
import type { Clock, Instant } from '@berelax/core'
import { createConnection } from '@berelax/db'
import { siteOrigin } from '../../../src/routes/alternates.ts'
import { takeRateLimit, withRateLimitHeaders } from '../../../src/security/rate-limit.ts'
import { type CollectEndpointDeps, handleCollectRequest } from './ingest.ts'

/**
 * `POST /api/collect` — the wiring, and nothing else.
 *
 * The ingest is next door and takes its dependencies as an argument, so `collect.itest.ts` can drive the
 * same code with a frozen clock and its own rate-limiter state. This file builds those dependencies from
 * the real environment once, exactly as `app/api/v1/payments/intent/route.ts` does.
 *
 * Under `/api` and outside both locale groups, for the three reasons the endpoints beside it record:
 * `/api` is exempt from `proxy.ts` canonicalisation, so a mistyped trailing slash is a 308 rather than a
 * 301 that would downgrade this POST to a GET with the body dropped; a measurement is not a document, so a
 * locale would give one endpoint two URLs; and `/api/collect` is the path A-FIRST-06's collector is built
 * against, held in `COLLECT_PATH` so the two cannot drift.
 *
 * ## Why the runtime is built lazily
 *
 * `loadConfig()` throws when `DATABASE_URL` is absent and `next build` imports every route module to
 * collect its exports, so building the connection at module scope fails the build on any machine without a
 * database — including CI. A memoised getter moves the failure to the first request, which is where a
 * missing secret should surface.
 *
 * ## The rate limiter's state lives here, and what that means
 *
 * `rateLimitHits` is per PROCESS, and that is stated rather than implied: two application instances behind
 * a load balancer would each allow the budget, so the effective ceiling is the budget times the instance
 * count. It is the right trade for this endpoint — the alternative is a database write per request to
 * protect a table from being written to — and the ceiling is generous enough (see
 * `COLLECT_RATE_MAX_REQUESTS`, derived from the batch cap) that a multiple of it is still far above any
 * real client. If this ever needs to be exact across instances, the state moves and nothing else does:
 * `decideCollectRate` is pure and takes the hit list as an argument.
 */
export const dynamic = 'force-dynamic'

let runtime: CollectEndpointDeps | undefined

function collectRuntime(): CollectEndpointDeps {
  if (runtime !== undefined) return runtime
  const config = loadConfig()
  // Small on purpose: PgBouncer multiplexes in front of the database and the managed instance has a hard
  // connection ceiling (ADR 0004). One batch is a handful of statements in one short transaction.
  const sql = createConnection({ url: config.DATABASE_URL, max: 4 })
  // Built here because `@berelax/core` cannot ship one: reading the clock is exactly what the purity gate
  // forbids there, so the edge supplies it and every instant this request stamps comes from this.
  const clock: Clock = { now: () => Date.now() as Instant }
  runtime = {
    sql,
    clock,
    rateLimitHits: new Map(),
    /*
     * The hosts that are US, so an internal navigation is not read as a referral (ADR 0058).
     *
     * From `siteOrigin()` — the one place this application decides what its own origin is, which the
     * canonical URL, the `hreflang` set, the sitemap and `robots.txt` all already read — and not from a
     * literal or a second environment variable. `www.` goes beside the apex because they are two hosts to
     * a `Referer` header and one site to a visitor. Reading it from there rather than hard-coding the
     * production host is what stops every internal navigation on staging being recorded as a referral
     * from production.
     */
    ownHosts: ownHostsFrom(siteOrigin()),
  }
  return runtime
}

function ownHostsFrom(origin: string): readonly string[] {
  try {
    const host = new URL(origin).hostname
    return host.startsWith('www.') ? [host, host.slice(4)] : [host, `www.${host}`]
  } catch {
    // A malformed origin is a configuration fault and not this request's to fail on: an empty list means
    // every referrer is external, which over-reports referrals and never loses a session.
    return []
  }
}

export async function POST(request: Request): Promise<Response> {
  // H-HARD-01. The highest ceiling of the four and still a ceiling: a beacon endpoint with none is a
  // write amplifier pointed at the database it exists to keep traffic away from.
  const limit = await takeRateLimit({ scope: 'collect', request, nowIso: new Date().toISOString() })
  if (limit.kind === 'refused') return limit.response
  const response = await handleCollectRequest(collectRuntime(), request)
  return withRateLimitHeaders(response, limit.headers)
}
