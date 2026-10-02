import type { PaymentIntentRow } from '@berelax/db'
import type {
  CheckoutBody,
  CheckoutDeps,
  CheckoutOutcome,
  CheckoutRefusal,
  HostedFieldsConfiguration,
} from '@berelax/payments'
import {
  authoriseCheckout,
  CHECKOUT_FIELDS,
  CHECKOUT_REFUSAL_SENTENCES,
  checkoutContentSecurityPolicy,
} from '@berelax/payments'
import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'
import { renderCheckout } from './render.ts'
import type { CheckoutOutcomeView, CheckoutView } from './view.ts'

/**
 * `GET`/`POST /checkout` — everything this screen decides, with no Next, no connection and no clock (Y-PAY-03).
 *
 * The split every admin surface in this build takes, and here for the reason the review paste form gives: the
 * things worth asserting are the refusals and the headers, and both are decided from a view and a submission
 * that a test can construct. `route.ts` beside this file is the session, the connection, the registry and the
 * two verbs.
 *
 * ## The response headers are this file's, not the route's
 *
 * {@link checkoutHeaders} builds them from the hosted-fields configuration, so the content-security policy on
 * the served document is the same string `apps/web/src/checkout-csp.test.ts` asserts and gate block 145 breaks.
 * A header assembled in `route.ts` would be a header no unit test could see.
 */

/** A fresh idempotency key for one attempt. */
export type MintKey = () => string

export interface CheckoutReadInput {
  readonly chrome: AdminChrome
  readonly hostedFields: HostedFieldsConfiguration
  readonly gatewayName: string
  readonly nowIso: string
  readonly actorLabel: string | null
  /** What a refused POST is re-rendered with, so the operator does not retype the amount and the reference. */
  readonly form?: { readonly amountFils: string; readonly reference: string }
  readonly refusal?: CheckoutRefusal
  readonly intent?: { readonly row: PaymentIntentRow; readonly outcome: 'created' | 'replayed' }
}

/**
 * Every header the checkout answers with, and why each one is not left to a default.
 *
 * `content-security-policy` is the acceptance line's subject and comes from `@berelax/payments`.
 * `cache-control: no-store` because a cached checkout is a card-entry frame served to the next reader — and
 * because the page carries an idempotency key that must not be reused by somebody else's attempt.
 * `x-robots-tag` because the proxy's noindex covers admin PATHS and this document states it for itself too:
 * the belt is a prefix in a registry and the braces are here, and the prefix is the one that can be removed by
 * an edit to a list.
 * `referrer-policy: no-referrer` so that navigating from this page to the gateway's origin does not send the
 * checkout's URL; `permissions-policy` because a card-entry frame has no business asking for a camera.
 */
export function checkoutHeaders(hostedFields: HostedFieldsConfiguration): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': checkoutContentSecurityPolicy(hostedFields),
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  }
}

const outcomeViewFor = (
  intent: PaymentIntentRow,
  outcome: 'created' | 'replayed',
): CheckoutOutcomeView => ({
  paymentIntentId: intent.id,
  state: intent.state,
  outcome,
  authorisedFils: intent.authorisedFils,
  capturedFils: intent.capturedFils,
  customerActionRequired: intent.state === 'requires_customer_action',
})

/** The view the document is rendered from. Pure, so `checkout-render.test.ts` builds one directly. */
export function checkoutViewFor(input: CheckoutReadInput, key: string): CheckoutView {
  return {
    chrome: input.chrome,
    readAtIso: input.nowIso,
    hostedFields: input.hostedFields,
    gatewayName: input.gatewayName,
    idempotencyKey: key,
    form: input.form ?? { amountFils: '', reference: '' },
    refusal:
      input.refusal === undefined
        ? null
        : { name: input.refusal, sentence: CHECKOUT_REFUSAL_SENTENCES[input.refusal] },
    outcome:
      input.intent === undefined ? null : outcomeViewFor(input.intent.row, input.intent.outcome),
    actorLabel: input.actorLabel,
  }
}

/** `GET /checkout` — the screen, with a fresh key for the attempt it is about to be used for. */
export function handleCheckoutRead(input: CheckoutReadInput, mintKey: MintKey): Response {
  return new Response(renderCheckout(checkoutViewFor(input, mintKey())), {
    status: 200,
    headers: checkoutHeaders(input.hostedFields),
  })
}

/**
 * `POST /checkout` — the same document, with the outcome or the refusal on it.
 *
 * **200 for a refusal, not 4xx**, and this is the one status decision worth arguing. The response is a
 * DOCUMENT an operator reads and acts on: a 400 with a page in it is a page some browsers and every proxy in
 * front of it are entitled to replace, and the one thing the operator must see is the sentence saying what to
 * fix. The 4xx belongs on the JSON twin (`/api/v1/payments/token`), where the caller is a program, and that is
 * where the acceptance line's *"rejected at the schema boundary with 400"* is asserted.
 *
 * The form's values are carried back on a refusal so nothing is retyped — EXCEPT when the refusal is
 * `card_data_refused`, where the submission is deliberately dropped. Re-rendering it would put the card number
 * back into the HTML of the very response that refused it, which is the same mistake as quoting it in an error
 * message and is worse, because it would be visible on the screen and in any browser cache.
 *
 * ## It takes the `Request` and reads the body itself
 *
 * `route.ts` hands the request over unread, and this is the only place the form encoding is decided. That is
 * `pnpm saq-a`'s rule 3 satisfied rather than exempted: a payments transport that reads a body must reach the
 * one boundary, and a `route.ts` that parsed the body itself would be a second reader of a payments submission
 * — which is exactly the shape the rule exists to refuse, even when the file it is in then passes the result
 * straight on. The gate found this on its first run against this unit's own code.
 */
export async function handleCheckoutWrite(
  deps: CheckoutDeps,
  request: Request,
  input: CheckoutReadInput,
  mintKey: MintKey,
): Promise<Response> {
  // `application/x-www-form-urlencoded` only. The screen is one `<form method="post">`, which is what makes it
  // work with JavaScript off; the JSON shape is `/api/v1/payments/token`'s, which is the same boundary reached
  // by a program. A body that is not form-encoded parses to empty `URLSearchParams`, which `authoriseCheckout`
  // refuses by name rather than turning into a 500.
  const body: CheckoutBody = new URLSearchParams(await request.text())
  const result: CheckoutOutcome = await authoriseCheckout(deps, body)
  if (result.kind === 'refused') {
    const safeToEcho = result.refusal !== 'card_data_refused'
    return new Response(
      renderCheckout(
        checkoutViewFor(
          {
            ...input,
            refusal: result.refusal,
            ...(safeToEcho ? { form: formFrom(body) } : {}),
          },
          mintKey(),
        ),
      ),
      { status: 200, headers: checkoutHeaders(input.hostedFields) },
    )
  }
  return new Response(
    renderCheckout(
      checkoutViewFor(
        { ...input, intent: { row: result.intent, outcome: result.outcome } },
        mintKey(),
      ),
    ),
    { status: 200, headers: checkoutHeaders(input.hostedFields) },
  )
}

/**
 * The two fields worth carrying back, read out of whichever body shape arrived.
 *
 * Only the amount and the reference. Never the token: it is single-use, so re-rendering it would put a spent
 * credential in the HTML and invite a retry that cannot work.
 */
function formFrom(body: CheckoutBody): { readonly amountFils: string; readonly reference: string } {
  const read = (name: string): string => {
    const value = body instanceof URLSearchParams ? body.get(name) : body[name]
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  }
  return {
    amountFils: read(CHECKOUT_FIELDS.amountFils),
    reference: read(CHECKOUT_FIELDS.reference),
  }
}
