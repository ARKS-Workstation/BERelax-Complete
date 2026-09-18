import { describe, expect, it } from 'vitest'
import { derivativePath, PRIVATE_ORIGINALS_PREFIX } from '../url.ts'
import { derivativeHeaders, IMMUTABLE_CACHE_CONTROL, publicKeyFor } from './port.ts'

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
