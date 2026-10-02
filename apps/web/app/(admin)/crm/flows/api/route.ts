import { loadConfig } from '@berelax/config'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { guardAdminRoute } from '../../../../../src/session.ts'
import {
  FLOW_API_SENTENCES,
  FLOW_API_STATUS,
  type FlowPublishRequest,
  publishFlowFromApi,
} from './handler.ts'

/**
 * `POST /crm/flows/api` — the Next binding for the journey publish endpoint (C-AUTO-09).
 *
 * Everything decidable is in `./handler.ts`, which `apps/web/src/flow-builder.itest.ts` drives directly
 * and also over HTTP; this file is the connection, the session and the one verb. The same split the
 * pipeline board and the diary take, and for the same reason: a route file holding the logic can only be
 * tested through a server.
 *
 * POST only. There is deliberately no GET: a journey is read through the builder screen, which is a
 * different authority (`campaign:read` rather than `campaign:send`), and an endpoint serving both would
 * be one route with two permissions.
 */
export const dynamic = 'force-dynamic'

/**
 * A connection per request, closed in a `finally`.
 *
 * `max: 2` for the reason every admin route gives: this is one publish, not a pass over the book, and
 * the integration suite opens a 64-connection pool of its own to prove a row lock — a route holding a
 * large pool would make `sorry, too many clients already` a property of somebody else's test run.
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

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Never cached: a cached publish response would be served to the next caller, who published
      // something else.
      'cache-control': 'no-store',
      // W-SYS-11: the answer depends on the session cookie, so a shared cache must not conflate two
      // callers' responses.
      vary: 'Cookie',
    },
  })

export async function POST(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does — including the body parse, so a
  // malformed body from an unauthenticated caller is still a 303 and not a 400. `guardAdminRoute` never
  // throws and fails closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response

  let body: FlowPublishRequest
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    const candidate = parsed as Record<string, unknown>
    body = {
      flowKey: candidate['flowKey'],
      title: candidate['title'],
      definition: candidate['definition'],
    }
  } catch {
    return json(
      {
        ok: false,
        refusal: 'unreadable_request',
        sentence: FLOW_API_SENTENCES.unreadable_request,
        rules: [],
      },
      FLOW_API_STATUS.unreadable_request,
    )
  }

  try {
    const outcome = await withSql((sql) => publishFlowFromApi(sql, authorised.principal, body))
    return outcome.ok ? json(outcome, 200) : json(outcome, outcome.status)
  } catch (error) {
    // Anything the handler did not name. 503 rather than 500 with the message, because the two are
    // different facts: this says the publish could not be attempted, not that the document was wrong.
    return new Response(
      `The journey could not be published: ${isAppError(error) ? error.message : 'Unexpected'}\n`,
      {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      },
    )
  }
}
