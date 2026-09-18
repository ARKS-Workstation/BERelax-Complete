/**
 * Resolving an instant to the trading date it belongs to.
 *
 * Trading runs 11:00 to 02:00, so a treatment at 01:30 on the 3rd belongs to the **2nd's** business
 * day. Cash-up, the rota, commission and every daily report cut on that, and "today" in the owner
 * dashboard is a trading date rather than a calendar one.
 *
 * ## Why this returns a result rather than a date
 *
 * Between 02:00 and 11:00 the premises is shut, and an instant in that gap belongs to **no** trading
 * date. A resolver that returns a date anyway — the nearest one, the calendar one — is worse than one
 * that fails, because the wrong answer is indistinguishable from a right one and it lands in a
 * report. Returning `null` is barely better: a caller that forgets the check gets a crash somewhere
 * else entirely, with nothing saying why.
 *
 * So the result is a discriminated union carrying a **named reason**. `before_opening` and
 * `after_closing` are different facts about the business, and a caller that wants to say "we open at
 * 11" needs to know which one it has.
 *
 * Pure: the zone is an argument, the hours are an argument, and there is no clock. That is what makes
 * the whole thing testable under any process timezone, which the suite asserts.
 */
import {
  ASIA_DUBAI,
  crossesMidnight,
  fromLocal,
  type Instant,
  type LocalDate,
  type LocalTime,
  localDate,
  minutesSinceMidnight,
  type TimeZone,
  type TradingHours,
  toLocal,
} from '../time.ts'

/** Why an instant belongs to no trading date. */
export type OutsideTradingReason =
  /** After the previous night's close and before today's opening — the daytime gap. */
  | 'before_opening'
  /** After close on a day whose hours do not reach the next opening. */
  | 'after_closing'
  /** The premises is shut for the whole date: a holiday, or maintenance. */
  | 'premises_closed'

export type TradingDateResolution =
  | { readonly kind: 'trading'; readonly date: LocalDate }
  | {
      readonly kind: 'outside_trading'
      readonly reason: OutsideTradingReason
      /**
       * The calendar date the instant fell on locally.
       *
       * Not a trading date, and never to be used as one. It is here so a message can say *"we open at
       * 11:00 on Saturday"* without the caller re-deriving it.
       */
      readonly calendarDate: LocalDate
    }

/** A date the premises does not trade at all. */
export interface ClosedDate {
  readonly date: LocalDate
}

function previousDate(date: LocalDate): LocalDate {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - 1)
  return localDate(value.toISOString().slice(0, 10))
}

export function nextDate(date: LocalDate): LocalDate {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return localDate(value.toISOString().slice(0, 10))
}

/** Hours for a given calendar date, or undefined when the premises does not open that day. */
export type HoursForDate = (date: LocalDate) => TradingHours | undefined

/**
 * The trading date an instant belongs to, or a named reason why it belongs to none.
 *
 * Two candidates are considered, in this order:
 *
 *  1. **The previous date's session, if it runs past midnight.** 01:30 on the 3rd is inside the 2nd's
 *     11:00–02:00, so the 2nd wins. Checking this first is what makes the after-midnight case the
 *     normal path rather than a correction applied afterwards.
 *  2. **The instant's own calendar date.** 11:00 on the 3rd is inside the 3rd's session.
 *
 * Windows are half-open — `[open, close)` — so an instant exactly at 02:00 is outside. A treatment may
 * *end* at close; nothing may start there, and an appointment booked at the close instant is the kind
 * of off-by-one that produces a therapist rostered for a shift that has finished.
 */
export function resolveTradingDate(
  instant: Instant,
  hoursFor: HoursForDate,
  zone: TimeZone = ASIA_DUBAI,
): TradingDateResolution {
  const { date, time } = toLocal(instant, zone)
  const minutes = minutesSinceMidnight(time)

  const yesterday = previousDate(date)
  const yesterdayHours = hoursFor(yesterday)
  if (yesterdayHours !== undefined && crossesMidnight(yesterdayHours)) {
    if (minutes < minutesSinceMidnight(yesterdayHours.close)) {
      return { kind: 'trading', date: yesterday }
    }
  }

  const todayHours = hoursFor(date)
  if (todayHours === undefined) {
    return { kind: 'outside_trading', reason: 'premises_closed', calendarDate: date }
  }

  const openMinutes = minutesSinceMidnight(todayHours.open)
  const closeMinutes = minutesSinceMidnight(todayHours.close)

  if (minutes < openMinutes) {
    return { kind: 'outside_trading', reason: 'before_opening', calendarDate: date }
  }
  if (!crossesMidnight(todayHours) && minutes >= closeMinutes) {
    return { kind: 'outside_trading', reason: 'after_closing', calendarDate: date }
  }
  return { kind: 'trading', date }
}

/** The open and close instants of a trading date. `close` may land on the next calendar date. */
export function tradingBounds(
  date: LocalDate,
  hours: TradingHours,
  zone: TimeZone = ASIA_DUBAI,
): { readonly opensAt: Instant; readonly closesAt: Instant } {
  const opensAt = fromLocal(date, hours.open, zone)
  const closesAt = crossesMidnight(hours)
    ? fromLocal(nextDate(date), hours.close, zone)
    : fromLocal(date, hours.close, zone)
  return { opensAt, closesAt }
}

/** Hours lookup backed by a weekly pattern plus dated overrides and full closures. */
export interface HoursSchedule {
  /** Index 0 is Sunday, matching `premises_hours.day_of_week`. */
  readonly weekly: readonly (TradingHours | undefined)[]
  /** Dated replacements — Ramadan, a seasonal change. Keyed by ISO date. */
  readonly overrides?: Readonly<Record<string, TradingHours>>
  /** Dates the premises does not open at all. */
  readonly closedDates?: readonly LocalDate[]
}

export function hoursFromSchedule(
  schedule: HoursSchedule,
  zone: TimeZone = ASIA_DUBAI,
): HoursForDate {
  const closed = new Set(schedule.closedDates ?? [])
  return (date: LocalDate): TradingHours | undefined => {
    if (closed.has(date)) return undefined
    const override = schedule.overrides?.[date]
    if (override !== undefined) return override
    // `Intl` in the business zone rather than the process zone: a date's weekday is a local fact, and
    // `new Date(date).getDay()` would answer it in whatever timezone the machine happens to be in.
    const weekday = weekdayIn(date, zone)
    return schedule.weekly[weekday]
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Day of week for a local date, 0 = Sunday, computed in the given zone. */
export function weekdayIn(date: LocalDate, zone: TimeZone = ASIA_DUBAI): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
  }).format(new Date(`${date}T12:00:00Z`))
  const index = (WEEKDAYS as readonly string[]).indexOf(formatted)
  if (index === -1) throw new Error(`Unrecognised weekday '${formatted}' for ${date}`)
  return index
}

export type { LocalTime }
