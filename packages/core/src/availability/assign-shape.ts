/**
 * Resource-shape assignment: turning an offerable start into a concrete `(therapists[], room)`.
 *
 * `solveAvailability` (B-AVAIL-02) answers *whether* a start is offerable and hands back every room
 * and every therapist that is free for it. That is not yet a booking: Couple Massage needs **two**
 * therapists and a room that holds two clients, Four Hands needs **two** therapists over **one**
 * client, and Morocco Bath needs the wet room and nothing else will do. This module is the layer that
 * chooses, and it is deliberately not a second solver — every window, lead, advance, turnaround and
 * buffer figure still comes from `solveAvailability`, which this module *feeds* with the parameters the
 * shape implies (`clients`, `therapist_buffer_minutes`, the narrowed room types) and then reads back.
 *
 * ## The three real shapes, and why there is no fourth
 *
 * docs/13 §4 sells three footprints, and `0017_catalogue.sql` seeds exactly those rows:
 *
 *   - **Couple Massage** — 2 therapists, 2 clients, the capacity-2 couples room;
 *   - **Four Hands**     — 2 therapists, 1 client, a standard room;
 *   - **Morocco Bath**   — 1 therapist, 1 client, the single wet room, which is the scarce resource.
 *
 * Full Body Shaving is the fourth line on that table and it is **[CONFIRM]** — nobody has said whether
 * it needs a room of its own — so it is absent here rather than guessed at. A fourth constant would be
 * a resource footprint this business has not agreed to sell.
 *
 * ## All-or-none, because half a Four Hands is not a treatment
 *
 * An assignment is complete or it does not exist. Returning one therapist for a two-therapist shape is
 * the failure mode worth naming: the slot is offered, the customer books, and the shortfall is
 * discovered on the floor. `assignShape` therefore answers with a refusal *reason* rather than with a
 * partial tuple, in the same style as `resolveTradingDate` and `roomUnavailableReason` — "no
 * availability" is the answer the front desk cannot act on.
 *
 * ## Deterministic, because a seed and a screenshot have to stay diffable
 *
 * Given the same free rooms and therapists, the same tuple comes back, in the same order, every time —
 * and it does not depend on the order the repository happened to return them in. Rooms sort by
 * *scarcity* (see `ROOM_TYPE_PREFERENCE`) and therapists by id. That is not a fairness policy: who
 * *should* get the work is rota fairness, which needs state this module does not have and belongs with
 * the eligibility provider of B-AVAIL-04 and P-HR. What is settled here is only that the answer does
 * not move between two runs over identical input.
 *
 * ## An assignment the database would refuse is not an assignment
 *
 * `0024_appointment_constraints.sql` writes **one appointment row per therapist**, and two of its rules
 * decide what a legal tuple is:
 *
 *   - `appointment_therapist_no_overlap` — `exclude using gist (therapist_id with =, period with &&)`.
 *     The two therapists of a shape must therefore be *distinct*; the same id twice is refused with
 *     SQLSTATE 23P01, so this module de-duplicates rather than trusting its input.
 *   - `appointment_room_capacity` — the deferred trigger counts, at the busiest instant of the written
 *     row's own period, the **client places** held in the room, and refuses a peak above
 *     `rooms.capacity`. Places are summed over distinct *deliveries* (0038), so two therapists over one
 *     client is one place however many rows it is. `roomPlacesRequired` is that figure and
 *     `roomPlacesTaken` mirrors the SQL `room_peak_concurrency` so the two cannot drift. Until 0038 the
 *     trigger counted rows, which made Four Hands unbookable in every capacity-1 standard room the
 *     salon owns; see `roomPlacesRequired` for what was wrong and why the inventory was not.
 *
 * Pure: rooms, therapist ids, periods and appointments in, a tuple out. No clock, no database.
 */
import { AppError, type ServiceResourceShapeInput, type ServiceShape } from '@berelax/shared'
import type { TradingWindow } from '../business-day/windows.ts'
import type { Instant } from '../time.ts'
import type { Period, Room, RoomType } from './room-predicates.ts'
import {
  type CandidateSlot,
  type ScheduledAppointment,
  type SlotRejection,
  type SlotRequest,
  solveAvailability,
} from './solve.ts'

/**
 * The resource footprint of one delivery, exactly as `service_resource_shape` stores it.
 *
 * Aliased from `@berelax/shared` rather than restated. The zod refinements at the edge, the CHECK
 * constraints in `0017_catalogue.sql` and this module all have to agree about what those six fields
 * mean, and a second declaration of them is how they stop agreeing — `min_room_capacity` in
 * particular, which is the *client* count and not the therapist count (Four Hands is 1).
 */
export type ResourceShape = ServiceResourceShapeInput

/**
 * The therapist buffer the three constants below carry, in minutes.
 *
 * Provisional under Y9-buffer, mirroring the value `0017_catalogue.sql` seeded onto every
 * `service_resource_shape` row. It is named once here so that the three shapes cannot disagree with
 * each other, and so that the day the owner answers Y9-buffer there is a single literal to change.
 * Production reads the row; these constants are the documented shape of it.
 */
export const PROVISIONAL_THERAPIST_BUFFER_MINUTES = 10

/** Couple Massage: two therapists, two clients, one room that holds both of them. */
export const COUPLE_MASSAGE_SHAPE: ResourceShape = Object.freeze({
  shape: 'couple',
  therapistsRequired: 2,
  roomsRequired: 1,
  minRoomCapacity: 2,
  requiredRoomType: 'couples',
  therapistBufferMinutes: PROVISIONAL_THERAPIST_BUFFER_MINUTES,
})

/**
 * Four Hands: two therapists over **one** client, in a standard room.
 *
 * `minRoomCapacity` is 1 and that is correct — there is one client, docs/13 §4 says so, and 0017 seeds
 * it. The two rows the database stores are two *therapists*, which is not a second place in the room;
 * that is what 0038 settled, and it is why a capacity-1 standard room takes this shape.
 */
export const FOUR_HANDS_SHAPE: ResourceShape = Object.freeze({
  shape: 'four_hands',
  therapistsRequired: 2,
  roomsRequired: 1,
  minRoomCapacity: 1,
  requiredRoomType: 'standard',
  therapistBufferMinutes: PROVISIONAL_THERAPIST_BUFFER_MINUTES,
})

/**
 * Morocco Bath: one therapist, one client, the wet room.
 *
 * The shape is `solo`, and the `requiredRoomType` is what makes it one of the three: there is one wet
 * room, a Morocco Bath cannot be delivered anywhere else, and mis-scheduling it voids the booking
 * rather than degrading it (0012_rooms.sql).
 */
export const MOROCCO_BATH_SHAPE: ResourceShape = Object.freeze({
  shape: 'solo',
  therapistsRequired: 1,
  roomsRequired: 1,
  minRoomCapacity: 1,
  requiredRoomType: 'wet',
  therapistBufferMinutes: PROVISIONAL_THERAPIST_BUFFER_MINUTES,
})

/**
 * The three footprints this business sells. Three, and the length is asserted.
 *
 * Kept as an array so a test can iterate the real shapes without listing them again, which is how a
 * fourth one arrives unnoticed.
 */
export const REAL_RESOURCE_SHAPES: readonly ResourceShape[] = Object.freeze([
  COUPLE_MASSAGE_SHAPE,
  FOUR_HANDS_SHAPE,
  MOROCCO_BATH_SHAPE,
])

/**
 * Scarcity order: the room the premises can least afford to give away sorts last.
 *
 * Three standard rooms, one couples room, one wet room (0012_rooms.sql), so a single client who would
 * fit anywhere goes into a standard room and the couples room stays available for the booking that
 * cannot go anywhere else. `bookableRoomsFor` deliberately does *not* sort — it says so in its own
 * comment — because preferring a standard room over the only couples room is a **scheduling policy**,
 * and this is the module that owns scheduling policy.
 *
 * A `Record` over the union rather than an ordered array with an `indexOf`: a fourth room type becomes
 * a compile error here, where a lookup with a fall-back would silently rank it first or last.
 */
export const ROOM_TYPE_PREFERENCE: Readonly<Record<RoomType, number>> = Object.freeze({
  standard: 0,
  couples: 1,
  wet: 2,
})

/**
 * Places in one room that one delivery of the shape consumes — that is, **clients**.
 *
 * It was `max(minRoomCapacity, therapistsRequired)` until migration 0038, because the deferred trigger
 * of `0024` counted appointment **rows** against `rooms.capacity` and `0024` writes one row per
 * therapist. That made a Four Hands two places, and since every standard room the salon owns is
 * capacity 1 (B-CAT-06 measured the inventory and seeded them so), a shape this business sells was
 * assignable to no room at all.
 *
 * The rows were the wrong unit, not the inventory. `rooms.capacity` is documented in `0012_rooms.sql`
 * as the clients a room holds at once and docs/13 §4 states Four Hands as *2 therapists, 1 standard
 * room, 1 client* — so a row is a therapist, a place is a client, and the two columns were never
 * comparable. 0038 gives the appointment a `delivery_id` and a `room_places` figure and re-issues
 * `room_peak_concurrency` to sum places over distinct deliveries; this function is the other side of
 * that arithmetic and is now simply the client count.
 *
 * It stays a named function rather than becoming `shape.minRoomCapacity` at each call site, because
 * "places of a room a delivery occupies" and "clients a room must hold" are two questions that happen
 * to share an answer: `bookableRoomsFor`'s `clients` asks whether the room is big enough at all, and
 * this asks how much of it this delivery takes. They are asserted separately for that reason.
 */
export function roomPlacesRequired(shape: ResourceShape): number {
  return shape.minRoomCapacity
}

/**
 * The peak number of **client places** held in `roomId` at any single instant of `period`.
 *
 * A mirror of the SQL `room_peak_concurrency(room_id, window)` — re-issued by 0038 to sum places over
 * distinct deliveries — measured the same way and for the same reason: a **total** is wrong, and so is
 * "how many appointments overlap this one". In a capacity-2 room holding 10:00–12:00 and 18:00–20:00, a
 * new 09:00–21:00 booking overlaps both, so the naive count is 3 — but at no instant are three people
 * in the room, and refusing that booking is the guard becoming the problem. For half-open intervals the
 * maximum number of simultaneously open intervals is always attained at one of their lower bounds, so
 * measuring at `period`'s own start and at every appointment start inside it is exhaustive.
 *
 * Grouped by {@link ScheduledAppointment.delivery}, because the SQL groups by `delivery_id`: two
 * therapists over one client are two records and **one** place. A record with no delivery is its own
 * delivery of one place, which is what every record was before 0038 and is the stricter reading of a
 * room. The places of a delivery are taken at `max`, matching `max(room_places)` in the SQL, so two
 * records that disagreed about one delivery's footprint are counted at the larger of the two.
 *
 * The periods compared are the **treatments**, not the room occupancy: `appointment.period` stores the
 * treatment and the trigger reads that column, so counting turnaround here would make this module
 * stricter than the constraint it is predicting. Room *availability* does count the turnaround, and
 * that is `roomsFreeFor`'s job, one layer up.
 *
 * `appointments` carries no status because it cannot: the repository selects on `holds_resources`, the
 * generated column 0024 defines, so a cancelled or rescheduled appointment never reaches core.
 */
export function roomPlacesTaken(args: {
  readonly roomId: string
  readonly period: Period
  readonly appointments: readonly ScheduledAppointment[]
}): number {
  const { roomId, period, appointments } = args
  const inRoom = appointments.filter((appointment) => appointment.roomId === roomId)
  const instants: Instant[] = [
    period.startsAt,
    ...inRoom
      .map((appointment) => appointment.treatment.startsAt)
      .filter((at) => at >= period.startsAt && at < period.endsAt),
  ]
  return instants.reduce((peak, at) => {
    // Keyed by delivery id, and by the record's own id when it has no delivery — which is exactly
    // "one delivery per row", the default `appointment.delivery_id` carries.
    const places = new Map<string, number>()
    for (const appointment of inRoom) {
      if (appointment.treatment.startsAt > at || at >= appointment.treatment.endsAt) continue
      const key = appointment.delivery?.id ?? appointment.id
      const claimed = appointment.delivery?.places ?? 1
      places.set(key, Math.max(places.get(key) ?? 0, claimed))
    }
    const concurrent = [...places.values()].reduce((total, claimed) => total + claimed, 0)
    return concurrent > peak ? concurrent : peak
  }, 0)
}

/**
 * Places still free in the room over `period`: its capacity less the peak already committed.
 *
 * Counted *before* the candidate's own rows exist, which is why the comparison one caller up is
 * `remaining >= required` rather than the trigger's `peak > capacity`. The two say the same thing from
 * either side of the insert.
 */
export function remainingRoomPlaces(args: {
  readonly room: Room
  readonly period: Period
  readonly appointments: readonly ScheduledAppointment[]
}): number {
  const { room, period, appointments } = args
  return room.capacity - roomPlacesTaken({ roomId: room.id, period, appointments })
}

/**
 * The room types this shape may be delivered in: the service's compatibility rows, narrowed.
 *
 * An intersection and never a substitution. `service_room_type_compat` answers "may this treatment
 * happen in that kind of room at all" and has no fall-back — zero rows means zero rooms (0012) — while
 * `service_resource_shape.required_room_type` narrows that set for one footprint, which is what makes
 * Four Hands standard-room-only even though its parent treatment also permits the couples room. A
 * `required_room_type` with no matching compatibility row yields nothing, which is the same structural
 * refusal read from this side as the composite foreign key `service_resource_shape_room_type_compat_fk`
 * enforces from the other.
 */
export function shapeRoomTypes(
  shape: ResourceShape,
  compatibleRoomTypes: readonly RoomType[],
): RoomType[] {
  if (shape.requiredRoomType === undefined) return [...compatibleRoomTypes]
  return compatibleRoomTypes.filter((roomType) => roomType === shape.requiredRoomType)
}

/**
 * The deterministic room order: scarcity, then the smallest room that fits, then the id.
 *
 * Capacity ascending after the type rank, so a solo client does not take the two-plinth room while a
 * one-plinth room stands empty. The id last, because two rooms of one type and one capacity are
 * otherwise a coin toss, and a coin toss shows up as a diff in every seeded fixture and screenshot.
 */
export function compareRoomPreference(a: Room, b: Room): number {
  const byType = ROOM_TYPE_PREFERENCE[a.roomType] - ROOM_TYPE_PREFERENCE[b.roomType]
  if (byType !== 0) return byType
  if (a.capacity !== b.capacity) return a.capacity - b.capacity
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/** The concrete tuple: which therapists, which room, and how many places of it are consumed. */
export interface ShapeAssignment {
  readonly shape: ServiceShape
  /**
   * Exactly `therapistsRequired` distinct ids, ascending. Ids and never names: a therapist has no
   * display name until an admin sets one.
   */
  readonly therapistIds: readonly string[]
  readonly roomId: string
  /**
   * Places of the room consumed — the clients this delivery puts in it, which is the figure
   * `appointment.room_places` stores and the capacity trigger sums. Carried on the assignment rather
   * than recomputed by the caller, so the figure the availability layer reasoned about is the figure
   * the booking transaction writes and the database checks against `rooms.capacity`.
   *
   * Not the number of appointment rows: that is `therapistIds.length`, and conflating the two is the
   * defect 0038 corrected.
   */
  readonly placesUsed: number
}

/**
 * Why a slot that is otherwise offerable cannot be delivered in this shape.
 *
 * Two reasons and they are not interchangeable: one is answered by opening another room or moving the
 * booking, the other by rostering a second therapist.
 */
export type ShapeRefusal = 'no_room_with_free_places' | 'too_few_therapists'

export type ShapeAssignmentResult =
  | { readonly kind: 'assigned'; readonly assignment: ShapeAssignment }
  | { readonly kind: 'refused'; readonly reason: ShapeRefusal }

/**
 * Refuses a footprint this layer cannot honestly assign, rather than assigning something near it.
 *
 * The zod schema at the edge and 0017's CHECK constraints already refuse a malformed row; what is
 * caught here is what *this function* would otherwise do silently. A `roomsRequired` above one is the
 * important one: every one of the three real shapes is delivered in a single room, `appointment` has
 * one `room_id` per row, and quietly returning one room for a two-room footprint produces a booking
 * nobody can work.
 */
function assertAssignable(shape: ResourceShape): void {
  if (!Number.isInteger(shape.therapistsRequired) || shape.therapistsRequired < 1) {
    throw new AppError(
      'validation',
      `A shape needs at least one therapist, got ${shape.therapistsRequired}`,
    )
  }
  if (!Number.isInteger(shape.minRoomCapacity) || shape.minRoomCapacity < 1) {
    throw new AppError(
      'validation',
      `A shape puts at least one client in the room, got ${shape.minRoomCapacity}`,
    )
  }
  if (shape.roomsRequired !== 1) {
    throw new AppError(
      'validation',
      `This layer assigns one room; the ${shape.shape} shape asks for ${shape.roomsRequired}. ` +
        'All three shapes this business sells are delivered in a single room.',
    )
  }
}

/**
 * The assignment, or the reason there is not one. All-or-none.
 *
 * `rooms` and `therapistIds` are what `solveAvailability` reported free for this start — this function
 * only ever narrows them, never widens. The shape's own rules are re-applied to the rooms rather than
 * trusted from the caller, because B-AVAIL-06 calls this again inside the booking transaction to
 * re-check the tuple against rows that may have changed since the page was rendered, and at that point
 * there is no solver in the call stack to have filtered anything.
 *
 * The room is decided before the therapists, matching the order `solveAvailability` reports its own
 * rejections in, so the two layers explain a gap the same way round.
 */
export function assignShape(args: {
  readonly shape: ResourceShape
  readonly rooms: readonly Room[]
  readonly therapistIds: readonly string[]
  /** The treatment itself, `[start, start + duration)` — the period `appointment.period` stores. */
  readonly treatment: Period
  readonly appointments: readonly ScheduledAppointment[]
}): ShapeAssignmentResult {
  const { shape, rooms, therapistIds, treatment, appointments } = args
  assertAssignable(shape)

  const placesUsed = roomPlacesRequired(shape)
  // No separate `capacity >= placesUsed` filter: `remaining = capacity - taken` and `taken` is never
  // negative, so the free-places test already implies it. A second filter saying the same thing is a
  // line nothing can ever fail.
  const room = rooms
    .filter(
      (candidate) =>
        candidate.isBookable &&
        (shape.requiredRoomType === undefined || candidate.roomType === shape.requiredRoomType) &&
        remainingRoomPlaces({ room: candidate, period: treatment, appointments }) >= placesUsed,
    )
    .sort(compareRoomPreference)
    .at(0)
  if (room === undefined) return { kind: 'refused', reason: 'no_room_with_free_places' }

  // De-duplicated, because `appointment_therapist_no_overlap` refuses the same therapist twice over
  // one period with SQLSTATE 23P01: a "pair" that is one person listed twice is not two therapists,
  // and the failure would arrive from the booking transaction rather than from availability.
  // Ascending by id, and the comparator has no equal case on purpose: the `Set` above has already
  // removed every duplicate, so a `0` branch here would be a line no input could ever reach.
  const chosen = [...new Set(therapistIds)]
    .sort((a, b) => (a < b ? -1 : 1))
    .slice(0, shape.therapistsRequired)
  if (chosen.length < shape.therapistsRequired) {
    return { kind: 'refused', reason: 'too_few_therapists' }
  }

  return {
    kind: 'assigned',
    assignment: { shape: shape.shape, therapistIds: chosen, roomId: room.id, placesUsed },
  }
}

/**
 * Everything `solveAvailability` needs except the three figures the shape decides.
 *
 * `clients` and `therapistBufferMinutes` are deliberately **not** accepted from the caller: both are
 * read off the shape, so no caller can hand the solver a client count or a buffer that disagrees with
 * the footprint it is asking about. `compatibleRoomTypes` stays a caller's field because it is the
 * *service*'s compatibility set; the shape narrows it in `shapeSolverRequest`.
 */
export interface ShapeSlotRequest extends Omit<SlotRequest, 'clients' | 'therapistBufferMinutes'> {
  readonly shape: ResourceShape
}

/** The solver request this shape implies. The seam where assignment feeds the solver. */
export function shapeSolverRequest(request: ShapeSlotRequest): SlotRequest {
  const { shape, compatibleRoomTypes, ...rest } = request
  return {
    ...rest,
    compatibleRoomTypes: shapeRoomTypes(shape, compatibleRoomTypes),
    // The room must hold the CLIENTS — this is the capacity question `bookableRoomsFor` answers, and
    // it is not the same question as how many appointment rows the shape writes. The row count is
    // `roomPlacesRequired`, applied in `assignShape`, and each refusal keeps its own name.
    clients: shape.minRoomCapacity,
    therapistBufferMinutes: shape.therapistBufferMinutes,
  }
}

/** An offerable start with the tuple that will deliver it. */
export interface AssignedSlot extends CandidateSlot {
  readonly assignment: ShapeAssignment
}

/** Every reason a start is not offered, from either layer. */
export type ShapeRejection = SlotRejection | ShapeRefusal

export interface ShapeRejectedStart {
  readonly startsAt: Instant
  readonly reason: ShapeRejection
}

export interface ShapeSlotSolution {
  readonly slots: readonly AssignedSlot[]
  readonly rejected: readonly ShapeRejectedStart[]
  readonly windows: readonly TradingWindow[]
}

/**
 * The offerable starts for one shape, each with its concrete tuple.
 *
 * Solve, then assign, then drop what cannot be assigned. A start the solver offered but no tuple can
 * deliver is moved into `rejected` with the assignment layer's own reason rather than being silently
 * dropped, because "we have a room and a therapist free but not two therapists" is the sentence the
 * front desk needs and the one a bare absence cannot say.
 */
export function assignShapeSlots(request: ShapeSlotRequest): ShapeSlotSolution {
  const solution = solveAvailability(shapeSolverRequest(request))
  const slots: AssignedSlot[] = []
  const rejected: ShapeRejectedStart[] = [...solution.rejected]

  for (const slot of solution.slots) {
    const result = assignShape({
      shape: request.shape,
      // The room records behind the ids the solver reported. It never widens: an id the solver did not
      // report cannot appear here, whatever else is in `request.rooms`.
      rooms: request.rooms.filter((room) => slot.availableRoomIds.includes(room.id)),
      therapistIds: slot.availableTherapistIds,
      treatment: slot.treatment,
      appointments: request.appointments,
    })
    if (result.kind === 'refused') {
      rejected.push({ startsAt: slot.startsAt, reason: result.reason })
      continue
    }
    slots.push({ ...slot, assignment: result.assignment })
  }

  // Ascending, so a caller walking the rejections to explain a gap in the day does not have to sort
  // them. A start is rejected by exactly one layer, so there are no ties to break.
  return {
    slots,
    rejected: [...rejected].sort((a, b) => a.startsAt - b.startsAt),
    windows: solution.windows,
  }
}

// ------------------------------------------------------------------------------------------------
// The seam the booking transaction re-checks through
// ------------------------------------------------------------------------------------------------
//
// `packages/db` may never import `packages/core`, so B-AVAIL-06's booking transaction takes the rule
// that decides whether a tuple is still deliverable as an injected function. This is that function, and
// it lives here rather than at the call site so there is exactly one of it: an adapter written twice —
// once in the route and once in the pair test — is two rules, and the second one drifts.
//
// Its argument types are spelled in **plain epoch milliseconds** and plain string unions, which is what
// a caller on the other side of the boundary has: `Instant` is a branded number and `packages/db`
// cannot name the brand. The branding happens here, on the one side that owns it. The shapes are
// otherwise field for field those of `SlotRecheckInput` / `SlotRecheckResult` in
// `packages/db/src/repositories/create-booking.ts`, and `packages/fixtures` asserts the assignability
// with `satisfies` rather than a comment — the same arrangement `CompliancePolicyRow` has with
// `CompliancePolicy` (B-CAT-05) and `TherapistPoolRead` with `TherapistPool` (B-AVAIL-04).

/** A committed appointment as a caller outside this package spells it: epoch milliseconds, no brands. */
export interface CommittedAppointment {
  readonly id: string
  readonly roomId: string
  readonly therapistIds: readonly string[]
  /** `appointment.delivery_id` and `appointment.room_places` (0038). Required from a repository. */
  readonly delivery: { readonly id: string; readonly places: number }
  readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  readonly turnaroundMinutes: number
  readonly therapistBufferMinutes: number
}

/** Everything `assignShape` needs, as rows read inside the booking transaction. */
export interface ShapeRecheckInput {
  readonly shape: ResourceShape
  /**
   * The candidate rooms. In the booking transaction this is the ONE room that was offered, so the
   * answer is "still this room, or none" — silently moving a booking to another room would change what
   * the customer was shown after the confirmation had been rendered.
   */
  readonly rooms: readonly Room[]
  readonly therapistIds: readonly string[]
  readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  readonly appointments: readonly CommittedAppointment[]
}

export type ShapeRecheckResult =
  | {
      readonly kind: 'assigned'
      readonly roomId: string
      readonly therapistIds: readonly string[]
      readonly placesUsed: number
    }
  | { readonly kind: 'refused'; readonly reason: ShapeRefusal }

/**
 * Re-applies the assignment rule to a tuple that was offered earlier.
 *
 * A thin adapter over {@link assignShape} and deliberately not a second implementation of it: the rule
 * that decided the slot was offerable is the rule that has to decide it still is, or the booking
 * transaction would be checking something the availability query never claimed.
 */
export function recheckShapeAssignment(input: ShapeRecheckInput): ShapeRecheckResult {
  const result = assignShape({
    shape: input.shape,
    rooms: input.rooms,
    therapistIds: input.therapistIds,
    treatment: {
      startsAt: input.treatment.startsAt as Instant,
      endsAt: input.treatment.endsAt as Instant,
    },
    appointments: input.appointments.map(
      (appointment): ScheduledAppointment => ({
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
      }),
    ),
  })
  return result.kind === 'assigned'
    ? {
        kind: 'assigned',
        roomId: result.assignment.roomId,
        therapistIds: result.assignment.therapistIds,
        placesUsed: result.assignment.placesUsed,
      }
    : { kind: 'refused', reason: result.reason }
}
