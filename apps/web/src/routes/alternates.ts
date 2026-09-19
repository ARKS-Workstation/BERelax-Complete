/**
 * The canonical URL and the `hreflang` set for one route, in one locale.
 *
 * Every document declares three things about its own place in the URL space: which URL is canonical,
 * which URL serves the other locale, and which one a reader whose language we do not serve should get.
 * Google's rule for the second is the one that is usually broken: **the set must be reciprocal and
 * self-referential** — every page in a set lists every page in the set, *including itself*. A page that
 * lists only the other locale is ignored entirely, and the symptom is the Arabic page ranking for
 * English queries with no explanation.
 *
 * So the set is generated from the registry for both locales at once, and it cannot be lopsided:
 * `alternatesFor` builds one `languages` map per route and hands the same map to both documents, with
 * `canonical` the only thing that differs.
 *
 * The canonical URL is the **canonicalised** path — `canonicalPath` — and not the path as written. That
 * is the agreement the proxy exists for: if the registry declared `/kitchen-sink/` and the proxy
 * redirected `/kitchen-sink/` to `/kitchen-sink`, every page would announce a canonical URL that 301s,
 * which is the most confident way to tell a crawler to ignore what you said.
 */
import type { Metadata } from 'next'
import {
  DEFAULT_LOCALE,
  HREFLANG_DEFAULT,
  hreflangFor,
  type Locale,
  localisedPath,
} from '../i18n/locales.ts'
import { canonicalPath } from './canonical.ts'
import { fillParams, isParameterised, type RouteId, routeById } from './registry.ts'

/**
 * The origin the site is served from, when the environment does not say.
 *
 * `berelaxmassage.com` is the live domain (docs/13 §5): it is the one with the ranking category pages
 * and the inbound links, and the relaunch takes it over rather than moving to a new name — moving would
 * throw away the only SEO asset this business already has. It is a fallback rather than a constant
 * because a preview deployment that announced this origin as canonical would ask Google to index
 * production copies of unreviewed pages.
 */
export const SITE_ORIGIN_FALLBACK = 'https://berelaxmassage.com'

/** The environment variable that overrides it. Read at render time, so a build can be promoted. */
export const SITE_ORIGIN_ENV = 'SITE_ORIGIN'

/**
 * The origin, validated.
 *
 * It throws rather than falling back on a malformed value, for the reason `@berelax/config` gives: a
 * canonical URL built from `https:/berelax` is not a smaller problem than no canonical URL, it is the
 * same problem with nothing to alert on. Statically rendered routes read this at build, so a typo fails
 * the build — which is where it should surface.
 */
export function siteOrigin(): string {
  const configured = process.env[SITE_ORIGIN_ENV]
  if (configured === undefined || configured.trim() === '') return SITE_ORIGIN_FALLBACK
  const trimmed = configured.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${SITE_ORIGIN_ENV} is not an absolute URL: '${configured}'`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${SITE_ORIGIN_ENV} must be http or https: '${configured}'`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`${SITE_ORIGIN_ENV} must be an origin with no path: '${configured}'`)
  }
  return `${url.protocol}//${url.host}`
}

/**
 * An absolute URL for a path.
 *
 * Absolute because `hreflang` requires it — a relative `href` on an alternate link is ignored by
 * Google — and because the same builders feed JSON-LD and the sitemap, where a relative URL is
 * meaningless.
 */
export function absoluteUrl(path: string): string {
  return `${siteOrigin()}${canonicalPath(path)}`
}

export interface RouteAlternates {
  readonly canonical: string
  /** Keyed by `hreflang` value: one entry per locale, plus `x-default`. */
  readonly languages: Readonly<Record<string, string>>
}

/**
 * The canonical URL and the complete, reciprocal `hreflang` set for one document.
 *
 * Built from the route's own `locales`, so a route served in one locale gets a set of one plus
 * `x-default` rather than an alternate pointing at a 404 — the failure that makes a whole set invalid.
 */
export function alternatesFor(
  id: RouteId,
  locale: Locale,
  params: Readonly<Record<string, string>> = {},
): RouteAlternates {
  const route = routeById(id)
  if (route.kind !== 'document') {
    throw new Error(`Route '${id}' is a ${route.kind}, which has no canonical URL or hreflang set`)
  }
  // The params are substituted before anything is published, and `fillParams` throws on a segment nobody
  // filled. A treatment page that forgot to pass its slug would otherwise announce
  // `https://…/treatments/[slug]` as canonical — in the `<head>` of all eight pages, each one telling
  // every crawler to index a URL that 404s, and nothing on the page would look wrong.
  const urlOf = (served: Locale): string =>
    absoluteUrl(fillParams(localisedPath(route.path, served), params))
  const languages: Record<string, string> = {}
  for (const served of route.locales) {
    languages[hreflangFor(served)] = urlOf(served)
  }
  // x-default is the default locale's document, not a third URL: it answers "no language matched",
  // and pointing it at a language selector nobody built would be a redirect loop with extra steps.
  const fallback = route.locales.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : route.locales[0]
  if (fallback !== undefined) {
    languages[HREFLANG_DEFAULT] = urlOf(fallback)
  }
  return { canonical: urlOf(locale), languages }
}

/**
 * The metadata every registry document exports.
 *
 * Spread into the page's own `metadata` so the title and description stay where the copy is. The robots
 * directive is here rather than on the page for the same reason the header is derived from the registry:
 * `indexable: false` is declared once, and a page cannot forget to restate it.
 */
export function routeMetadata(
  id: RouteId,
  locale: Locale,
  params: Readonly<Record<string, string>> = {},
): Metadata {
  const route = routeById(id)
  if (isParameterised(route.path) && Object.keys(params).length === 0) {
    throw new Error(
      `Route '${id}' has a dynamic segment, so its metadata needs the params of the page being ` +
        'rendered. Without them the canonical URL and every hreflang alternate would name the pattern.',
    )
  }
  const alternates = alternatesFor(id, locale, params)
  if (route.indexable) return { alternates }
  return { alternates, robots: { index: false, follow: false } }
}
