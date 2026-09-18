import { robotsResponse } from '../../src/facts/handlers.ts'

/**
 * `GET /robots.txt` — the crawl policy, with the AI crawlers explicitly allowed (docs/09 §"LLM SEO").
 *
 * A route handler rather than `app/robots.ts`. Next's metadata convention would work and is refused here for
 * one reason: it takes a `MetadataRoute.Robots` object, which can express `userAgent`, `allow`, `disallow`
 * and `sitemap` and **cannot** express the thing this policy turns on — that a named user-agent group
 * *replaces* the wildcard group rather than adding to it, so every group has to carry the whole policy. The
 * builder in `src/facts/robots.ts` writes the groups out and its test asserts each one is complete.
 *
 * It reads no database; see `robotsResponse`.
 */
export const dynamic = 'force-dynamic'

export function GET(): Response {
  return robotsResponse()
}
