/**
 * The solver's worked examples, asserted to the minute.
 *
 * Every figure here is a business rule rather than an illustration: 23:40, 23:30, 01:00, 01:55, 02:00,
 * `now + 2h`, day 90. They are asserted as wall-clock strings in the business zone, because that is the
 * form the front desk and the customer see, and an epoch number that is out by an hour reads as
 * plausible while a `'23:40'` that should be `'00:40'` does not.
 *
 * Each assertion is paired with a control that must fail if the rule were implemented the other way —
 * the 15-minute grid that cannot distinguish the two turnarounds, the closure removed, the lead
 * shortened by one minute, the buffer swapped with the turnaround. A test that cannot fail is not a
 * test.
 */
import { describe, expect, it } from 'vitest'
import type { HoursForDate } from '../business-day/resolve.ts'
import { type ClosedInterval, latestStartIn, tradingWindowsFor } from '../business-day/windows.ts'
import {
  ASIA_DUBAI,
  addMinutes,
  fixedClock,
  type Instant,
  instantFromIso,
  localDate,
  localTime,
  type TradingHours,
  toLocal,
} from '../time.ts'
import { alignToStep, candidateStarts, mergePeriods, treatmentPeriod } from './intervals.ts'
import type { Period, ResourceBlock, Room } from './room-predicates.ts'
import {
  advanceAnchorDate,
  appointmentRoomPeriod,
  appointmentTherapistPeriod,
  calendarDaysBetween,
  type ScheduledAppointment,
  type SlotRequest,
  type SlotSolution,
  solveAvailability,
  type TherapistShift,
} from './solve.ts'

/** 11:00 to 02:00 — the real trading hours, and the reason a treatment may cross midnight. */
const HOURS: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
/** The premises trades every day at the same hours. Dated exceptions are `tradingWindowsFor`'s job. */
const HOURS_FOR: HoursForDate = () => HOURS
const DATE = localDate('2026-10-02')

const at = (iso: string): Instant => instantFromIso(iso)
/** Wall-clock time in the business zone: the form every acceptance figure is written in. */
const wall = (instant: Instant): string => toLocal(instant).time
const day = (instant: Instant): string => toLocal(instant).date
const startsOf = (solution: SlotSolution): string[] => solution.slots.map((s) => wall(s.startsAt))
const lastStart = (solution: SlotSolution): string | undefined => startsOf(solution).at(-1)
const rejectionAt = (solution: SlotSolution, time: string): string | undefined =>
  solution.rejected.find((rejected) => wall(rejected.startsAt) === time)?.reason

/**
 * Therapists are referenced by id, never by name: a therapist has no display name until an admin sets
 * one. The form mirrors `therapistReference` in packages/fixtures, which core may not import.
 */
const THERAPIST_1 = 'therapist-01'
const THERAPIST_2 = 'therapist-02'

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
const WET: Room = { id: 'room-wet', roomType: 'wet', capacity: 1, isBookable: true }

const period = (fromIso: string, untilIso: string): Period => ({
  startsAt: at(fromIso),
  endsAt: at(untilIso),
})
const shift = (therapistId: string, fromIso: string, untilIso: string): TherapistShift => ({
  therapistId,
  period: period(fromIso, untilIso),
})

/**
 * Shifts that start before opening and end after close, so the window rules can be asserted on their
 * own. A shift equal to the trading hours would remove the opening slot via the therapist's leading
 * buffer — which is correct, and is asserted separately below rather than confounding every other case.
 */
const OPEN_SHIFTS: TherapistShift[] = [
  shift(THERAPIST_1, '2026-10-02T10:30:00+04:00', '2026-10-03T02:30:00+04:00'),
  shift(THERAPIST_2, '2026-10-02T10:30:00+04:00', '2026-10-03T02:30:00+04:00'),
]

const BASE: SlotRequest = {
  // The day before the date being solved, so lead and advance never confound a window assertion.
  now: at('2026-10-01T12:00:00+04:00'),
  tradingDate: DATE,
  hoursFor: HOURS_FOR,
  closures: [],
  durationMinutes: 120,
  turnaroundMinutes: 20,
  therapistBufferMinutes: 10,
  minLeadMinutes: 0,
  maxAdvanceDays: 90,
  rooms: [STANDARD_A],
  compatibleRoomTypes: ['standard'],
  therapistIds: [THERAPIST_1],
  shifts: OPEN_SHIFTS,
  appointments: [],
  blocks: [],
  // Five minutes, not the default quarter hour: several acceptance figures — 23:40, 00:55 — are not on
  // a quarter-hour grid, and a coarser grid would make the assertion about the grid rather than the rule.
  stepMinutes: 5,
}

const solve = (overrides: Partial<SlotRequest> = {}): SlotSolution =>
  solveAvailability({ ...BASE, ...overrides })

/** The same request with no grid set at all, so `DEFAULT_SLOT_STEP_MINUTES` applies. */
const { stepMinutes: _fineGrid, ...BASE_WITHOUT_GRID } = BASE
const solveOnDefaultGrid = (overrides: Partial<SlotRequest> = {}): SlotSolution =>
  solveAvailability({ ...BASE_WITHOUT_GRID, ...overrides })

describe('acceptance — the last bookable start, to the minute', () => {
  it('puts the last 120-minute start with a 20-minute turnaround at 23:40', () => {
    const solution = solve()
    expect(lastStart(solution)).toBe('23:40')
    const last = solution.slots.at(-1)
    // The room is held to exactly 02:00: 23:40 + 120 + 20. One minute later and the turnaround runs
    // past close, which is what `latestStartIn` is computed from.
    expect(wall(last?.roomPeriod.endsAt as Instant)).toBe('02:00')
    expect(day(last?.roomPeriod.endsAt as Instant)).toBe('2026-10-03')
    expect(startsOf(solution)).not.toContain('23:45')
  })

  it('puts the same duration in the wet room with a 30-minute turnaround at 23:30', () => {
    const solution = solve({ rooms: [WET], compatibleRoomTypes: ['wet'], turnaroundMinutes: 30 })
    expect(lastStart(solution)).toBe('23:30')
    expect(wall(solution.slots.at(-1)?.roomPeriod.endsAt as Instant)).toBe('02:00')
    expect(startsOf(solution)).not.toContain('23:35')
  })

  it('agrees with latestStartIn, which is where both figures come from', () => {
    const window = tradingWindowsFor({ date: DATE, hours: HOURS, closures: [] })[0] as never
    expect(wall(latestStartIn(window, 120, 20) as Instant)).toBe('23:40')
    expect(wall(latestStartIn(window, 120, 30) as Instant)).toBe('23:30')
    // A treatment longer than the window is not truncated to fit it; there is no start at all.
    expect(latestStartIn(window, 900, 20)).toBeUndefined()
  })

  it('cannot tell the two turnarounds apart on the default quarter-hour grid', () => {
    // The control for the two assertions above. 23:40 is not on a quarter-hour grid measured from
    // 11:00, so on the default grid the standard and the wet room both answer 23:30 — and a test
    // written on that grid would pass with the turnaround ignored entirely.
    expect(lastStart(solveOnDefaultGrid())).toBe('23:30')
    expect(
      lastStart(
        solveOnDefaultGrid({ rooms: [WET], compatibleRoomTypes: ['wet'], turnaroundMinutes: 30 }),
      ),
    ).toBe('23:30')
  })
})

describe('acceptance — the trading day crosses midnight', () => {
  const fortyFive = { durationMinutes: 45 } as const

  it('offers a 45-minute treatment at 01:00 when the turnaround still fits', () => {
    const offered = solve({ ...fortyFive, turnaroundMinutes: 15 })
    expect(startsOf(offered)).toContain('01:00')
    expect(lastStart(offered)).toBe('01:00')
    // 01:00 + 45 + 15 = 02:00 exactly. Trading dates, not calendar ones: the slot is on the 2nd's
    // business day although the clock says the 3rd.
    expect(day(offered.slots.at(-1)?.startsAt as Instant)).toBe('2026-10-03')
    expect(wall(offered.slots.at(-1)?.roomPeriod.endsAt as Instant)).toBe('02:00')
  })

  it('does not offer 01:00 for a 45-minute treatment with a 20-minute turnaround', () => {
    // The manifest's third acceptance line asks for 01:00 to be offered *with a 20-minute turnaround*.
    // It cannot be, and no implementation choice makes it so: 01:00 + 45 + 20 = 02:05, five minutes
    // past close, which the first acceptance line forbids outright ("no returned slot satisfies start
    // + duration + turnaround > closes_at") and which the 23:40 figure of the second line is derived
    // from. The largest turnaround that leaves 01:00 bookable for a 45-minute treatment is 15 minutes;
    // with 20 the last start is 00:55. See the NOTE appended to B-AVAIL-02's acceptance list.
    const solution = solve({ ...fortyFive, turnaroundMinutes: 20 })
    expect(startsOf(solution)).not.toContain('01:00')
    expect(lastStart(solution)).toBe('00:55')
    expect(wall(solution.slots.at(-1)?.roomPeriod.endsAt as Instant)).toBe('02:00')
  })

  it('offers a treatment that ends exactly at 02:00 with no turnaround, proving close is inclusive', () => {
    const solution = solve({ ...fortyFive, turnaroundMinutes: 0 })
    expect(lastStart(solution)).toBe('01:15')
    const last = solution.slots.at(-1)
    expect(wall(last?.treatment.endsAt as Instant)).toBe('02:00')
    expect(wall(last?.roomPeriod.endsAt as Instant)).toBe('02:00')
    // Half-open, so nothing may *start* at close even with a zero-length turnaround.
    expect(startsOf(solution)).not.toContain('01:20')
    expect(startsOf(solution)).not.toContain('02:00')
  })

  it('never offers 01:55 for any bookable duration', () => {
    for (const durationMinutes of [45, 60, 90, 120]) {
      expect(startsOf(solve({ durationMinutes, turnaroundMinutes: 0 }))).not.toContain('01:55')
    }
  })

  it('has 01:55 on the grid, so the assertion above is not vacuous', () => {
    // The control for the case above. If 01:55 were simply off the grid, "never offered at 01:55"
    // would be true of a solver with no window rule at all. A five-minute treatment ending exactly at
    // 02:00 is offered there, which is the same inclusive boundary from the other side.
    const window = tradingWindowsFor({ date: DATE, hours: HOURS, closures: [] })[0] as never
    const grid = candidateStarts({
      window,
      durationMinutes: 5,
      turnaroundMinutes: 0,
      stepMinutes: 5,
    })
    expect(grid.map(wall)).toContain('01:55')
    expect(grid.map(wall).at(-1)).toBe('01:55')
  })
})

describe('acceptance — turnaround occupies the room, the buffer occupies the therapist', () => {
  /** 12:00 to 13:00, therapist 01, in standard room A. Its own turnaround and buffer, not the query's. */
  const existing = (
    turnaroundMinutes: number,
    therapistBufferMinutes: number,
  ): ScheduledAppointment => ({
    id: 'appointment-1',
    roomId: STANDARD_A.id,
    therapistIds: [THERAPIST_1],
    treatment: period('2026-10-02T12:00:00+04:00', '2026-10-02T13:00:00+04:00'),
    turnaroundMinutes,
    therapistBufferMinutes,
  })

  it('holds the room for [start, end + turnaround) and the therapist for [start - buffer, end + buffer)', () => {
    const appointment = existing(30, 10)
    const room = appointmentRoomPeriod(appointment)
    const therapist = appointmentTherapistPeriod(appointment)
    expect([wall(room.startsAt), wall(room.endsAt)]).toEqual(['12:00', '13:30'])
    expect([wall(therapist.startsAt), wall(therapist.endsAt)]).toEqual(['11:50', '13:10'])
    // The control: neither interval is the other, and neither is the sum of the two figures. An
    // implementation that added both to one interval would end it at 13:40.
    expect(wall(room.endsAt)).not.toBe(wall(therapist.endsAt))
    expect(wall(addMinutes(appointment.treatment.endsAt, 30 + 10))).toBe('13:40')
  })

  /**
   * One probe start, 13:20, against the same 12:00–13:00 appointment.
   *
   * With a 30-minute turnaround the room is held to 13:30, so 13:20 collides with the **room**. With a
   * 10-minute buffer the therapist is free from 13:10, so 13:20 does not collide with the therapist.
   * Swap the two figures and both answers swap with them. An implementation that added turnaround and
   * buffer into one interval would answer identically both ways round, because 30 + 10 = 10 + 30.
   */
  const probe = (args: {
    readonly turnaroundMinutes: number
    readonly bufferMinutes: number
    readonly sameRoom: boolean
  }): SlotSolution =>
    solve({
      durationMinutes: 60,
      turnaroundMinutes: args.turnaroundMinutes,
      therapistBufferMinutes: args.bufferMinutes,
      stepMinutes: 20,
      rooms: [args.sameRoom ? STANDARD_A : STANDARD_B],
      // The same room means a different therapist, and the same therapist means a different room, so
      // exactly one resource can be the one that collides.
      therapistIds: [args.sameRoom ? THERAPIST_2 : THERAPIST_1],
      appointments: [existing(args.turnaroundMinutes, args.bufferMinutes)],
    })

  it('reports the ROOM as the conflict when the turnaround is the longer figure', () => {
    expect(
      rejectionAt(probe({ turnaroundMinutes: 30, bufferMinutes: 10, sameRoom: true }), '13:20'),
    ).toBe('no_room_available')
    // Same instant, same appointment, the therapist instead of the room: free, because the buffer is 10.
    const therapistSide = probe({ turnaroundMinutes: 30, bufferMinutes: 10, sameRoom: false })
    expect(startsOf(therapistSide)).toContain('13:20')
    expect(rejectionAt(therapistSide, '13:20')).toBeUndefined()
  })

  it('reports the THERAPIST as the conflict once the two values are swapped', () => {
    expect(
      rejectionAt(probe({ turnaroundMinutes: 10, bufferMinutes: 30, sameRoom: false }), '13:20'),
    ).toBe('no_therapist_available')
    // And the room, which was the conflict before the swap, is now free at the same instant.
    const roomSide = probe({ turnaroundMinutes: 10, bufferMinutes: 30, sameRoom: true })
    expect(startsOf(roomSide)).toContain('13:20')
    expect(rejectionAt(roomSide, '13:20')).toBeUndefined()
  })

  it('keeps the two intervals distinct on a returned slot', () => {
    const slot = solve({ durationMinutes: 60, turnaroundMinutes: 30, therapistBufferMinutes: 10 })
      .slots[0]
    expect(slot?.roomPeriod.startsAt).toBe(slot?.treatment.startsAt)
    expect(slot?.roomPeriod.endsAt).toBe(addMinutes(slot?.treatment.endsAt as Instant, 30))
    expect(slot?.therapistPeriod.startsAt).toBe(
      addMinutes(slot?.treatment.startsAt as Instant, -10),
    )
    expect(slot?.therapistPeriod.endsAt).toBe(addMinutes(slot?.treatment.endsAt as Instant, 10))
    // The conflated interval, written out, so the difference is asserted rather than described.
    expect(slot?.roomPeriod.endsAt).not.toBe(addMinutes(slot?.treatment.endsAt as Instant, 40))
  })
})

describe('acceptance — closures', () => {
  const CLOSURE: ClosedInterval = {
    startsAt: at('2026-10-02T14:00:00+04:00'),
    endsAt: at('2026-10-02T16:00:00+04:00'),
    reason: 'staff meeting',
  }
  const closed = (overrides: Partial<SlotRequest> = {}): SlotSolution =>
    solve({
      durationMinutes: 60,
      turnaroundMinutes: 20,
      stepMinutes: 15,
      closures: [CLOSURE],
      ...overrides,
    })

  it('splits the day in two and offers nothing inside the closure', () => {
    const solution = closed()
    expect(solution.windows).toHaveLength(2)
    for (const time of ['14:00', '14:15', '14:30', '15:00', '15:45']) {
      expect(startsOf(solution)).not.toContain(time)
    }
    // Nothing merely *overlaps* it either, which a start-time-only filter would allow.
    for (const slot of solution.slots) {
      expect(
        slot.roomPeriod.startsAt >= CLOSURE.endsAt || slot.roomPeriod.endsAt <= CLOSURE.startsAt,
      ).toBe(true)
    }
  })

  it('removes a slot the closure begins inside rather than truncating it', () => {
    const solution = closed()
    // 12:45 + 60 + 20 = 14:05, five minutes into the closure, so the slot goes. 12:30 + 80 = 13:50 fits.
    expect(startsOf(solution)).toContain('12:30')
    expect(startsOf(solution)).not.toContain('12:45')
    // Every surviving slot is a full treatment. A truncating implementation would return a shorter one.
    for (const slot of solution.slots) {
      expect(slot.treatment.endsAt - slot.treatment.startsAt).toBe(60 * 60_000)
    }
    // And the session resumes on the grid at 16:00, not 20 minutes later.
    expect(startsOf(solution)).toContain('16:00')
  })

  it('offers both of those starts once the closure is removed', () => {
    // The control. Without it, "12:45 is absent" would also be true of a solver that lost the
    // afternoon for an unrelated reason.
    const open = closed({ closures: [] })
    expect(startsOf(open)).toContain('12:45')
    expect(startsOf(open)).toContain('14:00')
    expect(open.windows).toHaveLength(1)
  })

  it('offers nothing at all on a fully closed date', () => {
    const solution = solve({ hoursFor: () => undefined })
    expect(solution.slots).toEqual([])
    expect(solution.rejected).toEqual([])
    expect(solution.windows).toEqual([])
  })
})

describe('acceptance — lead and advance, under a frozen instant', () => {
  // A frozen clock, read once, then passed in: packages/core reads no clock, so `now` is an argument.
  const NOW = fixedClock('2026-10-02T12:00:00+04:00').now()

  // Shifts are dated rows, so a query about the 90th day needs a therapist rostered on that day.
  const DECEMBER_SHIFTS = [
    shift(THERAPIST_1, '2026-12-31T10:30:00+04:00', '2027-01-01T02:30:00+04:00'),
  ]

  const leadRequest = (minLeadMinutes: number): SlotSolution =>
    solve({
      now: NOW,
      durationMinutes: 45,
      turnaroundMinutes: 0,
      minLeadMinutes,
      // One-minute grid: `now + 2h - 1min` has to be a candidate for its exclusion to mean anything.
      stepMinutes: 1,
    })

  it('excludes now + 2h - 1min and includes now + 2h exactly', () => {
    const solution = leadRequest(120)
    expect(startsOf(solution)).not.toContain('13:59')
    expect(rejectionAt(solution, '13:59')).toBe('before_minimum_lead')
    expect(startsOf(solution)[0]).toBe('14:00')
    expect(solution.slots[0]?.startsAt).toBe(addMinutes(NOW, 120))
  })

  it('offers 13:59 when the lead is one minute shorter', () => {
    // The control: 13:59 is on the grid and otherwise bookable, so its exclusion above is the lead rule.
    expect(startsOf(leadRequest(119))).toContain('13:59')
  })

  it('includes day 90 and excludes day 91', () => {
    expect(calendarDaysBetween(DATE, localDate('2026-12-31'))).toBe(90)
    expect(calendarDaysBetween(DATE, localDate('2027-01-01'))).toBe(91)

    const day90 = solve({ now: NOW, tradingDate: localDate('2026-12-31'), shifts: DECEMBER_SHIFTS })
    expect(day90.slots.length).toBeGreaterThan(0)

    const day91 = solve({ now: NOW, tradingDate: localDate('2027-01-01') })
    expect(day91.slots).toEqual([])
    expect(new Set(day91.rejected.map((r) => r.reason))).toEqual(
      new Set(['beyond_maximum_advance']),
    )
    expect(day91.rejected.length).toBeGreaterThan(0)
  })

  it('counts the advance in trading dates, so the whole of day 90 is bookable', () => {
    // The control that separates a day count from an hours count. `now` is 12:00, so day 90's evening
    // is more than 90 x 24h away: an hours-based horizon would drop it and reinstate it tomorrow.
    const day90 = solve({
      now: NOW,
      tradingDate: localDate('2026-12-31'),
      shifts: DECEMBER_SHIFTS,
    })
    const last = day90.slots.at(-1)?.startsAt as Instant
    expect(wall(last)).toBe('23:40')
    expect(last - NOW).toBeGreaterThan(90 * 24 * 60 * 60_000)
  })

  it('anchors the horizon on the trading date inside trading hours, and on the calendar date outside', () => {
    // 01:30 on the 3rd is the 2nd's business day, so the horizon is counted from the 2nd.
    expect(advanceAnchorDate(at('2026-10-03T01:30:00+04:00'), HOURS_FOR)).toBe(DATE)
    // 09:00 is in the nine-hour daytime gap, where there is no trading date at all.
    expect(advanceAnchorDate(at('2026-10-03T09:00:00+04:00'), HOURS_FOR)).toBe(
      localDate('2026-10-03'),
    )
    // And the zone is honoured rather than assumed: 01:30 in Dubai is 21:30 on the 2nd in London.
    expect(advanceAnchorDate(at('2026-10-03T01:30:00+04:00'), HOURS_FOR, ASIA_DUBAI)).toBe(DATE)
  })

  it('rejects a past date for want of lead time rather than for the horizon', () => {
    const past = solve({ now: NOW, tradingDate: localDate('2026-09-20') })
    expect(past.slots).toEqual([])
    expect(new Set(past.rejected.map((r) => r.reason))).toEqual(new Set(['before_minimum_lead']))
  })
})

describe('acceptance — the shift must cover the whole buffered interval', () => {
  const ninety = (overrides: Partial<SlotRequest>): SlotSolution =>
    solve({ durationMinutes: 90, turnaroundMinutes: 0, stepMinutes: 10, ...overrides })

  it('removes the opening slot from a therapist whose shift starts exactly at opening', () => {
    // The therapist is busy from 10:50 for an 11:00 start, and a shift that starts at 11:00 does not
    // cover it. The leading half of the buffer is the half that gets forgotten.
    const atOpen = ninety({
      shifts: [shift(THERAPIST_1, '2026-10-02T11:00:00+04:00', '2026-10-03T02:00:00+04:00')],
    })
    expect(startsOf(atOpen)).not.toContain('11:00')
    expect(rejectionAt(atOpen, '11:00')).toBe('no_therapist_available')
    expect(startsOf(atOpen)[0]).toBe('11:10')

    // The control: ten minutes earlier and the same slot is offered.
    const early = ninety({
      shifts: [shift(THERAPIST_1, '2026-10-02T10:50:00+04:00', '2026-10-03T02:00:00+04:00')],
    })
    expect(startsOf(early)[0]).toBe('11:00')
  })

  it('removes a treatment whose buffered end runs past the end of the shift', () => {
    const untilTen = [shift(THERAPIST_1, '2026-10-02T10:30:00+04:00', '2026-10-02T22:00:00+04:00')]
    const solution = ninety({ shifts: untilTen })
    // 21:00 + 90 + 10 = 22:40, past the end of the shift. 20:20 + 90 + 10 = 22:00 exactly, which the
    // half-open convention includes.
    expect(startsOf(solution)).not.toContain('21:00')
    expect(rejectionAt(solution, '21:00')).toBe('no_therapist_available')
    expect(startsOf(solution)).toContain('20:20')
    expect(lastStart(solution)).toBe('20:20')
  })

  it('treats two abutting shifts as one presence, and a gap between them as a gap', () => {
    const split = [
      shift(THERAPIST_1, '2026-10-02T10:30:00+04:00', '2026-10-02T18:00:00+04:00'),
      shift(THERAPIST_1, '2026-10-02T18:00:00+04:00', '2026-10-03T02:30:00+04:00'),
    ]
    expect(startsOf(ninety({ shifts: split }))).toContain('17:30')

    const gapped = [
      shift(THERAPIST_1, '2026-10-02T10:30:00+04:00', '2026-10-02T18:00:00+04:00'),
      shift(THERAPIST_1, '2026-10-02T18:10:00+04:00', '2026-10-03T02:30:00+04:00'),
    ]
    const withGap = ninety({ shifts: gapped })
    expect(startsOf(withGap)).not.toContain('17:30')
    expect(rejectionAt(withGap, '17:30')).toBe('no_therapist_available')
  })

  it('offers nothing when the eligible therapist list is empty', () => {
    // B-AVAIL-04 and B-AVAIL-05 narrow this list; an empty one is "nobody is eligible", not "anybody".
    const solution = solve({ therapistIds: [] })
    expect(solution.slots).toEqual([])
    expect(new Set(solution.rejected.map((r) => r.reason))).toEqual(
      new Set(['no_therapist_available']),
    )
  })
})

describe('acceptance — rooms, blocks and capacity come from the B-CAT-02 predicates', () => {
  it('offers nothing when the service has no compatible room type', () => {
    // An empty compatibility list means NO room, never "any room" — `roomAcceptsService`'s whole point.
    const solution = solve({ compatibleRoomTypes: [] })
    expect(solution.slots).toEqual([])
    expect(new Set(solution.rejected.map((r) => r.reason))).toEqual(new Set(['no_room_available']))
  })

  it('removes the slots a maintenance block covers, and keeps the ones it abuts', () => {
    const block: ResourceBlock = {
      roomId: STANDARD_A.id,
      period: period('2026-10-02T15:00:00+04:00', '2026-10-02T17:00:00+04:00'),
      kind: 'maintenance',
      reason: 'wet room pump',
    }
    const solution = solve({
      durationMinutes: 60,
      turnaroundMinutes: 0,
      stepMinutes: 60,
      blocks: [block],
    })
    expect(startsOf(solution)).not.toContain('15:00')
    expect(startsOf(solution)).not.toContain('16:00')
    // Half-open: a treatment ending exactly when the block starts, and one starting exactly when it
    // ends, both survive.
    expect(startsOf(solution)).toContain('14:00')
    expect(startsOf(solution)).toContain('17:00')
    expect(
      startsOf(solve({ durationMinutes: 60, turnaroundMinutes: 0, stepMinutes: 60 })),
    ).toContain('15:00')
  })

  it('needs a room that holds two clients for a two-client booking', () => {
    const solution = solve({ clients: 2, rooms: [STANDARD_A, STANDARD_B] })
    expect(solution.slots).toEqual([])
    const couples: Room = { id: 'room-couples', roomType: 'couples', capacity: 2, isBookable: true }
    const fits = solve({ clients: 2, rooms: [couples], compatibleRoomTypes: ['couples'] })
    expect(fits.slots.length).toBeGreaterThan(0)
  })

  it('lists every free room and therapist on the slot, for the shape assignment to choose from', () => {
    const solution = solve({
      rooms: [STANDARD_A, STANDARD_B],
      therapistIds: [THERAPIST_1, THERAPIST_2],
    })
    const slot = solution.slots[0]
    expect(slot?.availableRoomIds).toEqual([STANDARD_A.id, STANDARD_B.id])
    expect(slot?.availableTherapistIds).toEqual([THERAPIST_1, THERAPIST_2])
  })
})

describe('the interval arithmetic itself', () => {
  it('refuses a treatment with no positive duration', () => {
    expect(() => treatmentPeriod(at('2026-10-02T12:00:00+04:00'), 0)).toThrow(/positive/)
    expect(() => treatmentPeriod(at('2026-10-02T12:00:00+04:00'), -45)).toThrow(/positive/)
    expect(() => treatmentPeriod(at('2026-10-02T12:00:00+04:00'), 45.5)).toThrow(/positive/)
  })

  it('refuses a negative turnaround or buffer, and a non-positive grid', () => {
    expect(() => solve({ turnaroundMinutes: -1 })).toThrow(/not negative/)
    expect(() => solve({ therapistBufferMinutes: -1 })).toThrow(/not negative/)
    expect(() => solve({ stepMinutes: 0 })).toThrow(/positive/)
    expect(() => solve({ minLeadMinutes: -1 })).toThrow(/not negative/)
    expect(() => solve({ maxAdvanceDays: 0 })).toThrow(/at least one day/)
  })

  it('aligns a window that opens mid-quarter up to the next grid point', () => {
    // A closure ending at 14:07 must not move the whole evening off the quarter hour.
    expect(wall(alignToStep(at('2026-10-02T14:07:00+04:00'), 15))).toBe('14:15')
    // Already on the grid: unchanged, rather than pushed a whole step forward.
    expect(wall(alignToStep(at('2026-10-02T14:15:00+04:00'), 15))).toBe('14:15')
    // Seconds round up to the whole minute first, so a start never carries a hidden 30 seconds.
    expect(wall(alignToStep(at('2026-10-02T14:07:30+04:00'), 1))).toBe('14:08')
    expect(alignToStep(at('2026-10-02T14:07:30+04:00'), 1) % 60_000).toBe(0)
  })

  it('merges abutting and overlapping periods and leaves a gap alone', () => {
    const merged = mergePeriods([
      period('2026-10-02T18:00:00+04:00', '2026-10-02T20:00:00+04:00'),
      period('2026-10-02T11:00:00+04:00', '2026-10-02T14:00:00+04:00'),
      period('2026-10-02T14:00:00+04:00', '2026-10-02T15:00:00+04:00'),
      period('2026-10-02T12:00:00+04:00', '2026-10-02T13:00:00+04:00'),
      // Empty, so it contributes nothing rather than a zero-length fragment.
      period('2026-10-02T16:00:00+04:00', '2026-10-02T16:00:00+04:00'),
    ])
    expect(merged.map((p) => [wall(p.startsAt), wall(p.endsAt)])).toEqual([
      ['11:00', '15:00'],
      ['18:00', '20:00'],
    ])
  })

  it('returns no candidate starts when the treatment cannot fit the window at all', () => {
    const window = tradingWindowsFor({ date: DATE, hours: HOURS, closures: [] })[0] as never
    expect(
      candidateStarts({ window, durationMinutes: 900, turnaroundMinutes: 20, stepMinutes: 15 }),
    ).toEqual([])
  })
})
