import { sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of 0149_attribution_columns.sql (A-FIRST-08). SQL-first (ADR 0006); `pnpm db:drift`
 * compares these against the live database in both directions.
 *
 * Five things the mirror cannot say, and each of them will bite somebody who assembles a write from
 * these definitions rather than calling `packages/db/src/repositories/attribution.ts`:
 *
 *   1. **`sessionReference` is NOT a foreign key and never will be.** `analytics.run_retention` purges
 *      `analytics.session` at ninety days (0096), and this claim has to outlive it — a reference in
 *      either direction would either block the purge or cascade the attribution away with it. A
 *      `sessionReference` that resolves to nothing is the EXPECTED state of a row older than the
 *      window. The source, medium and campaign are therefore COPIED and not joined: a rollup reading
 *      them through a live join would report a day correctly for ninety days and then report it as
 *      unattributed, arriving as a cliff in a chart nobody had deployed anything near.
 *   2. **A first touch may only move EARLIER (ZY691).** `db.update(customerAttribution)` typechecks
 *      perfectly and is refused by the server for every role including the owner unless the new
 *      `occurredAt` is strictly before the old one, or the claim is unchanged. That is write-once
 *      stated as the rule a customer merge also needs, rather than as two rules that can disagree.
 *   3. **A booking's last touch may not postdate the booking (ZY692).** Enforced by a trigger reading
 *      `booking.created_at`, which a CHECK cannot do.
 *   4. **A customer merge FOLDS the earlier first touch onto the survivor**, by a trigger on the
 *      `merge_record` insert — not by the `repoint_update` statement, which can only move a row or skip
 *      it. `customer_attribution` is registered in `MERGE_PARTICIPANTS` so the catalogue check can see
 *      it; the arithmetic the generic statement cannot express lives in the database.
 *   5. **`basis`, `source`, `medium`, `sessionReference` and `howHeard` are held together by one
 *      IMMUTABLE function**, `attribution_origination_is_well_formed`, called by a CHECK on both tables.
 *      It is where `offline` is a fifth basis rather than a reuse of `direct`, where `offline` and
 *      `direct` each get one spelling, and where a how-heard answer is confined to an offline row.
 *
 * Neither `occurredAt` nor `recordedAt` has a default: both are supplied from an injected clock, because
 * every ordering assertion in this area is made under a frozen one. `consent.recordedAt` and
 * `mergeRecord.mergedAt` are the same shape for the same reason.
 */

export const customerAttribution = pgTable(
  'customer_attribution',
  {
    /** The PRIMARY KEY — which is what makes "exactly one first-touch row per customer" unfalsifiable. */
    customerId: uuid('customer_id').primaryKey(),
    /** One of five: 0096's `utm`, `click_id`, `referrer`, `direct`, plus `offline`. */
    basis: text('basis').notNull(),
    source: text('source').notNull(),
    medium: text('medium').notNull(),
    /** `''` when unknown, never null: a null dimension in a key never equals a null. */
    campaign: text('campaign').notNull().default(''),
    /** An opaque handle to `analytics.session`. Not a reference; see the header. */
    sessionReference: uuid('session_reference'),
    /** What the front desk was told, for an offline first touch. Null for every web touch. */
    howHeard: text('how_heard'),
    /** When the touch HAPPENED. The column ZY691 orders, so the one that decides a merge. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** When this row was written. The writer's instant, which is not the touch's. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index('customer_attribution_source_idx').on(t.source, t.medium, t.occurredAt)],
)

/**
 * The LAST touch, one row per booking.
 *
 * On the BOOKING and not on the customer, and that is the decision rather than a normalisation
 * accident: on the customer, a second booking would overwrite the first booking's last touch, and that
 * figure is the denominator of every "which channel produced this sale" report.
 *
 * `source` is NOT NULL and there is no path that leaves it unwritten — `createBooking` writes this row
 * inside the booking transaction for all four booking sources, and a booking with no session gets
 * `offline`. A nullable column would have made "we do not know" and "nobody wrote the row" one value,
 * and attribution coverage divides by exactly that distinction.
 */
export const bookingAttribution = pgTable(
  'booking_attribution',
  {
    bookingId: uuid('booking_id').primaryKey(),
    basis: text('basis').notNull(),
    source: text('source').notNull(),
    medium: text('medium').notNull(),
    campaign: text('campaign').notNull().default(''),
    sessionReference: uuid('session_reference'),
    howHeard: text('how_heard'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index('booking_attribution_source_idx').on(t.source, t.medium, t.occurredAt)],
)
