import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CMS_ROBOTS_TAG, isCmsRoute } from '@berelax/cms'
import {
  type CaptureTarget,
  captureFilename,
  capturePlan,
  DIRECTIONS,
  type Direction,
  missingCaptures,
  THEMES,
  VIEWPORTS,
} from '@berelax/harness/matrix'
import { testPort } from '@berelax/harness/ports'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_LOCALE,
  directionFor,
  HREFLANG_DEFAULT,
  hreflangFor,
  LOCALES,
  type Locale,
  localisedPath,
} from './i18n/locales.ts'
import { alternatesFor, siteOrigin } from './routes/alternates.ts'
import { canonicalPath } from './routes/canonical.ts'
import {
  documentRoutes,
  isParameterised,
  NOINDEX_ROBOTS_TAG,
  ROBOTS_HEADER,
  registryPaths,
  routePaths,
  sampleParamsOf,
  samplePathFor,
} from './routes/registry.ts'

/**
 * W-SITE-01 — the route spine, proved against the running application.
 *
 * Not one claim in this unit can be checked by reading source:
 *
 * - **"one 301 hop to a 200, zero chains, zero loops"** is a property of a sequence of responses. The
 *   pure normalisation table is asserted in `routes/registry.test.ts`; what is asserted here is that the
 *   proxy applies it *once*, that Next's own 308 trailing-slash handling never sees the path, and that
 *   the destination does not redirect again.
 * - **`x-robots-tag`** is a header. A grep for the string would pass on a rule inside a commented-out
 *   block, and the whole point of the header over a `<meta>` tag is that it arrives on a 404 and a 503 as
 *   well as on a page.
 * - **`hreflang` reciprocity** is a claim about two documents at once, rendered by two different root
 *   layouts, with the URLs resolved through `metadataBase`-less absolute hrefs. It is also the claim that
 *   has to agree with the canonicalisation: every URL advertised as an alternate is fetched here and has
 *   to answer 200 without redirecting.
 * - **A mirrored layout** is five computed track widths and a transform matrix.
 *
 * It drives `next start`, like `shell.itest.ts` and `primitives.itest.ts`, and builds first if `.next` is
 * absent — which it is in every fresh worktree and in CI.
 */

/**
 * A port from its own range, chosen at random.
 *
 * A hard-coded port collides when two agents run `pnpm verify` at once, and one of them then drives a
 * server that is not its own. `@berelax/harness/ports` owns the range and proves it does not overlap any
 * other suite's.
 */
const PORT = testPort('route-spine')
const BASE = `http://127.0.0.1:${PORT}`
const APP_DIR = new URL('..', import.meta.url).pathname
const SCREENS = join(APP_DIR, '..', '..', 'artifacts', 'screens', 'routes')

let server: ChildProcess
let browser: Browser

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`The app did not start on ${BASE} within ${timeoutMs}ms`)
}

/** Builds the app if it has not been built. `next start` serves `.next`, which is gitignored. */
/**
 * `SITE_ORIGIN` must be the same at build as it is here, and a mismatch has to say so.
 *
 * `siteOrigin()`'s own comment says the value is read at render time so a build can be promoted. That is
 * true of the dynamic routes and **false of the statically prerendered ones**: `/` and `/ar` are `○ Static`,
 * so their `metadata` — canonical and the whole hreflang set — is evaluated during `next build` and baked
 * into the HTML. A run whose `SITE_ORIGIN` differs from the build's therefore compares a runtime
 * expectation against a baked document and fails with a three-line map diff that looks like a broken
 * hreflang rule. It happened on this file's first merge, and the diagnosis cost more than the check does.
 *
 * It is not only a test problem. A build promoted between environments carries the origin it was built
 * with, so a production deploy of a build made without `SITE_ORIGIN` announces the fallback as canonical on
 * every static page — for a relaunch whose whole point is preserving `berelaxmassage.com`'s rankings, that
 * is the one mistake that matters and nothing else would catch it.
 */
function assertOriginMatchesBuild(): void {
  const buildManifest = join(APP_DIR, '.next', 'BUILD_ID')
  if (!existsSync(buildManifest)) return
  const home = join(APP_DIR, '.next', 'server', 'app', 'index.html')
  if (!existsSync(home)) return
  const baked = /<link rel="canonical" href="([^"]+)"/.exec(readFileSync(home, 'utf8'))?.[1]
  if (baked === undefined) return
  const bakedOrigin = new URL(baked).origin
  if (bakedOrigin === siteOrigin()) return
  throw new Error(
    `the built app baked ${bakedOrigin} as its canonical origin but this run expects ${siteOrigin()}. ` +
      'The static routes evaluate SITE_ORIGIN during `next build`, so the two must be identical — ' +
      'rebuild with the same SITE_ORIGIN (or unset it in both places) rather than changing this test.',
  )
}

function buildIfNeeded(): void {
  if (existsSync(join(APP_DIR, '.next', 'BUILD_ID'))) return
  const result = spawnSync('pnpm', ['exec', 'next', 'build'], {
    cwd: APP_DIR,
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
  })
  if (result.status !== 0) {
    throw new Error(`next build failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
}

beforeAll(async () => {
  buildIfNeeded()
  assertOriginMatchesBuild()
  server = spawn('pnpm', ['exec', 'next', 'start', '--port', String(PORT)], {
    cwd: APP_DIR,
    stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'production' },
  })
  await waitForServer()
  browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.kill('SIGTERM')
})

interface Hop {
  readonly status: number
  readonly location: string | null
}

/**
 * Follows a path by hand and reports every hop.
 *
 * `redirect: 'manual'` rather than letting `fetch` follow: the number of hops *is* the assertion, and a
 * followed redirect reports only where it ended up. The cap is five because that is where Google stops
 * following, so a chain longer than this is indistinguishable from a broken URL.
 */
interface Walk {
  /** Every URL visited, starting with the one asked for. Its length is the hop count plus one. */
  readonly visited: readonly string[]
  readonly hops: readonly Hop[]
  readonly final: Hop
}

async function walk(path: string, limit = 5): Promise<Walk> {
  const hops: Hop[] = []
  const visited: string[] = [path]
  let next = `${BASE}${path}`
  for (let step = 0; step < limit; step += 1) {
    const response = await fetch(next, { redirect: 'manual' })
    const location = response.headers.get('location')
    const hop: Hop = { status: response.status, location }
    if (response.status < 300 || response.status >= 400 || location === null) {
      return { visited, hops, final: hop }
    }
    hops.push(hop)
    const url = new URL(location, BASE)
    visited.push(`${url.pathname}${url.search}`)
    next = url.toString()
  }
  throw new Error(`${path} did not settle within ${limit} hops: ${JSON.stringify(hops)}`)
}

/** Where a walk ended up, as a path. */
function destination(result: Walk): string {
  return result.visited[result.visited.length - 1] ?? ''
}

/**
 * Every document path the registry claims, in both locales, as a path that can actually be fetched.
 *
 * `samplePathFor` substitutes a route's sample params, because a document with a dynamic segment has no path
 * of its own: walking `/treatments/[slug]` would assert the normalisation rules against a 404 and the
 * "canonical path is left alone" control would fail on a page that does not exist. W-SITE-05's treatment page
 * is the first such document, and its sample slug is a seeded catalogue row.
 */
const DOCUMENT_PATHS: readonly string[] = routePaths()
  .filter((entry) => entry.route.kind === 'document')
  .map((entry) => (entry.locale === null ? entry.path : samplePathFor(entry.route, entry.locale)))

/**
 * The spellings the proxy owns: wrong case, a trailing slash, or both.
 *
 * Generated from the registry rather than typed, so a route added tomorrow is asserted in every shape
 * without anybody remembering to add it. The root has none of its own — no letters to mis-case, and its
 * trailing slash is the path.
 */
function proxyVariantsOf(path: string): readonly string[] {
  if (path === '/') return []
  const upper = path.toUpperCase()
  return [`${path}/`, upper, `${upper}/`]
}

/**
 * The spellings Next normalises before any application code runs.
 *
 * `resolve-routes.js` collapses repeated slashes with an unconditional 308 the moment the request URL
 * contains one, and 16.3.5 has no configuration for it. So a doubled slash is always Next's hop, and one
 * that *also* has the wrong case is Next's 308 followed by the proxy's 301 — two permanent hops to the
 * canonical URL. Asserted as what it is rather than described as one hop.
 */
function collapsedVariantsOf(path: string): readonly string[] {
  if (path === '/') return ['//', '///']
  return [`/${path}`, `${path}//`, `/${path.toUpperCase()}//`]
}

describe('acceptance — every non-canonical spelling reaches the canonical path in one 301 hop', () => {
  it('normalises case and trailing slashes for every registry document, in one 301', async () => {
    for (const path of DOCUMENT_PATHS) {
      for (const variant of proxyVariantsOf(path)) {
        const result = await walk(variant)
        expect(result.hops, `${variant}: expected exactly one hop`).toHaveLength(1)
        expect(result.hops[0]?.status, `${variant}: status`).toBe(301)
        expect(destination(result), `${variant}: destination`).toBe(path)
        // The 200 at the end is the other half of "one hop to a 200": a redirect to a 404 is not a
        // normalisation, it is a broken link with a permanent status.
        expect(result.final.status, `${variant}: final status`).toBe(200)
        expect(result.final.location, `${variant}: the destination redirected again`).toBeNull()
      }
    }
  }, 120_000)

  it('collapses a doubled slash in Next own 308 and still lands on the canonical path', async () => {
    for (const path of DOCUMENT_PATHS) {
      for (const variant of collapsedVariantsOf(path)) {
        const result = await walk(variant)
        // Next's normalisation is first and is not ours. Asserting its status here is what documents the
        // boundary: everything after this hop is the proxy's, and there is at most one of those.
        expect(result.hops[0]?.status, `${variant}: Next collapses repeated slashes`).toBe(308)
        expect(
          result.hops.length,
          `${variant}: at most Next's hop and then ours`,
        ).toBeLessThanOrEqual(2)
        for (const hop of result.hops) {
          expect([301, 308], `${variant}: every hop is permanent`).toContain(hop.status)
        }
        expect(destination(result), `${variant}: destination`).toBe(path)
        expect(result.final.status, `${variant}: final status`).toBe(200)
        // Zero loops: no URL is visited twice, which is the property a chain of normalisations breaks
        // even when every individual hop looks right.
        expect(new Set(result.visited).size, `${variant}: revisited a URL`).toBe(
          result.visited.length,
        )
      }
    }
  }, 120_000)

  it('leaves a canonical path alone — zero hops, not one', async () => {
    // The control for the case above and the loop check in one: if the proxy redirected a canonical
    // path, every assertion above would still pass with two hops and the site would be in a loop.
    for (const path of DOCUMENT_PATHS) {
      const result = await walk(path)
      expect(result.hops, `${path} redirected`).toEqual([])
      expect(result.final.status, path).toBe(200)
    }
  }, 60_000)

  it('carries the query string across, because attribution lives in it', async () => {
    const result = await walk('/Kitchen-Sink/?utm_source=gbp&utm_campaign=map')
    expect(result.hops).toHaveLength(1)
    expect(destination(result)).toBe('/kitchen-sink?utm_source=gbp&utm_campaign=map')
  }, 30_000)

  it('normalises the acceptance criterion literal paths, which are W-SITE-05s routes', async () => {
    // These three used to end on a 404: `/treatments` did not exist, and the test asserted the hop count
    // and the destination rather than the 200. W-SITE-05 landed the route, so the destination now answers —
    // which is what the loops above assert for every document, and this case keeps the criterion's literal
    // spellings covered by name.
    for (const variant of ['/Treatments/', '/treatments/', '/tReAtMeNtS']) {
      const result = await walk(variant)
      expect(result.hops, variant).toHaveLength(1)
      expect(result.hops[0]?.status, variant).toBe(301)
      expect(destination(result), variant).toBe(canonicalPath(variant))
      expect(result.final.location, `${variant}: chained`).toBeNull()
      expect(result.final.status, variant).toBe(200)
    }
    // `/treatments//x`, the third literal in the criterion, is Next's 308 rather than the proxy's 301:
    // repeated slashes are collapsed before any application code runs. One permanent hop, no chain.
    const doubled = await walk('/treatments//x')
    expect(doubled.hops).toHaveLength(1)
    expect(doubled.hops[0]?.status).toBe(308)
    expect(destination(doubled)).toBe('/treatments/x')
    // And the mixed-case spelling of the same shape: two permanent hops, one each, to the canonical path.
    const mixed = await walk('/TREATMENTS//X/')
    expect(mixed.hops.map((hop) => hop.status)).toEqual([308, 301])
    expect(destination(mixed)).toBe('/treatments/x')
    expect(new Set(mixed.visited).size).toBe(mixed.visited.length)
  }, 30_000)
})

describe('acceptance — the proxy does not touch the CMS, the API or the build output', () => {
  it('does not normalise a mis-cased admin or API path', async () => {
    // Next 16 runs the proxy on *every* request, the admin's included. An unconditional case
    // normalisation here would lowercase a Payload document id and 404 a row that exists, and would
    // redirect a POST to `/API/v1/otp` into a GET. So the exemption is matched case-insensitively and
    // these paths are Next's own 404s rather than our 301s.
    for (const path of ['/Admin', '/ADMIN/collections/pages', '/CMS-API/pages', '/API/v1/otp']) {
      const result = await walk(path)
      expect(result.hops, `${path} was redirected by the proxy`).toEqual([])
    }
  }, 30_000)

  it('still redirects a public path of the same shape', async () => {
    // The control. Without it the assertion above is satisfied by a proxy that does nothing at all.
    const result = await walk('/Kitchen-Sink')
    expect(result.hops).toHaveLength(1)
    expect(result.hops[0]?.status).toBe(301)
  }, 30_000)

  it('leaves the admins own robots header in place', async () => {
    // `next.config.ts` serves this one, and the proxy must neither remove it nor double it.
    const response = await fetch(`${BASE}/admin`, { redirect: 'manual' })
    expect(response.status, 'the proxy redirected /admin').not.toBe(301)
    expect(response.headers.get(ROBOTS_HEADER)).toBe(CMS_ROBOTS_TAG)
  }, 30_000)
})

describe('acceptance — every admin route and /analytics is noindex, and no public route is', () => {
  it('serves the header on the admin group, including a route that does not exist yet', async () => {
    // `/analytics` is A-FIRST-10's and currently a 404 — which is the point of a *header*: it arrives on
    // the 404 today and on the dashboard the day it lands, with nothing to remember.
    for (const path of [
      '/analytics',
      '/analytics/funnel',
      '/settings/integrations/google/connect',
      '/kitchen-sink',
      '/ar/kitchen-sink',
    ]) {
      const response = await fetch(`${BASE}${path}`, { redirect: 'manual' })
      expect(response.headers.get(ROBOTS_HEADER), path).toBe(NOINDEX_ROBOTS_TAG)
    }
  }, 60_000)

  it('serves it on no public route', async () => {
    // The control, and the most expensive one-line mistake available in this unit: a prefix of `/` would
    // satisfy the case above and noindex the whole site.
    for (const path of ['/', '/ar']) {
      const response = await fetch(`${BASE}${path}`, { redirect: 'manual' })
      expect(response.headers.get(ROBOTS_HEADER), path).toBeNull()
    }
  }, 30_000)

  it('is absent from the JSON API, which the proxy is exempt from', async () => {
    // Stated rather than left implicit: `/api/v1/otp` is POST-only and exempt, so it gets no header from
    // the proxy. `registry.test.ts` asserts that every non-indexable route is either covered by a prefix
    // or exempt, so this gap is enumerated rather than accidental.
    const response = await fetch(`${BASE}/api/v1/otp`, { redirect: 'manual' })
    expect(response.headers.get(ROBOTS_HEADER)).toBeNull()
  }, 30_000)
})

interface HeadLinks {
  readonly lang: string | null
  readonly dir: string | null
  readonly canonical: string | null
  readonly alternates: Readonly<Record<string, string>>
}

async function headLinks(path: string): Promise<HeadLinks> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    return await page.evaluate(() => {
      const alternates: Record<string, string> = {}
      for (const link of document.querySelectorAll('link[rel="alternate"][hreflang]')) {
        const hreflang = link.getAttribute('hreflang')
        const href = link.getAttribute('href')
        if (hreflang !== null && href !== null) alternates[hreflang] = href
      }
      return {
        lang: document.documentElement.getAttribute('lang'),
        dir: document.documentElement.getAttribute('dir'),
        canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
        alternates,
      }
    })
  } finally {
    await context.close()
  }
}

describe('acceptance — EN at / and AR at /ar, with a reciprocal self-referential hreflang set', () => {
  it('declares the right lang and dir per locale', async () => {
    for (const locale of LOCALES) {
      const head = await headLinks(localisedPath('/', locale))
      expect(head.lang, locale).toBe(locale)
      expect(head.dir, locale).toBe(directionFor(locale))
      // The codes have to be the same string: a document that says `lang="ar"` and an alternate that
      // says `hreflang="ar-AE"` are two claims about one page that nothing reconciles.
      expect(head.alternates[hreflangFor(locale)], locale).toBeDefined()
    }
  }, 60_000)

  it('emits the whole set on every registry document, in both locales', async () => {
    for (const route of documentRoutes()) {
      const heads = new Map<Locale, HeadLinks>()
      const params = sampleParamsOf(route)
      for (const locale of route.locales) {
        const path = samplePathFor(route, locale)
        const head = await headLinks(path)
        heads.set(locale, head)

        const expected = alternatesFor(route.id, locale, params)
        // Enumerated: the whole map, compared as a map, so an extra or a missing hreflang fails. A
        // `toContain` here would pass on a set that had lost a locale.
        expect(head.alternates, path).toEqual(expected.languages)
        expect(head.canonical, path).toBe(expected.canonical)
        // Self-referential. A set that lists only the other locale is discarded by Google entirely.
        expect(Object.values(head.alternates), path).toContain(expected.canonical)
        expect(head.alternates[hreflangFor(locale)], path).toBe(expected.canonical)
        expect(head.alternates[HREFLANG_DEFAULT], path).toBe(
          alternatesFor(route.id, DEFAULT_LOCALE, params).canonical,
        )
      }

      // Reciprocal: both documents carry the same set of alternates.
      const sets = [...heads.values()].map((head) => head.alternates)
      for (const set of sets) expect(set).toEqual(sets[0])
      // The control: the two canonicals are *not* the same URL. A copy-paste that pointed both documents
      // at the English one would satisfy every assertion above.
      const canonicals = [...heads.values()].map((head) => head.canonical)
      expect(new Set(canonicals).size, route.id).toBe(route.locales.length)
    }
  }, 120_000)

  it('advertises only URLs that answer 200 without redirecting', async () => {
    // The agreement between the two halves of this unit: an alternate or a canonical that 301s is a page
    // telling a crawler to ignore what it just said. Every advertised URL is fetched.
    for (const route of documentRoutes()) {
      for (const locale of route.locales) {
        const head = await headLinks(samplePathFor(route, locale))
        for (const href of [head.canonical, ...Object.values(head.alternates)]) {
          expect(href).not.toBeNull()
          if (href === null) continue
          const url = new URL(href)
          expect(url.pathname, href).toBe(canonicalPath(url.pathname))
          const advertised = await walk(url.pathname)
          expect(advertised.hops, `${href} redirected`).toEqual([])
          expect(advertised.final.status, href).toBe(200)
        }
      }
    }
  }, 120_000)
})

describe('acceptance — the Arabic document is genuinely mirrored', () => {
  interface Column {
    /** Physical offset of the column's left edge from the grid's left edge, in rem. */
    readonly fromLeft: number
    readonly width: number
  }

  interface Mirror {
    readonly direction: string
    readonly gridWidth: number
    /** The 12rem column, which the template puts on the inline-start side. */
    readonly narrow: Column
    /** The 20rem column, on the inline-end side. */
    readonly wide: Column
  }

  /**
   * Measures where the editorial grid's two asymmetric columns actually are.
   *
   * By probe elements placed on the grid's *named lines* rather than by reading
   * `getComputedStyle(grid).gridTemplateColumns`: the computed value lists tracks in logical order, which
   * is identical in both directions and therefore says nothing at all about mirroring. A probe spanning
   * `wide-start / measure-start` is the 12rem column — the one on the inline-start side — and its bounding
   * box is where the engine actually put it.
   */
  async function mirrorOf(path: string): Promise<Mirror> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    try {
      const page = await context.newPage()
      await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      return await page.evaluate(() => {
        const grid = document.querySelector('.be-grid')
        if (grid === null) throw new Error('no .be-grid on the page')
        const probe = (gridColumn: string): HTMLElement => {
          const element = document.createElement('div')
          element.style.cssText = `grid-column: ${gridColumn}; block-size: 4px`
          grid.appendChild(element)
          return element
        }
        // Both line names come from `EDITORIAL_GRID_TEMPLATE`: the 12rem column lies between
        // `wide-start` and `measure-start`, the 20rem column between `measure-end` and `wide-end`.
        const narrowProbe = probe('wide-start / measure-start')
        const wideProbe = probe('measure-end / wide-end')
        const gridRect = grid.getBoundingClientRect()
        const narrowRect = narrowProbe.getBoundingClientRect()
        const wideRect = wideProbe.getBoundingClientRect()
        narrowProbe.remove()
        wideProbe.remove()
        // In rem, because `theme/arabic.css` recalibrates the root font size: the same layout is a
        // different number of pixels wide in Arabic, and 12rem is 12rem in both.
        const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
        return {
          direction: getComputedStyle(grid).direction,
          gridWidth: gridRect.width / rem,
          narrow: {
            fromLeft: (narrowRect.left - gridRect.left) / rem,
            width: narrowRect.width / rem,
          },
          wide: { fromLeft: (wideRect.left - gridRect.left) / rem, width: wideRect.width / rem },
        }
      })
    } finally {
      await context.close()
    }
  }

  /** The gap between a column's outer edge and the nearest edge of the grid: the 1fr gutter track. */
  function gapLeft(column: Column): number {
    return column.fromLeft
  }

  function gapRight(measured: Mirror, column: Column): number {
    return measured.gridWidth - (column.fromLeft + column.width)
  }

  it('puts the grids inline-start column on the right in Arabic and on the left in English', async () => {
    const arabic = await mirrorOf('/ar')
    const english = await mirrorOf('/')

    expect(arabic.direction).toBe('rtl')
    expect(english.direction).toBe('ltr')

    // The probes really are the 12rem and 20rem columns. Without this the ordering assertions below would
    // hold for any two boxes in any layout.
    for (const measured of [arabic, english]) {
      expect(measured.narrow.width).toBeCloseTo(12, 0)
      // `minmax(0, 20rem)` collapses rather than squeezing the measure, so at 1440px the inline-end
      // column sits a little under its maximum once the measure has taken its 68 characters —
      // `kitchen-sink.itest.ts` asserts the same track as `<= 320.5px`. What identifies the two probes is
      // the asymmetry itself: the inline-end column is the wider one.
      expect(measured.wide.width).toBeLessThanOrEqual(20.05)
      expect(measured.wide.width).toBeGreaterThan(measured.narrow.width)
    }

    // The claim, twice. The inline-start column is physically to the right of the inline-end one in the
    // Arabic document and to the left of it in the English one...
    expect(arabic.narrow.fromLeft).toBeGreaterThan(arabic.wide.fromLeft)
    expect(english.narrow.fromLeft).toBeLessThan(english.wide.fromLeft)
    // ...and it is against the right-hand gutter, not merely further along: the gap outside it is the
    // gutter track, which is the same width as the gutter outside the 20rem column at the other end.
    expect(gapRight(arabic, arabic.narrow)).toBeLessThan(gapLeft(arabic.narrow))
    expect(gapRight(arabic, arabic.narrow)).toBeCloseTo(gapLeft(arabic.wide), 1)
    // The control, in the document that must not be mirrored.
    expect(gapLeft(english.narrow)).toBeLessThan(gapRight(english, english.narrow))
    expect(gapLeft(english.narrow)).toBeCloseTo(gapRight(english, english.wide), 1)
  }, 60_000)

  it('flips a directional icon by transform, not by moving it', async () => {
    async function iconTransform(path: string): Promise<string> {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      try {
        const page = await context.newPage()
        await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
        return await page.evaluate(() => {
          const icon = document.querySelector('.be-icon[data-icon-mirror="true"]')
          if (icon === null) throw new Error('no directional icon on the page')
          return getComputedStyle(icon).transform
        })
      } finally {
        await context.close()
      }
    }

    const arabic = await iconTransform('/ar/kitchen-sink')
    const english = await iconTransform('/kitchen-sink')
    const parts = /matrix\(([^)]+)\)/.exec(arabic)?.[1]?.split(',').map(Number.parseFloat) ?? []
    expect(parts, `unexpected transform: ${arabic}`).toHaveLength(6)
    // `scaleX(-1)`: the horizontal scale is negated, so the glyph is drawn mirrored. A page that nudged
    // the icon instead would report a translation here and an unchanged scale — which is the failure the
    // criterion names, and it is invisible in a screenshot of a symmetrical glyph.
    expect(parts[0]).toBe(-1)
    expect(parts[3]).toBe(1)
    expect(parts[4], 'mirrored by translation rather than by scale').toBe(0)
    expect(parts[5]).toBe(0)
    // The control: the same component in the English document is not transformed at all.
    expect(english).toBe('none')
  }, 60_000)
})

describe('acceptance — the registry agrees with what the build produced', () => {
  function manifest<T>(name: string): T {
    return JSON.parse(readFileSync(join(APP_DIR, '.next', name), 'utf8')) as T
  }

  it('serves exactly the registrys paths, and nothing else', () => {
    // `app-path-routes-manifest.json` is Next's own resolution of the app directory — route groups
    // collapsed, dynamic segments spelled its way. Comparing the registry with it is a control on the
    // directory walk in `routes/discover.ts`: a scanner bug that dropped a route would make the unit
    // bijection pass and this fail.
    const routes = manifest<Record<string, string>>('app-path-routes-manifest.json')
    const served = [...new Set(Object.values(routes))]
      .filter((path) => !isCmsRoute(path))
      // `/_not-found` and `/_global-error` are framework internals with no file in `app/`: Next
      // synthesises them, they are not addressable, and they are not the site's routes.
      .filter((path) => !path.startsWith('/_'))
      .sort()
    expect(served).toEqual([...registryPaths()].sort())
  })

  it('prerendered exactly the routes declared static or isr, and the params of the parameterised one', () => {
    const prerender = manifest<{ routes: Record<string, unknown> }>('prerender-manifest.json')
    const prerendered = new Set(Object.keys(prerender.routes))
    // The control: the manifest is not empty, so "declared dynamic, absent from it" cannot pass because
    // nothing was prerendered.
    expect(prerendered.has('/')).toBe(true)
    for (const { path, route } of routePaths()) {
      if (isParameterised(path)) {
        // A route with a dynamic segment is prerendered as its `generateStaticParams`, so the manifest holds
        // its concrete paths and never the pattern. The catalogue decides how many, so the assertion is the
        // shape rather than a count: at least one path under this prefix, and the pattern itself absent.
        expect(prerendered.has(path), `${path} is a pattern and cannot be prerendered`).toBe(false)
        // Only a document prerenders params. The portrait handler is `dynamic` and reads bytes off disk per
        // request, so "no concrete path under its prefix" is the correct state rather than a missing build.
        if (route.kind !== 'document' || route.rendering === 'dynamic') continue
        const prefix = path.slice(0, path.indexOf('['))
        const concrete = [...prerendered].filter(
          (entry) => entry.startsWith(prefix) && !entry.includes('['),
        )
        expect(
          concrete.length,
          `${path} is declared ${route.rendering} and prerendered no params. These routes read the ` +
            'catalogue at build time: the database must be migrated and seeded before `next build`.',
        ).toBeGreaterThan(0)
        continue
      }
      // `isr` is prerendered exactly as `static` is — the difference is that it was built from the database
      // and is replaced by on-demand revalidation, not that it is built later. Written as "not dynamic"
      // rather than as the two-way disjunction it used to be: W-SITE-04 made `home` the last `static` route
      // `isr`, so `rendering === 'static'` became a comparison the compiler can prove is never true, and a
      // condition that can never hold is a condition that has stopped saying anything.
      expect(prerendered.has(path), `${path} is declared ${route.rendering}`).toBe(
        route.rendering !== 'dynamic',
      )
    }
  })

  it('prerendered one treatment path per published service, in both locales', () => {
    // The number the acceptance criterion names — 8 (style x treatment) services — read off what the build
    // produced rather than counted by hand, and 16 documents because each is served in two locales. A count
    // that drifted from the catalogue would mean `generateStaticParams` had read something else.
    const prerender = manifest<{ routes: Record<string, unknown> }>('prerender-manifest.json')
    const treatmentPaths = Object.keys(prerender.routes).filter((path) =>
      /^(\/ar)?\/treatments\/[a-z0-9-]+$/.test(path),
    )
    const english = treatmentPaths.filter((path) => !path.startsWith('/ar/'))
    const arabic = treatmentPaths.filter((path) => path.startsWith('/ar/'))
    expect(english.length, english.join(', ')).toBe(8)
    expect(arabic.map((path) => path.replace('/ar', '')).sort()).toEqual([...english].sort())
  })
})

describe('acceptance — the screenshot harness reads the registry', () => {
  function localeFor(direction: Direction): Locale {
    const locale = LOCALES.find((candidate) => directionFor(candidate) === direction)
    if (locale === undefined) throw new Error(`No locale renders ${direction}`)
    return locale
  }

  async function capture(target: CaptureTarget, path: string): Promise<Uint8Array> {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: target.viewport.width, height: target.viewport.height },
      deviceScaleFactor: target.viewport.scale,
      colorScheme: target.theme,
      locale: target.direction === 'rtl' ? 'ar-AE' : 'en-AE',
      timezoneId: 'Asia/Dubai',
      reducedMotion: 'reduce',
    })
    try {
      await context.addInitScript({
        content: 'globalThis.__name = globalThis.__name || ((f) => f)',
      })
      // The theme is set the way the product sets it: the key the blocking bootstrap script in
      // `app/_document/shell.tsx` reads, on the context, before any page exists.
      await context.addInitScript(
        ({ value }: { value: string }) => {
          globalThis.localStorage.setItem('berelax:theme', value)
        },
        { value: target.theme },
      )
      const page: Page = await context.newPage()
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      // The render is the cell it claims to be. Without this, twelve identical light LTR captures at one
      // viewport would satisfy the count and the filenames would be the only thing that differed.
      const state = await page.evaluate(() => ({
        theme: document.documentElement.getAttribute('data-theme'),
        dir: document.documentElement.getAttribute('dir'),
        lang: document.documentElement.getAttribute('lang'),
        width: window.innerWidth,
      }))
      expect(state.theme, path).toBe(target.theme)
      expect(state.dir, path).toBe(target.direction)
      expect(state.width, path).toBe(target.viewport.width)
      return await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' })
    } finally {
      await context.close()
    }
  }

  it('captures every registry route at 3 viewports x 2 themes x 2 directions', async () => {
    const documents = documentRoutes()
    const plan = capturePlan(documents.map((route) => route.id))
    // Stated rather than counted after the fact: a matrix that lost an axis would otherwise report a
    // pass over eight cells per route.
    expect(VIEWPORTS).toHaveLength(3)
    expect(THEMES).toHaveLength(2)
    expect(DIRECTIONS).toHaveLength(2)
    expect(plan).toHaveLength(documents.length * 12)

    mkdirSync(SCREENS, { recursive: true })
    const written: string[] = []
    for (const target of plan) {
      const route = documents.find((candidate) => candidate.id === target.page)
      expect(route, target.page).toBeDefined()
      if (route === undefined) continue
      // The direction axis is the locale: an RTL cell is the Arabic document at that URL, not the
      // English one with an attribute flipped. `app/_document/shell.tsx` explains why that distinction
      // is the whole reason there are two root layouts.
      //
      // `samplePathFor`, not the route's path: a document with a dynamic segment has no path of its own, and
      // photographing `/treatments/[slug]` captured a 404 page whose `<html>` carries no theme attribute —
      // which is how this failed rather than silently filing a picture of an error page.
      const path = samplePathFor(route, localeFor(target.direction))
      const png = await capture(target, path)
      expect(png.byteLength, `${target.page} ${target.viewport.name}`).toBeGreaterThan(1000)
      const filename = captureFilename(target)
      writeFileSync(join(SCREENS, filename), png)
      written.push(filename)
    }

    // Named, not counted: `missingCaptures` reports which cell is absent, and a route added to the
    // registry without a capture fails here rather than quietly never being looked at.
    expect(missingCaptures(plan, written)).toEqual([])
    // 780s rather than 420s since W-SITE-07: the registry gained five more documents, so the matrix is 132
    // cells rather than 72 — eleven documents at twelve cells each. The budget is for the matrix, not for one
    // page, and it is raised in proportion rather than by guesswork.
    //
    // 420s rather than 300s since W-SITE-05: the registry gained three documents, so the matrix is 72 cells
    // rather than 24 — six documents at twelve cells each, about two seconds per cell on a loaded box where
    // several worktrees run this suite at once. The budget is for the matrix, not for one page.
    //
    // 850s rather than 780s since B-UI-01: the registry gained `/book`, so the matrix is 144 cells rather
    // than 132. Raised in proportion to the twelve cells added rather than by guesswork.
  }, 850_000)
})
