import { MINIMUM_REVIEW_COOLING_OFF_HOURS } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Instant, instantFromIso } from '../time.ts'
import {
  matchedEscalationCategories,
  matchReviewEscalations,
  REVIEW_ESCALATION_CATEGORIES,
  REVIEW_ESCALATION_LEXICON,
  type ReviewEscalationCategory,
} from './escalation-lexicon.ts'
import {
  type ReviewRoutingPolicy,
  type ReviewRoutingVerdict,
  type RoutableReview,
  routeReview,
} from './routing.ts'

/**
 * G-REV-03 — 10,000 generated reviews, and two properties that must hold over all of them:
 *
 *   1. no review with `rating <= 2` is ever routed `auto_send`;
 *   2. no review whose text carries an escalation term is ever routed `auto_send`, whatever its rating and
 *      whatever language it is in.
 *
 * ## The oracle knows what was put in, so it does not have to read the text
 *
 * This is the important design decision here. An oracle that re-scanned the generated text would be a
 * second implementation of the matcher — and the obvious spelling of that second implementation, a
 * substring test, is *wrong* in a way that would make the property fail on correct code: `الم` is a
 * substring of the ordinary Arabic words for "the place" and "the massage", so a substring oracle would
 * report a violation on every innocent Arabic review the router correctly declines to flag.
 *
 * So the generator **composes** each review from a base sentence and, sometimes, an injected escalation
 * term, and the oracle is told which. `injectedTerm` is knowledge about the input rather than an
 * inspection of it, which is the strongest form of independence available: it cannot agree with the code
 * under test because it never calls it.
 *
 * A separate completeness assertion, which is *not* the safety oracle, does call `matchReviewEscalations`
 * to check that an injected term is actually found. That direction is allowed to use the code, because a
 * false negative there is a missed escalation rather than a wrongly-permitted one, and it is the assertion
 * that would catch a lexicon that had stopped matching anything.
 *
 * ## The checker is proved able to fail
 *
 * Two mutant routers at the bottom, each the shape of a real defect — a truthiness test on the
 * compliance-locked setting, and a router that never consults the lexicon — are run through the same
 * oracle, which must report violations for both. A property suite whose oracle cannot fail asserts
 * nothing, however many cases it runs.
 *
 * ## And auto_send is reached
 *
 * The final assertion is that the run produced at least one `auto_send`. Without it, every property here is
 * satisfied by a router that escalates everything — which is not a safe default, it is a broken
 * autoresponder, and it would make all four of the assertions above meaningless at once.
 */
const RUNS = 10_000

const REVIEWED_AT = instantFromIso('2026-09-10T18:22:00.000Z')
/** 72 hours later: past the 24-hour floor, so the cooling-off row is not what decides every case. */
const NOW = instantFromIso('2026-09-13T18:22:00.000Z')

/**
 * Innocent base sentences, in the four forms reviews arrive in.
 *
 * Each is asserted below to carry no escalation term, so the "no term injected" branch of the property has
 * something real to say. They are ordinary compliments and mild logistics remarks — no person is named in
 * any of them (ADR 0020: therapists have no display name until an admin sets one).
 */
const INNOCENT: readonly string[] = [
  'Lovely and relaxing, I will book again next month.',
  'the room was warm and the oil was very good',
  'Good value for ninety minutes and easy to find parking.',
  'مكان ممتاز ونظيف، والخدمة رائعة. أنصح به بشدة.',
  'خدمة ممتازة والموظفون محترمون جدا',
  'el makan ktir helo w el service mumtaz',
  'Napakaganda ng lugar at ang masahe ay sobrang nakakarelax.',
  'Tempatnya sangat bersih dan pelayanannya ramah sekali.',
]

/** One term per category per script, taken from the lexicon in force. Injected verbatim into a sentence. */
function termsFor(category: ReviewEscalationCategory): readonly string[] {
  return REVIEW_ESCALATION_LEXICON.rules[category].terms.map((entry) => entry.term)
}

/** The raw setting values the generator draws from: the intended ones and the shapes a read hands back. */
const AUTOSEND_VALUES: readonly unknown[] = [true, false, undefined, null, 'true', 1, {}]
const ACCESS_VALUES: readonly unknown[] = [true, false, undefined, null, 'api']
const COOLING_VALUES: readonly unknown[] = [24, 0, -1, 48, undefined, 'immediately']
const LANGUAGE_VALUES: readonly unknown[] = [['en', 'ar'], ['en'], ['ar'], [], undefined, ['tl']]

/** What the generator produced, and therefore what the oracle knows without reading anything. */
interface GeneratedCase {
  readonly rating: number
  readonly base: string | null
  /** The term the generator put into the text, or `null` if it put none. */
  readonly injectedTerm: string | null
  readonly injectedCategory: ReviewEscalationCategory | null
  readonly autosend: unknown
  readonly access: unknown
  readonly cooling: unknown
  readonly languages: unknown
}

const generated = (): fc.Arbitrary<GeneratedCase> =>
  fc
    .record({
      rating: fc.integer({ min: 1, max: 5 }),
      baseIndex: fc.integer({ min: 0, max: INNOCENT.length - 1 }),
      // A star-only review is the majority case (docs/10 §7), so it is generated often rather than rarely.
      starOnly: fc.boolean(),
      inject: fc.boolean(),
      categoryIndex: fc.integer({ min: 0, max: REVIEW_ESCALATION_CATEGORIES.length - 1 }),
      termIndex: fc.nat(),
      autosendIndex: fc.integer({ min: 0, max: AUTOSEND_VALUES.length - 1 }),
      accessIndex: fc.integer({ min: 0, max: ACCESS_VALUES.length - 1 }),
      coolingIndex: fc.integer({ min: 0, max: COOLING_VALUES.length - 1 }),
      languageIndex: fc.integer({ min: 0, max: LANGUAGE_VALUES.length - 1 }),
    })
    .map((raw): GeneratedCase => {
      const category = REVIEW_ESCALATION_CATEGORIES[raw.categoryIndex] as ReviewEscalationCategory
      const terms = termsFor(category)
      const term = terms[raw.termIndex % terms.length] as string
      const base = raw.starOnly ? null : (INNOCENT[raw.baseIndex] as string)
      const inject = raw.inject && base !== null
      return {
        rating: raw.rating,
        base,
        injectedTerm: inject ? term : null,
        injectedCategory: inject ? category : null,
        autosend: AUTOSEND_VALUES[raw.autosendIndex],
        access: ACCESS_VALUES[raw.accessIndex],
        cooling: COOLING_VALUES[raw.coolingIndex],
        languages: LANGUAGE_VALUES[raw.languageIndex],
      }
    })

/** The comment text the case describes. The term is appended as a clause, the way a reviewer writes it. */
function commentOf(one: GeneratedCase): string | null {
  if (one.base === null) return null
  return one.injectedTerm === null ? one.base : `${one.base} ${one.injectedTerm}`
}

function reviewOf(one: GeneratedCase): RoutableReview {
  return { rating: one.rating, commentText: commentOf(one), reviewedAt: REVIEWED_AT }
}

function policyOf(one: GeneratedCase, now: Instant = NOW): ReviewRoutingPolicy {
  return {
    now,
    autosendEnabledSetting: one.autosend,
    businessProfileAccessSetting: one.access,
    coolingOffHoursSetting: one.cooling,
    replyLanguagesSetting: one.languages,
    lexicon: REVIEW_ESCALATION_LEXICON,
  }
}

/** The two safety properties, checked against a verdict from any router. Returns the violation, or null. */
function violation(one: GeneratedCase, verdict: ReviewRoutingVerdict): string | null {
  if (verdict !== 'auto_send') return null
  // Property 1. A plain `<=` on the generated rating; nothing from the module under test.
  if (one.rating <= 2) return `rating ${one.rating} auto_sent`
  // Property 2. Knowledge of what was injected, not an inspection of the text.
  if (one.injectedTerm !== null) {
    return `text carrying "${one.injectedTerm}" (${String(one.injectedCategory)}) auto_sent`
  }
  return null
}

describe('property — no low-rated and no term-carrying review is ever auto-sent', () => {
  it('holds over every innocent base sentence, so the no-term branch is not vacuous', () => {
    // If a base sentence carried a term of its own, every "no term injected" case would silently be a
    // "term present" case and the property would prove much less than it says.
    for (const text of INNOCENT) {
      expect(matchedEscalationCategories(matchReviewEscalations(text)), text).toEqual([])
    }
  })

  it(`holds over ${RUNS} generated reviews`, () => {
    let autoSent = 0
    let termCarrying = 0
    let lowRated = 0
    fc.assert(
      fc.property(generated(), (one) => {
        const decision = routeReview({ review: reviewOf(one), policy: policyOf(one) })
        if (decision.verdict === 'auto_send') autoSent += 1
        if (one.injectedTerm !== null) termCarrying += 1
        if (one.rating <= 2) lowRated += 1
        const failed = violation(one, decision.verdict)
        expect(failed, `${failed ?? ''} — rule ${decision.rule}`).toBeNull()
      }),
      { numRuns: RUNS, seed: 20260919, verbose: false },
    )
    // The run has to have contained both kinds of case it claims to be about, and at least one auto_send.
    // A generator that produced no low-rated review, or no review with a term in it, or nothing sendable,
    // would report a green property over a corpus that never tested it.
    expect(lowRated).toBeGreaterThan(RUNS / 10)
    expect(termCarrying).toBeGreaterThan(RUNS / 10)
    expect(autoSent).toBeGreaterThan(0)
    // An explicit timeout, the same way `solve.property.test.ts` and `assign-shape.property.test.ts` do
    // it. Ten thousand routes is around nine seconds, because each one compares the text against every
    // term of seven categories plus the reused display-name lexicon — and the acceptance line asks for
    // ten thousand, so the honest answer is to pay for them rather than to run fewer.
  }, 60_000)

  it('finds every injected term, in every category and every script', () => {
    // The completeness direction, which is allowed to use the matcher: a lexicon that had stopped matching
    // would make the property above pass for the wrong reason.
    let checked = 0
    fc.assert(
      fc.property(generated(), (one) => {
        if (one.injectedTerm === null || one.injectedCategory === null) return
        checked += 1
        const categories = matchedEscalationCategories(matchReviewEscalations(commentOf(one)))
        expect(categories, `${one.injectedCategory}: ${one.injectedTerm}`).toContain(
          one.injectedCategory,
        )
      }),
      { numRuns: 2_000, seed: 20260919 },
    )
    expect(checked).toBeGreaterThan(100)
  }, 30_000)
})

describe('control — the oracle catches the two mutants it exists to catch', () => {
  /** A truthiness test on the compliance-locked setting: the classic permissive-normaliser defect. */
  function mutantTruthySettings(one: GeneratedCase): ReviewRoutingVerdict {
    return one.autosend ? 'auto_send' : 'escalate'
  }

  /**
   * A router that gets the rating band right and never consults the lexicon.
   *
   * Deliberately independent of the settings: this mutant exists to break property 2 and nothing else, so
   * every violation it produces is a term-carrying review rather than a low-rated one — which is what
   * makes the second assertion below able to distinguish the two properties.
   */
  function mutantIgnoresLexicon(one: GeneratedCase): ReviewRoutingVerdict {
    return one.rating >= 4 ? 'auto_send' : 'escalate'
  }

  it('reports violations for a truthiness test on the autosend setting', () => {
    const violations: string[] = []
    fc.assert(
      fc.property(generated(), (one) => {
        const failed = violation(one, mutantTruthySettings(one))
        if (failed !== null) violations.push(failed)
      }),
      { numRuns: 1_000, seed: 20260919 },
    )
    // Both properties are broken by this mutant: `'true'`, `1` and `{}` are all truthy, so a one-star
    // review and a review alleging an injury both get sent.
    expect(violations.some((text) => text.includes('rating 1'))).toBe(true)
    expect(violations.some((text) => text.includes('auto_sent'))).toBe(true)
  })

  it('reports violations for a router that never reads the lexicon', () => {
    const violations: string[] = []
    fc.assert(
      fc.property(generated(), (one) => {
        const failed = violation(one, mutantIgnoresLexicon(one))
        if (failed !== null) violations.push(failed)
      }),
      { numRuns: 1_000, seed: 20260919 },
    )
    expect(violations.length).toBeGreaterThan(0)
    // This mutant gets the rating band right, so every violation it produces is a term-carrying review —
    // which is what says the second property is the one being tested and not a by-product of the first.
    expect(violations.every((text) => text.startsWith('text carrying'))).toBe(true)
  })

  it('reports none for the shipped router over the same corpus', () => {
    // The acceptance control for both mutants. Without it, a violation counter that always fired would
    // satisfy the two assertions above.
    const violations: string[] = []
    fc.assert(
      fc.property(generated(), (one) => {
        const decision = routeReview({ review: reviewOf(one), policy: policyOf(one) })
        const failed = violation(one, decision.verdict)
        if (failed !== null) violations.push(failed)
      }),
      { numRuns: 1_000, seed: 20260919 },
    )
    expect(violations).toEqual([])
  })
})

describe('property — no setting combination sends a one- or two-star review', () => {
  it('escalates every low-rated review whatever the four settings hold', () => {
    // The same claim as `routing.test.ts`'s exhaustive loop, arrived at the other way: randomised rather
    // than enumerated, and with the cooling-off clock varied as well.
    fc.assert(
      fc.property(
        generated(),
        fc.constantFrom(
          NOW,
          REVIEWED_AT,
          instantFromIso('2026-09-11T00:00:00.000Z'),
          instantFromIso('2027-01-01T00:00:00.000Z'),
        ),
        (one, now) => {
          if (one.rating > 2) return
          const decision = routeReview({
            review: reviewOf(one),
            policy: policyOf(one, now),
          })
          expect(decision.verdict).toBe('escalate')
          expect(decision.rule).toBe('rating_escalates')
        },
      ),
      { numRuns: 3_000, seed: 20260919 },
    )
    // And the floor it cannot go below is a constant, not a literal repeated here.
    expect(MINIMUM_REVIEW_COOLING_OFF_HOURS).toBe(24)
  }, 30_000)
})
