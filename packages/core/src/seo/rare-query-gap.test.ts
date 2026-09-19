import { describe, expect, it } from 'vitest'
import { rareQueryGap, rareQueryGapExplanation } from './rare-query-gap.ts'

/**
 * G-SEO-01 — the rare-query gap is a stored fact, and the sentence is rendered from it.
 *
 * The claim that matters is the second one, and it is the easy one to fake: a hardcoded sentence
 * containing the right number satisfies "the string mentions the withheld clicks" for exactly as long as
 * the fixture does not change. So every assertion about the sentence is paired with a **different** input
 * that must produce a **different** sentence.
 */

const WINDOW = {
  queryClicks: 258,
  pageClicks: 329,
  queryImpressions: 5448,
  pageImpressions: 7588,
}

describe('the gap is derived from the two totals, never declared', () => {
  it('is the difference, in clicks and in impressions', () => {
    const gap = rareQueryGap(WINDOW)
    expect(gap.withheldClicks).toBe(329 - 258)
    expect(gap.withheldImpressions).toBe(7588 - 5448)
  })

  it('reports the withheld share in basis points rather than as a float percentage', () => {
    // 71/329 is 21.58%, which is 2158 bp. Integer, so two runs of one report produce the same bytes.
    expect(rareQueryGap(WINDOW).withheldShareBp).toBe(2158)
    expect(Number.isInteger(rareQueryGap(WINDOW).withheldShareBp)).toBe(true)
  })

  it('is zero when nothing was withheld, which is a real state and not an error', () => {
    const gap = rareQueryGap({
      queryClicks: 40,
      pageClicks: 40,
      queryImpressions: 900,
      pageImpressions: 900,
    })
    expect(gap.withheldClicks).toBe(0)
    expect(gap.withheldShareBp).toBe(0)
  })

  it('does not divide by zero on a property with no clicks at all', () => {
    const gap = rareQueryGap({
      queryClicks: 0,
      pageClicks: 0,
      queryImpressions: 0,
      pageImpressions: 0,
    })
    expect(gap.withheldShareBp).toBe(0)
    expect(Number.isNaN(gap.withheldShareBp)).toBe(false)
  })

  it('refuses the inverted case, which cannot come from Google', () => {
    // Google withholds rows; it does not invent them. More query clicks than page clicks means this
    // system summed something twice or compared two windows — and the alternative to refusing is a
    // dashboard sentence reading "-20 clicks are withheld".
    expect(() => rareQueryGap({ ...WINDOW, queryClicks: 400 })).toThrow(/can only ever total less/)
    expect(() => rareQueryGap({ ...WINDOW, queryImpressions: 9000 })).toThrow(
      /can only ever total less/,
    )
  })
})

describe('the explanation is rendered from the numbers it is given', () => {
  it('names the withheld clicks, the page total, the share and the impressions', () => {
    const sentence = rareQueryGapExplanation(WINDOW)
    expect(sentence).toContain('71')
    expect(sentence).toContain('329')
    expect(sentence).toContain('22%')
    expect(sentence).toContain('2140')
    expect(sentence).toContain('too rare')
  })

  it('changes when the stored numbers change — the control for the assertion above', () => {
    // Without this, a sentence with 71 baked into it passes the test above for ever, and the column the
    // criterion asks for would be decoration.
    const first = rareQueryGapExplanation(WINDOW)
    const second = rareQueryGapExplanation({
      queryClicks: 100,
      pageClicks: 480,
      queryImpressions: 3000,
      pageImpressions: 9000,
    })
    expect(second).not.toBe(first)
    expect(second).toContain('380')
    expect(second).not.toContain('71 of these')
  })

  it('renders a fraction of a percent rather than rounding a real gap to zero', () => {
    // 3/4000 is 0.075%, and "0%" beside a non-zero click count reads as a contradiction.
    const sentence = rareQueryGapExplanation({
      queryClicks: 3997,
      pageClicks: 4000,
      queryImpressions: 50_000,
      pageImpressions: 50_010,
    })
    expect(sentence).toContain('0.1%')
    expect(sentence).not.toContain('(0%)')
  })

  it('says something different when nothing was withheld, rather than printing a zero', () => {
    const sentence = rareQueryGapExplanation({
      queryClicks: 40,
      pageClicks: 40,
      queryImpressions: 900,
      pageImpressions: 900,
    })
    expect(sentence).toContain('add up to the page totals exactly')
    expect(sentence).not.toContain('withholds 0')
  })

  it('never claims nothing is wrong about an inverted gap: it refuses instead', () => {
    expect(() => rareQueryGapExplanation({ ...WINDOW, queryClicks: 1000 })).toThrow()
  })
})
