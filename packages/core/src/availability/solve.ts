/**
 * The availability solver. Given a trading date and everything that occupies it, which starts are
 * offerable.
 *
 * This is the function the public booking flow, the admin calendar and the reminder scheduler are all
 * queries against, so every constraint in it is a rule the business is actually run by:
 *
 *  1. **The trading window.** Slots exist only inside the date's windows, net of closures, and the
 *     treatment *plus its room turnaround* must finish before the window closes. `business-day/`
 *     produces those windows; nothing here re-derives a trading date or an opening time.
 *  2. **Duration plus turnaround** occupies the room; **the buffer either side** occupies the
 *     therapist. Two resources, two intervals, never one (see `intervals.ts`).
 *  3. **Minimum lead.** A start must be at least `minLeadMinutes` after `now`, inclusive of the
 *     boundary: with a two-hour lead, `now + 2h` is bookable and `now + 2h - 1min` is not.
 *  4. **Maximum advance**, counted in trading dates rather than in hours — see `withinAdvance`.
 *
 * ## Nothing is materialised
 *
 * There is no slot table and there is no availability cache: a slot is a **computed answer**, not a
 * row. Every acceptance figure in this module is arithmetic over injected data, which is what makes
 * "the wet room is under maintenance on Thursday" take effect the moment the block is written rather
 * than the next time a generator runs. `scripts/check-schema-conventions.mjs` enforces the absence
 * with the rule `no-precomputed-slot-table`, and `scripts/test-gates.mjs` proves that rule fires.
 *
 * ## Pure, and therefore "now" is an argument
 *
 * `packages/core` reads no clock (`pnpm purity`). That is not tidiness: the lead and advance
 * boundaries are exact to the minute, and the only honest way to assert an exact boundary is a frozen
 * instant passed in. Shifts, appointments, blocks, closures and the day's hours are injected for the
 * same reason — `packages/db` reads them, this module decides.
 *
 * ## What this unit deliberately does not do
 *
 * It answers *whether a start is offerable at all*, along with the rooms and therapists that are free
 * for it. Choosing a concrete `(therapists[], room)` tuple for the two-therapist shapes — Four Hands,
 * Couple Massage — is B-AVAIL-03, which consumes `availableRoomIds` and `availableTherapistIds`.
 * Narrowing the therapist list by skill, gender, leave and credential expiry is B-AVAIL-04 and
 * B-AVAIL-05: they hand this function a list that is already eligible, which is why there is no
 * therapist-attribute logic here to disagree with theirs.
 */
import { AppError } from '@berelax/shared'
import { type HoursForDate, resolveTradingDate } from '../business-day/resolve.ts'
import {
  type ClosedInterval,
  type TradingWindow,
  tradingWindowsFor,
} from '../business-day/windows.ts'
import {
  ASIA_DUBAI,
  addMinutes,
  differenceInMinutes,
  type Instant,
  type LocalDate,
  type TimeZone,
} from '../time.ts'
import {
  candidateStarts,
  coveredWithoutGap,
  overlapsAny,
  roomOccupancy,
  therapistOccupancy,
  treatmentPeriod,
} from './intervals.ts'
import {
  bookableRoomsFor,
  type Period,
  type ResourceBlock,
  type Room,
  type RoomType,
} from './room-predicates.ts'

/**
 * The grid a customer is offered, in minutes, when the caller does not say.
 *
 * A quarter hour is the booking grid the front desk works in. It is a *policy*, not a constraint, and
 * it is explicit because it decides which exact starts appear: the latest bookable start for a
 * 120-minute treatment with a 20-minute turnaround on an 11:00–02:00 day is 23:40, and 23:40 is not
 * on a quarter-hour grid measured from 11:00 — so on this default the last offered start is 23:30.
 */
export const DEFAULT_SLOT_STEP_MINUTES = 15

/**
 * A therapist's rostered presence. One row per shift; two abutting rows are one presence.
 *
 * Therapists are identified by id and never by name — a therapist has no display name until an admin
 * sets one, and this module has no business inventing one.
 */
export interface TherapistShift {
  readonly therapistId: string
  readonly period: Period
}

/**
 * An appointment that already exists, with **its own** turnaround and buffer.
 *
 * Not the candidate's: both figures are snapshotted onto the appointment when it is booked, so a
 * Morocco Bath booked yesterday still holds its wet room for 30 minutes after the owner reduces the
 * standard turnaround to 15 today. Reading the current setting for an existing appointment would move
 * a room's occupancy retroactively, and the first sign of it would be a double booking.
 */
export interface ScheduledAppointment {
  readonly id: string
  readonly roomId: string
  /**
   * The therapists this record holds. **One id per `appointment` row** as the repository reads them.
   *
   * It used to say "two for Four Hands and Couple Massage", and that invitation to merge the rows of
   * one delivery into a single record was half of a real defect: room places were counted in records,
   * so a merged two-therapist delivery reported one place where the database counted two. Merging is
   * now harmless — {@link delivery} is what the place count groups by — but a record is still a row,
   * because each row blocks its own therapist over the same period and that is what
   * `therapistsFreeFor` asks.
   */
  readonly therapistIds: readonly string[]
  /**
   * The delivery this record belongs to, and the client places it occupies in the room.
   *
   * Absent means *this record is its own delivery of one client*, which is the reading every caller
   * had before deliveries existed and the **stricter** one: it can only ever over-count a room's
   * committed places, and over-counting refuses a booking the database would have taken, where
   * under-counting offers one it refuses at COMMIT. Present, it mirrors `appointment.delivery_id` and
   * `appointment.room_places` (0038): two therapists over one client is one delivery of one place.
   *
   * One optional object rather than two optional fields, so a caller cannot supply a grouping without
   * the footprint that grouping is counted at.
   */
  readonly delivery?: { readonly id: string; readonly places: number }
  /** The treatment itself. Occupancy is derived from it, never stored alongside it. */
  readonly treatment: Period
  readonly turnaroundMinutes: number
  readonly therapistBufferMinutes: number
}

/** Everything the solver needs. All of it injected; none of it read. */
export interface SlotRequest {
  /** The frozen instant the query is made at. Lead time is measured from this and nothing else. */
  readonly now: Instant
  /** The trading date being solved. 01:30 belongs to the previous one (`resolveTradingDate`). */
  readonly tradingDate: LocalDate
  /** The date's hours, as a lookup, so `now`'s own trading date can be resolved with the same rules. */
  readonly hoursFor: HoursForDate
  readonly closures: readonly ClosedInterval[]
  readonly durationMinutes: number
  /** Minutes the ROOM is held after the treatment (`service.turnaround_minutes`). */
  readonly turnaroundMinutes: number
  /** Minutes the THERAPIST is held either side (`service_resource_shape.therapist_buffer_minutes`). */
  readonly therapistBufferMinutes: number
  /** `booking.min_lead_minutes`. Provisionally 120 (Y9-lead). */
  readonly minLeadMinutes: number
  /** `booking.max_advance_days`, counted in trading dates. Provisionally 90 (Y9-lead). */
  readonly maxAdvanceDays: number
  readonly rooms: readonly Room[]
  /** The service's `service_room_type_compat` rows. Empty means no room, never "any room". */
  readonly compatibleRoomTypes: readonly RoomType[]
  /** Clients in the room at once: 1 for solo and Four Hands, 2 for Couple Massage. */
  readonly clients?: number
  /** Therapists already narrowed to the eligible ones by B-AVAIL-04 / B-AVAIL-05. */
  readonly therapistIds: readonly string[]
  readonly shifts: readonly TherapistShift[]
  readonly appointments: readonly ScheduledAppointment[]
  readonly blocks: readonly ResourceBlock[]
  readonly stepMinutes?: number
  readonly zone?: TimeZone
}

/**
 * Why an otherwise well-formed start is not offered.
 *
 * Named, for the same reason `resolveTradingDate` names its reasons: "no availability" is the answer
 * the front desk cannot act on, and the useful sentence is "the wet room is blocked until Thursday"
 * or "we need two hours' notice". Starts that do not *fit* the window at all are absent rather than
 * rejected — they were never candidates.
 */
export type SlotRejection =
  | 'beyond_maximum_advance'
  | 'before_minimum_lead'
  | 'no_room_available'
  | 'no_therapist_available'

export interface RejectedStart {
  readonly startsAt: Instant
  readonly reason: SlotRejection
}

/** An offerable start, with both occupancy intervals and the resources that are free for it. */
export interface CandidateSlot {
  readonly startsAt: Instant
  /** `[start, start + duration)`. */
  readonly treatment: Period
  /** `[start, end + turnaround)` — the room. */
  readonly roomPeriod: Period
  /** `[start - buffer, end + buffer)` — the therapist. */
  readonly therapistPeriod: Period
  /** Non-empty by construction: a slot with no free room is not a slot. */
  readonly availableRoomIds: readonly string[]
  /** Non-empty by construction. B-AVAIL-03 picks from these; it never widens them. */
  readonly availableTherapistIds: readonly string[]
}

export interface SlotSolution {
  readonly slots: readonly CandidateSlot[]
  readonly rejected: readonly RejectedStart[]
  /** The date's windows, net of closures, so a caller can explain a gap without recomputing it. */
  readonly windows: readonly TradingWindow[]
}

/** The room interval of an existing appointment: its treatment plus **its** turnaround. */
export function appointmentRoomPeriod(appointment: ScheduledAppointment): Period {
  return roomOccupancy({
    startsAt: appointment.treatment.startsAt,
    durationMinutes: differenceInMinutes(
      appointment.treatment.endsAt,
      appointment.treatment.startsAt,
    ),
    turnaroundMinutes: appointment.turnaroundMinutes,
  })
}

/** The therapist interval of an existing appointment: its treatment plus **its** buffer, both sides. */
export function appointmentTherapistPeriod(appointment: ScheduledAppointment): Period {
  return therapistOccupancy({
    startsAt: appointment.treatment.startsAt,
    durationMinutes: differenceInMinutes(
      appointment.treatment.endsAt,
      appointment.treatment.startsAt,
    ),
    bufferMinutes: appointment.therapistBufferMinutes,
  })
}

/**
 * The rooms that can take the booking over `period`.
 *
 * Compatibility, capacity, decommissioning and blocks are `bookableRoomsFor`'s (B-CAT-02) — re-deriving
 * overlap here would give the availability engine a second opinion about what "busy" means, and the
 * two would drift at the boundary minute. What is added is the appointments, because a room is also
 * busy for another booking's turnaround.
 */
export function roomsFreeFor(args: {
  readonly rooms: readonly Room[]
  readonly compatibleRoomTypes: readonly RoomType[]
  readonly period: Period
  readonly blocks: readonly ResourceBlock[]
  readonly appointments: readonly ScheduledAppointment[]
  readonly clients?: number
}): Room[] {
  const { rooms, compatibleRoomTypes, period, blocks, appointments, clients = 1 } = args
  return bookableRoomsFor({ rooms, compatibleRoomTypes, period, blocks, clients }).filter(
    (room) => {
      const occupied = appointments
        .filter((appointment) => appointment.roomId === room.id)
        .map(appointmentRoomPeriod)
      return !overlapsAny(period, occupied)
    },
  )
}

/**
 * The therapists free for `period`, which is already the buffered interval.
 *
 * Two conditions, and the second is the one that is easy to get wrong. The therapist must be on shift
 * for the **whole** interval — "a shift overlaps it" would send a therapist home at 22:00 in the
 * middle of a treatment that started at 21:00 — and must have no other appointment overlapping it,
 * counted with *that* appointment's own buffer.
 */
export function therapistsFreeFor(args: {
  readonly therapistIds: readonly string[]
  readonly period: Period
  readonly shifts: readonly TherapistShift[]
  readonly appointments: readonly ScheduledAppointment[]
}): string[] {
  const { therapistIds, period, shifts, appointments } = args
  return therapistIds.filter((therapistId) => {
    const rostered = shifts
      .filter((shift) => shift.therapistId === therapistId)
      .map((shift) => shift.period)
    if (!coveredWithoutGap(period, rostered)) return false
    const busy = appointments
      .filter((appointment) => appointment.therapistIds.includes(therapistId))
      .map(appointmentTherapistPeriod)
    return !overlapsAny(period, busy)
  })
}

/**
 * The trading date the advance horizon is counted from.
 *
 * `resolveTradingDate` answers it inside trading hours, and names a reason outside them. In the
 * daytime gap — 02:00 to 11:00, nine hours of every day — there is no trading date, so the calendar
 * date it reports is the anchor: at 09:00 last night's session has closed and today's has not opened,
 * and "90 days ahead" is counted from today.
 */
export function advanceAnchorDate(
  now: Instant,
  hoursFor: HoursForDate,
  zone: TimeZone = ASIA_DUBAI,
): LocalDate {
  const resolution = resolveTradingDate(now, hoursFor, zone)
  return resolution.kind === 'trading' ? resolution.date : resolution.calendarDate
}

/** Whole days from one local date to another. Negative when `to` is the earlier one. */
export function calendarDaysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * True when a trading date is inside the advance horizon.
 *
 * Counted in **trading dates**, not in hours from `now`, and that is a decision rather than a
 * convenience. An hours-based horizon truncates the final day at whatever time of day the query is
 * made: ask at 12:00 and the 90th day is bookable until 12:00, so its evening — which is most of its
 * bookable time — disappears, and reappears tomorrow morning. `max_advance_days` is "how far ahead
 * clients may book", and a day is either inside that or not.
 */
export function withinAdvance(daysAhead: number, maxAdvanceDays: number): boolean {
  return daysAhead <= maxAdvanceDays
}

export function solveAvailability(request: SlotRequest): SlotSolution {
  const {
    now,
    tradingDate,
    hoursFor,
    closures,
    durationMinutes,
    turnaroundMinutes,
    therapistBufferMinutes,
    minLeadMinutes,
    maxAdvanceDays,
    rooms,
    compatibleRoomTypes,
    clients = 1,
    therapistIds,
    shifts,
    appointments,
    blocks,
    stepMinutes = DEFAULT_SLOT_STEP_MINUTES,
    zone = ASIA_DUBAI,
  } = request

  if (!Number.isInteger(minLeadMinutes) || minLeadMinutes < 0) {
    throw new AppError(
      'validation',
      `A minimum lead is whole minutes and not negative, got ${minLeadMinutes}`,
    )
  }
  if (!Number.isInteger(maxAdvanceDays) || maxAdvanceDays < 1) {
    throw new AppError(
      'validation',
      `A maximum advance of ${maxAdvanceDays} days offers nothing; it is at least one day`,
    )
  }

  const windows = tradingWindowsFor({
    date: tradingDate,
    hours: hoursFor(tradingDate),
    closures,
    zone,
  })
  // Both computed once. The lead boundary is an instant, so it is comparable directly; the advance
  // boundary is a count of trading dates, and the date being solved does not change inside the loop.
  const earliestStart = addMinutes(now, minLeadMinutes)
  const daysAhead = calendarDaysBetween(advanceAnchorDate(now, hoursFor, zone), tradingDate)

  const slots: CandidateSlot[] = []
  const rejected: RejectedStart[] = []

  for (const window of windows) {
    for (const startsAt of candidateStarts({
      window,
      durationMinutes,
      turnaroundMinutes,
      stepMinutes,
      zone,
    })) {
      if (!withinAdvance(daysAhead, maxAdvanceDays)) {
        rejected.push({ startsAt, reason: 'beyond_maximum_advance' })
        continue
      }
      // `<` and not `<=`: the boundary is inclusive, so a start exactly `minLeadMinutes` after now is
      // offered. The off-by-one in the other direction loses the 14:00 slot to a 12:00 query for ever.
      if (startsAt < earliestStart) {
        rejected.push({ startsAt, reason: 'before_minimum_lead' })
        continue
      }

      const roomPeriod = roomOccupancy({ startsAt, durationMinutes, turnaroundMinutes })
      const availableRooms = roomsFreeFor({
        rooms,
        compatibleRoomTypes,
        period: roomPeriod,
        blocks,
        appointments,
        clients,
      })
      if (availableRooms.length === 0) {
        rejected.push({ startsAt, reason: 'no_room_available' })
        continue
      }

      const therapistPeriod = therapistOccupancy({
        startsAt,
        durationMinutes,
        bufferMinutes: therapistBufferMinutes,
      })
      const availableTherapistIds = therapistsFreeFor({
        therapistIds,
        period: therapistPeriod,
        shifts,
        appointments,
      })
      if (availableTherapistIds.length === 0) {
        rejected.push({ startsAt, reason: 'no_therapist_available' })
        continue
      }

      slots.push({
        startsAt,
        treatment: treatmentPeriod(startsAt, durationMinutes),
        roomPeriod,
        therapistPeriod,
        availableRoomIds: availableRooms.map((room) => room.id),
        availableTherapistIds,
      })
    }
  }

  return { slots, rejected, windows }
}
