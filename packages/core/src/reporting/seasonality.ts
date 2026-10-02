import { AppError } from '@berelax/shared'
import type { LocalDate } from '../time.ts'
import type { KpiBusinessDay, KpiInput, Rational } from './kpi-expression.ts'
import {
  divideRational,
  formatFigure,
  isZeroRational,
  KPI_UNIT_DECIMALS,
} from './kpi-expression.ts'
import type { KpiRegistry } from './kpi-registry.ts'
import { KPI_REGISTRY, resolveKpi } from './kpi-registry.ts'
import type { KpiOutcome } from './operational-kpis.ts'
import { REVENUE_PER_AVAILABLE_ROOM_HOUR } from './revpar.ts'

/**
 * Seasonality: Ramadan, the public holidays and the summer exodus, as an index over this business's own
 * trading days (R-REP-06).
 *
 * # The one thing this module exists to refuse
 *
 * **An index of 1.00 is the dangerous value here, and it is dangerous for ADR 0070's reason exactly.**
 * "No seasonal effect measured" and "we have not traded through a Ramadan yet" are the same number and
 * different claims, and only one of them survives the first Ramadan. A flat index is also the one value
 * a screen renders without complaint, and the one a forecast would multiply by to no visible effect — so
 * a reader would see a seasonality model, see it saying nothing, and conclude the business is not
 * seasonal. docs/06 B6 says the opposite in so many words: "any forecast that assumes a flat year will
 * be wrong twice annually".
 *
 * So this module never returns 1.00 for want of evidence. It returns `no_data`, naming how many
 * occurrences of the bucket it observed and how many it needs, and {@link KpiOutcome} is R-REP-04's
 * union rather than a fourth one of this unit's own.
 *
 * # Why the floor is stated in OCCURRENCES and not in days
 *
 * A Ramadan is about thirty consecutive trading days, so a days floor of thirty is met by a single
 * Ramadan — and a single occurrence of anything cannot be distinguished from everything else that
 * happened that month. Two is the smallest number that can REPEAT, which is the smallest number from
 * which a seasonal claim can be made at all; see {@link MINIMUM_SEASONALITY_OCCURRENCES}. This business
 * has weeks of history, so every bucket answers `no_data` today and
 * `packages/fixtures/src/cash-forecast.itest.ts` MEASURES that rather than asserting it — R-REP-04's
 * arrangement for the contribution margin, one subject along.
 *
 * # Why the index is a quotient of a REGISTERED KPI and not a KPI of its own
 *
 * The index is `RevPARH(the bucket's trading days) ÷ RevPARH(the baseline's trading days)`, and both
 * sides are computed by `resolveKpi('revenue_per_available_room_hour')` — R-REP-03's registered KPI,
 * evaluated over two different selections of `KpiInput`. Three things follow, and the third is an
 * acceptance line:
 *
 *   * **Nothing is registered here.** A KPI is an expression over measures folded from ONE input (ADR
 *     0068), and an index is a quotient of two folds over two different SUBSETS of it — a partition the
 *     expression language has no node for. Registering one would have meant a new node type, its
 *     rendering, its unit rule and a fourth row in the quotient table, which is the cost ADR 0068 states.
 *     Dividing one registered KPI's figure by its own figure over another population costs none of that
 *     and leaves one statement of the arithmetic.
 *   * **The index is an INTENSITY ratio and not a revenue ratio**, which is the whole reason the hours
 *     matter. Ramadan revenue is lower partly because the premises is open for fewer hours and partly
 *     because demand moves; a raw revenue ratio blends the two and reports the reduced hours as reduced
 *     demand. RevPARH's denominator separates them.
 *   * **The denominator is `premises_hours`, transitively and with no code here.** RevPARH divides by
 *     `available_room_hours`, which divides `available_room_minutes` by 60, which subtracts
 *     `room_closure_minutes` from `room_open_minutes`, which sums `businessDays.openMinutes` — the
 *     caller's read of `reporting.dim_date.open_minutes`, which migration 0110 derives from
 *     `business_day.duration_seconds`, which 0011 GENERATES from the day's instants, which
 *     `generateBusinessDays` computes from `premises_hours` and `premises_hours_override`. That chain is
 *     R-REP-06's third acceptance line, and it is satisfied by not having any arithmetic of its own:
 *     `packages/fixtures/src/cash-forecast.itest.ts` writes a Ramadan hours override, regenerates and
 *     refreshes, and reads a different index out of the same code.
 *
 * # Why there is no `total` on the observance impact
 *
 * The fourth acceptance line — "a lunar-date holiday reports its impact twice — confirmed and
 * provisional — rather than one blended number". {@link ObservanceImpact} has exactly two sides and no
 * field that adds them, because a blended figure cannot be unblended by whoever reads it: a dirham of
 * impact resting on a date the authority has not announced is a different claim from a dirham resting on
 * 1 January, and the remedy for one is to wait and the remedy for the other is to staff differently.
 * {@link OBSERVANCE_IMPACT_SIDES} is the whole key set and `seasonality.test.ts` asserts that, so a third
 * key fails by name rather than by nobody noticing.
 *
 * # Nothing here reaches the cash forecast, deliberately
 *
 * `./cash-forecast.ts` does not import this module and must not: the decision and its reasons are ADR
 * 0073, and gate case 151j plants the import and requires the scan written for it to see it. An index
 * over almost nothing, multiplied into a cash figure, is an assumption that leaves no trace in the
 * number it changed.
 *
 * Pure. Every date, every rate and every window is an argument; `scripts/check-core-purity.mjs` refuses a
 * clock here.
 */

// --- the buckets ---------------------------------------------------------------------------------

/**
 * What a seasonality index can be about.
 *
 * Three, and each is a different KIND of fact, which is why they are not one list of date ranges:
 *
 *   * `ramadan` and `public_holiday` are observances, dated in `reporting.calendar_observance`, and
 *     `dim_date` carries them per trading day. Their dates are `Y9-holiday-calendar` and the table ships
 *     EMPTY (migration 0110), so neither bucket has an observation in this build.
 *   * `summer` is Gregorian and recurring, so it is a window rather than an observance — docs/06 B6's
 *     "genuinely quiet July/August". It is an ARGUMENT here for ADR 0070's reason: nothing in this unit
 *     holds a window length. The provisional months live in the settings registry under
 *     `reporting.seasonality_summer_months`, flagged provisional against `Y9-summer-window`.
 */
export const SEASONALITY_BUCKETS = ['ramadan', 'public_holiday', 'summer'] as const
export type SeasonalityBucket = (typeof SEASONALITY_BUCKETS)[number]

/**
 * The smallest number of separated occurrences of a bucket from which a seasonal claim can be made.
 *
 * Two, and the argument is not about this business. One occurrence of a season is one month of trading
 * that also contained whatever else happened that month — a price change, a closure, a campaign, a
 * therapist leaving — and nothing in one observation separates the season from the rest of it. Two is the
 * smallest number that can repeat, and a repeat is the only evidence that an effect belongs to the season
 * rather than to the month it happened in.
 *
 * It is a METHODOLOGICAL floor and not a figure about the salon, which is why it is a constant here while
 * the summer window is an argument: answering `Y9-summer-window` changes which days are in the bucket and
 * changes nothing about how much evidence a claim needs. The caller still passes it, so a report that
 * wants a stricter floor can have one and no caller gets a default it did not state.
 */
export const MINIMUM_SEASONALITY_OCCURRENCES = 2

/** One trading day, with the observance flags `reporting.dim_date` carries (migration 0110). */
export interface SeasonalityDay {
  readonly businessDay: LocalDate
  /** `dim_date.open_minutes`. Derived from `premises_hours` and its dated overrides, never a constant. */
  readonly openMinutes: number
  /** `dim_date.is_ramadan`. */
  readonly isRamadan: boolean
  /** `dim_date.ramadan_is_provisional`. True while the lunar date has not been announced. */
  readonly ramadanIsProvisional: boolean
  /** `dim_date.is_public_holiday`. */
  readonly isPublicHoliday: boolean
  /** `dim_date.public_holiday_is_provisional`. */
  readonly publicHolidayIsProvisional: boolean
  /** `dim_date.public_holiday_is_lunar_dated`. A lunar date must be provisional — see below. */
  readonly publicHolidayIsLunarDated: boolean
  /** `dim_date.public_holiday_names`, or null. A statutory holiday's NAME is a published fact. */
  readonly publicHolidayNames: string | null
  /** The calendar month of the trading date, 1-12, for the summer window. */
  readonly monthOfYear: number
}

/**
 * Everything a seasonality reading is computed from: the trading days with their flags, and the KPI
 * input the registered RevPARH is evaluated over.
 *
 * `kpiInput.businessDays` is the whole period and `days` describes those same trading dates. They are
 * held equal by {@link assertSeasonalityInput} in BOTH directions rather than merged into one structure,
 * because `KpiBusinessDay` is R-REP-03's shape and carries no observance flag: widening it would have put
 * this unit's columns into another unit's input type, and every measure's declared read set is checked
 * against that type.
 */
export interface SeasonalityInput {
  readonly days: readonly SeasonalityDay[]
  readonly kpiInput: KpiInput
  /** The calendar months the summer exodus covers. An argument — see {@link SEASONALITY_BUCKETS}. */
  readonly summerMonths: readonly number[]
  /** How many separated occurrences of a bucket an index needs. See {@link MINIMUM_SEASONALITY_OCCURRENCES}. */
  readonly minimumOccurrences: number
}

/** A measured index: what it is, and the evidence behind it. */
export interface SeasonalityIndexValue {
  readonly bucket: SeasonalityBucket
  /**
   * `RevPARH(bucket) ÷ RevPARH(baseline)`, exact. Below 1 means the bucket is quieter per room-hour.
   *
   * A `Rational` and not a float, for ADR 0068's reason: a figure that prints differently in two places
   * is a figure two screens disagree about.
   */
  readonly index: Rational
  /** The bucket's own RevPARH, so the index can be checked against its two halves. */
  readonly bucketRevparh: Rational
  readonly baselineRevparh: Rational
  readonly bucketTradingDays: number
  readonly baselineTradingDays: number
  /** Runs of consecutive trading days in the bucket. The evidence the floor is about. */
  readonly bucketOccurrences: number
  /** True when any day in the bucket rests on a date nobody has announced (`Y9-holiday-calendar`). */
  readonly restsOnProvisionalDates: boolean
}

/** An index as a string, at the four places a ratio publishes to (`KPI_UNIT_DECIMALS`). */
export const publishedIndex = (measured: SeasonalityIndexValue): string =>
  formatFigure(measured.index, KPI_UNIT_DECIMALS.ratio)

// --- the index -----------------------------------------------------------------------------------

/**
 * The days a trading date in `bucket` is, and the days the BASELINE is.
 *
 * The baseline is every trading day in no bucket at all, rather than "every day not in this bucket".
 * Otherwise a Ramadan index would be measured against a baseline containing the summer, and the summer
 * index against a baseline containing Ramadan — so the two indices would each be partly the other's
 * reciprocal and neither would mean what its name says.
 */
const inBucket = (
  day: SeasonalityDay,
  bucket: SeasonalityBucket,
  summerMonths: readonly number[],
) => {
  switch (bucket) {
    case 'ramadan':
      return day.isRamadan
    case 'public_holiday':
      return day.isPublicHoliday
    case 'summer':
      return summerMonths.includes(day.monthOfYear)
  }
}

const inAnyBucket = (day: SeasonalityDay, summerMonths: readonly number[]): boolean =>
  SEASONALITY_BUCKETS.some((bucket) => inBucket(day, bucket, summerMonths))

/**
 * How many separated runs of trading days the selection contains.
 *
 * Counted over the ORDERED trading dates of the period rather than over calendar dates, because a date
 * the premises did not trade on has no `dim_date` row at all (ADR 0060) — so two Ramadan days either side
 * of a closure are one occurrence here, which is right: the closure did not make it two Ramadans.
 */
function occurrencesOf(ordered: readonly SeasonalityDay[], selected: ReadonlySet<string>): number {
  let runs = 0
  let inRun = false
  for (const day of ordered) {
    const member = selected.has(day.businessDay)
    if (member && !inRun) runs += 1
    inRun = member
  }
  return runs
}

/** Raised when a day claims a lunar-dated holiday whose date is presented as settled. */
export class LunarDatePresentedAsSettled extends AppError {
  constructor(businessDay: string) {
    super(
      'invariant_violated',
      `The trading day ${businessDay} carries a lunar-dated public holiday that is not flagged ` +
        'provisional. The UAE lunar holidays are announced at short notice (docs/04 section 6), so a ' +
        'lunar date presented as settled is a date this repository has no evidence for — and an impact ' +
        'figure resting on it would be reported on the confirmed side, where nobody would know to ' +
        'doubt it. `reporting.calendar_observance_lunar_is_provisional` (migration 0110) refuses the ' +
        'row, so reaching this means the flags were not read from dim_date.',
      { details: { businessDay } },
    )
    this.name = 'LunarDatePresentedAsSettled'
  }
}

/**
 * The input's two halves held equal, and the one combination the calendar cannot hold.
 *
 * Exported so the integration suite can assert the refusals fire against rows it writes, rather than
 * against a hand-built object only this file knows the shape of.
 */
export function assertSeasonalityInput(input: SeasonalityInput): void {
  const flagged = new Set(input.days.map((day) => day.businessDay as string))
  const kpiDays = new Set(input.kpiInput.businessDays.map((day) => day.businessDay as string))
  const missingFlags = [...kpiDays].filter((day) => !flagged.has(day)).sort()
  const missingHours = [...flagged].filter((day) => !kpiDays.has(day)).sort()
  if (missingFlags.length > 0 || missingHours.length > 0) {
    throw new AppError(
      'validation',
      `The seasonality flags and the KPI period describe different trading days: ` +
        `[${missingFlags.join(', ')}] have hours and no flags, and [${missingHours.join(', ')}] have ` +
        'flags and no hours. A bucket selected from one and divided by a denominator read from the ' +
        'other is an index over two different periods.',
      { details: { missingFlags, missingHours } },
    )
  }
  for (const day of input.days) {
    if (day.isPublicHoliday && day.publicHolidayIsLunarDated && !day.publicHolidayIsProvisional) {
      throw new LunarDatePresentedAsSettled(day.businessDay)
    }
    if (!Number.isInteger(day.monthOfYear) || day.monthOfYear < 1 || day.monthOfYear > 12) {
      throw new AppError(
        'validation',
        `Trading day ${day.businessDay} reports month ${day.monthOfYear}, which is not a calendar month.`,
      )
    }
  }
  for (const month of input.summerMonths) {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new AppError(
        'validation',
        `The summer window names month ${month}, which is not a calendar month. The window is ` +
          'Y9-summer-window and is supplied by the caller; a month outside 1-12 would select no day ' +
          'and the index would read no_data for a reason that is a typo.',
      )
    }
  }
  if (!Number.isInteger(input.minimumOccurrences) || input.minimumOccurrences < 1) {
    throw new AppError(
      'validation',
      `An index needs at least one occurrence of its bucket; received ${input.minimumOccurrences}. ` +
        `${MINIMUM_SEASONALITY_OCCURRENCES} is the floor this build states and why.`,
    )
  }
}

/** The RevPARH of a selection of trading days, through the REGISTERED KPI. */
function revparhOver(
  input: SeasonalityInput,
  selected: ReadonlySet<string>,
  registry: KpiRegistry,
): Rational | { readonly divisorFormula: string } {
  const businessDays: KpiBusinessDay[] = input.kpiInput.businessDays.filter((day) =>
    selected.has(day.businessDay as string),
  )
  const result = resolveKpi(REVENUE_PER_AVAILABLE_ROOM_HOUR.id, registry).compute({
    ...input.kpiInput,
    businessDays,
  })
  return result.kind === 'measured' ? result.value : { divisorFormula: result.divisorFormula }
}

/**
 * The seasonality index for one bucket, or the reason there is not one.
 *
 * `no_data` for want of occurrences is the answer this build gives for every bucket today, and it is the
 * point of the module rather than a gap in it: see the header.
 */
export function seasonalityIndex(
  bucket: SeasonalityBucket,
  input: SeasonalityInput,
  registry: KpiRegistry = KPI_REGISTRY,
): KpiOutcome<SeasonalityIndexValue> {
  assertSeasonalityInput(input)
  const ordered = [...input.days].sort((a, b) => (a.businessDay < b.businessDay ? -1 : 1))
  const bucketDays = new Set(
    ordered
      .filter((day) => inBucket(day, bucket, input.summerMonths))
      .map((day) => day.businessDay as string),
  )
  const baselineDays = new Set(
    ordered
      .filter((day) => !inAnyBucket(day, input.summerMonths))
      .map((day) => day.businessDay as string),
  )
  const occurrences = occurrencesOf(ordered, bucketDays)

  if (occurrences < input.minimumOccurrences) {
    return Object.freeze({
      state: 'no_data' as const,
      why:
        `The period holds ${occurrences} separated occurrence(s) of ${bucket} and an index needs ` +
        `${input.minimumOccurrences}. One occurrence of a season cannot be told apart from everything ` +
        'else that happened in the same weeks, so an index computed from it would be a figure about one ' +
        'month wearing the name of a season — and a flat 1.00 returned for want of evidence would be ' +
        'read as "this business is not seasonal", which docs/06 B6 says is wrong twice a year.',
      missingFigures: Object.freeze([
        `${bucket}: ${occurrences} of ${input.minimumOccurrences} occurrences observed`,
      ]),
    })
  }
  if (baselineDays.size === 0) {
    return Object.freeze({
      state: 'no_denominator' as const,
      why:
        `Every trading day in the period is in a seasonality bucket, so there is no baseline to ` +
        `measure ${bucket} against. An index against a baseline of nothing is not a quieter season; it ` +
        'is a period nobody chose the shape of.',
    })
  }

  const bucketRevparh = revparhOver(input, bucketDays, registry)
  const baselineRevparh = revparhOver(input, baselineDays, registry)
  if ('divisorFormula' in bucketRevparh || 'divisorFormula' in baselineRevparh) {
    const empty = 'divisorFormula' in bucketRevparh ? bucket : 'the baseline'
    const formula =
      'divisorFormula' in bucketRevparh
        ? bucketRevparh.divisorFormula
        : (baselineRevparh as { divisorFormula: string }).divisorFormula
    return Object.freeze({
      state: 'no_denominator' as const,
      why:
        `${empty} has no available room-hours (${formula}), so there is no revenue per room-hour to ` +
        'divide. A room-hour denominator of zero is a period with no capacity for sale, which is not ' +
        'the same reading as a quiet one.',
    })
  }
  if (isZeroRational(baselineRevparh)) {
    return Object.freeze({
      state: 'no_denominator' as const,
      why:
        'The baseline earned nothing per available room-hour, so there is no normal for the bucket to ' +
        'be a multiple of. A division by zero revenue would report any bucket revenue at all as an ' +
        'infinite season.',
    })
  }

  const index = divideRational(bucketRevparh, baselineRevparh)
  if (index === null) {
    // Unreachable while the zero check above stands, and kept because removing it would make the zero
    // check the only thing between a caller and a `null` — ADR 0068's argument for a result shape.
    return Object.freeze({
      state: 'no_denominator' as const,
      why: 'The baseline revenue per available room-hour is zero.',
    })
  }

  return Object.freeze({
    state: 'value' as const,
    value: Object.freeze({
      bucket,
      index,
      bucketRevparh,
      baselineRevparh,
      bucketTradingDays: bucketDays.size,
      baselineTradingDays: baselineDays.size,
      bucketOccurrences: occurrences,
      restsOnProvisionalDates: ordered.some(
        (day) =>
          bucketDays.has(day.businessDay as string) &&
          ((day.isRamadan && day.ramadanIsProvisional) ||
            (day.isPublicHoliday && day.publicHolidayIsProvisional)),
      ),
    }),
  })
}

/** Every bucket's index, in {@link SEASONALITY_BUCKETS} order, so a report cannot omit one silently. */
export function seasonalityModel(
  input: SeasonalityInput,
  registry: KpiRegistry = KPI_REGISTRY,
): readonly {
  readonly bucket: SeasonalityBucket
  readonly outcome: KpiOutcome<SeasonalityIndexValue>
}[] {
  return Object.freeze(
    SEASONALITY_BUCKETS.map((bucket) =>
      Object.freeze({ bucket, outcome: seasonalityIndex(bucket, input, registry) }),
    ),
  )
}

// --- the observance impact, twice ----------------------------------------------------------------

/**
 * The two sides of {@link ObservanceImpact}, and the whole of its key set.
 *
 * Asserted as the exact keys by `seasonality.test.ts`, which is how "rather than one blended number" is
 * a check and not a comment: a `total` added here fails that assertion by name. See the module header.
 */
export const OBSERVANCE_IMPACT_SIDES = ['confirmed', 'provisional'] as const
export type ObservanceImpactSide = (typeof OBSERVANCE_IMPACT_SIDES)[number]

/** What the observances on one side of the confirmed/provisional line cover. */
export interface ObservanceImpactFigures {
  readonly tradingDays: number
  /** `Σ dim_date.open_minutes` over those days: the hours the premises is open on them. */
  readonly openMinutes: bigint
  /** Those days' share of the period's trading days, in basis points. */
  readonly shareOfPeriodBp: number
  /** Every observance NAME on those days, deduplicated and sorted. A statutory name is a published fact. */
  readonly observanceNames: readonly string[]
  /** How many of those days carry a holiday whose date is announced against the lunar calendar. */
  readonly lunarDatedDays: number
  /** How many carry Ramadan. Reported per side, because Ramadan's start is lunar too. */
  readonly ramadanDays: number
}

/**
 * The impact of the period's observances, split on whether their DATES are settled — and never summed.
 *
 * There is deliberately no combined field. See the module header and {@link OBSERVANCE_IMPACT_SIDES}.
 */
export interface ObservanceImpact {
  readonly confirmed: ObservanceImpactFigures
  readonly provisional: ObservanceImpactFigures
}

const BASIS_POINTS = 10_000

function figuresFor(days: readonly SeasonalityDay[], periodDays: number): ObservanceImpactFigures {
  const names = new Set<string>()
  for (const day of days) {
    if (day.publicHolidayNames === null) continue
    // `dim_date.public_holiday_names` is `string_agg(..., ' / ')` over the day's observances (0110), so
    // a day carrying two holidays contributes both names rather than one joined string nobody can split.
    for (const name of day.publicHolidayNames.split(' / ')) {
      const trimmed = name.trim()
      if (trimmed !== '') names.add(trimmed)
    }
  }
  return Object.freeze({
    tradingDays: days.length,
    openMinutes: days.reduce((total, day) => total + BigInt(day.openMinutes), 0n),
    // Integer basis points, not a float: `shareInBasisPoints`' reason one module along, and a period
    // with no trading day at all is 0 rather than a division by zero, because the SHARE of an empty
    // period is a fact about the period and not about the observances.
    shareOfPeriodBp: periodDays === 0 ? 0 : Math.round((days.length * BASIS_POINTS) / periodDays),
    observanceNames: Object.freeze([...names].sort()),
    lunarDatedDays: days.filter((day) => day.isPublicHoliday && day.publicHolidayIsLunarDated)
      .length,
    ramadanDays: days.filter((day) => day.isRamadan).length,
  })
}

/**
 * The period's observance impact, reported twice.
 *
 * A trading day is on the `provisional` side when ANY observance it carries rests on a date nobody has
 * announced, and on `confirmed` only when every observance it carries is settled. That asymmetry is
 * deliberate: a day that is both a confirmed holiday and a provisionally-dated one may stop being a
 * holiday the moment the announcement comes, so reporting it as settled would be reporting the part of
 * it that cannot move and staying silent about the part that can.
 *
 * A day with no observance at all is on NEITHER side, which is why the two counts do not add to the
 * period: `shareOfPeriodBp` is what says how much of the period each side covers.
 */
export function observanceImpact(input: SeasonalityInput): ObservanceImpact {
  assertSeasonalityInput(input)
  const observed = input.days.filter((day) => day.isRamadan || day.isPublicHoliday)
  const provisional = observed.filter(
    (day) =>
      (day.isRamadan && day.ramadanIsProvisional) ||
      (day.isPublicHoliday && day.publicHolidayIsProvisional),
  )
  const provisionalDates = new Set(provisional.map((day) => day.businessDay as string))
  const confirmed = observed.filter((day) => !provisionalDates.has(day.businessDay as string))
  return Object.freeze({
    confirmed: figuresFor(confirmed, input.days.length),
    provisional: figuresFor(provisional, input.days.length),
  })
}
