import { describe, expect, it } from 'vitest'
import {
  AGREEMENT_SCORES,
  classifyLabelAgreement,
  classifyPhoneAgreement,
  DUPLICATE_AUTO_MERGE_THRESHOLD,
  DUPLICATE_REVIEW_THRESHOLD,
  DUPLICATE_VERDICTS,
  duplicateVerdict,
  LABEL_AGREEMENTS,
  LABEL_NEAR_THRESHOLD,
  LABEL_PARTIAL_THRESHOLD,
  labelSimilarityPerMille,
  labelTrigrams,
  PHONE_AGREEMENTS,
  PROVISIONAL_DUPLICATE_THRESHOLDS,
  scoreDuplicatePair,
} from './duplicate-score.ts'

/**
 * The scoring table, the two classifiers and the bands — each with the control that makes the
 * assertion mean something.
 *
 * The golden fixture (`duplicate-score.golden.test.ts`) pins the score of sixty real pairs. This file
 * is the other half: the claims that hold for *every* pair, which a fixture of any size cannot state.
 */

describe('the agreement table', () => {
  it('has a cell for every (phone x label) pair and nothing else', () => {
    expect(PHONE_AGREEMENTS).toHaveLength(6)
    expect(LABEL_AGREEMENTS).toHaveLength(5)
    expect(Object.keys(AGREEMENT_SCORES).sort()).toEqual([...PHONE_AGREEMENTS].sort())
    for (const phone of PHONE_AGREEMENTS) {
      expect(Object.keys(AGREEMENT_SCORES[phone]).sort()).toEqual([...LABEL_AGREEMENTS].sort())
      for (const label of LABEL_AGREEMENTS) {
        const cell = AGREEMENT_SCORES[phone][label]
        expect(Number.isInteger(cell), `${phone} x ${label} is an integer per mille`).toBe(true)
        expect(cell).toBeGreaterThanOrEqual(0)
        expect(cell).toBeLessThanOrEqual(1000)
      }
    }
  })

  /**
   * The rule the whole unit turns on: nothing merges itself without an identical number.
   *
   * Stated as a property over the table rather than as a list of cells, because the dangerous edit is
   * raising one cell in one row — and a test that checked the cells it expected to be high would not
   * be looking at the row that moved.
   */
  it('reaches the auto-merge band only where the number is identical', () => {
    // One direction only, and deliberately: an identical number does NOT imply an automatic merge —
    // `identical x partial` is 0.94 and `identical x different` is 0.72, both of which are reviewed by
    // a human. What must hold is the converse, that nothing outside that row can ever merge itself.
    for (const phone of PHONE_AGREEMENTS) {
      if (phone === 'identical') continue
      for (const label of LABEL_AGREEMENTS) {
        const auto = AGREEMENT_SCORES[phone][label] / 1000 >= DUPLICATE_AUTO_MERGE_THRESHOLD
        expect(auto, `${phone} x ${label} in the auto-merge band`).toBe(false)
      }
    }
    // The control: the claim above is only worth making if the auto band is reachable at all.
    expect(AGREEMENT_SCORES.identical.identical / 1000).toBeGreaterThanOrEqual(
      DUPLICATE_AUTO_MERGE_THRESHOLD,
    )
    // And only if it is NOT reachable with the weakest label evidence on an identical number.
    expect(AGREEMENT_SCORES.identical.different / 1000).toBeLessThan(DUPLICATE_AUTO_MERGE_THRESHOLD)
  })

  it('never sits a cell exactly on a threshold', () => {
    // A cell equal to a threshold makes every band assertion depend on how `>=` treats a float
    // arrived at by division. There is no reason to have one, so there is none.
    for (const phone of PHONE_AGREEMENTS) {
      for (const label of LABEL_AGREEMENTS) {
        const score = AGREEMENT_SCORES[phone][label] / 1000
        expect(score, `${phone} x ${label}`).not.toBe(DUPLICATE_AUTO_MERGE_THRESHOLD)
        expect(score, `${phone} x ${label}`).not.toBe(DUPLICATE_REVIEW_THRESHOLD)
      }
    }
  })

  it('weighs more evidence at least as highly as less, along both axes', () => {
    // Monotonicity. Not a mathematical necessity — it is a claim about the table being a judgement
    // rather than a pile of numbers, and a transposed pair of cells is invisible without it.
    const labelOrder = ['different', 'partial', 'near', 'identical'] as const
    for (const phone of PHONE_AGREEMENTS) {
      for (let index = 1; index < labelOrder.length; index += 1) {
        const weaker = AGREEMENT_SCORES[phone][labelOrder[index - 1] as 'different']
        const stronger = AGREEMENT_SCORES[phone][labelOrder[index] as 'partial']
        expect(
          stronger,
          `${phone}: ${labelOrder[index]} over ${labelOrder[index - 1]}`,
        ).toBeGreaterThan(weaker)
      }
    }
    const phoneOrder = ['unknown', 'one_digit_shifted', 'one_digit_apart', 'identical'] as const
    for (const label of LABEL_AGREEMENTS) {
      for (let index = 1; index < phoneOrder.length; index += 1) {
        const weaker = AGREEMENT_SCORES[phoneOrder[index - 1] as 'unknown'][label]
        const stronger = AGREEMENT_SCORES[phoneOrder[index] as 'one_digit_apart'][label]
        expect(
          stronger,
          `${label}: ${phoneOrder[index]} over ${phoneOrder[index - 1]}`,
        ).toBeGreaterThan(weaker)
      }
    }
  })

  it('scores two records with nothing in common at zero', () => {
    expect(AGREEMENT_SCORES.different.different).toBe(0)
    expect(AGREEMENT_SCORES.unknown.unknown).toBe(0)
    // The control: a table of zeroes would satisfy that and detect nothing.
    expect(AGREEMENT_SCORES.identical.identical).toBe(1000)
  })
})

describe('classifyPhoneAgreement', () => {
  it.each([
    ['0501234567', '+971501234567', 'identical'],
    ['00971501234567', '971 50 123 4567', 'identical'],
    ['٠٥٠١٢٣٤٥٦٧', '(050) 123-4567', 'identical'],
    ['+447700900123', '00447700900123', 'identical'],
    ['+971501234567', '+971501234568', 'one_digit_apart'],
    ['+971501234567', '+971521234567', 'one_digit_apart'],
    ['+971501234567', '+971501234576', 'digits_transposed'],
    ['+971501234567', '+971501234657', 'digits_transposed'],
    ['+447700900123', '+44770090012', 'one_digit_shifted'],
    ['+971501234567', '+971587654321', 'different'],
    ['+971501234567', '+447700900123', 'different'],
    // Neither of these can be keyed, so there is no comparison to make. `unknown` is an absent
    // signal and not a weak match — see the note on the class.
    ['02 123 4567', '02 123 4568', 'unknown'],
    ['', '+971501234567', 'unknown'],
    ['not a number', 'also not a number', 'unknown'],
  ] as const)('reads %j against %j as %s', (left, right, expected) => {
    expect(classifyPhoneAgreement(left, right)).toBe(expected)
    // Symmetric, on every row, because the candidate query's ordering decides which side is `a`.
    expect(classifyPhoneAgreement(right, left)).toBe(expected)
  })

  it('treats an absent number as absent rather than as a match', () => {
    expect(classifyPhoneAgreement(null, null)).toBe('unknown')
    expect(classifyPhoneAgreement(undefined, '+971501234567')).toBe('unknown')
    expect(classifyPhoneAgreement(null, undefined)).toBe('unknown')
    // The control: two rows with no number must not be `identical`, which would auto-merge every
    // number-less contact in the table into one.
    expect(AGREEMENT_SCORES.unknown.unknown / 1000).toBeLessThan(DUPLICATE_REVIEW_THRESHOLD)
  })

  it('does not report a transposition for two digits that are the same', () => {
    // `…4455` against `…4455` with the pair "swapped" is the same string, and a classifier that
    // counted equal digits as a transposition would report a near match for every identical number.
    expect(classifyPhoneAgreement('+971504455555', '+971504455555')).toBe('identical')
    // Two digits differing but not adjacent is not a transposition either.
    expect(classifyPhoneAgreement('+971501234567', '+971511234577')).toBe('different')
  })

  it('does not call an extra digit a shift when the digits are not otherwise in order', () => {
    // A length difference of one is necessary and not sufficient: the shorter must actually be the
    // longer with one digit taken out, or every 11-digit number is "a shift away" from every 12.
    expect(classifyPhoneAgreement('+447700900123', '+44770090012')).toBe('one_digit_shifted')
    expect(classifyPhoneAgreement('+447700900123', '+44112233445')).toBe('different')
  })
})

describe('labelSimilarityPerMille and classifyLabelAgreement', () => {
  it('extracts the trigrams pg_trgm extracts', () => {
    // Two leading spaces, one trailing, per word. Pinned to what `show_trgm('ab')` returns, because
    // the candidate query's GIN index computes the other half of this comparison.
    expect([...labelTrigrams('ab')].sort()).toEqual(['  a', ' ab', 'ab '])
    expect(labelTrigrams('0042 customer').size).toBe(14)
    // The control: a different word must not produce the same set.
    expect([...labelTrigrams('ba')].sort()).not.toEqual(['  a', ' ab', 'ab '])
  })

  it.each([
    ['Customer 0042', 'Customer 0042', 1000, 'identical'],
    ['Customer 0042', '0042 Customer', 1000, 'identical'],
    ['Customer 0042', 'CUSTOMER-0042', 1000, 'identical'],
    ['  customer   0042  ', 'Customer 0042', 1000, 'identical'],
    ['Customer 0042', 'Customer 00042', 933, 'near'],
    // The measurement the `near` boundary is set from: two DIFFERENT records, 750.
    ['Customer 0042', 'Customer 0043', 750, 'partial'],
    ['Customer 0042', 'Custumer 0042', 647, 'partial'],
    ['Customer 0042', 'Customer', 643, 'partial'],
    ['Customer 0042', '0042', 357, 'different'],
    ['Customer 0042', 'Client 0042', 300, 'different'],
    ['Customer 0042', 'عميل 0042', 263, 'different'],
  ] as const)('reads %j against %j as %i per mille (%s)', (left, right, similarity, agreement) => {
    expect(labelSimilarityPerMille(left, right)).toBe(similarity)
    expect(labelSimilarityPerMille(right, left)).toBe(similarity)
    expect(classifyLabelAgreement(left, right)).toBe(agreement)
    expect(classifyLabelAgreement(right, left)).toBe(agreement)
  })

  it('keeps two different record serials out of the near band', () => {
    // This is the false merge the `near` boundary exists to prevent: `Customer 0042` and
    // `Customer 0043` on one family handset are two people, and `near` crossed with an identical
    // number is an automatic merge.
    expect(labelSimilarityPerMille('Customer 0042', 'Customer 0043')).toBeLessThan(
      LABEL_NEAR_THRESHOLD,
    )
    const scored = scoreDuplicatePair(
      { phone: '+971590002014', label: 'Customer 2014' },
      { phone: '+971590002014', label: 'Customer 2015' },
    )
    expect(scored.verdict).toBe('review')
    expect(scored.score).toBeLessThan(DUPLICATE_AUTO_MERGE_THRESHOLD)
  })

  it('folds Arabic orthography and Latin accents, which unaccent cannot do in an index', () => {
    expect(classifyLabelAgreement('عميل 0042', 'عمِيل 0042')).toBe('identical')
    expect(classifyLabelAgreement('ليلى 0402', 'ليلي 0402')).toBe('identical')
    expect(classifyLabelAgreement('Renée 0503', 'Renée 0503')).toBe('identical')
    // The control: folding must not make two different labels agree.
    expect(classifyLabelAgreement('عميل 0042', 'عميل 0043')).not.toBe('identical')
  })

  it('has no label agreement where there is no label', () => {
    expect(classifyLabelAgreement(null, 'Customer 0042')).toBe('unknown')
    expect(classifyLabelAgreement(undefined, undefined)).toBe('unknown')
    expect(classifyLabelAgreement('   ', 'Customer 0042')).toBe('unknown')
    // Punctuation folds to nothing, and a key built from nothing agrees with every other such key.
    expect(classifyLabelAgreement('--', '...')).toBe('unknown')
    expect(labelSimilarityPerMille('--', '...')).toBe(0)
    // The control: `unknown` must not be the answer for a label that does fold to something.
    expect(classifyLabelAgreement('--', 'Customer 0042')).toBe('unknown')
    expect(classifyLabelAgreement('0042', 'Customer 0042')).toBe('different')
  })

  it('places the two boundaries where the comment says they are', () => {
    expect(LABEL_NEAR_THRESHOLD).toBe(800)
    expect(LABEL_PARTIAL_THRESHOLD).toBe(450)
    expect(LABEL_NEAR_THRESHOLD).toBeGreaterThan(
      labelSimilarityPerMille('Customer 0042', 'Customer 0043'),
    )
    expect(LABEL_PARTIAL_THRESHOLD).toBeLessThan(
      labelSimilarityPerMille('Customer 0042', 'Custumer 0042'),
    )
  })
})

describe('the bands', () => {
  it('carries the provisional thresholds the manifest states', () => {
    expect(DUPLICATE_AUTO_MERGE_THRESHOLD).toBe(0.95)
    expect(DUPLICATE_REVIEW_THRESHOLD).toBe(0.7)
    expect(PROVISIONAL_DUPLICATE_THRESHOLDS).toEqual({ autoMerge: 0.95, review: 0.7 })
  })

  it.each([
    [1, 'auto_merge'],
    [0.96, 'auto_merge'],
    [0.95, 'auto_merge'],
    [0.94, 'review'],
    [0.72, 'review'],
    [0.7, 'review'],
    [0.69, 'distinct'],
    [0, 'distinct'],
  ] as const)('puts %d in the %s band', (score, verdict) => {
    expect(duplicateVerdict(score)).toBe(verdict)
    expect(DUPLICATE_VERDICTS).toContain(verdict)
  })

  it('takes injected thresholds, so the owner can tighten either one', () => {
    // C-CRM-05 will read the agreed figures from settings and pass them in. The point of the argument
    // is that this module does not have to change when they arrive.
    expect(duplicateVerdict(0.96, { autoMerge: 0.99, review: 0.8 })).toBe('review')
    expect(duplicateVerdict(0.75, { autoMerge: 0.99, review: 0.8 })).toBe('distinct')
    // The control: the same score under the shipped thresholds is a different verdict, or the
    // argument is being ignored.
    expect(duplicateVerdict(0.96)).toBe('auto_merge')
  })

  it('refuses a pair of thresholds that would merge what a human was meant to see', () => {
    expect(() => duplicateVerdict(0.5, { autoMerge: 0.7, review: 0.7 })).toThrow(
      /must be above review/,
    )
    expect(() => duplicateVerdict(0.5, { autoMerge: 0.5, review: 0.9 })).toThrow(RangeError)
    // The control: a valid pair must not throw, or the assertion above is only proving that it does.
    expect(() => duplicateVerdict(0.5, { autoMerge: 0.9, review: 0.5 })).not.toThrow()
  })
})

describe('scoreDuplicatePair', () => {
  it('reports the cell it used, so a reviewer can see why', () => {
    const scored = scoreDuplicatePair(
      { phone: '0590000042', label: 'Customer 0042' },
      { phone: '+971590000042', label: '0042 Customer' },
    )
    expect(scored).toEqual({
      score: 1,
      scorePerMille: 1000,
      phone: 'identical',
      label: 'identical',
      verdict: 'auto_merge',
    })
  })

  it('divides the per-mille figure by 1000 and nothing else', () => {
    for (const phone of PHONE_AGREEMENTS) {
      for (const label of LABEL_AGREEMENTS) {
        expect(AGREEMENT_SCORES[phone][label] / 1000).toBeLessThanOrEqual(1)
      }
    }
    const scored = scoreDuplicatePair(
      { phone: '+971590000601', label: 'Customer 0601' },
      { phone: '+971590000602', label: 'Customer 0601' },
    )
    expect(scored.scorePerMille).toBe(AGREEMENT_SCORES.one_digit_apart.identical)
    expect(scored.score).toBe(scored.scorePerMille / 1000)
  })

  it('scores two empty records at zero rather than at one', () => {
    const scored = scoreDuplicatePair({ phone: null, label: null }, { phone: null, label: null })
    expect(scored).toEqual({
      score: 0,
      scorePerMille: 0,
      phone: 'unknown',
      label: 'unknown',
      verdict: 'distinct',
    })
  })
})
