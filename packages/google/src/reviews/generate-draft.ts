import {
  assembleReplyDraft,
  buildReviewReplyPrompt,
  detectReviewLanguage,
  isHouseReplyRendering,
  languageIsConfigured,
  type ModelResponseRefusal,
  type ReplyLinter,
  type ReplySkeletonId,
  type ReviewReplyPrompt,
  skeletonForReview,
} from '@berelax/core'
import {
  type Actor,
  listUndraftedReviews,
  type QueuedReview,
  recordDraftQuarantine,
  recordReplyDraft,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { costOfFils, type LlmProvider } from '@berelax/providers/llm'
import { AppError, type DetectableReviewLanguage } from '@berelax/shared'

/**
 * The reply generator: the I/O half of G-REV-04.
 *
 * ## What is here and what is deliberately not
 *
 * Everything that decides anything is in `packages/core`: the skeletons, the prompt, the screen that
 * judges the model's answer, and the linter contract. This module reads rows, calls a provider, charges a
 * budget and writes rows. That split is not tidiness — it is what lets the whole injection defence be
 * tested as pure functions over 200 adversarial strings without a database or a provider, and it is why
 * there is no branch in this file that could produce different reply bytes.
 *
 * ## The clinical boundary is a dependency rule, not a habit
 *
 * `.dependency-cruiser.cjs` carries `reviews-generator-must-not-reach-clinical-data`, which forbids this
 * directory and `packages/core/src/reviews/` from importing `@berelax/clinical` or any intake repository.
 * It is a rule rather than a convention because the mistake is so natural: a treatment note or an intake
 * answer is exactly the "context" somebody would reach for to make a reply more personal, and F08 built
 * the boundary that makes that impossible. Note what this file does NOT read even from the review row —
 * the reviewer's display name never reaches the prompt, because docs/07 §4 forbids confirming that a
 * named reviewer was a client and the cheapest guarantee is that the model is never told the name.
 *
 * ## Determinism
 *
 * `generatedAtIso` is written by the database's `now()`, so nothing time-varying reaches the **draft
 * bytes**: the draft is a rendering of (skeleton, aspects, language) and the aspects come from a fake that
 * hashes the prompt. Three runs against the deterministic fake therefore produce byte-identical drafts,
 * which is what makes the approval queue's screenshots diffable — and it is why a timestamp or a random id
 * inside a draft would be a defect rather than a detail.
 *
 * ## The caps
 *
 * Both halves of G-AGT-01's per-run cap are applied here, and they are different things:
 *
 *   - the **token** cap is `maxOutputTokens` on each request, which bounds one call;
 *   - the **cost** cap is `charge`, the callback `withAgentRun` hands a job body, which bounds the run.
 *     `charge` throws `BudgetExceeded`, and this module deliberately does not catch it: the throw is what
 *     makes `withAgentRun` record the run as `budget_exceeded` with the partial cost in integer fils and
 *     leave `last_success_at` alone, so the watchdog reports the agent silent rather than the run
 *     reporting success on a partial result.
 */

/** Why no machine draft exists, beyond the model-response refusals the screen names. */
export const DRAFT_DECLINED_REASONS = [
  'no_skeleton_for_this_review',
  'reply_language_not_configured',
  'model_refused_to_answer',
  'draft_rejected_by_linter',
] as const
export type DraftDeclinedReason = (typeof DRAFT_DECLINED_REASONS)[number]

/** Everything written into `google_reviews.draft_quarantine_reason`, in one closed vocabulary. */
export type NoDraftReason = ModelResponseRefusal | DraftDeclinedReason

/** What happened to one review. Returned so a test and an operator's log see the same thing. */
export type ReviewDraftOutcome =
  | {
      readonly reviewId: string
      readonly kind: 'drafted'
      readonly draft: string
      readonly skeleton: ReplySkeletonId
      readonly costFils: number
    }
  | {
      readonly reviewId: string
      readonly kind: 'no_draft'
      readonly reason: NoDraftReason
      readonly costFils: number
    }
  /** The row already carried a draft or a decision. A replayed run reaches this and writes nothing. */
  | { readonly reviewId: string; readonly kind: 'already_decided'; readonly costFils: 0 }

export interface DraftRunSummary {
  readonly outcomes: readonly ReviewDraftOutcome[]
  readonly costFils: number
  /** Tokens spent across the run, for the monthly budget console. */
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface GenerateDraftsDeps {
  readonly sql: Sql
  /** Who the audit rows are attributed to. The agent, not a person. */
  readonly actor: Actor
  /** The adapter the `agents.llm_provider` setting selected. Never constructed here. */
  readonly llm: LlmProvider
  /** The linter every draft must pass before it is written. No default: see `reply-lint-contract.ts`. */
  readonly linter: ReplyLinter
  /** `withAgentRun`'s budget callback. Throws `BudgetExceeded`, which this module lets through. */
  readonly charge: (fils: number) => void
  /** The per-call token cap. */
  readonly maxOutputTokens: number
  /** `agents.review_reply_languages`, already normalised by the caller through the shared floor. */
  readonly configuredLanguages: readonly DetectableReviewLanguage[]
  /**
   * The language a review with NO text is answered in.
   *
   * An argument rather than a default, because a star-only review has no language to detect and guessing
   * one here would be a policy decision hidden in a generator. The caller resolves it from the configured
   * set.
   */
  readonly starOnlyReplyLanguage: DetectableReviewLanguage
}

/** Which language this review is answered in, or `null` when none is configured for it. */
function replyLanguageFor(
  review: QueuedReview,
  deps: GenerateDraftsDeps,
): DetectableReviewLanguage | null {
  if (review.comment === null || review.comment.trim().length === 0) {
    return deps.configuredLanguages.includes(deps.starOnlyReplyLanguage)
      ? deps.starOnlyReplyLanguage
      : null
  }
  const detected = detectReviewLanguage(review.comment)
  if (!languageIsConfigured(detected, deps.configuredLanguages)) return null
  // `languageIsConfigured` is false for 'unknown' by construction, so the cast is safe and the narrowing
  // is the shared floor's job rather than this module's.
  return detected as DetectableReviewLanguage
}

/**
 * Asks the model for a selection. Charges the run and returns the raw answer, or `null` on a refusal.
 *
 * The idempotency key is the prompt fingerprint plus the review id, so a replayed run inside one process
 * reuses the provider's cached answer and does not spend the budget twice — and a review whose text has
 * changed gets a different key, because it is a different question.
 */
async function askForSelection(
  deps: GenerateDraftsDeps,
  review: QueuedReview,
  prompt: ReviewReplyPrompt,
  language: DetectableReviewLanguage,
): Promise<{
  readonly response: string | null
  readonly costFils: number
  readonly inputTokens: number
  readonly outputTokens: number
}> {
  const outcome = await deps.llm.complete({
    purpose: 'review_reply',
    prompt: prompt.text,
    locale: language,
    maxOutputTokens: deps.maxOutputTokens,
    idempotencyKey: `review-draft:${review.id}:${prompt.fingerprint}`,
  })
  const costFils = costOfFils(outcome.usage, deps.llm.pricing)
  // Charged whichever way the call went. A refusal costs input tokens, and a run that only charged for
  // the answers it liked would under-report exactly the reviews that caused the most calls.
  deps.charge(costFils)
  return {
    response: outcome.kind === 'completion' ? outcome.text : null,
    costFils,
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
  }
}

/**
 * Drafts replies for every routed review that has neither a draft nor a decision.
 *
 * Oldest first (see `listUndraftedReviews`): the oldest undrafted review is the one closest to its
 * cooling-off window closing, and a newest-first job starves the tail of the queue the first time it falls
 * behind.
 */
export async function generateReplyDrafts(
  deps: GenerateDraftsDeps,
  scope: { readonly connectionId: string; readonly limit?: number },
): Promise<DraftRunSummary> {
  const reviews = await listUndraftedReviews(deps.sql, scope)
  const outcomes: ReviewDraftOutcome[] = []
  let costFils = 0
  let inputTokens = 0
  let outputTokens = 0

  for (const review of reviews) {
    const result = await draftOne(deps, review)
    outcomes.push(result.outcome)
    costFils += result.outcome.costFils
    inputTokens += result.inputTokens
    outputTokens += result.outputTokens
  }

  return { outcomes, costFils, inputTokens, outputTokens }
}

/** One review, end to end. Exported so a caller can draft a single row from the admin screen. */
export async function draftOne(
  deps: GenerateDraftsDeps,
  review: QueuedReview,
): Promise<{
  readonly outcome: ReviewDraftOutcome
  readonly inputTokens: number
  readonly outputTokens: number
}> {
  const noDraft = async (
    reason: NoDraftReason,
    spent: number,
    tokens: { input: number; output: number },
  ) => {
    const written = await withUnitOfWork(deps.sql, deps.actor, (uow) =>
      recordDraftQuarantine(uow, review.id, reason),
    )
    return {
      outcome:
        written === 'quarantined'
          ? ({ reviewId: review.id, kind: 'no_draft', reason, costFils: spent } as const)
          : ({ reviewId: review.id, kind: 'already_decided', costFils: 0 } as const),
      inputTokens: tokens.input,
      outputTokens: tokens.output,
    }
  }

  const language = replyLanguageFor(review, deps)
  if (language === null) {
    return noDraft('reply_language_not_configured', 0, { input: 0, output: 0 })
  }

  const hasText = review.comment !== null && review.comment.trim().length > 0
  const skeleton = skeletonForReview({ rating: review.rating, hasText })
  if (skeleton === null) {
    return noDraft('no_skeleton_for_this_review', 0, { input: 0, output: 0 })
  }

  const prompt = buildReviewReplyPrompt({
    rating: review.rating,
    commentText: review.comment,
    language,
    skeleton,
  })

  // A star-only review asks the model nothing: there is no text to select from, so the call would spend
  // budget to answer a question with no input — and it is why that path has no untrusted input at all.
  const asked = hasText
    ? await askForSelection(deps, review, prompt, language)
    : { response: null, costFils: 0, inputTokens: 0, outputTokens: 0 }
  const tokens = { input: asked.inputTokens, output: asked.outputTokens }

  if (hasText && asked.response === null) {
    return noDraft('model_refused_to_answer', asked.costFils, tokens)
  }

  const assembled = assembleReplyDraft({
    rating: review.rating,
    commentText: review.comment,
    language,
    prompt,
    response: asked.response,
  })
  if (assembled.kind === 'quarantined') {
    return noDraft(assembled.refusal, asked.costFils, tokens)
  }
  if (assembled.kind === 'declined') {
    // Unreachable with the check above, and handled rather than narrowed away on purpose: a `declined`
    // outcome this function did not anticipate must not fall through to the write, and an exhaustive
    // branch is how that stays true when `assembleReplyDraft` grows a second reason.
    return noDraft('no_skeleton_for_this_review', asked.costFils, tokens)
  }

  // The linter, on the write path, with no way round it: this function is the only thing that writes
  // `reply_draft_skeleton_id`, and it does not write without a clean lint.
  const findings = deps.linter.lint({
    draft: assembled.draft,
    language,
    reviewText: review.comment,
  })
  if (findings.length > 0) {
    return noDraft('draft_rejected_by_linter', asked.costFils, tokens)
  }

  // The second application, in the shape `autoSendFloor` uses: the generator can only produce a house
  // rendering, so this can fail only if the generator is broken — which is exactly when nothing should be
  // written. A throw reaches `withAgentRun` and the run is recorded as failed.
  if (!isHouseReplyRendering(assembled.draft, language)) {
    throw new AppError(
      'invariant_violated',
      `The draft for review ${review.id} is not a rendering of any house skeleton, so it was not ` +
        'written. Nothing but renderReplySkeleton may produce a published reply.',
      { details: { reviewId: review.id, skeleton } },
    )
  }

  const written = await withUnitOfWork(deps.sql, deps.actor, (uow) =>
    recordReplyDraft(uow, review.id, {
      draft: assembled.draft,
      skeletonId: assembled.provenance.skeleton,
      aspects: assembled.provenance.aspects,
      language: assembled.provenance.language,
      promptVersion: assembled.provenance.promptVersion,
      promptFingerprint: assembled.provenance.promptFingerprint,
      lintVersion: deps.linter.version,
    }),
  )

  return {
    outcome:
      written === 'drafted'
        ? ({
            reviewId: review.id,
            kind: 'drafted',
            draft: assembled.draft,
            skeleton: assembled.provenance.skeleton,
            costFils: asked.costFils,
          } as const)
        : ({ reviewId: review.id, kind: 'already_decided', costFils: 0 } as const),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
  }
}
