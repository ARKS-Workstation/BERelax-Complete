import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { EXCLUSION_REASONS, exclusionReasonFrom } from './eligibility.ts'

/**
 * B-AVAIL-04 — the half of the eligibility read model that needs no database.
 *
 * The rest of it is asserted against real PostgreSQL in `eligibility.itest.ts`, because every rule it
 * applies is a join, a range subtraction or a view predicate and a mock would assert the mock. What is
 * here is the translation from the `case` expression's text into a typed reason, which is pure, and
 * which is only ever exercised on the path where the SQL and the TypeScript have drifted — exactly the
 * path that gets shipped untested.
 */
describe('EXCLUSION_REASONS', () => {
  it('is the seven reasons, in the order the rules are applied', () => {
    // The order is load-bearing rather than cosmetic: the `case` in `readEligibleTherapists` and
    // `ELIGIBILITY_EXCLUSION_REASONS` in `@berelax/core` mirror this list, and a therapist failing two
    // checks must be reported identically by both implementations or the agreement test in
    // `packages/fixtures` is comparing two different questions.
    expect(EXCLUSION_REASONS).toEqual([
      'not_employed',
      'missing_skill',
      'credential_missing',
      'credential_expired',
      'not_rostered',
      'on_approved_leave',
      'gender_mismatch',
    ])
  })

  it('puts gender_mismatch LAST, which is a decision and not the end of a list', () => {
    // B-AVAIL-05. Asserted as a position rather than as membership, because moving it earlier changes
    // the answer for a therapist who fails two checks — and it would report a person's recorded gender
    // to a caller that is already being told the therapist left in March. The pair in `packages/fixtures`
    // asserts the same position against real rows, on both implementations.
    expect(EXCLUSION_REASONS.at(-1)).toBe('gender_mismatch')
    expect(EXCLUSION_REASONS.indexOf('gender_mismatch')).toBe(EXCLUSION_REASONS.length - 1)
  })
})

describe('exclusionReasonFrom', () => {
  for (const reason of EXCLUSION_REASONS) {
    it(`passes ${reason} through unchanged`, () => {
      expect(exclusionReasonFrom(reason)).toBe(reason)
    })
  }

  it('refuses a reason it does not know, rather than returning it or undefined', () => {
    // The permissive version of this function — a cast, or a lookup with a fall-back — turns a reason
    // the TypeScript side has not learned about into a therapist with no usable reason attached, and a
    // therapist with no reason attached is indistinguishable from an eligible one at the call site. So
    // a seventh reason added to the SQL and not to the list above has to read as the defect it is.
    let caught: unknown = null
    try {
      exclusionReasonFrom('on_unpaid_sabbatical')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).message).toContain('on_unpaid_sabbatical')
    // The message names every reason it does know, because the useful next step is the diff between
    // the two lists rather than the fact that one value was wrong.
    for (const reason of EXCLUSION_REASONS) {
      expect((caught as AppError).message).toContain(reason)
    }
  })

  it('refuses the near misses a hand-written case expression actually produces', () => {
    // A typo, a plural, a spelling from another layer's vocabulary, and the empty string a `case` with
    // no matching branch would produce if somebody replaced its `null` fall-through.
    for (const wrong of ['not_rostered ', 'missing_skills', 'onLeave', 'on_leave', '']) {
      expect(() => exclusionReasonFrom(wrong)).toThrow(AppError)
    }
  })
})
