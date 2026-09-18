/**
 * The `next/image` loader: a requested width becomes the nearest rung that actually exists.
 *
 * DigitalOcean Spaces has no image transformation (docs/08 §6), so there is no origin that can answer
 * "give me this at 719px". Every width that will ever be served was encoded by the derivative job, and
 * this function is the mapping from what a layout asks for to what the bucket holds. It runs in the
 * browser as well as on the server, so it carries no `sharp`, no `node:*` and no filesystem — which is
 * why the ladders live in their own module.
 *
 * **It refuses a `src` it does not recognise rather than passing it through.** A loader that returned an
 * unknown URL unchanged is how a full-resolution original, or a raw Spaces CDN hostname, reaches an
 * `<img>` in production: nothing rejects it, the image renders, and the only symptom is a slow page and
 * a public URL for a photograph whose consent is not on record (`Y12-consent-photo`). Every image on this
 * site comes out of the derivative pipeline; anything else is a mistake worth a build failure.
 */
import { AppError } from '@berelax/shared'
import { type CropName, nearestRung } from './ladders.ts'
import { derivativePath, parseDerivativePath } from './url.ts'

export interface ImageLoaderArgs {
  readonly src: string
  readonly width: number
  /**
   * Ignored, deliberately.
   *
   * `next/image` always passes one, and there is nothing this loader could do with it: the encoder
   * settings are fixed at build time (docs/08 §6) and the URL is addressed by the source bytes, so two
   * qualities at one width would be two URLs the job never produced. Honouring it would need a transform
   * service the MVP does not have — the P2 Cloudflare Images option in docs/08 §6.
   */
  readonly quality?: number
}

/** The widest width a layout may ask for. Above the widest desktop rung there is nothing to serve. */
export const MAX_REQUESTED_WIDTH = 3000

export function mediaImageLoader({ src, width }: ImageLoaderArgs): string {
  const ref = parseDerivativePath(src)
  if (ref === undefined) {
    throw new AppError(
      'validation',
      `[loader-src-not-a-derivative] '${src}' is not a content-addressed derivative path. Every image ` +
        'on this site is built by the derivative job; nothing else may be handed to next/image.',
      { details: { src } },
    )
  }
  if (!Number.isInteger(width) || width < 1 || width > MAX_REQUESTED_WIDTH) {
    throw new AppError(
      'validation',
      `[loader-width-out-of-range] ${width} is not a requested width in 1..${MAX_REQUESTED_WIDTH}`,
      { details: { src, width } },
    )
  }
  return derivativePath({ ...ref, width: nearestRung(ref.crop, width) })
}

/** The rung a crop would serve a requested width from. Exported for the `sizes`/`srcset` builder. */
export function servedWidth(crop: CropName, requestedWidth: number): number {
  return nearestRung(crop, requestedWidth)
}
