import { isSitemapType, sitemapXml } from '@berelax/core'
import { factsRuntime } from '../../../src/facts/runtime.ts'
import { buildSitemaps } from '../../../src/sitemap/build.ts'

/**
 * `GET /sitemaps/<type>` — one section: `pages`, `treatments`, `therapists` or `journal`.
 *
 * ## Why a 404 for a section with no URLs, rather than an empty `<urlset>`
 *
 * An empty urlset is not "no information": it is a positive statement that there are no pages of this
 * kind, and a crawler acts on it by dropping the ones it already knows. Two of the four sections are
 * legitimately empty today — nobody is publishable (ADR 0020) and no journal post has its two bylines —
 * so those paths 404, the index does not list them, and the day a therapist is published both change
 * together with nothing to remember.
 *
 * A 404 is also what an unknown type gets. Not a redirect to the index and not an empty document: a
 * crawler following a guessed path should learn the path is wrong.
 *
 * ## Why the whole set is built to serve one section
 *
 * `buildSitemaps` reads the catalogue and the roster, which are two queries over small tables, and
 * building one section in isolation would mean a second function deciding what belongs in it — the exact
 * duplication the `lastmod` of the index is already derived from. One builder, four readers.
 */
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly type: string }> },
): Promise<Response> {
  const { type } = await context.params
  if (!isSitemapType(type)) return new Response('Not found', { status: 404 })
  const { urlsByType } = await buildSitemaps(factsRuntime().sql, new Date().toISOString())
  const urls = urlsByType[type]
  if (urls.length === 0) return new Response('Not found', { status: 404 })
  return new Response(sitemapXml(urls), {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}
