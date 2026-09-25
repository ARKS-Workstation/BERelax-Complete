import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../src/components/admin/google-reauth-source.ts'
import { handleCalendarRead, handleCalendarWrite } from './handler.ts'

/**
 * `GET`/`POST /calendar` — the Next binding for the front-desk diary (B-UI-03).
 *
 * Everything decidable lives in `./handler.ts`, which `apps/web/src/admin-calendar.itest.ts` drives
 * directly with a frozen clock; this file is the connection, the clock and the two verbs. The same split
 * `app/(public)/booking/[token]/route.ts` takes, and for the same reason: a route file that held the logic
 * would be a route file that could only be tested through a server — and the first acceptance line here is
 * about an instant, which cannot be frozen behind a `next start`.
 *
 * `POST` takes two body shapes and answers in kind. The inline script sends JSON and is answered JSON, so a
 * move repaints the grid in the same document; a `<form>` sends `application/x-www-form-urlencoded` and is
 * answered with a 303 back to the diary, so the screen works with JavaScript off. One handler, one
 * transaction, two envelopes.
 */
export const dynamic = 'force-dynamic'

/**
 * A connection per request, closed in a `finally`.
 *
 * `max: 2` for the reason the HR, compliance and manage-booking routes give: this is a page load, not a
 * pass over the book, and the integration suite opens a 64-connection pool of its own to prove a row lock —
 * a route that held a large pool would make `sorry, too many clients already` a property of somebody else's
 * test run.
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

const now = (): Instant => Date.now() as Instant

/** The failure a diary must not have: a blank page that reads as an empty day. */
function unavailable(error: unknown): Response {
  const message = isAppError(error) ? error.message : 'Unexpected'
  return new Response(`The diary could not be read: ${message}\n`, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    return await withSql(async (sql) =>
      handleCalendarRead(
        {
          searchParams: url.searchParams,
          chrome: await adminChromeFor({ sql, now: now(), request }),
        },
        { sql, now },
      ),
    )
  } catch (error) {
    return unavailable(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const contentType = request.headers.get('content-type') ?? ''
  const wantsJson = contentType.includes('application/json')
  try {
    const body = wantsJson
      ? ((await request.json()) as Record<string, unknown>)
      : new URLSearchParams(await request.text())
    return await withSql((sql) =>
      handleCalendarWrite({ searchParams: url.searchParams, body, wantsJson }, { sql, now }),
    )
  } catch (error) {
    // A body that is not what its own content-type claims. Answered in the shape the caller asked for, so a
    // script never has to parse an HTML error and a form never receives JSON.
    if (wantsJson) {
      return new Response(
        JSON.stringify({
          ok: false,
          refusal: 'new_period_invalid',
          announcement: 'That is not a move this diary can read.',
        }),
        {
          status: 400,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        },
      )
    }
    return unavailable(error)
  }
}
