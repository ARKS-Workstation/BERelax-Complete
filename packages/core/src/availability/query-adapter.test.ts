/**
 * The read path's solver seam, asserted as the composition it is.
 *
 * `solveAvailabilityQuery` adds no rule: it narrows the pool by gender (B-AVAIL-05), solves the grid
 * (B-AVAIL-02) and assigns a concrete tuple (B-AVAIL-03), in that order. So every assertion here is about
 * the ORDER and the PLUMBING — that the gender rule is applied before the solve rather than as a filter
 * afterwards, that the shape decides the client count and the buffer rather than the caller, that a start
 * no tuple can deliver is reported with the assignment layer's own reason instead of vanishing, and that
 * the free sets are carried alongside the chosen tuple.
 *
 * Every positive assertion is paired with a control that must fail if the plumbing were wired the other
 * way round. A test that cannot fail is not a test (ADR 0003).
 *
 * Therapists are ids and never names: a therapist has no display name until an admin sets one (ADR 0020).
 */
import { describe, expect, it } from 'vitest'
import { type Instant, instantFromIso, toLocal } from '../time.ts'
import { FOUR_HANDS_SHAPE } from './assign-shape.ts'
import {
  type AvailabilityAppointmentInput,
  type AvailabilityQueryFacts,
  type AvailabilityShapeInput,
  type AvailabilitySolvedDay,
  solveAvailabilityQuery,
} from './query-adapter.ts'

const DATE = '2026-10-02'
/** 11:00–02:00, the real trading hours, and the reason a treatment may cross midnight. */
const HOURS = { [DATE]: { open: '11:00', close: '02:00' } }
/** Well before the day, so neither the 2-hour lead nor the 90-day advance is what decides anything. */
const NOW = instantFromIso('2026-10-01T08:00:00+04:00') as number

const at = (iso: string): number => instantFromIso(iso) as number
const wall = (instant: number): string => toLocal(instant as Instant).time
const startsOf = (solved: AvailabilitySolvedDay): string[] =>
  solved.slots.map((s) => wall(s.startsAt))
const reasonAt = (solved: AvailabilitySolvedDay, time: string): string | undefined =>
  solved.rejected.find((r) => wall(r.startsAt) === time)?.reason

const THERAPIST_F1 = 'therapist-f1'
const THERAPIST_F2 = 'therapist-f2'
const THERAPIST_M1 = 'therapist-m1'
/** Holds an existing appointment and is in no pool, so it occupies a resource without competing. */
const OUTSIDE_POOL = 'therapist-99'

const ROOM_A = { id: 'room-a', roomType: 'standard' as const, capacity: 1, isBookable: true }
const ROOM_B = { id: 'room-b', roomType: 'standard' as const, capacity: 1, isBookable: true }
const WET = { id: 'room-wet', roomType: 'wet' as const, capacity: 1, isBookable: true }

const SOLO: AvailabilityShapeInput = {
  shape: 'solo',
  therapistsRequired: 1,
  roomsRequired: 1,
  minRoomCapacity: 1,
  therapistBufferMinutes: 10,
}

/** Two therapists over ONE client: one delivery, one place in a standard room (docs/13 §4). */
const FOUR_HANDS: AvailabilityShapeInput = {
  shape: 'four_hands',
  therapistsRequired: 2,
  roomsRequired: 1,
  minRoomCapacity: 1,
  requiredRoomType: 'standard',
  therapistBufferMinutes: 10,
}

const appointment = (
  overrides: Partial<AvailabilityAppointmentInput> = {},
): AvailabilityAppointmentInput => ({
  id: 'appointment-1',
  roomId: ROOM_A.id,
  therapistIds: [OUTSIDE_POOL],
  delivery: { id: 'delivery-1', places: 1 },
  treatment: { startsAt: at(`${DATE}T19:00:00+04:00`), endsAt: at(`${DATE}T20:00:00+04:00`) },
  turnaroundMinutes: 20,
  therapistBufferMinutes: 10,
  ...overrides,
})

function facts(overrides: Partial<AvailabilityQueryFacts> = {}): AvailabilityQueryFacts {
  return {
    now: NOW,
    tradingDate: DATE,
    hours: HOURS,
    closures: [],
    durationMinutes: 60,
    turnaroundMinutes: 20,
    minLeadMinutes: 120,
    maxAdvanceDays: 90,
    shape: SOLO,
    compatibleRoomTypes: ['standard'],
    rooms: [ROOM_A],
    therapists: [{ therapistId: THERAPIST_F1, skills: ['asian_style'], gender: 'female' }],
    shifts: [
      {
        therapistId: THERAPIST_F1,
        period: {
          startsAt: at(`${DATE}T11:00:00+04:00`),
          endsAt: at('2026-10-03T02:00:00+04:00'),
        },
      },
    ],
    appointments: [],
    blocks: [],
    clientGender: 'female',
    ...overrides,
  }
}

describe('solveAvailabilityQuery', () => {
  it('offers starts with a concrete room, a concrete therapist and the free sets beside them', () => {
    const solved = solveAvailabilityQuery(facts())
    expect(solved.refusal).toBeNull()
    expect(solved.slots.length).toBeGreaterThan(0)
    for (const slot of solved.slots) {
      expect(slot.roomId).toBe(ROOM_A.id)
      expect(slot.therapistIds).toEqual([THERAPIST_F1])
      expect(slot.availableRoomIds).toContain(ROOM_A.id)
      expect(slot.availableTherapistIds).toContain(THERAPIST_F1)
      expect(slot.placesUsed).toBe(1)
      expect(slot.genderMismatch).toBe(false)
    }
    // The therapist buffer eats the day's first grid point: an 11:00 start needs the therapist from
    // 10:50 and the roster begins at 11:00, so the first offered start is 11:15. The ROOM is free at
    // 11:00, which is the distinction B-AVAIL-02 keeps.
    expect(startsOf(solved)[0]).toBe('11:15')
    // 02:00 close, 60 + 20: `latestStartIn` is 00:40 and the grid is on the wall clock, so 00:30.
    expect(startsOf(solved).at(-1)).toBe('00:30')
    expect(solved.windows).toHaveLength(1)
  })

  it('refuses the whole request when the client gender was never collected and matching is strict', () => {
    const solved = solveAvailabilityQuery(facts({ clientGender: undefined }))
    expect(solved.refusal).toBe('requires_client_gender')
    expect(solved.slots).toEqual([])
    // No rejected starts and no windows: no start was CONSIDERED, and reporting a full day would send
    // the reader to the rota rather than to the intake form.
    expect(solved.rejected).toEqual([])
    expect(solved.windows).toEqual([])
    expect(solved.excludedByGender.map((row) => row.therapistId)).toEqual([THERAPIST_F1])
  })

  it('answers the same request under advisory matching', () => {
    // The control for the refusal above: the mode is the only difference, and it comes from the caller
    // rather than from this function. `absent is strict` is `genderMatchingMode`'s rule, not a default here.
    const solved = solveAvailabilityQuery(
      facts({ clientGender: undefined, genderMatching: 'advisory' }),
    )
    expect(solved.refusal).toBeNull()
    expect(solved.slots.length).toBeGreaterThan(0)
    // Nothing is PROVED a same-gender match when the client's gender is unknown, so every slot says so.
    expect(solved.slots.every((slot) => slot.genderMismatch)).toBe(true)
    expect(solved.slots[0]?.availableTherapistIds).toEqual([THERAPIST_F1])
  })

  it('removes a cross-gender therapist before the solve rather than filtering slots after it', () => {
    const solved = solveAvailabilityQuery(
      facts({
        therapists: [
          { therapistId: THERAPIST_M1, skills: ['asian_style'], gender: 'male' },
          { therapistId: THERAPIST_F1, skills: ['asian_style'], gender: 'female' },
        ],
        shifts: [
          {
            therapistId: THERAPIST_M1,
            period: {
              startsAt: at(`${DATE}T11:00:00+04:00`),
              endsAt: at('2026-10-03T02:00:00+04:00'),
            },
          },
          ...facts().shifts,
        ],
      }),
    )
    // Applied BEFORE the solve, so the excluded id is in no slot's free set — not merely absent from the
    // chosen tuple. Filtering afterwards cannot undo the intervals computed from their presence.
    for (const slot of solved.slots) {
      expect(slot.availableTherapistIds).not.toContain(THERAPIST_M1)
    }
    expect(solved.excludedByGender.map((row) => row.therapistId)).toEqual([THERAPIST_M1])
  })

  it('reports a start the assignment layer cannot deliver with the assignment layer own reason', () => {
    // One therapist free, a Four Hands asked for. The solver offers the start — a room and a therapist
    // ARE free — and `assignShape` refuses it for want of a second therapist. Dropping it silently would
    // lose the one sentence the front desk needs: "we have a room but not two therapists."
    const solved = solveAvailabilityQuery(facts({ shape: FOUR_HANDS }))
    expect(solved.slots).toEqual([])
    expect(reasonAt(solved, '13:00')).toBe('too_few_therapists')
  })

  it('assigns a Four Hands as ONE delivery of one client in a capacity-1 standard room', () => {
    // The control for the case above, and the shape 0038 corrected: two therapists over one client is
    // one place, so the room the salon actually owns fits it.
    const solved = solveAvailabilityQuery(
      facts({
        shape: FOUR_HANDS,
        therapists: [
          { therapistId: THERAPIST_F1, skills: ['asian_style'], gender: 'female' },
          { therapistId: THERAPIST_F2, skills: ['asian_style'], gender: 'female' },
        ],
        shifts: [
          ...facts().shifts,
          {
            therapistId: THERAPIST_F2,
            period: {
              startsAt: at(`${DATE}T11:00:00+04:00`),
              endsAt: at('2026-10-03T02:00:00+04:00'),
            },
          },
        ],
      }),
    )
    expect(solved.slots.length).toBeGreaterThan(0)
    expect(solved.slots[0]?.therapistIds).toEqual([THERAPIST_F1, THERAPIST_F2])
    expect(solved.slots[0]?.placesUsed).toBe(1)
    expect(solved.slots[0]?.roomId).toBe(ROOM_A.id)
    // The shape's own figure, which is what `FOUR_HANDS_SHAPE` in core states independently.
    expect(FOUR_HANDS.minRoomCapacity).toBe(FOUR_HANDS_SHAPE.minRoomCapacity)
  })

  it('narrows the compatible room types by the shape required room type', () => {
    // The service is compatible with both; the shape insists on a standard room. Only a wet room is
    // supplied, so nothing is offered — the narrowing is `shapeRoomTypes`', applied here and not by the
    // caller, so no route can widen it.
    const solved = solveAvailabilityQuery(
      facts({ shape: FOUR_HANDS, compatibleRoomTypes: ['standard', 'wet'], rooms: [WET] }),
    )
    expect(solved.slots).toEqual([])
    expect(reasonAt(solved, '13:00')).toBe('no_room_available')
  })

  it('offers nothing when the service is compatible with no room type at all', () => {
    // `service_room_type_compat` is fail-closed by design (0012): an empty set means NO room, never any
    // room. The permissive reading would offer a Morocco Bath in a standard room.
    const solved = solveAvailabilityQuery(facts({ compatibleRoomTypes: [] }))
    expect(solved.slots).toEqual([])
    expect(reasonAt(solved, '13:00')).toBe('no_room_available')
  })

  it('counts an existing appointment room occupancy including its own turnaround', () => {
    const solved = solveAvailabilityQuery(facts({ appointments: [appointment()] }))
    const starts = startsOf(solved)
    // 19:00–20:00 plus a 20-minute turnaround holds the room to 20:20, and a candidate's own room
    // interval is [start, start + 80), so every start from 17:45 to 20:15 collides. 20:30 is the first
    // grid point clear of it — not 20:20, which the wall-clock grid never offers.
    expect(starts).not.toContain('19:00')
    expect(starts).not.toContain('20:00')
    expect(starts).not.toContain('20:15')
    expect(starts).toContain('20:30')
    expect(starts).toContain('17:30')
    expect(starts).not.toContain('17:45')
    expect(reasonAt(solved, '19:00')).toBe('no_room_available')
  })

  it('counts an existing appointment therapist occupancy including its own buffer', () => {
    // A second room, so the ROOM is never the reason — and the appointment is held by the pool's own
    // therapist rather than by an outsider, which is what makes this the therapist half.
    const solved = solveAvailabilityQuery(
      facts({
        rooms: [ROOM_A, ROOM_B],
        appointments: [appointment({ roomId: ROOM_B.id, therapistIds: [THERAPIST_F1] })],
      }),
    )
    expect(reasonAt(solved, '19:00')).toBe('no_therapist_available')
    expect(startsOf(solved)).not.toContain('20:00')
  })

  it('subtracts a room block, with its kind and reason carried through', () => {
    const solved = solveAvailabilityQuery(
      facts({
        blocks: [
          {
            roomId: ROOM_A.id,
            period: {
              startsAt: at(`${DATE}T15:00:00+04:00`),
              endsAt: at(`${DATE}T17:00:00+04:00`),
            },
            kind: 'deep_clean',
            reason: 'linen delivery',
          },
        ],
      }),
    )
    expect(startsOf(solved)).not.toContain('15:00')
    expect(reasonAt(solved, '15:00')).toBe('no_room_available')
    expect(startsOf(solved)).toContain('17:00')
  })

  it('subtracts a premises closure from the day windows', () => {
    // Always empty from the database today — a whole-day closure is absent from `business_day` and an
    // intra-day one is a room block — and the field exists so a caller that acquires a source has
    // somewhere to put it other than a fake block per room.
    const solved = solveAvailabilityQuery(
      facts({
        closures: [
          {
            startsAt: at(`${DATE}T14:00:00+04:00`),
            endsAt: at(`${DATE}T18:00:00+04:00`),
            reason: 'staff meeting',
          },
        ],
      }),
    )
    expect(solved.windows).toHaveLength(2)
    expect(startsOf(solved)).not.toContain('14:00')
    expect(startsOf(solved)).not.toContain('16:00')
    expect(startsOf(solved)).toContain('18:00')
  })

  it('honours a caller supplied grid step', () => {
    const solved = solveAvailabilityQuery(facts({ stepMinutes: 60 }))
    // 11:15 on a 60-minute grid aligned to the wall clock is 12:00, because `alignToStep` rounds the
    // window's own start up to the next multiple of the step since midnight.
    expect(startsOf(solved)[0]).toBe('12:00')
    expect(startsOf(solved)).not.toContain('11:15')
  })

  it('returns no window at all for a trading date the premises does not open', () => {
    const solved = solveAvailabilityQuery(facts({ hours: {} }))
    expect(solved.windows).toEqual([])
    expect(solved.slots).toEqual([])
    expect(solved.rejected).toEqual([])
  })

  it('omits a therapist gender rather than answering null when nobody has recorded it', () => {
    // Y8-staff leaves `employee.gender` nullable and the port omits the key rather than answering null,
    // so absence has one spelling. Under STRICT matching absence is a MISMATCH and not a wildcard.
    const solved = solveAvailabilityQuery(
      facts({ therapists: [{ therapistId: THERAPIST_F1, skills: ['asian_style'] }] }),
    )
    expect(solved.slots).toEqual([])
    expect(solved.excludedByGender.map((row) => row.reason)).toEqual(['gender_mismatch'])
  })

  it('refuses a start before the minimum lead and offers the one exactly at it', () => {
    // The lead boundary is inclusive, and the off-by-one in the other direction loses the 14:00 slot to
    // a 12:00 query for ever.
    const solved = solveAvailabilityQuery(facts({ now: at(`${DATE}T11:00:00+04:00`) }))
    expect(reasonAt(solved, '12:45')).toBe('before_minimum_lead')
    expect(startsOf(solved)).toContain('13:00')
  })

  it('refuses every start beyond the maximum advance', () => {
    const solved = solveAvailabilityQuery(
      facts({ maxAdvanceDays: 1, now: at('2026-09-01T12:00:00+04:00') }),
    )
    expect(solved.slots).toEqual([])
    expect(reasonAt(solved, '13:00')).toBe('beyond_maximum_advance')
  })

  it('returns rejected starts in ascending order', () => {
    const solved = solveAvailabilityQuery(facts({ shape: FOUR_HANDS }))
    const starts = solved.rejected.map((row) => row.startsAt)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
  })
})
