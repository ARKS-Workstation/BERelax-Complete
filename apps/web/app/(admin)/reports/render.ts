import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import { KPI_TILE_CSS, renderKpiTile } from '@berelax/ui/reporting'
import {
  ADMIN_BANNER_CSS,
  renderAdminBanner,
} from '../../../src/components/admin/google-reauth-banner.ts'
import type { DashboardView } from './view.ts'

/**
 * The role-scoped dashboard, as HTML (R-REP-08).
 *
 * Pure: a payload in, a document out, no database and no clock. The payload carries the window and the
 * instant it was read at and the page prints both, so two runs over the same window produce the same
 * bytes — which the screenshot matrix needs and which "as of now" cannot give.
 *
 * ## Three things the markup has to make checkable
 *
 *   * **Which dashboard this is**, as `data-dashboard` on `<main>`'s wrapper. A role-scoped screen whose
 *     scope is only visible in its figures cannot be asserted at all.
 *   * **The time-of-day chart as BUCKETS**, each one an element with `data-bucket-hour`, in document
 *     order. The acceptance line is "15 contiguous buckets in business-day order", and document order
 *     is the only place that claim lives once the figures are drawn — so an hour with no deliveries is
 *     an EMPTY bucket rather than an absent one, which is the difference between "nobody came at 15:00"
 *     and "15:00 is not a trading hour".
 *   * **The drill-down total beside the tile's figure.** The M5 gate is an identity between two
 *     numbers, and printing both is what lets a reader check it without a test.
 *
 * ## Why a route handler and not a `page.tsx`
 *
 * `apps/web/src/routes/registry.ts` requires every *document* to be served in both locales, so a
 * `page.tsx` here would need an Arabic admin document and the W-SYS-01 shell. The month reconciliation,
 * the compliance calendar, the Messages inbox, the five HR screens and R-REP-07's data-quality page are
 * the precedent. `?dir=rtl` re-renders this English document mirrored, so the direction half of the
 * accessibility matrix is audited without inventing an Arabic admin surface.
 */

const CSS = `
  body {
    background: var(--color-ground);
    color: var(--color-ink);
    font-family: var(--font-body, system-ui), system-ui, sans-serif;
    margin: 0;
  }
  main { max-width: 76ch; margin: 0 auto; padding: var(--space-6) var(--space-5); }
  h1 { font-size: 1.5rem; margin: 0 0 var(--space-4); }
  h2 { font-size: 1.25rem; margin: var(--space-6) 0 var(--space-3); }
  .dash-window { color: var(--color-ink-2); margin: 0 0 var(--space-5); }
  .dash-tiles { display: grid; gap: var(--space-4); margin: 0 0 var(--space-6); }
  .dash-buckets {
    display: flex;
    gap: var(--space-2);
    align-items: flex-end;
    margin: 0 0 var(--space-5);
    padding: 0;
    list-style: none;
  }
  .dash-bucket { flex: 1 1 0; text-align: center; font-size: 0.875rem; }
  .dash-bucket-bar {
    display: block;
    background: var(--color-accent-teal);
    border-radius: var(--radius-1, 2px);
    margin: 0 auto var(--space-2);
    width: 100%;
  }
  .dash-bucket[data-bucket-empty="true"] .dash-bucket-bar {
    background: var(--color-surface-clay);
  }
  .dash-rows { border-collapse: collapse; width: 100%; font-size: 0.875rem; }
  .dash-rows th, .dash-rows td {
    text-align: start;
    border-bottom: 1px solid var(--color-hairline);
    padding: var(--space-2) var(--space-3);
  }
  .dash-identity {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-3) var(--space-4);
    margin: 0 0 var(--space-4);
  }
  .dash-note { font-size: 0.875rem; color: var(--color-ink-3); }
`

/**
 * The bars, one per bucket, in business-day order.
 *
 * The height is a share of the busiest bucket and is capped at a pixel figure so the chart cannot grow
 * without bound; a bucket with nothing in it still renders, at a floor height, carrying
 * `data-bucket-empty`. A chart that omitted the empty hours would be contiguous by accident on a busy
 * day and wrong on a quiet one.
 */
function buckets(view: DashboardView): string {
  if (view.buckets.length === 0) {
    return (
      '<p class="dash-note">No trading day in this window has hours on file, so there is no window to ' +
      'bucket. That is not a day with no deliveries: a date the premises did not trade has no row in ' +
      'business_day at all.</p>'
    )
  }
  const byHour = new Map(view.timeOfDay.map((row) => [row.startHour, row]))
  const busiest = Math.max(1, ...view.timeOfDay.map((row) => row.delivered))
  return (
    `<ul class="dash-buckets" data-bucket-count="${view.buckets.length}" ` +
    `data-buckets-contiguous="${view.bucketsAreContiguous}">` +
    view.buckets
      .map((bucket) => {
        const row = byHour.get(bucket.startHour)
        const delivered = row?.delivered ?? 0
        const height = delivered === 0 ? 4 : Math.max(4, Math.round((delivered / busiest) * 80))
        return (
          `<li class="dash-bucket" data-bucket-hour="${bucket.startHour}" ` +
          `data-bucket-index="${bucket.index}" data-bucket-empty="${delivered === 0}">` +
          `<span class="dash-bucket-bar" style="height:${height}px" aria-hidden="true"></span>` +
          `<span class="dash-bucket-label">${safeText(bucket.label)}</span>` +
          `<span class="dash-bucket-count"> ${delivered}</span>` +
          '</li>'
        )
      })
      .join('') +
    '</ul>'
  )
}

function drillDown(view: DashboardView): string {
  if (view.drillDown === null) {
    return (
      '<p class="dash-note">Press a tile’s drill-down to list the rows behind it. Every headline ' +
      'figure here is a fold over rows, and the rows add up to it exactly.</p>'
    )
  }
  const tile = view.tiles.find((entry) => entry.tileId === view.drillDown?.tileId)
  const figure = tile?.figure.state === 'value' ? tile.figure.value : null
  return (
    '<div class="dash-identity">' +
    `<p><strong>${safeText(view.drillDown.rows.length.toString())}</strong> row(s), each one ` +
    `${safeText(view.drillDown.rowGrain)}.</p>` +
    `<p>They add up to <strong data-drill-aggregate="${safeText(view.drillDown.aggregate)}">` +
    `${safeText(view.drillDown.aggregate)}</strong>, and the tile reads ` +
    `<strong>${safeText(figure ?? 'a refusal')}</strong>. The M5 gate is that those two agree exactly.</p>` +
    '</div>' +
    '<table class="dash-rows"><thead><tr>' +
    view.columns.map((column) => `<th>${safeText(column)}</th>`).join('') +
    '</tr></thead><tbody>' +
    view.drillDown.rows
      .map(
        (row) =>
          '<tr>' +
          view.columns
            .map((column) => {
              const value = (row as Readonly<Record<string, unknown>>)[camel(column)]
              return `<td>${value === undefined ? '' : safeText(String(value))}</td>`
            })
            .join('') +
          '</tr>',
      )
      .join('') +
    '</tbody></table>'
  )
}

/** `business_day` to `businessDay`. One place, so the header and the cell cannot disagree. */
const camel = (column: string): string =>
  column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())

export function renderDashboardHtml(view: DashboardView): string {
  const scope =
    view.scope.kind === 'business'
      ? 'the whole business'
      : 'your own appointments and roster only — every figure here is restricted in the query'
  return [
    '<!doctype html>',
    `<html lang="en" dir="${view.direction}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<title>Reports — admin</title>',
    `<style>${tokensCss()}${CSS}${KPI_TILE_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    `<div data-dashboard="${safeText(view.dashboard)}" data-scope="${safeText(view.scope.kind)}">`,
    '<h1>Reports</h1>',
    `<p class="dash-window">Trading dates <strong>${safeText(view.window.from)}</strong> to ` +
      `<strong>${safeText(view.window.to)}</strong>, read as at <strong>${safeText(view.asOfIso)}</strong>. ` +
      `This dashboard covers ${scope}.</p>`,
    '<h2>Headline figures</h2>',
    '<div class="dash-tiles">',
    ...view.tiles.map((tile) =>
      renderKpiTile({
        kpiId: tile.tileId,
        label: tile.label,
        formula: tile.measureId,
        unit: tile.tileId === 'net_revenue' ? 'fils' : 'minutes',
        figure: tile.figure,
        drillDownHref: `/reports?from=${view.window.from}&to=${view.window.to}&tile=${tile.tileId}`,
      }),
    ),
    '</div>',
    '<h2>Time of day</h2>',
    `<p class="dash-note">The trading window as ${view.buckets.length} contiguous hour bucket(s), in ` +
      'business-day order: trading runs past midnight, so 00:00 and 01:00 come last rather than first.</p>',
    buckets(view),
    '<h2>The rows behind a figure</h2>',
    drillDown(view),
    `<p class="dash-note">Rooms are counted as they are in service TODAY (${view.provenance.roomsCounted} ` +
      'bookable): rooms.is_bookable is current state with no history, so a room taken out of service ' +
      'today is absent from a denominator for a month it was in service for.</p>',
    '</div>',
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
