import { describe, expect, it } from 'vitest'
import {
  ASIA_DUBAI,
  fromLocal,
  type Instant,
  type LocalDate,
  localDate,
  localTime,
  minutesSinceMidnight,
  type TimeZone,
} from '../time.ts'
import {
  isWithinNightWindow,
  rulesFor,
  WORKED_MINUTE_BUCKETS,
  type WorkingHoursRules,
} from './rates.ts'
import {
  employeeTradingDayHours,
  mergePresences,
  publicHolidayTradingDates,
  type RosteredShift,
  restViolations,
  splitWorkedMinutes,
  summariseWorkedHours,
  tradingWeekStart,
  workedMinutes,
} from './working-hours.ts'

/**
 * P-HR-05 — working hours across midnight, against figures computed by hand.
 *
 * Every expected number below is worked out in the comment beside it from the rule set and the clock, not
 * taken from a previous run of the code under test. That is the whole discipline of this file: the defect
 * this unit exists to prevent produces *plausible* totals, so a snapshot of what the implementation said
 * would lock the defect in and read as coverage.
 *
 * The four mistakes each group is aimed at:
 *
 *   1. **Wall-clock subtraction.** `02:00 − 18:00` is −960 minutes, and `abs()` of it is 960, and neither
 *      is 480. The first case asserts 480 *and* asserts the naive figure is not 480, so an implementation
 *      that happened to agree by another route still has to agree with the right number.
 *   2. **The night window computed in the wrong zone.** Every instant of a trading day currently shares
 *      its UTC date with its trading date (the window is 07:00–22:00 UTC), so a UTC implementation is
 *      right about *which day* and wrong about *which minutes*: `18:00–02:00 Asia/Dubai` holds four hours
 *      of night-window time and none at all read as UTC. Asserted by running the same split in both zones.
 *   3. **Public-holiday-ness read per minute from the calendar date.** A 23:00–02:00 shift on a Friday
 *      trading date has 120 minutes whose calendar date is Saturday. If Saturday is the holiday and
 *      Friday is not, the correct answer is zero holiday minutes. Asserted in both directions.
 *   4. **Double counting.** A minute past the ordinary allowance *and* inside the night window is one
 *      minute. `overtimeMinutes` is 180 in the 15:00–02:00 case while the `overtime` BUCKET is empty,
 *      because the night rate is dearer — and the cap is judged on the eligible minutes, not on the
 *      bucket, which is the distinction that keeps a breach visible when the night rate absorbs it.
 *
 * The rule set below mirrors the version 0059 seeds. It is restated here rather than imported because
 * `packages/core` may not read a database; that the seeded row really carries these figures is asserted
 * against PostgreSQL by `packages/fixtures/src/hr-working-hours.itest.ts`.
 */
const V1: WorkingHoursRules = {
  effectiveFrom: localDate('1900-01-01'),
  ordinaryMinutesPerDay: 480,
  ordinaryMinutesPerWeek: 2880,
  weekStartsOn: 1,
  overtimeDailyCapMinutes: 120,
  minimumRestMinutes: 660,
  nightWindow: { from: localTime('22:00'), until: localTime('04:00') },
  multiplierBp: { ordinary: 10_000, overtime: 12_500, night: 15_000, publicHoliday: 15_000 },
}

const at = (date: string, time: string, zone: TimeZone = ASIA_DUBAI): Instant =>
  fromLocal(localDate(date), localTime(time), zone)

/** `[from, to)` as a period, where `to` may be a time on the following calendar date. */
const span = (fromDate: string, fromTime: string, toDate: string, toTime: string) => ({
  startsAt: at(fromDate, fromTime),
  endsAt: at(toDate, toTime),
})

const MONDAY = '2026-06-01'
const FRIDAY = '2026-06-05'
const SATURDAY = '2026-06-06'

const shift = (args: {
  id: string
  employeeId?: string
  tradingDate: string
  fromDate: string
  fromTime: string
  toDate: string
  toTime: string
}): RosteredShift => ({
  shiftId: args.id,
  employeeId: args.employeeId ?? 'employee-1',
  tradingDate: localDate(args.tradingDate),
  period: span(args.fromDate, args.fromTime, args.toDate, args.toTime),
})

describe('the length of a shift that crosses midnight', () => {
  it('is 480 minutes for 18:00-02:00, which wall-clock subtraction cannot produce', () => {
    // 18:00 to midnight is 6h, midnight to 02:00 is 2h. 8h = 480 minutes.
    expect(workedMinutes(span(MONDAY, '18:00', '2026-06-02', '02:00'))).toBe(480)

    // The control. Same-date subtraction of the two wall-clock times gives -960, and its absolute value
    // gives 960. Neither is the answer, and an implementation that produced either would be believed:
    // -960 looks like a sign bug somebody "fixes" with abs(), and 960 looks like a plausible long shift.
    const naive =
      minutesSinceMidnight(localTime('02:00')) - minutesSinceMidnight(localTime('18:00'))
    expect(naive).toBe(-960)
    expect(Math.abs(naive)).not.toBe(480)
  })

  it('is 180 minutes for the 23:00-02:00 shift the week test uses', () => {
    expect(workedMinutes(span(FRIDAY, '23:00', SATURDAY, '02:00'))).toBe(180)
  })

  it('refuses a span that ends when or before it starts, rather than returning a negative', () => {
    expect(() => workedMinutes(span(MONDAY, '18:00', MONDAY, '18:00'))).toThrow(/no worked minutes/)
    expect(() => workedMinutes(span(MONDAY, '18:00', MONDAY, '17:00'))).toThrow(/no worked minutes/)
  })

  it('refuses a boundary that is not on a whole minute rather than rounding paid time', () => {
    const period = {
      startsAt: at(MONDAY, '18:00'),
      endsAt: (at(MONDAY, '18:30') + 30_000) as Instant,
    }
    expect(() => workedMinutes(period)).toThrow(/whole minute/)
  })
})

describe('splitting 18:00-02:00 into buckets', () => {
  const split = splitWorkedMinutes({
    period: span(MONDAY, '18:00', '2026-06-02', '02:00'),
    rules: V1,
    isPublicHoliday: false,
  })

  it('puts the four hours from 22:00 in the night bucket and the rest in ordinary', () => {
    // 18:00-22:00 is 240 minutes outside the night window and inside the day's 480-minute allowance.
    // 22:00-02:00 is 240 minutes inside the window [22:00, 04:00). 240 + 240 = 480, the whole shift.
    expect(split.minutes.ordinary).toBe(240)
    expect(split.minutes.night).toBe(240)
    expect(split.minutes.overtime).toBe(0)
    expect(split.minutes.publicHoliday).toBe(0)
    expect(split.totalMinutes).toBe(480)
  })

  it('sums to the total exactly, with no minute counted twice or lost', () => {
    const summed = WORKED_MINUTE_BUCKETS.reduce((total, b) => total + split.minutes[b], 0)
    expect(summed).toBe(480)
  })

  it('weights the minutes with the multipliers from the rule set and nothing else', () => {
    // 240 x 10000 + 240 x 15000 = 2,400,000 + 3,600,000 = 6,000,000 basis-point-minutes.
    expect(split.weightedMinuteBp).toBe(6_000_000)
    expect(split.multiplierBp).toEqual(V1.multiplierBp)
  })

  it('loses the entire night window when the same split is computed in UTC', () => {
    // The control for the zone being a real argument. 18:00-02:00 Asia/Dubai is 14:00-22:00 UTC, and the
    // night window read as UTC wall-clock time then contains no minute of the shift at all: 22:00Z is the
    // exclusive end. A UTC implementation reports zero night minutes and still sums to 480, which is why
    // the sum property alone cannot catch it.
    const inUtc = splitWorkedMinutes({
      period: span(MONDAY, '18:00', '2026-06-02', '02:00'),
      rules: V1,
      isPublicHoliday: false,
      zone: 'UTC' as TimeZone,
    })
    expect(inUtc.totalMinutes).toBe(480)
    expect(inUtc.minutes.night).toBe(0)
    expect(inUtc.minutes.ordinary).toBe(480)
  })
})

describe('the overtime boundary and the daily cap', () => {
  it('puts the last two hours of an 11:00-21:00 shift in the overtime bucket', () => {
    // 600 minutes worked. The first 480 are ordinary (11:00-19:00); 19:00-21:00 is 120 minutes past the
    // allowance and nowhere near the night window, so the overtime bucket is the dearest that applies.
    const split = splitWorkedMinutes({
      period: span(MONDAY, '11:00', MONDAY, '21:00'),
      rules: V1,
      isPublicHoliday: false,
    })
    expect(split.totalMinutes).toBe(600)
    expect(split.minutes.ordinary).toBe(480)
    expect(split.minutes.overtime).toBe(120)
    expect(split.minutes.night).toBe(0)
    // 480 x 10000 + 120 x 12500 = 4,800,000 + 1,500,000 = 6,300,000.
    expect(split.weightedMinuteBp).toBe(6_300_000)
  })

  it('counts a minute that is both overtime and night ONCE, at the dearer night rate', () => {
    // 15:00-02:00 is 660 minutes. The allowance runs out at 23:00 (15:00 + 480), so 180 minutes are
    // overtime-eligible; the night window starts at 22:00, so 240 minutes are night. The 180 that are
    // both are counted once, in `night`, because 15000bp beats 12500bp.
    //   ordinary: 15:00-22:00 = 420
    //   night:    22:00-02:00 = 240   (60 of them still inside the allowance, 180 of them beyond it)
    //   overtime: 0            — every eligible minute was dearer as a night minute
    const split = splitWorkedMinutes({
      period: span(MONDAY, '15:00', '2026-06-02', '02:00'),
      rules: V1,
      isPublicHoliday: false,
    })
    expect(split.totalMinutes).toBe(660)
    expect(split.minutes.ordinary).toBe(420)
    expect(split.minutes.night).toBe(240)
    expect(split.minutes.overtime).toBe(0)
    // And the eligibility is still 180, which is what the cap is judged on. An implementation that read
    // the cap off the overtime BUCKET would report no breach here at all.
    expect(split.overtimeMinutes).toBe(180)
    // 420 x 10000 + 240 x 15000 = 4,200,000 + 3,600,000 = 7,800,000.
    expect(split.weightedMinuteBp).toBe(7_800_000)
  })

  it('reports the 60 minutes past the 2-hour cap on that day, and none on a shorter one', () => {
    const day = employeeTradingDayHours({
      employeeId: 'employee-1',
      tradingDate: localDate(MONDAY),
      shifts: [
        shift({
          id: 'shift-long',
          tradingDate: MONDAY,
          fromDate: MONDAY,
          fromTime: '15:00',
          toDate: '2026-06-02',
          toTime: '02:00',
        }),
      ],
      rules: V1,
      isPublicHoliday: false,
    })
    // 180 eligible minutes against a 120-minute cap.
    expect(day.overtimeMinutes).toBe(180)
    expect(day.overtimeBeyondCapMinutes).toBe(60)

    // The control: the 18:00-02:00 shift works exactly the allowance and breaches nothing, so the cap
    // rule is about the cap rather than about every long shift.
    const within = employeeTradingDayHours({
      employeeId: 'employee-1',
      tradingDate: localDate(MONDAY),
      shifts: [
        shift({
          id: 'shift-eight',
          tradingDate: MONDAY,
          fromDate: MONDAY,
          fromTime: '18:00',
          toDate: '2026-06-02',
          toTime: '02:00',
        }),
      ],
      rules: V1,
      isPublicHoliday: false,
    })
    expect(within.overtimeMinutes).toBe(0)
    expect(within.overtimeBeyondCapMinutes).toBe(0)
  })

  it('shares one day allowance across two shifts instead of giving each its own', () => {
    // 11:00-16:00 (300) then 18:00-23:00 (300) on one trading date: 600 minutes, so 120 are beyond the
    // 480 allowance. Those 120 are the LAST 120 worked — 21:00-23:00 — of which 22:00-23:00 is also
    // night. So overtime 60, night 60, ordinary 480. Two independent per-shift allowances would report
    // no overtime at all, because neither shift alone reaches 480.
    const day = employeeTradingDayHours({
      employeeId: 'employee-1',
      tradingDate: localDate(MONDAY),
      shifts: [
        shift({
          id: 'shift-early',
          tradingDate: MONDAY,
          fromDate: MONDAY,
          fromTime: '11:00',
          toDate: MONDAY,
          toTime: '16:00',
        }),
        shift({
          id: 'shift-late',
          tradingDate: MONDAY,
          fromDate: MONDAY,
          fromTime: '18:00',
          toDate: MONDAY,
          toTime: '23:00',
        }),
      ],
      rules: V1,
      isPublicHoliday: false,
    })
    expect(day.totalMinutes).toBe(600)
    expect(day.minutes.ordinary).toBe(480)
    expect(day.minutes.overtime).toBe(60)
    expect(day.minutes.night).toBe(60)
    expect(day.overtimeMinutes).toBe(120)
    expect(day.shiftIds).toEqual(['shift-early', 'shift-late'])
  })
})

describe('the public-holiday bucket follows the trading date, not the minute', () => {
  const fridayNight = shift({
    id: 'shift-friday-night',
    tradingDate: FRIDAY,
    fromDate: FRIDAY,
    fromTime: '23:00',
    toDate: SATURDAY,
    toTime: '02:00',
  })

  it('pays nothing at the holiday rate when the holiday is the calendar date it ENDS on', () => {
    // 120 of the 180 minutes have Saturday as their calendar date. Saturday is the holiday and Friday is
    // the trading date, so the correct answer is zero holiday minutes — and a per-minute calendar-date
    // reading would report 120.
    const day = employeeTradingDayHours({
      employeeId: 'employee-1',
      tradingDate: localDate(FRIDAY),
      shifts: [fridayNight],
      rules: V1,
      isPublicHoliday: publicHolidayTradingDates([
        {
          startsOn: localDate(SATURDAY),
          endsOn: localDate(SATURDAY),
          kind: 'public_holiday',
          isConfirmed: true,
        },
      ]).has(localDate(FRIDAY)),
    })
    expect(day.totalMinutes).toBe(180)
    expect(day.minutes.publicHoliday).toBe(0)
    // All 180 are inside [22:00, 04:00), so they are night minutes.
    expect(day.minutes.night).toBe(180)
  })

  it('pays every minute at the holiday rate when the TRADING date is the holiday', () => {
    const day = employeeTradingDayHours({
      employeeId: 'employee-1',
      tradingDate: localDate(FRIDAY),
      shifts: [fridayNight],
      rules: V1,
      isPublicHoliday: publicHolidayTradingDates([
        {
          startsOn: localDate(FRIDAY),
          endsOn: localDate(FRIDAY),
          kind: 'public_holiday',
          isConfirmed: true,
        },
      ]).has(localDate(FRIDAY)),
    })
    // Every minute is both night and holiday at equal rates; the tie goes to the holiday, because a
    // holiday is a property of the whole trading date and reporting it as night would make "how many
    // public-holiday minutes did we work" unanswerable.
    expect(day.minutes.publicHoliday).toBe(180)
    expect(day.minutes.night).toBe(0)
    expect(day.totalMinutes).toBe(180)
    // 180 x 15000 = 2,700,000, the same figure either way round — which is exactly why the tie-break
    // cannot be checked by the money and has to be checked by the bucket.
    expect(day.weightedMinuteBp).toBe(2_700_000)
  })

  it('gives the tie to night when the night rate is genuinely dearer', () => {
    const nightIsDearer: WorkingHoursRules = {
      ...V1,
      multiplierBp: { ...V1.multiplierBp, night: 16_000 },
    }
    const day = employeeTradingDayHours({
      employeeId: 'employee-1',
      tradingDate: localDate(FRIDAY),
      shifts: [fridayNight],
      rules: nightIsDearer,
      isPublicHoliday: true,
    })
    expect(day.minutes.night).toBe(180)
    expect(day.minutes.publicHoliday).toBe(0)
  })

  it('expands a multi-day closure and ignores closures of other kinds', () => {
    const dates = publicHolidayTradingDates([
      {
        startsOn: localDate(FRIDAY),
        endsOn: localDate('2026-06-07'),
        kind: 'public_holiday',
        isConfirmed: false,
      },
      {
        startsOn: localDate(MONDAY),
        endsOn: localDate(MONDAY),
        kind: 'maintenance',
        isConfirmed: true,
      },
    ])
    expect([...dates].sort()).toEqual(['2026-06-05', '2026-06-06', '2026-06-07'])
    // The control: a maintenance closure is not a public holiday, so nothing about Monday is a holiday.
    expect(dates.has(localDate(MONDAY))).toBe(false)
  })

  it('refuses a closure that ends before it starts', () => {
    expect(() =>
      publicHolidayTradingDates([
        {
          startsOn: localDate(SATURDAY),
          endsOn: localDate(FRIDAY),
          kind: 'public_holiday',
          isConfirmed: true,
        },
      ]),
    ).toThrow(/ends before it starts/)
  })
})

describe('the night window', () => {
  const window = V1.nightWindow

  it('wraps midnight, so 23:00 and 03:59 are night and 21:59 and 04:00 are not', () => {
    expect(isWithinNightWindow(localTime('22:00'), window)).toBe(true)
    expect(isWithinNightWindow(localTime('23:59'), window)).toBe(true)
    expect(isWithinNightWindow(localTime('00:00'), window)).toBe(true)
    expect(isWithinNightWindow(localTime('03:59'), window)).toBe(true)
    // Half-open at the far end, and closed at the near end.
    expect(isWithinNightWindow(localTime('04:00'), window)).toBe(false)
    expect(isWithinNightWindow(localTime('21:59'), window)).toBe(false)
    expect(isWithinNightWindow(localTime('12:00'), window)).toBe(false)
  })

  it('also handles a window that does not wrap, which is the branch a wrapping-only reading loses', () => {
    const daytime = { from: localTime('01:00'), until: localTime('05:00') }
    expect(isWithinNightWindow(localTime('00:59'), daytime)).toBe(false)
    expect(isWithinNightWindow(localTime('01:00'), daytime)).toBe(true)
    expect(isWithinNightWindow(localTime('04:59'), daytime)).toBe(true)
    expect(isWithinNightWindow(localTime('05:00'), daytime)).toBe(false)
  })
})

describe('merging rostered rows into presences', () => {
  const half = (id: string, fromTime: string, toDate: string, toTime: string) =>
    shift({ id, tradingDate: MONDAY, fromDate: MONDAY, fromTime, toDate, toTime })

  it('treats two abutting halves of a rota as one presence', () => {
    const presences = mergePresences([
      half('a', '18:00', MONDAY, '22:00'),
      half('b', '22:00', '2026-06-02', '02:00'),
    ])
    expect(presences).toHaveLength(1)
    expect(workedMinutes(presences[0]?.period as { startsAt: Instant; endsAt: Instant })).toBe(480)
    expect(presences[0]?.shiftIds).toEqual(['a', 'b'])
  })

  it('does not pay an overlap twice', () => {
    // 18:00-23:00 (300) and 22:00-02:00 (240) overlap by an hour. The presence is 18:00-02:00 = 480,
    // not 540.
    const day = employeeTradingDayHours({
      employeeId: 'employee-1',
      tradingDate: localDate(MONDAY),
      shifts: [half('a', '18:00', MONDAY, '23:00'), half('b', '22:00', '2026-06-02', '02:00')],
      rules: V1,
      isPublicHoliday: false,
    })
    expect(day.totalMinutes).toBe(480)
    expect(day.minutes.night).toBe(240)
  })

  it('keeps a real gap as two presences', () => {
    const presences = mergePresences([
      half('a', '11:00', MONDAY, '14:00'),
      half('b', '18:00', MONDAY, '22:00'),
    ])
    expect(presences).toHaveLength(2)
  })

  it('refuses a shift that belongs to another employee or another trading date', () => {
    expect(() =>
      employeeTradingDayHours({
        employeeId: 'employee-1',
        tradingDate: localDate(MONDAY),
        shifts: [{ ...half('a', '18:00', MONDAY, '22:00'), employeeId: 'employee-2' }],
        rules: V1,
        isPublicHoliday: false,
      }),
    ).toThrow(/belongs to employee employee-2/)
    expect(() =>
      employeeTradingDayHours({
        employeeId: 'employee-1',
        tradingDate: localDate(FRIDAY),
        shifts: [half('a', '18:00', MONDAY, '22:00')],
        rules: V1,
        isPublicHoliday: false,
      }),
    ).toThrow(/not to employee-1 on 2026-06-05/)
  })
})

describe('the week a shift belongs to', () => {
  it('starts on the configured weekday, computed in the business zone', () => {
    // 2026-06-05 is a Friday; the Monday of its week is 2026-06-01.
    expect(tradingWeekStart(localDate(FRIDAY), 1)).toBe('2026-06-01')
    // 2026-06-06 is a Saturday, whose Monday is still 2026-06-01.
    expect(tradingWeekStart(localDate(SATURDAY), 1)).toBe('2026-06-01')
    // The control: a different week start gives a different answer, so the argument is read. With weeks
    // starting on Saturday (6), Friday the 5th belongs to the week that began on Saturday the 30th of May.
    expect(tradingWeekStart(localDate(FRIDAY), 6)).toBe('2026-05-30')
    expect(tradingWeekStart(localDate(SATURDAY), 6)).toBe('2026-06-06')
  })

  it('refuses a week start that is not a weekday', () => {
    expect(() => tradingWeekStart(localDate(FRIDAY), 7)).toThrow(/weekday 0-6/)
  })

  it('counts a 23:00 Friday to 02:00 Saturday shift wholly in Friday’s week', () => {
    const summary = summariseWorkedHours({
      shifts: [
        shift({
          id: 'shift-friday-night',
          tradingDate: FRIDAY,
          fromDate: FRIDAY,
          fromTime: '23:00',
          toDate: SATURDAY,
          toTime: '02:00',
        }),
      ],
      ruleVersions: [V1],
    })
    expect(summary.days).toHaveLength(1)
    expect(summary.days[0]?.tradingDate).toBe(FRIDAY)
    expect(summary.weeks).toHaveLength(1)
    expect(summary.weeks[0]?.weekStartTradingDate).toBe('2026-06-01')
    // All 180 minutes, not 60 in one week and 120 in the next. A calendar-date key would put the two
    // hours after midnight in the week beginning 2026-06-08, and both weekly totals would look ordinary.
    expect(summary.weeks[0]?.totalMinutes).toBe(180)
    expect(summary.weeks[0]?.tradingDates).toEqual([FRIDAY])
    expect(summary.weeks.map((week) => week.weekStartTradingDate)).not.toContain('2026-06-08')
  })

  it('breaches the weekly cap on the minute past it, and not before', () => {
    // Six 480-minute shifts is 2880 minutes, exactly the weekly allowance: no breach. A seventh minute
    // breaches it, so the seventh shift is one minute long — 11:00 to 11:01 on the Sunday.
    const week = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', FRIDAY, SATURDAY]
    const sixDays = week.map((date, index) =>
      shift({
        id: `shift-${index}`,
        tradingDate: date,
        fromDate: date,
        fromTime: '18:00',
        toDate: nextCalendarDate(date),
        toTime: '02:00',
      }),
    )
    const exact = summariseWorkedHours({ shifts: sixDays, ruleVersions: [V1] })
    expect(exact.weeks[0]?.totalMinutes).toBe(2880)
    expect(exact.violations.filter((v) => v.kind === 'weekly_ordinary_cap')).toEqual([])

    const oneMoreMinute = summariseWorkedHours({
      shifts: [
        ...sixDays,
        shift({
          id: 'shift-sunday',
          tradingDate: '2026-06-07',
          fromDate: '2026-06-07',
          fromTime: '11:00',
          toDate: '2026-06-07',
          toTime: '11:01',
        }),
      ],
      ruleVersions: [V1],
    })
    expect(oneMoreMinute.weeks[0]?.totalMinutes).toBe(2881)
    expect(oneMoreMinute.violations).toContainEqual({
      kind: 'weekly_ordinary_cap',
      employeeId: 'employee-1',
      weekStartTradingDate: '2026-06-01',
      totalMinutes: 2881,
      capMinutes: 2880,
    })
  })
})

/** The next calendar date, for building a shift whose end is after midnight. */
function nextCalendarDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

describe('the rest period between consecutive shifts', () => {
  it('names both shift ids when the gap is under the minimum', () => {
    // Monday's shift ends at 02:00 on Tuesday; Tuesday's starts at 11:00. The gap is 9 hours = 540
    // minutes, under the 11-hour minimum.
    const violations = restViolations({
      shifts: [
        shift({
          id: 'shift-monday',
          tradingDate: MONDAY,
          fromDate: MONDAY,
          fromTime: '18:00',
          toDate: '2026-06-02',
          toTime: '02:00',
        }),
        shift({
          id: 'shift-tuesday',
          tradingDate: '2026-06-02',
          fromDate: '2026-06-02',
          fromTime: '11:00',
          toDate: '2026-06-02',
          toTime: '19:00',
        }),
      ],
      ruleVersions: [V1],
    })
    expect(violations).toEqual([
      {
        kind: 'minimum_rest',
        employeeId: 'employee-1',
        earlierShiftId: 'shift-monday',
        laterShiftId: 'shift-tuesday',
        gapMinutes: 540,
        minimumMinutes: 660,
      },
    ])
  })

  it('reports nothing when the gap clears the minimum', () => {
    // The control. Monday 11:00-19:00 then Tuesday 11:00-19:00 is a 16-hour gap.
    const violations = restViolations({
      shifts: [
        shift({
          id: 'shift-monday',
          tradingDate: MONDAY,
          fromDate: MONDAY,
          fromTime: '11:00',
          toDate: MONDAY,
          toTime: '19:00',
        }),
        shift({
          id: 'shift-tuesday',
          tradingDate: '2026-06-02',
          fromDate: '2026-06-02',
          fromTime: '11:00',
          toDate: '2026-06-02',
          toTime: '19:00',
        }),
      ],
      ruleVersions: [V1],
    })
    expect(violations).toEqual([])
  })

  it('does not report a rota written in two abutting halves as a breach', () => {
    // The gap between the rows is zero minutes, which is under every minimum there could be — and the
    // employee never went home. Without the merge this is the false breach the roster would show every
    // single day.
    const violations = restViolations({
      shifts: [
        shift({
          id: 'a',
          tradingDate: MONDAY,
          fromDate: MONDAY,
          fromTime: '18:00',
          toDate: MONDAY,
          toTime: '22:00',
        }),
        shift({
          id: 'b',
          tradingDate: MONDAY,
          fromDate: MONDAY,
          fromTime: '22:00',
          toDate: '2026-06-02',
          toTime: '02:00',
        }),
      ],
      ruleVersions: [V1],
    })
    expect(violations).toEqual([])
  })

  it('does not compare two different employees to each other', () => {
    const violations = restViolations({
      shifts: [
        shift({
          id: 'a',
          employeeId: 'employee-1',
          tradingDate: MONDAY,
          fromDate: MONDAY,
          fromTime: '11:00',
          toDate: MONDAY,
          toTime: '19:00',
        }),
        shift({
          id: 'b',
          employeeId: 'employee-2',
          tradingDate: MONDAY,
          fromDate: MONDAY,
          fromTime: '20:00',
          toDate: MONDAY,
          toTime: '23:00',
        }),
      ],
      ruleVersions: [V1],
    })
    expect(violations).toEqual([])
  })
})

describe('choosing the rule version', () => {
  const V2: WorkingHoursRules = {
    ...V1,
    effectiveFrom: localDate('2026-06-03'),
    multiplierBp: { ...V1.multiplierBp, overtime: 20_000 },
  }

  it('takes the latest version effective at or before the trading date', () => {
    expect(rulesFor([V1, V2], localDate('2026-06-02')).multiplierBp.overtime).toBe(12_500)
    expect(rulesFor([V1, V2], localDate('2026-06-03')).multiplierBp.overtime).toBe(20_000)
    // Order of the input must not matter: a SQL read without an `order by` is easy to write.
    expect(rulesFor([V2, V1], localDate('2026-06-02')).multiplierBp.overtime).toBe(12_500)
  })

  it('throws rather than defaulting when nothing governs the date', () => {
    expect(() => rulesFor([V2], localDate('2026-06-02'))).toThrow(/No working-hours rule version/)
    expect(() => rulesFor([], localDate('2026-06-02'))).toThrow(/invented its own rates/)
  })

  it('prices two days either side of a rate change at their own rates', () => {
    const summary = summariseWorkedHours({
      shifts: [
        shift({
          id: 'before',
          tradingDate: '2026-06-02',
          fromDate: '2026-06-02',
          fromTime: '11:00',
          toDate: '2026-06-02',
          toTime: '21:00',
        }),
        shift({
          id: 'after',
          tradingDate: '2026-06-03',
          fromDate: '2026-06-03',
          fromTime: '11:00',
          toDate: '2026-06-03',
          toTime: '21:00',
        }),
      ],
      ruleVersions: [V1, V2],
    })
    const [before, after] = summary.days
    // Both days are 480 ordinary + 120 overtime. Only the overtime rate differs.
    expect(before?.weightedMinuteBp).toBe(480 * 10_000 + 120 * 12_500)
    expect(after?.weightedMinuteBp).toBe(480 * 10_000 + 120 * 20_000)
  })

  it('refuses a rule set the arithmetic cannot be right about', () => {
    const empty = { ...V1, nightWindow: { from: localTime('22:00'), until: localTime('22:00') } }
    expect(() => rulesFor([empty], localDate(MONDAY))).toThrow(/covers either no minute/)

    const reduction = { ...V1, multiplierBp: { ...V1.multiplierBp, night: 9_000 } }
    expect(() => rulesFor([reduction], localDate(MONDAY))).toThrow(/below the ordinary rate/)

    const noOrdinaryDay = { ...V1, ordinaryMinutesPerDay: 0 }
    expect(() => rulesFor([noOrdinaryDay], localDate(MONDAY))).toThrow(/no ordinary minutes/)

    const fractionalRest = { ...V1, minimumRestMinutes: 12.5 }
    expect(() => rulesFor([fractionalRest], localDate(MONDAY))).toThrow(/whole number of minutes/)

    const badWeekStart = { ...V1, weekStartsOn: 9 }
    expect(() => rulesFor([badWeekStart], localDate(MONDAY))).toThrow(/weekday 0-6/)

    const longWeek = { ...V1, ordinaryMinutesPerWeek: 20_000 }
    expect(() => rulesFor([longWeek], localDate(MONDAY))).toThrow(/whole number of minutes/)

    const longCap = { ...V1, overtimeDailyCapMinutes: 2_000 }
    expect(() => rulesFor([longCap], localDate(MONDAY))).toThrow(/whole number of minutes/)
  })

  it('refuses a negative carry-in of minutes already worked', () => {
    expect(() =>
      splitWorkedMinutes({
        period: span(MONDAY, '18:00', MONDAY, '19:00'),
        rules: V1,
        isPublicHoliday: false,
        minutesAlreadyWorked: -1,
      }),
    ).toThrow(/not negative/)
  })
})

describe('the summary over several employees and days', () => {
  it('keys days on employee and trading date, and orders deterministically', () => {
    const shifts: RosteredShift[] = [
      shift({
        id: 's2',
        employeeId: 'employee-2',
        tradingDate: MONDAY,
        fromDate: MONDAY,
        fromTime: '11:00',
        toDate: MONDAY,
        toTime: '19:00',
      }),
      shift({
        id: 's1',
        employeeId: 'employee-1',
        tradingDate: FRIDAY,
        fromDate: FRIDAY,
        fromTime: '11:00',
        toDate: FRIDAY,
        toTime: '19:00',
      }),
      shift({
        id: 's0',
        employeeId: 'employee-1',
        tradingDate: MONDAY,
        fromDate: MONDAY,
        fromTime: '11:00',
        toDate: MONDAY,
        toTime: '19:00',
      }),
    ]
    const summary = summariseWorkedHours({ shifts, ruleVersions: [V1] })
    expect(summary.days.map((day) => `${day.employeeId} ${day.tradingDate}`)).toEqual([
      'employee-1 2026-06-01',
      'employee-1 2026-06-05',
      'employee-2 2026-06-01',
    ])
    // Two employees, one week each, and employee-1's two days are one week because both are in it.
    expect(summary.weeks).toHaveLength(2)
    expect(summary.weeks[0]?.tradingDates).toEqual([MONDAY, FRIDAY])
    expect(summary.weeks[0]?.totalMinutes).toBe(960)
  })

  it('returns no days and no weeks for no shifts', () => {
    expect(summariseWorkedHours({ shifts: [], ruleVersions: [V1] })).toEqual({
      days: [],
      weeks: [],
      violations: [],
    })
  })

  it('uses the trading date to look the holiday up, from a set the caller resolved', () => {
    const summary = summariseWorkedHours({
      shifts: [
        shift({
          id: 'holiday-shift',
          tradingDate: FRIDAY,
          fromDate: FRIDAY,
          fromTime: '11:00',
          toDate: FRIDAY,
          toTime: '19:00',
        }),
      ],
      ruleVersions: [V1],
      publicHolidays: new Set([localDate(FRIDAY)]) as ReadonlySet<LocalDate>,
    })
    expect(summary.days[0]?.isPublicHoliday).toBe(true)
    expect(summary.days[0]?.minutes.publicHoliday).toBe(480)
  })
})
