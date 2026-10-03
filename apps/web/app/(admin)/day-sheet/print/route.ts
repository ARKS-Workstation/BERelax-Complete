import { loadConfig } from '@berelax/config'
import { instantFromIso } from '@berelax/core'
import { createConnection, readCalendarDay, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../../src/session.ts'
import { renderDaySheetHtml } from './render.ts'
import { DUBAI_DATE, daySheetViewFor } from './view.ts'

/**
 * `GET /day-sheet/print` — the printable day sheet (H-HARD-08).
 *
 * ## It reads `readCalendarDay` and adds no reader of its own
 *
 * That is the decision in this file. The diary already answers "what is happening on trading day X" in ONE
 * statement, and the two properties the acceptance line needs are properties that query already has:
 *
 *   - **after-midnight treatments are included**, because it joins on `a.trading_date` — the STORED column
 *     that resolves the 01:30 case — rather than on the calendar date of `lower(a.period)`. A second
 *     reader written here would have had to re-derive that, and `resolveTradingDate` is the one reading of
 *     where a trading day ends (0011);
 *   - **two reads of an unchanged day are byte-identical**, because it orders by `starts_at, id`, which
 *     that file's own comment records as being for exactly this.
 *
 * So the sheet and the diary cannot disagree about what the floor is delivering. A paper fallback that
 * showed a different set from the screen it replaces would be worse than no fallback.
 *
 * `holds_resources` is the diary's filter and is right here too: it is the GENERATED column, so a
 * cancellation and a reschedule's superseded leg are both released by it, and a sheet listing a cancelled
 * booking sends a therapist to an empty room.
 *
 * ## Why the trading date comes from a query parameter and that is not the refused shape
 *
 * `admin-guard.test.ts` refuses a principal, a role or a permission taken from the query across the whole
 * of `apps/web`. A DATE is none of those: it selects which day to print, it authorises nothing, and the
 * session decides whether this page may be read at all. `/calendar` takes its date the same way and for the
 * same reason — a sheet you cannot ask for tomorrow's is a sheet somebody prints at midnight.
 *
 * It defaults to TODAY in the business zone rather than to the current trading date resolved from the
 * instant, and the difference is one somebody will ask about: at 00:30 the session in force opened
 * yesterday, so "today" and "the current trading day" differ for two hours of every day. The default is
 * the calendar date because the person printing at 00:30 is printing for the shift they are standing in,
 * and the sheet SAYS which trading day it is for in its heading — so a reader who wanted the other one can
 * see that they have the wrong sheet rather than discovering it from a missing treatment.
 */
export const dynamic = 'force-dynamic'

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** `YYYY-MM-DD` or null. Rejected rather than coerced: a half-parsed date is another day's sheet. */
function parseDate(raw: string | null): string | null {
  return raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and
  // fails closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const url = new URL(request.url)

  try {
    const readAtIso = new Date().toISOString()
    const tradingDate =
      parseDate(url.searchParams.get('date')) ?? DUBAI_DATE.format(new Date(readAtIso))

    const view = await withSql(async (sql) => {
      // One connection for the chrome and the day, for the commission screen's reason: a second pool
      // would make one page load two connections, and the integration suite opens 64 of its own.
      const chrome = await adminChromeFor({ sql, now: instantFromIso(readAtIso), request })
      return daySheetViewFor({
        chrome,
        tradingDate,
        day: await readCalendarDay(sql, tradingDate),
      })
    })

    return new Response(renderDaySheetHtml(view), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Never cached. A cached day sheet is yesterday's floor plan handed to today's shift, and this is
        // the one document somebody prints without reading.
        'cache-control': 'no-store',
        vary: 'Cookie',
      },
    })
  } catch (error) {
    // Plain text and a 503: a blank sheet would be read as an empty day, and an empty day and an
    // unreadable one are a quiet evening and an outage.
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The day sheet could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
