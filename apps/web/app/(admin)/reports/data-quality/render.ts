import { type DataQualityState, safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import { KPI_TILE_CSS, type KpiTileProps, renderKpiTile } from '@berelax/ui/reporting'
import {
  ADMIN_BANNER_CSS,
  type AdminChrome,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/**
 * The data-quality screen (R-REP-07): every registered check, its last run, and the rows behind a
 * failure.
 *
 * Pure: a view in, a document out, no database and no clock. The view carries the instant it was read
 * at and the page prints it, so two runs over the same window produce the same bytes — which a
 * screenshot diff needs and which "as of now" cannot give.
 *
 * ## What the page is FOR, which decides its shape
 *
 * It answers one question — *may I believe the numbers on the other screens today* — and it answers it
 * per check rather than as a verdict. A single green tick over seven checks would be read as a
 * guarantee, and the one state this page exists to make visible is the one where nothing has been
 * checked at all.
 *
 * So three things follow:
 *
 *   * **A check that has never run reads `unknown`, never `pass`.** The acceptance line, and it is a
 *     property of {@link DataQualityState} rather than of this renderer: `judgeDataQualityReading`
 *     answers `unknown` for a reading with no observation, and there is no branch here that turns an
 *     absent figure into a tick.
 *   * **A failing check names its two sides and its variance**, because "these two figures differ by
 *     one fils" is a sentence somebody can act on and "the revenue check failed" is not — the same
 *     argument the month reconciliation's own page makes about a variance versus a total.
 *   * **The tiles are on this page too.** A screen that listed the checks without showing what they
 *     refuse would let a reader believe the failure was confined to this page. The tiles are rendered
 *     from `@berelax/ui/reporting` with the same gated figures the API serves, so the rendered layer
 *     and the API cannot disagree.
 *
 * ## Why a route handler and not a `page.tsx`
 *
 * `apps/web/src/routes/registry.ts` requires every *document* to be served in both locales, so a
 * `page.tsx` here would need an Arabic admin document and the W-SYS-01 shell. The month
 * reconciliation, the compliance calendar, the Messages inbox and the five HR screens are the
 * precedent, and this surface is English-only for the same reason: it is an operator's working paper.
 */

/** One check as the page lists it. Every figure is a decimal STRING: a `number` would round fils. */
export interface DataQualityCheckView {
  readonly checkId: string
  readonly label: string
  readonly summary: string
  readonly state: DataQualityState
  readonly measure: string
  readonly relation: string
  /** `null` when no pass has produced a reading. Printed as "never" rather than left blank. */
  readonly lastRanAtIso: string | null
  readonly observed: {
    readonly leftLabel: string
    readonly leftValue: string
    readonly rightLabel: string
    readonly rightValue: string
    readonly variance: string
    readonly offendingRows: number
  } | null
  readonly detail: string
  /** The subjects this check attests, so a reader can see which figures it gates. */
  readonly attests: readonly string[]
  /** The rows behind a failure, already paged. Empty for a passing or unknown check. */
  readonly drillDown: readonly {
    readonly subject: string
    readonly figure: string
    readonly detail: string
  }[]
  readonly drillDownRelation: string
  readonly drillDownPredicate: string
}

export interface DataQualityView {
  readonly chrome: AdminChrome
  readonly windowFrom: string
  readonly windowTo: string
  readonly asOfIso: string
  readonly checks: readonly DataQualityCheckView[]
  /** The gated tiles, so the page shows what the checks refuse rather than only that they refused. */
  readonly tiles: readonly KpiTileProps[]
  /** The staleness window in minutes, printed so the amber rows can be read against it. */
  readonly staleAfterMinutes: number
}

/** How each state reads. A total map, so a state added to the union fails `pnpm typecheck` here. */
const STATE_WORD: Readonly<Record<DataQualityState, string>> = Object.freeze({
  unknown: 'Unknown — never run',
  pass: 'Holds',
  fail: 'Does not hold',
  stale: 'Stale',
})

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
  .dq-window { color: var(--color-ink-2); margin: 0 0 var(--space-5); }
  .dq-tiles { display: grid; gap: var(--space-4); margin: 0 0 var(--space-6); }
  .dq-check {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-4) var(--space-5);
    margin: 0 0 var(--space-4);
  }
  .dq-check[data-dq-state="fail"] {
    border-color: var(--color-danger);
    border-inline-start-width: var(--space-2);
  }
  .dq-check[data-dq-state="unknown"],
  .dq-check[data-dq-state="stale"] {
    border-color: var(--color-border-strong);
    border-inline-start-width: var(--space-2);
  }
  .dq-check h3 { margin: 0 0 var(--space-2); font-size: 1.0625rem; }
  .dq-state { font-size: 0.875rem; color: var(--color-ink-2); margin: 0 0 var(--space-2); }
  .dq-sides { margin: 0 0 var(--space-2); padding-inline-start: var(--space-5); }
  .dq-rows { border-collapse: collapse; width: 100%; font-size: 0.875rem; }
  .dq-rows th, .dq-rows td {
    text-align: start;
    border-bottom: 1px solid var(--color-hairline);
    padding: var(--space-2) var(--space-3);
  }
  .dq-attests { font-size: 0.875rem; color: var(--color-ink-3); margin: var(--space-2) 0 0; }
`

const sides = (check: DataQualityCheckView): string => {
  if (check.observed === null) {
    // No branch here produces a figure. An "unknown" check has nothing to compare, and printing a zero
    // for each side would make it indistinguishable from two sides that agreed at zero.
    return (
      '<p class="dq-state">No pass has produced a reading, so there is nothing to compare. This is ' +
      'not the same claim as a check that agreed.</p>'
    )
  }
  return (
    '<ul class="dq-sides">' +
    `<li>${safeText(check.observed.leftLabel)}: <strong>${safeText(check.observed.leftValue)}</strong> ` +
    `${safeText(check.measure)}</li>` +
    `<li>${safeText(check.observed.rightLabel)}: <strong>${safeText(check.observed.rightValue)}</strong> ` +
    `${safeText(check.measure)}</li>` +
    `<li>Variance: <strong>${safeText(check.observed.variance)}</strong> ${safeText(check.measure)} ` +
    `over ${check.observed.offendingRows} row(s)</li>` +
    '</ul>'
  )
}

const drillDown = (check: DataQualityCheckView): string => {
  if (check.drillDown.length === 0) {
    return (
      `<p class="dq-attests">Drill-down: ${safeText(check.drillDownRelation)} — ` +
      `${safeText(check.drillDownPredicate)}. No rows to list.</p>`
    )
  }
  return (
    `<p class="dq-attests">${safeText(check.drillDownRelation)} — ` +
    `${safeText(check.drillDownPredicate)}:</p>` +
    '<table class="dq-rows"><thead><tr><th>Row</th><th>Figure</th><th>Why</th></tr></thead><tbody>' +
    check.drillDown
      .map(
        (row) =>
          `<tr><td><code>${safeText(row.subject)}</code></td><td>${safeText(row.figure)}</td>` +
          `<td>${safeText(row.detail)}</td></tr>`,
      )
      .join('') +
    '</tbody></table>'
  )
}

export function renderDataQualityHtml(view: DataQualityView): string {
  const failing = view.checks.filter((check) => check.state === 'fail')
  const unknown = view.checks.filter((check) => check.state === 'unknown')
  const stale = view.checks.filter((check) => check.state === 'stale')
  // Three counts and not one, for the month reconciliation's reason: "the arithmetic disagrees",
  // "nobody has checked" and "this is yesterday's answer" have three different remedies, and a screen
  // that added them up would show one red number that nobody could act on.
  const headline =
    `<p class="dq-window"><strong>${failing.length}</strong> check(s) do not hold, ` +
    `<strong>${unknown.length}</strong> have never run and <strong>${stale.length}</strong> are stale, ` +
    `of ${view.checks.length} registered. A view is stale after ${view.staleAfterMinutes} minutes.</p>`

  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<title>Data quality — admin</title>',
    `<style>${tokensCss()}${CSS}${KPI_TILE_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Data quality</h1>',
    `<p class="dq-window">Trading dates <strong>${safeText(view.windowFrom)}</strong> to ` +
      `<strong>${safeText(view.windowTo)}</strong>, read as at <strong>${safeText(view.asOfIso)}</strong>.</p>`,
    headline,
    '<h2>What the checks refuse</h2>',
    '<div class="dq-tiles">',
    ...view.tiles.map((tile) => renderKpiTile(tile)),
    '</div>',
    '<h2>Every registered check</h2>',
    ...view.checks.map((check) =>
      [
        `<section class="dq-check" data-dq-state="${check.state}" data-dq-check="${safeText(check.checkId)}">`,
        `<h3>${safeText(check.label)}</h3>`,
        `<p class="dq-state">${safeText(STATE_WORD[check.state])} · last run ` +
          `${check.lastRanAtIso === null ? 'never' : safeText(check.lastRanAtIso)} · ` +
          `${safeText(check.relation)} in ${safeText(check.measure)}</p>`,
        `<p>${safeText(check.summary)}</p>`,
        sides(check),
        `<p>${safeText(check.detail)}</p>`,
        drillDown(check),
        `<p class="dq-attests">Gates: ${check.attests.map((a) => safeText(a)).join(', ')}</p>`,
        '</section>',
      ].join(''),
    ),
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
