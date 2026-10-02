import { loadConfig } from '@berelax/config'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { guardAdminRoute } from '../../../../../../src/session.ts'
import { handleBuilderRead, handleBuilderWrite } from './handler.ts'

/**
 * `GET`/`POST /crm/flows/[id]/builder` — the Next binding for the journey builder (C-AUTO-09).
 *
 * Everything decidable lives in `./handler.ts`, which `apps/web/src/flow-builder.itest.ts` drives
 * directly with an injected clock; this file is the connection, the clock, the session and the two
 * verbs. The split the diary, the pipeline board and the paste form all take, for the reason they all
 * record: a route file that held the logic could only be tested through a server, and the instant this
 * page prints has to be a value a test can choose or two repeat captures could not be identical.
 *
 * `[id]` is the flow KEY. `handler.ts` says why: `flow` has no other handle an operator types, and a
 * uuid in a URL is a uuid somebody reads aloud.
 */
export const dynamic = 'force-dynamic'

/**
 * A connection per request, closed in a `finally`.
 *
 * `max: 2` for the reason the diary, the pipeline board and the HR routes give: this is a page load, not
 * a pass over the book, and the integration suite opens a 64-connection pool of its own to prove a row
 * lock — a route holding a large pool would make `sorry, too many clients already` a property of
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

const now = (): Date => new Date()

/** The failure a builder must not have: a blank page that reads as an empty journey. */
function unavailable(error: unknown): Response {
  return new Response(
    `The journey could not be read: ${isAppError(error) ? error.message : 'Unexpected'}\n`,
    {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    },
  )
}

/** The key the segment carries. Next gives it as a promise in this major version. */
async function flowKeyOf(context: { readonly params: Promise<{ readonly id: string }> }) {
  const { id } = await context.params
  return id
}

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and
  // fails closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    const url = new URL(request.url)
    const flowKey = await flowKeyOf(context)
    return await withSql((sql) =>
      handleBuilderRead(
        { flowKey, principal: authorised.principal, searchParams: url.searchParams },
        { sql, now },
      ),
    )
  } catch (error) {
    return unavailable(error)
  }
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  // W-SYS-11: the session, before anything else — including the body parse, so an unauthenticated POST
  // with a malformed body is still a 303 to the login screen and not a 400.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    const url = new URL(request.url)
    const flowKey = await flowKeyOf(context)
    const form = new URLSearchParams(await request.text())
    return await withSql((sql) =>
      handleBuilderWrite(
        {
          flowKey,
          principal: authorised.principal,
          searchParams: url.searchParams,
          form,
        },
        { sql, now },
      ),
    )
  } catch (error) {
    return unavailable(error)
  }
}
