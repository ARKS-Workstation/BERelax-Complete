/**
 * The seam B-AVAIL-07's availability **read** path solves through.
 *
 * `packages/db` may never import `packages/core`, so the query service in
 * `packages/db/src/queries/availability.ts` reads rows and takes the rule that turns them into offerable
 * slots as an injected function. This is that function, and it lives here rather than at the call site for
 * the reason {@link recheckShapeAssignment} does: an adapter written twice — once in the route, once in the
 * pair test — is two rules, and the second one drifts.
 *
 * It is an **adapter and not a new rule**. Every decision it makes is made elsewhere:
 *
 *   - the trading window, the grid, turnaround, buffer, lead and advance are `solveAvailability`'s
 *     (B-AVAIL-02);
 *   - same-gender matching is `solveGenderMatchedAvailability`'s (B-AVAIL-05), applied by narrowing the
 *     pool *before* the solve rather than filtering slots after it;
 *   - the concrete (therapists, room) tuple and the client-place count are `assignShape`'s (B-AVAIL-03),
 *     re-applied per offered start exactly as `assignShapeSlots` does;
 *   - which therapists are in the pool at all is B-AVAIL-04's read model, already applied by the SQL that
 *     produced the rows.
 *
 * What it adds is the composition the three of them did not have in one place: shape **and** gender.
 * `assignShapeSlots` solves a shape and knows nothing about the client's gender;
 * `solveGenderMatchedAvailability` applies the gender rule and returns starts without a tuple. A booking
 * page needs both at once, and composing them in the route would put the order of the two rules — narrow
 * by gender, then solve, then assign — in whichever caller was written first.
 *
 * ## The types are spelled in plain data
 *
 * Epoch milliseconds, not the branded `Instant`; plain string unions, not the branded vocabulary. That is
 * what a caller on the other side of the boundary has, and the branding happens here, on the one side that
 * owns it. The shapes are field for field those of `AvailabilitySolveInput` / `AvailabilitySolveResult` in
 * `packages/db/src/queries/availability.ts`, and `packages/fixtures` asserts the assignability with
 * `satisfies` rather than a comment — the same arrangement `SlotRecheck` has (B-AVAIL-06).
 */
import type { RoomTypeName, ServiceShape, TherapistSkill } from '@berelax/shared'
import type { HoursForDate } from '../business-day/resolve.ts'
import type { ClosedInterval } from '../business-day/windows.ts'
import type { Instant, LocalDate, LocalTime, TradingHours } from '../time.ts'
import { assignShape, type ResourceShape, shapeRoomTypes } from './assign-shape.ts'
import type { TherapistGender, TherapistPool } from './eligibility-port.ts'
import { solveGenderMatchedAvailability } from './gender-match.ts'
import type { Room } from './room-predicates.ts'
import type { ScheduledAppointment } from './solve.ts'

/** A resource shape as a repository reads it: `service_resource_shape`, one row, plain strings. */
export interface AvailabilityShapeInput {
  readonly shape: ServiceShape
  readonly therapistsRequired: number
  readonly roomsRequired: number
  readonly minRoomCapacity: number
  readonly requiredRoomType?: RoomTypeName
  readonly therapistBufferMinutes: number
}

/** A `rooms` row. */
export interface AvailabilityRoomInput {
  readonly id: string
  readonly roomType: RoomTypeName
  readonly capacity: number
  readonly isBookable: boolean
}

/**
 * A `resource_block` row, as instants. Room unavailability that is not a booking.
 *
 * `kind` and `reason` are required rather than optional, matching `ResourceBlock`: no arithmetic reads
 * them, and `roomUnavailableReason` is what turns "no availability" into a sentence the front desk can
 * act on. A block with no reason is a room that is unavailable and nobody can say why.
 */
export interface AvailabilityBlockInput {
  readonly roomId: string
  readonly period: { readonly startsAt: number; readonly endsAt: number }
  readonly kind: 'maintenance' | 'deep_clean' | 'hold' | 'other'
  readonly reason: string
}

/** An `appointment` row that still holds its therapist and its room, with its own snapshotted figures. */
export interface AvailabilityAppointmentInput {
  readonly id: string
  readonly roomId: string
  readonly therapistIds: readonly string[]
  /** `appointment.delivery_id` and `appointment.room_places` (0038). Required from a repository. */
  readonly delivery: { readonly id: string; readonly places: number }
  readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  readonly turnaroundMinutes: number
  readonly therapistBufferMinutes: number
}

/** A therapist the read model already accepted, and their presence net of approved leave. */
export interface AvailabilityTherapistInput {
  readonly therapistId: string
  readonly skills: readonly TherapistSkill[]
  /** Absent when nobody has told the build (Y8-staff). Absence is never a match under strict mode. */
  readonly gender?: TherapistGender
}

export interface AvailabilityShiftInput {
  readonly therapistId: string
  readonly period: { readonly startsAt: number; readonly endsAt: number }
}

/** Local opening hours for one calendar date, as `HH:MM`. `business_day` materialises the instants. */
export interface AvailabilityHoursInput {
  readonly open: string
  readonly close: string
}

/**
 * Everything the read path needs, as rows.
 *
 * `hours` is a map keyed by **calendar** date and not a single window, because `resolveTradingDate` has to
 * be able to ask about the date before the one it is given: 01:30 belongs to the previous trading date, and
 * the advance horizon is counted from whichever trading date `now` is inside. A single window cannot answer
 * either question.
 */
export interface AvailabilityQueryFacts {
  readonly now: number
  readonly tradingDate: string
  readonly hours: Readonly<Record<string, AvailabilityHoursInput>>
  /**
   * Intra-day closures. **Always empty from the database, and the field exists anyway.**
   *
   * A whole-day closure is ABSENT from `business_day` rather than flagged in it (0011), so it arrives as
   * a missing `hours` entry; an intra-day closure of one room is a `resource_block` (0012). There is
   * therefore no table that produces a `ClosedInterval` today. The field stays because
   * `tradingWindowsFor` takes closures and a caller that acquires a source for them — a premises-wide
   * shutdown that is not a whole day — must have somewhere to put them other than a fake block per room.
   *
   * Epoch milliseconds, like every other instant crossing this boundary: `Instant` is a branded number
   * and `packages/db` cannot name the brand. Branded here, on the one side that owns it.
   */
  readonly closures: readonly {
    readonly startsAt: number
    readonly endsAt: number
    readonly reason: string
  }[]
  readonly durationMinutes: number
  readonly turnaroundMinutes: number
  readonly minLeadMinutes: number
  readonly maxAdvanceDays: number
  readonly shape: AvailabilityShapeInput
  /** The service's `service_room_type_compat` rows. Empty means no room, never "any room". */
  readonly compatibleRoomTypes: readonly RoomTypeName[]
  readonly rooms: readonly AvailabilityRoomInput[]
  readonly therapists: readonly AvailabilityTherapistInput[]
  readonly shifts: readonly AvailabilityShiftInput[]
  readonly appointments: readonly AvailabilityAppointmentInput[]
  readonly blocks: readonly AvailabilityBlockInput[]
  /**
   * The **client's** gender, or `undefined` when nobody asked.
   *
   * A required key with a possibly-undefined value, not an optional property — the same choice
   * `GenderMatchedRequest` makes and for the same reason: `clientGender: undefined` has to be WRITTEN, so
   * "we did not collect it" is a visible statement at the call site rather than a field somebody forgot.
   * Under strict matching that statement is answered with `requires_client_gender` and zero slots.
   */
  readonly clientGender: TherapistGender | undefined
  /** Absent is strict (`genderMatchingMode`). */
  readonly genderMatching?: string
  readonly stepMinutes?: number
}

/** An offerable start with the tuple that would deliver it, in plain data. */
export interface AvailabilitySolvedSlot {
  readonly startsAt: number
  readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  readonly roomPeriod: { readonly startsAt: number; readonly endsAt: number }
  readonly therapistPeriod: { readonly startsAt: number; readonly endsAt: number }
  /** The room the assignment chose — one of {@link availableRoomIds}, by `compareRoomPreference`. */
  readonly roomId: string
  /** The therapists the assignment chose — a subset of {@link availableTherapistIds}. */
  readonly therapistIds: readonly string[]
  /**
   * Every room free for this start, not only the one that was chosen.
   *
   * Carried because the assignment picks ONE and a caller needs the set. A booking that takes the chosen
   * room does not remove the start from availability when another room is free, so a caller — or a test —
   * that reasons about "is this start still deliverable in THAT room" has no other way to ask.
   */
  readonly availableRoomIds: readonly string[]
  /**
   * Every therapist free for this start, after the gender rule.
   *
   * This is what "the same variant with other therapists" is computed from. The assignment reports the
   * one it chose, which is the lowest id; counting alternatives from that would report one therapist
   * however many were free, and the no-availability answer would name the wrong person.
   */
  readonly availableTherapistIds: readonly string[]
  readonly placesUsed: number
  /** `false` means every therapist offered is a PROVED same-gender match. Never absent. */
  readonly genderMismatch: boolean
}

export interface AvailabilityRejectedStart {
  readonly startsAt: number
  readonly reason: string
}

export interface AvailabilitySolvedDay {
  readonly slots: readonly AvailabilitySolvedSlot[]
  readonly rejected: readonly AvailabilityRejectedStart[]
  /** `requires_client_gender`, or null. Never absent, so a caller cannot forget to look. */
  readonly refusal: string | null
  readonly windows: readonly { readonly startsAt: number; readonly endsAt: number }[]
  /** Those the gender rule removed. A subset of the pool's own exclusions. */
  readonly excludedByGender: readonly { readonly therapistId: string; readonly reason: string }[]
}

/**
 * Narrow by gender, solve, assign a tuple. In that order, and the order is the rule.
 *
 * Solving first and filtering afterwards is the mistake both B-AVAIL-05 and B-AVAIL-03 name: by the time
 * `solveAvailability` has returned, an excluded therapist is already inside `availableTherapistIds` and
 * inside the intervals computed from their presence, so a filter applied to the answer cannot undo them.
 */
export function solveAvailabilityQuery(facts: AvailabilityQueryFacts): AvailabilitySolvedDay {
  const hoursFor: HoursForDate = (date: LocalDate): TradingHours | undefined => {
    const entry = facts.hours[date]
    if (entry === undefined) return undefined
    return { open: entry.open as LocalTime, close: entry.close as LocalTime }
  }

  const rooms: Room[] = facts.rooms.map((room) => ({
    id: room.id,
    roomType: room.roomType,
    capacity: room.capacity,
    isBookable: room.isBookable,
  }))

  const appointments: ScheduledAppointment[] = facts.appointments.map((appointment) => ({
    id: appointment.id,
    roomId: appointment.roomId,
    therapistIds: appointment.therapistIds,
    delivery: appointment.delivery,
    treatment: {
      startsAt: appointment.treatment.startsAt as Instant,
      endsAt: appointment.treatment.endsAt as Instant,
    },
    turnaroundMinutes: appointment.turnaroundMinutes,
    therapistBufferMinutes: appointment.therapistBufferMinutes,
  }))

  const shape: ResourceShape = {
    shape: facts.shape.shape,
    therapistsRequired: facts.shape.therapistsRequired,
    roomsRequired: facts.shape.roomsRequired,
    minRoomCapacity: facts.shape.minRoomCapacity,
    // Spread rather than assigned: under `exactOptionalPropertyTypes` an explicit `undefined` is a
    // different type from an absent key, and absent is what "any compatible room type" means here.
    ...(facts.shape.requiredRoomType === undefined
      ? {}
      : { requiredRoomType: facts.shape.requiredRoomType }),
    therapistBufferMinutes: facts.shape.therapistBufferMinutes,
  }

  const pool: TherapistPool = {
    therapists: facts.therapists.map((therapist) => ({
      therapistId: therapist.therapistId,
      skills: therapist.skills,
      ...(therapist.gender === undefined ? {} : { gender: therapist.gender }),
    })),
    shifts: facts.shifts.map((shift) => ({
      therapistId: shift.therapistId,
      period: {
        startsAt: shift.period.startsAt as Instant,
        endsAt: shift.period.endsAt as Instant,
      },
    })),
    // The pool handed to the solver carries no exclusions: the SQL already removed them, and repeating
    // them here would double-count a therapist into two reasons — what `assertPoolAccountsFor` refuses.
    excluded: [],
  }

  const solution = solveGenderMatchedAvailability({
    now: facts.now as Instant,
    tradingDate: facts.tradingDate as LocalDate,
    hoursFor,
    closures: facts.closures.map(
      (closure): ClosedInterval => ({
        startsAt: closure.startsAt as Instant,
        endsAt: closure.endsAt as Instant,
        reason: closure.reason,
      }),
    ),
    durationMinutes: facts.durationMinutes,
    turnaroundMinutes: facts.turnaroundMinutes,
    // Both read off the SHAPE and never from the caller, exactly as `shapeSolverRequest` insists: a
    // client count or a buffer that disagrees with the footprint is a slot the booking refuses.
    therapistBufferMinutes: shape.therapistBufferMinutes,
    clients: shape.minRoomCapacity,
    minLeadMinutes: facts.minLeadMinutes,
    maxAdvanceDays: facts.maxAdvanceDays,
    rooms,
    // Narrowed by the shape's own required room type, so a Morocco Bath cannot be offered a standard
    // room by way of the service's wider compatibility set.
    compatibleRoomTypes: shapeRoomTypes(shape, facts.compatibleRoomTypes),
    appointments,
    blocks: facts.blocks.map((block) => ({
      roomId: block.roomId,
      period: {
        startsAt: block.period.startsAt as Instant,
        endsAt: block.period.endsAt as Instant,
      },
      kind: block.kind,
      reason: block.reason,
    })),
    pool,
    clientGender: facts.clientGender,
    ...(facts.genderMatching === undefined
      ? {}
      : { genderMatching: facts.genderMatching as 'strict' | 'advisory' }),
    ...(facts.stepMinutes === undefined ? {} : { stepMinutes: facts.stepMinutes }),
  })

  const slots: AvailabilitySolvedSlot[] = []
  const rejected: AvailabilityRejectedStart[] = solution.rejected.map((start) => ({
    startsAt: start.startsAt,
    reason: start.reason,
  }))

  for (const slot of solution.slots) {
    const assignment = assignShape({
      shape,
      // The room records behind the ids the solver reported, never wider: an id the solver did not
      // report cannot appear here whatever else is in `rooms`.
      rooms: rooms.filter((room) => slot.availableRoomIds.includes(room.id)),
      therapistIds: slot.availableTherapistIds,
      treatment: slot.treatment,
      appointments,
    })
    if (assignment.kind === 'refused') {
      // Moved into `rejected` with the assignment layer's own reason rather than dropped. "We have a
      // room and one therapist free but not two" is the sentence the front desk needs, and a bare
      // absence cannot say it.
      rejected.push({ startsAt: slot.startsAt, reason: assignment.reason })
      continue
    }
    slots.push({
      startsAt: slot.startsAt,
      treatment: slot.treatment,
      roomPeriod: slot.roomPeriod,
      therapistPeriod: slot.therapistPeriod,
      roomId: assignment.assignment.roomId,
      therapistIds: assignment.assignment.therapistIds,
      availableRoomIds: slot.availableRoomIds,
      // The solver's own list, which the gender rule has already narrowed to proved same-gender matches
      // wherever one exists. Never widened here: `crossGenderTherapistIds` is deliberately kept out of
      // it, so a caller cannot reach a cross-gender delivery by reading the alternatives.
      availableTherapistIds: slot.availableTherapistIds,
      placesUsed: assignment.assignment.placesUsed,
      genderMismatch: slot.genderMismatch,
    })
  }

  return {
    slots,
    // Ascending, so a caller walking the rejections to explain a gap does not have to sort them.
    rejected: [...rejected].sort((a, b) => a.startsAt - b.startsAt),
    refusal: solution.refusal,
    windows: solution.windows.map((window) => ({
      startsAt: window.startsAt,
      endsAt: window.endsAt,
    })),
    excludedByGender: solution.excludedByGender.map((row) => ({
      therapistId: row.therapistId,
      reason: row.reason,
    })),
  }
}
