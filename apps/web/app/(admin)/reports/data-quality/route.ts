import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../../src/session.ts'
import { handleDataQualityRead } from './handler.ts'

/**
 * `GET /reports/data-quality` — the HTTP plumbing for R-REP-07's data-quality screen.
 *
 * Everything the unit decides is in `handler.ts`, which `apps/web/src/data-quality.itest.ts`
 * drives directly against real PostgreSQL. This file is the session guard, the connection and the
 * admin chrome, and it holds no figure and no judgement — the split G-REV-06 records, for the reason it
 * records: a suite driving this over HTTP asserts against whatever `.next` was last built.
 *
 * **Authenticated (W-SYS-11).** `guardAdminRoute` refuses a request carrying no live staff session, and
 * `/reports` is a prefix in `ADMIN_GROUP_PREFIXES` so the proxy marks it noindex before this handler
 * runs. The authorisation beyond that is `report:read`, asked inside the handler so that the refusal
 * and its audit row are covered by the suite rather than only by a browser.
 */
export const dynamic = 'force-dynamic'

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and
  // fails closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const principal = authorised.principal
  try {
    const url = new URL(request.url)
    const now = Date.now()
    return await withSql(async (sql) =>
      handleDataQualityRead(
        {
          searchParams: url.searchParams,
          chrome: await adminChromeFor({ sql, now: now as Instant, request }),
          principal: {
            role: principal.role,
            employeeId: principal.employeeId,
            staffReference: principal.staffReference,
          },
          requestId: request.headers.get('x-request-id'),
        },
        { sql, now: () => now },
      ),
    )
  } catch (error) {
    // Plain text and a 503: a blank page listing no failing check would say "everything is sound" when
    // the truth is "nothing could be read", which is the one failure this screen must not have.
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The data-quality report could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
