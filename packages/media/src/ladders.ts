/**
 * The two art-directed ladders, the encoder settings, and nothing that needs a filesystem.
 *
 * This module is imported by the browser through the `next/image` loader, so it carries no `sharp`,
 * no `node:*` and no I/O. `derivatives.ts` is the half that encodes; this is the half that both ends
 * have to agree on. They cannot be two lists: a rung the loader asks for and the job never produced
 * is a 404 inside a `srcset`, which the browser resolves by silently showing nothing.
 *
 * docs/08 §6 fixes the numbers: `[414, 640, 828, 1080]` at 4:5 for phones, `[1024, 1440, 1920, 2560]`
 * at 16:9 for everything else, AVIF `q52/effort4/4:2:0`, WebP `q76`, JPEG `q80 mozjpeg`.
 */

/**
 * The two crops, named rather than inferred.
 *
 * Art direction is the point (docs/08 §6): a landscape hero CSS-cropped to a phone looks bad and
 * wastes about 40% of the pixels it downloads. So the phone gets a genuinely different photograph —
 * the same original, cropped 4:5 around its focal point — rather than the same file squeezed.
 */
export type CropName = 'mobile' | 'desktop'

export interface CropLadder {
  /** Target aspect ratio as [w, h]. The crop is taken at this ratio before any resize. */
  readonly ratio: readonly [number, number]
  /** Every width this crop is ever served at, ascending. Nothing outside this list is produced. */
  readonly widths: readonly number[]
  /** The CSS media query this crop is offered under, so `<picture>` and the ladder agree. */
  readonly media: string
}

export const CROPS: Readonly<Record<CropName, CropLadder>> = {
  mobile: { ratio: [4, 5], widths: [414, 640, 828, 1080], media: '(max-width: 767px)' },
  desktop: { ratio: [16, 9], widths: [1024, 1440, 1920, 2560], media: '(min-width: 768px)' },
}

export const CROP_NAMES: readonly CropName[] = ['mobile', 'desktop']

/** Output formats, widest support last. `jpg` and not `jpeg`: the URL pattern permits one spelling. */
export type DerivativeFormat = 'avif' | 'webp' | 'jpg'

export const FORMATS: readonly DerivativeFormat[] = ['avif', 'webp', 'jpg']

export const CONTENT_TYPES: Readonly<Record<DerivativeFormat, string>> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
}

/**
 * Encoder settings, exactly as docs/08 §6 states them.
 *
 * They are a single frozen constant rather than arguments with defaults because a derivative's URL is
 * content-addressed on the **source** bytes, not on the encode: change a quality here and every
 * already-published URL keeps its old bytes forever. So this is a decision to be made once and read
 * from one place, and `derivatives.itest.ts` asserts the values rather than trusting them.
 */
export const AVIF_OPTIONS = { quality: 52, effort: 4, chromaSubsampling: '4:2:0' } as const
export const WEBP_OPTIONS = { quality: 76 } as const
export const JPEG_OPTIONS = { quality: 80, mozjpeg: true } as const

/** Every (crop, width, format) triple a source is expanded into. 2 x 4 x 3 = 24. */
export interface RenditionSpec {
  readonly crop: CropName
  readonly width: number
  readonly height: number
  readonly format: DerivativeFormat
}

export function renditionSpecs(): readonly RenditionSpec[] {
  const specs: RenditionSpec[] = []
  for (const crop of CROP_NAMES) {
    const ladder = CROPS[crop]
    for (const width of ladder.widths) {
      for (const format of FORMATS) {
        specs.push({ crop, width, height: heightFor(crop, width), format })
      }
    }
  }
  return specs
}

/** The height a rung is served at. Derived from the ratio so a crop can never be off by a pixel. */
export function heightFor(crop: CropName, width: number): number {
  const [w, h] = CROPS[crop].ratio
  return Math.round((width * h) / w)
}

/**
 * The rung a requested width is served at: the nearest declared one, ties going to the larger.
 *
 * Nearest and not "the next one up". Rounding up from 1081 to a 2560 that does not exist in this
 * ladder would 404; rounding up inside the ladder would ship 1080 pixels to a 640px slot on every
 * device between the rungs, which is most of them. A tie goes up rather than down because the visible
 * failure of the two is the soft image, not the extra kilobyte.
 */
export function nearestRung(crop: CropName, requestedWidth: number): number {
  const widths = CROPS[crop].widths
  let best = widths[0]
  if (best === undefined) {
    throw new Error(`crop '${crop}' declares no widths`)
  }
  for (const width of widths) {
    const closer = Math.abs(width - requestedWidth) < Math.abs(best - requestedWidth)
    const tie = Math.abs(width - requestedWidth) === Math.abs(best - requestedWidth)
    if (closer || (tie && width > best)) best = width
  }
  return best
}

/** Whether a width is a rung of a crop's ladder. The guard against an undeclared derivative. */
export function isDeclaredWidth(crop: CropName, width: number): boolean {
  return CROPS[crop].widths.includes(width)
}

export interface CropRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * The crop window taken out of a source before it is resized.
 *
 * **Crop before resize, and around the declared focal point.** Both halves are load-bearing and both are
 * measured facts about this library rather than preferences. The nineteen staff portraits are full-length
 * shots whose native ratios run from 0.461 to 0.799, and the face sits in roughly the top fifth of the
 * frame; a 4:5 centre crop of those produces a row of torsos. `assets/media/README.md` says so, and
 * `scripts/check-media.mjs` already refuses an asset that crops without declaring where its subject is.
 *
 * The focal point is centred in the window and then the window is pushed back inside the frame, rather
 * than the focal point being placed proportionally. The difference shows at the edges: a subject at 16%
 * from the top wants the window flush with the top of the frame, and clamping gives exactly that, while
 * a proportional placement leaves a sliver of dead space above the head.
 */
export function cropRectFor(
  source: { readonly width: number; readonly height: number },
  crop: CropName,
  focal: { readonly x: number; readonly y: number },
): CropRect {
  const [rw, rh] = CROPS[crop].ratio
  const target = rw / rh
  let width = source.width
  let height = Math.round(source.width / target)
  if (height > source.height) {
    height = source.height
    width = Math.round(source.height * target)
  }
  const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max)
  return {
    left: clamp(Math.round((focal.x / 100) * source.width - width / 2), source.width - width),
    top: clamp(Math.round((focal.y / 100) * source.height - height / 2), source.height - height),
    width,
    height,
  }
}
