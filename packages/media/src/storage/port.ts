/**
 * The media storage port: two buckets, and the headers a derivative is served with.
 *
 * ADR 0022 and docs/12 §1 set the shape. This interface is the one the real DigitalOcean Spaces adapter
 * will implement — it is not shaped around the fake — which is what stops the real integration being a
 * rewrite. `put` returns a verified receipt rather than `void` for the same reason: docs/12 §1 forbids a
 * stub that looks like it works, and an adapter whose `put` returns nothing cannot tell anybody whether
 * it wrote.
 *
 * **Two buckets, and the split is a security boundary, not an organisational one** (docs/08 §6).
 * `private` holds originals, video masters and signed consent PDFs: no CDN, no public read. `public`
 * holds derivatives only. The reason it matters here is the therapist portraits — nineteen photographs
 * of real employees whose photography consent is not yet on record (`Y12-consent-photo`). An original
 * that reached a public bucket would be a full-resolution photograph of a named employee on a CDN, and
 * nothing would ever tell us it had happened.
 *
 * **Derivatives are served same-origin.** Never `*.cdn.digitaloceanspaces.com` in a URL: a third-party
 * origin costs a DNS lookup, a TCP handshake and a TLS handshake before the first byte of the LCP image,
 * which is the whole requests-to-LCP budget in docs/08 §8. `scripts/check-media.mjs`
 * (`[no-private-origin-url]`) fails the build on either spelling appearing in source.
 */
import { AppError } from '@berelax/shared'
import { CONTENT_TYPES } from '../ladders.ts'
import { parseDerivativePath } from '../url.ts'

export type MediaBucket = 'private' | 'public'

export const MEDIA_BUCKETS: readonly MediaBucket[] = ['private', 'public']

/**
 * One year, immutable. Safe only because the URL carries the content hash of the source bytes.
 *
 * `immutable` is the load-bearing token: without it a browser still revalidates on reload, and the
 * hero photograph costs a round trip on every hard refresh. With it — and with a content-addressed
 * path, so a changed photograph is a changed URL — there is nothing to revalidate and nothing to purge.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** Originals are never cached by anything. They are never served to a browser at all. */
export const PRIVATE_CACHE_CONTROL = 'private, no-store'

export interface PutRequest {
  readonly bucket: MediaBucket
  /** Key within the bucket, no leading slash. */
  readonly key: string
  readonly body: Uint8Array
  readonly contentType: string
  readonly cacheControl: string
}

export interface StoredObject {
  readonly bucket: MediaBucket
  readonly key: string
  readonly bytes: number
  /** The full sha256 of the stored bytes, as read back. */
  readonly sha256: string
  readonly contentType: string
  readonly cacheControl: string
}

export interface MediaStorage {
  /** Which adapter this is. Surfaced so an admin screen can say so rather than imply a real bucket. */
  readonly kind: 'fake' | 'spaces'
  /**
   * Where a fake adapter's writes are visible on disk, so a put can be looked at.
   *
   * `undefined` for a real adapter. docs/12 §1: a fake sends to a local outbox that is visible; it does
   * not pretend to have uploaded.
   */
  readonly outbox: string | undefined
  put(request: PutRequest): Promise<StoredObject>
  head(location: { bucket: MediaBucket; key: string }): Promise<StoredObject | undefined>
  get(location: { bucket: MediaBucket; key: string }): Promise<Uint8Array>
  list(bucket: MediaBucket): Promise<readonly string[]>
}

/** The public-bucket key for a derivative URL path: the same string without its leading slash. */
export function publicKeyFor(derivativePathname: string): string {
  return derivativePathname.replace(/^\//, '')
}

export interface ServedHeaders {
  readonly 'content-type': string
  readonly 'cache-control': string
}

/**
 * The response headers a derivative is served with.
 *
 * Refuses anything that is not a derivative path. A year of `immutable` on a URL that is not content-
 * addressed is unfixable by deploying: every cache that saw it keeps the old bytes until it expires,
 * and there is no purge for a browser cache.
 */
export function derivativeHeaders(derivativePathname: string): ServedHeaders {
  const ref = parseDerivativePath(derivativePathname)
  if (ref === undefined) {
    throw new AppError(
      'invariant_violated',
      `[not-an-immutable-path] '${derivativePathname}' is not a content-addressed derivative path, so ` +
        'it must not be served with a year of immutable caching',
      { details: { path: derivativePathname } },
    )
  }
  return { 'content-type': CONTENT_TYPES[ref.format], 'cache-control': IMMUTABLE_CACHE_CONTROL }
}
