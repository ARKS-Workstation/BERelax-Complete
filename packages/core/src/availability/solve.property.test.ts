/**
 * The solver's invariants, over randomised days.
 *
 * Two statements, held over at least 10,000 generated cases:
 *
 *   1. no returned slot has `start + duration + turnaround` past the window it sits in, and
 *   2. no returned slot's therapist interval `[start - buffer, end + buffer)` overlaps an existing
 *      appointment or falls in a gap between that therapist's shifts — and no returned slot's room
 *      interval `[start, end + turnaround)` overlaps a block or another appointment in that room.
 *
 * ## The oracle is written independently
 *
 * The checks below re-derive both intervals with plain arithmetic and scan the precomputed windows
 * directly. An oracle expressed in terms of the functions it is checking proves the solver is
 * self-consistent, which is not the question. In particular "no shift gap" is checked as *the gaps
 * between consecutive shift rows*, not via `mergePeriods`.
 *
 * ## Cost
 *
 * The trading windows are precomputed outside the property, and everything generated inside it is an
 * offset in minutes from a precomputed opening instant. A previous unit's property test built its
 * windows inside the property, called `Intl` four million times and timed out; the fix was not to
 * generate less but to generate only what varies.
 *
 * ## The checker is proved able to fail
 *
 * Two mutants at the bottom — a solver that forgets the turnaround, and one that forgets the buffer —
 * are run through the same checks, which must report violations. A property suite whose oracle cannot
 * fail asserts nothing, however many cases it runs.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { horizonDates } from '../business-day/horizon.ts'
import type { HoursForDate } from '../business-day/resolve.ts'
import { tradingBounds } from '../business-day/resolve.ts'
import {
  addMinutes,
  type Instant,
  instantFromIso,
  type LocalDate,
  localDate,
  localTime,
  type TradingHours,
} from '../time.ts'
import type { Period, ResourceBlock, Room } from './room-predicates.ts'
import {
  type CandidateSlot,
  type ScheduledAppointment,
  type SlotRequest,
  solveAvailability,
  type TherapistShift,
} from './solve.ts'

const HOURS: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const HOURS_FOR: HoursForDate = () => HOURS

/** Midday inside a session, so `now` resolves to a trading date rather than to the daytime gap. */
const NOW: Instant = instantFromIso('2026-09-30T12:00:00+04:00')
const FIRST_DATE = localDate('2026-10-01')
const DATES: readonly LocalDate[] = horizonDates(FIRST_DATE, 7)

/**
 * Precomputed once: the bounds of each date's session, and the day's closures.
 *
 * `DATES[i]` is `i + 1` days after `NOW`'s trading date, which is what the advance horizon is checked
 * against below without re-deriving it.
 */
const SESSIONS = DATES.map((date) => ({ date, ...tradingBounds(date, HOURS) }))

/** A closure on one of the seven dates, so the multi-window path is exercised by a third of the runs. */
const CLOSURES = [
  {
    startsAt: addMinutes(SESSIONS[2]?.opensAt as Instant, 180),
    endsAt: addMinutes(SESSIONS[2]?.opensAt as Instant, 300),
    reason: 'deep clean',
  },
]

const ROOMS: readonly Room[] = [
  { id: 'room-standard-a', roomType: 'standard', capacity: 1, isBookable: true },
  { id: 'room-standard-b', roomType: 'standard', capacity: 1, isBookable: true },
  { id: 'room-couples', roomType: 'couples', capacity: 2, isBookable: true },
  // Decommissioned: it must never appear on a slot, whatever else is generated.
  { id: 'room-standard-retired', roomType: 'standard', capacity: 1, isBookable: false },
]
const COMPATIBLE: readonly Room['roomType'][] = ['standard', 'couples']
/** Ids, never names. */
const THERAPIST_IDS = ['therapist-01', 'therapist-02', 'therapist-03']

/** Everything is an offset in minutes from the day's opening instant: no `Intl` inside the property. */
const generated = fc.record({
  dateIndex: fc.integer({ min: 0, max: DATES.length - 1 }),
  durationMinutes: fc.constantFrom(45, 60, 90, 120),
  turnaroundMinutes: fc.constantFrom(0, 15, 20, 30),
  bufferMinutes: fc.constantFrom(0, 5, 10, 20),
  stepMinutes: fc.constantFrom(15, 30),
  minLeadMinutes: fc.constantFrom(0, 120, 600),
  maxAdvanceDays: fc.constantFrom(1, 7, 90),
  clients: fc.constantFrom(1, 2),
  appointments: fc.array(
    fc.record({
      startOffset: fc.integer({ min: 0, max: 840 }),
      durationMinutes: fc.constantFrom(45, 60, 90, 120),
      turnaroundMinutes: fc.constantFrom(0, 20, 30),
      therapistBufferMinutes: fc.constantFrom(0, 10),
      roomIndex: fc.integer({ min: 0, max: ROOMS.length - 1 }),
      therapistIndex: fc.integer({ min: 0, max: THERAPIST_IDS.length - 1 }),
    }),
    { maxLength: 4 },
  ),
  blocks: fc.array(
    fc.record({
      startOffset: fc.integer({ min: 0, max: 840 }),
      durationMinutes: fc.constantFrom(30, 60, 120),
      roomIndex: fc.integer({ min: 0, max: ROOMS.length - 1 }),
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
 * Declaring it twice is how a generator and the checker that reads it drift apart: a field added to
 * one and not the other typechecks for as long as the reader never looks at it.
 */
type Generated = typeof generated extends fc.Arbitrary<infer T> ? T : never

function shiftsFrom(sample: Generated, opensAt: Instant): TherapistShift[] {
  const shifts: TherapistShift[] = []
  sample.shifts.forEach((spec, index) => {
    const therapistId = THERAPIST_IDS[index] as string
    const start = addMinutes(opensAt, spec.startOffset)
    const end = addMinutes(opensAt, spec.endOffset)
    // A break splits the roster into two rows with a real gap between them, which is what the "no
    // shift gap" half of the property needs to have something to catch.
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

function requestFrom(sample: Generated): SlotRequest {
  const session = SESSIONS[sample.dateIndex] as (typeof SESSIONS)[number]
  const appointments: ScheduledAppointment[] = sample.appointments.map((spec, index) => ({
    id: `appointment-${index}`,
    roomId: (ROOMS[spec.roomIndex] as Room).id,
    therapistIds: [THERAPIST_IDS[spec.therapistIndex] as string],
    treatment: {
      startsAt: addMinutes(session.opensAt, spec.startOffset),
      endsAt: addMinutes(session.opensAt, spec.startOffset + spec.durationMinutes),
    },
    turnaroundMinutes: spec.turnaroundMinutes,
    therapistBufferMinutes: spec.therapistBufferMinutes,
  }))
  const blocks: ResourceBlock[] = sample.blocks.map((spec) => ({
    roomId: (ROOMS[spec.roomIndex] as Room).id,
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
    closures: CLOSURES,
    durationMinutes: sample.durationMinutes,
    turnaroundMinutes: sample.turnaroundMinutes,
    therapistBufferMinutes: sample.bufferMinutes,
    minLeadMinutes: sample.minLeadMinutes,
    maxAdvanceDays: sample.maxAdvanceDays,
    rooms: ROOMS,
    compatibleRoomTypes: COMPATIBLE,
    clients: sample.clients,
    therapistIds: THERAPIST_IDS,
    shifts: shiftsFrom(sample, session.opensAt),
    appointments,
    blocks,
    stepMinutes: sample.stepMinutes,
  }
}

// --- the oracle, written without the functions under test ----------------------------------------

/**
 * A span of plain epoch milliseconds.
 *
 * Deliberately not `Period`, whose `Instant` brand exists to stop domain code doing arithmetic on
 * instants by accident. The oracle's whole job is that arithmetic — `start + duration + turnaround`,
 * written out — so it works in numbers, and a `Period` is assignable to it without a cast.
 */
interface Span {
  readonly startsAt: number
  readonly endsAt: number
}

const overlaps = (a: Span, b: Span): boolean => a.startsAt < b.endsAt && b.startsAt < a.endsAt
const minutes = (count: number): number => count * 60_000

/** The windows of a date, from the precomputed session minus the precomputed closures. */
function windowsOf(dateIndex: number): Span[] {
  const session = SESSIONS[dateIndex] as (typeof SESSIONS)[number]
  const whole: Span = { startsAt: session.opensAt, endsAt: session.closesAt }
  let windows: Span[] = [whole]
  for (const closure of CLOSURES) {
    const next: Span[] = []
    for (const window of windows) {
      if (!overlaps(window, closure)) {
        next.push(window)
        continue
      }
      if (closure.startsAt > window.startsAt) {
        next.push({ startsAt: window.startsAt, endsAt: closure.startsAt })
      }
      if (closure.endsAt < window.endsAt)
        next.push({ startsAt: closure.endsAt, endsAt: window.endsAt })
    }
    windows = next
  }
  return windows
}

/** The gaps between one therapist's shift rows — the thing a slot must never land in. */
function shiftGapsFor(therapistId: string, shifts: readonly TherapistShift[]): Span[] {
  const ordered = shifts
    .filter((shift) => shift.therapistId === therapistId)
    .map((shift) => shift.period)
    .sort((a, b) => a.startsAt - b.startsAt)
  const gaps: Span[] = []
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1] as Period
    const current = ordered[index] as Period
    if (current.startsAt > previous.endsAt) {
      gaps.push({ startsAt: previous.endsAt, endsAt: current.startsAt })
    }
  }
  return gaps
}

/** The two intervals, re-derived from the configured minutes rather than read off the slot. */
function intervalFaults(
  slot: CandidateSlot,
  request: SlotRequest,
  durationMinutes: number,
): string[] {
  const treatmentEnd = slot.startsAt + minutes(durationMinutes)
  const faults: string[] = []
  if (slot.roomPeriod.endsAt !== treatmentEnd + minutes(request.turnaroundMinutes)) {
    faults.push('room interval is not start..end+turnaround')
  }
  if (slot.therapistPeriod.startsAt !== slot.startsAt - minutes(request.therapistBufferMinutes)) {
    faults.push('therapist interval does not lead by the buffer')
  }
  if (slot.therapistPeriod.endsAt !== treatmentEnd + minutes(request.therapistBufferMinutes)) {
    faults.push('therapist interval does not trail by the buffer')
  }
  return faults
}

/** The room half: a free room is bookable, compatible, big enough, unblocked and unoccupied. */
function roomFaults(roomPeriod: Span, slot: CandidateSlot, request: SlotRequest): string[] {
  const faults: string[] = []
  if (slot.availableRoomIds.length === 0) faults.push('offered with no room')
  for (const roomId of slot.availableRoomIds) {
    const room = ROOMS.find((candidate) => candidate.id === roomId) as Room
    if (!room.isBookable) faults.push(`${roomId} is decommissioned`)
    if (!COMPATIBLE.includes(room.roomType)) faults.push(`${roomId} is an incompatible type`)
    if (room.capacity < (request.clients ?? 1)) faults.push(`${roomId} is too small`)
    const busy: Span[] = [
      ...request.blocks.filter((block) => block.roomId === roomId).map((block) => block.period),
      ...request.appointments
        .filter((appointment) => appointment.roomId === roomId)
        .map((appointment) => ({
          startsAt: appointment.treatment.startsAt,
          endsAt: appointment.treatment.endsAt + minutes(appointment.turnaroundMinutes),
        })),
    ]
    if (busy.some((period) => overlaps(period, roomPeriod))) faults.push(`${roomId} is occupied`)
  }
  return faults
}

/**
 * The therapist half: on shift for the whole buffered interval, in no shift gap, and not already
 * booked — counting the other appointment with **its** buffer rather than with this query's.
 */
function therapistFaults(
  therapistPeriod: Span,
  slot: CandidateSlot,
  request: SlotRequest,
): string[] {
  const faults: string[] = []
  if (slot.availableTherapistIds.length === 0) faults.push('offered with no therapist')
  for (const therapistId of slot.availableTherapistIds) {
    const rostered = request.shifts.filter((shift) => shift.therapistId === therapistId)
    const earliest = Math.min(...rostered.map((shift) => shift.period.startsAt))
    const latest = Math.max(...rostered.map((shift) => shift.period.endsAt))
    if (therapistPeriod.startsAt < earliest || therapistPeriod.endsAt > latest) {
      faults.push(`${therapistId} is not on shift`)
    }
    if (shiftGapsFor(therapistId, request.shifts).some((gap) => overlaps(gap, therapistPeriod))) {
      faults.push(`${therapistId} is in a shift gap`)
    }
    const booked: Span[] = request.appointments
      .filter((appointment) => appointment.therapistIds.includes(therapistId))
      .map((appointment) => ({
        startsAt: appointment.treatment.startsAt - minutes(appointment.therapistBufferMinutes),
        endsAt: appointment.treatment.endsAt + minutes(appointment.therapistBufferMinutes),
      }))
    if (booked.some((period) => overlaps(period, therapistPeriod))) {
      faults.push(`${therapistId} is already booked`)
    }
  }
  return faults
}

/** Every way a slot can be wrong, as a list of complaints. Empty means the slot is sound. */
function faultsIn(args: {
  readonly slot: CandidateSlot
  readonly sample: Generated
  readonly request: SlotRequest
}): string[] {
  const { slot, sample, request } = args
  const treatmentEnd = slot.startsAt + minutes(sample.durationMinutes)
  const roomPeriod: Span = {
    startsAt: slot.startsAt,
    endsAt: treatmentEnd + minutes(request.turnaroundMinutes),
  }
  const therapistPeriod: Span = {
    startsAt: slot.startsAt - minutes(request.therapistBufferMinutes),
    endsAt: treatmentEnd + minutes(request.therapistBufferMinutes),
  }
  const faults = [
    ...intervalFaults(slot, request, sample.durationMinutes),
    ...roomFaults(roomPeriod, slot, request),
    ...therapistFaults(therapistPeriod, slot, request),
  ]
  // The window: start + duration + turnaround must not pass the close of the window it sits in.
  const insideAWindow = windowsOf(sample.dateIndex).some(
    (window) => roomPeriod.startsAt >= window.startsAt && roomPeriod.endsAt <= window.endsAt,
  )
  if (!insideAWindow) faults.push('room interval is not contained by any trading window')
  if (slot.startsAt < NOW + minutes(request.minLeadMinutes)) faults.push('inside the minimum lead')
  if (sample.dateIndex + 1 > request.maxAdvanceDays) faults.push('beyond the maximum advance')
  return faults
}

describe('property — every returned slot is deliverable', () => {
  it('holds over 10,000 generated days', () => {
    let offered = 0
    let emptyRuns = 0
    fc.assert(
      fc.property(generated, (sample) => {
        const request = requestFrom(sample)
        const { slots } = solveAvailability(request)
        offered += slots.length
        if (slots.length === 0) emptyRuns += 1
        for (const slot of slots) {
          const faults = faultsIn({ slot, sample, request })
          // Thrown rather than returned false: fast-check prints the message beside the shrunk
          // counterexample, and "a slot was wrong" without saying how is a day's work to reproduce.
          if (faults.length > 0) {
            throw new Error(
              `slot at ${slot.startsAt} on ${request.tradingDate}: ${faults.join('; ')}`,
            )
          }
        }
        // Ascending and unique, so a caller may walk them without sorting.
        return slots.every(
          (slot, index) =>
            index === 0 || slot.startsAt > (slots[index - 1] as CandidateSlot).startsAt,
        )
      }),
      { numRuns: 10_000 },
    )
    // Non-vacuity, in both directions: a property over an empty result set passes without asserting
    // anything, and a generator that always fills the day never exercises the exclusions.
    expect(offered).toBeGreaterThan(10_000)
    expect(emptyRuns).toBeGreaterThan(0)
  }, 120_000)
})

describe('the oracle can fail', () => {
  /** The honest request, with room for both mutants to show. */
  const sample: Generated = {
    dateIndex: 0,
    durationMinutes: 120,
    turnaroundMinutes: 20,
    bufferMinutes: 10,
    stepMinutes: 15,
    minLeadMinutes: 0,
    maxAdvanceDays: 90,
    clients: 1,
    appointments: [],
    blocks: [],
    // One shift per therapist, exactly the trading hours, so the leading buffer has an edge to fall off.
    shifts: THERAPIST_IDS.map(() => ({
      startOffset: 0,
      breakStart: 300,
      breakMinutes: 0 as const,
      endOffset: 900,
    })),
  }

  it('reports the window fault of a solver that forgot the turnaround', () => {
    const honest = requestFrom(sample)
    // The mutant: the room is booked as though the turnaround were zero, so the last slots of the day
    // run past close once the real 20 minutes are counted.
    const mutant = solveAvailability({ ...honest, turnaroundMinutes: 0 })
    const faults = mutant.slots.flatMap((slot) => faultsIn({ slot, sample, request: honest }))
    expect(faults).toContain('room interval is not contained by any trading window')
    // And the honest solver produces none of them on the same day.
    const sound = solveAvailability(honest)
    expect(sound.slots.flatMap((slot) => faultsIn({ slot, sample, request: honest }))).toEqual([])
    expect(sound.slots.length).toBeGreaterThan(0)
  })

  it('reports the shift fault of a solver that forgot the buffer', () => {
    const honest = requestFrom(sample)
    const mutant = solveAvailability({ ...honest, therapistBufferMinutes: 0 })
    const faults = mutant.slots.flatMap((slot) => faultsIn({ slot, sample, request: honest }))
    // The opening slot is the one that shows it: the therapist is busy ten minutes before a shift
    // that starts at opening.
    expect(faults.some((fault) => fault.endsWith('is not on shift'))).toBe(true)
  })
})
