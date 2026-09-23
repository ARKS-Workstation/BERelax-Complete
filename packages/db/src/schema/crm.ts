import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { roomType } from './rooms.ts'
import { employeeGender } from './staff.ts'

/**
 * Drizzle mirror of 0053_crm_client_record.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Three things the mirror cannot say, and every one of them matters before somebody builds a write from
 * these definitions:
 *
 *   - **`customer_blocklist.key_value` and the three CHECKs on it.** The column is normalised — E.164 or
 *     a lower-cased address — and the database refuses anything else. An insert built from this mirror
 *     with a number as the front desk typed it raises, which is the correct outcome: an un-normalised
 *     entry is an entry nothing will ever match. Normalise with `normaliseBlocklistKey` from
 *     `@berelax/core` first.
 *   - **Removing a blocklist entry or a do-not-pair flag is a LIFT.** `delete` is revoked from
 *     `berelax_app` on both tables, so `db.delete(customerBlocklist)` fails at run time however well it
 *     typechecks. Set `liftedAt`, `liftedByRole` and `liftedReason` — all three, or the
 *     `…_lift_is_whole` constraint raises.
 *   - **The two vocabularies carry an AFTER trigger that writes `audit_event`.** A change made through
 *     this mirror is audited whether or not the caller asked, and it is attributed only if the caller set
 *     the transaction-local `berelax.audit_actor_*` values first. There is no Drizzle expression for
 *     that; use the repository.
 *
 * There is deliberately no `pgEnum` for the lifecycle state or the acquisition source. Both vocabularies
 * are provisional (Y9-crm-lifecycle, Y9-crm-source) and a provisional value has to carry
 * `is_provisional`, an OPEN-QUESTIONS id and a note — which an enum label has nowhere to put. See the
 * migration header.
 */

export const customerLifecycleState = pgTable('customer_lifecycle_state', {
  state: text('state').primaryKey(),
  displayOrder: smallint('display_order').notNull(),
  description: text('description').notNull(),
  isProvisional: boolean('is_provisional').notNull(),
  openQuestionId: text('open_question_id'),
  provisionalNote: text('provisional_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const customerAcquisitionSource = pgTable('customer_acquisition_source', {
  source: text('source').primaryKey(),
  displayOrder: smallint('display_order').notNull(),
  description: text('description').notNull(),
  isProvisional: boolean('is_provisional').notNull(),
  openQuestionId: text('open_question_id'),
  provisionalNote: text('provisional_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const customerPreference = pgTable('customer_preference', {
  customerId: uuid('customer_id').primaryKey(),
  preferredLanguage: text('preferred_language'),
  /** `employee_gender`, the same two labels the solver reads — never a second list. */
  preferredTherapistGender: employeeGender('preferred_therapist_gender'),
  preferredRoomType: roomType('preferred_room_type'),
  /** Free text on purpose: no vocabulary for these three has been stated. See the migration header. */
  pressureNote: text('pressure_note'),
  oilNote: text('oil_note'),
  musicNote: text('music_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const customerTag = pgTable(
  'customer_tag',
  {
    customerId: uuid('customer_id').notNull(),
    /** A lower-case slug, enforced by a CHECK: two capitalisations of one tag are two tags. */
    tag: text('tag').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.tag] }), index('customer_tag_tag_idx').on(t.tag)],
)

export const customerBlocklist = pgTable(
  'customer_blocklist',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    keyKind: text('key_kind').notNull(),
    /** Normalised. See the module note: the database refuses any other spelling. */
    keyValue: text('key_value').notNull(),
    /** The record the entry is ABOUT. Never what the match runs on. */
    customerId: uuid('customer_id'),
    keyReason: text('reason').notNull(),
    /** The F07 role that made the change, beside the row — `audit_event` holds the actor KIND only. */
    addedByRole: text('added_by_role').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull(),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    liftedByRole: text('lifted_by_role'),
    liftedReason: text('lifted_reason'),
  },
  (t) => [
    // One ACTIVE entry per key. Drizzle cannot express the `where lifted_at is null` predicate, so this
    // mirrors the index by name and columns only; the partiality is the migration's and `pnpm db:drift`
    // compares columns rather than indexes.
    uniqueIndex('customer_blocklist_one_active_per_key').on(t.keyKind, t.keyValue),
    index('customer_blocklist_active_idx').on(t.keyValue, t.keyKind),
  ],
)

export const customerTherapistDoNotPair = pgTable(
  'customer_therapist_do_not_pair',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    customerId: uuid('customer_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    pairReason: text('reason').notNull(),
    setByRole: text('set_by_role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    liftedByRole: text('lifted_by_role'),
    liftedReason: text('lifted_reason'),
  },
  (t) => [
    uniqueIndex('customer_therapist_do_not_pair_one_active').on(t.customerId, t.employeeId),
    index('customer_therapist_do_not_pair_customer_idx').on(t.customerId),
  ],
)
