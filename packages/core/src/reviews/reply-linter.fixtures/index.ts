import type { DetectableReviewLanguage } from '@berelax/shared'
import type { CompliancePolicy } from '../../compliance/lexicon.ts'
import { FSI, PDI } from '../../text/bidi.ts'
import { REPLY_LENGTH_CAP, type ReplyOrigin } from '../reply-lint-contract.ts'
import type { SendPathLintRule } from '../reply-linter.ts'

/**
 * One known-bad reply per rule, and the pairs that prove three rules are about what they claim.
 *
 * ADR 0003 is about a gate's fixture; this is the same argument one layer in. A rule nobody has seen refuse
 * anything may not be a rule at all, and the way that happens here is specific: every rule below reaches a
 * vocabulary that lives somewhere else — the regulatory profile, the escalation lexicon, the response
 * screen's term lists, the employee roster — so a rule can stop firing because a list moved, with nothing
 * in this package changing. `reply-linter.test.ts` drives every fixture and asserts the rule BY NAME, and
 * refuses to pass if there are fewer fixtures than rules.
 *
 * ## Why a directory and not a constant in the linter
 *
 * Two suites read these. The unit test runs them against {@link FIXTURE_COMPLIANCE_POLICY}, a stand-in with
 * one banned term in it, because a unit test that restated the profile's fourteen terms would be a second
 * copy of the profile. `packages/google/src/reviews/reply-delivery.itest.ts` runs the SAME fixtures against
 * `regulatory_profile_current` read out of the database, which is the check that holds the stand-in and the
 * row together: a profile that stopped banning `therapeutic` fails there rather than passing quietly here.
 *
 * ## What is not in here
 *
 * No invented person. Every fixture that has to contain a name contains a record LABEL — the shape
 * `packages/fixtures/src/synthetic.ts` argues for and `packages/core/src/reviews/notification-fixtures.ts`
 * already uses — and the two that matter are exported as constants so the integration test inserts the same
 * bytes it lints against rather than a second spelling of them.
 *
 * Several fixtures deliberately name a word the reply must not contain — `cupping`, `full service`, `nurse`
 * — and each one is a term of a shipped lexicon, quoted from it. None of them is a claim about this
 * business; they are the strings the lexicon exists to refuse.
 */

/** One deliberately unpublishable reply, and the rule it must be refused by. */
export interface KnownBadReply {
  readonly rule: SendPathLintRule
  /** Why this reply is the one worth having, in a sentence. Read by a person, not by a matcher. */
  readonly why: string
  readonly draft: string
  readonly language: DetectableReviewLanguage
  readonly reviewText: string | null
  readonly reviewerDisplayName: string | null
  readonly signature: string | null
  readonly origin: ReplyOrigin
}

/**
 * The staff display name the roster fixture uses, in the spelling an admin would have typed.
 *
 * A record label rather than a name (brief rule 10, ADR 0020): the nineteen therapists have no display
 * names and this build does not invent one. It is exported because the integration test INSERTS it into
 * `employee.display_name` and then lints {@link ROSTERED_NAME_REPLY} against the live roster — two uses of
 * one string, so the test cannot pass against a name the roster does not hold.
 *
 * Written into the fixture reply in LOWER CASE on purpose. `textNamesAnIndividual` skips a lower-case word,
 * so `names_an_individual` cannot fire on it and the only rule left to refuse it is the roster one — which
 * is what makes "adding a therapist changes the answer" a test rather than an assertion.
 */
export const FIXTURE_ROSTER_DISPLAY_NAME = 'Roster Fixture 05'

/** The reviewer label the `confirms_the_reviewer_was_a_client` fixture answers. Not a name. */
export const FIXTURE_REVIEWER_DISPLAY_NAME = 'Fixture Reviewer B'

/** The label Google gives a reviewer who has not set one. The default for every other fixture. */
export const ANONYMOUS_REVIEWER = 'A Google user'

/**
 * A signature, for the one criterion that needs the cap measured over something longer than the draft.
 *
 * House vocabulary — `the front desk` is a phrase two of the four skeletons already close with — and
 * deliberately not a business name, a person or a legal entity (brief rule 15). What the business actually
 * signs its replies with is `OPEN-QUESTIONS Y9-reply-signature`.
 */
export const FIXTURE_REPLY_SIGNATURE = '— the front desk'

/**
 * A clean reply, which is the control every rule assertion needs.
 *
 * Without it the whole file is satisfied by a linter that refuses everything, which is the vacuous pass
 * ADR 0003 and the brief's rule 3 are both about.
 */
export const CLEAN_REPLY = 'Thank you for the feedback. We look forward to welcoming you back.'

/** The frame every English fixture is built on, so the difference between two fixtures is the clause. */
const FRAME = 'Thank you for the feedback.'

/**
 * An English reply of exactly `codePoints` code points that breaks no rule but the one under test.
 *
 * Built rather than written out, because the cap criterion asks for 1,200 and 1,201 exactly and a literal
 * of that length is a string nobody can check by reading. Every word in it is one the lexicons permit, and
 * the filler is the single letter `a`, which no term list contains.
 */
export function paddedEnglishReply(codePoints: number): string {
  const unit = ' We are glad the visit went well.'
  let text = FRAME
  while (text.length + unit.length <= codePoints) text += unit
  while (text.length < codePoints) text += codePoints - text.length === 1 ? '.' : ' a'
  return text
}

/**
 * The stand-in profile.
 *
 * `permittedPublicTitles` carries the three titles 0004 seeds, so that `therapist` is PERMITTED here: the
 * `names_an_individual` fixture uses that word and must be refused for naming a person rather than for
 * carrying an unpermitted title, and the two rules would otherwise be indistinguishable.
 *
 * `bannedClaimTerms` carries ONE term rather than the profile's fourteen. The point of the field is that
 * the list is data, and a copy of the data here would be the second statement that drifts; one term is
 * enough to prove the rule reaches the profile, and the integration test proves the profile still holds it.
 */
export const FIXTURE_COMPLIANCE_POLICY: CompliancePolicy = Object.freeze({
  bannedClaimTerms: Object.freeze(['therapeutic']),
  permittedPublicTitles: Object.freeze(['Therapist', 'Senior Therapist', 'Spa Therapist']),
  medicalClaimsPermitted: false,
})

/** The health-disclosure fixture's reply. One reply, two reviews — see {@link HEALTH_DISCLOSURE_PAIR}. */
const HEALTH_ECHO_REPLY = `${FRAME} We are glad the visit was comfortable while you were pregnant.`

/**
 * The pair that makes `echoes_health_disclosure` a claim about the REVIEW rather than about the reply.
 *
 * The identical reply is refused against a review that discloses a pregnancy and accepted against one that
 * does not. Without the second half the rule is satisfied by a linter carrying a list of health words and
 * refusing any reply containing one — which would refuse the reply above for a review that never mentioned
 * it, and which is a different rule with the same name.
 *
 * `pregnant` is in the escalation lexicon's `illness` category and is NOT in
 * `regulatory_profile.banned_claim_terms` (which carries `prenatal`), so the criterion's "appearing only in
 * the review text and not in the banned-claims lexicon" is a property of the chosen word and not a hope.
 */
export const HEALTH_DISCLOSURE_PAIR = Object.freeze({
  reply: HEALTH_ECHO_REPLY,
  language: 'en' as DetectableReviewLanguage,
  /** Discloses a pregnancy. The reply repeats it. */
  reviewWithDisclosure: 'I told the front desk I was pregnant and they were very careful with me.',
  /** The same review with the disclosure removed, and nothing else changed that any rule can read. */
  reviewWithout: 'The front desk was helpful and they were careful with me.',
})

/** An Arabic review, for the language pair. Calm, clean, good reception: no escalation term in it. */
export const ARABIC_REVIEW = 'المكان هادئ ونظيف والاستقبال ممتاز.'

/** The Arabic house closing pair, which is what a compliant Arabic reply looks like. */
export const ARABIC_REPLY = 'شكراً لك على ملاحظاتك، وقد قرأناها بعناية. نتطلع إلى استقبالك مرة أخرى.'

/**
 * The same Arabic reply with a Latin numeral bidi-isolated inside it.
 *
 * `FSI` … `PDI` from `packages/core/src/text/bidi.ts` (ADR 0011), in the escape form the invisible-character
 * gate requires, because a literal isolate in source is the Trojan Source specimen that gate refuses.
 *
 * The claim it carries is narrow and worth asserting: the isolates are separators to every token matcher,
 * so the reply is still Arabic and still passes — and the isolates DO count towards the 1,200-character
 * cap, because they are bytes Google receives.
 */
export const ARABIC_REPLY_WITH_ISOLATED_NUMERAL = `شكراً لك على ملاحظاتك. مدة الجلسة ${FSI}60${PDI} دقيقة. نتطلع إلى استقبالك مرة أخرى.`

/**
 * One fixture per rule, in the rule order {@link SendPathLintRule} declares.
 *
 * Some fixtures trip a second rule and that is left visible rather than engineered away: `nurse` is both an
 * unpermitted title and a named individual, because `PROVIDER_TITLES` is the list both rules read. The test
 * asserts that each fixture's findings CONTAIN its rule, which is the claim ADR 0003 asks for, and a
 * fixture narrowed until it tripped exactly one rule would be a fixture written to suit the assertion.
 */
export const KNOWN_BAD_REPLIES: readonly KnownBadReply[] = Object.freeze([
  {
    rule: 'not_a_house_skeleton_rendering',
    why: 'a machine draft that is not a rendering of any house skeleton came from somewhere unaccounted for, whatever provenance it arrives with',
    draft: `${FRAME} We will pass it on.`,
    language: 'en',
    reviewText: null,
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: null,
    origin: 'machine_draft',
  },
  {
    rule: 'banned_claim_term',
    why: 'the profile in force bans "therapeutic" as a claim under a non-healthcare licence, and a reply is public copy',
    draft: `${FRAME} We are glad the therapeutic effect lasted.`,
    language: 'en',
    reviewText: null,
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: null,
    origin: 'approved_by_a_human',
  },
  {
    rule: 'service_outside_the_licence',
    why: 'cupping is a Department of Health licensed activity; naming it in a public reply advertises it, and a denial names it just as loudly',
    draft: `${FRAME} We do not offer cupping here.`,
    language: 'en',
    reviewText: null,
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: null,
    origin: 'approved_by_a_human',
  },
  {
    rule: 'reads_as_solicitation',
    why: 'in this trade "full service" reads as a sexual service whatever it was meant to answer, and a public reply is the most-indexed sentence the business writes',
    draft: `${FRAME} We do not offer a full service here.`,
    language: 'en',
    reviewText: null,
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: null,
    origin: 'approved_by_a_human',
  },
  {
    rule: 'unpermitted_staff_title',
    why: 'the profile permits three titles and "nurse" is not one of them; a reply using it claims a clinical role the licence does not carry',
    draft: `${FRAME} We are glad the nurse looked after you.`,
    language: 'en',
    reviewText: null,
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: null,
    origin: 'approved_by_a_human',
  },
  {
    rule: 'style_as_therapist_attribute',
    why: 'a treatment style attached to a person is an advertisement about who is on the premises (ADR 0021), and no capital letter or provider title appears for any other rule to catch',
    draft: `${FRAME} We are glad the thai lady looked after you.`,
    language: 'en',
    reviewText: null,
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: null,
    origin: 'approved_by_a_human',
  },
  {
    rule: 'names_a_rostered_therapist',
    why: 'the roster display name in lower case, which the capitalisation heuristic cannot see — so this fixture is refused by the live roster read and by nothing else',
    draft: `${FRAME} We are glad ${FIXTURE_ROSTER_DISPLAY_NAME.toLowerCase()} was able to help.`,
    language: 'en',
    reviewText: null,
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: null,
    origin: 'approved_by_a_human',
  },
  {
    rule: 'names_an_individual',
    why: 'a provider title identifies who was on shift even with no name beside it, and "therapist" is a title the profile PERMITS — so this is refused for naming a person rather than for an unpermitted title',
    draft: `${FRAME} We are glad the therapist remembered you.`,
    language: 'en',
    reviewText: null,
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: null,
    origin: 'approved_by_a_human',
  },
  {
    rule: 'confirms_the_reviewer_was_a_client',
    why: "repeating the reviewer's own display name confirms publicly that a named person was a client here; the reviewer may say so and the business may not",
    draft: `${FRAME} We are glad ${FIXTURE_REVIEWER_DISPLAY_NAME.toLowerCase()} enjoyed the visit.`,
    language: 'en',
    reviewText: null,
    reviewerDisplayName: FIXTURE_REVIEWER_DISPLAY_NAME,
    signature: null,
    origin: 'approved_by_a_human',
  },
  {
    rule: 'promises_discount_or_refund',
    why: 'money is never offered on a public listing, and a refund named in a reply is a commitment the whole street can read',
    draft: `${FRAME} We have arranged a refund for the visit.`,
    language: 'en',
    reviewText: null,
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: null,
    origin: 'approved_by_a_human',
  },
  {
    rule: 'admits_fault',
    why: 'a public admission is a legal statement; "sorry" is deliberately not the trigger, so the fixture carries an admission and an apology to prove which of the two is refused',
    draft: `${FRAME} This was our mistake and we are sorry.`,
    language: 'en',
    reviewText: null,
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: null,
    origin: 'approved_by_a_human',
  },
  {
    rule: 'echoes_health_disclosure',
    why: 'the reply repeats a pregnancy the reviewer disclosed; the identical reply passes against a review that never mentioned it, which is what HEALTH_DISCLOSURE_PAIR proves',
    draft: HEALTH_DISCLOSURE_PAIR.reply,
    language: 'en',
    reviewText: HEALTH_DISCLOSURE_PAIR.reviewWithDisclosure,
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: null,
    origin: 'approved_by_a_human',
  },
  {
    rule: 'echoes_review_text',
    why: "five of the reviewer's own words in the same order, two of them content-bearing: a quote rather than the function words any two sentences about one visit share",
    draft: `${FRAME} We are glad the rooms were very clean and will pass it on.`,
    language: 'en',
    reviewText: 'The rooms were very clean and quiet throughout the session.',
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: null,
    origin: 'approved_by_a_human',
  },
  {
    rule: 'exceeds_length_cap',
    why: `the draft alone is inside the ${REPLY_LENGTH_CAP}-character cap and the reply WITH its signature is one character over it, which is the only shape that proves the cap is measured on what is published`,
    draft: paddedEnglishReply(REPLY_LENGTH_CAP - FIXTURE_REPLY_SIGNATURE.length - 1),
    language: 'en',
    reviewText: null,
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: FIXTURE_REPLY_SIGNATURE,
    origin: 'approved_by_a_human',
  },
  {
    rule: 'language_mismatch',
    why: 'an Arabic review answered in English. The reply is in the language it claims, so only the review comparison can refuse it',
    draft: CLEAN_REPLY,
    language: 'en',
    reviewText: ARABIC_REVIEW,
    reviewerDisplayName: ANONYMOUS_REVIEWER,
    signature: null,
    origin: 'approved_by_a_human',
  },
])
