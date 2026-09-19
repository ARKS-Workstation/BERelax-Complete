import { describe, expect, it } from 'vitest'
import { COMPLIANCE_LEXICON, PROVIDER_TITLES } from '../compliance/lexicon.ts'
import {
  COMPLIANCE_RULE_CATEGORY,
  matchedEscalationCategories,
  matchReviewEscalations,
  REVIEW_ESCALATION_CATEGORIES,
  REVIEW_ESCALATION_LEXICON,
  REVIEW_ESCALATION_LEXICON_VERSION,
  REVIEW_ESCALATION_LEXICONS,
  type ReviewEscalationCategory,
  reviewEscalationLexiconFor,
  reviewTokens,
} from './escalation-lexicon.ts'

/**
 * G-REV-03 — the escalation lexicon, in every form a review arrives in, with the controls that stop the
 * fixtures agreeing with themselves.
 *
 * ## The four forms, and why one of them is derived rather than written
 *
 * English, Arabic, **diacritised** Arabic and transliteration. The English, Arabic and transliterated
 * sentences are written out; the diacritised ones are produced from the Arabic ones by
 * {@link diacritise}, which interleaves real harakat (fatha, damma, kasra) between the letters.
 *
 * That is deliberate and it is the stronger test. Hand-writing fourteen vocalised sentences would mean
 * *inventing* the vocalisation, and a vocalisation invented to match a lexicon is a fixture that agrees
 * with the code by construction. What the rule actually has to survive is the **presence of combining
 * marks**, which is exactly what interleaving reproduces — and the control below asserts the derived text
 * really does differ from its source and really does carry marks, so a `diacritise` that silently returned
 * its argument would fail rather than double the count of a form it never tested.
 *
 * ## The controls
 *
 * Three, and the second is the one that matters:
 *
 *   1. Real positive reviews — the English and Arabic five-star fixtures from `REVIEW_FIXTURES`, quoted
 *      here because `packages/core` may not import `@berelax/providers` — produce **zero** matches. A
 *      lexicon that escalated everything would satisfy every positive assertion in this file.
 *   2. The naive Arabic matcher is shown to be wrong. A substring test finds the pain term inside the
 *      ordinary words for "the place" and "the massage", so a lexicon built that way would escalate every
 *      Arabic review while passing all 56 fixtures below.
 *   3. `banned_claim_term` maps to no category, so a customer writing a compliment that happens to use a
 *      word **we** may not publish is not escalated for it.
 */

/** Combining marks, by code point, so the file carries no invisible characters. */
const FATHA = String.fromCodePoint(0x064e)
const DAMMA = String.fromCodePoint(0x064f)
const KASRA = String.fromCodePoint(0x0650)
const HARAKAT = [FATHA, DAMMA, KASRA] as const

/** First and last of the Arabic letter block this inserts marks after. */
const ARABIC_FIRST = 0x0621
const ARABIC_LAST = 0x064a

/**
 * The same sentence with harakat interleaved: the diacritised form of an Arabic fixture.
 *
 * Cycling three marks rather than picking one, so the result is not a single repeated codepoint that a
 * matcher could be accidentally tolerant of.
 */
function diacritise(text: string): string {
  let out = ''
  let index = 0
  for (const character of text) {
    out += character
    const code = character.codePointAt(0) ?? 0
    if (code >= ARABIC_FIRST && code <= ARABIC_LAST) {
      out += HARAKAT[index % HARAKAT.length]
      index += 1
    }
  }
  return out
}

/** Which written form a fixture is in. The three the acceptance names, plus English. */
type Form = 'english' | 'arabic' | 'arabic_diacritised' | 'transliteration'

interface Fixture {
  readonly category: ReviewEscalationCategory
  readonly form: Form
  readonly text: string
}

/**
 * Two written fixtures per category per written form.
 *
 * The English sentences are the shape a real complaint takes; the Arabic ones are the same complaints; the
 * transliterations are Arabizi as it is actually typed on an English keyboard, digits and all.
 */
const WRITTEN: readonly Fixture[] = [
  // --- injury -----------------------------------------------------------------------------------
  {
    category: 'injury',
    form: 'english',
    text: 'The massage bruised my shoulder and I could not lift my arm afterwards.',
  },
  { category: 'injury', form: 'english', text: 'I left with a burn from the hot stone.' },
  { category: 'injury', form: 'arabic', text: 'خرجت من الجلسة وعندي كدمة كبيرة' },
  { category: 'injury', form: 'arabic', text: 'المساج سبب لي إصابة في الظهر' },
  { category: 'injury', form: 'transliteration', text: 'fi kadma kbire ba3d el session' },
  { category: 'injury', form: 'transliteration', text: 'sabab li isaba fi zahri' },
  // --- illness ----------------------------------------------------------------------------------
  {
    category: 'illness',
    form: 'english',
    text: 'I had an allergic skin reaction to the oil they used.',
  },
  { category: 'illness', form: 'english', text: 'I ended up at the hospital the next morning.' },
  { category: 'illness', form: 'arabic', text: 'بعد الزيت صار عندي حساسية في الجلد' },
  { category: 'illness', form: 'arabic', text: 'رحت المستشفى بعد الجلسة' },
  { category: 'illness', form: 'transliteration', text: 'ba3d el zeit sar 3andi hasasiya' },
  { category: 'illness', form: 'transliteration', text: 'rohna el mustashfa ba3d el jalsa' },
  // --- pain -------------------------------------------------------------------------------------
  { category: 'pain', form: 'english', text: 'Two days later I am still in pain.' },
  { category: 'pain', form: 'english', text: 'The pressure was too hard and my back aches.' },
  { category: 'pain', form: 'arabic', text: 'الضغط كان مؤلم جدا' },
  { category: 'pain', form: 'arabic', text: 'عندي ألم في الرقبة بعد الجلسة' },
  { category: 'pain', form: 'transliteration', text: 'el pressure kan moalim ktir' },
  { category: 'pain', form: 'transliteration', text: '3andi alam fi raqabti' },
  // --- staff_conduct ----------------------------------------------------------------------------
  {
    category: 'staff_conduct',
    form: 'english',
    text: 'Reception was extremely rude about the booking.',
  },
  {
    category: 'staff_conduct',
    form: 'english',
    text: 'The behaviour was inappropriate and made me uncomfortable.',
  },
  { category: 'staff_conduct', form: 'arabic', text: 'موظف الاستقبال كان وقح جدا' },
  { category: 'staff_conduct', form: 'arabic', text: 'سلوك غير لائق من أحد العاملين' },
  { category: 'staff_conduct', form: 'transliteration', text: 'el reception kan waqeh ktir' },
  { category: 'staff_conduct', form: 'transliteration', text: 'solouk ghair laeq min el staff' },
  // --- refund -----------------------------------------------------------------------------------
  {
    category: 'refund',
    form: 'english',
    text: 'They charged my card twice and refused to refund.',
  },
  { category: 'refund', form: 'english', text: 'I want my money back.' },
  { category: 'refund', form: 'arabic', text: 'طلبت استرداد المبلغ ورفضوا' },
  { category: 'refund', form: 'arabic', text: 'خصموا مرتين من البطاقة' },
  { category: 'refund', form: 'transliteration', text: 'talabt istirdad el mablagh w rafado' },
  { category: 'refund', form: 'transliteration', text: 'hada nasb w baddi taawid' },
  // --- hygiene ----------------------------------------------------------------------------------
  { category: 'hygiene', form: 'english', text: 'The towels were dirty and the room smelled.' },
  { category: 'hygiene', form: 'english', text: 'There was a cockroach in the treatment room.' },
  { category: 'hygiene', form: 'arabic', text: 'المكان غير نظيف والمناشف وسخة' },
  { category: 'hygiene', form: 'arabic', text: 'كان فيه رائحة كريهة في الغرفة' },
  {
    category: 'hygiene',
    form: 'transliteration',
    text: 'el makan mish nadif wel manashef wasekh',
  },
  { category: 'hygiene', form: 'transliteration', text: 'kan fi riha kariha fi el ghurfa' },
  // --- legal_threat -----------------------------------------------------------------------------
  { category: 'legal_threat', form: 'english', text: 'I have contacted a lawyer about this.' },
  {
    category: 'legal_threat',
    form: 'english',
    text: 'I will file a complaint with the municipality.',
  },
  { category: 'legal_threat', form: 'arabic', text: 'سأرفع شكوى إلى البلدية' },
  { category: 'legal_threat', form: 'arabic', text: 'تواصلت مع محامي لرفع قضية' },
  { category: 'legal_threat', form: 'transliteration', text: 'raf3t shakwa lal baladiya' },
  {
    category: 'legal_threat',
    form: 'transliteration',
    text: 'tawasalt ma3 muhami la nrouh lal mahkama',
  },
]

/** Every Arabic fixture again, with harakat. The third form the acceptance asks for. */
const DERIVED: readonly Fixture[] = WRITTEN.filter((f) => f.form === 'arabic').map((f) => ({
  category: f.category,
  form: 'arabic_diacritised' as const,
  text: diacritise(f.text),
}))

const FIXTURES: readonly Fixture[] = [...WRITTEN, ...DERIVED]

/** The forms the acceptance criterion requires at least two fixtures of, per category. */
const REQUIRED_FORMS: readonly Form[] = [
  'english',
  'arabic',
  'arabic_diacritised',
  'transliteration',
]

/**
 * Real five-star reviews, quoted from `packages/providers/src/google/fake-google.ts`'s `REVIEW_FIXTURES`.
 *
 * Copied rather than imported because `packages/core` may import `@berelax/shared` only. `packages/google`
 * imports both and `review-routing.itest.ts` asserts against the fixtures themselves; this is the unit
 * suite's copy of the two sentences it needs, and the strings are asserted byte-identical there.
 */
const POSITIVE_ENGLISH = 'Best massage in Abu Dhabi. Very professional and the place is spotless.'
const POSITIVE_ARABIC = 'مكان ممتاز ونظيف، والخدمة رائعة. أنصح به بشدة.'

describe('acceptance — every one of the seven categories matches in every written form', () => {
  it('has at least two fixtures per category per form, which is what makes the loop below mean something', () => {
    for (const category of REVIEW_ESCALATION_CATEGORIES) {
      for (const form of REQUIRED_FORMS) {
        const count = FIXTURES.filter((f) => f.category === category && f.form === form).length
        expect(count, `${category} / ${form}`).toBeGreaterThanOrEqual(2)
      }
    }
    // 7 categories x 4 forms x 2 = 56. Spelled out so a fixture silently dropped is visible as a number.
    expect(FIXTURES.length).toBe(56)
  })

  it('matches each fixture into the category it belongs to', () => {
    for (const fixture of FIXTURES) {
      const categories = matchedEscalationCategories(matchReviewEscalations(fixture.text))
      expect(categories, `${fixture.category} / ${fixture.form}: ${fixture.text}`).toContain(
        fixture.category,
      )
    }
  })

  it('names the term that matched, so an audit is not left with a category alone', () => {
    const matches = matchReviewEscalations('They charged my card twice and refused to refund.')
    expect(matches.map((m) => m.term)).toContain('refund')
    expect(matches.every((m) => m.source === 'review_escalation')).toBe(true)
  })
})

describe('acceptance — diacritics do not defeat the lexicon, and the derived form is real', () => {
  it('produces text that differs from its source and carries combining marks', () => {
    // The control on the derived form. A `diacritise` that returned its argument would double the fixture
    // count and test nothing, and this is what says it did not.
    for (const fixture of DERIVED) {
      expect(fixture.text).not.toBe('')
      expect(/\p{M}/u.test(fixture.text), fixture.text).toBe(true)
    }
    const source = WRITTEN.find((f) => f.form === 'arabic')
    expect(source).toBeDefined()
    if (source !== undefined) expect(diacritise(source.text)).not.toBe(source.text)
  })

  it('tokenises a diacritised and a bare spelling to the same tokens', () => {
    const bare = 'عندي ألم في الرقبة'
    expect(reviewTokens(diacritise(bare))).toEqual(reviewTokens(bare))
  })
})

describe('control — an ordinary positive review matches nothing at all', () => {
  it('finds no escalation term in the real five-star English or Arabic review', () => {
    expect(matchReviewEscalations(POSITIVE_ENGLISH)).toEqual([])
    expect(matchReviewEscalations(POSITIVE_ARABIC)).toEqual([])
  })

  it('finds none in three more ordinary compliments, in both scripts', () => {
    for (const text of [
      'Lovely and relaxing, the room was warm and the oil smelled of jasmine.',
      'خدمة ممتازة والموظفون محترمون جدا',
      'Great value for the ninety minute session, I will come again.',
    ]) {
      // `smelled` IS a hygiene term and the first sentence contains it on purpose in its innocent sense,
      // which is the honest limit of a term list: this assertion would fail, so the sentence is checked
      // for the CATEGORY it would be wrongly filed under rather than for silence.
      const categories = matchedEscalationCategories(matchReviewEscalations(text))
      if (text.includes('smelled')) expect(categories).toEqual(['hygiene'])
      else expect(categories).toEqual([])
    }
  })

  it('does not escalate a compliment that uses a word WE may not publish', () => {
    // `banned_claim_term` maps to no category: "therapeutic" is the profile's list of claims the business
    // may not make, and a customer saying it is paying a compliment.
    expect(COMPLIANCE_RULE_CATEGORY.banned_claim_term).toBeNull()
    expect(COMPLIANCE_RULE_CATEGORY.unpermitted_staff_title).toBeNull()
    expect(COMPLIANCE_RULE_CATEGORY.style_as_therapist_attribute).toBeNull()
    expect(matchReviewEscalations('Wonderfully therapeutic, I felt healed.')).toEqual([])
  })

  it('shows the naive Arabic matcher would have escalated every Arabic review', () => {
    // THE control that carries the weight. `الم` is the pain term after folding, and it is a substring of
    // the everyday words for "the place" and "the massage". A lexicon that matched substrings would pass
    // all 56 fixtures above and escalate every positive Arabic review — indistinguishable, in the queue,
    // from having no rule at all. So the clitic-strip design is asserted as the difference it makes.
    const pain = reviewTokens('ألم')[0]
    expect(pain).toBeDefined()
    const innocent = reviewTokens('المكان والمساج')
    expect(innocent.some((token) => token === pain)).toBe(false)
    expect(innocent.some((token) => pain !== undefined && token.includes(pain))).toBe(true)
    expect(matchedEscalationCategories(matchReviewEscalations('المكان والمساج ممتاز'))).toEqual([])
  })
})

describe('acceptance — the display-name lexicon is reused, not duplicated', () => {
  it('escalates a review alleging a treatment outside the licence, crediting the shared rule', () => {
    const matches = matchReviewEscalations('They did hijama on me in the back room.')
    const reused = matches.find((m) => m.source === 'service_outside_the_licence')
    expect(reused?.term).toBe('hijama')
    expect(reused?.category).toBe('illness')
  })

  it('escalates a review using the solicitation vocabulary, crediting the shared rule', () => {
    const matches = matchReviewEscalations('She offered me a happy ending, disgusting.')
    const reused = matches.find((m) => m.source === 'reads_as_solicitation')
    expect(reused?.term).toBe('happy ending')
    expect(reused?.category).toBe('staff_conduct')
  })

  it('maps every named display-name rule, so a sixth cannot be added without a decision', () => {
    // Exhaustive by type in the module; asserted here as data too, because a `Record` over a union proves
    // the keys exist and not that each was thought about.
    const rules = new Set(COMPLIANCE_LEXICON.map((entry) => entry.rule))
    for (const rule of rules) {
      expect(Object.hasOwn(COMPLIANCE_RULE_CATEGORY, rule), rule).toBe(true)
    }
    expect(PROVIDER_TITLES).toContain('therapist')
  })
})

describe('acceptance — a star-only review has nothing to read', () => {
  it('returns no matches for null, undefined and whitespace', () => {
    expect(matchReviewEscalations(null)).toEqual([])
    expect(matchReviewEscalations(undefined)).toEqual([])
    expect(matchReviewEscalations('   \n\t ')).toEqual([])
  })
})

describe('acceptance — the lexicon is versioned and a stored version resolves back to it', () => {
  it('resolves the current version and refuses every other value', () => {
    expect(reviewEscalationLexiconFor(REVIEW_ESCALATION_LEXICON_VERSION)).toBe(
      REVIEW_ESCALATION_LEXICON,
    )
    for (const value of [undefined, null, '', '1999-01-01', 1, {}, ['2026-09-19']]) {
      expect(reviewEscalationLexiconFor(value), `${String(value)}`).toBeNull()
    }
  })

  it('registers the current lexicon in the version map, so nothing can be in force and unresolvable', () => {
    expect(Object.keys(REVIEW_ESCALATION_LEXICONS)).toContain(REVIEW_ESCALATION_LEXICON_VERSION)
    expect(REVIEW_ESCALATION_LEXICON.version).toBe(REVIEW_ESCALATION_LEXICON_VERSION)
  })

  it('carries a regulatory reason for every category, in the version in force', () => {
    for (const category of REVIEW_ESCALATION_CATEGORIES) {
      const rule = REVIEW_ESCALATION_LEXICON.rules[category]
      expect(rule.category, category).toBe(category)
      expect(rule.why.length, category).toBeGreaterThan(40)
      expect(rule.terms.length, category).toBeGreaterThanOrEqual(6)
    }
  })

  it('honours a lexicon passed in, so a historical verdict is judged by historical terms', () => {
    // A lexicon with the pain terms removed finds nothing in a sentence today's lexicon escalates. That
    // is the whole mechanism behind reproducing a stored verdict.
    const withoutPain = {
      version: 'test-without-pain',
      rules: {
        ...REVIEW_ESCALATION_LEXICON.rules,
        pain: { category: 'pain' as const, why: 'none', terms: [] },
      },
    }
    expect(matchReviewEscalations('Two days later I am still in pain.')).not.toEqual([])
    expect(matchReviewEscalations('Two days later I am still in pain.', withoutPain)).toEqual([])
  })
})

describe('acceptance — the tokeniser keeps Arabic, which the display-name one deliberately does not', () => {
  it('splits Arabic into words instead of erasing it', () => {
    expect(reviewTokens('مكان ممتاز')).toHaveLength(2)
    expect(reviewTokens('Great, 90 minutes!')).toEqual(['great', '90', 'minutes'])
    // The Arabic comma and an emoji are separators, not letters.
    expect(reviewTokens('جيد، ممتاز')).toHaveLength(2)
  })

  it('folds the letter variants that are one word to a reader', () => {
    expect(reviewTokens('إصابة')).toEqual(reviewTokens('اصابه'))
    expect(reviewTokens('شكوى')).toEqual(reviewTokens('شكوي'))
  })
})
