/**
 * The derivative build: two art-directed crops, four rungs each, three formats, colour-managed.
 *
 * Twenty-four files out of one photograph, and the interesting properties are the three that are easy to
 * lose.
 *
 * **Exactly the declared ladder.** No rung is skipped because the source is smaller than it — an
 * upscaled 2560 wastes bytes, but a *missing* 2560 inside a `srcset` is a 404 that the browser resolves
 * by showing nothing at all, on the widest screens only, which is the hardest class of bug to see.
 *
 * **Idempotence by content address, not by timestamp.** The path carries the sha256 of the source, so a
 * second pass over unchanged bytes finds every object already present and encodes nothing. The encode
 * counter is incremented inside the encoder itself — `createEncoder` closes over it and only `encode`
 * can move it — because a counter the caller increments proves the caller's arithmetic, not the pipeline's.
 *
 * **Colour management, which matters more here than it sounds.** docs/08 §6:
 * `pipelineColourspace('rgb16')` → resize → `toColourspace('srgb')` → an sRGB ICC profile. Resizing in
 * 8-bit sRGB averages gamma-encoded values, which darkens and dulls exactly the low-contrast pastel
 * gradients this photography is made of; doing it in 16-bit linear light does not. The ICC profile then
 * has to be *embedded*, because Safari and Chrome disagree about what an untagged image means on a
 * wide-gamut display, and the disagreement looks like the brand colours being wrong on a MacBook.
 */
import { AppError } from '@berelax/shared'
import sharp from 'sharp'
import { contentAddress, sha256Hex } from './hash.ts'
import {
  AVIF_OPTIONS,
  CONTENT_TYPES,
  type CropName,
  cropRectFor,
  type DerivativeFormat,
  heightFor,
  isDeclaredWidth,
  JPEG_OPTIONS,
  type RenditionSpec,
  renditionSpecs,
  WEBP_OPTIONS,
} from './ladders.ts'
import { type Placeholder, placeholderFor } from './placeholder.ts'
import {
  IMMUTABLE_CACHE_CONTROL,
  type MediaStorage,
  PRIVATE_CACHE_CONTROL,
  publicKeyFor,
} from './storage/port.ts'
import {
  assertCroppedSlot,
  derivativePath,
  type MediaSlotName,
  originalKey,
  PRIVATE_ORIGINALS_PREFIX,
} from './url.ts'

export interface FocalPoint {
  /** Percentages, as `assets/media/manifest.json` records them. */
  readonly x: number
  readonly y: number
}

/** The default focal point: the middle of the frame, which is what no declaration means. */
export const CENTRE_FOCAL: FocalPoint = { x: 50, y: 50 }

export interface BuildDerivativesInput {
  readonly mediaId: string
  readonly slot: string
  /** The original's bytes. The content address is taken from exactly these. */
  readonly source: Uint8Array
  readonly focal?: FocalPoint
  readonly storage: MediaStorage
}

export interface DerivativeOutput {
  /** The immutable public path, which is also the URL. */
  readonly path: string
  readonly crop: CropName
  readonly width: number
  readonly height: number
  readonly format: DerivativeFormat
  readonly bytes: number
  readonly sha256: string
  /** True when the object was already in the bucket and nothing was encoded for it. */
  readonly reused: boolean
}

export interface DerivativeBuildResult {
  readonly mediaId: string
  readonly slot: MediaSlotName
  /** First sixteen hex characters of the source sha256 — the `{hash}` segment of every path. */
  readonly contentHash: string
  readonly placeholder: Placeholder
  readonly outputs: readonly DerivativeOutput[]
  /**
   * How many encodes ran.
   *
   * Zero on a second pass over unchanged bytes. Incremented inside the encoder, so it cannot be zero
   * because nobody counted.
   */
  readonly encoded: number
  readonly reused: number
}

export interface SourceGeometry {
  readonly width: number
  readonly height: number
}

/**
 * The source's pixel dimensions, with the one guard that matters.
 *
 * Nothing in this pipeline calls `.rotate()`, so a source whose pixels are stored sideways under an EXIF
 * orientation tag would be cropped against the wrong axis and published rotated. Refusing is right: the
 * fix is to normalise the original on upload, not to guess here, and a sideways therapist portrait is not
 * a bug anybody would attribute to a derivative job.
 */
export async function readSourceGeometry(source: Uint8Array): Promise<SourceGeometry> {
  const metadata = await sharp(source).metadata()
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new AppError('validation', '[unreadable-original] the source has no pixel dimensions')
  }
  if (metadata.orientation !== undefined && metadata.orientation > 1) {
    throw new AppError(
      'validation',
      `[original-carries-exif-orientation] the source declares EXIF orientation ` +
        `${metadata.orientation}; normalise the original before building derivatives`,
      { details: { orientation: metadata.orientation } },
    )
  }
  return { width: metadata.width, height: metadata.height }
}

export interface RenditionRequest {
  readonly source: Uint8Array
  readonly crop: CropName
  readonly width: number
  readonly format: DerivativeFormat
  readonly focal?: FocalPoint
}

/**
 * One rendition: crop to the target ratio around the focal point, resize, tag, encode.
 *
 * The single place the sharp pipeline is written down, and it is exported for one specific reason —
 * `scripts/check-budgets.mjs` measures the hero's widest AVIF through *this* function. A budget that
 * encoded with its own settings would be measuring a file the site never serves, which is a budget that
 * passes while the real derivative is over.
 *
 * No rung is skipped for being wider than the source. An upscaled 2560 wastes bytes; a *missing* 2560
 * inside a `srcset` is a 404 the browser resolves by showing nothing, on the widest screens only.
 */
export async function encodeRendition(request: RenditionRequest): Promise<Buffer> {
  const geometry = await readSourceGeometry(request.source)
  const rect = cropRectFor(geometry, request.crop, request.focal ?? CENTRE_FOCAL)
  const pipeline = sharp(request.source)
    // 16-bit linear light for the resize. See the file header: resizing gamma-encoded pastels in 8 bits
    // is what visibly dulls them.
    .pipelineColourspace('rgb16')
    .extract(rect)
    .resize({ width: request.width, height: heightFor(request.crop, request.width) })
    .toColourspace('srgb')
    // `withIccProfile` and not the `withMetadata({ icc })` docs/08 writes: `withMetadata` is deprecated
    // in sharp 0.35, and it also *keeps* EXIF — which would embed the camera's original capture date in
    // every derivative and make byte-identical re-encoding impossible. The profile is the only metadata a
    // derivative needs.
    .withIccProfile('srgb')
  switch (request.format) {
    case 'avif':
      return await pipeline.avif({ ...AVIF_OPTIONS }).toBuffer()
    case 'webp':
      return await pipeline.webp({ ...WEBP_OPTIONS }).toBuffer()
    case 'jpg':
      return await pipeline.jpeg({ ...JPEG_OPTIONS }).toBuffer()
  }
}

interface Encoder {
  encode(spec: RenditionSpec): Promise<Uint8Array>
  count(): number
}

/**
 * The encoder, and the encode counter that only it can move.
 *
 * The counter is the whole point of the closure. W-SYS-05 asks for "a second run re-encodes nothing
 * (encode counter 0)", and that claim is worthless if the number is maintained by the loop that decides
 * whether to skip — the loop would then be asserting its own branch. Here the only way the count rises
 * is that libvips produced bytes.
 */
function createEncoder(source: Uint8Array, focal: FocalPoint): Encoder {
  let encodes = 0
  return {
    count: () => encodes,
    async encode(spec: RenditionSpec): Promise<Uint8Array> {
      const buffer = await encodeRendition({
        source,
        crop: spec.crop,
        width: spec.width,
        format: spec.format,
        focal,
      })
      encodes += 1
      return buffer
    },
  }
}

/** Puts an original into the private bucket. Never the public one — docs/08 §6, and consent. */
export async function storeOriginal(input: {
  readonly mediaId: string
  readonly extension: string
  readonly source: Uint8Array
  readonly contentType: string
  readonly storage: MediaStorage
}): Promise<string> {
  const key = originalKey(input.mediaId, input.extension)
  await input.storage.put({
    bucket: 'private',
    key,
    body: input.source,
    contentType: input.contentType,
    cacheControl: PRIVATE_CACHE_CONTROL,
  })
  return key
}

/** Whether a private-bucket key is one of ours. Used by the job to refuse a key from anywhere else. */
export function isOriginalKey(key: string): boolean {
  return key.startsWith(`${PRIVATE_ORIGINALS_PREFIX}/`)
}

export async function buildDerivatives(
  input: BuildDerivativesInput,
): Promise<DerivativeBuildResult> {
  const slot = assertCroppedSlot(input.slot)
  const contentHash = contentAddress(input.source)
  const focal = input.focal ?? CENTRE_FOCAL

  // Read once, up front, so a source that cannot be cropped correctly fails before twenty-four encodes
  // rather than during them.
  await readSourceGeometry(input.source)

  const stats = await sharp(input.source).stats()
  const placeholder = placeholderFor(stats.dominant)

  const encoder = createEncoder(input.source, focal)
  const outputs: DerivativeOutput[] = []

  for (const spec of renditionSpecs()) {
    if (!isDeclaredWidth(spec.crop, spec.width)) {
      throw new AppError(
        'invariant_violated',
        `[undeclared-derivative-width] ${spec.width} is not a rung of the ${spec.crop} ladder`,
        { details: { crop: spec.crop, width: spec.width } },
      )
    }

    const path = derivativePath({
      mediaId: input.mediaId,
      contentHash,
      slot,
      crop: spec.crop,
      width: spec.width,
      format: spec.format,
    })
    const key = publicKeyFor(path)

    const existing = await input.storage.head({ bucket: 'public', key })
    if (existing !== undefined) {
      outputs.push({
        path,
        crop: spec.crop,
        width: spec.width,
        height: spec.height,
        format: spec.format,
        bytes: existing.bytes,
        sha256: existing.sha256,
        reused: true,
      })
      continue
    }

    const body = await encoder.encode(spec)
    const stored = await input.storage.put({
      bucket: 'public',
      key,
      body,
      contentType: CONTENT_TYPES[spec.format],
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    })
    outputs.push({
      path,
      crop: spec.crop,
      width: spec.width,
      height: spec.height,
      format: spec.format,
      bytes: stored.bytes,
      sha256: sha256Hex(body),
      reused: false,
    })
  }

  const expected = renditionSpecs().length
  if (outputs.length !== expected) {
    throw new AppError(
      'invariant_violated',
      `[derivative-count-mismatch] produced ${outputs.length} derivatives, the ladders declare ${expected}`,
      { details: { produced: outputs.length, expected } },
    )
  }

  return {
    mediaId: input.mediaId,
    slot,
    contentHash,
    placeholder,
    outputs,
    encoded: encoder.count(),
    reused: outputs.filter((output) => output.reused).length,
  }
}
