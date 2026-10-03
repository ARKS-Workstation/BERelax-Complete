import { escapeHtml } from '@berelax/core'
import type { AnalyticsPanelId, PanelHeadline } from '../queries.ts'

/**
 * The shared panel furniture: the section wrapper, the headline, and the CSS all nine panels use.
 *
 * ## Why the headline is an ATTRIBUTE as well as text
 *
 * `data-headline` carries the figure as a plain integer, and `data-headline-state` says which of the three
 * kinds it is. That pair is what makes the acceptance line *"each headline number equals the value returned
 * by its own query, compared programmatically"* a check: the suite parses the attribute and compares it
 * against the number its own call to the panel's query function produced. Comparing the TEXT instead would
 * compare a formatted string — "41.3%" against 413 per mille — so the test would either reimplement the
 * formatting or assert something weaker than the figure.
 *
 * A `no_data` panel carries NO `data-headline` attribute at all. Not an empty one and not a zero: the
 * attribute's absence is what a test can assert, and a `data-headline="0"` for a day nothing was measured
 * on is exactly the zero ADR 0002 refuses. The reason is rendered as text beside it, because a reader
 * looking at a gap needs the reason and not the gap.
 *
 * ## Why this is markup rather than a `.tsx` component
 *
 * The reason the till, the diary, the Messages inbox, the compliance calendar, A-MEAS-07's revenue panel
 * and the re-auth banner all record: `apps/web/src/routes/registry.ts` is in exact bijection with the
 * filesystem and requires every DOCUMENT to be served in both locales, so an admin screen is a route
 * handler returning bytes and the things on it are functions returning bytes. A-FIRST-10's manifest entry
 * names these files `.tsx`; they are `.ts` because that is what every other admin panel in this repository
 * is, and the deviation is recorded as a NOTE on the entry.
 */

/** Tokens only; `pnpm colours` refuses a literal hex outside the token layer. */
export const PANEL_CSS = `
  .panel {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-6);
  }
  .panel > h2 { font-size: 1.125rem; margin: 0 0 var(--space-2); }
  .panel__why { color: var(--color-ink-2); font-size: 0.875rem; margin: 0 0 var(--space-4); }
  .panel__headline {
    font-size: 1.75rem;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
    margin: 0 0 var(--space-2);
  }
  .panel__basis { color: var(--color-ink-2); font-size: 0.875rem; margin: 0 0 var(--space-4); }
  .panel__nodata {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-inline-start-color: var(--color-accent-gold);
    border-radius: var(--radius-2);
    background: var(--color-ground);
    padding: var(--space-3) var(--space-4);
    margin: 0 0 var(--space-4);
  }
  .panel table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  .panel caption { text-align: start; color: var(--color-ink-2); font-size: 0.875rem; padding-bottom: var(--space-2); }
  .panel th, .panel td {
    text-align: start;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-hairline);
  }
  .panel td.num, .panel th.num { text-align: end; }
  .panel tbody tr:last-child td { border-bottom: 0; }
  @media (max-width: 40rem) {
    .panel { padding: var(--space-4); }
    .panel table { font-size: 0.875rem; }
  }
`

/**
 * The figure, as text a reader can check against the two integers it came from.
 *
 * A per-mille rate is printed to one decimal place AND with its numerator and denominator, which is the
 * data-quality strip's acceptance line generalised to every rate on the page: a share with no denominator
 * is not checkable, and a reader who can see 24 of 1,031 does not have to trust the 2.3%.
 */
export function headlineText(headline: PanelHeadline): string {
  if (headline.kind === 'no_data') return 'no data'
  if (headline.kind === 'count') return `${headline.value.toLocaleString('en-AE')} ${headline.unit}`
  const whole = Math.floor(headline.perMille / 10)
  const tenth = headline.perMille % 10
  return (
    `${whole}.${tenth}% — ${headline.numerator.toLocaleString('en-AE')} of ` +
    `${headline.denominator.toLocaleString('en-AE')}`
  )
}

/** The integer a test compares, or null for a panel with no figure. */
export function headlineValue(headline: PanelHeadline): number | null {
  if (headline.kind === 'no_data') return null
  return headline.kind === 'count' ? headline.value : headline.perMille
}

/**
 * One panel: the landmark, the heading, the headline and whatever the panel itself renders.
 *
 * `<section aria-labelledby>` rather than a bare `<div>`, so each panel is a region a screen reader can
 * jump between — nine unlabelled sections on one page is the axe violation this page would otherwise have,
 * and "zero serious or critical violations" is an acceptance line.
 */
export function renderPanel(args: {
  readonly id: AnalyticsPanelId
  readonly heading: string
  /** One sentence saying what the figure measures. Not decoration: see `basis`. */
  readonly why: string
  readonly headline: PanelHeadline
  /** Where the figure comes from — a rollup, or a live read. The two age differently. */
  readonly basis: string
  readonly body: string
}): string {
  const value = headlineValue(args.headline)
  const headingId = `panel-${args.id}-heading`
  const attributes = [
    `class="panel"`,
    `data-panel="${escapeHtml(args.id)}"`,
    `data-headline-state="${args.headline.kind === 'no_data' ? 'no-data' : args.headline.kind}"`,
    // Absent for a no-data panel, deliberately. See the header: a zero here is the figure ADR 0002
    // refuses, and the absence is what a test can assert.
    ...(value === null ? [] : [`data-headline="${value}"`]),
    `role="region"`,
    `aria-labelledby="${headingId}"`,
  ].join(' ')
  const figure =
    args.headline.kind === 'no_data'
      ? `<p class="panel__nodata"><strong>${escapeHtml(headlineText(args.headline))}</strong> — ${escapeHtml(args.headline.why)}</p>`
      : `<p class="panel__headline">${escapeHtml(headlineText(args.headline))}</p>`
  return (
    `<section ${attributes}>` +
    `<h2 id="${headingId}">${escapeHtml(args.heading)}</h2>` +
    `<p class="panel__why">${escapeHtml(args.why)}</p>` +
    figure +
    `<p class="panel__basis">${escapeHtml(args.basis)}</p>` +
    args.body +
    '</section>'
  )
}

/** A whole-number cell, grouped. Every number on this page goes through one of these two. */
export const num = (value: number): string =>
  `<td class="num">${escapeHtml(value.toLocaleString('en-AE'))}</td>`

/**
 * A share as a cell, or an em dash when there is no denominator.
 *
 * An em dash and not `0%`, for the page's one rule: a row with no sessions has no conversion rate, and a
 * zero would read as a row that converted nobody.
 */
export function shareCell(numerator: number, denominator: number): string {
  if (denominator <= 0) return '<td class="num">—</td>'
  const perMille = Math.round((numerator * 1000) / denominator)
  return `<td class="num">${Math.floor(perMille / 10)}.${perMille % 10}%</td>`
}
