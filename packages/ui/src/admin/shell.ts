import { type AdminNavGroup, adminNavFor, adminNavLocate, type Role, safeText } from '@berelax/core'
import { tokensCss } from '../tokens/emit.ts'

/**
 * The admin's chrome: a fixed sidebar, a topbar, and a content column.
 *
 * ## Why this exists
 *
 * The operational admin had no chrome. Fifty-three route handlers, each emitting a complete HTML document
 * with its own `<style>`, and not one link between them — a screen was reached by typing its path. This
 * module is the one document every one of them is now rendered inside, so the navigation, the breadcrumb,
 * the signed-in reader and the sign-out control are written once.
 *
 * ## What is borrowed and what is not
 *
 * The layout is the one every admin console has settled on, and the brief names Minia as the reference:
 * a fixed left rail of grouped links, a topbar carrying where-you-are and who-you-are, and a content
 * column of cards. That ARRANGEMENT is what has been reproduced. Nothing from that template is in this
 * repository — not a rule of its CSS, not a line of its markup, not its icon set — because it is sold
 * under a licence this project does not hold, and `pnpm licences` exists to keep unlicensed material out.
 *
 * The colours are therefore this product's own. `pnpm colours` would refuse a borrowed palette anyway:
 * every literal colour outside the token layer is a violation, and every token carries a measured
 * contrast ratio with a test asserting it. So the rail is `--color-ground-sunk`, the cards are
 * `--color-surface`, and the current item is marked with `--color-accent-gold` — which is the DARKENED
 * gold at 4.62:1, not the brand `--color-decor-gold` at 2.90:1, because the current item is text.
 *
 * ## Why a string and not a React component
 *
 * Because its callers are route handlers, not pages. `apps/web/src/routes/registry.ts` requires every
 * DOCUMENT to exist in both locales with a canonical URL, and there is no Arabic admin and no canonical
 * form for a `noindex` screen — which is why these screens are route handlers in the first place, as
 * `reports/render.ts` explains at length. A React shell would mean inventing an Arabic admin to satisfy a
 * rule about public pages.
 *
 * ## The document's contract with its callers
 *
 * A caller passes the `<html>` attributes it already carried, its own `<style>`, and its `<main>` content.
 * Nothing it used to emit is taken away: the data attributes its tests assert on are passed through
 * verbatim rather than rebuilt here, because a shell that rewrote them would break every screen's tests
 * for the sake of tidiness.
 */

export interface AdminShellOptions {
  /** The `<title>`, which this appends `— admin` to. No brand: see the note in `till/render.ts`. */
  readonly title: string
  /** The `<h1>`. Defaults to `title`, and differs where a screen's heading carries a period or a name. */
  readonly heading?: string
  /** The path being served, for the sidebar's current item and the breadcrumb. */
  readonly path: string
  /** The reader's role, which decides what the sidebar contains. */
  readonly role: Role
  /** The reader's `employee.staff_reference`. No name of a person is in this build (brief rule 10). */
  readonly staffReference?: string
  /**
   * Extra attributes for `<html>`, already escaped by the caller.
   *
   * Passed through rather than composed, because the screens' tests assert on these exact attributes and
   * several build them conditionally. A shell that owned them would be a second author of a contract
   * forty render modules already have with their tests.
   */
  readonly htmlAttributes?: string
  /** The screen's own CSS, appended after the shell's. */
  readonly pageCss?: string
  /** Markup placed above the heading — the Google re-auth banner and its kin. */
  readonly banner?: string
  /** The screen's content, which replaces everything it used to put inside `<main>` below its `<h1>`. */
  readonly body: string
  /**
   * The window the sidebar's window-requiring links should carry.
   *
   * `/reports`, `/analytics` and `/accounts/reconciliation` refuse a bare request on purpose — a screen
   * that answered for "the last thirty days" answers a different question every day — so the sidebar has
   * to supply one or send every reader to a 400. It comes from the CALLER, which has a clock and a trading
   * calendar; this module has neither and must not guess. Absent, those links are rendered as the
   * refusals they are: present, labelled, and marked `aria-disabled`, so the menu still tells you the
   * screen exists.
   */
  readonly window?: { readonly from: string; readonly to: string; readonly period: string }
}

/** The rail's width, and the only place it is stated. */
const RAIL_REM = 15

export const ADMIN_SHELL_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--color-ground);
    color: var(--color-ink);
    font-size: 1.0625rem;
    line-height: 1.5;
  }
  .shell { display: grid; grid-template-columns: ${RAIL_REM}rem minmax(0, 1fr); min-height: 100vh; }
  /*
   * The rail scrolls independently and stays put. "position: sticky" with "align-self: start" rather than
   * "position: fixed": fixed would take the rail out of the grid and the content column would slide under
   * it at every width, which is the commonest way this layout breaks.
   */
  .rail {
    position: sticky;
    top: 0;
    align-self: start;
    height: 100vh;
    overflow-y: auto;
    background: var(--color-ground-sunk);
    border-inline-end: 1px solid var(--color-border);
    padding: var(--space-4) 0;
  }
  .rail-mark {
    display: block;
    padding: 0 var(--space-4) var(--space-4);
    font-size: 1.375rem;
    color: var(--color-ink);
    text-decoration: none;
  }
  .rail-group { padding: var(--space-3) 0 0; }
  .rail-group > h2 {
    margin: 0 0 var(--space-2);
    padding: 0 var(--space-4);
    font-size: 0.9375rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-ink-3);
  }
  .rail-group ul { margin: 0; padding: 0; list-style: none; }
  /*
   * 2.75rem is 44px, and the floor the touch-target gate holds a control to on a phone is 48. The anchor
   * is a block, so its height is the row's: padding plus the line box takes it past 48 at the body step,
   * and "min-height" is the guarantee rather than the arithmetic.
   */
  .rail-group a {
    display: flex;
    align-items: center;
    min-height: 3rem;
    padding: var(--space-2) var(--space-4);
    color: var(--color-ink-2);
    text-decoration: none;
    border-inline-start: 3px solid transparent;
  }
  .rail-group a:hover { background: var(--color-surface); color: var(--color-ink); }
  .rail-group a[aria-current='page'] {
    background: var(--color-surface);
    color: var(--color-accent-gold);
    border-inline-start-color: var(--color-accent-gold);
    font-weight: 600;
  }
  /*
   * A link the menu cannot complete. It is shown rather than hidden — the screen exists and a reader
   * should know — but it is not a link, because an anchor to a path that answers 400 is a trap.
   */
  .rail-group span.unavailable {
    display: flex;
    align-items: center;
    min-height: 3rem;
    padding: var(--space-2) var(--space-4);
    color: var(--color-ink-3);
    border-inline-start: 3px solid transparent;
  }
  .topbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-5);
    background: var(--color-surface);
    border-block-end: 1px solid var(--color-border);
  }
  .crumbs { margin: 0; font-size: 0.9375rem; color: var(--color-ink-2); }
  .crumbs a { color: var(--color-ink-2); }
  .whoami { display: flex; align-items: center; gap: var(--space-3); font-size: 0.9375rem; }
  .whoami .role {
    padding: 0.125rem var(--space-2);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-1);
    color: var(--color-ink-2);
  }
  .whoami form { margin: 0; }
  .whoami button {
    min-height: 2.5rem;
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface-raised);
    color: var(--color-ink);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-1);
    font: inherit;
    cursor: pointer;
  }
  main { padding: var(--space-5); max-width: 90rem; }
  main > h1 { margin: 0 0 var(--space-4); font-size: 1.5rem; }
  /* The card, which is the one shape the content column is built from. */
  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-4);
    margin-block-end: var(--space-4);
  }
  .card > h2 { margin: 0 0 var(--space-3); font-size: 1.25rem; }
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--space-4);
    margin-block-end: var(--space-4);
  }
  a:focus-visible, button:focus-visible, [tabindex]:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }
  /*
   * Below the rail's own width plus a readable column there is no room for two columns, so the rail
   * becomes a band above the content. It is NOT collapsed behind a button: a disclosure needs script, the
   * admin ships none, and a menu that cannot open without JavaScript is worse than one that wraps.
   */
  @media (max-width: 60rem) {
    .shell { grid-template-columns: minmax(0, 1fr); }
    .rail { position: static; height: auto; border-inline-end: 0; border-block-end: 1px solid var(--color-border); }
    .rail-group a, .rail-group span.unavailable { border-inline-start: 0; }
    .rail-group a[aria-current='page'] { border-inline-start: 0; text-decoration: underline; }
    main { padding: var(--space-4); }
  }
`

function navItemHref(
  item: AdminNavGroup['items'][number],
  window: AdminShellOptions['window'],
): string | null {
  if (item.needsWindow === undefined) return item.href
  if (window === undefined) return null
  return item.needsWindow === 'period'
    ? `${item.href}?period=${encodeURIComponent(window.period)}`
    : `${item.href}?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`
}

function renderRail(options: AdminShellOptions): string {
  const groups = adminNavFor(options.role)
  const here = adminNavLocate(options.path)
  const parts = [
    '<div class="rail">',
    // The mark is a link to the dashboard and carries no brand wordmark, for the reason the titles do not.
    '<a class="rail-mark" href="/calendar">Admin</a>',
    '<nav aria-label="Sections">',
  ]
  if (groups.length === 0) {
    parts.push('<p class="rail-group">No section is available to this role.</p>')
  }
  for (const group of groups) {
    parts.push(
      `<div class="rail-group"><h2 id="nav-${safeText(group.id)}">${safeText(group.label)}</h2>`,
    )
    parts.push(`<ul aria-labelledby="nav-${safeText(group.id)}">`)
    for (const item of group.items) {
      const href = navItemHref(item, options.window)
      const current = here !== null && here.item.href === item.href
      parts.push(
        href === null
          ? `<li><span class="unavailable" aria-disabled="true" title="Open this from a screen that ` +
              `carries a date range.">${safeText(item.label)}</span></li>`
          : `<li><a href="${safeText(href)}"${current ? ' aria-current="page"' : ''}>` +
              `${safeText(item.label)}</a></li>`,
      )
    }
    parts.push('</ul></div>')
  }
  parts.push('</nav></div>')
  return parts.join('')
}

function renderTopbar(options: AdminShellOptions): string {
  const here = adminNavLocate(options.path)
  const crumbs = [
    '<p class="crumbs" aria-label="Breadcrumb">',
    '<a href="/calendar">Admin</a>',
    here === null ? '' : ` / ${safeText(here.group.label)}`,
    here === null ? ` / ${safeText(options.title)}` : ` / ${safeText(here.item.label)}`,
    '</p>',
  ].join('')
  /*
   * Sign-out is a POST and not a link. A GET that ends a session is a session anybody can end with an
   * `<img>` tag on a page the reader happens to be looking at, which is the textbook cross-site request
   * every admin gets this wrong at least once.
   */
  const whoami = [
    '<div class="whoami">',
    options.staffReference === undefined
      ? ''
      : `<span data-testid="shell-staff">${safeText(options.staffReference)}</span>`,
    `<span class="role" data-testid="shell-role">${safeText(options.role)}</span>`,
    '<form method="post" action="/logout">',
    '<button type="submit">Sign out</button>',
    '</form>',
    '</div>',
  ].join('')
  return `<div class="topbar">${crumbs}${whoami}</div>`
}

export function renderAdminShell(options: AdminShellOptions): string {
  const heading = options.heading ?? options.title
  return [
    '<!doctype html>',
    `<html lang="en"${options.htmlAttributes ?? ''}>`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    `<title>${safeText(options.title)} — admin</title>`,
    `<style>${tokensCss()}${ADMIN_SHELL_CSS}${options.pageCss ?? ''}</style>`,
    '</head>',
    '<body>',
    '<div class="shell">',
    renderRail(options),
    '<div>',
    renderTopbar(options),
    '<main>',
    options.banner ?? '',
    `<h1>${safeText(heading)}</h1>`,
    options.body,
    '</main>',
    '</div>',
    '</div>',
    '</body>',
    '</html>',
  ].join('')
}
