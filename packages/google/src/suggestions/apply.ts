import {
  type CompliancePolicy,
  judgeSeoSuggestion,
  type Principal,
  performPublication,
  publicationCanonicalContent,
  type SuggestionTarget,
} from '@berelax/core'
import {
  markSeoSuggestionApplied,
  markSeoSuggestionRolledBack,
  publicationHistory,
  publicationPosition,
  publicationRecordById,
  publishSurface,
  readCompliancePolicy,
  recordApproval,
  recordDraft,
  recordLintPass,
  revertSurfaceTo,
  type SeoSuggestionRow,
  type Sql,
  seoSuggestionById,
} from '@berelax/db'
import { AppError } from '@berelax/shared'

/**
 * Applying and rolling back a suggestion — a HUMAN action, through the publication control plane.
 *
 * ## Why this module is in `packages/google/src/suggestions/` and not `packages/google/src/seo/`
 *
 * Because `.dependency-cruiser.cjs`'s `seo-agent-must-not-reach-a-publish-path` forbids every module under
 * `packages/google/src/seo/` from holding a reference to a publish path, and that rule is right. Applying
 * a suggestion is not the agent's code: it is what an operator does to the agent's output, and the
 * directory boundary IS the cage. Putting this beside `draft-suggestions.ts` would have required the rule
 * to grow an exemption, and an exemption is how a cage stops being one.
 *
 * The `@berelax/core` barrel re-exports `performPublication`, which that rule cannot close — it is the
 * loophole the rule's own comment documents, and the POLICY layer is what closes it: a caller reaching it
 * through the barrel and calling it with the `seo_agent` principal gets `PrincipalDenied`, asserted in
 * `packages/core/src/access/seo-agent.policy.test.ts` and driven over the whole corpus by
 * `packages/google/src/seo/redteam.test.ts`.
 *
 * ## Why the before-state must be what is LIVE, and why that refusal is the feature
 *
 * {@link applySeoSuggestion} refuses unless the surface's current published record carries the
 * suggestion's `before_content_sha256`. That looks like fussiness and it is the strongest form of the
 * rollback guarantee: if an editor has touched the page since the suggestion was drafted, applying it
 * would overwrite their edit, and rolling it back afterwards would restore a document that was never
 * live. The refusal is named — `suggestion_before_state_is_not_live` — so the screen can say *this
 * suggestion is stale, re-run the pass* rather than reporting a conflict nobody can act on.
 *
 * It also makes the rollback mechanical. The record the apply SUPERSEDES is the before-state, so
 * {@link rollbackSeoSuggestion} is `revertSurfaceTo` against `appliedRecord.supersedesId` and nothing has
 * to be reconstructed. 0133's `ZY403` then holds the result: the new record's `content_sha256` must be the
 * stored `before_content_sha256`, or the UPDATE is refused.
 *
 * ## Why the lint runs AGAIN here
 *
 * The suggestion already carries a lint version from the drafting pass. This re-lints the after-copy
 * against `regulatory_profile_current` as it stands now, and both are needed. The stored stamp says which
 * rules judged the copy when it was drafted — evidence, for afterwards. This one says whether the copy may
 * be published **today**: the profile is append-only and versioned (0004), so a licence class confirmed
 * between the draft and the apply legitimately changes the answer, in both directions. Publishing on the
 * strength of a week-old lint is the shape of mistake ADR 0063 built a chokepoint to prevent.
 */

/** Every refusal this module raises, by name. Each one is raised below. */
export const SUGGESTION_APPLY_REFUSALS = [
  /** No suggestion with that id. */
  'suggestion_absent',
  /** The suggestion is not `approved`, so nobody has said it may be published. */
  'suggestion_not_approved',
  /** The surface's live content is not the suggestion's stored before-state. See the header. */
  'suggestion_before_state_is_not_live',
  /** The after-copy does not pass the publication copy lint against the profile in force. */
  'suggestion_fails_the_lint',
  /** The suggestion is not `applied`, so there is nothing to roll back. */
  'suggestion_not_applied',
  /** No earlier published record of the surface carries the stored before-state. */
  'suggestion_has_no_restorable_record',
] as const
export type SuggestionApplyRefusal = (typeof SUGGESTION_APPLY_REFUSALS)[number]

function refuse(
  refusal: SuggestionApplyRefusal,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AppError('invariant_violated', message, { details: { ...details, refusal } })
}

/** The named refusal carried on an error this module raised, or null. */
export function suggestionApplyRefusalOf(err: unknown): SuggestionApplyRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' &&
    (SUGGESTION_APPLY_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as SuggestionApplyRefusal)
    : null
}

/** Who approved it, snapshotted onto `publication_approval` so a rename cannot rewrite the past. */
export interface SuggestionApprover {
  readonly userId: string
  readonly displayName: string
  readonly role: string
}

export interface ApplySeoSuggestionInput {
  /** The operator's principal. `performPublication` is what refuses the agent's. */
  readonly principal: Principal
  readonly suggestionId: string
  readonly approver: SuggestionApprover
  /**
   * What the publish-time weight check measured, and the budget it judged against.
   *
   * Both required by 0093 and both passed through rather than defaulted: `ZZ005` refuses a published
   * record with no measurement, and a default would be a measurement nobody took.
   */
  readonly measuredCriticalPathBytes: number
  readonly criticalPathBudgetBytes: number
  readonly now: Date
}

export interface AppliedSuggestion {
  readonly suggestion: SeoSuggestionRow
  readonly recordId: string
  /**
   * The record that was live before the apply: the before-state, and the rollback's target.
   *
   * NOT `publication_record.supersedes_id`, which is null here. 0093's `ZZ003` reserves that column for a
   * `published` row following a `published` row — a correction or a revert — and refuses it on the
   * ordinary revision path, which goes draft, lint_passed, approved, published. So the rollback finds its
   * target by walking the surface's history rather than by following a pointer; see
   * {@link rollbackSeoSuggestion}.
   */
  readonly replacedRecordId: string
}

/**
 * The target a suggestion's lint re-check is made against.
 *
 * Reconstructed from the stored surface rather than stored as a column, because the TARGET is a drafting
 * concern — the allowlist decides what the agent may have an opinion about — and by the time a human is
 * applying a suggestion the question is only whether the copy may be published. Storing a `target_kind`
 * would have been a second answer to that, on a row whose state can move.
 */
const targetFor = (suggestion: SeoSuggestionRow): SuggestionTarget => ({
  // `body_copy` is the broadest allowlisted kind, so the re-check cannot pass a target the drafting pass
  // would have refused: a refused target never reaches `approved` (ZY402), so this call site can only be
  // reached for a target the allowlist already admitted.
  kind: 'body_copy',
  ref: suggestion.surface,
})

function asPolicy(row: {
  readonly bannedClaimTerms: readonly string[]
  readonly permittedPublicTitles: readonly string[]
  readonly medicalClaimsPermitted: boolean
}): CompliancePolicy {
  return {
    bannedClaimTerms: row.bannedClaimTerms,
    permittedPublicTitles: row.permittedPublicTitles,
    medicalClaimsPermitted: row.medicalClaimsPermitted,
  }
}

/**
 * Publishes an approved suggestion's after-copy, through lint pass, approval and publication.
 *
 * Every step is 0093's, in 0093's order, because the state machine refuses any other: a `published` record
 * needs an approval, an approval needs a lint pass carrying the same content hash, and the COMMIT needs an
 * `audit_event` written in the same transaction (`ZZ004`). None of that is re-implemented here.
 */
export async function applySeoSuggestion(
  sql: Sql,
  input: ApplySeoSuggestionInput,
): Promise<AppliedSuggestion> {
  return await performPublication({
    principal: input.principal,
    action: 'publish',
    apply: async (): Promise<AppliedSuggestion> => {
      const suggestion = await seoSuggestionById(sql, input.suggestionId)
      if (suggestion === null) {
        refuse('suggestion_absent', `There is no seo_suggestion ${input.suggestionId}.`, {
          suggestionId: input.suggestionId,
        })
      }
      if (suggestion.state !== 'approved') {
        refuse(
          'suggestion_not_approved',
          `Suggestion ${suggestion.id} is ${suggestion.state}. Only an approved suggestion may be ` +
            'applied: a refused one can never become approved (ZY402), which is what makes "a ' +
            'suggestion that fails the banned-claims lint cannot be applied at all" a database fact.',
          { suggestionId: suggestion.id, state: suggestion.state },
        )
      }

      const policyRow = await readCompliancePolicy(sql)
      const verdict = judgeSeoSuggestion({
        target: targetFor(suggestion),
        surface: suggestion.surface,
        beforeRegions: [...suggestion.beforeRegions],
        afterRegions: [...suggestion.afterRegions],
        /*
         * The after-copy IS the answer here, canonicalised. There is no model answer to screen at apply
         * time — the escalation screen judged one once, at drafting — and passing an empty string would
         * make the screen examine nothing, which is ADR 0002's defect. What matters at this point is the
         * copy about to be published, which is what the publication lint reads.
         */
        answer: publicationCanonicalContent([...suggestion.afterRegions]),
        policy: asPolicy(policyRow),
      })
      if (verdict.kind === 'refused') {
        refuse(
          'suggestion_fails_the_lint',
          `Suggestion ${suggestion.id} does not pass the publication copy lint against regulatory ` +
            `profile version ${policyRow.profileVersion}: ${verdict.rules.join(', ')}. The stored stamp ` +
            'says which rules judged it when it was drafted; this says whether it may be published today.',
          { suggestionId: suggestion.id, rules: verdict.rules },
        )
      }

      const position = await publicationPosition(sql, suggestion.surface)
      if (
        position.state !== 'published' ||
        position.currentRecordId === null ||
        position.currentContentSha256 !== suggestion.beforeContentSha256
      ) {
        refuse(
          'suggestion_before_state_is_not_live',
          `The live content of '${suggestion.surface}' is ${position.currentContentSha256 ?? 'nothing'} ` +
            `and the suggestion's stored before-state hashes to ${suggestion.beforeContentSha256}. ` +
            'Applying it would overwrite an edit nobody asked to lose, and rolling it back afterwards ' +
            'would restore a document that was never live. Re-run the pass.',
          {
            suggestionId: suggestion.id,
            surface: suggestion.surface,
            live: position.currentContentSha256,
            before: suggestion.beforeContentSha256,
          },
        )
      }

      // The chain, in 0093's order. `recordDraft` first because the state machine requires a `draft`
      // before a `lint_passed` on a surface whose newest record is `published`.
      await recordDraft(sql, {
        surface: suggestion.surface,
        contentSha256: suggestion.afterContentSha256,
        recordedAt: input.now,
        actorKind: 'staff',
        actorLabel: input.approver.displayName,
      })
      const lint = await recordLintPass(sql, {
        surface: suggestion.surface,
        contentSha256: suggestion.afterContentSha256,
        termsChecked: verdict.termsChecked,
        lintedAt: input.now,
        actorKind: 'staff',
        actorLabel: input.approver.displayName,
      })
      const approval = await recordApproval(sql, {
        surface: suggestion.surface,
        lintPassId: lint.lintPassId,
        contentSha256: suggestion.afterContentSha256,
        approverUserId: input.approver.userId,
        approverDisplayName: input.approver.displayName,
        approverRole: input.approver.role,
        approvedAt: input.now,
      })
      const published = await publishSurface(sql, {
        surface: suggestion.surface,
        lintPassId: lint.lintPassId,
        approvalId: approval.approvalId,
        contentSha256: suggestion.afterContentSha256,
        measuredCriticalPathBytes: input.measuredCriticalPathBytes,
        criticalPathBudgetBytes: input.criticalPathBudgetBytes,
        recordedAt: input.now,
        actorKind: 'staff',
        actorLabel: input.approver.displayName,
        /*
         * No `supersedesId`, and that is 0093's rule rather than an omission: `ZZ003` permits the column
         * only on a `published` row whose PREVIOUS record is also `published` — a correction or a revert —
         * and the chain above has just written `draft`, `lint_passed` and `approved`, so the previous
         * record is `approved`. Passing the live record's id here was the first version and the database
         * refused it by name, which is the shape of mistake a service-layer-only guard would have let
         * through.
         */
      })

      const applied = await markSeoSuggestionApplied(sql, suggestion.id, published.recordId)
      return {
        suggestion: applied,
        recordId: published.recordId,
        replacedRecordId: position.currentRecordId,
      }
    },
  })
}

export interface RollbackSeoSuggestionInput {
  readonly principal: Principal
  readonly suggestionId: string
  readonly actorLabel: string
  readonly measuredCriticalPathBytes: number
  readonly criticalPathBudgetBytes: number
  readonly now: Date
}

export interface RolledBackSuggestion {
  readonly suggestion: SeoSuggestionRow
  readonly recordId: string
  /** The hash the surface landed on. `ZY403` has already held it equal to the stored before-state. */
  readonly contentSha256: string
}

/**
 * Restores the stored before-state, as a new published record superseding the applied one.
 *
 * Nothing is reconstructed and nothing is re-approved: `revertSurfaceTo` copies the target's
 * `content_sha256`, `lint_pass_id` and `approval_id`, because the content being restored was linted and
 * approved once — asking for a second approval of unchanged copy is how a revert comes to be done by hand.
 *
 * The weight figures are re-measured by the caller, which is `revertSurfaceTo`'s own decision: the page is
 * rendered from today's templates, so the target's figure describes bytes nobody will download.
 */
export async function rollbackSeoSuggestion(
  sql: Sql,
  input: RollbackSeoSuggestionInput,
): Promise<RolledBackSuggestion> {
  return await performPublication({
    principal: input.principal,
    action: 'publish',
    apply: async (): Promise<RolledBackSuggestion> => {
      const suggestion = await seoSuggestionById(sql, input.suggestionId)
      if (suggestion === null) {
        refuse('suggestion_absent', `There is no seo_suggestion ${input.suggestionId}.`, {
          suggestionId: input.suggestionId,
        })
      }
      if (suggestion.state !== 'applied' || suggestion.appliedRecordId === null) {
        refuse(
          'suggestion_not_applied',
          `Suggestion ${suggestion.id} is ${suggestion.state}, so there is nothing to roll back.`,
          { suggestionId: suggestion.id, state: suggestion.state },
        )
      }
      const appliedRecord = await publicationRecordById(sql, suggestion.appliedRecordId)
      if (appliedRecord === null) {
        refuse(
          'suggestion_has_no_restorable_record',
          `The publication record ${suggestion.appliedRecordId} of suggestion ${suggestion.id} is gone.`,
          { suggestionId: suggestion.id, appliedRecordId: suggestion.appliedRecordId },
        )
      }
      /*
       * The rollback target, DERIVED from the ledger: the NEWEST published record before the applied one.
       *
       * Not `appliedRecord.supersedesId` — 0093's `ZZ003` reserves that column for a `published` row
       * following a `published` row, so it is null on the ordinary revision path the apply takes. And not
       * a column of its own on `seo_suggestion` either: that would be a second statement of something the
       * ledger already holds, with two answers to compare on the day a revert goes to the wrong version.
       *
       * The hash is a POST-condition and NOT a filter condition, which was the first design and was
       * vacuous: `applySeoSuggestion` refuses unless the live record carries the stored before-state, so
       * the newest earlier published record always carries it, and a hash clause inside the `filter` could
       * never change which record was chosen. Gate case 164k is what found that — the clause was removed
       * and every test still passed. As an assertion it is reachable and it is the thing that matters: if
       * the walk ever picks another version, the rollback is REFUSED by name rather than restoring a
       * document nobody approved. `ZY403` then refuses the state move as well, so the wrong answer is
       * stopped twice and neither layer is the other's backup.
       */
      const history = await publicationHistory(sql, suggestion.surface)
      const published = history.filter(
        (record) => record.state === 'published' && record.seq < appliedRecord.seq,
      )
      const target = published[published.length - 1]
      if (target === undefined) {
        refuse(
          'suggestion_has_no_restorable_record',
          `No published record of '${suggestion.surface}' precedes ${appliedRecord.id}, so there is ` +
            'nothing to restore. A suggestion may only be applied over a live published record, so this ' +
            'is unreachable through applySeoSuggestion.',
          { suggestionId: suggestion.id, appliedRecordId: appliedRecord.id },
        )
      }
      if (target.contentSha256 !== suggestion.beforeContentSha256) {
        refuse(
          'suggestion_has_no_restorable_record',
          `The newest published record of '${suggestion.surface}' before ${appliedRecord.id} is ` +
            `${target.id}, which carries ${target.contentSha256}, and the suggestion's stored ` +
            `before-state hashes to ${suggestion.beforeContentSha256}. Reverting to it would restore a ` +
            'document this suggestion never replaced.',
          {
            suggestionId: suggestion.id,
            targetRecordId: target.id,
            carries: target.contentSha256,
            before: suggestion.beforeContentSha256,
          },
        )
      }

      const reverted = await revertSurfaceTo(sql, {
        surface: suggestion.surface,
        targetRecordId: target.id,
        measuredCriticalPathBytes: input.measuredCriticalPathBytes,
        criticalPathBudgetBytes: input.criticalPathBudgetBytes,
        recordedAt: input.now,
        actorKind: 'staff',
        actorLabel: input.actorLabel,
      })
      // `ZY403` refuses this UPDATE unless `reverted.recordId` carries `before_content_sha256`, which is
      // what makes "rollback is exact" a property of the database rather than of this function's order.
      const rolledBack = await markSeoSuggestionRolledBack(sql, suggestion.id, reverted.recordId)
      return {
        suggestion: rolledBack,
        recordId: reverted.recordId,
        contentSha256: reverted.contentSha256,
      }
    },
  })
}
