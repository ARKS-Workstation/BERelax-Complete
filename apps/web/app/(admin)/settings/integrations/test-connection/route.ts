import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { runTestConnection } from './handler.ts'

/**
 * `POST /settings/integrations/test-connection` — run the nightly check now, for one connection.
 *
 * POST only, and that is a decision rather than a convention: this forces a token refresh and makes one
 * authenticated read per capability, so a GET would let any crawler spend the Google account's refresh
 * quota on every visit — against a limit of about a hundred live refresh tokens per account, where
 * exceeding it silently invalidates the oldest (docs/10 §3).
 *
 * The answer is JSON, exactly as the picker's POST beside it answers JSON: the reason code is what a caller
 * branches on, and the status separates a refused request (4xx) from a deployment that cannot run the check
 * at all (5xx). A redirect back to the card with the result rendered on it belongs with G-CONN-08, which
 * owns the reconnect round trip and the return path; this unit's card links there and does not pretend to
 * own it.
 *
 * `ok: false` with a named reason is the normal answer for a broken connection, and it is still a 200: the
 * check ran and established something. A non-2xx would say the check itself failed, which is a different
 * fact and the one that must not be confused with it.
 */
export const dynamic = 'force-dynamic'

/** The form field the card posts, and the query parameter a curl user would reach for. */
async function connectionIdFrom(request: Request): Promise<string | null> {
  const fromQuery = new URL(request.url).searchParams.get('connectionId')
  if (fromQuery !== null && fromQuery !== '') return fromQuery
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('form')) {
    const form = await request.formData()
    const value = form.get('connectionId')
    return typeof value === 'string' && value !== '' ? value : null
  }
  if (type.includes('json')) {
    const body: unknown = await request.json().catch(() => null)
    const value =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['connectionId']
        : undefined
    return typeof value === 'string' && value !== '' ? value : null
  }
  return null
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
  try {
    const connectionId = await connectionIdFrom(request)
    if (connectionId === null) {
      return Response.json(
        {
          ok: false,
          reason: 'connection_id_required',
          message:
            'Name the connection to test. Testing "whichever connection sorts first" is how a second ' +
            'account gets tested and the first one reported.',
        },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      )
    }
    const outcome = await withSql((sql) =>
      runTestConnection({ sql, config: loadConfig(), connectionId, now: Date.now() as Instant }),
    )
    return Response.json(outcome, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    const reason = isAppError(error) ? (error.details['reason'] ?? error.kind) : 'unexpected'
    const status = isAppError(error) && error.kind === 'provider_unavailable' ? 503 : 500
    return Response.json(
      { ok: false, reason, message: isAppError(error) ? error.message : 'Unexpected' },
      { status, headers: { 'cache-control': 'no-store' } },
    )
  }
}
