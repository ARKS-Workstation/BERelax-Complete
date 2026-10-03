import { loadConfig } from '@berelax/config'
import {
  can,
  type GoogleConnectionDisplayState,
  type Instant,
  type Permission,
} from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import {
  adminChromeFor,
  googleReauthBannerFor,
} from '../../../src/components/admin/google-reauth-source.ts'
import { NOINDEX_ROBOTS_TAG, ROBOTS_HEADER } from '../../../src/routes/registry.ts'
import { guardAdminRoute } from '../../../src/session.ts'
import { agentConsoleScreen } from './queries.ts'
import { renderAgentConsoleHtml } from './render.ts'

/**
 * `GET /agents` — the agent console (G-AGT-02).
 *
 * A handler returning bytes rather than a `page.tsx`, for the reason every other admin screen records:
 * the route registry is in exact bijection with the filesystem and requires every DOCUMENT in both
 * locales, which would need an Arabic admin document and the W-SYS-01 shell.
 *
 * ## Two permissions, and they are not the same question
 *
 * READING the console needs `report:read`: it is a screen of figures about how the business's automation
 * is behaving, and a manager, an accountant, a marketer and an auditor all have reason to look. STOPPING
 * an agent needs `agent:configure`, which in the F07 matrix is the owner's and the manager's — and the
 * read decides whether the toggle is rendered at all, while the POST decides whether it is obeyed. The
 * second is the authority; the first is so the screen does not offer a control that will refuse.
 *
 * ## Why the trading date is resolved and not taken from the query
 *
 * Unlike `/analytics`, this screen is about NOW: an operator opens it because something is wrong at this
 * moment, and a required `?date=` would make the common case a form to fill in. So the trading date comes
 * from the CALENDAR — `business_day`, asked which date contains this instant — and never from
 * `current_date`: a business day can close after midnight, so in the small hours the figures are still
 * is the only reading under which "runs today" and the budget derived from them agree with the ledger.
 *
 * `resolveTradingDate` in `@berelax/core` is the pure resolver and it is deliberately not used here: it
 * needs the premises' hours as an argument, this route already holds a connection to the table that
 * stores them, and asking the row is one statement rather than two that could disagree. `business_day` is
 * also what ZY222 holds every analytics session against, so this answer and the store's agree by
 * construction.
 */
export const dynamic = 'force-dynamic'

/** Reading the console. Exported so the suite cannot drift from it. */
export const AGENTS_READ_PERMISSION: Permission = 'report:read'
/** Working a kill switch. The POST's authority; see `kill-switch/route.ts`. */
export const AGENTS_TOGGLE_PERMISSION: Permission = 'agent:configure'

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function headersFor(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    [ROBOTS_HEADER]: NOINDEX_ROBOTS_TAG,
  }
}

/**
 * The Google connection's display state, or null when nothing is connected.
 *
 * Read through `googleReauthBannerFor`, which is the SAME derivation the banner on every admin page
 * uses, and that is the point rather than convenience: a console that re-derived the connection's health
 * would show a different answer from the banner at the top of the same page the moment the two
 * disagreed — which is exactly when somebody is looking at it.
 *
 * `null` for a build with no connection at all, which the reason table reads as "Google is not a cause
 * here" rather than as broken. A missing connection is not a dead grant, and an agent that needs one has
 * never been able to run.
 */
async function googleStateFor(
  sql: Sql,
  now: Instant,
): Promise<GoogleConnectionDisplayState | null> {
  const banner = await googleReauthBannerFor({ sql, now })
  return banner?.state ?? null
}

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else. `guardAdminRoute` never throws and fails closed.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const principal = authorised.principal

  if (!can(principal.role, AGENTS_READ_PERMISSION)) {
    return new Response(
      `The role "${principal.role}" may not ${AGENTS_READ_PERMISSION}, which this console requires.\n`,
      { status: 403, headers: headersFor('text/plain; charset=utf-8') },
    )
  }

  try {
    const url = new URL(request.url)
    const html = await withSql(async (sql) => {
      const now = Date.now() as Instant
      const resolution = await tradingDateFor(sql, now)
      const screen = await agentConsoleScreen(sql, {
        tradingDate: resolution,
        googleState: await googleStateFor(sql, now),
      })
      return renderAgentConsoleHtml({
        chrome: await adminChromeFor({ sql, now, request }),
        screen,
        mayToggle: can(principal.role, AGENTS_TOGGLE_PERMISSION),
        direction: url.searchParams.get('dir') === 'rtl' ? 'rtl' : 'ltr',
      })
    })
    return new Response(html, { headers: headersFor('text/html; charset=utf-8') })
  } catch (error) {
    /*
     * 503 and plain text. A blank console would say "no agent is in trouble" when the truth is "nothing
     * could be read", and this is the one screen whose whole job is the difference between those two.
     */
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The agent console could not be read: ${message}\n`, {
      status: 503,
      headers: headersFor('text/plain; charset=utf-8'),
    })
  }
}

/**
 * The trading date the figures are about, from the calendar and never from `current_date`.
 *
 * `business_day` is asked which date contains this instant, and the fallback for an instant inside no
 * trading window is the next date the calendar opens — which is `fileUnderTradingDate`'s rule one table
 * over, and is the only answer under which a daytime figure belongs to a day the business is open on.
 */
async function tradingDateFor(sql: Sql, now: Instant): Promise<string> {
  const [row] = await sql<{ tradingDate: string }[]>`
    select trading_date::text as "tradingDate"
      from business_day
     where opens_at <= ${new Date(now).toISOString()}::timestamptz
       and closes_at > ${new Date(now).toISOString()}::timestamptz
     limit 1
  `
  if (row !== undefined) return row.tradingDate
  const [next] = await sql<{ tradingDate: string }[]>`
    select trading_date::text as "tradingDate"
      from business_day
     where opens_at > ${new Date(now).toISOString()}::timestamptz
     order by opens_at
     limit 1
  `
  if (next !== undefined) return next.tradingDate
  // The calendar has run out, which is a horizon that needs generating rather than a date to invent.
  throw new Error(
    'The trading calendar holds no day containing this instant and none after it, so there is no ' +
      'trading date for these figures to be about. The business_day horizon needs extending.',
  )
}
