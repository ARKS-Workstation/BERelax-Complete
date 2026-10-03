import { sitemapIndexXml } from '@berelax/core'
import { factsRuntime } from '../../src/facts/runtime.ts'
import { buildSitemaps } from '../../src/sitemap/build.ts'

/**
 * `GET /sitemap.xml` — the sitemap INDEX, not a sitemap.
 *
 * A route handler rather than Next's `app/sitemap.ts` metadata convention, for the reason
 * `robots.txt/route.ts` gives about its own: the convention takes a `MetadataRoute.Sitemap` array, which
 * can express `url`, `lastModified`, `changeFrequency` and `alternates.languages` — and **cannot express a
 * sitemap index at all.** An index is the shape this site needs: four sections whose contents are decided
 * by different rows, so a crawler can re-fetch the treatments and leave the pages alone.
 *
 * `robots.txt` advertises this path, and only once the registry declares a route at it — "the registry
 * knows that path" and "something serves it" are the same statement, because the registry is in exact
 * bijection with the filesystem. So this file landing is what turns the `Sitemap:` line on.
 *
 * ## Why it is dynamic and uncached by the framework
 *
 * The index's `lastmod` per section is the newest instant the rows in it carry, so a prerendered index is
 * one that stops moving when a price does — and `lastmod` that does not move when the content did is the
 * one failure a crawler acts on by not coming back. `cache-control` is an hour, which is a crawler's own
 * re-read interval rather than a guess: it costs two reads per hour and keeps the answer live.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const { sections } = await buildSitemaps(factsRuntime().sql, new Date().toISOString())
  return new Response(sitemapIndexXml(sections), {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}
