import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, monthReconciliation, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../../src/session.ts'
import { type ReconciliationLineView, renderMonthReconciliationHtml } from './render.ts'

/**
 * `GET /accounts/reconciliation` — the closed-month reconciliation (M-VAT-12).
 *
 * The report comes from `@berelax/db`'s `monthReconciliation`, whole, and this route converts its
 * `bigint`s to decimal strings and nothing else. No figure is computed here, no figure is reordered here
 * and no line is filtered out here: the page is the report, and a screen that decided which lines to show
 * would be a second opinion about what reconciles.
 *
 * ## The period is an argument, and there is no default month
 *
 * `?period=YYYY-MM` is required. A route that defaulted to "last month" would answer a different question
 * every month, so a screenshot of it could not be repeated and a link to it could not be cited — and the
 * artefact this page exists to produce is one somebody cites. A missing or unparseable parameter is a 400
 * that says what to pass, never a redirect to a guess.
 *
 * `?at=` is the instant an OPEN period is read at, for the same reason the compliance calendar takes one:
 * so an operator can ask "what did this look like then" and so a screenshot is reproducible. It is ignored
 * for a closed period, where the lock's own `locked_at` is the authority — which is a property of
 * `monthReconciliation` rather than of this route, and the page prints which instant was used.
 *
 * **This route is authenticated (W-SYS-11).** `guardAdminRoute` refuses a request carrying no live staff
 * session, and `/accounts` is a prefix in `ADMIN_GROUP_PREFIXES` so the proxy refuses it before this
 * handler runs. It is read-only — GET, no mutation of any kind — so there is no actor to record and none is
 * invented. The EXPORT is deliberately not here: `exportMonthReconciliation` writes an `audit_event` and
 * therefore needs an actor and a recipient, and inventing either from a GET would put a fabricated name in
 * an append-only trail. A route that exports is a POST and belongs with the unit that has a signed-in
 * principal to name.
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

const PERIOD_ID = /^(\d{4})-(\d{2})$/

/** The calendar month a `YYYY-MM` names, as a period. Never a guess, and never a clock. */
function periodFrom(
  periodId: string,
): { periodId: string; startsOn: string; endsOn: string } | null {
  const match = PERIOD_ID.exec(periodId)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) return null
  // Day 0 of the NEXT month is the last day of this one, which is the one arithmetic that gets February
  // and a leap year right without a table. UTC, because a period boundary is a calendar fact about which
  // day a figure belongs to and nothing here is an instant.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const mm = String(month).padStart(2, '0')
  return {
    periodId,
    startsOn: `${year}-${mm}-01`,
    endsOn: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
  }
}

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and
  // fails closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    const url = new URL(request.url)
    const requested = url.searchParams.get('period')
    const period = requested === null ? null : periodFrom(requested)
    if (period === null) {
      return new Response(
        'This page reconciles one named month. Pass ?period=YYYY-MM, for example ' +
          '?period=2026-08. There is deliberately no default: a page that answered for "last month" ' +
          'would answer a different question every month, and this report is one people cite.\n',
        { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      )
    }
    const at = url.searchParams.get('at')
    const instant = at === null ? Date.now() : Date.parse(at)
    if (Number.isNaN(instant)) {
      return new Response(
        `?at=${at} is not an instant this page can parse. A query parameter that quietly did nothing ` +
          'would make "as of then" answer for now and look right.\n',
        { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      )
    }
    const nowIso = new Date(instant).toISOString()

    const view = await withSql(async (sql) => {
      const report = await monthReconciliation(sql, period, nowIso)
      const lines: ReconciliationLineView[] = report.lines.map((line) => ({
        id: line.id,
        kind: line.kind,
        measure: line.measure,
        claim: line.claim,
        // `String(bigint)` and never `Number(bigint)`: a figure this page is about may not be rounded on
        // its way to the reader, and `JSON.stringify` cannot serialise a bigint at all.
        left: {
          label: line.left.label,
          fils: String(line.left.fils),
          rowsExamined: line.left.rowsExamined,
        },
        right: {
          label: line.right.label,
          fils: String(line.right.fils),
          rowsExamined: line.right.rowsExamined,
        },
        variance: String(line.variance),
        derivedFrom: line.derivedFrom,
      }))
      return {
        chrome: await adminChromeFor({ sql, now: instant as Instant, request }),
        periodId: report.period.periodId,
        startsOn: report.period.startsOn,
        endsOn: report.period.endsOn,
        closed: report.closed,
        lockedPeriodId: report.lockedPeriodId,
        sourceAsOf: report.sourceAsOf,
        lines,
        unexplainedVarianceLines: report.unexplainedVarianceLines,
        examinedRows: report.examinedRows,
        notExportableReasons: report.notExportableReasons,
        caveats: report.caveats,
      }
    })

    return new Response(renderMonthReconciliationHtml(view), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Never cached. A cached reconciliation outlives the month it was true for, and for an OPEN period
        // it is a claim about figures that are still moving.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    // Plain text and a 503: this surface has no error document, and a blank page that looked like a month
    // with no variance would say "everything reconciles" when the truth is "nothing could be read" — the
    // one failure a reconciliation screen must never have.
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The month reconciliation could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
