import { loadConfig } from '@berelax/config'
import { createConnection } from '@berelax/db'
import { handleTreatmentPath, type TreatmentPathDeps } from './handler.ts'

/**
 * `GET /treatments/<slug>` — the wiring, and nothing else. The resolution is in `handler.ts`.
 *
 * Lazily built for the same reason the OTP route is: `loadConfig()` throws without `DATABASE_URL`, and
 * `next build` imports every route module to collect its exports, so a connection at module scope fails
 * the build on any machine without a database — including CI, which has no reason to have one.
 *
 * W-SITE-05 replaces this file with the rendered page; see the header of `handler.ts`.
 */

/** Resolves a slug against the catalogue and the redirect map on every request. Nothing to prerender. */
export const dynamic = 'force-dynamic'

let runtime: TreatmentPathDeps | undefined

function treatmentRuntime(): TreatmentPathDeps {
  if (runtime !== undefined) return runtime
  const config = loadConfig()
  // Two short reads per request, and PgBouncer multiplexes in front of the database (ADR 0004).
  runtime = { sql: createConnection({ url: config.DATABASE_URL, max: 4 }) }
  return runtime
}

export async function GET(request: Request): Promise<Response> {
  return await handleTreatmentPath(treatmentRuntime(), request)
}
