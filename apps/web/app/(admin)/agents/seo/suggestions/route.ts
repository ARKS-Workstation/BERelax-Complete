import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../../src/components/admin/google-reauth-source.ts'
import { type AdminPrincipal, guardAdminRoute } from '../../../../../src/session.ts'
import {
  handleSeoSuggestionsRead,
  handleSeoSuggestionsWrite,
  type SuggestionsPrincipal,
} from './handler.ts'

/**
 * `GET`/`POST /agents/seo/suggestions` — the Next binding for the suggestions queue (G-SEO-05).
 *
 * Everything decidable is in `./handler.ts`, which the integration suite drives directly with an injected
 * clock; this file is the connection, the session, the clock and the two verbs. The same split the diary,
 * the pipeline board, the quick-book screen and the review paste form take, and here for a specific
 * reason: applying a suggestion writes a `publication_approval` row carrying an instant, and every
 * ordering assertion about that chain is made under a frozen clock — which it cannot be behind a
 * `next start`.
 */
export const dynamic = 'force-dynamic'

/**
 * A connection per request, closed in a `finally`.
 *
 * `max: 2` for the reason every other admin route gives: this is a page load and a handful of inserts, not
 * a pass over the book, and the integration suite opens a 64-connection pool of its own to prove a row
 * lock — a route that held a large pool would make `sorry, too many clients already` a property of
 * somebody else's test run.
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
 * The failure a publishing queue must not have: a blank page, or a list that looks ready and applies
 * nothing.
 *
 * 503 and `text/plain`. Deliberately NOT a document: every file under `app/(admin)` that emits a doctype
 * has to render the Google re-auth banner (G-CONN-08) and `google-reauth-banner.test.ts` walks the tree to
 * say so. A one-sentence refusal for a database nobody can reach is not a page, and dressing it as one
 * would put a second, bannerless copy of the shell in this file.
 */
function unavailable(error: unknown): Response {
  const message = isAppError(error) ? error.message : 'Unexpected'
  return new Response(`The SEO suggestions queue is not available: ${message}\n`, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * The admin session's principal, as the handler's decision needs it.
 *
 * Three fields of five: the handler decides on a ROLE, records an ID on the approval and prints the
 * employment handle as the audit label. `sessionId` and `credentialId` are not its business.
 */
function suggestionsPrincipalFrom(principal: AdminPrincipal): SuggestionsPrincipal {
  return {
    id: principal.employeeId,
    staffReference: principal.staffReference,
    role: principal.role,
  }
}

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and
  // fails closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    const url = new URL(request.url)
    const principal = suggestionsPrincipalFrom(authorised.principal)
    return await withSql(
      async (sql) =>
        await handleSeoSuggestionsRead(
          {
            searchParams: url.searchParams,
            body: null,
            principal,
            chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
          },
          { sql, now: () => new Date() },
        ),
    )
  } catch (error) {
    return unavailable(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    const url = new URL(request.url)
    const principal = suggestionsPrincipalFrom(authorised.principal)
    // `application/x-www-form-urlencoded` only. This screen has no JSON client and never will: it is one
    // `<form method="post">` per action, which is what makes it work with JavaScript off. A body that is
    // not form-encoded parses to an empty `URLSearchParams`, which the handler refuses by name as
    // `unreadable_request` — the same answer a hand-crafted POST gets, rather than a 500.
    const body = new URLSearchParams(await request.text())
    return await withSql(
      async (sql) =>
        await handleSeoSuggestionsWrite(
          {
            searchParams: url.searchParams,
            body,
            principal,
            chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
          },
          { sql, now: () => new Date() },
        ),
    )
  } catch (error) {
    return unavailable(error)
  }
}
