import { escapeHtml, formatAmount } from '@berelax/core'
import type {
  InteractionPanel,
  LandingPagePanel,
  OriginationPanel,
  SegmentPanel,
  SourceRevenuePanel,
} from '../queries.ts'
import { num, renderPanel, shareCell } from './panel.ts'

/**
 * The five tabular panels (A-FIRST-10): origination, landing pages, interactions, the two splits, and
 * revenue by source.
 *
 * One file because they share one shape — a `<table>` of rows with a share column — and five files of
 * forty lines each would be five places to make the same decision about an empty denominator. What they
 * do NOT share is the query: each is read by its own function in `../queries.ts`, which is what the
 * headline comparison rests on.
 *
 * Every share column uses `shareCell`, so a row with no sessions prints an em dash and never `0%`. That is
 * the page's one rule, stated once: a zero and "there is nothing to be a share of" are different facts
 * (ADR 0002), and a table is where the distinction gets quietly lost.
 */

export function renderOriginationPanel(panel: OriginationPanel): string {
  const rows = panel.rows
    .map(
      (row) =>
        `<tr data-origination="${escapeHtml(`${row.source}/${row.medium}/${row.campaign}`)}">` +
        `<th scope="row">${escapeHtml(row.source)}</th>` +
        `<td>${escapeHtml(row.medium)}</td>` +
        `<td>${escapeHtml(row.campaign === '' ? '—' : row.campaign)}</td>` +
        num(row.sessions) +
        num(row.paid) +
        shareCell(row.paid, row.sessions) +
        '</tr>',
    )
    .join('')
  return renderPanel({
    id: 'origination',
    heading: 'Traffic and conversion by source, medium and campaign',
    why:
      'One row per origination tuple the resolver produced. A session nobody could attribute reads ' +
      'unknown/unknown rather than being dropped — dropping it would shrink every bucket as the ' +
      'attribution got worse.',
    headline: panel.headline,
    basis:
      'analytics.daily_traffic and analytics.daily_funnel, both keyed on the tuple, joined on all three ' +
      'dimensions so a tuple present in one and not the other is still a row. Sessions are the ' +
      'non-crawler figure.',
    body:
      '<table><caption>Sessions, paid conversions and the share, by origination.</caption>' +
      '<thead><tr><th scope="col">Source</th><th scope="col">Medium</th><th scope="col">Campaign</th>' +
      '<th scope="col" class="num">Sessions</th><th scope="col" class="num">Paid</th>' +
      '<th scope="col" class="num">Share</th></tr></thead>' +
      `<tbody>${rows}</tbody></table>`,
  })
}

export function renderLandingPagePanel(panel: LandingPagePanel): string {
  const rows = panel.rows
    .map(
      (row) =>
        `<tr data-landing-path="${escapeHtml(row.path)}">` +
        `<th scope="row"><code>${escapeHtml(row.path)}</code></th>` +
        num(row.sessions) +
        num(row.paid) +
        shareCell(row.paid, row.sessions) +
        '</tr>',
    )
    .join('')
  return renderPanel({
    id: 'landing-pages',
    heading: 'Landing-page performance',
    why:
      'Sessions that ENTERED on each path, and how many of them paid. Read off the session row rather ' +
      'than the first page_view event: raw events are dropped at 90 days and the landing path is not, ' +
      'so an events-derived panel would change its answer as the window aged out.',
    headline: panel.headline,
    basis: 'Live read of analytics.session.landing_path, crawler sessions excluded.',
    body:
      '<table><caption>Sessions by entry page, with the paid share of each.</caption>' +
      '<thead><tr><th scope="col">Entry page</th><th scope="col" class="num">Sessions</th>' +
      '<th scope="col" class="num">Paid</th><th scope="col" class="num">Share</th></tr></thead>' +
      `<tbody>${rows}</tbody></table>`,
  })
}

export function renderInteractionPanel(panel: InteractionPanel): string {
  const rows = panel.rows
    .map(
      (row) =>
        `<tr data-interaction="${escapeHtml(`${row.eventName}|${row.path}`)}">` +
        `<th scope="row">${escapeHtml(row.eventName)}</th>` +
        `<td><code>${escapeHtml(row.path)}</code></td>` +
        num(row.events) +
        num(row.sessions) +
        '</tr>',
    )
    .join('')
  return renderPanel({
    id: 'interactions',
    heading: 'Interactions, ranked',
    why:
      'page_view is deliberately absent: it is a navigation rather than an interaction, it is on every ' +
      'row of the event table, and including it would hold the top of this ranking for ever. Volume and ' +
      'reach are both shown — one visitor pressing a call-to-action eleven times is not eleven people.',
    headline: panel.headline,
    basis:
      'Live read of analytics.event for this trading date, crawler sessions excluded. The exclusion is ' +
      'event_name <> page_view rather than a list of four names, so a sixth collected event appears here ' +
      'on the day it is collected.',
    body:
      '<table><caption>Events and the sessions they came from, by event name and path.</caption>' +
      '<thead><tr><th scope="col">Event</th><th scope="col">Path</th>' +
      '<th scope="col" class="num">Events</th><th scope="col" class="num">Sessions</th></tr></thead>' +
      `<tbody>${rows}</tbody></table>`,
  })
}

/**
 * One of the two splits. The id and the wording differ; the shape does not.
 *
 * Two CALLS of one renderer rather than two renderers, and the panel id is a parameter of a closed union
 * so a third caller cannot invent an id the page's own spine does not hold. The BASIS line differs between
 * them and is passed in, because that is the one thing a reader comparing the two needs: the device split
 * is a rollup and survives a raw purge, and the breakpoint split is a live read of rows retention keeps
 * for ninety days.
 */
export function renderSegmentPanel(args: {
  readonly id: 'devices' | 'breakpoints'
  readonly heading: string
  readonly why: string
  readonly basis: string
  readonly columnHeading: string
  readonly panel: SegmentPanel
}): string {
  const rows = args.panel.rows
    .map(
      (row) =>
        `<tr data-segment="${escapeHtml(row.segment)}">` +
        `<th scope="row">${escapeHtml(row.segment)}</th>` +
        num(row.sessions) +
        num(row.paid) +
        shareCell(row.paid, row.sessions) +
        '</tr>',
    )
    .join('')
  return renderPanel({
    id: args.id,
    heading: args.heading,
    why: args.why,
    headline: args.panel.headline,
    basis: args.basis,
    body:
      `<table><caption>Sessions and the paid share, by ${escapeHtml(args.columnHeading.toLowerCase())}.</caption>` +
      `<thead><tr><th scope="col">${escapeHtml(args.columnHeading)}</th>` +
      '<th scope="col" class="num">Sessions</th><th scope="col" class="num">Paid</th>' +
      '<th scope="col" class="num">Share</th></tr></thead>' +
      `<tbody>${rows}</tbody></table>`,
  })
}

/**
 * Revenue by source, joined to paid bookings.
 *
 * Money through `formatAmount`, which is `@berelax/core`'s formatter over the `Money` the query built with
 * `filsFromStoredDigits`. Nothing here divides by 100: a renderer doing its own arithmetic on a money
 * figure is the float ADR 0007 refuses, and the currency is stated once in the column head rather than in
 * every cell — which is `formatAmount`'s own documented reason for existing.
 *
 * NET and VAT are both printed beside gross, because `net + vat = gross` is a CHECK on the table and a
 * reader who can see all three can verify it. A panel showing gross alone would be asking to be trusted
 * about the only arithmetic on the page a tax authority cares about.
 */
export function renderSourceRevenuePanel(panel: SourceRevenuePanel): string {
  const rows = panel.rows
    .map(
      (row) =>
        `<tr data-revenue-source="${escapeHtml(`${row.source}/${row.medium}/${row.campaign}`)}">` +
        `<th scope="row">${escapeHtml(row.source)}</th>` +
        `<td>${escapeHtml(row.medium)}</td>` +
        `<td>${escapeHtml(row.campaign === '' ? '—' : row.campaign)}</td>` +
        num(row.paidInvoices) +
        `<td class="num">${escapeHtml(formatAmount(row.gross))}</td>` +
        `<td class="num">${escapeHtml(formatAmount(row.net))}</td>` +
        `<td class="num">${escapeHtml(formatAmount(row.vat))}</td>` +
        '</tr>',
    )
    .join('')
  return renderPanel({
    id: 'source-revenue',
    heading: 'Revenue by source, joined to paid bookings',
    why:
      'Settled invoices joined to the session their booking was attributed to. This is money that ' +
      'arrived, not a conversion a platform counted — and it is a different question from whether a ' +
      'conversion was successfully pushed to that platform, which is the dispatch reconciliation panel.',
    headline: panel.headline,
    basis:
      'analytics.daily_source_revenue. Integer fils throughout, gross VAT-inclusive and authoritative, ' +
      'with VAT derived as gross − net so net + VAT = gross exactly (ADR 0007).',
    body:
      '<table><caption>Paid invoices and the money they brought, by origination. Figures in AED.</caption>' +
      '<thead><tr><th scope="col">Source</th><th scope="col">Medium</th><th scope="col">Campaign</th>' +
      '<th scope="col" class="num">Paid invoices</th><th scope="col" class="num">Gross</th>' +
      '<th scope="col" class="num">Net</th><th scope="col" class="num">VAT</th></tr></thead>' +
      `<tbody>${rows}</tbody></table>`,
  })
}
