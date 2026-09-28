import { sql } from 'drizzle-orm'
import {
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { googleConnection } from './google.ts'
import { message } from './message.ts'

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
    /**
     * The docs/07 §4 routing verdict (migration 0037). NULL until the router has seen the row.
     *
     * The database also carries the floor as three CHECK constraints — an `auto_send` verdict requires
     * `rating >= 4`, `comment_text is null` and `delivery_mode = 'api'`. They are invisible here, because
     * `pnpm db:drift` compares columns only; `packages/db/src/schema/reviews.itest.ts` asserts them by
     * name against the applied schema, which is the only place that can.
     */
    routingVerdict: text('routing_verdict'),
    /** Which row of the table decided it, so an audit can explain any decision. */
    routingRuleId: text('routing_rule_id'),
    /** The escalation lexicon version the text was compared against. Reproduces a stored verdict. */
    routingLexiconVersion: text('routing_lexicon_version'),
    /** When the verdict was taken — not when the review was recorded. */
    routedAt: timestamp('routed_at', { withTimezone: true }),
    /**
     * The provenance of a machine-written draft (migration 0048). All six together or none.
     *
     * Together with `replyDraft` these make the draft **reproducible**: the skeleton id plus the aspects
     * plus the language re-render the exact bytes, so an edit is a comparison rather than a memory, and
     * the prompt fingerprint says which review text it was written against — the check that catches a
     * draft approved against a review the reviewer has since changed.
     *
     * 0048 also carries the ordering as a CHECK: `reply_draft_skeleton_id is null or routing_verdict is
     * not null`, so no machine draft can exist for a review the docs/07 §4 table never saw. Invisible
     * here, because `pnpm db:drift` compares columns only; `reviews.itest.ts` asserts it by name.
     */
    replyDraftSkeletonId: text('reply_draft_skeleton_id'),
    replyDraftAspects: text('reply_draft_aspects').array(),
    replyDraftLanguage: text('reply_draft_language'),
    replyDraftPromptVersion: text('reply_draft_prompt_version'),
    replyDraftPromptFingerprint: text('reply_draft_prompt_fingerprint'),
    replyDraftGeneratedAt: timestamp('reply_draft_generated_at', { withTimezone: true }),
    /**
     * Why no draft was produced, when the reason is that the model's response showed signs of having
     * been steered by the review. A quarantined row carries no machine draft; 0048 refuses the pair.
     */
    draftQuarantineReason: text('draft_quarantine_reason'),
    draftQuarantinedAt: timestamp('draft_quarantined_at', { withTimezone: true }),
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
    // The two reads the routing agent and the operator's queue make (0037). Partial, because both are a
    // small and differently-growing fraction of the table.
    index('google_reviews_escalated_idx')
      .on(t.connectionId, t.placeId, t.reviewedAt)
      .where(sql`routing_verdict = 'escalate'`),
    index('google_reviews_unrouted_idx')
      .on(t.connectionId, t.reviewedAt)
      .where(sql`routing_verdict is null`),
    // The read the reply generator makes (0048): routed, and neither drafted nor quarantined yet.
    index('google_reviews_undrafted_idx')
      .on(t.connectionId, t.reviewedAt)
      .where(
        sql`routing_verdict is not null and reply_draft is null and draft_quarantine_reason is null`,
      ),
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

/**
 * The two routing verdicts, mirroring the CHECK constraint in 0037.
 *
 * Spelled here as well as in `packages/core/src/reviews/routing.ts` because `packages/db` may not import
 * `packages/core` (ADR 0001) — the same two-hand-kept-lists situation as `EXCLUSION_REASONS` and
 * `ELIGIBILITY_EXCLUSION_REASONS`, and held together the same way: `packages/fixtures` imports both and
 * asserts they are equal, which is the only place that may.
 *
 * The **rule id** is deliberately not mirrored. It is a list of fourteen that changes when the routing
 * table changes, a copy here would silently disagree between deploys, and an id this build does not know
 * is answered `escalate` by `reviewVerdictForRule` — which is the safe direction and needs no list.
 */
export const REVIEW_ROUTING_VERDICTS = ['auto_send', 'escalate'] as const
export type ReviewRoutingVerdictName = (typeof REVIEW_ROUTING_VERDICTS)[number]

/**
 * Drizzle mirror of the fallback intake's two tables (migration 0094).
 *
 * `reviewIntakeEmail` holds one row per forwarded Google notification, and the column that matters is
 * `rawBody`: NOT NULL in effect on the `needs_paste` path and NULL on the `parsed` path, because on that
 * path the `google_reviews` row is the record and a second copy of the reviewer's words would drift. The
 * shape is a CHECK over `status` in the migration and is invisible here — `pnpm db:drift` compares columns
 * only, and `reviews.itest.ts` asserts the constraint by name against the applied schema.
 *
 * `googlePlaceAggregate` holds one Places reading per listing per TRADING DATE. There is deliberately no
 * text column on it at all: docs/10 §8 records the Places caching terms as unverified, so nothing in this
 * build stores review content from that source (ADR 0049), and the absence of a column is what makes the
 * acceptance line's table scan a property of the schema rather than of a caller remembering.
 */
export const reviewIntakeEmail = pgTable(
  'review_intake_email',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => googleConnection.id, { onDelete: 'restrict' }),
    placeId: text('place_id').notNull(),
    /** parsed | needs_paste. The two shapes `parseReviewNotificationEmail` can return. */
    status: text('status').notNull(),
    /** Which template shape read it, on the parsed path. The closed set lives in `packages/core`. */
    templateId: text('template_id'),
    /** Why nothing could be read, on the refusal path. Also a `packages/core` set. */
    refusal: text('refusal'),
    /** The forwarded body byte for byte, on the needs_paste path. Never normalised. */
    rawBody: text('raw_body'),
    /** sha256 of the body on both paths, lower-case hex, computed by the caller. */
    rawBodySha256: text('raw_body_sha256').notNull(),
    /** Bytes, not code points: a template change often arrives as an encoding change. */
    rawBodyBytes: integer('raw_body_bytes').notNull(),
    reviewId: uuid('review_id').references(() => googleReview.id, { onDelete: 'restrict' }),
    /** Injected by the caller, never defaulted: the pass is tested on a frozen clock. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    /** When a person closed a needs_paste item by pasting the review. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // The queue read: what is still somebody's job, oldest forward first. Partial, so the cost does not
    // grow with the items already dealt with.
    index('review_intake_email_awaiting_paste_idx')
      .on(t.connectionId, t.receivedAt)
      .where(sql`status = 'needs_paste' and resolved_at is null`),
  ],
)

export const googlePlaceAggregate = pgTable(
  'google_place_aggregate',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => googleConnection.id, { onDelete: 'restrict' }),
    placeId: text('place_id').notNull(),
    /**
     * The trading date the reading counts against, resolved by the caller on `business_day`.
     *
     * Trading runs 11:00-02:00 Asia/Dubai, so a reading taken at 01:30 belongs to the PREVIOUS trading
     * date — and the calendar date of the instant is a different number for nine hours either side of
     * midnight.
     */
    observedOn: date('observed_on').notNull(),
    /** When the call was made. Distinct from `observedOn`, which is the day it counts against. */
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    /** Integer tenths, 10-50, or NULL for an unrated listing. Never a float to compare. */
    ratingTenths: smallint('rating_tenths'),
    /** NULL for a listing with no ratings; 0 for one whose only review was deleted. Different facts. */
    reviewCount: integer('review_count'),
    /** How many curated bodies the call returned and the adapter dropped. A count, never a body. */
    curatedReviewsDiscarded: integer('curated_reviews_discarded').notNull().default(0),
    /** The number the email SAID. Stored rather than derived — it is evidence of what the owner was told. */
    reportedNewReviews: integer('reported_new_reviews'),
    /** NULLABLE even for a notification: F03 diverts every send off production and writes no row. */
    notifiedMessageId: uuid('notified_message_id').references(() => message.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // The tripwire's idempotency AND the shape of the table: one reading per listing per trading date, so
    // a reclaimed job cannot email the owner about the same reviews twice.
    unique('google_place_aggregate_one_reading_per_trading_date').on(
      t.connectionId,
      t.placeId,
      t.observedOn,
    ),
    // "The newest reading strictly before today" is one index step rather than a sort of the history.
    index('google_place_aggregate_latest_idx').on(t.connectionId, t.placeId, t.observedOn),
  ],
)

/** The two outcomes of reading a forwarded notification, mirroring 0094's CHECK. */
export const REVIEW_INTAKE_STATUSES = ['parsed', 'needs_paste'] as const
export type ReviewIntakeStatus = (typeof REVIEW_INTAKE_STATUSES)[number]
