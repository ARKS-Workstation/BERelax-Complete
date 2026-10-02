import type { Instant } from '@berelax/core'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../../src/session.ts'
import { queuePrincipalFrom, reviewsUnavailable, withSql } from '../route.ts'
import { handleReviewApprove, handleReviewDetailRead, reviewIdFrom } from './handler.ts'

/**
 * `GET`/`POST /reviews/[id]` — one review's approval screen (G-REV-06, docs/10 §6).
 *
 * The GET renders the draft, the escalation reason and — once a human has approved one — *Copy reply*, the
 * deep link and *Marked as posted*. The POST is the approval, which lints the posted bytes through
 * G-REV-05's send-path linter and refuses them server-side with every rule named.
 *
 * A dynamic segment beside the static `paste` one, which Next resolves in favour of the static path, so
 * `/reviews/paste` is still the paste form. The registry declares this route as `/reviews/[id]` with NO
 * `sampleParams`, for the reason `/hr/leave/[id]` gives: a sample id would be one review the screenshot
 * harness opened on every run, and the page shows a customer's words about this business.
 *
 * `application/x-www-form-urlencoded` only. This screen has no JSON client: it is `<form method="post">`
 * twice over, which is what makes the approval work with JavaScript off — the only thing a script does
 * here is put the already-approved text on a clipboard.
 */
export const dynamic = 'force-dynamic'

type Context = { readonly params: Promise<{ readonly id?: string }> }

export async function GET(request: Request, context: Context): Promise<Response> {
  // W-SYS-11: the session first. `guardAdminRoute` never throws and fails closed.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    const url = new URL(request.url)
    const { id } = await context.params
    return await withSql(async (sql) =>
      handleReviewDetailRead(
        {
          reviewId: reviewIdFrom(id),
          searchParams: url.searchParams,
          chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
          body: null,
          principal: queuePrincipalFrom(authorised.principal),
          requestId: request.headers.get('x-request-id'),
        },
        { sql, now: () => Date.now() as Instant },
      ),
    )
  } catch (error) {
    return reviewsUnavailable(error)
  }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    const url = new URL(request.url)
    const { id } = await context.params
    // A body that is not form-encoded parses to an empty `URLSearchParams`, which the handler refuses by
    // name as `unreadable_request` — the same answer a hand-crafted POST gets, rather than a 500.
    const body = new URLSearchParams(await request.text())
    return await withSql(async (sql) =>
      handleReviewApprove(
        {
          reviewId: reviewIdFrom(id),
          searchParams: url.searchParams,
          chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
          body,
          principal: queuePrincipalFrom(authorised.principal),
          requestId: request.headers.get('x-request-id'),
        },
        { sql, now: () => Date.now() as Instant },
      ),
    )
  } catch (error) {
    return reviewsUnavailable(error)
  }
}
