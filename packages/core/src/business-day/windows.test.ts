import { describe, expect, it } from 'vitest'
import { instantFromIso, localDate, localTime, type TradingHours } from '../time.ts'
import { tradingBounds } from './resolve.ts'
import {
  type ClosedInterval,
  isWithinWindows,
  latestStartIn,
  totalTradingMinutes,
  tradingWindowsFor,
  windowMinutes,
} from './windows.ts'

const HOURS: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const DATE = localDate('2026-10-02')

const closure = (fromIso: string, untilIso: string, reason = 'maintenance'): ClosedInterval => ({
  startsAt: instantFromIso(fromIso),
  endsAt: instantFromIso(untilIso),
  reason,
})

describe('acceptance — closures subtract from the trading window', () => {
  it('returns one window when nothing is closed', () => {
    const windows = tradingWindowsFor({ date: DATE, hours: HOURS, closures: [] })
    expect(windows).toHaveLength(1)
    expect(windowMinutes(windows[0] as never)).toBe(900)
  })

  it('returns zero windows for a full-day closure', () => {
    const { opensAt, closesAt } = tradingBounds(DATE, HOURS)
    const windows = tradingWindowsFor({
      date: DATE,
      hours: HOURS,
      closures: [{ startsAt: opensAt, endsAt: closesAt, reason: 'public holiday' }],
    })
    expect(windows).toEqual([])
  })

  it('returns zero windows when the premises does not open at all', () => {
    expect(tradingWindowsFor({ date: DATE, hours: undefined, closures: [] })).toEqual([])
  })

  it('returns exactly two windows for a closure in the middle of the session', () => {
    const windows = tradingWindowsFor({
      date: DATE,
      hours: HOURS,
      closures: [closure('2026-10-02T14:00:00+04:00', '2026-10-02T16:00:00+04:00')],
    })
    expect(windows).toHaveLength(2)
    expect(windowMinutes(windows[0] as never)).toBe(180)
    expect(windowMinutes(windows[1] as never)).toBe(600)
    expect(totalTradingMinutes(windows)).toBe(780)
  })

  it('returns the surviving tail when a closure overlaps the opening', () => {
    const windows = tradingWindowsFor({
      date: DATE,
      hours: HOURS,
      closures: [closure('2026-10-02T09:00:00+04:00', '2026-10-02T13:00:00+04:00')],
    })
    expect(windows).toHaveLength(1)
    expect(windowMinutes(windows[0] as never)).toBe(780)
  })

  it('returns the surviving head when a closure runs past the close, including past midnight', () => {
    const windows = tradingWindowsFor({
      date: DATE,
      hours: HOURS,
      closures: [closure('2026-10-03T00:00:00+04:00', '2026-10-03T04:00:00+04:00')],
    })
    expect(windows).toHaveLength(1)
    expect(windowMinutes(windows[0] as never)).toBe(780)
  })

  it('ignores a closure that does not touch the session', () => {
    const windows = tradingWindowsFor({
      date: DATE,
      hours: HOURS,
      closures: [closure('2026-10-02T06:00:00+04:00', '2026-10-02T09:00:00+04:00')],
    })
    expect(windows).toHaveLength(1)
  })

  it('applies overlapping closures to the same result whatever order they arrive in', () => {
    // Without sorting first, an overlapping pair splits a window into fragments that the next closure
    // splits again, and the answer depends on input order — which is the kind of bug that only shows
    // up when two people add a closure on the same afternoon.
    const a = closure('2026-10-02T14:00:00+04:00', '2026-10-02T17:00:00+04:00')
    const b = closure('2026-10-02T16:00:00+04:00', '2026-10-02T19:00:00+04:00')
    const forwards = tradingWindowsFor({ date: DATE, hours: HOURS, closures: [a, b] })
    const backwards = tradingWindowsFor({ date: DATE, hours: HOURS, closures: [b, a] })
    expect(backwards).toEqual(forwards)
    expect(forwards).toHaveLength(2)
  })

  it('returns windows in order and never touching', () => {
    const windows = tradingWindowsFor({
      date: DATE,
      hours: HOURS,
      closures: [
        closure('2026-10-02T20:00:00+04:00', '2026-10-02T21:00:00+04:00'),
        closure('2026-10-02T14:00:00+04:00', '2026-10-02T15:00:00+04:00'),
      ],
    })
    expect(windows).toHaveLength(3)
    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index]?.startsAt ?? 0).toBeGreaterThan(windows[index - 1]?.endsAt ?? 0)
    }
  })

  it('drops a fragment too short to book, rather than making every caller filter it', () => {
    // Eleven minutes between two closures is not bookable time: the shortest treatment is 45.
    const windows = tradingWindowsFor({
      date: DATE,
      hours: HOURS,
      minimumMinutes: 45,
      closures: [
        closure('2026-10-02T11:10:00+04:00', '2026-10-02T14:00:00+04:00'),
        closure('2026-10-02T14:11:00+04:00', '2026-10-03T02:00:00+04:00'),
      ],
    })
    expect(windows).toEqual([])
  })
})

describe('isWithinWindows', () => {
  const windows = tradingWindowsFor({
    date: DATE,
    hours: HOURS,
    closures: [closure('2026-10-02T14:00:00+04:00', '2026-10-02T16:00:00+04:00')],
  })

  it('accepts an instant inside a surviving window', () => {
    expect(isWithinWindows(instantFromIso('2026-10-02T12:00:00+04:00'), windows)).toBe(true)
    expect(isWithinWindows(instantFromIso('2026-10-03T01:00:00+04:00'), windows)).toBe(true)
  })

  it('rejects an instant inside the closure', () => {
    expect(isWithinWindows(instantFromIso('2026-10-02T15:00:00+04:00'), windows)).toBe(false)
  })

  it('is half-open: the end instant is outside', () => {
    expect(isWithinWindows(instantFromIso('2026-10-03T02:00:00+04:00'), windows)).toBe(false)
  })
})

describe('latestStartIn', () => {
  const [window] = tradingWindowsFor({ date: DATE, hours: HOURS, closures: [] })

  it('leaves room for the treatment and its turnaround', () => {
    // 02:00 close, 120-minute treatment, 20-minute turnaround: the last start is 23:40, not midnight.
    const latest = latestStartIn(window as never, 120, 20)
    expect(new Date(latest ?? 0).toISOString()).toBe('2026-10-02T19:40:00.000Z')
  })

  it('returns nothing when the treatment cannot fit', () => {
    const short = tradingWindowsFor({
      date: DATE,
      hours: HOURS,
      closures: [closure('2026-10-02T12:00:00+04:00', '2026-10-03T02:00:00+04:00')],
    })
    expect(latestStartIn(short[0] as never, 120, 20)).toBeUndefined()
  })
})
