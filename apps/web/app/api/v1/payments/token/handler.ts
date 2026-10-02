import type { Actor, Sql } from '@berelax/db'
import type { CheckoutRefusal, PaymentGatewayRegistry } from '@berelax/payments'
import { authoriseCheckout, CHECKOUT_REFUSAL_SENTENCES } from '@berelax/payments'

/**
 * `POST /api/v1/payments/token` — the JSON twin of the `/checkout` screen's submission (Y-PAY-03).
 *
 * The gateway's hosted-fields script produces an opaque single-use token and posts it here with the amount and
 * the reference. This endpoint calls `authoriseCheckout` in `@berelax/payments` and nothing else: it is the
 * SAME boundary the screen's own POST goes through, which is the point rather than a convenience. Two
 * transports for one submission is how one of them comes to read a body its own way and skip the card-data
 * refusal, so `pnpm saq-a` refuses a payments transport that reads a body any other way, with a known-bad
 * fixture for it in gate block 145 (ADR 0003).
 *
 * ## The acceptance line lives here
 *
 * *"a request body containing a 13-19 digit Luhn-valid number is rejected at the schema boundary with 400 and
 * creates no intent"*. Both halves are asserted in `apps/web/src/checkout.itest.ts` against a real database: a
 * 400 whose `error` is `card_data_refused`, and a delta of ZERO over `payment_intent` across the refused
 * request. The 400 is here and not on the screen because the caller here is a PROGRAM: a status code is the
 * only thing it reads, where an operator reads a sentence (see `handleCheckoutWrite` on why the document
 * answers 200 with a refusal on it).
 *
 * ## What the response body may contain
 *
 * The refusal NAME, the refusal SENTENCE and, for card data, the field PATHS. Never a submitted value — not
 * even echoed back to the caller that sent it. A response is a place a value ends up logged twice over: in our
 * access log and in whatever the client writes down, and a client that logged our 400 verbatim would be the
 * second copy we cannot see. The paths are enough to fix the request, which is all a 400 owes anybody.
 *
 * `gatewayIntentId` and the customer-action URL are absent for Y-PAY-02's reason, unchanged: the browser is
 * told the intent's id, its state and its figures, and nothing that would let it address the gateway directly.
 */

export interface PaymentTokenEndpointDeps {
  readonly sql: Sql
  readonly registry: PaymentGatewayRegistry
  /** Who the audit row names. Resolved from the admin session by `route.ts`; never from the body. */
  readonly actor: Actor
}

function json(body: unknown, status: number): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Which status each refusal answers with.
 *
 * 400 for every one of them, and stated as a map rather than as a single `400` so that a refusal added later
 * has to be given a status deliberately. `write_refused` is the one worth pausing on: it is a 400 here because
 * the only way to reach it through this endpoint is a submission the database refused on its CONTENT — `ZY231`
 * for card-shaped text, which `assertNoCardData` has already refused, so arriving here means the request got
 * past the boundary with something the ledger will not hold. A 409 would tell the caller to retry; there is
 * nothing to retry.
 */
const STATUS_FOR: Readonly<Record<CheckoutRefusal, number>> = Object.freeze({
  card_data_refused: 400,
  instrument_token_missing: 400,
  amount_missing: 400,
  amount_not_integer_fils: 400,
  amount_not_positive: 400,
  reference_missing: 400,
  idempotency_key_missing: 400,
  unreadable_request: 400,
  write_refused: 400,
})

export async function handlePaymentTokenRequest(
  deps: PaymentTokenEndpointDeps,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return json(
        {
          error: 'unreadable_request',
          reason: CHECKOUT_REFUSAL_SENTENCES.unreadable_request,
        },
        400,
      )
    }
    body = parsed as Record<string, unknown>
  } catch {
    // The parse failure is NOT reported with the body's text in it, which a `JSON.parse` error message would
    // otherwise hand over: `SyntaxError` quotes the offending input, and the offending input is exactly what
    // this endpoint must never repeat.
    return json(
      { error: 'unreadable_request', reason: CHECKOUT_REFUSAL_SENTENCES.unreadable_request },
      400,
    )
  }

  const result = await authoriseCheckout(deps, body)
  if (result.kind === 'refused') {
    return json(
      {
        error: result.refusal,
        reason: CHECKOUT_REFUSAL_SENTENCES[result.refusal],
        // Paths and not values. Present even when empty, so a caller can tell "no paths" from "the field was
        // not reported" — an absent key would let a client assume the refusal was about something else.
        paths: result.paths,
        created: false,
      },
      STATUS_FOR[result.refusal],
    )
  }

  return json(
    {
      outcome: result.outcome,
      created: true,
      paymentIntentId: result.intent.id,
      state: result.intent.state,
      authorisedFils: result.intent.authorisedFils,
      capturedFils: result.intent.capturedFils,
      refundedFils: result.intent.refundedFils,
    },
    200,
  )
}
