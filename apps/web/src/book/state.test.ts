import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  BOOK_FIELDS,
  BOOK_PATH,
  bookHref,
  CLIENT_GENDERS,
  DAY_STRIP_DAYS,
  dayStrip,
  groupStarts,
  parseBookingParams,
  SLOT_GROUPS,
  slotGroupOf,
  tradingDateLabel,
  wallClock,
} from './state.ts'

/**
 * B-UI-01 — everything `/book` decides that is a pure function of its URL.
 *
 * These run in milliseconds and cover the three things on this page that are wrong in ways a screenshot
 * cannot show: a query field accepted that should not be, a start filed under the wrong part of the day,
 * and a day strip that silently answers about a different day from the one asked for.
 *
 * Every assertion has a control that must fail. `parseBookingParams` is checked against values it must
 * *reject* as well as values it must keep, because a parser that returned everything would satisfy the
 * accept half on its own — and `?date=lol` reaching a SQL predicate is the reason the rejection matters.
 */

const uuid = '0199f0d1-2b4e-7c9a-8f1e-3d5a7b9c1e22'
const second = '0199f0d1-2b4e-7c9a-8f1e-3d5a7b9c1e23'

/** 19:45 Gulf time on a fixed date, and the instants around the boundaries this module owns. */
const at = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+04:00`)

describe('parseBookingParams keeps what it can read and drops what it cannot', () => {
  it('keeps a well-formed field of every kind', () => {
    const parsed = parseBookingParams({
      [BOOK_FIELDS.variant]: uuid,
      [BOOK_FIELDS.date]: '2026-10-24',
      [BOOK_FIELDS.therapist]: second,
      [BOOK_FIELDS.gender]: 'female',
      [BOOK_FIELDS.slot]: String(at('2026-10-24', '19:45')),
      [BOOK_FIELDS.step]: 'waitlist',
    })
    expect(parsed).toEqual({
      variant: uuid,
      date: '2026-10-24',
      therapist: second,
      gender: 'female',
      slot: at('2026-10-24', '19:45'),
      step: 'waitlist',
    })
  })

  it('drops every malformed field, and drops it to null rather than to a default', () => {
    // The control on the case above. A parser that kept these would put `lol` into a `::date` cast and a
    // `'; drop'` into a uuid comparison — and this page is a public URL anything may link to.
    const parsed = parseBookingParams({
      [BOOK_FIELDS.variant]: 'not-a-uuid',
      [BOOK_FIELDS.date]: '24/10/2026',
      [BOOK_FIELDS.therapist]: `${uuid} or 1=1`,
      [BOOK_FIELDS.gender]: 'other',
      [BOOK_FIELDS.slot]: '19:45',
      [BOOK_FIELDS.step]: 'confirm',
    })
    expect(parsed.variant).toBeNull()
    expect(parsed.date).toBeNull()
    expect(parsed.therapist).toBeNull()
    expect(parsed.gender).toBeNull()
    // `Number.parseInt('19:45')` is 19, which is a valid instant in January 1970. The regex is what stops
    // a wall-clock string being read as an epoch, and this is the case that proves it.
    expect(parsed.slot).toBeNull()
    expect(parsed.step).toBe('choose')
  })

  it('takes the first value when a field arrives twice', () => {
    // A re-submitted stale form sends the field twice. Joining them would produce `a,b`, which every
    // validator above rejects — so the reader would lose a choice that is present in the URL.
    const parsed = parseBookingParams({ [BOOK_FIELDS.date]: ['2026-10-24', '2026-10-25'] })
    expect(parsed.date).toBe('2026-10-24')
  })

  it('reads nothing out of an empty query, and never throws on arbitrary input', () => {
    expect(parseBookingParams({})).toEqual({
      variant: null,
      date: null,
      therapist: null,
      gender: null,
      slot: null,
      step: 'choose',
    })
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.string()), (raw) => {
        const parsed = parseBookingParams(raw)
        // Whatever arrives, what comes out is either null or a value of the declared shape. A page that
        // 500s on a mangled query string is a page a stray link can take off the air.
        expect(parsed.variant === null || /^[0-9a-f-]{36}$/i.test(parsed.variant)).toBe(true)
        expect(parsed.date === null || /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)).toBe(true)
        expect(parsed.gender === null || CLIENT_GENDERS.includes(parsed.gender)).toBe(true)
        expect(parsed.slot === null || Number.isSafeInteger(parsed.slot)).toBe(true)
        expect(['choose', 'waitlist']).toContain(parsed.step)
      }),
      { numRuns: 200 },
    )
  })
})

describe('bookHref spells one state one way', () => {
  it('leaves out an empty field and sorts the rest', () => {
    expect(bookHref(BOOK_PATH, { date: '2026-10-24', variant: uuid, therapist: null })).toBe(
      `/book?date=2026-10-24&variant=${uuid}`,
    )
    expect(bookHref(BOOK_PATH, {})).toBe('/book')
  })

  it('round-trips through the parser', () => {
    // The two halves are used together — the no-availability state builds a link and the next request
    // parses it — so the property that matters is that the pair is lossless, not that either is correct.
    const href = bookHref('/ar/book', {
      [BOOK_FIELDS.variant]: uuid,
      [BOOK_FIELDS.date]: '2026-10-24',
      [BOOK_FIELDS.gender]: 'male',
      [BOOK_FIELDS.slot]: at('2026-10-24', '11:15'),
    })
    const query = Object.fromEntries(new URLSearchParams(href.split('?')[1] ?? ''))
    expect(parseBookingParams(query)).toEqual({
      variant: uuid,
      date: '2026-10-24',
      therapist: null,
      gender: 'male',
      slot: at('2026-10-24', '11:15'),
      step: 'choose',
    })
  })
})

describe('a start is filed under the part of the day a reader would look for it in', () => {
  it('splits at 12:00 and 17:00 in the premises own zone', () => {
    expect(slotGroupOf(at('2026-10-24', '11:15'))).toBe('morning')
    expect(slotGroupOf(at('2026-10-24', '11:59'))).toBe('morning')
    expect(slotGroupOf(at('2026-10-24', '12:00'))).toBe('afternoon')
    expect(slotGroupOf(at('2026-10-24', '16:59'))).toBe('afternoon')
    expect(slotGroupOf(at('2026-10-24', '17:00'))).toBe('evening')
    expect(slotGroupOf(at('2026-10-24', '23:45'))).toBe('evening')
  })

  it('files an after-midnight start under the evening of the trading date it belongs to', () => {
    // The case the whole function exists for. Trading runs 11:00-02:00, so 00:30 is the late end of the
    // 24th's session (ADR 0007) — grouping it by its wall-clock hour would file it under "morning" and
    // print it above the 19:45 it follows.
    expect(slotGroupOf(at('2026-10-25', '00:30'))).toBe('evening')
    expect(slotGroupOf(at('2026-10-25', '01:45'))).toBe('evening')
    // And the control: the same clock time on a date this grid is not about is still the small hours.
    expect(slotGroupOf(at('2026-10-25', '02:59'))).toBe('evening')
    expect(slotGroupOf(at('2026-10-25', '03:00'))).toBe('morning')
  })

  it('groups a whole trading day in time order, with the empty parts absent', () => {
    const starts = [
      at('2026-10-25', '00:30'),
      at('2026-10-24', '19:45'),
      at('2026-10-24', '11:15'),
      at('2026-10-24', '23:45'),
    ]
    const grouped = groupStarts(starts)
    expect(grouped.map((section) => section.group)).toEqual(['morning', 'evening'])
    // Afternoon is absent rather than present and empty: an empty grid with a heading reads as a fault.
    expect(grouped.map((section) => section.group)).not.toContain('afternoon')
    // Time order across the midnight boundary, which sorting the LABELS would get wrong: `00:30` sorts
    // before `11:15` as a string and after it as an instant, and the instant is the truth.
    expect(grouped[1]?.starts.map((start) => start.label)).toEqual(['19:45', '23:45', '00:30'])
    expect(grouped.flatMap((section) => section.starts)).toHaveLength(4)
  })

  it('answers with a declared group for any instant', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000_000 }), (instant) => {
        expect(SLOT_GROUPS).toContain(slotGroupOf(instant))
      }),
      { numRuns: 300 },
    )
  })

  it('drops a duplicate start rather than rendering one time twice', () => {
    const twice = groupStarts([at('2026-10-24', '19:45'), at('2026-10-24', '19:45')])
    expect(twice.flatMap((section) => section.starts)).toHaveLength(1)
  })
})

describe('the day strip answers about the day it was asked about', () => {
  const dates = [
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
    '2026-10-27',
    '2026-10-28',
    '2026-10-29',
    '2026-10-30',
    '2026-10-31',
  ]

  it('offers exactly the declared number of days and selects the first when none was asked for', () => {
    const strip = dayStrip(dates, null)
    expect(strip.days).toHaveLength(DAY_STRIP_DAYS)
    expect(strip.selected).toBe('2026-10-24')
    expect(strip.days.filter((day) => day.selected).map((day) => day.tradingDate)).toEqual([
      '2026-10-24',
    ])
  })

  it('selects the day asked for when the strip offers it', () => {
    const strip = dayStrip(dates, '2026-10-27')
    expect(strip.selected).toBe('2026-10-27')
    expect(strip.days.filter((day) => day.selected)).toHaveLength(1)
  })

  it('falls back to the first day for a date the strip does not offer, and says so by selecting it', () => {
    // A bookmark from last week, and a date the premises does not trade. Neither is an error: the page
    // answers with the days it can offer now. The control is the case above — a date it CAN offer wins.
    for (const requested of ['2026-01-01', '2026-11-30', '']) {
      const strip = dayStrip(dates, requested)
      expect(strip.selected, requested).toBe('2026-10-24')
    }
    expect(dayStrip([], '2026-10-24').selected).toBeNull()
    expect(dayStrip([], null).days).toEqual([])
  })
})

describe('a time and a date are spelled once for both documents', () => {
  it('renders a wall clock in the premises zone, in Latin digits, in both locales', () => {
    // docs/08 §7: every number, price and time is Latin-digit. `Intl.DateTimeFormat('ar-AE')` would
    // return Arabic-Indic digits and a 12-hour clock, so the time goes through `toLocal` instead — one
    // spelling, and one thing for a test to assert.
    expect(wallClock(at('2026-10-24', '19:45'))).toBe('19:45')
    expect(wallClock(at('2026-10-25', '00:30'))).toBe('00:30')
  })

  it('names a trading date in each locale own words, with Latin digits in Arabic too', () => {
    const english = tradingDateLabel('2026-10-24', 'en', 'long')
    const arabic = tradingDateLabel('2026-10-24', 'ar', 'long')
    expect(english).toContain('24')
    expect(english).toContain('October')
    // Latin digits on the Arabic document: `ar-AE-u-nu-latn`, per docs/08 §7. Without the extension this
    // would read ٢٤ beside a Latin-digit price, which is two numbering systems on one page.
    expect(arabic).toContain('24')
    expect(arabic).not.toMatch(/[٠-٩]/)
    // Not a translation of the same string: the Arabic label is Arabic.
    expect(arabic).not.toBe(english)
    expect(arabic).toMatch(/[؀-ۿ]/)
    // The short form is shorter, which is what the strip needs at 390px.
    expect(tradingDateLabel('2026-10-24', 'en', 'short').length).toBeLessThan(english.length)
    // The date is formatted as a DATE, not as an instant: a zone shift would print the 23rd or the 25th.
    expect(tradingDateLabel('2026-10-01', 'en', 'short')).toContain('1')
    expect(tradingDateLabel('2026-10-01', 'en', 'long')).toContain('October')
  })
})
