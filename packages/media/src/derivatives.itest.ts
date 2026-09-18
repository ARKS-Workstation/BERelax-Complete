import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildDerivatives, storeOriginal } from './derivatives.ts'
import { CROPS, renditionSpecs } from './ladders.ts'
import { isWithinPlaceholderBand } from './placeholder.ts'
import { createFakeMediaStorage } from './storage/fake.ts'
import { type MediaStorage, publicKeyFor } from './storage/port.ts'
import { DERIVATIVE_PATH_PATTERN, derivativePath, originalKey } from './url.ts'

/**
 * The pipeline itself, against libvips.
 *
 * Deliberately a **synthetic** source rather than one of the staff photographs. Two reasons. The
 * properties under test — the ladder is exactly the declared one, the path carries the source digest, the
 * profile is embedded, a second pass encodes nothing, a re-encode is byte-identical — are properties of
 * the pipeline and of our fixed encoder settings, not of any particular image; and a smooth gradient
 * encodes in seven seconds where a photograph takes twenty-eight, which is the difference between this
 * running on every `pnpm verify` and being skipped. The real photography is measured in
 * `packages/fixtures/src/media-derivatives.itest.ts`, where the byte budgets are.
 */
const MEDIA_ID = '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f'

/** A deterministic two-axis gradient. Pastel, low-contrast, and the same bytes on every machine. */
async function syntheticOriginal(offset = 0): Promise<Buffer> {
  const width = 2000
  const height = 1200
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3
      // Light and barely saturated on purpose: the dominant colour comes out at rgb(216, 216, 200),
      // which is L=0.8778 C=0.0216 — inside the placeholder band on its own measurement, so the
      // `clamped === false` assertion below is a real control rather than a coincidence.
      raw[i] = 212 + offset + Math.round((16 * x) / width)
      raw[i + 1] = 208 + Math.round((20 * y) / height)
      raw[i + 2] = 202 + Math.round((12 * (x + y)) / (width + height))
    }
  }
  return await sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

let workspaces: string[] = []

function freshStorage(): MediaStorage {
  const outbox = mkdtempSync(join(tmpdir(), 'berelax-derivatives-'))
  workspaces.push(outbox)
  return createFakeMediaStorage({ outbox, now: () => '2026-09-18T10:00:00.000Z' })
}

let source: Buffer
let first: Awaited<ReturnType<typeof buildDerivatives>>
let firstStorage: MediaStorage
let second: Awaited<ReturnType<typeof buildDerivatives>>
let third: Awaited<ReturnType<typeof buildDerivatives>>

beforeAll(async () => {
  source = await syntheticOriginal()
  firstStorage = freshStorage()
  first = await buildDerivatives({ mediaId: MEDIA_ID, slot: 'hero', source, storage: firstStorage })
  // The same bytes, the same bucket. Nothing may be encoded.
  second = await buildDerivatives({
    mediaId: MEDIA_ID,
    slot: 'hero',
    source,
    storage: firstStorage,
  })
  // The same bytes, an empty bucket. Everything is encoded again, and must come out identical.
  third = await buildDerivatives({
    mediaId: MEDIA_ID,
    slot: 'hero',
    source,
    storage: freshStorage(),
  })
}, 180_000)

afterAll(() => {
  for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true })
  workspaces = []
})

describe('the declared ladders, and nothing else', () => {
  it('emits exactly the 24 declared renditions', () => {
    const expected = renditionSpecs().map((spec) =>
      derivativePath({
        mediaId: MEDIA_ID,
        contentHash: first.contentHash,
        slot: 'hero',
        crop: spec.crop,
        width: spec.width,
        format: spec.format,
      }),
    )
    expect(new Set(first.outputs.map((output) => output.path))).toEqual(new Set(expected))
    expect(first.outputs).toHaveLength(24)
  })

  it('writes no undeclared width into the bucket', async () => {
    // Read back from the bucket rather than from the return value: the claim is about what a browser can
    // fetch, and an object written under a path the result never mentioned is exactly what that misses.
    const keys = await firstStorage.list('public')
    expect(keys).toHaveLength(24)
    const widths = { mobile: new Set<number>(), desktop: new Set<number>() }
    for (const key of keys) {
      const path = `/${key}`
      expect(path, path).toMatch(DERIVATIVE_PATH_PATTERN)
      const match = /-(mobile|desktop)-(\d+)\.(avif|webp|jpg)$/.exec(key)
      expect(match, key).not.toBeNull()
      if (match === null) continue
      widths[match[1] as 'mobile' | 'desktop'].add(Number(match[2]))
    }
    expect([...widths.mobile].sort((a, b) => a - b)).toEqual([...CROPS.mobile.widths])
    expect([...widths.desktop].sort((a, b) => a - b)).toEqual([...CROPS.desktop.widths])
  })

  it('resizes each rung to its own ratio', async () => {
    for (const crop of ['mobile', 'desktop'] as const) {
      const widest = CROPS[crop].widths.at(-1) ?? 0
      const output = first.outputs.find(
        (candidate) =>
          candidate.crop === crop && candidate.width === widest && candidate.format === 'avif',
      )
      expect(output, crop).toBeDefined()
      if (output === undefined) continue
      const bytes = await firstStorage.get({ bucket: 'public', key: publicKeyFor(output.path) })
      const metadata = await sharp(bytes).metadata()
      expect(metadata.width).toBe(widest)
      expect(metadata.height).toBe(output.height)
      const [rw, rh] = CROPS[crop].ratio
      expect((metadata.width ?? 0) / (metadata.height ?? 1)).toBeCloseTo(rw / rh, 2)
    }
    // The control: the two widest AVIFs are different shapes, which is what art direction means.
    const mobile = first.outputs.find((o) => o.crop === 'mobile' && o.width === 1080)
    const desktop = first.outputs.find((o) => o.crop === 'desktop' && o.width === 2560)
    expect(mobile?.height).toBe(1350)
    expect(desktop?.height).toBe(1440)
  })

  it('refuses a slot with no ratio', async () => {
    await expect(
      buildDerivatives({ mediaId: MEDIA_ID, slot: 'logo', source, storage: freshStorage() }),
    ).rejects.toThrow(/\[slot-is-never-cropped\]/)
  })
})

describe('the content address', () => {
  it('is the first 16 hex characters of the sha256 of the source bytes', () => {
    // Computed here from `node:crypto` directly, not through the module under test.
    expect(first.contentHash).toBe(sha256(source).slice(0, 16))
    expect(first.contentHash).toMatch(/^[0-9a-f]{16}$/)
    for (const output of first.outputs) {
      expect(output.path).toContain(`/${first.contentHash}/`)
    }
  })

  it('moves every path when the source bytes change', async () => {
    const changed = await syntheticOriginal(1)
    expect(sha256(changed)).not.toBe(sha256(source))
    const other = await buildDerivatives({
      mediaId: MEDIA_ID,
      slot: 'hero',
      source: changed,
      storage: freshStorage(),
    })
    // The control for `immutable`: if the digest did not move, a year of caching would serve the old
    // photograph from every browser that had seen it, with no purge available.
    expect(other.contentHash).not.toBe(first.contentHash)
    expect(new Set(other.outputs.map((o) => o.path))).not.toEqual(
      new Set(first.outputs.map((o) => o.path)),
    )
  })
})

describe('idempotence and determinism', () => {
  it('encodes the whole ladder on the first pass', () => {
    // The proof that the counter is a counter. Without this, "a second run encodes nothing" is satisfied
    // by a number that is always zero.
    expect(first.encoded).toBe(24)
    expect(first.reused).toBe(0)
    expect(first.outputs.every((output) => output.reused === false)).toBe(true)
  })

  it('encodes nothing on a second pass over unchanged bytes', () => {
    expect(second.encoded).toBe(0)
    expect(second.reused).toBe(24)
    expect(second.outputs.every((output) => output.reused === true)).toBe(true)
    // And what it reports is what is in the bucket, byte for byte.
    const before = new Map(first.outputs.map((output) => [output.path, output.sha256]))
    for (const output of second.outputs) {
      expect(output.sha256, output.path).toBe(before.get(output.path))
    }
  })

  it('produces byte-identical outputs when it does re-encode', () => {
    // The stronger claim, and the one the second pass cannot make: with an empty bucket every rung is
    // encoded again, and libvips at these fixed settings must return the same bytes. It does — AVIF via
    // libaom, WebP and mozjpeg are all deterministic here, and nothing in the pipeline embeds a timestamp
    // because `withIccProfile` adds the profile and keeps no EXIF.
    expect(third.encoded).toBe(24)
    const before = new Map(first.outputs.map((output) => [output.path, output.sha256]))
    for (const output of third.outputs) {
      expect(output.sha256, output.path).toBe(before.get(output.path))
      expect(output.bytes).toBe(
        first.outputs.find((candidate) => candidate.path === output.path)?.bytes,
      )
    }
  })
})

describe('colour management', () => {
  it('embeds an sRGB profile in every format', async () => {
    for (const format of ['avif', 'webp', 'jpg'] as const) {
      const output = first.outputs.find(
        (candidate) =>
          candidate.format === format && candidate.crop === 'mobile' && candidate.width === 414,
      )
      expect(output, format).toBeDefined()
      if (output === undefined) continue
      const bytes = await firstStorage.get({ bucket: 'public', key: publicKeyFor(output.path) })
      const metadata = await sharp(bytes).metadata()
      // The bytes really are the codec the extension claims. libvips reports AVIF as a HEIF container
      // with an AV1 payload, which is what `image/avif` is; a `.avif` that was quietly a PNG would
      // still decode in every browser and would be four times the size.
      const container = { avif: 'heif', webp: 'webp', jpg: 'jpeg' }[format]
      expect(metadata.format, format).toBe(container)
      if (format === 'avif') expect(metadata.compression).toBe('av1')
      expect(metadata.space, format).toBe('srgb')
      expect(metadata.icc, format).toBeDefined()
      const icc = Buffer.from(metadata.icc ?? new Uint8Array())
      // Bytes 16..20 of an ICC header are the data colour space. The profile description is UTF-16BE, so
      // the nulls come out; 'sRGB' is what is left.
      expect(icc.subarray(16, 20).toString('latin1'), format).toBe('RGB ')
      expect(icc.toString('latin1').replaceAll(' ', ''), format).toContain('sRGB')
    }
  })

  it('would carry no profile at all without the pipeline', async () => {
    // The control. `sharp` strips metadata by default, so an encode that forgot `withIccProfile` produces
    // an untagged image — which Safari and Chrome interpret differently on a wide-gamut display, and the
    // symptom is the brand colours looking wrong on a MacBook rather than an error.
    const untagged = await sharp(source)
      .resize({ width: 414, height: 518 })
      .avif({ quality: 52, effort: 4 })
      .toBuffer()
    expect((await sharp(untagged).metadata()).icc).toBeUndefined()
  })
})

describe('the placeholder', () => {
  it('comes out of the source and sits inside the band', () => {
    expect(isWithinPlaceholderBand(first.placeholder)).toBe(true)
    // The synthetic source is a light pastel gradient, so this one is in band on its own measurement —
    // which the real photographs are not. See `packages/fixtures/src/media-derivatives.itest.ts`.
    expect(first.placeholder.clamped).toBe(false)
    expect(first.placeholder.measured.lightness).toBeGreaterThan(0.86)
  })
})

describe('the bucket split', () => {
  it('writes derivatives to the public bucket and nothing else', async () => {
    expect(await firstStorage.list('private')).toEqual([])
  })

  it('writes an original to the private bucket and nothing else', async () => {
    const storage = freshStorage()
    const key = await storeOriginal({
      mediaId: MEDIA_ID,
      extension: 'png',
      source,
      contentType: 'image/png',
      storage,
    })
    expect(key).toBe(originalKey(MEDIA_ID, 'png'))
    expect(await storage.list('private')).toEqual([key])
    // The control, and the reason the split exists: the private bucket holds full-resolution photographs
    // of employees whose photography consent is not on record. One in the public bucket is a data
    // incident nothing would report.
    expect(await storage.list('public')).toEqual([])
    const stored = await storage.head({ bucket: 'private', key })
    expect(stored?.cacheControl).toBe('private, no-store')
  })
})
