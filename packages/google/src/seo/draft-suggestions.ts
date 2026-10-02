import {
  createRunBudget,
  judgeSeoSuggestion,
  publicationCanonicalContent,
  type SeoUntrustedEnvelope,
  type SuggestionTarget,
} from '@berelax/core'
import {
  insertSeoSuggestion,
  publicationContentHash,
  readCompliancePolicy,
  type SeoSuggestionRow,
  type Sql,
  type SuggestionRegion,
  withAgentRun,
} from '@berelax/db'
import { AppError } from '@berelax/shared'

/**
 * The drafting pass: findings in, `seo_suggestion` rows out. It cannot publish, by construction.
 *
 * ## What this module is NOT allowed to touch, and why that shapes its signature
 *
 * Two dependency rules cross here and together they close the cage:
 *
 *   - **`seo-agent-must-not-reach-a-publish-path`** forbids every module under
 *     `packages/google/src/seo/` from importing the CMS, Next's cache API or
 *     `packages/core/src/access/publication.ts`. So this module holds no reference to the thing it may not
 *     do. A refusal it never reaches is a refusal nobody has to argue with at three in the morning.
 *   - **`seo-llm-only-through-a-prompt-module`** forbids every non-`*prompt*` module here from importing
 *     `packages/providers/src/llm/`, and its companion
 *     `seo-prompt-must-use-the-untrusted-envelope` is satisfiable only from inside `packages/core`. The two
 *     together mean **nothing under `packages/google/src/seo/` may reach a model at all**, which reads like
 *     an oversight and is the design: a prompt is a pure function of its inputs, it belongs where it can be
 *     fuzzed over 200 adversarial strings with no provider and no database, and the provider is wired in
 *     from outside.
 *
 * So {@link SeoDraftDeps.draft} is a **function the caller supplies**, and {@link SeoModelAnswer} is a
 * structural seam declared here rather than `LlmOutcome` imported from the port. That is a fact stated
 * twice, which the brief forbids unless the check that holds the two equal lands in the same commit —
 * `redteam.test.ts` is that check: tests are exempt from the rule, so it imports the real
 * `LlmProvider` and asserts a provider-backed drafter is assignable to this seam. A seam that drifted from
 * the port would be a compile error there rather than a runtime surprise in the worker.
 *
 * ## The cost cap is the RUN's, enforced mid-run
 *
 * `withAgentRun` takes `createRunBudget` and the cap is `agent_definition.budget_fils_per_run` (G-AGT-01).
 * Every answer is charged **as it arrives**, before the next finding is drafted, which is what "mid-run"
 * has to mean: a cap checked at the end is a cap that has already been exceeded. `createRunBudget` throws
 * `BudgetExceeded`, `withAgentRun` records the run as `budget_exceeded` with the **partial** cost
 * persisted, and `recordHeartbeat` leaves `last_success_at` alone — so a run that ran away goes visibly
 * quiet rather than reporting success with half a report.
 *
 * There is deliberately no second cap on this module. A per-pass cap would be a second answer to whether
 * a run may continue, and the one that aborted the run is the one that matters.
 *
 * ## Every suggestion is judged, and a refusal is STORED
 *
 * `judgeSeoSuggestion` runs the target allowlist, the escalation screen and the publication copy lint —
 * the same lint `sendPathReplyLinter` calls for its five `PUBLIC_NAME_RULES` and the same one W-SITE-10's
 * control plane calls before a publication, so there is one implementation of "is this claim publishable"
 * in this build (ADR 0063, ADR 0086).
 *
 * A refused draft is written as a `refused` row rather than dropped. Two reasons, and the second is the
 * one that matters: a refusal nobody can see is indistinguishable from a model that produced nothing, so
 * the day the screen starts refusing everything the report would simply be empty; and an **escalation**
 * attempt is a security event, recorded as an `audit_event` whose `operation` is `denied` — the vocabulary
 * 0005 already has for exactly this, rather than a new table that only this unit would write to.
 */

/** The `agent_definition` row this pass reports to. Seeded by migration 0042. */
export const SEO_SUGGESTION_AGENT = 'seo_agent'

/** The audit action an escalation attempt writes. A named constant, so a test counts a delta on one. */
export const SEO_ESCALATION_AUDIT_ACTION = 'seo.suggestion.escalation_refused'

/**
 * What a model answered, as this module needs it.
 *
 * A structural seam and not `LlmOutcome`; see the module header for why it cannot be the import, and
 * `redteam.test.ts` for the assignability check that keeps the two equal. The field names are the port's
 * own, so the check is a one-line `satisfies` rather than an adapter.
 */
export interface SeoModelAnswer {
  /** The provider that answered, from `LLM_PROVIDER_NAMES`. Stored on the row. */
  readonly provider: string
  /** `completion` or `refusal`. A refusal is a normal outcome and is not an error (the port's decision). */
  readonly kind: 'completion' | 'refusal'
  /** The answer, whole. Screened whole: see `SeoSuggestionDraftInput.answer`. */
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
  /** What the call cost, in integer fils, already rounded UP by `costOfFils` (ADR 0007). */
  readonly costFils: number
  /** The copy the caller extracted from the answer, region by region. Empty for a refusal. */
  readonly regions: readonly SuggestionRegion[]
}

/** One thing to draft a suggestion for. */
export interface SeoDraftRequest {
  /** The allowlisted target (G-SEO-01). A kind off the list is refused without a model call. */
  readonly target: SuggestionTarget
  /** The publication surface locator: `collection:slug`. */
  readonly surface: string
  /** The copy as it stands. STORED as the before-state, which is what makes a rollback exact. */
  readonly beforeRegions: readonly SuggestionRegion[]
  /**
   * The untrusted evidence behind the finding, already enclosed (G-SEO-02).
   *
   * Carried so the drafter has it and so the type of this field says what it is. The pass never reads
   * `region` — building a prompt is the drafter's job and the drafter lives outside this directory — and
   * never unwraps it: a finding's evidence reaching a `seo_suggestion` row unfenced would put a
   * competitor's bytes on an admin screen.
   */
  readonly evidence: readonly SeoUntrustedEnvelope[]
}

/** What the caller supplies. One function, and it is where the model lives. */
export interface SeoDraftDeps {
  /** Drafts one suggestion. Throwing is a failed run; a `refusal` answer is an ordinary outcome. */
  draft(request: SeoDraftRequest): Promise<SeoModelAnswer>
  /**
   * Appends one audit row. Injected rather than written here so the pass cannot reach for a second
   * statement of what an audit row is, and so a test counts a delta on a sink it controls.
   */
  audit(event: {
    readonly action: string
    readonly entityId: string
    readonly detail: Readonly<Record<string, unknown>>
  }): Promise<void>
}

export interface SeoDraftPassOptions {
  readonly jobId?: string
}

export interface SeoDraftPassResult {
  readonly runId: string
  readonly outcome: string
  /** What the run spent, in integer fils, as `agent_run` recorded it. */
  readonly costFils: number
  readonly proposed: readonly SeoSuggestionRow[]
  readonly refused: readonly SeoSuggestionRow[]
  /** How many answers were a model refusal rather than a completion. Not a failure. */
  readonly modelRefusals: number
  /** How many escalation attempts were recorded as security events. */
  readonly escalationsRecorded: number
}

/**
 * Drafts a suggestion per request, judges every one, and stores both verdicts.
 *
 * Sequential and not concurrent, deliberately. The cap has to be enforced **between** calls — a run that
 * fired ten requests at once would be ten calls past its budget before the first charge landed — and the
 * per-suggestion cost would then be unattributable to the answer that incurred it.
 */
export async function runSeoSuggestionDraftPass(
  sql: Sql,
  deps: SeoDraftDeps,
  requests: readonly SeoDraftRequest[],
  atIso: string,
  options: SeoDraftPassOptions = {},
): Promise<SeoDraftPassResult> {
  const proposed: SeoSuggestionRow[] = []
  const refused: SeoSuggestionRow[] = []
  let modelRefusals = 0
  let escalationsRecorded = 0

  const policy = await readCompliancePolicy(sql)
  const proposedAt = new Date(atIso)
  if (Number.isNaN(proposedAt.getTime())) {
    throw new AppError('validation', `runSeoSuggestionDraftPass was given the instant ${atIso}`)
  }

  const run = await withAgentRun(
    sql,
    {
      agentKey: SEO_SUGGESTION_AGENT,
      startedAtIso: atIso,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    },
    async (charge, runId) => {
      for (const request of requests) {
        const answer = await deps.draft(request)
        /*
         * Charged BEFORE anything is stored, which is the whole meaning of "mid-run". `createRunBudget`
         * throws `BudgetExceeded` here, and the throw propagates out of the body — so the suggestions
         * drafted before the cap was reached are already committed (each insert is its own statement)
         * while the run is recorded as `budget_exceeded` with the partial cost. That split is correct: the
         * work done is real and the run did not succeed.
         */
        charge(answer.costFils)

        if (answer.kind === 'refusal') {
          // The model declined. An ordinary outcome, not an error (the port's own decision), and nothing
          // to store: there is no `after` state, so there is no before/after pair and nothing to roll back.
          modelRefusals += 1
          continue
        }

        const verdict = judgeSeoSuggestion({
          target: request.target,
          surface: request.surface,
          beforeRegions: request.beforeRegions,
          afterRegions: answer.regions,
          answer: answer.text,
          policy,
        })

        const beforeSha = await publicationContentHash(
          sql,
          publicationCanonicalContent([...request.beforeRegions]),
        )
        const afterSha = await publicationContentHash(
          sql,
          publicationCanonicalContent([...answer.regions]),
        )
        if (beforeSha === afterSha) {
          /*
           * A draft that changes nothing. 0133's `seo_suggestion_changes_something` CHECK would refuse the
           * INSERT, and reaching it would abort the whole pass over a model that answered with the copy it
           * was given — which is a thing models do. Skipped and counted as a model refusal, because that is
           * what it is: an answer with no proposal in it.
           */
          modelRefusals += 1
          continue
        }

        const row = await insertSeoSuggestion(sql, {
          runId,
          surface: request.surface,
          state: verdict.kind === 'proposed' ? 'proposed' : 'refused',
          beforeRegions: request.beforeRegions,
          beforeContentSha256: beforeSha,
          afterRegions: answer.regions,
          afterContentSha256: afterSha,
          lintVersion: verdict.lintVersion,
          lintTermsChecked: verdict.termsChecked,
          refusedRules: verdict.kind === 'refused' ? verdict.rules : [],
          llmProvider: answer.provider,
          inputTokens: answer.inputTokens,
          outputTokens: answer.outputTokens,
          costFils: answer.costFils,
          proposedAt,
        })

        if (verdict.kind === 'proposed') {
          proposed.push(row)
          continue
        }
        refused.push(row)

        if (verdict.escalations.length > 0) {
          /*
           * The security event. `audit_event.operation` is `denied` — 0005's own vocabulary for a refused
           * attempt, indexed on `action` — rather than a `security_event` table only this unit would
           * write to. The detail carries the RULE NAMES and the matched PHRASES, never the model's answer:
           * the answer is a competitor's text by the time an injection has worked, and an audit row is
           * read by a person.
           */
          await deps.audit({
            action: SEO_ESCALATION_AUDIT_ACTION,
            entityId: row.id,
            detail: {
              surface: request.surface,
              rules: verdict.escalations.map((escalation) => escalation.rule),
              matched: verdict.escalations.map((escalation) => escalation.matched),
              profileVersion: policy.profileVersion,
            },
          })
          escalationsRecorded += 1
        }
      }
    },
    createRunBudget,
  )

  return {
    runId: run.runId,
    outcome: run.outcome,
    costFils: run.costFils,
    proposed,
    refused,
    modelRefusals,
    escalationsRecorded,
  }
}
