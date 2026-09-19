import { isAppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { CROPS, FORMATS, heightFor, nearestRung } from './ladders.ts'
import {
  cropForViewportWidth,
  DEFAULT_SIZES,
  fallbackDimensions,
  fallbackSrcFor,
  PREVIEW_CSS_WIDTHS,
  pictureSourcesFor,
  selectedRungFor,
  slotOf,
  srcsetFor,
} from './srcset.ts'
import { DERIVATIVE_PATH_PATTERN, parseDerivativePath } from './url.ts'

/**
 * W-SYS-10 — the one `srcset` builder.
 *
 * The acceptance criterion this file underwrites is "one source of truth, not a lookalike": the preview's
 * string and the production component's string must be the same string. That is asserted end to end in
 * `apps/web/src/breakpoint-preview.itest.ts`, against two rendered documents. What is here is the property
 * that makes the comparison worth making — that the string is built from the ladders rather than typed —
 * and each assertion is paired with the wrong answer it must not produce.
 */
const REF = {
  mediaId: '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f',
  contentHash: '8dad757b10eadb9b',
  slot: 'hero',
} as const

describe('srcsetFor', () => {
  it('offers every rung of the crop, ascending, with w descriptors', () => {
    const set = srcsetFor(REF, 'mobile', 'avif')
    const entries = set.split(', ')
    // Every rung the ladder declares, in the ladder's order. A narrowed set is how a retina tablet ends
    // up with the phone rung, and the image still appears.
    expect(entries).toHaveLength(CROPS.mobile.widths.length)
    expect(entries.map((entry) => entry.split(' ')[1])).toEqual(
      CROPS.mobile.widths.map((width) => `${width}w`),
    )
    for (const entry of entries) {
      const [path] = entry.split(' ')
      expect(path, entry).toMatch(DERIVATIVE_PATH_PATTERN)
      const ref = parseDerivativePath(path ?? '')
      expect(ref?.crop, entry).toBe('mobile')
      expect(ref?.format, entry).toBe('avif')
      expect(ref?.mediaId, entry).toBe(REF.mediaId)
      expect(ref?.contentHash, entry).toBe(REF.contentHash)
    }
  })

  it('never mixes the two ladders into one set', () => {
    // The control on the art direction. A single set containing both crops would let a browser choose a
    // 16:9 rung on a phone, which is the whole thing the two ladders exist to prevent — and it would look
    // like a working image.
    const mobile = srcsetFor(REF, 'mobile', 'avif')
    const desktop = srcsetFor(REF, 'desktop', 'avif')
    for (const width of CROPS.desktop.widths) {
      expect(mobile).not.toContain(`-${width}.avif`)
    }
    for (const width of CROPS.mobile.widths) {
      expect(desktop).not.toContain(`-${width}.avif`)
    }
    expect(mobile).not.toBe(desktop)
  })

  it('refuses a slot with no ladder', () => {
    // The wordmark is never cropped, so there is no ladder to offer. Silently producing 4:5 crops of a
    // wordmark would cut the brand name in half at every rung.
    try {
      srcsetFor({ ...REF, slot: 'logo' }, 'mobile', 'avif')
      expect.unreachable('a slot with no ratio must not yield a srcset')
    } catch (error) {
      expect(isAppError(error) && error.message).toContain('[slot-is-never-cropped]')
    }
    try {
      srcsetFor({ ...REF, slot: 'carousel' }, 'mobile', 'avif')
      expect.unreachable('an undeclared slot must not yield a srcset')
    } catch (error) {
      expect(isAppError(error) && error.message).toContain('[unknown-slot]')
    }
  })
})

describe('pictureSourcesFor', () => {
  it('emits one source per crop and format, in resolution order', () => {
    const sources = pictureSourcesFor(REF)
    expect(sources).toHaveLength(2 * FORMATS.length)
    expect(sources.map((source) => `${source.crop}/${source.format}`)).toEqual([
      'mobile/avif',
      'mobile/webp',
      'mobile/jpg',
      'desktop/avif',
      'desktop/webp',
      'desktop/jpg',
    ])
    // The media query is the ladder's own, not a copy. A second spelling of `(max-width: 767px)` here is
    // a second breakpoint to keep in step with the crop the job takes.
    expect(sources[0]?.media).toBe(CROPS.mobile.media)
    expect(sources.at(-1)?.media).toBe(CROPS.desktop.media)
    // `image/jpeg`, not `image/jpg`: the format token is `jpg` because the URL pattern admits one
    // spelling, and a browser matching `type` against `image/jpg` matches nothing.
    expect(sources.at(-1)?.type).toBe('image/jpeg')
    expect(sources.every((source) => source.sizes === DEFAULT_SIZES)).toBe(true)
  })

  it('passes the sizes it is given through unchanged', () => {
    const sources = pictureSourcesFor(REF, '(min-width: 1024px) 480px, 100vw')
    expect(new Set(sources.map((source) => source.sizes))).toEqual(
      new Set(['(min-width: 1024px) 480px, 100vw']),
    )
    // The srcset does NOT change with sizes — it is the set of files, and sizes is how the browser picks
    // from it. A builder that filtered the set by the layout would make the preview and the component
    // disagree the moment one of them passed a different sizes.
    expect(sources[0]?.srcset).toBe(pictureSourcesFor(REF)[0]?.srcset)
  })
})

describe('cropForViewportWidth', () => {
  it('reads the bound out of the ladder rather than restating it', () => {
    // The two queries are `(max-width: 767px)` and `(min-width: 768px)`, so the switch is at 768 — and
    // that number appears in this file nowhere except as the ladder's own.
    const bound = Number.parseInt(/(\d+)px/.exec(CROPS.desktop.media)?.[1] ?? '', 10)
    expect(cropForViewportWidth(bound - 1)).toBe('mobile')
    expect(cropForViewportWidth(bound)).toBe('desktop')
    expect(cropForViewportWidth(bound + 1)).toBe('desktop')
  })

  it('sends every acceptance width to a crop, and the phones to the 4:5 one', () => {
    expect(PREVIEW_CSS_WIDTHS).toEqual([360, 390, 414, 768, 1024, 1440, 1600])
    const byWidth = PREVIEW_CSS_WIDTHS.map((width) => cropForViewportWidth(width))
    expect(byWidth).toEqual([
      'mobile',
      'mobile',
      'mobile',
      'desktop',
      'desktop',
      'desktop',
      'desktop',
    ])
  })

  it('refuses a width that is not one', () => {
    for (const bad of [0, -390, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        cropForViewportWidth(bad)
        expect.unreachable(`${String(bad)} is not a viewport width`)
      } catch (error) {
        expect(isAppError(error) && error.message, String(bad)).toContain(
          '[invalid-viewport-width]',
        )
      }
    }
  })
})

describe('selectedRungFor', () => {
  it('answers with a declared rung and its ladder height at every acceptance width', () => {
    for (const cssWidth of PREVIEW_CSS_WIDTHS) {
      const resolved = selectedRungFor(cssWidth)
      expect(CROPS[resolved.crop].widths, `${cssWidth}px`).toContain(resolved.width)
      expect(resolved.height, `${cssWidth}px`).toBe(heightFor(resolved.crop, resolved.width))
      // The selection rule, stated as the property rather than as a table: never narrower than what is
      // needed, unless there is nothing wider left.
      const widest = CROPS[resolved.crop].widths.at(-1) ?? 0
      if (resolved.width !== widest) {
        expect(resolved.width, `${cssWidth}px`).toBeGreaterThanOrEqual(cssWidth)
      }
    }
  })

  it('reports the table the acceptance criterion asks for', () => {
    // Written out, because not one of the seven widths is a rung and two of them are the interesting cases:
    // 768 crosses into the 16:9 ladder at its narrowest rung, and 1600 is served the 1920 rung rather than
    // the closer 1440 — which is HTML's selection rule, and the reason this is not `nearestRung`.
    expect(
      PREVIEW_CSS_WIDTHS.map((width) => {
        const rung = selectedRungFor(width)
        return `${width}->${rung.crop}/${rung.width}`
      }),
    ).toEqual([
      '360->mobile/414',
      '390->mobile/414',
      '414->mobile/414',
      '768->desktop/1024',
      '1024->desktop/1024',
      '1440->desktop/1440',
      '1600->desktop/1920',
    ])
  })

  it('differs from the loader nearest-rung rule, which is the whole point', () => {
    // If these two ever agreed everywhere, one of them would be redundant. They do not: 1600 needs 1600
    // pixels and 1440 is fewer, so the loader's "closest" answer is a soft image on the widest screens.
    expect(selectedRungFor(1600).width).toBe(1920)
    expect(nearestRung('desktop', 1600)).toBe(1440)
  })

  it('takes a device pixel ratio into account, and stops at the widest rung', () => {
    // A 390px phone at 2x needs 780 device pixels, which is the 828 rung and not the 414 one. The preview
    // renders at 1 and says so; this is the control that the parameter is not decoration.
    expect(selectedRungFor(390, 1).width).toBe(414)
    expect(selectedRungFor(390, 2).width).toBe(828)
    // Above the widest rung there is nothing to choose, so the widest is the answer rather than an error:
    // a 4K display is a real display and an upscale in the browser is the correct outcome.
    expect(selectedRungFor(1600, 3).width).toBe(2560)
  })
})

describe('the <img> inside the <picture>', () => {
  it('is a JPEG at the narrowest desktop rung, with its intrinsic box', () => {
    const src = fallbackSrcFor(REF)
    const ref = parseDerivativePath(src)
    expect(ref?.format).toBe('jpg')
    expect(ref?.crop).toBe('desktop')
    expect(ref?.width).toBe(CROPS.desktop.widths[0])
    const box = fallbackDimensions()
    expect(box.width).toBe(CROPS.desktop.widths[0])
    // The height comes from the ladder's ratio, so the box reserved before the bytes arrive is the box the
    // bytes fill — which is what stops the page reflowing when they land.
    expect(box.height).toBe(heightFor('desktop', box.width))
  })

  it('refuses a slot with no ladder, like the srcset does', () => {
    try {
      fallbackSrcFor({ ...REF, slot: 'logo' })
      expect.unreachable('a wordmark has no desktop rung')
    } catch (error) {
      expect(isAppError(error) && error.message).toContain('[slot-is-never-cropped]')
    }
  })
})

describe('slotOf', () => {
  it('answers the declared slot and refuses anything else', () => {
    expect(slotOf(REF)).toBe('hero')
    expect(() => slotOf({ ...REF, slot: 'carousel' })).toThrow(/\[unknown-slot]/)
  })
})
