import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { instantFromIso, localDate } from '../time.ts'
import {
  hoursFromDayRows,
  rescheduleTradingDate,
  SUCCESSOR_STATUSES,
  successorStatusFor,
  type TradingDayHoursRow,
} from './reschedule-policy.ts'
import { LEGAL_APPOINTMENT_TRANSITIONS } from './transitions.ts'

/**
 * The trading-date re-resolution, and the status a successor is born in.
 *
 * The midnight cases are the acceptance criterion written out: 23:50 -> 00:30 keeps the trading date and
 * 23:50 -> 11:30 the next morning moves it. Both are asserted against the SAME hours, so the difference in
 * the answer comes from the instants rather than from the calendar.
 */

/** Three consecutive trading dates, all 11:00-02:00, which is what the salon actually trades. */
const DAYS: readonly TradingDayHoursRow[] = [
  { tradingDate: '2099-11-05', open: '11:00', close: '02:00' },
  { tradingDate: '2099-11-06', open: '11:00', close: '02:00' },
  { tradingDate: '2099-11-07', open: '11:00', close: '02:00' },
]

/** A Dubai wall-clock instant as epoch milliseconds, which is how it crosses the package boundary. */
const dubai = (iso: string): number => instantFromIso(`${iso}+04:00`)

describe('a reschedule across midnight re-resolves the trading date', () => {
  it('keeps the trading date when 23:50 moves to 00:30, because both are inside one session', () => {
    // 00:30 on the 7th is inside the 6th's 11:00-02:00. Arithmetic on the calendar date answers
    // '2099-11-07' here, which is the bug this criterion exists to catch.
    expect(rescheduleTradingDate({ startsAtMs: dubai('2099-11-06T23:50:00'), days: DAYS })).toEqual(
      {
        kind: 'trading',
        tradingDate: '2099-11-06',
      },
    )
    expect(rescheduleTradingDate({ startsAtMs: dubai('2099-11-07T00:30:00'), days: DAYS })).toEqual(
      {
        kind: 'trading',
        tradingDate: '2099-11-06',
      },
    )
  })

  it('moves to the next trading date when 23:50 moves to 11:30 the following morning', () => {
    expect(rescheduleTradingDate({ startsAtMs: dubai('2099-11-07T11:30:00'), days: DAYS })).toEqual(
      {
        kind: 'trading',
        tradingDate: '2099-11-07',
      },
    )
  })

  it('refuses the daytime gap by name rather than answering the nearest date', () => {
    // 09:00 is after the previous night's close and before the day's opening. A resolver that answered
    // '2099-11-06' anyway would be indistinguishable from a right answer, and it would land in a report.
    const gap = rescheduleTradingDate({ startsAtMs: dubai('2099-11-06T09:00:00'), days: DAYS })
    expect(gap).toEqual({
      kind: 'outside_trading',
      reason: 'before_opening',
      calendarDate: '2099-11-06',
    })
  })

  it('refuses a date the premises does not trade, which is a row that is ABSENT', () => {
    const closed = rescheduleTradingDate({
      startsAtMs: dubai('2099-11-09T19:00:00'),
      days: DAYS,
    })
    expect(closed.kind).toBe('outside_trading')
    expect(closed.kind === 'outside_trading' && closed.reason).toBe('premises_closed')
  })

  it('refuses an instant that is not whole epoch milliseconds', () => {
    expect(() => rescheduleTradingDate({ startsAtMs: Number.NaN, days: DAYS })).toThrow(AppError)
  })

  it('reads hours by calendar date and answers undefined for a date with no row', () => {
    const hoursFor = hoursFromDayRows(DAYS)
    expect(hoursFor(localDate('2099-11-06'))).toEqual({ open: '11:00', close: '02:00' })
    expect(hoursFor(localDate('2099-11-09'))).toBeUndefined()
  })

  it('takes a SUPERSET of rows without being confused by the extras', () => {
    // The caller brackets by calendar date rather than picking the right row, so the resolver is handed
    // dates it does not need. The answer must be the same as with the exact pair.
    const widened = [
      ...DAYS,
      { tradingDate: '2099-11-01', open: '11:00', close: '02:00' },
      { tradingDate: '2099-12-25', open: '11:00', close: '02:00' },
    ]
    expect(
      rescheduleTradingDate({ startsAtMs: dubai('2099-11-07T00:30:00'), days: widened }),
    ).toEqual({ kind: 'trading', tradingDate: '2099-11-06' })
  })
})

describe('the successor is born in a status, and the set agrees with the transition table', () => {
  it('keeps a request a request and a promise a promise', () => {
    expect(successorStatusFor('requested')).toBe('requested')
    expect(successorStatusFor('confirmed')).toBe('confirmed')
  })

  it('does not carry a check-in to a slot that has not happened yet', () => {
    // A successor born `checked_in` would claim the client had arrived for a treatment three hours in the
    // future, and would make `checked_in -> no_show` reachable against a client who is present.
    expect(successorStatusFor('checked_in')).toBe('confirmed')
  })

  it('throws for every status the table does not permit a reschedule from', () => {
    // Enumerated from the table rather than listed here, so a pair added to
    // LEGAL_APPOINTMENT_TRANSITIONS without a case in this function fails rather than being absorbed.
    const canReschedule = Object.entries(LEGAL_APPOINTMENT_TRANSITIONS)
      .filter(([, targets]) => targets.some((target) => target.to === 'rescheduled'))
      .map(([from]) => from)
    expect(canReschedule.sort()).toEqual(['checked_in', 'confirmed', 'requested'])
    for (const [from] of Object.entries(LEGAL_APPOINTMENT_TRANSITIONS)) {
      if (canReschedule.includes(from)) {
        expect(SUCCESSOR_STATUSES).toContain(successorStatusFor(from))
      } else {
        expect(() => successorStatusFor(from), from).toThrow(/cannot be made from/)
      }
    }
  })

  it('throws for a label this build has never heard of', () => {
    expect(() => successorStatusFor('paused')).toThrow(AppError)
  })
})
