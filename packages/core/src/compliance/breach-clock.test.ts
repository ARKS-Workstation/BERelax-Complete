import { describe, expect, it } from 'vitest'
import {
  BUSINESS_CIVIL_ZONE,
  breachNotificationDeadline,
  notificationWasTimely,
} from './breach-clock.ts'

/**
 * The clock, and the three ways a plausible wrong answer could get out of it.
 *
 * Every case here pairs the claim with a control that must give a DIFFERENT answer, because every one
 * of these is a function over dates and the failure mode of a date test is that it passes for an
 * implementation that ignores one of its inputs.
 */
describe('breachNotificationDeadline', () => {
  const DISCOVERED = '2026-10-01T09:00:00.000Z'

  it('adds the period to the discovery, to the hour', () => {
    const clock = breachNotificationDeadline({ discoveredAtIso: DISCOVERED, periodHours: 72 })
    expect(clock.deadlineAtIso).toBe('2026-10-04T09:00:00.000Z')
    expect(clock.periodHours).toBe(72)
    // The control: a different period gives a different instant, so the figure is used rather than
    // ignored in favour of a constant.
    expect(
      breachNotificationDeadline({ discoveredAtIso: DISCOVERED, periodHours: 24 }).deadlineAtIso,
    ).toBe('2026-10-02T09:00:00.000Z')
  })

  it('dates the deadline in the business civil zone and NOT in UTC', () => {
    // 21:00 UTC on the 2nd is 01:00 on the 3rd in Asia/Dubai. 72 hours on is 21:00 UTC on the 5th,
    // which is 01:00 on the 6th locally — so the civil date and the UTC date differ, which is the
    // whole point of computing one.
    const clock = breachNotificationDeadline({
      discoveredAtIso: '2026-10-02T21:00:00.000Z',
      periodHours: 72,
    })
    expect(clock.deadlineAtIso.slice(0, 10)).toBe('2026-10-05')
    expect(clock.dueOn).toBe('2026-10-06')
    expect(clock.discoveredOn).toBe('2026-10-03')
    expect(clock.zoneName).toBe(BUSINESS_CIVIL_ZONE.name)
  })

  it('does not move with the trading day, which is the one thing it must not do', () => {
    /*
      Trading runs 11:00–02:00, so `resolveTradingDate` puts 01:30 local on the PREVIOUS trading date.
      A statutory deadline does not work that way — `rights-policy.ts` already says so in those words —
      and using the trading date here would hand the business an extra day roughly one night in three.

      01:30 on the 3rd in Asia/Dubai is 21:30 UTC on the 2nd. The trading date would be the 2nd; the
      civil date is the 3rd. This asserts the civil one.
    */
    const clock = breachNotificationDeadline({
      discoveredAtIso: '2026-10-02T21:30:00.000Z',
      periodHours: 72,
    })
    expect(clock.discoveredOn).toBe('2026-10-03')
    expect(clock.discoveredOn).not.toBe('2026-10-02')
  })

  it('refuses an unparseable discovery rather than producing a plausible date from NaN', () => {
    expect(() =>
      breachNotificationDeadline({ discoveredAtIso: 'last Friday', periodHours: 72 }),
    ).toThrow(/is not an instant/)
  })

  it.each([0, -1, 1.5, Number.NaN])('refuses the period %s rather than defaulting', (hours) => {
    // A default here would be an invented statutory period in the one place nobody looks, and a zero
    // or negative one would put a duty in the calendar that was already overdue when it was created.
    expect(() =>
      breachNotificationDeadline({ discoveredAtIso: DISCOVERED, periodHours: hours }),
    ).toThrow(/whole number of hours/)
  })

  it('carries the open question the period is provisional against', () => {
    // Not decoration: the figure is the build's reading of a secondary source, so a stored deadline
    // that did not say which unanswered question produced it would read like a figure somebody checked.
    expect(
      breachNotificationDeadline({ discoveredAtIso: DISCOVERED, periodHours: 72 }).openQuestionId,
    ).toBe('Y1-breach-clock')
  })
})

describe('notificationWasTimely', () => {
  const DEADLINE = '2026-10-04T09:00:00.000Z'

  it('compares INSTANTS, so the same civil day can be timely or late', () => {
    // The pair that matters. Both are on the 4th; a comparison done on dates calls both timely, and
    // one of them is eleven hours past the deadline.
    expect(
      notificationWasTimely({ deadlineAtIso: DEADLINE, notifiedAtIso: '2026-10-04T08:00:00.000Z' }),
    ).toBe('timely')
    expect(
      notificationWasTimely({ deadlineAtIso: DEADLINE, notifiedAtIso: '2026-10-04T20:00:00.000Z' }),
    ).toBe('late')
  })

  it('treats the deadline instant itself as timely', () => {
    expect(notificationWasTimely({ deadlineAtIso: DEADLINE, notifiedAtIso: DEADLINE })).toBe(
      'timely',
    )
  })

  it('answers unknown for a notification that has not happened, never late', () => {
    // "We cannot tell" and "it was late" are different findings, and the second is an accusation. A
    // duty with no notification row yet is simply open.
    expect(notificationWasTimely({ deadlineAtIso: DEADLINE, notifiedAtIso: null })).toBe('unknown')
    expect(notificationWasTimely({ deadlineAtIso: 'not a date', notifiedAtIso: DEADLINE })).toBe(
      'unknown',
    )
  })
})
