/**
 * Dated hours overrides: what a Ramadan schedule does to the hours, and what it may not do to a booking.
 *
 * `premises_hours_override` (migration 0011) replaces `premises_hours` for a date range. That shape is
 * deliberate and this module does not invent a second one — 0011's own comment says why a Ramadan row is
 * DATA: "without this it is a migration, which is not something to run under time pressure during
 * Ramadan". `packages/fixtures/src/cash-forecast.itest.ts` already proves the reporting half of the chain
 * — a row here moves `business_day.duration_seconds`, which moves `dim_date.open_minutes`, which moves
 * the seasonality index, with no code change anywhere. What was missing is the two things the BOOKING
 * side needs:
 *
 *   1. **The hours lookup the availability engine reads**, so the last bookable start on an override date
 *      is computed from the override rather than from the weekly pattern. {@link hoursWithOverrides}
 *      produces a `HoursForDate`, which is the one interface `solveAvailability`, `resolveTradingDate`
 *      and `tradingWindowsFor` all take — so nothing downstream learns that overrides exist.
 *   2. **The refusal.** Narrowing the hours over a date somebody has already been booked on does not
 *      cancel the booking; it produces a customer standing outside a locked door, which is the failure
 *      `windows.ts` was written not to have one subject along.
 *      {@link hoursOverrideStrandedAppointments} is what the save path reports and refuses on.
 *
 * ## Why the stranding test is the ROOM period and not the treatment
 *
 * An appointment holds its room for **its own** turnaround after the treatment ends (0038, and
 * `solve.ts`'s `ScheduledAppointment` carries the figure for that reason). A treatment finishing at 01:55
 * with a 20-minute turnaround needs the premises open until 02:15. Comparing the treatment alone would
 * accept an override that sent the last customer out through a locked door with the room still dirty —
 * and the acceptance line is about appointments "outside trading hours", which is the interval the
 * premises is actually occupied for.
 *
 * The therapist buffer is deliberately NOT included. A buffer is the therapist's own recovery window and
 * is not premises occupancy: an override that clipped it would refuse a booking the salon can keep, which
 * is the error that produces a workaround rather than a correction.
 *
 * ## This module is stated TWICE, and the check that holds the two equal ships with it
 *
 * `holiday_override_stranded_appointments(...)` in migration 0123 is the same rule in SQL, because the
 * database has to be able to refuse the write (ZY294) and SQL cannot read TypeScript. That is 0117's
 * `is_card_shaped` / `cardShapedRuns` arrangement, and the drift it guards is the dangerous direction: a
 * database still accepting what the availability engine had started refusing, so a test asserting the
 * refusal would be satisfied by the wrong layer. `packages/fixtures/src/holiday-hours-agreement.itest.ts`
 * drives one probe set — stated once, in that file — through both and requires identical verdicts.
 *
 * Pure: dates and instants in, instants and ids out. No clock, no database, and the zone is an argument.
 */
import { AppError } from '@berelax/shared'
import { type HoursForDate, nextDate, weekdayIn } from '../business-day/resolve.ts'
import { type ClosedInterval, latestStartIn, tradingWindowsFor } from '../business-day/windows.ts'
import {
  ASIA_DUBAI,
  addMinutes,
  fromLocal,
  type Instant,
  type LocalDate,
  localDate,
  minutesSinceMidnight,
  type TimeZone,
  type TradingHours,
} from '../time.ts'

/**
 * One `premises_hours_override` row, reduced to what the hours need.
 *
 * `dayOfWeek` is `premises_hours_override.day_of_week`: null means every date in the range, and a number
 * means only that weekday inside it (0 = Sunday, matching `premises_hours`). A Ramadan row is the null
 * case; "Fridays open at 14:00 through March" is the other.
 */
export interface DatedHoursOverride {
  readonly startsOn: LocalDate
  readonly endsOn: LocalDate
  readonly dayOfWeek: number | null
  readonly hours: TradingHours
  /** `premises_hours_override.reason`, carried so a refusal can name the row a reader would look for. */
  readonly reason: string
}

/** The weekly pattern plus its dated overrides and the dates the premises does not open at all. */
export interface OverriddenHoursSchedule {
  /** Index 0 is Sunday, matching `premises_hours.day_of_week`. `undefined` is a closed weekday. */
  readonly weekly: readonly (TradingHours | undefined)[]
  readonly overrides: readonly DatedHoursOverride[]
  /** Dates the premises does not open at all — `premises_closure` over a whole date. */
  readonly closedDates?: readonly LocalDate[]
}

function assertRangeOrdered(override: DatedHoursOverride): void {
  if (override.endsOn < override.startsOn) {
    throw new AppError(
      'validation',
      `An hours override from ${override.startsOn} to ${override.endsOn} ends before it starts; ` +
        '0011 refuses the row.',
    )
  }
}

/** True when `date` falls inside the override's range and on a weekday it applies to. */
export function hoursOverrideCoversDate(
  override: DatedHoursOverride,
  date: LocalDate,
  zone: TimeZone = ASIA_DUBAI,
): boolean {
  assertRangeOrdered(override)
  if (date < override.startsOn || date > override.endsOn) return false
  if (override.dayOfWeek === null) return true
  return weekdayIn(date, zone) === override.dayOfWeek
}

/**
 * The hours lookup the availability engine reads, with dated overrides applied.
 *
 * **The LAST applicable override wins**, and that is a decision rather than an accident of iteration
 * order: 0011 puts no exclusion constraint on `premises_hours_override`, so two rows may cover one date,
 * and "the first one found" depends on the order a reader happened to sort by. The rule here is the one
 * a reader can state — the row that comes latest in the list the caller supplied — and the repository
 * supplies them ordered by `starts_on`, so a narrower row entered later for the same range governs.
 *
 * A closed date beats everything, including an override: `premises_closure` over a whole date means the
 * premises is SHUT, and hours for a date nobody opens on would put a trading window on it.
 */
export function hoursWithOverrides(
  schedule: OverriddenHoursSchedule,
  zone: TimeZone = ASIA_DUBAI,
): HoursForDate {
  for (const override of schedule.overrides) assertRangeOrdered(override)
  const closed = new Set<string>(schedule.closedDates ?? [])
  return (date: LocalDate): TradingHours | undefined => {
    if (closed.has(date)) return undefined
    let chosen: TradingHours | undefined
    for (const override of schedule.overrides) {
      if (hoursOverrideCoversDate(override, date, zone)) chosen = override.hours
    }
    if (chosen !== undefined) return chosen
    // `Intl` in the business zone rather than the process zone, for `hoursFromSchedule`'s reason: a
    // date's weekday is a local fact and `new Date(date).getDay()` answers it wherever the machine is.
    return schedule.weekly[weekdayIn(date, zone)]
  }
}

/**
 * The latest start a treatment of this length may take on `date`, net of closures, or `undefined`.
 *
 * Delegates to `tradingWindowsFor` and `latestStartIn` rather than restating either: those two already
 * carry the acceptance figures B-AVAIL-02 pinned to the minute (23:40 for 120+20 on an 11:00–02:00 day),
 * and a second arithmetic here would be a second opinion about the same boundary. What this adds is the
 * one thing they do not do — reading the hours through a lookup that honours the override.
 *
 * The LAST window of the date and not the first: a closure splitting the session leaves two windows, and
 * the last bookable start of the DATE is in the later one. `undefined` means no window on the date is
 * long enough, which is the honest answer for a 120-minute treatment in a reduced window — not a start
 * that would run past close.
 */
export function lastBookableStart(args: {
  readonly date: LocalDate
  readonly hoursFor: HoursForDate
  readonly closures: readonly ClosedInterval[]
  readonly durationMinutes: number
  readonly turnaroundMinutes: number
  readonly zone?: TimeZone
}): Instant | undefined {
  const { date, hoursFor, closures, durationMinutes, turnaroundMinutes, zone = ASIA_DUBAI } = args
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new AppError(
      'validation',
      `A treatment is a whole number of minutes above zero, got ${durationMinutes}`,
    )
  }
  if (!Number.isInteger(turnaroundMinutes) || turnaroundMinutes < 0) {
    throw new AppError(
      'validation',
      `A turnaround is a whole number of minutes, got ${turnaroundMinutes}`,
    )
  }
  const windows = tradingWindowsFor({ date, hours: hoursFor(date), closures, zone })
  let latest: Instant | undefined
  for (const window of windows) {
    const candidate = latestStartIn(window, durationMinutes, turnaroundMinutes)
    if (candidate !== undefined && (latest === undefined || candidate > latest)) latest = candidate
  }
  return latest
}

/** An appointment as the stranding test reads it: the treatment, and the room's own turnaround. */
export interface BookedAppointmentPeriod {
  readonly appointmentId: string
  /** `appointment.trading_date`, never re-derived from the period (`working-hours.ts`'s rule 2). */
  readonly tradingDate: LocalDate
  readonly startsAt: Instant
  readonly endsAt: Instant
  readonly turnaroundMinutes: number
}

/** One appointment an override would leave outside trading hours, and which side it falls off. */
export interface StrandedAppointment {
  readonly appointmentId: string
  readonly tradingDate: LocalDate
  /** `before_opening` when the treatment starts before the new open; `after_closing` otherwise. */
  readonly reason: 'before_opening' | 'after_closing'
}

/** The open and close instants a trading date would have under `hours`. */
function boundsUnder(
  date: LocalDate,
  hours: TradingHours,
  zone: TimeZone,
): Readonly<{
  opensAt: Instant
  closesAt: Instant
}> {
  const opensAt = fromLocal(date, hours.open, zone)
  // `<=` and not `<`: 0011 generates `crosses_midnight` as `close_time <= open_time`, so an override of
  // 14:00–14:00 is a 24-hour day there and would be a zero-length one here. Two readings of the same
  // column is exactly the drift this module's agreement suite exists to refuse.
  const closesAt =
    minutesSinceMidnight(hours.close) <= minutesSinceMidnight(hours.open)
      ? fromLocal(nextDate(date), hours.close, zone)
      : fromLocal(date, hours.close, zone)
  return { opensAt, closesAt }
}

/**
 * The appointments an override would leave outside trading hours, room turnaround included.
 *
 * Ordered by trading date then appointment id, so the report is the same list on every run — which is
 * what makes the refusal's message and the agreement suite's comparison stable.
 *
 * Only the dates the override actually covers are considered: an appointment on a date inside the range
 * but on a weekday the override does not apply to keeps the weekly hours and is not affected. Getting
 * that wrong would refuse a Ramadan Friday override because of a Tuesday booking.
 */
export function hoursOverrideStrandedAppointments(args: {
  readonly override: DatedHoursOverride
  readonly appointments: readonly BookedAppointmentPeriod[]
  readonly zone?: TimeZone
}): readonly StrandedAppointment[] {
  const { override, appointments, zone = ASIA_DUBAI } = args
  assertRangeOrdered(override)
  const stranded: StrandedAppointment[] = []
  for (const appointment of appointments) {
    if (!hoursOverrideCoversDate(override, appointment.tradingDate, zone)) continue
    const { opensAt, closesAt } = boundsUnder(appointment.tradingDate, override.hours, zone)
    if (appointment.startsAt < opensAt) {
      stranded.push({
        appointmentId: appointment.appointmentId,
        tradingDate: appointment.tradingDate,
        reason: 'before_opening',
      })
      continue
    }
    // Half-open on the opening side, INCLUSIVE on the closing side: a treatment plus its turnaround may
    // end exactly at close (`solve.worked.test.ts` pins the last room period at 02:00) and nothing may
    // start there. An exclusive comparison here would strand the last booking of every single day.
    if (addMinutes(appointment.endsAt, appointment.turnaroundMinutes) > closesAt) {
      stranded.push({
        appointmentId: appointment.appointmentId,
        tradingDate: appointment.tradingDate,
        reason: 'after_closing',
      })
    }
  }
  return stranded.sort(
    (a, b) =>
      (a.tradingDate < b.tradingDate ? -1 : a.tradingDate > b.tradingDate ? 1 : 0) ||
      (a.appointmentId < b.appointmentId ? -1 : a.appointmentId > b.appointmentId ? 1 : 0),
  )
}

/** Every date an override covers, ascending. Useful for asserting the window's first and last date. */
export function hoursOverrideDates(
  override: DatedHoursOverride,
  zone: TimeZone = ASIA_DUBAI,
): readonly LocalDate[] {
  assertRangeOrdered(override)
  const dates: LocalDate[] = []
  for (
    let date: LocalDate = override.startsOn;
    date <= override.endsOn;
    date = nextDate(localDate(date))
  ) {
    if (hoursOverrideCoversDate(override, date, zone)) dates.push(date)
  }
  return dates
}
