import type { CompliancePolicy } from '../compliance/lexicon.ts'
import { containsPhrase, lexiconTokens } from '../compliance/lexicon.ts'
import { type SuggestionTargetRule, suggestionTargetRefusal } from './target-allowlist.ts'

/**
 * The ingest screen: what may become a persisted suggestion candidate, and what is dropped before it can.
 *
 * ## Why the filter is at ingest and not at publication
 *
 * A banned medical term in a Search Console query is not a claim anybody at this business made — it is a
 * sentence a member of the public typed into Google. It becomes ours the moment we write it into a row,
 * because from then on it is in our records, in a worklist an owner reads, and in whatever prompt a later
 * unit builds from that row. docs/09 §"E-E-A-T" makes the rule about copy, and this is the cheapest possible
 * enforcement of it: the term never enters the system, so no later stage has to remember to remove it.
 *
 * G-SEO-02's acceptance says it exactly: *"a banned medical term present in the GSC fixture never appears in
 * any persisted candidate row"*. Never appears, not "is removed later".
 *
 * ## What is scanned, and the one thing deliberately NOT scanned
 *
 * The **query** is scanned. The **target reference is not**, and that is a decision rather than an omission.
 * A `target_ref` is a locator, and this site's most valuable locators are under `/treatments/` —
 * `lexiconTokens` splits on every non-alphanumeric character, so `/treatments/hot-oil-massage#title`
 * contributes the token `treatments`, and `treatment` is on `banned_claim_terms` under the stricter default
 * licence (migration 0004). A screen that scanned the locator would drop every candidate for every treatment
 * page, which is every candidate the agent can usefully produce.
 *
 * This is the same trap, with the same cause, that `lintCmsCopy` in `packages/cms` had to strip URLs to
 * avoid, and that `apps/web/src/facts/llms.ts` records for `/llms.txt`: a path is a locator, not a claim. The
 * allowlist in `./target-allowlist.ts` is what judges the locator, and it judges it as a locator.
 *
 * The suggestion's *copy* — the before and after — is not screened here because it does not exist here:
 * G-SEO-05 drafts it, and its banned-claims lint runs against the drafted text at that point.
 *
 * ## Why the drop is logged with the term redacted
 *
 * A log is a persisted artefact. A filter whose log carried the banned phrase verbatim would have moved the
 * problem rather than removed it — the claim would still be in our records, now in the place that gets
 * grepped, aggregated and pasted into tickets. So the log carries the rule, the count and
 * {@link redactedClaimTerm}: the term's first character and its length, which is enough for an operator to
 * find it in `regulatory_profile.banned_claim_terms` and nothing like enough to be a claim.
 *
 * It is a redaction, not a secret, and the difference is worth stating: the profile's term list is
 * configuration a reader can hold, so somebody with the list can recover which entry matched. What the
 * redaction removes is the banned phrase existing *verbatim* in the log stream. The **query** is not logged
 * at all — that one is somebody else's sentence, and the drop is the decision not to keep it.
 *
 * ## Purity
 *
 * No clock, no I/O, no ids. The policy is an argument, because `regulatory_profile` is a row and this package
 * may not read one; the caller passes the profile in force, which is also what makes the screen testable
 * against a licence class the build has not been given yet (Y1-licence).
 */

/** The analyses that may produce a candidate today. A new one is added by migration; see 0057. */
export const CANDIDATE_FINDING_KINDS = ['ctr_outlier', 'content_gap', 'cannibalisation'] as const
export type CandidateFindingKind = (typeof CANDIDATE_FINDING_KINDS)[number]

/** Why a candidate was dropped at ingest. */
export const CANDIDATE_DROP_RULES = ['banned_claim_term', 'target_not_allowlisted'] as const
export type CandidateDropRule = (typeof CANDIDATE_DROP_RULES)[number]

/**
 * One proposal, as an analysis produces it and before anything has judged it.
 *
 * `query` is untrusted input — see `./untrusted-envelope.ts` on why a Search Console query is user input
 * wearing telemetry's clothes — and it is the field the banned-term screen reads.
 */
export interface SuggestionCandidateProposal {
  readonly findingKind: CandidateFindingKind
  readonly targetKind: string
  readonly targetRef: string
  /** The query that produced the finding, or null for a finding that came from a page rather than a query. */
  readonly query: string | null
}

/**
 * One dropped proposal, as the log records it.
 *
 * Note what is absent: `query`. That is the field carrying the claim and it is the field that must not
 * survive the drop. `targetRef` stays, because a locator is what an operator needs in order to understand
 * which page lost a candidate, and it carries no claim (see the module header).
 */
export interface DroppedCandidate {
  readonly rule: CandidateDropRule
  readonly findingKind: CandidateFindingKind
  readonly targetKind: string
  readonly targetRef: string
  /**
   * For `banned_claim_term`, the matched term redacted. For `target_not_allowlisted`, the target rule that
   * refused it — which is not a claim and is reported in full, because an operator has to be able to act
   * on it.
   */
  readonly redacted: string
  /** The target-allowlist rule, when that is what dropped it. Null for a banned term. */
  readonly targetRule: SuggestionTargetRule | null
}

/** What survived ingest and what did not. Both halves, because a silent drop is the failure mode. */
export interface ScreenedCandidates {
  readonly kept: readonly SuggestionCandidateProposal[]
  readonly dropped: readonly DroppedCandidate[]
}

/**
 * The mask character. U+2022 BULLET, which is printable.
 *
 * A redaction made of invisible characters would be refused by `pnpm invisibles` and — worse — would not look
 * redacted: an operator reading the log would see a short word and assume the term was short.
 */
export const REDACTION_BULLET = '•'

/**
 * A banned term reduced to its first character and its length.
 *
 * `treatment` becomes `t••••••••`. Length-preserving so an operator can match it against the profile's list;
 * not the term, so the log does not carry the claim.
 */
export function redactedClaimTerm(term: string): string {
  const trimmed = term.trim()
  if (trimmed.length === 0) return REDACTION_BULLET
  const head = trimmed.slice(0, 1)
  const masked = REDACTION_BULLET.repeat(trimmed.length - 1)
  return `${head}${masked}`
}

/**
 * The first banned term a text asserts, or null.
 *
 * Returns the term as the PROFILE spells it rather than as the text does, so the redaction is of a
 * configured value and not of a visitor's typing. `containsPhrase` is B-CAT-05's comparison — the same
 * tokenisation, the same inflection tolerance — because a phrase the catalogue lint refuses on a menu must
 * not be admitted here by a second, slightly different reading of the same list.
 */
export function bannedTermIn(text: string, policy: CompliancePolicy): string | null {
  if (policy.medicalClaimsPermitted) return null
  const tokens = lexiconTokens(text)
  for (const term of policy.bannedClaimTerms) {
    if (containsPhrase(tokens, term)) return term
  }
  return null
}

/**
 * Screens a batch of proposals against the target allowlist and the profile's claim list.
 *
 * Order matters and is declared: the target allowlist runs first, because a proposal aimed at robots.txt is
 * refused whatever its query says, and reporting it as a banned term would name the wrong problem.
 *
 * Nothing is mutated and nothing is written. The caller persists `kept` and logs `dropped` — which is the
 * split that lets `packages/db` stay free of `packages/core` (the dependency runs core ← db) and lets the
 * whole screen be proved without a database.
 */
export function screenSuggestionCandidates(
  proposals: readonly SuggestionCandidateProposal[],
  policy: CompliancePolicy,
): ScreenedCandidates {
  const kept: SuggestionCandidateProposal[] = []
  const dropped: DroppedCandidate[] = []
  for (const proposal of proposals) {
    const targetRefusal = suggestionTargetRefusal({
      kind: proposal.targetKind,
      ref: proposal.targetRef,
    })
    if (targetRefusal !== null) {
      dropped.push({
        rule: 'target_not_allowlisted',
        findingKind: proposal.findingKind,
        targetKind: proposal.targetKind,
        targetRef: proposal.targetRef,
        redacted: targetRefusal.detail,
        targetRule: targetRefusal.rule,
      })
      continue
    }
    const term = proposal.query === null ? null : bannedTermIn(proposal.query, policy)
    if (term !== null) {
      dropped.push({
        rule: 'banned_claim_term',
        findingKind: proposal.findingKind,
        targetKind: proposal.targetKind,
        targetRef: proposal.targetRef,
        redacted: redactedClaimTerm(term),
        targetRule: null,
      })
      continue
    }
    kept.push(proposal)
  }
  return Object.freeze({ kept: Object.freeze(kept), dropped: Object.freeze(dropped) })
}
