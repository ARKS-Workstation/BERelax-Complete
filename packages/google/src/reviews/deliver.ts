import { createHash } from 'node:crypto'
import {
  detectReviewLanguage,
  REVIEW_ESCALATION_LEXICON,
  type ReplyLintContext,
  type ReplyLintFinding,
  renderFinalReply,
  replyLinterFor,
  sendPathReplyLinter,
} from '@berelax/core'
import {
  type Actor,
  getReview,
  listStaffDisplayNames,
  type QueuedReview,
  type ReplyLintStamp,
  readCompliancePolicy,
  recordReplyApproved,
  recordReplyPostedManually,
  recordReplySubmittedToApi,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { AppError, type DetectableReviewLanguage } from '@berelax/shared'

/**
 * The send path: the one way a reply becomes public, in either delivery mode (G-REV-05).
 *
 * docs/10 §6 gives the requirement as a single clause — *"the reply path is identical in both modes"*, with
 * the linter on it — and the manifest gives the claim that has to be proved rather than asserted: *"it sits
 * on the send path, so a caller cannot route around it."* Three things here make that true, and they fail
 * independently, which is the point:
 *
 *   1. **The linter is not injectable.** `deliverApprovedReply` builds it from the database itself — the
 *      profile in force, the staff roster as it is now, the escalation lexicon. A delivery function that
 *      took a `ReplyLinter` argument would be a chokepoint a caller walks past by handing it a permissive
 *      one, which is the bypass the acceptance criterion is about. There is no argument here that can
 *      change a verdict.
 *   2. **The repository writers demand a stamp.** `recordReplySubmittedToApi` and
 *      `recordReplyPostedManually` take `ReplyLintStamp` as a required argument (0113), so a caller who
 *      skips this module cannot reach either timestamp without producing one — and cannot produce one,
 *      because `packages/db` may not import `packages/core` and therefore holds nothing that can lint.
 *   3. **The database refuses the rest.** `google_reviews_delivery_needs_a_lint_pass` refuses
 *      `submitted_at` or `posted_manually_at` on a row with no `reply_lint_version`, which is what holds
 *      when somebody writes the UPDATE by hand.
 *
 * ## What the three mechanisms do NOT stop, stated rather than implied
 *
 * They make a delivery with NO stamp unreachable. They cannot make a FABRICATED one unreachable: the stamp
 * is a plain object, so a caller inside `packages/google` could compose one and call the repository writer
 * itself, and no CHECK can tell a real lint pass from an invented one — the database cannot lint.
 *
 * What closes that is {@link reproduceReplyLint}, which re-runs the stored rule set over the stored text and
 * reports the findings. A fabricated stamp is therefore detectable rather than prevented, and that is the
 * honest limit of the claim: the floor stops the accident (a new caller that forgot), and the reproduction
 * catches the fabrication (a caller that lied).
 *
 * ## The order of operations, and why the API submitter is last
 *
 * The lint runs before anything leaves the process. In API mode the submitter is reached only after a clean
 * lint, so a refused reply produces **zero** transport calls — asserted with a spy rather than reasoned
 * about, because "the network call is after the check" is the kind of claim a refactor silently reverses.
 *
 * The submitter is an injected port and not a Business Profile client. G-REV-07 owns that adapter, its
 * `accountId` path and its 6/min token bucket, and it is `todo`; building half of it here would be a second
 * place where the v4 host string lives, which is exactly what that unit's dependency rule forbids. What
 * this unit owns is that nothing reaches the port unlinted.
 *
 * ## What it does NOT do
 *
 * It does not approve. Mandatory human approval is docs/10 §6's own step and G-REV-06's screen; this
 * function is what that screen calls, and it takes the approved text as an argument precisely so that the
 * text an owner edited is the text that is judged. It does not decide the signature either — see
 * {@link ReplyDeliveryDeps.signature}.
 */

/**
 * The two delivery modes, taken off the row's own type rather than re-imported.
 *
 * `google_reviews.delivery_mode` is the authority (docs/10 §6 made it a column so the two sets of
 * timestamps could coexist), and `QueuedReview` already carries it. Spelling `'api' | 'manual'` again here
 * would be a third statement of a two-element set.
 */
export type ReplyDeliveryMode = QueuedReview['deliveryMode']

/** The API-mode submitter. Never reached before a clean lint; see the header. */
export interface ReplySubmitter {
  submit(input: {
    readonly review: QueuedReview
    /** The exact bytes to publish, signature included. */
    readonly reply: string
  }): Promise<void>
}

export interface ReplyDeliveryDeps {
  readonly sql: Sql
  /** Who the audit row is attributed to. The person who approved it, never the agent. */
  readonly actor: Actor
  /**
   * The signature appended to every reply before it is measured and judged, or `null` for none.
   *
   * An argument rather than a setting because nobody has said what this business signs its replies with.
   * `OPEN-QUESTIONS Y9-reply-signature` records the figure; the mechanism is built and the cap is measured
   * over it, which is what the acceptance criterion asks for. G-REV-06 owns the card that supplies it.
   */
  readonly signature: string | null
  /** Required in `api` mode and `null` in `manual` mode, so neither is the default. */
  readonly submitter: ReplySubmitter | null
}

export interface ReplyDeliveryInput {
  readonly reviewId: string
  /**
   * The reply a human approved, which may not be the machine's draft.
   *
   * Taken as an argument rather than read from `reply_draft`, because an owner edits the draft before
   * approving it (docs/10 §6) and the bytes that are judged have to be the bytes that go out. The stored
   * draft is the machine's sentence; this is the reply.
   */
  readonly approvedReply: string
  /**
   * The language the approver says the reply is in.
   *
   * Explicit, because the linter checks it from BOTH sides — the reply must be in the language it claims,
   * and, when the review has one this build can identify, it must be that language. A declaration is
   * therefore not a way round the rule: claiming `ar` over English text fails the first half and claiming
   * `en` over an Arabic review fails the second.
   */
  readonly language: DetectableReviewLanguage
  readonly mode: ReplyDeliveryMode
}

export interface ReplyDelivered {
  readonly reviewId: string
  readonly mode: ReplyDeliveryMode
  /** The exact bytes delivered and stored, signature included. */
  readonly reply: string
  readonly lintVersion: string
  readonly contentSha256: string
}

/**
 * Raised instead of delivering. Carries every rule, by name.
 *
 * `details.rules` rather than the sentence, for the reason `PublicationCopyRefused` gives: a reworded
 * message must not be a reworded rule, and the approval queue reads the rule names to tell the owner which
 * edits to make. Every reason rather than the first, so two problems are one round trip.
 */
export class ReplyDeliveryRefused extends AppError {
  readonly code = 'reply_delivery_refused' as const
  readonly findings: readonly ReplyLintFinding[]
  constructor(reviewId: string, mode: ReplyDeliveryMode, findings: readonly ReplyLintFinding[]) {
    super(
      'validation',
      `The reply to review ${reviewId} cannot be published (${mode} delivery): ` +
        findings.map((finding) => `${finding.rule} — ${finding.why}`).join('; '),
      {
        userFacing: true,
        details: {
          code: 'reply_delivery_refused',
          reviewId,
          mode,
          rules: findings.map((finding) => finding.rule),
        },
      },
    )
    this.name = 'ReplyDeliveryRefused'
    this.findings = Object.freeze([...findings])
  }
}

/** The rules a refusal carries, or null — so a caller branches without matching on a message. */
export function replyDeliveryRefusalRulesOf(error: unknown): readonly string[] | null {
  return error instanceof ReplyDeliveryRefused
    ? error.findings.map((finding) => finding.rule)
    : null
}

/** sha256 over the delivered bytes, lower-case hex. UTF-8, so the digest is over what Google receives. */
export function replyContentSha256(reply: string): string {
  return createHash('sha256').update(reply, 'utf8').digest('hex')
}

/**
 * The lint context as it is right now: the profile in force and the roster as it stands.
 *
 * Read on every delivery and never cached. The roster read is the acceptance criterion — adding a therapist
 * changes the answer with no code change — and a cache is the one thing that would make that false for as
 * long as the cache lived.
 *
 * Exported because the reproduction path needs the same context to re-run a stored decision against, and
 * because `packages/core`'s `CompliancePolicy` and `packages/db`'s `CompliancePolicyRow` are deliberately
 * different types (ADR 0001): this is the one field copy between them on this path, rather than one per
 * caller.
 */
export async function readReplyLintContext(sql: Sql): Promise<ReplyLintContext> {
  const [policy, rosterDisplayNames] = await Promise.all([
    readCompliancePolicy(sql),
    listStaffDisplayNames(sql),
  ])
  return {
    policy: {
      bannedClaimTerms: policy.bannedClaimTerms,
      permittedPublicTitles: policy.permittedPublicTitles,
      medicalClaimsPermitted: policy.medicalClaimsPermitted,
    },
    rosterDisplayNames,
    lexicon: REVIEW_ESCALATION_LEXICON,
  }
}

/**
 * Lints an approved reply and delivers it, or refuses.
 *
 * Both delivery modes go through this function and through the same linter; the only thing `mode` selects
 * is which timestamp the row ends up carrying and whether the API submitter is called. That is the whole of
 * docs/10 §6's "the reply path is identical in both modes", and it is asserted from the refusing side —
 * `reply-delivery.itest.ts` drives a known-bad reply through BOTH modes and asserts the same rule name, no
 * timestamp and no transport call.
 */
/**
 * The lint, and the stamp it produces. The ONE expression on this path that judges a reply.
 *
 * Extracted by G-REV-06, which needed the same judgement at a second moment — *approval*, which docs/10 §6
 * names as its own step before the owner has pasted anything anywhere — and extracted rather than
 * re-written for the reason ADR 0063 exists: a second construction of `sendPathReplyLinter` would be a
 * second place that decides what `origin` to pass and which context to read, and the day they disagreed
 * the lenient one would be whichever the approval screen called. There is still exactly one `lint(` call
 * on the send path, and {@link deliverApprovedReply} and {@link approveReply} both go through it.
 *
 * It is NOT exported. An exported "lint this reply" function is an injectable linter with extra steps: a
 * caller could lint, ignore the answer and reach a repository writer with a stamp of its own. Both public
 * entry points below lint and write in the same call, which is what keeps the chokepoint a chokepoint.
 */
async function lintOrRefuse(
  deps: Pick<ReplyDeliveryDeps, 'sql' | 'signature'>,
  review: QueuedReview,
  input: {
    readonly approvedReply: string
    readonly language: DetectableReviewLanguage
    readonly mode: ReplyDeliveryMode
  },
): Promise<ReplyLintStamp> {
  const context = await readReplyLintContext(deps.sql)
  const linter = sendPathReplyLinter(context)
  const findings = linter.lint({
    draft: input.approvedReply,
    language: input.language,
    reviewText: review.comment,
    reviewerDisplayName: review.reviewerDisplayName,
    signature: deps.signature,
    // A human approved this and may have edited it, so the house-rendering rule does not apply — every
    // rule about what the sentence SAYS still does. See `ReplyOrigin`.
    origin: 'approved_by_a_human',
  })
  if (findings.length > 0) {
    throw new ReplyDeliveryRefused(review.id, input.mode, findings)
  }
  const reply = renderFinalReply({ draft: input.approvedReply, signature: deps.signature })
  return {
    approvedText: reply,
    lintVersion: linter.version,
    contentSha256: replyContentSha256(reply),
  }
}

/** What an owner approving a reply needs back: the bytes to copy, and the stamp they were judged under. */
export interface ReplyApproved {
  readonly reviewId: string
  /** The exact bytes stored as `reply_approved_text`, signature included. What *Copy reply* copies. */
  readonly reply: string
  readonly lintVersion: string
  readonly contentSha256: string
}

/**
 * A human approves a reply. Nothing becomes public, and nothing can without this having happened.
 *
 * docs/10 §6 gives the fallback path as four steps — *the same linter runs → **mandatory human approval**
 * → owner sees the draft with Copy reply and a deep link → posts → clicks Marked as posted* — and the
 * reason approval is a write rather than a flag on the next request is the Copy reply control. **Copy reply
 * is a send path**: the bytes it puts on a clipboard leave this system and are published under the
 * business's name, so a reply that reached a clipboard unlinted would defeat G-REV-05 entirely while every
 * assertion about `deliverApprovedReply` went on passing.
 *
 * So the lint happens here, through {@link lintOrRefuse} — the same expression, the same context, the same
 * `origin` — and the linted bytes are stored by `recordReplyApproved` before any screen can offer them.
 * *Copy reply* then serves `reply_approved_text`, which is a column nothing can write without having
 * passed through this function: `ReplyLintStamp` is a required argument of every stamp writer and
 * `packages/db` may not import `packages/core` (ADR 0001), so the write layer holds nothing that could
 * produce one.
 *
 * It takes the approved text as an ARGUMENT rather than reading `reply_draft`, which is G-REV-05's
 * decision restated: an owner edits the draft before approving it, and the bytes that are judged have to
 * be the bytes that go out. A hand-edited draft carrying a banned claim is therefore refused HERE, by the
 * server, with every rule named — not merely disabled in a client.
 *
 * No delivery timestamp is written and no `delivery_mode`, so nothing about this says the reply is public.
 * The mode is read off the row only so that a refusal names the mode the reply would have gone out in.
 */
export async function approveReply(
  deps: Pick<ReplyDeliveryDeps, 'sql' | 'actor' | 'signature'>,
  input: {
    readonly reviewId: string
    readonly approvedReply: string
    readonly language: DetectableReviewLanguage
  },
): Promise<ReplyApproved> {
  const review = await getReview(deps.sql, input.reviewId)
  if (review === undefined) {
    throw new AppError('not_found', `No review ${input.reviewId}`)
  }
  const stamp = await lintOrRefuse(deps, review, {
    approvedReply: input.approvedReply,
    language: input.language,
    mode: review.deliveryMode,
  })
  await withUnitOfWork(deps.sql, deps.actor, (uow) =>
    recordReplyApproved(uow, input.reviewId, stamp),
  )
  return {
    reviewId: input.reviewId,
    reply: stamp.approvedText,
    lintVersion: stamp.lintVersion,
    contentSha256: stamp.contentSha256,
  }
}

/**
 * A named human says they have pasted the approved reply into Google (G-REV-06, docs/10 §6).
 *
 * The last step of fallback mode, and the one that is **a claim about the outside world rather than an
 * observation of it**. There is no Business Profile API access (docs/10 §4, OPEN-QUESTIONS Y3-gbp-api), so nothing here has seen the
 * reply on the listing: `posted_manually_at` records that somebody said they posted it. Migration 0128's
 * ZY341 refuses the write unless an `audit_event` in the same transaction attributes the claim to a staff
 * actor with a real id, which is what makes *who said so* answerable.
 *
 * It re-lints, and that is not belt and braces. Between approval and this call the row sits with
 * `reply_approved_text` written and no delivery timestamp — a state 0128 deliberately leaves editable, so
 * an owner can change their mind — and the regulatory profile or the staff roster may also have moved
 * (both are live rows, which `SEND_PATH_LINT_VERSION` records that it does not pin). So the bytes that
 * become a delivery are judged again, by the same expression, at the moment of delivery. A reply that has
 * stopped being publishable is refused with its rules named rather than posted because it once passed.
 *
 * `signature: null`, always, and the reason is {@link reproduceReplyLint}'s: the stored text ALREADY
 * includes the signature it was approved with, so appending one again would measure and store a reply that
 * was never approved.
 *
 * The language is read back off the stored text rather than taken as an argument, for the same reason: the
 * caller at this point is a button, not an author, and `detectReviewLanguage` is what the rule compares
 * against anyway. Text whose language cannot be identified is refused by name rather than guessed at.
 */
export async function markReplyPostedManually(
  deps: Pick<ReplyDeliveryDeps, 'sql' | 'actor'>,
  reviewId: string,
): Promise<ReplyDelivered> {
  const review = await getReview(deps.sql, reviewId)
  if (review === undefined) throw new AppError('not_found', `No review ${reviewId}`)
  const approved = review.replyApprovedText
  if (approved === null) {
    throw new AppError(
      'invariant_violated',
      `Review ${reviewId} has no approved reply, so there is nothing a person could have pasted into ` +
        'Google. docs/10 §6 makes human approval mandatory and it is the step that produces the bytes ' +
        '*Copy reply* copies — marking a review posted before one exists would record a claim about a ' +
        'reply nobody has read.',
      { userFacing: true },
    )
  }
  const language = detectReviewLanguage(approved)
  if (language === 'unknown') {
    // The same conclusion `reproduceReplyLint` reaches, and for the same reason: a reply whose language
    // cannot be identified is one no declaration could have made pass, so it is refused by the rule's own
    // name rather than delivered under a guess.
    throw new ReplyDeliveryRefused(reviewId, 'manual', [
      {
        rule: 'language_mismatch',
        why:
          'the approved reply is in no language this build can identify, so the rule that a reply must ' +
          'match the review’s language cannot be applied to it',
      },
    ])
  }
  return await deliverApprovedReply(
    { sql: deps.sql, actor: deps.actor, signature: null, submitter: null },
    { reviewId, approvedReply: approved, language, mode: 'manual' },
  )
}

export async function deliverApprovedReply(
  deps: ReplyDeliveryDeps,
  input: ReplyDeliveryInput,
): Promise<ReplyDelivered> {
  const review = await getReview(deps.sql, input.reviewId)
  if (review === undefined) {
    throw new AppError('not_found', `No review ${input.reviewId}`)
  }
  if (input.mode === 'api' && deps.submitter === null) {
    // Not a lint refusal, and kept apart from one: a missing adapter is an operator's configuration
    // problem, and reporting it as a refused reply would send somebody looking at the wording.
    throw new AppError(
      'invariant_violated',
      `Review ${input.reviewId} cannot be delivered in api mode with no submitter. Fallback mode is the ` +
        'launch mode (docs/10 §6); api delivery needs G-REV-07’s adapter wired in.',
    )
  }

  const stamp = await lintOrRefuse(deps, review, {
    approvedReply: input.approvedReply,
    language: input.language,
    mode: input.mode,
  })
  const reply = stamp.approvedText

  // Only now, and only in api mode. A refused reply reaches no transport at all, which the itest asserts
  // with a spy at zero calls rather than by reading this line.
  if (input.mode === 'api' && deps.submitter !== null) {
    await deps.submitter.submit({ review, reply })
  }

  await withUnitOfWork(deps.sql, deps.actor, (uow) =>
    input.mode === 'api'
      ? recordReplySubmittedToApi(uow, input.reviewId, stamp)
      : recordReplyPostedManually(uow, input.reviewId, stamp),
  )

  return {
    reviewId: input.reviewId,
    mode: input.mode,
    reply,
    lintVersion: stamp.lintVersion,
    contentSha256: stamp.contentSha256,
  }
}

/** What re-judging a delivered reply can conclude. */
export type ReplyLintReproduction =
  | {
      readonly kind: 'reproduced'
      readonly lintVersion: string
      readonly rules: readonly string[]
    }
  /** The row carries no stamp, so there is no decision to reproduce. */
  | { readonly kind: 'not_delivered' }
  /** The stored version names a rule set this build has never had. */
  | { readonly kind: 'unknown_lint_version'; readonly lintVersion: string }
  /** The stored text no longer hashes to the stored digest, so it has changed since it was judged. */
  | { readonly kind: 'content_changed'; readonly expectedSha256: string; readonly actual: string }

/**
 * Re-runs a delivered reply's lint from the version stored on the row.
 *
 * The acceptance criterion is that the decision is reproducible **from the stored version alone**, and the
 * shape that makes it one is this: nothing here reads `SEND_PATH_LINT_VERSION`. It reads the row's own
 * `reply_lint_version`, resolves it through `replyLinterFor`, and re-runs that rule set. A version this
 * build no longer has answers `unknown_lint_version` rather than silently falling back to today's rules,
 * which would report the current answer as the historical one.
 *
 * The hash is checked first and separately, because the two failures are different facts: rules that no
 * longer clear the text is a decision that has changed, and text that no longer matches its digest is a row
 * that has been edited. Conflating them would explain an edit as a rule change.
 *
 * What the stored version does NOT pin is the regulatory profile or the roster, both of which are live rows
 * — see `SEND_PATH_LINT_VERSION` in `@berelax/core`. So a reproduction is a statement about the rules, evaluated against the
 * world as it is now, and `rules` being non-empty means the reply would not pass TODAY rather than that it
 * should not have passed then.
 */
export async function reproduceReplyLint(
  sql: Sql,
  reviewId: string,
): Promise<ReplyLintReproduction> {
  const review = await getReview(sql, reviewId)
  if (review === undefined) throw new AppError('not_found', `No review ${reviewId}`)
  const text = review.replyApprovedText
  const version = review.replyLintVersion
  const digest = review.replyLintContentSha256
  if (text === null || version === null || digest === null) return { kind: 'not_delivered' }

  const actual = replyContentSha256(text)
  if (actual !== digest) {
    return { kind: 'content_changed', expectedSha256: digest, actual }
  }

  const context = await readReplyLintContext(sql)
  const linter = replyLinterFor(version, context)
  if (linter === null) return { kind: 'unknown_lint_version', lintVersion: version }

  // The language the reply was delivered in is not stored as such. It is read back off the text, which is
  // the honest answer rather than a fifth column: `detectReviewLanguage` is what the rule compares against
  // anyway, so a reply whose language cannot be identified is one no declaration could have made pass.
  const language = detectReviewLanguage(text)
  if (language === 'unknown') {
    return { kind: 'reproduced', lintVersion: version, rules: ['language_mismatch'] }
  }

  const findings = linter.lint({
    // The stored text already INCLUDES the signature, so it is the draft here and there is no signature to
    // append again — appending one would measure a reply that was never published.
    draft: text,
    language,
    reviewText: review.comment,
    reviewerDisplayName: review.reviewerDisplayName,
    signature: null,
    origin: 'approved_by_a_human',
  })
  return {
    kind: 'reproduced',
    lintVersion: version,
    rules: findings.map((finding) => finding.rule),
  }
}
