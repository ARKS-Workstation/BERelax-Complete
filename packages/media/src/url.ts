/**
 * Derivative URLs: content-addressed, immutable, and parseable back into what produced them.
 *
 * `/m/{mediaId}/{first16OfSha256}/{slot}-{crop}-{width}.{ext}` (docs/08 §6).
 *
 * The hash is the first sixteen hex characters of the sha256 of the **source** bytes, and it is what
 * makes `Cache-Control: immutable` safe to promise for a year: re-crop, re-touch or replace the
 * original and every derivative lands on a different path, so nothing anywhere has to be purged. The
 * usual alternative — a `?v=` query string — is discarded by a proportion of intermediary caches and
 * by some CDNs' default cache keys, which is a stale hero photograph nobody can explain.
 *
 * The crop is in the filename and not only in the width. docs/08 writes the pattern as
 * `{slot}-{width}`, and today that happens to be unambiguous because the two ladders share no width —
 * but the moment a rung is added to both, two different photographs claim one path and one silently
 * overwrites the other. Naming the crop costs seven characters and removes the failure entirely; the
 * pattern this unit is held to (`[a-z0-9-]+-\d+`) admits it.
 *
 * Pure string work. No `node:crypto` here, because the browser imports this module through the
 * `next/image` loader; hashing lives in `derivatives.ts`.
 */
import { AppError } from '@berelax/shared'
import { CROP_NAMES, type CropName, type DerivativeFormat, FORMATS } from './ladders.ts'

/**
 * The slots the media library declares.
 *
 * Duplicating `assets/media/manifest.json` here would be drift waiting to happen, so it is not
 * duplicated silently: `packages/fixtures/src/media-derivatives.itest.ts` asserts this list equals the
 * manifest's own keys. `packages/media` cannot import `@berelax/fixtures` — production code must not
 * depend on the fixture library — and `packages/fixtures` may see both, which makes it the place the
 * pair is checked.
 */
export const MEDIA_SLOTS = ['therapist-portrait', 'hero', 'logo'] as const
export type MediaSlotName = (typeof MEDIA_SLOTS)[number]

/**
 * The slots this pipeline crops.
 *
 * A logo is a wordmark: it has no declared ratio, cropping it to 4:5 would cut the brand name in half,
 * and it is served as authored. Passing one to the derivative job is a programming error rather than a
 * reason to produce twenty-four bad crops, so it is refused by name.
 */
export const CROPPED_SLOTS: readonly MediaSlotName[] = ['therapist-portrait', 'hero']

/** Where originals live in the private bucket. No CDN, no public read (docs/08 §6). */
export const PRIVATE_ORIGINALS_PREFIX = 'originals'

/** Where derivatives live in the public bucket, and the prefix every derivative URL starts with. */
export const PUBLIC_DERIVATIVE_PREFIX = 'm'

/**
 * The pattern every derivative path matches, as W-SYS-05 states it.
 *
 * Written once, exported, and used by both the builder and the tests — a second copy of a regular
 * expression is a second regular expression, and the one in the test is the one that rots.
 */
export const DERIVATIVE_PATH_PATTERN =
  /^\/m\/[0-9a-f-]{36}\/[0-9a-f]{16}\/[a-z0-9-]+-\d+\.(avif|webp|jpg)$/

/** A media id is a lower-case UUID. 36 characters, which is what the pattern above counts. */
export const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The content address: the first sixteen hex characters of the source sha256. */
export const CONTENT_HASH_PATTERN = /^[0-9a-f]{16}$/

export const CONTENT_HASH_LENGTH = 16

export interface DerivativeRef {
  readonly mediaId: string
  readonly contentHash: string
  readonly slot: MediaSlotName
  readonly crop: CropName
  readonly width: number
  readonly format: DerivativeFormat
}

export function assertMediaId(mediaId: string): void {
  if (!MEDIA_ID_PATTERN.test(mediaId)) {
    throw new AppError('validation', `[invalid-media-id] '${mediaId}' is not a lower-case UUID`, {
      details: { mediaId },
    })
  }
}

export function assertContentHash(contentHash: string): void {
  if (!CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new AppError(
      'validation',
      `[invalid-content-hash] '${contentHash}' is not ${CONTENT_HASH_LENGTH} lower-case hex characters`,
      { details: { contentHash } },
    )
  }
}

export function assertCroppedSlot(slot: string): MediaSlotName {
  const known = MEDIA_SLOTS.find((candidate) => candidate === slot)
  if (known === undefined) {
    throw new AppError('validation', `[unknown-slot] '${slot}' is not a declared media slot`, {
      details: { slot, slots: MEDIA_SLOTS },
    })
  }
  if (!CROPPED_SLOTS.includes(known)) {
    throw new AppError(
      'validation',
      `[slot-is-never-cropped] slot '${slot}' declares no aspect ratio, so it has no derivative ladder`,
      { details: { slot, cropped: CROPPED_SLOTS } },
    )
  }
  return known
}

/** The immutable public path for one derivative. */
export function derivativePath(ref: DerivativeRef): string {
  assertMediaId(ref.mediaId)
  assertContentHash(ref.contentHash)
  const name = `${ref.slot}-${ref.crop}-${ref.width}.${ref.format}`
  const path = `/${PUBLIC_DERIVATIVE_PREFIX}/${ref.mediaId}/${ref.contentHash}/${name}`
  if (!DERIVATIVE_PATH_PATTERN.test(path)) {
    // Unreachable through the assertions above, which is exactly why it is here: the pattern is the
    // contract other units match against, and a path built by this function that fails it must stop
    // the build rather than reach a `srcset`.
    throw new AppError(
      'invariant_violated',
      `[derivative-path-off-pattern] '${path}' does not match the declared derivative URL pattern`,
      { details: { path } },
    )
  }
  return path
}

/** The private-bucket key for a source original. Never reachable from a URL. */
export function originalKey(mediaId: string, extension: string): string {
  assertMediaId(mediaId)
  const clean = extension.replace(/^\./, '').toLowerCase()
  return `${PRIVATE_ORIGINALS_PREFIX}/${mediaId}.${clean}`
}

/**
 * The inverse of `derivativePath`. Returns `undefined` rather than throwing.
 *
 * The `next/image` loader calls this on whatever `src` a component passed, which may legitimately be
 * something else — an SVG in the bundle, an external avatar — and a loader that threw would take the
 * page down over a URL it simply does not own.
 */
export function parseDerivativePath(path: string): DerivativeRef | undefined {
  if (!DERIVATIVE_PATH_PATTERN.test(path)) return undefined
  const segments = path.split('/')
  const [, , mediaId, contentHash, filename] = segments
  if (mediaId === undefined || contentHash === undefined || filename === undefined) return undefined
  if (!MEDIA_ID_PATTERN.test(mediaId)) return undefined

  const dot = filename.lastIndexOf('.')
  const stem = filename.slice(0, dot)
  const format = FORMATS.find((candidate) => candidate === filename.slice(dot + 1))
  if (format === undefined) return undefined

  const lastDash = stem.lastIndexOf('-')
  const width = Number.parseInt(stem.slice(lastDash + 1), 10)
  if (!Number.isInteger(width) || width <= 0) return undefined

  const withoutWidth = stem.slice(0, lastDash)
  const cropDash = withoutWidth.lastIndexOf('-')
  const crop = CROP_NAMES.find((candidate) => candidate === withoutWidth.slice(cropDash + 1))
  if (crop === undefined) return undefined

  const slot = MEDIA_SLOTS.find((candidate) => candidate === withoutWidth.slice(0, cropDash))
  if (slot === undefined) return undefined

  return { mediaId, contentHash, slot, crop, width, format }
}
