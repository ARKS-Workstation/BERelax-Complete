import { describe, expect, it } from 'vitest'
import fixture from '../../test/fixtures/encoding-cases.json' with { type: 'json' }
import { SEGMENT_LIMITS, SMS_ENCODINGS, type SmsEncoding, smsUnitsOf } from './encoding.ts'
import { segmentSms } from './segments.ts'

/**
 * C-AUTO-02's first acceptance line, as a table.
 *
 * "Table-driven test over a committed 40-string fixture: GSM-7 basic set, GSM-7 extended characters
 * counted as two septets (EUR { } [ ] ~ backslash pipe caret), a single Arabic character forcing UCS-2,
 * and an emoji forcing UCS-2 — expected encoding, segment count and remaining budget all asserted."
 *
 * ## Why the expectations are committed rather than derived
 *
 * `packages/core/test/fixtures/encoding-cases.json` holds the forty bodies with the answer each one must
 * produce, hand authored case by case. Nothing regenerates it and there is no `--emit` flag anywhere near
 * it, for the reason C-CRM-02's golden file gives: changing a committed answer is allowed and sometimes
 * right, changing one **without noticing** is not — and every one of these answers is a price.
 *
 * ## What the coverage assertions are for
 *
 * A table with forty rows in it proves nothing about which forty. So the four groups the acceptance line
 * names are counted, and the file fails if one of them is empty: a fixture that lost its extension
 * characters in a merge would otherwise go on passing as a fixture of thirty-one ASCII bodies.
 */

interface EncodingCase {
  readonly id: string
  readonly why: string
  readonly body: string
  readonly encoding: SmsEncoding
  readonly units: number
  readonly unitSegments: number
  readonly segments: number
  readonly remaining: number
  readonly forcedBy: readonly string[]
}

const cases = fixture.cases as readonly EncodingCase[]

describe('the committed fixture', () => {
  it('is 40 cases with no repeated id, each one saying why it is there', () => {
    expect(cases).toHaveLength(40)
    expect(new Set(cases.map((one) => one.id)).size).toBe(40)
    for (const one of cases) {
      // A fixture row nobody can read is a row nobody maintains, and the `why` is what a reviewer uses
      // to decide whether a changed number is a correction or a regression.
      expect(one.why.length, one.id).toBeGreaterThan(30)
      expect((SMS_ENCODINGS as readonly string[]).includes(one.encoding), one.id).toBe(true)
    }
  })

  it('states the same capacities the module does', () => {
    // The fixture carries the limits it was authored against. If the module's limits change, this fails
    // here rather than as forty unexplained arithmetic failures.
    expect(fixture.limits).toEqual(SEGMENT_LIMITS)
  })

  it('covers all four groups the acceptance line names', () => {
    const inGroup = (predicate: (one: EncodingCase) => boolean): number =>
      cases.filter(predicate).length
    // GSM-7 bodies drawn from the basic set: the alphabet, the digits, the accented letters, the
    // boundaries.
    expect(
      inGroup((one) => one.encoding === 'GSM-7' && one.units === [...one.body].length),
    ).toBeGreaterThanOrEqual(10)
    // Extension characters, which cost two septets: every one of the nine appears somewhere in the table.
    const extended = cases.filter((one) => one.units > [...one.body].length)
    expect(extended.length).toBeGreaterThanOrEqual(9)
    for (const character of ['€', '{', '}', '[', ']', '~', '\\', '|', '^']) {
      expect(
        extended.some((one) => one.body.includes(character)),
        `no case exercises the extension character ${character}`,
      ).toBe(true)
    }
    // A single Arabic character forcing UCS-2, and an emoji forcing UCS-2.
    expect(
      inGroup((one) => one.encoding === 'UCS-2' && one.forcedBy.includes('م')),
    ).toBeGreaterThanOrEqual(1)
    expect(
      inGroup((one) => one.encoding === 'UCS-2' && one.forcedBy.includes('\u{1f600}')),
    ).toBeGreaterThanOrEqual(2)
    // And the worked example the last acceptance line names, by id, so a rename cannot lose it.
    const worked = cases.find((one) => one.id === 'ucs2-arabic-150-the-docs-04-worked-example')
    expect(worked?.body).toHaveLength(150)
    expect(worked?.segments).toBe(3)
  })
})

describe('every committed case', () => {
  for (const one of cases) {
    it(`${one.id}: ${one.encoding}, ${one.segments} segment(s), ${one.remaining} units free`, () => {
      const result = segmentSms(one.body)
      expect(result.encoding).toBe(one.encoding)
      expect(result.units).toBe(one.units)
      expect(result.segments).toBe(one.segments)
      expect(result.unitSegments).toBe(one.unitSegments)
      // The remaining budget, which is the number an author watches while typing.
      expect(result.remaining).toBe(one.remaining)
      expect(result.forcedBy).toEqual(one.forcedBy)
      // Invariants no row states individually, asserted for all forty: the parts are the body, there are
      // as many of them as the count claims, and none of them exceeds the capacity it was packed into.
      expect(result.parts.join('')).toBe(one.body)
      expect(result.parts).toHaveLength(one.segments)
      const limit =
        one.segments === 1
          ? SEGMENT_LIMITS[one.encoding].single
          : SEGMENT_LIMITS[one.encoding].concatenated
      for (const part of result.parts) {
        // In UNITS and not characters: a GSM-7 part of 153 characters can be 160 septets, so a
        // character count would pass while the segment overflowed.
        expect(
          smsUnitsOf(part, one.encoding),
          `a part exceeds the ${limit}-unit capacity`,
        ).toBeLessThanOrEqual(limit)
      }
    })
  }
})
