import { escapeHtml } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  ADMIN_BANNER_CSS,
  type AdminChrome,
  renderAdminBanner,
} from '../../../src/components/admin/google-reauth-banner.ts'
import { DATA_QUALITY_CSS, renderDataQualityPanel } from './panels/data-quality.ts'
import { renderFunnelPanel } from './panels/funnel.ts'
import { PANEL_CSS } from './panels/panel.ts'
import {
  renderInteractionPanel,
  renderLandingPagePanel,
  renderOriginationPanel,
  renderSegmentPanel,
  renderSourceRevenuePanel,
} from './panels/tables.ts'
import { renderTimeOfDayPanel, TIME_OF_DAY_CSS } from './panels/time-of-day.ts'
import { ANALYTICS_PANEL_IDS, type AnalyticsPageData } from './queries.ts'

/**
 * The /analytics document (A-FIRST-10): nine panels, one trading date, no client JavaScript.
 *
 * Pure: data in, bytes out, no database and no clock. That is what lets the screenshot matrix render it
 * twelve times — three viewports × two themes × two directions — with `page.setContent` and no server, and
 * it is why "zero pixel diff on a second run" is a property of the bytes rather than of the harness.
 *
 * ## Why the nine panels are a LIST and the count is derived
 *
 * `ANALYTICS_PANEL_IDS` in `./queries.ts` is the spine, and {@link renderAnalyticsPageHtml} renders one
 * panel per id in that order. The acceptance line is *"all nine panels render"*, and the only way that is
 * a check rather than a number in a test is for the page and the test to count the same list: the suite
 * asserts `ANALYTICS_PANEL_IDS.length` sections with `[data-panel]` and that the ids match, so a tenth
 * panel added to the spine and not to this renderer fails by name rather than being quietly absent.
 *
 * ## Why the re-auth banner and the send-backlog banner are both here
 *
 * One call to `renderAdminBanner` emits both, immediately after `<main>`, and
 * `apps/web/src/google-reauth-banner.test.ts` walks every admin document on disk and fails by name if one
 * of them does not make it. There is no exemption list to join. The banner comes INSIDE `<main>` because a
 * region outside every landmark is reachable by a screen reader only through "all content", which for a
 * warning is not good enough.
 *
 * ## Why the trading date is in the heading and in an attribute
 *
 * The page answers for one trading date and has no default (see `route.ts`), so the date is the subject of
 * every figure on it. In the heading because a screenshot of this page has to be readable on its own, and
 * in `data-trading-date` because the suite's comparison has to be able to prove it read the day it asked
 * for — a page that silently answered for today would pass every figure comparison against today's rows.
 */

export interface AnalyticsPageView {
  /**
   * The Google re-auth banner, the send-backlog banner and the page a reconnect comes back to.
   *
   * Required rather than optional, for the reason `AdminChrome` itself gives: an optional field would be a
   * permissive default, and the default would be the state the banners exist to make impossible — an admin
   * page that says nothing while the Google grant is dead or the send queue is backed up.
   */
  readonly chrome: AdminChrome
  readonly data: AnalyticsPageData
  /**
   * The writing direction, from `?dir=rtl` — the arrangement the till, the cash-up sheet and the
   * quick-book screen all use.
   *
   * `lang` stays `en`: there is no Arabic admin document (`locales: []` in the registry), and an admin
   * screen claiming `lang="ar"` while its text is English is a claim a screen reader acts on. What the
   * RTL cell of the screenshot matrix is for is the LAYOUT — every rule on this page is written with
   * `padding-inline`, `border-inline-start` and `text-align: start`, and the only way to find a `left`
   * that crept in is to render it mirrored and look.
   */
  readonly direction: 'ltr' | 'rtl'
}

const PAGE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 72rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  .lede {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  .lede p { margin: 0 0 var(--space-3); }
  .lede p:last-child { margin-bottom: 0; }
`

/**
 * One panel per id in the spine, in the spine's order.
 *
 * A `Record<AnalyticsPanelId, () => string>` and not a sequence of calls, so a panel id with no renderer
 * does not typecheck and a renderer for an id the spine does not declare does not either. That is the same
 * arrangement `ALERT_OBSERVERS` uses one package over and for the same reason: the list is what the page
 * READS rather than a description beside it.
 */
function panelRenderers(
  data: AnalyticsPageData,
): Record<(typeof ANALYTICS_PANEL_IDS)[number], string> {
  return {
    funnel: renderFunnelPanel(data.funnel),
    origination: renderOriginationPanel(data.origination),
    'landing-pages': renderLandingPagePanel(data.landingPages),
    interactions: renderInteractionPanel(data.interactions),
    devices: renderSegmentPanel({
      id: 'devices',
      heading: 'Device split',
      why:
        'Sessions and the paid share by the device kind the classifier recorded. The figure a redesign ' +
        'is judged on: a phone share that converts at half the desktop rate is a layout problem and not ' +
        'a traffic problem.',
      basis:
        'analytics.daily_traffic, which carries device_kind in its primary key — so this survives the ' +
        '90-day raw purge. The paid count is a live read of the funnel steps.',
      columnHeading: 'Device',
      panel: data.devices,
    }),
    breakpoints: renderSegmentPanel({
      id: 'breakpoints',
      heading: 'Breakpoint split',
      why:
        'The CSS breakpoint the session was actually laid out at, which is not the same question as the ' +
        'device kind: a tablet in landscape and a small laptop get the same breakpoint and different ' +
        'device kinds, and it is the breakpoint that decides what the visitor saw.',
      basis:
        'Live read of analytics.session.breakpoint. There is no breakpoint rollup, so unlike the device ' +
        'split this figure is recomputed from rows retention keeps for 90 days rather than from a rollup ' +
        'kept indefinitely.',
      columnHeading: 'Breakpoint',
      panel: data.breakpoints,
    }),
    'time-of-day': renderTimeOfDayPanel(data.timeOfDay),
    'source-revenue': renderSourceRevenuePanel(data.sourceRevenue),
    'data-quality': renderDataQualityPanel(data.dataQuality),
  }
}

export function renderAnalyticsPageHtml(view: AnalyticsPageView): string {
  const panels = panelRenderers(view.data)
  return [
    '<!doctype html>',
    `<html lang="en" dir="${view.direction}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Stated on the document as well as in the `x-robots-tag` the registry's /analytics prefix produces.
    // Two statements of one policy, and they are held equal by `registry.test.ts` reading the prefix list
    // rather than by this file being right.
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    `<title>First-party funnel — ${escapeHtml(view.data.tradingDate)} — admin</title>`,
    `<style>${tokensCss()}${PAGE_CSS}${PANEL_CSS}${TIME_OF_DAY_CSS}${DATA_QUALITY_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    `<body data-trading-date="${escapeHtml(view.data.tradingDate)}">`,
    '<main>',
    renderAdminBanner(view.chrome),
    `<h1>First-party funnel — trading date ${escapeHtml(view.data.tradingDate)}</h1>`,
    '<div class="lede">',
    '<p>Every figure here is this build’s own measurement, taken from the first-party collector and the ' +
      'ledger. Nothing on this page comes from an advertising platform, and the two do not agree: a ' +
      'platform counts a form submission and this counts an invoice settled in full.</p>',
    '<p>The page answers for <strong>one trading date</strong>, which runs 11:00 to 02:00 — so 01:30 ' +
      'belongs to the previous date. A share with no denominator reads <em>no data</em> and never 0%: a ' +
      'rate of nought on a day nobody visited reports a failure that did not happen.</p>',
    '</div>',
    ...ANALYTICS_PANEL_IDS.map((id) => panels[id]),
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
