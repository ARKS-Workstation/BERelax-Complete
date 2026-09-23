import {
  assertPrincipalMay,
  type CandidateDropRule,
  type CompliancePolicy,
  type Principal,
  type SuggestionCandidateProposal,
  screenSuggestionCandidates,
} from '@berelax/core'
import type { SuggestionCandidateInsert, SuggestionCandidateWrite } from '@berelax/db'

/**
 * The ingest boundary: the one place a finding becomes a persisted candidate.
 *
 * Three things happen here and the order is the design.
 *
 *   1. **The principal is checked, by the policy layer.** `seo_suggestion:propose` is the SEO agent's only
 *      write capability, and it is asserted through `assertPrincipalMay` rather than assumed — so a caller
 *      that arrived with the wrong principal is refused here rather than discovering it at the constraint.
 *      The refusal is `PrincipalDenied` from `packages/core/src/access/principal-policy.ts`, the same class
 *      and the same call site as a refused publish.
 *   2. **Every proposal is screened**, against the target allowlist and against
 *      `regulatory_profile.banned_claim_terms`. A dropped proposal is not written, not queued and not
 *      retried; it is logged.
 *   3. **What survived is written**, through the `persist` seam.
 *
 * ## Why `persist` is injected rather than the `Sql` handle
 *
 * Because the screen is the part that must be provable without a database. `packages/core` does the deciding
 * and `packages/db` does the writing (the dependency runs core ← db, so neither can call the other), and this
 * module is the composition of the two. Handing it a writer rather than a connection is what lets
 * `candidate-ingest.test.ts` drive the whole boundary — including the assertion that the log line does not
 * carry the banned term — with no PostgreSQL at all, and it is the same seam `runContentRevalidation` uses for
 * `revalidatePath` and `generateDrafts` uses for `charge`.
 *
 * `packages/google/src/seo/seo-agent-cage.itest.ts` wires the real writer and asserts the other half: that no
 * row in `seo_suggestion_candidate` carries the term, counted in SQL over the whole table.
 *
 * ## Why the drop is a log line and not an exception
 *
 * A banned term in a Search Console query is ordinary. It is what the public types. An exception would abort
 * the run, `withAgentRun` would record a failure, and the watchdog would report the agent broken every week
 * for doing exactly what it is supposed to do. So a drop is an event with a count, and the count is what an
 * operator watches: a night on which everything was dropped is a profile or an analysis problem, and it is
 * visible as a number rather than as silence.
 */

/** One structured line. Fields rather than message text, because a message is not something a query groups by. */
export interface SeoIngestLogLine {
  readonly level: 'info' | 'warn'
  readonly message: string
  /** Why the candidate was dropped. */
  readonly rule: CandidateDropRule
  /**
   * Everything else. Nothing here is a banned claim and nothing here is a visitor's query: the term arrives
   * redacted by `redactedClaimTerm` and the query is not carried at all. `candidate-ingest.test.ts` greps
   * every field of every line for both.
   */
  readonly fields: Readonly<Record<string, unknown>>
}

export interface SeoIngestLogger {
  log(line: SeoIngestLogLine): void
}

/** The write seam. `packages/db`'s `insertSuggestionCandidates`, in production. */
export type SuggestionCandidatePersist = (
  candidates: readonly SuggestionCandidateInsert[],
) => Promise<SuggestionCandidateWrite>

export interface IngestCandidatesDeps {
  /** Who is asking. The SEO agent's principal in production; asserted, not assumed. */
  readonly principal: Principal
  /** The regulatory profile in force. An argument, because `packages/core` may not read a row. */
  readonly policy: CompliancePolicy
  readonly persist: SuggestionCandidatePersist
  readonly logger: SeoIngestLogger
}

/** What one ingest did. Every number an operator needs to tell "nothing new" from "nothing". */
export interface IngestSummary {
  readonly proposed: number
  readonly kept: number
  readonly dropped: number
  readonly inserted: number
  readonly skipped: number
  /** How many drops each rule accounted for, so a spike is attributable. */
  readonly droppedByRule: Readonly<Record<CandidateDropRule, number>>
}

export async function ingestSuggestionCandidates(
  deps: IngestCandidatesDeps,
  args: {
    readonly siteUrl: string
    /** The `agent_run` this ingest belongs to, or null outside a run. */
    readonly runId: string | null
    readonly proposals: readonly SuggestionCandidateProposal[]
  },
): Promise<IngestSummary> {
  // The policy layer, before anything is screened or written. A caller with no propose capability must not
  // reach the screen: a refusal after the work is a refusal that has already spent the budget.
  assertPrincipalMay(deps.principal, 'seo_suggestion:propose')

  const screened = screenSuggestionCandidates(args.proposals, deps.policy)

  const droppedByRule: Record<CandidateDropRule, number> = {
    banned_claim_term: 0,
    target_not_allowlisted: 0,
  }
  for (const drop of screened.dropped) {
    droppedByRule[drop.rule] += 1
    deps.logger.log({
      level: 'warn',
      // The message names the rule and the locator and nothing else. The term is in `fields`, redacted.
      message: `seo candidate dropped at ingest: ${drop.rule}`,
      rule: drop.rule,
      fields: {
        siteUrl: args.siteUrl,
        runId: args.runId,
        findingKind: drop.findingKind,
        targetKind: drop.targetKind,
        targetRef: drop.targetRef,
        // `redacted` is the term's first character and its length for a banned claim, and the target rule
        // for a denied target — see `DroppedCandidate.redacted`. Never the term and never the query.
        redacted: drop.redacted,
        targetRule: drop.targetRule,
      },
    })
  }

  const written = await deps.persist(
    screened.kept.map((proposal) => ({
      runId: args.runId,
      siteUrl: args.siteUrl,
      findingKind: proposal.findingKind,
      targetKind: proposal.targetKind,
      targetRef: proposal.targetRef,
      query: proposal.query,
    })),
  )

  return {
    proposed: args.proposals.length,
    kept: screened.kept.length,
    dropped: screened.dropped.length,
    inserted: written.inserted,
    skipped: written.skipped,
    droppedByRule: Object.freeze(droppedByRule),
  }
}
