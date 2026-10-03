import { escapeHtml } from '@berelax/core'
import type { HourBucket, TimeOfDayPanel } from '../queries.ts'
import { num, renderPanel, shareCell } from './panel.ts'

/**
 * Conversion by hour across the trading window (A-FIRST-10).
 *
 * ## The acceptance line, and what makes it checkable
 *
 * *"exactly 15 contiguous hourly buckets from 11:00 through 01:00 in business-day order, with no
 * 03:00–10:00 bucket and no gap across midnight"*. Three claims, and each is held by a different thing:
 *
 *   - **Fifteen, contiguous, in business-day order** is the QUERY's: `generate_series` over
 *     `business_day.duration_seconds / 3600` from `opens_at`, left-joined to the sessions, so every hour
 *     of the window is a row whether anybody visited in it or not. The order is the series' order, which
 *     is the order the premises was open in — 23:00 then 00:00 then 01:00, never 00:00 first.
 *   - **No 03:00–10:00 bucket** is the same mechanism from the other side: those hours are not in the
 *     series because the premises is shut. A nought there would claim the business was open and empty.
 *   - **No gap across midnight** is what this renderer must not introduce. It prints the buckets in the
 *     order it was given and never sorts them: a `toSorted((a, b) => a.hour - b.hour)` here would put
 *     00:00 and 01:00 at the FRONT and is exactly the defect the line is about — the chart would show a
 *     midnight-to-01:00 pair, then a nine-hour hole, then the evening.
 *
 * `data-bucket-index` carries the position so a test can assert the sequence rather than the set, and
 * `data-hour` carries the hour. Asserting the set would pass for a chart in calendar order.
 *
 * ## Why the bars are a CSS inline width and not an image
 *
 * These documents ship no client JavaScript and no build-time stylesheet, so the only way to draw a
 * proportion is a style attribute. The width is a percentage of the busiest bucket, computed here, and the
 * TABLE beside it carries the figures — the bar is decoration and the numbers are the panel, which is
 * also why `aria-hidden` is on the bar and not on the cell.
 */

/** `11:00`, `00:00`. Two digits, so the column widths do not move between rows. */
const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`

export function renderTimeOfDayPanel(panel: TimeOfDayPanel): string {
  const busiest = panel.buckets.reduce((most, bucket) => Math.max(most, bucket.sessions), 0)
  const rows = panel.buckets
    .map((bucket: HourBucket, index: number) => {
      // Zero when nothing is busiest, which is the no-data case: a width of NaN would render as the
      // browser's default and the bar would be full for an empty hour.
      const width = busiest === 0 ? 0 : Math.round((bucket.sessions * 100) / busiest)
      return (
        `<tr data-bucket-index="${index}" data-hour="${bucket.hour}">` +
        `<th scope="row">${escapeHtml(hourLabel(bucket.hour))}</th>` +
        num(bucket.sessions) +
        num(bucket.paid) +
        shareCell(bucket.paid, bucket.sessions) +
        `<td><span class="bar" style="inline-size: ${width}%" aria-hidden="true"></span></td>` +
        '</tr>'
      )
    })
    .join('')
  return renderPanel({
    id: 'time-of-day',
    heading: 'Conversion by hour of the trading day',
    why:
      'The window the premises is open, in the order it is open in — so 23:00 is followed by 00:00 and ' +
      '01:00, and the hours the business is shut are absent rather than nought. A chart in calendar ' +
      'order would put the small hours at the front and show a nine-hour hole in the middle of the day.',
    headline: panel.headline,
    basis:
      `Hourly buckets generated from business_day for this trading date: ${hourLabel(panel.opensAtHour)} ` +
      `to ${hourLabel(panel.closesAtHour)}, ${panel.buckets.length} of them. Sessions are counted by the ` +
      'hour they BEGAN in, crawler sessions excluded.',
    body:
      '<table><caption>Sessions and paid conversions by the hour the session began.</caption>' +
      '<thead><tr><th scope="col">Hour</th><th scope="col" class="num">Sessions</th>' +
      '<th scope="col" class="num">Paid</th><th scope="col" class="num">Share</th>' +
      '<th scope="col">Relative volume</th></tr></thead>' +
      `<tbody>${rows}</tbody></table>`,
  })
}

/** The bar's own rule. Tokens only. */
export const TIME_OF_DAY_CSS = `
  .panel .bar {
    display: block;
    block-size: var(--space-3);
    min-inline-size: 1px;
    background: var(--color-accent-teal);
    border-radius: var(--radius-1);
  }
`
