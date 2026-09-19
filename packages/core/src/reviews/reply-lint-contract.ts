import type { DetectableReviewLanguage } from '@berelax/shared'
import { textNamesAnIndividual } from './individuals.ts'
import { detectReviewLanguage } from './language.ts'
import {
  admitsFaultOrLiability,
  mentionsMoneyOrDiscount,
  repeatsReviewText,
} from './prompt-builder.ts'
import {
  MAX_RENDERED_ASPECTS,
  REPLY_ASPECTS,
  REPLY_SKELETONS,
  type ReplyAspect,
  type ReplySkeletonId,
  renderReplySkeleton,
} from './skeletons.ts'

/**
 * The reply linter **seam**, and the subset of it this unit implements and tests against.
 *
 * ## Why this file exists at all, and what it is not
 *
 * G-REV-04's acceptance criteria are written against "the G-REV-05 linter", and G-REV-05 is not built.
 * Two of them cannot be asserted without a linter that really runs: the red-team corpus must produce no
 * draft that passes one, and a five-star review with NULL comment text must produce a draft that does.
 * Asserting either against a linter that does not exist would be a green test about nothing.
 *
 * So this unit declares the **interface** the generator depends on — {@link ReplyLinter} — and ships one
 * real implementation of it, {@link HOUSE_DRAFT_LINTER}, covering the rules a *machine-generated* draft
 * can be judged by with no database and no regulatory profile. The generator takes a linter as an
 * argument and has no default, so G-REV-05 replaces the implementation without touching the generator,
 * and the criteria above are asserted against something that runs today.
 *
 * **G-REV-05 still owns**, and this file deliberately does not attempt:
 *
 *   - the banned-claims lexicon read from `regulatory_profile` (a row, not a constant);
 *   - therapist-name detection against the **live employee roster** (an integration concern — the
 *     criterion is that adding a therapist changes the answer with no code change);
 *   - the health-disclosure echo rule in its full form, including the fixture pair that proves an
 *     identical draft passes when the review carries no health phrase;
 *   - the 1,200-character cap applied to the *final rendered reply including any auto-appended
 *     signature* — there is no signature layer yet, so the cap here is on the draft;
 *   - the send-path chokepoint, so that an unlinted draft is refused by the delivery function itself;
 *   - recording the lint version and content hash on the approved reply.
 *
 * ## The rule that only this unit can own
 *
 * `not_a_house_skeleton_rendering` is the centrepiece, and it belongs here rather than in G-REV-05
 * because it is a statement about the generator: a draft is acceptable only if it is one of the finitely
 * many strings {@link renderReplySkeleton} can produce. {@link HOUSE_REPLY_RENDERINGS} is that closed
 * set, enumerated — four skeletons times two languages times the 37 aspect subsets of size two or
 * fewer. Membership is checked rather than provenance being believed, so the rule holds for a draft that
 * arrives with a lying provenance, or with none.
 *
 * That is what makes "zero injection payloads produce a draft that passes the linter" a structural
 * claim. It does not depend on a lexicon being complete, which is the usual way this kind of assurance
 * rots: every content rule below can miss a phrase nobody thought of, and this one cannot, because a
 * phrase nobody thought of is not in the set.
 *
 * The content rules are kept anyway, and they are not redundant. They are what catches a draft that came
 * from somewhere else — a hand-typed reply, a future free-generation path, a skeleton someone adds
 * carelessly — and they are the rules G-REV-05 will deepen rather than replace.
 */

/** Every rule this implementation can report. G-REV-05's list is a superset. */
export const HOUSE_DRAFT_LINT_RULES = [
  'not_a_house_skeleton_rendering',
  'exceeds_length_cap',
  'names_an_individual',
  'promises_discount_or_refund',
  'admits_fault',
  'echoes_review_text',
  'language_mismatch',
] as const
export type HouseDraftLintRule = (typeof HOUSE_DRAFT_LINT_RULES)[number]

/**
 * The published cap, from docs/10 §6 by way of G-REV-05's criteria.
 *
 * Applied to the draft here. G-REV-05 applies it to the *rendered reply including any auto-appended
 * signature*, which is the number that matters on the send path and which cannot be computed until a
 * signature layer exists. The two are the same today because there is no signature.
 */
export const REPLY_LENGTH_CAP = 1_200

/** A candidate draft, and what the linter needs in order to judge it. */
export interface ReplyLintCandidate {
  readonly draft: string
  /** The language the reply claims to be in. The linter checks the claim rather than trusting it. */
  readonly language: DetectableReviewLanguage
  /** The review this answers, for the echo rule. `null` for a star-only review. */
  readonly reviewText: string | null
}

export interface ReplyLintFinding {
  readonly rule: string
  /** Why, in a sentence, for the message the approval queue shows. */
  readonly why: string
}

/**
 * The seam. A linter has a version and answers with every reason a draft may not be published.
 *
 * Every reason, not the first: an owner who is told about one problem fixes it and resubmits, and two
 * round trips for two problems is how a queue stops being read.
 */
export interface ReplyLinter {
  readonly version: string
  lint(candidate: ReplyLintCandidate): readonly ReplyLintFinding[]
}

/** The version this implementation stamps. G-REV-05's will differ, which is the point of recording it. */
export const HOUSE_DRAFT_LINT_VERSION = 'g-rev-04-house-draft-1'

/** Every aspect subset a rendering can carry: the empty set, the singletons, and the pairs. */
function aspectSubsets(): readonly (readonly ReplyAspect[])[] {
  const subsets: ReplyAspect[][] = [[]]
  for (let first = 0; first < REPLY_ASPECTS.length; first += 1) {
    subsets.push([REPLY_ASPECTS[first] as ReplyAspect])
    for (let second = first + 1; second < REPLY_ASPECTS.length; second += 1) {
      subsets.push([REPLY_ASPECTS[first] as ReplyAspect, REPLY_ASPECTS[second] as ReplyAspect])
    }
  }
  return subsets
}

/**
 * Every string this build can publish, per language.
 *
 * Enumerated at module load, which is cheap — 148 strings per language — and deterministic, because
 * {@link renderReplySkeleton} is a pure function of three enumerable arguments. A rendering nobody can
 * reach through {@link renderReplySkeleton} is not in here, and a draft not in here did not come from
 * this generator.
 */
export const HOUSE_REPLY_RENDERINGS: Readonly<
  Record<DetectableReviewLanguage, ReadonlySet<string>>
> = Object.freeze({
  en: renderingsFor('en'),
  ar: renderingsFor('ar'),
})

function renderingsFor(language: DetectableReviewLanguage): ReadonlySet<string> {
  const all = new Set<string>()
  for (const skeleton of REPLY_SKELETONS) {
    for (const aspects of aspectSubsets()) {
      all.add(renderReplySkeleton({ skeleton, aspects, language }))
    }
  }
  return all
}

/**
 * Whether a draft is a rendering of a declared skeleton in the declared language.
 *
 * Exported so the generator can assert it about its own output before writing it, which is a second
 * application of one rule in the same shape as `autoSendFloor` re-applying docs/07 §4 row 1: the
 * generator can only produce a rendering, so this can only fail if the generator is broken — which is
 * precisely when nothing should be written.
 */
export function isHouseReplyRendering(draft: string, language: DetectableReviewLanguage): boolean {
  return HOUSE_REPLY_RENDERINGS[language].has(draft)
}

/** The rendering for one (skeleton, aspects, language), for a test that builds an expectation. */
export function houseRendering(args: {
  readonly skeleton: ReplySkeletonId
  readonly aspects: readonly ReplyAspect[]
  readonly language: DetectableReviewLanguage
}): string {
  return renderReplySkeleton(args)
}

const WHY: Readonly<Record<HouseDraftLintRule, string>> = Object.freeze({
  not_a_house_skeleton_rendering:
    'the draft is not one of the sentences this business has approved. Every published reply is a ' +
    'rendering of a house skeleton, so a draft that is not one came from somewhere unaccounted for',
  exceeds_length_cap: `the reply is longer than the ${REPLY_LENGTH_CAP}-character cap`,
  names_an_individual:
    'the reply names or describes an individual. Confirming publicly who was on shift, or that a ' +
    'named reviewer was a client, is a confidentiality breach in this industry (docs/07 §4)',
  promises_discount_or_refund:
    'the reply mentions a refund, a discount or compensation. Money is never offered on a public ' +
    'listing (docs/07 §4)',
  admits_fault:
    'the reply accepts blame or liability. A public admission is a legal statement and is the ' +
    "owner's to make",
  echoes_review_text:
    "the reply repeats the reviewer's own words back at them publicly, which is how a health " +
    'disclosure in a review ends up quoted on a public listing (docs/10 §6)',
  language_mismatch:
    'the reply is not in the language it claims, so it is not in the language of the review it answers',
})

/**
 * The implementation. Pure, and total over any string.
 *
 * `MAX_RENDERED_ASPECTS` is referenced so that raising the cap without re-deriving
 * {@link HOUSE_REPLY_RENDERINGS} fails to compile rather than silently making the closed set an
 * incomplete list — the enumeration above builds subsets of size two because that is the cap, and the
 * two numbers must move together.
 */
export const HOUSE_DRAFT_LINTER: ReplyLinter = {
  version: HOUSE_DRAFT_LINT_VERSION,
  lint(candidate: ReplyLintCandidate): readonly ReplyLintFinding[] {
    const findings: ReplyLintFinding[] = []
    const finding = (rule: HouseDraftLintRule): void => {
      findings.push({ rule, why: WHY[rule] })
    }

    if (MAX_RENDERED_ASPECTS !== 2) {
      // Not reachable in a build that compiles: it is here so that changing the constant without
      // changing `aspectSubsets` is caught by the linter's own tests rather than by a published reply
      // that no rule recognised.
      finding('not_a_house_skeleton_rendering')
      return findings
    }

    if (!isHouseReplyRendering(candidate.draft, candidate.language)) {
      finding('not_a_house_skeleton_rendering')
    }
    if ([...candidate.draft].length > REPLY_LENGTH_CAP) finding('exceeds_length_cap')
    if (textNamesAnIndividual(candidate.draft)) finding('names_an_individual')
    if (mentionsMoneyOrDiscount(candidate.draft)) finding('promises_discount_or_refund')
    if (admitsFaultOrLiability(candidate.draft)) finding('admits_fault')
    if (repeatsReviewText(candidate.draft, candidate.reviewText)) finding('echoes_review_text')
    if (detectReviewLanguage(candidate.draft) !== candidate.language) finding('language_mismatch')

    return findings
  },
}

/** True when nothing was found. The question the generator and the send path actually ask. */
export function draftPassesLint(linter: ReplyLinter, candidate: ReplyLintCandidate): boolean {
  return linter.lint(candidate).length === 0
}
