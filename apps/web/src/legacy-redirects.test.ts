import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LEGACY_BASELINE, normaliseLegacyPath, resolveLegacyRedirect } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { localeOf, localisedPath, neutralPath } from './i18n/locales.ts'
import { canonicalPath } from './routes/canonical.ts'
import { registryPaths } from './routes/registry.ts'

/**
 * What `proxy.ts` does with a retired WooCommerce URL, as a table.
 *
 * `proxy()` itself needs a `NextRequest`, which a unit test in this application cannot build — `next/
 * server` is not importable from vitest here. What CAN be unit-tested is the decision, and the decision
 * is three composed functions: `canonicalPath`, then `neutralPath` to find the row, then `localisedPath`
 * to put the locale prefix back. This file asserts that composition over the cases the acceptance
 * criterion names, and `public-site.itest.ts` asserts the served status and `location` for the same
 * paths.
 *
 * The composition is written out here rather than exported from `proxy.ts`, and that is a deliberate
 * second statement: `proxy.ts` must stay importable by Next's edge runtime, which means no import of
 * anything that reaches a database — and a module exporting the decision would be one more thing that
 * could acquire such an import. The two are held equal by the integration suite, which drives the real
 * proxy.
 */

/** The three steps `proxy.ts` composes, in its order. */
function destinationFor(requested: string): string | null {
  const canonical = canonicalPath(requested)
  const retired = resolveLegacyRedirect(neutralPath(canonical))
  if (retired === null) return null
  return localisedPath(retired.target, localeOf(canonical))
}

describe('a retired WooCommerce URL redirects once, keeping its locale prefix', () => {
  const cases: readonly {
    readonly name: string
    readonly requested: string
    readonly destination: string | null
  }[] = [
    {
      name: 'the live site spelling, with its trailing slash',
      requested: '/product-category/arabic-massage-abu-dhabi/',
      destination: '/treatments',
    },
    {
      name: 'a product URL, to the treatment page about the same thing',
      requested: '/product/asian-normal-massage',
      destination: '/treatments/asian-normal-massage',
    },
    {
      name: 'the Arabic tree stays in the Arabic tree',
      requested: '/ar/product/asian-normal-massage',
      destination: '/ar/treatments/asian-normal-massage',
    },
    {
      name: 'an Arabic category page',
      requested: '/ar/product-tag/spa-abu-dhabi/',
      destination: '/ar/treatments',
    },
    {
      name: 'wrong case, which proxy.ts canonicalises before asking',
      requested: '/Product-Tag/Spa-Abu-Dhabi',
      destination: '/treatments',
    },
    {
      name: 'a page this site serves is not redirected',
      requested: '/treatments',
      destination: null,
    },
    { name: 'a path nothing knows about', requested: '/product/never-sold', destination: null },
    { name: 'the home page', requested: '/', destination: null },
  ]

  for (const entry of cases) {
    it(entry.name, () => {
      expect(destinationFor(entry.requested)).toBe(entry.destination)
    })
  }

  it('sends every baseline path to a destination, in both locales', () => {
    // The control that makes the table above non-vacuous: all twelve rows resolve, not just the five
    // spelled out.
    for (const row of LEGACY_BASELINE) {
      expect(destinationFor(row.source), row.source).toBe(row.target)
      expect(destinationFor(`/ar${row.source}`), `/ar${row.source}`).toBe(
        localisedPath(row.target, 'ar'),
      )
    }
  })

  it('never redirects a path the registry serves', () => {
    /*
      The invariant that keeps the map from shadowing the site. 0029 refuses a `redirect_map` row whose
      source is a live treatment page by name (`redirect_source_still_live`), and this is the same claim
      over the committed module — where there is no trigger to make it. A row shadowing a served path
      would be a page that 301s away from itself, and the symptom is a page that "disappeared" with
      nothing in the route code to explain it.
    */
    for (const path of registryPaths()) {
      if (path.includes('[')) continue
      expect(destinationFor(path), path).toBeNull()
    }
  })

  it('drops the query string from the LOOKUP and keeps it on the redirect', () => {
    // `normaliseLegacyPath` strips it, so `?utm_source=` cannot stop a row matching; `proxy.ts` replaces
    // only the pathname of the URL that arrived, so the parameter survives the hop. A campaign parameter
    // is how traffic on a retired URL is attributed, and dropping it turns a tracked visit into direct
    // traffic silently.
    expect(normaliseLegacyPath('/product/asian-normal-massage?utm_source=ig')).toBe(
      '/product/asian-normal-massage',
    )
    expect(resolveLegacyRedirect('/product/asian-normal-massage?utm_source=ig')?.target).toBe(
      '/treatments/asian-normal-massage',
    )
  })
})

describe('proxy.ts is what serves the map', () => {
  /*
    A source scan, and it is here for the same reason `therapist-guard.test.ts` is a scan: the thing being
    checked is that a layer EXISTS, and only a request can see a layer's effect — which this application's
    unit tests cannot make, because `next/server` is not importable from vitest here. The served status
    and `location` are asserted in `public-site.itest.ts`, which drives the built application; this is the
    half that fails in four seconds when the layer is deleted, rather than after a build.

    It asserts the three functions AND their order. The order is the load-bearing part: asking before
    canonicalisation would need a row per casing, and putting the locale prefix back after resolving is
    what keeps `/ar/...` under `/ar/...`.
  */
  const proxySource = readFileSync(join(import.meta.dirname, '..', 'proxy.ts'), 'utf8')

  it('resolves the legacy map from the committed module, after canonicalising', () => {
    expect(proxySource).toContain('resolveLegacyRedirect')
    expect(proxySource).toContain('neutralPath(canonical)')
    // After canonicalisation: the lookup appears later in the file than the canonical redirect.
    const canonicalised = proxySource.indexOf('const canonical = canonicalPath(pathname)')
    const resolved = proxySource.indexOf('resolveLegacyRedirect(neutralPath(canonical))')
    expect(canonicalised).toBeGreaterThan(-1)
    expect(resolved).toBeGreaterThan(canonicalised)
  })

  it('puts the locale prefix back on the destination', () => {
    expect(proxySource).toContain('localisedPath(retired.target, locale)')
  })

  it('reaches no database, which is why the map is a committed module at all', () => {
    // The constraint that decided the design. A proxy that imported a connection would be a proxy that
    // cannot run on the edge, and the symptom is a build error in a file nobody changed.
    for (const forbidden of ['@berelax/db', 'createConnection', 'postgres']) {
      expect(proxySource, forbidden).not.toContain(`'${forbidden}'`)
    }
  })
})
