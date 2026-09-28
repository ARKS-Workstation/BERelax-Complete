import { describe, expect, it } from 'vitest'
import { reviewCountPhrase } from './count-phrase.ts'

/**
 * The phrase the count tripwire's email is about.
 *
 * The acceptance line names one string — *an email reading "2 new reviews"* — and the integration test
 * asserts it on the fake Resend outbox. This file is what stops that assertion being the only one: it is
 * satisfied by a function that hard-codes the plural, and the interesting values are the ones the tripwire
 * fires on most often (one) and the one Arabic gets wrong (two).
 */
describe('the English phrase', () => {
  it('reads "2 new reviews", which is the string the acceptance line names', () => {
    expect(reviewCountPhrase(2, 'en')).toBe('2 new reviews')
  })

  it('reads "1 new review" and not "1 new reviews"', () => {
    expect(reviewCountPhrase(1, 'en')).toBe('1 new review')
  })

  it('pluralises every larger count', () => {
    expect(reviewCountPhrase(3, 'en')).toBe('3 new reviews')
    expect(reviewCountPhrase(41, 'en')).toBe('41 new reviews')
  })
})

describe('the Arabic phrase counts in four cases, not two', () => {
  it('uses the singular for one', () => {
    expect(reviewCountPhrase(1, 'ar')).toBe('تقييم جديد واحد')
  })

  it('uses the DUAL for two, which an English-shaped rendering would get wrong', () => {
    // The whole reason this function exists in two languages. `2 تقييمات` is the plural form and is wrong
    // for two, and it is the value the acceptance line happens to use — so a test that only passed 2
    // through an English-shaped renderer would look right.
    const two = reviewCountPhrase(2, 'ar')
    expect(two).toBe('تقييمان جديدان')
    expect(two).not.toContain('2')
  })

  it('uses the plural noun for three to ten', () => {
    expect(reviewCountPhrase(3, 'ar')).toBe('3 تقييمات جديدة')
    expect(reviewCountPhrase(10, 'ar')).toBe('10 تقييمات جديدة')
  })

  it('uses the accusative singular from eleven upwards', () => {
    expect(reviewCountPhrase(11, 'ar')).toBe('11 تقييماً جديداً')
    expect(reviewCountPhrase(41, 'ar')).toBe('41 تقييماً جديداً')
  })

  it('gives every case a distinct wording, so none of the four is dead', () => {
    const forms = new Set(
      [1, 2, 3, 11].map((count) => reviewCountPhrase(count, 'ar').replace(/\d+/g, '#')),
    )
    expect(forms.size).toBe(4)
  })
})

describe('refusals', () => {
  it('refuses zero and below rather than rendering a sentence about nothing', () => {
    for (const count of [0, -1]) {
      expect(() => reviewCountPhrase(count, 'en')).toThrow(/positive whole count/)
      expect(() => reviewCountPhrase(count, 'ar')).toThrow(/positive whole count/)
    }
  })

  it('refuses a fraction', () => {
    expect(() => reviewCountPhrase(1.5, 'en')).toThrow(/positive whole count/)
  })
})
