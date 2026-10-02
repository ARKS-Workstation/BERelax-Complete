import type { KpiExpr, KpiInput, KpiSpec, Measure } from './kpi-expression.ts'
import { constant, differenceOf, kpiRef, measureRef, quotientOf } from './kpi-expression.ts'

/**
 * Therapist utilisation, room utilisation, and the available room-hours both of them divide by
 * (R-REP-03).
 *
 * # The denominator, which is the whole unit
 *
 * `available_room_hours = Σ_rooms (open_minutes(business_day) − closure_minutes) ÷ 60`, and the one
 * thing it must not be is a constant. Migration 0110 put `open_minutes` on `dim_date`, derived from
 * `business_day.duration_seconds`, which migration 0011 GENERATES from the day's own opening and closing
 * instants — so the chain from `premises_hours` and its dated overrides down to this figure is already
 * built, and reading it means a Ramadan schedule is a row in `premises_hours_override` plus a
 * regeneration of `business_day` and no code change anywhere. That is R-REP-01's `provisional:` note,
 * and this unit either keeps it or quietly breaks it.
 *
 * Quietly, because a hard-coded 15 hours is RIGHT today — trading runs 11:00-02:00 (Y8-hours, resolved)
 * — so no fixture would fail and no reviewer would see it. The defence is therefore not a comment:
 * {@link ROOM_OPEN_MINUTES} declares that it reads `businessDays.openMinutes`, and
 * `kpi-registry.ts`'s `measure-reads-exactly-the-fields-it-declares` replays the reducer against a
 * recording input and fails when it stops touching that field. The unit test closes the same gap from
 * the other side, with a day whose `openMinutes` disagrees with its own instants: an implementation that
 * recomputed the length would answer differently, and that input is the only one that can tell the two
 * apart.
 *
 * ## Why the Σ is split into two measures
 *
 * The acceptance line's formula sums `(open − closure)` per room. `Σ(open) − Σ(closure)` is the same
 * number, and it is the form here for a reason the per-room form would have needed anyway: two
 * `resource_block` rows may overlap — 0012 constrains each block to be non-empty, bounded and half-open
 * and does not forbid a second block over the same minutes — so the closures of one room-day have to be
 * clipped to the open window and then UNIONED before they are summed. Summing them raw would subtract
 * the overlap twice, which can drive a denominator below zero and a utilisation above 100% with nothing
 * in either figure saying why.
 *
 * ## Why a closure arrives as minutes and not as a period
 *
 * ADR 0060's rule is that a trading date comes from `business_day` and is never derived from an instant.
 * Taking `resource_block.period` here would mean subtracting instants and would put the one operation
 * that could re-derive a date into the module whose figures are keyed on one. Rebasing the block against
 * `dim_date.opens_at` is one expression in the caller's SQL, and after it there is no instant in this
 * package's reporting input at all.
 *
 * # Why the two utilisations differ by the turnaround and not by the denominator
 *
 * The room is occupied for the treatment AND the turnaround: the next client cannot be in it while it is
 * being reset, so a room utilisation that ignored turnaround would report spare capacity that does not
 * exist, and the obvious response — book into it — is the thing the figure exists to prevent. The
 * therapist is not: the reset is not their treatment time, and counting it would make a therapist look
 * fully utilised at a lower delivered-treatment load than they are. The same fixture therefore yields
 * two different figures, which is the acceptance line, and the difference is exactly the turnaround.
 *
 * `fact_appointment.therapist_buffer_minutes` is NOT in the therapist numerator either, for the same
 * reason: it is the therapist's own turnaround, and the acceptance line that excludes turnaround from
 * therapist utilisation excludes it. A buffer-inclusive therapist load is a different figure with a
 * different name, and it belongs to R-REP-04's operational set if anybody asks for it.
 *
 * # Why only a DELIVERED appointment occupies anything
 *
 * `fact_appointment` carries every status (0110), and a no-show held a room nobody used. Counting it as
 * occupancy would make the busiest-looking day the one with the most no-shows. The lost room-hours are a
 * real figure and they are R-REP-04's — its acceptance line asks for them "reported alongside as a
 * separate figure" — so counting them here as well would double-count them across the two units' KPIs.
 */

/** Minutes, as the clipped-and-merged closure of one room on one day. */
interface MinuteInterval {
  readonly from: number
  readonly to: number
}

const MINUTES_PER_HOUR = 60n

/** `roomId` and `businessDay` as one map key. NUL cannot occur in either, so the join is unambiguous. */
const roomDayKey = (roomId: string, businessDay: string): string => `${roomId}\u0000${businessDay}`

/**
 * The trading days in scope, and nothing else about them.
 *
 * Separate from {@link openMinutesByDay} so that a measure which only needs to know whether a row is in
 * the period does not READ `openMinutes` — the `reads` declarations are checked in both directions, so a
 * helper that over-read would force every caller to declare a field it has no use for and would make the
 * one declaration that matters indistinguishable from the rest.
 */
function daysInScope(input: KpiInput): ReadonlySet<string> {
  const days = new Set<string>()
  for (const day of input.businessDays) days.add(day.businessDay)
  return days
}

/** The open minutes of every day in scope. */
function openMinutesByDay(input: KpiInput): ReadonlyMap<string, number> {
  const byDay = new Map<string, number>()
  for (const day of input.businessDays) byDay.set(day.businessDay, day.openMinutes)
  return byDay
}

/**
 * The distinct (room, day) pairs in scope, with the day's open minutes.
 *
 * Distinct, because a duplicated row would otherwise add a whole room-day to the denominator. The caller
 * builds this set by crossing rooms with days and a cross can be written twice.
 */
function roomDaysInScope(input: KpiInput): ReadonlyMap<string, number> {
  const openMinutes = openMinutesByDay(input)
  const inScope = new Map<string, number>()
  for (const roomDay of input.roomDays) {
    const minutes = openMinutes.get(roomDay.businessDay)
    if (minutes === undefined) continue
    inScope.set(roomDayKey(roomDay.roomId, roomDay.businessDay), minutes)
  }
  return inScope
}

/**
 * `[from, to)` clipped to `[0, openMinutes)`, or `null` when nothing of it falls inside the window.
 *
 * A block before opening or after closing is ordinary — maintenance is scheduled when the premises is
 * shut — and it closes the room for no trading minute, so it must subtract nothing rather than a
 * negative length.
 */
function clipToOpenWindow(
  closure: { readonly from: number; readonly to: number },
  openMinutes: number,
): MinuteInterval | null {
  const from = Math.max(closure.from, 0)
  const to = Math.min(closure.to, openMinutes)
  return to > from ? { from, to } : null
}

/** The total length of the UNION of `intervals`, so an overlap is subtracted once. */
function unionLength(intervals: readonly MinuteInterval[]): number {
  const sorted = [...intervals].sort((a, b) => a.from - b.from || a.to - b.to)
  let total = 0
  let openFrom: number | null = null
  let openTo = 0
  for (const interval of sorted) {
    if (openFrom === null) {
      openFrom = interval.from
      openTo = interval.to
      continue
    }
    if (interval.from <= openTo) {
      openTo = Math.max(openTo, interval.to)
      continue
    }
    total += openTo - openFrom
    openFrom = interval.from
    openTo = interval.to
  }
  if (openFrom !== null) total += openTo - openFrom
  return total
}

// --- the measures --------------------------------------------------------------------------------

/**
 * `Σ over every (room, trading day) in scope of that day's dim_date.open_minutes`.
 *
 * The declared reads are what make "the denominator reads `dim_date.open_minutes`" checkable rather than
 * claimed. See this module's header.
 */
export const ROOM_OPEN_MINUTES: Measure = {
  id: 'room_open_minutes',
  summary:
    'Room-minutes the premises was open for: the sum, over every (room, trading day) the room was in ' +
    "service for, of that trading day's dim_date.open_minutes. Never a constant: open_minutes derives " +
    'from business_day, which derives from premises_hours and its dated overrides.',
  unit: 'minutes',
  reads: [
    'businessDays.businessDay',
    'businessDays.openMinutes',
    'roomDays.businessDay',
    'roomDays.roomId',
  ],
  reduce: (input) => {
    let total = 0n
    for (const minutes of roomDaysInScope(input).values()) total += BigInt(minutes)
    return total
  },
}

/**
 * `Σ over every (room, trading day) in scope of the union of that room-day's closures, clipped to the
 * open window`.
 *
 * A closure of a room that was not in service, or on a day not in scope, subtracts nothing: it would
 * otherwise reduce a denominator that never included the room-day in the first place, and
 * `available_room_minutes` could go negative.
 */
export const ROOM_CLOSURE_MINUTES: Measure = {
  id: 'room_closure_minutes',
  summary:
    'Room-minutes lost to closures inside trading hours: per (room, trading day), the closures clipped ' +
    "to that day's open window and UNIONED, then summed. Two overlapping resource_block rows close the " +
    'room once, not twice.',
  unit: 'minutes',
  reads: [
    'businessDays.businessDay',
    'businessDays.openMinutes',
    'roomDays.businessDay',
    'roomDays.roomId',
    'roomClosures.businessDay',
    'roomClosures.roomId',
    'roomClosures.fromMinuteAfterOpen',
    'roomClosures.toMinuteAfterOpen',
  ],
  reduce: (input) => {
    const inScope = roomDaysInScope(input)
    const byRoomDay = new Map<string, MinuteInterval[]>()
    for (const closure of input.roomClosures) {
      const key = roomDayKey(closure.roomId, closure.businessDay)
      const openMinutes = inScope.get(key)
      if (openMinutes === undefined) continue
      const clipped = clipToOpenWindow(
        { from: closure.fromMinuteAfterOpen, to: closure.toMinuteAfterOpen },
        openMinutes,
      )
      if (clipped === null) continue
      const existing = byRoomDay.get(key)
      if (existing === undefined) byRoomDay.set(key, [clipped])
      else existing.push(clipped)
    }
    let total = 0n
    for (const intervals of byRoomDay.values()) total += BigInt(unionLength(intervals))
    return total
  },
}

/** `Σ over delivered appointments holding a room of (treatment_minutes + turnaround_minutes)`. */
export const ROOM_OCCUPIED_MINUTES: Measure = {
  id: 'room_occupied_minutes',
  summary:
    'Room-minutes a delivered appointment occupied, INCLUDING its turnaround: the next client cannot ' +
    'be in the room while it is being reset. An appointment holding no room occupies nothing, and a ' +
    "no-show is not occupancy — its lost room-hours are R-REP-04's own figure.",
  unit: 'minutes',
  reads: [
    'businessDays.businessDay',
    'appointments.businessDay',
    'appointments.roomId',
    'appointments.isDelivered',
    'appointments.treatmentMinutes',
    'appointments.turnaroundMinutes',
  ],
  reduce: (input) => {
    const days = daysInScope(input)
    let total = 0n
    for (const appointment of input.appointments) {
      if (!days.has(appointment.businessDay)) continue
      if (appointment.roomId === null || !appointment.isDelivered) continue
      total += BigInt(appointment.treatmentMinutes) + BigInt(appointment.turnaroundMinutes)
    }
    return total
  },
}

/** `Σ over delivered appointments with a therapist of treatment_minutes`, turnaround EXCLUDED. */
export const THERAPIST_TREATMENT_MINUTES: Measure = {
  id: 'therapist_treatment_minutes',
  summary:
    'Minutes a therapist spent delivering treatment, EXCLUDING turnaround and the therapist buffer: ' +
    'resetting a room is not treatment time, and counting it would make a therapist read as fully ' +
    'utilised at a lower delivered load than they are.',
  unit: 'minutes',
  reads: [
    'businessDays.businessDay',
    'appointments.businessDay',
    'appointments.employeeId',
    'appointments.isDelivered',
    'appointments.treatmentMinutes',
  ],
  reduce: (input) => {
    const days = daysInScope(input)
    let total = 0n
    for (const appointment of input.appointments) {
      if (!days.has(appointment.businessDay)) continue
      if (appointment.employeeId === null || !appointment.isDelivered) continue
      total += BigInt(appointment.treatmentMinutes)
    }
    return total
  },
}

/** `Σ over shift assignments in scope of rostered_minutes` — one row per employee per shift. */
export const THERAPIST_ROSTERED_MINUTES: Measure = {
  id: 'therapist_rostered_minutes',
  summary:
    'Minutes therapists were rostered for, summed over fact_shift, whose grain is one row per employee ' +
    'per shift. A shift with nobody on it has no row and contributes nothing, which is the right answer ' +
    'for a per-person denominator and the wrong one for "how many shifts were there".',
  unit: 'minutes',
  reads: [
    'businessDays.businessDay',
    'rosteredShifts.businessDay',
    'rosteredShifts.rosteredMinutes',
  ],
  reduce: (input) => {
    const days = daysInScope(input)
    let total = 0n
    for (const shift of input.rosteredShifts) {
      if (!days.has(shift.businessDay)) continue
      total += BigInt(shift.rosteredMinutes)
    }
    return total
  },
}

export const UTILISATION_MEASURES: readonly Measure[] = [
  ROOM_OPEN_MINUTES,
  ROOM_CLOSURE_MINUTES,
  ROOM_OCCUPIED_MINUTES,
  THERAPIST_TREATMENT_MINUTES,
  THERAPIST_ROSTERED_MINUTES,
]

// --- the KPIs ------------------------------------------------------------------------------------

/** `room_open_minutes − room_closure_minutes`, the denominator both room figures share. */
export const AVAILABLE_ROOM_MINUTES_EXPR: KpiExpr = differenceOf(
  measureRef(ROOM_OPEN_MINUTES.id),
  measureRef(ROOM_CLOSURE_MINUTES.id),
)

export const AVAILABLE_ROOM_MINUTES: KpiSpec = {
  id: 'available_room_minutes',
  label: 'Available room-minutes',
  summary:
    'Room-minutes the premises could have sold: open minutes per room-day, less the closures inside ' +
    'them. Non-negative by construction — a closure is clipped to the open window and overlapping ' +
    'closures are unioned — so no utilisation built on it can exceed 100% for an arithmetic reason.',
  unit: 'minutes',
  expression: AVAILABLE_ROOM_MINUTES_EXPR,
  provisional: null,
}

export const AVAILABLE_ROOM_HOURS: KpiSpec = {
  id: 'available_room_hours',
  label: 'Available room-hours',
  summary:
    "The acceptance line's denominator: Σ_rooms (open_minutes(business_day) − closure_minutes) ÷ 60. " +
    'Five rooms on a 15-hour trading day are 75.0; the same day with a two-hour closure of one room is ' +
    '73.0. The hours come from dim_date and never from a constant.',
  unit: 'hours',
  expression: quotientOf(kpiRef(AVAILABLE_ROOM_MINUTES.id), constant(MINUTES_PER_HOUR)),
  provisional: null,
}

export const ROOM_UTILISATION: KpiSpec = {
  id: 'room_utilisation',
  label: 'Room utilisation',
  summary:
    'The share of available room-minutes a delivered appointment occupied, INCLUDING its turnaround. ' +
    'Higher than therapist utilisation on the same fixture by exactly the turnaround minutes.',
  unit: 'ratio',
  expression: quotientOf(measureRef(ROOM_OCCUPIED_MINUTES.id), kpiRef(AVAILABLE_ROOM_MINUTES.id)),
  provisional: null,
}

export const THERAPIST_UTILISATION: KpiSpec = {
  id: 'therapist_utilisation',
  label: 'Therapist utilisation',
  summary:
    'The share of rostered minutes spent delivering treatment, EXCLUDING turnaround and the therapist ' +
    'buffer. Its denominator is the roster and not the trading window: a therapist rostered for half a ' +
    'day is not idle for the other half.',
  unit: 'ratio',
  expression: quotientOf(
    measureRef(THERAPIST_TREATMENT_MINUTES.id),
    measureRef(THERAPIST_ROSTERED_MINUTES.id),
  ),
  provisional: null,
}

export const UTILISATION_KPIS: readonly KpiSpec[] = [
  AVAILABLE_ROOM_MINUTES,
  AVAILABLE_ROOM_HOURS,
  ROOM_UTILISATION,
  THERAPIST_UTILISATION,
]
