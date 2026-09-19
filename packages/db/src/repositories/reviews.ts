import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import {
  REVIEW_ROUTING_VERDICTS,
  type ReviewDeliveryMode,
  type ReviewSource,
} from '../schema/reviews.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The review queue: writes, and the two paths that only exist because of docs/10 §6.
 *
 * ## Why every mutation takes a UnitOfWork
 *
 * The same reason `allocateDocumentNumber` does. A review row and the audit row that says how it got
 * there must commit together: a queue entry nobody can account for is the thing docs/07 §6 exists to
 * design out, and an audit row for an ingest that rolled back is just as bad.
 *
 * ## At-least-once, and what that forces
 *
 * Pub/Sub review notifications are delivered **at least once** (docs/10 §7), so the same
 * `(reviewId, updateTime)` arrives twice as a matter of course — not as a fault. `ingestApiReview` is
 * therefore an upsert keyed on the partial unique index, whose DO UPDATE is itself guarded by
 * `update_time` moving forward. A replay reaches the `unchanged` branch, writes no audit row, and the
 * queue keeps one row for one review. The alternative — check-then-insert — has a window between the
 * check and the insert exactly wide enough for the duplicate delivery to land in it.
 *
 * ## What an ingest must never touch
 *
 * `reply_draft`, `delivery_mode` and the delivery timestamps. A review that was pasted, drafted,
 * approved and posted manually may later be matched to an API row (see `reconcileApiReviewId`); the
 * API payload is authoritative about the *review* and knows nothing about our delivery of the reply.
 * Overwriting the draft would discard the only part of the row a human made.
 */

/** Ratings are 1..5 in the database too; this is the message a caller can act on. */
function assertRating(rating: number): void {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new AppError('validation', `Review rating must be an integer 1-5, received ${rating}`)
  }
}

/**
 * Star-only is `NULL`, never `''`.
 *
 * The paste form submits an empty textarea for a star-only review, which is the majority case
 * (docs/10 §7). Storing `''` would make "no comment" two values, and every reader — the router, the
 * linter, the generator — would have to remember both. Non-empty text is stored exactly as received:
 * trimming it here would quietly edit a customer's words.
 */
function normaliseComment(comment: string | null | undefined): string | null {
  if (comment === null || comment === undefined) return null
  return comment.trim().length === 0 ? null : comment
}

export interface ApiReviewPayload {
  readonly connectionId: string
  readonly placeId: string
  /** Present by definition: this is the API path. */
  readonly googleReviewId: string
  /** The payload's `updateTime`. Half of the idempotency key, and the guard on the upsert. */
  readonly updateTimeIso: string
  readonly rating: number
  /** Absent or empty for a star-only review. */
  readonly comment?: string | null
  readonly reviewerDisplayName: string
  readonly reviewedAtIso: string
}

/**
 * `unchanged` is the replay outcome, and the one the idempotency test asserts on: nothing was written
 * and, deliberately, no audit row either.
 */
export type ApiIngestOutcome = 'inserted' | 'updated' | 'unchanged'

export interface IngestedReview {
  readonly id: string
  readonly outcome: ApiIngestOutcome
}

export async function ingestApiReview(
  uow: UnitOfWork,
  payload: ApiReviewPayload,
): Promise<IngestedReview> {
  assertRating(payload.rating)
  const comment = normaliseComment(payload.comment)

  // `xmax = 0` distinguishes the inserted row from the updated one, which `returning` alone cannot.
  // The WHERE on the DO UPDATE is what makes a replay a no-op: a payload whose update_time has not
  // moved forward matches no row, so nothing is returned and nothing is audited.
  const rows = await uow.sql<{ id: string; inserted: boolean }[]>`
    insert into google_reviews (
      connection_id, place_id, google_review_id, google_update_time, source, delivery_mode,
      rating, comment_text, reviewer_display_name, reviewed_at
    ) values (
      ${payload.connectionId}, ${payload.placeId}, ${payload.googleReviewId},
      ${payload.updateTimeIso}, 'api', 'api', ${payload.rating}, ${comment},
      ${payload.reviewerDisplayName}, ${payload.reviewedAtIso}
    )
    on conflict (google_review_id) where google_review_id is not null do update set
      rating                = excluded.rating,
      comment_text          = excluded.comment_text,
      reviewer_display_name = excluded.reviewer_display_name,
      reviewed_at           = excluded.reviewed_at,
      google_update_time    = excluded.google_update_time
    where google_reviews.google_update_time is null
       or google_reviews.google_update_time < excluded.google_update_time
    returning id, xmax = 0 as inserted
  `

  const written = rows[0]
  if (written === undefined) {
    const [existing] = await uow.sql<{ id: string }[]>`
      select id from google_reviews where google_review_id = ${payload.googleReviewId}
    `
    if (existing === undefined) {
      // The row conflicted and then could not be read: the only way that happens is a concurrent
      // delete, and silently reporting success would hide it.
      throw new AppError(
        'invariant_violated',
        `Review ${payload.googleReviewId} conflicted on insert but could not be read back`,
      )
    }
    return { id: existing.id, outcome: 'unchanged' }
  }

  const outcome: ApiIngestOutcome = written.inserted ? 'inserted' : 'updated'
  await uow.audit.record({
    action: written.inserted ? 'google_review.ingested' : 'google_review.updated_from_api',
    entityType: 'google_review',
    entityId: written.id,
    operation: written.inserted ? 'create' : 'update',
    after: {
      googleReviewId: payload.googleReviewId,
      updateTime: payload.updateTimeIso,
      rating: payload.rating,
      starOnly: comment === null,
      source: 'api' satisfies ReviewSource,
      deliveryMode: 'api' satisfies ReviewDeliveryMode,
    },
  })
  return { id: written.id, outcome }
}

export interface ManualReviewInput {
  readonly connectionId: string
  readonly placeId: string
  /** How it reached us. `api` is rejected: this path has no `google_review_id` to store. */
  readonly source: Exclude<ReviewSource, 'api'>
  readonly rating: number
  readonly comment?: string | null
  readonly reviewerDisplayName: string
  readonly reviewedAtIso: string
}

/**
 * Records a review nobody could have fetched: pasted, forwarded, or typed in.
 *
 * `google_review_id` is NULL and `delivery_mode` is 'manual', which is the launch-day normal rather
 * than a degraded case. Both are decisions 1 and 2 of docs/10 §6 in one insert.
 */
export async function recordManualReview(
  uow: UnitOfWork,
  input: ManualReviewInput,
): Promise<{ readonly id: string }> {
  assertRating(input.rating)
  if ((input.source as ReviewSource) === 'api') {
    throw new AppError(
      'validation',
      "source 'api' cannot be recorded here: an API review carries a google_review_id, so it belongs " +
        'in ingestApiReview where the idempotency key applies',
    )
  }
  const comment = normaliseComment(input.comment)
  const [row] = await uow.sql<{ id: string }[]>`
    insert into google_reviews (
      connection_id, place_id, source, delivery_mode,
      rating, comment_text, reviewer_display_name, reviewed_at
    ) values (
      ${input.connectionId}, ${input.placeId}, ${input.source}, 'manual',
      ${input.rating}, ${comment}, ${input.reviewerDisplayName}, ${input.reviewedAtIso}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'Manual review insert returned no row')
  }
  await uow.audit.record({
    action: 'google_review.recorded',
    entityType: 'google_review',
    entityId: row.id,
    operation: 'create',
    after: {
      source: input.source,
      deliveryMode: 'manual' satisfies ReviewDeliveryMode,
      rating: input.rating,
      starOnly: comment === null,
      googleReviewId: null,
    },
  })
  return { id: row.id }
}

export interface ReconciliationInput {
  readonly connectionId: string
  readonly placeId: string
  readonly googleReviewId: string
  readonly updateTimeIso: string
  readonly reviewerDisplayName: string
  readonly rating: number
  /** The date Google shows against the review, `YYYY-MM-DD`, read in `zone`. */
  readonly reviewedOn: string
  /** IANA zone. Always an argument — a date is not a fact without one. */
  readonly zone: string
}

/**
 * The outcome of matching an API review against the manual rows.
 *
 * `ambiguous` is not a defensive afterthought. Reviewer name, rating and date are all Google gives
 * us, and two star-only five-star reviews from 'A Google user' on one day is an ordinary Saturday.
 * Picking one would attach the id — and every later API reply — to the wrong draft, silently. So the
 * candidates are returned for a human to resolve and nothing is written.
 */
export type ReconciliationOutcome =
  | { readonly kind: 'backfilled'; readonly id: string }
  | { readonly kind: 'no_match' }
  | { readonly kind: 'ambiguous'; readonly candidateIds: readonly string[] }

/**
 * Backfills `google_review_id` onto the manual row that is the same review.
 *
 * Deliberately an UPDATE of the existing row and never an insert: the row carries the approved draft
 * and the delivery history (`delivery_mode`, `posted_manually_at`), and a second row for one review
 * would double it in the queue and in every count the owner is shown.
 */
export async function reconcileApiReviewId(
  uow: UnitOfWork,
  input: ReconciliationInput,
): Promise<ReconciliationOutcome> {
  assertRating(input.rating)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.reviewedOn)) {
    throw new AppError(
      'validation',
      `reviewedOn must be YYYY-MM-DD, received "${input.reviewedOn}"`,
    )
  }

  // `lower(btrim(...))` on both sides, because a pasted name arrives with whatever spacing and casing
  // the owner's clipboard had. The zone is applied to the stored instant rather than compared as text:
  // a review left at 23:58 UTC is the next day in Asia/Dubai, and that is the date Google shows.
  const candidates = await uow.sql<{ id: string }[]>`
    select id from google_reviews
    where connection_id = ${input.connectionId}
      and place_id = ${input.placeId}
      and google_review_id is null
      and lower(btrim(reviewer_display_name)) = lower(btrim(${input.reviewerDisplayName}))
      and rating = ${input.rating}
      and (reviewed_at at time zone ${input.zone})::date = ${input.reviewedOn}::date
    order by reviewed_at
    for update
  `
  if (candidates.length === 0) return { kind: 'no_match' }
  if (candidates.length > 1) {
    return { kind: 'ambiguous', candidateIds: candidates.map((row) => row.id) }
  }

  const target = candidates[0]
  if (target === undefined) return { kind: 'no_match' }
  const updated = await uow.sql<{ id: string }[]>`
    update google_reviews set
      google_review_id   = ${input.googleReviewId},
      google_update_time = ${input.updateTimeIso},
      reconciled_at      = now()
    where id = ${target.id} and google_review_id is null
    returning id
  `
  if (updated[0] === undefined) {
    // Another transaction backfilled it between the SELECT ... FOR UPDATE and here. Reporting a
    // backfill that did not happen is worse than reporting nothing.
    return { kind: 'no_match' }
  }
  await uow.audit.record({
    action: 'google_review.reconciled',
    entityType: 'google_review',
    entityId: target.id,
    operation: 'update',
    before: { googleReviewId: null },
    after: {
      googleReviewId: input.googleReviewId,
      updateTime: input.updateTimeIso,
      matchedOn: { reviewerDisplayName: input.reviewerDisplayName, rating: input.rating },
      reviewedOn: input.reviewedOn,
      zone: input.zone,
    },
  })
  return { kind: 'backfilled', id: target.id }
}

/**
 * The reply went out through the API, and the two-step acknowledgement that mode allows.
 *
 * Both writes set `delivery_mode` as well as the timestamp, because a review ingested in API mode can
 * still be answered by hand when access lapses, and the row must say which actually happened. The
 * check constraint refuses the contradiction — an API submission on a row already posted by hand —
 * rather than leaving a row that reads as both.
 */
export async function recordReplySubmittedToApi(uow: UnitOfWork, reviewId: string): Promise<void> {
  const rows = await uow.sql<{ id: string }[]>`
    update google_reviews set delivery_mode = 'api', submitted_at = now()
    where id = ${reviewId} returning id
  `
  if (rows[0] === undefined) throw notFound(reviewId)
  await uow.audit.record({
    action: 'google_review.reply_submitted',
    entityType: 'google_review',
    entityId: reviewId,
    operation: 'update',
    after: { deliveryMode: 'api' satisfies ReviewDeliveryMode, submitted: true },
  })
}

export async function recordReplyConfirmedByGoogle(
  uow: UnitOfWork,
  reviewId: string,
): Promise<void> {
  const rows = await uow.sql<{ id: string }[]>`
    update google_reviews set confirmed_at = now()
    where id = ${reviewId} returning id
  `
  if (rows[0] === undefined) throw notFound(reviewId)
  await uow.audit.record({
    action: 'google_review.reply_confirmed',
    entityType: 'google_review',
    entityId: reviewId,
    operation: 'update',
    after: { deliveryMode: 'api' satisfies ReviewDeliveryMode, confirmed: true },
  })
}

/** The owner pasted the reply into Google themselves and clicked *Marked as posted*. */
export async function recordReplyPostedManually(uow: UnitOfWork, reviewId: string): Promise<void> {
  const rows = await uow.sql<{ id: string }[]>`
    update google_reviews set delivery_mode = 'manual', posted_manually_at = now()
    where id = ${reviewId} returning id
  `
  if (rows[0] === undefined) throw notFound(reviewId)
  await uow.audit.record({
    action: 'google_review.reply_posted_manually',
    entityType: 'google_review',
    entityId: reviewId,
    operation: 'update',
    after: { deliveryMode: 'manual' satisfies ReviewDeliveryMode, postedManually: true },
  })
}

function notFound(reviewId: string): AppError {
  return new AppError('not_found', `No review ${reviewId}`)
}

/**
 * A routing decision, as data. Computed in `packages/core` and handed here.
 *
 * `packages/db` may not import `packages/core` (ADR 0001), so this is a plain shape rather than the core
 * `ReviewRoutingDecision` type — and that is not a workaround, it is the boundary working: the write path
 * must not be able to *take* the decision, only to record one, so there is nothing here that could route a
 * review differently from the table.
 */
export interface ReviewRoutingVerdictInput {
  /** `auto_send` or `escalate`. Anything else is refused before the database has to. */
  readonly verdict: string
  /** Which row of the docs/07 §4 table decided it. */
  readonly ruleId: string
  /** The escalation lexicon version the text was compared against. */
  readonly lexiconVersion: string
  /** Every escalation term found, for the audit row. Empty for a star-only review. */
  readonly matchedTerms?: readonly string[]
  /** The categories those terms fall in. */
  readonly categories?: readonly string[]
}

/**
 * Records the verdict on a review, with the rule and the lexicon version that produced it.
 *
 * ## Why an auto_send is checked here as well as by the database
 *
 * 0037 carries the floor as three CHECK constraints — `rating >= 4`, `comment_text is null`,
 * `delivery_mode = 'api'` — and they are the guarantee. This function checks the *vocabulary* before the
 * statement runs, which the constraints cannot do for it: a verdict string this build does not know would
 * be refused by `google_reviews_routing_verdict_known` with a constraint name, and a caller reading that
 * message has to go and find out which of thirteen rule ids it came from. An `AppError` naming the value
 * is the difference between a queue that explains itself and one that reports a SQLSTATE.
 *
 * It deliberately does **not** re-derive the verdict. Two implementations of docs/07 §4, one of them in
 * SQL, is the shape that drifts; the second application of the rule belongs in `autoSendFloor`, beside the
 * first, where both can be read at once.
 *
 * ## Idempotent per decision, and never a second verdict
 *
 * The UPDATE is guarded by `routing_verdict is null`, so a replayed agent run — routing is an at-least-once
 * job like every other (docs/10 §7) — reaches `already_routed` and writes no second audit row. Re-routing
 * a review is not this function's job and would be a different one: the stored verdict is the record of a
 * decision that was taken, and overwriting it destroys the only evidence of what the queue actually did.
 */
export type RoutingWriteOutcome = 'routed' | 'already_routed'

export async function recordRoutingVerdict(
  uow: UnitOfWork,
  reviewId: string,
  decision: ReviewRoutingVerdictInput,
): Promise<RoutingWriteOutcome> {
  if (!(REVIEW_ROUTING_VERDICTS as readonly string[]).includes(decision.verdict)) {
    throw new AppError(
      'validation',
      `Unknown routing verdict "${decision.verdict}". The vocabulary is ` +
        `${REVIEW_ROUTING_VERDICTS.join(' | ')} and a third outcome is not a state docs/07 §4 describes`,
    )
  }
  if (decision.ruleId.trim().length === 0 || decision.lexiconVersion.trim().length === 0) {
    throw new AppError(
      'validation',
      'A routing verdict needs both the rule id that decided it and the lexicon version it was taken ' +
        'against: a decision nobody can explain is not an auditable one',
    )
  }

  const rows = await uow.sql<{ id: string }[]>`
    update google_reviews set
      routing_verdict         = ${decision.verdict},
      routing_rule_id         = ${decision.ruleId},
      routing_lexicon_version = ${decision.lexiconVersion},
      routed_at               = now()
    where id = ${reviewId} and routing_verdict is null
    returning id
  `
  if (rows[0] === undefined) {
    const [existing] = await uow.sql<{ id: string }[]>`
      select id from google_reviews where id = ${reviewId}
    `
    if (existing === undefined) throw notFound(reviewId)
    return 'already_routed'
  }

  await uow.audit.record({
    action: 'google_review.routed',
    entityType: 'google_review',
    entityId: reviewId,
    operation: 'update',
    before: { routingVerdict: null },
    after: {
      routingVerdict: decision.verdict,
      routingRuleId: decision.ruleId,
      routingLexiconVersion: decision.lexiconVersion,
      matchedTerms: decision.matchedTerms ?? [],
      categories: decision.categories ?? [],
    },
  })
  return 'routed'
}

export interface QueuedReview {
  readonly id: string
  readonly connectionId: string
  readonly placeId: string
  /** NULL on every fallback-mode row, which on launch day is all of them. */
  readonly googleReviewId: string | null
  readonly source: ReviewSource
  readonly deliveryMode: ReviewDeliveryMode
  readonly rating: number
  /** NULL for a star-only review. */
  readonly comment: string | null
  readonly reviewerDisplayName: string
  readonly reviewedAtIso: string
  readonly replyDraft: string | null
  readonly submittedAtIso: string | null
  readonly confirmedAtIso: string | null
  readonly postedManuallyAtIso: string | null
  /** NULL until the router has seen the row. Never read as "auto_send" — see reviewVerdictForRule. */
  readonly routingVerdict: string | null
  /** Which row of the docs/07 §4 table decided it. */
  readonly routingRuleId: string | null
  /** The lexicon version the verdict was taken against, which is what reproduces it. */
  readonly routingLexiconVersion: string | null
  readonly routedAtIso: string | null
}

interface ReviewRow {
  readonly id: string
  readonly connection_id: string
  readonly place_id: string
  readonly google_review_id: string | null
  readonly source: ReviewSource
  readonly delivery_mode: ReviewDeliveryMode
  readonly rating: number
  readonly comment_text: string | null
  readonly reviewer_display_name: string
  readonly reviewed_at: Date
  readonly reply_draft: string | null
  readonly submitted_at: Date | null
  readonly confirmed_at: Date | null
  readonly posted_manually_at: Date | null
  readonly routing_verdict: string | null
  readonly routing_rule_id: string | null
  readonly routing_lexicon_version: string | null
  readonly routed_at: Date | null
}

const toQueued = (row: ReviewRow): QueuedReview => ({
  id: row.id,
  connectionId: row.connection_id,
  placeId: row.place_id,
  googleReviewId: row.google_review_id,
  source: row.source,
  deliveryMode: row.delivery_mode,
  rating: row.rating,
  comment: row.comment_text,
  reviewerDisplayName: row.reviewer_display_name,
  reviewedAtIso: row.reviewed_at.toISOString(),
  replyDraft: row.reply_draft,
  submittedAtIso: row.submitted_at?.toISOString() ?? null,
  confirmedAtIso: row.confirmed_at?.toISOString() ?? null,
  postedManuallyAtIso: row.posted_manually_at?.toISOString() ?? null,
  routingVerdict: row.routing_verdict,
  routingRuleId: row.routing_rule_id,
  routingLexiconVersion: row.routing_lexicon_version,
  routedAtIso: row.routed_at?.toISOString() ?? null,
})

const REVIEW_COLUMNS =
  'id, connection_id, place_id, google_review_id, source, delivery_mode, rating, comment_text, ' +
  'reviewer_display_name, reviewed_at, reply_draft, submitted_at, confirmed_at, posted_manually_at, ' +
  'routing_verdict, routing_rule_id, routing_lexicon_version, routed_at'

/**
 * The queue for one listing of one connection, newest first.
 *
 * Scoped by **both** `connectionId` and `placeId`, and there is deliberately no unscoped overload.
 * Two connections is the ordinary case (docs/10 §2) and a queue that returned the other listing's
 * reviews would have the owner replying, in public, as the wrong business.
 */
export async function listReviewQueue(
  sql: Sql,
  scope: { readonly connectionId: string; readonly placeId: string; readonly limit?: number },
): Promise<readonly QueuedReview[]> {
  const rows = await sql<ReviewRow[]>`
    select ${sql.unsafe(REVIEW_COLUMNS)} from google_reviews
    where connection_id = ${scope.connectionId} and place_id = ${scope.placeId}
    order by reviewed_at desc
    limit ${scope.limit ?? 200}
  `
  return rows.map(toQueued)
}

export async function getReview(sql: Sql, id: string): Promise<QueuedReview | undefined> {
  const rows = await sql<ReviewRow[]>`
    select ${sql.unsafe(REVIEW_COLUMNS)} from google_reviews where id = ${id}
  `
  const row = rows[0]
  return row === undefined ? undefined : toQueued(row)
}
