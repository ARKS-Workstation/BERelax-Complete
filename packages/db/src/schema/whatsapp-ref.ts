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
 *   - **`whatsappRef` STILL ships empty, and now for a different reason.** 0079 said "this build writes no
 *     rows" because nothing called `issueWhatsappRef`. A-FIRST-07 wired `/api/whatsapp` to it, and the
 *     table is still empty: the route refuses to mint a code when `premises.phone_whatsapp` is not a
 *     dialable number, and it holds the Y1-nap placeholder. That refusal is deliberate rather than
 *     incidental — a code issued into a message nobody can send would be a denominator inflated by the
 *     absence of a phone number, and the capture rate would read as a front-desk failure.
 *   - **The outcome, the ref code and the attribution imply each other exactly.** The three CHECK
 *     constraints below are the whole of "an invented attribution is unrepresentable" as far as one row can
 *     state it, and they are equalities rather than one-way implications so no hole is open in either
 *     direction. The two facts that live on ANOTHER row — whether the code had expired, and whether the
 *     session named is the one the code was issued into — cannot be a CHECK and are 0127's ZY331 and
 *     ZY332.
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
  /** 0127: the code exists and its lifetime had run out. The booking is taken; the code is kept. */
  'ref_expired',
  /** 0127: the code exists and another CUSTOMER's booking claimed it first. Surfaced, not reassigned. */
  'ref_conflict',
])

/** The short codes A-FIRST issues into a WhatsApp conversation. Empty in this build. */
export const whatsappRef = pgTable(
  'whatsapp_ref',
  {
    refCode: text('ref_code').primaryKey(),
    /**
     * The analytics session the code was issued into: `analytics.session.session_id`, as a `uuid` since
     * 0127 and `text` before it.
     *
     * The type IS the PII guard. Every other column on this row is one step from a person — the code is
     * read off a phone screen and typed back in at a counter — and a `text` handle is a column a later unit
     * could put a phone number, an email address or a name into with nothing to notice. A blacklist CHECK
     * cannot close that, because a regex refusing digit runs refuses most uuids as well; a uuid cannot be a
     * contact detail at all.
     *
     * Deliberately NOT a foreign key and deliberately NOT unique. Retention purges a session at 90 days
     * and an attribution has to outlive the session it is about, so neither CASCADE nor RESTRICT is
     * available; and a conversation may be issued a second code, with both attributing to it.
     */
    sessionReference: uuid('session_reference').notNull(),
    /** When the code was handed out, which a backfill makes different from `createdAt`. */
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    /**
     * When the code stops being claimable (0127). Stamped at issue from `booking.whatsapp_ref_ttl_days`
     * and never recomputed — answering Y12-ref-ttl would otherwise move the recorded outcome of bookings
     * already taken. An expired code is NOT recycled: it still exists in the customer's chat history.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    /**
     * A-Z and 2-9 less I, L, O, U, 0 and 1 — Crockford's set, narrowed from 0079's four by 0127. `U` is the
     * one that matters: with the others out, a misread of `U` as `V` was the last way a typo could produce
     * another VALID code and attribute a booking to somebody else's conversation.
     */
    check('whatsapp_ref_ref_code_check', sql`${t.refCode} ~ '^[A-HJKM-NP-TV-Z2-9]{4}$'`),
    check('whatsapp_ref_expires_after_it_was_issued', sql`${t.expiresAt} > ${t.issuedAt}`),
    index('whatsapp_ref_issued_at_idx').on(t.issuedAt.desc()),
    /** Not for the claim path, which reads the primary key: for "which codes are dead and unclaimed". */
    index('whatsapp_ref_expires_at_idx').on(t.expiresAt),
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
    /**
     * The code the desk typed, for the three outcomes in which it RESOLVED to a row — `matched`,
     * `ref_expired`, `ref_conflict` — and null for the two in which nothing was found. Only `matched`
     * carries an attribution; the other two keep the code because it is the evidence for the finding.
     * ON DELETE RESTRICT: a code a booking names cannot be removed from under it.
     */
    refCode: text('ref_code').references(() => whatsappRef.refCode, { onDelete: 'restrict' }),
    /** What was typed when it matched nothing. Null for every other outcome. */
    enteredCode: text('entered_code'),
    /**
     * The session this booking is attributed to (0127), for `matched` and nothing else.
     *
     * Not a foreign key, for the reason `whatsappRef.sessionReference` is not one: the session is purged at
     * 90 days and this row outlives it, which is the whole point of denormalising. A-FIRST-08 joins from
     * here for a desk booking's first and last touch. The value is always the CODE's own session, which
     * 0127's ZY332 refuses to let a caller substitute.
     */
    attributedSessionId: uuid('attributed_session_id'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'booking_whatsapp_ref_capture_resolved_names_its_ref',
      sql`(${t.outcome} in ('matched', 'ref_expired', 'ref_conflict')) = (${t.refCode} is not null)`,
    ),
    check(
      'booking_whatsapp_ref_capture_unknown_keeps_what_was_typed',
      sql`(${t.outcome} = 'unknown_code') = (${t.enteredCode} is not null)`,
    ),
    check(
      'booking_whatsapp_ref_capture_attribution_only_when_matched',
      sql`(${t.outcome} = 'matched') = (${t.attributedSessionId} is not null)`,
    ),
    index('booking_whatsapp_ref_capture_outcome_idx').on(t.outcome, t.recordedAt.desc()),
    index('booking_whatsapp_ref_capture_ref_code_idx').on(t.refCode),
  ],
)
