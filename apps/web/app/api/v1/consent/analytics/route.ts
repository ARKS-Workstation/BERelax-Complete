import { loadConfig } from '@berelax/config'
import type { Clock, Instant } from '@berelax/core'
import { createConnection } from '@berelax/db'
import { type ConsentEndpointDeps, handleConsentRequest } from './handler.ts'

/**
 * `POST /api/v1/consent/analytics` — the wiring, and nothing else.
 *
 * The handler is next door and takes its dependencies as an argument, so the integration suite can drive
 * the same code with a frozen clock and its own connection. This file builds those dependencies from the
 * real environment once, exactly as `/api/collect/route.ts` and `/api/v1/payments/intent/route.ts` do.
 *
 * Under `/api/v1` and outside both locale groups, for the reasons `/api/collect` records: `/api` is exempt
 * from `proxy.ts` canonicalisation, so a mistyped trailing slash is a 308 rather than a 301 that would
 * downgrade this POST to a GET with the body dropped, and a consent decision is not a document, so a
 * locale would give one endpoint two URLs. The path is held in `ANALYTICS_CONSENT_PATH` so the banner and
 * the route cannot drift.
 *
 * The runtime is built LAZILY for the reason `/api/collect` gives: `loadConfig()` throws when
 * `DATABASE_URL` is absent and `next build` imports every route module to collect its exports, so a
 * connection at module scope fails the build on any machine without a database, CI included.
 *
 * `loadConfig()` is called for `DATABASE_URL` and for nothing else. There is no setting, flag or
 * environment variable on this path that could change whether consent is recorded or what it permits —
 * ADR 0076, and `packages/fixtures/src/consent-gate-arch.test.ts` is what holds it.
 */
export const dynamic = 'force-dynamic'

let runtime: ConsentEndpointDeps | undefined

function consentRuntime(): ConsentEndpointDeps {
  if (runtime !== undefined) return runtime
  const config = loadConfig()
  // Small on purpose: PgBouncer multiplexes in front of the database and the managed instance has a hard
  // connection ceiling (ADR 0004). One decision is one short transaction.
  const sql = createConnection({ url: config.DATABASE_URL, max: 4 })
  // Built here because `@berelax/core` cannot ship one: reading the clock is exactly what the purity gate
  // forbids there, so the edge supplies it and `decided_at` comes from this.
  const clock: Clock = { now: () => Date.now() as Instant }
  runtime = { sql, clock }
  return runtime
}

export async function POST(request: Request): Promise<Response> {
  return await handleConsentRequest(consentRuntime(), request)
}
