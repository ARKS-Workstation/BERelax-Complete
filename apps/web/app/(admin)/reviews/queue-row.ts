import { explainReviewEscalation } from '@berelax/core'
import type { QueuedReview } from '@berelax/db'
import type { QueueRow, ReviewDetailView, ReviewQueueStage } from './view.ts'

/**
 * A stored review row, reduced to what each of the two screens shows (G-REV-06).
 *
 * Pure, and separated from the handlers so `apps/web/src/reviews-queue-render.test.ts` can drive both
 * mappings over hand-built rows — including the rows that should not exist. That is not a convenience: the
 * assertions that matter here are about a row carrying a verdict this screen must not act on, and a
 * database cannot be made to hold one on demand.
 */

/**
 * Where a review stands, derived from the row and in exactly one place.
 *
 * The ORDER is the whole content of this function, and it reads from the end of life backwards: a row that
 * has been delivered is delivered whatever else is on it. Written as a sequence of returns rather than as
 * one expression, because each step is a different question and collapsing them would hide that a
 * quarantined review can also have been approved by a human who wrote the reply themselves.
 *
 * `claimed_as_posted` is named for what it is. There is no API access in this build (docs/10 §4, OPEN-QUESTIONS Y3-gbp-api), so
 * `posted_manually_at` is somebody's statement that they pasted the reply into Google and not an
 * observation of the listing — and a stage called `posted` or `published` would make the queue say the
 * one thing it cannot know.
 */
export function stageOf(row: QueuedReview): ReviewQueueStage {
  if (row.submittedAtIso !== null) return 'submitted_to_the_api'
  if (row.postedManuallyAtIso !== null) return 'claimed_as_posted'
  if (row.replyApprovedText !== null) return 'approved_not_yet_posted'
  if (row.draftQuarantineReason !== null) return 'quarantined'
  if (row.replyDraft !== null) return 'awaiting_approval'
  return 'awaiting_a_draft'
}

/**
 * The stored verdict explained, from the row's own fields.
 *
 * The lexicon version comes off the ROW, so the categories are derived from the terms the verdict was
 * taken against rather than from today's. `@berelax/core`'s `explainReviewEscalation` is where that
 * argument lives; this is the one call site that reads it off a review.
 */
const escalationOf = (row: QueuedReview) =>
  explainReviewEscalation({
    comment: row.comment,
    routingRuleId: row.routingRuleId,
    routingLexiconVersion: row.routingLexiconVersion,
  })

/** One row of the queue. No reply text and no review text: a queue is read to choose what to open. */
export function queueRowFrom(row: QueuedReview): QueueRow {
  return {
    id: row.id,
    rating: row.rating,
    starOnly: row.comment === null,
    reviewerDisplayName: row.reviewerDisplayName,
    reviewedAtIso: row.reviewedAtIso,
    stage: stageOf(row),
    escalation: escalationOf(row),
  }
}

/** One review, as the detail screen shows it. */
export function reviewDetailFrom(row: QueuedReview): NonNullable<ReviewDetailView['review']> {
  return {
    id: row.id,
    rating: row.rating,
    starOnly: row.comment === null,
    comment: row.comment,
    reviewerDisplayName: row.reviewerDisplayName,
    reviewedAtIso: row.reviewedAtIso,
    placeId: row.placeId,
    source: row.source,
    deliveryMode: row.deliveryMode,
    stage: stageOf(row),
    escalation: escalationOf(row),
    draft: row.replyDraft,
    quarantineReason: row.draftQuarantineReason,
    approvedText: row.replyApprovedText,
    lintVersion: row.replyLintVersion,
    contentSha256: row.replyLintContentSha256,
    postedManuallyAtIso: row.postedManuallyAtIso,
    submittedAtIso: row.submittedAtIso,
  }
}
