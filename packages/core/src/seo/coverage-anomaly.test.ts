import { describe, expect, it } from 'vitest'
import {
  absoluteDeviationScale,
  COVERAGE_ANOMALY_RULES,
  type CoverageAnomalyConfig,
  type CoverageSeriesPoint,
  coverageAnomalies,
  medianOf,
  type SustainedDropFinding,
} from './coverage-anomaly.ts'

/**
 * The cry-wolf gate, measured.
 *
 * The acceptance criterion is three numbers and one absence, and all four are asserted on SEEDED series
 * rather than on a mocked threshold: *a single-day impression dip and a 6-point PageSpeed swing each
 * produce zero findings, while a sustained 40% impression drop over seven consecutive days produces
 * exactly one*, and *a low-traffic origin with no CrUX data produces a 'no field data' finding and never a
 * rendered zero, asserted against the finding payload*.
 *
 * The configuration below is the one the tests use and is NOT a shipped default — there is none, on
 * purpose (see the module header). It is stated once here so the three cases are judged by the same
 * thresholds, which is what makes "the dip produces nothing and the drop produces one" a statement about
 * the analysis rather than about two sets of numbers.
 */
const CONFIG: CoverageAnomalyConfig = {
  baselineWindowDays: 14,
  minConsecutiveDays: 5,
  // 40% is the figure the acceptance line names, so the floor sits just under it: a drop OF 40% must
  // qualify. A floor of exactly 4,000 would make the named case depend on the rounding direction of
  // `dropBasisPoints`, which is the kind of boundary a test should state rather than inherit.
  minRelativeDropBp: 3_000,
  minDispersionMultipleMilli: 2_500,
  minAbsoluteDrop: 20,
}

/** A flat-ish series: the baseline the cases below are judged against. */
function steadyDays(count: number, from: number, base: number): CoverageSeriesPoint[] {
  const points: CoverageSeriesPoint[] = []
  for (let day = 0; day < count; day += 1) {
    // A deterministic wobble, not a random one: the series has to have a non-zero dispersion for the
    // dispersion condition to be doing anything at all, and a generated wobble would make the threshold
    // a different number on every run. +/-10 on 400 is a MAD of 10.
    points.push({ date: iso(from + day), value: base + (day % 2 === 0 ? 10 : -10) })
  }
  return points
}

/** Day `n` of 2026-03, as an ISO date. The dates are opaque labels; only their order matters. */
function iso(day: number): string {
  return `2026-03-${String(day).padStart(2, '0')}`
}

const impressions = (points: readonly CoverageSeriesPoint[]) => ({
  subject: '/treatments/deep-tissue',
  kind: 'impressions' as const,
  points,
})

describe('medianOf and absoluteDeviationScale', () => {
  it('takes the lower middle on an even count, so the answer is an integer', () => {
    expect(medianOf([4, 1, 3, 2])).toBe(2)
    expect(medianOf([5])).toBe(5)
    // The control: an averaged median would answer 2.5 here, and a half-impression in a threshold is how
    // the same input produces two different verdicts on two machines.
    expect(Number.isInteger(medianOf([1, 2, 3, 4]))).toBe(true)
  })

  it('answers zero for a flat series and the typical move for a wobbling one', () => {
    expect(absoluteDeviationScale([400, 400, 400, 400, 400])).toBe(0)
    /*
     * 12, and this is the number that condemned the median absolute deviation. The MAD of these six
     * values is 0 — three deviations of 0 and three of 20, lower middle — so a dispersion condition
     * scaled by it would be `drop >= 0` on the commonest shape a daily series takes. The mean is 10.
     */
    expect(absoluteDeviationScale([390, 410, 390, 410, 390, 410])).toBe(10)
    expect(medianOf([390, 410, 390, 410, 390, 410].map((v) => Math.abs(v - 390)))).toBe(0)
  })
})

describe('coverageAnomalies: the cry-wolf gate', () => {
  it('produces ZERO findings for a single-day impression dip', () => {
    const points = [
      ...steadyDays(14, 1, 400),
      // One day at 120, a 70% fall — far past every relative and dispersion threshold, and still one day.
      { date: iso(15), value: 120 },
      ...steadyDays(10, 16, 400),
    ]
    const report = coverageAnomalies({ series: [impressions(points)], crux: [] }, CONFIG)
    expect(report.findings).toEqual([])
    // The control that stops this passing vacuously: the series WAS judged. Without it a report of zero
    // findings is indistinguishable from a series too short to have a baseline.
    expect(report.coverage.sustained_impression_drop).toBe(1)
  })

  it('produces ZERO findings for a 6-point PageSpeed swing', () => {
    const scores: CoverageSeriesPoint[] = []
    for (let day = 0; day < 28; day += 1) {
      /*
       * 88, 85, 82: a six-point swing, for a month, and THREE-valued on purpose. A two-valued swing puts
       * the median on its own lower value, so the drop on a low day is nought and the case passes because
       * of a SIGN rather than because of a threshold — which is how this test first passed while the
       * condition it was about could be deleted with nothing failing (gate case 163c found it).
       */
      scores.push({ date: iso(day + 1), value: [88, 85, 82][day % 3] as number })
    }
    const report = coverageAnomalies(
      {
        series: [{ subject: 'https://example.test/', kind: 'pagespeed_score', points: scores }],
        crux: [],
      },
      CONFIG,
    )
    expect(report.findings).toEqual([])
    expect(report.coverage.sustained_pagespeed_regression).toBe(1)
  })

  it('produces EXACTLY one finding for a sustained 40% impression drop over seven consecutive days', () => {
    const points = [
      ...steadyDays(14, 1, 400),
      // 240 is 40% below the 400 baseline, seven days running. One event, one finding — the resume-after-
      // the-run decision in `sustainedRunsIn` is what makes it one rather than three.
      ...Array.from({ length: 7 }, (_, offset) => ({ date: iso(15 + offset), value: 240 })),
    ]
    const report = coverageAnomalies({ series: [impressions(points)], crux: [] }, CONFIG)
    expect(report.findings).toHaveLength(1)
    const finding = report.findings[0] as SustainedDropFinding
    expect(finding.rule).toBe('sustained_impression_drop')
    expect(finding.days).toBe(7)
    expect(finding.fromDate).toBe(iso(15))
    expect(finding.toDate).toBe(iso(21))
    expect(finding.baseline).toBe(390)
    expect(finding.observed).toBe(240)
    // 150/390 = 3,846 basis points, floored. Asserted to the digit because the figure is what a reader
    // acts on, and a rule that reported "down a bit" would pass every other assertion here.
    expect(finding.dropBp).toBe(3_846)
    expect(finding.dispersion).toBe(10)
  })

  it('refuses a large relative drop on a series of counts too small to mean anything', () => {
    /*
     * The absolute floor, isolated — both other conditions are RATIOS and a ratio over tiny counts is
     * meaningless. Cycling 5, 3, 4 puts the median at 4 with a deviation scale of 0, so the dispersion
     * condition passes and the relative one does too (2 of 4 is 5,000 basis points); `minAbsoluteDrop` is
     * the only thing left that can refuse a run at 2, which is what makes this case about that condition.
     */
    const tiny: CoverageSeriesPoint[] = []
    for (let day = 0; day < 14; day += 1) {
      tiny.push({ date: iso(day + 1), value: [5, 3, 4][day % 3] as number })
    }
    const points = [
      ...tiny,
      ...Array.from({ length: 7 }, (_, offset) => ({ date: iso(15 + offset), value: 2 })),
    ]
    expect(coverageAnomalies({ series: [impressions(points)], crux: [] }, CONFIG).findings).toEqual(
      [],
    )
    // And the control: the SAME proportional drop on counts that do mean something IS a finding, so the
    // floor is a floor on the magnitude rather than a condition that refuses everything.
    const real = [
      ...steadyDays(14, 1, 400),
      ...Array.from({ length: 7 }, (_, offset) => ({ date: iso(15 + offset), value: 200 })),
    ]
    expect(
      coverageAnomalies({ series: [impressions(real)], crux: [] }, CONFIG).findings,
    ).toHaveLength(1)
  })

  it('refuses a drop that is relatively large and smaller than the series own noise', () => {
    /*
     * The dispersion condition, isolated, and the series is three-valued ON PURPOSE. A two-valued
     * alternating series has the same median as its lower value, so a run BELOW that value is refused by
     * the absolute floor and the case passes without the dispersion condition being consulted at all —
     * which is how the first version of this test passed against a dispersion that was always zero.
     * Cycling 600, 200, 400 puts the median at 400 with a scale of 142, so the only thing that can
     * refuse a run at 240 (40% down, past the floor) is `minDispersionMultipleMilli`.
     */
    const noisy: CoverageSeriesPoint[] = []
    for (let day = 0; day < 14; day += 1) {
      noisy.push({ date: iso(day + 1), value: [600, 200, 400][day % 3] as number })
    }
    const points = [
      ...noisy,
      ...Array.from({ length: 7 }, (_, offset) => ({ date: iso(15 + offset), value: 240 })),
    ]
    const report = coverageAnomalies({ series: [impressions(points)], crux: [] }, CONFIG)
    expect(report.findings).toEqual([])
    // And the control, in the direction a refusal cannot state: the SAME relative drop on a quiet series
    // IS a finding. Without this the case above is satisfied by a condition that refuses everything.
    const quiet = [
      ...steadyDays(14, 1, 400),
      ...Array.from({ length: 7 }, (_, offset) => ({ date: iso(15 + offset), value: 240 })),
    ]
    expect(
      coverageAnomalies({ series: [impressions(quiet)], crux: [] }, CONFIG).findings,
    ).toHaveLength(1)
  })

  it('breaks a run on a day the source had no row for, rather than reading the gap as a collapse', () => {
    const points = [
      ...steadyDays(14, 1, 400),
      { date: iso(15), value: 240 },
      { date: iso(16), value: 240 },
      { date: iso(17), value: null },
      { date: iso(18), value: 240 },
      { date: iso(19), value: 240 },
    ]
    const report = coverageAnomalies({ series: [impressions(points)], crux: [] }, CONFIG)
    // Two runs of two, neither reaching five. A gap read as zero would have made one run of five with a
    // deeper drop — the Search Console lag manufacturing the very collapse `gsc-window.ts` exists to avoid.
    expect(report.findings).toEqual([])
  })

  it('reports a position LOSS as a rise, not a fall', () => {
    const points = [
      ...steadyDays(14, 1, 600),
      ...Array.from({ length: 6 }, (_, offset) => ({ date: iso(15 + offset), value: 1_400 })),
    ]
    const report = coverageAnomalies(
      {
        series: [{ subject: 'spa near me', kind: 'avg_position_centi', points }],
        crux: [],
      },
      CONFIG,
    )
    expect(report.findings).toHaveLength(1)
    const finding = report.findings[0] as SustainedDropFinding
    expect(finding.rule).toBe('sustained_position_loss')
    // Position 5.90 to position 14.00. A module treating this like impressions would compute a negative
    // drop and report nothing, which is a ranking collapse reported as silence.
    expect(finding.baseline).toBe(590)
    expect(finding.observed).toBe(1_400)
    expect(finding.drop).toBe(810)
  })

  it('refuses a series out of date order rather than comparing a run against the days after it', () => {
    const points = [...steadyDays(14, 1, 400)].reverse()
    expect(() => coverageAnomalies({ series: [impressions(points)], crux: [] }, CONFIG)).toThrow(
      /ascending date order/,
    )
  })

  it('refuses a configuration that cannot discriminate', () => {
    expect(() =>
      coverageAnomalies({ series: [], crux: [] }, { ...CONFIG, minConsecutiveDays: 1 }),
    ).toThrow(/minConsecutiveDays must be at least 2/)
    expect(() =>
      coverageAnomalies({ series: [], crux: [] }, { ...CONFIG, minAbsoluteDrop: 0 }),
    ).toThrow(/minAbsoluteDrop must be at least 1/)
  })
})

describe('coverageAnomalies: CrUX and PageSpeed empty cases', () => {
  it("reports 'no field data' for a low-traffic origin and the payload holds no number at all", () => {
    const report = coverageAnomalies(
      {
        series: [],
        crux: [{ scope: 'origin', subject: 'https://example.test', hasFieldData: false }],
      },
      CONFIG,
    )
    expect(report.findings).toHaveLength(1)
    const finding = report.findings[0]
    expect(finding?.rule).toBe('crux_no_field_data')
    /*
     * The assertion the acceptance line asks for, made against the PAYLOAD rather than against a rendered
     * string: no value of this finding is a number, so there is nothing for a panel to render as `0`.
     * ADR 0070's refusal, structurally — a shape with an optional `lcpMs` would pass every other
     * assertion in this file and would be read as zero the day somebody spread a default into it.
     */
    for (const [key, value] of Object.entries(finding ?? {})) {
      expect(typeof value, `${key} is a number, so a screen can render it as zero`).not.toBe(
        'number',
      )
    }
    expect(report.coverage.crux_no_field_data).toBe(1)
  })

  it('reports nothing for an origin that HAS field data, and still counts it as judged', () => {
    const report = coverageAnomalies(
      {
        series: [],
        crux: [
          { scope: 'origin', subject: 'https://example.test', hasFieldData: true, lcpMs: 2_100 },
        ],
      },
      CONFIG,
    )
    expect(report.findings).toEqual([])
    // The control for the case above: without it, a rule that reported `crux_no_field_data` for every
    // observation would pass, and the panel would say "no field data" about an origin that has some.
    expect(report.coverage.crux_no_field_data).toBe(1)
  })

  it('counts a series too short to have a baseline and a run as NOT judged', () => {
    const report = coverageAnomalies(
      { series: [impressions(steadyDays(10, 1, 400))], crux: [] },
      CONFIG,
    )
    expect(report.findings).toEqual([])
    // ADR 0002 on the answer rather than in a comment: zero findings over a series that could not produce
    // one is not a pass, and this is the field that says so.
    expect(report.coverage.sustained_impression_drop).toBe(0)
  })
})

describe('the rule list', () => {
  it('has a coverage counter for every rule and no counter for anything else', () => {
    const report = coverageAnomalies({ series: [], crux: [] }, CONFIG)
    expect(Object.keys(report.coverage).sort()).toEqual([...COVERAGE_ANOMALY_RULES].sort())
  })
})
