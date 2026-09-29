import { describe, expect, it } from 'vitest'
import { derivativePath, PRIVATE_ORIGINALS_PREFIX } from '../url.ts'
import {
  assertSignable,
  derivativeHeaders,
  IMMUTABLE_CACHE_CONTROL,
  publicKeyFor,
  type SignRequest,
} from './port.ts'

const MEDIA_ID = '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f'
const HASH = '9f86d081884c7d65'

const pathFor = (format: 'avif' | 'webp' | 'jpg'): string =>
  derivativePath({
    mediaId: MEDIA_ID,
    contentHash: HASH,
    slot: 'hero',
    crop: 'desktop',
    width: 1920,
    format,
  })

describe('derivativeHeaders', () => {
  it('serves a year of immutable caching, with the right content type', () => {
    expect(IMMUTABLE_CACHE_CONTROL).toBe('public, max-age=31536000, immutable')
    expect(derivativeHeaders(pathFor('avif'))).toEqual({
      'content-type': 'image/avif',
      'cache-control': 'public, max-age=31536000, immutable',
    })
    expect(derivativeHeaders(pathFor('webp'))['content-type']).toBe('image/webp')
    // `.jpg` in the URL, `image/jpeg` on the wire. The two spellings are not interchangeable.
    expect(derivativeHeaders(pathFor('jpg'))['content-type']).toBe('image/jpeg')
  })

  it('refuses to put a year of immutable on anything that is not content-addressed', () => {
    // The control, and the failure it prevents is unfixable by deploying: every cache that saw the header
    // keeps the stale bytes until it expires, and there is no purge for a browser cache.
    for (const candidate of [
      '/favicon.ico',
      `/${PRIVATE_ORIGINALS_PREFIX}/${MEDIA_ID}.jpg`,
      `/m/${MEDIA_ID}/${HASH.slice(0, 15)}/hero-desktop-1920.avif`,
      `/m/${MEDIA_ID}/${HASH}/hero-desktop-1920.avif?resize=800`,
    ]) {
      expect(() => derivativeHeaders(candidate), candidate).toThrow(/\[not-an-immutable-path\]/)
    }
    expect(() => derivativeHeaders(pathFor('avif'))).not.toThrow()
  })
})

describe('publicKeyFor', () => {
  it('is the URL path without its leading slash', () => {
    const path = pathFor('avif')
    expect(publicKeyFor(path)).toBe(path.slice(1))
    expect(publicKeyFor(path).startsWith('/')).toBe(false)
  })
})

/**
 * The signing verb's two refusals, W-SYS-14 (EXTENDED, not replaced — the acceptance line asks for that).
 *
 * These are the checks that hold before any adapter work, so they are the port's and not the fake's. The
 * fake's own half — an armed refusal, no key configured, and an object that is not in the bucket — is in
 * `fake.test.ts`, because those are facts about an adapter rather than about the interface.
 */
const NOW = 1_800_000_000

const signRequest = (overrides: Partial<SignRequest> = {}): SignRequest => ({
  bucket: 'private',
  key: `${PRIVATE_ORIGINALS_PREFIX}/${MEDIA_ID}.jpg`,
  documentId: MEDIA_ID,
  documentClass: 'tax_invoice',
  expiresAtEpochSeconds: NOW + 900,
  ...overrides,
})

describe('assertSignable', () => {
  it('refuses to sign a PUBLIC object', () => {
    // Not a hypothetical: the first person to believe that a derivative needs authorisation would add a
    // signature check to the derivative origin and take every image on the site offline.
    expect(() => assertSignable(signRequest({ bucket: 'public' }), NOW)).toThrow(
      /\[signing-a-public-object\]/,
    )
    expect(() => assertSignable(signRequest(), NOW)).not.toThrow()
  })

  it('refuses an expiry that is not after the current instant', () => {
    // `now` and `now - 1`, because `now` is what an off-by-one in a caller's arithmetic produces and a link
    // dead at the moment it is minted reads as a link that is simply broken.
    for (const expiry of [NOW, NOW - 1, 1]) {
      expect(
        () => assertSignable(signRequest({ expiresAtEpochSeconds: expiry }), NOW),
        String(expiry),
      ).toThrow(/\[signing-an-expired-link\]/)
    }
    expect(() => assertSignable(signRequest({ expiresAtEpochSeconds: NOW + 1 }), NOW)).not.toThrow()
  })
})
