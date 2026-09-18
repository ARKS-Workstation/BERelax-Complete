import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of `packages/db/migrations/0012_rooms.sql`.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`
 * which compares these definitions against the live database in both directions.
 */

/**
 * `tstzrange`, which Drizzle has no built-in column type for.
 *
 * Carried as the Postgres text form (`["2026-10-02 19:00:00+00","2026-10-02 20:00:00+00")`) rather
 * than parsed into a pair of instants. Parsing it here would put range semantics in the ORM layer,
 * where a caller could construct an inclusive upper bound without noticing; the database refuses
 * anything but `[)` (see `resource_block_period_half_open`), and the pure overlap predicate in
 * `@berelax/core` is what callers should be reasoning with.
 */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tstzrange'
  },
})

/**
 * standard | couples | wet.
 *
 * The wet room is a **type**, not a `rooms.is_wet` boolean. With a boolean, "may this treatment
 * happen in this room" is a predicate over attributes that every availability query has to restate,
 * and the next facility adds a column to all of them. With a type, compatibility is a join on one
 * column and the scheduler can rank scarcity by type — which matters, because the wet room is the
 * scarce resource and Morocco Bath cannot be delivered anywhere else.
 */
export const roomType = pgEnum('room_type', ['standard', 'couples', 'wet'])

/**
 * Style is an attribute of the **treatment**, not of the therapist (ADR 0021).
 *
 * Declared here rather than in the catalogue schema because `service_room_type_compat` needs it
 * before a `service` table exists. B-CAT-03 reuses this enum: a composite foreign key requires
 * identical types on both sides.
 */
export const treatmentStyle = pgEnum('treatment_style', ['asian', 'arabic'])

/**
 * The room inventory.
 *
 * Plural against the singular convention of every other table here, and deliberately so: ADR 0015
 * and docs/01 decision 9 both pin `rooms.capacity` as the column the deferred room-capacity trigger
 * counts overlapping appointments against, and B-AVAIL-01 writes that trigger.
 */
export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** Stable internal reference. `name` is editable and translated; joins and seeds need a fixed handle. */
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    roomType: roomType('room_type').notNull(),
    /**
     * Clients the room holds at once — authoritative, not derived from `roomType`.
     *
     * A second couples room with three plinths must be data rather than a migration, and this is the
     * number ADR 0015's constraint trigger counts against.
     */
    capacity: smallint('capacity').notNull(),
    /** False decommissions a room without deleting it, so its past appointments keep their room. */
    isBookable: boolean('is_bookable').notNull(),
    displayOrder: smallint('display_order').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // Partial, matching the migration. Mirrored WITH its predicate: a mirror that drops the `where`
    // reads as an index over every room, which is a different query plan and a different claim.
    index('rooms_bookable_idx').on(t.roomType).where(sql`${t.isBookable}`),
    check('rooms_capacity_positive', sql`${t.capacity} >= 1`),
    check('rooms_couples_holds_two', sql`${t.roomType} <> 'couples' or ${t.capacity} >= 2`),
  ],
)

/**
 * Room unavailability that is not a booking: maintenance, deep cleans, manual holds.
 *
 * Rooms only. A therapist block is leave or a shift gap — P-HR data with its own approval path —
 * rather than a second nullable foreign key here, because a polymorphic parent makes "which resource
 * is this?" unanswerable in a constraint.
 */
export const resourceBlock = pgTable(
  'resource_block',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    /** `[)` bounds, enforced by the database. See ADR 0015 on why half-open is the only convention. */
    period: tstzrange('period').notNull(),
    kind: text('kind').notNull(),
    reason: text('reason').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('resource_block_period_nonempty', sql`not isempty(${t.period})`),
    check(
      'resource_block_period_bounded',
      sql`lower(${t.period}) is not null and upper(${t.period}) is not null`,
    ),
    check(
      'resource_block_period_half_open',
      sql`lower_inc(${t.period}) and not upper_inc(${t.period})`,
    ),
  ],
)

/**
 * Which room types a service may be delivered in. **No default and no fall-back.**
 *
 * Zero rows for a service means zero bookable rooms. A permissive default would let a Morocco Bath
 * be booked into a dry room the first time somebody forgot a row, and the failure would be
 * discovered by the customer rather than by a test.
 *
 * Keyed on the service natural key `(style, treatment_key)` because there is no `service` table yet.
 * B-CAT-03 declares `(style, treatment_key)` UNIQUE on `service`, at which point these two columns
 * become a composite foreign key with no data migration.
 */
export const serviceRoomTypeCompat = pgTable(
  'service_room_type_compat',
  {
    serviceStyle: treatmentStyle('service_style').notNull(),
    serviceTreatmentKey: text('service_treatment_key').notNull(),
    roomType: roomType('room_type').notNull(),
    /** The row is an assumption the build made, read by the Unconfirmed Assumptions panel. */
    isProvisional: boolean('is_provisional').notNull(),
    openQuestionId: text('open_question_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.serviceStyle, t.serviceTreatmentKey, t.roomType] }),
    index('service_room_type_compat_room_type_idx').on(t.roomType),
  ],
)
