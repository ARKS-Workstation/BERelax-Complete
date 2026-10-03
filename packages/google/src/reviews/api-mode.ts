import type { Actor, QueuedReview, Sql } from '@berelax/db'
import { getReview } from '@berelax/db'
// Subpath import, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type { BusinessProfileProvider } from '@berelax/providers/google'
import type { DetectableReviewLanguage } from '@berelax/shared'
import { AppError } from '@berelax/shared'
import { createReviewsV4Submitter } from '../adapters/reviews-v4.ts'
import type { DegradedMode } from '../consumers.ts'
import type { PerProfileRateLimit } from '../rate-limit/token-bucket.ts'
import type { DegradationCause, WithGoogleDeps } from '../with-google.ts'
import { withGoogle } from '../with-google.ts'
import {
  deliverApprovedReply,
  type ReplyDelivered,
  replyDeliveryRefusalRulesOf,
} from './deliver.ts'

/**
 * Which path a reply goes out by, read off the ROW. The flip is a row change, not a deploy.
 *
 * docs/10 §6 ends on it: *"switching to API mode is a row in the capability table, not a deploy."* This is
 * the module that makes that true rather than aspirational — the one place in this build that reads
 * `google_reviews.delivery_mode` and selects a path from it. Everything either side is already shared:
 * `deliverApprovedReply` is the single send path and lints identically in both modes (ADR 0063), and
 * `createReviewsV4Submitter` is the quarantined adapter the api arm hands it.
 *
 * There is deliberately no configuration here and no feature flag. A flag would be a second answer to
 * which mode a reply goes out in, and the row is the one that the `google_reviews_delivery_fields_match_mode`
 * constraint already holds the timestamps against.
 *
 * ## Why the API call is INSIDE the chokepoint, and the lint refusal is not
 *
 * `withGoogle` is what turns an upstream failure into a declared degradation: `quota_exhausted` and
 * `access_not_granted` both degrade `gbp_reviews` to `draft_only`, append a `health_check_failed`
 * connection event the owner's dashboard reads, update the capability health, and **return rather than
 * throw** (docs/10 §6: the fallback is the launch mode, not an error state). The transport call therefore
 * has to be inside the body, which means `deliverApprovedReply` is inside it too — lint and delivery are
 * one call by design, because an exported "lint this reply" would be an injectable linter with extra
 * steps.
 *
 * A **lint refusal is not an upstream failure** and must not be classified as one. `classifyGoogleError`
 * would file a refused reply as `TransientUpstream`, which does not degrade, so the caller would get a
 * Google error naming a correlation id instead of the rule the owner has to fix. So the body catches
 * exactly that case and returns it as a VALUE; anything else is re-thrown for `withGoogle` to classify.
 * The discrimination is by {@link replyDeliveryRefusalRulesOf}, which answers null for every other error.
 *
 * ## No signature, and it is deferred rather than decided
 *
 * `signature: null`, always, and `OPEN-QUESTIONS Y9-reply-signature` is why: nobody has said what this
 * business signs its replies with, or whether it wants one at all. The mechanism exists —
 * `deliverApprovedReply` takes `string | null` and the 1,200-character cap is measured over the rendered
 * total — so what is missing is the setting, not the code. A plausible sign-off invented here would be
 * indistinguishable from a configured one and would be published under the owner's name on an indexed
 * page (the brief's rule 15). G-REV-06's settings card is where it arrives, and ADR 0063 records the
 * consequence that card meets: a signature is linted like the rest of the reply.
 */

export type StoredModeOutcome =
  /** It went out, by whichever path the row named. */
  | { readonly kind: 'delivered'; readonly delivered: ReplyDelivered }
  /** The linter refused it. Every rule, by name, for the approval queue to show. */
  | { readonly kind: 'refused'; readonly rules: readonly string[] }
  /**
   * Google was unavailable to this capability, so nothing was submitted and nothing threw.
   *
   * `mode` is the DECLARED degraded mode from `../consumers.ts` — `draft_only` for the autoresponder —
   * and not a decision taken here. A consumer that chose its own would be a second answer to what happens
   * when Google stops, and the one nobody updates is the one in production.
   */
  | {
      readonly kind: 'degraded'
      readonly mode: DegradedMode
      readonly cause: DegradationCause
      readonly correlationId: string
    }

export interface StoredModeDeps {
  readonly sql: Sql
  /** Who the delivery is attributed to. The person who approved it, never the agent. */
  readonly actor: Actor
  /** The chokepoint's dependencies. Used only on the api arm, where a token is needed. */
  readonly google: WithGoogleDeps
  readonly profile: Pick<BusinessProfileProvider, 'listReviews' | 'updateReply'>
  /** The per-profile limiter, shared with the Business Information hours write. Required. */
  readonly limit: PerProfileRateLimit
}

export interface StoredModeInput {
  readonly reviewId: string
  /** The reply a human approved, which may not be the machine's draft. */
  readonly approvedReply: string
  readonly language: DetectableReviewLanguage
}

/**
 * Delivers one approved reply by the path the row names.
 *
 * `manual` makes no Google call at all, so it does not go through `withGoogle`: there is no token to
 * refresh and nothing to degrade, and wrapping it would report a reply the owner pasted by hand as a
 * degraded API call. That asymmetry is the feature — it is what makes fallback mode work with no Google
 * connection whatsoever.
 */
export async function deliverInStoredMode(
  deps: StoredModeDeps,
  input: StoredModeInput,
): Promise<StoredModeOutcome> {
  const review: QueuedReview | undefined = await getReview(deps.sql, input.reviewId)
  if (review === undefined) {
    throw new AppError('not_found', `No review ${input.reviewId}`)
  }

  if (review.deliveryMode === 'manual') {
    try {
      return {
        kind: 'delivered',
        delivered: await deliverApprovedReply(
          { sql: deps.sql, actor: deps.actor, signature: null, submitter: null },
          {
            reviewId: input.reviewId,
            approvedReply: input.approvedReply,
            language: input.language,
            mode: 'manual',
          },
        ),
      }
    } catch (error) {
      const rules = replyDeliveryRefusalRulesOf(error)
      if (rules === null) throw error
      return { kind: 'refused', rules }
    }
  }

  const outcome = await withGoogle(deps.google, 'gbp_reviews', async (context) => {
    // The submitter is built from the CAPABILITY ROW's resource_ref, inside the call, so a row re-pointed
    // between two replies takes effect on the next one. A ref with no accountId refuses here, before the
    // transport, naming the missing part.
    const submitter = createReviewsV4Submitter({
      profile: deps.profile,
      limit: deps.limit,
      resourceRef: context.resourceRef,
    })
    try {
      return {
        kind: 'delivered' as const,
        delivered: await deliverApprovedReply(
          { sql: deps.sql, actor: deps.actor, signature: null, submitter },
          {
            reviewId: input.reviewId,
            approvedReply: input.approvedReply,
            language: input.language,
            mode: 'api',
          },
        ),
      }
    } catch (error) {
      const rules = replyDeliveryRefusalRulesOf(error)
      // A lint refusal is about the WORDS and is not evidence of anything about the connection. Letting
      // it reach `classifyGoogleError` would file it as `TransientUpstream` — which does not degrade — so
      // the owner would be shown a correlation id instead of the rule they have to fix.
      if (rules === null) throw error
      return { kind: 'refused' as const, rules }
    }
  })

  if (outcome.kind === 'degraded') {
    return {
      kind: 'degraded',
      mode: outcome.mode,
      cause: outcome.cause,
      correlationId: outcome.correlationId,
    }
  }
  return outcome.value
}
