import { AppError } from '@berelax/shared'
import type { Period } from '../availability/room-predicates.ts'
import { weekdayIn } from '../business-day/resolve.ts'
import {
  ASIA_DUBAI,
  addMinutes,
  type LocalDate,
  localDate,
  type TimeZone,
  toLocal,
} from '../time.ts'
import {
  assertWorkingHoursRules,
  dearestBucket,
  emptyBucketMinutes,
  isWithinNightWindow,
  rulesFor,
  WORKED_MINUTE_BUCKETS,
  type WorkedMinuteBucket,
  type WorkingHoursRules,
} from './rates.ts'

/**
 * Working hours across midnight: how long a shift is, which trading date it belongs to, which bucket
 * each of its minutes is paid in, and what a week of them adds up to. Pure.
 *
 * ## The defect this module exists not to have
 *
 * Trading runs 11:00–02:00 (docs/01 decision 8), so the ordinary shift crosses midnight and **a shift is
 * not an interval on a calendar date**. Three arithmetic mistakes follow from forgetting that, and all
 * three produce plausible numbers:
 *
 *   1. **Length by wall-clock subtraction.** 18:00 to 02:00 read as `02:00 − 18:00` is −16 hours, or 8
 *      hours once somebody wraps it in an `abs()` that is right by accident and wrong for 02:00–18:00.
 *      {@link workedMinutes} subtracts **instants**, where 18:00–02:00 is 480 minutes and there is no
 *      wrap to get right.
 *   2. **The wrong day.** A shift ending 01:30 belongs to the trading date that opened at 11:00 the
 *      previous calendar day. Nothing in this module re-derives that: `shift.trading_date` is a foreign
 *      key into `business_day`, the resolution is `resolveTradingDate`'s in `../business-day/resolve.ts`,
 *      and every function here takes the trading date as **given**. A second reading of "which day is it"
 *      is the defect this unit is most likely to ship, so there is exactly one reading and it is not
 *      here.
 *   3. **The wrong week.** A shift starting 23:00 Friday and ending 02:00 Saturday is wholly Friday's,
 *      because its trading date is Friday. Aggregation keys on the trading date and never on a calendar
 *      date of either end — see {@link tradingWeekStart}.
 *
 * ## Why the buckets are a partition and not four tallies
 *
 * A minute at 23:30 in the ninth hour of a shift is a night minute *and* an overtime minute. Counting it
 * in both makes the buckets sum to more than the minutes worked, so no reconciliation against
 * `shift.period` is possible and an hour can go missing without any figure looking wrong. So each minute
 * is counted **once**, in the dearest bucket that applies ({@link dearestBucket}), which is both the
 * lawful reading and what makes the unit's property — the buckets sum to the total, exactly — hold by
 * construction rather than by arithmetic luck.
 *
 * ## Integer minutes throughout
 *
 * Every quantity here is a whole number of minutes or a whole number of basis-point-minutes. There is no
 * division except by 60,000 to turn a millisecond difference into minutes, and that division is checked
 * to be exact ({@link workedMinutes} refuses a shift boundary that is not on a minute). A fractional
 * minute would be ADR 0007's float-money mistake wearing a timesheet's costume: it reconciles to nothing,
 * and the error is a few seconds per shift until it is a day per year.
 *
 * ## The minute-by-minute walk, and why it is not a segment scan
 *
 * {@link splitWorkedMinutes} classifies each minute of the shift individually. A boundary-scan version —
 * find the instants where night-ness changes, subtract the overtime boundary, take the lengths — is
 * perhaps twenty times faster and its correctness is an argument rather than a reading. The slow version
 * is the one whose answer can be checked against a figure computed by hand, and a shift is at most a few
 * hundred minutes. The property suite holds both this implementation and two deliberately broken ones to
 * the same invariant, which is the guard that matters more than the speed.
 *
 * Pure: instants in, integers out, the zone is an argument and there is no clock.
 */

/** A `shift` row joined to its `shift_assignment`: one employee's rostered span on one trading date. */
export interface RosteredShift {
  readonly shiftId: string
  readonly employeeId: string
  /** `shift.trading_date`, a foreign key into `business_day`. Never re-derived from `period`. */
  readonly tradingDate: LocalDate
  /** `shift.period`, half-open `[startsAt, endsAt)`. Crosses midnight on a normal day. */
  readonly period: Period
}

/** Abutting or overlapping shift rows, merged into the one span the employee was actually present for. */
export interface Presence {
  readonly period: Period
  /** The shift rows merged into it, chronologically. Kept so a violation can name the row. */
  readonly shiftIds: readonly string[]
}

/** Minutes and the multiplier each bucket carries, for one span or one aggregate. */
export interface BucketTotals {
  readonly totalMinutes: number
  readonly minutes: Readonly<Record<WorkedMinuteBucket, number>>
  /**
   * The multipliers the split was made with, copied from the rule version in force.
   *
   * Returned rather than left for the caller to fetch again: a bucket count without the rate it was
   * counted at is not an answer anybody can act on, and a second read of the rate table is a second read
   * that can land after a rate change.
   */
  readonly multiplierBp: Readonly<Record<WorkedMinuteBucket, number>>
  /**
   * `sum(minutes × multiplierBp)`. Whole basis-point-minutes.
   *
   * Deliberately not money. Turning this into fils needs an hourly rate, and `employee.basic_wage_fils`
   * is a monthly figure whose conversion to an hourly one is a policy question nobody has answered
   * (Y9-overtime, Y8-staff). A figure in this unit that looked like pay would be that answer, invented.
   */
  readonly weightedMinuteBp: number
}

/** One employee's hours on one trading date. */
export interface TradingDayHours extends BucketTotals {
  readonly employeeId: string
  readonly tradingDate: LocalDate
  /** Minutes worked past the day's ordinary allowance, whichever buckets they were paid in. */
  readonly overtimeMinutes: number
  /** Of those, the ones past the daily cap. Above zero is a compliance breach, not a dearer rate. */
  readonly overtimeBeyondCapMinutes: number
  readonly isPublicHoliday: boolean
  readonly shiftIds: readonly string[]
}

/** One employee's hours over one trading week. */
export interface TradingWeekHours extends BucketTotals {
  readonly employeeId: string
  /** The trading date the week starts on, which is what this aggregate is keyed by. */
  readonly weekStartTradingDate: LocalDate
  /** The trading dates that contributed, ascending. A date with no shift does not appear. */
  readonly tradingDates: readonly LocalDate[]
  readonly overtimeMinutes: number
}

export type WorkingHoursViolation =
  | {
      readonly kind: 'daily_overtime_cap'
      readonly employeeId: string
      readonly tradingDate: LocalDate
      readonly overtimeMinutes: number
      readonly capMinutes: number
    }
  | {
      readonly kind: 'weekly_ordinary_cap'
      readonly employeeId: string
      readonly weekStartTradingDate: LocalDate
      readonly totalMinutes: number
      readonly capMinutes: number
    }
  | {
      readonly kind: 'minimum_rest'
      readonly employeeId: string
      /** The last shift of the earlier presence, and the first of the later one. Both, always. */
      readonly earlierShiftId: string
      readonly laterShiftId: string
      readonly gapMinutes: number
      readonly minimumMinutes: number
    }

export interface WorkedHoursSummary {
  readonly days: readonly TradingDayHours[]
  readonly weeks: readonly TradingWeekHours[]
  readonly violations: readonly WorkingHoursViolation[]
}

/**
 * The minutes a span covers, by subtracting instants.
 *
 * 18:00–02:00 Asia/Dubai is 480, and nothing in this function knows either figure: it is
 * `(endsAt − startsAt) / 60000`. That is the whole of the midnight fix, and it is why the arithmetic is
 * done on instants and the wall clock is consulted only to classify a minute, never to measure one.
 *
 * A boundary that is not on a whole minute is **refused** rather than rounded. `shift.period` is a
 * `tstzrange` and can hold seconds; rounding them would silently create or destroy paid time, and the
 * discrepancy is small enough to survive every review and large enough to matter over a year.
 */
export function workedMinutes(period: Period): number {
  const milliseconds = period.endsAt - period.startsAt
  if (milliseconds <= 0) {
    throw new AppError(
      'validation',
      'A shift that ends when or before it starts has no worked minutes. A shift crossing midnight is ' +
        'not this case: 18:00-02:00 has an end instant after its start instant, and only wall-clock ' +
        'subtraction makes it look negative.',
    )
  }
  if (milliseconds % 60_000 !== 0) {
    throw new AppError(
      'validation',
      `A shift boundary must fall on a whole minute; this one spans ${milliseconds}ms. Rounding it ` +
        'would create or destroy paid time by a few seconds per shift, which reconciles to nothing.',
    )
  }
  return milliseconds / 60_000
}

function weightedBp(
  minutes: Readonly<Record<WorkedMinuteBucket, number>>,
  rules: WorkingHoursRules,
) {
  let total = 0
  for (const bucket of WORKED_MINUTE_BUCKETS) total += minutes[bucket] * rules.multiplierBp[bucket]
  return total
}

function multipliersOf(rules: WorkingHoursRules): Readonly<Record<WorkedMinuteBucket, number>> {
  return { ...rules.multiplierBp }
}

/**
 * One span's minutes, split into the four buckets.
 *
 * `minutesAlreadyWorked` is the day's allowance already consumed by earlier spans, and it is consumed by
 * **every** worked minute whatever bucket it lands in: a minute at 23:00 is paid at the night rate and is
 * still one of the day's first eight hours. Treating night minutes as though they did not count towards
 * the ordinary allowance is how a 18:00–02:00 shift comes to report overtime it did not work.
 *
 * Whether the trading date is a public holiday is decided **once, for the whole span**, and that is the
 * second half of the midnight fix. A per-minute reading of "is this minute's calendar date a holiday"
 * would give a 23:00–02:00 shift two hours of holiday pay whenever the holiday is the day after its
 * trading date — and nothing about the resulting figure looks wrong.
 */
export function splitWorkedMinutes(args: {
  readonly period: Period
  readonly rules: WorkingHoursRules
  readonly isPublicHoliday: boolean
  readonly minutesAlreadyWorked?: number
  readonly zone?: TimeZone
}): BucketTotals & { readonly overtimeMinutes: number } {
  const { period, rules, isPublicHoliday, minutesAlreadyWorked = 0, zone = ASIA_DUBAI } = args
  assertWorkingHoursRules(rules)
  if (!Number.isInteger(minutesAlreadyWorked) || minutesAlreadyWorked < 0) {
    throw new AppError(
      'validation',
      `Minutes already worked must be a whole number and not negative, got ${minutesAlreadyWorked}`,
    )
  }
  const totalMinutes = workedMinutes(period)
  const minutes = emptyBucketMinutes()
  let overtimeMinutes = 0

  for (let offset = 0; offset < totalMinutes; offset += 1) {
    // The minute is classified by the wall clock at the instant it BEGINS, which is what makes the
    // windows half-open here as everywhere else: a minute beginning at 04:00 is a day minute even though
    // it started one minute after a night minute ended.
    const at = addMinutes(period.startsAt, offset)
    const uplifts: WorkedMinuteBucket[] = []
    if (isPublicHoliday) uplifts.push('publicHoliday')
    if (isWithinNightWindow(toLocal(at, zone).time, rules.nightWindow)) uplifts.push('night')
    if (minutesAlreadyWorked + offset >= rules.ordinaryMinutesPerDay) {
      uplifts.push('overtime')
      overtimeMinutes += 1
    }
    minutes[dearestBucket(rules, uplifts)] += 1
  }

  return {
    totalMinutes,
    minutes,
    multiplierBp: multipliersOf(rules),
    weightedMinuteBp: weightedBp(minutes, rules),
    overtimeMinutes,
  }
}

/**
 * Abutting and overlapping shift rows merged into presences, chronologically.
 *
 * A roster written in two halves — 18:00–22:00 and 22:00–02:00 — is **one** presence of eight hours, and
 * this is the same reading `mergePeriods` gives the availability solver, for the same stated reason: a
 * treatment crossing the join must not be refused. Here it matters twice more. Two overlapping rows left
 * unmerged would pay the overlap twice, and the gap of zero minutes between two abutting rows would be
 * reported as a rest-period breach by an employee who never went home in between.
 *
 * Merging on `<=` and not `<` is what makes the abutting case one presence; the two are otherwise
 * identical and the difference only shows up in the rest check.
 */
export function mergePresences(shifts: readonly RosteredShift[]): readonly Presence[] {
  const ordered = [...shifts].sort(
    (a, b) =>
      a.period.startsAt - b.period.startsAt ||
      a.period.endsAt - b.period.endsAt ||
      (a.shiftId < b.shiftId ? -1 : a.shiftId > b.shiftId ? 1 : 0),
  )
  const presences: { period: { startsAt: number; endsAt: number }; shiftIds: string[] }[] = []
  for (const shift of ordered) {
    const open = presences[presences.length - 1]
    if (open !== undefined && shift.period.startsAt <= open.period.endsAt) {
      open.period.endsAt = Math.max(open.period.endsAt, shift.period.endsAt)
      open.shiftIds.push(shift.shiftId)
      continue
    }
    presences.push({
      period: { startsAt: shift.period.startsAt, endsAt: shift.period.endsAt },
      shiftIds: [shift.shiftId],
    })
  }
  return presences.map((presence) => ({
    period: { startsAt: presence.period.startsAt, endsAt: presence.period.endsAt } as Period,
    shiftIds: presence.shiftIds,
  }))
}

/**
 * One employee's hours on one trading date.
 *
 * `shifts` must all be that employee's and all carry that trading date; anything else is a caller
 * mistake and is refused, because silently ignoring a foreign row would under-report somebody's hours.
 * The day's ordinary allowance is consumed across presences in chronological order, so the overtime
 * boundary falls where the person actually crossed it rather than inside whichever row happens to be
 * longest.
 */
export function employeeTradingDayHours(args: {
  readonly employeeId: string
  readonly tradingDate: LocalDate
  readonly shifts: readonly RosteredShift[]
  readonly rules: WorkingHoursRules
  readonly isPublicHoliday: boolean
  readonly zone?: TimeZone
}): TradingDayHours {
  const { employeeId, tradingDate, shifts, rules, isPublicHoliday, zone = ASIA_DUBAI } = args
  for (const shift of shifts) {
    if (shift.employeeId !== employeeId || shift.tradingDate !== tradingDate) {
      throw new AppError(
        'validation',
        `Shift ${shift.shiftId} belongs to employee ${shift.employeeId} on ${shift.tradingDate}, not to ` +
          `${employeeId} on ${tradingDate}`,
      )
    }
  }
  const minutes = emptyBucketMinutes()
  let totalMinutes = 0
  let overtimeMinutes = 0
  const shiftIds: string[] = []

  for (const presence of mergePresences(shifts)) {
    const split = splitWorkedMinutes({
      period: presence.period,
      rules,
      isPublicHoliday,
      minutesAlreadyWorked: totalMinutes,
      zone,
    })
    for (const bucket of WORKED_MINUTE_BUCKETS) minutes[bucket] += split.minutes[bucket]
    totalMinutes += split.totalMinutes
    overtimeMinutes += split.overtimeMinutes
    shiftIds.push(...presence.shiftIds)
  }

  return {
    employeeId,
    tradingDate,
    totalMinutes,
    minutes,
    multiplierBp: multipliersOf(rules),
    weightedMinuteBp: weightedBp(minutes, rules),
    overtimeMinutes,
    overtimeBeyondCapMinutes: Math.max(0, overtimeMinutes - rules.overtimeDailyCapMinutes),
    isPublicHoliday,
    shiftIds,
  }
}

/**
 * The same UTC-midnight step `nextDate` in `../business-day/resolve.ts` takes forward, in both
 * directions.
 *
 * Local to this module rather than a widening of that one: the week boundary is this unit's arithmetic
 * and `business-day/resolve.ts` is B-CAT-01's module, and an exported `addDays` there is the kind of
 * general-purpose helper that later grows a timezone argument and becomes a second opinion about what a
 * date is. `T00:00:00Z` and `setUTCDate` because a `LocalDate` is a label, not an instant — stepping it
 * in any zone but UTC would make the answer depend on the offset at midnight.
 */
function stepDate(date: LocalDate, days: number): LocalDate {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return localDate(value.toISOString().slice(0, 10))
}

/**
 * The trading date a trading week starts on.
 *
 * Keyed on the **trading** date, which is the acceptance criterion this function exists for: a shift
 * starting 23:00 Friday and ending 02:00 Saturday has `trading_date` Friday, so it is Friday's week, and
 * no part of it is Saturday's. An implementation that keyed on the calendar date of either end of the
 * period would split that shift across two weeks, and both weekly totals would look ordinary.
 *
 * The weekday is computed in the business zone by `weekdayIn` rather than with `getDay()`, which answers
 * in whatever zone the machine happens to be in — and the machine running payroll is not necessarily in
 * the emirate.
 */
export function tradingWeekStart(
  tradingDate: LocalDate,
  weekStartsOn: number,
  zone: TimeZone = ASIA_DUBAI,
): LocalDate {
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new AppError('validation', `A working week starts on a weekday 0-6, got ${weekStartsOn}`)
  }
  const weekday = weekdayIn(tradingDate, zone)
  return stepDate(tradingDate, -((weekday - weekStartsOn + 7) % 7))
}

/** A `premises_closure` row, reduced to what a holiday calendar needs. */
export interface ClosureRow {
  readonly startsOn: LocalDate
  readonly endsOn: LocalDate
  /** `public_holiday`, `ramadan_hours`, `maintenance` or `other` (0003). */
  readonly kind: string
  readonly isConfirmed: boolean
}

/**
 * The trading dates that are public holidays, from `premises_closure` rows.
 *
 * **Unconfirmed rows are included**, and that is the strict direction rather than an oversight. UAE
 * public holidays are lunar and announced at short notice — 0003 carries `is_confirmed` for exactly that
 * reason — and of the two possible errors, paying an uplift for a day that turns out not to be a holiday
 * is visible and recoverable, while not paying one is a shortfall on a payslip nobody re-reads.
 *
 * The rows this can never see are the reason the holiday flag is an **argument** to the maths and not a
 * lookup inside it: a public holiday the premises trades through has no closure row at all, so this set
 * is a floor and not the calendar. That gap is recorded against Y9-overtime rather than filled with a
 * list of lunar dates, which brief rule 15 refuses — a plausible holiday calendar is indistinguishable
 * from a confirmed one.
 */
export function publicHolidayTradingDates(rows: readonly ClosureRow[]): ReadonlySet<LocalDate> {
  const dates = new Set<LocalDate>()
  for (const row of rows) {
    if (row.kind !== 'public_holiday') continue
    if (row.endsOn < row.startsOn) {
      throw new AppError(
        'validation',
        `A closure from ${row.startsOn} to ${row.endsOn} ends before it starts; 0003 refuses the row`,
      )
    }
    for (let date = row.startsOn; date <= row.endsOn; date = stepDate(date, 1)) dates.add(date)
  }
  return dates
}

/**
 * Rest-period breaches, naming both shifts.
 *
 * Between **presences** and not between rows, which is what {@link mergePresences} is for: a rota written
 * in two abutting halves has a zero-minute gap in the middle and is not a breach. The pair reported is
 * the last shift of the earlier presence and the first of the later one, because those are the two rows
 * somebody has to move.
 *
 * The minimum is read from the version governing the **later** shift's trading date: a rest requirement
 * applies to the shift that has to be delayed, and reading it from the earlier date would apply a rule
 * that had already been replaced.
 */
export function restViolations(args: {
  readonly shifts: readonly RosteredShift[]
  readonly ruleVersions: readonly WorkingHoursRules[]
}): readonly WorkingHoursViolation[] {
  const byEmployee = new Map<string, RosteredShift[]>()
  for (const shift of args.shifts) {
    const held = byEmployee.get(shift.employeeId)
    if (held === undefined) byEmployee.set(shift.employeeId, [shift])
    else held.push(shift)
  }
  const tradingDateOf = new Map(args.shifts.map((shift) => [shift.shiftId, shift.tradingDate]))
  const violations: WorkingHoursViolation[] = []

  for (const employeeId of [...byEmployee.keys()].sort()) {
    const presences = mergePresences(byEmployee.get(employeeId) as RosteredShift[])
    for (let index = 1; index < presences.length; index += 1) {
      const earlier = presences[index - 1] as Presence
      const later = presences[index] as Presence
      const laterShiftId = later.shiftIds[0] as string
      const rules = rulesFor(args.ruleVersions, tradingDateOf.get(laterShiftId) as LocalDate)
      // Instants, so a gap spanning midnight is the gap it is. A wall-clock subtraction would read the
      // gap between 02:00 and 11:00 as negative nine hours and report no breach at all.
      const gapMinutes = (later.period.startsAt - earlier.period.endsAt) / 60_000
      if (gapMinutes >= rules.minimumRestMinutes) continue
      violations.push({
        kind: 'minimum_rest',
        employeeId,
        earlierShiftId: earlier.shiftIds[earlier.shiftIds.length - 1] as string,
        laterShiftId,
        gapMinutes,
        minimumMinutes: rules.minimumRestMinutes,
      })
    }
  }
  return violations
}

/**
 * Everything the rota validator and payroll read: per trading date, per trading week, plus the breaches.
 *
 * The rule version is chosen **per trading date**, so a rate change part-way through a period splits
 * cleanly and the days before it keep the rates that applied. The weekly cap is read from the version
 * governing the week's first trading date: a rate change on Wednesday does not re-cap Monday and Tuesday.
 * A change to `weekStartsOn` mid-week can therefore place two days of one calendar week in two different
 * trading weeks, and that is the honest answer — when the definition of a week changed, there is no
 * single week to put them in.
 */
export function summariseWorkedHours(args: {
  readonly shifts: readonly RosteredShift[]
  readonly ruleVersions: readonly WorkingHoursRules[]
  readonly publicHolidays?: ReadonlySet<LocalDate>
  readonly zone?: TimeZone
}): WorkedHoursSummary {
  const { shifts, ruleVersions, publicHolidays, zone = ASIA_DUBAI } = args
  const grouped = new Map<string, RosteredShift[]>()
  for (const shift of shifts) {
    const key = `${shift.employeeId}\u0000${shift.tradingDate}`
    const held = grouped.get(key)
    if (held === undefined) grouped.set(key, [shift])
    else held.push(shift)
  }

  const days: TradingDayHours[] = []
  const violations: WorkingHoursViolation[] = []
  for (const key of [...grouped.keys()].sort()) {
    const group = grouped.get(key) as RosteredShift[]
    const first = group[0] as RosteredShift
    const rules = rulesFor(ruleVersions, first.tradingDate)
    const day = employeeTradingDayHours({
      employeeId: first.employeeId,
      tradingDate: first.tradingDate,
      shifts: group,
      rules,
      isPublicHoliday: publicHolidays?.has(first.tradingDate) ?? false,
      zone,
    })
    days.push(day)
    if (day.overtimeBeyondCapMinutes > 0) {
      violations.push({
        kind: 'daily_overtime_cap',
        employeeId: day.employeeId,
        tradingDate: day.tradingDate,
        overtimeMinutes: day.overtimeMinutes,
        capMinutes: rules.overtimeDailyCapMinutes,
      })
    }
  }

  const weekKeys = new Map<string, TradingDayHours[]>()
  for (const day of days) {
    const rules = rulesFor(ruleVersions, day.tradingDate)
    const weekStart = tradingWeekStart(day.tradingDate, rules.weekStartsOn, zone)
    const key = `${day.employeeId}\u0000${weekStart}`
    const held = weekKeys.get(key)
    if (held === undefined) weekKeys.set(key, [day])
    else held.push(day)
  }

  const weeks: TradingWeekHours[] = []
  for (const key of [...weekKeys.keys()].sort()) {
    const inWeek = weekKeys.get(key) as TradingDayHours[]
    const [employeeId, weekStart] = key.split('\u0000') as [string, string]
    const weekStartTradingDate = localDate(weekStart)
    const rules = rulesFor(ruleVersions, weekStartTradingDate)
    const minutes = emptyBucketMinutes()
    let totalMinutes = 0
    let overtimeMinutes = 0
    for (const day of inWeek) {
      for (const bucket of WORKED_MINUTE_BUCKETS) minutes[bucket] += day.minutes[bucket]
      totalMinutes += day.totalMinutes
      overtimeMinutes += day.overtimeMinutes
    }
    weeks.push({
      employeeId,
      weekStartTradingDate,
      tradingDates: inWeek.map((day) => day.tradingDate).sort(),
      totalMinutes,
      minutes,
      multiplierBp: multipliersOf(rules),
      weightedMinuteBp: weightedBp(minutes, rules),
      overtimeMinutes,
    })
    if (totalMinutes > rules.ordinaryMinutesPerWeek) {
      violations.push({
        kind: 'weekly_ordinary_cap',
        employeeId,
        weekStartTradingDate,
        totalMinutes,
        capMinutes: rules.ordinaryMinutesPerWeek,
      })
    }
  }

  violations.push(...restViolations({ shifts, ruleVersions }))
  return { days, weeks, violations }
}
