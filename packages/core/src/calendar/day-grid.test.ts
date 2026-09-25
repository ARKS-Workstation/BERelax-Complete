import { describe, expect, it } from 'vitest'
import { appointmentRoomPeriod, appointmentTherapistPeriod } from '../availability/solve.ts'
import type { Instant } from '../time.ts'
import {
  bandsOfKind,
  CALENDAR_STEP_MINUTES,
  type CalendarAppointmentFacts,
  type CalendarDayFacts,
  calendarAxes,
  cardsOn,
} from './day-grid.ts'

/**
 * B-UI-03 — the two axes of the admin calendar, as arithmetic.
 *
 * Everything decidable about the grid is decidable here: that both axes come from ONE facts object, that a
 * room's turnaround and a therapist's buffer are different bands of different lengths, that a treatment
 * crossing midnight is one continuous span, and that the drop targets are the day's own quarter hours. What
 * is left for a browser is whether the page draws them — `apps/web/src/admin-calendar-grid.itest.ts` — and
 * what is left for PostgreSQL is which rows there are.
 *
 * Every claim is paired with a control that must fail. `toEqual` on a band list is satisfied by a function
 * that returns the same list for every input, so each case also states the input that must produce a
 * DIFFERENT answer.
 */

/** 2099-06-17, 11:00 Dubai, as the `business_day` row stores it. */
const OPENS_AT = Date.parse('2099-06-17T07:00:00.000Z')
/** 02:00 the next calendar date. Fifteen hours, which is 900 minutes and 60 quarter hours. */
const CLOSES_AT = Date.parse('2099-06-17T22:00:00.000Z')
const MINUTE = 60_000

const ROOM_A = '00000000-0000-4000-8000-0000000000a1'
const ROOM_B = '00000000-0000-4000-8000-0000000000a2'
const THERAPIST_A = '00000000-0000-4000-8000-0000000000b1'
const THERAPIST_B = '00000000-0000-4000-8000-0000000000b2'

/** The configured minutes, deliberately unequal: the difference is what one acceptance line is about. */
const TURNAROUND_MINUTES = 20
const BUFFER_MINUTES = 10

function appointment(args: {
  readonly id: string
  readonly roomId?: string
  readonly therapistId?: string
  readonly startsAt: number
  readonly minutes: number
  readonly turnaroundMinutes?: number
  readonly therapistBufferMinutes?: number
}): CalendarAppointmentFacts {
  return {
    id: args.id,
    bookingId: `booking-${args.id}`,
    roomId: args.roomId ?? ROOM_A,
    therapistIds: [args.therapistId ?? THERAPIST_A],
    delivery: { id: `delivery-${args.id}`, places: 1 },
    treatment: {
      startsAt: args.startsAt as Instant,
      endsAt: (args.startsAt + args.minutes * MINUTE) as Instant,
    },
    turnaroundMinutes: args.turnaroundMinutes ?? TURNAROUND_MINUTES,
    therapistBufferMinutes: args.therapistBufferMinutes ?? BUFFER_MINUTES,
    status: 'confirmed',
    shape: 'solo',
    serviceLabel: 'Normal Massage (Asian)',
  }
}

function day(appointments: readonly CalendarAppointmentFacts[]): CalendarDayFacts {
  return {
    tradingDate: '2099-06-17',
    opensAt: OPENS_AT,
    closesAt: CLOSES_AT,
    rooms: [
      { roomId: ROOM_A, code: 'R1', name: 'Room One', capacity: 1 },
      { roomId: ROOM_B, code: 'R2', name: 'R2', capacity: 2 },
    ],
    therapists: [
      { therapistId: THERAPIST_A, reference: 'Therapist 07' },
      { therapistId: THERAPIST_B, reference: null },
    ],
    appointments,
  }
}

/** 19:00 Dubai on the trading date. */
const EVENING = Date.parse('2099-06-17T15:00:00.000Z')

describe('acceptance — both axes are derived from one facts object', () => {
  it('carries the facts object and every appointment by reference, not by copy', () => {
    const one = appointment({ id: 'one', startsAt: EVENING, minutes: 45 })
    const facts = day([one])
    const axes = calendarAxes(facts)

    // The claim the acceptance line makes — "no second fetch, no second source of truth" — as identity.
    // A behavioural comparison of two lists passes until the two reads disagree, which is the only moment
    // it would have mattered.
    expect(axes.source).toBe(facts)
    const roomCard = cardsOn(axes.rooms)[0]
    const therapistCard = cardsOn(axes.therapists)[0]
    expect(roomCard?.appointment).toBe(one)
    expect(therapistCard?.appointment).toBe(one)
    // The same object on both axes, which is the strongest form of "the same appointment".
    expect(roomCard?.appointment).toBe(therapistCard?.appointment)

    // The control: two axes over the same rows are not the same LANES. A function that returned one axis
    // twice would satisfy every assertion above.
    expect(axes.rooms).not.toBe(axes.therapists)
    expect(axes.rooms.map((lane) => lane.axis)).toEqual(['room', 'room'])
    expect(axes.therapists.map((lane) => lane.axis)).toEqual(['therapist', 'therapist'])
  })

  it('places every appointment on exactly one room lane and one therapist lane', () => {
    const first = appointment({ id: 'first', startsAt: EVENING, minutes: 45 })
    const second = appointment({
      id: 'second',
      roomId: ROOM_B,
      therapistId: THERAPIST_B,
      startsAt: EVENING,
      minutes: 60,
    })
    const axes = calendarAxes(day([first, second]))
    expect(cardsOn(axes.rooms)).toHaveLength(2)
    expect(cardsOn(axes.therapists)).toHaveLength(2)
    expect(axes.rooms.map((lane) => lane.cards.length)).toEqual([1, 1])
    // The control: the SAME two appointments in one room are two cards on one lane and the other lane is
    // empty — an empty room lane still exists, because an empty room is what a receptionist is looking for.
    const bothInA = calendarAxes(
      day([first, { ...second, roomId: ROOM_A, therapistIds: [THERAPIST_B] }]),
    )
    expect(bothInA.rooms.map((lane) => lane.cards.length)).toEqual([2, 0])
    expect(bothInA.rooms[1]?.label).toBe('R2')
  })

  it('labels a lane with a room code and a therapist handle, never with a name', () => {
    const axes = calendarAxes(day([appointment({ id: 'one', startsAt: EVENING, minutes: 45 })]))
    expect(axes.rooms.map((lane) => lane.label)).toEqual(['R1 · Room One', 'R2'])
    // `staff_reference` when there is one and a stated absence when there is not. ADR 0020: a therapist has
    // no display name until an admin publishes one, and this grid never invents a handle either.
    expect(axes.therapists.map((lane) => lane.label)).toEqual([
      'Therapist 07',
      'therapist not on file',
    ])
  })
})

describe('acceptance — the turnaround is the room’s band and the buffer is the therapist’s', () => {
  it('draws the two as different bands of different lengths when the configured values differ', () => {
    const one = appointment({ id: 'one', startsAt: EVENING, minutes: 45 })
    const axes = calendarAxes(day([one]))
    const roomCard = cardsOn(axes.rooms)[0]
    const therapistCard = cardsOn(axes.therapists)[0]
    if (roomCard === undefined || therapistCard === undefined) throw new Error('no card')

    const turnaround = bandsOfKind(roomCard, 'turnaround')
    const buffer = bandsOfKind(therapistCard, 'therapist_buffer')
    expect(turnaround).toHaveLength(1)
    // Both sides of the treatment. The leading half is the one that gets forgotten, and forgetting it draws
    // a therapist as free at a moment the booking transaction refuses to give them away.
    expect(buffer).toHaveLength(2)
    expect(turnaround[0]?.minutes).toBe(TURNAROUND_MINUTES)
    expect(buffer.map((band) => band.minutes)).toEqual([BUFFER_MINUTES, BUFFER_MINUTES])
    // The acceptance line: different lengths. Drawn length, not just declared minutes.
    expect(turnaround[0]?.length).not.toBe(buffer[1]?.length)
    expect(turnaround[0]?.length).toBeCloseTo((TURNAROUND_MINUTES / 900) * 1, 10)

    // The turnaround band is exactly the interval the solver treats the room as occupied for, and the
    // buffer band is exactly the therapist's. Compared against the functions themselves, so a band drawn
    // from a second opinion about a footprint fails here.
    expect(turnaround[0]?.endsAt).toBe(appointmentRoomPeriod(one).endsAt)
    expect(buffer[0]?.startsAt).toBe(appointmentTherapistPeriod(one).startsAt)
    expect(buffer[1]?.endsAt).toBe(appointmentTherapistPeriod(one).endsAt)

    // The control: EQUAL configured minutes make the two bands the same length. Without it, a function that
    // returned two different lengths for any input would satisfy the assertion above.
    const equal = calendarAxes(
      day([
        appointment({
          id: 'equal',
          startsAt: EVENING,
          minutes: 45,
          turnaroundMinutes: 10,
          therapistBufferMinutes: 10,
        }),
      ]),
    )
    const equalRoom = cardsOn(equal.rooms)[0]
    const equalTherapist = cardsOn(equal.therapists)[0]
    if (equalRoom === undefined || equalTherapist === undefined) throw new Error('no card')
    expect(bandsOfKind(equalRoom, 'turnaround')[0]?.length).toBe(
      bandsOfKind(equalTherapist, 'therapist_buffer')[1]?.length,
    )
  })

  it('omits a band a configured zero does not create, rather than drawing an empty one', () => {
    const axes = calendarAxes(
      day([
        appointment({
          id: 'none',
          startsAt: EVENING,
          minutes: 45,
          turnaroundMinutes: 0,
          therapistBufferMinutes: 0,
        }),
      ]),
    )
    const roomCard = cardsOn(axes.rooms)[0]
    const therapistCard = cardsOn(axes.therapists)[0]
    if (roomCard === undefined || therapistCard === undefined) throw new Error('no card')
    // A zero-length band would be an element with no width that a test for "the turnaround is drawn" would
    // still find — which is how a page comes to claim it draws something it does not.
    expect(bandsOfKind(roomCard, 'turnaround')).toEqual([])
    expect(bandsOfKind(therapistCard, 'therapist_buffer')).toEqual([])
    expect(roomCard.bands.map((band) => band.kind)).toEqual(['treatment'])
    expect(therapistCard.bands.map((band) => band.kind)).toEqual(['treatment'])
    // The footprint is then the treatment and nothing more, on both axes.
    expect(roomCard.length).toBeCloseTo(therapistCard.length, 10)
  })

  it('clamps what it draws to the day and reports the minutes it does not draw', () => {
    // The last treatment of the day: 01:30–02:00 Dubai, whose 20-minute turnaround runs past the close.
    const late = appointment({
      id: 'late',
      startsAt: Date.parse('2099-06-17T21:30:00.000Z'),
      minutes: 30,
    })
    const card = cardsOn(calendarAxes(day([late])).rooms)[0]
    const turnaround = bandsOfKind(card as never, 'turnaround')[0]
    if (turnaround === undefined) throw new Error('no turnaround band')
    // The fact is 20 minutes; the drawing is nothing, because the grid ends at the close.
    expect(turnaround.minutes).toBe(TURNAROUND_MINUTES)
    expect(turnaround.length).toBe(0)
    expect(turnaround.offset).toBe(1)
    // The control: the same treatment earlier in the day draws its whole turnaround.
    const earlier = bandsOfKind(
      cardsOn(
        calendarAxes(day([appointment({ id: 'mid', startsAt: EVENING, minutes: 30 })])).rooms,
      )[0] as never,
      'turnaround',
    )[0]
    expect(earlier?.length).toBeGreaterThan(0)
  })
})

describe('acceptance — a treatment crossing midnight is one continuous block', () => {
  it('draws one treatment band, unsplit, on the trading date it belongs to', () => {
    // 23:50 Dubai on the 17th, 45 minutes, so it ends at 00:35 on the 18th — the same trading date,
    // because trading runs 11:00–02:00 and the session has not closed.
    const crossing = appointment({
      id: 'crossing',
      startsAt: Date.parse('2099-06-17T19:50:00.000Z'),
      minutes: 45,
    })
    const axes = calendarAxes(day([crossing]))
    const card = cardsOn(axes.rooms)[0]
    if (card === undefined) throw new Error('no card')
    const treatment = bandsOfKind(card, 'treatment')
    // ONE band. A grid whose coordinate space was the calendar date would have to split this in two, and
    // the second half would be drawn at the far left of the same day.
    expect(treatment).toHaveLength(1)
    expect(treatment[0]?.minutes).toBe(45)
    expect(treatment[0]?.length).toBeCloseTo(45 / 900, 10)
    // And it is inside the day, past the three-quarter mark: 23:50 is 770 minutes into a 900-minute day.
    expect(treatment[0]?.offset).toBeCloseTo(770 / 900, 10)
    expect((treatment[0]?.offset ?? 0) + (treatment[0]?.length ?? 0)).toBeLessThanOrEqual(1)

    // The control: the same wall-clock start on the day BEFORE is a different offset in a different day's
    // grid, so the offset above is a fact about this day rather than a constant.
    const previous = calendarAxes({
      ...day([crossing]),
      opensAt: Date.parse('2099-06-16T07:00:00.000Z'),
      closesAt: Date.parse('2099-06-16T22:00:00.000Z'),
      tradingDate: '2099-06-16',
    })
    expect(cardsOn(previous.rooms)[0]?.offset).not.toBeCloseTo(770 / 900, 3)
  })
})

describe('acceptance — the drop targets are the day’s own quarter hours', () => {
  it('starts at the open, steps by a quarter hour and stops before the close', () => {
    const axes = calendarAxes(day([]))
    expect(CALENDAR_STEP_MINUTES).toBe(15)
    // 900 minutes at 15 is 60, stated rather than counted after the fact.
    expect(axes.minutes).toBe(900)
    expect(axes.slots).toHaveLength(60)
    expect(axes.slots[0]?.startsAt).toBe(OPENS_AT)
    expect(axes.slots[0]?.label).toBe('11:00')
    // The last target STARTS inside the day. A target at the close would propose a start the booking rules
    // refuse, and refusing it here would be a second copy of `latestStart`.
    const last = axes.slots.at(-1)
    expect(last?.label).toBe('01:45')
    expect(last?.startsAt).toBeLessThan(CLOSES_AT)
    expect(last?.startsAt).toBe(CLOSES_AT - CALENDAR_STEP_MINUTES * MINUTE)
    // Labels are Dubai wall-clock, which is the point of them: the same instants in UTC read 07:00 and
    // 21:45, and a receptionist reading those would be four hours out.
    expect(axes.slots.map((slot) => slot.label)).toContain('00:00')
    expect(axes.slots.map((slot) => slot.label)).not.toContain('07:00')
    // Every target is inside the grid and carries the instant it means, in both spellings.
    for (const slot of axes.slots) {
      expect(slot.offset).toBeGreaterThanOrEqual(0)
      expect(slot.offset + slot.length).toBeLessThanOrEqual(1.0000001)
      expect(Date.parse(slot.startsAtIso)).toBe(slot.startsAt)
    }
  })

  it('answers no targets and no division by zero for a day with no length', () => {
    // Not a day the premises has, and the guard is not decoration: a `business_day` row whose hours were
    // written equal would otherwise divide by zero and lay every card out at NaN%, which draws as nothing
    // and reads as an empty diary.
    const axes = calendarAxes({
      ...day([appointment({ id: 'one', startsAt: OPENS_AT, minutes: 45 })]),
      closesAt: OPENS_AT,
    })
    expect(axes.slots).toEqual([])
    expect(axes.minutes).toBe(0)
    const card = cardsOn(axes.rooms)[0]
    expect(card?.offset).toBe(0)
    expect(card?.length).toBe(0)
    for (const band of card?.bands ?? []) expect(Number.isFinite(band.offset)).toBe(true)
  })
})
