import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CMS_ROBOTS_TAG, cmsRoutesIn, isCmsRoute } from '@berelax/cms'
import { captureFilename, capturePlan, missingCaptures } from '@berelax/harness/matrix'
import { DETECTABLE_REVIEW_LANGUAGES } from '@berelax/shared'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_LOCALE,
  HREFLANG_DEFAULT,
  hreflangFor,
  LOCALES,
  localeOf,
  localisedPath,
  neutralPath,
} from '../i18n/locales.ts'
import {
  absoluteUrl,
  alternatesFor,
  routeMetadata,
  SITE_ORIGIN_ENV,
  SITE_ORIGIN_FALLBACK,
  siteOrigin,
} from './alternates.ts'
import {
  canonicalPath,
  isProxyExempt,
  needsCanonicalRedirect,
  PROXY_EXEMPT_PREFIXES,
} from './canonical.ts'
import { type FilesystemRoute, sortedFilesystemRoutes } from './discover.ts'
import { NAV_ROUTE_IDS, navigableRouteIds } from './nav.ts'
import {
  ADMIN_GROUP_PREFIXES,
  documentRoutes,
  fillParams,
  isParameterised,
  NOINDEX_PREFIXES,
  NOINDEX_ROBOTS_TAG,
  parameterisedSitemapRoutes,
  pathFor,
  type RenderingMode,
  ROUTES,
  registryPaths,
  robotsTagFor,
  routeById,
  routeByPath,
  routePaths,
  sampleParamsOf,
  samplePathFor,
  sitemapEntries,
} from './registry.ts'

/**
 * W-SITE-01 — the route spine, checked without a server.
 *
 * What is here is everything that is decidable from the source: the bijection between the registry and
 * the filesystem, the normalisation table, the completeness of the `hreflang` sets and the capture plan.
 * What is *not* here is everything that is a claim about a response — one 301 hop to a 200, the robots
 * header on a live admin route, a mirrored grid — and that lives in `apps/web/src/route-spine.itest.ts`,
 * driving the built application. Splitting them this way is deliberate: these run in two seconds on every
 * commit, and a claim about rendered output cannot be checked by reading source at all.
 *
 * Every assertion here is paired with a control that must fail. `expect(missing).toEqual([])` on its own
 * is satisfied by a scanner that found nothing — which is the exact defect ADR 0002 records — so the
 * scanner is also run against a fixture tree whose routes are known.
 */

const APP_DIR = new URL('../../app', import.meta.url).pathname

/**
 * Reading the app directory in the unit suite.
 *
 * The suite is otherwise pure, and this is a `readdirSync` over about thirty files — cheaper than the
 * `next.config.ts` import in `payload-routes.test.ts` next door. It is here rather than in the
 * integration suite because "adding a route without a registry entry fails the build" has to fail in
 * seconds, on the commit that added the route, not after a build and a server start.
 */
function routesOnDisk(): readonly FilesystemRoute[] {
  // The CMS's routes are `@berelax/cms`'s and W-SYS-08's. They are skipped on this side and asserted
  // absent on the other, so neither half can quietly start treating the admin as a public route.
  return sortedFilesystemRoutes(APP_DIR).filter((route) => !isCmsRoute(route.path))
}

describe('acceptance — the registry and the filesystem are in exact bijection', () => {
  it('claims every route on disk', () => {
    const declared = new Set(registryPaths())
    const missing = routesOnDisk()
      .filter((route) => !declared.has(route.path))
      .map((route) => `${route.path} (app/${route.file})`)
    expect(
      missing,
      `route-without-registry-entry: on disk and not in the registry — ${missing.join(', ')}. ` +
        'Add an entry to apps/web/src/routes/registry.ts: a route the registry does not know about is ' +
        'absent from the sitemap, carries no hreflang and is never screenshotted, and none of those ' +
        'three is a build error on its own.',
    ).toEqual([])
  })

  it('claims nothing that is not on disk', () => {
    const onDisk = new Set(routesOnDisk().map((route) => route.path))
    const phantom = registryPaths().filter((path) => !onDisk.has(path))
    expect(
      phantom,
      `registry-entry-without-route: declared and not on disk — ${phantom.join(', ')}. The registry ` +
        'describes what is served, not what is planned: docs/09 §1 lists eleven more routes and each ' +
        'arrives with its own unit.',
    ).toEqual([])
  })

  it('resolves each URL from exactly one file', () => {
    // Four route groups and two root layouts make one URL from two files easy to write by accident —
    // `app/(ar)/page.tsx` and `app/(en)/(public)/page.tsx` both resolve to `/`. Next refuses that at
    // build time with a parallel-pages error after a minute of compiling; this names both files in two
    // seconds, and the bijection above cannot see it because a set does not count duplicates.
    const byPath = new Map<string, string[]>()
    for (const route of routesOnDisk()) {
      byPath.set(route.path, [...(byPath.get(route.path) ?? []), route.file])
    }
    const duplicates = [...byPath.entries()].filter(([, files]) => files.length > 1)
    expect(
      duplicates,
      `route-declared-twice: ${duplicates
        .map(([path, files]) => `${path} <- ${files.join(' and ')}`)
        .join('; ')}`,
    ).toEqual([])
  })

  it('agrees with the filesystem about which routes are documents and which are handlers', () => {
    // The bijection is over paths; this is over the property that decides whether a route has a
    // canonical URL, an hreflang set and a screenshot at all.
    for (const route of routesOnDisk()) {
      const entry = routeByPath(route.path)
      expect(entry, route.path).toBeDefined()
      expect(entry?.kind, `${route.path} (app/${route.file})`).toBe(route.kind)
    }
  })

  it('finds the routes it is supposed to find, and not the ones it is not', () => {
    // The control on the scanner. A walk that returned nothing would satisfy both assertions above, and
    // "green tick on zero modules" is ADR 0002's whole subject. Run against a tree whose answer is known.
    const root = mkdtempSync(join(tmpdir(), 'berelax-app-'))
    try {
      mkdirSync(join(root, '(group)', 'deep'), { recursive: true })
      mkdirSync(join(root, '_private'), { recursive: true })
      mkdirSync(join(root, 'api', '[slug]'), { recursive: true })
      writeFileSync(join(root, 'page.tsx'), 'export default function P() { return null }\n')
      writeFileSync(join(root, '(group)', 'deep', 'page.tsx'), 'export default () => null\n')
      writeFileSync(join(root, '_private', 'page.tsx'), 'export default () => null\n')
      writeFileSync(join(root, 'api', '[slug]', 'route.ts'), 'export function GET() {}\n')

      const found = sortedFilesystemRoutes(root)
      expect(found.map((route) => `${route.kind} ${route.path}`)).toEqual([
        // The root page, the grouped page with the group absent from the URL, and the handler.
        'document /',
        'handler /api/[slug]',
        'document /deep',
      ])
      // Named explicitly: an underscore-prefixed folder is excluded from routing by Next, so counting it
      // would report `app/_routes/route-nav.tsx` as an unregistered route on every run.
      expect(found.map((route) => route.path)).not.toContain('/_private')
      expect(found.map((route) => route.path)).not.toContain('/(group)/deep')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('contains no CMS route, from either direction', () => {
    expect(cmsRoutesIn(registryPaths())).toEqual([])
    // The control for the filter in `routesOnDisk`: the admin really is on disk, so the filter is doing
    // something. Without this, deleting the CMS would make the test above pass for the wrong reason.
    expect(sortedFilesystemRoutes(APP_DIR).some((route) => isCmsRoute(route.path))).toBe(true)
  })
})

describe('the registry is internally consistent', () => {
  it('has unique ids and unique paths, in path order', () => {
    const ids = ROUTES.map((route) => route.id)
    expect(new Set(ids).size).toBe(ids.length)
    const paths = registryPaths()
    expect(new Set(paths).size).toBe(paths.length)
    expect([...ROUTES.map((route) => route.path)]).toEqual(
      [...ROUTES.map((route) => route.path)].sort(),
    )
  })

  it('gives every document a locale and every handler none', () => {
    for (const route of ROUTES) {
      if (route.kind === 'document') {
        expect(route.locales.length, route.id).toBeGreaterThan(0)
        // Both locales, or the hreflang set for that route would point at a 404 — which invalidates the
        // whole set, not just the missing entry.
        expect([...route.locales], route.id).toEqual([...LOCALES])
      } else {
        expect([...route.locales], route.id).toEqual([])
      }
    }
  })

  it('pairs sitemap inclusion with a changefreq, indexability and a document', () => {
    for (const route of ROUTES) {
      expect(route.changefreq === null, `${route.id}: changefreq iff sitemap`).toBe(!route.sitemap)
      if (!route.sitemap) continue
      expect(route.indexable, `${route.id} is in the sitemap and not indexable`).toBe(true)
      expect(route.kind, `${route.id} is in the sitemap and not a document`).toBe('document')
    }
  })

  it('keeps every non-indexable route out of every sitemap', () => {
    const inSitemap = new Set(sitemapEntries().map((entry) => entry.path))
    for (const { path, route } of routePaths()) {
      if (route.indexable) continue
      expect(inSitemap.has(path), `${path} is not indexable and is in the sitemap`).toBe(false)
    }
    // The control: the sitemap really holds the routes it should, or this test passes on an empty sitemap —
    // which is exactly how a sitemap gate becomes decoration. `/treatments/[slug]` is deliberately absent:
    // it is a pattern, and `treatmentSitemapEntries` expands it over the catalogue (8 routes, 16 entries).
    expect([...inSitemap].sort()).toEqual([
      '/',
      '/about',
      '/ar',
      '/ar/about',
      '/ar/book',
      '/ar/contact',
      '/ar/faq',
      '/ar/journal',
      '/ar/pricing',
      '/ar/spa',
      '/ar/treatments',
      '/book',
      '/contact',
      '/faq',
      '/journal',
      '/pricing',
      '/spa',
      '/treatments',
    ])
    expect(sitemapEntries().every((entry) => entry.changefreq !== null)).toBe(true)
  })

  it('keeps every pattern out of the sitemap, and names the one a catalogue expands', () => {
    // A `<loc>` of `https://…/treatments/[slug]` is a sitemap telling a crawler to fetch a 404. The entries
    // function skips it; `parameterisedSitemapRoutes` is what stops that skip from being silent.
    for (const entry of sitemapEntries()) expect(entry.path, entry.path).not.toContain('[')
    expect(parameterisedSitemapRoutes().map((route) => route.path)).toEqual(['/treatments/[slug]'])
  })

  it('declares a rendering mode from a closed set', () => {
    for (const route of ROUTES) {
      expect(['static', 'dynamic', 'isr'], route.id).toContain(route.rendering)
    }
    // Asserted against `.next/prerender-manifest.json` — what the build produced — in the itest. Here it
    // is only the shape, so the itest's comparison has something to compare.
    //
    // **No route is `static` any more.** `home` was the last one and W-SITE-04 made it `isr`, for the reason
    // every other route on this list gives: the home page is composed from the premises row, the catalogue and
    // the roster, and a statically prerendered page bakes what it read into the build with nothing able to
    // correct it. The mode stays in the union rather than being deleted, because a page with nothing to read
    // is a real thing and the legal pages docs/09 §1 lists are the next candidates — and an empty list here
    // is the assertion that says so the day one arrives.
    //
    // `modeOf` widens the literal type before the comparison, and it is not a workaround for the compiler
    // being difficult — it is what lets the assertion go on existing. `ROUTES` is `as const`, so with no
    // `static` entry left the union narrows to `'isr' | 'dynamic'` and `route.rendering === 'static'` becomes
    // an error rather than a false comparison. Deleting the case to satisfy that would remove the one thing
    // that will notice the next `static` route.
    const modeOf = (route: (typeof ROUTES)[number]): RenderingMode => route.rendering
    expect(ROUTES.filter((route) => modeOf(route) === 'static').map((route) => route.id)).toEqual(
      [],
    )
    // The catalogue-derived routes, added by W-SITE-05, and the five CMS-and-premises routes W-SITE-07 added
    // to them. `isr` rather than `static` because they read the database during `next build` and are replaced
    // by on-demand revalidation when a row changes — a distinction with two consequences the itest checks
    // against the build's own manifests: the database is a build dependency, and a route with a dynamic
    // segment prerenders its params rather than its pattern.
    //
    // docs/09 §1 lists `/contact`, `/about` and the legal pages as `static`. They are `isr` here and the
    // reason is the rest of that document: §4 makes the `premises` row the only source of NAP and names
    // `/contact` and `/spa` as two of its three visible surfaces, and a statically prerendered page bakes the
    // address into the build — the staleness W-SITE-02 exists to remove. A page that reads a row is `isr`.
    expect(ROUTES.filter((route) => route.rendering === 'isr').map((route) => route.id)).toEqual([
      'home',
      'about',
      'contact',
      'faq',
      'journal',
      'pricing',
      'spa',
      'treatments',
      'treatment',
    ])
  })

  it('offers every indexable page in the site navigation, and nothing else', () => {
    // The reachability half of W-SITE-07's link-graph invariant, checked without a server. `SiteNav` renders
    // `NAV_ROUTE_IDS`, and a route that is indexable and absent from it is an orphan: reachable only from a
    // sitemap W-SITE-08 has not built and from /llms.txt. The invariant catches it over the built site; this
    // catches it on the commit, in two seconds, and names the route.
    expect([...NAV_ROUTE_IDS].sort()).toEqual([...navigableRouteIds()].sort())
    // The controls. A parameterised route is a pattern and cannot be a nav entry — `fillParams` would throw
    // rather than publish `/treatments/[slug]` — and its pages are reached from the index, which is what a hub
    // is. A non-indexable route must not be offered at all: it carries `noindex, nofollow`.
    expect([...NAV_ROUTE_IDS]).not.toContain('treatment')
    expect([...NAV_ROUTE_IDS]).not.toContain('kitchen-sink')
    // And the list is not empty, or every assertion above passes on nothing.
    expect(NAV_ROUTE_IDS.length).toBeGreaterThan(5)
  })

  it('declares sample params exactly for the documents that have a dynamic segment', () => {
    for (const route of ROUTES) {
      // Documents only. A handler with a dynamic segment — the portrait route — is opened by nothing that
      // needs a real path: it has no canonical URL, no hreflang set and no screenshot, which is what
      // `kind: 'handler'` means. A document's pattern, by contrast, is opened by all three.
      const parameterised = isParameterised(route.path) && route.kind === 'document'
      expect(
        Object.keys(sampleParamsOf(route)).length > 0,
        `${route.id}: sampleParams iff dynamic document`,
      ).toBe(parameterised)
      if (!parameterised) continue
      // And they have to fill it: `samplePathFor` throws on a segment nobody filled, which is what stops the
      // screenshot harness and the normalisation walk from opening a pattern.
      for (const locale of route.locales) {
        expect(samplePathFor(route, locale), route.id).not.toContain('[')
      }
    }
  })

  it('explains itself', () => {
    // A `why` that is empty is a registry entry somebody will delete next year without knowing what it
    // was for. Cheap to assert, and it is the field that makes the others reviewable.
    for (const route of ROUTES) expect(route.why.length, route.id).toBeGreaterThan(40)
  })
})

describe('acceptance — noindex covers the admin group and /analytics, and nothing public', () => {
  it('serves the same three directives the CMS does', () => {
    // One policy, one spelling. Two strings that mean the same thing are two strings to keep in step.
    expect(NOINDEX_ROBOTS_TAG).toBe(CMS_ROBOTS_TAG)
    expect(NOINDEX_ROBOTS_TAG).toContain('noindex')
    expect(NOINDEX_ROBOTS_TAG).toContain('nofollow')
    expect(NOINDEX_ROBOTS_TAG).toContain('noarchive')
  })

  it('covers /analytics before the route exists', () => {
    // A-FIRST-10 puts the funnel dashboard there. Declaring the prefix now means the route arrives
    // excluded rather than being indexed until somebody reads Search Console.
    expect(ADMIN_GROUP_PREFIXES).toContain('/analytics')
    for (const path of [
      '/analytics',
      '/analytics/funnel',
      '/settings/integrations/google/connect',
    ]) {
      expect(robotsTagFor(path), path).toBe(NOINDEX_ROBOTS_TAG)
    }
  })

  it('covers every non-indexable registry route, in every locale', () => {
    // No third category: a route is either covered by a noindex prefix or exempt from the proxy, and the
    // exempt one is the JSON API, which a crawler cannot GET a body out of anyway.
    for (const { path, route } of routePaths()) {
      if (route.indexable) continue
      const covered = robotsTagFor(path) === NOINDEX_ROBOTS_TAG
      expect(
        covered || isProxyExempt(path),
        `${path} is not indexable, carries no x-robots-tag and is not exempt from the proxy`,
      ).toBe(true)
    }
    expect(robotsTagFor('/kitchen-sink')).toBe(NOINDEX_ROBOTS_TAG)
    expect(robotsTagFor('/ar/kitchen-sink')).toBe(NOINDEX_ROBOTS_TAG)
    // A real path under a non-indexable dynamic route, not the pattern: `/kitchen-sink/portrait/[index]`
    // does not match `/kitchen-sink/portrait/3` as a prefix, so this is `matchesRoutePattern`'s job and the
    // reason it exists. It was `/treatments/[slug]` until W-SITE-05 made that route public.
    expect(robotsTagFor('/kitchen-sink/portrait/3')).toBe(NOINDEX_ROBOTS_TAG)
    // One segment, not any depth: a dynamic segment must not swallow a path below it. Here that is covered
    // by the `/kitchen-sink` prefix, so the pattern matcher is checked on a path no prefix claims.
    expect(robotsTagFor('/treatments/asian-normal-massage/reviews')).toBeNull()
  })

  it('leaves every public route alone', () => {
    // The control, and the most expensive one-line mistake available in this file: a prefix of `/` would
    // satisfy every assertion above and noindex the entire site.
    for (const path of [
      '/',
      '/ar',
      '/api/facts',
      '/treatments',
      '/ar/treatments',
      '/pricing',
      '/ar/pricing',
      // The eight most valuable pages on the site. `indexable: true` on a route whose paths come from the
      // catalogue is the one policy a prefix list could have silently reversed: `/treatments` as a noindex
      // prefix would have suppressed every treatment page the day it landed.
      '/treatments/asian-normal-massage',
      '/ar/treatments/arabic-morocco-bath-jacuzzi',
      '/settingsx',
    ]) {
      expect(robotsTagFor(path), path).toBeNull()
    }
    expect(NOINDEX_PREFIXES).not.toContain('/')
  })
})

describe('acceptance — normalisation resolves to one canonical path in one hop', () => {
  /** The table from the acceptance criterion, verbatim, plus the locale-prefixed shapes. */
  const TABLE: readonly [string, string][] = [
    ['/Treatments/', '/treatments'],
    ['/treatments/', '/treatments'],
    ['/treatments//x', '/treatments/x'],
    ['/TREATMENTS//X/', '/treatments/x'],
    ['/tReAtMeNtS', '/treatments'],
    ['/', '/'],
    ['//', '/'],
    ['///ar//', '/ar'],
    ['/AR/Kitchen-Sink/', '/ar/kitchen-sink'],
    ['/kitchen-sink', '/kitchen-sink'],
  ]

  it('resolves every variant to the canonical path', () => {
    for (const [given, expected] of TABLE) expect(canonicalPath(given), given).toBe(expected)
  })

  it('does not stop half way', () => {
    // The control for the table. Each of these is the output of *one* of the three rules, which is what a
    // chain of redirects looks like: /Treatments/ -> /treatments/ -> /treatments, three requests on a
    // phone and a diluted signal. One hop means the intermediate spellings are never produced.
    expect(canonicalPath('/Treatments/')).not.toBe('/Treatments')
    expect(canonicalPath('/Treatments/')).not.toBe('/treatments/')
    expect(canonicalPath('/treatments//x/')).not.toBe('/treatments//x')
  })

  it('is idempotent, so a canonical URL is never redirected again', () => {
    for (const [given] of TABLE) {
      const once = canonicalPath(given)
      expect(canonicalPath(once), given).toBe(once)
      expect(needsCanonicalRedirect(once), once).toBe(false)
    }
    // Over generated paths rather than the table only: a loop needs one input the table does not have,
    // and "zero loops" is a property, not a list.
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 8 }), { maxLength: 5 }), (segments) => {
        const path = `/${segments.join('/')}`
        const once = canonicalPath(path)
        return canonicalPath(once) === once && !needsCanonicalRedirect(once)
      }),
      { numRuns: 400 },
    )
  })

  it('leaves percent-escapes as octets and normalises their case upwards', () => {
    // Lowercasing `%D8%A7` produces `%d8%a7`: the same Arabic letter, a different string, and a redirect
    // that never reaches a fixed point. RFC 3986 §6.2.2.1 asks for upper case, which is also idempotent.
    expect(canonicalPath('/ar/%D8%A7')).toBe('/ar/%D8%A7')
    expect(canonicalPath('/AR/%d8%a7/')).toBe('/ar/%D8%A7')
    expect(canonicalPath(canonicalPath('/AR/%d8%a7/'))).toBe('/ar/%D8%A7')
  })
})

describe('acceptance — the proxy is excluded from the CMS, the API and the build output', () => {
  it('names the CMS prefixes from @berelax/cms rather than a second list', () => {
    expect(PROXY_EXEMPT_PREFIXES).toContain('/admin')
    expect(PROXY_EXEMPT_PREFIXES).toContain('/cms-api')
    expect(PROXY_EXEMPT_PREFIXES).toContain('/api')
    expect(PROXY_EXEMPT_PREFIXES).toContain('/_next')
  })

  it('exempts them however the request spells them', () => {
    for (const path of [
      '/admin',
      '/Admin',
      '/ADMIN/collections/pages',
      '/admin/collections/cms-users/AbC123',
      '/cms-api/pages',
      '/CMS-API/pages/AbC123',
      '/api/v1/otp',
      '/api/facts',
      '/_next/static/chunk.js',
      '/favicon.ico',
      '/ar/robots.txt',
    ]) {
      expect(isProxyExempt(path), path).toBe(true)
      expect(needsCanonicalRedirect(path), path).toBe(false)
    }
  })

  it('exempts nothing that merely begins with the same letters', () => {
    // The control. `startsWith('/admin')` alone swallows `/administration`, and a public page that is
    // never canonicalised and never gets a robots header is the kind of gap only Search Console reports.
    for (const path of ['/administration', '/apiary', '/cms-apix', '/', '/ar', '/kitchen-sink']) {
      expect(isProxyExempt(path), path).toBe(false)
    }
    expect(needsCanonicalRedirect('/Kitchen-Sink')).toBe(true)
    expect(needsCanonicalRedirect('/Admin')).toBe(false)
  })
})

describe('acceptance — the hreflang set is reciprocal, self-referential and has an x-default', () => {
  it('lists every locale and itself, from both documents', () => {
    for (const route of documentRoutes()) {
      // A parameterised route's set is built for one real page — its sample params — because a set built for
      // the pattern would name `/treatments/[slug]` in every entry.
      const params = sampleParamsOf(route)
      const sets = route.locales.map((locale) => alternatesFor(route.id, locale, params))
      for (const [index, alternates] of sets.entries()) {
        const locale = route.locales[index]
        expect(locale).toBeDefined()
        if (locale === undefined) continue
        // Self-referential: the page's own URL is in its own set. A set that lists only the other
        // locale is discarded by Google in its entirety.
        expect(Object.values(alternates.languages), `${route.id}/${locale}`).toContain(
          alternates.canonical,
        )
        expect(alternates.canonical).toBe(
          absoluteUrl(fillParams(localisedPath(route.path, locale), params)),
        )
        for (const served of route.locales) {
          expect(alternates.languages[hreflangFor(served)], `${route.id}/${locale}`).toBe(
            absoluteUrl(fillParams(localisedPath(route.path, served), params)),
          )
        }
        expect(alternates.languages[HREFLANG_DEFAULT]).toBe(
          absoluteUrl(fillParams(localisedPath(route.path, DEFAULT_LOCALE), params)),
        )
      }
      // Reciprocal: both documents carry the *same* set, so neither can point at a URL the other does
      // not claim.
      const [first, ...rest] = sets
      expect(first).toBeDefined()
      for (const other of rest) expect(other.languages).toEqual(first?.languages)
    }
  })

  it('uses the same language codes as <html lang>', () => {
    // The shell renders `lang={locale}`. A page that declares `lang="ar"` and an alternate that declares
    // `hreflang="ar-AE"` are two claims about one document that nothing reconciles.
    for (const locale of LOCALES) expect(hreflangFor(locale)).toBe(locale)
  })

  it('points x-default at the English document, not at a third URL', () => {
    const alternates = alternatesFor('home', 'ar')
    expect(alternates.languages[HREFLANG_DEFAULT]).toBe(alternates.languages['en'])
    // The control: x-default is not the Arabic document, which is what a copy-paste of the self-reference
    // produces and which no validator complains about.
    expect(alternates.languages[HREFLANG_DEFAULT]).not.toBe(alternates.canonical)
  })

  it('refuses a handler and a locale a route is not served in', () => {
    expect(() => alternatesFor('otp', 'en')).toThrow(/handler/)
    expect(() => pathFor(routeById('otp'), 'en')).toThrow(/not served in locale/)
  })

  it('refuses to publish a pattern as a URL', () => {
    // The most expensive silent mistake this file can catch: a treatment page that forgot to pass its slug
    // would announce `https://…/treatments/[slug]` as its canonical URL, in the head of all eight pages,
    // and nothing on the page would look wrong.
    // The messages name the rule, because the gate that neuters `fillParams` reads this output for it:
    // vitest prints "expected function to throw an error, but it didn't" and echoes nothing of the pattern,
    // so a `toThrow(/…/)` alone would leave the gate green over a failing test (ADR 0003).
    expect(
      () => alternatesFor('treatment', 'en'),
      'a pattern with an unfilled dynamic segment must be refused, not published as a URL',
    ).toThrow(/unfilled dynamic segment/)
    expect(
      () => routeMetadata('treatment', 'en'),
      'metadata for a route with an unfilled dynamic segment must be refused',
    ).toThrow(/dynamic segment/)
    expect(fillParams('/treatments/[slug]', { slug: 'asian-normal-massage' })).toBe(
      '/treatments/asian-normal-massage',
    )
    // The control: a route with no dynamic segment needs no params and is unaffected.
    expect(routeMetadata('pricing', 'en').alternates?.canonical).toBe(absoluteUrl('/pricing'))
    expect(
      routeMetadata('treatment', 'ar', { slug: 'asian-normal-massage' }).alternates?.canonical,
    ).toBe(absoluteUrl('/ar/treatments/asian-normal-massage'))
  })

  it('carries the registry robots directive into the page metadata', () => {
    expect(routeMetadata('home', 'en').robots).toBeUndefined()
    expect(routeMetadata('kitchen-sink', 'ar').robots).toEqual({ index: false, follow: false })
    expect(routeMetadata('kitchen-sink', 'ar').alternates?.canonical).toBe(
      absoluteUrl('/ar/kitchen-sink'),
    )
  })
})

describe('the site origin', () => {
  afterEach(() => {
    delete process.env[SITE_ORIGIN_ENV]
  })

  it('falls back to the live domain', () => {
    delete process.env[SITE_ORIGIN_ENV]
    expect(siteOrigin()).toBe(SITE_ORIGIN_FALLBACK)
    expect(absoluteUrl('/ar')).toBe(`${SITE_ORIGIN_FALLBACK}/ar`)
  })

  it('takes an override, without its trailing slash', () => {
    process.env[SITE_ORIGIN_ENV] = 'https://staging.berelaxmassage.com/'
    expect(siteOrigin()).toBe('https://staging.berelaxmassage.com')
    // A preview deployment announcing the production origin as canonical asks Google to index
    // production copies of unreviewed pages, which is why the override exists at all.
    expect(absoluteUrl('/')).toBe('https://staging.berelaxmassage.com/')
  })

  it('refuses a value that is not an origin', () => {
    for (const bad of [
      'berelaxmassage.com',
      '//berelaxmassage.com',
      'ftp://x.example',
      'https://x/p',
    ]) {
      process.env[SITE_ORIGIN_ENV] = bad
      expect(() => siteOrigin(), bad).toThrow(new RegExp(SITE_ORIGIN_ENV))
    }
  })
})

describe('acceptance — the capture matrix reads the registry', () => {
  const documents = documentRoutes().map((route) => route.id)

  it('plans three viewports x two themes x two directions for every registry document', () => {
    const plan = capturePlan(documents)
    expect(plan).toHaveLength(documents.length * 12)
    for (const id of documents) {
      expect(
        plan.filter((target) => target.page === id),
        id,
      ).toHaveLength(12)
    }
    expect(new Set(plan.map((target) => captureFilename(target))).size).toBe(plan.length)
  })

  it('names the cell that was not captured', () => {
    // The control. `missingCaptures` returning [] is the assertion the itest makes after photographing
    // every cell, and an implementation that always returned [] would satisfy it forever.
    const plan = capturePlan(documents)
    const all = plan.map((target) => captureFilename(target))
    expect(missingCaptures(plan, all)).toEqual([])
    const dropped = all[7]
    expect(dropped).toBeDefined()
    expect(
      missingCaptures(
        plan,
        all.filter((name) => name !== dropped),
      ),
    ).toEqual([dropped])
  })

  it('refuses two pages filed under one name', () => {
    // Two routes with one id produce one set of filenames: the second overwrites the first's images and
    // the count still adds up, which is a silent loss of half the evidence.
    expect(() => capturePlan(['home', 'home'])).toThrow(/Duplicate page name/)
  })
})

describe('the locale prefix is written down once', () => {
  it('prefixes Arabic and leaves English at the root', () => {
    expect(localisedPath('/', 'en')).toBe('/')
    expect(localisedPath('/', 'ar')).toBe('/ar')
    expect(localisedPath('/kitchen-sink', 'ar')).toBe('/ar/kitchen-sink')
    expect(neutralPath('/ar/kitchen-sink')).toBe('/kitchen-sink')
    expect(neutralPath('/ar')).toBe('/')
  })

  it('serves exactly the languages the review router can identify', () => {
    // G-REV-03's `DETECTABLE_REVIEW_LANGUAGES` decides which languages a review reply may be written in,
    // and it is spelled in `@berelax/shared` because that package is the leaf and may import no sibling —
    // so it cannot import `Locale` from `@berelax/ui` or `LOCALES` from here. Two hand-kept lists of one
    // fact, and this is the assertion that holds them together: a third locale added to the site without
    // a review-language detector would make every review in it escalate silently, and a language added
    // there that the site does not serve would let a reply be drafted in a language with no page to link
    // to. This test is named in that module's own comment.
    expect([...DETECTABLE_REVIEW_LANGUAGES]).toEqual([...LOCALES])
  })

  it('reads the locale off a path by segment, not by prefix', () => {
    expect(localeOf('/ar')).toBe('ar')
    expect(localeOf('/ar/kitchen-sink')).toBe('ar')
    // The control, and a real URL: `/arabic-massage-abu-dhabi` is an English page that already ranks on
    // the live site (docs/13 §4). A `startsWith('/ar')` test would serve it the Arabic document.
    expect(localeOf('/arabic-massage-abu-dhabi')).toBe('en')
    expect(neutralPath('/arabic-massage-abu-dhabi')).toBe('/arabic-massage-abu-dhabi')
  })
})
