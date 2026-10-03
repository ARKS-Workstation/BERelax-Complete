import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../../src/session.ts'
import { handleCampaignsRead } from './handler.ts'

/**
 * `GET /crm/campaigns` — the Next binding for the campaigns screen (C-AUTO-10).
 *
 * Everything decidable lives in `./handler.ts`; this file is the connection, the clock and the one verb.
 * The same split `app/(admin)/crm/pipeline/route.ts` takes, and for the same reason: a route file that
 * held the logic could only be tested through a server, and the staleness of a cached count is a
 * comparison between two instants that cannot be frozen behind a `next start`.
 */
export const dynamic = 'force-dynamic'

/**
 * A connection per request, closed in a `finally`.
 *
 * `max: 2` for the reason the diary, the HR, compliance and pipeline routes give: this is a page load,
 * and the integration suite opens a 64-connection pool of its own to prove a row lock — a route that
 * held a large pool would make `sorry, too many clients already` a property of somebody else's run.
 */
async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** The failure this screen must not have: a blank page that reads as "no campaigns". */
function unavailable(error: unknown): Response {
  const message = isAppError(error) ? error.message : 'Unexpected'
  return new Response(`The campaigns could not be read: ${message}\n`, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and
  // fails closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    return await withSql(async (sql) =>
      handleCampaignsRead(
        { chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }) },
        { sql, now: () => Date.now() as Instant },
      ),
    )
  } catch (error) {
    return unavailable(error)
  }
}
