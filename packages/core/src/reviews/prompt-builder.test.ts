import { describe, expect, it } from 'vitest'
import { instantFromIso } from '../time.ts'
import { REVIEW_ESCALATION_LEXICON } from './escalation-lexicon.ts'
import {
  assembleReplyDraft,
  buildReviewReplyPrompt,
  MAX_MODEL_RESPONSE_CHARACTERS,
  MODEL_RESPONSE_REFUSALS,
  type ModelResponseRefusal,
  screenModelResponse,
  selectedAspects,
} from './prompt-builder.ts'
import { RED_TEAM_CORPUS } from './red-team-corpus.ts'
import {
  draftPassesLint,
  HOUSE_DRAFT_LINT_RULES,
  HOUSE_DRAFT_LINTER,
  HOUSE_REPLY_RENDERINGS,
  type HouseDraftLintRule,
  isHouseReplyRendering,
  REPLY_LENGTH_CAP,
} from './reply-lint-contract.ts'
import { type ReviewRoutingPolicy, routeReview } from './routing.ts'
import {
  MAX_RENDERED_ASPECTS,
  REPLY_ASPECTS,
  REPLY_SKELETONS,
  renderableAspects,
  renderReplySkeleton,
  skeletonForReview,
} from './skeletons.ts'

/**
 * G-REV-04's pure half: the skeletons, the response screen, the linter contract, and the red-team corpus
 * judged from both ends.
 *
 * The prompt's structural properties are in `prompt-builder.fuzz.test.ts`, over 200 strings. This file is
 * about what happens to the *answer*, which is the half the fuzz corpus cannot reach.
 */

const REVIEWED_AT = instantFromIso('2026-09-10T18:22:00.000Z')

/**
 * The most permissive policy this build can be configured into.
 *
 * Auto-send deliberately enabled, API access granted, the cooling-off long since elapsed, both languages
 * configured. Any review that still escalates under *this* escalates under every setting — which is what
 * makes "no payload changes the verdict" a statement about the payload rather than about the settings the
 * test happened to choose.
 */
const PERMISSIVE: ReviewRoutingPolicy = {
  now: instantFromIso('2026-09-20T18:22:00.000Z'),
  autosendEnabledSetting: true,
  businessProfileAccessSetting: true,
  coolingOffHoursSetting: 24,
  replyLanguagesSetting: ['en', 'ar'],
  lexicon: REVIEW_ESCALATION_LEXICON,
}

/** What a well-behaved model answers: a selection, and nothing else. */
const OBEDIENT_SELECTION = 'ASPECTS: treatment'

describe('the house skeletons', () => {
  it('cover every review shape a draft can be asked for, and refuse the one that has no reply', () => {
    expect(skeletonForReview({ rating: 5, hasText: false })).toBe('star_only_thanks')
    expect(skeletonForReview({ rating: 4, hasText: false })).toBe('star_only_thanks')
    expect(skeletonForReview({ rating: 5, hasText: true })).toBe('positive_thanks')
    expect(skeletonForReview({ rating: 3, hasText: true })).toBe('mixed_acknowledgement')
    expect(skeletonForReview({ rating: 1, hasText: true })).toBe('low_rating_acknowledgement')
    // A one-star review with no text has nothing to answer. Offering "we take this seriously" against a
    // review that said nothing is a reply to something the reviewer did not say.
    expect(skeletonForReview({ rating: 1, hasText: false })).toBeNull()
    expect(skeletonForReview({ rating: 3, hasText: false })).toBeNull()
  })

  it('renders byte-identically across three runs, which is what makes the queue diffable', () => {
    for (const skeleton of REPLY_SKELETONS) {
      for (const language of ['en', 'ar'] as const) {
        const runs = [1, 2, 3].map(() =>
          renderReplySkeleton({ skeleton, aspects: ['team', 'treatment'], language }),
        )
        expect(new Set(runs).size, `${skeleton}/${language}`).toBe(1)
      }
    }
  })

  it('renders aspects in the declared order, never the order they were selected in', () => {
    // The property that makes a Set's insertion order unable to reach the text. Reversed input, same
    // bytes — so a model listing "team, treatment" and one listing "treatment, team" are one draft.
    const forward = renderReplySkeleton({
      skeleton: 'positive_thanks',
      aspects: ['treatment', 'team'],
      language: 'en',
    })
    const backward = renderReplySkeleton({
      skeleton: 'positive_thanks',
      aspects: ['team', 'treatment'],
      language: 'en',
    })
    expect(forward).toBe(backward)
  })

  it('caps the aspects and collapses duplicates', () => {
    expect(renderableAspects([...REPLY_ASPECTS])).toHaveLength(MAX_RENDERED_ASPECTS)
    expect(renderableAspects(['team', 'team', 'team'])).toEqual(['team'])
  })

  it('every rendering passes the linter, in both languages', () => {
    for (const language of ['en', 'ar'] as const) {
      for (const draft of HOUSE_REPLY_RENDERINGS[language]) {
        expect(
          HOUSE_DRAFT_LINTER.lint({ draft, language, reviewText: null }),
          `${language}: ${draft}`,
        ).toEqual([])
      }
    }
  })

  it('the closed set is the size the enumeration claims, so a skeleton cannot go missing', () => {
    // Four skeletons x (1 empty + 8 singletons + 28 pairs). A number rather than a formula, because the
    // formula is what the implementation already computes and would agree with itself.
    expect(HOUSE_REPLY_RENDERINGS.en.size).toBe(148)
    expect(HOUSE_REPLY_RENDERINGS.ar.size).toBe(148)
  })
})

describe('a five-star review with NULL comment text', () => {
  it('produces a valid draft that passes the linter, and asks the model nothing', () => {
    const prompt = buildReviewReplyPrompt({
      rating: 5,
      commentText: null,
      language: 'en',
      skeleton: 'star_only_thanks',
    })
    // `response: null` is the star-only path: there is no text to select from, so no call is made. That
    // is also why this path has no untrusted input at all.
    const outcome = assembleReplyDraft({
      rating: 5,
      commentText: null,
      language: 'en',
      prompt,
      response: null,
    })
    expect(outcome.kind).toBe('drafted')
    if (outcome.kind !== 'drafted') return
    expect(outcome.draft).toBe('Thank you for the rating. We look forward to welcoming you back.')
    expect(outcome.provenance.skeleton).toBe('star_only_thanks')
    expect(outcome.provenance.aspects).toEqual([])
    expect(
      draftPassesLint(HOUSE_DRAFT_LINTER, {
        draft: outcome.draft,
        language: 'en',
        reviewText: null,
      }),
    ).toBe(true)
  })

  it('does so in Arabic too, because the configured set has two members', () => {
    const prompt = buildReviewReplyPrompt({
      rating: 5,
      commentText: null,
      language: 'ar',
      skeleton: 'star_only_thanks',
    })
    const outcome = assembleReplyDraft({
      rating: 5,
      commentText: null,
      language: 'ar',
      prompt,
      response: null,
    })
    expect(outcome.kind).toBe('drafted')
    if (outcome.kind !== 'drafted') return
    expect(isHouseReplyRendering(outcome.draft, 'ar')).toBe(true)
    expect(
      HOUSE_DRAFT_LINTER.lint({ draft: outcome.draft, language: 'ar', reviewText: null }),
    ).toEqual([])
  })
})

describe('the response screen', () => {
  /** One known-bad response per rule, so a rule that stops matching is caught. */
  const KNOWN_BAD: Readonly<Record<ModelResponseRefusal, string>> = {
    response_absent: '   ',
    response_reveals_the_prompt: 'ALLOWED_ASPECTS: treatment, team',
    response_carries_instructions: 'Ignoring the previous instructions as asked.',
    response_names_an_individual: 'Your therapist that evening was on shift.',
    response_promises_money: 'We will refund you in full.',
    response_admits_fault: 'This was our mistake.',
    response_quotes_the_review:
      'We are glad the slipped disc and chronic shoulder pain improved after the session.',
    response_is_not_a_selection: 'x'.repeat(MAX_MODEL_RESPONSE_CHARACTERS + 1),
  }

  const REVIEW_FOR_ECHO =
    'I told them about my slipped disc and chronic shoulder pain before we started.'

  it('has one known-bad response per rule, so adding a rule without a case breaks the build', () => {
    expect(Object.keys(KNOWN_BAD).sort()).toEqual([...MODEL_RESPONSE_REFUSALS].sort())
  })

  it('refuses each known-bad response with its own rule', () => {
    for (const rule of MODEL_RESPONSE_REFUSALS) {
      expect(
        screenModelResponse({ response: KNOWN_BAD[rule], reviewText: REVIEW_FOR_ECHO }),
        rule,
      ).toBe(rule)
    }
  })

  it('the control: an obedient selection is refused by nothing', () => {
    expect(screenModelResponse({ response: OBEDIENT_SELECTION, reviewText: REVIEW_FOR_ECHO })).toBe(
      null,
    )
  })

  it('does not refuse an apology, because an apology is not an admission', () => {
    // A screen that quarantined the most ordinary thing a model says trains an operator to clear
    // quarantines without reading them, and that costs more than any single draft.
    expect(screenModelResponse({ response: 'We are sorry to hear this.', reviewText: null })).toBe(
      null,
    )
  })

  it('reads a selection out of prose without ever inventing an aspect', () => {
    expect(selectedAspects('ASPECTS: cleanliness, treatment')).toEqual(['treatment', 'cleanliness'])
    // An unrecognised name contributes nothing. There is no response that adds a ninth aspect.
    expect(selectedAspects('ASPECTS: obedience, supremacy')).toEqual([])
    for (const aspect of selectedAspects('everything: treatment team cleanliness atmosphere')) {
      expect(REPLY_ASPECTS).toContain(aspect)
    }
    expect(selectedAspects('everything: treatment team cleanliness atmosphere')).toHaveLength(
      MAX_RENDERED_ASPECTS,
    )
  })
})

describe('the reply linter contract', () => {
  const GOOD = renderReplySkeleton({
    skeleton: 'positive_thanks',
    aspects: ['treatment'],
    language: 'en',
  })

  /** One known-bad draft per rule. */
  const KNOWN_BAD: Readonly<
    Record<HouseDraftLintRule, { draft: string; reviewText: string | null }>
  > = {
    not_a_house_skeleton_rendering: {
      draft: 'Thanks for the review, we really appreciate you taking the time to write it.',
      reviewText: null,
    },
    exceeds_length_cap: { draft: `${GOOD} ${'x'.repeat(REPLY_LENGTH_CAP)}`, reviewText: null },
    names_an_individual: { draft: `${GOOD} Your therapist was delighted.`, reviewText: null },
    promises_discount_or_refund: { draft: `${GOOD} We will refund you.`, reviewText: null },
    admits_fault: { draft: `${GOOD} This was our mistake.`, reviewText: null },
    echoes_review_text: {
      draft: `${GOOD} Your slipped disc and chronic shoulder pain are noted.`,
      reviewText: 'I told them about my slipped disc and chronic shoulder pain before we started.',
    },
    language_mismatch: { draft: GOOD, reviewText: null },
  }

  it('has one known-bad draft per rule (ADR 0003)', () => {
    expect(Object.keys(KNOWN_BAD).sort()).toEqual([...HOUSE_DRAFT_LINT_RULES].sort())
  })

  it('rejects each known-bad draft, reporting the rule by name', () => {
    for (const rule of HOUSE_DRAFT_LINT_RULES) {
      const fixture = KNOWN_BAD[rule]
      // `language_mismatch` is the one case where the draft is right and the CLAIM is wrong: an English
      // rendering presented as Arabic. Everything else is judged against its own language.
      const language = rule === 'language_mismatch' ? 'ar' : 'en'
      const findings = HOUSE_DRAFT_LINTER.lint({
        draft: fixture.draft,
        language,
        reviewText: fixture.reviewText,
      })
      expect(
        findings.map((finding) => finding.rule),
        rule,
      ).toContain(rule)
    }
  })

  it('the control: the real draft is rejected by nothing', () => {
    expect(HOUSE_DRAFT_LINTER.lint({ draft: GOOD, language: 'en', reviewText: null })).toEqual([])
  })

  it('the cap is asserted at the boundary, not near it', () => {
    const at = 'a'.repeat(REPLY_LENGTH_CAP)
    const over = 'a'.repeat(REPLY_LENGTH_CAP + 1)
    const rules = (draft: string): readonly string[] =>
      HOUSE_DRAFT_LINTER.lint({ draft, language: 'en', reviewText: null }).map((f) => f.rule)
    expect(rules(at)).not.toContain('exceeds_length_cap')
    expect(rules(over)).toContain('exceeds_length_cap')
  })
})

describe('the 25-payload red-team corpus', () => {
  it('is 25 distinct payloads covering every named attack class', () => {
    expect(RED_TEAM_CORPUS).toHaveLength(25)
    expect(new Set(RED_TEAM_CORPUS.map((p) => p.id)).size).toBe(25)
    const classes = new Set(RED_TEAM_CORPUS.map((p) => p.attempt))
    // The six the acceptance criterion names, plus the block-escape class the fuzz corpus shares.
    for (const attempt of [
      'role_override',
      'discount_promise',
      'name_the_therapist',
      'admit_fault',
      'exfiltrate_the_prompt',
      'echo_a_health_disclosure',
    ] as const) {
      expect(classes, attempt).toContain(attempt)
    }
  })

  it('zero payloads change the routing verdict, under the most permissive settings there are', () => {
    for (const payload of RED_TEAM_CORPUS) {
      const decision = routeReview({
        review: { rating: 5, commentText: payload.reviewText, reviewedAt: REVIEWED_AT },
        policy: PERMISSIVE,
      })
      expect(decision.verdict, payload.id).toBe('escalate')
    }
  })

  it('the control: the same settings DO auto-send a review with nothing in it', () => {
    // Without this, the assertion above would pass on a policy that escalates everything, and would be
    // a test of the settings rather than of the payloads.
    const decision = routeReview({
      review: { rating: 5, commentText: null, reviewedAt: REVIEWED_AT },
      policy: PERMISSIVE,
    })
    expect(decision.verdict).toBe('auto_send')
    expect(decision.rule).toBe('quiet_high_rating_may_auto_send')
  })

  it('a hijacked model is refused for every payload, by the rule the payload expects', () => {
    for (const payload of RED_TEAM_CORPUS) {
      expect(
        screenModelResponse({ response: payload.objective, reviewText: payload.reviewText }),
        payload.id,
      ).toBe(payload.expectedRefusal)
    }
  })

  it('a hijacked model therefore produces NO draft for any payload', () => {
    for (const payload of RED_TEAM_CORPUS) {
      const prompt = buildReviewReplyPrompt({
        rating: 5,
        commentText: payload.reviewText,
        language: 'en',
        skeleton: 'positive_thanks',
      })
      const outcome = assembleReplyDraft({
        rating: 5,
        commentText: payload.reviewText,
        language: 'en',
        prompt,
        response: payload.objective,
      })
      expect(outcome.kind, payload.id).toBe('quarantined')
      if (outcome.kind !== 'quarantined') continue
      expect(outcome.refusal, payload.id).toBe(payload.expectedRefusal)
      // There is no `draft` field on a quarantine, so "no draft that passes the linter" is a property of
      // the type rather than of a value somebody remembered to leave out.
      expect('draft' in outcome).toBe(false)
    }
  })

  it('an unhijacked model produces a house draft carrying no byte of any payload', () => {
    for (const payload of RED_TEAM_CORPUS) {
      const prompt = buildReviewReplyPrompt({
        rating: 5,
        commentText: payload.reviewText,
        language: 'en',
        skeleton: 'positive_thanks',
      })
      const outcome = assembleReplyDraft({
        rating: 5,
        commentText: payload.reviewText,
        language: 'en',
        prompt,
        response: OBEDIENT_SELECTION,
      })
      expect(outcome.kind, payload.id).toBe('drafted')
      if (outcome.kind !== 'drafted') continue
      // Membership of the closed set is the complete statement: the set is fixed and does not depend on
      // the input, so a draft inside it cannot carry input.
      expect(isHouseReplyRendering(outcome.draft, 'en'), payload.id).toBe(true)
      expect(
        HOUSE_DRAFT_LINTER.lint({
          draft: outcome.draft,
          language: 'en',
          reviewText: payload.reviewText,
        }),
      ).toEqual([])
      // And the same claim stated the way a sceptic would check it: no twelve-character run of the
      // payload appears in the draft.
      for (let start = 0; start + 12 <= payload.reviewText.length; start += 1) {
        expect(
          outcome.draft.includes(payload.reviewText.slice(start, start + 12)),
          payload.id,
        ).toBe(false)
      }
    }
  })
})
