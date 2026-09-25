import {
  appointmentRoomPeriod,
  appointmentTherapistPeriod,
  type ScheduledAppointment,
} from '../availability/solve.ts'
import { ASIA_DUBAI, type Instant, type TimeZone, toLocal } from '../time.ts'

/**
 * The front-desk day, laid out on two axes over one set of rows (B-UI-03).
 *
 * Rooms are the scarce resource, so **room × time is the primary axis** and therapist × time is a second
 * READ of the same appointments rather than a second query. That is what {@link calendarAxes} is for: it
 * takes one day's facts and answers both axes, carrying the facts object it was given as
 * {@link CalendarAxes.source} and every appointment BY REFERENCE, so "the two views are derived from one
 * query result" is a claim a test can settle with `toBe` instead of comparing two lists and hoping.
 *
 * Pure, and the arithmetic lives here rather than in the page or in the browser for three reasons:
 *
 *  - **The bands are the solver's own intervals.** A card is drawn from `appointmentRoomPeriod` and
 *    `appointmentTherapistPeriod` — the two functions `occupancyIndex` uses to decide what a room and a
 *    therapist are already holding. So the turnaround the calendar draws is the turnaround a booking is
 *    refused for, and a second opinion about a footprint cannot exist: the room band is the treatment plus
 *    the service's turnaround, the therapist band is the treatment plus the shape's buffer on BOTH sides,
 *    and those two are different lengths whenever the configured minutes differ.
 *  - **A day is not a calendar date.** A trading day crosses midnight, so the grid's own coordinate space is
 *    `[opensAt, closesAt)` of the `business_day` row and a treatment that crosses midnight is one
 *    continuous span in it, never two. Nothing here truncates an instant to a date.
 *  - **The browser must do no arithmetic.** {@link CalendarAxes.slots} are the drop targets, each one
 *    carrying the instant it means, so a drag handler reads a start off the element under the pointer
 *    instead of converting a pixel offset into a time. A browser that computed the time would be a second
 *    implementation of the grid, and it would disagree with this one at exactly the two edges — the
 *    midnight crossing and the close — that nobody drags onto while testing.
 */

/** Minutes between two drop targets. A quarter of an hour is the granularity the front desk speaks in. */
export const CALENDAR_STEP_MINUTES = 15

/** The bands a card is drawn from, named by what HOLDS the resource. */
export const CALENDAR_BAND_KINDS = ['treatment', 'turnaround', 'therapist_buffer'] as const
export type CalendarBandKind = (typeof CALENDAR_BAND_KINDS)[number]

/**
 * One band of one card, with the instants it covers and where it sits in the day.
 *
 * `offset` and `length` are fractions of the day's own length, **clamped** to it, because a turnaround can
 * run past the close and a page cannot draw past its grid. `startsAt` and `endsAt` are never clamped: they
 * are the facts, and a band whose drawn length is 0 because it falls entirely outside the day is still a
 * band that holds a room.
 */
export interface CalendarBand {
  readonly kind: CalendarBandKind
  readonly startsAt: number
  readonly endsAt: number
  readonly minutes: number
  readonly offset: number
  readonly length: number
}

/** A drop target: a quarter hour of one lane, carrying the instant a card dropped on it would start. */
export interface CalendarSlot {
  readonly startsAt: number
  readonly startsAtIso: string
  /** `HH:MM` in the business zone. The label a receptionist reads, and the one the live region speaks. */
  readonly label: string
  readonly offset: number
  readonly length: number
}

/**
 * One appointment as the calendar needs it: a {@link ScheduledAppointment} plus what a card says.
 *
 * It extends the solver's own record rather than restating it, which is what lets the two band functions
 * be the solver's. The extra fields are all labels or ids — never a customer's name, never a therapist's:
 * ADR 0020 gives a therapist a handle until an admin publishes a name, and a front-desk calendar has no
 * reason to carry a client's name at all.
 */
export interface CalendarAppointmentFacts extends ScheduledAppointment {
  readonly status: string
  readonly bookingId: string
  /** The treatment, as the menu spells it. `service.public_display_name`. */
  readonly serviceLabel: string
  readonly shape: string
}

export interface CalendarRoomFacts {
  readonly roomId: string
  readonly code: string
  readonly name: string
  readonly capacity: number
}

/** A therapist on the day. `reference` is `employee.staff_reference`; there is no name field on purpose. */
export interface CalendarTherapistFacts {
  readonly therapistId: string
  readonly reference: string | null
}

/**
 * One day's rows, exactly as the reader answered them. The ONE source both axes are derived from.
 *
 * `opensAt`/`closesAt` are the `business_day` row's, so the grid cannot be wrong about which trading date
 * it is showing: a caller that resolved the date from a clock resolved it with `resolveTradingDate`, and
 * this structure only ever carries the answer.
 */
export interface CalendarDayFacts {
  readonly tradingDate: string
  readonly opensAt: number
  readonly closesAt: number
  readonly rooms: readonly CalendarRoomFacts[]
  readonly therapists: readonly CalendarTherapistFacts[]
  readonly appointments: readonly CalendarAppointmentFacts[]
}

/** One appointment on one lane: the SAME facts object, plus the bands that lane holds it for. */
export interface CalendarCard {
  /** By reference. Two cards for one appointment on two axes are two views of one row. */
  readonly appointment: CalendarAppointmentFacts
  readonly bands: readonly CalendarBand[]
  /** The whole footprint on this axis — the union of the bands, which is what the lane reserves. */
  readonly offset: number
  readonly length: number
}

export interface CalendarLane {
  readonly axis: 'room' | 'therapist'
  readonly id: string
  /** What the lane is called. A room code and name, or a therapist's handle. Never an invented name. */
  readonly label: string
  readonly cards: readonly CalendarCard[]
}

export interface CalendarAxes {
  /** The facts these axes were derived from, by reference. Both axes and nothing else come from it. */
  readonly source: CalendarDayFacts
  readonly tradingDate: string
  readonly opensAt: number
  readonly closesAt: number
  readonly minutes: number
  /** The primary axis: one lane per room, in the order the reader gave them. */
  readonly rooms: readonly CalendarLane[]
  /** The secondary axis, over the same appointments. */
  readonly therapists: readonly CalendarLane[]
  /** The drop targets, shared by every lane. */
  readonly slots: readonly CalendarSlot[]
}

const MINUTE = 60_000

/** Minutes between two instants, rounded. A period is always whole minutes; the rounding is a guard. */
function minutesBetween(later: number, earlier: number): number {
  return Math.round((later - earlier) / MINUTE)
}

function bandFrom(
  kind: CalendarBandKind,
  span: { readonly startsAt: number; readonly endsAt: number },
  day: { readonly opensAt: number; readonly minutes: number },
): CalendarBand {
  const total = day.minutes * MINUTE
  // Clamped for DRAWING only. A band outside the day draws as nothing and is still reported.
  const from = Math.min(Math.max(span.startsAt, day.opensAt), day.opensAt + total)
  const to = Math.min(Math.max(span.endsAt, day.opensAt), day.opensAt + total)
  return {
    kind,
    startsAt: span.startsAt,
    endsAt: span.endsAt,
    minutes: minutesBetween(span.endsAt, span.startsAt),
    offset: total === 0 ? 0 : (from - day.opensAt) / total,
    length: total === 0 ? 0 : (to - from) / total,
  }
}

/**
 * The room's bands: the treatment, and the turnaround AFTER it as its own band.
 *
 * Two bands rather than one long one, because they are two different facts about the room. The treatment is
 * when somebody is being treated in it; the turnaround is when it is being cleaned and cannot be sold. A
 * single band would draw the room as busy for both and tell the front desk nothing about which — and the
 * turnaround is the part a receptionist argues with, because it is the twenty minutes they can see nobody
 * in.
 */
function roomBands(
  appointment: CalendarAppointmentFacts,
  day: { readonly opensAt: number; readonly minutes: number },
): readonly CalendarBand[] {
  const occupancy = appointmentRoomPeriod(appointment)
  const treatment = bandFrom('treatment', appointment.treatment, day)
  if (occupancy.endsAt <= appointment.treatment.endsAt) return [treatment]
  return [
    treatment,
    bandFrom(
      'turnaround',
      { startsAt: appointment.treatment.endsAt, endsAt: occupancy.endsAt },
      day,
    ),
  ]
}

/**
 * The therapist's bands: the buffer BEFORE, the treatment, and the buffer AFTER.
 *
 * The leading half is the one that gets forgotten — `therapistOccupancy`'s own header says so — and a
 * calendar that drew the buffer only after the treatment would show a therapist free at the moment the
 * booking transaction refuses to give them away. Both halves are the same `therapist_buffer` kind, because
 * they are one rule; they are separate elements because they are on opposite sides of the card.
 */
function therapistBands(
  appointment: CalendarAppointmentFacts,
  day: { readonly opensAt: number; readonly minutes: number },
): readonly CalendarBand[] {
  const occupancy = appointmentTherapistPeriod(appointment)
  const treatment = bandFrom('treatment', appointment.treatment, day)
  const before =
    occupancy.startsAt < appointment.treatment.startsAt
      ? [
          bandFrom(
            'therapist_buffer',
            { startsAt: occupancy.startsAt, endsAt: appointment.treatment.startsAt },
            day,
          ),
        ]
      : []
  const after =
    occupancy.endsAt > appointment.treatment.endsAt
      ? [
          bandFrom(
            'therapist_buffer',
            { startsAt: appointment.treatment.endsAt, endsAt: occupancy.endsAt },
            day,
          ),
        ]
      : []
  return [...before, treatment, ...after]
}

function cardFrom(
  appointment: CalendarAppointmentFacts,
  bands: readonly CalendarBand[],
): CalendarCard {
  const offset = Math.min(...bands.map((band) => band.offset))
  const end = Math.max(...bands.map((band) => band.offset + band.length))
  return { appointment, bands, offset, length: end - offset }
}

/** The lane label for a room: the code the door carries, and the name beside it. */
function roomLabel(room: CalendarRoomFacts): string {
  return room.name === room.code ? room.code : `${room.code} · ${room.name}`
}

/**
 * The lane label for a therapist.
 *
 * `staff_reference` when there is one, and a stated absence when there is not — never a name and never an
 * invented handle. `appointment.therapist_id` is deliberately not a foreign key (0024), so an employee row
 * can be gone while the appointment it held remains, and a lane that silently dropped it would hide work
 * somebody has to do.
 */
function therapistLabel(therapist: CalendarTherapistFacts): string {
  return therapist.reference ?? 'therapist not on file'
}

/**
 * The drop targets for the whole day, at {@link CALENDAR_STEP_MINUTES}.
 *
 * Generated from the day's own bounds, so the last target is the last quarter hour that STARTS inside the
 * day. A target past the close would offer a start the booking rules refuse — `latestStart` leaves room for
 * the treatment and its turnaround — and refusing it here instead would put a second copy of that rule on
 * the page. The server answers a drop, this only proposes one.
 */
function slotsFor(
  day: { readonly opensAt: number; readonly closesAt: number; readonly minutes: number },
  zone: TimeZone,
): readonly CalendarSlot[] {
  const total = day.minutes * MINUTE
  const slots: CalendarSlot[] = []
  for (let at = day.opensAt; at < day.closesAt; at += CALENDAR_STEP_MINUTES * MINUTE) {
    slots.push({
      startsAt: at,
      startsAtIso: new Date(at).toISOString(),
      label: toLocal(at as Instant, zone).time,
      offset: total === 0 ? 0 : (at - day.opensAt) / total,
      length: total === 0 ? 0 : (CALENDAR_STEP_MINUTES * MINUTE) / total,
    })
  }
  return slots
}

/**
 * Both axes of one day, from one set of facts.
 *
 * The appointments are placed twice and read once. `source` is the object this was handed, and every card's
 * `appointment` is one of the objects inside it — not a copy of one — which is how
 * `apps/web/src/admin-calendar.itest.ts` asserts that the therapist view is not a second fetch: a second
 * fetch cannot produce the same object identity, and a behavioural comparison of two lists would pass right
 * up until the two reads disagreed, which is the only moment it mattered.
 *
 * A room lane exists for every room the reader returned, including an empty one, because an empty room is
 * the thing a receptionist is looking for. A therapist lane exists for every therapist the reader returned;
 * which therapists those are is the reader's decision, not this function's.
 */
export function calendarAxes(day: CalendarDayFacts, zone: TimeZone = ASIA_DUBAI): CalendarAxes {
  const minutes = minutesBetween(day.closesAt, day.opensAt)
  const bounds = { opensAt: day.opensAt, minutes }
  const rooms = day.rooms.map(
    (room): CalendarLane => ({
      axis: 'room',
      id: room.roomId,
      label: roomLabel(room),
      cards: day.appointments
        .filter((appointment) => appointment.roomId === room.roomId)
        .map((appointment) => cardFrom(appointment, roomBands(appointment, bounds))),
    }),
  )
  const therapists = day.therapists.map(
    (therapist): CalendarLane => ({
      axis: 'therapist',
      id: therapist.therapistId,
      label: therapistLabel(therapist),
      cards: day.appointments
        .filter((appointment) => appointment.therapistIds.includes(therapist.therapistId))
        .map((appointment) => cardFrom(appointment, therapistBands(appointment, bounds))),
    }),
  )
  return {
    source: day,
    tradingDate: day.tradingDate,
    opensAt: day.opensAt,
    closesAt: day.closesAt,
    minutes,
    rooms,
    therapists,
    slots: slotsFor({ opensAt: day.opensAt, closesAt: day.closesAt, minutes }, zone),
  }
}

/**
 * The bands of one kind on one card, in order. Reads a claim about a card without indexing into an array.
 *
 * Used by the page to draw and by the tests to compare the room's turnaround against the therapist's
 * buffer, which is the one assertion in this unit that is about two numbers being DIFFERENT.
 */
export function bandsOfKind(card: CalendarCard, kind: CalendarBandKind): readonly CalendarBand[] {
  return card.bands.filter((band) => band.kind === kind)
}

/** Every card on an axis, flattened, so a caller can count appointments without knowing about lanes. */
export function cardsOn(lanes: readonly CalendarLane[]): readonly CalendarCard[] {
  return lanes.flatMap((lane) => lane.cards)
}
