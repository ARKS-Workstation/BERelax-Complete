import { escapeHtml, type ReauthBannerView, type Role, safeText } from '@berelax/core'
import { RECONNECT_SCREEN_PATH } from '@berelax/shared'
import {
  MESSAGES_DELAYED_BANNER_CSS,
  renderMessagesDelayedBanner,
  type SendBacklogView,
} from './messages-delayed-banner.ts'

/**
 * The Google re-auth banner, on every admin document.
 *
 * ## Why it is markup rather than a component, and why every document calls it
 *
 * There is no `.tsx` here for the reason G-CONN-07, the Messages inbox, the compliance calendar, the HR
 * screens and the breakpoint preview all record: `apps/web/src/routes/registry.ts` is in exact bijection
 * with the filesystem and requires every *document* to be served in both locales, so an admin page is a
 * route handler that returns bytes. Ten of them exist, and the acceptance line says the banner is on every
 * admin page — so every one of the ten calls this function, and
 * `apps/web/src/google-reauth-banner.test.ts` walks the filesystem for admin documents and fails by name if
 * one of them does not. There is no exemption list: a new admin document that forgets the banner is a red
 * test naming the file.
 *
 * ## Why "non-dismissible" is a property of these bytes
 *
 * The obvious implementation of a banner you cannot dismiss is a dismiss button the broken state does not
 * render, plus somewhere to remember that it was pressed. Every available *somewhere* is wrong here, and
 * the thing being warned about is why: the connection is a Google grant that has expired, so a dismissed
 * banner means review replies stop being posted and nobody is told.
 *
 *   - **Client-side JavaScript** — removable from dev tools, and these documents ship no client bundle at
 *     all, so a banner that depended on script would be absent exactly when script was.
 *   - **A cookie** — it outlives the incident, on one operator's machine, invisibly.
 *   - **A query parameter** — it survives a bookmark and a shared link.
 *
 * So the banner is a function of the stored connection state and of nothing else. For `broken` this file
 * emits **no `<script>`, no `<details>`, no `<summary>`, no `button`, no `hidden` attribute and no
 * `[id]`**: there is no element for a stylesheet or a script to target by name, and there is no control to
 * press. `google-reauth-banner.itest.ts` asserts that in a real browser — the element is in the parsed DOM,
 * it has a non-zero box, and `getComputedStyle` reports it visible — and the known-bad fixtures in gate
 * block 100 each try one of the dismissals above and are named by the rule that catches them.
 *
 * `degraded` DOES carry a dismiss control, and it is deliberately one that cannot outlive the response:
 * a native `<details open>` collapses to its summary with no script, and nothing records that it was
 * collapsed. That is the acceptance line's *"reappears after a client-side navigation"* satisfied by there
 * being nowhere for a dismissal to live, rather than by code that puts the banner back.
 */

/**
 * The banner's own styles, keyed off the state attribute.
 *
 * Tokens only; there is no literal colour in this file (`pnpm colours`). Emitted by the caller inside the
 * same `<style>` as the rest of the document, because a route handler cannot reference the build's hashed
 * stylesheet.
 *
 * Nothing here can hide the banner. There is no `display: none`, no `visibility`, no zero `opacity` and no
 * `max-height` that could collapse it — which is a claim the integration suite makes against a real
 * browser rather than a claim this comment makes, because a rule added later is exactly what it would
 * miss.
 */
export const GOOGLE_REAUTH_BANNER_CSS = `
  .google-reauth {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    color: var(--color-ink);
    padding: var(--space-4) var(--space-5);
    margin: 0 0 var(--space-6);
  }
  .google-reauth h2 {
    font-size: 1.0625rem;
    line-height: 1.3;
    margin: 0 0 var(--space-2);
  }
  .google-reauth p { margin: 0 0 var(--space-3); }
  .google-reauth p:last-child { margin-bottom: 0; }
  .google-reauth a {
    display: inline-flex;
    align-items: center;
    min-height: 2.75rem;
    padding: var(--space-2) var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-ground);
    color: var(--color-ink);
    text-decoration: none;
  }
  .google-reauth summary {
    min-height: 2.75rem;
    display: flex;
    align-items: center;
    cursor: pointer;
  }
  .google-reauth[data-dismissible='false'] { border-inline-start-color: var(--color-ink); }
  .google-reauth[data-dismissible='false'] h2 { font-weight: 600; }
`

/**
 * Every admin document's chrome CSS, in one constant.
 *
 * The 29 render modules each used to name `GOOGLE_REAUTH_BANNER_CSS` directly, which meant the second
 * banner this chrome ever grew was a 29-file edit — and the failure mode of a 29-file edit is the one file
 * that was missed, rendering a banner with no styles and no error anywhere. `renderAdminBanner` already
 * composes the MARKUP for exactly that reason; this is the same argument for the styles.
 *
 * `GOOGLE_REAUTH_BANNER_CSS` stays as the Google banner's own rules, because
 * `google-reauth-banner.test.ts` holds that constant to a list of properties that could hide the banner —
 * `display: none`, `visibility`, a zero `opacity`, a collapsing `max-height` — and that claim is about
 * those rules rather than about everything an admin page emits.
 */
export const ADMIN_BANNER_CSS = `${GOOGLE_REAUTH_BANNER_CSS}${MESSAGES_DELAYED_BANNER_CSS}`

/** The attribute a test queries for, and the rule name the gate fixtures are caught by. */
export const GOOGLE_REAUTH_BANNER_ATTRIBUTE = 'data-google-reauth'

/**
 * Where reconnecting starts, with the page to come back to carried in the query.
 *
 * The consent route reads `returnTo`, validates it against the paths it declares and puts it in the
 * HttpOnly consent cookie — not in the redirect it hands Google, which is why the round trip survives and
 * why a tampered callback cannot change where the browser lands.
 */
export function reconnectHrefFor(view: ReauthBannerView, returnTo: string): string {
  const query = new URLSearchParams()
  if (view.connectionId !== null) query.set('connectionId', view.connectionId)
  query.set('returnTo', returnTo)
  return `${RECONNECT_SCREEN_PATH}/google/connect?${query.toString()}`
}

/**
 * The one field every admin document's view carries for this.
 *
 * One field rather than two so that adding the banner to a document is one line in its view and one line
 * in its template, and so the ten call sites cannot each decide differently what `returnTo` means.
 *
 * `returnTo` is the URL of the page being rendered — path and query, because the diary's state IS its
 * query string and a reconnect that came back to a bare `/calendar` would have thrown the operator's day
 * away. It is a required field rather than an optional one: a default would make the location preservation
 * quietly absent from nine documents and present in the one somebody tested.
 */
export interface AdminChrome {
  readonly googleReauth: ReauthBannerView | null
  /**
   * H-HARD-05's send-backlog banner, or null. REQUIRED and not optional, for the reason this interface
   * exists at all: an optional field would make the banner quietly absent from nine documents and present
   * in the one somebody tested. `adminChromeFor` is the single place that builds this, so adding it cost
   * one line there rather than ten.
   */
  readonly sendBacklog: SendBacklogView | null
  readonly returnTo: string
  /**
   * H-HARD-01's per-response CSP nonce, for the six admin documents that carry an inline `<script>`.
   *
   * OPTIONAL, which is the opposite of the decision `sendBacklog` records one field up, and the reason is
   * that the two fail in opposite directions. A missing banner is INVISIBLE — the page renders, the
   * operator is not told the connection is dead — so it must be impossible to omit. A missing nonce is
   * LOUD: `script-src 'nonce-…'` with no `'unsafe-inline'` refuses the script, the browser logs the
   * violation and the control does not work the first time anybody uses it. Fail-closed and immediately
   * visible is what makes an optional field safe here.
   *
   * It is also what keeps this unit from editing fifty-one `AdminChrome` literals across six other units'
   * files and their tests. The rule is enforced by a SCAN instead — `apps/web/src/security-headers.test.ts`
   * walks `app/(admin)` and requires every inline `<script>` to carry a `nonce=` attribute, in both
   * directions, which is `google-reauth-banner.test.ts`'s arrangement for the banner.
   *
   * `adminChromeFor` reads it off the request header the proxy sets, so no document has to remember to.
   */
  readonly cspNonce?: string
  /**
   * The signed-in reader's role and staff reference, for the shell's sidebar and topbar.
   *
   * OPTIONAL, following `cspNonce` one field up rather than `sendBacklog` two fields up, and for the
   * reason that comment gives: the question is which direction a missing value fails in. `sendBacklog`
   * must be required because a missing banner is INVISIBLE. A missing role here is made LOUD instead —
   * `renderAdminShell` throws `[admin-shell-no-role]` rather than rendering a document with no
   * navigation — so the property that makes an optional field safe is satisfied by the renderer, and this
   * unit does not edit forty-one `AdminChrome` literals across other units' tests to buy it.
   *
   * `adminChromeFor` fills both: from the `principal` a caller passes, or by resolving the session itself
   * when one does not.
   */
  readonly role?: Role
  readonly staffReference?: string
}

/**
 * What an admin document emits. One call, so a document either has the banners or visibly does not.
 *
 * The send-backlog banner comes FIRST, above the Google one, and the order is a judgement that is worth
 * stating: a delayed message is about something a member of staff is doing right now at a terminal — do
 * not promise a client this has been sent — and an expired Google grant is about replies that are not
 * being posted. The urgent-to-the-reader one is the one at the top.
 */
export function renderAdminBanner(chrome: AdminChrome): string {
  return (
    renderMessagesDelayedBanner(chrome.sendBacklog) +
    renderGoogleReauthBanner(chrome.googleReauth, chrome.returnTo)
  )
}

/**
 * The banner, or the empty string when the connection needs none.
 *
 * `returnTo` is the URL of the document being rendered, so *Reconnect* comes back to the page the operator
 * was on.
 */
export function renderGoogleReauthBanner(view: ReauthBannerView | null, returnTo: string): string {
  if (view === null) return ''
  const account =
    view.googleEmail === null
      ? ''
      : `<p data-google-reauth-account="${escapeHtml(view.googleEmail)}">The account is ` +
        `${safeText(view.googleEmail)}.</p>`
  const action =
    `<p><a data-action="reconnect-google" href="${escapeHtml(reconnectHrefFor(view, returnTo))}">` +
    'Reconnect Google</a></p>'
  const body = [
    `<h2>${escapeHtml(view.headline)}</h2>`,
    `<p>${escapeHtml(view.detail)}</p>`,
    account,
    action,
  ].join('')

  // The dismissible branch is a native `<details open>`: the summary stays, the detail collapses, and
  // nothing records that it happened. The non-dismissible branch has no control of any kind — see the
  // header for why each alternative is wrong for an expired Google grant.
  const inner = view.dismissible
    ? `<details open><summary data-action="dismiss-google-reauth">${escapeHtml(
        view.headline,
      )}</summary>${body}</details>`
    : body

  return (
    `<section class="google-reauth" ${GOOGLE_REAUTH_BANNER_ATTRIBUTE}="${escapeHtml(view.state)}" ` +
    `data-dismissible="${view.dismissible ? 'true' : 'false'}" role="region" ` +
    `aria-label="Google connection">${inner}</section>`
  )
}
