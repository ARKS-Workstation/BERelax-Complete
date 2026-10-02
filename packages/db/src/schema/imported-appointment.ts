import { sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { appointment } from './booking.ts'

/**
 * Drizzle mirror of 0130_appointment_migrated.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * One row per LINE of a reconstructed visit-history file, whether or not the line produced an
 * appointment — `imported_contact`'s arrangement (0121) and the framework's reason: a staged row that
 * reaches `applied` having recorded no entity cannot COMMIT (ZY196), and the line that recorded nothing
 * is precisely the line somebody needs to go and look at.
 *
 * Three things this mirror cannot say:
 *
 *   - **it is append-only.** ZY364 raises on UPDATE and on DELETE for every role, and the application
 *     role holds neither privilege. A line that was quarantined and has since been resolved is a NEW
 *     record from a new run; nothing removes the first.
 *   - **`outcome` is held to the facts at COMMIT.** ZY365 refuses an `imported` record naming an
 *     appointment that is not marked `migrated`, so the value is a claim the database checks.
 *   - **the other direction is checked too.** ZY363 refuses a migrated appointment that no record here
 *     names, which is what makes the flag unforgeable rather than merely documented.
 *
 * `contact_hmac` is the keyed digest of the customer cell and never the number (ADR 0072). There is no
 * `customer_id`, which is 0119's recorded decision: a merge re-points the one copy that exists, and this
 * record is evidence about a file rather than a row about a person. It also means a line whose customer
 * could not be resolved still records whose history is missing, which is the first question a quarantine
 * raises.
 */
export const importedAppointment = pgTable(
  'imported_appointment',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** `HMAC-SHA256(json(value), SUPPRESSION_PEPPER)`, lower-case hex. Never a phone number. */
    contactHmac: text('contact_hmac').notNull(),
    /** The LABEL of the pepper that keyed it, never the pepper. */
    pepperVersion: text('pepper_version').notNull(),
    /** `imported` | `quarantined`, held to the appointment it names by ZY365. */
    outcome: text('outcome').notNull(),
    /**
     * A short lower-case name from `APPOINTMENT_QUARANTINES`, present exactly when `outcome` is
     * `quarantined`. The database holds the SHAPE and `packages/migration` holds the vocabulary; naming
     * the values in both would be the second statement of a list that drifts.
     */
    quarantineReason: text('quarantine_reason'),
    /** The reconstructed appointment, present exactly when `outcome` is `imported`. */
    appointmentId: uuid('appointment_id').references(() => appointment.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // Partial, matching the migration: NULL is the ordinary case for a quarantined line, and a total
    // unique index would permit exactly one of them.
    uniqueIndex('imported_appointment_one_per_appointment')
      .on(t.appointmentId)
      .where(sql`${t.appointmentId} is not null`),
    index('imported_appointment_quarantined_idx')
      .on(t.createdAt)
      .where(sql`${t.outcome} = 'quarantined'`),
    index('imported_appointment_hmac_idx').on(t.contactHmac),
  ],
)
