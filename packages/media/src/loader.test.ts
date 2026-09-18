import { describe, expect, it } from 'vitest'
import { CROP_NAMES, CROPS, type CropName } from './ladders.ts'
import { MAX_REQUESTED_WIDTH, mediaImageLoader } from './loader.ts'
import { DERIVATIVE_PATH_PATTERN, derivativePath, parseDerivativePath } from './url.ts'

const MEDIA_ID = '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f'
const HASH = '9f86d081884c7d65'

const srcFor = (crop: CropName): string =>
  derivativePath({
    mediaId: MEDIA_ID,
    contentHash: HASH,
    slot: 'hero',
    crop,
    width: CROPS[crop].widths[0] ?? 0,
    format: 'avif',
  })

/**
 * The loader is the only thing standing between a layout's arbitrary width and a bucket with eight files
 * in it, so the table test is the whole range rather than a handful of samples.
 *
 * Spaces has no image transformation (docs/08 §6): there is no origin that can answer 719px. A width the
 * loader invents is a 404 inside a `srcset`, and a browser resolves that by rendering nothing at all.
 */
describe('mediaImageLoader', () => {
  it('maps every requested width in 1..3000 to the nearest declared rung', () => {
    for (const crop of CROP_NAMES) {
      const rungs = CROPS[crop].widths
      const src = srcFor(crop)
      for (let width = 1; width <= MAX_REQUESTED_WIDTH; width += 1) {
        const served = parseDerivativePath(mediaImageLoader({ src, width }))
        expect(served, `${crop} @ ${width}`).toBeDefined()
        if (served === undefined) continue

        // 1. It is a rung, not an arbitrary number.
        expect(rungs, `${crop} @ ${width}`).toContain(served.width)
        // 2. No other rung is strictly closer — the "nearest" claim, checked against the whole ladder
        //    rather than against a second copy of the same arithmetic.
        const distance = Math.abs(served.width - width)
        for (const rung of rungs) {
          expect(Math.abs(rung - width), `${crop} @ ${width} vs ${rung}`).toBeGreaterThanOrEqual(
            distance,
          )
        }
        // 3. A tie goes to the larger rung.
        const tied = rungs.filter((rung) => Math.abs(rung - width) === distance)
        expect(served.width).toBe(Math.max(...tied))
      }
    }
  })

  it('changes the width and nothing else', () => {
    for (const crop of CROP_NAMES) {
      const served = parseDerivativePath(mediaImageLoader({ src: srcFor(crop), width: 900 }))
      expect(served).toEqual({
        mediaId: MEDIA_ID,
        contentHash: HASH,
        slot: 'hero',
        crop,
        width: crop === 'mobile' ? 828 : 1024,
        format: 'avif',
      })
    }
  })

  it('is not the identity, not a constant, and not the other ladder', () => {
    // The three degenerate implementations that would satisfy "returns a declared rung" for some inputs.
    const mobile = srcFor('mobile')
    const served = (width: number): number =>
      parseDerivativePath(mediaImageLoader({ src: mobile, width }))?.width ?? 0
    expect(served(700)).not.toBe(700)
    expect(new Set([1, 700, 900, 3000].map(served)).size).toBe(4)
    // 3000 on the mobile ladder is 1080, not the desktop 2560. A loader reading the wrong crop's ladder
    // would ship a 16:9 URL at a 4:5 width and the bucket has no such object.
    expect(served(3000)).toBe(1080)
  })

  it('refuses a src it does not own rather than passing it through', () => {
    // Passing an unknown src through is how a full-resolution original reaches an `<img>`: nothing
    // rejects it, the image renders, and the only symptom is a slow page.
    for (const src of [
      '/logo.svg',
      'https://example.cdn.example.com/hero.jpg',
      `/m/${MEDIA_ID}/${HASH}/hero-mobile-1080.png`,
      `/m/${MEDIA_ID}/${HASH.toUpperCase()}/hero-mobile-1080.avif`,
    ]) {
      expect(() => mediaImageLoader({ src, width: 640 }), src).toThrow(
        /\[loader-src-not-a-derivative\]/,
      )
    }
    // The control: a legitimate src must not throw.
    expect(() => mediaImageLoader({ src: srcFor('mobile'), width: 640 })).not.toThrow()
  })

  it('refuses a width outside 1..3000', () => {
    const src = srcFor('desktop')
    for (const width of [0, -1, 3001, 1.5, Number.NaN]) {
      expect(() => mediaImageLoader({ src, width }), String(width)).toThrow(
        /\[loader-width-out-of-range\]/,
      )
    }
    expect(() => mediaImageLoader({ src, width: 1 })).not.toThrow()
    expect(() => mediaImageLoader({ src, width: MAX_REQUESTED_WIDTH })).not.toThrow()
  })

  it('ignores quality, because the encode is fixed at build time', () => {
    const src = srcFor('mobile')
    // Two qualities at one width would be two URLs the job never produced. Honouring the parameter would
    // need a transform origin; Spaces has none.
    expect(mediaImageLoader({ src, width: 640, quality: 50 })).toBe(
      mediaImageLoader({ src, width: 640, quality: 100 }),
    )
    expect(mediaImageLoader({ src, width: 640 })).toMatch(DERIVATIVE_PATH_PATTERN)
  })
})
