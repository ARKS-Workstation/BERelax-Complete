import { describe, expect, it } from 'vitest'
import { type HoursForDate, weekdayIn } from '../business-day/resolve.ts'
import {
  ASIA_DUBAI,
  fromLocal,
  type Instant,
  type LocalDate,
  localDate,
  localTime,
  type TradingHours,
} from '../time.ts'
import {
  accrualMonthsOwing,
  accrueMonth,
  addDays,
  applyLeaveLedgerEvent,
  assertLeaveEntitlementRules,
  calendarLeaveDays,
  emptyLeaveLedger,
  foldLeaveLedger,
  type LeaveEntitlementRules,
  type LeaveLedgerEvent,
  latestCompletedAccrualMonth,
  leaveCoveragePeriod,
  leaveDays,
  leaveLedgerProblems,
  leaveRulesFor,
  leaveYearStart,
  mayTakeAnnualLeaveOn,
  monthEnd,
  monthStart,
  openingBalanceOr,
  PROVISIONAL_OPENING_BALANCE,
  probationEndsOn,
  rolloverLeaveYear,
} from './leave-accrual.ts'

/**
 * P-HR-08 — leave entitlement and accrual, against figures worked out by hand.
 *
 * Every case name states the **rule it encodes**, which is the acceptance criterion for this file and
 * not a style preference: the figures are the build's provisional answer to Y9-leave-detail and none of
 * them is confirmed, so a case called "accrues 250" would say nothing about which rule had changed when
 * it goes red, and answering the question will make several of these fail on purpose.
 *
 * Every expected number is derived in the comment beside it from the rule set and the calendar, never
 * copied from a run of the code under test. The defects this unit exists to prevent all produce
 * *plausible* numbers — a working-day count instead of a calendar-day one, a part month accruing
 * nothing, a carried day expiring that should not — so a snapshot of what the implementation said would
 * lock one of them in and read as coverage.
 *
 * The rule set below mirrors the version 0066 seeds. Restated here rather than read, because
 * `packages/core` may not touch a database; that the seeded row really carries these figures is asserted
 * against PostgreSQL by `apps/worker/src/jobs/leave-accrual.itest.ts`.
 */
const V1: LeaveEntitlementRules = {
  effectiveFrom: localDate('1900-01-01'),
  annualEntitlementDays: 30,
  monthlyAccrualHundredths: 250,
  probationMonths: 6,
  accruesDuringProbation: true,
  carryOverCapHundredths: 3000,
  carryOverExpiresAfterOneLeaveYear: false,
  leaveYearStartsOnAnniversary: true,
  unpaidLeaveReducesAccrual: true,
  absentDayReducesAccrual: true,
  sickLeave: { fullPayDays: 15, halfPayDays: 30, unpaidDays: 45 },
}

const VERSIONS = [V1]
const day = (value: string): LocalDate => localDate(value)

/** 11:00–02:00, docs/01 decision 8. The premises trades every day (docs/13 §3). */
const HOURS: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const HOURS_FOR: HoursForDate = () => HOURS
const at = (date: string, time: string): Instant =>
  fromLocal(localDate(date), localTime(time), ASIA_DUBAI)

/** Twelve consecutive accrual months from a January. */
const twelveMonthsFrom = (year: number): readonly LocalDate[] =>
  Array.from({ length: 12 }, (_, index) => day(`${year}-${String(index + 1).padStart(2, '0')}-01`))

describe('a full year of service accrues the stated annual entitlement, exactly', () => {
  it('accrues 30 calendar days over twelve whole months, to the last day-hundredth', () => {
    // By hand: a whole month accrues the whole monthly figure — 250 day-hundredths, which is 2.5 days —
    // and twelve of them are 3000, which is 30 days. The arithmetic is integer throughout, so this is an
    // exact equality and not an approximation: twelve additions of the float 2.5 would also reach 30,
    // and 2.5 is one of the few decimals binary floating point represents exactly, which is precisely
    // why an implementation that used floats would pass this and fail on a month with unpaid days.
    const accrued = twelveMonthsFrom(2027)
      .map(
        (month) =>
          accrueMonth({ versions: VERSIONS, employedFrom: day('2027-01-01'), accrualMonth: month })
            .hundredths,
      )
      .reduce((total, hundredths) => total + hundredths, 0)
    expect(accrued).toBe(leaveDays(30))
    expect(accrued).toBe(3000)
  })

  it('accrues 2.5 days for a whole month, and pro-rates it for no whole month', () => {
    // A 31-day month: 250 x 31 / 31 is 250 with no rounding anywhere, which is why the pro-rating does
    // not disturb the ordinary case.
    const january = accrueMonth({
      versions: VERSIONS,
      employedFrom: day('2027-01-01'),
      accrualMonth: day('2027-01-01'),
    })
    expect(january.hundredths).toBe(250)
    expect(january.employedDays).toBe(31)
    expect(january.accruingDays).toBe(31)
    // A 28-day month reaches the same figure, because the monthly accrual is a monthly figure and not a
    // daily one. The control that matters: a per-day implementation would accrue less in February and
    // the twelve-month total would fall short of the entitlement.
    expect(
      accrueMonth({
        versions: VERSIONS,
        employedFrom: day('2027-01-01'),
        accrualMonth: day('2027-02-01'),
      }).hundredths,
    ).toBe(250)
  })

  it('accrues from the first day of service, pro-rated for the month of engagement', () => {
    // Engaged on 15 January: 17 of January's 31 days are employed (the 15th to the 31st inclusive), so
    // the accrual is 250 x 17 / 31 = 137.09..., rounded UP to 138 because the rounding direction is
    // towards the employee. Y9-leave-detail's recorded answer is "accrual from day 1"; a "completed
    // month" reading would give this month zero and cost every joiner not engaged on the 1st.
    const january = accrueMonth({
      versions: VERSIONS,
      employedFrom: day('2027-01-15'),
      accrualMonth: day('2027-01-01'),
    })
    expect(january.employedDays).toBe(17)
    expect(january.hundredths).toBe(138)
    expect(january.hundredths).not.toBe(0)
  })

  it('accrues nothing for a month wholly before the engagement, without failing', () => {
    // Zero is a real answer here and is reported rather than thrown: the catch-up window may reach a
    // month the employee was not engaged in, and a throw would stop the whole pass.
    const before = accrueMonth({
      versions: VERSIONS,
      employedFrom: day('2027-01-15'),
      accrualMonth: day('2026-11-01'),
    })
    expect(before.employedDays).toBe(0)
    expect(before.hundredths).toBe(0)
  })

  it('stops accruing after the last day of employment, pro-rated for the final month', () => {
    // Employment ends 10 March: 10 of March's 31 days, so 250 x 10 / 31 = 80.6 rounded up to 81.
    const march = accrueMonth({
      versions: VERSIONS,
      employedFrom: day('2027-01-01'),
      employedUntil: day('2027-03-10'),
      accrualMonth: day('2027-03-01'),
    })
    expect(march.employedDays).toBe(10)
    expect(march.hundredths).toBe(81)
  })

  it('records which policy version produced the figure, so a recomputed month is comparable', () => {
    // Two versions, and the March accrual must use the one in force in March. A "current version" read
    // would answer March with the later figures, which is the mistake `working_hours_rule` records for
    // the same reason one subject along: payroll recomputes the past.
    const v2: LeaveEntitlementRules = {
      ...V1,
      effectiveFrom: day('2027-06-01'),
      annualEntitlementDays: 36,
      monthlyAccrualHundredths: 300,
    }
    const march = accrueMonth({
      versions: [V1, v2],
      employedFrom: day('2027-01-01'),
      accrualMonth: day('2027-03-01'),
    })
    expect(march.ruleEffectiveFrom).toBe(day('1900-01-01'))
    expect(march.hundredths).toBe(250)
    const july = accrueMonth({
      versions: [V1, v2],
      employedFrom: day('2027-01-01'),
      accrualMonth: day('2027-07-01'),
    })
    expect(july.ruleEffectiveFrom).toBe(day('2027-06-01'))
    expect(july.hundredths).toBe(300)
  })
})

describe('probation stops leave being TAKEN and does not stop it accruing', () => {
  it('runs accrual through probation, because Y9-leave-detail answers "accrual from day 1"', () => {
    const january = accrueMonth({
      versions: VERSIONS,
      employedFrom: day('2027-01-01'),
      accrualMonth: day('2027-01-01'),
    })
    expect(january.isProbationary).toBe(true)
    expect(january.hundredths).toBe(250)
  })

  it('refuses annual leave on the last day of probation and allows it on the next', () => {
    // Six months from 1 January ends on 1 July, so 30 June is still probation and 1 July is not. The
    // pair is asserted rather than one side of it, because an off-by-one moves both.
    expect(probationEndsOn(V1, day('2027-01-01'))).toBe(day('2027-07-01'))
    expect(mayTakeAnnualLeaveOn(V1, day('2027-01-01'), day('2027-06-30'))).toBe(false)
    expect(mayTakeAnnualLeaveOn(V1, day('2027-01-01'), day('2027-07-01'))).toBe(true)
  })

  it('clamps the probation end into the month the contract names, never past it', () => {
    // 31 August plus six months is 28 February, not 3 March. An overflowing step would put the first day
    // of eligible leave in the month after the one the contract names.
    expect(probationEndsOn(V1, day('2026-08-31'))).toBe(day('2027-02-28'))
  })

  it('accrues nothing during probation when the policy says accrual waits', () => {
    // The control for the first case in this group. The flag is data, so the opposite policy must be
    // expressible and must actually change the answer — otherwise the first case proves nothing about
    // the flag being read.
    const waits: LeaveEntitlementRules = { ...V1, accruesDuringProbation: false }
    expect(
      accrueMonth({
        versions: [waits],
        employedFrom: day('2027-01-01'),
        accrualMonth: day('2027-01-01'),
      }).hundredths,
    ).toBe(0)
    // And the month after probation ends still accrues in full, so the flag gates the probationary
    // months and nothing else.
    expect(
      accrueMonth({
        versions: [waits],
        employedFrom: day('2027-01-01'),
        accrualMonth: day('2027-07-01'),
      }).hundredths,
    ).toBe(250)
  })

  it('treats a month straddling the probation end as NOT probationary', () => {
    // June ends 30 June, before the 1 July probation end, so June is probationary. July is not, although
    // its first day is the probation end itself. Whether leave may be TAKEN is asked per date, by
    // mayTakeAnnualLeaveOn, because a per-month flag could only be right about one side of the boundary.
    expect(
      accrueMonth({
        versions: VERSIONS,
        employedFrom: day('2027-01-01'),
        accrualMonth: day('2027-06-01'),
      }).isProbationary,
    ).toBe(true)
    expect(
      accrueMonth({
        versions: VERSIONS,
        employedFrom: day('2027-01-01'),
        accrualMonth: day('2027-07-01'),
      }).isProbationary,
    ).toBe(false)
  })
})

describe('unpaid leave and ABSENT days reduce accrual per the configured rule', () => {
  it('pro-rates a month with 6 days of unpaid leave down from 2.5 days to 2.02', () => {
    // By hand: March has 31 days, 6 of them earn nothing, so 25 accrue: 250 x 25 / 31 = 201.61, rounded
    // up to 202. The comparison with the unreduced 250 is the assertion that matters — a rule that read
    // the flag and then ignored the count would return 250 and look ordinary.
    const reduced = accrueMonth({
      versions: VERSIONS,
      employedFrom: day('2027-01-01'),
      accrualMonth: day('2027-03-01'),
      unpaidLeaveDays: 6,
    })
    expect(reduced.reducedDays).toBe(6)
    expect(reduced.accruingDays).toBe(25)
    expect(reduced.hundredths).toBe(202)
    expect(reduced.hundredths).toBeLessThan(250)
  })

  it('pro-rates a month with 3 ABSENT days down from 2.5 days to exactly 2.25', () => {
    // April has 30 days and 250 x 27 / 30 is 225 exactly, so this case carries no rounding at all: it is
    // the one that would catch a reduction applied in the wrong direction or to the wrong denominator.
    const reduced = accrueMonth({
      versions: VERSIONS,
      employedFrom: day('2027-01-01'),
      accrualMonth: day('2027-04-01'),
      absentDays: 3,
    })
    expect(reduced.hundredths).toBe(225)
  })

  it('leaves accrual alone when the policy says unpaid leave does not reduce it', () => {
    // The control. Both flags are data on the rule row, so each must be shown to change the answer;
    // otherwise the two cases above are about the arithmetic and say nothing about the rule being read.
    const lenient: LeaveEntitlementRules = { ...V1, unpaidLeaveReducesAccrual: false }
    const unreduced = accrueMonth({
      versions: [lenient],
      employedFrom: day('2027-01-01'),
      accrualMonth: day('2027-03-01'),
      unpaidLeaveDays: 6,
    })
    expect(unreduced.reducedDays).toBe(0)
    expect(unreduced.hundredths).toBe(250)
  })

  it('leaves accrual alone when the policy says an ABSENT day does not reduce it', () => {
    const lenient: LeaveEntitlementRules = { ...V1, absentDayReducesAccrual: false }
    expect(
      accrueMonth({
        versions: [lenient],
        employedFrom: day('2027-01-01'),
        accrualMonth: day('2027-04-01'),
        absentDays: 3,
      }).hundredths,
    ).toBe(250)
  })

  it('adds the two reductions rather than taking the larger of them', () => {
    // 4 unpaid plus 5 absent is 9 days that do not earn, not 5. April: 250 x 21 / 30 = 175 exactly.
    expect(
      accrueMonth({
        versions: VERSIONS,
        employedFrom: day('2027-01-01'),
        accrualMonth: day('2027-04-01'),
        unpaidLeaveDays: 4,
        absentDays: 5,
      }).hundredths,
    ).toBe(175)
  })

  it('refuses more non-earning days than the employment covered, rather than clamping to zero', () => {
    // Engaged on 20 April, so 11 days are employed; 20 unpaid days in that month is a disagreement
    // between the absence record and the employment period. Clamping it would accrue nothing for a month
    // somebody was at work, which is a silent loss.
    expect(() =>
      accrueMonth({
        versions: VERSIONS,
        employedFrom: day('2027-04-20'),
        accrualMonth: day('2027-04-01'),
        unpaidLeaveDays: 20,
      }),
    ).toThrow(/do not earn accrual but the employment covered only/)
  })

  it('refuses an absence count that is not a whole number of days inside the month', () => {
    expect(() =>
      accrueMonth({
        versions: VERSIONS,
        employedFrom: day('2027-01-01'),
        accrualMonth: day('2027-04-01'),
        absentDays: 31,
      }),
    ).toThrow(/Absent days/)
    expect(() =>
      accrueMonth({
        versions: VERSIONS,
        employedFrom: day('2027-01-01'),
        accrualMonth: day('2027-04-01'),
        unpaidLeaveDays: 1.5,
      }),
    ).toThrow(/Unpaid leave days/)
  })

  it('refuses an employment period that ends before it starts', () => {
    expect(() =>
      accrueMonth({
        versions: VERSIONS,
        employedFrom: day('2027-04-20'),
        employedUntil: day('2027-04-10'),
        accrualMonth: day('2027-04-01'),
      }),
    ).toThrow(/ends before it starts/)
  })
})

describe('the leave-year boundary caps what crosses it', () => {
  it('carries 30 days and forfeits the rest of a 34-day balance, the cap being 30', () => {
    // 3400 closing, cap 3000: 3000 crosses and 400 is lost to the cap. The two parts of the forfeiture
    // are reported separately because only one of them could have been avoided by taking leave sooner.
    const rollover = rolloverLeaveYear({ rules: V1, closingHundredths: 3400 })
    expect(rollover.carriedHundredths).toBe(3000)
    expect(rollover.forfeitedHundredths).toBe(400)
    expect(rollover.cappedHundredths).toBe(400)
    expect(rollover.expiredHundredths).toBe(0)
    // The parts sum to the whole, always. A forfeiture that did not decompose would be unexplainable to
    // the person it happened to.
    expect(rollover.cappedHundredths + rollover.expiredHundredths).toBe(
      rollover.forfeitedHundredths,
    )
  })

  it('carries a balance under the cap whole, forfeiting nothing', () => {
    const rollover = rolloverLeaveYear({ rules: V1, closingHundredths: 2000 })
    expect(rollover.carriedHundredths).toBe(2000)
    expect(rollover.forfeitedHundredths).toBe(0)
  })

  it('does NOT expire unused carried days under the seeded policy', () => {
    // The seeded answer, and the position this unit takes where the two recorded provisional answers
    // disagree: forfeiting entitlement is the irreversible error and a balance that is too high is a
    // visible one.
    const rollover = rolloverLeaveYear({
      rules: V1,
      closingHundredths: 2500,
      carriedInHundredths: 1000,
      takenFromCarryInHundredths: 400,
    })
    expect(rollover.expiredHundredths).toBe(0)
    expect(rollover.carriedHundredths).toBe(2500)
  })

  it('expires the unused part of last year’s carry-in when the policy says it lapses', () => {
    // The control, and the proof that answering Y9-leave-detail the other way is a data change and not a
    // code change: 1000 carried in, 400 of it used, so 600 lapses out of a 2500 closing balance and 1900
    // crosses. The cap does not bite at 1900, so this case isolates expiry from capping.
    const expiring: LeaveEntitlementRules = { ...V1, carryOverExpiresAfterOneLeaveYear: true }
    const rollover = rolloverLeaveYear({
      rules: expiring,
      closingHundredths: 2500,
      carriedInHundredths: 1000,
      takenFromCarryInHundredths: 400,
    })
    expect(rollover.expiredHundredths).toBe(600)
    expect(rollover.carriedHundredths).toBe(1900)
    expect(rollover.cappedHundredths).toBe(0)
  })

  it('applies expiry before the cap, so no hundredth is forfeited twice', () => {
    // 3600 closing with 800 of unused carry-in and a cap of 3000. Expiry first: 800 lapses, 2800 remains,
    // and the cap does not bite. The other order would cap 3600 to 3000 and then expire 800 of it, which
    // reports 1400 forfeited out of a 3600 balance that only lost 800.
    const expiring: LeaveEntitlementRules = { ...V1, carryOverExpiresAfterOneLeaveYear: true }
    const rollover = rolloverLeaveYear({
      rules: expiring,
      closingHundredths: 3600,
      carriedInHundredths: 800,
      takenFromCarryInHundredths: 0,
    })
    expect(rollover.expiredHundredths).toBe(800)
    expect(rollover.cappedHundredths).toBe(0)
    expect(rollover.carriedHundredths).toBe(2800)
    expect(rollover.forfeitedHundredths).toBe(800)
  })

  it('never expires more than the balance still holds', () => {
    // 1000 carried in, none of it recorded as taken, but the balance is down to 300 — the days went on
    // something. Expiring 1000 would forfeit 700 that is not there and drive the balance negative.
    const expiring: LeaveEntitlementRules = { ...V1, carryOverExpiresAfterOneLeaveYear: true }
    const rollover = rolloverLeaveYear({
      rules: expiring,
      closingHundredths: 300,
      carriedInHundredths: 1000,
    })
    expect(rollover.expiredHundredths).toBe(300)
    expect(rollover.carriedHundredths).toBe(0)
  })

  it('refuses a carry-in consumed by more than it held', () => {
    expect(() =>
      rolloverLeaveYear({
        rules: V1,
        closingHundredths: 1000,
        carriedInHundredths: 100,
        takenFromCarryInHundredths: 200,
      }),
    ).toThrow(/cannot have been taken from a carry-in/)
  })
})

describe('the leave year runs from the employment anniversary', () => {
  it('starts the leave year on the last anniversary at or before the date', () => {
    // Engaged 15 March 2027. On 1 January 2029 the leave year in progress began on 15 March 2028, not on
    // 15 March 2029 (which has not happened) and not on 1 January.
    expect(leaveYearStart(V1, day('2027-03-15'), day('2029-01-01'))).toBe(day('2028-03-15'))
    expect(leaveYearStart(V1, day('2027-03-15'), day('2029-03-15'))).toBe(day('2029-03-15'))
    expect(leaveYearStart(V1, day('2027-03-15'), day('2027-03-15'))).toBe(day('2027-03-15'))
  })

  it('clamps a 29 February anniversary rather than skipping three years in four', () => {
    // Engaged 29 February 2028. The 2029 anniversary is 28 February, because 29 February 2029 does not
    // exist. Reconstructing the anniversary from a month and a day would produce an invalid date.
    expect(leaveYearStart(V1, day('2028-02-29'), day('2029-06-01'))).toBe(day('2029-02-28'))
  })

  it('starts the leave year on 1 January when the policy is not anniversary-based', () => {
    // The control. The flag is data and must change the answer, and 1 January is the only alternative
    // expressible — any other anchor would be a date invented here (brief rule 15).
    const calendar: LeaveEntitlementRules = { ...V1, leaveYearStartsOnAnniversary: false }
    expect(leaveYearStart(calendar, day('2027-03-15'), day('2029-01-01'))).toBe(day('2029-01-01'))
    expect(leaveYearStart(calendar, day('2027-03-15'), day('2029-01-01'))).not.toBe(
      leaveYearStart(V1, day('2027-03-15'), day('2029-01-01')),
    )
  })

  it('refuses a date before the employment started', () => {
    expect(() => leaveYearStart(V1, day('2027-03-15'), day('2027-01-01'))).toThrow(
      /is in no leave year/,
    )
  })
})

describe('a leave day is a CALENDAR day, and a working-day count is a different number', () => {
  /**
   * The oracle: working days, written from the definition rather than from the code under test.
   *
   * Friday is taken as the weekly rest day, which is what makes this oracle differ. `weekdayIn` is the
   * business zone's own weekday reading — not `getDay()`, which answers in whatever zone the machine is
   * in — so the oracle is an independent implementation and not a transcription.
   */
  const workingDaysExcludingFridays = (from: LocalDate, to: LocalDate): number => {
    let worked = 0
    for (let date = from; date <= to; date = addDays(date, 1)) {
      if (weekdayIn(date, ASIA_DUBAI) !== 5) worked += 1
    }
    return worked
  }

  it('consumes 30 days for a 30-day annual request spanning four weekly rest days', () => {
    // 1 March 2027 is a Monday (1 January 2027 is a Friday; January has 31 days and February 28, both
    // multiples of seven plus three and zero respectively). The 30 days to 30 March therefore contain
    // four Fridays — the 5th, 12th, 19th and 26th — so a working-day count answers 26.
    const from = day('2027-03-01')
    const to = day('2027-03-30')
    expect(calendarLeaveDays({ from, to })).toBe(30)

    const oracle = workingDaysExcludingFridays(from, to)
    expect(oracle).toBe(26)
    // The assertion this criterion is really about: the two MUST differ. An engine that accidentally
    // counted working days would answer 26 here, which is a perfectly sensible-looking number, and the
    // only symptom would be somebody's balance running out four days early.
    expect(calendarLeaveDays({ from, to })).not.toBe(oracle)
  })

  it('counts both ends, so a single day of leave is one day and not zero', () => {
    expect(calendarLeaveDays({ from: day('2027-03-17'), to: day('2027-03-17') })).toBe(1)
    // The half-open reading, which is the plausible wrong one: 1 to 30 March would be 29.
    expect(calendarLeaveDays({ from: day('2027-03-01'), to: day('2027-03-30') })).not.toBe(29)
  })

  it('counts across a month and a leap day without consulting a calendar of working days', () => {
    // 20 February to 5 March 2028: 10 days of February (the 20th to the 29th, 2028 being a leap year)
    // plus 5 of March.
    expect(calendarLeaveDays({ from: day('2028-02-20'), to: day('2028-03-05') })).toBe(15)
  })

  it('refuses a range that ends before it starts', () => {
    expect(() => calendarLeaveDays({ from: day('2027-03-30'), to: day('2027-03-01') })).toThrow(
      /ends before it starts/,
    )
  })
})

describe('a leave day covers its TRADING session, not two calendar midnights', () => {
  it('covers the 01:30 instant whose calendar date is the day after the leave day', () => {
    // One day of leave on 17 March. Trading runs 11:00-02:00, so the session opens at 11:00 on the 17th
    // and closes at 02:00 on the 18th, and the 01:30 appointment in that tail is inside the leave.
    const period = leaveCoveragePeriod({
      from: day('2027-03-17'),
      to: day('2027-03-17'),
      hoursFor: HOURS_FOR,
    })
    expect(period.startsAt).toBe(at('2027-03-17', '11:00'))
    expect(period.endsAt).toBe(at('2027-03-18', '02:00'))

    const oneThirty = at('2027-03-18', '01:30')
    expect(oneThirty >= period.startsAt && oneThirty < period.endsAt).toBe(true)

    // The control, and the reading 0030 warned this unit off: two calendar midnights. The 01:30
    // appointment falls OUTSIDE it, so the therapist stays rostered for the last two hours of their
    // leave day and nothing about the stored period looks wrong.
    const naive = {
      startsAt: at('2027-03-17', '00:00'),
      endsAt: at('2027-03-18', '00:00'),
    }
    expect(oneThirty >= naive.startsAt && oneThirty < naive.endsAt).toBe(false)
  })

  it('does not swallow the tail of the PREVIOUS trading day', () => {
    // 01:30 on the 17th belongs to the 16th's session, which is not leave. A period starting at midnight
    // on the 17th would cover it and take two hours off a day the employee is working.
    const period = leaveCoveragePeriod({
      from: day('2027-03-17'),
      to: day('2027-03-17'),
      hoursFor: HOURS_FOR,
    })
    const previousTail = at('2027-03-17', '01:30')
    expect(previousTail < period.startsAt).toBe(true)
  })

  it('spans a run of leave days from the first opening to the last close', () => {
    const period = leaveCoveragePeriod({
      from: day('2027-03-17'),
      to: day('2027-03-19'),
      hoursFor: HOURS_FOR,
    })
    expect(period.startsAt).toBe(at('2027-03-17', '11:00'))
    expect(period.endsAt).toBe(at('2027-03-20', '02:00'))
  })

  it('falls back to the calendar day on a date the premises does not open', () => {
    // There is no session to cover, so the calendar day is the only reading available. It covers nothing
    // the rota could have offered anyway.
    const closed: HoursForDate = (date) => (date === day('2027-03-17') ? undefined : HOURS)
    const period = leaveCoveragePeriod({
      from: day('2027-03-17'),
      to: day('2027-03-17'),
      hoursFor: closed,
    })
    expect(period.startsAt).toBe(at('2027-03-17', '00:00'))
    expect(period.endsAt).toBe(at('2027-03-18', '00:00'))
  })

  it('refuses a run of leave days that ends before it starts', () => {
    expect(() =>
      leaveCoveragePeriod({
        from: day('2027-03-19'),
        to: day('2027-03-17'),
        hoursFor: HOURS_FOR,
      }),
    ).toThrow(/ends before it starts/)
  })
})

describe('which month may be accrued is decided on the trading session, not the calendar', () => {
  it('will not accrue February at 01:30 on 1 March, because February’s last session is open', () => {
    // 01:30 on 1 March is inside the session that opened at 11:00 on 28 February, so February's last
    // trading day has not finished. The latest month that may be accrued is January.
    expect(
      latestCompletedAccrualMonth({ tradingDate: day('2027-02-28'), sessionIsOpen: true }),
    ).toBe(day('2027-01-01'))
  })

  it('accrues February once that same session has closed at 02:00', () => {
    expect(
      latestCompletedAccrualMonth({ tradingDate: day('2027-02-28'), sessionIsOpen: false }),
    ).toBe(day('2027-02-01'))
  })

  it('accrues February from any later trading date in March', () => {
    expect(
      latestCompletedAccrualMonth({ tradingDate: day('2027-03-01'), sessionIsOpen: true }),
    ).toBe(day('2027-02-01'))
    expect(
      latestCompletedAccrualMonth({ tradingDate: day('2027-03-15'), sessionIsOpen: false }),
    ).toBe(day('2027-02-01'))
  })

  it('normalises any date in a month to its first day, which is the accrual key', () => {
    expect(monthStart(day('2027-03-17'))).toBe(day('2027-03-01'))
    expect(monthEnd(day('2027-02-17'))).toBe(day('2027-02-28'))
    expect(monthEnd(day('2028-02-17'))).toBe(day('2028-02-29'))
  })
})

describe('the months owing are bounded at both ends and by the catch-up window', () => {
  it('lists every month from engagement to the last complete one, oldest first', () => {
    expect(
      accrualMonthsOwing({
        employedFrom: day('2027-01-15'),
        throughMonth: day('2027-06-01'),
        maxMonths: 24,
      }),
    ).toEqual([
      day('2027-01-01'),
      day('2027-02-01'),
      day('2027-03-01'),
      day('2027-04-01'),
      day('2027-05-01'),
      day('2027-06-01'),
    ])
  })

  it('reaches no further back than the catch-up window, so a first pass cannot write a decade', () => {
    // The bound matters because the alternative is a first run against a long-standing roster deriving
    // years of accrual the business has no record of agreeing. History before the window is the opening
    // balance importer's job: one stated figure with a source beats a hundred derived ones.
    expect(
      accrualMonthsOwing({
        employedFrom: day('2019-01-15'),
        throughMonth: day('2027-06-01'),
        maxMonths: 3,
      }),
    ).toEqual([day('2027-04-01'), day('2027-05-01'), day('2027-06-01')])
  })

  it('stops at the month employment ended in', () => {
    expect(
      accrualMonthsOwing({
        employedFrom: day('2027-01-15'),
        employedUntil: day('2027-03-20'),
        throughMonth: day('2027-06-01'),
        maxMonths: 24,
      }),
    ).toEqual([day('2027-01-01'), day('2027-02-01'), day('2027-03-01')])
  })

  it('skips the months already accrued, which is the idempotency this pass depends on', () => {
    expect(
      accrualMonthsOwing({
        employedFrom: day('2027-01-15'),
        throughMonth: day('2027-03-01'),
        maxMonths: 24,
        alreadyAccrued: [day('2027-02-01')],
      }),
    ).toEqual([day('2027-01-01'), day('2027-03-01')])
  })

  it('lists nothing for an employee engaged after the window, without failing', () => {
    expect(
      accrualMonthsOwing({
        employedFrom: day('2027-08-01'),
        throughMonth: day('2027-06-01'),
        maxMonths: 24,
      }),
    ).toEqual([])
  })

  it('refuses a catch-up window of zero months, which would be a no-op reporting success', () => {
    expect(() =>
      accrualMonthsOwing({
        employedFrom: day('2027-01-15'),
        throughMonth: day('2027-06-01'),
        maxMonths: 0,
      }),
    ).toThrow(/at least one month/)
  })
})

describe('accrual starts from the imported opening balance, and zero is not silently zero', () => {
  it('answers an un-imported employee with a flagged zero naming Y8-leave', () => {
    const balance = openingBalanceOr(undefined)
    expect(balance).toEqual(PROVISIONAL_OPENING_BALANCE)
    expect(balance.hundredths).toBe(0)
    expect(balance.isImported).toBe(false)
    expect(balance.isProvisional).toBe(true)
    expect(balance.openQuestionId).toBe('Y8-leave')
  })

  it('answers an imported zero as imported, which is a different fact from the same number', () => {
    // The control, and the whole point of the distinction: an imported zero needs nothing and an
    // un-imported zero needs the HR file loading. A bare number cannot tell the two apart.
    const imported = openingBalanceOr({
      hundredths: 0,
      isImported: true,
      isProvisional: false,
      openQuestionId: null,
      sourceNote: 'HR handover file, row 4',
    })
    expect(imported.hundredths).toBe(0)
    expect(imported.isImported).toBe(true)
    expect(imported.isProvisional).toBe(false)
  })

  it('accrues on TOP of an imported balance of 12 days, reaching 42 after a full year', () => {
    // 1200 imported plus twelve months at 250 is 4200, which is 42 days. The control is the same fold
    // without the import: an engine that ignored the opening balance would answer 3000, which is exactly
    // the annual entitlement and therefore looks entirely correct.
    const withImport: LeaveLedgerEvent[] = [
      { kind: 'opening_balance', hundredths: leaveDays(12) },
      ...twelveMonthsFrom(2027).map(
        (month): LeaveLedgerEvent => ({ kind: 'accrual', accrualMonth: month, hundredths: 250 }),
      ),
    ]
    const imported = foldLeaveLedger(withImport)
    expect(imported.ledger.availableHundredths).toBe(4200)
    expect(leaveLedgerProblems(imported.ledger)).toEqual([])

    const withoutImport = foldLeaveLedger(withImport.slice(1))
    expect(withoutImport.ledger.availableHundredths).toBe(3000)
    expect(imported.ledger.availableHundredths).not.toBe(withoutImport.ledger.availableHundredths)
  })
})

describe('the balance is the sum of the movements, and it never goes negative', () => {
  const events: LeaveLedgerEvent[] = [
    { kind: 'opening_balance', hundredths: 500 },
    { kind: 'accrual', accrualMonth: localDate('2027-01-01'), hundredths: 250 },
    { kind: 'request', requestId: 'r1', hundredths: 300 },
  ]

  it('reserves a request when it is made, before anybody approves it', () => {
    // Reserving at request rather than at approval is the strict reading: two pending requests each
    // inside the balance but together over it is the failure a balance-at-approval model allows, and it
    // is discovered when the second one is approved and the balance goes negative.
    const { ledger } = foldLeaveLedger(events)
    expect(ledger.availableHundredths).toBe(450)
    expect(ledger.reservedHundredths).toBe(300)
    expect(ledger.takenHundredths).toBe(0)
    expect(leaveLedgerProblems(ledger)).toEqual([])
  })

  it('writes no movement on approval, because the reservation already moved the balance', () => {
    const before = foldLeaveLedger(events).ledger
    const step = applyLeaveLedgerEvent(before, { kind: 'approve', requestId: 'r1' })
    expect(step.movement).toBeNull()
    expect(step.ledger.availableHundredths).toBe(450)
    expect(step.ledger.reservedHundredths).toBe(0)
    expect(step.ledger.takenHundredths).toBe(300)
    // A `taken` movement here would take the days out a second time. The movement count is the
    // assertion that catches it.
    expect(step.ledger.movements).toHaveLength(before.movements.length)
  })

  it('returns the days when approved leave is cancelled, and the ledger still reconciles', () => {
    const { ledger } = foldLeaveLedger([
      ...events,
      { kind: 'approve', requestId: 'r1' },
      { kind: 'cancel', requestId: 'r1' },
    ])
    expect(ledger.availableHundredths).toBe(750)
    expect(ledger.takenHundredths).toBe(0)
    expect(ledger.reservedHundredths).toBe(0)
    expect(leaveLedgerProblems(ledger)).toEqual([])
    const summed = ledger.movements.reduce((total, movement) => total + movement.hundredths, 0)
    expect(summed).toBe(ledger.availableHundredths)
  })

  it('returns the days when a pending request is rejected', () => {
    const { ledger } = foldLeaveLedger([...events, { kind: 'reject', requestId: 'r1' }])
    expect(ledger.availableHundredths).toBe(750)
    expect(ledger.reservedHundredths).toBe(0)
    expect(ledger.requests['r1']?.status).toBe('rejected')
  })

  it('refuses a request larger than the balance rather than going negative', () => {
    const before = foldLeaveLedger(events).ledger
    const step = applyLeaveLedgerEvent(before, {
      kind: 'request',
      requestId: 'r2',
      hundredths: 500,
    })
    expect(step.refusal?.reason).toBe('insufficient_balance')
    expect(step.movement).toBeNull()
    // Unchanged, not partially applied. A refusal that mutated the ledger would be the worst of both.
    expect(step.ledger).toEqual(before)
  })

  it('refuses two pending requests that are each affordable and together are not', () => {
    // 450 available: 300 then 300. The second is refused. Without reservation at request time both
    // would be accepted and the second approval would drive the balance to -150.
    const { ledger, steps } = foldLeaveLedger([
      ...events,
      { kind: 'request', requestId: 'r2', hundredths: 300 },
      { kind: 'request', requestId: 'r3', hundredths: 300 },
    ])
    expect(steps[3]?.refusal).toBeNull()
    expect(steps[4]?.refusal?.reason).toBe('insufficient_balance')
    expect(ledger.availableHundredths).toBe(150)
    expect(ledger.availableHundredths).toBeGreaterThanOrEqual(0)
  })

  it('refuses a second accrual for a month already accrued, which is the job’s idempotency', () => {
    const before = foldLeaveLedger(events).ledger
    const step = applyLeaveLedgerEvent(before, {
      kind: 'accrual',
      accrualMonth: localDate('2027-01-31'),
      hundredths: 250,
    })
    // Normalised to the first of the month, so a second accrual keyed on a different day of the same
    // month is still the same month.
    expect(step.refusal?.reason).toBe('month_already_accrued')
    expect(step.ledger.availableHundredths).toBe(450)
  })

  it('refuses a second opening balance, which would add to the first rather than replace it', () => {
    const before = foldLeaveLedger(events).ledger
    const step = applyLeaveLedgerEvent(before, { kind: 'opening_balance', hundredths: 100 })
    expect(step.refusal?.reason).toBe('opening_balance_already_set')
  })

  it('refuses a decision on a request nobody made, and a second decision on a decided one', () => {
    const before = foldLeaveLedger([...events, { kind: 'approve', requestId: 'r1' }]).ledger
    expect(
      applyLeaveLedgerEvent(before, { kind: 'approve', requestId: 'ghost' }).refusal?.reason,
    ).toBe('unknown_request')
    expect(
      applyLeaveLedgerEvent(before, { kind: 'approve', requestId: 'r1' }).refusal?.reason,
    ).toBe('request_already_decided')
    expect(applyLeaveLedgerEvent(before, { kind: 'reject', requestId: 'r1' }).refusal?.reason).toBe(
      'request_already_decided',
    )
    // Cancelling an APPROVED request is legal — withdrawing a booked holiday is the ordinary case — so
    // the control has to distinguish the two, or "already decided" would be refusing the wrong thing.
    expect(applyLeaveLedgerEvent(before, { kind: 'cancel', requestId: 'r1' }).refusal).toBeNull()
  })

  it('refuses replaying a request already on the ledger, which would reserve the days twice', () => {
    const before = foldLeaveLedger(events).ledger
    expect(
      applyLeaveLedgerEvent(before, { kind: 'request', requestId: 'r1', hundredths: 100 }).refusal
        ?.reason,
    ).toBe('request_already_known')
  })

  it('refuses a cancellation of an already cancelled request', () => {
    const before = foldLeaveLedger([...events, { kind: 'cancel', requestId: 'r1' }]).ledger
    expect(applyLeaveLedgerEvent(before, { kind: 'cancel', requestId: 'r1' }).refusal?.reason).toBe(
      'request_already_decided',
    )
  })

  it('forfeits a carry-over as a negative movement, and refuses one bigger than the balance', () => {
    const before = foldLeaveLedger(events).ledger
    const forfeited = applyLeaveLedgerEvent(before, {
      kind: 'forfeit_carry_over',
      hundredths: 400,
    })
    expect(forfeited.movement?.kind).toBe('carry_over_forfeited')
    expect(forfeited.movement?.hundredths).toBe(-400)
    expect(forfeited.ledger.availableHundredths).toBe(50)
    expect(forfeited.ledger.forfeitedHundredths).toBe(400)
    expect(
      applyLeaveLedgerEvent(before, { kind: 'forfeit_carry_over', hundredths: 500 }).refusal
        ?.reason,
    ).toBe('insufficient_balance')
  })

  it('reports nothing wrong with an empty ledger, so the checker is not failing everything', () => {
    expect(leaveLedgerProblems(emptyLeaveLedger())).toEqual([])
  })

  it('throws rather than refuses on a malformed amount, which is a programming error', () => {
    expect(() =>
      applyLeaveLedgerEvent(emptyLeaveLedger(), { kind: 'opening_balance', hundredths: 1.5 }),
    ).toThrow(/day-hundredths/)
    expect(() =>
      applyLeaveLedgerEvent(emptyLeaveLedger(), {
        kind: 'accrual',
        accrualMonth: localDate('2027-01-01'),
        hundredths: -1,
      }),
    ).toThrow(/day-hundredths/)
    expect(() => leaveDays(-1)).toThrow(/whole number of leave days/)
    expect(() => leaveDays(1.5)).toThrow(/whole number of leave days/)
  })
})

describe('a policy version the arithmetic cannot be right about is refused', () => {
  it('accepts the seeded version, so the refusals below are about the versions and not the guard', () => {
    expect(() => assertLeaveEntitlementRules(V1)).not.toThrow()
  })

  it('refuses a version whose annual entitlement disagrees with twelve months of accrual', () => {
    // 30 days is 3000 day-hundredths and twelve months at 200 accrue 2400. The two figures are the same
    // entitlement stated twice, and a version where they disagree puts one number on the contract and a
    // different one in the ledger — both plausible, only one of them paid.
    expect(() => assertLeaveEntitlementRules({ ...V1, monthlyAccrualHundredths: 200 })).toThrow(
      /same entitlement stated twice/,
    )
  })

  it('refuses an entitlement, accrual, cap or probation figure that is not a whole non-negative number', () => {
    expect(() => assertLeaveEntitlementRules({ ...V1, annualEntitlementDays: 0 })).toThrow(
      /annual entitlement/,
    )
    expect(() => assertLeaveEntitlementRules({ ...V1, carryOverCapHundredths: -1 })).toThrow(
      /carry-over cap/,
    )
    expect(() => assertLeaveEntitlementRules({ ...V1, probationMonths: -1 })).toThrow(/Probation/)
    expect(() => assertLeaveEntitlementRules({ ...V1, monthlyAccrualHundredths: 250.5 })).toThrow(
      /monthly accrual/,
    )
  })

  it('refuses a version with an impossible sick-leave tier set, through the same guard', () => {
    expect(() =>
      assertLeaveEntitlementRules({
        ...V1,
        sickLeave: { fullPayDays: 0, halfPayDays: 0, unpaidDays: 0 },
      }),
    ).toThrow(/entitling nobody/)
  })

  it('picks the version governing a date, and refuses a date no version governs', () => {
    const v2: LeaveEntitlementRules = { ...V1, effectiveFrom: day('2027-06-01') }
    expect(leaveRulesFor([V1, v2], day('2027-05-31')).effectiveFrom).toBe(day('1900-01-01'))
    expect(leaveRulesFor([v2, V1], day('2027-06-01')).effectiveFrom).toBe(day('2027-06-01'))
    // Unordered input is the normal case: the caller is a SQL read and an `order by` is easy to lose.
    expect(leaveRulesFor([v2, V1], day('2030-01-01')).effectiveFrom).toBe(day('2027-06-01'))
    expect(() => leaveRulesFor([v2], day('2027-05-31'))).toThrow(
      /No leave entitlement version is effective/,
    )
    expect(() => leaveRulesFor([], day('2027-05-31'))).toThrow(/an entitlement nobody decided/)
  })
})
