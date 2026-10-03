import {
  type DispatchReconciliation,
  escapeHtml,
  isUnreconciled,
  UNRECONCILED,
  UNRECONCILED_PANEL_SENTENCE,
} from '@berelax/core'

/**
 * Revenue by source, and the state it has to be able to refuse to render (A-MEAS-07).
 *
 * ## Why this is markup and not a `.tsx` component
 *
 * The reason the till, the diary, the Messages inbox, the compliance calendar and the re-auth banner all
 * record: `apps/web/src/routes/registry.ts` is in exact bijection with the filesystem and requires every
 * *document* to be served in both locales, so an admin screen is a route handler returning bytes and the
 * things on it are functions returning bytes. A `page.tsx` here would need an Arabic admin document and
 * the W-SYS-01 shell. A-MEAS-07's manifest entry names this file `.tsx`; it is `.ts` because that is what
 * every other admin panel in this repository is, and the deviation is recorded as a NOTE on the entry.
 *
 * There is no analytics admin DOCUMENT yet — nothing under `app/(admin)/analytics` serves a route — so
 * this panel is a function the screen that arrives will call, and `revenue-by-source-render.test.ts`
 * asserts its bytes without a server. That is also why it takes a view rather than reading anything: pure
 * in, bytes out, so two renders of one view are byte-identical.
 *
 * ## The one thing this panel exists to do
 *
 * **When the day is unreconciled it renders no figure at all.** Not a figure with a warning beside it, not
 * a figure in amber, not a figure with an asterisk: no figure. The acceptance line is *"the panel renders
 * an explicit unreconciled state and the API returns `Unreconciled` rather than a number"*, and the reason
 * is ADR 0002's: a report that cannot distinguish "no conversions" from "conversions we failed to
 * attribute" is worse than no report. A figure beside a warning is read as a figure.
 *
 * The TYPE is what makes that hold rather than care. `DispatchReconciliation` is a discriminated union
 * whose `unreconciled` variant carries no revenue figure, so there is nothing for this renderer to
 * interpolate even if somebody wanted to — which is why the union is shaped that way in `@berelax/core`
 * rather than being a nullable number.
 */

/** The panel's own styles. Tokens only: `pnpm colours` refuses a literal hex outside the token layer. */
export const REVENUE_BY_SOURCE_CSS = `
.revenue-by-source { display: grid; gap: var(--space-3); }
.revenue-by-source__destination {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  background: var(--color-surface);
}
.revenue-by-source__state { font: var(--type-label); text-transform: uppercase; letter-spacing: 0.08em; }
.revenue-by-source__destination[data-state='unreconciled'] { border-color: var(--color-warning-border); }
.revenue-by-source__destination[data-state='unreconciled'] .revenue-by-source__state {
  color: var(--color-warning-text);
}
.revenue-by-source__figure { font: var(--type-display-sm); }
.revenue-by-source__differences { margin: var(--space-2) 0 0; padding-inline-start: var(--space-4); }
.revenue-by-source__counts { font: var(--type-body-sm); color: var(--color-text-muted); }
`

/**
 * What this panel is told about one destination.
 *
 * The reconciliation itself, plus the two-decimal figure for the RECONCILED case only. The figure is
 * formatted by the caller through `conversionValueFromFils`, because money formatting is
 * `@berelax/core`'s and a renderer dividing by 100 is the float this build refuses (ADR 0007).
 */
export interface RevenueBySourceEntry {
  readonly reconciliation: DispatchReconciliation
  /**
   * The figure, already formatted, for a reconciled destination. Absent for an unreconciled one.
   *
   * `exactOptionalPropertyTypes` is on, so this is genuinely absent rather than present and `undefined` —
   * and that is the point: a caller cannot hand this panel a figure for an unreconciled day without the
   * compiler refusing it.
   */
  readonly figure?: string
}

export interface RevenueBySourceView {
  readonly businessDay: string
  readonly entries: readonly RevenueBySourceEntry[]
}

/**
 * What the API answers for one destination: a figure, or the word.
 *
 * `Unreconciled` is a VALUE and not a formatted string, so a caller that serialises it cannot accidentally
 * produce `"NaN"` or `"0.00"` for a day whose figures disagree. Asserted at this layer as well as in the
 * markup, which is the acceptance line's *"asserted at both layers"*.
 */
export function revenueBySourceApiValue(entry: RevenueBySourceEntry): string {
  if (isUnreconciled(entry.reconciliation)) return UNRECONCILED
  if (entry.figure === undefined) {
    /*
     * A reconciled destination with no figure is a caller that forgot one, and the honest answer is the
     * same word rather than a zero: `0.00` is a real figure and would read as "this source produced no
     * revenue", which is the exact confusion ADR 0002 is about.
     */
    return UNRECONCILED
  }
  return entry.figure
}

/** One destination's block. `data-state` is what a stylesheet and a screenshot both key off. */
function renderEntry(entry: RevenueBySourceEntry): string {
  const result = entry.reconciliation
  const destination = escapeHtml(result.destination)
  const counts = isUnreconciled(result) ? result.counts : result
  const countLine = escapeHtml(
    `${counts.internalCount} recorded, ${counts.pushedCount} pushed, ` +
      `${counts.intentionallyNotPushedCount} not pushed by consent`,
  )

  if (!isUnreconciled(result)) {
    return [
      `<section class="revenue-by-source__destination" data-state="reconciled" data-destination="${destination}">`,
      `<h3>${destination}</h3>`,
      '<p class="revenue-by-source__state">Reconciled</p>',
      `<p class="revenue-by-source__figure">${escapeHtml(revenueBySourceApiValue(entry))}</p>`,
      `<p class="revenue-by-source__counts">${countLine}</p>`,
      '</section>',
    ].join('')
  }

  /*
   * The unreconciled block. No figure element at all, which is stronger than an empty one: a stylesheet
   * cannot reveal a number that was never written, and a screenshot cannot show one.
   */
  const differences = result.differences
    .filter((difference) => difference.kind !== 'intentionally_not_pushed')
    .map(
      (difference) =>
        `<li data-kind="${escapeHtml(difference.kind)}">${escapeHtml(difference.kind)}: ${escapeHtml(difference.eventId)}</li>`,
    )
  const unexplained = result.pushedWithoutInternalTruth.map(
    (eventId) =>
      `<li data-kind="pushed_without_internal_truth">pushed with no record: ${escapeHtml(eventId)}</li>`,
  )
  return [
    `<section class="revenue-by-source__destination" data-state="unreconciled" data-destination="${destination}">`,
    `<h3>${destination}</h3>`,
    `<p class="revenue-by-source__state">${escapeHtml(UNRECONCILED)}</p>`,
    `<p>${escapeHtml(UNRECONCILED_PANEL_SENTENCE)}</p>`,
    `<ul class="revenue-by-source__differences">${[...differences, ...unexplained].join('')}</ul>`,
    `<p class="revenue-by-source__counts">${countLine}</p>`,
    '</section>',
  ].join('')
}

/**
 * The panel.
 *
 * Every destination is rendered, including a reconciled one beside an unreconciled one, because the
 * acceptance line is about a PANEL and the failure being prevented is a screen that shows the destination
 * whose figures agree and quietly omits the one whose figures do not.
 */
export function renderRevenueBySource(view: RevenueBySourceView): string {
  return [
    `<div class="revenue-by-source" data-business-day="${escapeHtml(view.businessDay)}">`,
    ...view.entries.map(renderEntry),
    '</div>',
  ].join('')
}
