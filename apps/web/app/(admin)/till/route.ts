import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../src/session.ts'
import { handleTillRead, handleTillWrite } from './handler.ts'

/**
 * `GET`/`POST /till` — the Next binding for the front desk's till (M-TILL-13).
 *
 * Everything decidable lives in `./handler.ts`, which `apps/web/src/till.itest.ts` drives directly with an
 * injected clock and an injected issuer reader; this file is the connection, the clock and the two verbs. The
 * same split the diary, the pipeline board and quick-book take, and for the same reason: every date this
 * screen resolves is computed from `now`, and `now` cannot be frozen behind a `next start`.
 *
 * It passes **no** `readIssuer`, so the issuer is always the real `legal_entity` row — which today holds the
 * Y1-trn placeholder, so the ISSUE step refuses. See the note in `handler.ts` for why that injection point is
 * not a way round the rule.
 */
export const dynamic = 'force-dynamic'

/**
 * A connection per request, closed in a `finally`.
 *
 * `max: 2` for the reason the diary, the pipeline board, quick-book, the HR, compliance and manage-booking
 * routes all give: this is a page load, not a pass over the book, and the integration suite opens a
 * 64-connection pool of its own to prove a row lock — a route that held a large pool would make
 * `sorry, too many clients already` a property of somebody else's test run.
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

const now = (): number => Date.now()

/**
 * The failure a till must not have: a blank page, or a form that looks ready and takes nothing.
 *
 * 503 and `text/plain`. Deliberately NOT a document: every file under `app/(admin)` that emits a doctype has
 * to render the Google re-auth banner (G-CONN-08) and `google-reauth-banner.test.ts` walks the tree to say
 * so — correctly, because an admin page that says nothing while the grant is dead is the failure that check
 * exists to catch. A one-sentence refusal for a database nobody can reach is not a page, and dressing it as
 * one would put a second, bannerless copy of the shell in this file.
 */
function unavailable(error: unknown): Response {
  const message = isAppError(error) ? error.message : 'Unexpected'
  return new Response(`The till is not available: ${message}\n`, {
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
    return await withSql(async (sql) =>
      handleTillRead(
        {
          searchParams: url.searchParams,
          chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
          body: null,
          requestId: request.headers.get('x-request-id'),
        },
        { sql, now },
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
    // `application/x-www-form-urlencoded` only. This screen has no JSON client and never will: it is two
    // `<form method="post">` submissions, which is what makes it work with JavaScript off. A body that is not
    // form-encoded parses to an empty `URLSearchParams`, which the handler refuses by name as
    // `unreadable_request` — the same answer a hand-crafted POST gets, rather than a 500.
    const body = new URLSearchParams(await request.text())
    return await withSql(async (sql) =>
      handleTillWrite(
        {
          searchParams: url.searchParams,
          chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
          body,
          requestId: request.headers.get('x-request-id'),
        },
        { sql, now },
      ),
    )
  } catch (error) {
    return unavailable(error)
  }
}
