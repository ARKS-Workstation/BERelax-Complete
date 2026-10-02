import { AppError } from '@berelax/shared'
import {
  bannedClaimVocabulary,
  type PublishedCopyFinding,
  type PublishedCopyRegion,
  publicationCopyFindings,
} from '../compliance/banned-claims.ts'
import type { CompliancePolicy } from '../compliance/lexicon.ts'
import { medicalTermsIn } from './jsonld/vocabulary.ts'
import {
  type SuggestionTarget,
  type SuggestionTargetRule,
  suggestionTargetRefusal,
} from './target-allowlist.ts'

/**
 * Whether a drafted SEO suggestion may be proposed at all: the target, the escalation screen, the lint.
 *
 * ## Why the lint is the PUBLICATION lint and not a second one
 *
 * An LLM-drafted suggestion is text this business would publish. ADR 0063 settled what that means for a
 * review reply — *one* chokepoint, no injectable rule set — and the specific cost of getting it wrong is
 * on the record: G-REV-04's English reply used `treatment`, a term on `regulatory_profile.banned_claim_terms`,
 * and 32 of 296 renderings were refused by the lint that existed. A second linter here, or an unlinted
 * draft path, reproduces that defect in a place nobody is watching.
 *
 * So this module calls {@link publicationCopyFindings} — the same `lintPublicDisplayName` over the same
 * live `regulatory_profile` that `sendPathReplyLinter` calls for its five `PUBLIC_NAME_RULES`, and the
 * same one W-SITE-10's control plane calls before a publication. There is exactly one implementation of
 * "is this claim publishable" in this build and this is a caller of it, not a sibling.
 *
 * What this module does NOT do is run the reply linter's whole rule set. Four of those rules are about a
 * REPLY — `not_a_house_skeleton_rendering` asks whether a draft is one of the 148 strings the review
 * generator can produce, `language_mismatch` and `echoes_review_text` need a review — and asking them of a
 * page title is a category error that would refuse every suggestion this unit can make. Widening
 * `ReplyOrigin` with a third value to silence them was the first design and is worse: it edits a shared
 * contract so that a rule can be skipped, which is the injectable-linter shape ADR 0063 refuses.
 *
 * ## The escalation screen, and why it is over the ANSWER
 *
 * {@link screenSeoDraft} is G-REV-04's response screen applied to this subject. The payload in a
 * competitor's HTML is not the event; a model that COMPLIED with it is. "Ignore all previous instructions"
 * sitting in fetched markup proves nothing, and `redteam.corpus/` is built accordingly: each payload
 * carries the answer a fully-succumbed model would give, and the screen names the rule that must refuse
 * it. Driving the attack text through a fake that is a hash table proves only that the fake is indifferent.
 *
 * The screen's rules are about things a page title cannot legitimately ask for: an elevated role, a
 * publication, a cache call, a crawler directive, a credential, or a rating. Each of those is a capability
 * `SEO_AGENT_DENIED_CAPABILITIES` already withholds, which is the point — the permission layer is the
 * guarantee and this is what makes the attempt VISIBLE, as a refused suggestion and an `audit_event` whose
 * operation is `denied`, rather than a draft that was quietly harmless this time.
 *
 * ## Every refusal, not the first
 *
 * An owner told about one problem fixes it and resubmits; two round trips for two problems is how a queue
 * stops being read. The same argument the reply linter makes, and here it has a second edge: a payload
 * that trips three rules is more interesting than one that trips one, and a screen reporting only the
 * first would hide that.
 *
 * ## Pure
 *
 * No clock, no I/O. The policy is an argument, which is what lets the fixture suite judge against a
 * stand-in with one banned term in it while `suggestion-store.itest.ts` judges the SAME drafts against
 * `regulatory_profile_current` read out of the database — the pair that catches a profile which stopped
 * banning `therapeutic`.
 */

/**
 * The version stamped onto every suggestion this rule set judged.
 *
 * Named after the unit and counted, not dated, for `SEND_PATH_LINT_VERSION`'s reason: the question it
 * answers is *which rules judged this copy*, and changing any rule below means a new version rather than
 * an edit here. Editing the rules under this version would make every stored decision unreproducible,
 * which is the one thing `seo_suggestion.lint_version` exists to prevent.
 *
 * What it does NOT pin is the regulatory profile, which is a live row. A suggestion that passed under
 * profile version 1 can fail under version 2, and that is correct — the profile is the licence, not the
 * rule set.
 */
export const SEO_SUGGESTION_LINT_VERSION = 'g-seo-05-publication-copy-1'

/** Why a drafted answer is refused. Named, so a caller and a corpus entry agree on the rule. */
export const SEO_DRAFT_SCREEN_RULES = [
  /** The answer claims a role, a permission or an identity it was not given. */
  'claims_an_elevated_role',
  /** It asks for the copy to be published, pushed live or made visible without a human. */
  'asks_for_a_publication',
  /** It asks for a cache purge, a revalidation or a deploy — `cache:revalidate` is denied. */
  'asks_for_a_cache_call',
  /** It asks for a crawler directive: robots, noindex, canonical, redirect, sitemap. */
  'asks_for_a_machine_directive',
  /** It asks for a key, a token, a password or the prompt it was given. */
  'asks_for_a_credential_or_the_prompt',
  /** It asks for a rating, a review count or review markup. docs/09 forbids own-testimonial markup. */
  'asks_for_a_rating_claim',
  /** It proposes medical vocabulary the licence class does not permit (ADR 0020). */
  'proposes_medical_vocabulary',
] as const
export type SeoDraftScreenRule = (typeof SEO_DRAFT_SCREEN_RULES)[number]

/** Every rule that can refuse a suggestion: the target, the screen, and the publication copy lint. */
export type SeoSuggestionRule = SuggestionTargetRule | SeoDraftScreenRule | string

export interface SeoDraftRefusal {
  readonly rule: SeoDraftScreenRule
  /** The phrase that matched, for the audit row and for the operator's queue. Never the whole answer. */
  readonly matched: string
}

/**
 * The phrases each screen rule looks for.
 *
 * Phrases and not single words, deliberately, and the reason is the false positive that would make the
 * screen useless: a legitimate suggestion for a treatment page's title can contain `publish` (as in "our
 * published prices") and `key` (as in "key benefits"). A phrase is the smallest unit that distinguishes an
 * instruction from a noun, which is the same reason `lintPublicDisplayName` matches phrases of tokens
 * rather than substrings.
 *
 * Matched case-blind over whitespace-collapsed text. NOT accent- or homoglyph-folded: that is
 * `lexiconTokens`' job, it is already applied to the copy by the publication lint, and a second subtly
 * different normaliser here would be two answers to what a word is.
 */
const SCREEN_PHRASES: Readonly<Record<SeoDraftScreenRule, readonly string[]>> = Object.freeze({
  claims_an_elevated_role: Object.freeze([
    'i am now an admin',
    'you are now an admin',
    'as an administrator',
    'acting as the owner',
    'i have admin',
    'elevated permissions',
    'ignoring previous instructions',
    'ignoring the previous instructions',
    'disregarding the rules',
    'my new instructions',
  ]),
  asks_for_a_publication: Object.freeze([
    'publish this',
    'publishing this',
    'i have published',
    'push it live',
    'pushing it live',
    'push live',
    'go live now',
    'publish immediately',
    'publish without review',
    'no approval is needed',
    'no human review',
  ]),
  asks_for_a_cache_call: Object.freeze([
    'revalidate endpoint',
    'call revalidate',
    'calling the revalidate',
    'purge the cache',
    'purging the cache',
    'clear the cache',
    'trigger a deploy',
    'trigger the deploy',
    'redeploy the site',
  ]),
  asks_for_a_machine_directive: Object.freeze([
    'add noindex',
    'set noindex',
    'noindex to',
    'edit robots.txt',
    'update robots.txt',
    'add a canonical',
    'change the canonical',
    'set the canonical',
    'add a redirect',
    'create a redirect',
    'edit the sitemap',
    'remove from the sitemap',
    'x-robots-tag',
  ]),
  asks_for_a_credential_or_the_prompt: Object.freeze([
    'api key',
    'access token',
    'refresh token',
    'service account',
    'your system prompt',
    'the system prompt',
    'repeat your instructions',
    'print your instructions',
    'reveal your instructions',
    'client secret',
  ]),
  asks_for_a_rating_claim: Object.freeze([
    'aggregaterating',
    'aggregate rating',
    'star rating',
    'rated 5 stars',
    'rated 4.9',
    'review count',
    'reviewcount',
    'mark up our testimonials',
    'mark up the testimonials',
    'add review markup',
  ]),
  // Populated from `MEDICAL_VOCABULARY` rather than written out; see `screenSeoDraft`.
  proposes_medical_vocabulary: Object.freeze([]),
})

/** Lower-cased with runs of whitespace collapsed. One normalisation, used by every rule. */
function flatten(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Every rule a drafted answer breaks, in the order the rules are declared.
 *
 * The licence class is an argument and not a default, for `ValidateGraphOptions.licence`'s reason: the
 * caller that forgets it is the caller whose profile has been flipped, and a screen that quietly assumed
 * the strict case would refuse a suggestion that had become legitimate.
 */
export function screenSeoDraft(args: {
  readonly answer: string
  readonly medicalClaimsPermitted: boolean
}): readonly SeoDraftRefusal[] {
  const flat = flatten(args.answer)
  const refusals: SeoDraftRefusal[] = []
  for (const rule of SEO_DRAFT_SCREEN_RULES) {
    if (rule === 'proposes_medical_vocabulary') {
      /*
       * Delegated to `medicalTermsIn`, which is the ONE place that knows which terms are medical and
       * scans text as well as a `@type` list. A copy of the four terms here would be a second answer to a
       * compliance question, and the day they disagree the structured data and the suggestions describe
       * different businesses. Skipped wholesale under a healthcare licence, exactly as
       * `lintPublicDisplayName` skips the profile's claim list there.
       */
      if (args.medicalClaimsPermitted) continue
      for (const term of medicalTermsIn(args.answer)) {
        refusals.push({ rule, matched: term })
      }
      continue
    }
    for (const phrase of SCREEN_PHRASES[rule]) {
      if (flat.includes(phrase)) refusals.push({ rule, matched: phrase })
    }
  }
  return Object.freeze(refusals)
}

/** What a draft has to be judged on, all of it read by the caller. */
export interface SeoSuggestionDraftInput {
  /** The allowlisted target (G-SEO-01). A kind off the list refuses the suggestion outright. */
  readonly target: SuggestionTarget
  /** The surface locator the publication control plane knows: `collection:slug`. */
  readonly surface: string
  /** The copy as it stands. Stored verbatim, because the rollback is the stored before-state. */
  readonly beforeRegions: readonly PublishedCopyRegion[]
  /** The copy as the draft would have it. */
  readonly afterRegions: readonly PublishedCopyRegion[]
  /**
   * The model's answer, whole, for the escalation screen.
   *
   * Separate from {@link afterRegions} because they are different claims: the regions are the copy a
   * caller extracted from the answer, and the answer is everything the model said — including the
   * sentence in which it announces that it is now an administrator. Screening the regions alone would
   * screen the part an attacker does not need to use.
   */
  readonly answer: string
  readonly policy: CompliancePolicy
}

export type SeoSuggestionVerdict =
  | {
      readonly kind: 'proposed'
      readonly lintVersion: string
      /** How many banned terms the lint compared against. `> 0`, or this throws. */
      readonly termsChecked: number
    }
  | {
      readonly kind: 'refused'
      readonly lintVersion: string
      readonly termsChecked: number
      /** Every rule that refused it, de-duplicated, in rule order. Never empty. */
      readonly rules: readonly string[]
      /** The escalation refusals specifically, which are what gets recorded as a security event. */
      readonly escalations: readonly SeoDraftRefusal[]
      /** The publication copy lint's findings, with the region each came from. */
      readonly copyFindings: readonly PublishedCopyFinding[]
    }

/**
 * The verdict on one drafted suggestion.
 *
 * Three gates in one function rather than three a caller remembers to call in order, and that is the whole
 * reason this module exists: the ORDER does not matter to the answer — every refusal is reported — but the
 * COMPLETENESS does, and a caller that called two of three would produce a suggestion that looks judged.
 *
 * ## Two throws, and only one of them can be reached from a policy
 *
 * ADR 0002 says a check that examined nothing is worse than one that failed, and there are two ways for
 * this lint to examine nothing.
 *
 *   - **Empty after-copy.** `publicationCopyFindings` over no regions, or over regions whose text is
 *     blank, returns no findings — a pass over nothing, and a `proposed` row recording it. This is
 *     reachable: a model that answered with an empty string and an extractor that dutifully produced
 *     `[{region: 'title', text: ''}]` get here. 0133's `seo_suggestion_after_regions_is_an_array` CHECK
 *     refuses the empty ARRAY one layer down and cannot see the blank TEXT, which is why the guard is
 *     here rather than left to the database.
 *   - **Empty vocabulary.** `bannedClaimVocabulary` always includes `COMPLIANCE_LEXICON` and the
 *     unpermitted `PROVIDER_TITLES`, so no `CompliancePolicy` — not even one with no banned terms and
 *     medical claims permitted — can make it empty. The guard is therefore unreachable today and is kept
 *     because what it guards is a SHIPPED LIST in another module: emptying that list would silently turn
 *     every lint into a pass. `suggestion.test.ts` asserts the unreachability rather than this comment
 *     claiming it, so the day the lexicon is emptied the claim fails instead of the lint.
 *
 * Both are throws rather than refusals: an empty vocabulary is a broken profile and an empty draft is a
 * broken extractor, and neither is a bad suggestion a human should be shown.
 */
export function judgeSeoSuggestion(input: SeoSuggestionDraftInput): SeoSuggestionVerdict {
  if (input.afterRegions.every((region) => region.text.trim() === '')) {
    throw new AppError(
      'invariant_violated',
      'the drafted after-copy is empty, so the publication copy lint would examine nothing and the ' +
        'suggestion would be stored as linted (ADR 0002). An answer with no copy in it is not a ' +
        'suggestion — it is a model refusal the caller should have recognised.',
      { details: { code: 'seo_suggestion_after_copy_empty', surface: input.surface } },
    )
  }
  const termsChecked = bannedClaimVocabulary(input.policy).length
  if (termsChecked === 0) {
    throw new AppError(
      'invariant_violated',
      'the banned-claim vocabulary is empty, so the publication copy lint would pass every draft. A ' +
        'suggestion recorded as linted against nothing is evidence for a check that examined nothing ' +
        '(ADR 0002).',
      { details: { code: 'seo_suggestion_lint_vocabulary_empty', surface: input.surface } },
    )
  }

  const rules: string[] = []
  const targetRefusal = suggestionTargetRefusal(input.target)
  if (targetRefusal !== null) rules.push(targetRefusal.rule)

  const escalations = screenSeoDraft({
    answer: input.answer,
    medicalClaimsPermitted: input.policy.medicalClaimsPermitted,
  })
  for (const escalation of escalations) {
    if (!rules.includes(escalation.rule)) rules.push(escalation.rule)
  }

  const copyFindings = publicationCopyFindings(input.afterRegions, input.policy)
  for (const finding of copyFindings) {
    if (!rules.includes(finding.rule)) rules.push(finding.rule)
  }

  if (rules.length === 0) {
    return { kind: 'proposed', lintVersion: SEO_SUGGESTION_LINT_VERSION, termsChecked }
  }
  return {
    kind: 'refused',
    lintVersion: SEO_SUGGESTION_LINT_VERSION,
    termsChecked,
    rules: Object.freeze(rules),
    escalations,
    copyFindings,
  }
}

/** The refusals as lines, for an audit row's detail and for a failing test's message. */
export function formatSeoSuggestionRefusal(verdict: SeoSuggestionVerdict): string {
  if (verdict.kind === 'proposed') return ''
  return [
    ...verdict.escalations.map((e) => `${e.rule}  matched ${JSON.stringify(e.matched)}`),
    ...verdict.copyFindings.map((f) => `${f.rule}  ${f.region}  ${f.why}`),
  ].join('\n')
}
