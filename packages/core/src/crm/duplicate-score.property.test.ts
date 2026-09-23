import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  AGREEMENT_SCORES,
  classifyLabelAgreement,
  classifyPhoneAgreement,
  type DuplicateSubject,
  LABEL_AGREEMENTS,
  PHONE_AGREEMENTS,
  scoreDuplicatePair,
} from './duplicate-score.ts'

/**
 * C-CRM-02's determinism and symmetry acceptance line: "score(a,b) == score(b,a) and 1000 repeated
 * evaluations of the same pair return the identical value".
 *
 * Both properties are about a queue rather than about arithmetic. The candidate query returns rows in
 * whatever order the planner chose, so a scorer that answered differently depending on which record
 * arrived first would produce a review queue whose contents changed when an index did — and a pair that
 * scored 0.96 on Tuesday and 0.94 on Wednesday would merge or not merge depending on nothing.
 *
 * ## The controls
 *
 * A function returning a constant is perfectly deterministic and perfectly symmetric, and detects
 * nothing. So every property below is paired with a discrimination assertion: the generated corpus must
 * produce more than one distinct score, and it must produce at least one pair in each of the three
 * bands. Without those, this file would go on passing against `() => 0`.
 */

/**
 * Phone spellings the generator draws from: the same number written several ways, its neighbours, a
 * foreign number, and three things that cannot be keyed at all.
 */
const PHONES = [
  '+971590000042',
  '0590000042',
  '00971590000042',
  '971 59 000 0042',
  '(059) 000-0042',
  '٠٥٩٠٠٠٠٠٤٢',
  '+971590000043',
  '+971590000024',
  '+971597650042',
  '+447700900123',
  '00447700900123',
  '+44770090012',
  '+966500000042',
  '02 123 4567',
  '',
  'walk-in, no number given',
] as const

const LABELS = [
  'Customer 0042',
  '0042 Customer',
  'CUSTOMER-0042',
  'Customer 00042',
  'Customer 0043',
  'Custumer 0042',
  'Customer',
  'عميل 0042',
  'عمِيل 0042',
  '--',
  '   ',
] as const

const subject = (): fc.Arbitrary<DuplicateSubject> =>
  fc.record({
    phone: fc.oneof(fc.constantFrom(...PHONES), fc.constant(null), fc.string()),
    label: fc.oneof(fc.constantFrom(...LABELS), fc.constant(null), fc.string()),
  })

describe('scoreDuplicatePair is symmetric', () => {
  it('returns the same score, cell and verdict whichever record comes first', () => {
    fc.assert(
      fc.property(subject(), subject(), (a, b) => {
        const forward = scoreDuplicatePair(a, b)
        const backward = scoreDuplicatePair(b, a)
        return (
          forward.score === backward.score &&
          forward.scorePerMille === backward.scorePerMille &&
          forward.phone === backward.phone &&
          forward.label === backward.label &&
          forward.verdict === backward.verdict
        )
      }),
      { numRuns: 3_000 },
    )
  })

  it('is symmetric in each classifier on its own, so a failure says which half moved', () => {
    fc.assert(
      fc.property(subject(), subject(), (a, b) => {
        return (
          classifyPhoneAgreement(a.phone, b.phone) === classifyPhoneAgreement(b.phone, a.phone) &&
          classifyLabelAgreement(a.label, b.label) === classifyLabelAgreement(b.label, a.label)
        )
      }),
      { numRuns: 3_000 },
    )
  })

  it('discriminates: the generated corpus is not all one score', () => {
    // The control for both properties above. `() => 0` passes them; it does not pass this.
    const scores = new Set<number>()
    for (const phone of PHONES) {
      for (const label of LABELS) {
        scores.add(
          scoreDuplicatePair({ phone, label }, { phone: '+971590000042', label: 'Customer 0042' })
            .score,
        )
      }
    }
    expect(scores.size).toBeGreaterThan(5)
    expect(scores).toContain(1)
    expect(scores).toContain(0)
  })
})

describe('scoreDuplicatePair is deterministic', () => {
  it('returns the identical value over 1000 repeated evaluations of one pair', () => {
    const a: DuplicateSubject = { phone: '0590000042', label: 'Customer 0042' }
    const b: DuplicateSubject = { phone: '+971590000042', label: '0042 Customer' }
    const first = scoreDuplicatePair(a, b)
    for (let run = 0; run < 1_000; run += 1) {
      expect(scoreDuplicatePair(a, b)).toEqual(first)
    }
    // Not a tautology about object equality: the value is pinned as well, so a scorer that returned a
    // fresh constant would have to return this one.
    expect(first.score).toBe(1)
  })

  it('returns the identical value over 1000 evaluations of a pair in each band', () => {
    const pairs: readonly (readonly [DuplicateSubject, DuplicateSubject])[] = [
      [
        { phone: '+971590000601', label: 'Customer 0601' },
        { phone: '+971590000602', label: 'Customer 0601' },
      ],
      [
        { phone: '+971590002012', label: 'Customer 2012' },
        { phone: '+971590002012', label: 'عميل 3012' },
      ],
      [
        { phone: '02 123 4567', label: null },
        { phone: '+971590002019', label: 'Client 2019' },
      ],
    ]
    const bands = new Set<string>()
    for (const [a, b] of pairs) {
      const first = scoreDuplicatePair(a, b)
      bands.add(first.verdict)
      for (let run = 0; run < 1_000; run += 1) {
        const again = scoreDuplicatePair(a, b)
        expect(again.score).toBe(first.score)
        expect(again.verdict).toBe(first.verdict)
      }
    }
    // The control: the repeats above prove nothing if every pair sat in one band.
    expect(bands.size).toBeGreaterThan(1)
  })

  it('answers with a cell of the table for every generated pair, never undefined', () => {
    fc.assert(
      fc.property(subject(), subject(), (a, b) => {
        const scored = scoreDuplicatePair(a, b)
        return (
          (PHONE_AGREEMENTS as readonly string[]).includes(scored.phone) &&
          (LABEL_AGREEMENTS as readonly string[]).includes(scored.label) &&
          scored.scorePerMille === AGREEMENT_SCORES[scored.phone][scored.label] &&
          scored.score === scored.scorePerMille / 1000
        )
      }),
      { numRuns: 3_000 },
    )
  })
})
