import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../src/session.ts'
import { handleDashboardExport, handleDashboardRead } from './handler.ts'

/**
 * `GET /reports` and `POST /reports` — the HTTP plumbing for R-REP-08's role-scoped dashboards.
 *
 * Everything the unit decides is in `handler.ts`, which `apps/web/src/dashboards.itest.ts` drives
 * directly against real PostgreSQL. This file is the session guard, the connection and the admin
 * chrome, for the reason G-REV-06 records: a suite driving this over HTTP asserts against whatever
 * `.next` was last built.
 *
 * **Authenticated (W-SYS-11).** `guardAdminRoute` refuses a request with no live staff session, and
 * `/reports` is a prefix in `ADMIN_GROUP_PREFIXES` so the proxy marks it noindex before this runs. The
 * dashboard, the scope and the tiles all come from the PRINCIPAL's role. No query parameter chooses a
 * principal, a role, a scope or a permission.
 *
 * The POST is the export, and it is a POST because it writes: an `audit_event` with
 * `operation = 'export'` plus the insider-threat alert, in one transaction. A GET that exported would
 * put an actor nobody signed in with into an append-only trail.
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

const unavailable = (error: unknown): Response => {
  // Plain text and a 503: a blank dashboard reads as a business with no takings, which is the one
  // failure this screen must not have.
  const message = isAppError(error) ? error.message : 'Unexpected'
  return new Response(`The dashboard could not be read: ${message}\n`, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export async function GET(request: Request): Promise<Response> {
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const principal = authorised.principal
  try {
    const url = new URL(request.url)
    const now = Date.now()
    return await withSql(async (sql) =>
      handleDashboardRead(
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
    return unavailable(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const principal = authorised.principal
  try {
    const url = new URL(request.url)
    const now = Date.now()
    // `application/x-www-form-urlencoded` only. This screen has one `<form method="post">` and no JSON
    // client, which is what makes the export work with JavaScript off. A body that is not form-encoded
    // parses to an empty `URLSearchParams`, which the handler refuses by name rather than with a 500.
    const body = new URLSearchParams(await request.text())
    return await withSql(async (sql) =>
      handleDashboardExport(
        {
          searchParams: url.searchParams,
          chrome: await adminChromeFor({ sql, now: now as Instant, request }),
          principal: {
            role: principal.role,
            employeeId: principal.employeeId,
            staffReference: principal.staffReference,
          },
          requestId: request.headers.get('x-request-id'),
          body,
        },
        {
          sql,
          now: () => now,
          // The two writes — the audit row and the alert notification — in ONE transaction: all three
          // or none, because an export with no audit row is what the trail exists to make impossible
          // and an audit row for an export that failed is a false record.
          withTransaction: (run) => sql.begin((tx) => run(tx as unknown as Sql)) as never,
        },
      ),
    )
  } catch (error) {
    return unavailable(error)
  }
}
