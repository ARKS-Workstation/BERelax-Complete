/**
 * The crop windows a preview draws, and the sweep that lets a slider move one without a round trip.
 *
 * ## Why a precomputed sweep rather than the function in the browser
 *
 * The preview is served by a route handler, not a React page: W-SITE-01's registry requires every
 * *document* to exist in both locales, and an Arabic admin document is not what this unit is for (the
 * Messages inbox made the same call, one directory along). A route handler has no client bundle, so
 * "changing focalX re-crops the preview within the same render" cannot be a React island — and the
 * alternative, an inline script that computes the rectangle itself, would be a **second copy of
 * `cropRectFor`**, written in a string, where no typechecker and no test can see it. That is precisely the
 * drift this whole unit exists to prevent.
 *
 * So the server evaluates the real `cropRectFor` once per focal position and ships the answers. The inline
 * script only indexes the table. Every number an editor sees came out of the same function the derivative
 * job crops with, and `crop-preview.test.ts` asserts that for every entry.
 *
 * Pure geometry over `ladders.ts`. No `sharp`, no I/O.
 */
import { AppError } from '@berelax/shared'
import { CROP_NAMES, type CropName, type CropRect, cropRectFor } from './ladders.ts'

/**
 * The source frame the windows are taken out of.
 *
 * Named `CropSource` rather than `SourceGeometry` because `derivatives.ts` already exports that name for
 * the shape it *measures* with libvips. Two types with one name in one package is how an import ends up
 * pointing at the module that happens to be first in an editor's suggestion list.
 */
export interface CropSource {
  readonly width: number
  readonly height: number
}

/** The crop window per crop, for one focal point. */
export type CropBoxes = Readonly<Record<CropName, CropRect>>

export function cropBoxesFor(
  source: CropSource,
  focal: { readonly x: number; readonly y: number },
): CropBoxes {
  const boxes = {} as Record<CropName, CropRect>
  for (const crop of CROP_NAMES) boxes[crop] = cropRectFor(source, crop, focal)
  return boxes
}

/**
 * The step the focalX slider moves in, in percentage points.
 *
 * 1, so the slider is the full 0–100 integer range and the table is 101 entries — about 8KB of JSON, which
 * is less than one rung of the ladder it sits beside. A coarser step would make the slider report a crop
 * the job would not take for the value the row stores.
 */
export const FOCAL_STEP = 1

export interface FocalSweepEntry {
  readonly focalX: number
  readonly boxes: CropBoxes
}

/**
 * Every crop window from focalX 0 to 100 at the row's focalY.
 *
 * focalX alone, because that is the axis the acceptance criterion names and because a sweep over both axes
 * is 10,201 entries — a megabyte of JSON in an admin page, to make the second slider as instant as the
 * first. focalY is a form field that re-renders, and the note in the preview says so.
 */
export function focalXSweep(source: CropSource, focalY: number): readonly FocalSweepEntry[] {
  if (!Number.isFinite(focalY) || focalY < 0 || focalY > 100) {
    throw new AppError(
      'validation',
      `[focal-y-out-of-range] ${String(focalY)} is not a percentage from 0 to 100`,
      { details: { focalY } },
    )
  }
  const entries: FocalSweepEntry[] = []
  for (let focalX = 0; focalX <= 100; focalX += FOCAL_STEP) {
    entries.push({ focalX, boxes: cropBoxesFor(source, { x: focalX, y: focalY }) })
  }
  return entries
}

/**
 * Whether two crop windows differ as rectangles.
 *
 * Exported because both the preview's own assertion and the test's read it: "the mobile 4:5 crop is
 * visibly distinct from the desktop 16:9 crop" is a claim about four numbers, and a preview that showed
 * two identical boxes while labelling them differently would look right in a screenshot.
 */
export function cropBoxesDiffer(left: CropRect, right: CropRect): boolean {
  return (
    left.left !== right.left ||
    left.top !== right.top ||
    left.width !== right.width ||
    left.height !== right.height
  )
}
