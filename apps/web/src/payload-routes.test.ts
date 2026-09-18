import { CMS_ROBOTS_TAG, CMS_ROUTE_PREFIXES, cmsRoutesIn, isCmsRoute } from '@berelax/cms'
import { describe, expect, it } from 'vitest'
import nextConfig from '../next.config.ts'

/**
 * W-SYS-08 — the admin is noindex, and it is not part of the public site.
 *
 * Asserted against the real `next.config.ts` object rather than against its source text: the claim is
 * that the running app serves the header, and a grep for the string would pass on a rule inside a
 * commented-out block. `apps/web/src/payload.itest.ts` closes the loop by reading the header off a live
 * response; this is the enumeration — every prefix, with a control that a public path is untouched.
 */

/** Next's `source` syntax, reduced to the two forms this config uses. */
function sourceMatches(source: string, pathname: string): boolean {
  const pattern = source
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '')
    .replace(/:\w+/g, '.*')
  return new RegExp(`^${pattern}$`).test(pathname)
}

interface HeaderRule {
  readonly source: string
  readonly headers: readonly { readonly key: string; readonly value: string }[]
}

async function headerRules(): Promise<readonly HeaderRule[]> {
  const headers = nextConfig.headers
  expect(typeof headers, 'next.config.ts declares no headers()').toBe('function')
  if (typeof headers !== 'function') return []
  return (await headers()) as readonly HeaderRule[]
}

function robotsTagFor(rules: readonly HeaderRule[], pathname: string): string | null {
  for (const rule of rules) {
    if (!sourceMatches(rule.source, pathname)) continue
    const header = rule.headers.find((entry) => entry.key.toLowerCase() === 'x-robots-tag')
    if (header !== undefined) return header.value
  }
  return null
}

describe('acceptance — every CMS route returns x-robots-tag: noindex', () => {
  it('covers each prefix and each path under it', async () => {
    const rules = await headerRules()
    // Enumerated from `CMS_ROUTE_PREFIXES`, so a new prefix with no rule fails this test rather than
    // quietly becoming indexable.
    for (const prefix of CMS_ROUTE_PREFIXES) {
      expect(robotsTagFor(rules, prefix), prefix).toBe(CMS_ROBOTS_TAG)
      expect(robotsTagFor(rules, `${prefix}/collections/pages`), prefix).toBe(CMS_ROBOTS_TAG)
    }
  })

  it('leaves the public site alone', async () => {
    // The control. A rule matching `/:path*` would satisfy the case above and noindex the entire site —
    // which is the single most expensive one-line mistake available in this file.
    const rules = await headerRules()
    for (const path of [
      '/',
      '/spa',
      '/journal/first-post',
      '/ar',
      '/api/facts',
      '/administration',
    ]) {
      expect(robotsTagFor(rules, path), path).toBeNull()
    }
  })

  it('serves all three directives', async () => {
    const rules = await headerRules()
    const value = robotsTagFor(rules, '/admin') ?? ''
    expect(value).toContain('noindex')
    expect(value).toContain('nofollow')
    expect(value).toContain('noarchive')
  })

  it('does not advertise the framework', async () => {
    // `withPayload` adds an `X-Powered-By: Next.js, Payload` header unless `poweredByHeader` is already
    // false. It is, and this is the assertion that keeps it that way: naming the CMS and its version in
    // every response is free reconnaissance.
    expect(nextConfig.poweredByHeader).toBe(false)
    const rules = await headerRules()
    const advertised = rules.flatMap((rule) =>
      rule.headers.filter((header) => header.key.toLowerCase() === 'x-powered-by'),
    )
    expect(advertised).toEqual([])
  })
})

describe('acceptance — the CMS is absent from the public route registry', () => {
  /**
   * The registry itself is W-SITE-01's and does not exist yet.
   *
   * What exists here is the contract it has to honour, as a function it can call: `cmsRoutesIn` over the
   * registry's paths must be empty. Asserting it from this side means the exclusion is written down once,
   * in `@berelax/cms`, rather than as a second list in W-SITE-01 and a third in W-SITE-10's sitemap
   * builder.
   */
  it('recognises its own routes and nothing that merely resembles them', () => {
    expect(cmsRoutesIn(['/', '/spa', '/journal', '/api/facts', '/administration'])).toEqual([])
    expect(cmsRoutesIn(['/admin/collections/pages', '/cms-api/pages'])).toEqual([
      '/admin/collections/pages',
      '/cms-api/pages',
    ])
    expect(isCmsRoute('/admin')).toBe(true)
    expect(isCmsRoute('/')).toBe(false)
  })

  it('transpiles @berelax/cms, so the app can read that contract at all', () => {
    // `@berelax/cms` ships TypeScript source like every other workspace package. Without it in
    // `transpilePackages` the build fails on the first type annotation in the content model.
    expect(nextConfig.transpilePackages ?? []).toContain('@berelax/cms')
  })
})
