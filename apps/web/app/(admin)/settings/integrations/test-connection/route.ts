import { loadConfig } from '@berelax/config'
import { type Instant, parseReturnPath } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError, RECONNECT_SCREEN_PATH } from '@berelax/shared'
import { runTestConnection } from './handler.ts'

/**
 * `POST /settings/integrations/test-connection` — run the nightly check now, for one connection.
 *
 * POST only, and that is a decision rather than a convention: this forces a token refresh and makes one
 * authenticated read per capability, so a GET would let any crawler spend the Google account's refresh
 * quota on every visit — against a limit of about a hundred live refresh tokens per account, where
 * exceeding it silently invalidates the oldest (docs/10 §3).
 *
 * ## Two answers, one computation — G-CONN-07 deferred the second half here and this is it
 *
 * A request that says `content-type: application/json` is answered JSON: the reason code is what a caller
 * branches on, and the status separates a refused request (4xx) from a deployment that cannot run the check
 * at all (5xx). That is what G-CONN-07 shipped, and its NOTE recorded that the round trip back to the
 * screen the operator started from — with the outcome shown on it — was G-CONN-08's.
 *
 * A **form** post is now answered with a 303 back to that screen, carrying `tested=<ok|reason>` and the
 * connection id, which the card renders. 303 rather than 302 so the browser follows it with a GET: a 302
 * after a POST is re-POSTed by some clients on reload, and this POST spends a forced token refresh against
 * an account limit of about a hundred live refresh tokens. The pattern is the diary's, one directory up:
 * one handler, one computation, two envelopes, so the screen works with JavaScript off.
 *
 * `returnTo` is validated by `parseReturnPath` and falls back to the card. A `Location` built from an
 * unvalidated form field on a route whose entire output is a redirect is an open redirect.
 *
 * `ok: false` with a named reason is the normal answer for a broken connection, and it is still a 200: the
 * check ran and established something. A non-2xx would say the check itself failed, which is a different
 * fact and the one that must not be confused with it.
 */
export const dynamic = 'force-dynamic'

/**
 * Where a form post comes back to, and what it says when it gets there.
 *
 * The REASON travels, never the prose: a message is words somebody will improve and a reason is something
 * the card can branch on — the same rule the consent callback's `outcome` follows one directory along.
 */
function seeOther(args: {
  readonly origin: string
  readonly returnTo: string | null
  readonly connectionId: string | null
  readonly tested: string
}): Response {
  const destination = new URL(parseReturnPath(args.returnTo) ?? RECONNECT_SCREEN_PATH, args.origin)
  destination.searchParams.set('tested', args.tested)
  if (args.connectionId !== null) destination.searchParams.set('connection', args.connectionId)
  return new Response(null, {
    status: 303,
    headers: { location: destination.toString(), 'cache-control': 'no-store' },
  })
}

/**
 * What the request names, and which envelope it wants back.
 *
 * Read ONCE, because a request body can only be consumed once: the first version of this file read the
 * `connectionId` out of the form and G-CONN-08 then needed the `returnTo` out of the same form, which is
 * two reads of one stream and an empty second one.
 */
interface TestRequestFields {
  readonly connectionId: string | null
  readonly returnTo: string | null
  /** True when the caller asked for JSON. A form gets the 303 instead. */
  readonly wantsJson: boolean
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

async function fieldsFrom(request: Request): Promise<TestRequestFields> {
  const query = new URL(request.url).searchParams
  const type = request.headers.get('content-type') ?? ''
  const fromQuery = { connectionId: query.get('connectionId'), returnTo: query.get('returnTo') }
  if (type.includes('json')) {
    const body: unknown = await request.json().catch(() => null)
    const record =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    return {
      connectionId: nonEmpty(fromQuery.connectionId) ?? nonEmpty(record['connectionId']),
      returnTo: nonEmpty(fromQuery.returnTo) ?? nonEmpty(record['returnTo']),
      wantsJson: true,
    }
  }
  if (type.includes('form')) {
    const form = await request.formData()
    return {
      connectionId: nonEmpty(fromQuery.connectionId) ?? nonEmpty(form.get('connectionId')),
      returnTo: nonEmpty(fromQuery.returnTo) ?? nonEmpty(form.get('returnTo')),
      wantsJson: false,
    }
  }
  // Neither envelope declared: a curl call with a query string and no body. Answered JSON, because a
  // redirect to a page is useless to something that is not a browser.
  return {
    connectionId: nonEmpty(fromQuery.connectionId),
    returnTo: nonEmpty(fromQuery.returnTo),
    wantsJson: true,
  }
}

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  // Its own small pool rather than a shared one: a forced refresh holds a connection for the length of an
  // HTTPS call to Google while an advisory transaction lock is taken (G-CONN-04's `lock_timeout` note).
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function POST(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin
  let fields: TestRequestFields = { connectionId: null, returnTo: null, wantsJson: true }
  try {
    fields = await fieldsFrom(request)
    if (fields.connectionId === null) {
      const reason = 'connection_id_required'
      if (!fields.wantsJson) {
        return seeOther({ origin, returnTo: fields.returnTo, connectionId: null, tested: reason })
      }
      return Response.json(
        {
          ok: false,
          reason,
          message:
            'Name the connection to test. Testing "whichever connection sorts first" is how a second ' +
            'account gets tested and the first one reported.',
        },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      )
    }
    const connectionId = fields.connectionId
    const outcome = await withSql((sql) =>
      runTestConnection({ sql, config: loadConfig(), connectionId, now: Date.now() as Instant }),
    )
    if (!fields.wantsJson) {
      // `ok` or the reason, never the prose. The card reads it and says what happened in its own words,
      // which is also what stops two spellings of the same verdict — one here and one on the screen.
      return seeOther({
        origin,
        returnTo: fields.returnTo,
        connectionId,
        // `reason` is nullable on the outcome and null exactly when `ok` is true, so the fallback is
        // unreachable rather than a default: it is here because the TYPE does not know that, and a `!`
        // would be an assertion nobody could check.
        tested: outcome.ok ? 'ok' : (outcome.reason ?? 'unexpected'),
      })
    }
    return Response.json(outcome, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    const reason = isAppError(error) ? (error.details['reason'] ?? error.kind) : 'unexpected'
    if (!fields.wantsJson) {
      // A form post never gets a JSON body back, even when the deployment cannot run the check at all: the
      // operator is in a browser, and an operator staring at a JSON blob has been handed a bug report
      // rather than an answer.
      return seeOther({
        origin,
        returnTo: fields.returnTo,
        connectionId: fields.connectionId,
        tested: String(reason),
      })
    }
    const status = isAppError(error) && error.kind === 'provider_unavailable' ? 503 : 500
    return Response.json(
      { ok: false, reason, message: isAppError(error) ? error.message : 'Unexpected' },
      { status, headers: { 'cache-control': 'no-store' } },
    )
  }
}
