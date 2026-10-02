import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CUSTOMER_ACQUISITION_SOURCES } from '../crm/lifecycle.ts'
import { localDate } from '../time.ts'
import {
  ACQUISITION_SPEND_ACCOUNTS,
  AcquisitionSpendNotAttributable,
  acquisitionSpendRows,
  channelAttributedSpend,
  FIRST_TOUCH_PAID_CLASSIFICATION,
  firstTouchPaidStateOf,
  spendNotChannelAttributed,
} from './cac.ts'
import {
  buildRetentionCohorts,
  CohortContributionNotAttributable,
  CohortHorizonNotReached,
  CohortPeriodZeroDisagrees,
  cohortContributionRow,
  cohortRealisedWindow,
  collapseCohortMembers,
  comparableHorizon,
  realisedMonthsOf,
} from './cohorts.ts'
import type { ContributionMarginUnit } from './contribution-margin.ts'
import type { KpiInput, KpiResult, MeasuredKpi } from './kpi-expression.ts'
import { EMPTY_KPI_INPUT, isNoDenominator, wholeRational } from './kpi-expression.ts'
import { publishedFigure, resolveKpi, resolveMeasure } from './kpi-registry.ts'
import {
  assertPackageLiabilityReconciles,
  type DeferredRevenueMovement,
  MalformedEntitlement,
  packageLiabilitySchedule,
  packageLiabilityTotalFils,
  reconcilePackageLiabilityToLedger,
  remainingSessionShareFils,
} from './package-liability.ts'

/**
 * R-REP-05's pure half: the cohort grid, the realised horizon, CAC and the package liability schedule.
 *
 * Every case has a control that must fail (brief rule 3), and the controls here are all of one shape
 * because the unit is: **a figure nobody has observed must not be reachable.** So the refusals are
 * asserted to fire, and then the thing the refusal would otherwise have let through is computed by hand
 * and asserted to be a DIFFERENT number — a forecast's whole danger is that it is plausible, so showing
 * that the refused value is wrong is what makes the refusal evidence rather than taste.
 *
 * The figures are hand-computed in the comment above each assertion. Nothing here is a fact about the
 * business: the trading year is 2415, which nothing else in the repository claims.
 */

const JAN = localDate('2415-01-01')
const FEB = localDate('2415-02-01')
const MAR = localDate('2415-03-01')
const APR = localDate('2415-04-01')

const inputOf = (overrides: Partial<KpiInput>): KpiInput => ({ ...EMPTY_KPI_INPUT, ...overrides })

/** The figure, with the no-denominator case refused: a test asserting a number needs one. */
function measured(result: KpiResult): MeasuredKpi {
  if (isNoDenominator(result)) {
    throw new Error(
      `${result.kpi} answered no_denominator (divisor ${result.divisorFormula}) where a figure was ` +
        'expected',
    )
  }
  return result
}

const figureOf = (kpiId: string, input: KpiInput): MeasuredKpi =>
  measured(resolveKpi(kpiId).compute(input))

/** A delivery whose cost was fully attributable, so a contribution row may be built from it. */
const margin = (appointmentId: string, marginFils: bigint): ContributionMarginUnit => ({
  state: 'margin',
  appointmentId,
  serviceVariantId: 'variant',
  treatmentStyle: 'asian',
  netPriceFils: marginFils,
  costFils: 0n,
  marginFils,
  components: [],
  netPriceBasis: `invoice_line ${appointmentId}#1`,
})

/** A delivery whose therapist cost nothing can attribute — the ordinary state of this build. */
const unattributable = (appointmentId: string): ContributionMarginUnit => ({
  state: 'not_attributable',
  appointmentId,
  serviceVariantId: 'variant',
  treatmentStyle: 'asian',
  netPriceFils: 20_000n,
  attributedCostFils: 0n,
  missing: ['therapist', 'consumables'],
  openQuestionIds: ['Y8-staff', 'Y9-commission', 'Y9-unit-cost-basis'],
  components: [],
  netPriceBasis: `invoice_line ${appointmentId}#1`,
})

// --- the cohort grid ----------------------------------------------------------------------------

describe('retention cohorts by first-visit business month', () => {
  const members = [
    {
      customerId: 'a',
      firstVisitBusinessDay: localDate('2415-01-09'),
      firstTouch: 'paid' as const,
    },
    {
      customerId: 'b',
      firstVisitBusinessDay: localDate('2415-01-28'),
      firstTouch: 'not_recorded' as const,
    },
    {
      customerId: 'c',
      firstVisitBusinessDay: localDate('2415-02-03'),
      firstTouch: 'unpaid' as const,
    },
  ]
  const activity = [
    { customerId: 'a', activityMonth: localDate('2415-01-09') },
    { customerId: 'a', activityMonth: localDate('2415-02-14') },
    { customerId: 'b', activityMonth: localDate('2415-01-28') },
    { customerId: 'c', activityMonth: localDate('2415-02-03') },
  ]

  it("period 0's count equals the cohort size for every cohort", () => {
    const cohorts = buildRetentionCohorts({ members, activity, horizonMonths: 3 })
    expect(cohorts.map((cohort) => cohort.cohortMonth)).toEqual([JAN, FEB])
    for (const cohort of cohorts) {
      expect(cohort.periods[0]?.activeCustomers).toBe(cohort.cohortSize)
      expect(cohort.periods[0]?.retainedBasisPoints).toBe(10_000)
    }
    // January: two acquired, one of them back in February. 1/2 = 5,000 bp.
    const january = cohorts[0]
    expect(january?.cohortSize).toBe(2)
    expect(january?.periods.map((period) => period.activeCustomers)).toEqual([2, 1, 0])
    expect(january?.periods.map((period) => period.retainedBasisPoints)).toEqual([10_000, 5_000, 0])
    // Every period from 0 to the horizon, with no gaps, even the ones nobody came back in.
    expect(january?.periods.map((period) => period.month)).toEqual([JAN, FEB, MAR])
  })

  it('refuses a period 0 that disagrees with the cohort size, naming the customers', () => {
    // The control: the activity row for b's acquisition month is missing. An implementation that SET
    // period 0 to the cohort size would report 2 and go on to call February's single visit a 50%
    // retention of a cohort whose base it had just invented.
    const gapped = activity.filter((row) => row.customerId !== 'b')
    expect(() => buildRetentionCohorts({ members, activity: gapped, horizonMonths: 2 })).toThrow(
      CohortPeriodZeroDisagrees,
    )
    expect(() => buildRetentionCohorts({ members, activity: gapped, horizonMonths: 2 })).toThrow(
      /\bb\b/,
    )
  })

  it('refuses a grid with no period 0', () => {
    expect(() => buildRetentionCohorts({ members, activity, horizonMonths: 0 })).toThrow(
      /at least one period/,
    )
  })

  it('puts a merged customer in exactly one cohort — the earlier one', () => {
    // What a stale `reporting.dim_customer` looks like straight after a merge: the survivor's own row
    // and the tombstone's, both resolved to the survivor id, carrying two different first visits.
    const afterMerge = [
      {
        customerId: 'survivor',
        firstVisitBusinessDay: localDate('2415-03-11'),
        firstTouch: 'not_recorded' as const,
      },
      {
        customerId: 'survivor',
        firstVisitBusinessDay: localDate('2415-01-04'),
        firstTouch: 'paid' as const,
      },
    ]
    const collapsed = collapseCohortMembers(afterMerge)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.cohortMonth).toBe(JAN)
    // The earlier first touch travels with the earlier month, which is what A-FIRST-08's merge rule
    // says ("retains the earlier first touch"). Taking the month from one row and the touch from the
    // other would put the customer in January's cohort with March's channel.
    expect(collapsed[0]?.firstTouch).toBe('paid')

    const cohorts = buildRetentionCohorts({
      members: afterMerge,
      activity: [{ customerId: 'survivor', activityMonth: localDate('2415-01-04') }],
      horizonMonths: 1,
    })
    expect(cohorts).toHaveLength(1)
    expect(cohorts[0]?.cohortMonth).toBe(JAN)
    // The control: the LATER month is a cohort nobody is in, and a grid that took it would report a
    // March cohort of one and no January cohort at all.
    expect(cohorts.map((cohort) => cohort.cohortMonth)).not.toContain(MAR)
  })

  it('collapses the order the rows arrive in, not just one of the two orders', () => {
    const forwards = collapseCohortMembers([
      { customerId: 's', firstVisitBusinessDay: localDate('2415-01-04'), firstTouch: 'paid' },
      { customerId: 's', firstVisitBusinessDay: localDate('2415-03-11'), firstTouch: 'unpaid' },
    ])
    const backwards = collapseCohortMembers([
      { customerId: 's', firstVisitBusinessDay: localDate('2415-03-11'), firstTouch: 'unpaid' },
      { customerId: 's', firstVisitBusinessDay: localDate('2415-01-04'), firstTouch: 'paid' },
    ])
    expect(forwards).toEqual(backwards)
    expect(forwards[0]?.cohortMonth).toBe(JAN)
  })
})

// --- realised, never forecast -------------------------------------------------------------------

describe('the realised horizon', () => {
  it('counts the acquisition month and no month that has not closed', () => {
    // January acquired, March the last complete month: January, February, March — three.
    expect(realisedMonthsOf(JAN, MAR)).toBe(3)
    expect(realisedMonthsOf(MAR, MAR)).toBe(1)
    // A cohort acquired in a month that has not closed has NO realised month, which is what stops a
    // three-week-old cohort appearing in a comparison with a figure of any kind.
    expect(realisedMonthsOf(APR, MAR)).toBe(0)
  })

  it('refuses a value at a horizon the cohort has not lived', () => {
    expect(() =>
      cohortRealisedWindow({ cohortMonth: FEB, horizonMonths: 3, throughMonth: MAR }),
    ).toThrow(CohortHorizonNotReached)
    // And the control: two is exactly what February has lived, so it is allowed.
    expect(cohortRealisedWindow({ cohortMonth: FEB, horizonMonths: 2, throughMonth: MAR })).toEqual(
      [
        { cohortMonth: FEB, monthIndex: 0 },
        { cohortMonth: FEB, monthIndex: 1 },
      ],
    )
  })

  it('refuses a horizon of nothing rather than answering a value of nothing', () => {
    expect(() =>
      cohortRealisedWindow({ cohortMonth: JAN, horizonMonths: 0, throughMonth: MAR }),
    ).toThrow(/at least one month/)
  })

  it('gives a window a row per month whether the cohort spent in it or not', () => {
    const window = cohortRealisedWindow({ cohortMonth: JAN, horizonMonths: 3, throughMonth: MAR })
    expect(window.map((month) => month.monthIndex)).toEqual([0, 1, 2])
    // The whole point: the measure that divides by this counts three months, so a cohort that spent
    // in two of them has a monthly rate of two thirds of its total and not one half. Reached through
    // `resolveMeasure` and not `resolveKpi`, because a measure is not a KPI — `resolveKpi` throws
    // `UnknownKpi` for one, which is the registry refusing to render a fold as a published figure.
    expect(
      resolveMeasure('cohort_realised_months')?.reduce(inputOf({ cohortMonths: window })),
    ).toBe(3n)
  })

  it('compares cohorts only at a horizon all of them have reached', () => {
    // January has three months and March has one, so the comparable horizon is one. Reading
    // January's three-month figure beside March's one-month figure in a column headed LTV is the
    // planning error this unit is about, and the youngest cohort always looks worst.
    expect(comparableHorizon([JAN, FEB, MAR], MAR)).toBe(1)
    // A set containing a cohort with no realised month has nothing to compare, not a small number.
    expect(comparableHorizon([JAN, APR], MAR)).toBe(0)
    expect(comparableHorizon([], MAR)).toBe(0)
  })
})

// --- a contribution row, which cannot exist for an unattributable cost --------------------------

describe('a cohort contribution row', () => {
  it('sums the margins of the deliveries that produced it', () => {
    const row = cohortContributionRow({
      cohortMonth: JAN,
      monthIndex: 1,
      customerId: 'a',
      units: [margin('appt-1', 12_000n), margin('appt-2', 8_000n)],
    })
    expect(row).toEqual({
      cohortMonth: JAN,
      monthIndex: 1,
      customerId: 'a',
      netContributionFils: 20_000n,
    })
  })

  it('refuses a delivery whose cost nothing can attribute, naming the open questions', () => {
    // The control, and the whole of ADR 0070 reaching this unit: the net price of those deliveries is
    // 40,000 fils, so a module that fell back to revenue would have reported 40,000 — twice what the
    // one attributable delivery actually contributed, on the figure an acquisition budget is set from.
    const units = [margin('appt-1', 20_000n), unattributable('appt-2')]
    expect(() =>
      cohortContributionRow({ cohortMonth: JAN, monthIndex: 0, customerId: 'a', units }),
    ).toThrow(CohortContributionNotAttributable)
    expect(() =>
      cohortContributionRow({ cohortMonth: JAN, monthIndex: 0, customerId: 'a', units }),
    ).toThrow(/Y9-unit-cost-basis/)
  })

  it('refuses an empty delivery list rather than contributing a zero', () => {
    expect(() =>
      cohortContributionRow({ cohortMonth: JAN, monthIndex: 2, customerId: 'a', units: [] }),
    ).toThrow(/no delivery/)
  })

  it('refuses a month index that is not a whole number of months', () => {
    expect(() =>
      cohortContributionRow({
        cohortMonth: JAN,
        monthIndex: -1,
        customerId: 'a',
        units: [margin('appt-1', 1n)],
      }),
    ).toThrow(/whole number of months/)
  })
})

// --- the realised value, and the figures that divide by it --------------------------------------

/**
 * One cohort, two customers, two realised months, hand-computed.
 *
 *   contribution: a month 0 = 40,000, a month 1 = 20,000, b month 0 = 10,000  ->  70,000 fils
 *   customers: 2  ->  realised value per customer = 35,000 fils
 *   realised months: 2  ->  monthly contribution per customer = 17,500 fils
 *   paid-channel spend in January: 30,000; new customers from a paid channel: 1 (a)  ->  CAC 30,000
 *   unattributed first touch: 1 of 2  ->  0.5000
 *   payback: 30,000 / 17,500 = 12/7 months  ->  1.7
 */
const WORKED: KpiInput = inputOf({
  cohortMembers: [
    { customerId: 'a', cohortMonth: JAN, firstTouch: 'paid' },
    { customerId: 'b', cohortMonth: JAN, firstTouch: 'not_recorded' },
  ],
  cohortMonths: [
    { cohortMonth: JAN, monthIndex: 0 },
    { cohortMonth: JAN, monthIndex: 1 },
  ],
  cohortContributions: [
    { cohortMonth: JAN, monthIndex: 0, customerId: 'a', netContributionFils: 40_000n },
    { cohortMonth: JAN, monthIndex: 1, customerId: 'a', netContributionFils: 20_000n },
    { cohortMonth: JAN, monthIndex: 0, customerId: 'b', netContributionFils: 10_000n },
  ],
  acquisitionSpend: [{ cohortMonth: JAN, channel: 'probe', netFils: 30_000n }],
})

describe('the realised value of a cohort', () => {
  it('is the cumulative realised contribution per customer, to the fils', () => {
    const value = figureOf('cohort_realised_value_per_customer', WORKED)
    expect(value.value).toEqual(wholeRational(35_000n))
    expect(publishedFigure(value)).toBe('35000')
    expect(value.unit).toBe('fils_per_customer')
    // The formula is rendered from the expression the figure was computed from, so it names both.
    expect(value.formula).toBe('cohort_realised_net_contribution_fils ÷ cohort_customers')
  })

  it('drops a contribution for a month past the window rather than extending the horizon', () => {
    // The control: 99,000 fils of month-2 contribution is in the input and is NOT in the figure. An
    // implementation that summed what it was handed would have answered (70,000 + 99,000) / 2 =
    // 84,500 — a cohort worth two and a half times what it has actually produced, over two months
    // that had closed and one that had not.
    const withFuture = inputOf({
      ...WORKED,
      cohortContributions: [
        ...WORKED.cohortContributions,
        { cohortMonth: JAN, monthIndex: 2, customerId: 'a', netContributionFils: 99_000n },
      ],
    })
    expect(figureOf('cohort_realised_value_per_customer', withFuture).value).toEqual(
      wholeRational(35_000n),
    )
    expect(figureOf('cohort_realised_value_per_customer', withFuture).value).not.toEqual(
      wholeRational(84_500n),
    )
  })

  it('counts a month the cohort spent nothing in', () => {
    // Three months lived, two of them with spend: 70,000 / 2 customers / 3 months = 11,666.67, which
    // publishes as 11,667 and NOT as the 17,500 a denominator of "months with revenue" would give.
    const threeMonths = inputOf({
      ...WORKED,
      cohortMonths: [...WORKED.cohortMonths, { cohortMonth: JAN, monthIndex: 2 }],
    })
    const monthly = figureOf('cohort_monthly_contribution_per_customer', threeMonths)
    expect(publishedFigure(monthly)).toBe('11667')
    expect(publishedFigure(monthly)).not.toBe('17500')
  })

  it('answers no_denominator for a cohort with no customers rather than a value of zero', () => {
    const empty = resolveKpi('cohort_realised_value_per_customer').compute(
      inputOf({ cohortMonths: [{ cohortMonth: JAN, monthIndex: 0 }] }),
    )
    expect(isNoDenominator(empty)).toBe(true)
    if (isNoDenominator(empty)) expect(empty.divisorFormula).toBe('cohort_customers')
  })
})

// --- CAC, its payback and the share nobody can attribute ----------------------------------------

describe('CAC and its payback', () => {
  it('counts only the new customers whose first touch was paid', () => {
    const cac = figureOf('customer_acquisition_cost', WORKED)
    expect(cac.value).toEqual(wholeRational(30_000n))
    expect(cac.unit).toBe('fils_per_customer')
    // The control: both customers are new, so a denominator that counted every new customer would
    // have answered 15,000 — half the real cost, on the figure a marketing budget is set from.
    expect(cac.value).not.toEqual(wholeRational(15_000n))
    expect(cac.provisional?.openQuestionId).toBe('Y9-paid-channel-attribution')
  })

  it('reports the unattributed share beside it, on a fixture with a known unattributed count', () => {
    // One of the two has no recorded channel. 0.5000, read as 5,000 basis points.
    const share = figureOf('acquisition_unattributed_share', WORKED)
    expect(share.value).toEqual({ numerator: 1n, denominator: 2n })
    expect(publishedFigure(share)).toBe('0.5000')
    expect(share.unit).toBe('ratio')
  })

  it('counts only the spend of the ACQUISITION month, not the whole window', () => {
    // 77,000 spent in February is not part of what January's cohort cost to win. An implementation
    // that summed the window would answer 107,000 and would rise the longer the cohort was observed.
    const laterSpend = inputOf({
      ...WORKED,
      acquisitionSpend: [
        ...WORKED.acquisitionSpend,
        { cohortMonth: FEB, channel: 'probe', netFils: 77_000n },
      ],
    })
    expect(figureOf('customer_acquisition_cost', laterSpend).value).toEqual(wholeRational(30_000n))
  })

  it("is months of the cohort's own realised rate, to one decimal place", () => {
    // 30,000 / 17,500 = 12/7 months.
    const payback = figureOf('cac_payback_months', WORKED)
    expect(payback.value).toEqual({ numerator: 12n, denominator: 7n })
    expect(publishedFigure(payback)).toBe('1.7')
    expect(payback.unit).toBe('months')
  })

  it('returns NoDenominator when the contribution is zero', () => {
    // The acceptance line, exactly. A cohort that has contributed nothing has no payback — not a
    // payback of nought, and not one of infinity months.
    const noContribution = inputOf({ ...WORKED, cohortContributions: [] })
    const payback = resolveKpi('cac_payback_months').compute(noContribution)
    expect(isNoDenominator(payback)).toBe(true)
    // The divisor names the KPI that was empty, one level deep, which is what makes the answer say
    // WHICH denominator was zero — a payback with no contribution and a payback with no acquisition
    // cost are different operational facts (ADR 0068).
    if (isNoDenominator(payback)) {
      expect(payback.divisorFormula).toBe('cohort_monthly_contribution_per_customer')
    }
    // And the control: bigint division cannot produce a non-finite value, so even a figure read
    // without narrowing cannot be NaN or Infinity.
    expect(payback.kind).toBe('no_denominator')
  })

  it('answers no_denominator for CAC when no new customer has a paid first touch', () => {
    // Which is the state of this build: FIRST_TOUCH_PAID_CLASSIFICATION classifies all six labels as
    // not_recorded, so no row the db query produces can be `paid`.
    const noPaid = inputOf({
      ...WORKED,
      cohortMembers: WORKED.cohortMembers.map((member) => ({
        ...member,
        firstTouch: 'not_recorded' as const,
      })),
    })
    const cac = resolveKpi('customer_acquisition_cost').compute(noPaid)
    expect(isNoDenominator(cac)).toBe(true)
    if (isNoDenominator(cac)) expect(cac.divisorFormula).toBe('new_customers_from_paid_channels')
    // The share, meanwhile, is the whole of it — which is the figure that says why.
    expect(publishedFigure(figureOf('acquisition_unattributed_share', noPaid))).toBe('1.0000')
  })
})

describe('the first-touch classification', () => {
  it('covers every acquisition label with a stated reason, and records none of them as paid', () => {
    for (const source of CUSTOMER_ACQUISITION_SOURCES) {
      const entry = FIRST_TOUCH_PAID_CLASSIFICATION[source]
      expect(entry.why.trim().length).toBeGreaterThan(20)
      expect(firstTouchPaidStateOf(source)).toBe('not_recorded')
    }
    // Totality is a typecheck (a Record over the union), so what is asserted here is the direction a
    // type cannot see: that no label was quietly given an answer. `unpaid` would be the claim that
    // these customers cost nothing to acquire; `paid` would be an attribution nobody recorded.
    const states = new Set(
      CUSTOMER_ACQUISITION_SOURCES.map((source) => firstTouchPaidStateOf(source)),
    )
    expect([...states]).toEqual(['not_recorded'])
    expect(Object.keys(FIRST_TOUCH_PAID_CLASSIFICATION)).toHaveLength(
      CUSTOMER_ACQUISITION_SOURCES.length,
    )
  })

  it('names the one marketing account and nothing else', () => {
    expect(ACQUISITION_SPEND_ACCOUNTS).toEqual(['6070'])
  })
})

describe('acquisition spend', () => {
  it('refuses a marketing total that no channel claims', () => {
    const statement = spendNotChannelAttributed(
      250_000n,
      'the 6070 movement for the period; no cost table carries a marketing channel',
    )
    expect(() => acquisitionSpendRows(statement)).toThrow(AcquisitionSpendNotAttributable)
    expect(() => acquisitionSpendRows(statement)).toThrow(/250000/)
    // The control: a channel-attributed statement of the SAME money yields rows and a CAC. So the
    // refusal is about the attribution and not about the figure being absent.
    const attributed = channelAttributedSpend(
      [{ cohortMonth: JAN, channel: 'search', netFils: 250_000n }],
      'two bill lines tagged to search',
    )
    expect(acquisitionSpendRows(attributed)).toHaveLength(1)
  })

  it('is a measured zero when nothing was spent, which is a figure and not a refusal', () => {
    const nothing = channelAttributedSpend([], 'zero postings on 6070 in the period, measured')
    expect(acquisitionSpendRows(nothing)).toEqual([])
    expect(
      figureOf('customer_acquisition_cost', inputOf({ ...WORKED, acquisitionSpend: [] })).value,
    ).toEqual(wholeRational(0n))
  })

  it('refuses a row with a blank channel, a negative figure, or no basis', () => {
    expect(() =>
      channelAttributedSpend([{ cohortMonth: JAN, channel: '  ', netFils: 1n }], 'basis'),
    ).toThrow(/names no channel/)
    expect(() =>
      channelAttributedSpend([{ cohortMonth: JAN, channel: 'search', netFils: -1n }], 'basis'),
    ).toThrow(/negative/)
    expect(() => channelAttributedSpend([], '   ')).toThrow(/stated basis/)
    expect(() => spendNotChannelAttributed(1n, 'basis', [])).toThrow(/open question/)
  })
})

// --- the outstanding package liability ----------------------------------------------------------

/** `ceil(a ÷ b)` for non-negative `bigint`s — the release formula's own rounding, for the control. */
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

describe('the outstanding package liability', () => {
  it("is the release formula's own complement, and not a rounded per-session price", () => {
    // Three sessions on 10,000 fils, one taken. The release formula gives ceil(10,000 x 1 / 3) =
    // 3,334, so 6,666 remains. A per-session price of round(10,000/3) = 3,333 times two sessions
    // gives 6,666 here and 3,333 with two taken, where the truth is 3,333 — the residue lands on a
    // different session each time, which is the whole reason largest-remainder allocation exists.
    expect(remainingSessionShareFils(10_000n, 3, 2)).toBe(6_666n)
    expect(10_000n - ceilDiv(10_000n * 1n, 3n)).toBe(6_666n)
    expect(remainingSessionShareFils(10_000n, 3, 1)).toBe(3_333n)
    expect(remainingSessionShareFils(10_000n, 3, 0)).toBe(0n)
    expect(remainingSessionShareFils(10_000n, 3, 3)).toBe(10_000n)
  })

  it('equals value − released for every balance the release formula wrote', () => {
    // The identity the tie to 2050 rests on: for whole `v`,
    //   v − ceil(v·r/n) = v + floor(−v·r/n) = floor(v·(n−r)/n).
    // Counted rather than claimed (brief rule 22): the cases that could disagree are the ones where
    // `v·r` is not a multiple of `n`, and the floor below is measured, not guessed.
    let rounding = 0
    let total = 0
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 100_000_000n }),
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: 0, max: 24 }),
        (valueFils, sessionsTotal, redeemedDraw) => {
          const redeemed = redeemedDraw % (sessionsTotal + 1)
          const remaining = sessionsTotal - redeemed
          total += 1
          if ((valueFils * BigInt(redeemed)) % BigInt(sessionsTotal) !== 0n) rounding += 1
          expect(remainingSessionShareFils(valueFils, sessionsTotal, remaining)).toBe(
            valueFils - ceilDiv(valueFils * BigInt(redeemed), BigInt(sessionsTotal)),
          )
        },
      ),
      { numRuns: 500 },
    )
    // MEASURED over twelve runs of this generator: 268, 277, 287, 292, 296, 297, 298, 302, 307, 307,
    // 312 and 316 of 500 cases had a non-zero remainder. The floor is 200 — well under the lowest
    // observed — because a floor set just under the minimum becomes its own flake (brief rule 22).
    // The point of the count is that the identity is exercised where it COULD fail rather than only
    // where both sides divide exactly: a generator that drew `redeemed` as 0, or `sessionsTotal` as
    // 1, would satisfy the property for any implementation that returned `valueFils` unchanged.
    expect(total).toBe(500)
    expect(rounding).toBeGreaterThan(200)
  }, 30_000)

  it('refuses an entitlement that is not one', () => {
    expect(() => remainingSessionShareFils(1_000n, 0, 0)).toThrow(MalformedEntitlement)
    expect(() => remainingSessionShareFils(1_000n, 3, 4)).toThrow(/cannot owe more than it sold/)
    expect(() => remainingSessionShareFils(-1n, 3, 1)).toThrow(/wrong way/)
    expect(() => remainingSessionShareFils(1_000n, 3, 1.5)).toThrow(/not a count/)
  })

  it('ties the schedule to 2050 and to sold − released, to the fils', () => {
    const entitlements = [
      {
        packageSaleId: 'sale-1',
        balanceId: 'balance-1',
        sessionsTotal: 3,
        sessionsRemaining: 2,
        valueFils: 10_000n,
      },
      {
        packageSaleId: 'sale-1',
        balanceId: 'balance-2',
        sessionsTotal: 6,
        sessionsRemaining: 4,
        valueFils: 60_000n,
      },
    ]
    // 6,666 + 40,000 = 46,666 fils outstanding over 6 remaining sessions.
    const lines = packageLiabilitySchedule(entitlements)
    expect(packageLiabilityTotalFils(lines)).toBe(46_666n)

    // The imported half is on the opening_balance source, which is what H-MIG-03 posts. A scope of
    // `package_sale, package_redemption` alone would leave the first line out by the import.
    const ledger: DeferredRevenueMovement = {
      packageSaleFils: 70_000n,
      packageRedemptionFils: -23_334n,
      openingBalanceFils: 0n,
      otherFils: 0n,
    }
    const reconciliation = reconcilePackageLiabilityToLedger({
      lines,
      ledger,
      soldLessReleasedFils: 46_666n,
    })
    expect(reconciliation.outstandingFils).toBe(46_666n)
    expect(reconciliation.sessionsRemaining).toBe(6)
    expect(reconciliation.variances).toEqual([])
    expect(reconciliation.checked).toHaveLength(3)
    expect(() => assertPackageLiabilityReconciles(reconciliation)).not.toThrow()
    expect(reconciliation.provisional.openQuestionId).toBe('Y9-package-policy')
  })

  it('names the opening-balance source rather than dropping it', () => {
    // The control for the scope: the same schedule against a ledger where the whole liability came in
    // as an opening balance. A reconciliation scoped to the till's two sources would report the first
    // line out by 46,666 fils with a message naming neither the import nor the scope.
    const lines = packageLiabilitySchedule([
      {
        packageSaleId: 'sale-1',
        balanceId: 'balance-1',
        sessionsTotal: 6,
        sessionsRemaining: 6,
        valueFils: 46_666n,
      },
    ])
    const reconciliation = reconcilePackageLiabilityToLedger({
      lines,
      ledger: {
        packageSaleFils: 0n,
        packageRedemptionFils: 0n,
        openingBalanceFils: 46_666n,
        otherFils: 0n,
      },
      soldLessReleasedFils: 46_666n,
    })
    expect(reconciliation.variances).toEqual([])
  })

  it('reports a posting to 2050 from outside the package path as a named variance', () => {
    const lines = packageLiabilitySchedule([
      {
        packageSaleId: 'sale-1',
        balanceId: 'balance-1',
        sessionsTotal: 2,
        sessionsRemaining: 1,
        valueFils: 2_000n,
      },
    ])
    const reconciliation = reconcilePackageLiabilityToLedger({
      lines,
      ledger: {
        packageSaleFils: 2_000n,
        packageRedemptionFils: -1_000n,
        openingBalanceFils: 0n,
        otherFils: 5_000n,
      },
      soldLessReleasedFils: 1_000n,
    })
    expect(reconciliation.variances.map((variance) => variance.line)).toEqual([
      'deferred_revenue_postings_from_outside_the_package_path',
    ])
    expect(() => assertPackageLiabilityReconciles(reconciliation)).toThrow(
      /outside_the_package_path is out by -5000 fils/,
    )
  })

  it('reports a balance row that disagrees with its sale as its own line', () => {
    const lines = packageLiabilitySchedule([
      {
        packageSaleId: 'sale-1',
        balanceId: 'balance-1',
        sessionsTotal: 2,
        sessionsRemaining: 1,
        valueFils: 2_000n,
      },
    ])
    const reconciliation = reconcilePackageLiabilityToLedger({
      lines,
      ledger: {
        packageSaleFils: 2_000n,
        packageRedemptionFils: -1_000n,
        openingBalanceFils: 0n,
        otherFils: 0n,
      },
      // The sale says 1,500 is outstanding and the balances say 1,000: the sale-level figure cannot
      // see which balance is wrong and the session-level one can.
      soldLessReleasedFils: 1_500n,
    })
    expect(reconciliation.variances.map((variance) => variance.line)).toEqual([
      'session_schedule_against_sold_less_released',
    ])
  })

  it('publishes the liability as a figure with a rendered formula', () => {
    const figure = figureOf(
      'outstanding_package_liability',
      inputOf({
        packageEntitlements: [
          {
            packageSaleId: 'sale-1',
            balanceId: 'balance-1',
            sessionsTotal: 3,
            sessionsRemaining: 2,
            valueFils: 10_000n,
          },
        ],
      }),
    )
    expect(figure.value).toEqual(wholeRational(6_666n))
    expect(figure.unit).toBe('fils')
    expect(figure.formula).toBe('outstanding_package_liability_fils')
    // A sum over an empty set is nought here and is RIGHT to be: no package sold is no liability.
    // Available to it because it is a sum and not a division (ADR 0070's two measured zeros).
    expect(figureOf('outstanding_package_liability', EMPTY_KPI_INPUT).value).toEqual(
      wholeRational(0n),
    )
  })
})

// --- the registry holds all six, and the units follow from the arithmetic ------------------------

describe('the six KPIs this unit registers', () => {
  const ids = [
    'cohort_realised_value_per_customer',
    'cohort_monthly_contribution_per_customer',
    'customer_acquisition_cost',
    'acquisition_unattributed_share',
    'cac_payback_months',
    'outstanding_package_liability',
  ] as const

  it('are reachable through the ONE registry, with a label, a summary and a formula', () => {
    for (const id of ids) {
      const kpi = resolveKpi(id)
      expect(kpi.label.trim()).not.toBe('')
      expect(kpi.summary.trim()).not.toBe('')
      expect(kpi.formula.trim()).not.toBe('')
      expect(kpi.expandedFormula.trim()).not.toBe('')
    }
  })

  it('expand all the way down to their measures', () => {
    // The expansion is what a reader follows instead of chasing references by hand, and a renderer
    // that dropped a reference would be invisible in the one-level formula.
    expect(resolveKpi('cac_payback_months').expandedFormula).toBe(
      '(paid_channel_acquisition_spend_fils ÷ new_customers_from_paid_channels) ÷ ' +
        '((cohort_realised_net_contribution_fils ÷ cohort_customers) ÷ cohort_realised_months)',
    )
  })

  it('are pure: the same input gives the same answer', () => {
    for (const id of ids) {
      expect(resolveKpi(id).compute(WORKED)).toEqual(resolveKpi(id).compute(WORKED))
    }
  })
})
