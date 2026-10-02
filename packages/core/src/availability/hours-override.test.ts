import { describe, expect, it } from 'vitest'
import { hoursFromSchedule } from '../business-day/resolve.ts'
import type { ClosedInterval } from '../business-day/windows.ts'
import {
  ASIA_DUBAI,
  fromLocal,
  type Instant,
  type LocalDate,
  localDate,
  localTime,
  type TradingHours,
  toLocal,
} from '../time.ts'
import {
  type BookedAppointmentPeriod,
  type DatedHoursOverride,
  hoursOverrideCoversDate,
  hoursOverrideDates,
  hoursOverrideStrandedAppointments,
  hoursWithOverrides,
  lastBookableStart,
} from './hours-override.ts'

/**
 * P-HR-10's third and fourth acceptance lines, pure.
 *
 * Every figure here is computed by hand from the hours, and every assertion is paired with the control
 * that would be satisfied by the rule being absent (brief rule 3). The two that matter most:
 *
 *   * **23:40 and 01:40 are the same arithmetic over two different hours**, which is what makes "the
 *     last-bookable-start recomputes from the override" a claim about the override rather than about
 *     either figure. B-AVAIL-02 pinned 23:40 for 120+20 on an 11:00–02:00 day; a 14:00–04:00 Ramadan
 *     schedule moves it to 01:40, and the control asserts the weekly hours still answer 23:40 for the
 *     same request.
 *   * **The stranding test is the ROOM period**, so a treatment ending at 01:55 with a 20-minute
 *     turnaround is stranded by hours that close at 02:00 although the treatment itself fits. The control
 *     is the same appointment with a zero turnaround, which is not stranded.
 *
 * The dates are fixed and far from "now": `weekdayIn` reads a real calendar, so a weekday-restricted
 * override needs a date whose weekday is a fact rather than a function of the day the suite runs on.
 */

/** 2026-03-01 is a Sunday; the span to 2026-03-07 is one whole week, Sunday to Saturday. */
const SUNDAY = localDate('2026-03-01')
const MONDAY = localDate('2026-03-02')
const TUESDAY = localDate('2026-03-03')
const SATURDAY = localDate('2026-03-07')

const hours = (open: string, close: string): TradingHours => ({
  open: localTime(open),
  close: localTime(close),
})

/** 11:00–02:00 every day, which is what `premises_hours` holds for the fixture salon. */
const WEEKLY: readonly (TradingHours | undefined)[] = Array.from({ length: 7 }, () =>
  hours('11:00', '02:00'),
)

/** 14:00–04:00: a reduced opening with a later close, so the last start MOVES rather than vanishes. */
const RAMADAN = hours('14:00', '04:00')

const ramadanOverride: DatedHoursOverride = {
  startsOn: SUNDAY,
  endsOn: TUESDAY,
  dayOfWeek: null,
  hours: RAMADAN,
  reason: 'Reduced hours over the test window',
}

const at = (date: LocalDate, time: string): Instant => fromLocal(date, localTime(time), ASIA_DUBAI)

/** `HH:MM` in Asia/Dubai, so an assertion reads as a wall clock rather than as an epoch. */
const wall = (instant: Instant | undefined): string =>
  instant === undefined ? 'none' : toLocal(instant, ASIA_DUBAI).time.slice(0, 5)

const dayOf = (instant: Instant | undefined): string =>
  instant === undefined ? 'none' : toLocal(instant, ASIA_DUBAI).date

describe('hoursWithOverrides — a dated override replaces the weekly pattern', () => {
  const hoursFor = hoursWithOverrides({ weekly: WEEKLY, overrides: [ramadanOverride] })

  it('answers the override inside its range and the weekly pattern outside it', () => {
    expect(hoursFor(SUNDAY)).toEqual(RAMADAN)
    expect(hoursFor(TUESDAY)).toEqual(RAMADAN)
    // The control: one day past the end of the range is the weekly pattern again. Without it, a lookup
    // that returned the override for every date would pass the two assertions above.
    expect(hoursFor(localDate('2026-03-04'))).toEqual(hours('11:00', '02:00'))
    expect(hoursFor(localDate('2026-02-28'))).toEqual(hours('11:00', '02:00'))
  })

  it('applies a weekday-restricted override only on that weekday', () => {
    // 2026-03-01 is a Sunday, so `dayOfWeek: 1` (Monday, `premises_hours`' numbering) covers only the 2nd.
    const mondaysOnly: DatedHoursOverride = { ...ramadanOverride, dayOfWeek: 1 }
    const restricted = hoursWithOverrides({ weekly: WEEKLY, overrides: [mondaysOnly] })
    expect(restricted(MONDAY)).toEqual(RAMADAN)
    expect(restricted(SUNDAY)).toEqual(hours('11:00', '02:00'))
    expect(restricted(TUESDAY)).toEqual(hours('11:00', '02:00'))
    expect(hoursOverrideCoversDate(mondaysOnly, MONDAY)).toBe(true)
    expect(hoursOverrideCoversDate(mondaysOnly, SUNDAY)).toBe(false)
    expect(hoursOverrideDates(mondaysOnly)).toEqual([MONDAY])
  })

  it('lets the last applicable override win, so a narrower row entered later governs', () => {
    const narrower: DatedHoursOverride = {
      startsOn: MONDAY,
      endsOn: MONDAY,
      dayOfWeek: null,
      hours: hours('16:00', '23:00'),
      reason: 'A later, narrower row over one date',
    }
    const layered = hoursWithOverrides({ weekly: WEEKLY, overrides: [ramadanOverride, narrower] })
    expect(layered(MONDAY)).toEqual(hours('16:00', '23:00'))
    // The control for "last wins": reversing the list gives the other answer, which is why the rule is
    // stated rather than left to whatever order a reader happened to supply.
    const reversed = hoursWithOverrides({ weekly: WEEKLY, overrides: [narrower, ramadanOverride] })
    expect(reversed(MONDAY)).toEqual(RAMADAN)
  })

  it('lets a closed date beat an override, because a shut premises keeps no hours', () => {
    const closed = hoursWithOverrides({
      weekly: WEEKLY,
      overrides: [ramadanOverride],
      closedDates: [MONDAY],
    })
    expect(closed(MONDAY)).toBeUndefined()
    expect(closed(TUESDAY)).toEqual(RAMADAN)
  })

  it('refuses an override whose range ends before it starts', () => {
    expect(() =>
      hoursWithOverrides({
        weekly: WEEKLY,
        overrides: [{ ...ramadanOverride, startsOn: TUESDAY, endsOn: SUNDAY }],
      }),
    ).toThrow(/ends before it starts/)
  })
})

describe('acceptance — the last bookable start recomputes from the override', () => {
  const weeklyOnly = hoursFromSchedule({ weekly: WEEKLY })
  const withOverride = hoursWithOverrides({ weekly: WEEKLY, overrides: [ramadanOverride] })
  const request = {
    closures: [] as readonly ClosedInterval[],
    durationMinutes: 120,
    turnaroundMinutes: 20,
  }

  it('is 23:40 on the weekly hours — B-AVAIL-02s figure, as the baseline', () => {
    const latest = lastBookableStart({ date: SUNDAY, hoursFor: weeklyOnly, ...request })
    expect(wall(latest)).toBe('23:40')
    expect(dayOf(latest)).toBe('2026-03-01')
  })

  it('is 01:40 at the FIRST date of the override window', () => {
    const latest = lastBookableStart({ date: SUNDAY, hoursFor: withOverride, ...request })
    // 04:00 close − 120 − 20 = 01:40, on the NEXT calendar date, because a 14:00–04:00 session crosses
    // midnight exactly as 11:00–02:00 does. The trading date is still the 1st.
    expect(wall(latest)).toBe('01:40')
    expect(dayOf(latest)).toBe('2026-03-02')
  })

  it('is 01:40 at the LAST date of the override window too', () => {
    const latest = lastBookableStart({ date: TUESDAY, hoursFor: withOverride, ...request })
    expect(wall(latest)).toBe('01:40')
    expect(dayOf(latest)).toBe('2026-03-04')
  })

  it('is back to 23:40 on the first date AFTER the window — the control', () => {
    // Without this the two figures above are satisfied by a lookup that ignores the range entirely.
    const latest = lastBookableStart({
      date: localDate('2026-03-04'),
      hoursFor: withOverride,
      ...request,
    })
    expect(wall(latest)).toBe('23:40')
  })

  it('moves with the turnaround, so the figure is about the room and not about the grid', () => {
    expect(
      wall(
        lastBookableStart({
          date: SUNDAY,
          hoursFor: withOverride,
          closures: [],
          durationMinutes: 120,
          turnaroundMinutes: 30,
        }),
      ),
    ).toBe('01:30')
  })

  it('answers undefined when no window on the date is long enough', () => {
    const tiny = hoursWithOverrides({
      weekly: WEEKLY,
      overrides: [{ ...ramadanOverride, hours: hours('14:00', '15:00') }],
    })
    expect(lastBookableStart({ date: SUNDAY, hoursFor: tiny, ...request })).toBeUndefined()
    // And the control: a treatment that DOES fit the same one-hour window has a start.
    expect(
      wall(
        lastBookableStart({
          date: SUNDAY,
          hoursFor: tiny,
          closures: [],
          durationMinutes: 45,
          turnaroundMinutes: 0,
        }),
      ),
    ).toBe('14:15')
  })

  it('takes the LAST window of a split date, not the first', () => {
    // A closure from 20:00 to 22:00 splits the override's session in two. The last bookable start of the
    // DATE is in the later window; answering from the first one would silently stop offering the evening.
    const closures: readonly ClosedInterval[] = [
      { startsAt: at(SUNDAY, '20:00'), endsAt: at(SUNDAY, '22:00'), reason: 'Staff meeting' },
    ]
    const latest = lastBookableStart({
      date: SUNDAY,
      hoursFor: withOverride,
      closures,
      durationMinutes: 120,
      turnaroundMinutes: 20,
    })
    expect(wall(latest)).toBe('01:40')
    // The control: the earlier window's own latest start is 17:40, which is what a first-window
    // implementation would answer.
    expect(
      wall(
        lastBookableStart({
          date: SUNDAY,
          hoursFor: hoursWithOverrides({
            weekly: WEEKLY,
            overrides: [{ ...ramadanOverride, hours: hours('14:00', '20:00') }],
          }),
          closures,
          durationMinutes: 120,
          turnaroundMinutes: 20,
        }),
      ),
    ).toBe('17:40')
  })

  it('refuses a duration or a turnaround that is not whole minutes', () => {
    const base = { date: SUNDAY, hoursFor: withOverride, closures: [] }
    expect(() => lastBookableStart({ ...base, durationMinutes: 0, turnaroundMinutes: 0 })).toThrow(
      /whole number of minutes above zero/,
    )
    expect(() =>
      lastBookableStart({ ...base, durationMinutes: 60, turnaroundMinutes: -1 }),
    ).toThrow(/whole number of minutes/)
  })
})

describe('acceptance — an override that would strand a booked appointment is refused', () => {
  /** A 90-minute treatment on the 1st, 12:00–13:30, holding its room 20 minutes after. */
  const noon: BookedAppointmentPeriod = {
    appointmentId: 'aaaaaaaa-0000-0000-0000-000000000001',
    tradingDate: SUNDAY,
    startsAt: at(SUNDAY, '12:00'),
    endsAt: at(SUNDAY, '13:30'),
    turnaroundMinutes: 20,
  }
  /** A late treatment ending at 01:55 on the following calendar date; still the 1st's trading date. */
  const late: BookedAppointmentPeriod = {
    appointmentId: 'aaaaaaaa-0000-0000-0000-000000000002',
    tradingDate: SUNDAY,
    startsAt: at(localDate('2026-03-02'), '00:25'),
    endsAt: at(localDate('2026-03-02'), '01:55'),
    turnaroundMinutes: 20,
  }

  it('names the appointment a later opening leaves before the door opens', () => {
    const stranded = hoursOverrideStrandedAppointments({
      override: ramadanOverride,
      appointments: [noon, late],
    })
    expect(stranded).toEqual([
      { appointmentId: noon.appointmentId, tradingDate: SUNDAY, reason: 'before_opening' },
    ])
    // `late` survives: 01:55 + 20 = 02:15, and the override closes at 04:00.
  })

  it('names the appointment an earlier close leaves outside, turnaround included', () => {
    const earlyClose: DatedHoursOverride = {
      ...ramadanOverride,
      hours: hours('11:00', '02:00'),
    }
    const stranded = hoursOverrideStrandedAppointments({
      override: earlyClose,
      appointments: [noon, late],
    })
    expect(stranded).toEqual([
      { appointmentId: late.appointmentId, tradingDate: SUNDAY, reason: 'after_closing' },
    ])
  })

  it('does not strand it when the turnaround is zero — the control for "the room and not the treatment"', () => {
    // The same appointment and the same hours. 01:55 is inside 11:00–02:00; 01:55 + 20 is not. Without
    // this control the assertion above would pass for an implementation that compared the treatment.
    const stranded = hoursOverrideStrandedAppointments({
      override: { ...ramadanOverride, hours: hours('11:00', '02:00') },
      appointments: [{ ...late, turnaroundMinutes: 0 }],
    })
    expect(stranded).toEqual([])
  })

  it('accepts a room period ending exactly at close, because close is inclusive for an ending', () => {
    const exact: BookedAppointmentPeriod = {
      ...late,
      endsAt: at(localDate('2026-03-02'), '01:40'),
      turnaroundMinutes: 20,
    }
    expect(
      hoursOverrideStrandedAppointments({
        override: { ...ramadanOverride, hours: hours('11:00', '02:00') },
        appointments: [exact],
      }),
    ).toEqual([])
    // And one minute later is stranded, which is what makes the boundary a boundary.
    expect(
      hoursOverrideStrandedAppointments({
        override: { ...ramadanOverride, hours: hours('11:00', '02:00') },
        appointments: [{ ...exact, endsAt: at(localDate('2026-03-02'), '01:41') }],
      }),
    ).toHaveLength(1)
  })

  it('ignores an appointment on a date the override does not cover', () => {
    const outside: BookedAppointmentPeriod = {
      ...noon,
      tradingDate: SATURDAY,
      startsAt: at(SATURDAY, '12:00'),
      endsAt: at(SATURDAY, '13:30'),
    }
    expect(
      hoursOverrideStrandedAppointments({ override: ramadanOverride, appointments: [outside] }),
    ).toEqual([])
  })

  it('ignores an appointment inside the range but on a weekday the override does not apply to', () => {
    // The failure this prevents: refusing a Mondays-only Ramadan override because of a Sunday booking.
    const mondaysOnly: DatedHoursOverride = { ...ramadanOverride, dayOfWeek: 1 }
    expect(
      hoursOverrideStrandedAppointments({ override: mondaysOnly, appointments: [noon] }),
    ).toEqual([])
    expect(
      hoursOverrideStrandedAppointments({
        override: mondaysOnly,
        appointments: [
          {
            ...noon,
            tradingDate: MONDAY,
            startsAt: at(MONDAY, '12:00'),
            endsAt: at(MONDAY, '13:30'),
          },
        ],
      }),
    ).toHaveLength(1)
  })

  it('orders the report by trading date then id, so two runs produce one list', () => {
    const second: BookedAppointmentPeriod = {
      ...noon,
      appointmentId: 'aaaaaaaa-0000-0000-0000-000000000000',
      tradingDate: TUESDAY,
      startsAt: at(TUESDAY, '12:00'),
      endsAt: at(TUESDAY, '13:30'),
    }
    const third: BookedAppointmentPeriod = {
      ...noon,
      appointmentId: 'aaaaaaaa-0000-0000-0000-00000000000f',
      startsAt: at(SUNDAY, '11:30'),
      endsAt: at(SUNDAY, '12:30'),
    }
    const stranded = hoursOverrideStrandedAppointments({
      override: ramadanOverride,
      appointments: [second, third, noon],
    })
    expect(stranded.map((row) => `${row.tradingDate} ${row.appointmentId.slice(-3)}`)).toEqual([
      '2026-03-01 001',
      '2026-03-01 00f',
      '2026-03-03 000',
    ])
  })
})
