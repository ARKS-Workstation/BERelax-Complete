import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { handleManageBookingRead, handleManageBookingWrite } from './handler.ts'

/**
 * `GET`/`POST /booking/{token}` — the Next binding for the manage-booking page (B-UI-05).
 *
 * Everything decidable lives in `./handler.ts`, which `apps/web/src/manage-booking.itest.ts` drives
 * directly; this file is the connection, the clock and the two verbs. The same split
 * `app/api/v1/bookings/route.ts` takes, and for the same reason: a route file that held the logic would be
 * a route file that could only be tested through a server.
 *
 * ## Why a route handler and not a `page.tsx`
 *
 * `./render.ts`'s header gives the three reasons, and the short one is that a registry *document* must
 * declare `sampleParams` and carry an `hreflang` set in both locales — which for this route would mean a
 * live magic link committed to `apps/web/src/routes/registry.ts` and the token published in the head of
 * the page. The registry entry is a `handler`, `indexable: false`, and the two languages are one URL whose
 * language comes from `customer.locale`.
 */
export const dynamic = 'force-dynamic'

/**
 * A connection per request, closed in a `finally`.
 *
 * `max: 2` for the reason the HR and compliance routes give: this is a page load, not a pass over the book,
 * and the integration suite opens a 64-connection pool of its own to prove a row lock — a route that held a
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

const now = (): Instant => Date.now() as Instant

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params
  const url = new URL(request.url)
  return await withSql((sql) =>
    handleManageBookingRead({ token, searchParams: url.searchParams }, { sql, now }),
  )
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params
  // `formData()` rather than a JSON body: both forms on the page are plain HTML and work with JavaScript
  // off, which is the constraint docs/09 §3 puts on the booking flow and matters more here — the page is
  // opened from an SMS on whatever browser the phone has.
  const body = await request.formData()
  const form = new URLSearchParams()
  for (const [key, value] of body.entries()) {
    if (typeof value === 'string') form.append(key, value)
  }
  return await withSql((sql) => handleManageBookingWrite({ token, form }, { sql, now }))
}
