import { AppError } from '@berelax/shared'

/**
 * Coverage, ranking and field-data anomalies — with a threshold that is statistical rather than a delta.
 *
 * ## The failure this module is built against is a FALSE one
 *
 * G-SEO-01 mirrors Search Console nightly and G-SEO-03 reads the query report back. This is the other half
 * of the deterministic pipeline: the series themselves, judged. The obvious implementation is a delta —
 * *impressions today are 40% below yesterday, raise a finding* — and it is the one that makes the whole
 * feature worthless, because a single salon's daily impressions move by that much on a quiet Tuesday. An
 * agent that reports five findings a week that nobody can act on is an agent whose report stops being
 * opened, and then the one week it is right is the week nobody reads it. docs/09 calls this out directly
 * and the acceptance criterion turns it into a measurement: a one-day dip and a six-point PageSpeed swing
 * must each produce **zero** findings, while a sustained drop over a week produces **exactly one**.
 *
 * ## So a finding needs three things to be true at once
 *
 *   1. **A run of consecutive days.** One day is weather. {@link CoverageAnomalyConfig.minConsecutiveDays}
 *      is how long it has to persist, and the finding is reported ONCE for the run rather than once per
 *      day in it — which is the difference between one finding and seven for the same event.
 *   2. **A relative drop past a floor**, in basis points against the run's own baseline. This is the half a
 *      reader recognises: "40% down".
 *   3. **A drop past the series' own dispersion.** The part a delta cannot do. The baseline is the
 *      **median** of the comparison window and the scale is its **median absolute deviation**, because a
 *      mean and a standard deviation are both dragged by the very collapse being judged — a seven-day hole
 *      in the window moves the mean towards the hole and inflates the deviation, so the test gets weaker
 *      exactly when it matters. A site whose impressions normally swing by half therefore needs a bigger
 *      fall to be a finding than one that never moves, which is what "statistical" has to mean here if it
 *      is not to be a second hard-coded number.
 *
 * All three are {@link CoverageAnomalyConfig} fields and none has a default. A threshold that arrives by
 * default is a threshold nobody chose, and the caller stating its own is what makes the weekly report's
 * figures explicable — the same decision `ctr-outliers.ts` made and for the same reason.
 *
 * ## Why the scale is the MEAN absolute deviation from the median, and not the MAD
 *
 * The median absolute deviation was written first and is wrong here, measured rather than reasoned: with
 * {@link medianOf} taking the lower middle of an even count — which it does so the answer is an integer —
 * the MAD of a two-valued alternating series is **zero**. A fortnight of 410, 390, 410, 390 has a MAD of
 * nought, so `drop >= dispersion x multiple` is `drop >= 0` and the dispersion condition does nothing at
 * all. It passed its own unit test because the series it was tested on was flat, and the noisy control
 * that was supposed to prove it discriminates passed for an unrelated reason. That is the vacuous half of
 * an assertion the brief's rule 3 is about, and it was found by the figure in a test disagreeing with the
 * one in the module.
 *
 * So: the median is still the CENTRE, because a centre has to be robust to the collapse being judged, and
 * the SCALE is the mean of the absolute deviations from it, floored. Less robust than a MAD in theory and
 * not degenerate in practice, which is the trade worth making for a series of fourteen daily counts.
 *
 * The multiple is in **thousandths**, so the caller writes `2_500` for "two and a half times the typical
 * day-to-day move" and the arithmetic stays in integers. The usual robust z-score divides by
 * `scale x 1.4826`, the constant that makes a MAD consistent with a standard deviation under a normal
 * distribution; daily impressions on one salon's profile are not normal — they are counts over seven
 * weekdays, two of which are a weekend — so the constant would be a precision this data does not have,
 * and it is a float in a module whose every other quantity is an integer. ADR 0007's reasoning about money
 * applies to any quantity a test has to reproduce exactly: a float threshold is a threshold that is
 * 2.4999999 on one machine.
 *
 * ## No field data is a FINDING, and it carries no number
 *
 * CrUX has a traffic floor: an origin with too few visits has no field data at all, and the API answers
 * with no record rather than with zeros. A low-traffic origin is precisely this business today. Two wrong
 * answers are available and both have shipped elsewhere in this build's problem space: report nothing, so
 * the panel shows a blank where a reader supplies "fine"; or coerce the absence to `0`, so the panel shows
 * the **worst possible** LCP as if it had been measured. ADR 0070 settled the general case — *an
 * unattributable figure is a refusal and never a zero* — and this module follows it structurally rather
 * than by convention: {@link CoverageAnomalyFinding} has no numeric field at all, so there is nowhere for a
 * zero to be rendered from, and the measured figures live on
 * {@link SustainedDropFinding} which the no-data rule cannot construct.
 *
 * ## Pure, and the series arrive as arguments
 *
 * No clock, no I/O, no configuration read from anywhere. The dates are opaque ordered labels — this module
 * never parses one — because the only thing it needs of a date is that the caller handed the days in order,
 * and `gsc-window.ts` already owns what a Search Console date means.
 */

/** The rules, by name. A finding names one of these, so a reworded message is not a reworded rule. */
export const COVERAGE_ANOMALY_RULES = [
  /** Impressions sustained a fall past both the relative floor and the series' own dispersion. */
  'sustained_impression_drop',
  /** Average position sustained a RISE past both floors — a worse position is a larger number. */
  'sustained_position_loss',
  /** A PageSpeed score sustained a fall. A six-point swing is not one; see the module header. */
  'sustained_pagespeed_regression',
  /** CrUX has no field data for this origin, so no field figure exists to report. */
  'crux_no_field_data',
] as const
export type CoverageAnomalyRule = (typeof COVERAGE_ANOMALY_RULES)[number]

/** Which series a sustained-drop finding is about. The rule already says; this is for the message. */
export const COVERAGE_SERIES_KINDS = [
  'impressions',
  'avg_position_centi',
  'pagespeed_score',
] as const
export type CoverageSeriesKind = (typeof COVERAGE_SERIES_KINDS)[number]

/** One day of one series. The date is an opaque label the caller ordered; see the module header. */
export interface CoverageSeriesPoint {
  readonly date: string
  /**
   * The value, as a whole number in the series' own unit.
   *
   * Impressions are a count, `avg_position_centi` is 0042's hundredths (500 is position 5.00) and a
   * PageSpeed score is 0–100. `null` is a day the source had no row for — a gap, which is NOT a zero: a
   * day Search Console has not finished processing would otherwise read as a day with no impressions,
   * which is the whole collapse this module looks for, manufactured by the lag `gsc-window.ts` exists to
   * respect.
   */
  readonly value: number | null
}

export interface CoverageAnomalyConfig {
  /**
   * How many days the comparison baseline is taken over, ending the day before the run being judged.
   *
   * A window, not all of history: a site that grew tenfold over a year has a year-long median no recent
   * day resembles, and every day after the growth would be "above baseline" for ever.
   */
  readonly baselineWindowDays: number
  /** How many consecutive qualifying days a run needs. One is a dip; see the module header. */
  readonly minConsecutiveDays: number
  /** How far below baseline a day must sit, in basis points of the baseline. 4,000 is 40%. */
  readonly minRelativeDropBp: number
  /**
   * How many thousandths of the baseline's median absolute deviation the drop must also exceed.
   *
   * `2_500` is two and a half typical day-to-day moves. The second condition, and the one that makes a
   * noisy series harder to alarm than a flat one. The scale is {@link absoluteDeviationScale}.
   */
  readonly minDispersionMultipleMilli: number
  /**
   * An absolute floor on the drop, in the series' own unit, below which nothing is a finding.
   *
   * Needed because both other tests are RATIOS and a ratio over small numbers is meaningless: five
   * impressions falling to two is a 60% drop past any dispersion a two-impression series can have. This is
   * what stops the analysis reporting on pages nobody visits, and it is the reason the PageSpeed case in
   * the acceptance criterion needs no rule of its own — a six-point swing is below any floor a caller would
   * set for a 0–100 score, and it is below the dispersion of a score that normally swings by six.
   */
  readonly minAbsoluteDrop: number
}

/** What every finding carries. No figure: see the module header's note on the no-data rule. */
interface CoverageFindingBase {
  readonly rule: CoverageAnomalyRule
  /** What it is about: a page path, a query, or the origin for a whole-origin rule. */
  readonly subject: string
  /** Why, in a sentence, for the report an owner reads. Never the only statement of the figures. */
  readonly why: string
}

/** A sustained fall, with every figure it was decided on. */
export interface SustainedDropFinding extends CoverageFindingBase {
  readonly rule:
    | 'sustained_impression_drop'
    | 'sustained_position_loss'
    | 'sustained_pagespeed_regression'
  readonly series: CoverageSeriesKind
  /** The first and last day of the qualifying run, inclusive. */
  readonly fromDate: string
  readonly toDate: string
  /** How many consecutive days qualified. At least `minConsecutiveDays`. */
  readonly days: number
  /** The median of the baseline window, in the series' own unit. */
  readonly baseline: number
  /** The median of the run itself, in the series' own unit. */
  readonly observed: number
  /** `baseline - observed` for a fall, `observed - baseline` for a position loss. Always positive. */
  readonly drop: number
  /** The drop as basis points of the baseline. 4,000 is 40%. */
  readonly dropBp: number
  /** The baseline window's mean absolute deviation from its median, in the series' own unit. */
  readonly dispersion: number
}

/**
 * CrUX holds no field data for this origin.
 *
 * Structurally incapable of carrying a figure, which is the whole point: a shape with an optional
 * `lcpMs` would be a shape a renderer reads as `0` the day somebody spreads a default into it.
 */
export interface NoFieldDataFinding extends CoverageFindingBase {
  readonly rule: 'crux_no_field_data'
  /** Which collection was asked for and came back empty: the origin, or one URL. */
  readonly scope: 'origin' | 'url'
}

export type CoverageAnomalyFinding = SustainedDropFinding | NoFieldDataFinding

/** How many subjects each rule judged. Zero is legitimate and has to be visible — see `link-graph.ts`. */
export type CoverageAnomalyCoverage = Readonly<Record<CoverageAnomalyRule, number>>

export interface CoverageAnomalyReport {
  readonly findings: readonly CoverageAnomalyFinding[]
  readonly coverage: CoverageAnomalyCoverage
}

/** One series to judge, and what it is about. */
export interface CoverageSeries {
  readonly subject: string
  readonly kind: CoverageSeriesKind
  /** In date order, oldest first. Order is the caller's claim and {@link assertOrdered} holds it. */
  readonly points: readonly CoverageSeriesPoint[]
}

/**
 * What CrUX answered for one scope.
 *
 * A discriminated union and not a nullable record. `{ hasFieldData: false }` cannot be read as a
 * measurement; `{ lcpMs: null }` can, by anything that spreads it or renders it.
 */
export type CruxObservation =
  | { readonly scope: 'origin' | 'url'; readonly subject: string; readonly hasFieldData: false }
  | {
      readonly scope: 'origin' | 'url'
      readonly subject: string
      readonly hasFieldData: true
      /** 75th-percentile largest contentful paint, milliseconds, as CrUX reports it. */
      readonly lcpMs: number
    }

export interface CoverageAnomalyInput {
  readonly series: readonly CoverageSeries[]
  readonly crux: readonly CruxObservation[]
}

function assertConfig(config: CoverageAnomalyConfig): void {
  const problems: string[] = []
  for (const [name, value] of [
    ['baselineWindowDays', config.baselineWindowDays],
    ['minConsecutiveDays', config.minConsecutiveDays],
    ['minRelativeDropBp', config.minRelativeDropBp],
    ['minDispersionMultipleMilli', config.minDispersionMultipleMilli],
    ['minAbsoluteDrop', config.minAbsoluteDrop],
  ] as const) {
    if (!Number.isInteger(value)) problems.push(`${name} must be a whole number`)
  }
  if (problems.length === 0) {
    // Three days is the smallest window with a median that is not one of its own extremes, and a
    // baseline that is a single day is a baseline that is itself an anomaly half the time.
    if (config.baselineWindowDays < 3) problems.push('baselineWindowDays must be at least 3')
    // One would make a single-day dip a finding, which is the defect the whole module exists to avoid
    // and the first half of the acceptance criterion.
    if (config.minConsecutiveDays < 2) problems.push('minConsecutiveDays must be at least 2')
    if (config.minRelativeDropBp < 1)
      problems.push('minRelativeDropBp must be at least 1 basis point')
    if (config.minDispersionMultipleMilli < 1) {
      problems.push('minDispersionMultipleMilli must be at least 1 thousandth')
    }
    if (config.minAbsoluteDrop < 1) problems.push('minAbsoluteDrop must be at least 1')
  }
  if (problems.length > 0) {
    throw new AppError(
      'validation',
      `a coverage-anomaly configuration that cannot discriminate is worse than none: ${problems.join('; ')}`,
      { details: { problems } },
    )
  }
}

/**
 * The median of a non-empty list of whole numbers, rounded DOWN on an even count.
 *
 * Down rather than averaged, so the answer is an integer in the series' own unit and two runs of this
 * module over the same input agree to the digit. An averaged median of two odd impressions counts is a
 * half-impression, and a half of anything in a threshold is how a test becomes machine-dependent.
 */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) {
    throw new AppError('invariant_violated', 'medianOf was asked for the median of nothing')
  }
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor((sorted.length - 1) / 2)
  return sorted[middle] as number
}

/**
 * The mean absolute deviation from the median, floored. The dispersion the threshold is scaled by.
 *
 * See the module header for why this is not the median absolute deviation. Floored rather than rounded, so
 * the scale is never larger than the deviations it came from — a rounded-up scale makes the threshold
 * stricter than the data supports, which is a finding suppressed rather than one raised.
 */
export function absoluteDeviationScale(values: readonly number[]): number {
  const centre = medianOf(values)
  const total = values.reduce((sum, value) => sum + Math.abs(value - centre), 0)
  return Math.floor(total / values.length)
}

/** Basis points of `baseline`, rounded DOWN, so a drop exactly on the floor is not over it. */
function dropBasisPoints(drop: number, baseline: number): number {
  if (baseline <= 0) return 0
  return Math.floor((drop * 10_000) / baseline)
}

function assertOrdered(series: CoverageSeries): void {
  for (let at = 1; at < series.points.length; at += 1) {
    const previous = series.points[at - 1] as CoverageSeriesPoint
    const current = series.points[at] as CoverageSeriesPoint
    /*
     * A string comparison, which is exactly right for an ISO date and exactly wrong for anything else —
     * so the claim being checked is "the caller handed these in order", not "these are dates". A series
     * out of order makes the baseline window the days AFTER the run, which inverts every finding, and the
     * symptom is a report that is confidently backwards rather than one that is empty.
     */
    if (current.date <= previous.date) {
      throw new AppError(
        'validation',
        `the ${series.kind} series for ${series.subject} is not in ascending date order: ` +
          `${current.date} follows ${previous.date}. The baseline window is the days before a run, so ` +
          'an unordered series compares a collapse against the days after it.',
        { details: { subject: series.subject, kind: series.kind } },
      )
    }
  }
}

/** A position loss is a RISE; every other series' anomaly is a fall. One place states which. */
const isLossOnRise = (kind: CoverageSeriesKind): boolean => kind === 'avg_position_centi'

const RULE_FOR_SERIES: Readonly<Record<CoverageSeriesKind, SustainedDropFinding['rule']>> =
  Object.freeze({
    impressions: 'sustained_impression_drop',
    avg_position_centi: 'sustained_position_loss',
    pagespeed_score: 'sustained_pagespeed_regression',
  })

/**
 * Whether one day qualifies against one baseline, and the figures it qualified on.
 *
 * All three conditions, and `null` is never one: a gap day breaks a run rather than extending it, because
 * a day with no row is a day nothing is known about and a run broken by ignorance is not a sustained fall.
 */
function qualifies(
  value: number | null,
  baseline: number,
  dispersion: number,
  kind: CoverageSeriesKind,
  config: CoverageAnomalyConfig,
): boolean {
  if (value === null) return false
  const drop = isLossOnRise(kind) ? value - baseline : baseline - value
  if (drop < config.minAbsoluteDrop) return false
  if (dropBasisPoints(drop, baseline) < config.minRelativeDropBp) return false
  /*
   * `drop * 1000 >= dispersion * multiple` rather than `drop >= dispersion * multiple / 1000`. The same
   * inequality with no division, so there is no rounding step for the two sides to disagree across — and
   * a dispersion of zero (a perfectly flat baseline) makes the right-hand side zero, so a flat series is
   * judged by the other two conditions alone rather than by a comparison against nothing.
   */
  return drop * 1_000 >= dispersion * config.minDispersionMultipleMilli
}

/**
 * Every sustained run in one series, at most one finding per run.
 *
 * The baseline for a candidate run is the `baselineWindowDays` days immediately before it, which is why
 * the scan walks forward rather than evaluating each day against the whole series: a day is judged against
 * what the site was doing before it, and a series containing two separate collapses must report two
 * findings rather than one average of both.
 */
function sustainedRunsIn(
  series: CoverageSeries,
  config: CoverageAnomalyConfig,
): readonly SustainedDropFinding[] {
  const findings: SustainedDropFinding[] = []
  const points = series.points
  let at = config.baselineWindowDays

  while (at < points.length) {
    const window = points
      .slice(at - config.baselineWindowDays, at)
      .map((point) => point.value)
      .filter((value): value is number => value !== null)
    // A baseline that is mostly gaps is not a baseline. Half the window, so a source that missed a day or
    // two still produces an answer and one that missed most of them produces none rather than a median of
    // the two days it has.
    if (window.length * 2 < config.baselineWindowDays) {
      at += 1
      continue
    }
    const baseline = medianOf(window)
    const dispersion = absoluteDeviationScale(window)

    let end = at
    while (
      end < points.length &&
      qualifies(
        (points[end] as CoverageSeriesPoint).value,
        baseline,
        dispersion,
        series.kind,
        config,
      )
    ) {
      end += 1
    }
    const days = end - at
    if (days < config.minConsecutiveDays) {
      at += 1
      continue
    }

    const run = points.slice(at, end)
    const observed = medianOf(
      run.map((point) => point.value).filter((value): value is number => value !== null),
    )
    const drop = isLossOnRise(series.kind) ? observed - baseline : baseline - observed
    const first = run[0] as CoverageSeriesPoint
    const last = run[run.length - 1] as CoverageSeriesPoint
    findings.push({
      rule: RULE_FOR_SERIES[series.kind],
      subject: series.subject,
      series: series.kind,
      fromDate: first.date,
      toDate: last.date,
      days,
      baseline,
      observed,
      drop,
      dropBp: dropBasisPoints(drop, baseline),
      dispersion,
      why:
        `${series.subject}: ${series.kind} ran at ${observed} for ${days} consecutive days from ` +
        `${first.date}, against a ${config.baselineWindowDays}-day median of ${baseline} whose typical ` +
        `day-to-day move is ${dispersion}.`,
    })
    /*
     * Resume AFTER the run, not one day in. Resuming inside it would re-detect the same collapse against a
     * baseline that is now partly the collapse, which is both a second finding for one event and a weaker
     * test of it — the acceptance criterion says a sustained drop produces EXACTLY one finding, and this
     * line is why.
     */
    at = end
  }
  return findings
}

/**
 * Every anomaly in one input, and how many subjects each rule judged.
 *
 * Findings and a coverage count, not findings alone. Three of these four rules have few or no subjects on
 * this site today — there is no Search Console property (ADR 0005), so the series a caller can hand over
 * are the ones a manual export or a fixture provides — and a rule with no subjects returns no findings,
 * which is indistinguishable from a rule that passed. ADR 0002 is the reason that distinction has to be on
 * the answer rather than in a comment.
 */
export function coverageAnomalies(
  input: CoverageAnomalyInput,
  config: CoverageAnomalyConfig,
): CoverageAnomalyReport {
  assertConfig(config)
  const findings: CoverageAnomalyFinding[] = []
  const coverage: Record<CoverageAnomalyRule, number> = {
    sustained_impression_drop: 0,
    sustained_position_loss: 0,
    sustained_pagespeed_regression: 0,
    crux_no_field_data: 0,
  }

  for (const series of input.series) {
    assertOrdered(series)
    const rule = RULE_FOR_SERIES[series.kind]
    // Judged, not found: a series too short to have both a baseline and a minimum run can produce no
    // finding, and counting it as judged would report a rule as exercised by data that could not
    // exercise it. This is the floor the fuzz-adjacent defect in brief rule 22 is about.
    if (series.points.length >= config.baselineWindowDays + config.minConsecutiveDays) {
      coverage[rule] += 1
    }
    findings.push(...sustainedRunsIn(series, config))
  }

  for (const observation of input.crux) {
    coverage.crux_no_field_data += 1
    if (observation.hasFieldData) continue
    findings.push({
      rule: 'crux_no_field_data',
      subject: observation.subject,
      scope: observation.scope,
      why:
        `CrUX holds no field data for ${observation.subject}: the ${observation.scope} is below the ` +
        'traffic floor the dataset requires, so there is no measured field figure. This is not a zero ' +
        'and must not be rendered as one.',
    })
  }

  return { findings, coverage }
}

/** The findings as lines, for a report and for a failing test's message. */
export function formatCoverageAnomalies(findings: readonly CoverageAnomalyFinding[]): string {
  return findings.map((finding) => `${finding.rule}  ${finding.subject}  ${finding.why}`).join('\n')
}
