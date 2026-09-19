/**
 * The sitemap's catalogue half: one entry per published treatment, per locale, with a `lastmod` from the row.
 *
 * `sitemapEntries()` in the registry is the only source for a route whose path is a literal, and it skips a
 * parameterised one on purpose — `/treatments/[slug]` is a pattern, and a sitemap containing a pattern is a
 * sitemap naming a URL that 404s. This is the other half: the expansion, driven by
 * `parameterisedSitemapRoutes()` so that a second catalogue route added to the registry tomorrow arrives here
 * rather than being silently omitted.
 *
 * ## Why W-SITE-08 has not been pre-empted
 *
 * There is no `sitemap.xml` in this repository: the index and the per-type sitemaps are W-SITE-08's, and
 * `robotsResponse` already checks the registry before it publishes a `Sitemap:` line. What that unit needs
 * and could not have is the **content** of the treatment section, which only the catalogue knows. So this
 * produces the entries and nothing serves them yet, exactly as `sitemapEntries()` has since W-SITE-01 — and
 * the acceptance criterion "the sitemap contains exactly 8 treatment routes" is asserted against this
 * function, over the real rows, in `treatments.itest.ts`.
 *
 * ## Why `lastmod` comes from `updated_at` and not from the build
 *
 * A `lastmod` that moves on every deploy is one Google stops reading, and a `lastmod` that does not move when
 * a price does is worse than none: the page a crawler most needs to re-read is the one it is told has not
 * changed. `readTreatmentPages` derives it from the three rows that can change what the page says — the
 * service, its variants, and the `price_list` row in force — so a price change through the admin moves it and
 * a redeploy does not.
 */
import { readTreatmentPages, type Sql } from '@berelax/db'
import { LOCALES, type Locale, localisedPath } from '../i18n/locales.ts'
import {
  type ChangeFrequency,
  fillParams,
  parameterisedSitemapRoutes,
  type Route,
} from '../routes/registry.ts'

/** One sitemap entry for a catalogue-derived page. */
export interface TreatmentSitemapEntry {
  readonly path: string
  readonly locale: Locale
  readonly changefreq: ChangeFrequency
  /** ISO 8601, from the rows. What `<lastmod>` publishes. */
  readonly lastModified: string
  /** The catalogue slug, so a caller can group the locales of one page. */
  readonly slug: string
}

/**
 * The parameterised sitemap route the catalogue expands, or a throw.
 *
 * A throw rather than a filter: this module knows how to expand exactly one shape of route — a single
 * `[slug]` segment filled from the catalogue — and a registry that declared a second one would silently get
 * half a sitemap. The error names the route so the answer is "teach this function" rather than "wonder why
 * those pages are missing".
 */
function catalogueRoute(): Route {
  const routes = parameterisedSitemapRoutes()
  const route = routes.find((candidate) => candidate.path.endsWith('/[slug]'))
  if (routes.length !== 1 || route === undefined) {
    throw new Error(
      `The registry declares ${routes.length} parameterised sitemap route(s) (${routes
        .map((candidate) => candidate.path)
        .join(
          ', ',
        )}). This expander knows one: a treatment page keyed by slug. A route it does not know ` +
        'would be absent from every sitemap with nothing to say so.',
    )
  }
  return route
}

/**
 * Every treatment page, in every locale it is served in, with its `lastmod`.
 *
 * Eight rows today, sixteen entries: one route per treatment, two documents each. The count of *routes* is
 * what the acceptance criterion names, which is why `slug` is on the entry — the assertion is over distinct
 * slugs, and the locales are the same page in two languages, exactly as `/` and `/ar` are.
 */
export async function treatmentSitemapEntries(sql: Sql): Promise<readonly TreatmentSitemapEntry[]> {
  const route = catalogueRoute()
  const pages = await readTreatmentPages(sql)
  const entries: TreatmentSitemapEntry[] = []
  for (const page of pages) {
    for (const locale of LOCALES) {
      // The cast is the registry's literal types again: a handler's `locales` is the empty tuple, so the
      // union's `includes` accepts `never`. `parameterisedSitemapRoutes` only returns documents.
      if (!(route.locales as readonly Locale[]).includes(locale)) continue
      entries.push({
        path: fillParams(localisedPath(route.path, locale), { slug: page.slug }),
        locale,
        // Never defaulted: `parameterisedSitemapRoutes` returns only routes whose changefreq is set, and
        // the registry test asserts changefreq is non-null exactly when `sitemap` is true.
        changefreq: route.changefreq as ChangeFrequency,
        lastModified: page.lastModified,
        slug: page.slug,
      })
    }
  }
  return entries
}

/** The `lastmod` of one treatment page, for the publish loop's before/after comparison. */
export async function treatmentLastModified(sql: Sql, slug: string): Promise<string | undefined> {
  const pages = await readTreatmentPages(sql)
  return pages.find((page) => page.slug === slug)?.lastModified
}
