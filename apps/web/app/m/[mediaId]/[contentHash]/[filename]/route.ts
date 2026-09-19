import { derivativeHeaders, publicKeyFor } from '@berelax/media/storage'
import { DERIVATIVE_PATH_PATTERN } from '@berelax/media/url'
import { isAppError } from '@berelax/shared'
import { appMediaStorage } from '../../../../../src/media/storage.ts'

/**
 * The derivative origin: `/m/{mediaId}/{contentHash}/{slot}-{crop}-{width}.{ext}`.
 *
 * **Derivatives are served same-origin.** That is not a preference — it is the sentence at the top of
 * `packages/media/src/storage/port.ts`, and the reason is the LCP image: a third-party origin costs a DNS
 * lookup, a TCP handshake and a TLS handshake before its first byte, which is most of docs/08 §8's
 * requests-to-LCP budget. `scripts/check-media.mjs` already fails the build on a `digitaloceanspaces.com`
 * hostname appearing in source, so there has to be a same-origin path that answers, and this is it.
 *
 * Until W-SYS-10 there was none. Every derivative URL the pipeline produced was a path nothing served, so
 * the breakpoint preview would have shown an editor a page of broken images and called it a preview.
 *
 * ## What it does not do
 *
 * It does not transform, resize or re-encode. The path names an object that the derivative job either
 * built or did not, and a 404 is the honest answer for the second case: inventing a rendition here would
 * mean the site served widths the `srcset` never promised, at whatever CPU cost, from the app server.
 *
 * It also does not read the private bucket. `publicKeyFor` takes the pathname of a *derivative* path and
 * `derivativeHeaders` refuses anything that is not one, so a request cannot walk out of the public bucket
 * — which matters because the private one holds full-resolution photographs of employees whose
 * photography consent is an open question (`Y12-consent-photo`).
 *
 * ## Caching
 *
 * `Cache-Control: public, max-age=31536000, immutable`, from `derivativeHeaders` rather than written here.
 * A year of `immutable` is safe only because the URL carries the sha256 of the source bytes: re-crop the
 * original and every derivative lands on a different path, so nothing has to be purged. The header and the
 * content address are one decision, and reading it from the production helper is what keeps them one.
 */
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { params: Promise<{ mediaId: string; contentHash: string; filename: string }> },
): Promise<Response> {
  const { mediaId, contentHash, filename } = await context.params
  const pathname = `/m/${mediaId}/${contentHash}/${filename}`

  // Validated against the pattern before the bucket is touched. `derivativeHeaders` would refuse it
  // anyway, but it throws — and a malformed URL is a 404, not a 500.
  if (!DERIVATIVE_PATH_PATTERN.test(pathname)) {
    return new Response('Not a derivative path\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  try {
    const storage = appMediaStorage()
    const key = publicKeyFor(pathname)
    const head = await storage.head({ bucket: 'public', key })
    if (head === undefined) {
      // Never cached. A 404 for an object the job has not built yet must not outlive the build.
      return new Response('No such derivative\n', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    const bytes = await storage.get({ bucket: 'public', key })
    return new Response(new Uint8Array(bytes), { headers: { ...derivativeHeaders(pathname) } })
  } catch (error) {
    // 503 and the named reason, rather than an empty 200 or a generic 500: the one configuration that
    // reaches here is `MEDIA_STORAGE=real` with no adapter, and "the image is missing" is not what has
    // gone wrong.
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The derivative could not be served: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
