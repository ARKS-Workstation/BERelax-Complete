// Subpath import, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type { BusinessProfileProvider, Review } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import { parseGbpResourceRef, reviewsPathFor } from '../capability-resolver.ts'
import type { PerProfileRateLimit, RateLimitClock } from '../rate-limit/token-bucket.ts'
import { reviewReplyLimit } from '../rate-limit/token-bucket.ts'
import type { ReplySubmitter } from '../reviews/deliver.ts'

/**
 * The legacy `v4` Reviews adapter, quarantined in one module.
 *
 * docs/10 §7 calls Reviews the **highest-risk dependency** in the plan, and says why in one line:
 * *"Reviews remaining on legacy v4 while everything else migrated is the clearest possible signal it will
 * move."* Everything else this build touches is `v1` on `mybusinessbusinessinformation.googleapis.com`,
 * `mybusinessaccountmanagement.googleapis.com` or `mybusinessverifications.googleapis.com`. Reviews is on
 * a host Google has never migrated and has deprecated the rest of.
 *
 * So the whole of what this build knows about `v4` is here, and two different checks hold that true
 * because no single one can:
 *
 *   1. **The host string lives in one module.** `packages/fixtures/src/reviews-v4-quarantine.test.ts`
 *      scans every non-test module under `packages/` and `apps/` and asserts {@link MYBUSINESS_V4_HOST}
 *      appears in exactly one of them — this one. Dependency-cruiser sees module EDGES and cannot see a
 *      string, so the string half has to be a scan, exactly as the NAP rule's half is.
 *   2. **The module is reachable from one directory.** `.dependency-cruiser.cjs`'s
 *      `reviews-v4-is-quarantined` permits an import of this file only from
 *      `packages/google/src/reviews/` and the package barrel, so a route, a worker job or the SEO agent
 *      cannot hold a reference to it. A direct-dependency rule and not `reachable`, for
 *      `messaging-providers-only-inside-a-transport`'s reason: the barrel legitimately re-exports the
 *      factory, and a reachability rule would condemn every consumer of `@berelax/google`.
 *
 * Both have known-bad fixtures in `scripts/test-gates.mjs` (gate block 173) asserting they fire by name.
 *
 * ## The path is built from the PERSISTED accountId, and that is the whole reason it is persisted
 *
 * `v1` returns `locations/{l}`; the `v4` reviews path is `accounts/{a}/locations/{l}/reviews` (docs/10
 * §7). The account is **not recoverable from the location** — it is the thing you enumerated under — so
 * `GbpResourceRef` carries it and `reviewsPathFor` is the one function that assembles the path.
 * Reused rather than re-written here: a second assembler is a second answer to what the URL is, and the
 * day they disagreed one of them would 404 on a cron job at 03:00.
 *
 * A capability row holding a `v1`-shaped ref with no `account` therefore **fails loudly before any
 * transport call**: `parseGbpResourceRef` raises `google_resource_ref_malformed` naming the missing part.
 * That refusal is first in every function below, which `reviews-v4.test.ts` asserts with a transport spy
 * at zero calls rather than by reading this comment.
 *
 * ## The token bucket is 6/min and it is an argument
 *
 * docs/10 §7: *"Plan a 6/min token bucket against the 10 edits/min cap."* `reviewReplyLimit` holds the
 * figure and `../rate-limit/token-bucket.ts` holds the reason it is 6 and not 10 — the cap is per PROFILE
 * and shared with the Business Information hours write, the quota actually applied to legacy `v4` is on
 * docs/10 §8's must-confirm list, and a window that lives in one process cannot see a second worker's.
 *
 * It is an argument so that one profile has ONE window across both callers. A limiter constructed here
 * would be a limiter per adapter instance, which is no limiter at all: the eleventh edit of the minute is
 * the eleventh across every caller.
 *
 * ## What is NOT here
 *
 * No credentials, and no real HTTP. There is no Business Profile API access in this build (docs/10 §4,
 * `OPEN-QUESTIONS Y3-gbp-api`), so every call goes through `BusinessProfileProvider` — a port with a fake
 * (ADR 0022) — and the fake answers `access_not_granted` on demand. The whole API path is built and
 * exercised against it and is never selected, because `delivery_mode` stays `manual`.
 *
 * No reply SIGNATURE either, and that is deferred rather than decided. `OPEN-QUESTIONS Y9-reply-signature`
 * is **open**: nobody has said what this business signs its replies with, or whether it wants one.
 * `deliverApprovedReply` takes `signature: string | null` and the 1,200-character cap is measured over the
 * rendered total either way, so the mechanism exists; a plausible sign-off invented here would be
 * indistinguishable from a configured one and would be published under the owner's name on an indexed page
 * (the brief's rule 15). This adapter receives the bytes a human approved and appends nothing.
 */

/**
 * The legacy host. The ONE place this string appears in the repository.
 *
 * `mybusiness.googleapis.com` — not `mybusinessbusinessinformation`, which is `v1`'s and is a different
 * API with a different approval state. The scan named in the header is what keeps this the only
 * occurrence, and the reason the constant exists at all is that a scan cannot assert anything about a
 * string somebody inlined.
 */
export const MYBUSINESS_V4_HOST = 'mybusiness.googleapis.com'

/** `https://{host}/v4/`. The version is in the path on this API, which is part of why it is legacy. */
export const MYBUSINESS_V4_BASE = `https://${MYBUSINESS_V4_HOST}/v4/`

/**
 * `.../accounts/{a}/locations/{l}/reviews`, from the stored reference alone.
 *
 * Takes the ref and nothing else, which is the test of whether the row is sufficient: if the URL can be
 * built from the capability row, the adapter never has to re-enumerate accounts to find out where its own
 * location lives.
 */
export function reviewsV4ListUrl(ref: Readonly<Record<string, unknown>> | null): string {
  return `${MYBUSINESS_V4_BASE}${reviewsPathFor(ref)}`
}

/** `details.reason` on the refusal a row with no Google id gets. A caller branches on this, never prose. */
export const REVIEW_HAS_NO_GOOGLE_ID = 'google_review_has_no_google_review_id'

/** `.../reviews/{reviewId}/reply` — the `updateReply` target. Replying twice overwrites (docs/10 §7). */
export function reviewsV4ReplyUrl(
  ref: Readonly<Record<string, unknown>> | null,
  reviewId: string,
): string {
  return `${reviewsV4ListUrl(ref)}/${encodeURIComponent(reviewId)}/reply`
}

/**
 * The review's Google id, or a refusal.
 *
 * `google_reviews.google_review_id` is NULLABLE and is NULL on every fallback-mode row, which on launch
 * day is all of them (docs/10 §6 decision 1). A row that has never been reconciled has nothing on the
 * listing to reply TO, so api-mode delivery of it is impossible rather than merely awkward.
 *
 * The first version of this read was `review.googleReviewId ?? ''`, which would have built
 * `.../reviews//reply` and spent a call discovering it. A named refusal is the difference between an
 * operator reading *this review was never matched to a Google review* and an operator reading a 404.
 */
function googleIdOrRefuse(review: {
  readonly id: string
  readonly googleReviewId: string | null
}): string {
  if (review.googleReviewId === null) {
    throw new AppError(
      'invariant_violated',
      `Review ${review.id} has no google_review_id, so there is nothing on the Google listing to reply ` +
        'to. A pasted review acquires one at reconciliation (docs/10 §6 decision 1); until then its ' +
        'reply can only be posted by a person.',
      { details: { reason: REVIEW_HAS_NO_GOOGLE_ID, reviewId: review.id } },
    )
  }
  return review.googleReviewId
}

export interface ReviewsV4Deps {
  /** The port, never an SDK. `access_not_granted` from the fake is the launch-day answer. */
  readonly profile: Pick<BusinessProfileProvider, 'listReviews' | 'updateReply'>
  /**
   * The per-profile limiter, shared with the Business Information hours write.
   *
   * Required, not optional. An optional limiter is a limiter every caller may omit, and the cap Google
   * states cannot be raised is not a thing a call site should be able to opt out of.
   */
  readonly limit: PerProfileRateLimit
  /** The capability row's `resource_ref`, as stored. Parsed on every call; see the header. */
  readonly resourceRef: Readonly<Record<string, unknown>> | null
}

/** The limiter a caller with none of its own gets. One per profile — see the rate-limit module. */
export function reviewsV4Limit(clock: RateLimitClock): PerProfileRateLimit {
  return reviewReplyLimit(clock)
}

/**
 * Lists the reviews on the stored listing, for a first sync.
 *
 * The path is asserted before the call, so a `v1`-shaped ref spends no quota discovering what the parser
 * already knows.
 */
export async function listReviewsV4(deps: ReviewsV4Deps): Promise<readonly Review[]> {
  const url = reviewsV4ListUrl(deps.resourceRef)
  return await deps.profile.listReviews(url)
}

/**
 * The API-mode submitter `deliverApprovedReply` is handed, or nothing at all.
 *
 * It implements G-REV-05's `ReplySubmitter` and is reached **only after a clean lint** — that function
 * builds its linter from the database and cannot be handed a permissive one, so there is no path from
 * here to a published reply that has not been judged (ADR 0063). This module therefore does not lint, and
 * deliberately holds nothing that could: a second judgement on the send path is the injectable-linter
 * shape ADR 0063 refuses.
 *
 * It appends no signature. The bytes it receives are the bytes a human approved, rendered by
 * `renderFinalReply` with whatever signature the approval carried — `null` today, because
 * `Y9-reply-signature` is unanswered.
 */
export function createReviewsV4Submitter(deps: ReviewsV4Deps): ReplySubmitter {
  // Parsed at CONSTRUCTION as well as per call, so a misconfigured capability row is a loud failure when
  // the submitter is wired rather than at 03:00 on the first reply. The per-call parse stays, because the
  // row can be re-pointed between the wiring and the call.
  parseGbpResourceRef(deps.resourceRef)
  return {
    async submit({ review, reply }) {
      // Both refusals before the limiter, so a row that can never be delivered does not consume a slot
      // from the ten-a-minute budget the whole profile shares.
      const googleReviewId = googleIdOrRefuse(review)
      const url = reviewsV4ReplyUrl(deps.resourceRef, googleReviewId)
      await deps.limit.run(async () => {
        await deps.profile.updateReply({
          // The v4 reply URL, which on this API carries the account, the location and the review. The
          // port's parameter is named `locationId` because v1 identifies a location that way; what it
          // actually is, is the resource this call addresses.
          locationId: url,
          reviewId: googleReviewId,
          comment: reply,
        })
      })
    },
  }
}
