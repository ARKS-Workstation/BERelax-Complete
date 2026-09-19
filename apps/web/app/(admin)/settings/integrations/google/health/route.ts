import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { googleHealthFragment } from './handler.ts'

/**
 * `GET /settings/integrations/google/health` — the connection health fragment.
 *
 * Thin by design: the reading and the rendering are in `handler.ts`, which the integration test calls
 * directly. Calling the handler rather than this route in the test is what lets the DOM assertions run
 * against a frozen clock without a server, and it is the same split `app/api/v1/otp` already uses.
 *
 * `text/html` and `cache-control: no-store`. The fragment carries the expiry date of a credential and the
 * recency of the last successful call; a cached copy of either is a page that says the connection was
 * verified an hour ago when it has since died.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    const fragment = await googleHealthFragment({ sql, now: Date.now() as Instant })
    return new Response(fragment.html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch (error) {
    // The reason code, never the prose, is what a caller branches on. 503 for a deployment that cannot
    // serve the screen at all — an unreadable setting is that, not a bad request.
    const reason = isAppError(error) ? (error.details['reason'] ?? error.kind) : 'unexpected'
    return Response.json(
      { ok: false, reason, message: isAppError(error) ? error.message : 'Unexpected' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}
