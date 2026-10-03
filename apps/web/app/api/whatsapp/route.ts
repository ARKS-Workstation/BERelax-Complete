import { loadConfig } from '@berelax/config'
import type { Clock, Instant } from '@berelax/core'
import { createConnection } from '@berelax/db'
import { takeRateLimit, withRateLimitHeaders } from '../../../src/security/rate-limit.ts'
import { handleWhatsappIssueRequest, type WhatsappIssueDeps } from './issue.ts'

/**
 * `GET /api/whatsapp` — the wiring, and nothing else.
 *
 * The issue path is next door and takes its dependencies as an argument, so the integration suite drives
 * the same code with a frozen clock and its own connection. This file builds those dependencies from the
 * real environment once, exactly as `app/api/collect/route.ts` does.
 *
 * Under `/api` and outside both locale groups, for `/api/collect`'s three reasons: `/api` is exempt from
 * `proxy.ts` canonicalisation, a reference code is not a document so a locale would give one endpoint two
 * URLs, and the path is what A-FIRST-06's collector attaches the WhatsApp call to action to.
 *
 * GET and not POST, although it writes a row. The caller is a link a customer taps, and a link is a GET;
 * making it a POST would mean a form or a fetch, and a fetch cannot hand the navigation to WhatsApp. The
 * write is not idempotent in the "same answer" sense — a second tap issues a second code — and that is
 * correct rather than tolerated: the manifest's contract is many codes to one session (0079), a
 * conversation reopened a week later deserves a live code, and both attribute to the same session. What
 * would be wrong is a cached response, which `no-store` on every answer refuses.
 *
 * ## Why the runtime is built lazily
 *
 * `loadConfig()` throws when `DATABASE_URL` is absent and `next build` imports every route module to
 * collect its exports, so building the connection at module scope fails the build on any machine without a
 * database — including CI. A memoised getter moves the failure to the first request, which is where a
 * missing secret should surface.
 */
export const dynamic = 'force-dynamic'

let runtime: WhatsappIssueDeps | undefined

function whatsappRuntime(): WhatsappIssueDeps {
  if (runtime !== undefined) return runtime
  const config = loadConfig()
  // Small on purpose: PgBouncer multiplexes in front of the database and the managed instance has a hard
  // connection ceiling (ADR 0004). One issue is a handful of statements in one short transaction.
  const sql = createConnection({ url: config.DATABASE_URL, max: 4 })
  // Built here because `@berelax/core` cannot ship one: reading the clock is exactly what the purity gate
  // forbids there, so the edge supplies it and the instant this request stamps comes from this.
  const clock: Clock = { now: () => Date.now() as Instant }
  runtime = { sql, clock }
  return runtime
}

export async function GET(request: Request): Promise<Response> {
  // H-HARD-01: a GET that WRITES — a reference-code row — which is why it is limited although it is a read
  // by method. The ceiling fails towards PERMITTING: a refused tap is a customer who reaches WhatsApp
  // without a reference code, which is an attribution gap rather than a refusal anybody sees.
  const limit = await takeRateLimit({
    scope: 'whatsapp_ref',
    request,
    nowIso: new Date().toISOString(),
  })
  if (limit.kind === 'refused') return limit.response
  const response = await handleWhatsappIssueRequest(whatsappRuntime(), request)
  return withRateLimitHeaders(response, limit.headers)
}
