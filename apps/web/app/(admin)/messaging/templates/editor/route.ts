import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import type { AdminChrome } from '../../../../../src/components/admin/google-reauth-banner.ts'
import { adminChromeFor } from '../../../../../src/components/admin/google-reauth-source.ts'
import { previewFigures, renderEditorHtml, WORKED_EXAMPLE_BODY } from './render.ts'

/**
 * The template editor: what a body will be encoded as, split into and billed at, while it is being typed.
 *
 * docs/04 §5 asks for exactly this and says why it is architectural rather than a nicety: "Arabic doubles
 * the cost. GSM-7 gives 160 characters per segment; a single Arabic character forces UCS-2 at 70 (67
 * concatenated). A 'short' 150-character Arabic message is three segments. Compute encoding, segments and
 * cost at authoring time and show it to whoever writes the copy." An author who finds that out from the
 * invoice has already sent it to two thousand people.
 *
 * ## Read-only, and why that is the right shape rather than a gap
 *
 * GET renders the page; POST prices a body and writes nothing. It creates no template and no variant,
 * because a creation is a write and **there is no admin session until W-SYS-01** — the same statement the
 * inbox and the two Google routes next door record. A variant created here would have no author to
 * record, and an invented one is worse than a blank (brief rule 15). C-AUTO-01's residual NOTE hands the
 * create path a rule to obey when it lands: insert at `draft` and reach `approved` through
 * `setTemplateApproval`, which is what migration 0061 fences. The page says so on its face.
 *
 * ## Why POST for a read
 *
 * The body is customer-facing copy and a query string is written to every access log it passes through.
 * The inbox masks recipients for the same reason. So the body travels in a request body, which also means
 * a pasted body longer than a URL may be does not fail on a length nobody documented.
 *
 * Two response shapes, one computation: `content-type: application/json` gets the figures as JSON, for
 * the inline script that repaints them on every keystroke; anything else is treated as the form and gets
 * the whole page back, so the editor works with JavaScript off.
 *
 * **Not authenticated**, exactly as the routes next door record, and nothing it can disclose that the
 * caller did not send: there is nothing here to authorise until W-SYS-01.
 *
 * It DOES now read one row, and the sentence this replaces said it read none. G-CONN-08 puts the
 * non-dismissible Google re-auth banner on every admin document, and this is one — an author pricing copy
 * on the day the Google grant died is exactly the operator the banner is for. The read is the same
 * `adminChromeFor` the other nine documents make, on a connection of its own, and a failure to make it is
 * a 503 rather than a page with the warning quietly missing.
 */
export const dynamic = 'force-dynamic'

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  // Never cached: the page is a tool and its content is whatever the author last typed.
  'cache-control': 'no-store',
} as const

/** A body from a request, refused rather than coerced when it is not a string. */
function bodyFrom(value: unknown): string {
  if (typeof value === 'string') return value
  // `{}` and `{ body: 42 }` both arrive from a hand-written call, and `String(42)` would price "42" as
  // if somebody had typed it — an answer to a question nobody asked is worse than a refusal.
  throw new TypeError('a message body must be a string')
}

/**
 * The banner, on a connection opened and closed for this page.
 *
 * `max: 1`: this is one settings read and one connection scan, and the integration suite opens a
 * 64-connection pool of its own to prove a row lock (brief rule 12) — a tool page holding a larger pool
 * would make `sorry, too many clients already` a property of somebody else's test run.
 */
async function chromeFor(request: Request): Promise<AdminChrome> {
  const sql = createConnection({ url: loadConfig().DATABASE_URL, max: 1 })
  try {
    return await adminChromeFor({ sql, now: Date.now() as Instant, request })
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** A read that failed is a 503, never a page with the banner missing. */
function unavailable(error: unknown): Response {
  const message = isAppError(error) || error instanceof Error ? error.message : 'Unexpected'
  return new Response(`The editor could not be read: ${message}\n`, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export async function GET(request: Request): Promise<Response> {
  try {
    return new Response(renderEditorHtml(WORKED_EXAMPLE_BODY, await chromeFor(request)), {
      headers: HTML_HEADERS,
    })
  } catch (error) {
    return unavailable(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  const wantsJson = (request.headers.get('content-type') ?? '').includes('application/json')
  try {
    if (wantsJson) {
      const payload: unknown = await request.json()
      const body = bodyFrom((payload as { body?: unknown })?.body ?? '')
      return new Response(JSON.stringify(previewFigures(body)), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    const form = await request.formData()
    const body = bodyFrom(form.get('body') ?? '')
    return new Response(renderEditorHtml(body, await chromeFor(request)), {
      headers: HTML_HEADERS,
    })
  } catch (error) {
    // 400 and the reason in plain text: the only inputs here are the caller's own, so a 5xx would blame
    // the wrong side, and a page that re-rendered with an empty body would look like it had priced one.
    const message = isAppError(error) || error instanceof Error ? error.message : 'Unexpected'
    return new Response(`The body could not be read: ${message}\n`, {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
