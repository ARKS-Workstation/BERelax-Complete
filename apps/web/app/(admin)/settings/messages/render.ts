/**
 * The admin Messages inbox, as HTML.
 *
 * Pure: rows in, a document out, no database and no clock. That is what lets `render.test.ts` assert the
 * things the acceptance criterion names — body, encoding, segments, cost, status, and an HTML preview for
 * a Resend email — without a server, and it is why nothing here reads `new Date()`: a document that
 * printed "as of now" could not produce two identical screenshots on a repeat run, which is the other
 * half of the same criterion.
 *
 * ## Why this is a document served by a route handler
 *
 * W-SITE-01's registry is in exact bijection with the filesystem and requires every *document* to be
 * served in **both** locales, so a `page.tsx` here would need an Arabic admin document and the admin
 * shell that renders it — W-SYS-01's work — and it would join the twelve-cell screenshot matrix, whose
 * RTL half is a real Arabic route. This surface is English-only on purpose: it shows an operator what a
 * vendor was sent, and the acceptance criterion asks for three viewports times two themes, with no
 * direction axis. G-CONN-05 made the same call for the same reason one directory along.
 *
 * So the bytes are assembled here rather than by React, and the tokens come from `tokensCss()` — the one
 * place literal colours are allowed to exist (`pnpm colours`), emitted inline because a route handler
 * cannot reference the build's hashed stylesheet.
 *
 * ## Why the email preview is a sandboxed iframe
 *
 * `body_html` is the bytes Resend was given, and they contain rendered customer data. Interpolating them
 * into this page would let a template — or a value inside one — restyle or script the admin surface it is
 * being inspected on. `sandbox` with no allowances gives the preview no script, no form and no origin, and
 * `srcdoc` keeps it in one document so a screenshot has nothing to load.
 */
import { maskRecipient, safeText } from '@berelax/core'
import type { InboxEntry } from '@berelax/db'
import { tokensCss } from '@berelax/ui'
import {
  type AdminChrome,
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/** The page's own styles. Colours are tokens only; there is no literal in this file. */
const INBOX_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 68rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.125rem; margin: 0; }
  h3 { font-size: 1rem; margin: 0 0 var(--space-3); color: var(--color-ink-2); }
  p { margin: 0 0 var(--space-5); }
  .stub {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  .totals { display: flex; flex-wrap: wrap; gap: var(--space-7); margin: 0 0 var(--space-7); }
  .totals div { margin: 0; }
  .totals dt { color: var(--color-ink-2); font-size: 0.875rem; }
  .totals dd { margin: 0; font-size: 1.25rem; }
  ol.messages { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5); }
  article {
    background: var(--color-surface);
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    padding: var(--space-5);
  }
  .head { display: flex; flex-wrap: wrap; gap: var(--space-3) var(--space-5); align-items: baseline; }
  .head time { color: var(--color-ink-2); font-variant-numeric: tabular-nums; }
  .status { display: inline-flex; align-items: center; gap: var(--space-3); font-weight: 600; }
  .dot { width: var(--space-4); height: var(--space-4); border-radius: var(--radius-handle); }
  .dot-queued { background: var(--color-ink-3); }
  .dot-sent { background: var(--color-accent-teal); }
  .dot-delivered { background: var(--color-success); }
  .dot-failed { background: var(--color-danger); }
  dl.facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: var(--space-3) var(--space-5);
    margin: var(--space-5) 0;
  }
  dl.facts dt { color: var(--color-ink-2); font-size: 0.875rem; }
  dl.facts dd { margin: 0; font-variant-numeric: tabular-nums; }
  pre.body {
    margin: 0;
    padding: var(--space-5);
    background: var(--color-ground-sunk);
    border-radius: var(--radius-1);
    white-space: pre-wrap;
    word-break: break-word;
    font: 0.9375rem/1.5 ui-monospace, monospace;
  }
  iframe.preview {
    width: 100%;
    height: 12rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface-raised);
  }
  table { width: 100%; border-collapse: collapse; margin-top: var(--space-5); }
  caption { text-align: start; color: var(--color-ink-2); font-size: 0.875rem; padding-bottom: var(--space-3); }
  th, td { text-align: start; padding: var(--space-3); border-bottom: 1px solid var(--color-hairline); }
  th { font-size: 0.875rem; color: var(--color-ink-2); }
  .empty {
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-9) var(--space-5);
    text-align: center;
    color: var(--color-ink-2);
  }
`

/**
 * One instant, in the timezone the business runs in.
 *
 * Asia/Dubai and a fixed locale, because the reader is at the front desk in Abu Dhabi and because a
 * screenshot has to be byte-identical on a repeat run. `en-GB` rather than the request's language: this
 * surface is English-only, and an implicit locale would make the rendering depend on a header.
 */
const DUBAI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function formatInstant(iso: string): string {
  return `${DUBAI.format(new Date(iso))} Dubai`
}

/** Integer fils, spelled as fils. Money is never a float (ADR 0007), so it is never formatted as one. */
function formatFils(fils: number): string {
  return `${fils} fils`
}

function statusCell(status: string): string {
  // The word, always, with the colour as a second signal rather than the only one: a status told by
  // colour alone is a status a colour-blind operator cannot read, and docs/08 treats that as a defect.
  return (
    `<span class="status"><span class="dot dot-${safeText(status)}" aria-hidden="true"></span>` +
    `${safeText(status)}</span>`
  )
}

function fact(label: string, value: string | null): string {
  // A missing value is rendered as an em dash rather than omitted: a fact list whose rows appear and
  // disappear per message is a list nobody can scan down, and "not set" is itself information.
  return `<div><dt>${safeText(label)}</dt><dd>${value === null ? '—' : value}</dd></div>`
}

function receiptsTable(entry: InboxEntry): string {
  if (entry.receipts.length === 0) {
    return `<p class="empty">No delivery receipt yet. ${
      entry.status === 'queued'
        ? 'This message has not been handed to a vendor.'
        : `${safeText(entry.vendor)} reports delivery asynchronously.`
    }</p>`
  }
  const rows = entry.receipts
    .map(
      (receipt) =>
        '<tr>' +
        `<td>${formatInstant(receipt.occurredAtIso)}</td>` +
        `<td><code>${safeText(receipt.vendorStatus)}</code></td>` +
        `<td>${receipt.mappedStatus === null ? '—' : safeText(receipt.mappedStatus)}</td>` +
        `<td>${receipt.applied ? 'applied' : safeText(receipt.ignoredReason ?? 'ignored')}</td>` +
        `<td>${receipt.reason === null ? '—' : safeText(receipt.reason)}</td>` +
        '</tr>',
    )
    .join('')
  return (
    '<table><caption>Delivery receipts, as the vendor sent them and as this system read them' +
    '</caption><thead><tr>' +
    '<th scope="col">Reported</th><th scope="col">Vendor status</th><th scope="col">Mapped to</th>' +
    '<th scope="col">Outcome</th><th scope="col">Vendor reason</th>' +
    `</tr></thead><tbody>${rows}</tbody></table>`
  )
}

function preview(entry: InboxEntry): string {
  if (entry.bodyHtml === null) return ''
  return (
    `<h3>HTML part, as ${safeText(entry.vendor)} received it</h3>` +
    `<iframe class="preview" sandbox="" title="HTML preview of ${safeText(entry.subject ?? 'this email')}"` +
    ` srcdoc="${escapeAttribute(entry.bodyHtml)}"></iframe>`
  )
}

/**
 * Escapes a whole HTML document for an attribute value.
 *
 * `safeText` would strip bidi controls, and here that would mean the preview showed something different
 * from what was sent — the one thing this pane exists not to do. So the markup is escaped and nothing
 * else, and the `sandbox` attribute is what makes it safe to display.
 */
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function messageArticle(entry: InboxEntry): string {
  const failure =
    entry.lastFailureReason === null
      ? null
      : `${safeText(entry.lastFailureReason)}${
          entry.lastFailureDetail === null ? '' : ` — ${safeText(entry.lastFailureDetail)}`
        }`
  return (
    '<li><article>' +
    '<div class="head">' +
    `<h2>${safeText(entry.templateKey)} v${entry.templateVersion}</h2>` +
    `<time datetime="${safeText(entry.queuedAtIso)}">${formatInstant(entry.queuedAtIso)}</time>` +
    statusCell(entry.status) +
    '</div>' +
    '<dl class="facts">' +
    fact('Channel', `${safeText(entry.channel)} via ${safeText(entry.vendor)}`) +
    fact('Class', safeText(entry.messageClass)) +
    // Masked, because this page is screenshotted and published as a gallery link.
    fact('Recipient', safeText(maskRecipient(entry.channel, entry.recipient))) +
    fact('Sender ID', entry.senderId === null ? null : safeText(entry.senderId)) +
    fact('Encoding', safeText(entry.encoding)) +
    fact('Segments', String(entry.segments)) +
    fact('Cost', formatFils(entry.costFils)) +
    fact('Attempts', String(entry.attempts)) +
    fact(
      'Provider id',
      entry.providerMessageId === null ? null : `<code>${safeText(entry.providerMessageId)}</code>`,
    ) +
    fact('Locale', safeText(entry.locale)) +
    fact('Sent', entry.sentAtIso === null ? null : formatInstant(entry.sentAtIso)) +
    fact(
      'Next attempt',
      entry.nextAttemptAtIso === null ? null : formatInstant(entry.nextAttemptAtIso),
    ) +
    fact('Failure', failure) +
    '</dl>' +
    (entry.subject === null ? '' : `<h3>Subject: ${safeText(entry.subject)}</h3>`) +
    `<pre class="body">${safeText(entry.body)}</pre>` +
    preview(entry) +
    receiptsTable(entry) +
    '</article></li>'
  )
}

export interface InboxView {
  /**
   * The Google re-auth banner and the page a reconnect comes back to (G-CONN-08).
   *
   * Required rather than optional. An optional field would be a permissive default, and the default
   * would be the one state this banner exists to make impossible: an admin page that says nothing while
   * the Google grant is dead. `apps/web/src/google-reauth-banner.test.ts` walks every admin document on
   * disk and fails by name if one of them does not render it.
   */
  readonly chrome: AdminChrome
  readonly entries: readonly InboxEntry[]
  /** Echoed so a reader can see the list is filtered rather than empty. */
  readonly filter: {
    readonly templateKey: string | null
    readonly recipient: string | null
    readonly status: string | null
    readonly limit: number
  }
  /** The provider mode this environment is in, so the banner cannot claim the wrong one. */
  readonly smsProvider: string
  readonly emailProvider: string
}

export function renderInboxHtml(view: InboxView): string {
  const totalCost = view.entries.reduce((sum, entry) => sum + entry.costFils, 0)
  const totalSegments = view.entries.reduce((sum, entry) => sum + entry.segments, 0)
  const filters = [
    view.filter.templateKey === null ? null : `template ${view.filter.templateKey}`,
    view.filter.recipient === null ? null : 'one recipient',
    view.filter.status === null ? null : `status ${view.filter.status}`,
  ].filter((part): part is string => part !== null)

  const body =
    view.entries.length === 0
      ? '<p class="empty">No messages recorded yet. A send appears here the moment a vendor answers ' +
        'for it — this list is the evidence that nothing was sent invisibly, so an empty list means ' +
        'nothing has been sent.</p>'
      : `<ol class="messages">${view.entries.map((entry) => messageArticle(entry)).join('')}</ol>`

  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<title>Messages — BE RELAX admin</title>',
    `<style>${tokensCss()}${INBOX_CSS}${GOOGLE_REAUTH_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Messages</h1>',
    '<div class="stub">',
    `<p><strong>Nothing here left the building.</strong> The SMS provider is <code>${safeText(
      view.smsProvider,
    )}</code> and the email provider is <code>${safeText(
      view.emailProvider,
    )}</code>; with <code>fake</code>, SMSala and Resend are local stand-ins that compute real ` +
      'segments, real cost and real delivery receipts, and send nothing. Every send is listed below ' +
      'with what it would have cost, which is the point: a stub must never look like it worked.</p>',
    '</div>',
    '<dl class="totals">',
    `<div><dt>Messages listed</dt><dd>${view.entries.length}</dd></div>`,
    `<div><dt>Billable segments</dt><dd>${totalSegments}</dd></div>`,
    `<div><dt>Cost of the list</dt><dd>${formatFils(totalCost)}</dd></div>`,
    // The limit is always stated, filters or not: "showing 50" beside "there are 4" is the difference
    // between a short list and a truncated one, and a reader who cannot tell which will assume the wrong
    // one of the two.
    `<div><dt>Showing</dt><dd>${
      filters.length === 0 ? '' : `${safeText(filters.join(', '))} · `
    }newest ${view.filter.limit}</dd></div>`,
    '</dl>',
    body,
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
