import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of 0079_whatsapp_ref.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Three things the mirror cannot say, and each of them will bite somebody who builds a write from these
 * definitions instead of calling `packages/db/src/repositories/whatsapp-ref.ts`:
 *
 *   - **UPDATE, DELETE and TRUNCATE are revoked from `berelax_app`** on both tables. A `db.update(...)`
 *     against either typechecks perfectly and is refused by the server for the application role. That is
 *     the protection an ADR 0017 trigger pair would normally give, and 0079's header says why a trigger
 *     pair is a heavier instrument than this needs: it would also refuse the only legitimate DELETE there
 *     is, a fixture removing its own rows.
 *   - **`whatsappRef` ships EMPTY and this build writes no rows into it.** `issueWhatsappRef` exists
 *     because A-FIRST will need it (the real interface, not a fake shaped differently — docs/12 §1.1), and
 *     until something calls it every code the front desk types is `unknown_code`. That is the honest state
 *     of the funnel and it is shown on the screen rather than reported as a zero.
 *   - **The outcome and the ref code imply each other exactly.** The two CHECK constraints below are the
 *     whole of "an invented attribution is unrepresentable", and they are equalities rather than one-way
 *     implications so that neither hole is open: a `matched` row with no code, and a code on a row that
 *     matched nothing.
 *
 * `bookingWhatsappRefCapture` is keyed on the BOOKING and carries no customer id, which is deliberate
 * rather than an omission: an attribution is a property of the booking, so a client-record merge
 * (C-CRM-05) must not move it — and this table therefore has nothing to register in that unit's
 * participant registry.
 */

/**
 * The exhaustive result of comparing what the desk typed against `whatsapp_ref`.
 *
 * A `pgEnum` and not a table, unlike the 0053 CRM vocabularies: those are provisional claims about a
 * person that the owner may correct, and there is nothing here to correct — no fourth answer somebody
 * could supply and no label anybody could rename. Pinned label for label to `REF_CAPTURE_OUTCOMES` in
 * `packages/core/src/booking/ref-capture.ts`, which `packages/fixtures/src/whatsapp-ref.itest.ts` asserts
 * against `pg_enum` so a member added to one side alone is a red test rather than a silent divergence.
 */
export const whatsappRefCaptureOutcome = pgEnum('whatsapp_ref_capture_outcome', [
  'matched',
  'unknown_code',
  'not_offered',
])

/** The short codes A-FIRST issues into a WhatsApp conversation. Empty in this build. */
export const whatsappRef = pgTable(
  'whatsapp_ref',
  {
    refCode: text('ref_code').primaryKey(),
    /**
     * A-FIRST's opaque handle for the conversation. Not a phone number — Y1-nap has not said which
     * WhatsApp number is the business — and deliberately NOT unique: a conversation may be issued a second
     * code and both attribute to it.
     */
    sessionReference: text('session_reference').notNull(),
    /** When the code was handed out, which a backfill makes different from `createdAt`. */
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    /** A-Z and 2-9 less I, O, 0 and 1: the four a person misreads off a phone screen. */
    check('whatsapp_ref_ref_code_check', sql`${t.refCode} ~ '^[A-HJ-NP-Z2-9]{4}$'`),
    check('whatsapp_ref_session_reference_check', sql`btrim(${t.sessionReference}) <> ''`),
    index('whatsapp_ref_issued_at_idx').on(t.issuedAt.desc()),
  ],
)

/** One row per booking taken at the desk: what happened to the ref field. The rate's denominator. */
export const bookingWhatsappRefCapture = pgTable(
  'booking_whatsapp_ref_capture',
  {
    /**
     * The booking, and the primary key. NO foreign key and there must not be one — `invoice.bookingId`,
     * `checkoutIdempotency.bookingId` and `bookingManageGrant.bookingId` carry none for the same reason,
     * which 0067's header records B-UI-05 finding: six integration suites truncate `booking` by an explicit
     * list, and PostgreSQL refuses a truncate while a referencing table is absent from the statement.
     * `db.delete(booking)` is therefore not blocked by this table, and nothing cascades — a fixture that
     * removes its bookings removes its capture rows first.
     */
    bookingId: uuid('booking_id').primaryKey(),
    outcome: whatsappRefCaptureOutcome('outcome').notNull(),
    /** The attribution, and null for every other outcome. ON DELETE RESTRICT on the code. */
    refCode: text('ref_code').references(() => whatsappRef.refCode, { onDelete: 'restrict' }),
    /** What was typed when it matched nothing. Null for every other outcome. */
    enteredCode: text('entered_code'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'booking_whatsapp_ref_capture_matched_names_its_ref',
      sql`(${t.outcome} = 'matched') = (${t.refCode} is not null)`,
    ),
    check(
      'booking_whatsapp_ref_capture_unknown_keeps_what_was_typed',
      sql`(${t.outcome} = 'unknown_code') = (${t.enteredCode} is not null)`,
    ),
    index('booking_whatsapp_ref_capture_outcome_idx').on(t.outcome, t.recordedAt.desc()),
    index('booking_whatsapp_ref_capture_ref_code_idx').on(t.refCode),
  ],
)
