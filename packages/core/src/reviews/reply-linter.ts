import type { DetectableReviewLanguage } from '@berelax/shared'
import {
  type CompliancePolicy,
  containsPhrase,
  lintPublicDisplayName,
} from '../compliance/lexicon.ts'
import {
  containsArabicPhrase,
  matchReviewEscalations,
  type ReviewEscalationCategory,
  type ReviewEscalationLexicon,
  reviewTokens,
} from './escalation-lexicon.ts'
import { textNamesAnIndividual } from './individuals.ts'
import { detectReviewLanguage } from './language.ts'
import {
  admitsFaultOrLiability,
  mentionsMoneyOrDiscount,
  repeatsReviewText,
} from './prompt-builder.ts'
import {
  isHouseReplyRendering,
  REPLY_LENGTH_CAP,
  type ReplyLintCandidate,
  type ReplyLinter,
  type ReplyLintFinding,
  renderFinalReply,
} from './reply-lint-contract.ts'

/**
 * The reply linter (G-REV-05): the pure half of the send-path chokepoint.
 *
 * docs/10 §6 states the requirement in one clause — *"the same linter runs"* in both delivery modes — and
 * the manifest names what it must refuse: no medical claim from the regulatory-profile lexicon, no
 * therapist named, no discount or refund promise, never quote a reviewer's health disclosure back at them
 * publicly, never confirm a named reviewer was a client, never admit fault, a 1,200-character cap, and a
 * language match. This module is those rules. `packages/google/src/reviews/deliver.ts` is the chokepoint
 * that runs them, and `packages/db/migrations/0113_reply_lint_stamp.sql` is the floor underneath it.
 *
 * ## Nothing here is a second list
 *
 * Every vocabulary this module compares against already exists and is reached rather than restated, and
 * that is the whole shape of the file:
 *
 *   - the **medical-claim** half is `lintPublicDisplayName` against `regulatory_profile` (0004, ADR 0020) —
 *     the same function a service display name goes through (B-CAT-05) and the same one CMS copy goes
 *     through (W-SITE-07). A published reply is public copy, so it is linted as public copy, and the rule
 *     names it reports are `PUBLIC_NAME_RULES` rather than new inventions. That is what makes the
 *     licence flip reach this linter: the day Y1-licence is answered and the profile row changes, the reply
 *     linter becomes stricter or looser with no deploy, which a list in this file could not do;
 *   - the **health-disclosure** half is the escalation lexicon's `injury`, `illness` and `pain` categories
 *     (G-REV-03), asked a new question: not "may a machine answer this review" but "has the answer repeated
 *     what the reviewer disclosed";
 *   - the money, fault and quote-back checks are `mentionsMoneyOrDiscount`, `admitsFaultOrLiability` and
 *     `repeatsReviewText` from G-REV-04's response screen. One list, two callers: a term added for the
 *     screen and not for the linter would be a term the published reply had never been compared against;
 *   - the individual-naming heuristic is `textNamesAnIndividual`, already shared between the routing table
 *     and the response screen (G-REV-04's note).
 *
 * The only new vocabulary is the **roster**, and it is not vocabulary at all: it is a live read of
 * `employee.display_name`, passed in as {@link ReplyLintContext.rosterDisplayNames}. That is the point of
 * the acceptance criterion — adding a therapist changes the answer with no code change and no lexicon edit
 * — and it is why the roster arrives as an argument rather than being fetched here: `packages/core` reads
 * no database.
 *
 * ## Why the heuristic and the roster are two rules and not one
 *
 * `textNamesAnIndividual` fires on a provider title or on a capitalised word that is not sentence-initial.
 * It therefore misses exactly the spellings a hurried human writes — *"thanks, mina will be glad"*,
 * *"MINA says thank you"* — because a lower-case word carries no capital and an all-caps word reads as
 * emphasis. The roster rule catches those, and keeping the two apart is what makes the roster claim
 * provable: a draft that trips only `names_a_rostered_therapist` passes before the therapist is on the
 * roster and fails after, and the rule name is the difference.
 *
 * ## What is judged: the RENDERED reply
 *
 * Every rule but one reads {@link renderFinalReply}'s output — the draft plus the signature — and not the
 * draft. The cap criterion says so explicitly, and the rest follows for the same reason: a signature is
 * published bytes, so a signature carrying a banned claim, a staff title or the wrong language is a
 * non-compliant reply whatever the draft said. The consequence is stated rather than discovered: a
 * signature has to pass the linter too, and one that does not cannot be configured into a reply.
 *
 * The exception is `not_a_house_skeleton_rendering`, which is a statement about the generator and is asked
 * of `candidate.draft`. See {@link ReplyOrigin} in the seam.
 *
 * ## The boundary this module does not pretend to cover
 *
 * `lintPublicDisplayName` is Latin-script by construction — `lexiconTokens` splits on everything outside
 * `[a-z0-9]`, so an Arabic reply produces no claim findings at all. That is the same documented boundary
 * the display-name lint carries (Arabic public copy is linted where it is rendered, W-SITE-05 and
 * W-SITE-10), and it is recorded here rather than papered over with a guessed Arabic claim list: a term
 * list this build invented would be indistinguishable from one the profile had configured. Every OTHER
 * rule below is bilingual, because every other vocabulary it reaches already carries its Arabic spellings.
 *
 * Pure: the profile, the roster, the lexicon and the language are arguments. No clock, no I/O.
 */

/**
 * Every rule the send-path linter can report, in the order a reader meets them.
 *
 * A superset of `HOUSE_DRAFT_LINT_RULES`, which `reply-linter.test.ts` asserts rather than this comment
 * claiming: the seam promises G-REV-05's list is a superset, and a promise in a doc comment is not one.
 *
 * The five `PUBLIC_NAME_RULES` appear verbatim because the reply goes through the publication lint
 * itself. `unpermitted_staff_title` is weaker than `names_an_individual` for a reply — every provider title
 * trips both — and it is kept rather than filtered because filtering a rule out of a shared lint's output
 * is an exemption, and an exemption invented here would be invisible to the lint's own tests.
 */
export const SEND_PATH_LINT_RULES = [
  'not_a_house_skeleton_rendering',
  'banned_claim_term',
  'service_outside_the_licence',
  'reads_as_solicitation',
  'unpermitted_staff_title',
  'style_as_therapist_attribute',
  'names_a_rostered_therapist',
  'names_an_individual',
  'confirms_the_reviewer_was_a_client',
  'promises_discount_or_refund',
  'admits_fault',
  'echoes_health_disclosure',
  'echoes_review_text',
  'exceeds_length_cap',
  'language_mismatch',
] as const
export type SendPathLintRule = (typeof SEND_PATH_LINT_RULES)[number]

/**
 * The version stamped onto every reply this rule set clears.
 *
 * Named after the unit and counted, not dated: the question it answers is "which rules judged this reply",
 * and changing any rule below means a new entry in {@link SEND_PATH_LINTERS} rather than an edit here —
 * editing the rules under this version would make every stored decision unreproducible, which is the one
 * thing `reply_lint_version` exists to prevent. The same argument `REVIEW_ESCALATION_LEXICON_VERSION` makes.
 *
 * What the version does NOT pin is the regulatory profile or the roster, both of which are live rows. A
 * reply that passed under profile version 1 can fail under version 2, and that is correct — the profile is
 * the licence, not the rule set — but it means reproducing a PASS requires the profile that was in force.
 * `regulatory_profile` is append-only and versioned (0004) so that profile is recoverable; reading it back
 * by version is not built, and is recorded as a NOTE on this unit rather than implied to work.
 */
export const SEND_PATH_LINT_VERSION = 'g-rev-05-send-path-1'

/**
 * The escalation categories in which a reviewer discloses something about their own body.
 *
 * Three of the seven, and the other four are deliberately absent. `injury`, `illness` and `pain` are the
 * categories whose terms are facts about the reviewer — a reaction, a hospital visit, a pregnancy, pain
 * after a treatment — and repeating one in a public reply is the disclosure docs/10 §6 forbids: the
 * reviewer chose to write it, and we would be confirming it under the business's name on a page Google
 * indexes.
 *
 * `staff_conduct`, `refund`, `hygiene` and `legal_threat` are allegations about US. Repeating one back is
 * caught by `admits_fault`, `promises_discount_or_refund` and `echoes_review_text`, and treating them as
 * health disclosures would refuse a reply for containing the word "clean" in answer to a review that used
 * it — which is how a linter stops being read.
 */
export const HEALTH_DISCLOSURE_CATEGORIES: readonly ReviewEscalationCategory[] = Object.freeze([
  'injury',
  'illness',
  'pain',
])

/** What the send-path linter needs from the world, all of it read by the caller. */
export interface ReplyLintContext {
  /** `regulatory_profile_current`, mapped from `CompliancePolicyRow`. Never a constant. */
  readonly policy: CompliancePolicy
  /**
   * Every display name the employee roster currently holds, as the admin set them.
   *
   * Live, not cached: the criterion is that adding a therapist changes the answer with no code change. A
   * name is matched as a phrase of tokens, so a two-word display name is refused only when both words
   * appear together, and case, Arabic clitics and punctuation are folded by the shared matchers.
   */
  readonly rosterDisplayNames: readonly string[]
  /** The escalation lexicon in force, for the health-disclosure rule. */
  readonly lexicon: ReviewEscalationLexicon
}

/** A term written in Arabic script, which decides which of the two phrase matchers compares it. */
const ARABIC_TERM = /[؀-ۿ]/

/**
 * Whether a name — one word or several — appears in the reply, in either script.
 *
 * Both matchers reused rather than reimplemented, exactly as `mentionsAny` does in the prompt builder: the
 * Arabic one knows the clitic prefixes, so a name arriving with the conjunction attached still matches, and
 * the Latin one knows the inflections a token survives.
 *
 * A name whose tokens are shorter than two characters together is skipped. A one-character display name is
 * not a name, and matching one would refuse every reply containing that letter as a word.
 */
function replyNamesPerson(replyTokens: readonly string[], name: string): boolean {
  const tokens = reviewTokens(name)
  if (tokens.join('').length < 2) return false
  return ARABIC_TERM.test(name)
    ? containsArabicPhrase(replyTokens, name)
    : containsPhrase(replyTokens, name)
}

/** The health-disclosure term the reply repeats, or `null`. */
function echoedHealthDisclosure(
  reply: string,
  reviewText: string | null,
  lexicon: ReviewEscalationLexicon,
): string | null {
  const matches = matchReviewEscalations(reviewText, lexicon)
  if (matches.length === 0) return null
  const spoken = reviewTokens(reply)
  for (const match of matches) {
    if (!HEALTH_DISCLOSURE_CATEGORIES.includes(match.category)) continue
    const repeated = ARABIC_TERM.test(match.term)
      ? containsArabicPhrase(spoken, match.term)
      : containsPhrase(spoken, match.term)
    if (repeated) return match.term
  }
  return null
}

/** Why each rule refuses, in a sentence, for the message the approval queue shows the owner. */
const WHY: Readonly<Record<SendPathLintRule, string>> = Object.freeze({
  not_a_house_skeleton_rendering:
    'the draft is not one of the sentences this business has approved. A machine draft is a rendering ' +
    'of a house skeleton, so one that is not came from somewhere unaccounted for',
  banned_claim_term:
    'the reply makes a claim the regulatory profile in force does not permit. The licence is a massage ' +
    'and spa activity, so the claim describes something the premises may not deliver (ADR 0020)',
  service_outside_the_licence:
    'the reply names an activity this licence does not cover. Naming it publicly advertises it, which ' +
    'is actionable whether or not anybody ever delivers it',
  reads_as_solicitation:
    'the reply carries wording that reads as a solicitation. For a massage premises in this market that ' +
    'is the accusation that closes it, and no licence class makes it acceptable',
  unpermitted_staff_title:
    'the reply uses a staff title the regulatory profile does not permit in public copy',
  style_as_therapist_attribute:
    'the reply attaches a treatment style to a person. A style is how a treatment is delivered ' +
    '(ADR 0021) and says nothing about who is on the premises',
  names_a_rostered_therapist:
    'the reply contains the display name of somebody on the staff roster. Confirming publicly who was ' +
    'on shift is a confidentiality breach in this industry (docs/07 §4), whatever the reviewer said',
  names_an_individual:
    'the reply names or describes an individual. Confirming publicly who was on shift, or that a ' +
    'named reviewer was a client, is a confidentiality breach in this industry (docs/07 §4)',
  confirms_the_reviewer_was_a_client:
    "the reply repeats the reviewer's own display name, which confirms publicly that a named person " +
    'was a client here. The reviewer may say so; the business may not (docs/07 §4)',
  promises_discount_or_refund:
    'the reply mentions a refund, a discount or compensation. Money is never offered on a public ' +
    'listing (docs/07 §4)',
  admits_fault:
    'the reply accepts blame or liability. A public admission is a legal statement and is the ' +
    "owner's to make",
  echoes_health_disclosure:
    'the reply repeats a health disclosure the reviewer made about themselves. They chose to write it; ' +
    'confirming it under the business’s name on an indexed page is a different act (docs/10 §6)',
  echoes_review_text:
    "the reply repeats the reviewer's own words back at them publicly, which is how a health " +
    'disclosure in a review ends up quoted on a public listing (docs/10 §6)',
  exceeds_length_cap: `the reply, including any signature, is longer than the ${REPLY_LENGTH_CAP}-character cap`,
  language_mismatch:
    'the reply is not in the language it claims, or not in the language of the review it answers',
})

/**
 * The linter, bound to the profile and roster in force.
 *
 * A factory and not a constant, because two of its three inputs are rows. It returns the seam's
 * {@link ReplyLinter}, so the generator can be handed this instead of `HOUSE_DRAFT_LINTER` with no change
 * to `generateReplyDrafts` — which is what the seam was declared for.
 *
 * Deliberately NOT injectable on the send path: `deliverApprovedReply` constructs it from the database
 * itself. A delivery function that accepted a linter would be a chokepoint a caller could walk past by
 * handing it a permissive one, which is the bypass the acceptance criterion is about.
 */
export function sendPathReplyLinter(context: ReplyLintContext): ReplyLinter {
  return {
    version: SEND_PATH_LINT_VERSION,
    lint(candidate: ReplyLintCandidate): readonly ReplyLintFinding[] {
      const findings: ReplyLintFinding[] = []
      const finding = (rule: SendPathLintRule, why?: string): void => {
        findings.push({ rule, why: why ?? WHY[rule] })
      }

      // The published bytes. Everything below this line reads `reply`, not `candidate.draft`, except the
      // one rule that is a statement about the generator rather than about the sentence.
      const reply = renderFinalReply(candidate)
      const spoken = reviewTokens(reply)

      if (
        (candidate.origin ?? 'machine_draft') === 'machine_draft' &&
        !isHouseReplyRendering(candidate.draft, candidate.language)
      ) {
        finding('not_a_house_skeleton_rendering')
      }

      // The publication lint, whole, reporting its own rule names. A reply is public copy.
      for (const publicationFinding of lintPublicDisplayName(reply, context.policy)) {
        finding(
          publicationFinding.rule,
          `${WHY[publicationFinding.rule]} — "${publicationFinding.term}"`,
        )
      }

      for (const name of context.rosterDisplayNames) {
        if (replyNamesPerson(spoken, name)) {
          finding('names_a_rostered_therapist')
          break
        }
      }
      if (textNamesAnIndividual(reply)) finding('names_an_individual')

      const reviewer = candidate.reviewerDisplayName ?? null
      if (reviewer !== null && replyNamesPerson(spoken, reviewer)) {
        finding('confirms_the_reviewer_was_a_client')
      }

      if (mentionsMoneyOrDiscount(reply)) finding('promises_discount_or_refund')
      if (admitsFaultOrLiability(reply)) finding('admits_fault')

      const disclosure = echoedHealthDisclosure(reply, candidate.reviewText, context.lexicon)
      if (disclosure !== null) finding('echoes_health_disclosure')
      if (repeatsReviewText(reply, candidate.reviewText)) finding('echoes_review_text')

      // Code points, not UTF-16 units, and the bidi isolates an Arabic reply carries around a Latin
      // numeral count: they are bytes Google receives and characters the reply is charged for, so a cap
      // that skipped them would report a reply as inside a limit it is outside.
      if ([...reply].length > REPLY_LENGTH_CAP) finding('exceeds_length_cap')

      if (languageMismatches(reply, candidate)) finding('language_mismatch')

      return Object.freeze(findings)
    },
  }
}

/**
 * Whether the reply is in the wrong language, which is two questions under one rule name.
 *
 * The reply must be in the language it CLAIMS — a caller that declares `'ar'` over English text has
 * declared something false — and, when the review has a language this build can identify, it must be that
 * one. Both are the same failure to the reviewer: a reply in a language they did not write in, published
 * under the business's name.
 *
 * A review with no identifiable language leaves the second question unasked rather than answered `'en'`.
 * A star-only review has no language at all (docs/10 §7 calls it common), and guessing one here would be
 * the policy decision `detectReviewLanguage` exists to refuse to make.
 */
function languageMismatches(reply: string, candidate: ReplyLintCandidate): boolean {
  if (detectReviewLanguage(reply) !== candidate.language) return true
  const reviewLanguage = detectReviewLanguage(candidate.reviewText)
  return reviewLanguage !== 'unknown' && reviewLanguage !== candidate.language
}

/**
 * Every rule set a stored `reply_lint_version` can name.
 *
 * The same device `REVIEW_ESCALATION_LEXICONS` is: a stored version resolves back to the rules that took
 * the decision, so "why was this reply cleared" is answerable against the rules that cleared it rather
 * than against today's. A version this build does not know resolves to `null` and the caller refuses,
 * which is the safe direction — a reply nobody can re-judge is not one to publish again.
 */
export const SEND_PATH_LINTERS: Readonly<
  Record<string, (context: ReplyLintContext) => ReplyLinter>
> = Object.freeze({
  [SEND_PATH_LINT_VERSION]: sendPathReplyLinter,
})

/** The linter a stored version names, bound to the context, or `null` if this build has never had it. */
export function replyLinterFor(version: unknown, context: ReplyLintContext): ReplyLinter | null {
  if (typeof version !== 'string') return null
  const build = SEND_PATH_LINTERS[version]
  return build === undefined ? null : build(context)
}

/** The candidate a send path judges, with the two fields the seam leaves optional made explicit. */
export interface SendPathReplyCandidate {
  readonly draft: string
  readonly language: DetectableReviewLanguage
  readonly reviewText: string | null
  readonly reviewerDisplayName: string | null
  readonly signature: string | null
}
