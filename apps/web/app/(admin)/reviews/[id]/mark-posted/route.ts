import type { Instant } from '@berelax/core'
import { adminChromeFor } from '../../../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../../../src/session.ts'
import { queuePrincipalFrom, reviewsUnavailable, withSql } from '../../route.ts'
import { handleReviewMarkPosted, reviewIdFrom } from '../handler.ts'

/**
 * `POST /reviews/[id]/mark-posted` — a named human says they pasted the reply into Google (G-REV-06).
 *
 * The last step of fallback mode, which is the launch mode (docs/10 §6), and the one write in this build
 * that records **a claim about the outside world rather than an observation of it**. There is no Business
 * Profile API access (docs/10 §4, OPEN-QUESTIONS Y3-gbp-api): nothing here has seen the reply on the listing, so what this endpoint
 * stores is that a person with `review:reply_approve` said they had posted it, at a time, with their
 * employee id on the audit row. Migration 0128's ZY341 refuses the write unless that audit row exists in
 * the same transaction, which is what makes *who said so* answerable afterwards.
 *
 * Its own route rather than a second button on the approval form, as the manifest names it: it is a
 * different claim about a different thing, and a single endpoint taking an `action` field would be one
 * authorisation check and one audit action standing for two decisions.
 *
 * **POST only.** There is no `GET` here deliberately: a GET that recorded a claim would be recorded by
 * any crawler, any prefetch and any link preview that touched the URL, and the claim is that a human did
 * something. The 303 it answers with goes back to the review, which is what stops a reload claiming twice
 * — and 0128 refuses the second claim anyway.
 */
export const dynamic = 'force-dynamic'

type Context = { readonly params: Promise<{ readonly id?: string }> }

export async function POST(request: Request, context: Context): Promise<Response> {
  // W-SYS-11: the session first. `guardAdminRoute` never throws and fails closed.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    const url = new URL(request.url)
    const { id } = await context.params
    return await withSql(async (sql) =>
      handleReviewMarkPosted(
        {
          reviewId: reviewIdFrom(id),
          searchParams: url.searchParams,
          chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
          // The body carries nothing. Every field this decision needs is on the row: which bytes were
          // approved, which rule set cleared them, and whether somebody has already claimed this one.
          // A posted field for any of them would be a way to claim a different reply than the one stored.
          body: new URLSearchParams(),
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
