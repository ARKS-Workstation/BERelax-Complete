import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { serviceShape, serviceVariant } from './catalogue.ts'
import { customer } from './customer.ts'
import { priceList } from './price-list.ts'
import { rooms } from './rooms.ts'
import { businessDay } from './trading.ts'

/**
 * Drizzle mirror of `packages/db/migrations/0024_appointment_constraints.sql`.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`,
 * which compares these definitions against the live database in both directions.
 *
 * `serviceShape` is **imported** from `./catalogue.ts` rather than redeclared: a second
 * `pgEnum('service_shape', …)` would compile, read identically and be a different Postgres type.
 */

/**
 * `tstzrange`, which Drizzle has no built-in column type for.
 *
 * Carried as the Postgres text form rather than parsed into a pair of instants — the same choice
 * `./rooms.ts` makes for `resource_block.period`, and for the same reason: parsing it here would put
 * range semantics in the ORM layer, where a caller could construct an inclusive upper bound without
 * noticing. The database refuses anything but `[)` (`appointment_period_half_open`).
 */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tstzrange'
  },
})

/**
 * The `fils` domain from `0002_conventions.sql`: AED minor units as `bigint`.
 *
 * Carried as the string Postgres sends rather than a JS `number`, because `int8` does not fit in a
 * double and a silent precision loss in a money column is discovered during a VAT reconciliation.
 */
const fils = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'fils'
  },
})

/**
 * The nine appointment states B-LIFE-01 declares.
 *
 * Two distinct cancellations on purpose. `cancelled_by_customer` and `cancelled_by_salon` carry
 * different cancellation-policy and reporting consequences, and one shared `cancelled` label loses
 * which of the two happened — a distinction that then has to be recovered from an audit row, which
 * is to say it cannot be.
 *
 * **Which transitions are legal is not encoded here.** That is B-LIFE-01's transition table; a state
 * machine split between a migration and a data structure is a state machine with two answers.
 */
export const appointmentStatus = pgEnum('appointment_status', [
  'requested',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'no_show',
  'cancelled_by_customer',
  'cancelled_by_salon',
  'rescheduled',
])

/**
 * The commercial container: one booking, n appointments.
 *
 * That shape is what lets Four Hands and Couple Massage be resource **shapes** of existing services
 * (0017) rather than extra menu items — two therapists over one or two clients is two appointment
 * rows under one commercial record.
 *
 * There is deliberately **no status column**. A booking's state is a projection of its appointments,
 * and a second status would make "is this cancelled?" a question with two answers that drift apart
 * the first time a multi-appointment booking is half-cancelled.
 */
export const booking = pgTable(
  'booking',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /**
     * Attached here per the NOTE on B-LIFE-02: 0019 built the customer half, this unit the booking
     * half. `RESTRICT` on delete, because a booking is a financial record rather than a detail of a
     * contact.
     */
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onUpdate: 'cascade', onDelete: 'restrict' }),
    /** `online` | `front_desk` | `phone` | `walk_in`. A walk-in has given no online consent. */
    source: text('source').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('booking_customer_idx').on(t.customerId, t.createdAt.desc()),
    check('booking_source_check', sql`${t.source} in ('online', 'front_desk', 'phone', 'walk_in')`),
  ],
)

/**
 * One delivery: one therapist, one room, one period.
 *
 * Double-booking is refused by the **database** (ADR 0015), not by the application: an exclusion
 * constraint for the therapist, and a deferred constraint trigger counting overlaps against
 * `rooms.capacity` for the room. Neither is expressible here, so both live in the migration and are
 * asserted against a real PostgreSQL in `booking-constraints.itest.ts`.
 */
export const appointment = pgTable(
  'appointment',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => booking.id, { onDelete: 'cascade' }),
    /**
     * The trading date, materialised (0011) rather than derived. Trading runs 11:00–02:00, so a
     * 01:30 appointment belongs to the *previous* trading date and no truncation of `lower(period)`
     * gets that right. On the appointment rather than the booking because a reschedule moves one
     * appointment, and B-LIFE-03 re-resolves the trading date per appointment across midnight.
     */
    tradingDate: date('trading_date')
      .notNull()
      .references(() => businessDay.tradingDate, { onUpdate: 'cascade', onDelete: 'restrict' }),
    serviceVariantId: uuid('service_variant_id')
      .notNull()
      .references(() => serviceVariant.id, { onDelete: 'restrict' }),
    /** The footprint delivered. Whether it is *eligible* is the solver's question (B-AVAIL-03). */
    shape: serviceShape('shape').notNull(),
    /**
     * Deliberately **not** a foreign key: B-AVAIL-04 creates `employee` and depends on this unit, so
     * there is no parent to reference yet. The exclusion constraint does not need one — it compares
     * this column to itself.
     */
    therapistId: uuid('therapist_id').notNull(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'restrict' }),
    /**
     * The treatment, `[)` bounds. **Not** the room occupancy: turnaround extends the room's busy
     * interval and the therapist buffer extends the therapist's, and B-AVAIL-02 keeps the three
     * apart. Storing the padded interval here would make the padding unrecoverable and re-padding it
     * a second time the first bug.
     */
    period: tstzrange('period').notNull(),
    /**
     * The rows of **one delivery** share this (0038).
     *
     * Two therapists over one client — Four Hands — is one delivery, two rows and **one** place in the
     * room. `room_peak_concurrency` sums `roomPlaces` over distinct delivery ids, so this column is
     * what stopped `rooms.capacity` (clients) being compared against appointment rows (therapists),
     * which made Four Hands unbookable in every standard room the salon owns.
     *
     * Defaulted per row in the database, and the default is the strict reading: a writer that knows
     * nothing about deliveries produces one delivery per row, which is the old count.
     */
    deliveryId: uuid('delivery_id').notNull(),
    /** Clients this delivery puts in the room — `service_resource_shape.min_room_capacity`. */
    roomPlaces: smallint('room_places').notNull(),
    status: appointmentStatus('status').notNull(),
    /**
     * Generated in the database: true while the appointment still holds its therapist and its room.
     *
     * The single definition the exclusion constraint, the partial gist index and the capacity trigger
     * all read, so the status list is not written out three times and cannot drift between them.
     */
    holdsResources: boolean('holds_resources').notNull(),
    /**
     * Minutes the **room** stays held after the treatment, snapshotted at the moment it was sold
     * (0038).
     *
     * Not re-read from `service.turnaround_minutes` later, and that is the whole point: shortening the
     * configured turnaround would otherwise move the occupancy of every appointment already taken, and
     * the first sign of it would be a double booking.
     */
    turnaroundMinutes: smallint('turnaround_minutes').notNull(),
    /** Minutes the **therapist** is held either side. A different resource, a different duration. */
    therapistBufferMinutes: smallint('therapist_buffer_minutes').notNull(),
    /** VAT-inclusive gross in integer fils, snapshotted so a later price change cannot retro-price. */
    grossPriceFils: fils('gross_price_fils').notNull(),
    /** The net of that gross. VAT is the remainder, so `net + vat = gross` exactly (ADR 0007). */
    netFils: fils('net_fils').notNull(),
    vatFils: fils('vat_fils').notNull(),
    /** Basis points the split was taken at. 500 is the UAE standard rate. */
    vatRateBp: smallint('vat_rate_bp').notNull(),
    /**
     * The effective-dated override that produced the gross, or `null` meaning *considered and did not
     * apply* — the distinction `ResolvedPrice` makes. With `promotionId`, this is how a disputed
     * figure is settled a year later.
     */
    priceListId: uuid('price_list_id').references(() => priceList.id, { onDelete: 'restrict' }),
    /** No `promotion` table exists yet (B-CAT-04), so this references nothing. */
    promotionId: text('promotion_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('appointment_booking_idx').on(t.bookingId),
    index('appointment_trading_date_idx').on(t.tradingDate),
    index('appointment_delivery_idx').on(t.deliveryId),
    // Partial, matching the migration. A mirror that dropped the `where` would read as an index over
    // every appointment, which is a different plan and a different claim.
    index('appointment_room_period_idx')
      .using('gist', t.roomId, t.period)
      .where(sql`${t.holdsResources}`),
    check('appointment_period_upper_after_lower', sql`upper(${t.period}) > lower(${t.period})`),
    check(
      'appointment_period_bounded',
      sql`lower(${t.period}) is not null and upper(${t.period}) is not null`,
    ),
    check(
      'appointment_period_half_open',
      sql`lower_inc(${t.period}) and not upper_inc(${t.period})`,
    ),
    check('appointment_price_positive', sql`${t.grossPriceFils} > 0`),
    check('appointment_room_places_bounded', sql`${t.roomPlaces} between 1 and 4`),
    check('appointment_turnaround_bounded', sql`${t.turnaroundMinutes} between 0 and 240`),
    check(
      'appointment_therapist_buffer_bounded',
      sql`${t.therapistBufferMinutes} between 0 and 60`,
    ),
    check('appointment_vat_rate_bounded', sql`${t.vatRateBp} between 0 and 10000`),
    // VAT is derived as the remainder precisely so this is exact for every input rather than for
    // almost every input. A stored pair that fails it is a one-fils discrepancy on an invoice.
    check('appointment_price_split_exact', sql`${t.netFils} + ${t.vatFils} = ${t.grossPriceFils}`),
    check(
      'appointment_promotion_id_nonempty',
      sql`${t.promotionId} is null or btrim(${t.promotionId}) <> ''`,
    ),
    // `appointment_therapist_no_overlap` — EXCLUDE USING gist (therapist_id WITH =, period WITH &&)
    // WHERE (holds_resources) — is not expressible in Drizzle. It lives in
    // 0024_appointment_constraints.sql, and booking-constraints.itest.ts asserts both that
    // pg_constraint holds it with its predicate and that an overlap raises SQLSTATE 23P01.
  ],
)

/**
 * Every appointment status transition, in order. **Append-only: UPDATE and DELETE raise.**
 *
 * Written by a trigger rather than by the application, so a transition without a history row is not
 * reachable. A history table the caller is trusted to write has gaps exactly where somebody was in a
 * hurry, and the gaps are invisible — the chain still reads as complete.
 *
 * `appointmentId` is a plain uuid with **no foreign key**, the same choice `audit_event` (0005) and
 * `google_connection_events` (0016) make: an append-only log holding a reference to a mutable parent
 * is a contradiction, because the parent's delete either fails or rewrites history.
 *
 * It carries the actor, their F07 role and the reason as of **0046** (B-LIFE-01), and every one of those
 * arrives through a transaction-local `berelax.transition_*` setting because a trigger cannot see a value
 * that is not a column on `appointment` — the mechanism 0036 uses for the settings justification. The
 * duplication with `audit_event` is deliberate and narrow: the grain differs (one audit row per ACTION
 * versus one history row per APPOINTMENT, which a couples booking cancelled in one call makes visible),
 * and `audit_event` records the KIND of actor and has never held the ROLE the permission check consulted.
 */
export const appointmentStatusHistory = pgTable(
  'appointment_status_history',
  {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    appointmentId: uuid('appointment_id').notNull(),
    /** Null on the row recording the appointment's creation: there was no previous state. */
    fromStatus: appointmentStatus('from_status'),
    toStatus: appointmentStatus('to_status').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** `staff | customer | system | agent`, the same vocabulary as `audit_event.actor_kind`. */
    actorKind: text('actor_kind'),
    actorId: uuid('actor_id'),
    /** For an actor with no id — a worker, an agent. Never `''`. */
    actorLabel: text('actor_label'),
    /**
     * The F07 role the permission check consulted, which `audit_event` never held.
     *
     * Nullable, and that is a decision rather than laxity: `set_config` is transaction-local, so a NOT
     * NULL here would make a correcting `update appointment set status = …` from a psql session
     * impossible rather than merely unattributed — and push the correction outside the chain. What
     * enforces attribution for the application is `transitionAppointment`, which reads the appended row
     * back in the same transaction and refuses unless it carries exactly this actor.
     */
    actorRole: text('actor_role'),
    /** Why, as the actor stated it. Mandatory for the transitions the table declares; never `''`. */
    reason: text('reason'),
  },
  (t) => [
    index('appointment_status_history_appointment_idx').on(t.appointmentId, t.occurredAt, t.id),
    index('appointment_status_history_actor_idx').on(t.actorId, t.occurredAt),
    check(
      'appointment_status_history_is_a_change',
      sql`${t.fromStatus} is null or ${t.fromStatus} <> ${t.toStatus}`,
    ),
    check(
      'appointment_status_history_actor_kind_known',
      sql`${t.actorKind} is null or ${t.actorKind} in ('staff', 'customer', 'system', 'agent')`,
    ),
    check(
      'appointment_status_history_actor_role_known',
      sql`${t.actorRole} is null or ${t.actorRole} in ('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer', 'auditor', 'system')`,
    ),
    // Half an attribution is always a defect, whoever wrote it: a row naming a role and no kind of
    // actor is a row written from two places.
    check(
      'appointment_status_history_attribution_is_whole',
      sql`(${t.actorKind} is null) = (${t.actorRole} is null)`,
    ),
    check(
      'appointment_status_history_reason_needs_an_actor',
      sql`${t.reason} is null or ${t.actorRole} is not null`,
    ),
    check(
      'appointment_status_history_reason_nonempty',
      sql`${t.reason} is null or btrim(${t.reason}) <> ''`,
    ),
    check(
      'appointment_status_history_actor_label_nonempty',
      sql`${t.actorLabel} is null or btrim(${t.actorLabel}) <> ''`,
    ),
  ],
)

/**
 * Idempotency key → booking.
 *
 * A double-tapped Book button, a retried request after a timeout and a refreshed confirmation page
 * all arrive as the same request twice; without this the second one takes a second slot, and the
 * failure is discovered by two therapists rostered for one customer.
 *
 * The row is written in the **same transaction** as the booking, which is what makes it work: a
 * rolled-back booking releases its key, so a genuine retry gets a fresh attempt rather than a
 * permanent refusal.
 */
export const bookingIdempotency = pgTable(
  'booking_idempotency',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    /**
     * A hash of the request that claimed the key. Replaying a key with a *different* body is a bug
     * in the caller, not a retry: without this the second request gets back a booking for a slot it
     * did not ask for and reads it as success.
     */
    requestFingerprint: text('request_fingerprint').notNull(),
    bookingId: uuid('booking_id')
      .notNull()
      .unique()
      .references(() => booking.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('booking_idempotency_key_nonempty', sql`btrim(${t.idempotencyKey}) <> ''`),
    check('booking_idempotency_fingerprint_nonempty', sql`btrim(${t.requestFingerprint}) <> ''`),
  ],
)
