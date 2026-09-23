import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { appointment } from './booking.ts'
import { message } from './message.ts'

/**
 * Drizzle mirror of `packages/db/migrations/0051_scheduled_step.sql` (B-MSG-03).
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`, which
 * compares these declarations against the live database in both directions.
 *
 * The three rules that are **not** expressible here, and therefore live only in the migration:
 *
 *   - `refuse_scheduled_step_resurrection`, the BEFORE UPDATE trigger that makes leaving `pending` a
 *     one-way door. It is what stops a superseded step being revived instead of a new one being inserted.
 *   - `appointment_leaves_no_pending_scheduled_step` and
 *     `scheduled_step_attaches_to_a_live_appointment`, the two DEFERRED constraint triggers that refuse a
 *     transaction which commits a pending step on an appointment that no longer holds its resources, or
 *     one now due at or after the treatment starts.
 *   - the `step_type` bound, whose second half is a cast of the label's numeric part. The pattern half is
 *     stated below; the bound is in the migration, and `packages/fixtures/src/scheduled-step.itest.ts`
 *     asserts the constraint refuses `reminder_9999h` against a real PostgreSQL.
 */

/**
 * The five states.
 *
 * `pending` is the only one that is not terminal, and the four that are answer different questions about
 * the same row: a `superseded` step was replaced because the appointment moved, a `cancelled` one had its
 * appointment end, a `skipped` one came due and was refused with a reason, a `sent` one produced a message.
 * One `void` state instead of the first two would make "what did rescheduling cost us in reminders"
 * unanswerable.
 */
export const scheduledStepState = pgEnum('scheduled_step_state', [
  'pending',
  'sent',
  'skipped',
  'superseded',
  'cancelled',
])

export const scheduledStep = pgTable(
  'scheduled_step',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /**
     * CASCADE, unlike almost every other foreign key in this schema.
     *
     * A scheduled step is an *intention* about an appointment rather than evidence of anything, so an
     * appointment that no longer exists leaves nothing worth keeping. `messageId` below is the evidence,
     * and it is RESTRICT.
     */
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointment.id, { onDelete: 'cascade' }),
    /**
     * `reminder_24h`. Text with a pattern rather than an enum, deliberately.
     *
     * The reminder set is the F09 setting `booking.reminder_offsets_hours` and the label is derived from
     * the offset, so changing the reminder timing is a settings change rather than a migration — and the
     * acceptance criterion that a timing change produces NEW KEYS holds only because the label is part of
     * the key.
     */
    stepType: text('step_type').notNull(),
    /**
     * A deterministic function of (appointment_id, step_type, period) — `invalidationKeyFor` in
     * `packages/core/src/lifecycle/invalidation-key.ts`.
     *
     * **Not unique**, and that is a decision rather than an omission: a reschedule back to the original
     * period legitimately re-derives the key a superseded row already holds. The key answers "is this step
     * still about the appointment's current period?" and nothing about which row to send.
     */
    invalidationKey: text('invalidation_key').notNull(),
    /** The treatment start minus the offset. It moves with the period, so a move inserts new rows. */
    sendAt: timestamp('send_at', { withTimezone: true }).notNull(),
    state: scheduledStepState('state').notNull(),
    /** The message the send produced. RESTRICT, and unique: two steps cannot claim one message. */
    messageId: uuid('message_id').references(() => message.id, { onDelete: 'restrict' }),
    /** Why the send was late, when it was. Sent-only, and never `''`. */
    stalenessNote: text('staleness_note'),
    /** Why it was not sent. A closed set; SCHEDULED_STEP_SKIP_REASONS in `@berelax/core` is the same list. */
    skippedReason: text('skipped_reason'),
    /**
     * When the worker decided.
     *
     * Required for every terminal state by `scheduled_step_terminal_is_settled`, which is the whole of
     * "no step ends in a silent unrecorded state": the third outcome is not storable rather than being
     * looked for afterwards.
     */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    /**
     * At most one LIVE step per (appointment, step type).
     *
     * Partial, because every terminal row may repeat the pair — an appointment rescheduled four times has
     * four superseded `reminder_24h` rows, which is the history of the booking. This index plus the
     * resurrection trigger are "exactly one live step per step_type remains" after a reschedule and a
     * reschedule back.
     */
    uniqueIndex('scheduled_step_one_pending_step_per_type')
      .on(t.appointmentId, t.stepType)
      .where(sql`${t.state} = 'pending'`),
    index('scheduled_step_due_idx').on(t.sendAt).where(sql`${t.state} = 'pending'`),
    index('scheduled_step_appointment_idx').on(t.appointmentId, t.stepType),
    unique('scheduled_step_message_claimed_once').on(t.messageId),
    // The pattern half of the bound. The numeric half casts the label's digits and is in the migration.
    check(
      'scheduled_step_type_is_a_declared_reminder',
      sql`${t.stepType} ~ '^reminder_[1-9][0-9]{0,2}h$'
    and (regexp_replace(${t.stepType}, '^reminder_([0-9]+)h$', '\\1'))::integer between 1 and 168`,
    ),
    check('scheduled_step_invalidation_key_nonempty', sql`btrim(${t.invalidationKey}) <> ''`),
    check(
      'scheduled_step_pending_has_settled_nothing',
      sql`${t.state} <> 'pending'
    or (${t.settledAt} is null and ${t.messageId} is null and ${t.skippedReason} is null
        and ${t.stalenessNote} is null)`,
    ),
    check(
      'scheduled_step_terminal_is_settled',
      sql`${t.state} = 'pending' or ${t.settledAt} is not null`,
    ),
    check(
      'scheduled_step_sent_carries_its_message',
      sql`(${t.state} = 'sent') = (${t.messageId} is not null)`,
    ),
    check(
      'scheduled_step_skipped_carries_a_reason',
      sql`(${t.state} = 'skipped') = (${t.skippedReason} is not null)`,
    ),
    check(
      'scheduled_step_staleness_is_about_a_send',
      sql`${t.stalenessNote} is null or ${t.state} = 'sent'`,
    ),
  ],
)
