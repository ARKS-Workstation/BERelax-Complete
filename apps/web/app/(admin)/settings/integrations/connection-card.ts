import {
  CAPABILITY_HEALTH_LABEL,
  CAPABILITY_LABEL,
  type ConnectionTone,
  connectionStateCopy,
  DEGRADED_CAUSE_DETAIL,
  type DegradedCause,
  type GoogleCapability,
  type GoogleCapabilityHealth,
  type GoogleConnectionDisplayState,
  type GrantedScopeLabel,
} from '@berelax/core'
import { escapeHtml, renderTestingExpiry, type TestingExpiryView } from '@berelax/google'
import { tokensCss } from '@berelax/ui'

/**
 * Settings → Integrations: the Google connection card, as HTML.
 *
 * Pure. Rows and sentences in, a document out, no database and no clock — which is what lets the DOM
 * assertions, the axe audit and the screenshots run against the exact bytes the route serves, with
 * nothing between the renderer and the assertion and no server to start (brief rules 18 and 19). It is
 * also what makes the page reproducible: a document that printed *"as of now"* could not produce two
 * identical screenshots, and the acceptance asks for zero pixel diff on an unchanged rerun.
 *
 * ## Why this is a document served by a route handler and not a page.tsx
 *
 * The unit's file list named `page.tsx` and `connection-card.tsx`. It is the fourth surface in this
 * repository to record why it is not: `apps/web/src/routes/registry.ts` is in exact bijection with the
 * filesystem and requires every *document* to be served in **both** locales, so a page here would need an
 * Arabic admin document and would join a twelve-cell screenshot matrix whose RTL half must be a real
 * Arabic route. The Messages inbox, the HR credentials screen, the compliance calendar, the breakpoint
 * preview and the two Google routes next door are all handlers for that reason, and every one of them is
 * English-only on purpose: this surface tells an operator whether a credential works.
 *
 * So the bytes are assembled here, and the colours come from `tokensCss()` — the one place a literal
 * colour may exist (`pnpm colours`), emitted inline because a route handler cannot reference the build's
 * hashed stylesheet.
 *
 * ## The two rules this file exists to keep
 *
 * **Never a scope string** (docs/10 §4). Every permission is rendered from `grantedScopeLabels`, and the
 * card carries no `googleapis.com/auth/` substring anywhere — asserted against a real DOM over the whole
 * document, which is the only direction of that assertion a `hidden` attribute or an HTML comment cannot
 * satisfy.
 *
 * **Never *Connected* without a recency.** The state comes from `stateShownFor`, which is the rule rather
 * than this file's judgement, and the headline and the timestamp are rendered by the same branch — so
 * there is no arrangement of this template that prints one without the other.
 */

/** The card's own styles. Tokens only; there is no literal colour in this file. */
const CARD_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.25rem; margin: 0 0 var(--space-3); }
  h3 { font-size: 1rem; margin: var(--space-5) 0 var(--space-2); color: var(--color-ink-2); }
  p { margin: 0 0 var(--space-5); }
  .lede { color: var(--color-ink-2); }
  .card {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  .headline { font-size: 1.125rem; font-weight: 500; margin: 0 0 var(--space-2); }
  .recency { margin: 0 0 var(--space-3); color: var(--color-ink-2); }
  .detail { margin: 0 0 var(--space-5); }
  dl { margin: 0 0 var(--space-5); }
  dt { color: var(--color-ink-2); font-size: 0.875rem; }
  dd { margin: 0 0 var(--space-3); }
  ul { margin: 0 0 var(--space-5); padding-inline-start: var(--space-6); }
  li { margin: 0 0 var(--space-2); }
  .health { color: var(--color-ink-2); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin: var(--space-5) 0 0; }
  .actions a, .actions button {
    display: inline-flex;
    align-items: center;
    min-height: 2.75rem;
    padding: var(--space-2) var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-ground);
    color: var(--color-ink);
    font: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  .empty { color: var(--color-ink-2); }
  [data-tone='urgent'] .headline { font-weight: 600; }
`

export interface CapabilityRowView {
  readonly capability: GoogleCapability
  readonly health: GoogleCapabilityHealth
  /** What the capability points at, in the words the picker recorded. Null when nothing is chosen. */
  readonly resource: string | null
}

export interface ConfirmedListingView {
  readonly placeId: string
  readonly title: string
  readonly address: string
  /** Spelled out, so the card carries no instant a screenshot would have to re-render. */
  readonly confirmedOn: string
}

/**
 * What the amber state needs beyond its sentence, and what happens when nobody has recorded it.
 *
 * Both fields are nullable, and the null branches are the point. docs/10 §4 asks for a submission date
 * and a link to the Cloud quota page; neither is computable, so both are settings, and an unset setting
 * renders as a sentence saying so rather than as a plausible date or a URL somebody wrote from memory
 * (brief rule 15).
 */
export interface PendingApprovalView {
  readonly submittedOn: string | null
  readonly quotaPageUrl: string | null
}

export interface ConnectionCardView {
  readonly connectionId: string
  readonly googleEmail: string
  /** `stateShownFor`'s answer: what the person is told. */
  readonly state: GoogleConnectionDisplayState
  /** `deriveConnectionHealth`'s answer, which differs only for a grant nothing has read yet. */
  readonly derivedState: GoogleConnectionDisplayState
  readonly degradedCause: DegradedCause | null
  /** `recencyPhrase`'s output. Null exactly when nothing has ever succeeded. */
  readonly recency: string | null
  readonly scopes: readonly GrantedScopeLabel[]
  readonly capabilities: readonly CapabilityRowView[]
  readonly listing: ConfirmedListingView | null
  readonly searchConsoleProperty: string | null
  readonly expiry: TestingExpiryView | null
  /** When the nightly check will next run, spelled out in the owner's zone. */
  readonly nextCheck: string
  readonly pendingApproval: PendingApprovalView | null
}

export interface IntegrationsView {
  readonly connections: readonly ConnectionCardView[]
  /** True when the caller narrowed the page to one connection, which the screenshots do. */
  readonly narrowed: boolean
  readonly reconnectPath: string
  readonly testConnectionPath: string
}

const toneOf = (view: ConnectionCardView): ConnectionTone => connectionStateCopy(view.state).tone

/**
 * The capability list: English name, English health, and what it points at.
 *
 * `resource` is rendered as the picker recorded it — a listing title or a Search Console property — and
 * never as the stored `resource_ref` JSON. A capability with nothing chosen says so, because *"not
 * chosen yet"* and *"chosen and failing"* are the two states an operator most needs told apart and the
 * empty JSON object looks like neither.
 */
function capabilityList(view: ConnectionCardView): string {
  if (view.capabilities.length === 0) {
    return '<p class="empty">No permissions have been registered for this account yet.</p>'
  }
  const items = view.capabilities.map(
    (row) =>
      `<li data-capability="${escapeHtml(row.capability)}" data-health="${escapeHtml(row.health)}">` +
      `<strong>${escapeHtml(CAPABILITY_LABEL[row.capability])}</strong> — ` +
      `<span class="health">${escapeHtml(CAPABILITY_HEALTH_LABEL[row.health])}</span>` +
      (row.resource === null
        ? ' <span class="health">(nothing chosen yet)</span>'
        : ` <span class="health">(${escapeHtml(row.resource)})</span>`) +
      '</li>',
  )
  return `<ul data-capabilities="${view.capabilities.length}">${items.join('')}</ul>`
}

/** The permissions, in English. The list a person reads instead of the consent screen's URLs. */
function scopeList(view: ConnectionCardView): string {
  if (view.scopes.length === 0) {
    return '<p class="empty">Google returned no permissions for this account.</p>'
  }
  const items = view.scopes.map(
    (scope) =>
      `<li data-scope-recognised="${scope.recognised ? 'true' : 'false'}">` +
      escapeHtml(scope.label) +
      (scope.token === '' ? '' : ` <span class="health">(${escapeHtml(scope.token)})</span>`) +
      '</li>',
  )
  return `<ul data-scopes="${view.scopes.length}">${items.join('')}</ul>`
}

/**
 * The extra paragraph the amber state carries: when the application went in, and where approval shows up.
 *
 * Rendered only for `pending_gbp_approval`, and only from recorded values. The anchor exists when the
 * quota page has been configured and the sentence names the console page in words when it has not —
 * navigation rather than a URL, which is the one form of that instruction that cannot be wrong.
 */
function pendingApproval(view: ConnectionCardView): string {
  if (view.pendingApproval === null) return ''
  const submitted =
    view.pendingApproval.submittedOn === null
      ? 'The date the application was submitted has not been recorded.'
      : `The application was submitted on ${escapeHtml(view.pendingApproval.submittedOn)}.`
  const quota =
    view.pendingApproval.quotaPageUrl === null
      ? 'Approval is visible in the Google Cloud console as this project&rsquo;s Business Profile API ' +
        'quota moving from 0 to 300 requests per minute; open the console&rsquo;s APIs and services ' +
        'quotas page to check. Paste that page&rsquo;s address into settings and this will become a link.'
      : 'Approval is visible as this project&rsquo;s Business Profile API quota moving from 0 to 300 ' +
        `requests per minute: <a href="${escapeHtml(view.pendingApproval.quotaPageUrl)}" ` +
        'rel="noreferrer noopener" target="_blank">open the Cloud console quota page</a>.'
  return (
    `<p data-pending-approval="true" data-submitted-on="${escapeHtml(
      view.pendingApproval.submittedOn ?? 'not-recorded',
    )}" data-quota-link="${view.pendingApproval.quotaPageUrl === null ? 'unset' : 'set'}">` +
    `${submitted} ${quota}</p>`
  )
}

/**
 * One card.
 *
 * The headline and the recency are emitted by the same expression on purpose: there is no branch here
 * that can print *Connected* on its own, which is the rule `stateShownFor` encodes and this is where it
 * would be broken.
 */
function card(view: ConnectionCardView, page: IntegrationsView): string {
  const copy = connectionStateCopy(view.state)
  const detail =
    view.degradedCause === null ? copy.detail : DEGRADED_CAUSE_DETAIL[view.degradedCause]
  const recency =
    view.recency === null
      ? '<p class="recency" data-recency="never">Nothing has been read from Google on this account yet.</p>'
      : `<p class="recency" data-recency="${escapeHtml(view.recency)}">${escapeHtml(view.recency)}.</p>`
  return [
    `<section class="card" data-google-connection="${escapeHtml(view.connectionId)}" ` +
      `data-connection-state="${escapeHtml(view.state)}" ` +
      `data-derived-state="${escapeHtml(view.derivedState)}" ` +
      `data-tone="${escapeHtml(toneOf(view))}">`,
    `<h2 data-google-account="${escapeHtml(view.googleEmail)}">${escapeHtml(view.googleEmail)}</h2>`,
    `<p class="headline" data-connection-headline="${escapeHtml(view.state)}">${escapeHtml(
      copy.headline,
    )}</p>`,
    recency,
    `<p class="detail">${escapeHtml(detail)}</p>`,
    pendingApproval(view),
    renderTestingExpiry(view.expiry),
    '<h3>What this account is used for</h3>',
    capabilityList(view),
    '<h3>What it is allowed to do</h3>',
    scopeList(view),
    '<h3>What it is pointed at</h3>',
    '<dl>',
    view.listing === null
      ? '<div><dt>Business listing</dt><dd data-listing="none">No listing has been chosen yet.</dd></div>'
      : `<div><dt>Business listing</dt><dd data-listing="${escapeHtml(view.listing.placeId)}">` +
        `${escapeHtml(view.listing.title)} — ${escapeHtml(view.listing.address)} ` +
        `<span class="health">(confirmed ${escapeHtml(view.listing.confirmedOn)})</span></dd></div>`,
    view.searchConsoleProperty === null
      ? '<div><dt>Search Console property</dt><dd data-search-console="none">None chosen yet.</dd></div>'
      : `<div><dt>Search Console property</dt><dd data-search-console="${escapeHtml(
          view.searchConsoleProperty,
        )}">${escapeHtml(view.searchConsoleProperty)}</dd></div>`,
    `<div><dt>Next automatic check</dt><dd data-next-check="${escapeHtml(view.nextCheck)}">` +
      `${escapeHtml(view.nextCheck)}</dd></div>`,
    '</dl>',
    '<div class="actions">',
    // A GET link, because starting a consent is a navigation to Google. `Reconnect` rather than
    // `Connect`: the account is already named above, and docs/10 §4 asks for one button.
    `<a data-action="reconnect" href="${escapeHtml(page.reconnectPath)}">Reconnect this account</a>`,
    // A form rather than fetch(): this surface has no client bundle, and a POST is what a check that
    // makes authenticated calls to Google has to be — a GET would let any crawler spend the account's
    // refresh quota.
    `<form method="post" action="${escapeHtml(page.testConnectionPath)}">`,
    `<input type="hidden" name="connectionId" value="${escapeHtml(view.connectionId)}">`,
    '<button type="submit" data-action="test-connection">Test connection</button>',
    '</form>',
    '</div>',
    '</section>',
  ].join('')
}

/**
 * The whole document.
 *
 * `noindex, nofollow, noarchive` in the head as well as from the proxy's prefix rule: a direct hit on
 * this URL must not depend on a header somebody could reorganise, and the page names a Google account.
 */
export function renderIntegrationsPage(view: IntegrationsView): string {
  const body =
    view.connections.length === 0
      ? '<p class="empty" data-google-connections="0">No Google account is connected. Connecting one ' +
        'lets review replies be drafted for approval and Search Console performance be read.</p>'
      : view.connections.map((connection) => card(connection, view)).join('')
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title, bare or otherwise. `bare-brand-without-massage-center` refuses the short
    // name anywhere in `apps/web`, because berelax.com is an international airport-spa chain with an
    // outlet in this city — and the full trading name on an internal back-office screen would say
    // something it does not mean. The compliance calendar and the template editor title themselves the
    // same way; the Messages inbox is exempt instead, which is the arrangement this avoids extending.
    '<title>Integrations — admin</title>',
    `<style>${tokensCss()}${CARD_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>Integrations</h1>',
    '<p class="lede">What this business has connected to Google, whether it is working, and when it was ' +
      'last checked. Everything below is read from what has already been recorded: opening this page ' +
      'makes no call to Google, so it still says what is wrong on the day the connection has stopped ' +
      'working.</p>',
    `<div data-google-connections="${view.connections.length}"${
      view.narrowed ? ' data-narrowed="true"' : ''
    }>`,
    body,
    '</div>',
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
