/**
 * The route registry: every route this application serves, declared once.
 *
 * Four things need the same list and must not each keep their own: the sitemap (W-SITE-08), the
 * `hreflang` set, the screenshot matrix (H04), and the `x-robots-tag` policy. Every one of them is a
 * list of routes with a property attached, and every separately maintained copy of such a list has the
 * same failure: a route is added, one list is updated, and the omission is invisible. A page missing
 * from the sitemap is not a build error. A page with no `hreflang` is not a build error. A page nobody
 * screenshots is not a build error. So the list lives here and
 * `apps/web/src/routes/registry.test.ts` asserts an exact bijection between these entries and the
 * routes on disk — which *is* a build error, in both directions.
 *
 * ## What is deliberately absent
 *
 * **The CMS.** `/admin` and `/cms-api` belong to W-SYS-08 and to `@berelax/cms`, which owns their
 * prefixes and their robots header (`next.config.ts`). The bijection test asserts `cmsRoutesIn` over
 * these paths is empty *and* skips them on the filesystem side, so the two halves cannot drift into
 * declaring the admin a public route.
 *
 * **Routes that do not exist yet.** docs/09 §1 lists eleven more — `/treatments`, `/therapists`,
 * `/spa`, `/book` and the rest — and each arrives with its own unit. An entry here for a route with no
 * file fails the bijection, which is the point: the registry describes what is served, not what is
 * planned.
 *
 * ## Why the path is the default locale's path
 *
 * One entry covers both documents of a route. `path` is written as the English URL and the Arabic URL is
 * derived by `localisedPath`, because a route that is declared once cannot have a prefix in one locale
 * and not the other — which is how `hreflang` sets end up non-reciprocal.
 */
import { CMS_ROBOTS_TAG, cmsRoutesIn } from '@berelax/cms'
import { LOCALES, type Locale, localisedPath } from '../i18n/locales.ts'

/** A document is a page with `<html>` around it; a handler is a `route.ts` that answers with bytes. */
export type RouteKind = 'document' | 'handler'

/**
 * How the route is produced.
 *
 * `static` is prerendered at build; `dynamic` is rendered per request. Not decoration: the registry's
 * claim is checked against `.next/prerender-manifest.json` — what the build actually produced — by
 * `route-spine.itest.ts`, so a page that quietly became dynamic because something read a header fails
 * a test rather than a page-speed report six weeks later. ISR is not in the union until a route uses
 * it; docs/09 §1 plans it for the catalogue pages, which are W-SITE-04's.
 */
export type RenderingMode = 'static' | 'dynamic'

/** `<changefreq>` in a sitemap. A hint, and the only one of the sitemap fields that is a judgement. */
export type ChangeFrequency =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never'

export interface RouteEntry {
  /** Stable, locale-independent, and the name a screenshot is filed under. */
  readonly id: string
  /** The path in the default locale, spelled exactly as the router resolves it, dynamic segments included. */
  readonly path: string
  readonly kind: RouteKind
  readonly rendering: RenderingMode
  /**
   * The locales this route is served in. Empty for a locale-neutral handler: an API endpoint has no
   * document, no direction and no font stack, and giving it a locale would give one endpoint two URLs.
   */
  readonly locales: readonly Locale[]
  /** False means every response carries `x-robots-tag` and the route is in no sitemap. */
  readonly indexable: boolean
  readonly sitemap: boolean
  /** Null exactly when `sitemap` is false — there is nothing for a changefreq to describe. */
  readonly changefreq: ChangeFrequency | null
  /** Why this route is in the registry with these properties. Read by nobody; read by everybody. */
  readonly why: string
}

/**
 * Every route, in path order.
 *
 * Sorted because two consumers read it as a sequence — the sitemap and the capture matrix — and an
 * unsorted source produces a sitemap whose diff is noise. `registry.test.ts` asserts the order.
 */
export const ROUTES = [
  {
    id: 'home',
    path: '/',
    kind: 'document',
    rendering: 'static',
    locales: LOCALES,
    indexable: true,
    sitemap: true,
    changefreq: 'weekly',
    why:
      'The home page, in both locales. Weekly rather than daily: the hero, the proof and the ' +
      'treatments overview change when the catalogue does, and claiming daily change on a page that ' +
      'does not change teaches a crawler to ignore the hint.',
  },
  {
    id: 'facts',
    path: '/api/facts',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: true,
    sitemap: false,
    changefreq: null,
    why:
      'W-SITE-02s canonical machine-readable fact sheet (docs/09 §4). Indexable, which reads oddly for ' +
      'JSON and is the decision: the whole point of the endpoint is that a crawler and an assistant may ' +
      'fetch and cite it, and `indexable: false` here would put `noindex` on the one response this site ' +
      'most wants quoted. Absent from the sitemap because a sitemap lists documents — this has no ' +
      '<html>, no hreflang and nothing for a changefreq to describe. Locale-neutral: one endpoint, one ' +
      'URL, and the payload carries both locales worth of nothing, because a fact has no language.',
  },
  {
    id: 'otp',
    path: '/api/v1/otp',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'B-LIFE-02s code request. Locale-neutral on purpose — the locale of the message is a field in ' +
      'the request body — and exempt from the proxy, because a 301 turns its POST into a GET.',
  },
  {
    id: 'kitchen-sink',
    path: '/kitchen-sink',
    kind: 'document',
    rendering: 'dynamic',
    locales: LOCALES,
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'W-SYS-02 and W-SYS-03s proving ground, in both locales because the RTL half of the ' +
      'twelve-render sweep has to be a real Arabic document. A development surface, so noindex and ' +
      'absent from every sitemap — but still in the registry, because it is a route, and a route the ' +
      'registry does not know about is the failure this file exists to prevent. Dynamic since ' +
      'W-SITE-02: it renders the NAP block from the premises row, and a statically prerendered copy ' +
      'would bake the address at build time — the staleness that unit exists to remove. It is the one ' +
      'document that can afford to be dynamic, because nobody outside the team ever requests it.',
  },
  {
    id: 'kitchen-sink-portrait',
    path: '/kitchen-sink/portrait/[index]',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'Serves one staff portrait to both kitchen sinks from `assets/media/`. Locale-neutral because ' +
      'route groups do not appear in a URL and a photograph has no language; dynamic because the ' +
      'index is a segment and the bytes are read at request time.',
  },
  {
    id: 'llms-txt',
    path: '/llms.txt',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: true,
    sitemap: false,
    changefreq: null,
    why:
      'W-SITE-02s LLM-SEO index (docs/09 §"LLM SEO"), a different artefact from robots.txt and from the ' +
      'sitemap: it says what the business IS and which pages are worth reading, in prose, for a reader ' +
      'that will not run JavaScript. Indexable for the same reason as /api/facts, and its page list is ' +
      'derived from this registry, so docs/09 §1s eleven planned routes appear in it the day they land.',
  },
  {
    id: 'robots-txt',
    path: '/robots.txt',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: true,
    sitemap: false,
    changefreq: null,
    why:
      'W-SITE-02s crawl policy: what a crawler may FETCH, which is a different question from what may be ' +
      'indexed — that is this registrys `indexable` flag and the x-robots-tag the proxy serves. The two ' +
      'are alternatives rather than layers, so the noindex prefixes here are deliberately not disallowed ' +
      'there: a crawler forbidden to fetch them could never read the header. Dynamic because SITE_ORIGIN ' +
      'is read at request time, so a build promoted between environments cannot serve the wrong host.',
  },
  {
    id: 'google-connect',
    path: '/settings/integrations/google/connect',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'G-CONN-03s consent start and callback, inside the (admin) group. Covered by the /settings ' +
      'noindex prefix below rather than by a rule of its own, so the next admin route is noindex ' +
      'before it is written.',
  },
  {
    id: 'google-health',
    path: '/settings/integrations/google/health',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'G-CONN-06s connection health fragment: the plain-English state of every Google connection, how ' +
      'recently it was verified, and — while the OAuth consent screen is in Testing — the date the ' +
      'grant expires. A handler rather than a document for the reason the picker beside it gives, and ' +
      'read-only: it makes no Google call, so it still renders on the day the grant dies. G-CONN-07 ' +
      'replaces the fragment with the rendered card. Covered by the /settings noindex prefix.',
  },
  {
    id: 'google-picker',
    path: '/settings/integrations/google/picker',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'G-CONN-05s account and location picker: GET enumerates the accounts and locations this Google ' +
      'account manages, POST records the chosen listing or Search Console property. A handler rather ' +
      'than a document because a document has to be served in both locales and needs the admin shell ' +
      'W-SYS-01 builds; the settings card that will call this is G-CONN-07. Covered by the /settings ' +
      'noindex prefix, like the consent route beside it.',
  },
  {
    id: 'messages-inbox',
    path: '/settings/messages',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'B-MSG-04s admin Messages inbox: every message a vendor was asked to send, with its body, ' +
      'encoding, segments, cost, status and delivery receipts, plus an HTML preview pane for a Resend ' +
      'email. A handler answering text/html rather than a document, for the reason G-CONN-05s picker ' +
      'gives: a document must be served in both locales, which would need an Arabic admin document and ' +
      'the W-SYS-01 shell, and would join a screenshot matrix whose RTL half has to be a real Arabic ' +
      'route. This surface is English-only on purpose and is screenshotted at 3 viewports x 2 themes by ' +
      'apps/web/src/messages-inbox.itest.ts. Covered by the /settings noindex prefix, like the two ' +
      'Google routes beside it; dynamic because it reads the message rows on every request.',
  },
  {
    id: 'treatment-path',
    path: '/treatments/[slug]',
    kind: 'handler',
    rendering: 'dynamic',
    locales: [],
    indexable: false,
    sitemap: false,
    changefreq: null,
    why:
      'B-CAT-05s slug resolver: a live treatment answers 200, a renamed or archived one 301s to where ' +
      'it went. A handler rather than a document because a page.tsx and a route.ts cannot share a ' +
      'segment, and W-SITE-05 supersedes it with the real treatment page — at which point `kind` ' +
      'becomes `document`, `locales` becomes LOCALES and both flags flip, and this file is where that ' +
      'is decided rather than discovered. Not indexable and absent from the sitemap while it serves ' +
      'text/plain: asking a crawler to index a redirect stub is worse than not asking.',
  },
  // `as const satisfies` rather than an annotation: the annotation would widen every `id` to `string`
  // and `RouteId` with it, so `routeById('hoem')` would compile.
] as const satisfies readonly RouteEntry[]

/**
 * One entry of the registry, as declared.
 *
 * Narrower than `RouteEntry`: it carries the literal types the array declares, which is what makes
 * `RouteId` a union of the declared ids rather than `string`, and what lets `alternatesFor(route.id, …)`
 * typecheck without a cast.
 */
export type Route = (typeof ROUTES)[number]
export type RouteId = Route['id']

/**
 * The prefixes the admin group owns in the URL space.
 *
 * The `(admin)` route group is a route group, so it contributes **nothing** to the URL: its routes are
 * top-level paths that share no prefix. That is why this list exists rather than a single `/admin/**`
 * rule — and why it names `/analytics`, which has no route yet. A-FIRST-10 puts the funnel dashboard
 * there (docs/09 §1: "Add `/analytics` inside the admin route group — `noindex`, excluded from the
 * sitemap"), and declaring the prefix now means the route arrives already excluded instead of being
 * indexed for as long as it takes somebody to notice. `route-spine.itest.ts` asserts the header is on
 * the live response today, where the route is a 404.
 */
export const ADMIN_GROUP_PREFIXES: readonly string[] = ['/analytics', '/settings']

/**
 * The value a non-indexable response carries.
 *
 * The same three directives as the CMS's, because the reasons are the same ones `@berelax/cms` gives:
 * `noindex` alone leaves a crawler free to follow links out of the page, and a cached copy of an admin
 * screen outlives the page. `registry.test.ts` asserts this equals `CMS_ROBOTS_TAG` so the two cannot
 * drift into two spellings of one policy.
 */
export const NOINDEX_ROBOTS_TAG = 'noindex, nofollow, noarchive'
export const ROBOTS_HEADER = 'x-robots-tag'

/**
 * Every prefix under which a response is noindex, in sorted order.
 *
 * Derived, not typed: the admin group's prefixes, plus every locale of every non-indexable *document*
 * in the registry. A handler is covered when a document prefix already contains it — the portrait
 * handler sits under `/kitchen-sink` — and `registry.test.ts` asserts that every non-indexable entry is
 * either covered here or exempt from the proxy, so there is no third category that quietly gets neither.
 */
export const NOINDEX_PREFIXES: readonly string[] = [
  ...ADMIN_GROUP_PREFIXES,
  ...ROUTES.filter((route) => !route.indexable && route.kind === 'document').flatMap((route) =>
    route.locales.map((locale) => localisedPath(route.path, locale)),
  ),
].sort()

/**
 * Does a request path match a route pattern, segment for segment?
 *
 * `NOINDEX_PREFIXES` is a list of literal prefixes, which cannot express a pattern: a request for
 * `/treatments/thai-massage` does not start with `/treatments/[slug]`, so a prefix list can only mark a
 * dynamic route noindex by claiming its whole parent — and `/treatments` is where W-SITE-05 puts the
 * public treatment pages, so claiming it would silently suppress the most valuable pages on the site the
 * day they land. A dynamic segment therefore matches exactly one segment here, and a catch-all the rest.
 */
function matchesRoutePattern(pathname: string, pattern: string): boolean {
  const actual = pathname.split('/').filter((part) => part !== '')
  const expected = pattern.split('/').filter((part) => part !== '')
  for (const [index, segment] of expected.entries()) {
    if (segment.startsWith('[[...') || segment.startsWith('[...')) return actual.length > index
    if (segment.startsWith('[')) {
      if (actual[index] === undefined) return false
      continue
    }
    if (actual[index] !== segment) return false
  }
  return actual.length === expected.length
}

/**
 * Every route the registry declares non-indexable, as a pattern in every locale it is served in.
 *
 * Both kinds, deliberately. `indexable: false` on a handler used to be documentation rather than policy:
 * `NOINDEX_PREFIXES` filters on `kind === 'document'`, and the three handlers that existed happened to sit
 * under `/api` (proxy-exempt) or under a prefix a noindex document already claimed. `/treatments/[slug]`
 * is the first that sits under neither, and it answers 200 `text/plain` on a public path — so a crawler
 * will fetch `/treatments/thai-massage` and index a redirect stub. The field now means what it says.
 */
const NOINDEX_PATTERNS: readonly string[] = ROUTES.filter((route) => !route.indexable).flatMap(
  (route) =>
    route.locales.length === 0
      ? [route.path]
      : route.locales.map((locale) => localisedPath(route.path, locale)),
)

/** The `x-robots-tag` a path must carry, or null when it is a public page. */
export function robotsTagFor(pathname: string): string | null {
  const covered =
    NOINDEX_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ||
    NOINDEX_PATTERNS.some((pattern) => matchesRoutePattern(pathname, pattern))
  return covered ? NOINDEX_ROBOTS_TAG : null
}

/** The CMS's tag, re-exported so the one assertion that compares them has both in one import. */
export { CMS_ROBOTS_TAG }

export function routeById(id: RouteId): Route {
  const route = ROUTES.find((entry) => entry.id === id)
  // Throwing rather than returning undefined: every call site is a page or a builder that cannot
  // proceed without the entry, and an optional return would be checked with `??` and a made-up default.
  if (route === undefined) throw new Error(`No route with id '${id}' in the registry`)
  return route
}

/** The rendered documents, which is what has a locale, a canonical URL and a screenshot. */
export function documentRoutes(): readonly Route[] {
  return ROUTES.filter((route) => route.kind === 'document')
}

/** The path of one route in one locale. Throws for a locale the route is not served in. */
export function pathFor(route: RouteEntry, locale: Locale): string {
  if (!route.locales.includes(locale)) {
    throw new Error(`Route '${route.id}' is not served in locale '${locale}'`)
  }
  return localisedPath(route.path, locale)
}

/** One URL the registry claims, with the entry and locale it came from. */
export interface RoutePath {
  readonly path: string
  readonly route: Route
  /** Null for a locale-neutral handler: it has one URL, and no document to have a language. */
  readonly locale: Locale | null
}

/**
 * Every URL the registry claims — the set the bijection is asserted against.
 *
 * A locale-neutral handler contributes its path once. Everything else contributes one path per locale,
 * which is what makes `/ar/kitchen-sink` a route the registry knows about rather than a folder that
 * happens to exist.
 */
export function routePaths(): readonly RoutePath[] {
  // A loop with a declared accumulator rather than a `flatMap` over a ternary: the two branches produce
  // `locale: null` and `locale: Locale`, and inference picks one of them as the array's element type
  // rather than the union — which is a type error about `null` several lines away from the cause.
  const paths: RoutePath[] = []
  for (const route of ROUTES) {
    if (route.locales.length === 0) {
      paths.push({ path: route.path, route, locale: null })
      continue
    }
    for (const locale of route.locales) {
      paths.push({ path: localisedPath(route.path, locale), route, locale })
    }
  }
  return paths
}

export function registryPaths(): readonly string[] {
  return routePaths().map((entry) => entry.path)
}

/** The entry a URL belongs to, in either locale, or undefined when the registry does not claim it. */
export function routeByPath(pathname: string): Route | undefined {
  return routePaths().find((entry) => entry.path === pathname)?.route
}

/**
 * The routes a sitemap may contain, as `{ path, changefreq }` per locale.
 *
 * W-SITE-08 builds the sitemap index and the per-type sitemaps; this is the only source it may read, so
 * that "absent from every sitemap" is a property of the registry rather than a claim repeated in a
 * sitemap builder. Every non-indexable route, every handler and every CMS route is absent here by
 * construction, and `registry.test.ts` asserts each of those three.
 */
export interface SitemapEntry {
  readonly path: string
  readonly locale: Locale
  readonly changefreq: ChangeFrequency
}

export function sitemapEntries(): readonly SitemapEntry[] {
  const entries: SitemapEntry[] = []
  for (const route of ROUTES) {
    if (!route.sitemap || route.changefreq === null) continue
    for (const locale of route.locales) {
      entries.push({ path: pathFor(route, locale), locale, changefreq: route.changefreq })
    }
  }
  return entries
}

/** The CMS routes hiding in a set of registry paths. Empty, and asserted to be. */
export function cmsRoutesInRegistry(): readonly string[] {
  return cmsRoutesIn(registryPaths())
}
