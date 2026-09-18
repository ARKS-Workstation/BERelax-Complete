import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { renditionSpecs } from './ladders.ts'
import {
  assertCroppedSlot,
  CROPPED_SLOTS,
  DERIVATIVE_PATH_PATTERN,
  derivativePath,
  MEDIA_SLOTS,
  originalKey,
  PRIVATE_ORIGINALS_PREFIX,
  parseDerivativePath,
} from './url.ts'

const MEDIA_ID = '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f'
const HASH = '9f86d081884c7d65'

/**
 * The URL pattern is the contract W-SYS-05 is held to, and it is the one thing other units match against.
 *
 * So it is asserted from both ends: every path the builder can produce matches it, and the strings that
 * *nearly* match are rejected. The second half is the part that matters. A pattern that accepted an
 * uppercase digest, or a fifteen-character one, would let a path through that the CDN's cache key treats
 * as a different object from the one the page asked for.
 */
describe('derivativePath', () => {
  it('produces the declared pattern for every rendition of every cropped slot', () => {
    const paths = new Set<string>()
    for (const slot of CROPPED_SLOTS) {
      for (const spec of renditionSpecs()) {
        const path = derivativePath({
          mediaId: MEDIA_ID,
          contentHash: HASH,
          slot,
          crop: spec.crop,
          width: spec.width,
          format: spec.format,
        })
        expect(path).toMatch(DERIVATIVE_PATH_PATTERN)
        paths.add(path)
      }
    }
    // 2 slots x 24 renditions, all distinct. The crop is in the name precisely so two crops cannot
    // collide; without it this set would be smaller than 48 the moment the ladders shared a width.
    expect(paths.size).toBe(48)
  })

  it('names the crop as well as the width', () => {
    const mobile = derivativePath({
      mediaId: MEDIA_ID,
      contentHash: HASH,
      slot: 'hero',
      crop: 'mobile',
      width: 1080,
      format: 'avif',
    })
    expect(mobile).toBe(`/m/${MEDIA_ID}/${HASH}/hero-mobile-1080.avif`)
    // The control: the same slot, width and format at the other crop must be a different path.
    const desktop = derivativePath({
      mediaId: MEDIA_ID,
      contentHash: HASH,
      slot: 'hero',
      crop: 'desktop',
      width: 1080,
      format: 'avif',
    })
    expect(desktop).not.toBe(mobile)
  })

  it('refuses a media id or a digest that is nearly right', () => {
    const base = {
      contentHash: HASH,
      slot: 'hero',
      crop: 'mobile',
      width: 1080,
      format: 'avif',
    } as const
    expect(() => derivativePath({ ...base, mediaId: MEDIA_ID.toUpperCase() })).toThrow(
      /\[invalid-media-id\]/,
    )
    expect(() => derivativePath({ ...base, mediaId: 'not-a-uuid' })).toThrow(/\[invalid-media-id\]/)
    expect(() =>
      derivativePath({ ...base, mediaId: MEDIA_ID, contentHash: HASH.slice(0, 15) }),
    ).toThrow(/\[invalid-content-hash\]/)
    expect(() =>
      derivativePath({ ...base, mediaId: MEDIA_ID, contentHash: HASH.toUpperCase() }),
    ).toThrow(/\[invalid-content-hash\]/)
    // And the control: the same call with the correct values must not throw, or these four assertions are
    // satisfied by a function that rejects everything.
    expect(() => derivativePath({ ...base, mediaId: MEDIA_ID })).not.toThrow()
  })
})

describe('parseDerivativePath', () => {
  it('round-trips every rendition', () => {
    for (const spec of renditionSpecs()) {
      const path = derivativePath({
        mediaId: MEDIA_ID,
        contentHash: HASH,
        slot: 'therapist-portrait',
        crop: spec.crop,
        width: spec.width,
        format: spec.format,
      })
      expect(parseDerivativePath(path)).toEqual({
        mediaId: MEDIA_ID,
        contentHash: HASH,
        slot: 'therapist-portrait',
        crop: spec.crop,
        width: spec.width,
        format: spec.format,
      })
    }
  })

  it('returns undefined for anything that is not a derivative path', () => {
    for (const candidate of [
      '',
      '/',
      '/favicon.ico',
      // A private original. The loader is handed whatever a component passed, and this is the one string
      // that must never come back as a parseable media URL.
      `/${PRIVATE_ORIGINALS_PREFIX}/${MEDIA_ID}.jpg`,
      `/m/${MEDIA_ID}/${HASH}/hero-mobile-1080.jpeg`,
      `/m/${MEDIA_ID}/${HASH}/hero-mobile-1080.png`,
      `/m/${MEDIA_ID}/${HASH.slice(0, 15)}/hero-mobile-1080.avif`,
      `/m/${MEDIA_ID}/${HASH}/hero-tablet-1080.avif`,
      `/m/${MEDIA_ID}/${HASH}/banner-mobile-1080.avif`,
      `/m/${MEDIA_ID}/${HASH}/hero-mobile-1080.avif?v=2`,
      `https://example.com/m/${MEDIA_ID}/${HASH}/hero-mobile-1080.avif`,
    ]) {
      expect(parseDerivativePath(candidate), candidate).toBeUndefined()
    }
    // The control: a path that is right must parse, or "returns undefined" is trivially true.
    expect(parseDerivativePath(`/m/${MEDIA_ID}/${HASH}/hero-mobile-1080.avif`)).toBeDefined()
  })
})

describe('slots', () => {
  it('refuses a slot that is never cropped, and one it has never heard of', () => {
    expect(assertCroppedSlot('hero')).toBe('hero')
    expect(assertCroppedSlot('therapist-portrait')).toBe('therapist-portrait')
    // A wordmark has no declared ratio. Cropping it to 4:5 would cut the brand name in half, so it is a
    // programming error rather than twenty-four bad crops.
    expect(() => assertCroppedSlot('logo')).toThrow(/\[slot-is-never-cropped\]/)
    expect(() => assertCroppedSlot('gallery')).toThrow(/\[unknown-slot\]/)
    expect(MEDIA_SLOTS).toContain('logo')
    expect(CROPPED_SLOTS).not.toContain('logo')
  })
})

describe('originalKey', () => {
  it('puts an original under the private prefix, normalising the extension', () => {
    expect(originalKey(MEDIA_ID, '.JPG')).toBe(`${PRIVATE_ORIGINALS_PREFIX}/${MEDIA_ID}.jpg`)
    expect(originalKey(MEDIA_ID, 'png')).toBe(`${PRIVATE_ORIGINALS_PREFIX}/${MEDIA_ID}.png`)
    // The control: the key is not a URL, and it is never a derivative path.
    expect(parseDerivativePath(`/${originalKey(MEDIA_ID, 'jpg')}`)).toBeUndefined()
    expect(() => originalKey('nope', 'jpg')).toThrow(AppError)
  })
})
