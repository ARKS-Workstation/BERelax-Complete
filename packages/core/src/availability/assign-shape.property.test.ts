/**
 * The assignment invariants, over randomised therapist pools and room inventories.
 *
 * One statement carries this file, and it is the one the manifest asks for: **a shape requiring two
 * therapists never returns a partial assignment.** `therapistIds.length` is 0 or exactly
 * `therapistsRequired`, never one of two. Partial is the dangerous answer rather than the absent one —
 * the slot is offered, the customer books, and the missing pair of hands is discovered on the floor.
 *
 * Alongside it, everything else that has to be true of a tuple before the database will accept it:
 *
 *   - the two therapists are **distinct** (`appointment_therapist_no_overlap`, SQLSTATE 23P01);
 *   - both therapists and the room were reported free by the solver — assignment narrows, never widens;
 *   - the room is bookable and of a type the shape and the service's compatibility rows both allow;
 *   - `placesUsed` is the number of appointment **rows**, and the room's peak occupancy plus those rows
 *     does not exceed `rooms.capacity` (`appointment_room_capacity`, the deferred trigger of 0024).
 *
 * ## The oracle is written independently
 *
 * Every check below re-derives its figure with plain arithmetic over the generated sample — the room's
 * peak occupancy is counted out here rather than through `roomPlacesTaken`, and the allowed room types
 * are intersected here rather than through `shapeRoomTypes`. An oracle expressed in terms of the
 * functions it is checking proves the module is self-consistent, which is not the question.
 *
 * ## Cost
 *
 * The trading windows are precomputed outside the property and everything generated inside it is an
 * offset in minutes from a precomputed opening instant. B-AVAIL-02's property test learned that the
 * hard way: building windows inside the property called `Intl` four million times and timed out.
 *
 * ## The checker is proved able to fail
 *
 * Three mutants at the bottom — a half-filled pair, a pair that is one therapist listed twice, and a
 * room with one place too few — are run through the same checks, which must report each of them. A
 * property suite whose oracle cannot fail asserts nothing, however many cases it runs.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { horizonDates } from '../business-day/horizon.ts'
import { type HoursForDate, tradingBounds } from '../business-day/resolve.ts'
import {
  addMinutes,
  type Instant,
  instantFromIso,
  type LocalDate,
  localDate,
  localTime,
  type TradingHours,
} from '../time.ts'
import {
  type AssignedSlot,
  assignShapeSlots,
  COUPLE_MASSAGE_SHAPE,
  FOUR_HANDS_SHAPE,
  REAL_RESOURCE_SHAPES,
  type ResourceShape,
  type ShapeAssignment,
  type ShapeSlotRequest,
} from './assign-shape.ts'
import type { ResourceBlock, Room, RoomType } from './room-predicates.ts'
import type { ScheduledAppointment, TherapistShift } from './solve.ts'

const HOURS: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const HOURS_FOR: HoursForDate = () => HOURS

/** Midday inside a session, so `now` resolves to a trading date rather than to the daytime gap. */
const NOW: Instant = instantFromIso('2026-09-30T12:00:00+04:00')
const DATES: readonly LocalDate[] = horizonDates(localDate('2026-10-01'), 5)
const SESSIONS = DATES.map((date) => ({ date, ...tradingBounds(date, HOURS) }))

/** Ids, never names. A therapist has no display name until an admin sets one. */
const THERAPIST_IDS = ['therapist-01', 'therapist-02', 'therapist-03', 'therapist-04']

/**
 * The room inventory, with generated capacities.
 *
 * `minCapacity` keeps the generated data legal against the database rather than merely plausible:
 * 0012's `rooms_couples_holds_two` refuses any couples room below capacity 2, so a generated capacity-1
 * couples room is a row that cannot exist and an invariant proved over it would prove nothing.
 */
const ROOM_TEMPLATES: readonly {
  id: string
  roomType: RoomType
  minCapacity: number
  isBookable: boolean
}[] = [
  { id: 'room-standard-a', roomType: 'standard', minCapacity: 1, isBookable: true },
  { id: 'room-standard-b', roomType: 'standard', minCapacity: 1, isBookable: true },
  { id: 'room-couples', roomType: 'couples', minCapacity: 2, isBookable: true },
  { id: 'room-wet', roomType: 'wet', minCapacity: 1, isBookable: true },
  // Decommissioned, and generated large, so it wins every ranking it is ever wrongly offered to.
  { id: 'room-standard-retired', roomType: 'standard', minCapacity: 3, isBookable: false },
]

/** The three compatibility sets 0012 actually seeds, plus the union, so narrowing has work to do. */
const COMPAT_SETS: readonly (readonly RoomType[])[] = [
  ['standard', 'couples'],
  ['wet'],
  ['standard', 'couples', 'wet'],
]

const generated = fc.record({
  shapeIndex: fc.integer({ min: 0, max: REAL_RESOURCE_SHAPES.length - 1 }),
  dateIndex: fc.integer({ min: 0, max: SESSIONS.length - 1 }),
  compatIndex: fc.integer({ min: 0, max: COMPAT_SETS.length - 1 }),
  // `required_room_type` is a nullable column, so an admin may clear it. The invariants must hold
  // either way, and with it cleared the room *ranking* rather than the narrowing does the choosing.
  keepRequiredRoomType: fc.boolean(),
  durationMinutes: fc.constantFrom(45, 60, 90, 120),
  turnaroundMinutes: fc.constantFrom(0, 20, 30),
  stepMinutes: fc.constantFrom(30, 60),
  minLeadMinutes: fc.constantFrom(0, 120),
  maxAdvanceDays: fc.constantFrom(1, 7, 90),
  // The pool, and the point of the file: possibly empty, possibly one short, possibly duplicated.
  pool: fc.array(fc.integer({ min: 0, max: THERAPIST_IDS.length - 1 }), { maxLength: 5 }),
  capacities: fc.array(fc.constantFrom(1, 2, 3), {
    minLength: ROOM_TEMPLATES.length,
    maxLength: ROOM_TEMPLATES.length,
  }),
  appointments: fc.array(
    fc.record({
      startOffset: fc.integer({ min: 0, max: 840 }),
      durationMinutes: fc.constantFrom(45, 60, 90, 120),
      turnaroundMinutes: fc.constantFrom(0, 20, 30),
      therapistBufferMinutes: fc.constantFrom(0, 10),
      roomIndex: fc.integer({ min: 0, max: ROOM_TEMPLATES.length - 1 }),
      therapistIndex: fc.integer({ min: 0, max: THERAPIST_IDS.length - 1 }),
      // A second therapist on the row, so an existing two-therapist delivery occupies the way one does.
      pairIndex: fc.option(fc.integer({ min: 0, max: THERAPIST_IDS.length - 1 }), {
        nil: undefined,
      }),
    }),
    { maxLength: 3 },
  ),
  blocks: fc.array(
    fc.record({
      startOffset: fc.integer({ min: 0, max: 840 }),
      durationMinutes: fc.constantFrom(30, 120),
      roomIndex: fc.integer({ min: 0, max: ROOM_TEMPLATES.length - 1 }),
    }),
    { maxLength: 2 },
  ),
  shifts: fc.array(
    fc.record({
      startOffset: fc.integer({ min: -30, max: 120 }),
      breakStart: fc.integer({ min: 120, max: 540 }),
      breakMinutes: fc.constantFrom(0, 30, 60),
      endOffset: fc.integer({ min: 600, max: 960 }),
    }),
    { minLength: THERAPIST_IDS.length, maxLength: THERAPIST_IDS.length },
  ),
})

/**
 * The generated sample, taken from the arbitrary rather than declared beside it.
 *
 * Declaring it twice is how a generator and the checker that reads it drift apart: a field added to one
 * and not the other typechecks for as long as the reader never looks at it.
 */
type Generated = typeof generated extends fc.Arbitrary<infer T> ? T : never

const roomsFrom = (sample: Generated): Room[] =>
  ROOM_TEMPLATES.map((template, index) => ({
    id: template.id,
    roomType: template.roomType,
    capacity: Math.max(template.minCapacity, sample.capacities[index] as number),
    isBookable: template.isBookable,
  }))

const shapeFrom = (sample: Generated): ResourceShape => {
  const shape = REAL_RESOURCE_SHAPES[sample.shapeIndex] as ResourceShape
  return sample.keepRequiredRoomType ? shape : { ...shape, requiredRoomType: undefined }
}

function shiftsFrom(sample: Generated, opensAt: Instant): TherapistShift[] {
  const shifts: TherapistShift[] = []
  sample.shifts.forEach((spec, index) => {
    const therapistId = THERAPIST_IDS[index] as string
    const start = addMinutes(opensAt, spec.startOffset)
    const end = addMinutes(opensAt, spec.endOffset)
    // A break splits the roster into two rows with a real gap between them, so the solver's
    // "covered without a gap" rule has something to catch before assignment is ever reached.
    if (spec.breakMinutes === 0 || spec.breakStart + spec.breakMinutes >= spec.endOffset) {
      shifts.push({ therapistId, period: { startsAt: start, endsAt: end } })
      return
    }
    shifts.push({
      therapistId,
      period: { startsAt: start, endsAt: addMinutes(opensAt, spec.breakStart) },
    })
    shifts.push({
      therapistId,
      period: {
        startsAt: addMinutes(opensAt, spec.breakStart + spec.breakMinutes),
        endsAt: end,
      },
    })
  })
  return shifts
}

function requestFrom(sample: Generated): ShapeSlotRequest {
  const session = SESSIONS[sample.dateIndex] as (typeof SESSIONS)[number]
  const rooms = roomsFrom(sample)
  const appointments: ScheduledAppointment[] = sample.appointments.map((spec, index) => ({
    id: `appointment-${index}`,
    roomId: (rooms[spec.roomIndex] as Room).id,
    therapistIds:
      spec.pairIndex === undefined
        ? [THERAPIST_IDS[spec.therapistIndex] as string]
        : [THERAPIST_IDS[spec.therapistIndex] as string, THERAPIST_IDS[spec.pairIndex] as string],
    treatment: {
      startsAt: addMinutes(session.opensAt, spec.startOffset),
      endsAt: addMinutes(session.opensAt, spec.startOffset + spec.durationMinutes),
    },
    turnaroundMinutes: spec.turnaroundMinutes,
    therapistBufferMinutes: spec.therapistBufferMinutes,
  }))
  const blocks: ResourceBlock[] = sample.blocks.map((spec) => ({
    roomId: (rooms[spec.roomIndex] as Room).id,
    period: {
      startsAt: addMinutes(session.opensAt, spec.startOffset),
      endsAt: addMinutes(session.opensAt, spec.startOffset + spec.durationMinutes),
    },
    kind: 'maintenance',
    reason: 'generated',
  }))
  return {
    now: NOW,
    tradingDate: session.date,
    hoursFor: HOURS_FOR,
    closures: [],
    durationMinutes: sample.durationMinutes,
    turnaroundMinutes: sample.turnaroundMinutes,
    minLeadMinutes: sample.minLeadMinutes,
    maxAdvanceDays: sample.maxAdvanceDays,
    rooms,
    compatibleRoomTypes: COMPAT_SETS[sample.compatIndex] as readonly RoomType[],
    therapistIds: sample.pool.map((index) => THERAPIST_IDS[index] as string),
    shifts: shiftsFrom(sample, session.opensAt),
    appointments,
    blocks,
    shape: shapeFrom(sample),
    stepMinutes: sample.stepMinutes,
  }
}

// --- the oracle, written without the functions under test -----------------------------------------

/** A span of plain epoch milliseconds, so the arithmetic can be written out rather than branded. */
interface Span {
  readonly startsAt: number
  readonly endsAt: number
}

/**
 * The peak number of appointment rows in one room over `period`, counted out here.
 *
 * Deliberately not `roomPlacesTaken`: this is the figure the deferred trigger of 0024 computes at
 * COMMIT, and checking the module against itself would pass for any consistent wrong answer. Measured
 * at the period's own start and at every row start inside it, which for half-open intervals is where a
 * maximum is always attained.
 */
function peakRowsIn(roomId: string, period: Span, appointments: readonly ScheduledAppointment[]) {
  const rows: Span[] = appointments
    .filter((appointment) => appointment.roomId === roomId)
    .map((appointment) => appointment.treatment)
  const instants = [
    period.startsAt,
    ...rows.map((row) => row.startsAt).filter((at) => at >= period.startsAt && at < period.endsAt),
  ]
  return instants.reduce((peak, at) => {
    const concurrent = rows.filter((row) => row.startsAt <= at && at < row.endsAt).length
    return concurrent > peak ? concurrent : peak
  }, 0)
}

/** The room types the shape and the service's compatibility rows both allow, intersected here. */
function allowedTypes(request: ShapeSlotRequest): RoomType[] {
  const required = request.shape.requiredRoomType
  return required === undefined
    ? [...request.compatibleRoomTypes]
    : request.compatibleRoomTypes.filter((roomType) => roomType === required)
}

/** Every way an assignment can be wrong, as a list of complaints. Empty means the tuple is sound. */
function assignmentFaults(args: {
  readonly slot: AssignedSlot
  readonly assignment: ShapeAssignment
  readonly request: ShapeSlotRequest
}): string[] {
  const { slot, assignment, request } = args
  const shape = request.shape
  const faults: string[] = []

  // The statement this file exists for. Not `>= required`: an assignment that over-filled the pair
  // would write a third appointment row the room has no place for.
  if (assignment.therapistIds.length !== shape.therapistsRequired) {
    faults.push(
      `assigned ${assignment.therapistIds.length} therapists for a shape requiring ${shape.therapistsRequired}`,
    )
  }
  if (new Set(assignment.therapistIds).size !== assignment.therapistIds.length) {
    faults.push('the same therapist assigned twice')
  }
  for (const therapistId of assignment.therapistIds) {
    if (!slot.availableTherapistIds.includes(therapistId)) {
      faults.push(`${therapistId} was not reported free for this start`)
    }
  }

  if (!slot.availableRoomIds.includes(assignment.roomId)) {
    faults.push(`${assignment.roomId} was not reported free for this start`)
  }
  const room = request.rooms.find((candidate) => candidate.id === assignment.roomId)
  if (room === undefined) {
    faults.push(`${assignment.roomId} is not in the inventory`)
    return faults
  }
  if (!room.isBookable) faults.push(`${room.id} is decommissioned`)
  if (!allowedTypes(request).includes(room.roomType)) {
    faults.push(`${room.id} is a ${room.roomType} room, which this shape may not use`)
  }

  // One appointment row per therapist, so the places a delivery consumes is the therapist count when
  // that is the larger figure — Four Hands is one client and two rows.
  const rows = Math.max(shape.minRoomCapacity, shape.therapistsRequired)
  if (assignment.placesUsed !== rows) {
    faults.push(`placesUsed is ${assignment.placesUsed} where the shape writes ${rows} rows`)
  }
  const peak = peakRowsIn(room.id, slot.treatment, request.appointments)
  if (peak + rows > room.capacity) {
    faults.push(
      `${room.id} would hold ${peak + rows} rows at once against a capacity of ${room.capacity}`,
    )
  }
  return faults
}

describe('property — an assignment is complete, distinct and deliverable, or it does not exist', () => {
  it('holds over 5,000 generated pools and inventories', () => {
    let assigned = 0
    let emptyRuns = 0
    let twoTherapistRuns = 0
    fc.assert(
      fc.property(generated, (sample) => {
        const request = requestFrom(sample)
        const solution = assignShapeSlots(request)
        assigned += solution.slots.length
        if (solution.slots.length === 0) emptyRuns += 1
        if (request.shape.therapistsRequired === 2 && solution.slots.length > 0) {
          twoTherapistRuns += 1
        }
        for (const slot of solution.slots) {
          const faults = assignmentFaults({ slot, assignment: slot.assignment, request })
          // Thrown rather than returned false: fast-check prints the message beside the shrunk
          // counterexample, and "an assignment was wrong" without saying how is a day's work.
          if (faults.length > 0) {
            throw new Error(
              `slot at ${slot.startsAt} on ${request.tradingDate}: ${faults.join('; ')}`,
            )
          }
        }
        // Ascending and unique, both for the slots and for the merged rejections, so a caller may walk
        // either without sorting.
        const ascending = (values: readonly number[]): boolean =>
          values.every((value, index) => index === 0 || value >= (values[index - 1] as number))
        return (
          solution.slots.every(
            (slot, index) =>
              index === 0 || slot.startsAt > (solution.slots[index - 1] as AssignedSlot).startsAt,
          ) && ascending(solution.rejected.map((rejected) => rejected.startsAt))
        )
      }),
      { numRuns: 5_000 },
    )
    // Non-vacuity, in three directions: a property over an empty result set asserts nothing, a
    // generator that always fills the day never exercises the refusals, and the statement is about
    // two-therapist shapes in particular.
    expect(assigned).toBeGreaterThan(5_000)
    expect(emptyRuns).toBeGreaterThan(0)
    expect(twoTherapistRuns).toBeGreaterThan(0)
  }, 120_000)

  it('returns the identical answer on a second run over the same input', () => {
    fc.assert(
      fc.property(generated, (sample) => {
        const first = assignShapeSlots(requestFrom(sample))
        const second = assignShapeSlots(requestFrom(sample))
        expect(second.slots.map((slot) => slot.assignment)).toEqual(
          first.slots.map((slot) => slot.assignment),
        )
        return true
      }),
      { numRuns: 500 },
    )
  }, 60_000)
})

describe('the oracle can fail', () => {
  /** A day with room to spare, so an honest solution exists for the mutants to be measured against. */
  const sample: Generated = {
    shapeIndex: 0,
    dateIndex: 0,
    compatIndex: 2,
    keepRequiredRoomType: true,
    durationMinutes: 60,
    turnaroundMinutes: 20,
    stepMinutes: 60,
    minLeadMinutes: 0,
    maxAdvanceDays: 90,
    pool: [0, 1, 2],
    capacities: [1, 1, 2, 1, 3],
    appointments: [],
    blocks: [],
    shifts: THERAPIST_IDS.map(() => ({
      startOffset: -30,
      breakStart: 300,
      breakMinutes: 0 as const,
      endOffset: 960,
    })),
  }

  const honest = requestFrom(sample)

  /** The mutant's tuple, dropped onto a real slot so every other field stays sound. */
  const faultsOfMutant = (
    request: ShapeSlotRequest,
    mutate: (assignment: ShapeAssignment) => ShapeAssignment,
  ): string[] => {
    const solution = assignShapeSlots(request)
    expect(solution.slots.length).toBeGreaterThan(0)
    return solution.slots.flatMap((slot) =>
      assignmentFaults({ slot, assignment: mutate(slot.assignment), request }),
    )
  }

  it('reports the honest Couple Massage assignment as sound', () => {
    // The control. Without it the three mutants below are satisfied by a checker that complains about
    // everything.
    expect(faultsOfMutant(honest, (assignment) => assignment)).toEqual([])
    expect(honest.shape).toEqual(COUPLE_MASSAGE_SHAPE)
  })

  it('reports a pair that is one therapist short', () => {
    const faults = faultsOfMutant(honest, (assignment) => ({
      ...assignment,
      therapistIds: assignment.therapistIds.slice(0, 1),
    }))
    expect(faults.some((fault) => fault.startsWith('assigned 1 therapists'))).toBe(true)
  })

  it('reports a pair that is one therapist listed twice', () => {
    const first = THERAPIST_IDS[0] as string
    const faults = faultsOfMutant(honest, (assignment) => ({
      ...assignment,
      therapistIds: [first, first],
    }))
    expect(faults).toContain('the same therapist assigned twice')
  })

  it('reports a Four Hands put in a room with one place too few', () => {
    // The capacity-1 standard room the solver legitimately offers a Four Hands — its `clients` figure
    // is 1 — and which the database refuses the second appointment row in with `room_over_capacity`.
    const fourHands = requestFrom({ ...sample, shapeIndex: 1 })
    expect(fourHands.shape).toEqual(FOUR_HANDS_SHAPE)
    const single = fourHands.rooms.find(
      (room) => room.roomType === 'standard' && room.capacity === 1,
    ) as Room
    const faults = faultsOfMutant(
      // The honest module assigns nothing here, so the mutant is measured on a request whose inventory
      // does hold a large enough room — and then moved into the small one.
      {
        ...fourHands,
        rooms: [...fourHands.rooms, { ...single, id: 'room-standard-twin', capacity: 2 }],
      },
      (assignment) => ({ ...assignment, roomId: single.id }),
    )
    expect(faults.some((fault) => fault.includes('against a capacity of 1'))).toBe(true)
  })
})
