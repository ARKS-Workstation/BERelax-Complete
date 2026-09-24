import { loadConfig } from '@berelax/config'
import { suppressionKeyNormaliser } from '@berelax/core'
import { createConnection, loadSuppressionPeppers } from '@berelax/db'
import {
  handlePreferenceRead,
  handlePreferenceWrite,
  type PreferenceEndpointDeps,
} from './handler.ts'

/**
 * `/api/v1/preferences` — the wiring, and nothing else.
 *
 * The handler lives next door in `handler.ts` and takes its dependencies as an argument, so the
 * integration suite can drive it with a frozen clock and a known pepper. This file exists to build those
 * dependencies from the real environment exactly once, and it is the only place in the app that knows a
 * database connection or a pepper exists.
 *
 * ## Why the token is a query parameter and not a path segment
 *
 * `?c=<contact>&t=<token>` keeps the route unparameterised, which is worth something on its own — a
 * parameterised handler needs sample params in the route registry and an answer about prerendering — but
 * the real reason is the one the OTP route gives for being outside both locale groups: this is one
 * endpoint with one URL. A path token would also make the capability part of the resource identity, so
 * every log line, every `Referer` and every screenshot of the address bar would carry a different URL for
 * the same page.
 *
 * ## Why the runtime is built lazily
 *
 * `loadConfig()` throws when `DATABASE_URL` is absent and `loadSuppressionPeppers` throws when
 * `SUPPRESSION_PEPPER` is, and `next build` imports every route module to collect its exports. Building
 * either at module scope would therefore fail the build on any machine without a database or a secret
 * store — including CI, where the build step has no reason to have either. A memoised getter moves the
 * failure to the first request, which is where a missing secret should surface: loudly, in the logs, on a
 * box somebody is watching. The pepper's absence is NOT defaulted here, and the reason is the whole of why
 * it exists: keys computed under an empty pepper match nothing, so the endpoint would report a successful
 * unsubscribe and suppress nobody.
 */

/** Nothing here can be prerendered or cached: it verifies a capability and writes rows. */
export const dynamic = 'force-dynamic'

let runtime: PreferenceEndpointDeps | undefined

function preferenceRuntime(): PreferenceEndpointDeps {
  if (runtime !== undefined) return runtime
  const config = loadConfig()
  // Small on purpose, for the reason the OTP route gives: PgBouncer multiplexes in front of the database
  // and the managed instance has a hard connection ceiling (ADR 0004).
  const sql = createConnection({ url: config.DATABASE_URL, max: 4 })
  const built: PreferenceEndpointDeps = {
    sql,
    now: () => new Date().toISOString(),
    keying: {
      peppers: loadSuppressionPeppers(config),
      // The one normaliser this system has, injected because `packages/db` may not import
      // `packages/core`. There is no fallback: an un-normalised key matches nothing and no constraint
      // can catch it, because the plaintext never reaches a column.
      normalise: suppressionKeyNormaliser,
    },
  }
  runtime = built
  return built
}

export async function GET(request: Request): Promise<Response> {
  return await handlePreferenceRead(preferenceRuntime(), request)
}

export async function POST(request: Request): Promise<Response> {
  return await handlePreferenceWrite(preferenceRuntime(), request)
}
