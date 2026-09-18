import type { Brand } from '@berelax/shared'
import { AppError } from '@berelax/shared'

/**
 * Time primitives.
 *
 * Rules encoded here, from docs/01 decisions 8 and 22:
 *   - one representation of an instant, always UTC-based
 *   - the business timezone is explicit, never assumed, even though Asia/Dubai has no DST
 *   - nothing in `packages/core` reads the clock; a `Clock` is injected
 *   - `business_day` is a first-class concept, because trading runs 11:00–02:00 and a 01:30
 *     appointment belongs to the PREVIOUS trading date
 *
 * The clock rule matters beyond tidiness: every calculation here (availability, VAT periods, leave
 * accrual, commission) must be reproducible from its inputs. A hidden `new Date()` makes a test pass
 * today and fail during Ramadan, and makes a scheduling bug impossible to reproduce.
 */

/** Milliseconds since the Unix epoch. */
export type Instant = Brand<number, 'Instant'>

/** A calendar date in the business timezone, as `YYYY-MM-DD`. Not an instant. */
export type LocalDate = Brand<string, 'LocalDate'>

/** A wall-clock time in the business timezone, as `HH:MM`. Not an instant. */
export type LocalTime = Brand<string, 'LocalTime'>

/** An IANA timezone identifier. */
export type TimeZone = Brand<string, 'TimeZone'>

export const ASIA_DUBAI = 'Asia/Dubai' as TimeZone

export interface Clock {
  now(): Instant
}

/** The only clock permitted in tests and in pure code paths. */
export function fixedClock(iso: string): Clock {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new AppError('validation', `fixedClock received an unparseable instant: ${iso}`)
  }
  return { now: () => ms as Instant }
}

export function instantFromIso(iso: string): Instant {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new AppError('validation', `Unparseable instant: ${iso}`)
  }
  return ms as Instant
}

export function instantToIso(instant: Instant): string {
  return new Date(instant).toISOString()
}

export function addMinutes(instant: Instant, minutes: number): Instant {
  if (!Number.isInteger(minutes)) {
    throw new AppError('validation', `Minutes must be an integer, received ${minutes}`)
  }
  return (instant + minutes * 60_000) as Instant
}

export function differenceInMinutes(later: Instant, earlier: Instant): number {
  return Math.round((later - earlier) / 60_000)
}

export function localDate(value: string): LocalDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('validation', `LocalDate must be YYYY-MM-DD, received "${value}"`)
  }
  return value as LocalDate
}

export function localTime(value: string): LocalTime {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new AppError('validation', `LocalTime must be HH:MM, received "${value}"`)
  }
  return value as LocalTime
}

export function minutesSinceMidnight(time: LocalTime): number {
  const [h, m] = time.split(':')
  return Number(h) * 60 + Number(m)
}

// --- timezone conversion, without a date library -----------------------------------------------
// Intl is part of the language, is deterministic, and performs no I/O, so it is permitted in core.

const partsFormatter = new Map<string, Intl.DateTimeFormat>()

function formatterFor(zone: TimeZone): Intl.DateTimeFormat {
  const existing = partsFormatter.get(zone)
  if (existing) return existing
  const created = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  partsFormatter.set(zone, created)
  return created
}

export interface LocalDateTime {
  readonly date: LocalDate
  readonly time: LocalTime
}

/** Renders an instant as wall-clock date and time in the given zone. */
export function toLocal(instant: Instant, zone: TimeZone = ASIA_DUBAI): LocalDateTime {
  const parts = formatterFor(zone).formatToParts(new Date(instant))
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '00'
  // Intl renders midnight as hour "24" in some locales; normalise it.
  const hour = get('hour') === '24' ? '00' : get('hour')
  return {
    date: localDate(`${get('year')}-${get('month')}-${get('day')}`),
    time: localTime(`${hour}:${get('minute')}`),
  }
}

/** The zone's UTC offset in minutes at the given instant. */
export function offsetMinutes(instant: Instant, zone: TimeZone = ASIA_DUBAI): number {
  const { date, time } = toLocal(instant, zone)
  const asUtc = Date.parse(`${date}T${time}:00Z`)
  return Math.round((asUtc - Math.floor(instant / 60_000) * 60_000) / 60_000)
}

/**
 * Converts wall-clock date and time in a zone to an instant.
 *
 * Two-pass: guess using the offset at the naive instant, then re-derive the offset at the guess and
 * correct. That second pass is what makes this right across a DST boundary — Asia/Dubai has none,
 * but nothing here assumes a fixed offset, because the same code will be asked about a UK entity or
 * a Ramadan-shifted schedule one day.
 */
export function fromLocal(date: LocalDate, time: LocalTime, zone: TimeZone = ASIA_DUBAI): Instant {
  const naive = Date.parse(`${date}T${time}:00Z`)
  const firstGuess = (naive - offsetMinutes(naive as Instant, zone) * 60_000) as Instant
  const corrected = (naive - offsetMinutes(firstGuess, zone) * 60_000) as Instant
  return corrected
}

// --- business day ------------------------------------------------------------------------------

export interface TradingHours {
  readonly open: LocalTime
  readonly close: LocalTime
}

/** True when the close time is at or before the open time, e.g. 11:00–02:00. */
export function crossesMidnight(hours: TradingHours): boolean {
  return minutesSinceMidnight(hours.close) <= minutesSinceMidnight(hours.open)
}

/**
 * Resolves the trading date an instant belongs to.
 *
 * With trading hours of 11:00–02:00, an appointment at 01:30 on the 2nd belongs to the **1st's**
 * business day. Everything downstream depends on this: cash-up, the rota, commission, and every
 * daily report. "Today" in the owner dashboard is a business day, not a calendar date.
 */
export function businessDayFor(
  instant: Instant,
  hours: TradingHours,
  zone: TimeZone = ASIA_DUBAI,
): LocalDate {
  const { date, time } = toLocal(instant, zone)
  if (!crossesMidnight(hours)) return date

  const minutes = minutesSinceMidnight(time)
  const closeMinutes = minutesSinceMidnight(hours.close)
  if (minutes < closeMinutes) {
    // Before close, after midnight — still the previous trading date.
    const previous = new Date(`${date}T00:00:00Z`)
    previous.setUTCDate(previous.getUTCDate() - 1)
    return localDate(previous.toISOString().slice(0, 10))
  }
  return date
}

/** The open and close instants of a business day. `close` may fall on the following calendar date. */
export function businessDayBounds(
  day: LocalDate,
  hours: TradingHours,
  zone: TimeZone = ASIA_DUBAI,
): { readonly open: Instant; readonly close: Instant } {
  const open = fromLocal(day, hours.open, zone)
  if (!crossesMidnight(hours)) {
    return { open, close: fromLocal(day, hours.close, zone) }
  }
  const next = new Date(`${day}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  const nextDay = localDate(next.toISOString().slice(0, 10))
  return { open, close: fromLocal(nextDay, hours.close, zone) }
}

/**
 * The latest instant a treatment may START and still finish, with its room turnaround, before close.
 *
 * This is why the last 120-minute slot with a 20-minute turnaround is 23:40 and not 00:00.
 */
export function latestStart(
  day: LocalDate,
  hours: TradingHours,
  durationMinutes: number,
  turnaroundMinutes: number,
  zone: TimeZone = ASIA_DUBAI,
): Instant {
  const { close } = businessDayBounds(day, hours, zone)
  return addMinutes(close, -(durationMinutes + turnaroundMinutes))
}
