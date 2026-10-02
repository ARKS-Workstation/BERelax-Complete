import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../src/components/admin/google-reauth-source.ts'
import { type AdminPrincipal, guardAdminRoute } from '../../../src/session.ts'
import { handleReviewsQueueRead, type QueuePrincipal } from './handler.ts'

/**
 * `GET /reviews` — the Next binding for the approval queue (G-REV-06, docs/10 §6).
 *
 * Everything decidable is in `./handler.ts`, which the integration suite drives directly with an injected
 * clock; this file is the connection, the session and the clock. The same split the paste form one
 * directory along, the diary, the pipeline board and the quick-book screen take.
 */
export const dynamic = 'force-dynamic'

/**
 * A connection per request, closed in a `finally`.
 *
 * `max: 2` for the reason every admin route in this build gives: this is a page load and at most one
 * write, not a pass over the book, and the integration suite opens a 64-connection pool of its own to
 * prove a row lock — a route holding a large pool would make `sorry, too many clients already` a property
 * of somebody else's test run.
 */
export async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * 503 and `text/plain` for a database nobody can reach.
 *
 * Deliberately NOT a document: every file under `app/(admin)` that emits a doctype has to render the
 * Google re-auth banner (G-CONN-08) and `google-reauth-banner.test.ts` walks the tree to say so. A
 * one-sentence refusal is not a page, and dressing it as one would put a second, bannerless copy of the
 * shell in this file.
 */
export function reviewsUnavailable(error: unknown): Response {
  const message = isAppError(error) ? error.message : 'Unexpected'
  return new Response(`The reviews queue is not available: ${message}\n`, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * The session's principal, as the handler's decision needs it.
 *
 * Two fields of five: the handler decides on a ROLE and audits an ID, and `sessionId`, `credentialId` and
 * `staffReference` are not its business. `employeeId` is a uuid, which is what `audit_event.actor_id`
 * requires — and migration 0128 refuses a *Marked as posted* write whose audit row has no `actor_id`, so
 * this is the field the claim is attributable by.
 */
export function queuePrincipalFrom(principal: AdminPrincipal): QueuePrincipal {
  return { id: principal.employeeId, role: principal.role }
}

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and
  // fails closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    const url = new URL(request.url)
    return await withSql(async (sql) =>
      handleReviewsQueueRead(
        {
          searchParams: url.searchParams,
          chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
          body: null,
          principal: queuePrincipalFrom(authorised.principal),
          requestId: request.headers.get('x-request-id'),
        },
        { sql, now: () => Date.now() as Instant },
      ),
    )
  } catch (error) {
    return reviewsUnavailable(error)
  }
}
