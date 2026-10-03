import { safeText } from '@berelax/core'
import { CHECKOUT_FIELDS } from '@berelax/payments'
import { tokensCss } from '@berelax/ui'
import {
  ADMIN_BANNER_CSS,
  renderAdminBanner,
} from '../../../src/components/admin/google-reauth-banner.ts'
import { renderTillOfflinePanel, TILL_OFFLINE_PANEL_CSS } from './offline.ts'
import { CHECKOUT_PATH, type CheckoutView } from './view.ts'

/**
 * *Take a card payment* — the checkout whose card fields are not ours (Y-PAY-03, SAQ-A).
 *
 * Pure: a view in, a document out. No database, no clock, no configuration read — the origins arrive on the
 * view, which is what lets `apps/web/src/checkout-render.test.ts` render the configured and unconfigured
 * states side by side and assert the difference.
 *
 * ## What is NOT in this file, which is the whole unit
 *
 * There is no `<input>` for a card number, an expiry or a security code. There is no `autocomplete="cc-…"`
 * attribute of any kind. There is no `<script>`, inline or otherwise. The card fields are a document the
 * GATEWAY serves, from the gateway's own origin, inside the `<iframe>` below — so the browser's same-origin
 * policy makes them unreadable to this page, and the checkout's content-security policy leaves nothing on the
 * page in a position to try (`checkoutContentSecurityPolicy` in `@berelax/payments`: `script-src` names the
 * gateway's origin and does not include `'self'`).
 *
 * Three checks defend that absence, because an absence cannot be proved by anything passing:
 * `scripts/check-saq-a.mjs` scans this file and every other rendered surface for a card field and for a `cc-`
 * autocomplete token; `apps/web/src/checkout.itest.ts` opens the page in a real browser and asserts the card
 * field is inside a frame whose origin differs from the page's and whose `contentDocument` is null; and gate
 * block 145 adds a card input here and requires both to fail by name (ADR 0003).
 *
 * ## Why a route handler and not a `page.tsx`
 *
 * The manifest's `files` list names `card-fields.tsx`, and this is `route.ts` + `render.ts` + `handler.ts` +
 * `view.ts` instead. Every admin surface in this build has made the same choice and records the same reason:
 * `apps/web/src/routes/registry.ts` requires every **document** to be served in BOTH locales, so a `page.tsx`
 * here would need an Arabic admin document that W-SYS-01 has not built, and it would join a screenshot matrix
 * whose RTL half has to be a real Arabic route. The till, the three HR screens, the two settings screens, the
 * diary, the pipeline board, the quick-book screen and the review paste form all give this reason. The
 * manifest carries a NOTE saying so.
 *
 * ## One form, and the amount is ours while the card is not
 *
 * The amount and the reference are typed here, because they are OUR facts — what is owed and what it is for.
 * They post back to this same screen together with the hidden `instrumentToken` the gateway's script writes
 * into the form from inside the frame; `POST /api/v1/payments/token` is the JSON twin of the same submission,
 * for a gateway whose script posts it itself. Both call `authoriseCheckout` in `@berelax/payments`, which is
 * the one boundary: `pnpm saq-a` refuses a payments transport that reads a body any other way.
 *
 * `reference` is the field this unit worries about most, and the reason it is worth naming: it is free text a
 * person types at a front desk, so it is the one place in the whole flow where a card number can arrive by
 * accident. It is refused twice — at the request boundary by `assertNoCardData`, and in the database by
 * `ZY231` (migration 0117), which is the layer a caller cannot skip.
 *
 * ## Why there is no `<script>` element for the gateway's own script
 *
 * Because no gateway has been chosen, so its script URL is unknown and brief rule 15 refuses a plausible one
 * (`Y7-hosted-fields`). The CSP names the script ORIGIN anyway, which is what the acceptance line asks for and
 * is the useful half: adding the element once a gateway is chosen is one line of markup and not a change to
 * the policy, so nobody has to widen `script-src` under time pressure. Until then the page carries no script
 * at all, which is the strictest state this screen can be in.
 *
 * ## A reload of a successful POST is safe, and that is Y-PAY-02's property being shown
 *
 * `idempotencyKey` is a hidden value minted when the page was READ, so re-posting the form — a browser reload
 * after a successful authorisation — replays the same key. Y-PAY-02's acceptance line is *"a repeated
 * idempotency key returns the original intent and the adapter records zero additional calls"*, so the reload
 * renders the same intent with `outcome: replayed` and the gateway is not touched. That is why this POST
 * answers 200 with the document rather than redirecting: the 303 the review paste form uses exists to stop a
 * reload filing a second row, and here the key already does.
 */

/** Every colour is a token. `pnpm colours` refuses a literal hex outside the token layer (brief rule 11). */
const CHECKOUT_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.125rem; margin: var(--space-7) 0 var(--space-3); }
  p { margin: 0 0 var(--space-5); }
  .card, .refusal, .done, .policy {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
  }
  .refusal, .done, .policy {
    background: var(--color-surface-sand);
    border-color: var(--color-border);
    border-inline-start-width: var(--space-2);
  }
  form { display: grid; gap: var(--space-5); }
  label { display: grid; gap: var(--space-2); font-weight: 600; }
  input[type="text"] {
    font: inherit;
    padding: var(--space-3);
    min-height: 3rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface);
    color: var(--color-ink);
  }
  button {
    font: inherit;
    min-height: 3rem;
    padding: var(--space-3) var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface-sand);
    color: var(--color-ink);
  }
  iframe {
    width: 100%;
    min-height: 14rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface);
  }
  code { font-family: ui-monospace, monospace; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-5); }
  dt { font-weight: 600; }
  dd { margin: 0; }
`

/**
 * The card-entry frame, or the sentence that says why there is none.
 *
 * The `title` is not decoration: the frame is the only interactive region on the page and a screen reader
 * announcing "frame" with no name is the whole card-entry step being unlabelled. `sandbox` is deliberately
 * ABSENT — a sandboxed frame without `allow-scripts` cannot run the gateway's own fields, and adding
 * `allow-scripts allow-same-origin` together removes the sandbox's meaning entirely, which is worse than not
 * claiming one.
 */
function cardFields(view: CheckoutView): string {
  if (view.hostedFields.kind !== 'configured') {
    return [
      '<div class="refusal">',
      '<p><strong>No card gateway is configured, so no card can be taken here.</strong> ',
      'This screen shows the gateway’s own card fields in a frame served from the gateway’s ',
      'origin; until one is chosen there is no origin to point at, and this build does not guess one. ',
      'See <code>Y7-hosted-fields</code> in the open questions.</p>',
      '<p>Unset, or unusable:</p>',
      '<ul>',
      ...view.hostedFields.missing.map((missing) => `<li><code>${safeText(missing)}</code></li>`),
      '</ul>',
      '</div>',
    ].join('')
  }
  const origin = view.hostedFields.origins.frame
  return [
    '<div class="card">',
    `<iframe title="Card details, entered on the payment gateway" src="${safeText(origin)}/" ` +
      'referrerpolicy="no-referrer" loading="eager"></iframe>',
    `<p>The fields above are served by <code>${safeText(origin)}</code> and belong to it. ` +
      'Nothing on this page can read them, and nothing this system stores or logs can contain a card ' +
      'number: what comes back is a single-use token.</p>',
    '</div>',
  ].join('')
}

/** The outcome panel, once an intent exists. */
function outcome(view: CheckoutView): string {
  if (view.outcome === null) return ''
  const it = view.outcome
  return [
    '<div class="done">',
    `<p><strong>${it.outcome === 'replayed' ? 'Already recorded.' : 'Authorisation requested.'}</strong> ` +
      `Intent <code>${safeText(it.paymentIntentId)}</code> is <strong>${safeText(it.state)}</strong>.</p>`,
    '<dl>',
    `<dt>Authorised</dt><dd>${it.authorisedFils} fils</dd>`,
    `<dt>Captured</dt><dd>${it.capturedFils} fils</dd>`,
    '</dl>',
    it.customerActionRequired
      ? '<p>The gateway is waiting for the customer to finish a challenge on their own device. Nothing ' +
        'has moved yet, and nothing on this page can make it move: only a gateway transaction row can ' +
        '(ADR 0056).</p>'
      : '',
    '</div>',
  ].join('')
}

export function renderCheckout(view: CheckoutView): string {
  const f = CHECKOUT_FIELDS
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's brand-collision rule forbids the bare brand in any title, and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it.
    '<title>Take a card payment — payments admin</title>',
    `<style>${tokensCss()}${CHECKOUT_CSS}${TILL_OFFLINE_PANEL_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Take a card payment</h1>',
    '<div class="policy">',
    `<p><strong>Read at ${safeText(view.readAtIso)}.</strong> The card is typed into the ` +
      'gateway’s own fields, in a frame this page cannot read. No card number, expiry or security ' +
      'code reaches this system, appears in any log or audit row, or can be stored in any column — ' +
      'which is what keeps this a SAQ-A checkout rather than a system that handles card data.</p>',
    `<p>Gateway: <code>${safeText(view.gatewayName)}</code>.</p>`,
    view.actorLabel === null
      ? ''
      : `<p>Recorded against <strong>${safeText(view.actorLabel)}</strong>, which is what the audit row ` +
        'names.</p>',
    '</div>',
    view.refusal === null
      ? ''
      : `<div class="refusal"><p><strong>Not authorised.</strong> ${safeText(view.refusal.sentence)}</p></div>`,
    outcome(view),
    /*
      H-HARD-08's honest-failure panel, BEFORE the form and not after a failure.

      There is no code running in this browser — ADR 0013, and `script-src 'none'` on this document — so a
      submission that cannot reach the server ends on the browser's own error page. The only moment this
      application is certain to have the operator's attention is before the submission, which is why the
      reference and the paper fallback are rendered unconditionally rather than on an error state nothing
      could detect.
    */
    renderTillOfflinePanel({
      idempotencyKey: view.idempotencyKey,
      // A state only when the SERVER answered. A refusal that arrived is a refusal before the money
      // moved; the other two states are things this page can never be re-rendered to say, which is why
      // the panel carries their sentences standing.
      state: view.refusal === null ? null : 'refused_before_the_money_moved',
    }),
    '<h2>Card details</h2>',
    cardFields(view),
    '<h2>What is being paid</h2>',
    '<div class="card">',
    `<form method="post" action="${CHECKOUT_PATH}">`,
    // The token the gateway's script writes in from inside the frame. `hidden`, because nobody types it,
    // and named so `check-saq-a.mjs` can assert this form carries exactly the four declared fields.
    `<input type="hidden" name="${f.instrumentToken}" value="">`,
    `<input type="hidden" name="${f.idempotencyKey}" value="${safeText(view.idempotencyKey)}">`,
    `<label for="checkout-amount">Amount in fils, VAT included` +
      `<input type="text" id="checkout-amount" name="${f.amountFils}" required inputmode="numeric" ` +
      `autocomplete="off" value="${safeText(view.form.amountFils)}"></label>`,
    `<label for="checkout-reference">Invoice or booking reference` +
      `<input type="text" id="checkout-reference" name="${f.reference}" required maxlength="200" ` +
      `autocomplete="off" value="${safeText(view.form.reference)}"></label>`,
    `<button type="submit"${view.hostedFields.kind === 'configured' ? '' : ' disabled'}>` +
      'Authorise this payment</button>',
    '</form>',
    '</div>',
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
