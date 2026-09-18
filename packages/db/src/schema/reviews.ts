import { sql } from 'drizzle-orm'
import { index, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { googleConnection } from './google.ts'

/**
 * Drizzle mirror of the review table (migration 0020).
 *
 * Hand-written because migrations are SQL-first (ADR 0006); `pnpm db:drift` compares this against the
 * live database in both directions.
 *
 * The two shapes that are the whole point of the table, from docs/10 §6:
 *
 *   - `googleReviewId` is **nullable**, because a pasted review has none. It is unique only among the
 *     rows that have one, which a partial index expresses and a plain unique index cannot.
 *   - `deliveryMode` is a column, so `submittedAt`/`confirmedAt` and `postedManuallyAt` coexist. There is
 *     deliberately **no `postedAt`**: it would read the same whether the system sent the reply or a human
 *     said they had, which is the one distinction anybody needs from it afterwards.
 */
export const googleReview = pgTable(
  'google_reviews',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** ON DELETE RESTRICT in the database: disconnecting is a status, not a row delete. */
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => googleConnection.id, { onDelete: 'restrict' }),
    /** The listing, denormalised from the connection's `gbp_reviews` capability `resource_ref.placeId`. */
    placeId: text('place_id').notNull(),
    /** Nullable. NULL until an API row arrives or reconciliation backfills it. */
    googleReviewId: text('google_review_id'),
    /** The payload's `updateTime`. With `googleReviewId`, the at-least-once idempotency key. */
    googleUpdateTime: timestamp('google_update_time', { withTimezone: true }),
    /** api | email_parse | paste | manual */
    source: text('source').notNull(),
    /** api | manual. Which delivery timestamps below are meaningful on this row. */
    deliveryMode: text('delivery_mode').notNull(),
    rating: smallint('rating').notNull(),
    /** NULL for a star-only review — common (docs/10 §7) — and never the empty string. */
    commentText: text('comment_text'),
    /** Google's display name, verbatim. Frequently 'A Google user'. */
    reviewerDisplayName: text('reviewer_display_name').notNull(),
    /** When the reviewer left it, not when we found out. */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull(),
    /** The reply awaiting approval. Reconciliation never touches it. */
    replyDraft: text('reply_draft'),
    /** api delivery: submitted to the API, then acknowledged by Google. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** manual delivery: the owner posted it and said so. */
    postedManuallyAt: timestamp('posted_manually_at', { withTimezone: true }),
    /** When a manual row acquired its `googleReviewId`. */
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // Partial: many rows legitimately have no id, and exactly one row per real Google review.
    uniqueIndex('google_reviews_google_review_id_key')
      .on(t.googleReviewId)
      .where(sql`google_review_id is not null`),
    // The queue read is scoped by both columns, because that is the query that must never return
    // another connection's rows.
    index('google_reviews_queue_idx').on(t.connectionId, t.placeId, t.reviewedAt),
    index('google_reviews_unmatched_idx')
      .on(t.connectionId, t.rating, t.reviewedAt)
      .where(sql`google_review_id is null`),
  ],
)

/** The four honest ways a review reaches the system (docs/10 §6). */
export const REVIEW_SOURCES = ['api', 'email_parse', 'paste', 'manual'] as const
export type ReviewSource = (typeof REVIEW_SOURCES)[number]

/**
 * How the reply was delivered — a column, not an assumption.
 *
 * 'api' means the reply was submitted through Business Profile and acknowledged; 'manual' means a human
 * posted it. Both are normal, and on launch day only the second one exists (docs/10 §6).
 */
export const REVIEW_DELIVERY_MODES = ['api', 'manual'] as const
export type ReviewDeliveryMode = (typeof REVIEW_DELIVERY_MODES)[number]
