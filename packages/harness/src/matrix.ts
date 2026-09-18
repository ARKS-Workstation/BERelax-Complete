/**
 * The capture matrix: what gets photographed, and why each axis is there.
 *
 * Three viewports, two themes, two directions — twelve images per page. That is a lot of images, and
 * each axis earns its place by catching a class of defect the others cannot see:
 *
 * **390px** is the phone the booking actually happens on. It is also where a 68ch measure becomes
 * 34ch, where a four-column table becomes unreadable, and where a 40px touch target becomes a
 * mis-tap. **768px** is the tablet at the front desk. **1440px** is the laptop the owner reads
 * reports on, and the width at which a full-bleed layout stops having any structure.
 *
 * **Dark mode** is not the light theme with the colours swapped — docs/08 derives it separately, warm
 * rather than inverted, with the accent polarity flipped. Nothing about it can be inferred from a
 * light screenshot.
 *
 * **RTL** is the axis most likely to be skipped and most likely to be wrong. An Arabic page is not a
 * translated page: the whole layout mirrors, icons that imply direction have to flip, and anything
 * positioned with `left` instead of `inline-start` stays where it was. That failure is invisible in
 * code review and obvious in a screenshot.
 */

export interface Viewport {
  readonly name: string
  readonly width: number
  readonly height: number
  /** Device scale factor. 2 on the phone, because that is what a phone is. */
  readonly scale: number
  readonly why: string
}

export const VIEWPORTS: readonly Viewport[] = [
  {
    name: 'phone',
    width: 390,
    height: 844,
    scale: 2,
    why: 'the device the booking actually happens on',
  },
  { name: 'tablet', width: 768, height: 1024, scale: 2, why: 'the front desk' },
  {
    name: 'desktop',
    width: 1440,
    height: 900,
    scale: 1,
    why: 'reports, and where layout needs structure',
  },
]

export type Theme = 'light' | 'dark'
export type Direction = 'ltr' | 'rtl'

export const THEMES: readonly Theme[] = ['light', 'dark']
export const DIRECTIONS: readonly Direction[] = ['ltr', 'rtl']

export interface CaptureTarget {
  readonly page: string
  readonly viewport: Viewport
  readonly theme: Theme
  readonly direction: Direction
}

/**
 * A capture's filename.
 *
 * Deterministic and sortable: page, then viewport in ascending width, then theme, then direction.
 * The parts are joined with `__` so a page name containing a hyphen cannot be confused for a
 * separator — which matters because the gallery parses these back.
 */
export function captureFilename(target: CaptureTarget): string {
  return `${target.page}__${target.viewport.name}__${target.theme}__${target.direction}.png`
}

/** Parses a filename back into its target parts, or undefined if it is not one of ours. */
export function parseCaptureFilename(
  filename: string,
): { page: string; viewport: string; theme: Theme; direction: Direction } | undefined {
  const base = filename.replace(/\.png$/, '')
  const parts = base.split('__')
  if (parts.length !== 4) return undefined
  const [page, viewport, theme, direction] = parts
  if (page === undefined || viewport === undefined) return undefined
  if (theme !== 'light' && theme !== 'dark') return undefined
  if (direction !== 'ltr' && direction !== 'rtl') return undefined
  return { page, viewport, theme, direction }
}

/**
 * Every combination for a set of pages, in a stable order.
 *
 * This is what makes the matrix answer to the route registry rather than to a list inside the capture
 * script. `apps/web/src/route-spine.itest.ts` passes the registry's document ids and asserts that every
 * target in the returned plan was photographed — so adding a route adds twelve required captures, and a
 * route added without one fails a test rather than quietly never being looked at.
 *
 * Duplicate names throw rather than being de-duplicated: two pages filed under one name produce one set
 * of filenames, so the second would silently overwrite the first's images and the count would still add
 * up.
 */
export function capturePlan(pages: readonly string[]): CaptureTarget[] {
  const seen = new Set<string>()
  for (const page of pages) {
    if (seen.has(page)) throw new Error(`Duplicate page name in the capture plan: '${page}'`)
    seen.add(page)
  }
  return pages.flatMap((page) => targetsFor(page))
}

/**
 * The filenames a plan requires that are absent from a set of captures.
 *
 * Returned rather than thrown, and named rather than counted: "47 of 48" says a cell is missing, and
 * `home__phone__dark__rtl.png` says which one — the difference between a failing test somebody can fix
 * and a failing test somebody re-runs.
 */
export function missingCaptures(
  plan: readonly CaptureTarget[],
  filenames: Iterable<string>,
): string[] {
  const present = new Set(filenames)
  return plan.map((target) => captureFilename(target)).filter((name) => !present.has(name))
}

/** Every combination for one page, in a stable order. */
export function targetsFor(page: string): CaptureTarget[] {
  const targets: CaptureTarget[] = []
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const direction of DIRECTIONS) {
        targets.push({ page, viewport, theme, direction })
      }
    }
  }
  return targets
}
