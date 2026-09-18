import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { addMinutes, type Instant, instantFromIso } from '../time.ts'
import {
  blocksAffecting,
  bookableRoomsFor,
  isEmptyPeriod,
  type Period,
  periodsOverlap,
  type ResourceBlock,
  ROOM_TYPES,
  type Room,
  type RoomType,
  roomAcceptsService,
  roomBusyDuring,
  roomUnavailableReason,
} from './room-predicates.ts'

/**
 * B-CAT-02 — the pure room predicates.
 *
 * The one assertion that earns the file is the boundary: a block that ends exactly when a treatment
 * starts must NOT make the room busy. That is the only input where the two plausible implementations
 * disagree, so every overlap test here is paired with its abutting control — a test that only ever
 * checks the overlapping case passes just as happily against an inclusive upper bound.
 */

const at = (iso: string): Instant => instantFromIso(iso)

/** 19:00–20:00 Dubai on a trading night, which is 15:00–16:00 UTC. */
const PERIOD: Period = {
  startsAt: at('2026-10-02T19:00:00+04:00'),
  endsAt: at('2026-10-02T20:00:00+04:00'),
}

const period = (fromIso: string, untilIso: string): Period => ({
  startsAt: at(fromIso),
  endsAt: at(untilIso),
})

const block = (
  roomId: string,
  fromIso: string,
  untilIso: string,
  kind: ResourceBlock['kind'] = 'maintenance',
): ResourceBlock => ({
  roomId,
  period: period(fromIso, untilIso),
  kind,
  reason: 'linen delivery',
})

const room = (id: string, roomType: RoomType, capacity: number, isBookable = true): Room => ({
  id,
  roomType,
  capacity,
  isBookable,
})

/** The provisional inventory from migration 0012: three standard, one couples, one wet. */
const INVENTORY: readonly Room[] = [
  room('room-1', 'standard', 1),
  room('room-2', 'standard', 1),
  room('room-3', 'standard', 1),
  room('room-couples', 'couples', 2),
  room('room-wet', 'wet', 1),
]

/** The compatibility sets migration 0012 seeds, as the pure predicate sees them. */
const DRY_MASSAGE: readonly RoomType[] = ['standard', 'couples']
const MOROCCO_BATH: readonly RoomType[] = ['wet']

describe('acceptance — roomBusyDuring at the boundary minute', () => {
  it('is busy when a block overlaps the period', () => {
    expect(
      roomBusyDuring({
        roomId: 'room-1',
        period: PERIOD,
        blocks: [block('room-1', '2026-10-02T19:30:00+04:00', '2026-10-02T21:00:00+04:00')],
      }),
    ).toBe(true)
  })

  it('is NOT busy when a block merely abuts the start of the period', () => {
    // 18:00–19:00 against 19:00–20:00. Under '[]' bounds this would collide; under '[)' it does not,
    // and this is the case that decides which the implementation uses.
    expect(
      roomBusyDuring({
        roomId: 'room-1',
        period: PERIOD,
        blocks: [block('room-1', '2026-10-02T18:00:00+04:00', '2026-10-02T19:00:00+04:00')],
      }),
    ).toBe(false)
  })

  it('is NOT busy when a block merely abuts the end of the period', () => {
    expect(
      roomBusyDuring({
        roomId: 'room-1',
        period: PERIOD,
        blocks: [block('room-1', '2026-10-02T20:00:00+04:00', '2026-10-02T21:30:00+04:00')],
      }),
    ).toBe(false)
  })

  it('becomes busy when the abutting block is extended by a single minute — the control', () => {
    // The paired control for both abutting cases above. Without it, an implementation that always
    // returned false would satisfy them.
    const abutting = block('room-1', '2026-10-02T18:00:00+04:00', '2026-10-02T19:00:00+04:00')
    const overlappingByOneMinute: ResourceBlock = {
      ...abutting,
      period: { startsAt: abutting.period.startsAt, endsAt: addMinutes(abutting.period.endsAt, 1) },
    }
    expect(roomBusyDuring({ roomId: 'room-1', period: PERIOD, blocks: [abutting] })).toBe(false)
    expect(
      roomBusyDuring({ roomId: 'room-1', period: PERIOD, blocks: [overlappingByOneMinute] }),
    ).toBe(true)
  })

  it('ignores a block on a different room', () => {
    const blocks = [block('room-wet', '2026-10-02T19:15:00+04:00', '2026-10-02T19:45:00+04:00')]
    expect(roomBusyDuring({ roomId: 'room-1', period: PERIOD, blocks })).toBe(false)
    // Control: the same block does make its own room busy, so the filter is on the id and not on
    // the overlap arithmetic silently failing.
    expect(roomBusyDuring({ roomId: 'room-wet', period: PERIOD, blocks })).toBe(true)
  })

  it('is not busy with no blocks at all', () => {
    expect(roomBusyDuring({ roomId: 'room-1', period: PERIOD, blocks: [] })).toBe(false)
  })

  it('names the colliding blocks, so "no availability" can say why', () => {
    const blocks = [
      block('room-wet', '2026-10-02T19:30:00+04:00', '2026-10-02T21:00:00+04:00', 'deep_clean'),
      block('room-wet', '2026-10-02T20:00:00+04:00', '2026-10-02T22:00:00+04:00', 'hold'),
      block('room-1', '2026-10-02T19:30:00+04:00', '2026-10-02T21:00:00+04:00', 'other'),
    ]
    const affecting = blocksAffecting({ roomId: 'room-wet', period: PERIOD, blocks })
    expect(affecting).toHaveLength(1)
    expect(affecting[0]?.kind).toBe('deep_clean')
  })
})

describe('periodsOverlap', () => {
  it('is symmetric', () => {
    const a = period('2026-10-02T19:00:00+04:00', '2026-10-02T20:00:00+04:00')
    const b = period('2026-10-02T19:45:00+04:00', '2026-10-02T20:15:00+04:00')
    expect(periodsOverlap(a, b)).toBe(true)
    expect(periodsOverlap(b, a)).toBe(true)
  })

  it('treats containment as overlap in both directions', () => {
    const outer = period('2026-10-02T18:00:00+04:00', '2026-10-02T23:00:00+04:00')
    const inner = period('2026-10-02T19:00:00+04:00', '2026-10-02T19:10:00+04:00')
    expect(periodsOverlap(outer, inner)).toBe(true)
    expect(periodsOverlap(inner, outer)).toBe(true)
  })

  it('says an empty period overlaps nothing, exactly as an empty tstzrange does', () => {
    const instant = at('2026-10-02T19:30:00+04:00')
    const empty: Period = { startsAt: instant, endsAt: instant }
    expect(isEmptyPeriod(empty)).toBe(true)
    expect(periodsOverlap(empty, PERIOD)).toBe(false)
    expect(periodsOverlap(PERIOD, empty)).toBe(false)
    // Control: the same instant inside a one-minute period does overlap.
    expect(isEmptyPeriod(PERIOD)).toBe(false)
    expect(
      periodsOverlap(period('2026-10-02T19:30:00+04:00', '2026-10-02T19:31:00+04:00'), PERIOD),
    ).toBe(true)
  })

  it('refuses an inverted period rather than swapping the bounds', () => {
    // Postgres raises on tstzrange(later, earlier). Normalising here would make this predicate
    // disagree with the constraint that is supposed to be the arbiter.
    const inverted = period('2026-10-02T20:00:00+04:00', '2026-10-02T19:00:00+04:00')
    expect(() => periodsOverlap(inverted, PERIOD)).toThrow(AppError)
    expect(() => periodsOverlap(PERIOD, inverted)).toThrow(/cannot end before it starts/)
  })
})

describe('acceptance — compatibility never falls back to "any room"', () => {
  it('yields zero rooms for a service with no compatibility rows', () => {
    const bookable = bookableRoomsFor({
      rooms: INVENTORY,
      compatibleRoomTypes: [],
      period: PERIOD,
    })
    expect(bookable).toEqual([])
    // The control that makes the empty result meaningful: the same inventory and period with a real
    // compatibility set returns rooms. Without this, a predicate hard-wired to return [] would pass.
    expect(
      bookableRoomsFor({ rooms: INVENTORY, compatibleRoomTypes: DRY_MASSAGE, period: PERIOD }),
    ).toHaveLength(4)
  })

  it('resolves Morocco Bath to the wet room only', () => {
    const bookable = bookableRoomsFor({
      rooms: INVENTORY,
      compatibleRoomTypes: MOROCCO_BATH,
      period: PERIOD,
    })
    expect(bookable.map((r) => r.id)).toEqual(['room-wet'])
  })

  it('accepts a room whose type is listed and refuses one whose type is not', () => {
    expect(roomAcceptsService(room('room-wet', 'wet', 1), MOROCCO_BATH)).toBe(true)
    expect(roomAcceptsService(room('room-1', 'standard', 1), MOROCCO_BATH)).toBe(false)
    expect(roomAcceptsService(room('room-1', 'standard', 1), [])).toBe(false)
  })

  it('covers exactly the three room types, so a fourth cannot be added without a migration', () => {
    expect(ROOM_TYPES).toEqual(['standard', 'couples', 'wet'])
  })
})

describe('bookableRoomsFor', () => {
  it('drops a decommissioned room', () => {
    const rooms = [room('room-1', 'standard', 1, false), room('room-2', 'standard', 1)]
    expect(
      bookableRoomsFor({ rooms, compatibleRoomTypes: DRY_MASSAGE, period: PERIOD }).map(
        (r) => r.id,
      ),
    ).toEqual(['room-2'])
  })

  it('drops a room too small for the number of clients', () => {
    // A couple needs capacity 2, which only the couples room has.
    const bookable = bookableRoomsFor({
      rooms: INVENTORY,
      compatibleRoomTypes: DRY_MASSAGE,
      period: PERIOD,
      clients: 2,
    })
    expect(bookable.map((r) => r.id)).toEqual(['room-couples'])
    // Control: at one client the standard rooms come back too.
    expect(
      bookableRoomsFor({ rooms: INVENTORY, compatibleRoomTypes: DRY_MASSAGE, period: PERIOD }),
    ).toHaveLength(4)
  })

  it('drops a room that is blocked during the period', () => {
    const bookable = bookableRoomsFor({
      rooms: INVENTORY,
      compatibleRoomTypes: MOROCCO_BATH,
      period: PERIOD,
      blocks: [block('room-wet', '2026-10-02T19:30:00+04:00', '2026-10-02T21:00:00+04:00')],
    })
    expect(bookable).toEqual([])
  })

  it('keeps the caller ordering rather than ranking by scarcity', () => {
    const reversed = [...INVENTORY].reverse()
    const bookable = bookableRoomsFor({
      rooms: reversed,
      compatibleRoomTypes: DRY_MASSAGE,
      period: PERIOD,
    })
    expect(bookable.map((r) => r.id)).toEqual(['room-couples', 'room-3', 'room-2', 'room-1'])
  })

  it('refuses a client count that is not a positive integer', () => {
    for (const clients of [0, -1, 1.5]) {
      expect(() =>
        bookableRoomsFor({
          rooms: INVENTORY,
          compatibleRoomTypes: DRY_MASSAGE,
          period: PERIOD,
          clients,
        }),
      ).toThrow(AppError)
    }
  })
})

describe('roomUnavailableReason', () => {
  const cases: readonly [
    string,
    Parameters<typeof roomUnavailableReason>[0],
    string | undefined,
  ][] = [
    [
      'a decommissioned room',
      {
        room: room('room-1', 'standard', 1, false),
        compatibleRoomTypes: DRY_MASSAGE,
        period: PERIOD,
      },
      'not_bookable',
    ],
    [
      'a dry room for a Morocco Bath',
      { room: room('room-1', 'standard', 1), compatibleRoomTypes: MOROCCO_BATH, period: PERIOD },
      'incompatible_room_type',
    ],
    [
      'a single room for a couple',
      {
        room: room('room-1', 'standard', 1),
        compatibleRoomTypes: DRY_MASSAGE,
        period: PERIOD,
        clients: 2,
      },
      'insufficient_capacity',
    ],
    [
      'a room under maintenance',
      {
        room: room('room-wet', 'wet', 1),
        compatibleRoomTypes: MOROCCO_BATH,
        period: PERIOD,
        blocks: [block('room-wet', '2026-10-02T19:30:00+04:00', '2026-10-02T21:00:00+04:00')],
      },
      'blocked',
    ],
    [
      'a room that can take the booking',
      { room: room('room-wet', 'wet', 1), compatibleRoomTypes: MOROCCO_BATH, period: PERIOD },
      undefined,
    ],
  ]

  for (const [label, args, expected] of cases) {
    it(`reports ${expected ?? 'no reason'} for ${label}`, () => {
      expect(roomUnavailableReason(args)).toBe(expected)
    })
  }

  it('reports the first reason only, so the message is the one worth saying', () => {
    // Decommissioned AND incompatible AND blocked. The customer-facing answer is that the room is
    // out of service, not that the bath is in the wrong room.
    expect(
      roomUnavailableReason({
        room: room('room-1', 'standard', 1, false),
        compatibleRoomTypes: MOROCCO_BATH,
        period: PERIOD,
        blocks: [block('room-1', '2026-10-02T19:30:00+04:00', '2026-10-02T21:00:00+04:00')],
      }),
    ).toBe('not_bookable')
  })
})
