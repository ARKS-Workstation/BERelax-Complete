import { timingSafeEqual } from 'node:crypto'
import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { deliverInboundReviewEmail } from '@berelax/google'
import { isAppError } from '@berelax/shared'

/**
 * `POST /api/v1/reviews/inbound` — where a forwarded Google notification arrives (G-REV-02, docs/10 §6).
 *
 * The owner forwards Google's own notification email to an inbound address and this endpoint reads it: the
 * reviewer, the rating and the text on the parsed path, and on the other path a `needs_paste` item carrying the
 * body byte for byte. All of the deciding is `deliverInboundReviewEmail` in `@berelax/google`, which
 * `packages/google/src/reviews/inbound-email.itest.ts` drives against real PostgreSQL with a frozen clock;
 * this file is the transport.
 *
 * ## It refuses every request today, and that is the honest state rather than an unfinished one
 *
 * `REVIEW_INBOUND_SECRET` is unset in every environment, so every request gets **503
 * `inbound_not_configured`**. Two things are missing and neither is this build's to invent:
 *
 *   - **A receiving address.** Resend inbound needs a verified receiving domain, and docs/05 §2's sending
 *     subdomains do not exist either (Y6-email-sender). `Y8-inbound-review-address` records the address and
 *     the secret as one question, because they arrive together.
 *   - **A way to know the request is Resend's.** An unauthenticated endpoint here is an injection path into
 *     the LLM pipeline — docs/10 §7 says exactly that about an unverified Pub/Sub webhook, and the argument is
 *     identical: the body reaches `buildReviewReplyPrompt`, and anybody who learned this URL could choose what
 *     a review says. A shared secret is the weakest thing that closes it and the strongest thing available
 *     before a signing key exists; the day Resend's own signature is configured, this comparison is the one
 *     line that changes.
 *
 * A 503 naming the reason is deliberately not a 404 and not a silent 200. docs/12 §1 forbids a stub that looks
 * like it works, and a 200 here would tell a forwarding rule that its mail was read.
 *
 * ## Why the secret is read from the environment and not from `parseConfig`
 *
 * The same arrangement `gsc-nightly-snapshot.ts` uses for `GOOGLE_TOKEN_KEK`: a credential that exists in one
 * deployment and in no test belongs in the environment, and `parseConfig` refuses an unknown key — so a
 * required field there would make every existing environment fail to boot for a feature nobody has credentials
 * for yet.
 *
 * ## Why the comparison is timing-safe
 *
 * Because a `===` on a secret leaks its length and its prefix to anybody who can time the response, and this
 * endpoint is public by construction. `timingSafeEqual` throws on a length mismatch, so the lengths are
 * compared first and the answer for a wrong length is the same 401 as for a wrong secret.
 */
export const dynamic = 'force-dynamic'

/** The environment variable holding the shared secret. Unset in every environment today. */
export const REVIEW_INBOUND_SECRET_ENV = 'REVIEW_INBOUND_SECRET'

function json(body: unknown, status: number): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** True only for two equal secrets, in constant time for two of the same length. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * The body, from either encoding a mail relay might use.
 *
 * JSON with a `text` field is Resend's inbound shape; `text/plain` is what a curl or a simpler relay sends. The
 * raw bytes are what matter on both paths, and neither is trimmed: the acceptance line compares the stored
 * column with the fixture's bytes, so a tidy-up here would fail it.
 */
async function rawBodyFrom(request: Request): Promise<string | null> {
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    try {
      const parsed = (await request.json()) as { readonly text?: unknown; readonly html?: unknown }
      if (typeof parsed.text === 'string' && parsed.text !== '') return parsed.text
      // The HTML part, for a relay that sends no plain-text alternative. One of the three fixture template
      // shapes is an HTML table for exactly this reason.
      if (typeof parsed.html === 'string' && parsed.html !== '') return parsed.html
      return null
    } catch {
      return null
    }
  }
  const text = await request.text()
  return text === '' ? null : text
}

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function POST(request: Request): Promise<Response> {
  const expected = process.env[REVIEW_INBOUND_SECRET_ENV]
  if (expected === undefined || expected === '') {
    return json(
      {
        error: 'inbound_not_configured',
        openQuestion: 'Y8-inbound-review-address',
        message:
          'No inbound review address is configured, so this endpoint accepts nothing. A forwarded review ' +
          'can be typed into the paste form meanwhile, which is the intake path that always works ' +
          '(docs/10 §6). Configuring REVIEW_INBOUND_SECRET and a verified receiving domain turns this on.',
      },
      503,
    )
  }

  const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (presented === '' || !secretMatches(presented, expected)) {
    return json(
      {
        error: 'unauthenticated',
        message:
          'This endpoint feeds review text into a drafting pipeline, so it accepts nothing it cannot ' +
          'attribute to the configured forwarder.',
      },
      401,
    )
  }

  const rawBody = await rawBodyFrom(request)
  if (rawBody === null || rawBody.trim() === '') {
    return json({ error: 'invalid_request', message: 'The message had no body to read.' }, 400)
  }

  try {
    // ONE clock read, at the edge. The parse takes the instant as an argument for exactly this reason.
    const receivedAt = Date.now() as Instant
    const recorded = await withSql((sql) =>
      deliverInboundReviewEmail({ sql }, { rawBody, receivedAt }),
    )
    // 202 rather than 201: what was created depends on whether the body could be read, and on the refusal
    // path the thing created is a job for a person rather than a review. The outcome says which, so a
    // forwarding rule's logs show the difference.
    return json(
      {
        accepted: true,
        status: recorded.status,
        intakeId: recorded.intakeId,
        reviewId: recorded.reviewId,
        ...(recorded.parse.kind === 'needs_paste'
          ? { refusal: recorded.parse.refusal }
          : { template: recorded.parse.template }),
      },
      202,
    )
  } catch (error) {
    // A listing that cannot be decided is the caller's problem in the sense that they can act on it — paste
    // the review — so it is reported rather than swallowed. Everything else is a 503.
    const message = isAppError(error) ? error.message : 'Unexpected'
    const named =
      message.includes('[review-inbound-no-listing]') ||
      message.includes('[review-inbound-ambiguous-listing]')
    return json({ error: named ? 'listing_unresolved' : 'unexpected', message }, named ? 409 : 503)
  }
}
