/**
 * Resource-shape assignment, asserted as the three shapes the business actually sells.
 *
 * Every positive assertion here is paired with a control that must fail if the rule were implemented
 * the other way round: the therapist removed, the room's second place occupied, the preference order
 * reversed in the input, the room-places figure replaced by the client count. A test that cannot fail
 * is not a test (ADR 0003).
 *
 * Therapists are ids and never names. A therapist has no display name until an admin sets one, and the
 * form mirrors `therapistReference` in packages/fixtures, which core may not import.
 */
import { describe, expect, it } from 'vitest'
import type { HoursForDate } from '../business-day/resolve.ts'
import type { ClosedInterval } from '../business-day/windows.ts'
import {
  addMinutes,
  type Instant,
  instantFromIso,
  localDate,
  localTime,
  type TradingHours,
  toLocal,
} from '../time.ts'
import {
  assignShape,
  assignShapeSlots,
  COUPLE_MASSAGE_SHAPE,
  compareRoomPreference,
  FOUR_HANDS_SHAPE,
  MOROCCO_BATH_SHAPE,
  REAL_RESOURCE_SHAPES,
  type ResourceShape,
  ROOM_TYPE_PREFERENCE,
  remainingRoomPlaces,
  roomPlacesRequired,
  roomPlacesTaken,
  type ShapeSlotRequest,
  type ShapeSlotSolution,
  shapeRoomTypes,
  shapeSolverRequest,
} from './assign-shape.ts'
import type { Period, Room } from './room-predicates.ts'
import type { ScheduledAppointment, TherapistShift } from './solve.ts'

/** 11:00 to 02:00 — the real trading hours, and the reason a treatment may cross midnight. */
const HOURS: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const HOURS_FOR: HoursForDate = () => HOURS
const DATE = localDate('2026-10-02')

const at = (iso: string): Instant => instantFromIso(iso)
const wall = (instant: Instant): string => toLocal(instant).time
const startsOf = (solution: ShapeSlotSolution): string[] =>
  solution.slots.map((slot) => wall(slot.startsAt))
const rejectionAt = (solution: ShapeSlotSolution, time: string): string | undefined =>
  solution.rejected.find((rejected) => wall(rejected.startsAt) === time)?.reason

const period = (fromIso: string, untilIso: string): Period => ({
  startsAt: at(fromIso),
  endsAt: at(untilIso),
})

const THERAPIST_1 = 'therapist-01'
const THERAPIST_2 = 'therapist-02'
const THERAPIST_3 = 'therapist-03'
/** Held by an existing appointment and never in an eligible pool, so it occupies without competing. */
const OUTSIDE_POOL = 'therapist-99'

const STANDARD_A: Room = {
  id: 'room-standard-a',
  roomType: 'standard',
  capacity: 1,
  isBookable: true,
}
const STANDARD_B: Room = {
  id: 'room-standard-b',
  roomType: 'standard',
  capacity: 1,
  isBookable: true,
}
/**
 * A capacity-2 standard room. An owner can have one — `rooms.capacity` is data (0012) — and the seeded
 * inventory has none.
 *
 * It exists here to keep the **room preference** assertions honest, and it is deliberately no longer
 * what makes Four Hands assignable: since 0038 counts client places over distinct deliveries rather
 * than appointment rows, two therapists over one client take one place and fit in the capacity-1 rooms
 * the salon actually owns. What this room still proves is that the ranking prefers a *standard* room
 * and, among standard rooms, the smallest that fits — so a solo client does not take the two-plinth
 * room while a one-plinth room stands empty.
 */
const STANDARD_TWIN: Room = {
  id: 'room-standard-twin',
  roomType: 'standard',
  capacity: 2,
  isBookable: true,
}
const COUPLES: Room = { id: 'room-couples', roomType: 'couples', capacity: 2, isBookable: true }
const WET: Room = { id: 'room-wet', roomType: 'wet', capacity: 1, isBookable: true }
/** Decommissioned, and big enough to win every ranking if it were ever considered. */
const RETIRED: Room = {
  id: 'room-standard-retired',
  roomType: 'standard',
  capacity: 2,
  isBookable: false,
}

const ALL_ROOMS: readonly Room[] = [STANDARD_A, STANDARD_B, STANDARD_TWIN, COUPLES, WET, RETIRED]

const shift = (therapistId: string): TherapistShift => ({
  therapistId,
  // Before opening and after close, so the window rules never confound an assignment assertion.
  period: period('2026-10-02T10:30:00+04:00', '2026-10-03T02:30:00+04:00'),
})

const appointment = (args: {
  readonly id: string
  readonly roomId: string
  readonly therapistIds: readonly string[]
  readonly from: string
  readonly until: string
  readonly turnaroundMinutes?: number
  /** Omitted means "its own delivery of one client", which is what `appointment.delivery_id` defaults to. */
  readonly delivery?: { readonly id: string; readonly places: number }
}): ScheduledAppointment => ({
  id: args.id,
  roomId: args.roomId,
  therapistIds: args.therapistIds,
  treatment: period(args.from, args.until),
  turnaroundMinutes: args.turnaroundMinutes ?? 20,
  therapistBufferMinutes: 10,
  ...(args.delivery === undefined ? {} : { delivery: args.delivery }),
})

const BASE: ShapeSlotRequest = {
  // The day before the date being solved, so lead and advance never confound an assignment assertion.
  now: at('2026-10-01T12:00:00+04:00'),
  tradingDate: DATE,
  hoursFor: HOURS_FOR,
  closures: [],
  durationMinutes: 60,
  turnaroundMinutes: 20,
  minLeadMinutes: 0,
  maxAdvanceDays: 90,
  rooms: ALL_ROOMS,
  // The compatibility rows 0012 seeds for a dry massage: it may be delivered in either kind of dry
  // room, and which one it SHOULD go in is this module's decision rather than the table's.
  compatibleRoomTypes: ['standard', 'couples'],
  therapistIds: [THERAPIST_1, THERAPIST_2],
  shifts: [shift(THERAPIST_1), shift(THERAPIST_2), shift(THERAPIST_3)],
  appointments: [],
  blocks: [],
  shape: COUPLE_MASSAGE_SHAPE,
  // An hour, so the assertions are about the assignment rather than about how finely the day is diced.
  stepMinutes: 60,
}

const solve = (overrides: Partial<ShapeSlotRequest> = {}): ShapeSlotSolution =>
  assignShapeSlots({ ...BASE, ...overrides })

/** A shape with one field changed, for the controls that prove a rule is the one doing the work. */
const withShape = (shape: ResourceShape, patch: Partial<ResourceShape>): ResourceShape => ({
  ...shape,
  ...patch,
})

describe('acceptance — Couple Massage needs two therapists and both places of a capacity-2 room', () => {
  it('assigns two distinct therapists and the couples room when all three are free', () => {
    const solution = solve()
    expect(solution.slots.length).toBeGreaterThan(0)
    for (const slot of solution.slots) {
      expect(slot.assignment).toEqual({
        shape: 'couple',
        therapistIds: [THERAPIST_1, THERAPIST_2],
        roomId: COUPLES.id,
        // TWO clients, which is what the deferred trigger counts against rooms.capacity. It is also
        // two appointment rows, and for this one shape the two figures coincide — which is why the
        // Four Hands case below is the one that tells them apart.
        placesUsed: 2,
      })
    }
    // The couples room and nothing else, even though three standard rooms were offered to the solver.
    expect(new Set(solution.slots.map((slot) => slot.assignment.roomId))).toEqual(
      new Set([COUPLES.id]),
    )
  })

  it('removes every slot when the first of the two therapists is gone', () => {
    const solution = solve({ therapistIds: [THERAPIST_2] })
    expect(solution.slots).toEqual([])
    expect(rejectionAt(solution, '19:00')).toBe('too_few_therapists')
  })

  it('removes every slot when the second of the two therapists is gone', () => {
    const solution = solve({ therapistIds: [THERAPIST_1] })
    expect(solution.slots).toEqual([])
    expect(rejectionAt(solution, '19:00')).toBe('too_few_therapists')
  })

  it('removes the slot when one of the two couples-room places is already occupied', () => {
    const occupied = appointment({
      id: 'appointment-couples-single',
      roomId: COUPLES.id,
      therapistIds: [OUTSIDE_POOL],
      from: '2026-10-02T19:00:00+04:00',
      until: '2026-10-02T20:00:00+04:00',
    })

    // The assignment layer's own answer, with the room still offered to it: one place left of two.
    const treatment = period('2026-10-02T19:00:00+04:00', '2026-10-02T20:00:00+04:00')
    expect(
      remainingRoomPlaces({ room: COUPLES, period: treatment, appointments: [occupied] }),
    ).toBe(1)
    expect(
      assignShape({
        shape: COUPLE_MASSAGE_SHAPE,
        rooms: [COUPLES],
        therapistIds: [THERAPIST_1, THERAPIST_2],
        treatment,
        appointments: [occupied],
      }),
    ).toEqual({ kind: 'refused', reason: 'no_room_with_free_places' })

    // The control, and it is what makes the assertion above about *places* rather than about the room
    // being busy at all: one free place is enough for a footprint that needs one.
    const soloInADryRoom = withShape(MOROCCO_BATH_SHAPE, { requiredRoomType: 'couples' })
    expect(
      assignShape({
        shape: soloInADryRoom,
        rooms: [COUPLES],
        therapistIds: [THERAPIST_1],
        treatment,
        appointments: [occupied],
      }),
    ).toEqual({
      kind: 'assigned',
      assignment: {
        shape: 'solo',
        therapistIds: [THERAPIST_1],
        roomId: COUPLES.id,
        placesUsed: 1,
      },
    })

    // And end to end, where the solver removes the whole room for the overlap before assignment is
    // reached. Both layers refuse the 19:00 start; neither offers it.
    const solution = solve({ appointments: [occupied] })
    expect(startsOf(solution)).not.toContain('19:00')
    expect(rejectionAt(solution, '19:00')).toBe('no_room_available')
    // Non-vacuity: the rest of the day is still bookable, so the appointment removed a slot rather
    // than the fixture removing the room.
    expect(startsOf(solution)).toContain('11:00')
  })

  it('refuses a couples footprint when the only free rooms are of another type', () => {
    const solution = solve({ rooms: [STANDARD_A, STANDARD_TWIN, WET] })
    expect(solution.slots).toEqual([])
    // The solver never sees a candidate room at all: the shape narrowed the compatible types to
    // `couples`, and zero types means zero rooms, never "any room".
    expect(rejectionAt(solution, '19:00')).toBe('no_room_available')
  })
})

describe('acceptance — Four Hands puts two therapists in one room, standard for preference', () => {
  const FOUR_HANDS_BASE: Partial<ShapeSlotRequest> = {
    shape: FOUR_HANDS_SHAPE,
    therapistIds: [THERAPIST_1, THERAPIST_2],
  }

  it('assigns two therapists to a single standard room', () => {
    const solution = solve(FOUR_HANDS_BASE)
    expect(solution.slots.length).toBeGreaterThan(0)
    for (const slot of solution.slots) {
      expect(slot.assignment).toEqual({
        shape: 'four_hands',
        therapistIds: [THERAPIST_1, THERAPIST_2],
        // The smallest standard room, which since 0038 is a capacity-1 one: one client is one place
        // however many therapists work it, so the two-plinth room is left for a booking that needs it.
        roomId: STANDARD_A.id,
        // One client, one place. TWO appointment rows will be written, and that is a different number
        // — `therapistIds.length` — which is the conflation 0038 corrected.
        placesUsed: 1,
      })
      expect(slot.assignment.therapistIds).toHaveLength(2)
    }
  })

  it('selects the standard room over the capacity-2 couples room, preserving couples capacity', () => {
    // With the seeded `required_room_type`, which narrows before the ranking is consulted.
    const narrowed = solve({ ...FOUR_HANDS_BASE, rooms: [COUPLES, STANDARD_TWIN] })
    expect(narrowed.slots.length).toBeGreaterThan(0)
    expect(new Set(narrowed.slots.map((slot) => slot.assignment.roomId))).toEqual(
      new Set([STANDARD_TWIN.id]),
    )

    // And with the narrowing removed, so the scarcity ranking itself is what chooses. Without this
    // case the assertion above is satisfied by the room type filter and the preference order could be
    // reversed, absent or dead.
    const ranked = solve({
      ...FOUR_HANDS_BASE,
      shape: withShape(FOUR_HANDS_SHAPE, { requiredRoomType: undefined }),
      rooms: [COUPLES, STANDARD_TWIN],
    })
    expect(new Set(ranked.slots.map((slot) => slot.assignment.roomId))).toEqual(
      new Set([STANDARD_TWIN.id]),
    )

    // The control: the same two rooms in the opposite input order must not change the answer. A
    // preference order that was really "whatever the repository returned first" fails here.
    const reversed = solve({
      ...FOUR_HANDS_BASE,
      shape: withShape(FOUR_HANDS_SHAPE, { requiredRoomType: undefined }),
      rooms: [STANDARD_TWIN, COUPLES],
    })
    expect(reversed.slots.map((slot) => slot.assignment.roomId)).toEqual(
      ranked.slots.map((slot) => slot.assignment.roomId),
    )
  })

  it('takes a capacity-1 standard room, which is the whole seeded standard inventory', () => {
    // The regression this case exists for. Until 0038 the deferred trigger counted appointment ROWS
    // against `rooms.capacity`, so a Four Hands was two places, and every standard room 0012 seeds is
    // capacity 1 — the shape was assignable to no room the salon owns and this layer returned zero
    // slots for it. docs/13 §4 states the footprint as 2 therapists, 1 standard room, 1 CLIENT, and
    // 0012 documents `capacity` as clients, so the rows were the wrong unit.
    const solution = solve({ ...FOUR_HANDS_BASE, rooms: [STANDARD_A, STANDARD_B] })
    expect(solution.slots.length).toBeGreaterThan(0)
    for (const slot of solution.slots) {
      expect(slot.assignment.roomId).toBe(STANDARD_A.id)
      expect(slot.assignment.therapistIds).toEqual([THERAPIST_1, THERAPIST_2])
      expect(slot.assignment.placesUsed).toBe(1)
    }

    // Control 1: a capacity-1 room already holding somebody else's delivery has no free place, so the
    // assignment is refused by name. Without this the acceptance above is satisfied by a places check
    // that has stopped counting anything at all.
    const treatment = period('2026-10-02T19:00:00+04:00', '2026-10-02T20:00:00+04:00')
    const occupied = appointment({
      id: 'held',
      roomId: STANDARD_A.id,
      therapistIds: [OUTSIDE_POOL],
      from: '2026-10-02T19:00:00+04:00',
      until: '2026-10-02T20:00:00+04:00',
    })
    expect(
      assignShape({
        shape: FOUR_HANDS_SHAPE,
        rooms: [STANDARD_A],
        therapistIds: [THERAPIST_1, THERAPIST_2],
        treatment,
        appointments: [occupied],
      }),
    ).toEqual({ kind: 'refused', reason: 'no_room_with_free_places' })

    // Control 2: a COUPLE footprint — the same two therapists, two clients — is still refused by a
    // capacity-1 room. So the acceptance above is about the client count rather than about a rule that
    // stopped comparing places to capacity.
    expect(
      assignShape({
        shape: withShape(COUPLE_MASSAGE_SHAPE, { requiredRoomType: 'standard' }),
        rooms: [STANDARD_A],
        therapistIds: [THERAPIST_1, THERAPIST_2],
        treatment,
        appointments: [],
      }),
    ).toEqual({ kind: 'refused', reason: 'no_room_with_free_places' })
  })

  it('counts room places as clients, which is not the number of appointment rows', () => {
    // The corrected rule, and the two figures it is easy to conflate. Four Hands needs TWO therapists
    // — two appointment rows — and ONE place, because there is one client; the rule was
    // max(minRoomCapacity, therapistsRequired) until 0038 and that made the shape unbookable.
    expect(roomPlacesRequired(FOUR_HANDS_SHAPE)).toBe(1)
    expect(FOUR_HANDS_SHAPE.minRoomCapacity).toBe(1)
    expect(FOUR_HANDS_SHAPE.therapistsRequired).toBe(2)
    // Non-vacuity: a shape with two clients really does need two places, so the function is reading
    // `minRoomCapacity` rather than answering 1 for everything.
    expect(roomPlacesRequired(COUPLE_MASSAGE_SHAPE)).toBe(2)
    expect(roomPlacesRequired(MOROCCO_BATH_SHAPE)).toBe(1)
  })
})

describe('acceptance — Morocco Bath and the single wet room', () => {
  /**
   * The eight catalogue variants of Morocco Bath: two styles across four durations.
   *
   * Style reaches this layer only through the pool of eligible therapists — it is an attribute of the
   * treatment that maps to a required skill, never to a room (ADR 0021) — so the pools differ per
   * style here the way B-AVAIL-04 will hand them over. That a style cannot change the room assignment
   * is itself the claim worth pinning: if it could, reassigning a therapist would move the booking.
   */
  const VARIANTS = (['asian', 'arabic'] as const).flatMap((style) =>
    [45, 60, 90, 120].map((durationMinutes) => ({
      style,
      durationMinutes,
      therapistId: style === 'asian' ? THERAPIST_1 : THERAPIST_2,
    })),
  )

  const moroccoRequest = (variant: (typeof VARIANTS)[number]): Partial<ShapeSlotRequest> => ({
    shape: MOROCCO_BATH_SHAPE,
    durationMinutes: variant.durationMinutes,
    // The wet room's own turnaround: 30 minutes of cleaning, not the 20 a dry room needs.
    turnaroundMinutes: 30,
    compatibleRoomTypes: ['wet'],
    therapistIds: [variant.therapistId],
  })

  /** The wet room held for the whole session, by a therapist outside every pool above. */
  const WET_OCCUPIED: ScheduledAppointment = appointment({
    id: 'appointment-wet-all-evening',
    roomId: WET.id,
    therapistIds: [OUTSIDE_POOL],
    from: '2026-10-02T11:00:00+04:00',
    until: '2026-10-03T02:00:00+04:00',
    turnaroundMinutes: 0,
  })

  it.each(VARIANTS)(
    'offers $style Morocco Bath at $durationMinutes minutes only while the wet room is free',
    (variant) => {
      const free = solve(moroccoRequest(variant))
      expect(free.slots.length).toBeGreaterThan(0)
      for (const slot of free.slots) {
        expect(slot.assignment).toEqual({
          shape: 'solo',
          therapistIds: [variant.therapistId],
          roomId: WET.id,
          placesUsed: 1,
        })
      }

      const occupied = solve({ ...moroccoRequest(variant), appointments: [WET_OCCUPIED] })
      expect(occupied.slots).toEqual([])
      expect(rejectionAt(occupied, '19:00')).toBe('no_room_available')
    },
  )

  it('never assigns a dry room, however many are free', () => {
    // Every dry room free and large enough, and the wet room gone: zero slots rather than a substitute.
    const solution = solve({
      ...moroccoRequest(VARIANTS[0] as (typeof VARIANTS)[number]),
      rooms: [STANDARD_A, STANDARD_B, STANDARD_TWIN, COUPLES],
    })
    expect(solution.slots).toEqual([])

    // The control: the same request with the wet room present is offered, so the fixture is not simply
    // broken.
    const withWet = solve({
      ...moroccoRequest(VARIANTS[0] as (typeof VARIANTS)[number]),
      rooms: [STANDARD_A, COUPLES, WET],
    })
    expect(withWet.slots.length).toBeGreaterThan(0)
  })
})

describe('acceptance — a duration that fits no free window is offered as nothing at all', () => {
  /**
   * Two closures that leave two one-hour windows, the longest free stretch in the day being 60
   * minutes. A 120-minute treatment fits neither.
   */
  const CLOSURES: readonly ClosedInterval[] = [
    {
      startsAt: at('2026-10-02T12:00:00+04:00'),
      endsAt: at('2026-10-02T18:00:00+04:00'),
      reason: 'deep clean',
    },
    {
      startsAt: at('2026-10-02T19:00:00+04:00'),
      endsAt: at('2026-10-03T02:00:00+04:00'),
      reason: 'private hire',
    },
  ]

  it('returns zero slots and zero rejections rather than a truncated one', () => {
    const solution = solve({ closures: CLOSURES, durationMinutes: 120 })
    expect(solution.slots).toEqual([])
    // Not merely absent from `slots`: there was never a candidate to reject. A best-effort
    // implementation would have offered a start and reported a reason for shortening it.
    expect(solution.rejected).toEqual([])
    // Two windows, each an hour: 11:00-12:00 and 18:00-19:00.
    expect(solution.windows.length).toBe(2)
  })

  it('offers the same day to a treatment that does fit', () => {
    // The control. Without it the case above passes against a solver that returns nothing ever.
    const solution = solve({
      closures: CLOSURES,
      durationMinutes: 45,
      turnaroundMinutes: 0,
      stepMinutes: 15,
    })
    expect(startsOf(solution)).toContain('11:00')
    expect(solution.slots.every((slot) => slot.assignment.roomId === COUPLES.id)).toBe(true)
  })
})

describe('acceptance — the assignment is deterministic', () => {
  it('selects the same therapist ids and room id on 1000 repeat runs', () => {
    const first = solve({ therapistIds: [THERAPIST_1, THERAPIST_2, THERAPIST_3] })
    expect(first.slots.length).toBeGreaterThan(0)
    const signature = (solution: ShapeSlotSolution): string =>
      solution.slots
        .map(
          (slot) =>
            `${slot.startsAt}:${slot.assignment.roomId}:${slot.assignment.therapistIds.join(',')}`,
        )
        .join('|')
    const expected = signature(first)
    for (let run = 0; run < 1000; run += 1) {
      expect(signature(solve({ therapistIds: [THERAPIST_1, THERAPIST_2, THERAPIST_3] }))).toBe(
        expected,
      )
    }
    // In order, and the order is the ids' own: a three-therapist pool for a two-therapist shape must
    // not pick the third.
    expect(first.slots[0]?.assignment.therapistIds).toEqual([THERAPIST_1, THERAPIST_2])
  })

  it('does not depend on the order the therapists arrived in', () => {
    // The control for the run above: 1000 identical calls are also stable for an implementation that
    // simply takes the first two of whatever it was handed.
    const shuffled = solve({ therapistIds: [THERAPIST_3, THERAPIST_2, THERAPIST_1] })
    expect(shuffled.slots[0]?.assignment.therapistIds).toEqual([THERAPIST_1, THERAPIST_2])
  })

  it('never returns the same therapist twice, whatever the pool says', () => {
    // The exclusion constraint `appointment_therapist_no_overlap` refuses one therapist twice over one
    // period, so a duplicated pool must produce a refusal and not a pair of one person.
    const result = assignShape({
      shape: COUPLE_MASSAGE_SHAPE,
      rooms: [COUPLES],
      therapistIds: [THERAPIST_1, THERAPIST_1],
      treatment: period('2026-10-02T19:00:00+04:00', '2026-10-02T20:00:00+04:00'),
      appointments: [],
    })
    expect(result).toEqual({ kind: 'refused', reason: 'too_few_therapists' })
  })
})

describe('the shape narrows the solver rather than the other way round', () => {
  it('reads the client count and the therapist buffer off the shape', () => {
    const request = shapeSolverRequest({ ...BASE, shape: COUPLE_MASSAGE_SHAPE })
    expect(request.clients).toBe(2)
    expect(request.therapistBufferMinutes).toBe(COUPLE_MASSAGE_SHAPE.therapistBufferMinutes)
    expect(request.compatibleRoomTypes).toEqual(['couples'])
  })

  it('intersects the compatibility rows and never substitutes for them', () => {
    expect(shapeRoomTypes(MOROCCO_BATH_SHAPE, ['wet'])).toEqual(['wet'])
    // A required type with no compatibility row yields nothing. The permissive reading — fall back to
    // every compatible type — would put a Morocco Bath in a dry room the first time a row was missing.
    expect(shapeRoomTypes(MOROCCO_BATH_SHAPE, ['standard', 'couples'])).toEqual([])
    // A shape with no narrowing passes the service's own set through untouched.
    expect(
      shapeRoomTypes(withShape(FOUR_HANDS_SHAPE, { requiredRoomType: undefined }), [
        'standard',
        'couples',
      ]),
    ).toEqual(['standard', 'couples'])
  })

  it("still reports the solver's own rejection reasons", () => {
    const lead = solve({
      now: at('2026-10-02T17:00:00+04:00'),
      minLeadMinutes: 120,
      stepMinutes: 60,
    })
    expect(rejectionAt(lead, '18:00')).toBe('before_minimum_lead')
    expect(startsOf(lead)).toContain('19:00')

    // Two trading dates ahead of `now`'s own, against a one-day horizon.
    const advance = solve({ now: at('2026-09-30T12:00:00+04:00'), maxAdvanceDays: 1 })
    expect(rejectionAt(advance, '19:00')).toBe('beyond_maximum_advance')
    expect(advance.slots).toEqual([])
  })

  it('leaves the rejections ascending after the two layers are merged', () => {
    const solution = solve({
      now: at('2026-10-02T17:00:00+04:00'),
      minLeadMinutes: 120,
      therapistIds: [THERAPIST_1],
      stepMinutes: 60,
    })
    // Both layers contributed: the early starts are inside the lead, the late ones have one therapist.
    expect(new Set(solution.rejected.map((rejected) => rejected.reason))).toEqual(
      new Set(['before_minimum_lead', 'too_few_therapists']),
    )
    expect(solution.rejected.map((rejected) => rejected.startsAt)).toEqual(
      [...solution.rejected].sort((a, b) => a.startsAt - b.startsAt).map((r) => r.startsAt),
    )
  })

  it('never widens the rooms the solver reported free', () => {
    // A decommissioned room is refused even when handed straight to the assignment layer, because
    // B-AVAIL-06 calls it again inside the booking transaction with no solver in the call stack.
    expect(
      assignShape({
        shape: withShape(FOUR_HANDS_SHAPE, { requiredRoomType: undefined }),
        rooms: [RETIRED],
        therapistIds: [THERAPIST_1, THERAPIST_2],
        treatment: period('2026-10-02T19:00:00+04:00', '2026-10-02T20:00:00+04:00'),
        appointments: [],
      }),
    ).toEqual({ kind: 'refused', reason: 'no_room_with_free_places' })
  })
})

describe('room places are a peak, exactly as the SQL counts them', () => {
  const ROOM_ID = COUPLES.id
  /** One evening, two appointments at different times. Nobody is ever in the room twice over. */
  const EVENING: readonly ScheduledAppointment[] = [
    appointment({
      id: 'appointment-early',
      roomId: ROOM_ID,
      therapistIds: [THERAPIST_1],
      from: '2026-10-02T22:00:00+04:00',
      until: '2026-10-03T00:00:00+04:00',
    }),
    appointment({
      id: 'appointment-late',
      roomId: ROOM_ID,
      therapistIds: [THERAPIST_2],
      from: '2026-10-03T01:00:00+04:00',
      until: '2026-10-03T01:30:00+04:00',
    }),
  ]

  it('counts one, not two, for a long candidate spanning both of them', () => {
    // The naive count — appointments overlapping the candidate — is 2 here, and would refuse a
    // capacity-2 room that is never holding more than one person. This is the case
    // room_peak_concurrency's comment in 0024 is written about.
    const spanning = period('2026-10-02T21:00:00+04:00', '2026-10-03T02:00:00+04:00')
    expect(roomPlacesTaken({ roomId: ROOM_ID, period: spanning, appointments: EVENING })).toBe(1)
    expect(remainingRoomPlaces({ room: COUPLES, period: spanning, appointments: EVENING })).toBe(1)
  })

  it('counts two when two appointments really do overlap', () => {
    const doubled: readonly ScheduledAppointment[] = [
      ...EVENING,
      appointment({
        id: 'appointment-alongside',
        roomId: ROOM_ID,
        therapistIds: [THERAPIST_3],
        from: '2026-10-02T22:30:00+04:00',
        until: '2026-10-02T23:30:00+04:00',
      }),
    ]
    const inside = period('2026-10-02T22:30:00+04:00', '2026-10-02T23:00:00+04:00')
    expect(roomPlacesTaken({ roomId: ROOM_ID, period: inside, appointments: doubled })).toBe(2)
    expect(remainingRoomPlaces({ room: COUPLES, period: inside, appointments: doubled })).toBe(0)
  })

  it('ignores appointments in other rooms and outside the candidate period', () => {
    const elsewhere = appointment({
      id: 'appointment-elsewhere',
      roomId: STANDARD_A.id,
      therapistIds: [THERAPIST_3],
      from: '2026-10-02T19:00:00+04:00',
      until: '2026-10-02T20:00:00+04:00',
    })
    const quiet = period('2026-10-02T19:00:00+04:00', '2026-10-02T20:00:00+04:00')
    expect(
      roomPlacesTaken({ roomId: ROOM_ID, period: quiet, appointments: [...EVENING, elsewhere] }),
    ).toBe(0)
  })

  it('counts an appointment already in progress at the candidate start', () => {
    // The window's own lower bound is one of the measured instants, which is what catches a treatment
    // that began before the candidate and has not finished.
    const later = period('2026-10-02T23:00:00+04:00', '2026-10-02T23:30:00+04:00')
    expect(roomPlacesTaken({ roomId: ROOM_ID, period: later, appointments: EVENING })).toBe(1)
  })

  it('counts the two rows of one delivery as one place, and two deliveries as two', () => {
    const treatment = period('2026-10-02T19:00:00+04:00', '2026-10-02T20:00:00+04:00')
    const seat = (seatIndex: number, deliveryId: string): ScheduledAppointment =>
      appointment({
        id: `four-hands-row-${deliveryId}-${seatIndex}`,
        roomId: ROOM_ID,
        therapistIds: [`${OUTSIDE_POOL}-${deliveryId}-${seatIndex}`],
        from: '2026-10-02T19:00:00+04:00',
        until: '2026-10-02T20:00:00+04:00',
        delivery: { id: deliveryId, places: 1 },
      })

    // A committed Four Hands: two appointment rows, one delivery, ONE client in the room. This is the
    // case that under-counted before 0038 — it was two records and therefore two places — and the
    // consequence was a capacity-2 room reporting no free place for a solo client who fitted.
    const oneFourHands = [seat(0, 'delivery-a'), seat(1, 'delivery-a')]
    expect(
      roomPlacesTaken({ roomId: ROOM_ID, period: treatment, appointments: oneFourHands }),
    ).toBe(1)
    expect(
      remainingRoomPlaces({ room: COUPLES, period: treatment, appointments: oneFourHands }),
    ).toBe(1)

    // The control: two SEPARATE deliveries of one client each fill the same capacity-2 room, so the 1
    // above is the grouping and not a function that has stopped counting past one.
    const twoDeliveries = [seat(0, 'delivery-a'), seat(1, 'delivery-a'), seat(0, 'delivery-b')]
    expect(
      roomPlacesTaken({ roomId: ROOM_ID, period: treatment, appointments: twoDeliveries }),
    ).toBe(2)
    expect(
      remainingRoomPlaces({ room: COUPLES, period: treatment, appointments: twoDeliveries }),
    ).toBe(0)

    // And a delivery that says it holds two clients — a committed Couple Massage — fills the room on
    // its own, so `places` is read rather than assumed to be 1.
    const couple = [
      { ...seat(0, 'delivery-c'), delivery: { id: 'delivery-c', places: 2 } },
      { ...seat(1, 'delivery-c'), delivery: { id: 'delivery-c', places: 2 } },
    ]
    expect(roomPlacesTaken({ roomId: ROOM_ID, period: treatment, appointments: couple })).toBe(2)
  })
})

describe('the room preference order is total and stable', () => {
  it('ranks standard before couples before wet', () => {
    expect(ROOM_TYPE_PREFERENCE.standard).toBeLessThan(ROOM_TYPE_PREFERENCE.couples)
    expect(ROOM_TYPE_PREFERENCE.couples).toBeLessThan(ROOM_TYPE_PREFERENCE.wet)
    expect(compareRoomPreference(STANDARD_TWIN, COUPLES)).toBeLessThan(0)
    expect(compareRoomPreference(WET, COUPLES)).toBeGreaterThan(0)
  })

  it('prefers the smallest room of a type that still fits, then the id', () => {
    // A solo client in the capacity-2 standard room while a capacity-1 one stands empty wastes the
    // place a second booking would have needed.
    expect(compareRoomPreference(STANDARD_A, STANDARD_TWIN)).toBeLessThan(0)
    expect(compareRoomPreference(STANDARD_A, STANDARD_B)).toBeLessThan(0)
    expect(compareRoomPreference(STANDARD_B, STANDARD_A)).toBeGreaterThan(0)
    // Reflexive, so `sort` is stable and a room list containing one room twice cannot reorder itself.
    expect(compareRoomPreference(STANDARD_A, STANDARD_A)).toBe(0)
  })
})

describe('the three real shapes, and a footprint this layer refuses to guess at', () => {
  it('is three shapes and not four', () => {
    expect(REAL_RESOURCE_SHAPES).toHaveLength(3)
    expect(REAL_RESOURCE_SHAPES.map((shape) => shape.shape)).toEqual([
      'couple',
      'four_hands',
      'solo',
    ])
    // Every one is delivered in a single room, which is what makes the `roomsRequired` guard below a
    // guard rather than a restriction.
    expect(REAL_RESOURCE_SHAPES.every((shape) => shape.roomsRequired === 1)).toBe(true)
  })

  it('refuses a footprint asking for more than one room', () => {
    const twoRooms = withShape(COUPLE_MASSAGE_SHAPE, { roomsRequired: 2 })
    expect(() =>
      assignShape({
        shape: twoRooms,
        rooms: [COUPLES],
        therapistIds: [THERAPIST_1, THERAPIST_2],
        treatment: period('2026-10-02T19:00:00+04:00', '2026-10-02T20:00:00+04:00'),
        appointments: [],
      }),
    ).toThrow(/assigns one room/)
  })

  it.each([
    { field: 'therapistsRequired' as const, value: 0, message: /at least one therapist/ },
    { field: 'therapistsRequired' as const, value: 1.5, message: /at least one therapist/ },
    { field: 'minRoomCapacity' as const, value: 0, message: /at least one client/ },
    { field: 'minRoomCapacity' as const, value: 1.5, message: /at least one client/ },
  ])('refuses $field of $value', ({ field, value, message }) => {
    expect(() =>
      assignShape({
        shape: withShape(COUPLE_MASSAGE_SHAPE, { [field]: value }),
        rooms: [COUPLES],
        therapistIds: [THERAPIST_1, THERAPIST_2],
        treatment: period('2026-10-02T19:00:00+04:00', '2026-10-02T20:00:00+04:00'),
        appointments: [],
      }),
    ).toThrow(message)
  })

  it('pins the three footprints to the rows 0017 seeded', () => {
    expect(COUPLE_MASSAGE_SHAPE).toEqual({
      shape: 'couple',
      therapistsRequired: 2,
      roomsRequired: 1,
      minRoomCapacity: 2,
      requiredRoomType: 'couples',
      therapistBufferMinutes: 10,
    })
    expect(FOUR_HANDS_SHAPE).toEqual({
      shape: 'four_hands',
      therapistsRequired: 2,
      roomsRequired: 1,
      minRoomCapacity: 1,
      requiredRoomType: 'standard',
      therapistBufferMinutes: 10,
    })
    expect(MOROCCO_BATH_SHAPE).toEqual({
      shape: 'solo',
      therapistsRequired: 1,
      roomsRequired: 1,
      minRoomCapacity: 1,
      requiredRoomType: 'wet',
      therapistBufferMinutes: 10,
    })
  })
})

describe("the therapist buffer is the shape's and the turnaround is the service's", () => {
  it('holds the therapist either side and the room afterwards, from two different figures', () => {
    const solution = solve({ stepMinutes: 60 })
    const slot = solution.slots[0]
    expect(wall(slot?.startsAt as Instant)).toBe('11:00')
    // Room: start .. end + 20 (the service's turnaround). Therapist: start - 10 .. end + 10.
    expect(wall(slot?.roomPeriod.endsAt as Instant)).toBe('12:20')
    expect(wall(slot?.therapistPeriod.startsAt as Instant)).toBe('10:50')
    expect(wall(slot?.therapistPeriod.endsAt as Instant)).toBe('12:10')

    // Swapping the two figures moves a different boundary, which a conflated implementation could not
    // do: a 30-minute buffer on the shape and no turnaround on the service.
    const swapped = solve({
      stepMinutes: 60,
      turnaroundMinutes: 0,
      shape: withShape(COUPLE_MASSAGE_SHAPE, { therapistBufferMinutes: 30 }),
    })
    const other = swapped.slots[0]
    expect(wall(other?.roomPeriod.endsAt as Instant)).toBe('12:00')
    expect(wall(other?.therapistPeriod.endsAt as Instant)).toBe('12:30')
  })

  it('keeps a shift that ends mid-treatment from producing an assignment', () => {
    // The therapist interval must be covered without a gap, buffer included. 23:00 + 60 + 10 = 00:10,
    // ten minutes past a shift that ends at midnight.
    const endsAtMidnight: TherapistShift[] = [THERAPIST_1, THERAPIST_2].map((therapistId) => ({
      therapistId,
      period: period('2026-10-02T10:30:00+04:00', '2026-10-03T00:00:00+04:00'),
    }))
    const solution = solve({ shifts: endsAtMidnight, stepMinutes: 60 })
    expect(startsOf(solution)).not.toContain('23:00')
    expect(startsOf(solution)).toContain('22:00')
    expect(rejectionAt(solution, '23:00')).toBe('no_therapist_available')
  })

  it('never lets a room be chosen while an overlapping turnaround still holds it', () => {
    // The room is busy for the previous booking's own turnaround, not this one's: 30 minutes snapshotted
    // onto the appointment, so 19:00 + 60 + 30 = 20:30 and the 20:00 start is gone.
    const previous = appointment({
      id: 'appointment-previous',
      roomId: COUPLES.id,
      therapistIds: [OUTSIDE_POOL],
      from: '2026-10-02T19:00:00+04:00',
      until: '2026-10-02T20:00:00+04:00',
      turnaroundMinutes: 30,
    })
    const solution = solve({ appointments: [previous], stepMinutes: 30 })
    expect(startsOf(solution)).not.toContain('20:00')
    expect(startsOf(solution)).toContain('20:30')
  })
})

describe('an assignment is offered on every start it is offered for', () => {
  it('carries a tuple on every slot and a reason on every rejection', () => {
    const solution = solve({
      now: at('2026-10-02T17:00:00+04:00'),
      minLeadMinutes: 120,
      stepMinutes: 30,
    })
    expect(solution.slots.length).toBeGreaterThan(0)
    expect(solution.rejected.length).toBeGreaterThan(0)
    for (const slot of solution.slots) {
      expect(slot.assignment.therapistIds).toHaveLength(2)
      expect(new Set(slot.assignment.therapistIds).size).toBe(2)
      expect(slot.availableRoomIds).toContain(slot.assignment.roomId)
      expect(addMinutes(slot.startsAt, 60)).toBe(slot.treatment.endsAt)
    }
    for (const rejected of solution.rejected) {
      expect(typeof rejected.reason).toBe('string')
    }
  })
})
