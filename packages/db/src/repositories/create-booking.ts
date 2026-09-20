import { createHash, randomUUID } from 'node:crypto'
import {
  AppError,
  type GenderMatchingMode,
  genderMatchingMode,
  type RoomTypeName,
  type ServiceShape,
  type TherapistSkill,
} from '@berelax/shared'
import type { Actor, RequestContext } from '../audit.ts'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  readCommittedAppointments,
  readEligibleTherapists,
  type ScheduledAppointmentRow,
} from './eligibility.ts'

/**
 * The booking transaction (B-AVAIL-06). One transaction, or nothing.
 *
 * Everything a booking consists of commits together: the `booking` row, every `appointment` row, the
 * idempotency claim, the `booking.created` outbox event and the audit row. Any two of those five
 * without the third is a defect that is very hard to find later, because the evidence of it is exactly
 * the record that is missing (ADR 0008).
 *
 * ## The room row is the serialisation point
 *
 * `0024_appointment_constraints.sql` makes double-booking impossible for a *therapist* — an exclusion
 * constraint, and constraints do not race. The room half is a counting rule, and a count can be taken
 * twice: two transactions each read a capacity-2 room holding two places, each decide there is room,
 * and each commit a third. ADR 0024 records that as a consequence rather than leaving it implied, and
 * docs/01 decision 9 names the fix — `SELECT … FOR UPDATE` on the `rooms` row, taken by this
 * transaction before anything is counted.
 *
 * Two properties of that lock are decisions rather than details:
 *
 *   - **It is ordered by room id.** A couples booking touching two rooms and another touching the same
 *     two in the other order deadlock unless every writer takes them in one order. `order by id` is an
 *     order every writer can compute without coordinating, and `create-booking.concurrency.itest.ts`
 *     runs 200 interleaved iterations to show there is no deadlock left to find.
 *   - **It is taken before the re-validation, not after.** A lock taken after the count is a lock over
 *     nothing: the loser has already decided the slot is free. The loser here blocks on the lock, and
 *     when it is released re-reads the committed rows under READ COMMITTED — which is what makes the
 *     second request receive a named `slot_taken` instead of a raw `23P01` from the constraint, or
 *     worse, a `room_over_capacity` arriving from COMMIT.
 *
 * ## Idempotency is a constraint, not a set in memory
 *
 * A double-tapped Book button, a retry after a timeout and a refreshed confirmation page all arrive as
 * the same request twice. `booking_idempotency`'s PRIMARY KEY on the client-supplied key (0024) is what
 * makes the second one wait: the claim is inserted inside the booking's own transaction, so the second
 * transaction **blocks on the index** until the first commits or rolls back, and then either finds the
 * booking and replays it or gets a clean attempt at a key nobody holds. An in-memory set answers the
 * wrong question in the same process and no question at all in the second one; B-MSG-04's
 * `message_delivery_receipt_replay_unique` is the same mechanism for the same reason.
 *
 * Replaying a key with a *different* request is a caller bug and not a retry, so
 * `request_fingerprint` is compared and a mismatch is refused by name. Without that, the second request
 * is handed a booking for a slot it never asked for and reads it as success.
 *
 * ## The re-validation is injected, because `packages/db` may not import `packages/core`
 *
 * The rule that decides whether a tuple is still deliverable is `assignShape` in
 * `packages/core/src/availability/assign-shape.ts`, and the dependency runs core ← db. So the rule
 * arrives as a function (`SlotRecheck`) and this module supplies it with rows: the locked room, the
 * therapists the eligibility read model still accepts, and every committed appointment on the trading
 * date. That is the same arrangement B-CAT-05 made for the public-name lint, and it fails the same way
 * round — a caller that supplies no re-check is refused with `slot_not_revalidated` rather than
 * defaulting to "the page was probably still right".
 *
 * `packages/fixtures/src/booking-transaction.itest.ts` is where the pair is exercised, because
 * `packages/fixtures` is the only package allowed to import both.
 *
 * ## Eligibility is re-applied here, which is why `therapist_id` has no foreign key
 *
 * `appointment.therapist_id` is a plain uuid. `references employee (id)` is the constraint that fits
 * and it is not the claim worth making: `employee` holds every employee, so it would accept a
 * receptionist as the therapist of a massage while reading as though it had proved otherwise
 * (B-AVAIL-04's NOTE). The claim worth enforcing is B-AVAIL-04's read model — employed, skilled for
 * this treatment's style, rostered, not on approved leave, credentialled — plus B-AVAIL-05's
 * same-gender rule, re-applied against rows read inside this transaction. `readEligibleTherapists` is
 * that read model, and a therapist it excludes is refused with `therapist_not_eligible` naming the
 * reason.
 *
 * The gender rule is **not re-opened here**. The mode is passed through to the same reader the
 * availability query used and normalised by the same `genderMatchingMode`, so an absent or unreadable
 * setting is strict in this transaction exactly as it is in the solver, and a booking whose client
 * gender was never collected has no eligible therapist rather than a relaxed one.
 *
 * ## The price is snapshotted, never re-read
 *
 * `resolvePrice` (B-CAT-04) is pure and lives in core, so the figures arrive as an argument and are
 * written onto every appointment row: gross, net, VAT, the rate, and the `price_list_id` /
 * `promotion_id` that produced them. B-CAT-05 asserts that a later price-list change cannot move a
 * booked figure, and this is what makes that true. The split is re-checked here rather than left to
 * `appointment_price_split_exact`, so a caller gets a named refusal instead of a check violation.
 */

/** The SQLSTATEs this transaction translates. Every one of them is raised by a rule in the schema. */
export const BOOKING_SQLSTATE = {
  /** `room_over_capacity`, the deferred capacity trigger (0024, re-issued by 0038). */
  roomOverCapacity: 'ZB001',
  /** `delivery_incoherent`: the rows of one delivery disagree about the room, period or footprint. */
  deliveryIncoherent: 'ZB004',
} as const

/** `23P01`, exclusion_violation — `appointment_therapist_no_overlap`. */
const EXCLUSION_VIOLATION = '23P01'
/** `23505`, unique_violation. */
const UNIQUE_VIOLATION = '23505'
/** `23503`, foreign_key_violation. */
const FOREIGN_KEY_VIOLATION = '23503'
/** The PRIMARY KEY on `booking_idempotency.idempotency_key`, which PostgreSQL names for us. */
const IDEMPOTENCY_PK = 'booking_idempotency_pkey'
/** `appointment.trading_date` into `business_day`: a date the premises does not trade. */
const TRADING_DATE_FK = 'appointment_trading_date_fkey'

/** Every reason this transaction refuses, as a value. Callers branch on these, never on prose. */
export const BOOKING_REFUSALS = [
  'idempotency_key_required',
  'idempotency_key_reused',
  'booking_has_no_deliveries',
  'shape_not_offered',
  'therapist_count_wrong',
  'therapist_repeated',
  'price_split_disagrees',
  'requires_client_gender',
  'slot_not_revalidated',
  'room_not_found',
  'therapist_not_eligible',
  'slot_taken',
  'delivery_incoherent',
  'not_a_trading_date',
] as const
export type BookingRefusal = (typeof BOOKING_REFUSALS)[number]

/** The statuses a booking may be created in. A lifecycle transition is B-LIFE-01's, not this unit's. */
export const BOOKABLE_STATUSES = ['requested', 'confirmed'] as const
export type BookableStatus = (typeof BOOKABLE_STATUSES)[number]

/**
 * The price as `resolvePrice` returned it, in integer fils.
 *
 * `priceListId` and `promotionId` are `null` rather than absent when those layers did not apply — the
 * distinction `ResolvedPrice` makes, and the one a dispute is settled with: absent reads as "not
 * recorded", null reads as "considered, did not apply".
 */
export interface BookingPriceSnapshot {
  readonly grossFils: number
  readonly netFils: number
  readonly vatFils: number
  readonly vatRateBp: number
  readonly priceListId: string | null
  readonly promotionId: string | null
}

/** One delivery: one room, one period, one footprint, `therapistsRequired` appointment rows. */
export interface BookingDeliveryInput {
  /**
   * The delivery id, when the caller has one. Generated here otherwise.
   *
   * It is what the room's places are counted per (0038), so the two rows of a Four Hands must share it
   * — which is why this function writes them rather than leaving the caller to insert rows.
   */
  readonly deliveryId?: string
  /** The trading date, from `resolveTradingDate`. 01:30 belongs to the PREVIOUS trading date. */
  readonly tradingDate: string
  readonly serviceVariantId: string
  readonly shape: ServiceShape
  readonly roomId: string
  /** Exactly `therapists_required` distinct ids, as the assignment chose them. */
  readonly therapistIds: readonly string[]
  /** The treatment itself, in epoch milliseconds. Turnaround and buffer are not baked in. */
  readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  readonly price: BookingPriceSnapshot
  readonly status?: BookableStatus
}

export interface CreateBookingInput {
  /** The client-supplied key. Required, and the public endpoint refuses a request without one. */
  readonly idempotencyKey: string
  readonly customerId: string
  readonly source: 'online' | 'front_desk' | 'phone' | 'walk_in'
  readonly notes?: string
  /**
   * The **client's** gender, when it was collected. A different question from the therapist's.
   *
   * No table holds it (B-AVAIL-05's NOTE: `customer` has no gender column), so it is an argument. Under
   * strict matching its absence means no therapist is eligible, which is the refusal rather than the
   * relaxation.
   */
  readonly clientGender?: 'female' | 'male'
  /** `booking.same_gender_matching`, from `readGenderMatching`. **Absent is strict.** */
  readonly genderMatching?: GenderMatchingMode
  readonly deliveries: readonly BookingDeliveryInput[]
}

export interface CreatedBookingDelivery {
  readonly deliveryId: string
  readonly roomId: string
  readonly therapistIds: readonly string[]
  readonly appointmentIds: readonly string[]
  readonly roomPlaces: number
  readonly turnaroundMinutes: number
  readonly therapistBufferMinutes: number
}

export interface CreatedBooking {
  readonly bookingId: string
  readonly deliveries: readonly CreatedBookingDelivery[]
  /** True when the idempotency key had already been used by an identical request. */
  readonly replayed: boolean
}

/** A `rooms` row, as the re-check needs it. Field for field the shape of `Room` in `@berelax/core`. */
export interface SlotRecheckRoom {
  readonly id: string
  readonly roomType: RoomTypeName
  readonly capacity: number
  readonly isBookable: boolean
}

/** A `service_resource_shape` row. Field for field the shape of `ResourceShape` in `@berelax/core`. */
export interface SlotRecheckShape {
  readonly shape: ServiceShape
  readonly therapistsRequired: number
  readonly roomsRequired: number
  readonly minRoomCapacity: number
  readonly requiredRoomType?: RoomTypeName
  readonly therapistBufferMinutes: number
}

/** Everything `assignShape` needs, read inside the transaction with the room row locked. */
export interface SlotRecheckInput {
  readonly shape: SlotRecheckShape
  /** The candidate rooms — in practice the one requested, so the answer is "still this room, or no". */
  readonly rooms: readonly SlotRecheckRoom[]
  readonly therapistIds: readonly string[]
  readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  readonly appointments: readonly ScheduledAppointmentRow[]
}

export type SlotRecheckResult =
  | {
      readonly kind: 'assigned'
      readonly roomId: string
      readonly therapistIds: readonly string[]
      readonly placesUsed: number
    }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * `assignShape`, injected.
 *
 * A function rather than an import because `packages/db` must never import `packages/core`. Required
 * rather than optional: a booking written without it would be a booking nobody re-checked, and the
 * permissive default is the one failure this whole transaction exists to prevent.
 */
export type SlotRecheck = (input: SlotRecheckInput) => SlotRecheckResult

export interface CreateBookingDeps {
  readonly recheck: SlotRecheck
}

const refusal = (
  kind: 'conflict' | 'validation' | 'invariant_violated',
  name: BookingRefusal,
  message: string,
  extra: Record<string, unknown> = {},
): AppError =>
  new AppError(kind, `${name}: ${message}`, {
    userFacing: true,
    details: { refusal: name, ...extra },
  })

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/** The constraint a driver error names, from either spelling the drivers use. */
const constraintOf = (err: unknown): string | undefined => {
  const named = err as { constraint_name?: unknown; constraint?: unknown } | null
  if (typeof named?.constraint_name === 'string') return named.constraint_name
  if (typeof named?.constraint === 'string') return named.constraint
  const carried = (err as { details?: { constraint?: unknown } } | null)?.details?.constraint
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a PostgreSQL error from the booking schema into a named `AppError`, or `null`.
 *
 * Exported for the same reason `journalError` and `catalogueError` are: two of the rules that matter
 * most here are deferred constraint triggers, and a caller that wraps only its INSERTs will see them
 * arrive from `COMMIT`. This transaction forces them early with `set constraints all immediate` so the
 * translation happens where the context is, but the export stays because a caller composing another
 * statement into the same unit of work can still meet them at the end.
 *
 * Anything unrecognised returns `null` and is rethrown: a translation that guessed would report a disk
 * error as a taken slot, and the front desk would go looking for a booking that does not exist.
 */
export function bookingError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  const details = { sqlState: code, constraint: constraintOf(err) }
  switch (code) {
    case BOOKING_SQLSTATE.roomOverCapacity:
      return refusal(
        'conflict',
        'slot_taken',
        `the room has no free place left for this booking. ${message}`,
        details,
      )
    case BOOKING_SQLSTATE.deliveryIncoherent:
      return refusal('invariant_violated', 'delivery_incoherent', message, details)
    case EXCLUSION_VIOLATION:
      // The therapist half of ADR 0015. It can only be this constraint: it is the only EXCLUDE on
      // `appointment`, and the room half is a trigger with its own SQLSTATE.
      return refusal(
        'conflict',
        'slot_taken',
        `one of these therapists is already booked over this period. ${message}`,
        details,
      )
    case FOREIGN_KEY_VIOLATION:
      // Only this one foreign key. Every other 23503 on this table means something else entirely, and
      // reporting it as "the premises does not trade then" would send the reader to the wrong table.
      return constraintOf(err) === TRADING_DATE_FK
        ? refusal(
            'validation',
            'not_a_trading_date',
            'the premises does not trade on that date, so there is no trading day for the ' +
              'appointment to belong to. The trading calendar is a table (0011), not a rule.',
            details,
          )
        : null
    default:
      return null
  }
}

/** The refusal an error carries, or `null`. Lets a caller branch without matching on the message. */
export function bookingRefusalOf(err: unknown): BookingRefusal | null {
  const translated = err instanceof AppError ? err : bookingError(err)
  const name = translated?.details['refusal']
  return BOOKING_REFUSALS.includes(name as BookingRefusal) ? (name as BookingRefusal) : null
}

/** True when the error is a second request losing the race for one idempotency key. */
export function isIdempotencyRace(err: unknown): boolean {
  return sqlState(err) === UNIQUE_VIOLATION && constraintOf(err) === IDEMPOTENCY_PK
}

/**
 * A stable fingerprint of the request the key claimed.
 *
 * Over the fields that decide **what was booked** — the customer, and every delivery's variant, shape,
 * room, therapists and period — and deliberately not over the notes or the source, which a retry may
 * legitimately spell differently. Sorted and explicit rather than `JSON.stringify(input)`: object key
 * order is insertion order in JavaScript, so a caller assembling the same request from two code paths
 * would produce two fingerprints and its own retry would read as a reused key.
 */
export function requestFingerprint(input: CreateBookingInput): string {
  const canonical = [
    input.customerId,
    ...[...input.deliveries]
      .map((delivery) =>
        [
          delivery.tradingDate,
          delivery.serviceVariantId,
          delivery.shape,
          delivery.roomId,
          [...delivery.therapistIds].sort().join(','),
          String(delivery.treatment.startsAt),
          String(delivery.treatment.endsAt),
          String(delivery.price.grossFils),
        ].join('|'),
      )
      .sort(),
  ].join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

interface IdempotencyRow {
  readonly booking_id: string
  readonly request_fingerprint: string
}

/** The booking a key already produced, with every appointment it wrote. `null` when the key is free. */
export async function readBookingByIdempotencyKey(
  sql: Sql,
  idempotencyKey: string,
): Promise<CreatedBooking | null> {
  const [claim] = await sql<IdempotencyRow[]>`
    select booking_id::text as booking_id, request_fingerprint
      from booking_idempotency where idempotency_key = ${idempotencyKey}
  `
  if (claim === undefined) return null
  return {
    bookingId: claim.booking_id,
    deliveries: await readBookingDeliveries(sql, claim.booking_id),
    replayed: true,
  }
}

/** The fingerprint a key was claimed with, for the mismatch check. `null` when the key is free. */
async function readClaim(sql: Sql, idempotencyKey: string): Promise<IdempotencyRow | undefined> {
  const [claim] = await sql<IdempotencyRow[]>`
    select booking_id::text as booking_id, request_fingerprint
      from booking_idempotency where idempotency_key = ${idempotencyKey}
  `
  return claim
}

/** A booking's deliveries, grouped from its appointment rows. Ordered so a replay is diffable. */
export async function readBookingDeliveries(
  sql: Sql,
  bookingId: string,
): Promise<readonly CreatedBookingDelivery[]> {
  const rows = await sql<
    {
      id: string
      delivery_id: string
      room_id: string
      therapist_id: string
      room_places: number
      turnaround_minutes: number
      therapist_buffer_minutes: number
    }[]
  >`
    select id::text as id, delivery_id::text as delivery_id, room_id::text as room_id,
           therapist_id::text as therapist_id, room_places, turnaround_minutes,
           therapist_buffer_minutes
      from appointment
     where booking_id = ${bookingId}
     order by lower(period), delivery_id, therapist_id
  `
  const grouped = new Map<string, CreatedBookingDelivery>()
  for (const row of rows) {
    const held = grouped.get(row.delivery_id)
    grouped.set(row.delivery_id, {
      deliveryId: row.delivery_id,
      roomId: row.room_id,
      therapistIds: [...(held?.therapistIds ?? []), row.therapist_id],
      appointmentIds: [...(held?.appointmentIds ?? []), row.id],
      roomPlaces: Number(row.room_places),
      turnaroundMinutes: Number(row.turnaround_minutes),
      therapistBufferMinutes: Number(row.therapist_buffer_minutes),
    })
  }
  return [...grouped.values()]
}

interface FootprintRow {
  readonly shape: ServiceShape
  readonly therapists_required: number
  readonly rooms_required: number
  readonly min_room_capacity: number
  readonly required_room_type: RoomTypeName | null
  readonly therapist_buffer_minutes: number
  readonly turnaround_minutes: number
  readonly required_skill: TherapistSkill
}

/**
 * The footprint and the two snapshot figures, read from the catalogue **inside the transaction**.
 *
 * Not taken from the caller, and that is the point of it being here: `turnaround_minutes` and
 * `therapist_buffer_minutes` are snapshotted onto the appointment, and the value worth freezing is the
 * one in force at the instant the booking is taken. A caller-supplied figure would let a stale page
 * write a turnaround the owner changed an hour ago.
 *
 * A missing `service_resource_shape` row is `shape_not_offered` rather than a default. 0017's composite
 * foreign key makes the absence structural — "this treatment is not sold in that footprint" — and the
 * permissive reading would book a Four Hands for a treatment nobody offers one for.
 */
async function readFootprint(sql: Sql, delivery: BookingDeliveryInput): Promise<Footprint> {
  const [row] = await sql<FootprintRow[]>`
    select srs.shape,
           srs.therapists_required,
           srs.rooms_required,
           srs.min_room_capacity,
           srs.required_room_type::text as required_room_type,
           srs.therapist_buffer_minutes,
           s.turnaround_minutes,
           sk.required_skill::text as required_skill
      from service_variant v
      join service s on s.id = v.service_id
      join service_skill sk on sk.style = s.style
      join service_resource_shape srs
        on srs.service_style = s.style
       and srs.service_treatment_key = s.treatment_key
       and srs.shape = ${delivery.shape}::service_shape
     where v.id = ${delivery.serviceVariantId}
  `
  if (row === undefined) {
    throw refusal(
      'conflict',
      'shape_not_offered',
      `no service_resource_shape row offers the ${delivery.shape} footprint for this variant, so ` +
        'nothing says how many therapists or what kind of room it needs',
      { serviceVariantId: delivery.serviceVariantId, shape: delivery.shape },
    )
  }
  return {
    shape: {
      shape: row.shape,
      therapistsRequired: Number(row.therapists_required),
      roomsRequired: Number(row.rooms_required),
      minRoomCapacity: Number(row.min_room_capacity),
      // Spread rather than assigned: under `exactOptionalPropertyTypes` an explicit `undefined` is a
      // different type from an absent key, and absent is what "any compatible type" means here.
      ...(row.required_room_type === null ? {} : { requiredRoomType: row.required_room_type }),
      therapistBufferMinutes: Number(row.therapist_buffer_minutes),
    },
    turnaroundMinutes: Number(row.turnaround_minutes),
    requiredSkill: row.required_skill,
  }
}

/**
 * Locks every room a transaction will write, in ascending room-id order.
 *
 * The order is the deadlock-avoidance rule: two transactions taking the same set of rows in the same
 * order queue instead of waiting on each other. Ascending id is a *total* order that every writer can
 * compute alone, which is what makes it work without any coordination between them.
 *
 * Exported for B-LIFE-03's reschedule, which writes appointment rows into the same rooms and must
 * therefore take the same locks in the same order — two writers ordering differently is the deadlock this
 * function exists to prevent, and a second copy of it would be a second order.
 */
export async function lockRooms(sql: Sql, roomIds: readonly string[]): Promise<SlotRecheckRoom[]> {
  const locked: SlotRecheckRoom[] = []
  // ONE STATEMENT PER ROOM, in the order given — which the caller has sorted by id.
  //
  // A single `where id = any(...) order by id for update` takes the same locks in one round trip, and it
  // was the first version of this function. It is wrong for the claim being made: the order locks are
  // acquired in is then a property of the PLAN rather than of this code. A sequential scan returns
  // physical order, an index scan returns index order, `ORDER BY` is applied after the rows are locked,
  // and none of the three is a promise the planner makes. Deadlock avoidance needs an order every writer
  // computes the same way, so it is computed here and visible in the loop.
  for (const id of roomIds) {
    const [row] = await sql<
      { id: string; room_type: RoomTypeName; capacity: number; is_bookable: boolean }[]
    >`
      select id::text as id, room_type::text as room_type, capacity, is_bookable
        from rooms where id = ${id}
         for update
    `
    if (row === undefined) continue
    locked.push({
      id: row.id,
      roomType: row.room_type,
      capacity: Number(row.capacity),
      isBookable: row.is_bookable,
    })
  }
  return locked
}

function assertRequestIsWellFormed(input: CreateBookingInput): void {
  if (input.idempotencyKey.trim() === '') {
    throw refusal(
      'validation',
      'idempotency_key_required',
      'a booking request carries a client-supplied idempotency key; without one a retry is ' +
        'indistinguishable from a second booking',
    )
  }
  if (input.deliveries.length === 0) {
    throw refusal(
      'validation',
      'booking_has_no_deliveries',
      'a booking with no appointments is a commercial record of nothing',
    )
  }
  // B-AVAIL-05's rule, honoured rather than re-opened. Under strict matching the solver returns ZERO
  // slots and the reason code `requires_client_gender` before any start is considered, so a booking
  // path that accepted an unrecorded client gender would book through a refusal the availability query
  // had already made — and `readEligibleTherapists` cannot catch it, because an absent client gender
  // means "this query is not about a client" there (the admin calendar asks who is working on
  // Thursday). `genderMatchingMode` is the same normaliser the settings reader and core apply, so an
  // absent or unreadable mode is strict here exactly as it is there.
  if (genderMatchingMode(input.genderMatching) === 'strict' && input.clientGender === undefined) {
    throw refusal(
      'validation',
      'requires_client_gender',
      "the client's gender has not been collected, and same-gender matching is a hard constraint " +
        'under strict mode (ADR 0020, Y9-gender open). It is a fact no table holds, so it is an ' +
        'argument the caller has to write out; a booking taken without it would assign a therapist ' +
        'the availability query refused to offer.',
    )
  }
  for (const delivery of input.deliveries) {
    if (new Set(delivery.therapistIds).size !== delivery.therapistIds.length) {
      throw refusal(
        'validation',
        'therapist_repeated',
        'a pair that is one therapist listed twice is not two therapists, and ' +
          'appointment_therapist_no_overlap refuses the second row',
        { therapistIds: [...delivery.therapistIds] },
      )
    }
    const { grossFils, netFils, vatFils } = delivery.price
    if (netFils + vatFils !== grossFils) {
      throw refusal(
        'validation',
        'price_split_disagrees',
        `net ${netFils} + VAT ${vatFils} is ${netFils + vatFils}, not the gross ${grossFils}. VAT is ` +
          'derived as the remainder so the identity is exact (ADR 0007); a pair that fails it is a ' +
          'one-fils discrepancy on an invoice',
        { grossFils, netFils, vatFils },
      )
    }
  }
}

/** The ISO instant a `tstzrange` bound is built from. The zone is UTC and always written out. */
const iso = (epochMs: number): string => new Date(epochMs).toISOString()

interface Footprint {
  readonly shape: SlotRecheckShape
  readonly turnaroundMinutes: number
  readonly requiredSkill: TherapistSkill
}

/**
 * Re-applies B-AVAIL-04's eligibility read model to the therapists this delivery names.
 *
 * Narrowed to those ids, so the answer is about them rather than about the roster: an id the model
 * excludes is refused by name, with the reason it gave. The gender mode is forwarded rather than
 * re-decided, so strict here means what it means in the solver (B-AVAIL-05).
 */
async function assertTherapistsAreEligible(
  uow: UnitOfWork,
  args: {
    readonly input: CreateBookingInput
    readonly delivery: BookingDeliveryInput
    readonly footprint: Footprint
  },
): Promise<void> {
  const { input, delivery, footprint } = args
  const pool = await readEligibleTherapists(uow.sql, {
    tradingDate: delivery.tradingDate,
    requiredSkill: footprint.requiredSkill,
    employeeIds: delivery.therapistIds,
    ...(input.clientGender === undefined ? {} : { clientGender: input.clientGender }),
    ...(input.genderMatching === undefined ? {} : { genderMatching: input.genderMatching }),
  })
  const eligible = new Set(pool.therapists.map((therapist) => therapist.therapistId))
  const ineligible = delivery.therapistIds.filter((id) => !eligible.has(id))
  if (ineligible.length === 0) return
  throw refusal(
    'conflict',
    'therapist_not_eligible',
    `${ineligible.length} of the named therapists may not take this appointment. ` +
      'appointment.therapist_id has no foreign key precisely because `references employee (id)` ' +
      'would accept a receptionist as the therapist of a massage; this is the claim that constraint ' +
      'could not make.',
    {
      shape: delivery.shape,
      ineligible,
      excluded: pool.excluded.filter((row) => ineligible.includes(row.therapistId)),
    },
  )
}

/**
 * Writes one delivery: `therapistsRequired` appointment rows sharing one delivery id.
 *
 * The rows are written here rather than by the caller because they have to share `delivery_id` and
 * `room_places`, and `appointment.delivery_id`'s default produces a fresh id per row — which is exactly
 * the per-row place count 0038 corrected.
 *
 * `committed` is appended to, so the next delivery of the same booking is counted against these rows.
 */
async function writeDelivery(
  uow: UnitOfWork,
  args: {
    readonly bookingId: string
    readonly input: CreateBookingInput
    readonly delivery: BookingDeliveryInput
    readonly footprint: Footprint
    readonly room: SlotRecheckRoom
    readonly recheck: SlotRecheck
    readonly committed: ScheduledAppointmentRow[]
  },
): Promise<CreatedBookingDelivery> {
  const { bookingId, input, delivery, footprint, room, recheck, committed } = args

  if (delivery.therapistIds.length !== footprint.shape.therapistsRequired) {
    throw refusal(
      'validation',
      'therapist_count_wrong',
      `the ${delivery.shape} footprint needs exactly ${footprint.shape.therapistsRequired} ` +
        `therapist(s); ${delivery.therapistIds.length} were named. Dropping the extra one silently ` +
        'would book a shape nobody asked for.',
      { shape: delivery.shape, named: delivery.therapistIds.length },
    )
  }

  await assertTherapistsAreEligible(uow, { input, delivery, footprint })

  const verdict = recheck({
    shape: footprint.shape,
    // Only the room that was asked for. The question here is "is THIS tuple still deliverable", not
    // "find me a room": silently moving the booking to another room would change what the customer was
    // told, and the confirmation has already been rendered.
    rooms: [room],
    therapistIds: delivery.therapistIds,
    treatment: delivery.treatment,
    appointments: committed,
  })
  if (verdict.kind === 'refused') {
    throw refusal(
      'conflict',
      'slot_taken',
      `the slot is no longer available (${verdict.reason}). Somebody else committed it while this ` +
        'request was in flight, which is what the room lock exists to make orderly rather than ' +
        'simultaneous.',
      { reason: verdict.reason, roomId: delivery.roomId, shape: delivery.shape },
    )
  }

  const deliveryId = delivery.deliveryId ?? randomUUID()
  const status = delivery.status ?? 'requested'
  const appointmentIds: string[] = []
  for (const therapistId of verdict.therapistIds) {
    const [row] = await uow.sql<{ id: string }[]>`
      insert into appointment (
        booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
        delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
        gross_price_fils, net_fils, vat_fils, vat_rate_bp, price_list_id, promotion_id
      ) values (
        ${bookingId},
        ${delivery.tradingDate}::date,
        ${delivery.serviceVariantId},
        ${delivery.shape}::service_shape,
        ${therapistId},
        ${delivery.roomId},
        ${`[${iso(delivery.treatment.startsAt)},${iso(delivery.treatment.endsAt)})`}::tstzrange,
        ${status}::appointment_status,
        ${deliveryId},
        ${verdict.placesUsed},
        ${footprint.turnaroundMinutes},
        ${footprint.shape.therapistBufferMinutes},
        ${delivery.price.grossFils},
        ${delivery.price.netFils},
        ${delivery.price.vatFils},
        ${delivery.price.vatRateBp},
        ${delivery.price.priceListId},
        ${delivery.price.promotionId}
      )
      returning id::text as id
    `
    const appointmentId = (row as { id: string }).id
    appointmentIds.push(appointmentId)
    committed.push({
      id: appointmentId,
      roomId: delivery.roomId,
      therapistIds: [therapistId],
      delivery: { id: deliveryId, places: verdict.placesUsed },
      treatment: delivery.treatment,
      turnaroundMinutes: footprint.turnaroundMinutes,
      therapistBufferMinutes: footprint.shape.therapistBufferMinutes,
    })
  }

  return {
    deliveryId,
    roomId: delivery.roomId,
    therapistIds: [...verdict.therapistIds],
    appointmentIds,
    roomPlaces: verdict.placesUsed,
    turnaroundMinutes: footprint.turnaroundMinutes,
    therapistBufferMinutes: footprint.shape.therapistBufferMinutes,
  }
}

/**
 * Creates the booking inside an existing unit of work. All of it, or none of it.
 *
 * Call it through {@link bookSlot} unless the booking is part of a larger transaction: `bookSlot` owns
 * the one recovery this function cannot perform, which is the second request of a double tap finding
 * its key already taken — that arrives as a unique violation, and a unique violation has aborted the
 * transaction it arrived in.
 */
export async function createBooking(
  uow: UnitOfWork,
  input: CreateBookingInput,
  deps: CreateBookingDeps,
): Promise<CreatedBooking> {
  // Fail closed, exactly as `setPublicDisplayName` refuses to write an unlinted public name. A booking
  // written without the availability rule being re-applied is a booking nobody checked.
  if (typeof deps?.recheck !== 'function') {
    throw refusal(
      'invariant_violated',
      'slot_not_revalidated',
      'no slot re-check was supplied, so nothing re-applied the availability rule inside the ' +
        'transaction. `assignShape` from @berelax/core is the rule; packages/db may not import it, ' +
        'so the caller injects it.',
    )
  }
  assertRequestIsWellFormed(input)

  const fingerprint = requestFingerprint(input)

  // The fast path. A retry that arrives after the first request committed is answered from the claim
  // without taking a single lock, which is what makes a refreshed confirmation page cheap.
  const claimed = await readClaim(uow.sql, input.idempotencyKey)
  if (claimed !== undefined) {
    if (claimed.request_fingerprint !== fingerprint) {
      throw refusal(
        'conflict',
        'idempotency_key_reused',
        'this idempotency key was used for a different request. Replaying it would hand back a ' +
          'booking for a slot this request did not ask for, and the caller would read it as success.',
        { idempotencyKey: input.idempotencyKey },
      )
    }
    return {
      bookingId: claimed.booking_id,
      deliveries: await readBookingDeliveries(uow.sql, claimed.booking_id),
      replayed: true,
    }
  }

  const [bookingRow] = await uow.sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${input.customerId}, ${input.source}, ${input.notes ?? null})
    returning id::text as id
  `
  const bookingId = (bookingRow as { id: string }).id

  // Claimed BEFORE any room is locked and any row is counted. A concurrent transaction holding the
  // same key blocks here, on the primary key's index, and does no further work until this one commits
  // or rolls back — which is how a double tap produces one booking rather than two attempts at one
  // slot, and the reason `bookSlot` can answer the loser from the winner's own row.
  await uow.sql`
    insert into booking_idempotency (idempotency_key, request_fingerprint, booking_id)
    values (${input.idempotencyKey}, ${fingerprint}, ${bookingId})
  `

  const footprints = await Promise.all(
    input.deliveries.map((delivery) => readFootprint(uow.sql, delivery)),
  )

  // Every room this booking writes, de-duplicated and SORTED. The sort is the deadlock-avoidance rule
  // and it is here, at the call site, because it is a property of the request rather than of the query:
  // two bookings naming the same two rooms in opposite orders must still take the locks in one order.
  const roomIds = [...new Set(input.deliveries.map((delivery) => delivery.roomId))].sort()
  const locked = await lockRooms(uow.sql, roomIds)
  for (const roomId of roomIds) {
    if (!locked.some((room) => room.id === roomId)) {
      throw refusal('validation', 'room_not_found', `no room with id ${roomId}`, { roomId })
    }
  }

  // Read AFTER the lock. Under READ COMMITTED this is the first statement that can see a competitor's
  // committed appointment, and seeing it is the whole purpose of having waited.
  const tradingDates = [...new Set(input.deliveries.map((delivery) => delivery.tradingDate))]
  const committed: ScheduledAppointmentRow[] = []
  for (const tradingDate of tradingDates) {
    committed.push(...(await readCommittedAppointments(uow.sql, { tradingDate })))
  }

  const written: CreatedBookingDelivery[] = []
  for (const [index, delivery] of input.deliveries.entries()) {
    written.push(
      await writeDelivery(uow, {
        bookingId,
        input,
        delivery,
        footprint: footprints[index] as Footprint,
        room: locked.find((candidate) => candidate.id === delivery.roomId) as SlotRecheckRoom,
        recheck: deps.recheck,
        // Mutated by `writeDelivery`, on purpose: the rows it writes join the set the NEXT delivery is
        // counted against. Without that a booking of two deliveries into one capacity-2 room would
        // check both against an empty room and meet the third place at COMMIT — the all-or-none
        // failure arriving from the one place this transaction cannot name it.
        committed,
      }),
    )
  }

  // Forces the two DEFERRED triggers — `appointment_room_capacity` and
  // `appointment_delivery_is_coherent` — to fire here rather than at COMMIT. They are deferred because
  // a legitimate rearrangement passes through a state they would refuse (ADR 0024), and this
  // transaction has finished rearranging: checking now means a refusal arrives where the context is,
  // as a named `slot_taken`, instead of from a COMMIT this function does not execute.
  await uow.sql`set constraints all immediate`

  await uow.audit.record({
    action: 'booking.created',
    entityType: 'booking',
    entityId: bookingId,
    operation: 'create',
    after: {
      source: input.source,
      customer_id: input.customerId,
      idempotency_key: input.idempotencyKey,
      request_fingerprint: fingerprint,
      deliveries: written.map((delivery) => ({
        delivery_id: delivery.deliveryId,
        room_id: delivery.roomId,
        therapist_ids: delivery.therapistIds,
        room_places: delivery.roomPlaces,
        appointment_ids: delivery.appointmentIds,
      })),
      // The figures as snapshotted, so the audit row explains a disputed amount without joining.
      prices: input.deliveries.map((delivery) => ({
        gross_price_fils: delivery.price.grossFils,
        net_fils: delivery.price.netFils,
        vat_fils: delivery.price.vatFils,
        price_list_id: delivery.price.priceListId,
        promotion_id: delivery.price.promotionId,
      })),
    },
  })

  // Same transaction as the rows, so a booking cannot exist without its event and an event cannot
  // exist for a booking that rolled back (ADR 0008). The key is derived from the booking rather than
  // random, so a retry of this operation cannot enqueue a second copy.
  await uow.publish({
    eventType: 'booking.created',
    aggregateType: 'booking',
    aggregateId: bookingId,
    idempotencyKey: `booking.created:${bookingId}`,
    payload: {
      bookingId,
      source: input.source,
      customerId: input.customerId,
      deliveries: written.map((delivery) => ({
        deliveryId: delivery.deliveryId,
        roomId: delivery.roomId,
        therapistIds: delivery.therapistIds,
        appointmentIds: delivery.appointmentIds,
      })),
    },
  })

  return { bookingId, deliveries: written, replayed: false }
}

/**
 * The booking transaction, with the one recovery that cannot happen inside it.
 *
 * Two requests with the same idempotency key and the first still in flight: the second blocks on
 * `booking_idempotency_pkey`, and when the first commits it is handed a unique violation — which has
 * already aborted its own transaction, so it cannot read the winner's booking from there. This function
 * catches exactly that error, on exactly that constraint, and answers the loser from the committed
 * claim. Any other failure is translated by {@link bookingError} and rethrown.
 *
 * `set constraints all immediate` inside the transaction means a capacity refusal has already been
 * turned into a named error by the time this function sees it; the translation here is the backstop for
 * a constraint that still arrives from `COMMIT`.
 */
export async function bookSlot(
  sql: Sql,
  actor: Actor,
  input: CreateBookingInput,
  deps: CreateBookingDeps,
  context: RequestContext = {},
): Promise<CreatedBooking> {
  try {
    return await withUnitOfWork(sql, actor, (uow) => createBooking(uow, input, deps), context)
  } catch (err) {
    if (isIdempotencyRace(err)) {
      const existing = await readBookingByIdempotencyKey(sql, input.idempotencyKey)
      // `null` means the winner rolled back after all, which releases the key: that is a genuine retry
      // and it deserves the error rather than a fabricated success.
      if (existing !== null) {
        const claim = await readClaim(sql, input.idempotencyKey)
        if (claim?.request_fingerprint !== requestFingerprint(input)) {
          throw refusal(
            'conflict',
            'idempotency_key_reused',
            'this idempotency key was used for a different request, which was in flight at the same ' +
              'time as this one',
            { idempotencyKey: input.idempotencyKey },
          )
        }
        return existing
      }
    }
    throw bookingError(err) ?? err
  }
}
