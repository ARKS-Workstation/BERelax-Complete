import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { principalForRequest } from '../../../../src/payload/request-principal.ts'
import { guardAdminRoute } from '../../../../src/session.ts'
import { handleReviewsPasteRead, handleReviewsPasteWrite } from './handler.ts'

/**
 * `GET`/`POST /reviews/paste` — the Next binding for the paste form (G-REV-02, docs/10 §6).
 *
 * Everything decidable is in `./handler.ts`, which `apps/web/src/reviews-paste.itest.ts` drives directly with
 * an injected clock; this file is the connection, the session, the clock and the two verbs. The same split the
 * diary, the pipeline board and the quick-book screen take, and here for a specific reason: the row this form
 * writes carries an instant derived from a typed date, and the refusal for a date in the future needs "now" to
 * be a value a test can choose — which it cannot be behind a `next start`.
 */
export const dynamic = 'force-dynamic'

/**
 * A connection per request, closed in a `finally`.
 *
 * `max: 2` for the reason the diary, the pipeline board, the quick-book screen and the HR, compliance and
 * manage-booking routes all give: this is a page load and one insert, not a pass over the book, and the
 * integration suite opens a 64-connection pool of its own to prove a row lock — a route that held a large pool
 * would make `sorry, too many clients already` a property of somebody else's test run.
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

/**
 * The failure a review-intake screen must not have: a blank page, or a form that looks ready and saves nothing.
 *
 * 503 and `text/plain`. Deliberately NOT a document: every file under `app/(admin)` that emits a doctype has to
 * render the Google re-auth banner (G-CONN-08) and `google-reauth-banner.test.ts` walks the tree to say so. A
 * one-sentence refusal for a database nobody can reach is not a page, and dressing it as one would put a
 * second, bannerless copy of the shell in this file.
 */
function unavailable(error: unknown): Response {
  const message = isAppError(error) ? error.message : 'Unexpected'
  return new Response(`The review paste form is not available: ${message}\n`, {
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
    const url = new URL(request.url)
    // Payload's own session, verified by Payload. The GET is guarded as well as the POST: the queue on this
    // page shows a forwarded review's full text, which is a customer's words about this business.
    const principal = await principalForRequest(request)
    return await withSql(async (sql) =>
      handleReviewsPasteRead(
        {
          searchParams: url.searchParams,
          chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
          body: null,
          principal,
          requestId: request.headers.get('x-request-id'),
        },
        { sql, now: () => Date.now() as Instant },
      ),
    )
  } catch (error) {
    return unavailable(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and
  // fails closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    const url = new URL(request.url)
    const principal = await principalForRequest(request)
    // `application/x-www-form-urlencoded` only. This screen has no JSON client and never will: it is one
    // `<form method="post">`, which is what makes it work with JavaScript off. A body that is not form-encoded
    // parses to an empty `URLSearchParams`, which the handler refuses by name as `unreadable_request` — the
    // same answer a hand-crafted POST gets, rather than a 500.
    const body = new URLSearchParams(await request.text())
    return await withSql(async (sql) =>
      handleReviewsPasteWrite(
        {
          searchParams: url.searchParams,
          chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
          body,
          principal,
          requestId: request.headers.get('x-request-id'),
        },
        { sql, now: () => Date.now() as Instant },
      ),
    )
  } catch (error) {
    return unavailable(error)
  }
}
