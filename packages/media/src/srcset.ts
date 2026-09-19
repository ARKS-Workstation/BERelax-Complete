/**
 * The `srcset` builder: one function, two consumers, one string.
 *
 * The production `<picture>` and the admin's breakpoint preview both have to answer the same question —
 * "which files may the browser choose between for this media id?" — and the whole point of a preview is
 * that the answer is *the same answer*. Two builders that agree today is the arrangement where an editor
 * approves a crop the site never serves: the preview shows the 4:5 ladder, the component ships the 16:9
 * one, and nothing anywhere fails. So there is one builder, it lives here, and
 * `apps/web/src/breakpoint-preview.itest.ts` asserts the two rendered `srcset` attributes are equal
 * string for string, with a lookalike as the control.
 *
 * Pure string work over `ladders.ts` and `url.ts`. No `sharp`, no `node:*`, no I/O — the production
 * component renders on the server and the preview's own markup is assembled in a route handler, and
 * neither may drag libvips into a bundle.
 *
 * ## Why `w` descriptors and not `x`
 *
 * A `srcset` of `1x/2x` says "this is the same image at two densities" and forces the browser to decide
 * from the device alone. `w` descriptors plus `sizes` let it decide from the *rendered* width, which is
 * the number that actually determines how many pixels are needed — and it is the only form that works
 * when the same component is 100vw on a phone and 480px in a three-column grid.
 *
 * ## Why the two crops are two `<source>` sets and not one
 *
 * Art direction (docs/08 §6): the phone gets a genuinely different photograph, cropped 4:5 around the
 * focal point, not the 16:9 frame squeezed. A single `srcset` cannot express that — the browser would be
 * free to pick a 16:9 rung on a phone. Each crop is offered under its own `media`, taken from
 * `CROPS[crop].media` rather than restated here, so the query the ladder declares and the query the
 * markup carries cannot drift.
 */
import { AppError } from '@berelax/shared'
import {
  CONTENT_TYPES,
  CROP_NAMES,
  CROPS,
  type CropName,
  type DerivativeFormat,
  FORMATS,
  heightFor,
} from './ladders.ts'
import { assertCroppedSlot, derivativePath, type MediaSlotName } from './url.ts'

/**
 * Everything a URL needs that is not the rung: the row, the content address, the slot.
 *
 * Deliberately the same three fields the derivative job produces, so a manifest read back out of the
 * bucket can be handed straight to this module without a translation step that could lose the hash.
 */
export interface DerivativeSetRef {
  readonly mediaId: string
  readonly contentHash: string
  readonly slot: string
}

/** One `<source>`: a crop, a format, and the set of files the browser may choose from. */
export interface PictureSource {
  readonly crop: CropName
  readonly format: DerivativeFormat
  /** The `type` attribute. From `CONTENT_TYPES`, so `jpg` cannot become `image/jpg`. */
  readonly type: string
  /** The `media` attribute, from the ladder's own declaration. */
  readonly media: string
  readonly srcset: string
  readonly sizes: string
}

/**
 * The default `sizes`.
 *
 * `100vw` because the two slots with a published byte budget — the hero and the testimonial background —
 * are full-bleed, and because it is the only default that is never *too small*: a `sizes` that
 * under-states the rendered width makes the browser choose a rung below the one it needs and the image
 * renders soft, which is the failure nobody files a bug about. A component in a grid passes its own.
 */
export const DEFAULT_SIZES = '100vw'

/**
 * The CSS widths the preview renders at.
 *
 * The seven in W-SYS-10's acceptance criterion, and they are not the same list as either ladder: they are
 * the widths real phones, tablets and laptops report, which is precisely why a preview is needed. 360 is
 * the narrowest Android still sold, 390 the iPhone, 414 the Plus, 768 the tablet at the front desk, and
 * 1024/1440/1600 the laptops. Not one of them is a rung, so every one of them exercises the loader's
 * nearest-rung mapping rather than a lucky exact hit.
 */
export const PREVIEW_CSS_WIDTHS: readonly number[] = [360, 390, 414, 768, 1024, 1440, 1600]

/** The `min-width`/`max-width` in a crop's declared media query, in px. */
function mediaBound(crop: CropName): { readonly kind: 'min' | 'max'; readonly px: number } {
  const query = CROPS[crop].media
  const match = /\((min|max)-width:\s*(\d+)px\)/.exec(query)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    // Unreachable while the ladders declare the two queries they declare, and here because this module
    // resolves a CSS width to a crop by *reading* those queries. A ladder whose media query this cannot
    // parse would silently send every width to one crop, which is art direction switched off.
    throw new AppError(
      'invariant_violated',
      `[unparseable-crop-media-query] crop '${crop}' declares '${query}', which is not a single ` +
        'min-width or max-width bound in px',
      { details: { crop, media: query } },
    )
  }
  return { kind: match[1] === 'min' ? 'min' : 'max', px: Number.parseInt(match[2], 10) }
}

/**
 * Which crop a viewport of this CSS width is served from.
 *
 * Decided by evaluating the ladders' own media queries, not by comparing against 768 written here. The
 * breakpoint appears once, in `CROPS`, and this is the reader.
 */
export function cropForViewportWidth(cssWidth: number): CropName {
  if (!Number.isFinite(cssWidth) || cssWidth <= 0) {
    throw new AppError(
      'validation',
      `[invalid-viewport-width] ${String(cssWidth)} is not a positive CSS width`,
      { details: { cssWidth } },
    )
  }
  for (const crop of CROP_NAMES) {
    const bound = mediaBound(crop)
    if (bound.kind === 'max' ? cssWidth <= bound.px : cssWidth >= bound.px) return crop
  }
  throw new AppError(
    'invariant_violated',
    `[no-crop-serves-viewport-width] no declared crop's media query matches ${cssWidth}px`,
    { details: { cssWidth } },
  )
}

export interface ResolvedRung {
  readonly crop: CropName
  /** The rung the browser will request: a declared width, never the requested one. */
  readonly width: number
  readonly height: number
}

/**
 * The rung a browser selects out of the `srcset` for a slot rendered at this CSS width.
 *
 * **This is deliberately not `nearestRung`, and the difference is not a rounding preference.** The two
 * functions answer different questions. `nearestRung` — the `next/image` loader's rule — maps an
 * *arbitrary* requested width onto an object that happens to exist, and rounds to whichever rung is closest
 * because the alternative is a 404. Here every candidate in the `srcset` already exists, and the choice is
 * the browser's: HTML's selection algorithm takes the **narrowest candidate whose width is at least the
 * width needed**, so a slot rendered at 1600 CSS px is served the 1920 rung, while `nearestRung` would say
 * 1440. A preview built on `nearestRung` would therefore print 1440 and report its byte count while the
 * browser downloaded 1920 — a weight report that is wrong on exactly the widest, heaviest screens.
 *
 * `apps/web/src/breakpoint-preview.itest.ts` asserts this against `HTMLImageElement.currentSrc` in a real
 * Chromium at every one of the seven widths, which is the only way to know the rule is the browser's rather
 * than this module's opinion of it.
 *
 * The widest rung is the floor: above it there is nothing else to serve, and an upscale in the browser is
 * the correct and only answer.
 */
export function selectedRungFor(cssWidth: number, dpr = 1): ResolvedRung {
  const crop = cropForViewportWidth(cssWidth)
  const needed = cssWidth * dpr
  const widths = CROPS[crop].widths
  const widest = widths.at(-1)
  if (widest === undefined) {
    throw new AppError('invariant_violated', `[crop-declares-no-widths] '${crop}' has no rungs`)
  }
  const width = widths.find((candidate) => candidate >= needed) ?? widest
  return { crop, width, height: heightFor(crop, width) }
}

/**
 * The `srcset` for one crop in one format: every rung of that ladder, ascending, with `w` descriptors.
 *
 * Every rung, and not only the ones a particular layout would ask for. A `srcset` is the *set the
 * browser may choose from*; narrowing it to the widths one page happens to render at is how a retina
 * tablet ends up with the phone rung, and the omission is invisible because the image still appears.
 */
export function srcsetFor(ref: DerivativeSetRef, crop: CropName, format: DerivativeFormat): string {
  const slot = assertCroppedSlot(ref.slot)
  return CROPS[crop].widths
    .map(
      (width) =>
        `${derivativePath({
          mediaId: ref.mediaId,
          contentHash: ref.contentHash,
          slot,
          crop,
          width,
          format,
        })} ${width}w`,
    )
    .join(', ')
}

/**
 * Every `<source>` a `<picture>` needs, in the order a browser resolves them.
 *
 * Crop first, then format best-first. The two `media` queries are mutually exclusive, so within a crop
 * the browser takes the first `type` it supports — AVIF, then WebP, then JPEG. Getting the order wrong
 * does not break anything visibly: it serves JPEG to a browser that would have taken AVIF, and the only
 * symptom is the page being three times heavier than the budget says.
 */
export function pictureSourcesFor(
  ref: DerivativeSetRef,
  sizes: string = DEFAULT_SIZES,
): readonly PictureSource[] {
  const sources: PictureSource[] = []
  for (const crop of CROP_NAMES) {
    for (const format of FORMATS) {
      sources.push({
        crop,
        format,
        type: CONTENT_TYPES[format],
        media: CROPS[crop].media,
        srcset: srcsetFor(ref, crop, format),
        sizes,
      })
    }
  }
  return sources
}

/**
 * The `<img>` inside the `<picture>`: the narrowest desktop JPEG.
 *
 * `<img>` is not a fallback image, it is the element that renders — every `<source>` only overrides its
 * `src`. It has to be a format every browser decodes, so JPEG; and the narrowest *desktop* rung rather
 * than the narrowest mobile one because a browser old enough to ignore `<picture>` is being handed a
 * single file for every screen, and the 16:9 frame is the one the photograph was composed as.
 */
export function fallbackSrcFor(ref: DerivativeSetRef): string {
  const slot = assertCroppedSlot(ref.slot)
  const crop: CropName = 'desktop'
  const width = CROPS[crop].widths[0]
  if (width === undefined) {
    throw new AppError('invariant_violated', `[crop-declares-no-widths] '${crop}' has no rungs`)
  }
  return derivativePath({
    mediaId: ref.mediaId,
    contentHash: ref.contentHash,
    slot,
    crop,
    width,
    format: 'jpg',
  })
}

/** The intrinsic size of the `<img>`, so the box is reserved before the bytes arrive (docs/08 §8). */
export function fallbackDimensions(): { readonly width: number; readonly height: number } {
  const crop: CropName = 'desktop'
  const width = CROPS[crop].widths[0]
  if (width === undefined) {
    throw new AppError('invariant_violated', `[crop-declares-no-widths] '${crop}' has no rungs`)
  }
  return { width, height: heightFor(crop, width) }
}

/** The slot a ref names, refusing one that has no ladder. Re-exported so callers need one import. */
export function slotOf(ref: DerivativeSetRef): MediaSlotName {
  return assertCroppedSlot(ref.slot)
}
