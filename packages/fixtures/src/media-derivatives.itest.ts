import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CROPS,
  encodeRendition,
  isWithinPlaceholderBand,
  MEDIA_SLOTS,
  PLACEHOLDER_LIGHTNESS_MIN,
  type Placeholder,
  placeholderFor,
} from '@berelax/media'
import sharp from 'sharp'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  assetByPath,
  assetsForSlot,
  loadMediaManifest,
  type MediaAsset,
  mediaRoot,
} from './media.ts'
import { generateSalon } from './salon.ts'

/**
 * The derivative pipeline against the real photography, which is the only place two of W-SYS-05's numbers
 * can be checked at all.
 *
 * `packages/fixtures` is the right home for this. `packages/media` must not depend on the fixture library
 * — production code reaching into test fixtures is the wrong direction — and the media manifest, the
 * fixture salon and the pipeline are three things that have to agree. Fixtures may see all three.
 *
 * **The twelve fixture images** are the four interiors in the `hero` slot and the eight portraits the
 * fixture salon actually puts on screen. Not all nineteen portraits: eleven of them are never rendered by
 * anything, and a placeholder for an image nobody shows is not a measurement. The two logos are excluded
 * because a wordmark has no dominant colour worth extracting and is never cropped.
 */
const HERO_BUDGETS = {
  // docs/08 §8: hero poster, AVIF, widest rung. 95KB mobile, 170KB desktop.
  mobile: 95 * 1024,
  desktop: 170 * 1024,
} as const

function bytesOf(asset: MediaAsset): Buffer {
  return readFileSync(join(mediaRoot(), asset.path))
}

function focalOf(asset: MediaAsset): { x: number; y: number } {
  return { x: asset.focalX ?? 50, y: asset.focalY ?? 50 }
}

/** The four heroes plus the eight portraits the fixture salon renders. Twelve. */
function twelveFixtureImages(): MediaAsset[] {
  const heroes = assetsForSlot('hero')
  const rendered = [
    ...new Set(generateSalon().therapists.map((therapist) => therapist.portrait.path)),
  ]
  return [...heroes, ...rendered.map((path) => assetByPath(path))]
}

let placeholders: { asset: MediaAsset; placeholder: Placeholder }[] = []

beforeAll(async () => {
  placeholders = []
  for (const asset of twelveFixtureImages()) {
    const stats = await sharp(bytesOf(asset)).stats()
    placeholders.push({ asset, placeholder: placeholderFor(stats.dominant) })
  }
}, 120_000)

describe('the media manifest and the pipeline agree', () => {
  it('declares the same slots in both places', () => {
    // The manifest's slot block is written from `packages/media`'s registry by
    // `scripts/emit-media-manifest.mjs`, and `pnpm media` fails when the committed file drifts from it.
    // This is the other direction: the manifest's keys and the slot names the URL builder accepts must be
    // the same set, because a slot renamed in one place would produce a `[unknown-slot]` failure at run
    // time on a real upload and nowhere else.
    expect([...MEDIA_SLOTS].sort()).toEqual(Object.keys(loadMediaManifest().slots).sort())
  })

  it('declares the same aspect ratios as the slots the crops serve', () => {
    const slots = loadMediaManifest().slots
    expect(slots['therapist-portrait'].ratio).toEqual([...CROPS.mobile.ratio])
    expect(slots['service-card'].ratio).toEqual([...CROPS.mobile.ratio])
    expect(slots.hero.ratio).toEqual([...CROPS.desktop.ratio])
    expect(slots.gallery.ratio).toEqual([...CROPS.desktop.ratio])
    expect(slots['testimonial-background'].ratio).toEqual([...CROPS.desktop.ratio])
    // The control: the slot that is never cropped declares no ratio, and the two crops are not the same.
    expect(slots.logo.ratio).toBeNull()
    expect(CROPS.mobile.ratio).not.toEqual([...CROPS.desktop.ratio])
  })
})

describe('the placeholder colour of all twelve fixture images', () => {
  it('is twelve images', () => {
    expect(placeholders).toHaveLength(12)
    expect(new Set(placeholders.map((entry) => entry.asset.path)).size).toBe(12)
    expect(placeholders.filter((entry) => entry.asset.slot === 'hero')).toHaveLength(4)
    expect(placeholders.filter((entry) => entry.asset.slot === 'therapist-portrait')).toHaveLength(
      8,
    )
  })

  it('is OKLCH inside the band — chroma <= 0.06, lightness 0.86..0.94', () => {
    for (const { asset, placeholder } of placeholders) {
      expect(isWithinPlaceholderBand(placeholder), asset.path).toBe(true)
      expect(placeholder.chroma, asset.path).toBeLessThanOrEqual(0.06)
      expect(placeholder.lightness, asset.path).toBeGreaterThanOrEqual(0.86)
      expect(placeholder.lightness, asset.path).toBeLessThanOrEqual(0.94)
    }
  })

  /**
   * And here is what that costs, stated rather than hidden.
   *
   * docs/08 §6 says the placeholder is "clamped to chroma <=0.06, lightness 0.86-0.94", and §8 asserts
   * that "pastel photography is a performance asset" — soft, low-contrast, low-detail images. The second
   * claim is not true of this library. **All twelve measure below the lightness floor**, from 0.134
   * (team-05, a near-black frame) to 0.783, and one (spa-02) is also outside the chroma bound at 0.0755.
   * Every placeholder on the site is therefore the clamp's output rather than the photograph's colour.
   *
   * So this test asserts the count of clamped images, and the failure it is designed to produce is a
   * *passing* build becoming a failing one when somebody replaces the photography with images that really
   * are pastel. At that point this assertion is the thing that says the note above is now out of date.
   * `Y12-photos` is the audit that would do it.
   */
  it('records that every one of the twelve had to be clamped', () => {
    const clamped = placeholders.filter((entry) => entry.placeholder.clamped)
    expect(clamped).toHaveLength(12)
    for (const { asset, placeholder } of placeholders) {
      expect(placeholder.measured.lightness, asset.path).toBeLessThan(PLACEHOLDER_LIGHTNESS_MIN)
    }
    // The darkest and the most saturated, named so the numbers in the comment above are checkable.
    const darkest = placeholders.reduce((worst, entry) =>
      entry.placeholder.measured.lightness < worst.placeholder.measured.lightness ? entry : worst,
    )
    expect(darkest.asset.path).toBe('team/team-05.jpg')
    expect(darkest.placeholder.measured.lightness).toBeCloseTo(0.1344, 3)
    const mostSaturated = placeholders.reduce((worst, entry) =>
      entry.placeholder.measured.chroma > worst.placeholder.measured.chroma ? entry : worst,
    )
    expect(mostSaturated.asset.path).toBe('photos/spa-02.jpg')
    expect(mostSaturated.placeholder.measured.chroma).toBeCloseTo(0.0755, 3)
  })

  it('keeps each photograph’s hue, so the twelve are not one colour', () => {
    // The control for the clamp. Lightness and chroma are pulled into a narrow band, so if the hue were
    // clamped too every placeholder on the site would be the same pale grey and the value would carry no
    // information at all.
    const hues = new Set(placeholders.map((entry) => Math.round(entry.placeholder.hue)))
    expect(hues.size).toBeGreaterThan(3)
  })
})

describe('the hero byte budget', () => {
  /**
   * The acceptance number, measured on the real photographs through the production encoder.
   *
   * `encodeRendition` is the same function `buildDerivatives` and `scripts/check-budgets.mjs` call, so
   * this cannot pass while the derivative the site serves is over budget — which is what a test with its
   * own encoder settings would allow.
   */
  it('keeps the widest hero AVIF within 95KB at 4:5 and 170KB at 16:9', async () => {
    const measured: string[] = []
    for (const asset of assetsForSlot('hero')) {
      for (const crop of ['mobile', 'desktop'] as const) {
        const width = CROPS[crop].widths.at(-1) ?? 0
        const bytes = await encodeRendition({
          source: bytesOf(asset),
          crop,
          width,
          format: 'avif',
          focal: focalOf(asset),
        })
        measured.push(`${asset.path} ${crop} ${width} ${bytes.length}`)
        expect(bytes.length, `${asset.path} ${crop}@${width}`).toBeLessThanOrEqual(
          HERO_BUDGETS[crop],
        )
      }
    }
    expect(measured).toHaveLength(8)
    // The control: the budgets are not so loose that any file passes. The 16:9 crop at 2560 is the
    // heaviest derivative the site serves, and the worst of the four heroes uses about 90% of its budget —
    // so a budget five times the number would be decoration.
    for (const line of measured) {
      const size = Number(line.split(' ').at(-1))
      expect(size).toBeGreaterThan(10_000)
    }
  }, 240_000)
})
