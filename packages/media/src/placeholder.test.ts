import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  isWithinPlaceholderBand,
  PLACEHOLDER_CHROMA_MAX,
  PLACEHOLDER_LIGHTNESS_MAX,
  PLACEHOLDER_LIGHTNESS_MIN,
  placeholderCss,
  placeholderFor,
  rgbToOklch,
} from './placeholder.ts'

/**
 * Two separate claims, and conflating them is how this test would become worthless.
 *
 * **The conversion is right.** Pinned against Ottosson's published reference values. Eighteen
 * coefficients copied by hand is exactly the kind of code where one transposed digit produces plausible
 * numbers for grey and wrong ones for anything saturated.
 *
 * **The band holds for every input.** A property, because the input is a photograph's dominant colour and
 * there is no list of those. Note what this does *not* claim: that the photographs are in band. They are
 * not — `placeholderFor` clamps, and `media-derivatives.itest.ts` measures how far.
 */
describe('rgbToOklch', () => {
  it('matches the published reference values', () => {
    const red = rgbToOklch({ r: 255, g: 0, b: 0 })
    expect(red.lightness).toBeCloseTo(0.6279554, 5)
    expect(red.chroma).toBeCloseTo(0.2576833, 5)
    expect(red.hue).toBeCloseTo(29.2338851, 4)

    const white = rgbToOklch({ r: 255, g: 255, b: 255 })
    expect(white.lightness).toBeCloseTo(1, 6)
    expect(white.chroma).toBeCloseTo(0, 6)

    const black = rgbToOklch({ r: 0, g: 0, b: 0 })
    expect(black.lightness).toBeCloseTo(0, 6)
    expect(black.chroma).toBeCloseTo(0, 6)

    const green = rgbToOklch({ r: 0, g: 255, b: 0 })
    expect(green.lightness).toBeCloseTo(0.8664396, 5)
    expect(green.chroma).toBeCloseTo(0.2948272, 5)
    expect(green.hue).toBeCloseTo(142.4953401, 4)

    const blue = rgbToOklch({ r: 0, g: 0, b: 255 })
    expect(blue.lightness).toBeCloseTo(0.4520137, 5)
    expect(blue.chroma).toBeCloseTo(0.3132145, 5)
    expect(blue.hue).toBeCloseTo(264.0520206, 4)
  })

  it('is not a grey-only approximation', () => {
    // The control. A transposed coefficient, or the linearisation left out, still gives a neutral its
    // right lightness and zero chroma — so the pins above are only evidence when the saturated primaries
    // are distinguished from each other as well.
    const grey = rgbToOklch({ r: 128, g: 128, b: 128 })
    expect(grey.chroma).toBeCloseTo(0, 6)
    // 128/255 is 0.502 in sRGB and 0.2159 in linear light; OKLCH lightness is ~0.5998, not ~0.502.
    expect(grey.lightness).toBeCloseTo(0.5998, 3)
    expect(grey.lightness).not.toBeCloseTo(0.502, 2)
    const hues = [
      rgbToOklch({ r: 255, g: 0, b: 0 }).hue,
      rgbToOklch({ r: 0, g: 255, b: 0 }).hue,
      rgbToOklch({ r: 0, g: 0, b: 255 }).hue,
    ]
    expect(new Set(hues.map((hue) => Math.round(hue))).size).toBe(3)
  })

  it('refuses a channel that is not an sRGB channel', () => {
    for (const bad of [-1, 256, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => rgbToOklch({ r: bad, g: 0, b: 0 })).toThrow(
        /\[placeholder-channel-out-of-range\]/,
      )
    }
    expect(() => rgbToOklch({ r: 0, g: 0, b: 0 })).not.toThrow()
  })
})

describe('the placeholder band', () => {
  it('holds for every sRGB dominant colour', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (r, g, b) => {
          const placeholder = placeholderFor({ r, g, b })
          expect(isWithinPlaceholderBand(placeholder)).toBe(true)
          expect(placeholder.chroma).toBeLessThanOrEqual(PLACEHOLDER_CHROMA_MAX)
          expect(placeholder.lightness).toBeGreaterThanOrEqual(PLACEHOLDER_LIGHTNESS_MIN)
          expect(placeholder.lightness).toBeLessThanOrEqual(PLACEHOLDER_LIGHTNESS_MAX)
          // The hue survives: it is the only part of the measurement that carries the photograph's
          // character, and a clamp that rotated it would produce a colour unrelated to the image.
          expect(placeholder.hue).toBe(placeholder.measured.hue)
          // The measurement is kept, not overwritten, so a clamp can be reported rather than discovered.
          expect(placeholder.measured).toEqual(rgbToOklch({ r, g, b }))
        },
      ),
      { numRuns: 500 },
    )
  })

  it('reports whether it clamped, rather than always saying yes', () => {
    // The control for `clamped`, and the reason it matters: every one of the twelve fixture photographs
    // is clamped, so a hard-coded `true` would look correct against all of them.
    const dark = placeholderFor({ r: 24, g: 8, b: 8 })
    expect(dark.clamped).toBe(true)
    expect(dark.measured.lightness).toBeLessThan(PLACEHOLDER_LIGHTNESS_MIN)

    // rgb(230, 230, 230) measures L≈0.9255, C=0 — already inside the band, so nothing moves.
    const inBand = placeholderFor({ r: 230, g: 230, b: 230 })
    expect(inBand.clamped).toBe(false)
    expect(inBand.lightness).toBe(inBand.measured.lightness)
    expect(inBand.chroma).toBe(inBand.measured.chroma)

    // Chroma alone is enough to clamp: a light but vivid colour is in band on lightness and out on chroma.
    const vivid = placeholderFor({ r: 255, g: 200, b: 120 })
    expect(vivid.measured.chroma).toBeGreaterThan(PLACEHOLDER_CHROMA_MAX)
    expect(vivid.clamped).toBe(true)
    expect(vivid.chroma).toBe(PLACEHOLDER_CHROMA_MAX)
  })

  it('rejects an out-of-band colour', () => {
    // Without this, "every placeholder is in band" is satisfied by a predicate that returns true.
    expect(isWithinPlaceholderBand({ lightness: 0.9, chroma: 0.02, hue: 100 })).toBe(true)
    expect(isWithinPlaceholderBand({ lightness: 0.5, chroma: 0.02, hue: 100 })).toBe(false)
    expect(isWithinPlaceholderBand({ lightness: 0.99, chroma: 0.02, hue: 100 })).toBe(false)
    expect(isWithinPlaceholderBand({ lightness: 0.9, chroma: 0.2, hue: 100 })).toBe(false)
    expect(
      isWithinPlaceholderBand({
        lightness: PLACEHOLDER_LIGHTNESS_MAX,
        chroma: PLACEHOLDER_CHROMA_MAX,
        hue: 0,
      }),
    ).toBe(true)
  })
})

describe('placeholderCss', () => {
  it('renders the colour as an OKLCH function with a percentage lightness', () => {
    const css = placeholderCss({ lightness: 0.9012, chroma: 0.0234, hue: 107.04 })
    expect(css).toMatch(/^oklch\(90\.12% 0\.0234 107\.04\)$/)
    // The control: two different colours must not render the same string.
    expect(placeholderCss({ lightness: 0.88, chroma: 0.01, hue: 50 })).not.toBe(css)
  })
})
