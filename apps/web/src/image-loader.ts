/**
 * The custom `next/image` loader, wired in `next.config.ts` as `images.loaderFile`.
 *
 * Next requires a module with a default export at a path it can resolve, so this file exists to be that
 * module. The mapping itself lives in `@berelax/media/loader` — the sharp-free half of the media package
 * — because the loader and the derivative job have to agree on the ladder, and two copies of a list of
 * widths is one copy that will be wrong. A rung the loader requests and the job never built is a 404
 * inside a `srcset`, which the browser resolves by rendering nothing.
 */
import { type ImageLoaderArgs, mediaImageLoader } from '@berelax/media/loader'

export default function imageLoader(args: ImageLoaderArgs): string {
  return mediaImageLoader(args)
}
