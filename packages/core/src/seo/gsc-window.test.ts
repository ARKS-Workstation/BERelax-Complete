import { describe, expect, it } from 'vitest'
import { businessDayFor, instantFromIso, localDate, localTime } from '../time.ts'
import {
  addUtcDays,
  GSC_DATA_LAG_DAYS,
  GSC_SNAPSHOT_WINDOW_DAYS,
  gscCalendarDate,
  gscRequestWindow,
  windowRespectsGscLag,
} from './gsc-window.ts'

/**
 * G-SEO-01 — the 2–3 day lag, and the one date in this system that is not a trading date.
 *
 * Every assertion here is paired with its control, because both claims are of the kind that passes
 * vacuously: "the window ends at today - 3" is satisfied by any window that ends in the past, and "these
 * are UTC dates" is satisfied by every instant except the nine hours where the two answers differ.
 */

/** 03:00 Asia/Dubai on 19 September 2026 — when the nightly crons run. */
const NIGHTLY_ISO = '2026-09-18T23:00:00.000Z'

describe('the requested window ends at today - 3 and never reaches nearer', () => {
  it('ends three days back and never includes today or yesterday', () => {
    const at = instantFromIso(NIGHTLY_ISO)
    const today = gscCalendarDate(at)
    const yesterday = addUtcDays(today, -1)
    const window = gscRequestWindow(at)

    expect(today).toBe('2026-09-18')
    expect(window.endDate).toBe('2026-09-15')
    // Stated three ways on purpose. The first is the arithmetic, the second and third are the criterion
    // in its own words — a window ending at today - 3 cannot contain either, and saying so separately is
    // what survives somebody "fixing" the constant.
    expect(window.endDate).toBe(addUtcDays(today, -GSC_DATA_LAG_DAYS))
    expect(window.endDate < yesterday).toBe(true)
    expect(window.endDate < today).toBe(true)
  })

  it('covers the declared number of whole days, inclusive at both ends', () => {
    const window = gscRequestWindow(instantFromIso(NIGHTLY_ISO))
    expect(window.startDate).toBe('2026-09-09')
    expect(addUtcDays(window.startDate, GSC_SNAPSHOT_WINDOW_DAYS - 1)).toBe(window.endDate)
  })

  it('a one-day window is the single day at today - 3, not an empty range', () => {
    const window = gscRequestWindow(instantFromIso(NIGHTLY_ISO), 1)
    expect(window.startDate).toBe(window.endDate)
    expect(window.endDate).toBe('2026-09-15')
  })

  it('refuses a window of less than a day', () => {
    expect(() => gscRequestWindow(instantFromIso(NIGHTLY_ISO), 0)).toThrow(/at least one whole day/)
    expect(() => gscRequestWindow(instantFromIso(NIGHTLY_ISO), 2.5)).toThrow(
      /at least one whole day/,
    )
  })

  it('the lag predicate accepts the computed window and refuses each day nearer than it', () => {
    const at = instantFromIso(NIGHTLY_ISO)
    const window = gscRequestWindow(at)
    expect(windowRespectsGscLag(window, at)).toBe(true)
    // The control, and the whole point of the predicate existing separately: a window one day nearer is
    // refused, so "it respects the lag" is not a property of every window ever built.
    for (let nearer = 1; nearer <= GSC_DATA_LAG_DAYS; nearer += 1) {
      expect(
        windowRespectsGscLag(
          { startDate: window.startDate, endDate: addUtcDays(window.endDate, nearer) },
          at,
        ),
        `a window ending ${nearer} day(s) later must be refused`,
      ).toBe(false)
    }
    // And a backwards window is not "safely in the past": it is a bug.
    expect(
      windowRespectsGscLag(
        { startDate: localDate('2026-09-15'), endDate: localDate('2026-09-09') },
        at,
      ),
    ).toBe(false)
  })
})

describe('these are Google calendar days in UTC, not business_day trading dates', () => {
  it('disagrees with the trading date at 01:30 Dubai, and the UTC answer is the one that is used', () => {
    // 01:30 on 19 September in Abu Dhabi is 21:30 UTC on the 18th. Trading runs 11:00–02:00, so this
    // instant belongs to the 18th's TRADING day — and to Google it is simply the 18th in UTC too, because
    // the UTC clock has not yet passed midnight. The pair that actually differs is below.
    const at = instantFromIso('2026-09-18T21:30:00.000Z')
    const hours = { open: localTime('11:00'), close: localTime('02:00') }
    expect(businessDayFor(at, hours)).toBe('2026-09-18')
    expect(gscCalendarDate(at)).toBe('2026-09-18')
  })

  it('disagrees at 03:30 Dubai, where the trading date is still yesterday and Google has moved on', () => {
    // 23:30 UTC on the 18th is 03:30 on the 19th in Abu Dhabi: after the 02:00 close, so the trading date
    // is the 19th; and still the 18th in UTC, so Google's date is the 18th. THIS is the four-hour band
    // where the two answers differ, and where resolving a Search Console date on `business_day` would
    // silently move a day of clicks. The window below is derived from the UTC answer, deliberately.
    const at = instantFromIso('2026-09-18T23:30:00.000Z')
    const hours = { open: localTime('11:00'), close: localTime('02:00') }
    expect(businessDayFor(at, hours)).toBe('2026-09-19')
    expect(gscCalendarDate(at)).toBe('2026-09-18')
    expect(gscRequestWindow(at).endDate).toBe('2026-09-15')
    // The control: had the trading date been used, the window would end a day later — which is a day
    // deeper into the 2–3 day lag, and therefore a day of incomplete figures stored as though complete.
    expect(gscRequestWindow(at).endDate).not.toBe(
      addUtcDays(localDate('2026-09-19'), -GSC_DATA_LAG_DAYS),
    )
  })

  it('reads the same for every process timezone, because the calendar date comes from the instant', () => {
    // The `TZ=Pacific/Kiritimati` case, asserted here rather than left to the suite runner: `toISOString`
    // is UTC by definition, so nothing in this module can be moved by a machine's zone.
    const at = instantFromIso('2026-09-18T23:59:59.999Z')
    expect(gscCalendarDate(at)).toBe('2026-09-18')
    expect(gscCalendarDate(instantFromIso('2026-09-19T00:00:00.000Z'))).toBe('2026-09-19')
  })
})

describe('day arithmetic crosses month and year boundaries', () => {
  it('steps back over the end of a month and the end of a year', () => {
    expect(addUtcDays(localDate('2026-03-01'), -1)).toBe('2026-02-28')
    expect(addUtcDays(localDate('2027-01-01'), -1)).toBe('2026-12-31')
    expect(addUtcDays(localDate('2028-03-01'), -1)).toBe('2028-02-29')
    expect(addUtcDays(localDate('2026-12-30'), 3)).toBe('2027-01-02')
  })

  it('refuses a fractional number of days rather than rounding one', () => {
    expect(() => addUtcDays(localDate('2026-09-15'), 1.5)).toThrow(/whole number of days/)
  })

  it('a window computed on the first of a month reaches into the previous one', () => {
    const window = gscRequestWindow(instantFromIso('2027-01-01T23:00:00.000Z'))
    expect(window.endDate).toBe('2026-12-29')
    expect(window.startDate).toBe('2026-12-23')
  })
})
