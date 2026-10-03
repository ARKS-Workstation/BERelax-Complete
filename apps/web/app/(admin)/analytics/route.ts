import { loadConfig } from '@berelax/config'
import { can, type Instant, type Permission } from '@berelax/core'
import { createConnection, type Sql, withUnitOfWork } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../src/components/admin/google-reauth-source.ts'
import { NOINDEX_ROBOTS_TAG, ROBOTS_HEADER } from '../../../src/routes/registry.ts'
import { type AdminPrincipal, guardAdminRoute } from '../../../src/session.ts'
import { readAnalyticsPage } from './queries.ts'
import { renderAnalyticsPageHtml } from './render.ts'

/**
 * `GET /analytics` — the first-party funnel dashboard (A-FIRST-10).
 *
 * A handler returning bytes rather than a `page.tsx`, for the reason the till, the diary, the Messages
 * inbox, the compliance calendar, the SEO suggestion queue and A-MEAS-07's revenue panel all record:
 * `apps/web/src/routes/registry.ts` is in exact bijection with the filesystem and requires every DOCUMENT
 * to be served in BOTH locales, which would need an Arabic admin document and the W-SYS-01 shell. The
 * manifest entry names `page.tsx`; the deviation is recorded as a NOTE on it.
 *
 * ## `?date=` is REQUIRED and has no default
 *
 * A page answering for "today" answers a different question every day, so a link to it could not be cited
 * and a screenshot of it could not be repeated — which is M-VAT-12's argument for `?period=` on the
 * reconciliation screen, and it applies harder here because the acceptance line is a pixel-diff on a
 * second run. A missing or malformed date is a 400 naming the parameter, never a silent fallback.
 *
 * It is a DATE and not a principal, a role or a permission. W-SYS-11's repository-wide scan refuses a
 * query parameter that chooses any of those three, and nothing on this route reads one.
 *
 * ## Why the permission is `report:read` and what the refusal writes
 *
 * This page aggregates how every visitor reached the business and what they paid. `report:read` is the F07
 * matrix's grant for a figure about the business rather than about a person, and it is held by the owner,
 * the manager, the accountant, the marketer and the auditor — and NOT by the receptionist or the
 * therapist, which is the deny-by-default side of the acceptance line.
 *
 * A refusal answers **403** and writes an `audit_event` with `operation: 'denied'`, which is one of
 * `ALWAYS_AUDITED` in `@berelax/db`. Not a 404 and not a redirect to the sign-in page: the caller IS
 * signed in, so pretending the route does not exist would tell an operator their link is broken while the
 * trail recorded nothing. The row names the principal and the permission, because "who tried to open the
 * revenue dashboard" is the question an insider-threat trail exists to answer (docs/06 §D4).
 */
export const dynamic = 'force-dynamic'

/** The permission this page requires. Spelled once, and exported so the suite cannot drift from it. */
export const ANALYTICS_PERMISSION: Permission = 'report:read'

/** `YYYY-MM-DD`, and nothing looser: a date the calendar may not hold is still a date. */
const TRADING_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * `?dir=rtl` mirrors the layout, which is the arrangement the till, the cash-up sheet and the quick-book
 * screen all use. Anything else is `ltr` — a fail-safe default rather than a refusal, because a mistyped
 * presentation hint should not cost somebody the page.
 */
const directionOf = (params: URLSearchParams): 'ltr' | 'rtl' =>
  params.get('dir') === 'rtl' ? 'rtl' : 'ltr'

/**
 * A connection per request, closed in a `finally`.
 *
 * `max: 2` for the reason every other admin route gives: this is a page load and eleven reads, not a pass
 * over the book, and the integration suite opens a 64-connection pool of its own to prove a row lock — a
 * route that held a large pool would make `sorry, too many clients already` a property of somebody else's
 * test run.
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

/** Every response this route emits carries the same two headers plus the robots policy. */
function headersFor(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    // Stated on this response as well as by the proxy, which serves it for the whole `/analytics` prefix.
    // Two statements of one policy, and the constant is imported rather than typed so they cannot differ.
    [ROBOTS_HEADER]: NOINDEX_ROBOTS_TAG,
  }
}

/**
 * The refusal, recorded.
 *
 * `withUnitOfWork` so the row is written in a transaction of its own and the actor is the signed-in
 * principal — `staff`, with the employment handle as the label, which is what the trail reads as. The
 * ENTITY is the route rather than the principal: the thing acted upon is the dashboard, and
 * `group by entity_id` over this table is then "who tried to open which screen".
 */
async function recordDenial(sql: Sql, principal: AdminPrincipal): Promise<void> {
  await withUnitOfWork(
    sql,
    { kind: 'staff', id: principal.employeeId, label: principal.staffReference },
    async (uow) => {
      await uow.audit.record({
        action: 'analytics_dashboard.denied',
        entityType: 'route',
        entityId: '/analytics',
        operation: 'denied',
        // The role and the permission, and nothing the caller typed. `audit_event` is append-only
        // (ADR 0008) and is read by staff, so a query string goes nowhere near it.
        after: { role: principal.role, permission: ANALYTICS_PERMISSION },
      })
    },
  )
}

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and
  // fails closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const principal = authorised.principal

  try {
    const url = new URL(request.url)
    const date = url.searchParams.get('date')
    if (date === null || !TRADING_DATE.test(date)) {
      /*
       * 400 and `text/plain`, deliberately NOT a document: every file under `app/(admin)` that emits a
       * doctype has to render the admin banners (G-CONN-08) and `google-reauth-banner.test.ts` walks the
       * tree to say so. A one-sentence refusal about a query parameter is not a page, and dressing it as
       * one would put a second copy of the shell in this file.
       */
      return new Response(
        'The analytics dashboard answers for one trading date and has no default. Add ' +
          '?date=YYYY-MM-DD — a page that answered for "today" would answer a different question every ' +
          'day, so a link to it could not be cited.\n',
        { status: 400, headers: headersFor('text/plain; charset=utf-8') },
      )
    }

    if (!can(principal.role, ANALYTICS_PERMISSION)) {
      await withSql(async (sql) => await recordDenial(sql, principal))
      return new Response(
        `The role "${principal.role}" may not ${ANALYTICS_PERMISSION}, which this dashboard requires. ` +
          'The refusal has been recorded.\n',
        { status: 403, headers: headersFor('text/plain; charset=utf-8') },
      )
    }

    const html = await withSql(async (sql) => {
      const data = await readAnalyticsPage(sql, { tradingDate: date })
      return renderAnalyticsPageHtml({
        chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
        data,
        direction: directionOf(url.searchParams),
      })
    })
    return new Response(html, { headers: headersFor('text/html; charset=utf-8') })
  } catch (error) {
    /*
     * 503 and plain text, for the reason `/compliance` and the SEO queue both give: a blank page that
     * looked like an empty dashboard would say "nobody visited" when the truth is "nothing could be read",
     * and this is the one page whose whole subject is the difference between those two.
     */
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The analytics dashboard could not be read: ${message}\n`, {
      status: 503,
      headers: headersFor('text/plain; charset=utf-8'),
    })
  }
}
