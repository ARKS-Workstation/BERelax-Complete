import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { SEGMENT_LIMITS, SMS_ENCODINGS, type SmsEncoding } from './encoding.ts'
import { segmentSms } from './segments.ts'

/**
 * C-AUTO-02's two property acceptance lines.
 *
 * 1. "For every length 1..1000 in both encodings: `segments == ceil(length / perSegment)` with the
 *    single-segment boundaries exact at 160/161 for GSM-7 (153 per concatenated segment) and 70/71 for
 *    UCS-2 (67 per concatenated segment)."
 * 2. "Over generated strings containing astral-plane code points and combining marks: no surrogate pair
 *    and no grapheme cluster is split across a segment boundary."
 *
 * ## Why both properties carry an explicit timeout
 *
 * `vitest.config.ts` declares no `testTimeout`, so the default is 5,000 ms. Two thousand segmentations,
 * half of them running a grapheme walk over strings up to a thousand characters long, is comfortably
 * inside that on an idle machine and is not on one running four verifies on four cores — and the failure
 * arrives as "test timed out", which names the wrong thing entirely. So the budget is stated.
 *
 * ## The controls
 *
 * A property over a formula is satisfied by an implementation that contains the same formula twice, and
 * "no cluster is split" is satisfied perfectly by a splitter that returns the whole body as one part. So
 * each property below is paired with something that must fail: the one-limit formula is shown to
 * DISAGREE with the two-limit one on seven lengths rather than being assumed to differ, and the cluster
 * check is run against a deliberately unit-aligned split and asserted to catch it.
 */

const CHARACTER: Readonly<Record<SmsEncoding, string>> = {
  // One septet each and one code unit each, so "length" and "units" coincide and the property is about
  // the segment arithmetic rather than about the unit counter, which `encoding.test.ts` covers.
  'GSM-7': 'a',
  'UCS-2': 'ت',
}

/** The count the acceptance line states: the single limit first, then the concatenated one. */
function expectedSegments(length: number, encoding: SmsEncoding): number {
  const limits = SEGMENT_LIMITS[encoding]
  return length <= limits.single ? 1 : Math.ceil(length / limits.concatenated)
}

describe('every length from 1 to 1000, in both encodings', () => {
  it('counts ceil(length / perSegment) segments, with the single-segment capacity applied first', () => {
    const disagreements: string[] = []
    for (const encoding of SMS_ENCODINGS) {
      const character = CHARACTER[encoding]
      for (let length = 1; length <= 1000; length += 1) {
        const result = segmentSms(character.repeat(length))
        expect(result.encoding, `${encoding} at ${length}`).toBe(encoding)
        expect(result.units, `${encoding} units at ${length}`).toBe(length)
        const expected = expectedSegments(length, encoding)
        if (result.segments !== expected)
          disagreements.push(`${encoding} ${length}: ${result.segments} != ${expected}`)
        // A body of single-unit characters has one code point per grapheme, so the cluster-safe count
        // and the unit arithmetic must agree here. Where they do not, the extra segment is real and
        // `segments.test.ts` covers it — but it must not appear for plain text.
        expect(result.unitSegments, `${encoding} unitSegments at ${length}`).toBe(result.segments)
        expect(result.parts.join(''), `${encoding} parts at ${length}`).toBe(
          character.repeat(length),
        )
      }
    }
    // Reported all at once rather than failing on the first, because "off by one at 154" and "off by one
    // everywhere above 153" are different bugs and the first message would look identical.
    expect(disagreements, 'the segment count disagrees with ceil(length / perSegment)').toEqual([])
  }, 30_000)

  it('is exact at 160/161 and 306/307 for GSM-7, and 70/71 and 134/135 for UCS-2', () => {
    // The four boundaries the acceptance line names, spelled out rather than left to the loop above: a
    // loop that agreed with a wrong formula would pass, and these are the numbers docs/04 §5 quotes.
    expect(segmentSms('a'.repeat(160)).segments).toBe(1)
    expect(segmentSms('a'.repeat(161)).segments).toBe(2)
    expect(segmentSms('a'.repeat(306)).segments).toBe(2)
    expect(segmentSms('a'.repeat(307)).segments).toBe(3)
    expect(segmentSms('ت'.repeat(70)).segments).toBe(1)
    expect(segmentSms('ت'.repeat(71)).segments).toBe(2)
    expect(segmentSms('ت'.repeat(134)).segments).toBe(2)
    expect(segmentSms('ت'.repeat(135)).segments).toBe(3)
  })

  it('would fail if one limit were used for both cases, which is the control on the formula', () => {
    // The control. `expectedSegments` is a second copy of the rule, so the property above is only worth
    // something if the rule it encodes is not the obvious wrong one — and the obvious wrong one is
    // `ceil(length / concatenated)` for every length, which differs only in the seven septets between
    // the concatenated limit and the single one.
    const oneLimit = (length: number, encoding: SmsEncoding): number =>
      Math.ceil(length / SEGMENT_LIMITS[encoding].concatenated)
    const differing: number[] = []
    for (let length = 1; length <= 1000; length += 1) {
      if (oneLimit(length, 'GSM-7') !== expectedSegments(length, 'GSM-7')) differing.push(length)
    }
    expect(differing).toEqual([154, 155, 156, 157, 158, 159, 160])
    // And the implementation follows the two-limit rule on every one of them.
    for (const length of differing) {
      expect(segmentSms('a'.repeat(length)).segments, `${length}`).toBe(1)
      expect(oneLimit(length, 'GSM-7')).toBe(2)
    }
    // The UCS-2 side has three such lengths, for the same reason and a smaller gap.
    const ucs2 = [68, 69, 70].filter(
      (length) => oneLimit(length, 'UCS-2') !== expectedSegments(length, 'UCS-2'),
    )
    expect(ucs2).toEqual([68, 69, 70])
  })
})

/** The pieces the generator assembles a body from: everything that makes a cluster interesting. */
const ZWJ = String.fromCodePoint(0x200d)
const VARIATION_SELECTOR_16 = String.fromCodePoint(0xfe0f)
const PIECES: readonly string[] = [
  'a',
  'Booking ',
  'ت',
  'م',
  '€',
  '{',
  // Astral: a surrogate pair that must never be cut.
  '\u{1f600}',
  '\u{1f9d8}',
  // A regional-indicator flag: two astral code points that are one grapheme.
  '\u{1f1e6}\u{1f1ea}',
  // A ZWJ sequence: eight code units, one glyph.
  `\u{1f468}${ZWJ}\u{1f469}${ZWJ}\u{1f467}`,
  // An emoji whose presentation depends on a variation selector, which is invisible and still billed.
  `❤${VARIATION_SELECTOR_16}`,
  // Combining marks on a Latin base and on an Arabic one.
  `e${String.fromCodePoint(0x0301)}`,
  `و${String.fromCodePoint(0x0654)}`,
  // A skin-tone modifier, which is an astral code point attached to another astral code point.
  `\u{1f44d}\u{1f3fd}`,
]

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** Every offset in `body` at which a grapheme cluster begins, plus the end. */
function clusterBoundaries(body: string): ReadonlySet<number> {
  const boundaries = new Set<number>([0, body.length])
  let offset = 0
  for (const piece of GRAPHEMES.segment(body)) {
    offset += piece.segment.length
    boundaries.add(offset)
  }
  return boundaries
}

/**
 * The offsets a split actually cut at, and whether any of them falls inside a cluster.
 *
 * Computed from `Intl.Segmenter` here rather than from the module's own chunking, deliberately: a check
 * that reused the implementation's idea of a cluster would agree with it by construction.
 */
function splitsACluster(body: string, parts: readonly string[]): boolean {
  const boundaries = clusterBoundaries(body)
  let offset = 0
  for (const part of parts) {
    offset += part.length
    if (!boundaries.has(offset)) return true
  }
  return false
}

describe('generated bodies with astral code points and combining marks', () => {
  it('never splits a surrogate pair or a grapheme cluster across a segment boundary', () => {
    let multiSegment = 0
    let sawAstral = 0
    fc.assert(
      fc.property(
        // `minLength: 40` and not 1: fast-check biases towards small arrays, and a body of three pieces
        // is one segment — so a generator with no floor produced 200 single-segment bodies and "no
        // cluster is split across a boundary" held because there were no boundaries. The discrimination
        // assertions below are what turned that from a green run into a red one.
        fc.array(fc.constantFrom(...PIECES), { minLength: 40, maxLength: 200 }),
        (pieces) => {
          const body = pieces.join('')
          const result = segmentSms(body)
          expect(result.parts.join('')).toBe(body)
          expect(result.parts).toHaveLength(result.segments)
          // Every generated cluster is far shorter than a segment, so none of them is unsplittable.
          expect(result.splitClusters).toEqual([])
          expect(
            splitsACluster(body, result.parts),
            'a segment boundary falls inside a grapheme cluster',
          ).toBe(false)
          for (const part of result.parts) {
            expect(/[\uD800-\uDBFF]$/.test(part)).toBe(false)
            expect(/^[\uDC00-\uDFFF]/.test(part)).toBe(false)
          }
          if (result.segments > 1) multiSegment += 1
          if (body.length > [...body].length) sawAstral += 1
        },
      ),
      { numRuns: 200 },
    )
    // The discrimination assertions. Without them this file would pass against a splitter that returns
    // the whole body as one part, and against a generator that only ever produced ASCII.
    expect(multiSegment, 'no generated body needed more than one segment').toBeGreaterThan(20)
    expect(sawAstral, 'no generated body contained an astral code point').toBeGreaterThan(20)
  }, 30_000)

  it('catches a unit-aligned split, which is the control on the cluster check itself', () => {
    // A splitter that counts code units and stops at 67 is the obvious implementation and the wrong one.
    // Run the same check against it: if `splitsACluster` cannot see this, it cannot see anything.
    const body = '\u{1f600}'.repeat(67)
    const naive: string[] = []
    for (let index = 0; index < body.length; index += 67) naive.push(body.slice(index, index + 67))
    expect(naive.join('')).toBe(body)
    expect(splitsACluster(body, naive)).toBe(true)
    // And the real split of the same body is not caught, so the two answers differ on one input.
    expect(splitsACluster(body, segmentSms(body).parts)).toBe(false)
  })
})
