import { describe, expect, it } from 'vitest'
import golden from '../../test/fixtures/holiday-impact-golden.json' with { type: 'json' }
import { type LocalDate, localDate } from '../time.ts'
import {
  HOLIDAY_IMPACT_FORMAT_VERSION,
  HOLIDAY_PREDICTED_QUALIFIER,
  type HolidayObservance,
  holidayBasisOf,
  holidayConfirmationImpact,
  holidayFigure,
  holidayImpactBytes,
  holidayPayCalendar,
  observanceDates,
  publicHolidayMinutes,
  publishHolidayFigure,
  weakestHolidayBasis,
} from './holiday-impact.ts'
import type { TradingDayHours } from './working-hours.ts'

/**
 * P-HR-10's first, second, fifth and sixth acceptance lines, pure.
 *
 * ## The dates in this file are FIXTURE dates
 *
 * They are in 2081, which no suite, gate or fixture anywhere in this repository uses, and they are not a
 * claim about when any lunar observance falls. Brief rule 15 refuses an invented date in the DATABASE
 * because a plausible one is indistinguishable from a configured one; a date in a pure test that no
 * migration replays and no report reads is a worked example, and 2081 is chosen so nobody can mistake it
 * for one. The real dates are `Y9-holiday-calendar`.
 *
 * ## What each group proves, and the control that makes it mean something
 *
 *   * **The figure says what it rests on.** Every count is a `HolidayFigure`, and the control for each
 *     marking assertion is the SAME input with the confirmation state flipped — so a function that
 *     returned `confirmed` unconditionally fails rather than passing half the file.
 *   * **A retained date is not an impact.** The control is the same rows over a confirmation that moved
 *     the holiday off their date, which DOES report them.
 *   * **The bytes are pinned.** The golden file holds the exact serialisation; the control is a report
 *     built from one changed field, whose bytes must differ — because an equality of two empty strings is
 *     also an equality.
 */

/** The holiday's predicted range: two days. */
const PREDICTED_FROM = localDate('2081-03-10')
const PREDICTED_TO = localDate('2081-03-11')
/** The announced range: moved one day later, so one date is released, one retained, one acquired. */
const CONFIRMED_FROM = localDate('2081-03-11')
const CONFIRMED_TO = localDate('2081-03-12')

const provisional: HolidayObservance = {
  id: '01810000-0000-7000-8000-000000000001',
  kind: 'public_holiday',
  name: 'Fixture lunar holiday',
  dateBasis: 'lunar',
  confirmationState: 'provisional',
  startsOn: PREDICTED_FROM,
  endsOn: PREDICTED_TO,
  openQuestionId: 'Y9-holiday-calendar',
}

const confirmed: HolidayObservance = {
  ...provisional,
  confirmationState: 'confirmed',
  startsOn: CONFIRMED_FROM,
  endsOn: CONFIRMED_TO,
  openQuestionId: null,
}

/** One appointment on each of the three dates, so each side of the move has exactly one row. */
const appointments = [
  { appointmentId: 'a0000000-0000-7000-8000-000000000001', tradingDate: PREDICTED_FROM },
  { appointmentId: 'a0000000-0000-7000-8000-000000000002', tradingDate: CONFIRMED_FROM },
  { appointmentId: 'a0000000-0000-7000-8000-000000000003', tradingDate: CONFIRMED_TO },
] as const

const shiftAssignments = [
  {
    shiftId: 'b0000000-0000-7000-8000-000000000001',
    employeeId: 'e0000000-0000-7000-8000-000000000001',
    tradingDate: PREDICTED_FROM,
  },
  {
    shiftId: 'b0000000-0000-7000-8000-000000000001',
    employeeId: 'e0000000-0000-7000-8000-000000000002',
    tradingDate: PREDICTED_FROM,
  },
  {
    shiftId: 'b0000000-0000-7000-8000-000000000002',
    employeeId: 'e0000000-0000-7000-8000-000000000001',
    tradingDate: CONFIRMED_TO,
  },
] as const

const approvedLeave = [
  {
    leaveRequestId: 'c0000000-0000-7000-8000-000000000001',
    employeeId: 'e0000000-0000-7000-8000-000000000003',
    tradingDate: PREDICTED_FROM,
  },
  {
    leaveRequestId: 'c0000000-0000-7000-8000-000000000001',
    employeeId: 'e0000000-0000-7000-8000-000000000003',
    tradingDate: CONFIRMED_FROM,
  },
] as const

const report = (observance: HolidayObservance = confirmed) =>
  holidayConfirmationImpact({
    observance,
    previousStartsOn: PREDICTED_FROM,
    previousEndsOn: PREDICTED_TO,
    appointments: [...appointments],
    shiftAssignments: [...shiftAssignments],
    approvedLeave: [...approvedLeave],
  })

describe('an observance is a range of trading dates', () => {
  it('expands to every date it covers, ascending', () => {
    expect(observanceDates(provisional)).toEqual([PREDICTED_FROM, PREDICTED_TO])
    expect(observanceDates({ ...provisional, endsOn: PREDICTED_FROM })).toEqual([PREDICTED_FROM])
  })

  it('refuses a range that ends before it starts', () => {
    expect(() => observanceDates({ ...provisional, endsOn: localDate('2081-03-09') })).toThrow(
      /ends before it starts/,
    )
  })
})

describe('a figure says what it rests on, and a predicted one carries the words', () => {
  it('is as weak as its weakest date', () => {
    expect(weakestHolidayBasis(['confirmed', 'confirmed'])).toBe('confirmed')
    expect(weakestHolidayBasis(['confirmed', 'predicted'])).toBe('predicted')
    // An empty set is `confirmed`, which is only safe because a count of nought has nothing to qualify.
    expect(weakestHolidayBasis([])).toBe('confirmed')
  })

  it('reads the basis off the observance rather than from a caller argument', () => {
    expect(holidayBasisOf([confirmed])).toBe('confirmed')
    expect(holidayBasisOf([provisional])).toBe('predicted')
    expect(holidayBasisOf([confirmed, provisional])).toBe('predicted')
  })

  it('returns the qualifier WITH the number, so the two cannot be separated', () => {
    const settled = publishHolidayFigure(holidayFigure({ count: 3, basis: 'confirmed' }))
    expect(settled).toEqual({ count: 3, qualifier: '' })
    const predicted = publishHolidayFigure(
      holidayFigure({ count: 3, basis: 'predicted', openQuestionIds: ['Y9-holiday-calendar'] }),
    )
    expect(predicted.count).toBe(3)
    expect(predicted.qualifier).toBe(HOLIDAY_PREDICTED_QUALIFIER)
    expect(predicted.qualifier).not.toBe('')
  })

  it('deduplicates and sorts the open questions, so two runs produce one answer', () => {
    const figure = holidayFigure({
      count: 1,
      basis: 'predicted',
      openQuestionIds: ['Y9-overtime', 'Y9-holiday-calendar', 'Y9-overtime'],
    })
    expect(figure).toEqual({
      basis: 'predicted',
      count: 1,
      openQuestionIds: ['Y9-holiday-calendar', 'Y9-overtime'],
    })
  })

  it('refuses a count that is not a whole number of rows', () => {
    expect(() => holidayFigure({ count: -1, basis: 'confirmed' })).toThrow(/whole rows/)
    expect(() => holidayFigure({ count: 1.5, basis: 'confirmed' })).toThrow(/whole rows/)
  })
})

describe('acceptance — a provisional holiday is distinguishable, and Ramadan is not a pay bucket', () => {
  it('splits the pay calendar into announced and predicted dates', () => {
    const calendar = holidayPayCalendar([
      confirmed,
      {
        ...provisional,
        id: 'x',
        startsOn: localDate('2081-04-01'),
        endsOn: localDate('2081-04-01'),
      },
    ])
    expect([...calendar.confirmedDates].sort()).toEqual([CONFIRMED_FROM, CONFIRMED_TO])
    expect([...calendar.predictedDates]).toEqual([localDate('2081-04-01')])
    expect(calendar.openQuestionIds).toEqual(['Y9-holiday-calendar'])
    // The union is what `summariseWorkedHours({ publicHolidays })` takes: a provisional holiday IS paid
    // at the uplift, which is the strict direction. The split is what lets the figure say so.
    expect(calendar.dates.size).toBe(3)
  })

  it('makes a date covered by both a predicted and an announced observance PREDICTED', () => {
    const calendar = holidayPayCalendar([
      { ...confirmed, startsOn: PREDICTED_FROM, endsOn: PREDICTED_FROM },
      { ...provisional, startsOn: PREDICTED_FROM, endsOn: PREDICTED_FROM },
    ])
    expect([...calendar.predictedDates]).toEqual([PREDICTED_FROM])
    expect(calendar.confirmedDates.size).toBe(0)
  })

  it('keeps Ramadan out of the pay dates, because Ramadan changes HOURS and not the bucket', () => {
    const calendar = holidayPayCalendar([
      { ...provisional, kind: 'ramadan', name: 'Fixture Ramadan' },
    ])
    expect(calendar.dates.size).toBe(0)
    expect([...calendar.ramadanDates].sort()).toEqual([PREDICTED_FROM, PREDICTED_TO])
  })
})

describe('acceptance — the public-holiday bucket is distinct and says what it rests on', () => {
  /** Two employee-days, as `summariseWorkedHours(...).days` returns them. */
  const day = (
    tradingDate: LocalDate,
    publicHoliday: number,
    ordinary: number,
  ): TradingDayHours => ({
    employeeId: 'e0000000-0000-7000-8000-000000000001',
    tradingDate,
    totalMinutes: publicHoliday + ordinary,
    minutes: { publicHoliday, night: 0, overtime: 0, ordinary },
    multiplierBp: { publicHoliday: 15_000, night: 12_500, overtime: 12_500, ordinary: 10_000 },
    weightedMinuteBp: publicHoliday * 15_000 + ordinary * 10_000,
    overtimeMinutes: 0,
    overtimeBeyondCapMinutes: 0,
    isPublicHoliday: publicHoliday > 0,
    shiftIds: ['b0000000-0000-7000-8000-000000000001'],
  })

  it('reports the minutes P-HR-05 counted, marked by the dates they fell on', () => {
    const calendar = holidayPayCalendar([confirmed])
    const figure = publicHolidayMinutes({
      days: [day(CONFIRMED_FROM, 480, 0), day(localDate('2081-03-20'), 0, 480)],
      calendar,
    })
    // 480 and not 960: the ordinary day contributes nothing, which is the "never folded into ordinary
    // hours" half of the acceptance line read from this side.
    expect(figure).toEqual({ basis: 'confirmed', count: 480 })
  })

  it('marks the same minutes PREDICTED when the date they fell on is predicted', () => {
    // The control for the assertion above, and the acceptance line's real subject: the number is
    // identical and the claim is not.
    const figure = publicHolidayMinutes({
      days: [day(PREDICTED_FROM, 480, 0)],
      calendar: holidayPayCalendar([provisional]),
    })
    expect(figure).toEqual({
      basis: 'predicted',
      count: 480,
      openQuestionIds: ['Y9-holiday-calendar'],
    })
  })

  it('is as weak as its weakest day across a period', () => {
    const calendar = holidayPayCalendar([confirmed, { ...provisional, id: 'y' }])
    const figure = publicHolidayMinutes({
      days: [day(CONFIRMED_TO, 300, 0), day(PREDICTED_FROM, 180, 0)],
      calendar,
    })
    expect(figure.count).toBe(480)
    expect(figure.basis).toBe('predicted')
  })
})

describe('acceptance — confirming onto a different date reports what it affected', () => {
  it('names the released, acquired and retained dates', () => {
    const impact = report()
    expect(impact.releasedDates).toEqual([PREDICTED_FROM])
    expect(impact.acquiredDates).toEqual([CONFIRMED_TO])
    expect(impact.retainedDates).toEqual([CONFIRMED_FROM])
  })

  it('lists the appointments, shift assignments and approved leave on the two changed dates only', () => {
    const impact = report()
    expect(impact.appointments.map((row) => [row.reference.slice(-3), row.side])).toEqual([
      ['001', 'released'],
      ['003', 'acquired'],
    ])
    // Both halves of `shift_assignment`'s key: two employees on one shift are two rows to act on.
    expect(impact.shiftAssignments.map((row) => row.reference)).toEqual([
      'b0000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001',
      'b0000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000002',
      'b0000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000001',
    ])
    expect(impact.approvedLeave).toHaveLength(1)
    expect(impact.approvedLeave[0]?.side).toBe('released')
  })

  it('omits a row on a RETAINED date, because nothing about it changed', () => {
    // The subject, asserted here rather than only implied by the list above: the appointment and the
    // leave day on CONFIRMED_FROM — a date the holiday was on before the announcement and is on after —
    // are ABSENT, because nothing about them changed and a report whose rows are mostly noise is one
    // nobody reads to the end.
    const impact = report()
    expect(impact.retainedDates).toEqual([CONFIRMED_FROM])
    expect(impact.appointments.map((row) => row.reference)).not.toContain(
      appointments[1]?.appointmentId,
    )
    expect(impact.approvedLeave.map((row) => row.tradingDate)).not.toContain(CONFIRMED_FROM)
    expect(impact.appointments.map((row) => row.tradingDate)).not.toContain(CONFIRMED_FROM)

    // And the control: a confirmation that moves the holiday CLEAR of that date does report it — so the
    // omission is a function of the dates rather than a row this function drops.
    const movedClear = report({
      ...confirmed,
      startsOn: localDate('2081-03-20'),
      endsOn: localDate('2081-03-20'),
    })
    expect(movedClear.retainedDates).toEqual([])
    expect(movedClear.acquiredDates).toEqual([localDate('2081-03-20')])
    // `002` is on CONFIRMED_FROM, which was RETAINED in the report above and is RELEASED here. Same row,
    // same inputs, different side — which is the omission being the rule rather than a dropped row.
    // `003` is on neither range now, so it is absent from both reports, and nothing on the acquired date
    // is booked at all: an impact report over a holiday nobody is working through is empty, correctly.
    expect(movedClear.appointments.map((row) => [row.reference.slice(-3), row.side])).toEqual([
      ['001', 'released'],
      ['002', 'released'],
    ])
  })

  it('carries a figure per collection, marked by the observance that produced it', () => {
    const impact = report()
    expect(impact.figures.appointments).toEqual({ basis: 'confirmed', count: 2 })
    expect(impact.figures.shiftAssignments).toEqual({ basis: 'confirmed', count: 3 })
    expect(impact.figures.approvedLeave).toEqual({ basis: 'confirmed', count: 1 })
  })

  it('marks the SAME counts predicted when the report is run before the announcement', () => {
    // The admin surface shows what a confirmation would do before it is recorded, and that report rests
    // on a date nobody has announced. Identical numbers, different claim.
    const preview = holidayConfirmationImpact({
      observance: { ...provisional, startsOn: CONFIRMED_FROM, endsOn: CONFIRMED_TO },
      previousStartsOn: PREDICTED_FROM,
      previousEndsOn: PREDICTED_TO,
      appointments: [...appointments],
      shiftAssignments: [...shiftAssignments],
      approvedLeave: [...approvedLeave],
    })
    expect(preview.figures.appointments).toEqual({
      basis: 'predicted',
      count: 2,
      openQuestionIds: ['Y9-holiday-calendar'],
    })
    expect(publishHolidayFigure(preview.figures.appointments).qualifier).toBe(
      HOLIDAY_PREDICTED_QUALIFIER,
    )
  })

  it('reports nothing when the announcement confirms the date it already had', () => {
    const unmoved = holidayConfirmationImpact({
      observance: { ...confirmed, startsOn: PREDICTED_FROM, endsOn: PREDICTED_TO },
      previousStartsOn: PREDICTED_FROM,
      previousEndsOn: PREDICTED_TO,
      appointments: [...appointments],
      shiftAssignments: [...shiftAssignments],
      approvedLeave: [...approvedLeave],
    })
    expect(unmoved.releasedDates).toEqual([])
    expect(unmoved.acquiredDates).toEqual([])
    expect(unmoved.appointments).toEqual([])
    expect(unmoved.figures.appointments).toEqual({ basis: 'confirmed', count: 0 })
  })
})

describe('acceptance — the report is deterministic, pinned by a golden file', () => {
  it('is byte-identical across two independent builds', () => {
    expect(holidayImpactBytes(report())).toBe(holidayImpactBytes(report()))
  })

  it('matches the committed golden exactly', () => {
    expect(holidayImpactBytes(report())).toBe(golden.bytes)
    // The golden carries the figures, so the equality is not an equality of two empty strings.
    expect(golden.bytes).toContain(`"formatVersion":"${HOLIDAY_IMPACT_FORMAT_VERSION}"`)
    expect(golden.bytes.length).toBeGreaterThan(500)
  })

  it('distinguishes one report from another — the control', () => {
    // A golden file that matched everything would be satisfied by a serialiser returning a constant.
    const moved = report({ ...confirmed, endsOn: localDate('2081-03-13') })
    expect(holidayImpactBytes(moved)).not.toBe(golden.bytes)
  })

  it('holds no instant at all, which is what makes the clock irrelevant', () => {
    // A `generatedAt` field would make two runs differ by construction, and freezing the clock to hide
    // that would be a test about the clock. The instant lives on holiday_confirmation.recorded_at.
    expect(holidayImpactBytes(report())).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('sorts keys recursively, so the bytes do not depend on insertion order', () => {
    const forwards = holidayImpactBytes({ alpha: 1, beta: { x: 1, a: 2 } })
    const backwards = holidayImpactBytes({ beta: { a: 2, x: 1 }, alpha: 1 })
    expect(forwards).toBe(backwards)
    expect(forwards).toBe('{"alpha":1,"beta":{"a":2,"x":1}}')
  })
})
