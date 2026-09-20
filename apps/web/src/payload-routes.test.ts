import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CMS_ROBOTS_TAG, CMS_ROUTE_PREFIXES, cmsRoutesIn, isCmsRoute } from '@berelax/cms'
import { describe, expect, it } from 'vitest'
import nextConfig from '../next.config.ts'
import { assertPayloadSecretConfigured } from '../payload.config.ts'

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

describe('acceptance — only the CMS needs PAYLOAD_SECRET, and both its entry points refuse without it', () => {
  const read = (path: string): string => readFileSync(join('apps', 'web', path), 'utf8')

  /**
   * The two files that can mint a session token.
   *
   * `/admin` is the document and `/cms-api` is the REST API — `/cms-api/users/login` is there, not under
   * `/admin` — so guarding one and not the other would leave a login able to sign a token with the
   * placeholder secret. Source text rather than behaviour, and that is the right level here: the claim is
   * that the call exists at module scope in both files, and calling it in a test would only prove the
   * function works.
   */
  const ENTRY_POINTS = [
    join('app', '(payload)', 'layout.tsx'),
    join('app', '(payload)', 'cms-api', '[...slug]', 'route.ts'),
  ]

  it('asserts the secret in every entry point that can sign a token', () => {
    for (const path of ENTRY_POINTS) {
      const source = read(path)
      expect(source, path).toContain('assertPayloadSecretConfigured')
      // At module scope, not inside a handler: a request that reaches a handler has already loaded the
      // module, and Payload's own middleware runs before ours.
      expect(source, path).toMatch(/^assertPayloadSecretConfigured\(\)$/m)
    }
  })

  it('does not make a public page depend on the admin’s signing key', () => {
    // The control, and the defect this replaced. `payloadSecret()` used to throw during module evaluation
    // whenever NODE_ENV was production outside a build — so the moment a public page imported the config to
    // read CMS content, every one of those pages answered 500 in an environment with no PAYLOAD_SECRET. The
    // prerendered copy was served happily and the first revalidation turned the page into an error, which is
    // how `content.itest.ts` found it.
    for (const path of [
      join('app', '(en)', '(public)', 'faq', 'page.tsx'),
      join('app', '(en)', '(public)', 'journal', 'page.tsx'),
      join('src', 'cms', 'read.ts'),
    ]) {
      expect(read(path), path).not.toContain('assertPayloadSecretConfigured')
    }
    // And the guard really is conditional on the environment rather than on nothing: with no NODE_ENV of
    // production it returns, which is what lets development and this suite import the config at all.
    expect(() => assertPayloadSecretConfigured()).not.toThrow()
  })
})
