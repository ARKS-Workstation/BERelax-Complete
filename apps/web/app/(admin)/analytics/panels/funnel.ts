import { escapeHtml } from '@berelax/core'
import type { FunnelPanel } from '../queries.ts'
import { num, renderPanel } from './panel.ts'

/**
 * The funnel, with per-step drop-off (A-FIRST-10).
 *
 * ## The one cell that is deliberately empty
 *
 * `landing` has no drop-off, because it has no previous stage. The cell is an em dash rather than a zero:
 * a nought there would say nobody was lost before the funnel started, which is a claim about a step that
 * does not exist. Every other panel on this page follows the same rule for the same reason.
 *
 * ## Why a negative drop-off is printed as a negative number
 *
 * `landing` counts only consented sessions, while a visit before any consent contributes to no session at
 * all and is counted in `analytics.pre_consent_landing` instead (ADR 0066). So a later stage can
 * legitimately exceed an earlier one, and `funnelOrderViolations` in `@berelax/core` names the pairs where
 * it happened. Clamping the figure at zero would make a measurement artefact look like a clean funnel, so
 * the number is printed as it is and the violations are listed under it, pointing at the data-quality
 * strip where the pre-consent count is.
 *
 * ## Why both rates are shown
 *
 * `conversionRateOf` is paid ÷ landing: the marketing figure. `showAdjustedConversionOf` is paid ÷ (kept
 * confirmations): the operational one. A spa that fills its diary and cannot get people through the door
 * has a healthy conversion rate and no revenue, and one number cannot say both — which is why
 * `funnel-counts.ts` exports two functions and neither takes a stage parameter.
 */
export function renderFunnelPanel(panel: FunnelPanel): string {
  const rows = panel.rows
    .map((row) => {
      const dropped =
        row.droppedFromPrevious === null ? '<td class="num">—</td>' : num(row.droppedFromPrevious)
      return (
        `<tr data-stage="${escapeHtml(row.stage)}">` +
        `<th scope="row">${escapeHtml(row.stage)}</th>` +
        num(row.entered) +
        num(row.excluded) +
        num(row.gapEntered) +
        dropped +
        '</tr>'
      )
    })
    .join('')

  const violations =
    panel.orderViolations.length === 0
      ? ''
      : '<p class="panel__nodata" data-order-violations="' +
        `${panel.orderViolations.length}">A later stage holds more sessions than an earlier one: ` +
        escapeHtml(
          panel.orderViolations
            .map((violation) => `${violation.stage} exceeds ${violation.previous}`)
            .join('; '),
        ) +
        '. That is expected rather than wrong where it happens: the first bucket counts only consented ' +
        'sessions, and a visit before any consent is counted in the data-quality strip below instead.</p>'

  const showAdjusted =
    panel.showAdjusted.kind === 'rate'
      ? `${Math.floor(panel.showAdjusted.perMille / 10)}.${panel.showAdjusted.perMille % 10}% ` +
        `(${panel.showAdjusted.numerator.toLocaleString('en-AE')} of ` +
        `${panel.showAdjusted.denominator.toLocaleString('en-AE')} kept confirmations)`
      : `no data — ${panel.showAdjusted.why}`

  const landing = panel.rows[0]
  return renderPanel({
    id: 'funnel',
    heading: 'The funnel, to PAID',
    why:
      'Conversion is paid ÷ landing and never booking_created ÷ landing: a platform knows about a form ' +
      'submission and not about a payment, and the gap between the two is the no-show rate.',
    headline: panel.headline,
    basis:
      'Live read of analytics.funnel_step for this trading date, crawler sessions excluded. ' +
      `Show-adjusted conversion: ${showAdjusted}`,
    body:
      violations +
      '<table><caption>Sessions reaching each stage, how many of those do not count, how many were ' +
      'filed out of the closed hours, and how many were lost since the stage above.</caption>' +
      '<thead><tr><th scope="col">Stage</th><th scope="col" class="num">Entered</th>' +
      '<th scope="col" class="num">Excluded</th><th scope="col" class="num">From the gap</th>' +
      '<th scope="col" class="num">Lost since above</th></tr></thead>' +
      `<tbody>${rows}</tbody></table>` +
      (landing === undefined
        ? ''
        : `<p class="panel__basis">Of ${escapeHtml(landing.entered.toLocaleString('en-AE'))} landings.</p>`),
  })
}
