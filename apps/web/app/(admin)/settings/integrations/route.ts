import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { renderIntegrationsPage } from './connection-card.ts'
import { integrationsView } from './handler.ts'

/**
 * `GET /settings/integrations` — the Google connection card.
 *
 * Thin by design: the reading is in `handler.ts` and the bytes are in `connection-card.ts`, both of which
 * the tests call directly. That split is what lets the card be rendered at a frozen clock without a server
 * — the whole point of a page that shows a deadline is what it says *before* anything has gone wrong, and a
 * route reading `Date.now()` could not be asked. It is the same arrangement the health fragment beside it
 * and `app/api/v1/otp` already use.
 *
 * `?connectionId=` narrows the page to one connection. Not a convenience: the integration suite runs
 * sequentially against one database where earlier files leave connections behind, so a screenshot of the
 * whole list would diff the moment another unit consented to something (brief rule 12).
 *
 * `text/html` and `cache-control: no-store`. The card carries the expiry date of a credential and the
 * recency of the last successful call; a cached copy of either is a page saying the connection was verified
 * an hour ago when it has since died.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    const params = new URL(request.url).searchParams
    const connectionId = params.get('connectionId')
    const now = Date.now() as Instant
    // The three outcomes a round trip can arrive with: a Test connection's verdict, and the consent
    // callback's kind and warning. Read here rather than in the handler because they are a property of the
    // REQUEST, and the handler is the reading of the database.
    const roundTrip = {
      tested: params.get('tested'),
      consent: params.get('outcome'),
      warning: params.get('warning'),
      connectionId: params.get('connection'),
    }
    const view = await integrationsView({
      sql,
      now,
      chrome: await adminChromeFor({ sql, now, request }),
      roundTrip,
      ...(connectionId === null || connectionId === '' ? {} : { connectionId }),
    })
    return new Response(renderIntegrationsPage(view), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch (error) {
    // The reason code, never the prose, is what a caller branches on. 503 rather than a blank page: an
    // empty card would read as "nothing is connected", which is the one wrong answer this screen must
    // never give — the same choice the compliance calendar makes for the same reason.
    const reason = isAppError(error) ? (error.details['reason'] ?? error.kind) : 'unexpected'
    return Response.json(
      { ok: false, reason, message: isAppError(error) ? error.message : 'Unexpected' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}
