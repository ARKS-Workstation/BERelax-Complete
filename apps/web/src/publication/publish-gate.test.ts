import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { HOME_BUDGET, homeBudgetLimit } from '../home/budget.ts'
import {
  compliancePolicyOf,
  criticalResourcesIn,
  documentBytes,
  measureCriticalPath,
  type ResourceFetcher,
  transferredBytes,
} from './publish-gate.ts'

/**
 * The publish gate's measurement, without a server.
 *
 * `apps/web/src/publication.itest.ts` drives this against the running application and the real page, which
 * is the only place the figures can be real. What that suite cannot do cheaply is exercise the edges: a
 * `<link rel="icon">` that must not be counted, a resource that 404s, a document that does not render, and
 * the compression rule. Each of those is a way the measurement could silently stop measuring — and a weight
 * check that measures nothing finds every page inside every budget, which is ADR 0002's failure exactly.
 */

/**
 * A document in the shape this application actually emits.
 *
 * Six `<link>` elements, of which four are on the critical path: the stylesheet, the font preload, the
 * script preload and the art-directed image preload. The icon and the DNS hint are not — an icon is fetched
 * after paint and a `preconnect` transfers no bytes — and the `<script>` element is the deferred twin of the
 * preload above it, which is why counting `<script src>` as well would double the framework.
 */
const DOCUMENT = [
  '<!doctype html><html><head>',
  '<link rel="stylesheet" href="/_next/static/css/app.css"/>',
  '<link rel="preload" href="/_next/static/media/plex.woff2" as="font" type="font/woff2" crossorigin=""/>',
  '<link rel="preload" href="/_next/static/chunks/main.js" as="script"/>',
  '<link rel="preload" as="image" imagesrcset="/media/hero-828.avif 828w, /media/hero-1080.avif 1080w" imagesizes="100vw"/>',
  '<link rel="icon" href="/favicon.ico"/>',
  '<link rel="preconnect" href="https://example.test"/>',
  '<style>:root{--x:1px}</style>',
  '</head><body><h1>What to expect on a first visit</h1>',
  '<script src="/_next/static/chunks/main.js" defer=""></script>',
  '</body></html>',
].join('')

describe('the critical set is read out of the document', () => {
  it('takes the stylesheet and every preload, and nothing else', () => {
    expect(criticalResourcesIn(DOCUMENT)).toEqual([
      { href: '/_next/static/css/app.css', kind: 'asset' },
      { href: '/_next/static/media/plex.woff2', kind: 'asset' },
      { href: '/_next/static/chunks/main.js', kind: 'asset' },
      // The art-directed preload has no `href`: the narrowest srcset candidate stands in for it, because
      // docs/08 §8 states the 250KB figure in a mobile column and the phone gets the narrow rung.
      { href: '/media/hero-828.avif', kind: 'image' },
    ])
  })

  it('does not count a resource twice, and skips a data URI', () => {
    const twice = `${DOCUMENT}<link rel="preload" href="/_next/static/css/app.css" as="style"/>`
    expect(criticalResourcesIn(twice).length).toBe(criticalResourcesIn(DOCUMENT).length)
    expect(
      criticalResourcesIn('<link rel="preload" as="image" href="data:image/gif;base64,R0lGOD"/>'),
    ).toEqual([])
  })

  it('finds nothing in a document that declares nothing', () => {
    // The discriminator. Without it a pattern that matched everything and a pattern that matched nothing
    // would both satisfy the case above on this fixture.
    expect(criticalResourcesIn('<html><head><title>x</title></head><body>y</body></html>')).toEqual(
      [],
    )
  })
})

describe('the compression rule', () => {
  it('compresses a document, and a stylesheet, and leaves an image and a font alone', () => {
    expect(documentBytes(DOCUMENT)).toBeLessThan(Buffer.byteLength(DOCUMENT, 'utf8'))
    const css = Buffer.from(':root{--a:1px}'.repeat(400), 'utf8')
    expect(transferredBytes('text/css; charset=utf-8', css)).toBe(
      gzipSync(css, { level: 9 }).length,
    )
    expect(transferredBytes('text/css; charset=utf-8', css)).toBeLessThan(css.length)
    // Already compressed: gzipping an AVIF or a woff2 reports a bigger file than the browser downloads, so
    // the budget would refuse pages for bytes nobody transfers.
    const binary = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 37) % 251))
    expect(transferredBytes('image/avif', binary)).toBe(binary.length)
    expect(transferredBytes('font/woff2', binary)).toBe(binary.length)
    expect(transferredBytes('video/mp4', binary)).toBe(binary.length)
  })
})

/** A fetcher over a fixed map, so the measurement's arithmetic is visible. */
function fetcherOver(
  files: Readonly<Record<string, { readonly contentType: string; readonly body: Buffer }>>,
): ResourceFetcher {
  return async (path: string) => {
    const found = files[path]
    if (found === undefined)
      throw new Error(`[publication-document-unavailable] ${path} answered 404`)
    return found
  }
}

const binary = (length: number): Buffer =>
  Buffer.from(Array.from({ length }, (_, i) => (i * 37) % 251))

describe('the measurement', () => {
  const files = {
    '/about': { contentType: 'text/html', body: Buffer.from(DOCUMENT, 'utf8') },
    '/_next/static/css/app.css': {
      contentType: 'text/css',
      body: Buffer.from(':root{--a:1px}'.repeat(400), 'utf8'),
    },
    '/_next/static/media/plex.woff2': { contentType: 'font/woff2', body: binary(20_000) },
    '/_next/static/chunks/main.js': {
      contentType: 'application/javascript',
      body: Buffer.from('export const x = 1;'.repeat(500), 'utf8'),
    },
    '/media/hero-828.avif': { contentType: 'image/avif', body: binary(90_000) },
  }

  it('sums the document, the assets and the image, each into its own half', async () => {
    const measured = await measureCriticalPath(fetcherOver(files), {
      surface: 'pages/about',
      path: '/about',
    })
    expect(measured.surface).toBe('pages/about')
    expect(measured.documentBytes).toBe(documentBytes(DOCUMENT))
    // The image is its own component, so docs/08 §8's cut order can be applied to the right half: the hero
    // is what an editor changes, and the fonts and stylesheets are not.
    expect(measured.criticalImageBytes).toBe(90_000)
    expect(measured.criticalAssetBytes).toBe(
      transferredBytes('text/css', files['/_next/static/css/app.css'].body) +
        20_000 +
        transferredBytes('application/javascript', files['/_next/static/chunks/main.js'].body),
    )
    // And each part is real, which a total alone would not show.
    expect(measured.documentBytes).toBeGreaterThan(0)
    expect(measured.criticalAssetBytes).toBeGreaterThan(20_000)
  })

  it('counts a missing resource as zero rather than refusing the publish', async () => {
    // A 404 on a preload target is a rendering defect for `hero-lcp.itest.ts` and `pnpm media` to report.
    // Refusing here would attribute it to the weight budget, which sends somebody to look at a photograph.
    const { ['/media/hero-828.avif']: _absent, ...without } = files
    const measured = await measureCriticalPath(fetcherOver(without), {
      surface: 'pages/about',
      path: '/about',
    })
    expect(measured.criticalImageBytes).toBe(0)
    expect(measured.criticalAssetBytes).toBeGreaterThan(0)
  })

  it('throws for a document that does not render, rather than reporting it as weightless', async () => {
    // The direction that matters: a page that will not render must not become the lightest page on the site
    // and therefore the easiest to publish.
    await expect(
      measureCriticalPath(fetcherOver(files), { surface: 'pages/gone', path: '/gone' }),
    ).rejects.toThrow(/publication-document-unavailable/)
  })
})

describe('the budget comes from docs/08 §8’s one statement of it', () => {
  it('is the critical-above-fold limit, on the KiB basis every budget here uses', () => {
    // 250KB, docs/08 §8's mobile column. Asserted against the table AND against the figure, so a mutation
    // that pointed the gate at another metric — `css`, at 25KB — fails, and so would one that quietly
    // rounded the basis from KiB to KB and moved every page 2.4% closer to the edge.
    expect(homeBudgetLimit('critical-above-fold')).toBe(250 * 1024)
    expect(HOME_BUDGET.find((limit) => limit.metric === 'critical-above-fold')?.limit).toBe(
      homeBudgetLimit('critical-above-fold'),
    )
    // The control on the assertion being about a real lookup: another metric answers a different number.
    expect(homeBudgetLimit('css')).not.toBe(homeBudgetLimit('critical-above-fold'))
  })
})

describe('the policy is copied field by field, and nothing is invented', () => {
  it('carries the profile’s three lint inputs and drops the rest', () => {
    const policy = compliancePolicyOf({
      bannedClaimTerms: ['cure', 'clinic'],
      permittedPublicTitles: ['Therapist'],
      medicalClaimsPermitted: false,
      profileVersion: 3,
      licenceClass: 'unconfirmed',
    })
    expect(policy).toEqual({
      bannedClaimTerms: ['cure', 'clinic'],
      permittedPublicTitles: ['Therapist'],
      medicalClaimsPermitted: false,
    })
  })
})
