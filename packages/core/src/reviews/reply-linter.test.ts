import { describe, expect, it } from 'vitest'
import { BIDI_CONTROLS, stripBidiControls } from '../text/bidi.ts'
import { REVIEW_ESCALATION_CATEGORIES, REVIEW_ESCALATION_LEXICON } from './escalation-lexicon.ts'
import {
  HOUSE_DRAFT_LINT_RULES,
  HOUSE_DRAFT_LINTER,
  HOUSE_REPLY_RENDERINGS,
  REPLY_LENGTH_CAP,
  REPLY_SIGNATURE_SEPARATOR,
  type ReplyLintCandidate,
  renderFinalReply,
} from './reply-lint-contract.ts'
import {
  ANONYMOUS_REVIEWER,
  ARABIC_REPLY,
  ARABIC_REPLY_WITH_ISOLATED_NUMERAL,
  ARABIC_REVIEW,
  CLEAN_REPLY,
  FIXTURE_COMPLIANCE_POLICY,
  FIXTURE_REPLY_SIGNATURE,
  FIXTURE_ROSTER_DISPLAY_NAME,
  HEALTH_DISCLOSURE_PAIR,
  KNOWN_BAD_REPLIES,
  paddedEnglishReply,
} from './reply-linter.fixtures/index.ts'
import {
  HEALTH_DISCLOSURE_CATEGORIES,
  type ReplyLintContext,
  replyLinterFor,
  SEND_PATH_LINT_RULES,
  SEND_PATH_LINT_VERSION,
  sendPathReplyLinter,
} from './reply-linter.ts'

/**
 * G-REV-05's linter, as pure functions.
 *
 * Every case here is a claim about something that could be quietly wrong while the whole file still passed,
 * because that is this build's dominant defect class and this module is unusually exposed to it: every
 * vocabulary it judges against lives somewhere else, so a rule can stop firing because a list moved.
 *
 * The three shapes the cases are built in:
 *
 *   - **a fixture per rule, asserted BY NAME**, plus a control that the clean reply produces nothing. A
 *     linter that refused everything satisfies the first half and fails the second;
 *   - **pairs**, for the three rules whose claim is about something other than the reply's own words: the
 *     health-disclosure rule (same reply, two reviews), the roster rule (same reply, two rosters), and the
 *     cap (1,200 and 1,201 with the same signature);
 *   - **the closed set**, for the rule nothing else can check: every one of the renderings the generator can
 *     produce has to pass, or the house vocabulary itself is unpublishable — which is how this unit found
 *     that it was.
 */

/** The context a unit test can build: the stand-in profile, one rostered label, the lexicon in force. */
function context(overrides: Partial<ReplyLintContext> = {}): ReplyLintContext {
  return {
    policy: FIXTURE_COMPLIANCE_POLICY,
    rosterDisplayNames: [FIXTURE_ROSTER_DISPLAY_NAME],
    lexicon: REVIEW_ESCALATION_LEXICON,
    ...overrides,
  }
}

/** The rule names a candidate is refused by, which is what every assertion below reads. */
function rulesFor(candidate: ReplyLintCandidate, ctx: ReplyLintContext = context()): string[] {
  return sendPathReplyLinter(ctx)
    .lint(candidate)
    .map((finding) => finding.rule)
}

const approved = (draft: string, extra: Partial<ReplyLintCandidate> = {}): ReplyLintCandidate => ({
  draft,
  language: 'en',
  reviewText: null,
  reviewerDisplayName: ANONYMOUS_REVIEWER,
  signature: null,
  origin: 'approved_by_a_human',
  ...extra,
})

describe('one known-bad fixture per rule, refused by the name of the rule it breaks', () => {
  it.each(KNOWN_BAD_REPLIES.map((fixture) => [fixture.rule, fixture] as const))(
    '%s',
    (rule, fixture) => {
      const rules = rulesFor({
        draft: fixture.draft,
        language: fixture.language,
        reviewText: fixture.reviewText,
        reviewerDisplayName: fixture.reviewerDisplayName,
        signature: fixture.signature,
        origin: fixture.origin,
      })
      expect(rules, `${rule}: ${fixture.why}`).toContain(rule)
    },
  )

  /**
   * The count check the acceptance criterion asks for, in the form that catches the thing it is about.
   *
   * `toEqual` over the whole ordered list rather than a length comparison: a length test passes when a rule
   * is added and an existing fixture is duplicated, and it says nothing about WHICH rule lost its fixture.
   * This fails if a rule has no fixture, and it fails the other way too — a fixture naming a rule the list
   * does not declare is a fixture asserting something nothing reports.
   */
  it('has a fixture for every rule, so adding a rule without one breaks the build', () => {
    const covered = [...new Set(KNOWN_BAD_REPLIES.map((fixture) => fixture.rule))]
    expect(covered).toEqual([...SEND_PATH_LINT_RULES])
    expect(KNOWN_BAD_REPLIES.length).toBeGreaterThanOrEqual(SEND_PATH_LINT_RULES.length)
  })

  /** The control. Without it every assertion above is satisfied by a linter that refuses everything. */
  it('passes a clean reply, which is what stops the fixtures passing vacuously', () => {
    expect(rulesFor(approved(CLEAN_REPLY))).toEqual([])
  })

  it('reports every reason rather than the first, so two problems are one round trip', () => {
    const rules = rulesFor(
      approved('Thank you for the feedback. We have arranged a refund and it was our mistake.'),
    )
    expect(rules).toContain('promises_discount_or_refund')
    expect(rules).toContain('admits_fault')
  })
})

describe('the seam G-REV-04 declared', () => {
  /**
   * The superset claim, checked rather than promised.
   *
   * `reply-lint-contract.ts` says "G-REV-05's list is a superset". That sentence is the kind that is true
   * when written and false after a rename, and the generator depends on it: it is handed a `ReplyLinter` and
   * reads the rule names out of the findings.
   */
  it('reports every rule the house-draft linter can, and more', () => {
    for (const rule of HOUSE_DRAFT_LINT_RULES) {
      expect(SEND_PATH_LINT_RULES as readonly string[]).toContain(rule)
    }
    expect(SEND_PATH_LINT_RULES.length).toBeGreaterThan(HOUSE_DRAFT_LINT_RULES.length)
  })

  /**
   * The rule that only the closed set can check — and the defect this case found.
   *
   * Every string `renderReplySkeleton` can produce has to pass the send-path linter, because the generator
   * writes nothing else and a draft it produced is a draft an owner will approve.
   *
   * This walk is what found the defect G-REV-05 fixed in `skeletons.ts`. Against the profile in force, 32 of
   * the 296 renderings were REFUSED: the English `treatment` aspect rendered as "the treatment itself", and
   * `treatment` is on `regulatory_profile.banned_claim_terms` (0004). The Arabic for the same aspect already
   * said "the session itself", so the two languages had disagreed about a compliance claim since G-REV-04
   * and nothing had ever compared a house rendering against the claim list. The fix was to the phrase, not
   * to the rule — the rule is the licence.
   *
   * Note what this case can and cannot see. {@link FIXTURE_COMPLIANCE_POLICY} carries ONE banned term, so
   * the walk here is a smoke test; the walk that catches a profile disagreement is the same walk against
   * `regulatory_profile_current` in `packages/google/src/reviews/reply-delivery.itest.ts`, and that is where
   * the 32 were counted.
   */
  it('passes every rendering the generator can produce, in both languages', () => {
    const refused: string[] = []
    for (const language of ['en', 'ar'] as const) {
      for (const rendering of HOUSE_REPLY_RENDERINGS[language]) {
        const rules = rulesFor({
          draft: rendering,
          language,
          reviewText: null,
          reviewerDisplayName: ANONYMOUS_REVIEWER,
          signature: null,
          origin: 'machine_draft',
        })
        if (rules.length > 0) refused.push(`${language}: ${rendering} → ${rules.join(', ')}`)
      }
    }
    expect(refused, 'a house rendering the generator can produce is not publishable').toEqual([])
    // The vacuity floor: the closed set has to be a real set, or the walk above asserts nothing.
    expect(HOUSE_REPLY_RENDERINGS.en.size).toBeGreaterThan(100)
  })

  /** The generator sets no origin, so it must get the strict reading by default. */
  it('applies the house-rendering rule to a draft that declares no origin', () => {
    const rules = rulesFor({
      draft: 'A sentence no skeleton can render.',
      language: 'en',
      reviewText: null,
    })
    expect(rules).toContain('not_a_house_skeleton_rendering')
  })
})

describe('the health-disclosure echo is about the REVIEW, not about a word list', () => {
  /**
   * The pair the criterion asks for. Identical reply; the review is the only difference.
   *
   * The half that matters is the second: a linter carrying its own list of health words satisfies the first
   * and refuses the same reply against a review that never mentioned anything, which is a different rule
   * with the same name.
   */
  it('refuses the reply against a review that discloses, and passes it against one that does not', () => {
    const candidate = (reviewText: string): ReplyLintCandidate =>
      approved(HEALTH_DISCLOSURE_PAIR.reply, { reviewText })
    expect(rulesFor(candidate(HEALTH_DISCLOSURE_PAIR.reviewWithDisclosure))).toEqual([
      'echoes_health_disclosure',
    ])
    expect(rulesFor(candidate(HEALTH_DISCLOSURE_PAIR.reviewWithout))).toEqual([])
  })

  /**
   * The phrase is outside the banned-claims lexicon, which is the criterion's own condition.
   *
   * Asserted rather than assumed, because the word was chosen for it: if `pregnant` were ever added to the
   * profile's claim list the reply above would be refused by `banned_claim_term` and this pair would prove
   * nothing about the echo rule while still passing.
   */
  it('uses a health phrase the banned-claims lexicon does not carry', () => {
    const rules = rulesFor(approved(HEALTH_DISCLOSURE_PAIR.reply))
    expect(rules).toEqual([])
  })

  /** Three of the seven categories, and the other four are about us rather than about the reviewer. */
  it('treats only the reviewer-body categories as disclosures', () => {
    expect(HEALTH_DISCLOSURE_CATEGORIES).toEqual(['injury', 'illness', 'pain'])
    for (const category of HEALTH_DISCLOSURE_CATEGORIES) {
      expect(REVIEW_ESCALATION_CATEGORIES as readonly string[]).toContain(category)
    }
    const allegations = REVIEW_ESCALATION_CATEGORIES.filter(
      (category) => !HEALTH_DISCLOSURE_CATEGORIES.includes(category),
    )
    expect(allegations).toEqual(['staff_conduct', 'refund', 'hygiene', 'legal_threat'])
  })

  /**
   * The control that keeps the rule from being `echoes_review_text` under another name.
   *
   * `repeatsReviewText` needs five consecutive tokens. The disclosure reply repeats ONE word, so the quote
   * rule cannot see it — which is the whole reason this rule exists.
   */
  it('fires on a single repeated word, where the five-token quote rule cannot', () => {
    expect(
      HOUSE_DRAFT_LINTER.lint({
        draft: HEALTH_DISCLOSURE_PAIR.reply,
        language: 'en',
        reviewText: HEALTH_DISCLOSURE_PAIR.reviewWithDisclosure,
        origin: 'approved_by_a_human',
      }).map((finding) => finding.rule),
    ).toEqual([])
  })
})

describe('the roster rule reads the roster', () => {
  /**
   * The pair: one reply, two rosters. The rule name is the only thing that moves.
   *
   * The lower-case spelling is what makes this a test of the roster rather than of the capitalisation
   * heuristic — `textNamesAnIndividual` skips a lower-case word — and the empty-roster half is what would
   * fail if the name were matched from a list in the module instead of from the argument.
   */
  it('refuses a reply naming a rostered label and passes the same reply with an empty roster', () => {
    const fixture = KNOWN_BAD_REPLIES.find(
      (candidate) => candidate.rule === 'names_a_rostered_therapist',
    )
    if (fixture === undefined) throw new Error('the roster fixture is missing')
    const candidate = approved(fixture.draft)
    expect(rulesFor(candidate, context({ rosterDisplayNames: [] }))).toEqual([])
    expect(rulesFor(candidate)).toEqual(['names_a_rostered_therapist'])
  })

  it('matches case-blind, so the capitalised spelling is refused too', () => {
    const candidate = approved(
      `Thank you for the feedback. We are glad ${FIXTURE_ROSTER_DISPLAY_NAME} was able to help.`,
    )
    // Capitalised, so the heuristic sees it as well — which is correct and is why the assertion is
    // `toContain`: the claim is that the roster rule still fires, not that it fires alone.
    expect(rulesFor(candidate)).toContain('names_a_rostered_therapist')
  })

  /** A one-character display name is not a name, and matching one would refuse half the replies. */
  it('ignores a roster entry too short to be a name', () => {
    expect(
      rulesFor(approved('Thank you for the feedback. We will pass a note on.'), {
        ...context(),
        rosterDisplayNames: ['a'],
      }),
    ).toEqual([])
  })
})

describe('the 1,200-character cap is measured on what is published', () => {
  /**
   * 1,200 passes and 1,201 is refused, with the signature included in both — which is the criterion.
   *
   * The control is the draft length: at 1,201 the DRAFT is 1,183 characters and would pass on its own, so a
   * cap measured on the draft reports this reply as inside a limit it is outside. That is the defect the
   * criterion names, and it is the one a test over the draft alone cannot see.
   */
  it('passes at exactly 1,200 and refuses at 1,201, counting the signature', () => {
    const room =
      REPLY_LENGTH_CAP - FIXTURE_REPLY_SIGNATURE.length - REPLY_SIGNATURE_SEPARATOR.length
    const inside = approved(paddedEnglishReply(room), { signature: FIXTURE_REPLY_SIGNATURE })
    const over = approved(paddedEnglishReply(room + 1), { signature: FIXTURE_REPLY_SIGNATURE })

    expect([...renderFinalReply(inside)].length).toBe(REPLY_LENGTH_CAP)
    expect([...renderFinalReply(over)].length).toBe(REPLY_LENGTH_CAP + 1)
    expect(rulesFor(inside)).toEqual([])
    expect(rulesFor(over)).toEqual(['exceeds_length_cap'])

    // The control: both DRAFTS are inside the cap, so only the rendering can have tipped it over.
    expect([...over.draft].length).toBeLessThanOrEqual(REPLY_LENGTH_CAP)
  })

  it('renders a blank signature as no signature rather than as a trailing separator', () => {
    expect(renderFinalReply({ draft: CLEAN_REPLY, signature: '   ' })).toBe(CLEAN_REPLY)
    expect(renderFinalReply({ draft: CLEAN_REPLY, signature: null })).toBe(CLEAN_REPLY)
    expect(renderFinalReply({ draft: CLEAN_REPLY })).toBe(CLEAN_REPLY)
  })

  /** One renderer, two linters. A second implementation of the cap is the drift this holds shut. */
  it('measures the same rendering in the house-draft linter', () => {
    const room =
      REPLY_LENGTH_CAP - FIXTURE_REPLY_SIGNATURE.length - REPLY_SIGNATURE_SEPARATOR.length
    const over = {
      draft: paddedEnglishReply(room + 1),
      language: 'en' as const,
      reviewText: null,
      signature: FIXTURE_REPLY_SIGNATURE,
      origin: 'approved_by_a_human' as const,
    }
    expect(HOUSE_DRAFT_LINTER.lint(over).map((finding) => finding.rule)).toEqual([
      'exceeds_length_cap',
    ])
  })
})

describe('language match', () => {
  it('refuses an Arabic review answered in English', () => {
    expect(rulesFor(approved(CLEAN_REPLY, { reviewText: ARABIC_REVIEW }))).toEqual([
      'language_mismatch',
    ])
  })

  it('passes an Arabic review answered in Arabic', () => {
    expect(rulesFor(approved(ARABIC_REPLY, { language: 'ar', reviewText: ARABIC_REVIEW }))).toEqual(
      [],
    )
  })

  /** The other half of the rule: a declaration is not a way round it. */
  it('refuses an English reply that declares itself Arabic', () => {
    expect(rulesFor(approved(CLEAN_REPLY, { language: 'ar', reviewText: ARABIC_REVIEW }))).toEqual([
      'language_mismatch',
    ])
  })

  /**
   * Latin numerals bidi-isolated inside Arabic text, which is the criterion's own wording.
   *
   * Two claims, and the second is the one worth having. The isolates are separators to every token matcher,
   * so the reply is still Arabic and still passes — asserted against the SAME reply with the controls
   * stripped, so the case is about the isolates rather than about the sentence. And they COUNT towards the
   * cap, because they are bytes Google receives: a cap that skipped them would report a reply as inside a
   * limit it is outside.
   */
  it('handles a Latin numeral isolated inside an Arabic reply', () => {
    const isolated = approved(ARABIC_REPLY_WITH_ISOLATED_NUMERAL, {
      language: 'ar',
      reviewText: ARABIC_REVIEW,
    })
    expect(rulesFor(isolated)).toEqual([])
    const stripped = stripBidiControls(ARABIC_REPLY_WITH_ISOLATED_NUMERAL)
    expect(rulesFor(approved(stripped, { language: 'ar', reviewText: ARABIC_REVIEW }))).toEqual([])
    // The fixture really does carry isolates, or both assertions above are about one string.
    expect(stripped).not.toBe(ARABIC_REPLY_WITH_ISOLATED_NUMERAL)
    expect(
      BIDI_CONTROLS.some((control) => ARABIC_REPLY_WITH_ISOLATED_NUMERAL.includes(control)),
    ).toBe(true)
    // And they are charged for.
    expect([...ARABIC_REPLY_WITH_ISOLATED_NUMERAL].length).toBe([...stripped].length + 2)
  })

  /** A star-only review has no language, so the review comparison must not invent one. */
  it('asks nothing of a review with no text', () => {
    expect(rulesFor(approved(CLEAN_REPLY, { reviewText: null }))).toEqual([])
    expect(rulesFor(approved(ARABIC_REPLY, { language: 'ar', reviewText: null }))).toEqual([])
  })
})

describe('a stored version resolves back to the rules that took the decision', () => {
  it('resolves the version this build stamps', () => {
    const linter = replyLinterFor(SEND_PATH_LINT_VERSION, context())
    expect(linter?.version).toBe(SEND_PATH_LINT_VERSION)
    expect(linter?.lint(approved(CLEAN_REPLY))).toEqual([])
  })

  /** A version nobody has is `null` and never today's rules, which would report the wrong answer. */
  it('refuses a version it has never had, rather than falling back', () => {
    expect(replyLinterFor('g-rev-05-send-path-0', context())).toBeNull()
    expect(replyLinterFor(null, context())).toBeNull()
    expect(replyLinterFor(42, context())).toBeNull()
  })
})
