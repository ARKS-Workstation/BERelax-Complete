/**
 * Trading windows for a date, net of closures.
 *
 * A trading date is usually one window — 11:00 to 02:00. It stops being one the moment anything is
 * subtracted from it, and things are subtracted from it regularly: a maintenance slot, a staff
 * meeting, a lunar public holiday announced four days out.
 *
 * So availability is computed against **a list of windows**, never against an open and a close. A
 * scheduler written for one interval per day works until the first afternoon somebody shuts for two
 * hours, and then it offers slots during the closure — which is the kind of bug that produces a
 * customer standing outside a locked door.
 *
 * Pure: instants in, instants out, no clock and no database.
 */
import type { Instant, LocalDate, TimeZone, TradingHours } from '../time.ts'
import { ASIA_DUBAI, addMinutes } from '../time.ts'
import { tradingBounds } from './resolve.ts'

export interface TradingWindow {
  readonly startsAt: Instant
  readonly endsAt: Instant
}

/** A period the premises is shut, as instants. Produced from `premises_closure` rows. */
export interface ClosedInterval {
  readonly startsAt: Instant
  readonly endsAt: Instant
  readonly reason: string
}

/** Minutes in a window. Useful for capacity reporting, and for asserting a window is worth offering. */
export function windowMinutes(window: TradingWindow): number {
  return (window.endsAt - window.startsAt) / 60_000
}

/**
 * Subtracts closures from a date's trading window.
 *
 * Returns zero windows for a full-day closure, one for an uninterrupted day, and two for a closure
 * that falls strictly inside the session. Windows come back in chronological order and never touch,
 * so a caller can walk them without checking for adjacency.
 *
 * A window shorter than `minimumMinutes` is dropped rather than returned. Eleven minutes between two
 * closures is not bookable time — the shortest treatment is forty-five — and returning it makes every
 * downstream consumer filter it out again, or forget to.
 */
export function tradingWindowsFor(args: {
  readonly date: LocalDate
  readonly hours: TradingHours | undefined
  readonly closures: readonly ClosedInterval[]
  readonly zone?: TimeZone
  readonly minimumMinutes?: number
}): TradingWindow[] {
  const { date, hours, closures, zone = ASIA_DUBAI, minimumMinutes = 1 } = args
  if (hours === undefined) return []

  const { opensAt, closesAt } = tradingBounds(date, hours, zone)
  let windows: TradingWindow[] = [{ startsAt: opensAt, endsAt: closesAt }]

  // Sorting first is not cosmetic: overlapping closures applied in arbitrary order can split a window
  // into fragments that a later closure then splits again, and the result depends on input order.
  const ordered = [...closures].sort((a, b) => a.startsAt - b.startsAt || a.endsAt - b.endsAt)

  for (const closure of ordered) {
    const next: TradingWindow[] = []
    for (const window of windows) {
      // No overlap: the window survives whole.
      if (closure.endsAt <= window.startsAt || closure.startsAt >= window.endsAt) {
        next.push(window)
        continue
      }
      // Leading fragment, if the closure starts after the window does.
      if (closure.startsAt > window.startsAt) {
        next.push({ startsAt: window.startsAt, endsAt: closure.startsAt })
      }
      // Trailing fragment, if the closure ends before the window does.
      if (closure.endsAt < window.endsAt) {
        next.push({ startsAt: closure.endsAt, endsAt: window.endsAt })
      }
    }
    windows = next
  }

  return windows.filter((window) => windowMinutes(window) >= minimumMinutes)
}

/** True when the instant falls inside one of the windows. Half-open, as everywhere else. */
export function isWithinWindows(instant: Instant, windows: readonly TradingWindow[]): boolean {
  return windows.some((window) => instant >= window.startsAt && instant < window.endsAt)
}

/**
 * The latest instant a treatment may start in a window and still finish, with its turnaround, before
 * the window closes.
 *
 * This is why the last 120-minute slot with a 20-minute turnaround starts at 23:40 rather than at
 * midnight, and why a two-hour treatment is simply unavailable in a ninety-minute window.
 */
export function latestStartIn(
  window: TradingWindow,
  durationMinutes: number,
  turnaroundMinutes: number,
): Instant | undefined {
  const latest = addMinutes(window.endsAt, -(durationMinutes + turnaroundMinutes))
  return latest >= window.startsAt ? latest : undefined
}

/** Total bookable minutes across a date's windows, for capacity reporting. */
export function totalTradingMinutes(windows: readonly TradingWindow[]): number {
  return windows.reduce((total, window) => total + windowMinutes(window), 0)
}
