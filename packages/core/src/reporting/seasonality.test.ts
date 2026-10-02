import { describe, expect, it } from 'vitest'
import { horizonDates } from '../business-day/horizon.ts'
import { ACCOUNTS } from '../ledger/chart-of-accounts.ts'
import { type LocalDate, localDate } from '../time.ts'
import { EMPTY_KPI_INPUT, type KpiInput } from './kpi-expression.ts'
import { buildKpiRegistry, KPI_MEASURES, KPI_SPECS, resolveKpi } from './kpi-registry.ts'
import { REVENUE_PER_AVAILABLE_ROOM_HOUR } from './revpar.ts'
import type { SeasonalityDay, SeasonalityInput } from './seasonality.ts'
import {
  MINIMUM_SEASONALITY_OCCURRENCES,
  OBSERVANCE_IMPACT_SIDES,
  observanceImpact,
  publishedIndex,
  SEASONALITY_BUCKETS,
  seasonalityIndex,
  seasonalityModel,
} from './seasonality.ts'

/**
 * R-REP-06 — the seasonality model.
 *
 * # What this file is arranged to prove
 *
 * The acceptance line names Ramadan and the summer exodus, and the DATES of the first are
 * `Y9-holiday-calendar` and are not this build's to invent. So nothing here asserts a date. What it
 * asserts is:
 *
 *   1. **An index of 1.00 is never returned for want of evidence.** A flat index and "we have not traded
 *      through two Ramadans" are the same number and different claims, and only one of them survives the
 *      first Ramadan. Every case that gets an index does so over a fixture with two separated
 *      occurrences, and the case with one occurrence asserts `no_data` naming its count.
 *   2. **The denominator is `openMinutes` and nothing else.** The same fixture with a different
 *      `openMinutes` produces a different index, and the figures are hand-computed — which is the pure
 *      half of the third acceptance line. The database half, a `premises_hours_override` row changing it
 *      with no code change, is `packages/fixtures/src/cash-forecast.itest.ts`'.
 *   3. **The observance impact is reported twice and is never blended.** Asserted on the KEY SET, so a
 *      `total` added to the type fails this file by name.
 *   4. **A lunar date presented as settled is refused** rather than filed on the confirmed side, which is
 *      where nobody would know to doubt it.
 */

// --- the fixture ---------------------------------------------------------------------------------

const DAY_ONE = localDate('2027-03-01')
const DAYS: readonly LocalDate[] = horizonDates(DAY_ONE, 20)

const ROOM_A = 'room-a'
const ROOM_B = 'room-b'

/** 900 minutes — 11:00 to 02:00, which is what `premises_hours` holds today. */
const FIFTEEN_HOURS = 900
/** 720 minutes — a 14:00 to 02:00 Ramadan schedule, as an hours override would produce. */
const TWELVE_HOURS = 720

const day = (
  at: number,
  overrides: Partial<Omit<SeasonalityDay, 'businessDay'>> = {},
): SeasonalityDay => {
  const businessDay = DAYS[at]
  if (businessDay === undefined) throw new Error(`day ${at} is outside the fixture`)
  return {
    businessDay,
    openMinutes: FIFTEEN_HOURS,
    isRamadan: false,
    ramadanIsProvisional: false,
    isPublicHoliday: false,
    publicHolidayIsProvisional: false,
    publicHolidayIsLunarDated: false,
    publicHolidayNames: null,
    monthOfYear: 3,
    ...overrides,
  }
}

/** A Ramadan trading day: the flags `dim_date` carries, with the date provisional as 0110 requires. */
const ramadanDay = (at: number, openMinutes = TWELVE_HOURS): SeasonalityDay =>
  day(at, { isRamadan: true, ramadanIsProvisional: true, openMinutes })

const inputOf = (
  days: readonly SeasonalityDay[],
  revenueByDay: ReadonlyMap<string, bigint>,
  options: { readonly summerMonths?: readonly number[]; readonly minimumOccurrences?: number } = {},
): SeasonalityInput => {
  const kpiInput: KpiInput = {
    ...EMPTY_KPI_INPUT,
    businessDays: days.map((entry) => ({
      businessDay: entry.businessDay,
      openMinutes: entry.openMinutes,
    })),
    roomDays: days.flatMap((entry) => [
      { businessDay: entry.businessDay, roomId: ROOM_A },
      { businessDay: entry.businessDay, roomId: ROOM_B },
    ]),
    revenueLines: days
      .filter((entry) => revenueByDay.has(entry.businessDay as string))
      .map((entry) => ({
        businessDay: entry.businessDay,
        accountCode: ACCOUNTS.treatmentRevenue,
        netFils: revenueByDay.get(entry.businessDay as string) ?? 0n,
      })),
  }
  return {
    days,
    kpiInput,
    summerMonths: options.summerMonths ?? [7, 8],
    minimumOccurrences: options.minimumOccurrences ?? MINIMUM_SEASONALITY_OCCURRENCES,
  }
}

const revenue = (entries: readonly (readonly [number, bigint])[]): ReadonlyMap<string, bigint> =>
  new Map(
    entries.map(([at, fils]) => {
      const date = DAYS[at]
      if (date === undefined) throw new Error(`day ${at} is outside the fixture`)
      return [date as string, fils]
    }),
  )

/**
 * Two separated Ramadan runs, each of two trading days, with a baseline either side.
 *
 * Two runs rather than one, because `MINIMUM_SEASONALITY_OCCURRENCES` is 2 and this fixture exists to get
 * PAST that floor — a one-run version of it is the `no_data` case below. Two days per run rather than
 * thirty, because the floor is in occurrences and not in days, and a thirty-day fixture would make the
 * hand-computed figures unreadable without proving anything the two-day one does not.
 */
const TWO_RAMADANS: readonly SeasonalityDay[] = [
  day(0),
  day(1),
  ramadanDay(2),
  ramadanDay(3),
  day(4),
  day(5),
  ramadanDay(6),
  ramadanDay(7),
  day(8),
  day(9),
]

describe('the seasonality index', () => {
  /**
   * Hand-computed, in fils and minutes.
   *
   * Baseline: 6 trading days × 2 rooms × 900 minutes = 10,800 room-minutes = 180 room-hours.
   *           Revenue 6 × 300,000 = 1,800,000 fils. RevPARH = 1,800,000 / 180 = 10,000 fils/room-hour.
   * Ramadan:  4 trading days × 2 rooms × 720 minutes =  5,760 room-minutes =  96 room-hours.
   *           Revenue 4 × 120,000 =   480,000 fils. RevPARH =   480,000 /  96 =  5,000 fils/room-hour.
   * Index   =  5,000 / 10,000 = 1/2, published as 0.5000.
   *
   * The Ramadan days are open for FEWER minutes, which is the point: a raw revenue ratio would be
   * 480,000 / 1,800,000 = 0.2667 and would report the reduced hours as reduced demand. The index says
   * demand per room-hour halved; the hours say the premises was open 80% as long.
   */
  it('is RevPARH over the bucket divided by RevPARH over the baseline, hand-computed', () => {
    const input = inputOf(
      TWO_RAMADANS,
      revenue([
        [0, 300_000n],
        [1, 300_000n],
        [2, 120_000n],
        [3, 120_000n],
        [4, 300_000n],
        [5, 300_000n],
        [6, 120_000n],
        [7, 120_000n],
        [8, 300_000n],
        [9, 300_000n],
      ]),
    )
    const outcome = seasonalityIndex('ramadan', input)
    expect(outcome.state).toBe('value')
    if (outcome.state !== 'value') throw new Error('expected an index')
    expect(outcome.value.index).toEqual({ numerator: 1n, denominator: 2n })
    expect(publishedIndex(outcome.value)).toBe('0.5000')
    expect(outcome.value.bucketRevparh).toEqual({ numerator: 5_000n, denominator: 1n })
    expect(outcome.value.baselineRevparh).toEqual({ numerator: 10_000n, denominator: 1n })
    expect(outcome.value.bucketTradingDays).toBe(4)
    expect(outcome.value.baselineTradingDays).toBe(6)
    expect(outcome.value.bucketOccurrences).toBe(2)
    // The dates are provisional, which `dim_date` carries and the index reports rather than hides.
    expect(outcome.value.restsOnProvisionalDates).toBe(true)
  })

  /**
   * The acceptance line "Ramadan weeks take their room-hour denominator from premises_hours", proved in
   * the pure layer by changing nothing but the minutes.
   *
   * Same days, same revenue, same rooms. Ramadan open for 900 minutes instead of 720:
   *   4 × 2 × 900 = 7,200 room-minutes = 120 room-hours; 480,000 / 120 = 4,000 fils/room-hour.
   *   Index = 4,000 / 10,000 = 2/5, published as 0.4000.
   *
   * ADR 0068's argument applies here and is the reason this case exists: fifteen hours is the right
   * answer today, so an implementation that multiplied a day count by 900 would pass the case above and
   * fail this one. The database half — an hours override row doing it with no code change — is the
   * integration suite's.
   */
  it('changes when the open minutes change, and by exactly the ratio of the minutes', () => {
    const rows = revenue([
      [0, 300_000n],
      [1, 300_000n],
      [2, 120_000n],
      [3, 120_000n],
      [4, 300_000n],
      [5, 300_000n],
      [6, 120_000n],
      [7, 120_000n],
      [8, 300_000n],
      [9, 300_000n],
    ])
    const reducedHours = seasonalityIndex('ramadan', inputOf(TWO_RAMADANS, rows))
    const fullHours = seasonalityIndex(
      'ramadan',
      inputOf(
        TWO_RAMADANS.map((entry) =>
          entry.isRamadan ? { ...entry, openMinutes: FIFTEEN_HOURS } : entry,
        ),
        rows,
      ),
    )
    if (reducedHours.state !== 'value' || fullHours.state !== 'value') {
      throw new Error('expected two indices')
    }
    expect(publishedIndex(reducedHours.value)).toBe('0.5000')
    expect(publishedIndex(fullHours.value)).toBe('0.4000')
    // 720/900 = 4/5, and the index moved by exactly 5/4. Asserted as a ratio rather than as two strings,
    // so the case is about the denominator and not about the formatting.
    expect(reducedHours.value.index).toEqual({ numerator: 1n, denominator: 2n })
    expect(fullHours.value.index).toEqual({ numerator: 2n, denominator: 5n })
  })

  /**
   * The case this module exists for.
   *
   * ONE Ramadan run, which is what a business with weeks of history has at best — and the answer is
   * `no_data` naming the count, never the 1.00 a screen would render as "not seasonal".
   */
  it('returns no_data naming its observation count, never a flat index, below the occurrence floor', () => {
    const oneRun = [day(0), day(1), ramadanDay(2), ramadanDay(3), day(4), day(5)]
    const outcome = seasonalityIndex(
      'ramadan',
      inputOf(
        oneRun,
        revenue([
          [0, 300_000n],
          [1, 300_000n],
          [2, 120_000n],
          [3, 120_000n],
          [4, 300_000n],
          [5, 300_000n],
        ]),
      ),
    )
    expect(outcome.state).toBe('no_data')
    if (outcome.state !== 'no_data') throw new Error('expected no_data')
    expect(outcome.missingFigures).toEqual(['ramadan: 1 of 2 occurrences observed'])
    expect(outcome.why).toContain('flat 1.00')
    // And the control: the same fixture with NO Ramadan day at all is also no_data, with a count of
    // zero — so "we have not observed it" and "we observed it once" are both refusals and are
    // distinguishable from each other.
    const none = seasonalityIndex('ramadan', inputOf([day(0), day(1)], revenue([[0, 1n]])))
    expect(none.state).toBe('no_data')
    expect(none.state === 'no_data' ? none.missingFigures : []).toEqual([
      'ramadan: 0 of 2 occurrences observed',
    ])
  })

  it('counts a run broken only by a non-trading day as ONE occurrence', () => {
    // A date the premises did not trade on has no `dim_date` row at all (ADR 0060), so days 2 and 4 are
    // adjacent in the ORDERED trading calendar even though a calendar day sits between them. The closure
    // did not make it two Ramadans.
    const withGap = [day(0), ramadanDay(2), ramadanDay(4), day(5)]
    const outcome = seasonalityIndex('ramadan', inputOf(withGap, revenue([[0, 1n]])))
    expect(outcome.state === 'no_data' ? outcome.missingFigures : []).toEqual([
      'ramadan: 1 of 2 occurrences observed',
    ])
  })

  it('answers no_denominator rather than an index when there is no baseline to measure against', () => {
    const everyDayRamadan = [ramadanDay(0), day(1, { monthOfYear: 7 }), ramadanDay(2)]
    const outcome = seasonalityIndex(
      'ramadan',
      inputOf(everyDayRamadan, revenue([[0, 1n]]), { minimumOccurrences: 1 }),
    )
    expect(outcome.state).toBe('no_denominator')
    expect(outcome.state === 'no_denominator' ? outcome.why : '').toContain('no baseline')
  })

  it('answers no_denominator rather than an index when the baseline earned nothing per room-hour', () => {
    const outcome = seasonalityIndex(
      'ramadan',
      inputOf(
        TWO_RAMADANS,
        revenue([
          [2, 120_000n],
          [3, 120_000n],
          [6, 120_000n],
          [7, 120_000n],
        ]),
      ),
    )
    expect(outcome.state).toBe('no_denominator')
    expect(outcome.state === 'no_denominator' ? outcome.why : '').toContain('no normal')
  })

  it('measures the summer window the caller supplies, and nothing it chose itself', () => {
    // July and August are the provisional window and they are an ARGUMENT: the same days answered against
    // a different window select a different bucket, with no change here.
    const julyDays = [
      day(0, { monthOfYear: 7 }),
      day(1, { monthOfYear: 3 }),
      day(2, { monthOfYear: 7 }),
      day(3, { monthOfYear: 3 }),
    ]
    const rows = revenue([
      [0, 100_000n],
      [1, 300_000n],
      [2, 100_000n],
      [3, 300_000n],
    ])
    const inJuly = seasonalityIndex('summer', inputOf(julyDays, rows, { summerMonths: [7, 8] }))
    expect(inJuly.state).toBe('value')
    // 2 days × 2 rooms × 900 = 60 room-hours each side. 200,000/60 over 600,000/60 = 1/3.
    expect(inJuly.state === 'value' ? inJuly.value.index : null).toEqual({
      numerator: 1n,
      denominator: 3n,
    })
    const inMarch = seasonalityIndex('summer', inputOf(julyDays, rows, { summerMonths: [3] }))
    expect(inMarch.state === 'value' ? inMarch.value.index : null).toEqual({
      numerator: 3n,
      denominator: 1n,
    })
    expect(() =>
      seasonalityIndex('summer', inputOf(julyDays, rows, { summerMonths: [13] })),
    ).toThrow(/not a calendar month/)
  })

  it('measures the baseline as the days in NO bucket, so two buckets are not each other reciprocals', () => {
    // A day that is both in the summer window and a Ramadan day is in both buckets and in neither
    // baseline. Were the baseline "every day not in this bucket", the Ramadan index would be measured
    // partly against the summer and the summer index partly against Ramadan.
    const overlapping = [
      ramadanDay(0, FIFTEEN_HOURS),
      day(1, { monthOfYear: 7 }),
      ramadanDay(2, FIFTEEN_HOURS),
      day(3, { monthOfYear: 7 }),
      day(4),
      day(5),
    ]
    const rows = revenue([
      [0, 100_000n],
      [1, 100_000n],
      [2, 100_000n],
      [3, 100_000n],
      [4, 300_000n],
      [5, 300_000n],
    ])
    const ramadan = seasonalityIndex('ramadan', inputOf(overlapping, rows))
    const summer = seasonalityIndex('summer', inputOf(overlapping, rows))
    if (ramadan.state !== 'value' || summer.state !== 'value')
      throw new Error('expected two indices')
    // Both are measured against days 4 and 5 only — the two days in neither bucket.
    expect(ramadan.value.baselineTradingDays).toBe(2)
    expect(summer.value.baselineTradingDays).toBe(2)
    expect(ramadan.value.baselineRevparh).toEqual(summer.value.baselineRevparh)
  })

  it('reaches the hours denominator through the REGISTERED RevPARH and not an arithmetic of its own', () => {
    // The whole index is a quotient of one registered KPI over two populations, which is why no KPI is
    // registered here. Handed a registry whose RevPARH has been replaced, the index moves — so the
    // dependency is real and not a comment.
    const input = inputOf(
      TWO_RAMADANS,
      revenue([
        [0, 300_000n],
        [1, 300_000n],
        [2, 120_000n],
        [3, 120_000n],
        [4, 300_000n],
        [5, 300_000n],
        [6, 120_000n],
        [7, 120_000n],
        [8, 300_000n],
        [9, 300_000n],
      ]),
    )
    const registry = buildKpiRegistry(KPI_SPECS, KPI_MEASURES)
    expect(resolveKpi(REVENUE_PER_AVAILABLE_ROOM_HOUR.id, registry).formula).toContain(
      'treatment_net_revenue_fils',
    )
    const throughTheRegistry = seasonalityIndex('ramadan', input, registry)
    expect(throughTheRegistry).toEqual(seasonalityIndex('ramadan', input))
    // And a registry that does not hold RevPARH at all is an error rather than an empty index: a tile
    // with no figure and no reason is the thing `UnknownKpi` exists to prevent.
    const without = buildKpiRegistry(
      KPI_SPECS.filter((spec) => spec.id !== REVENUE_PER_AVAILABLE_ROOM_HOUR.id),
      KPI_MEASURES,
    )
    expect(() => seasonalityIndex('ramadan', input, without)).toThrow(/No KPI/)
  })

  it('reports every bucket, so a report cannot omit one silently', () => {
    const model = seasonalityModel(inputOf([day(0), day(1)], revenue([[0, 1n]])))
    expect(model.map((entry) => entry.bucket)).toEqual([...SEASONALITY_BUCKETS])
    for (const entry of model) expect(entry.outcome.state).toBe('no_data')
  })
})

describe('the input is held equal to the KPI period in both directions', () => {
  it('refuses a flagged day with no hours and an hours day with no flags', () => {
    const base = inputOf([day(0), day(1)], revenue([[0, 1n]]))
    expect(() =>
      seasonalityIndex('ramadan', {
        ...base,
        days: [...base.days, day(5)],
      }),
    ).toThrow(/flags and no hours/)
    expect(() =>
      seasonalityIndex('ramadan', {
        ...base,
        kpiInput: {
          ...base.kpiInput,
          businessDays: [
            ...base.kpiInput.businessDays,
            { businessDay: localDate('2099-01-01'), openMinutes: 900 },
          ],
        },
      }),
    ).toThrow(/hours and no flags/)
  })

  it('refuses an occurrence floor below one', () => {
    expect(() =>
      seasonalityIndex('ramadan', inputOf([day(0)], revenue([[0, 1n]]), { minimumOccurrences: 0 })),
    ).toThrow(/at least one occurrence/)
  })
})

describe('the observance impact, reported twice', () => {
  /**
   * One Gregorian holiday whose date is settled, one lunar holiday whose date is not, and one Ramadan
   * run whose date is not.
   *
   * The names are the published names of nothing: the fixture uses two strings that are visibly test
   * data, because a statutory holiday's NAME is a published fact and inventing a plausible one here
   * would put it in a file somebody later copies (brief rule 15). What is asserted is the SPLIT.
   */
  const OBSERVED: readonly SeasonalityDay[] = [
    day(0),
    day(1, {
      isPublicHoliday: true,
      publicHolidayIsProvisional: false,
      publicHolidayIsLunarDated: false,
      publicHolidayNames: 'fixture-gregorian-holiday',
    }),
    day(2, {
      isPublicHoliday: true,
      publicHolidayIsProvisional: true,
      publicHolidayIsLunarDated: true,
      publicHolidayNames: 'fixture-lunar-holiday',
    }),
    ramadanDay(3),
    ramadanDay(4),
    day(5),
  ]

  const input = inputOf(OBSERVED, revenue([[0, 1n]]))

  it('has exactly two sides and no field that adds them', () => {
    const impact = observanceImpact(input)
    // The fourth acceptance line, as a check rather than as a comment: a `total` added to the type fails
    // here by name, which is the only thing that can hold "rather than one blended number" shut.
    expect(Object.keys(impact).sort()).toEqual([...OBSERVANCE_IMPACT_SIDES].sort())
    expect(OBSERVANCE_IMPACT_SIDES).toEqual(['confirmed', 'provisional'])
  })

  it('reports the lunar holiday on the provisional side and the Gregorian one on the confirmed side', () => {
    const impact = observanceImpact(input)
    expect(impact.confirmed.tradingDays).toBe(1)
    expect(impact.confirmed.observanceNames).toEqual(['fixture-gregorian-holiday'])
    expect(impact.confirmed.lunarDatedDays).toBe(0)
    expect(impact.confirmed.ramadanDays).toBe(0)
    // 900 minutes on the one confirmed day; 1 of 6 trading days is 1,667 basis points.
    expect(impact.confirmed.openMinutes).toBe(900n)
    expect(impact.confirmed.shareOfPeriodBp).toBe(1_667)

    expect(impact.provisional.tradingDays).toBe(3)
    expect(impact.provisional.observanceNames).toEqual(['fixture-lunar-holiday'])
    expect(impact.provisional.lunarDatedDays).toBe(1)
    expect(impact.provisional.ramadanDays).toBe(2)
    // 900 for the lunar holiday + 720 + 720 for the two Ramadan days.
    expect(impact.provisional.openMinutes).toBe(2_340n)
    expect(impact.provisional.shareOfPeriodBp).toBe(5_000)

    // The two sides are different figures and neither is the sum: that is what "twice, rather than one
    // blended number" means, asserted on the figures as well as on the key set.
    expect(impact.confirmed.openMinutes).not.toBe(impact.provisional.openMinutes)
    expect(impact.confirmed.openMinutes + impact.provisional.openMinutes).toBe(3_240n)
    // And a day with no observance is on NEITHER side, so the shares do not add to the period.
    expect(impact.confirmed.shareOfPeriodBp + impact.provisional.shareOfPeriodBp).toBeLessThan(
      10_000,
    )
  })

  it('reports a day carrying both a settled and an unsettled observance as PROVISIONAL', () => {
    const both = [
      day(0),
      day(1, {
        isPublicHoliday: true,
        publicHolidayIsProvisional: true,
        publicHolidayIsLunarDated: true,
        publicHolidayNames: 'fixture-gregorian-holiday / fixture-lunar-holiday',
      }),
    ]
    const impact = observanceImpact(inputOf(both, revenue([[0, 1n]])))
    expect(impact.confirmed.tradingDays).toBe(0)
    expect(impact.provisional.tradingDays).toBe(1)
    // `dim_date.public_holiday_names` joins a day's observances with ' / ' (0110), so both names are
    // reported rather than one string nobody can split.
    expect(impact.provisional.observanceNames).toEqual([
      'fixture-gregorian-holiday',
      'fixture-lunar-holiday',
    ])
  })

  it('refuses a lunar-dated holiday presented as settled', () => {
    // `reporting.calendar_observance_lunar_is_provisional` (0110) refuses the row, so reaching this means
    // the flags did not come from `dim_date`. Refused rather than filed on the confirmed side, which is
    // where nobody would know to doubt it.
    expect(() =>
      observanceImpact(
        inputOf(
          [
            day(0, {
              isPublicHoliday: true,
              publicHolidayIsLunarDated: true,
              publicHolidayIsProvisional: false,
              publicHolidayNames: 'fixture-lunar-holiday',
            }),
          ],
          revenue([[0, 1n]]),
        ),
      ),
    ).toThrow(/lunar date presented as settled/)
  })

  it('reports an empty period as zeros on both sides rather than dividing by no days', () => {
    const impact = observanceImpact(inputOf([], new Map()))
    for (const side of OBSERVANCE_IMPACT_SIDES) {
      expect(impact[side].tradingDays).toBe(0)
      expect(impact[side].shareOfPeriodBp).toBe(0)
      expect(impact[side].openMinutes).toBe(0n)
    }
  })
})
