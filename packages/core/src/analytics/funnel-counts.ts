import {
  FUNNEL_STAGES,
  FUNNEL_TERMINAL_STAGE,
  type FunnelStage,
  funnelStageRank,
} from '@berelax/shared'

/**
 * The eight funnel counts and the two rates taken from them (A-FIRST-09).
 *
 * ## Why conversion has no numerator parameter
 *
 * The acceptance line is *"conversion is computed as paid ÷ landing, never booking_created ÷ landing"*,
 * and the only way to make that true of code rather than of a reviewer's attention is to leave no
 * parameter a caller could pass the wrong stage through. {@link conversionRateOf} takes the counts and
 * nothing else; its numerator is {@link FUNNEL_TERMINAL_STAGE}, which is derived from the last element of
 * `FUNNEL_STAGES` rather than written out, so a ninth stage appended to the taxonomy moves this
 * numerator with it and no edit here is required or possible.
 *
 * `booking_created ÷ landing` is the figure the business will be shown by every advertising platform's
 * own dashboard, because a platform knows about a form submission and not about a payment. It is higher,
 * it is not revenue, and the gap between the two is the no-show and cancellation rate — which is exactly
 * the figure a spa needs and is the one a build that reported bookings would hide.
 *
 * ## Why the terminal stage is a fact in the LEDGER
 *
 * `paid` is not a thing a browser can tell us. It is an invoice settled in full, and this module says so
 * by taking the count as an argument: nothing here derives `paid` from an event, a booking status or a
 * sum of money. A funnel that counted its own idea of paid would disagree with the invoice the moment a
 * refund landed, and the disagreement would be between two numbers neither of which was wrong when it
 * was computed.
 *
 * ## Why every rate is per mille and has a "no denominator" variant
 *
 * Integer arithmetic, for the reason every rate in this build is one: a percentage computed in floating
 * point and rendered to one decimal place disagrees with the two integers it came from, and somebody
 * then has to work out which of the three is wrong. And a day with no landings has no conversion rate —
 * not 0% — because 0% says the funnel failed on a day nobody visited (ADR 0002, ADR 0073).
 */

/** What one stage holds: how many reached it, and how many of those do not count. */
export interface FunnelStageCount {
  readonly entered: number
  /**
   * How many of `entered` are excluded. A subset, never a separate population.
   *
   * A no-show reached `confirmed` before it was excluded from it, which is why 0096's
   * `daily_funnel_excluded_within_entered` is a CHECK and not a convention — and why the show-adjusted
   * rate can subtract this from that without the two being able to disagree.
   */
  readonly excluded: number
  /**
   * How many were filed under this trading date because the instant fell in the DAYTIME GAP.
   *
   * Trading runs 11:00-02:00, so between 02:00 and 11:00 no business day contains the instant at all
   * while web traffic carries on (ADR 0066, `Y5-funnel-gap-bucket`). Those steps are filed under the next
   * date the calendar opens and COUNTED here, so the cohort is visible and re-bucketable rather than
   * silently read as daytime trade. A subset of `entered`, like `excluded`.
   */
  readonly gapEntered: number
}

export type FunnelCounts = Readonly<Record<FunnelStage, FunnelStageCount>>

export const EMPTY_FUNNEL_STAGE_COUNT: FunnelStageCount = Object.freeze({
  entered: 0,
  excluded: 0,
  gapEntered: 0,
})

/**
 * An all-zero set of counts, with every stage present.
 *
 * Built from `FUNNEL_STAGES` rather than written out, so a stage added to the taxonomy appears here with
 * a zero instead of being `undefined` at the first read. A missing stage and a stage with no arrivals are
 * different facts and only one of them is a bucket that is empty for ever.
 */
export const EMPTY_FUNNEL_COUNTS: FunnelCounts = Object.freeze(
  Object.fromEntries(FUNNEL_STAGES.map((stage) => [stage, EMPTY_FUNNEL_STAGE_COUNT])) as Record<
    FunnelStage,
    FunnelStageCount
  >,
)

/** One row as the funnel read returns it, before it is folded into a complete set of counts. */
export interface FunnelCountRow {
  readonly stage: FunnelStage
  readonly entered: number
  readonly excluded: number
  readonly gapEntered: number
}

/**
 * Folds the rows a query returned into a complete set of counts.
 *
 * Totalled rather than overwritten, because the read is grouped by origination as well as by stage and a
 * caller asking for the whole day gets one row per (stage, source, medium, campaign). A function that
 * assigned instead of adding would answer with whichever tuple sorted last, which is a number that looks
 * right and is a fraction of the truth.
 */
export function funnelCountsFrom(rows: readonly FunnelCountRow[]): FunnelCounts {
  const counts: Record<FunnelStage, FunnelStageCount> = { ...EMPTY_FUNNEL_COUNTS }
  for (const row of rows) {
    const current = counts[row.stage]
    counts[row.stage] = {
      entered: current.entered + row.entered,
      excluded: current.excluded + row.excluded,
      gapEntered: current.gapEntered + row.gapEntered,
    }
  }
  return Object.freeze(counts)
}

/**
 * Narrows a stage read out of the taxonomy tuple, refusing the absence rather than defaulting.
 *
 * `noUncheckedIndexedAccess` types every element of `FUNNEL_STAGES` as possibly `undefined`, and the two
 * stages this module is built on — the first and the last — are read by position. A `?? 'paid'` would be
 * this file inventing the taxonomy's own answer, which is exactly what deriving the numerator exists to
 * avoid; a cast would hide an empty tuple until the first index read. So the absence is named.
 */
function stageOrRefuse(stage: FunnelStage | undefined, what: string): FunnelStage {
  if (stage === undefined) {
    throw new Error(
      `FUNNEL_STAGES does not hold ${what}, so the funnel has no such bucket and these rates have no ` +
        'numerator or denominator. The taxonomy needs re-deciding, not re-pointing.',
    )
  }
  return stage
}

/** The first stage of the taxonomy — `conversionRateOf`'s denominator. */
const FIRST_STAGE: FunnelStage = stageOrRefuse(FUNNEL_STAGES[0], 'a first stage')

/** The terminal stage — `conversionRateOf`'s numerator, and the ledger's fact. */
const TERMINAL_STAGE: FunnelStage = stageOrRefuse(FUNNEL_TERMINAL_STAGE, 'a terminal stage')

/**
 * A rate, or the named reason there is not one.
 *
 * `no_denominator` is a value and not a `null` for the reason `FunnelOutcome`'s `no_step` is: "there is
 * no conversion rate" and "there is no conversion rate because nobody landed" are different facts, and
 * the second is the one a reader looking at a gap needs.
 */
export type FunnelRate =
  | {
      readonly kind: 'rate'
      readonly numerator: number
      readonly denominator: number
      readonly perMille: number
    }
  | { readonly kind: 'no_denominator'; readonly why: string }

const rate = (numerator: number, denominator: number, why: string): FunnelRate =>
  denominator <= 0
    ? { kind: 'no_denominator', why }
    : {
        kind: 'rate',
        numerator,
        denominator,
        // Rounded once, at the end. A truncation reads as the lower figure for ever, and the direction
        // the rounding goes should not be a surprise to whoever reconciles the two integers above.
        perMille: Math.round((numerator * 1000) / denominator),
      }

/**
 * Conversion: PAID over LANDING.
 *
 * No parameter chooses either stage. The numerator is the taxonomy's terminal stage and the denominator
 * is its first, both derived — so `booking_created ÷ landing` is not a thing this module can be asked
 * for, which is the acceptance line stated as a type rather than as a convention.
 */
export function conversionRateOf(counts: FunnelCounts): FunnelRate {
  const landing = counts[FIRST_STAGE]
  const paid = counts[TERMINAL_STAGE]
  return rate(
    paid.entered,
    landing.entered,
    'no session landed in this window, so there is no denominator. A conversion rate of 0% for a day ' +
      'nobody visited reports a funnel failure that did not happen (ADR 0002).',
  )
}

/**
 * The show-adjusted conversion: of the bookings that were confirmed AND turned up, what share paid.
 *
 * The denominator is `confirmed.entered - confirmed.excluded`, and that subtraction is the whole point: a
 * no-show contributes to `confirmed.entered` AND to `confirmed.excluded`, so it cancels out of the
 * denominator, and it contributes nothing to `paid`, so it is out of the numerator. Excluded from both
 * sides, which is A-FIRST-09's acceptance line, and it falls out of the counts rather than needing a
 * second query that knows what a no-show is.
 *
 * It is a different figure from {@link conversionRateOf} and not a correction of it. Conversion measures
 * the marketing; this measures the operation — a spa that fills its diary and cannot get people through
 * the door has a healthy conversion rate and no revenue, and one number cannot say both.
 */
export function showAdjustedConversionOf(counts: FunnelCounts): FunnelRate {
  const confirmed = counts[CONFIRMED_STAGE]
  const paid = counts[TERMINAL_STAGE]
  return rate(
    paid.entered,
    confirmed.entered - confirmed.excluded,
    'no booking was confirmed and kept in this window, so there is no denominator: every confirmed ' +
      'booking was excluded, which is a figure about the no-shows and not about conversion.',
  )
}

/**
 * The stage the show-adjusted denominator is taken from.
 *
 * `confirmed` and not `attended`, and the difference is what the figure measures. `attended` is already
 * past the door, so `paid ÷ attended` would be a question about the till rather than about the diary; the
 * no-shows are exactly what the adjustment is for, and they are excluded from `confirmed`.
 *
 * Found by rank rather than written as a literal, so a stage inserted into the taxonomy before it does
 * not silently move the figure: `FUNNEL_STAGES` holds the order and `funnelStageRank` reads it.
 */
const CONFIRMED_STAGE: FunnelStage = (() => {
  const confirmed = FUNNEL_STAGES.find((stage) => stage === 'confirmed')
  if (confirmed === undefined) {
    throw new Error(
      'FUNNEL_STAGES no longer holds `confirmed`, so the show-adjusted conversion has no denominator. ' +
        'The rate is "of the bookings that were confirmed and turned up, what share paid" — if the ' +
        'taxonomy has dropped that stage the figure needs re-deciding, not re-pointing.',
    )
  }
  return confirmed
})()

/**
 * Whether a set of counts is monotonically non-increasing down the funnel.
 *
 * A funnel whose third bucket exceeds its second is either a measurement defect or a cohort arriving
 * mid-journey, and both need looking at — but this build has one case where it is CORRECT and expected:
 * `landing` counts only consented sessions while a pre-consent visit is counted in
 * `analytics.pre_consent_landing` and contributes to no session at all (ADR 0066). So this is a
 * reportable observation and not a refusal, and A-FIRST-10 renders it as a data-quality figure rather
 * than as drop-off.
 */
export function funnelOrderViolations(
  counts: FunnelCounts,
): readonly { readonly stage: FunnelStage; readonly previous: FunnelStage }[] {
  const violations: { stage: FunnelStage; previous: FunnelStage }[] = []
  for (const stage of FUNNEL_STAGES) {
    const rank = funnelStageRank(stage)
    if (rank === 0) continue
    const previous = FUNNEL_STAGES[rank - 1] as FunnelStage
    if (counts[stage].entered > counts[previous].entered) violations.push({ stage, previous })
  }
  return violations
}
