import { safeText } from '@berelax/core'
import type { RungVerdict } from '@berelax/media/derivative-set'

/**
 * One rung's transferred weight, against the budget its slot declares.
 *
 * ## The number is measured, never estimated
 *
 * `verdict.rendition.bytes` is what `head` reported for the object in the public bucket — the bytes a
 * browser downloads. An estimate from pixel count and quality would be a number that tracks nothing: AVIF
 * spends bytes on *detail*, so two 2560-wide photographs of the same room differ by a factor of three, and
 * a budget checked against an estimate passes while the file is over. That is the difference between this
 * badge and decoration.
 *
 * ## Three states, not two
 *
 * `over`, `within`, and **`unbudgeted`**. Only the hero has a figure in docs/08 §8 (95KB on the 4:5 crop,
 * 170KB on the 16:9), and `publishedBudgetBytes` is `null` everywhere else — which means "docs/08 states
 * none", not "unlimited". A badge that rendered `null` as a pass would tell an editor the gallery tile was
 * within a budget nobody ever wrote; this says there is no budget, which is the true and more useful thing.
 *
 * ## Why HTML rather than a React component
 *
 * The preview is served by a route handler, and Next 16.3.5 refuses `react-dom/server` anywhere in the app
 * graph ("You're importing a component that imports react-dom/server"), so a handler cannot render JSX to
 * bytes. The Messages inbox next door assembles its document the same way and for the same reason. The
 * production `<picture>` IS a React component (`src/components/media/slot-picture.tsx`) — and the fact that
 * this and that are two renderers is what makes the `srcset` equality assertion in
 * `apps/web/src/breakpoint-preview.itest.ts` a real cross-check rather than a tautology: both read
 * `pictureSourcesFor`, and the test compares the strings they each produced.
 *
 * The state is on `data-state` as well as in the class, so a Playwright assertion reads the verdict rather
 * than a colour — a colour assertion passes when the state is right and the palette is wrong, and fails
 * when the palette changes and the state is right.
 */
export type WeightState = 'over' | 'within' | 'unbudgeted'

export function weightState(verdict: RungVerdict): WeightState {
  if (verdict.budgetBytes === null) return 'unbudgeted'
  return verdict.overBudget ? 'over' : 'within'
}

/** Bytes as a figure an editor can compare with a file listing, with the exact count kept. */
export function formatBytes(count: number): string {
  const kib = count / 1024
  return kib >= 1 ? `${kib.toFixed(1)} KB (${count} bytes)` : `${count} bytes`
}

export function weightBadgeHtml(verdict: RungVerdict): string {
  const state = weightState(verdict)
  const { rendition, budgetBytes } = verdict
  const note =
    budgetBytes === null
      ? 'no published budget for this slot — docs/08 §8 states one for the hero only'
      : verdict.overBudget
        ? `over the ${formatBytes(budgetBytes)} budget by ${formatBytes(rendition.bytes - budgetBytes)}`
        : `within the ${formatBytes(budgetBytes)} budget`
  return (
    `<span class="weight weight-${state}" data-state="${state}" data-crop="${rendition.crop}" ` +
    `data-rung="${rendition.width}" data-format="${rendition.format}" ` +
    `data-bytes="${rendition.bytes}" data-budget="${budgetBytes === null ? '' : budgetBytes}">` +
    `<strong class="weight-figure">${safeText(formatBytes(rendition.bytes))}</strong>` +
    `<span class="weight-note">${safeText(note)}</span>` +
    '</span>'
  )
}
