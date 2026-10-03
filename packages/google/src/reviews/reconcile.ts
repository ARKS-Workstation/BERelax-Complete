import { ASIA_DUBAI, instantFromIso, type TimeZone, toLocal } from '@berelax/core'
import {
  type Actor,
  ingestApiReview,
  reconcileApiReviewId,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
// Subpath import, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type { Review } from '@berelax/providers/google'

/**
 * First sync: the reviews the API returns, matched against the ones a person pasted.
 *
 * docs/10 §6 states both halves of this in one decision: *"`google_review_id` is NULLABLE. A manually
 * entered review has none. When API access arrives, reconcile by reviewer name + rating + date and
 * backfill."* This is the pass that does it, on the first sync after `delivery_mode` flips.
 *
 * ## There is ONE statement of what a review is, and it is not here
 *
 * `reconcileApiReviewId` and `ingestApiReview` are G-REV-02's, in `packages/db`, and this module calls
 * them rather than writing SQL of its own. That is the point of the unit's own instruction to keep one
 * intake shape: the matching rule (`lower(btrim(reviewer_display_name))`, the rating, the review date in
 * a NAMED zone), the `ambiguous` answer, the `for update` lock, the audit row and every CHECK constraint
 * that makes a backfill legal are all stated once. A second reconciliation written for the API path would
 * be a second answer to *is this the same review*, and the day they disagreed one of them would attach an
 * id — and every later reply — to the wrong draft.
 *
 * What this module adds is the only thing the two repository functions cannot decide between them: **which
 * of them to call**. An API review either matches a manual row, in which case it is a backfill, or it does
 * not, in which case it is a new row. `ambiguous` is neither and is reported rather than resolved.
 *
 * ## Why `ambiguous` writes nothing and is carried out of the pass
 *
 * Reviewer name, rating and date are all Google gives us, and *two star-only five-star reviews from "A
 * Google user" on one day is an ordinary Saturday* (`ReconciliationOutcome`'s own words). Picking one
 * would attach the id to the wrong draft silently. So the candidates come back on the result for a human
 * to resolve, and the final row count reflects that nothing was written — which is why the acceptance
 * line's *"zero duplicates"* is asserted as a COUNT rather than as the absence of an error.
 *
 * ## Why the date is derived here and the zone is an argument
 *
 * `reconcileApiReviewId` matches on `(reviewed_at at time zone $zone)::date`, so it needs the API
 * review's date **in that same zone** — a review left at 23:58 UTC is the next day in Asia/Dubai, and
 * that is the date Google shows. `toLocal` is the one conversion in this build; a second one here would
 * be a second answer to what day a review was left on. The zone defaults to `ASIA_DUBAI`, which is the
 * premises' zone and the only one this business trades in.
 */

/** One review the API returned that could not be matched without guessing. Nothing was written. */
export interface AmbiguousReview {
  readonly googleReviewId: string
  readonly candidateIds: readonly string[]
}

export interface FirstSyncResult {
  /** API reviews matched onto a pasted row, whose `google_review_id` is now filled in. */
  readonly backfilled: number
  /** API reviews that matched nothing and were inserted as new rows. */
  readonly inserted: number
  /** API reviews already carrying this id: a re-run of the sync, which must change nothing. */
  readonly unchanged: number
  /** Reported, never resolved. See the module header. */
  readonly ambiguous: readonly AmbiguousReview[]
}

export interface FirstSyncInput {
  readonly connectionId: string
  readonly placeId: string
  readonly reviews: readonly Review[]
  /** The zone the review date is read in. The premises' zone, and always explicit. */
  readonly zone?: TimeZone
}

export interface FirstSyncDeps {
  readonly sql: Sql
  /** Who the backfill's audit row is attributed to. The sync is an agent, and says so. */
  readonly actor: Actor
}

/**
 * Reconciles one listing's reviews, review by review.
 *
 * Sequential and one transaction per review, deliberately. `reconcileApiReviewId` takes `for update` on
 * every unmatched candidate of the same (name, rating, date), so two reviews reconciled concurrently
 * would contend on exactly the rows that are hardest to tell apart — and a transaction spanning the whole
 * sync would hold those locks for its duration and make a partial sync all-or-nothing. A first sync is
 * tens of rows once.
 */
export async function reconcileFirstSync(
  deps: FirstSyncDeps,
  input: FirstSyncInput,
): Promise<FirstSyncResult> {
  const zone = input.zone ?? ASIA_DUBAI
  let backfilled = 0
  let inserted = 0
  let unchanged = 0
  const ambiguous: AmbiguousReview[] = []

  for (const review of input.reviews) {
    const local = toLocal(instantFromIso(review.createdAtIso), zone)
    const outcome = await withUnitOfWork(deps.sql, deps.actor, async (uow) =>
      reconcileApiReviewId(uow, {
        connectionId: input.connectionId,
        placeId: input.placeId,
        googleReviewId: review.reviewId,
        updateTimeIso: review.reply?.updatedAtIso ?? review.createdAtIso,
        reviewerDisplayName: review.reviewerDisplayName,
        rating: review.rating,
        reviewedOn: local.date,
        zone,
      }),
    )
    if (outcome.kind === 'backfilled') {
      backfilled += 1
      continue
    }
    if (outcome.kind === 'ambiguous') {
      // Nothing written, and the candidates carried out. A pass that picked one would be indistinguishable
      // from a pass that matched correctly, for ever.
      ambiguous.push({ googleReviewId: review.reviewId, candidateIds: outcome.candidateIds })
      continue
    }

    // `no_match` covers two different situations and `ingestApiReview` tells them apart: a review this
    // system has never seen (inserted) and one it already has by id, which is what a re-run of the sync
    // produces (unchanged). Deciding that here would be a third answer to a question the upsert already
    // answers from the unique index.
    const ingested = await withUnitOfWork(deps.sql, deps.actor, async (uow) =>
      ingestApiReview(uow, {
        connectionId: input.connectionId,
        placeId: input.placeId,
        googleReviewId: review.reviewId,
        updateTimeIso: review.reply?.updatedAtIso ?? review.createdAtIso,
        rating: review.rating,
        // Absent for a star-only review, which is most of them (docs/10 §7). `ingestApiReview`
        // normalises an empty comment to NULL, so there is one representation of "no comment".
        comment: review.comment ?? null,
        reviewerDisplayName: review.reviewerDisplayName,
        reviewedAtIso: review.createdAtIso,
      }),
    )
    if (ingested.outcome === 'inserted') inserted += 1
    else unchanged += 1
  }

  return { backfilled, inserted, unchanged, ambiguous: Object.freeze(ambiguous) }
}
