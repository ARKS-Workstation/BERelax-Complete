import {
  matchedEscalationCategories,
  matchReviewEscalations,
  type ReviewEscalationCategory,
  type ReviewEscalationMatch,
  reviewEscalationLexiconFor,
} from './escalation-lexicon.ts'
import {
  REVIEW_ROUTING_ROWS,
  type ReviewRoutingRule,
  type ReviewRoutingVerdict,
  reviewRoutingRule,
  reviewVerdictForRule,
} from './routing.ts'

/**
 * Why a review is in the approval queue, in a sentence an owner can act on (G-REV-06).
 *
 * The acceptance line is *"an escalated review shows the matched rule in plain English (for example
 * 'mentions a refund')"*, and the two halves of that sentence are two different facts that this module
 * keeps apart on purpose:
 *
 *   - **the matched RULE** is which row of the docs/07 §4 table took the decision, stored on the review as
 *     `routing_rule_id` (G-REV-03). Its sentence is {@link REVIEW_ROUTING_ROWS}`[rule].why`, read from the
 *     table rather than re-worded here — a second wording of a rule is a second rule as far as the person
 *     reading it is concerned, and the one they would be reading is whichever copy nobody updated.
 *   - **what is IN the review** is the escalation categories its text matched, which are not stored at all.
 *     `ReviewRoutingDecision.categories` exists only in memory at routing time, and that is right: it is
 *     derived, and a stored copy would disagree with the lexicon the moment either changed. So it is
 *     re-derived here from the review text and the lexicon version the verdict was taken against.
 *
 * The rule id alone is not enough, and the reason is stated in `routing.ts`: precedence follows the
 * document, so **a three-star review mentioning a refund carries `rating_below_auto_send_band`**. An owner
 * told only the rule id would be told about the rating and not about the refund. Both are shown.
 *
 * ## Pure, and biased to escalate
 *
 * No clock, no database, no lexicon of its own. Every answer is derived from the row's stored fields plus
 * the versioned lexicon those fields name, and every unreadable field answers the cautious way:
 *
 *   - an unrecognised or absent `routing_rule_id` answers `escalate` through {@link reviewVerdictForRule},
 *     which is total over `unknown` and returns the permissive verdict only for a rule this build declares
 *     AND whose row says `auto_send`;
 *   - a `routing_lexicon_version` this build cannot resolve answers {@link lexiconVersion} `null` and NO
 *     categories, rather than falling back to today's terms — which would report today's answer as the
 *     one that was taken. The same device `replayReviewRouting` and `reproduceReplyLint` use.
 *
 * It does NOT re-route. `routeReview` needs the policy settings and the clock, and re-taking the decision
 * on a screen would mean the queue could disagree with the verdict stored on the row — which is the one
 * thing an audit of a verdict must not do. This explains the stored decision; it never replaces it.
 */

/**
 * What each escalation category means, in the fewest plain words that are still true.
 *
 * `Record<ReviewEscalationCategory, string>`, so a category added to
 * `REVIEW_ESCALATION_CATEGORIES` stops this file compiling until somebody words it — the device the
 * lexicon's own `RULES` uses, and the only form of "the list is complete" that survives somebody in a
 * hurry.
 *
 * These are deliberately SHORTER than the lexicon's own `why`, and both are shown. The lexicon's sentence
 * is the regulatory reason a machine may not answer it ("a public reply either admits or denies it, and
 * both are statements about a reportable incident that only the owner may make"); this is the phrase that
 * answers *why is this in my queue* at a glance, which is the acceptance line's own example — *"mentions a
 * refund"*. Neither is a claim about this business: each describes what the REVIEW says.
 */
export const REVIEW_ESCALATION_CATEGORY_PHRASE: Readonly<Record<ReviewEscalationCategory, string>> =
  Object.freeze({
    injury: 'mentions an injury',
    illness: 'mentions an illness or a medical treatment',
    pain: 'mentions pain',
    staff_conduct: 'makes an allegation about a member of staff',
    refund: 'mentions a refund',
    hygiene: 'alleges a hygiene failure',
    legal_threat: 'names a lawyer, a court or a regulator',
  })

/** One category the review's text matched, with the terms that matched it. */
export interface ReviewEscalationReason {
  readonly category: ReviewEscalationCategory
  /** The glance-level phrase. See {@link REVIEW_ESCALATION_CATEGORY_PHRASE}. */
  readonly phrase: string
  /** The regulatory reason, verbatim from the lexicon rule. Never re-worded here. */
  readonly why: string
  /**
   * The lexicon's own spellings that matched, deduplicated and in the order the lexicon lists them.
   *
   * The lexicon's spelling and not the reviewer's token: the term is what an owner can look up, and
   * echoing the matched token back would put the reviewer's words into a second place for no gain.
   */
  readonly terms: readonly string[]
}

/** The stored verdict, exactly as a review row carries it. Every field is `unknown`-tolerant. */
export interface StoredReviewVerdict {
  /** `google_reviews.comment_text`. NULL for a star-only review, and never `''`. */
  readonly comment: string | null
  /** `google_reviews.routing_rule_id`. NULL until the router has seen the row. */
  readonly routingRuleId: unknown
  /** `google_reviews.routing_lexicon_version`. The version the verdict was taken against. */
  readonly routingLexiconVersion: unknown
}

/** Why this review is where it is, with everything the queue shows and nothing derived twice. */
export interface ReviewEscalationExplanation {
  /** Biased to `escalate` by construction — see {@link reviewVerdictForRule}. */
  readonly verdict: ReviewRoutingVerdict
  /** The rule, or `null` when the stored id is not one this build declares. */
  readonly rule: ReviewRoutingRule | null
  /** The rule's sentence, or the sentence for *there is no rule on this row*. Always plain English. */
  readonly why: string
  /** The lexicon the categories were derived from, or `null` when this build cannot resolve it. */
  readonly lexiconVersion: string | null
  /** The categories the text matched, in the lexicon's declared order. Empty for a star-only review. */
  readonly reasons: readonly ReviewEscalationReason[]
}

/**
 * The sentence for a row the router has never seen.
 *
 * NOT `routing_table_unavailable`'s wording, which is about a table that could not be read. An unrouted
 * row is the ordinary state of a review between intake and the drafting job, and telling an owner the
 * routing table was missing would send them to look at the wrong thing.
 */
const NOT_ROUTED_YET =
  'nothing has routed this review yet, so no rule of the docs/07 §4 table has been applied to it. ' +
  'Until one has, it is a human’s to read: a review with no verdict is never auto-answered'

/**
 * The sentence for a rule id this build does not declare.
 *
 * Names the id, because the only useful thing to say about an unrecognised rule is which one it was: the
 * row was written by a build that had a rule this one does not, which is a deployment question rather
 * than a review question.
 */
function unknownRuleSentence(stored: unknown): string {
  const shown = typeof stored === 'string' && stored.trim() !== '' ? stored.trim() : String(stored)
  return (
    `this review carries the routing rule “${shown}”, which is not a rule this build declares. It is ` +
    'escalated: an unrecognised verdict is never read as permission to publish'
  )
}

/** The terms of one category, in the lexicon's declared order, deduplicated. */
function termsOf(matches: readonly ReviewEscalationMatch[]): readonly string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const match of matches) {
    if (seen.has(match.term)) continue
    seen.add(match.term)
    terms.push(match.term)
  }
  return Object.freeze(terms)
}

/**
 * Explains one stored verdict.
 *
 * The categories are derived from the lexicon the verdict NAMES, which is why the version is taken off the
 * row rather than `REVIEW_ESCALATION_LEXICON` being read: this file imports the RESOLVER and never the
 * current lexicon, so there is no expression here that could answer with today's terms by accident.
 */
export function explainReviewEscalation(stored: StoredReviewVerdict): ReviewEscalationExplanation {
  const rule = reviewRoutingRule(stored.routingRuleId)
  const verdict = reviewVerdictForRule(stored.routingRuleId)
  const why =
    rule !== null
      ? REVIEW_ROUTING_ROWS[rule].why
      : stored.routingRuleId === null || stored.routingRuleId === undefined
        ? NOT_ROUTED_YET
        : unknownRuleSentence(stored.routingRuleId)

  const lexicon = reviewEscalationLexiconFor(stored.routingLexiconVersion)
  if (lexicon === null) {
    return Object.freeze({ verdict, rule, why, lexiconVersion: null, reasons: [] })
  }

  const matches = matchReviewEscalations(stored.comment, lexicon)
  const categories = matchedEscalationCategories(matches)
  const reasons = categories.map((category) => ({
    category,
    phrase: REVIEW_ESCALATION_CATEGORY_PHRASE[category],
    why: lexicon.rules[category].why,
    terms: termsOf(matches.filter((match) => match.category === category)),
  }))
  return Object.freeze({
    verdict,
    rule,
    why,
    lexiconVersion: lexicon.version,
    reasons: Object.freeze(reasons),
  })
}
