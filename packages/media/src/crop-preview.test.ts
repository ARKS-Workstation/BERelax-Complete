import { isAppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { cropBoxesDiffer, cropBoxesFor, FOCAL_STEP, focalXSweep } from './crop-preview.ts'
import { CROP_NAMES, cropRectFor } from './ladders.ts'

/**
 * W-SYS-10 — the crop windows the preview draws.
 *
 * The claim these assertions defend is that the sweep the browser indexes is not a second implementation:
 * every entry must equal `cropRectFor` for the same inputs, because `cropRectFor` is what the derivative
 * job extracts with. If they can drift, the editor approves a crop the site does not serve — and both look
 * plausible.
 *
 * The source used is the real hero frame's geometry (1672x941, `assets/media/photos/hero-team.jpg`) and the
 * real portrait geometry (1086x1448, `team/team-02.jpg`), because the interesting behaviour is at the
 * edges: a 16:9 window out of a 16:9-ish frame is the whole frame, and a 4:5 window out of a tall portrait
 * has room to move.
 */
const HERO = { width: 1672, height: 941 }
const PORTRAIT = { width: 1086, height: 1448 }

describe('cropBoxesFor', () => {
  it('is cropRectFor, for every crop', () => {
    for (const focal of [
      { x: 0, y: 0 },
      { x: 15, y: 45 },
      { x: 50, y: 45 },
      { x: 100, y: 100 },
    ]) {
      const boxes = cropBoxesFor(HERO, focal)
      for (const crop of CROP_NAMES) {
        expect(boxes[crop], `${crop} @ ${focal.x},${focal.y}`).toEqual(
          cropRectFor(HERO, crop, focal),
        )
      }
    }
  })

  it('gives the two crops numerically different windows for the same asset', () => {
    // W-SYS-10's acceptance names this: "the mobile 4:5 crop is visibly distinct from the desktop 16:9 crop
    // for the same asset (differing crop boxes asserted numerically)". On the hero frame the 16:9 window is
    // the entire frame and the 4:5 window is a 753px column out of the middle of it.
    const boxes = cropBoxesFor(HERO, { x: 50, y: 45 })
    expect(cropBoxesDiffer(boxes.mobile, boxes.desktop)).toBe(true)
    expect(boxes.desktop).toEqual({ left: 0, top: 0, width: 1672, height: 941 })
    expect(boxes.mobile.width).toBe(753)
    expect(boxes.mobile.height).toBe(941)
    expect(boxes.mobile.left).toBeGreaterThan(0)
    // The control on the comparison itself: two windows that ARE the same are reported as the same.
    expect(cropBoxesDiffer(boxes.mobile, { ...boxes.mobile })).toBe(false)
    expect(cropBoxesDiffer(boxes.mobile, { ...boxes.mobile, left: boxes.mobile.left + 1 })).toBe(
      true,
    )
  })

  it('keeps every window inside the frame at every focal point', () => {
    for (const source of [HERO, PORTRAIT]) {
      for (let x = 0; x <= 100; x += 5) {
        for (let y = 0; y <= 100; y += 5) {
          const boxes = cropBoxesFor(source, { x, y })
          for (const crop of CROP_NAMES) {
            const box = boxes[crop]
            const where = `${crop} ${source.width}x${source.height} @ ${x},${y}`
            expect(box.left, where).toBeGreaterThanOrEqual(0)
            expect(box.top, where).toBeGreaterThanOrEqual(0)
            expect(box.left + box.width, where).toBeLessThanOrEqual(source.width)
            expect(box.top + box.height, where).toBeLessThanOrEqual(source.height)
          }
        }
      }
    }
  })
})

describe('focalXSweep', () => {
  it('covers the whole slider and agrees with cropRectFor at every stop', () => {
    const sweep = focalXSweep(PORTRAIT, 16)
    expect(FOCAL_STEP).toBe(1)
    expect(sweep).toHaveLength(101)
    expect(sweep[0]?.focalX).toBe(0)
    expect(sweep.at(-1)?.focalX).toBe(100)
    for (const entry of sweep) {
      for (const crop of CROP_NAMES) {
        expect(entry.boxes[crop], `${crop} @ ${entry.focalX}`).toEqual(
          cropRectFor(PORTRAIT, crop, { x: entry.focalX, y: 16 }),
        )
      }
    }
  })

  it('actually moves the window, and only where there is room to move', () => {
    // Without this the sweep could be 101 copies of one rectangle and every assertion above would hold —
    // which is the shape of a slider that looks live and changes nothing.
    const sweep = focalXSweep(HERO, 45)
    const mobileLefts = new Set(sweep.map((entry) => entry.boxes.mobile.left))
    expect(mobileLefts.size).toBeGreaterThan(50)
    expect(Math.min(...mobileLefts)).toBe(0)
    // 1672 - 753: at focalX 100 the window is flush with the right edge, clamped rather than pushed outside
    // the frame — `cropRectFor`'s documented behaviour, and the reason a subject 16% from an edge gets the
    // window flush with it instead of a sliver of dead space.
    expect(Math.max(...mobileLefts)).toBe(919)

    // The half that is NOT movement: the hero's 16:9 window is the whole frame (1672 / (16/9) rounds to its
    // full 941 height), so focalX has nothing to move and the desktop box is constant. A preview that
    // animated it would be showing a crop the job does not take.
    expect(new Set(sweep.map((entry) => JSON.stringify(entry.boxes.desktop))).size).toBe(1)

    // The control on that claim: a frame with room to move does move.
    const wide = focalXSweep({ width: 2400, height: 1000 }, 50)
    expect(new Set(wide.map((entry) => entry.boxes.desktop.left)).size).toBeGreaterThan(20)
  })

  it('refuses a focalY that is not a percentage', () => {
    for (const bad of [-1, 101, Number.NaN]) {
      try {
        focalXSweep(HERO, bad)
        expect.unreachable(`${String(bad)} is not a percentage`)
      } catch (error) {
        expect(isAppError(error) && error.message, String(bad)).toContain('[focal-y-out-of-range]')
      }
    }
  })
})
