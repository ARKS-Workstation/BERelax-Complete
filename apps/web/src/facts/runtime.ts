import { loadConfig } from '@berelax/config'
import { createConnection } from '@berelax/db'
import type { FactsDeps } from './handlers.ts'

/**
 * The one database connection the three machine surfaces share, built on first use.
 *
 * Lazy for the reason `app/api/v1/otp/route.ts` records: `loadConfig()` throws when `DATABASE_URL` is
 * absent and `next build` imports every route module to collect its exports, so building a connection at
 * module scope fails the build on any machine without a database — which includes CI, where the build step
 * runs before the migrations are applied. A memoised getter moves the failure to the first request, where a
 * missing secret should surface: loudly, in the logs, on a box somebody is watching.
 *
 * One runtime for all three routes rather than one each, because they are three views of one read, and
 * `max: 2` is already generous: PgBouncer multiplexes in front of the database and the managed instance has
 * a hard connection ceiling (ADR 0004).
 */
let runtime: FactsDeps | undefined

export function factsRuntime(): FactsDeps {
  if (runtime !== undefined) return runtime
  const config = loadConfig()
  runtime = {
    sql: createConnection({ url: config.DATABASE_URL, max: 2 }),
    now: () => new Date().toISOString(),
  }
  return runtime
}
