import {
  PAPER_FALLBACK_STEPS,
  safeText,
  TILL_FAILURE_SENTENCES,
  type TillFailureState,
  tillAttemptReference,
} from '@berelax/core'

/**
 * The till's honest-failure panel (H-HARD-08).
 *
 * ## Why it is on the page BEFORE anything goes wrong
 *
 * Because when the network drops there is no page. This checkout is a server-rendered `<form method="post">`
 * with no client JavaScript — ADR 0013, and `checkoutContentSecurityPolicy` emits `script-src 'none'` for
 * the merchant document, so there is nothing that could run to detect the loss and render a message. A
 * submission that cannot reach the server ends in the BROWSER's own error page, which this system does not
 * write and cannot change.
 *
 * That is the constraint, and it decides the design. The only moment this application is certain to have
 * the operator's attention is **before** the submission, so the instructions and the attempt's reference go
 * on the screen then, every time, rendered from the state the page is actually in. The panel is not a
 * warning that appears on failure; it is the thing the operator reads off the screen while the network is
 * already gone.
 *
 * ## What it must never do
 *
 * It renders nothing that could be mistaken for "the payment is in hand". Every sentence comes from
 * `TILL_FAILURE_SENTENCES` in `@berelax/core`, `tillFailureSentenceProblems` refuses one containing a
 * promise about a future send, and `scripts/check-offline-money.mjs` refuses a browser store, an offline
 * API or a deferred-send construct anywhere on the money path. A tick after a submission nobody got an
 * answer to is the defect this unit exists to make impossible.
 *
 * It is a FRAGMENT and not a document, so it carries no banners of its own: `renderCheckout` is the
 * document and `google-reauth-banner.test.ts`'s walk covers it there.
 */

/** The attribute a test and the Playwright spec both query for. */
export const TILL_OFFLINE_PANEL_ATTRIBUTE = 'data-till-offline'

export const TILL_OFFLINE_PANEL_CSS = `
  [${TILL_OFFLINE_PANEL_ATTRIBUTE}] {
    border: 1px solid var(--color-border);
    border-inline-start: var(--space-2) solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
  }
  [${TILL_OFFLINE_PANEL_ATTRIBUTE}] ol { margin: 0 0 var(--space-3); padding-inline-start: var(--space-7); }
  [${TILL_OFFLINE_PANEL_ATTRIBUTE}] li { margin: 0 0 var(--space-2); }
  [data-till-attempt-reference] {
    font-variant-numeric: tabular-nums;
    font-size: 1.25rem;
    letter-spacing: 0.08em;
    font-weight: 600;
  }
`

export interface TillOfflineView {
  /** The attempt's idempotency key, which is what makes a repeat of the same attempt safe. */
  readonly idempotencyKey: string
  /**
   * The state to show, or null for the standing panel.
   *
   * Null is the ordinary case and the one that matters: the panel is on the page before a submission,
   * because after a failed one there is no page. A state is set only when the SERVER answered — which is
   * `refused_before_the_money_moved` — so the two readings never contradict each other.
   */
  readonly state: TillFailureState | null
}

/**
 * The panel.
 *
 * `data-dismissible="false"` and no control of any kind, for the Google re-auth banner's reason: a panel
 * with something to press is a panel that is not there the one time it matters. There is also nothing to
 * press that could work — see the module header on why no script runs here.
 */
export function renderTillOfflinePanel(view: TillOfflineView): string {
  const reference = tillAttemptReference(view.idempotencyKey)
  return [
    `<section ${TILL_OFFLINE_PANEL_ATTRIBUTE}="${safeText(view.state ?? 'standing')}" ` +
      'data-dismissible="false" aria-labelledby="till-offline-heading">',
    '<h2 id="till-offline-heading">If the connection drops</h2>',
    view.state === null
      ? '<p><strong>This screen cannot tell you whether a payment was taken if it never hears back.</strong> ' +
        'It is one form posted to the server, with no code running in this browser, so a submission that ' +
        'cannot reach the system ends on the browser’s own error page and not on this one. Read the ' +
        'reference below before you submit.</p>'
      : `<p><strong>${safeText(TILL_FAILURE_SENTENCES[view.state])}</strong></p>`,
    '<p>This attempt’s reference, which is also what makes submitting it twice safe:</p>',
    `<p data-till-attempt-reference="${safeText(reference)}">${safeText(reference)}</p>`,
    // The two failure sentences the server can never deliver, shown here for the same reason the reference
    // is: the moment an operator needs them is the moment this page cannot be re-rendered.
    '<p>If you submit and nothing comes back: ' +
      `${safeText(TILL_FAILURE_SENTENCES.unknown_whether_it_completed)}</p>`,
    '<p>If this browser cannot reach the system at all: ' +
      `${safeText(TILL_FAILURE_SENTENCES.did_not_leave_this_terminal)}</p>`,
    '<h3>What to do on paper</h3>',
    '<ol>',
    ...PAPER_FALLBACK_STEPS.map((step) => `<li>${safeText(step)}</li>`),
    '</ol>',
    '<p>Nothing is held for you and nothing is waiting to be sent. This system does not keep a payment ' +
      'to try later: a card authorised an hour after the customer left, against an invoice somebody has ' +
      'since voided, into a period that may be closed, is worse than one that was never taken — and the ' +
      'tick you would have seen would have been this screen’s guess rather than the gateway’s answer.</p>',
    '</section>',
  ].join('')
}
