import { describe, expect, it } from 'vitest'
import {
  GENDER_MATCHING_MODES,
  GENDER_MATCHING_SETTING_KEY,
  genderMatchingMode,
  genderMatchingModeSchema,
  STRICT_GENDER_MATCHING,
} from './gender-matching.ts'

/**
 * B-AVAIL-05 — the vocabulary, and the one function that decides what an unreadable setting means.
 *
 * The rule itself is `packages/core/src/availability/gender-match.ts` and the stored value is read by
 * `packages/db/src/settings/availability.ts`. What is asserted here is narrower and is the thing the
 * whole unit rests on: that **strict is what you get for saying nothing**, and that the only way to
 * reach the relaxed mode is to ask for it by its exact name.
 */
describe('the two modes', () => {
  it('is exactly strict and advisory — a third state is a decision nobody took', () => {
    // ADR 0020 and docs/01 decision 19 name two. `'off'` was in the registry's schema until this unit;
    // the length is asserted so a third label is a deliberate edit here rather than a widened string.
    expect([...GENDER_MATCHING_MODES]).toEqual(['strict', 'advisory'])
    expect(STRICT_GENDER_MATCHING).toBe('strict')
    expect(GENDER_MATCHING_SETTING_KEY).toBe('booking.same_gender_matching')
  })

  it('accepts only those two for WRITING, and refuses the one that was removed', () => {
    expect(genderMatchingModeSchema.safeParse('strict').success).toBe(true)
    expect(genderMatchingModeSchema.safeParse('advisory').success).toBe(true)
    // The narrowing this unit made. A value that can no longer be written can still be READ out of a
    // row an older build wrote, which is what the normaliser below is for.
    expect(genderMatchingModeSchema.safeParse('off').success).toBe(false)
    expect(genderMatchingModeSchema.safeParse('maybe').success).toBe(false)
  })
})

describe('genderMatchingMode — strict is the value that needs no argument', () => {
  /**
   * Everything a real database can hand back when nobody has configured anything, or when what was
   * configured has stopped being legal. `undefined` is the missing row, `null` is a `jsonb` null,
   * `'off'` is the mode this unit removed, and the object is what a half-finished migration leaves.
   */
  const unreadable: readonly unknown[] = [
    undefined,
    null,
    '',
    'off',
    'OFF',
    'Advisory',
    'advisory ',
    ' advisory',
    'strict',
    'STRICT',
    'maybe',
    0,
    1,
    true,
    false,
    Number.NaN,
    [],
    ['advisory'],
    {},
    { mode: 'advisory' },
  ]

  for (const value of unreadable) {
    it(`resolves ${JSON.stringify(value) ?? 'undefined'} to strict`, () => {
      expect(genderMatchingMode(value)).toBe('strict')
    })
  }

  it('returns advisory for the exact string, so the strict answer is not simply hard-wired', () => {
    // The control, and it is the whole point of having one: without it every assertion above is
    // satisfied by `() => 'strict'`, which is a function that has stopped being a setting.
    expect(genderMatchingMode('advisory')).toBe('advisory')
  })

  it('is total: no input throws, because a throw is a decision the caller would have to make', () => {
    // A reader that throws on a corrupted row leaves "what do we do now" to whichever call site
    // happens to be first, and the answer that ships is a try/catch with a fall-back in it.
    for (const value of [...unreadable, 'advisory', Symbol('advisory'), () => 'advisory']) {
      expect(() => genderMatchingMode(value)).not.toThrow()
    }
  })
})
