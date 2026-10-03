/**
 * Which URLs belong in which sitemap section, assembled from the registry and the rows.
 *
 * `packages/core/src/seo/sitemap.ts` owns the BYTES and every rule about them; this owns the content,
 * because the content is a question about the catalogue, the roster and the CMS and `packages/core` may
 * not read a database. The split is the one `sitemapEntries()` and `treatmentSitemapEntries()` already
 * draw.
 *
 * ## Four sections, and two of them are legitimately absent today
 *
 *   - **pages** — every registry route whose path is a literal and whose entry says `sitemap: true`.
 *     Non-indexable routes, handlers, the admin estate and `/analytics` are absent **by construction**:
 *     `sitemapEntries()` filters on `route.sitemap`, and `registry.test.ts` asserts no non-indexable route
 *     is in it. There is no second filter here to forget, which is the whole reason the registry exists.
 *   - **treatments** — the catalogue's own expansion, `treatmentSitemapEntries`, whose `lastmod` comes
 *     from the service, its variants and the price list in force.
 *   - **therapists** — the roster's, `therapistSitemapEntries`, which applies ADR 0020's guard. **Empty
 *     today**, so the section is left out of the index entirely rather than served as an empty
 *     `<urlset>`: an empty urlset is a positive statement that those pages have gone, and a crawler acts
 *     on it by dropping the ones it knows about.
 *   - **journal** — the CMS's published posts, and empty for the same shape of reason: a post needs an
 *     author byline and a reviewer byline (W-SITE-07) and this build invents neither.
 *
 * ## Why `hreflang` comes from `alternatesFor` and not from a second builder
 *
 * The acceptance criterion is that the sitemap's `hreflang` entries are reciprocal **with the page-level
 * tags**, for every route in both locales. Two builders would be two answers, and the cross-check would
 * then be a test of whether somebody had kept them in step. One builder makes the agreement structural;
 * `public-site.itest.ts` still asserts it over the served bytes, because the registry entry and the
 * rendered `<head>` are two different programs.
 */
import {
  ASIA_DUBAI,
  lastmodFor,
  SITEMAP_TYPES,
  type SitemapSection,
  type SitemapType,
  type SitemapUrl,
  offsetMinutes as zoneOffsetMinutes,
} from '@berelax/core'
import type { Sql } from '@berelax/db'
import { readTherapistPages } from '@berelax/db'
import type { Locale } from '../i18n/locales.ts'
import { absoluteUrl, alternatesFor } from '../routes/alternates.ts'
import { type RouteId, sitemapEntries } from '../routes/registry.ts'
import { therapistSitemapEntries } from '../therapists/sitemap.ts'
import { treatmentSitemapEntries } from '../treatments/sitemap.ts'

/** Where the index is served. One spelling, read by the index route, the section route and robots.txt. */
export const SITEMAP_INDEX_PATH = '/sitemap.xml'

/** Where one section is served. */
export const sitemapSectionPath = (type: SitemapType): string => `/sitemaps/${type}`

/**
 * The Asia/Dubai offset at one instant, from `@berelax/core`.
 *
 * Read per instant rather than written as `+04:00`, because ADR 0007's rule is that the zone is always an
 * argument and a fixed offset is the thing that is wrong the first time a zone acquires a rule. The UAE
 * has no daylight saving today, so every `lastmod` carries `+04:00` — as an OUTPUT of the zone rather
 * than an assumption baked into a format string.
 */
export function dubaiOffsetAt(iso: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new Error(`'${iso}' is not an instant a sitemap <lastmod> can be dated from`)
  }
  return zoneOffsetMinutes(ms as never, ASIA_DUBAI)
}

/** One `<url>` from a registry id, a locale, the params of the page and its `lastmod`. */
function urlFor(
  id: RouteId,
  locale: Locale,
  params: Readonly<Record<string, string>>,
  path: string,
  lastmodIso: string,
  changefreq: SitemapUrl['changefreq'],
): SitemapUrl {
  return {
    loc: absoluteUrl(path),
    lastmod: lastmodFor(lastmodIso, dubaiOffsetAt(lastmodIso)),
    changefreq,
    // The SAME function the `<head>` uses. See the module header.
    alternates: alternatesFor(id, locale, params).languages,
  }
}

/**
 * The `pages` section.
 *
 * `generatedAtIso` is the `lastmod` for every entry, and that is the honest answer rather than a
 * shortcut: the only thing that changes the markup of `/faq`, `/about` or `/contact` is a deploy or a
 * revalidation, and neither leaves a row-level instant behind. Where a row DOES decide the content — a
 * treatment, a therapist — the entry is in that row's own section with the row's own instant.
 */
export function pageSitemapUrls(generatedAtIso: string): readonly SitemapUrl[] {
  return sitemapEntries().map((entry) =>
    urlFor(entry.id, entry.locale, {}, entry.path, generatedAtIso, entry.changefreq),
  )
}

/** Every section's URLs, keyed by type. A section with no URLs stays in the map and out of the index. */
export type SitemapUrlsByType = Readonly<Record<SitemapType, readonly SitemapUrl[]>>

export interface SitemapSections {
  /** Only the sections that hold at least one URL, in `SITEMAP_TYPES` order. */
  readonly sections: readonly SitemapSection[]
  readonly urlsByType: SitemapUrlsByType
}

/** The newest `lastmod` in a set, as an ISO instant, or the build's instant for an empty set. */
function newestIso(instants: readonly string[], fallbackIso: string): string {
  if (instants.length === 0) return fallbackIso
  return instants.reduce((newest, candidate) =>
    Date.parse(candidate) > Date.parse(newest) ? candidate : newest,
  )
}

/**
 * Every section, built from the rows.
 *
 * `journal` is an empty array and the emptiness is the DATA rather than a stub: W-SITE-07's
 * `journal_posts` collection publishes nothing, because a post needs an author byline and a reviewer
 * byline and this build invents neither (brief rule 10). The day one is published this function grows a
 * read; nothing else changes, because the index already leaves an empty section out.
 */
export async function buildSitemaps(sql: Sql, generatedAtIso: string): Promise<SitemapSections> {
  const [treatments, therapistRows] = await Promise.all([
    treatmentSitemapEntries(sql),
    readTherapistPages(sql),
  ])
  const therapists = therapistSitemapEntries(therapistRows)
  const urlsByType: SitemapUrlsByType = {
    pages: pageSitemapUrls(generatedAtIso),
    treatments: treatments.map((entry) =>
      urlFor(
        'treatment',
        entry.locale,
        { slug: entry.slug },
        entry.path,
        entry.lastModified,
        entry.changefreq,
      ),
    ),
    therapists: therapists.map((entry) =>
      urlFor(
        'therapist',
        entry.locale,
        { slug: entry.slug },
        entry.path,
        entry.lastModified,
        entry.changefreq,
      ),
    ),
    journal: [],
  }
  /*
    The section's own `lastmod` is the NEWEST of the instants its rows carry — not the build's instant,
    which is the shortcut that makes the index useless. A crawler reads the index to decide which sections
    to fetch at all, so an index whose every section is dated "now" asks it to re-fetch the whole site on
    every deploy, and an index whose sections never move asks it to fetch nothing after a price change.
    `pages` is the one section legitimately dated by the build: nothing but a deploy changes its markup.
  */
  const newestByType: Readonly<Record<SitemapType, string>> = {
    pages: generatedAtIso,
    treatments: newestIso(
      treatments.map((entry) => entry.lastModified),
      generatedAtIso,
    ),
    therapists: newestIso(
      therapists.map((entry) => entry.lastModified),
      generatedAtIso,
    ),
    journal: generatedAtIso,
  }
  const sections: SitemapSection[] = []
  for (const type of SITEMAP_TYPES) {
    const urls = urlsByType[type]
    if (urls.length === 0) continue
    const newest = newestByType[type]
    sections.push({
      type,
      loc: absoluteUrl(sitemapSectionPath(type)),
      lastmod: lastmodFor(newest, dubaiOffsetAt(newest)),
      urlCount: urls.length,
    })
  }
  return { sections, urlsByType }
}
