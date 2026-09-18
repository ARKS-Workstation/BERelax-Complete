/**
 * Room predicates: is this room busy, and may this service be delivered in it.
 *
 * ## Half-open, everywhere
 *
 * Every period here is `[startsAt, endsAt)` — the same `'[)'` convention the database stores
 * (ADR 0015). Two treatments that abut exactly at 14:00 do not overlap, and a maintenance block that
 * ends at 14:00 does not consume the 14:00 slot. Get this wrong in one direction and the day silently
 * loses a slot after every closure; get it wrong in the other and two clients are booked into the
 * same room at the boundary minute. The boundary is asserted directly in the tests, because it is the
 * only case where the two possible implementations disagree.
 *
 * ## Compatibility has no fall-back
 *
 * `roomAcceptsService` takes the room types a service may be delivered in and answers over exactly
 * those. An empty list means **no room**, never "any room". The permissive reading is the failure
 * this predicate exists to prevent: it would put a Morocco Bath in a dry room the moment a
 * compatibility row was missing, and the customer would be the one to discover it.
 *
 * Pure: instants and records in, booleans and arrays out. No clock, no database, no ordering
 * assumptions about the inputs.
 */
import { AppError } from '@berelax/shared'
import type { Instant } from '../time.ts'

/** The three kinds of treatment room. Mirrors the `room_type` Postgres enum. */
export type RoomType = 'standard' | 'couples' | 'wet'

export const ROOM_TYPES: readonly RoomType[] = ['standard', 'couples', 'wet']

/** A half-open span of time, `[startsAt, endsAt)`. */
export interface Period {
  readonly startsAt: Instant
  readonly endsAt: Instant
}

/** A schedulable room. Shaped from a `rooms` row; the id is opaque to this module. */
export interface Room {
  readonly id: string
  readonly roomType: RoomType
  /** Clients the room holds at once. Authoritative, never derived from `roomType`. */
  readonly capacity: number
  /** False for a decommissioned room, which keeps its history but takes no new bookings. */
  readonly isBookable: boolean
}

/** Room unavailability that is not a booking. Shaped from a `resource_block` row. */
export interface ResourceBlock {
  readonly roomId: string
  readonly period: Period
  readonly kind: 'maintenance' | 'deep_clean' | 'hold' | 'other'
  readonly reason: string
}

/**
 * True when a period covers no time at all.
 *
 * An empty period overlaps nothing, exactly as `tstzrange(t, t, '[)')` is empty in Postgres and
 * `&&` against it is false. Treated as a question rather than an error, because a zero-length period
 * is a legitimate thing to ask about — the answer is simply that nothing collides with it.
 */
export function isEmptyPeriod(period: Period): boolean {
  return period.endsAt <= period.startsAt
}

/**
 * True when two half-open periods share at least one instant.
 *
 * An inverted period is rejected rather than normalised. Postgres raises on
 * `tstzrange(later, earlier)`, and silently swapping the bounds here would make the predicate
 * disagree with the constraint that is meant to be the arbiter.
 */
export function periodsOverlap(a: Period, b: Period): boolean {
  assertOrdered(a)
  assertOrdered(b)
  if (isEmptyPeriod(a) || isEmptyPeriod(b)) return false
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt
}

/**
 * True when a resource block makes the room unavailable at any point in `period`.
 *
 * Blocks for other rooms are ignored rather than treated as an error: the caller is expected to hand
 * over the day's blocks for the whole premises, and filtering here means no caller has to remember to.
 */
export function roomBusyDuring(args: {
  readonly roomId: string
  readonly period: Period
  readonly blocks: readonly ResourceBlock[]
}): boolean {
  const { roomId, period, blocks } = args
  return blocks.some((block) => block.roomId === roomId && periodsOverlap(block.period, period))
}

/** The blocks that collide with a period, for an explanation rather than a yes/no. */
export function blocksAffecting(args: {
  readonly roomId: string
  readonly period: Period
  readonly blocks: readonly ResourceBlock[]
}): ResourceBlock[] {
  const { roomId, period, blocks } = args
  return blocks.filter((block) => block.roomId === roomId && periodsOverlap(block.period, period))
}

/**
 * True when the service may be delivered in this room at all.
 *
 * `compatibleRoomTypes` is the service's `service_room_type_compat` rows. An empty list yields false
 * for every room — that is the whole point of the table having no default.
 */
export function roomAcceptsService(room: Room, compatibleRoomTypes: readonly RoomType[]): boolean {
  return compatibleRoomTypes.includes(room.roomType)
}

/**
 * The rooms a service can actually be delivered in over a period.
 *
 * Four independent reasons a room drops out, all applied: it is decommissioned, its type is not
 * compatible with the service, it is too small for the number of clients, or it is blocked. Each one
 * is a different conversation with the customer, which is why `bookableRoomsBecause` exists
 * alongside this.
 *
 * Ordering is the caller's input order, not scarcity order. Preferring a standard room over the only
 * couples room is a scheduling policy and belongs to the availability engine — a predicate that
 * quietly sorted would make that policy invisible and unchangeable.
 */
export function bookableRoomsFor(args: {
  readonly rooms: readonly Room[]
  readonly compatibleRoomTypes: readonly RoomType[]
  readonly period: Period
  readonly blocks?: readonly ResourceBlock[]
  readonly clients?: number
}): Room[] {
  const { rooms, compatibleRoomTypes, period, blocks = [], clients = 1 } = args
  if (!Number.isInteger(clients) || clients < 1) {
    throw new AppError('validation', `A booking is for at least one client, received ${clients}`)
  }
  return rooms.filter(
    (room) =>
      room.isBookable &&
      roomAcceptsService(room, compatibleRoomTypes) &&
      room.capacity >= clients &&
      !roomBusyDuring({ roomId: room.id, period, blocks }),
  )
}

/** Why a room is unavailable, in the order the reasons are checked. */
export type RoomUnavailableReason =
  | 'not_bookable'
  | 'incompatible_room_type'
  | 'insufficient_capacity'
  | 'blocked'

/**
 * The first reason a room cannot take the booking, or `undefined` when it can.
 *
 * A named reason rather than a boolean, for the same argument as `resolveTradingDate`: "no
 * availability" with no reason attached is the answer the front desk cannot act on, and the fix is
 * usually "the wet room is under maintenance until Thursday" rather than anything about the slot.
 */
export function roomUnavailableReason(args: {
  readonly room: Room
  readonly compatibleRoomTypes: readonly RoomType[]
  readonly period: Period
  readonly blocks?: readonly ResourceBlock[]
  readonly clients?: number
}): RoomUnavailableReason | undefined {
  const { room, compatibleRoomTypes, period, blocks = [], clients = 1 } = args
  if (!room.isBookable) return 'not_bookable'
  if (!roomAcceptsService(room, compatibleRoomTypes)) return 'incompatible_room_type'
  if (room.capacity < clients) return 'insufficient_capacity'
  if (roomBusyDuring({ roomId: room.id, period, blocks })) return 'blocked'
  return undefined
}

function assertOrdered(period: Period): void {
  if (period.endsAt < period.startsAt) {
    throw new AppError(
      'validation',
      `A period cannot end before it starts: ${period.startsAt} .. ${period.endsAt}`,
    )
  }
}
