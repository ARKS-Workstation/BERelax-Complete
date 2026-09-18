import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ASIA_DUBAI,
  type Instant,
  instantFromIso,
  type LocalDate,
  localDate,
  localTime,
  type TradingHours,
} from '../time.ts'
import { horizonDates, horizonRows } from './horizon.ts'
import {
  type HoursForDate,
  hoursFromSchedule,
  resolveTradingDate,
  tradingBounds,
  weekdayIn,
} from './resolve.ts'

/** The real hours: 11:00 to 02:00, every day. */
const OPEN_11_TO_02: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const DAILY: HoursForDate = () => OPEN_11_TO_02

describe('acceptance — the three cases that define the rule', () => {
  const cases: readonly [string, string, ReturnType<typeof describeResolution>][] = [
    // 01:30 on the 3rd is inside the 2nd's 11:00–02:00 session.
    ['2026-10-03T01:30:00+04:00', 'belongs to the previous trading date', 'trading 2026-10-02'],
    // 11:00 on the 3rd is the moment the 3rd opens.
    ['2026-10-03T11:00:00+04:00', 'opens the 3rd', 'trading 2026-10-03'],
    // 10:59 is in the daytime gap: the 2nd closed at 02:00 and the 3rd has not opened.
    ['2026-10-03T10:59:00+04:00', 'is in the daytime gap', 'outside before_opening'],
  ]

  for (const [iso, what, expected] of cases) {
    it(`${iso} ${what}`, () => {
      expect(describeResolution(resolveTradingDate(instantFromIso(iso), DAILY))).toBe(expected)
    })
  }

  it('treats the close instant as outside, because a window is half-open', () => {
    // A treatment may END at 02:00. Nothing may start there, and an appointment booked at the close
    // instant is the off-by-one that rosters a therapist for a shift that has finished.
    expect(
      describeResolution(resolveTradingDate(instantFromIso('2026-10-03T02:00:00+04:00'), DAILY)),
    ).toBe('outside before_opening')
    expect(
      describeResolution(resolveTradingDate(instantFromIso('2026-10-03T01:59:59+04:00'), DAILY)),
    ).toBe('trading 2026-10-02')
  })

  it('names the reason rather than returning null by accident', () => {
    const result = resolveTradingDate(instantFromIso('2026-10-03T08:00:00+04:00'), DAILY)
    expect(result.kind).toBe('outside_trading')
    if (result.kind === 'outside_trading') {
      expect(result.reason).toBe('before_opening')
      // The calendar date is carried so a message can say "we open at 11:00" without re-deriving it.
      expect(result.calendarDate).toBe('2026-10-03')
    }
  })

  it('reports premises_closed for a date with no hours at all', () => {
    const closed: HoursForDate = (date) => (date === '2026-10-03' ? undefined : OPEN_11_TO_02)
    const result = resolveTradingDate(instantFromIso('2026-10-03T15:00:00+04:00'), closed)
    expect(result.kind === 'outside_trading' && result.reason).toBe('premises_closed')
  })

  it('reports after_closing for hours that do not cross midnight', () => {
    const daytime: HoursForDate = () => ({ open: localTime('09:00'), close: localTime('17:00') })
    const result = resolveTradingDate(instantFromIso('2026-10-03T18:00:00+04:00'), daytime)
    expect(result.kind === 'outside_trading' && result.reason).toBe('after_closing')
  })
})

describe('tradingBounds', () => {
  it('spans exactly 15 hours for 11:00 to 02:00, asserted arithmetically', () => {
    const { opensAt, closesAt } = tradingBounds(localDate('2026-10-02'), OPEN_11_TO_02)
    expect((closesAt - opensAt) / 1000).toBe(54_000)
  })

  it('closes on the following calendar date when the session crosses midnight', () => {
    const { closesAt } = tradingBounds(localDate('2026-10-02'), OPEN_11_TO_02)
    expect(new Date(closesAt).toISOString()).toBe('2026-10-02T22:00:00.000Z')
  })

  it('stays on the same date when it does not', () => {
    const daytime: TradingHours = { open: localTime('09:00'), close: localTime('17:00') }
    const { opensAt, closesAt } = tradingBounds(localDate('2026-10-02'), daytime)
    expect((closesAt - opensAt) / 3_600_000).toBe(8)
  })
})

describe('the mapping is total and unambiguous', () => {
  const HORIZON_DAYS = 400
  const START = localDate('2026-01-01')

  /**
   * An independent implementation: every window in the horizon, built once, then scanned.
   *
   * Deliberately naive and deliberately not sharing a line with the resolver — an oracle written in
   * terms of the thing it checks proves the thing is self-consistent, which is not the question.
   *
   * The windows are precomputed because building them inside the property meant four million `Intl`
   * round trips and a suite that timed out. Precomputing changes the cost, not the independence.
   */
  const WINDOWS: readonly { date: LocalDate; opensAt: Instant; closesAt: Instant }[] = horizonDates(
    START,
    HORIZON_DAYS,
  ).map((date) => ({ date, ...tradingBounds(date, OPEN_11_TO_02) }))

  function naiveScan(instant: Instant): LocalDate | undefined {
    for (const window of WINDOWS) {
      if (instant >= window.opensAt && instant < window.closesAt) return window.date
    }
    return undefined
  }

  const firstOpen = WINDOWS[0]?.opensAt ?? (0 as Instant)
  const lastClose = WINDOWS.at(-1)?.closesAt ?? (0 as Instant)

  it('agrees with an independent interval scan over 10,000 random instants', () => {
    fc.assert(
      fc.property(fc.integer({ min: firstOpen, max: lastClose }), (millis) => {
        const instant = millis as Instant
        const resolved = resolveTradingDate(instant, DAILY)
        const scanned = naiveScan(instant)
        if (scanned === undefined) return resolved.kind === 'outside_trading'
        return resolved.kind === 'trading' && resolved.date === scanned
      }),
      { numRuns: 10_000 },
    )
  }, 30_000)

  it('maps every instant to at most one trading date', () => {
    // Windows are half-open and consecutive sessions are separated by the daytime gap, so overlap is
    // structurally impossible — but the scan is what would notice if it stopped being.
    fc.assert(
      fc.property(fc.integer({ min: firstOpen, max: lastClose }), (millis) => {
        const instant = millis as Instant
        const matches = WINDOWS.filter(
          (window) => instant >= window.opensAt && instant < window.closesAt,
        ).length
        return matches <= 1
      }),
      { numRuns: 10_000 },
    )
  }, 30_000)

  it('leaves the daytime gap unmapped, which is most of a day', () => {
    // 02:00 to 11:00 is nine hours out of twenty-four. A resolver that mapped them would be wrong
    // 37% of the time and would look right in every test that only checked opening hours.
    const unmapped = fc
      .sample(fc.integer({ min: firstOpen, max: lastClose }), 5_000)
      .filter((millis) => naiveScan(millis as Instant) === undefined)
    expect(unmapped.length).toBeGreaterThan(0)
    for (const millis of unmapped.slice(0, 200)) {
      expect(resolveTradingDate(millis as Instant, DAILY).kind).toBe('outside_trading')
    }
  })
})

describe('no fixed-offset assumption', () => {
  it('honours the zone it is given rather than ignoring it', () => {
    // The same instant resolves to different trading dates in different business zones. If the zone
    // argument were being dropped — the classic way a "timezone-aware" function is not — both would
    // come back the same, and every test that only ever passed Asia/Dubai would still be green.
    const instant = instantFromIso('2026-10-03T01:30:00+04:00')
    expect(describeResolution(resolveTradingDate(instant, DAILY, ASIA_DUBAI))).toBe(
      'trading 2026-10-02',
    )
    // 01:30 in Dubai is 21:30 the previous evening in London: mid-session on the 2nd there too, but
    // by a different route, and 11:30 in Kiritimati, which is before opening.
    expect(
      describeResolution(resolveTradingDate(instant, DAILY, 'Pacific/Kiritimati' as never)),
    ).toBe('trading 2026-10-03')
  })

  it('makes no fixed-offset assumption, which the suite proves by running under three timezones', () => {
    // Asia/Dubai has no DST, so a hardcoded +04:00 survives every test — until the worker runs in
    // another region. Proving that needs a fresh process per timezone, because mutating TZ mid-run
    // does not reliably invalidate Intl's caches. `scripts/test-gates.mjs` runs this whole suite
    // under UTC, UTC+14 and UTC-7; this assertion is here to say where that lives.
    expect(
      describeResolution(resolveTradingDate(instantFromIso('2026-10-03T01:30:00+04:00'), DAILY)),
    ).toBe('trading 2026-10-02')
  })

  it('computes a weekday in the business zone, not the machine zone', () => {
    // 2026-10-03 is a Saturday in Asia/Dubai.
    expect(weekdayIn(localDate('2026-10-03'))).toBe(6)
    expect(weekdayIn(localDate('2026-10-04'))).toBe(0)
  })
})

describe('hoursFromSchedule', () => {
  const schedule = {
    weekly: Array.from({ length: 7 }, () => OPEN_11_TO_02),
    overrides: { '2026-03-20': { open: localTime('20:00'), close: localTime('01:00') } },
    closedDates: [localDate('2026-12-02')],
  }
  const hoursFor = hoursFromSchedule(schedule)

  it('uses the weekly pattern by default', () => {
    expect(hoursFor(localDate('2026-10-03'))).toEqual(OPEN_11_TO_02)
  })

  it('prefers a dated override, so Ramadan hours are data rather than a migration', () => {
    expect(hoursFor(localDate('2026-03-20'))?.open).toBe('20:00')
  })

  it('returns nothing for a closed date, so no business day is generated for it', () => {
    expect(hoursFor(localDate('2026-12-02'))).toBeUndefined()
  })
})

describe('horizonRows', () => {
  const hoursFor = hoursFromSchedule({
    weekly: Array.from({ length: 7 }, () => OPEN_11_TO_02),
    closedDates: [localDate('2026-10-05')],
  })

  it('produces one row per trading date and none for a closed one', () => {
    const rows = horizonRows({ from: localDate('2026-10-01'), days: 10, hoursFor })
    expect(rows).toHaveLength(9)
    expect(rows.map((row) => row.tradingDate)).not.toContain('2026-10-05')
  })

  it('is deterministic: the same horizon twice is the same rows', () => {
    const options = { from: localDate('2026-10-01'), days: 30, hoursFor }
    expect(horizonRows(options)).toEqual(horizonRows(options))
  })

  it('marks an override-sourced date, so a report can tell why the hours were unusual', () => {
    const rows = horizonRows({
      from: localDate('2026-10-01'),
      days: 3,
      hoursFor,
      isOverride: (date) => date === '2026-10-02',
    })
    expect(rows.find((row) => row.tradingDate === '2026-10-02')?.source).toBe('override')
    expect(rows.find((row) => row.tradingDate === '2026-10-01')?.source).toBe('weekly')
  })
})

function describeResolution(result: ReturnType<typeof resolveTradingDate>): string {
  return result.kind === 'trading' ? `trading ${result.date}` : `outside ${result.reason}`
}
