import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { roomType, serviceRoomTypeCompat, treatmentStyle } from './rooms.ts'

/**
 * Drizzle mirror of `packages/db/migrations/0017_catalogue.sql`.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`.
 *
 * `treatmentStyle` and `roomType` are **imported** from `./rooms.ts` rather than redeclared. A second
 * `pgEnum('treatment_style', …)` would compile, read identically and produce a different Postgres type,
 * and the composite foreign key from `service_room_type_compat` to `service` — which needs the same type
 * on both sides — would then be impossible to attach. B-CAT-02 created the enum for exactly this.
 */

/**
 * The `fils` domain from `0002_conventions.sql`: AED minor units as `bigint`.
 *
 * Carried as the string Postgres sends rather than a JS `number`, because `int8` does not fit in a
 * double and a silent precision loss in a money column is discovered during a VAT reconciliation. The
 * branded `Money` type and the arithmetic live in `@berelax/core`; `packages/db` must never import it
 * (the dependency runs the other way), so this layer moves the digits and does not do sums on them.
 */
const fils = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'fils'
  },
})

/**
 * The skill a treatment style requires of whoever delivers it.
 *
 * Eligibility only: it decides who *can* take the appointment, never what it costs. Price and therapist
 * assignment are decoupled (ADR 0021), which is what makes a therapist reassignment free of repricing.
 */
export const therapistSkill = pgEnum('therapist_skill', ['asian_style', 'arabic_style'])

/**
 * The resource footprint of one delivery: `solo`, `four_hands`, `couple`.
 *
 * Four Hands (two therapists, one client) and Couple Massage (two therapists, two clients) are **shapes
 * of the treatments already in the catalogue**, not extra treatments. docs/13 §4 lists them like menu
 * items, which is the trap: as treatment keys they would multiply the styles and durations they share
 * with their parents, and none of 0012's compatibility rows would cover them.
 */
export const serviceShape = pgEnum('service_shape', ['solo', 'four_hands', 'couple'])

/**
 * The catalogue: one row per `(style × treatment)` pair, so exactly 8 rows (ADR 0021).
 *
 * `(style, treatment_key)` is UNIQUE and is the parent of `service_room_type_compat`, whose two
 * natural-key columns B-CAT-02 declared for precisely this migration to point at.
 *
 * `treatment_key` is `text` and not an enum on purpose: there is no equality operator between an enum
 * and `text`, and the child's column is `text`, so an enum here would have made the composite foreign
 * key unattachable.
 */
export const service = pgTable(
  'service',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    style: treatmentStyle('style').notNull(),
    treatmentKey: text('treatment_key').notNull(),
    /** The public path segment. Changing it is paired with a 301 row by B-CAT-05. */
    slug: text('slug').notNull().unique(),
    /** Unconstrained by design — the front desk's own words. The *public* name is the linted one. */
    internalName: text('internal_name').notNull(),
    /** Reaches a customer, so B-CAT-05 lints it against the banned-claims lexicon. */
    publicDisplayName: text('public_display_name').notNull(),
    /**
     * Minutes the **room** is unavailable afterwards: linen, cleaning, airing.
     *
     * Not the therapist buffer. That is `serviceResourceShape.therapistBufferMinutes` — a different
     * resource with a different duration, and deliberately not derived from this one (docs/06 B1).
     */
    turnaroundMinutes: smallint('turnaround_minutes').notNull(),
    displayOrder: smallint('display_order').notNull(),
    /**
     * When the service became publicly bookable; `null` is a draft (B-CAT-05, migration 0029).
     *
     * Setting it is guarded in the database by three separate named refusals — no room-type
     * compatibility row (ZC001), no resource shape (ZC002), no priced variant (ZC003) — because all
     * three present to the owner as the same symptom: the treatment is on the site and nobody can
     * book it.
     */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /**
     * When the service left the menu. Archive, never delete: a future appointment holds the variant it
     * was quoted from, and `appointment.service_variant_id` is ON DELETE RESTRICT (0024).
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /** The same provenance trio as `app_setting`, read by the Unconfirmed Assumptions panel. */
    isProvisional: boolean('is_provisional').notNull(),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('service_style_treatment_key_unique').on(t.style, t.treatmentKey),
    // The public menu's read and the one definition of bookable (0029). Partial, so a draft or an
    // archived service is absent from the index rather than filtered out of it.
    index('service_bookable_idx')
      .on(t.displayOrder, t.id)
      .where(sql`${t.publishedAt} is not null and ${t.archivedAt} is null`),
    // An archived service that is still published is a menu item the site renders and the solver
    // refuses, which reads as a broken booking system rather than a withdrawn treatment.
    check(
      'service_archived_is_not_published',
      sql`${t.archivedAt} is null or ${t.publishedAt} is null`,
    ),
    check('service_treatment_key_snake_case', sql`${t.treatmentKey} ~ '^[a-z][a-z0-9_]*$'`),
    check('service_slug_kebab_case', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check(
      'service_names_nonempty',
      sql`btrim(${t.internalName}) <> '' and btrim(${t.publicDisplayName}) <> ''`,
    ),
    check('service_turnaround_bounded', sql`${t.turnaroundMinutes} between 0 and 240`),
    check(
      'service_provisional_names_a_question',
      sql`not ${t.isProvisional} or ${t.openQuestionId} is not null`,
    ),
  ],
)

/**
 * Duration × price, and **duration is the only pricing axis** (ADR 0021).
 *
 * No time of day, no seniority, no day of week: a third axis multiplies the catalogue and every screen
 * that renders it. The 32 price points are transcribed from docs/13 §4 by B-CAT-06's seed rather than by
 * the migration, because a migration cannot be re-run when a price changes.
 */
export const serviceVariant = pgTable(
  'service_variant',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => service.id, { onDelete: 'cascade' }),
    durationMinutes: smallint('duration_minutes').notNull(),
    /** VAT-inclusive gross in integer fils (docs/01 decision 7). Strictly positive in the database. */
    grossPriceFils: fils('gross_price_fils').notNull(),
    /** On a variant the only guessable value is the price; B-CAT-06 calls this `price_provisional`. */
    isProvisional: boolean('is_provisional').notNull(),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('service_variant_service_idx').on(t.serviceId),
    unique('service_variant_service_duration_unique').on(t.serviceId, t.durationMinutes),
    check('service_variant_duration_allowed', sql`${t.durationMinutes} in (45, 60, 90, 120)`),
    // Strictly positive, not merely non-negative: zero is a missing price, and it would invoice as
    // 0.00 and reconcile to nothing rather than failing anywhere a human would look.
    check('service_variant_price_positive', sql`${t.grossPriceFils} > 0`),
    check(
      'service_variant_provisional_names_a_question',
      sql`not ${t.isProvisional} or ${t.openQuestionId} is not null`,
    ),
  ],
)

/**
 * Style → required therapist skill, **for eligibility only**.
 *
 * Keyed on the style rather than on the service: the requirement belongs to the style, and eight rows
 * would let two services of the same style disagree about who may deliver them.
 *
 * It carries no price and never will. A price here would recouple pricing to therapist assignment,
 * which is the one thing ADR 0021 exists to prevent — `packages/shared`'s skill-mapping type makes that
 * a compile error rather than a convention.
 */
export const serviceSkill = pgTable(
  'service_skill',
  {
    style: treatmentStyle('style').primaryKey(),
    requiredSkill: therapistSkill('required_skill').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  // One skill per style and one style per skill. Without the uniqueness, both styles could require the
  // same skill — which is the "style is really a therapist attribute" model creeping back in.
  (t) => [unique('service_skill_required_skill_unique').on(t.requiredSkill)],
)

/**
 * Therapists, rooms, minimum room capacity and the therapist buffer, per `(service, shape)`.
 *
 * Keyed on the service **natural** key rather than on `service_id`, which buys a guarantee a surrogate
 * key cannot: `(service_style, service_treatment_key, required_room_type)` is exactly the primary key of
 * `service_room_type_compat`, so a shape demanding a room type the service may not be delivered in is
 * refused by a foreign key. With a `service_id` that check would be a trigger, or more likely nothing —
 * and a Four Hands shape demanding the wet room would resolve to zero bookable rooms and read as "no
 * availability" for ever.
 *
 * `minRoomCapacity` is not derivable from `therapistsRequired`: Four Hands is two therapists over **one**
 * client, so its minimum capacity is 1 while Couple Massage's is 2.
 */
export const serviceResourceShape = pgTable(
  'service_resource_shape',
  {
    serviceStyle: treatmentStyle('service_style').notNull(),
    serviceTreatmentKey: text('service_treatment_key').notNull(),
    shape: serviceShape('shape').notNull(),
    therapistsRequired: smallint('therapists_required').notNull(),
    roomsRequired: smallint('rooms_required').notNull(),
    minRoomCapacity: smallint('min_room_capacity').notNull(),
    /** NULL means any type the compatibility rows allow; a value narrows them for this shape only. */
    requiredRoomType: roomType('required_room_type'),
    /** Minutes protecting the **therapist** either side. Never the room's turnaround. */
    therapistBufferMinutes: smallint('therapist_buffer_minutes').notNull(),
    isProvisional: boolean('is_provisional').notNull(),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.serviceStyle, t.serviceTreatmentKey, t.shape] }),
    index('service_resource_shape_shape_idx').on(t.shape),
    foreignKey({
      columns: [t.serviceStyle, t.serviceTreatmentKey],
      foreignColumns: [service.style, service.treatmentKey],
      name: 'service_resource_shape_service_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    // The guarantee the natural key exists for. MATCH SIMPLE, so a NULL `required_room_type` is
    // unconstrained and falls back to the service's full compatibility set.
    foreignKey({
      columns: [t.serviceStyle, t.serviceTreatmentKey, t.requiredRoomType],
      foreignColumns: [
        serviceRoomTypeCompat.serviceStyle,
        serviceRoomTypeCompat.serviceTreatmentKey,
        serviceRoomTypeCompat.roomType,
      ],
      name: 'service_resource_shape_room_type_compat_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check('service_resource_shape_therapists_positive', sql`${t.therapistsRequired} >= 1`),
    check('service_resource_shape_rooms_positive', sql`${t.roomsRequired} >= 1`),
    check('service_resource_shape_capacity_positive', sql`${t.minRoomCapacity} >= 1`),
    check(
      'service_resource_shape_couple_holds_two',
      sql`${t.shape} <> 'couple' or ${t.minRoomCapacity} >= 2`,
    ),
    check(
      'service_resource_shape_four_hands_needs_two',
      sql`${t.shape} <> 'four_hands' or ${t.therapistsRequired} >= 2`,
    ),
    check(
      'service_resource_shape_buffer_bounded',
      sql`${t.therapistBufferMinutes} between 0 and 60`,
    ),
    check(
      'service_resource_shape_provisional_names_a_question',
      sql`not ${t.isProvisional} or ${t.openQuestionId} is not null`,
    ),
  ],
)
