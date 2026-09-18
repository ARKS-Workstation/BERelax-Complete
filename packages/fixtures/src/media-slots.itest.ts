import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CROPS,
  declaredCropRect,
  encodeRendition,
  isJunkAlt,
  MEDIA_SLOT_LIST,
  MEDIA_SLOT_NAMES,
  mediaSlot,
  provisionalSlotPlaceholders,
  SLOT_REGISTRY,
  validateUpload,
} from '@berelax/media'
import { beforeAll, describe, expect, it } from 'vitest'
import { assetByPath, loadMediaManifest, type MediaAsset, mediaRoot } from './media.ts'

/**
 * W-SYS-09 — the slot registry against the twenty-five real assets, and the focal point against libvips.
 *
 * `packages/fixtures` is the right home for the same reason `media-derivatives.itest.ts` is here:
 * `packages/media` must not import the fixture library, the media manifest and the registry are two things
 * that have to agree, and this package may see both.
 *
 * Two claims live here and nowhere else.
 *
 * **The library satisfies its own declared constraints.** Every committed asset is run through the
 * validator a real upload goes through. `pnpm media` does this too, on every build; this is the version
 * with the controls — a deliberately wrong measurement of a real file has to be rejected, or the pass over
 * twenty-five files proves only that the validator returns an empty array.
 *
 * **Crop before resize, around the focal point.** Moving the focal point changes the 4:5 derivative's
 * bytes, and leaves the 16:9 derivative byte-identical when the subject cannot leave the frame. That needs
 * a real photograph and a real encoder, and it is the only assertion in this repository that shows the
 * focal point reaching libvips rather than being stored and ignored.
 */
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function bytesOf(asset: MediaAsset): Buffer {
  return readFileSync(join(mediaRoot(), asset.path))
}

/**
 * `photos/hero-team.jpg`: 1672x941, ratio 1.7768.
 *
 * Chosen because its 16:9 window is the whole frame — 1672/(16/9) rounds to 941, which is its full height
 * — so the desktop crop cannot move however the focal point is set. That is exactly the "subject stays in
 * frame" case the acceptance describes, measured rather than assumed.
 */
const HERO_PATH = 'photos/hero-team.jpg'

/** Left of centre, so the 4:5 window clamps against the left edge instead of sitting mid-frame. */
const MOVED_FOCAL = { x: 15, y: 45 } as const

let hero: MediaAsset
let source: Buffer
const encoded: Record<string, string> = {}

beforeAll(async () => {
  hero = assetByPath(HERO_PATH)
  source = bytesOf(hero)
  const declared = { x: hero.focalX ?? 50, y: hero.focalY ?? 50 }
  for (const [label, focal] of [
    ['declared', declared],
    ['moved', MOVED_FOCAL],
  ] as const) {
    for (const crop of ['mobile', 'desktop'] as const) {
      // The narrowest rung of each ladder and WebP rather than AVIF: the claim is about which pixels were
      // cropped, which no encoder setting changes, and the widest AVIF rung of a real photograph is eight
      // seconds of libvips. WebP q76 is deterministic, which is what a byte-identity assertion needs.
      const width = CROPS[crop].widths[0] as number
      const buffer = await encodeRendition({ source, crop, width, format: 'webp', focal })
      encoded[`${label}-${crop}`] = sha256(buffer)
    }
  }
}, 120_000)

describe('the twenty-five real assets against the declared constraints', () => {
  it('satisfies every constraint its slot declares', () => {
    const manifest = loadMediaManifest()
    expect(manifest.assets).toHaveLength(25)
    for (const asset of manifest.assets) {
      const focal =
        asset.focalX === undefined || asset.focalY === undefined
          ? undefined
          : { x: asset.focalX, y: asset.focalY }
      const violations = validateUpload({
        slot: asset.slot,
        mimeType: asset.path.endsWith('.png') ? 'image/png' : 'image/jpeg',
        byteLength: asset.bytes,
        width: asset.width,
        height: asset.height,
        filename: asset.path,
        ...(focal === undefined ? {} : { focal }),
      })
      expect(
        violations.map((violation) => violation.rule),
        `${asset.path}: ${violations.map((violation) => violation.message).join('; ')}`,
      ).toEqual([])
    }
  })

  it('and the validator is not simply returning nothing', () => {
    // The control for the pass above, on a real file. The same asset with each constraint broken in turn
    // has to be rejected by the rule written for it; without this, twenty-five empty arrays would be
    // indistinguishable from a validator that examined nothing (ADR 0003).
    const asset = assetByPath('team/team-01.jpg')
    const base = {
      slot: asset.slot,
      mimeType: 'image/jpeg' as const,
      byteLength: asset.bytes,
      width: asset.width,
      height: asset.height,
      focal: { x: asset.focalX ?? 50, y: asset.focalY ?? 50 },
      filename: asset.path,
    }
    expect(validateUpload(base)).toEqual([])
    expect(validateUpload({ ...base, mimeType: 'image/webp' }).map((v) => v.rule)).toEqual([
      'slot-mime-not-allowed',
    ])
    expect(
      validateUpload({ ...base, byteLength: SLOT_REGISTRY['therapist-portrait'].maxBytes + 1 }).map(
        (v) => v.rule,
      ),
    ).toEqual(['slot-over-maximum-bytes'])
    expect(validateUpload({ ...base, width: 500, height: 907 }).map((v) => v.rule)).toEqual([
      'slot-below-minimum-dimensions',
    ])
    // The same real portrait with its focal point removed: 0.551 against the slot's 0.800, and nobody has
    // said where the face is. This is the failure `assets/media/README.md` measures.
    const withoutFocal = { ...base, focal: undefined }
    expect(validateUpload(withoutFocal).map((v) => v.rule)).toEqual(['slot-ratio-out-of-tolerance'])
  })

  it('stores every focal point as a percentage inside the frame', () => {
    for (const asset of loadMediaManifest().assets) {
      if (asset.focalX === undefined) continue
      expect(asset.focalX, asset.path).toBeGreaterThanOrEqual(0)
      expect(asset.focalX, asset.path).toBeLessThanOrEqual(100)
      expect(asset.focalY, asset.path).toBeGreaterThanOrEqual(0)
      expect(asset.focalY, asset.path).toBeLessThanOrEqual(100)
    }
    // The control: a focal point outside the frame is refused by name, so "every one is in range" is a
    // fact about the library rather than about a check that never fires.
    expect(
      validateUpload({
        slot: 'hero',
        mimeType: 'image/jpeg',
        byteLength: 1000,
        width: 1920,
        height: 1080,
        focal: { x: 101, y: 50 },
      }).map((violation) => violation.rule),
    ).toEqual(['slot-focal-point-out-of-range'])
  })

  it('would have every one of its filenames rejected as alt text', () => {
    // Not a hypothetical junk corpus: these are the twenty-five names actually on disk, and the filename is
    // what a required alt field gets filled with when it is already on screen.
    for (const asset of loadMediaManifest().assets) {
      const filename = asset.path.split('/').pop() ?? ''
      expect(isJunkAlt({ slot: mediaSlot(asset.slot), alt: filename, filename }), filename).toBe(
        true,
      )
      // And the stem alone, which is what survives a copy-paste that drops the extension.
      const stem = filename.replace(/\.[a-z]+$/, '')
      expect(
        isJunkAlt({ slot: mediaSlot(asset.slot), alt: stem, filename: asset.path }),
        stem,
      ).toBe(true)
    }
  })
})

describe('the focal point reaches libvips: crop before resize', () => {
  it('measures the hero frame the claim depends on', () => {
    expect([hero.width, hero.height]).toEqual([1672, 941])
    // The 16:9 window is the whole frame, at the declared focal point and at the moved one. This is what
    // "the subject stays in frame" means here, and it is measured rather than asserted about the photograph.
    const declared = declaredCropRect(
      {
        slot: 'hero',
        mimeType: 'image/jpeg',
        byteLength: hero.bytes,
        width: hero.width,
        height: hero.height,
        focal: { x: hero.focalX ?? 50, y: hero.focalY ?? 50 },
      },
      SLOT_REGISTRY.hero,
    )
    const moved = declaredCropRect(
      {
        slot: 'hero',
        mimeType: 'image/jpeg',
        byteLength: hero.bytes,
        width: hero.width,
        height: hero.height,
        focal: MOVED_FOCAL,
      },
      SLOT_REGISTRY.hero,
    )
    expect(declared).toEqual({ left: 0, top: 0, width: 1672, height: 941 })
    expect(moved).toEqual(declared)

    // The 4:5 window is 753 wide out of 1672, and the focal point decides where it sits.
    const portraitDeclared = declaredCropRect(
      {
        slot: 'therapist-portrait',
        mimeType: 'image/jpeg',
        byteLength: hero.bytes,
        width: hero.width,
        height: hero.height,
        focal: { x: hero.focalX ?? 50, y: hero.focalY ?? 50 },
      },
      SLOT_REGISTRY['therapist-portrait'],
    )
    const portraitMoved = declaredCropRect(
      {
        slot: 'therapist-portrait',
        mimeType: 'image/jpeg',
        byteLength: hero.bytes,
        width: hero.width,
        height: hero.height,
        focal: MOVED_FOCAL,
      },
      SLOT_REGISTRY['therapist-portrait'],
    )
    expect(portraitDeclared.width).toBe(753)
    expect(portraitDeclared.left).toBe(460)
    expect(portraitMoved.left).toBe(0)

    // And the order: the window is 753 source pixels wide while the rung being served is 414. A pipeline
    // that resized first and cropped afterwards could not take a 753-pixel window out of a 414-pixel
    // image, so this is the assertion that says crop comes before resize rather than the comment saying so.
    expect(portraitDeclared.width).toBeGreaterThan(CROPS.mobile.widths[0] as number)
  })

  it('changes the 4:5 derivative when the focal point moves', () => {
    expect(encoded['declared-mobile']).not.toBe(encoded['moved-mobile'])
  })

  it('leaves the 16:9 derivative byte-identical', () => {
    expect(encoded['declared-desktop']).toBe(encoded['moved-desktop'])
    // The control that keeps the assertion above from being "both encodes produced the same thing": the
    // two crops of the same frame at the same focal point are different images.
    expect(encoded['declared-desktop']).not.toBe(encoded['declared-mobile'])
  })
})

describe('the placeholders are provisional, and nothing publishes one silently', () => {
  it('flags one per slot that reserves a box, against Y12-photos', () => {
    const provisional = provisionalSlotPlaceholders()
    expect(provisional).toHaveLength(MEDIA_SLOT_NAMES.length - 1)
    for (const entry of provisional) {
      expect(entry.openQuestionId, entry.slot).toBe('Y12-photos')
    }
  })

  it('has no slot with an asset in the library and no placeholder, and none the other way round', () => {
    // The two halves of "a placeholder stands in for a photograph that has not been chosen". A slot with
    // assets and no placeholder would paint nothing while its images load; a slot with neither assets nor a
    // placeholder would render as a collapsed box. `logo` is the one slot with assets and no placeholder,
    // deliberately — a flat card behind a transparent wordmark is a rectangle nobody drew.
    const occupied = new Set(loadMediaManifest().assets.map((asset) => asset.slot))
    for (const slot of MEDIA_SLOT_LIST) {
      expect(slot.placeholder === null, slot.name).toBe(slot.name === 'logo')
    }
    expect([...occupied].includes('logo')).toBe(true)
    // Three of the five named slots have no photograph at all yet, which is what Y12-photos is about.
    expect(
      [...MEDIA_SLOT_LIST].filter((slot) => !occupied.has(slot.name)).map((s) => s.name),
    ).toEqual(['service-card', 'gallery', 'testimonial-background'])
  })
})
