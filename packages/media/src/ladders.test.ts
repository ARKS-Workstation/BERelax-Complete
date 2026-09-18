import { describe, expect, it } from 'vitest'
import {
  AVIF_OPTIONS,
  CROP_NAMES,
  CROPS,
  cropRectFor,
  FORMATS,
  heightFor,
  isDeclaredWidth,
  JPEG_OPTIONS,
  nearestRung,
  renditionSpecs,
  WEBP_OPTIONS,
} from './ladders.ts'

/**
 * The ladders are numbers from docs/08 §6, so the test is mostly "are they still those numbers".
 *
 * That sounds like a test of a constant, and it is — but it is the constant two independent things agree
 * on. The job encodes from it and the browser's loader requests from it, so a width that drifts here is a
 * `srcset` entry pointing at a file that was never built, which the browser resolves by rendering
 * nothing, on one breakpoint only.
 *
 * Every positive assertion below is paired with the mistake it is guarding against, because "1080 is a
 * mobile rung" is satisfied just as well by an implementation where every width is a rung of everything.
 */
describe('the two art-directed ladders', () => {
  it('is 4:5 [414, 640, 828, 1080] on mobile and 16:9 [1024, 1440, 1920, 2560] on desktop', () => {
    expect(CROPS.mobile.ratio).toEqual([4, 5])
    expect(CROPS.mobile.widths).toEqual([414, 640, 828, 1080])
    expect(CROPS.desktop.ratio).toEqual([16, 9])
    expect(CROPS.desktop.widths).toEqual([1024, 1440, 1920, 2560])
  })

  it('does not treat one ladder’s rung as the other’s', () => {
    // The control. A width is declared *for a crop*, and the two ladders deliberately share none: the
    // desktop 1024 is not a mobile width and the mobile 1080 is not a desktop width.
    expect(isDeclaredWidth('mobile', 1080)).toBe(true)
    expect(isDeclaredWidth('desktop', 1080)).toBe(false)
    expect(isDeclaredWidth('desktop', 1024)).toBe(true)
    expect(isDeclaredWidth('mobile', 1024)).toBe(false)
    // And nothing between the rungs is declared, or "no undeclared width is produced" means nothing.
    expect(isDeclaredWidth('mobile', 828)).toBe(true)
    expect(isDeclaredWidth('mobile', 829)).toBe(false)
  })

  it('expands to exactly 24 renditions — two crops, four rungs, three formats', () => {
    const specs = renditionSpecs()
    expect(specs).toHaveLength(24)
    expect(new Set(specs.map((spec) => `${spec.crop}-${spec.width}-${spec.format}`)).size).toBe(24)
    for (const spec of specs) {
      expect(isDeclaredWidth(spec.crop, spec.width)).toBe(true)
    }
    expect(FORMATS).toEqual(['avif', 'webp', 'jpg'])
    expect(CROP_NAMES).toEqual(['mobile', 'desktop'])
  })

  it('pins the encoder settings docs/08 §6 states', () => {
    // The URL is addressed by the *source* bytes, so a quality changed here leaves every published URL
    // serving its old bytes for a year. It is a decision to be made once, which is why it is asserted.
    expect(AVIF_OPTIONS).toEqual({ quality: 52, effort: 4, chromaSubsampling: '4:2:0' })
    expect(WEBP_OPTIONS).toEqual({ quality: 76 })
    expect(JPEG_OPTIONS).toEqual({ quality: 80, mozjpeg: true })
  })

  it('derives a rung’s height from its own ratio', () => {
    expect(heightFor('mobile', 1080)).toBe(1350)
    expect(heightFor('mobile', 414)).toBe(518)
    expect(heightFor('desktop', 2560)).toBe(1440)
    // The control for the pair above: the two crops must not produce the same height for one width, which
    // is what a single shared ratio would do.
    expect(heightFor('desktop', 1080)).toBe(608)
    expect(heightFor('mobile', 1080)).not.toBe(heightFor('desktop', 1080))
  })
})

describe('nearestRung', () => {
  it('rounds to the nearest declared rung, ties upwards', () => {
    expect(nearestRung('mobile', 1)).toBe(414)
    expect(nearestRung('mobile', 526)).toBe(414)
    // 527 is equidistant from 414 and 640. A tie goes up: the visible failure of the two is the soft
    // image, not the extra kilobyte.
    expect(nearestRung('mobile', 527)).toBe(640)
    expect(nearestRung('mobile', 733)).toBe(640)
    expect(nearestRung('mobile', 734)).toBe(828)
    expect(nearestRung('mobile', 953)).toBe(828)
    expect(nearestRung('mobile', 954)).toBe(1080)
    expect(nearestRung('mobile', 3000)).toBe(1080)
    expect(nearestRung('desktop', 1)).toBe(1024)
    expect(nearestRung('desktop', 1231)).toBe(1024)
    expect(nearestRung('desktop', 1232)).toBe(1440)
    expect(nearestRung('desktop', 3000)).toBe(2560)
  })

  it('is neither the identity nor a constant', () => {
    // Two controls, because both degenerate implementations satisfy "returns a declared rung" for at
    // least some inputs: `width => width` passes on the rungs themselves, and `() => widest` passes at
    // the top of the range.
    expect(nearestRung('mobile', 700)).not.toBe(700)
    expect(new Set([1, 700, 900, 3000].map((w) => nearestRung('mobile', w))).size).toBe(4)
  })
})

describe('cropRectFor', () => {
  // team/team-01.jpg as the media manifest records it: a full-length portrait, focal point near the top.
  const portrait = { width: 882, height: 1600 }

  it('crops a tall portrait to 4:5 around its declared focal point', () => {
    const rect = cropRectFor(portrait, 'mobile', { x: 50, y: 16 })
    expect(rect.width).toBe(882)
    expect(rect.height).toBe(1103)
    expect(rect.left).toBe(0)
    // 16% of 1600 is 256, and half the window is 551 — so the window wants to start above the frame and
    // is pushed flush to the top. That is the behaviour the portraits need: the face is in the top fifth.
    expect(rect.top).toBe(0)
  })

  it('uses the focal point, rather than centring and claiming to', () => {
    // The control, and the defect it guards against is a real one: a centre crop of these portraits
    // produces a row of torsos (assets/media/README.md). If `focal` were ignored the two rects below
    // would be equal.
    const centred = cropRectFor(portrait, 'mobile', { x: 50, y: 50 })
    const focal = cropRectFor(portrait, 'mobile', { x: 50, y: 16 })
    expect(centred.top).toBe(249)
    expect(focal.top).not.toBe(centred.top)
  })

  it('never leaves the frame, whatever the focal point claims', () => {
    for (const y of [0, 16, 50, 84, 100]) {
      for (const x of [0, 50, 100]) {
        const rect = cropRectFor(portrait, 'desktop', { x, y })
        expect(rect.left).toBeGreaterThanOrEqual(0)
        expect(rect.top).toBeGreaterThanOrEqual(0)
        expect(rect.left + rect.width).toBeLessThanOrEqual(portrait.width)
        expect(rect.top + rect.height).toBeLessThanOrEqual(portrait.height)
      }
    }
  })

  it('takes the widest window each ratio allows', () => {
    // photos/spa-01.jpg: 1983x793 is 2.50:1, far wider than either target, so both crops keep the full
    // height and lose width — and they must lose *different* amounts.
    const source = { width: 1983, height: 793 }
    const wide = cropRectFor(source, 'desktop', { x: 50, y: 45 })
    expect(wide.height).toBe(793)
    expect(wide.width).toBe(1410)
    expect(wide.left).toBe(287)
    // The control: the same source at 4:5 must be narrower still, or the ratio is not being applied.
    const tall = cropRectFor(source, 'mobile', { x: 50, y: 45 })
    expect(tall.height).toBe(793)
    expect(tall.width).toBe(634)
    expect(tall.width).toBeLessThan(wide.width)
  })
})
