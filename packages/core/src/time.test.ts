import { AppError } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ASIA_DUBAI,
  addMinutes,
  businessDayBounds,
  businessDayFor,
  crossesMidnight,
  differenceInMinutes,
  fixedClock,
  fromLocal,
  instantFromIso,
  instantToIso,
  latestStart,
  localDate,
  localTime,
  minutesSinceMidnight,
  type TradingHours,
  toLocal,
} from './time.ts'

/** The real trading hours from docs/13-business-profile.md §2. */
const BERELAX: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const SAME_DAY: TradingHours = { open: localTime('09:00'), close: localTime('18:00') }

describe('clock injection', () => {
  it('fixedClock returns the same instant every time, which is the point', () => {
    const clock = fixedClock('2026-09-18T06:00:00.000Z')
    expect(clock.now()).toBe(clock.now())
    expect(instantToIso(clock.now())).toBe('2026-09-18T06:00:00.000Z')
  })

  it('rejects an unparseable instant rather than silently producing NaN', () => {
    expect(() => fixedClock('not a date')).toThrow(AppError)
  })
})

describe('local time in Asia/Dubai', () => {
  it('renders 22:30Z as 02:30 the following day — the after-midnight case', () => {
    const local = toLocal(instantFromIso('2026-03-01T22:30:00Z'), ASIA_DUBAI)
    expect(local.date).toBe('2026-03-02')
    expect(local.time).toBe('02:30')
  })

  it('renders midnight as 00:00, not 24:00', () => {
    const local = toLocal(instantFromIso('2026-03-01T20:00:00Z'), ASIA_DUBAI)
    expect(local.time).toBe('00:00')
    expect(local.date).toBe('2026-03-02')
  })

  it('round-trips local -> instant -> local for every hour of a year', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 364 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        (dayOffset, hour, minute) => {
          const base = new Date('2026-01-01T00:00:00Z')
          base.setUTCDate(base.getUTCDate() + dayOffset)
          const date = localDate(base.toISOString().slice(0, 10))
          const time = localTime(
            `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
          )
          const back = toLocal(fromLocal(date, time, ASIA_DUBAI), ASIA_DUBAI)
          return back.date === date && back.time === time
        },
      ),
      { numRuns: 1500 },
    )
  })
})

describe('crossesMidnight', () => {
  it('is true for 11:00-02:00 and false for 09:00-18:00', () => {
    expect(crossesMidnight(BERELAX)).toBe(true)
    expect(crossesMidnight(SAME_DAY)).toBe(false)
  })

  it('treats an identical open and close as crossing, i.e. a 24-hour day', () => {
    expect(crossesMidnight({ open: localTime('11:00'), close: localTime('11:00') })).toBe(true)
  })
})

describe('businessDayFor — the rule everything downstream depends on', () => {
  const at = (iso: string) => businessDayFor(instantFromIso(iso), BERELAX, ASIA_DUBAI)

  it('an 01:30 appointment belongs to the PREVIOUS trading date', () => {
    // 2026-03-02 01:30 Dubai = 2026-03-01 21:30Z
    expect(at('2026-03-01T21:30:00Z')).toBe('2026-03-01')
  })

  it('a 23:45 appointment belongs to that same date', () => {
    // 2026-03-01 23:45 Dubai = 2026-03-01 19:45Z
    expect(at('2026-03-01T19:45:00Z')).toBe('2026-03-01')
  })

  it('a 13:00 appointment belongs to that same date', () => {
    expect(at('2026-03-01T09:00:00Z')).toBe('2026-03-01')
  })

  it('exactly at close (02:00) belongs to the NEW date, because the range is half-open', () => {
    // 2026-03-02 02:00 Dubai = 2026-03-01 22:00Z
    expect(at('2026-03-01T22:00:00Z')).toBe('2026-03-02')
  })

  it('one minute before close belongs to the previous date', () => {
    expect(at('2026-03-01T21:59:00Z')).toBe('2026-03-01')
  })

  it('crosses a month boundary correctly', () => {
    // 2026-04-01 01:00 Dubai = 2026-03-31 21:00Z
    expect(at('2026-03-31T21:00:00Z')).toBe('2026-03-31')
  })

  it('crosses a year boundary correctly', () => {
    // 2027-01-01 01:00 Dubai = 2026-12-31 21:00Z
    expect(at('2026-12-31T21:00:00Z')).toBe('2026-12-31')
  })

  it('is the calendar date when hours do not cross midnight', () => {
    expect(businessDayFor(instantFromIso('2026-03-01T09:00:00Z'), SAME_DAY, ASIA_DUBAI)).toBe(
      '2026-03-01',
    )
  })

  it('every instant inside a business day resolves to that same day', () => {
    const day = localDate('2026-03-01')
    const { open, close } = businessDayBounds(day, BERELAX, ASIA_DUBAI)
    fc.assert(
      fc.property(fc.integer({ min: 0, max: differenceInMinutes(close, open) - 1 }), (offset) => {
        return businessDayFor(addMinutes(open, offset), BERELAX, ASIA_DUBAI) === day
      }),
      { numRuns: 900 },
    )
  })
})

describe('businessDayBounds', () => {
  it('spans 15 hours for 11:00-02:00', () => {
    const { open, close } = businessDayBounds(localDate('2026-03-01'), BERELAX, ASIA_DUBAI)
    expect(differenceInMinutes(close, open)).toBe(15 * 60)
    expect(instantToIso(open)).toBe('2026-03-01T07:00:00.000Z')
    expect(instantToIso(close)).toBe('2026-03-01T22:00:00.000Z')
  })

  it('spans 9 hours for ordinary same-day hours', () => {
    const { open, close } = businessDayBounds(localDate('2026-03-01'), SAME_DAY, ASIA_DUBAI)
    expect(differenceInMinutes(close, open)).toBe(9 * 60)
  })

  it('close is always after open', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 364 }), (dayOffset) => {
        const base = new Date('2026-01-01T00:00:00Z')
        base.setUTCDate(base.getUTCDate() + dayOffset)
        const { open, close } = businessDayBounds(
          localDate(base.toISOString().slice(0, 10)),
          BERELAX,
          ASIA_DUBAI,
        )
        return close > open
      }),
      { numRuns: 400 },
    )
  })
})

describe('latestStart', () => {
  it('a 120-minute treatment with 20 minutes turnaround must start by 23:40', () => {
    const start = latestStart(localDate('2026-03-01'), BERELAX, 120, 20, ASIA_DUBAI)
    expect(toLocal(start, ASIA_DUBAI)).toEqual({ date: '2026-03-01', time: '23:40' })
  })

  it('a 45-minute treatment with 20 minutes turnaround must start by 00:55', () => {
    const start = latestStart(localDate('2026-03-01'), BERELAX, 45, 20, ASIA_DUBAI)
    expect(toLocal(start, ASIA_DUBAI)).toEqual({ date: '2026-03-02', time: '00:55' })
  })

  it('the latest start plus duration plus turnaround always lands exactly on close', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(45, 60, 90, 120),
        fc.integer({ min: 0, max: 45 }),
        (duration, turnaround) => {
          const day = localDate('2026-03-01')
          const start = latestStart(day, BERELAX, duration, turnaround, ASIA_DUBAI)
          const { close } = businessDayBounds(day, BERELAX, ASIA_DUBAI)
          return addMinutes(start, duration + turnaround) === close
        },
      ),
      { numRuns: 300 },
    )
  })

  it('a latest start is still inside the same business day', () => {
    const day = localDate('2026-03-01')
    const start = latestStart(day, BERELAX, 60, 20, ASIA_DUBAI)
    expect(businessDayFor(start, BERELAX, ASIA_DUBAI)).toBe(day)
  })
})

describe('validation', () => {
  it('rejects a malformed LocalDate', () => {
    expect(() => localDate('01/03/2026')).toThrow(/YYYY-MM-DD/)
  })

  it('rejects a malformed or out-of-range LocalTime', () => {
    expect(() => localTime('25:00')).toThrow(/HH:MM/)
    expect(() => localTime('9:00')).toThrow(/HH:MM/)
  })

  it('rejects fractional minutes', () => {
    expect(() => addMinutes(instantFromIso('2026-03-01T00:00:00Z'), 1.5)).toThrow(/integer/)
  })

  it('minutesSinceMidnight handles both ends of the day', () => {
    expect(minutesSinceMidnight(localTime('00:00'))).toBe(0)
    expect(minutesSinceMidnight(localTime('23:59'))).toBe(1439)
  })
})
