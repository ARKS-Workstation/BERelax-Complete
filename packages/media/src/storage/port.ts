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

/**
 * What an adapter is asked to authorise: one object, for one document, until one instant.
 *
 * `documentId` and `documentClass` rather than the key alone, and the reason is the whole shape of
 * W-SYS-14: the thing a reader is authorised for is a DOCUMENT the register knows about, not a path into a
 * bucket. A signature over the storage key would be a signature over a private-bucket path, which is the
 * one string that must never travel in a URL — `scripts/check-media.mjs` already refuses a private origin
 * appearing in source, and a signed key in a query string would put one in a link instead.
 */
export interface SignRequest {
  readonly bucket: MediaBucket
  /** Key within the bucket, no leading slash. Checked to exist: a signed 404 is not an authorisation. */
  readonly key: string
  readonly documentId: string
  readonly documentClass: string
  /** Seconds since the epoch. Whole and positive; the signer refuses anything else. */
  readonly expiresAtEpochSeconds: number
}

/**
 * The authorisation an adapter minted: a query string, and the facts a caller has to record.
 *
 * No URL and no origin. The route that serves the document knows its own path and the signature is
 * detached, so an adapter that returned a whole URL would be an adapter deciding where this application
 * serves documents from.
 */
export interface SignedObjectQuery {
  /** The query string, without a leading `?`. */
  readonly query: string
  /** The nonce a single-use fetch burns. The caller records it; nothing else can reconstruct it. */
  readonly nonce: string
  readonly keyVersion: string
  readonly expiresAtEpochSeconds: number
}

/**
 * Refuses a signing request that cannot mean what it says, before any adapter work.
 *
 * Two refusals, and neither is hypothetical. **A public object may not be signed**: the public bucket
 * holds content-addressed derivatives served with a year of `immutable`, so signing one is a claim that it
 * needs authorisation — and the first person to believe that claim would add a signature check to the
 * derivative origin and break every image on the site. **An expiry must be in the future at mint time**:
 * `now() - 1` is what an off-by-one in a caller's arithmetic produces, and a link that is dead when it is
 * minted reads on the screen as a link that is simply broken, which is M-VAT-11's finding about its grant
 * TTL restated here.
 */
export function assertSignable(request: SignRequest, nowEpochSeconds: number): void {
  if (request.bucket !== 'private') {
    throw new AppError(
      'invariant_violated',
      `[signing-a-public-object] ${request.bucket}/${request.key} is not in the private bucket, so a ` +
        'signature over it authorises nothing: the public bucket is content-addressed and served with a ' +
        'year of immutable caching. Signing one would be a claim that derivatives need authorisation, ' +
        'and acting on that claim takes every image on the site offline.',
      { details: { bucket: request.bucket, key: request.key } },
    )
  }
  if (request.expiresAtEpochSeconds <= nowEpochSeconds) {
    throw new AppError(
      'validation',
      `[signing-an-expired-link] the requested expiry ${request.expiresAtEpochSeconds} is not after the ` +
        `current instant ${nowEpochSeconds}, so this link would be dead before it was handed over — ` +
        'which reads on the screen as a link that is simply broken rather than as one that has expired.',
      { details: { expiresAtEpochSeconds: request.expiresAtEpochSeconds, nowEpochSeconds } },
    )
  }
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
  /**
   * Mints a time-limited authorisation to fetch ONE private object as ONE document (W-SYS-14).
   *
   * ## Why the verb is here and not beside the route
   *
   * Every other capability this application has over a bucket is on this interface, and the one that
   * decides who may read an object is the one a reader would most expect to find somewhere else — which is
   * the argument for it being here. A route that reached past the port for its own signer would be a
   * second answer to "may this be fetched", and the second answer is the one that disagrees.
   *
   * ## What a real adapter does with it, and why it is NOT a presigned Spaces URL
   *
   * Spaces presigns the way S3 does, and such a URL can only be checked by the service holding the bucket
   * credential. That makes every refusal a third-party 403 with an XML body, so "this link expired" and
   * "somebody is guessing" become one fact — the distinction W-SYS-14 exists to keep. So the real adapter
   * implements this the same way the fake does: a detached HMAC this application verifies, over bytes it
   * then streams out of the bucket itself. The interface is therefore shaped around the DECISION and not
   * around a provider feature, which is what ADR 0022 means by not shaping a port around its fake.
   *
   * An adapter that cannot sign **throws** and names which of the two reasons it is: no key configured, or
   * a refusal armed for a test. It does not return a URL that will not work.
   */
  sign(request: SignRequest): Promise<SignedObjectQuery>
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
