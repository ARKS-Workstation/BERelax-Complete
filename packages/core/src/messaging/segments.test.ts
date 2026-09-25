import { describe, expect, it } from 'vitest'
import { SEGMENT_LIMITS } from './encoding.ts'
import { segmentSms, splitSmsSegments } from './segments.ts'

/**
 * Segment counting, and the split that has to keep a character whole.
 *
 * The boundaries are asserted on both sides — 160/161 and 306/307 for GSM-7, 70/71 and 134/135 for
 * UCS-2 — because an off-by-one here is a price that is wrong by a third and looks plausible. The
 * property test over every length from 1 to 1000 lives in `segments.property.test.ts`; this file holds
 * the boundaries themselves, the cluster-safety cases that a generator would only reach by luck, and the
 * invariants every result has to satisfy.
 */

/** Two characters that force nothing, and two that force everything. */
const ARABIC = 'ت'
const EMOJI = '\u{1f600}'
const ZWJ = String.fromCodePoint(0x200d)
const COMBINING_ACUTE = String.fromCodePoint(0x0301)

/**
 * The two halves of a surrogate pair, at the ends of a part.
 *
 * Asserted by codepoint range rather than with `String.prototype.isWellFormed`, which is ES2024 and this
 * repository compiles against the ES2023 lib. The range is also the more specific claim: it names WHICH
 * half went missing, which is the difference between a packer that overshot and one that undershot.
 */
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/
const LEADING_LOW_SURROGATE = /^[\uDC00-\uDFFF]/

describe('segment counting at the boundaries', () => {
  it('fits 160 GSM-7 characters in one segment and 161 in two', () => {
    expect(segmentSms('a'.repeat(160)).segments).toBe(1)
    expect(segmentSms('a'.repeat(161)).segments).toBe(2)
  })

  it('drops to 153 per segment once concatenated, because of the UDH header', () => {
    expect(segmentSms('a'.repeat(306)).segments).toBe(2)
    expect(segmentSms('a'.repeat(307)).segments).toBe(3)
    // And the case in between the two limits, which is the one a single limit would get wrong: 154 is
    // above the concatenated capacity and below the single one, so it is one segment.
    expect(segmentSms('a'.repeat(154)).segments).toBe(1)
  })

  it('fits 70 UCS-2 characters in one segment and 67 per segment after that', () => {
    expect(segmentSms(ARABIC.repeat(70)).segments).toBe(1)
    expect(segmentSms(ARABIC.repeat(71)).segments).toBe(2)
    expect(segmentSms(ARABIC.repeat(134)).segments).toBe(2)
    expect(segmentSms(ARABIC.repeat(135)).segments).toBe(3)
  })

  it('charges two septets for a GSM-7 extension character', () => {
    // 159 letters plus one brace is 161 septets, so it does not fit in one segment even though it is
    // 160 characters long.
    const result = segmentSms(`${'a'.repeat(159)}{`)
    expect(result.units).toBe(161)
    expect(result.segments).toBe(2)
  })

  it('is zero segments for an empty body, not one', () => {
    const empty = segmentSms('')
    expect(empty.segments).toBe(0)
    expect(empty.parts).toEqual([])
    expect(empty.remaining).toBe(SEGMENT_LIMITS['GSM-7'].single)
  })

  it('reports remaining capacity against the right limit', () => {
    expect(segmentSms('a'.repeat(100)).remaining).toBe(60)
    expect(segmentSms('a'.repeat(200)).remaining).toBe(306 - 200)
    // The UCS-2 side of the same claim: the budget an author is watching is against 70, then against
    // whatever the concatenated segments add up to.
    expect(segmentSms(ARABIC.repeat(50)).remaining).toBe(20)
    expect(segmentSms(ARABIC.repeat(100)).remaining).toBe(134 - 100)
  })
})

describe('the cost asymmetry that matters for this business', () => {
  it('makes the same message cost more than twice as much in Arabic', () => {
    const english = 'Your BE RELAX appointment is confirmed. See you soon.'
    const arabic = 'تم تأكيد موعدك في بي ريلاكس. نراكم قريباً.'
    expect(segmentSms(english).segments).toBe(1)
    expect(segmentSms(english).encoding).toBe('GSM-7')
    expect(segmentSms(arabic).encoding).toBe('UCS-2')
    // Shorter in characters, and it still costs a whole segment at 70 rather than 160.
    expect(arabic.length).toBeLessThan(english.length)
    expect(segmentSms(arabic).singleLimit).toBe(70)
  })

  it('makes a 150-character Arabic body three segments, which docs/04 section 5 asks for by name', () => {
    const result = segmentSms(ARABIC.repeat(150))
    expect(result.encoding).toBe('UCS-2')
    expect(result.segments).toBe(3)
    // The control, and the whole point of the screen this feeds: the same 150 characters in English are
    // one segment. A preview that reported three for both would be useless and would pass the assertion
    // above.
    expect(segmentSms('a'.repeat(150)).segments).toBe(1)
  })
})

describe('the split keeps a character whole', () => {
  it('reassembles the body exactly, in order, in every part count', () => {
    for (const body of [
      '',
      'a',
      'a'.repeat(161),
      ARABIC.repeat(150),
      EMOJI.repeat(67),
      `${'a'.repeat(159)}{`,
    ]) {
      const result = segmentSms(body)
      expect(result.parts.join(''), `${body.length} chars`).toBe(body)
      expect(result.parts).toHaveLength(result.segments)
    }
  })

  it('never ends a part on half of a surrogate pair', () => {
    // 67 emoji are 134 code units, which the arithmetic calls two segments of 67. It cannot be done: 67
    // is odd, so the 34th emoji would straddle the boundary and both halves would arrive as replacement
    // characters. Three parts, none of which ends mid-pair.
    const result = segmentSms(EMOJI.repeat(67))
    // The parts first and the counts second, deliberately: a splitter that packs code units produces two
    // parts here, and asserting the count before the halves would fail with "expected 2 to be 3" — which
    // names the symptom rather than the broken pair that caused it.
    for (const part of result.parts) {
      expect(
        TRAILING_HIGH_SURROGATE.test(part),
        'a part ending in a high surrogate is a pair cut in half',
      ).toBe(false)
      expect(
        LEADING_LOW_SURROGATE.test(part),
        'a part starting with a low surrogate has lost its high half',
      ).toBe(false)
      expect(part.length % 2).toBe(0)
    }
    expect(result.unitSegments).toBe(2)
    expect(result.segments).toBe(3)
    expect(result.clusterCostsAnExtraSegment).toBe(true)
    expect(result.parts.map((part) => [...part].length)).toEqual([33, 33, 1])
  })

  it('never splits a ZWJ sequence or a combining mark across a boundary', () => {
    // A family emoji is eight code units that render as one glyph, and a base letter with a combining
    // acute is two. Both are graphemes; splitting either changes what the recipient sees rather than
    // breaking it visibly, which is the worse failure of the two.
    const family = `${'\u{1f468}'}${ZWJ}${'\u{1f469}'}${ZWJ}${'\u{1f467}'}`
    const body = `${family}${`e${COMBINING_ACUTE}`}`.repeat(20)
    const result = segmentSms(body)
    expect(result.segments).toBeGreaterThan(1)
    expect(result.splitClusters).toEqual([])
    for (const part of result.parts) {
      expect(part.startsWith(ZWJ), 'a part beginning with a joiner is a sequence cut in half').toBe(
        false,
      )
      expect(part.endsWith(ZWJ), 'a part ending in a joiner is a sequence cut in half').toBe(false)
      expect(
        part.startsWith(COMBINING_ACUTE),
        'a part beginning with a combining mark has lost its base letter',
      ).toBe(false)
    }
  })

  it('names a cluster no segment could hold rather than splitting one quietly', () => {
    // 80 combining marks on one letter is one grapheme cluster of 81 code units, and a concatenated
    // UCS-2 segment holds 67. There is no split that keeps it whole, so the only honest answer is to
    // break it at a code point — which never breaks a surrogate pair — and to say so.
    const overlong = `a${COMBINING_ACUTE.repeat(80)}`
    const result = segmentSms(overlong)
    expect(result.units).toBe(81)
    expect(result.splitClusters).toEqual([overlong])
    expect(result.parts.join('')).toBe(overlong)
    expect(result.segments).toBe(2)
    // The control: one mark fewer than a segment holds is not split and is not reported.
    const fits = `a${COMBINING_ACUTE.repeat(60)}`
    expect(segmentSms(fits).splitClusters).toEqual([])
  })

  it('fills each part to the concatenated limit and no further', () => {
    const limit = SEGMENT_LIMITS['UCS-2'].concatenated
    for (const part of splitSmsSegments(ARABIC.repeat(150))) {
      expect(part.length).toBeLessThanOrEqual(limit)
    }
    // Every part but the last is full, which is what makes the count minimal: a packer that opened a new
    // segment early would satisfy every assertion above and charge for a segment nobody needs.
    const parts = splitSmsSegments(ARABIC.repeat(150))
    expect(parts.slice(0, -1).map((part) => part.length)).toEqual([limit, limit])
  })

  it('is one part with the whole body whenever the body fits in a single segment', () => {
    // The single-segment capacity is larger than the concatenated one, so this is a separate branch and
    // a place an off-by-one would go unnoticed: 160 septets is one part, not one part of 153 plus one
    // of 7.
    expect(splitSmsSegments('a'.repeat(160))).toEqual(['a'.repeat(160)])
    expect(splitSmsSegments(ARABIC.repeat(70))).toEqual([ARABIC.repeat(70)])
  })
})
