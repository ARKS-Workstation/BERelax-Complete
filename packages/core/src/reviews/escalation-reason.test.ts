import { describe, expect, it } from 'vitest'
import {
  REVIEW_ESCALATION_CATEGORIES,
  REVIEW_ESCALATION_LEXICON_VERSION,
} from './escalation-lexicon.ts'
import { explainReviewEscalation, REVIEW_ESCALATION_CATEGORY_PHRASE } from './escalation-reason.ts'
import { REVIEW_ROUTING_ROWS } from './routing.ts'

/**
 * G-REV-06 — the escalation reason the approval queue shows.
 *
 * Every case here is paired with a control that must fail (brief rule 3), because an explanation is the
 * kind of thing that passes vacuously: a function returning an empty reason list satisfies "no refund
 * phrase for a clean review" and every assertion about a clean review, for ever.
 */

const VERSION = REVIEW_ESCALATION_LEXICON_VERSION

describe('the matched rule, in plain English', () => {
  it('reads the rule sentence out of the routing table rather than re-wording it', () => {
    const explained = explainReviewEscalation({
      comment: 'One star. Nothing was as described.',
      routingRuleId: 'rating_escalates',
      routingLexiconVersion: VERSION,
    })
    expect(explained.rule).toBe('rating_escalates')
    expect(explained.verdict).toBe('escalate')
    // Byte-identical to the table's own sentence. A second wording would be a second rule.
    expect(explained.why).toBe(REVIEW_ROUTING_ROWS.rating_escalates.why)
    // The control: a DIFFERENT rule gives a different sentence, so the equality above is not an
    // assertion that every rule has the same words.
    const other = explainReviewEscalation({
      comment: null,
      routingRuleId: 'free_text_present',
      routingLexiconVersion: VERSION,
    })
    expect(other.why).toBe(REVIEW_ROUTING_ROWS.free_text_present.why)
    expect(other.why).not.toBe(explained.why)
  })

  it('names a refund without being told about it, which is the acceptance line’s own example', () => {
    const explained = explainReviewEscalation({
      comment: 'I asked for a refund and nobody answered.',
      routingRuleId: 'escalation_term_present',
      routingLexiconVersion: VERSION,
    })
    expect(explained.reasons.map((reason) => reason.phrase)).toContain('mentions a refund')
    const refund = explained.reasons.find((reason) => reason.category === 'refund')
    // The regulatory reason comes from the lexicon, verbatim, and the terms are the lexicon's spellings.
    expect(refund?.why).toContain('money already taken')
    expect(refund?.terms).toContain('refund')
    // The control: the same rule id over text with no escalation term in it yields no reasons at all, so
    // the phrase above is produced by the TEXT and not by the rule id.
    const quiet = explainReviewEscalation({
      comment: 'Quiet room and the towels were warm.',
      routingRuleId: 'escalation_term_present',
      routingLexiconVersion: VERSION,
    })
    expect(quiet.reasons).toEqual([])
  })

  it('shows what is IN the review even when another row took the decision', () => {
    // routing.ts: precedence follows the document, so a three-star review mentioning a refund carries
    // `rating_below_auto_send_band`. An owner told only the rule id would never hear about the refund.
    const explained = explainReviewEscalation({
      comment: 'Three stars. I would like a refund for the second session.',
      routingRuleId: 'rating_below_auto_send_band',
      routingLexiconVersion: VERSION,
    })
    expect(explained.rule).toBe('rating_below_auto_send_band')
    expect(explained.why).toBe(REVIEW_ROUTING_ROWS.rating_below_auto_send_band.why)
    expect(explained.reasons.map((reason) => reason.category)).toEqual(['refund'])
  })

  it('reports every category in the lexicon’s declared order, deduplicated', () => {
    const explained = explainReviewEscalation({
      comment:
        'My lawyer will write. The room was dirty and I was in pain for a week. Refund please.',
      routingRuleId: 'escalation_term_present',
      routingLexiconVersion: VERSION,
    })
    const found = explained.reasons.map((reason) => reason.category)
    expect(found).toContain('pain')
    expect(found).toContain('hygiene')
    expect(found).toContain('refund')
    expect(found).toContain('legal_threat')
    // Declared order, not the order the words appear in the sentence — the sentence above names the
    // lawyer first and `legal_threat` is last in the lexicon.
    const declared = REVIEW_ESCALATION_CATEGORIES.filter((category) => found.includes(category))
    expect(found).toEqual(declared)
    // Deduplicated: one entry per category however many of its terms matched.
    expect(new Set(found).size).toBe(found.length)
  })
})

describe('every unreadable field answers the cautious way', () => {
  it('escalates a review nothing has routed, and says so without blaming the table', () => {
    const explained = explainReviewEscalation({
      comment: 'Lovely.',
      routingRuleId: null,
      routingLexiconVersion: null,
    })
    expect(explained.verdict).toBe('escalate')
    expect(explained.rule).toBeNull()
    expect(explained.why).toContain('nothing has routed this review yet')
    // NOT the routing_table_unavailable wording, which would send somebody to look at the table.
    expect(explained.why).not.toBe(REVIEW_ROUTING_ROWS.routing_table_unavailable.why)
  })

  it('escalates an unrecognised rule id and names it', () => {
    const explained = explainReviewEscalation({
      comment: 'Lovely.',
      routingRuleId: 'rule_from_a_later_build',
      routingLexiconVersion: VERSION,
    })
    expect(explained.verdict, 'unknown-rule-escalates').toBe('escalate')
    expect(explained.rule).toBeNull()
    expect(explained.why).toContain('rule_from_a_later_build')
  })

  it('escalates a stored auto_send verdict’s own rule only when this build declares it', () => {
    // The one permissive row in the table. It is reported as `auto_send` because that IS what the row
    // says — and the queue still refuses to offer an auto-send control, which is a separate claim
    // asserted where that control would be rendered. Here the point is the bias: everything else is
    // `escalate`.
    const permitted = explainReviewEscalation({
      comment: null,
      routingRuleId: 'quiet_high_rating_may_auto_send',
      routingLexiconVersion: VERSION,
    })
    expect(permitted.verdict).toBe('auto_send')
    // The control: a misspelling of the ONE permissive rule is `escalate`, not a near-miss match.
    const misspelt = explainReviewEscalation({
      comment: null,
      routingRuleId: 'quiet_high_rating_may_autosend',
      routingLexiconVersion: VERSION,
    })
    expect(misspelt.verdict, 'unknown-rule-escalates').toBe('escalate')
  })

  it('reports no categories for a lexicon version it cannot resolve, rather than today’s terms', () => {
    const stored = {
      comment: 'I asked for a refund and nobody answered.',
      routingRuleId: 'escalation_term_present',
    }
    const unresolvable = explainReviewEscalation({
      ...stored,
      routingLexiconVersion: '1999-01-01',
    })
    // Labelled for gate 158g, which makes the resolver fall back to today's lexicon: a known-bad fixture
    // has to fail by the name of the rule rather than by a diff of two arrays (ADR 0003).
    expect(unresolvable.lexiconVersion, 'lexicon-version-is-the-stored-one').toBeNull()
    expect(unresolvable.reasons, 'lexicon-version-is-the-stored-one').toEqual([])
    // The rule sentence is still shown: the rule id resolves without a lexicon.
    expect(unresolvable.why).toBe(REVIEW_ROUTING_ROWS.escalation_term_present.why)
    // The control, and the whole reason this case exists: the SAME text under the version the verdict
    // names does find the refund. So the empty list above is "this build cannot say", not "nothing here".
    const resolvable = explainReviewEscalation({ ...stored, routingLexiconVersion: VERSION })
    expect(resolvable.lexiconVersion).toBe(VERSION)
    expect(resolvable.reasons.map((reason) => reason.category)).toEqual(['refund'])
  })

  it('reports no categories for a star-only review and still explains the rule', () => {
    const explained = explainReviewEscalation({
      comment: null,
      routingRuleId: 'autosend_outside_api_mode',
      routingLexiconVersion: VERSION,
    })
    expect(explained.reasons).toEqual([])
    expect(explained.why).toBe(REVIEW_ROUTING_ROWS.autosend_outside_api_mode.why)
    expect(explained.lexiconVersion).toBe(VERSION)
  })
})

describe('the phrase table', () => {
  it('words every category, and no two the same', () => {
    const phrases = REVIEW_ESCALATION_CATEGORIES.map(
      (category) => REVIEW_ESCALATION_CATEGORY_PHRASE[category],
    )
    expect(phrases).toHaveLength(REVIEW_ESCALATION_CATEGORIES.length)
    for (const phrase of phrases) expect(phrase.trim().length).toBeGreaterThan(5)
    // One rule with two wordings and two rules with one wording are the same defect. The `Record` over
    // the union is what proves completeness; this is what proves they are distinct.
    expect(new Set(phrases).size).toBe(phrases.length)
  })

  it('describes the review and never the business', () => {
    // brief rule 15 and docs/07 §4: a phrase on this screen must not be a statement about what happened
    // at the premises. "mentions an injury" is about the review; "caused an injury" would be a finding.
    for (const category of REVIEW_ESCALATION_CATEGORIES) {
      const phrase = REVIEW_ESCALATION_CATEGORY_PHRASE[category]
      expect(phrase).toMatch(/^(mentions|makes|alleges|names) /)
      expect(phrase).not.toMatch(/\b(we|our|us)\b/i)
    }
  })
})
