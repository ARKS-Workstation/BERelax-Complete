import { loadConfig } from '@berelax/config'
import { instantFromIso, orderReassignmentQueue } from '@berelax/core'
import { createConnection, readReassignmentQueue, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { type ReassignmentQueueEntryView, renderReassignmentQueueHtml } from './render.ts'

/**
 * The reassignment work queue: every appointment whose therapist may no longer take it (P-HR-04).
 *
 * P-HR-03's nightly sweep raises `appointment_reassignment_flag` and deliberately touches nothing else —
 * no cancellation, no unassignment, no status change — so the queue is the only place the work is
 * visible. This route is that place.
 *
 * The rows come from `@berelax/db` and the ORDER from `@berelax/core`: `readReassignmentQueue` already
 * orders by the appointment's start, and `orderReassignmentQueue` is applied to what it returns so the
 * page cannot present an order the pure comparator disagrees with. That is not belt and braces — it is
 * the one line that makes the SQL and the rule checkable against each other, and
 * `packages/fixtures/src/reassignment.itest.ts` asserts they agree over the same rows.
 *
 * **This route is not authenticated.** There is no admin session until W-SYS-01, exactly as the
 * credentials screen next door and the two Google routes record. It is read-only — GET, no mutation of
 * any kind — so there is no actor to record and none is invented. Acting on the queue is a write with an
 * actor, a reason and a client gender no table holds, so it is deliberately not reachable from here.
 */
export const dynamic = 'force-dynamic'

/** The queue is a work list and is bounded, for the reason the credentials screen is. */
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function parseLimit(url: URL): number {
  const raw = Number(url.searchParams.get('limit') ?? '')
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT) : DEFAULT_LIMIT
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const limit = parseLimit(url)
    const readAtIso = new Date().toISOString()

    const { entries, chrome } = await withSql(async (sql) => {
      // Read on the same connection as the queue: a second pool for the chrome would make one page load
      // two connections, and the integration suite opens a 64-connection pool of its own to prove a lock.
      const chrome = await adminChromeFor({ sql, now: instantFromIso(readAtIso), request })
      const rows = await readReassignmentQueue(sql)
      // Ordered by the pure comparator over what the reader returned, then cut. The cut is AFTER the
      // ordering on purpose: a limit applied first would drop the appointments that start soonest if the
      // reader's order ever stopped matching the rule's, which is the disagreement this call exists to
      // make impossible.
      const ordered = orderReassignmentQueue(
        rows.map((row) => ({
          appointmentId: row.appointmentId,
          startsAt: row.startsAt.getTime(),
          reason: row.reason,
          documentType: row.documentType,
          therapistReference: row.therapistReference,
          startsAtIso: row.startsAt.toISOString(),
          tradingDate: row.appointmentTradingDate,
          documentExpiresOn: row.documentExpiresOn,
          detectedOn: row.detectedOn,
          roomCode: row.roomCode,
          shape: row.shape,
          appointmentStatus: row.appointmentStatus,
        })),
      )
        .slice(0, limit)
        .map(
          (row): ReassignmentQueueEntryView => ({
            appointmentId: row.appointmentId,
            therapistReference: row.therapistReference,
            startsAtIso: row.startsAtIso,
            tradingDate: row.tradingDate,
            reason: row.reason,
            documentType: row.documentType,
            documentExpiresOn: row.documentExpiresOn,
            detectedOn: row.detectedOn,
            roomCode: row.roomCode,
            shape: row.shape,
            appointmentStatus: row.appointmentStatus,
          }),
        )
      return { entries: ordered, chrome }
    })

    return new Response(renderReassignmentQueueHtml({ chrome, entries, readAtIso }), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Never cached. A cached copy of a work queue outlives the work: an appointment reassigned five
        // minutes ago would still be on it, and somebody would reassign it twice.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    // Plain text and a 503: this surface has no error document, and a blank page that looked like an
    // empty queue would say "nothing needs a different therapist" when the truth is "nothing could be
    // read" — which is the one failure a work queue must never have.
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The reassignment queue could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
