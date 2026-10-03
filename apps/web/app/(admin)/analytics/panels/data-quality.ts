import { escapeHtml } from '@berelax/core'
import type { DataQualityPanel, PanelHeadline } from '../queries.ts'
import { headlineText, renderPanel } from './panel.ts'

/**
 * The data-quality strip (A-FIRST-10), and the one acceptance line on this page that is about a ZERO.
 *
 * *"the data-quality strip shows bot-filtered share and ref-capture rate with numerator and denominator
 * visible, and renders 'no data' rather than 0% when no codes were issued"*.
 *
 * Both halves are structural rather than careful:
 *
 *   - **Numerator and denominator visible** is {@link renderFigure}, which prints `24 of 1,031` beside
 *     every share. A reader who can see the two integers does not have to trust the percentage, and a
 *     percentage nobody can check is the figure a dashboard is believed on.
 *   - **"no data" rather than 0%** is `PanelHeadline`'s `no_data` variant, which carries the REASON. The
 *     query returns it when the denominator is nought, and there is no code path here that can turn one
 *     into a percentage: the variant has no numerator to print. `0%` for a day nobody was offered a ref
 *     code on would say the loop was offered and refused, which is the claim ADR 0002 is about.
 *
 * ## Why the two populations beside them are on this panel
 *
 * The daytime-gap cohort and the pre-consent landings are the two groups of real visitors that no panel
 * above can show, and leaving them off would make the funnel look complete. The gap cohort is sessions
 * filed under this trading date out of the closed hours no business day contains
 * (`Y5-funnel-gap-bucket`, still open). The pre-consent landings are visits that produced no session at
 * all, counted in `analytics.pre_consent_landing` because A-FIRST-05 creates the visitor row AT consent —
 * which is why a later funnel stage can legitimately exceed `landing`, and why the funnel panel's order
 * violations point down here.
 */

/** A share with both its integers, or the named absence. Never a bare percentage. */
function renderFigure(args: {
  readonly id: string
  readonly label: string
  readonly figure: PanelHeadline
  readonly explanation: string
}): string {
  const state = args.figure.kind === 'no_data' ? 'no-data' : args.figure.kind
  const value =
    args.figure.kind === 'rate'
      ? ` data-numerator="${args.figure.numerator}" data-denominator="${args.figure.denominator}"` +
        ` data-per-mille="${args.figure.perMille}"`
      : ''
  const detail =
    args.figure.kind === 'no_data'
      ? `<dd class="why">${escapeHtml(args.figure.why)}</dd>`
      : `<dd class="why">${escapeHtml(args.explanation)}</dd>`
  return (
    `<div class="figure" data-figure="${escapeHtml(args.id)}" data-figure-state="${state}"${value}>` +
    `<dl><dt>${escapeHtml(args.label)}</dt>` +
    `<dd class="value">${escapeHtml(headlineText(args.figure))}</dd>` +
    detail +
    '</dl></div>'
  )
}

export function renderDataQualityPanel(panel: DataQualityPanel): string {
  return renderPanel({
    id: 'data-quality',
    heading: 'Data quality',
    why:
      'Whether anything above can be believed. Two shares with both of their integers, and the two ' +
      'populations of real visitors no panel above is able to show.',
    headline: panel.headline,
    basis:
      'analytics.daily_traffic for the crawler share, analytics.daily_ref_capture for the capture rate, ' +
      'analytics.pre_consent_landing for the identifier-free landing count.',
    body:
      '<div class="strip">' +
      renderFigure({
        id: 'bot-filtered',
        label: 'Bot-filtered share',
        figure: panel.botFiltered,
        explanation:
          'Sessions the classifier flagged as a crawler, out of all sessions rolled up for the date. ' +
          'Every other panel on this page excludes them.',
      }) +
      renderFigure({
        id: 'ref-capture',
        label: 'Ref-capture rate',
        figure: panel.refCapture,
        explanation:
          'WhatsApp ref codes claimed, out of codes issued, paired by the day the CODE was issued ' +
          'rather than the day the booking was taken — the other pairing mixes cohorts.',
      }) +
      '<div class="figure" data-figure="gap-sessions" ' +
      `data-sessions="${panel.gapSessions}"><dl><dt>Filed out of the closed hours</dt>` +
      `<dd class="value">${escapeHtml(panel.gapSessions.toLocaleString('en-AE'))} sessions</dd>` +
      // The hours themselves are NOT written here: they live in `premises_hours`, they are provisional
      // against Y1-nap, and `packages/db/src/seed/premises.test.ts` refuses a literal of them on a
      // rendered surface. A page that states them reads wrong the day the salon's hours change.
      '<dd class="why">No business day contains the hours between closing and the next opening, while ' +
      'web traffic carries on. These are filed under the next date the calendar opens ' +
      'and counted here, so the cohort is visible and re-bucketable rather than read as daytime trade ' +
      '(Y5-funnel-gap-bucket, open).</dd></dl></div>' +
      '<div class="figure" data-figure="pre-consent-landings" ' +
      `data-landings="${panel.preConsentLandings}"><dl><dt>Landings before any consent</dt>` +
      `<dd class="value">${escapeHtml(panel.preConsentLandings.toLocaleString('en-AE'))} landings</dd>` +
      '<dd class="why">Visits that produced no session at all: the visitor row is created at consent, so ' +
      'these are counted without an identifier. This is why a later funnel stage can hold more sessions ' +
      'than the first one, and it is not a defect in the funnel.</dd></dl></div>' +
      '</div>',
  })
}

/** The strip's own layout. Tokens only. */
export const DATA_QUALITY_CSS = `
  .panel .strip { display: grid; gap: var(--space-4); grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .panel .figure {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-ground);
    padding: var(--space-4);
  }
  .panel .figure dl { margin: 0; }
  .panel .figure dt { color: var(--color-ink-2); font-size: 0.875rem; }
  .panel .figure dd { margin: 0; }
  .panel .figure dd.value { font-size: 1.25rem; font-variant-numeric: tabular-nums; margin: var(--space-1) 0; }
  .panel .figure dd.why { color: var(--color-ink-2); font-size: 0.8125rem; }
  .panel .figure[data-figure-state='no-data'] { border-inline-start: var(--space-2) solid var(--color-accent-gold); }
  @media (max-width: 48rem) {
    .panel .strip { grid-template-columns: minmax(0, 1fr); }
  }
`
