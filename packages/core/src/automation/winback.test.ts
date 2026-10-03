import { describe, expect, it } from 'vitest'
import type { HoursForDate } from '../business-day/resolve.ts'
import { instantFromIso, localDate, localTime } from '../time.ts'
import {
  addCalendarDays,
  PROVISIONAL_WINBACK_DAYS,
  visitBusinessDay,
  WINBACK_WORKED_EXAMPLE,
  winbackDue,
} from './winback.ts'

/**
 * C-AUTO-11's win-back arithmetic, and the worked example the acceptance line asks to be committed.
 *
 * The example is read from {@link WINBACK_WORKED_EXAMPLE} rather than written here, so the test asserts
 * the COMMITTED figure rather than one it chose — and the calendar-dated answer is committed beside it,
 * so the one-day difference the whole module exists for is visible in the source.
 */

/** Trading 11:00-02:00, every day. The fixture salon's hours, and the only ones that cross midnight. */
const ALWAYS_OPEN: HoursForDate = () => ({ open: localTime('11:00'), close: localTime('02:00') })

/** Closed on 18 September 2026, open every other day. For the unmeasurable case. */
const CLOSED_ON_THE_18TH: HoursForDate = (date) =>
  date === localDate('2026-09-18')
    ? undefined
    : { open: localTime('11:00'), close: localTime('02:00') }

describe('the committed worked example', () => {
  it('measures from the PREVIOUS business day for a visit that ended at 01:30', () => {
    const decision = winbackDue({
      lastVisitEndedAt: instantFromIso(WINBACK_WORKED_EXAMPLE.lastVisitEndedAtIso),
      hoursFor: ALWAYS_OPEN,
      today: WINBACK_WORKED_EXAMPLE.dueOn,
      intervalDays: WINBACK_WORKED_EXAMPLE.intervalDays,
    })
    expect(decision.kind).toBe('due')
    if (decision.kind !== 'due' && decision.kind !== 'not_yet') return
    // 01:30 on the 19th is inside the session that opened at 11:00 on the 18th.
    expect(decision.lastVisitBusinessDay).toBe(WINBACK_WORKED_EXAMPLE.businessDay)
    expect(decision.dueOn).toBe(WINBACK_WORKED_EXAMPLE.dueOn)
  })

  it('is one day EARLIER than the calendar-dated answer, which is the whole point', () => {
    // The control, and the reason the module exists: dated on the calendar date this customer would be
    // won back a day late, every time, and nothing on any screen would say so.
    expect(WINBACK_WORKED_EXAMPLE.calendarDatedWouldBe).not.toBe(WINBACK_WORKED_EXAMPLE.dueOn)
    expect(addCalendarDays(localDate('2026-09-19'), PROVISIONAL_WINBACK_DAYS)).toBe(
      WINBACK_WORKED_EXAMPLE.calendarDatedWouldBe,
    )
    expect(addCalendarDays(WINBACK_WORKED_EXAMPLE.businessDay, PROVISIONAL_WINBACK_DAYS)).toBe(
      WINBACK_WORKED_EXAMPLE.dueOn,
    )
  })

  it('is not yet due the day before', () => {
    const decision = winbackDue({
      lastVisitEndedAt: instantFromIso(WINBACK_WORKED_EXAMPLE.lastVisitEndedAtIso),
      hoursFor: ALWAYS_OPEN,
      today: localDate('2026-12-16'),
      intervalDays: WINBACK_WORKED_EXAMPLE.intervalDays,
    })
    expect(decision.kind).toBe('not_yet')
  })
})

describe('winbackDue', () => {
  it('distinguishes a contact who never visited from one who visited long ago', () => {
    expect(
      winbackDue({
        lastVisitEndedAt: null,
        hoursFor: ALWAYS_OPEN,
        today: localDate('2026-12-17'),
        intervalDays: 90,
      }),
    ).toEqual({ kind: 'never_visited' })
  })

  it('refuses rather than falling back to the calendar date for an unmeasurable visit', () => {
    // 15:00 on a day the premises was closed. There is no business day to measure from, and a
    // substituted origin would produce a due date that reconciles against a day nothing happened on.
    const decision = winbackDue({
      lastVisitEndedAt: instantFromIso('2026-09-18T11:00:00.000Z'),
      hoursFor: CLOSED_ON_THE_18TH,
      today: localDate('2026-12-17'),
      intervalDays: 90,
    })
    expect(decision.kind).toBe('not_measurable')
    if (decision.kind !== 'not_measurable') return
    expect(decision.reason).toBe('premises_closed')
    expect(decision.calendarDate).toBe(localDate('2026-09-18'))
  })

  it('dates an afternoon visit on its own calendar day, so the rule is not simply "yesterday"', () => {
    // The control for the 01:30 case: 15:00 Asia/Dubai on the 18th is the 18th, not the 17th.
    const decision = winbackDue({
      lastVisitEndedAt: instantFromIso('2026-09-18T11:00:00.000Z'),
      hoursFor: ALWAYS_OPEN,
      today: localDate('2026-12-17'),
      intervalDays: 90,
    })
    if (decision.kind !== 'due' && decision.kind !== 'not_yet') throw new Error('measurable')
    expect(decision.lastVisitBusinessDay).toBe(localDate('2026-09-18'))
  })
})

describe('visitBusinessDay', () => {
  it('is the one reading of which trading day an instant belongs to', () => {
    expect(visitBusinessDay(instantFromIso('2026-09-18T21:30:00.000Z'), ALWAYS_OPEN)).toEqual({
      kind: 'trading',
      date: localDate('2026-09-18'),
    })
  })
})

describe('addCalendarDays', () => {
  it('refuses a fractional interval rather than rounding it', () => {
    expect(() => addCalendarDays(localDate('2026-09-18'), 1.5)).toThrow(/whole non-negative/)
    expect(() => addCalendarDays(localDate('2026-09-18'), -1)).toThrow(/whole non-negative/)
  })

  it('crosses a month and a year boundary', () => {
    expect(addCalendarDays(localDate('2026-12-30'), 3)).toBe(localDate('2027-01-02'))
  })
})
