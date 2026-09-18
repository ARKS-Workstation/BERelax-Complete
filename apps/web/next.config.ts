import { withPayload } from '@payloadcms/next/withPayload'
import type { NextConfig } from 'next'

/**
 * Next.js configuration.
 *
 * Server components by default, which is the decision in ADR 0013: the public site renders on the
 * server so HTML arrives complete, with content and structured data in the first response. Googlebot
 * executes JavaScript on its own schedule; almost nothing else does, and the crawlers behind AI
 * answers read HTML and stop.
 */

/**
 * The CMS route prefixes, written here as literals.
 *
 * They are declared once in `@berelax/cms` (`CMS_ROUTE_PREFIXES`) and `apps/web/src/payload-routes.test.ts`
 * asserts that every one of them is covered by a rule below — with a control asserting a public path is
 * not. The literals are here rather than imported because this file is loaded by Next's own config loader
 * before any workspace package is transpiled, so an import of TypeScript source from `packages/` would be
 * a resolution failure at the very first step of the build.
 */
const CMS_NOINDEX_SOURCES = ['/admin', '/admin/:path*', '/cms-api', '/cms-api/:path*'] as const

/** Kept in step with `CMS_ROBOTS_TAG` in `@berelax/cms` by the same test. */
const CMS_ROBOTS_TAG = 'noindex, nofollow, noarchive'

const config: NextConfig = {
  reactStrictMode: true,
  /**
   * Trailing slashes are `proxy.ts`'s, not Next's.
   *
   * Next's internal `/:path+/ → /:path+` redirect carries `priority: true`, so it runs *before* the proxy:
   * `/Kitchen-Sink/` was a 308 to `/Kitchen-Sink` and then a 301 from the proxy to `/kitchen-sink`. Two
   * permanent hops for the commonest mistyped-link shape there is, which is the chain W-SITE-01's
   * acceptance criterion forbids — and each hop is a round trip on a phone. With the rule off, the proxy
   * applies case, doubled-slash and trailing-slash normalisation in one 301.
   *
   * The paths the proxy deliberately does not canonicalise — `/admin`, `/cms-api`, `/api` — do not lose
   * the behaviour: it trims their trailing slash with a 308, which is what Next was doing and what keeps
   * `POST /api/v1/otp/` a POST. See `proxy.ts`.
   */
  skipTrailingSlashRedirect: true,
  // The monorepo's workspace packages ship TypeScript source rather than built output, so Next has to
  // compile them. Without this they arrive as untranspiled `.ts` and the build fails on the first
  // type annotation.
  transpilePackages: [
    '@berelax/ui',
    '@berelax/core',
    '@berelax/config',
    // The API routes reach the database and the send choke point, which pull in their own workspace
    // dependencies. Every package in the chain has to be listed: a package that is only a transitive
    // dependency still arrives as untranspiled TypeScript.
    '@berelax/clinical',
    '@berelax/cms',
    '@berelax/media',
    '@berelax/db',
    '@berelax/google',
    '@berelax/messaging',
    '@berelax/providers',
    '@berelax/shared',
  ],
  images: {
    // DigitalOcean Spaces has no image transformation (docs/08 §6), so there is no origin that could
    // answer an arbitrary width. Every width that will ever be served was encoded by the derivative
    // job, and `src/image-loader.ts` maps a requested width onto the nearest rung that exists. Next's
    // built-in optimiser is turned off rather than left as a fallback: it would happily serve a width
    // the bucket does not hold, from the app server, at full CPU cost, and nothing would say so.
    loader: 'custom',
    loaderFile: './src/image-loader.ts',
  },
  typedRoutes: true,
  experimental: {
    // Font and image optimisation write into .next; nothing else needs to.
    optimizePackageImports: ['@berelax/ui'],
  },
  poweredByHeader: false,

  /**
   * `x-robots-tag` on every CMS route.
   *
   * A response header rather than a `<meta>` tag or a robots.txt entry, because it is the only one of the
   * three that a crawler cannot miss: it arrives with the response, it covers the JSON the REST API
   * returns as well as the HTML the admin renders, and it applies to a 401 login page and a 500 alike.
   * robots.txt is advisory and a `<meta>` tag needs a document.
   *
   * `nofollow` and `noarchive` as well as `noindex`: a crawler that reached the login screen would
   * otherwise be free to walk into every collection listing behind it, and a cached copy of an admin
   * screen full of unpublished copy would outlive the page.
   */
  async headers() {
    return CMS_NOINDEX_SOURCES.map((source) => ({
      source,
      headers: [{ key: 'x-robots-tag', value: CMS_ROBOTS_TAG }],
    }))
  },
}

/**
 * `withPayload` is not optional and it is not cosmetic.
 *
 * It externalises the packages Payload loads at runtime rather than bundles (`drizzle-kit`, `sharp`,
 * `pino`), silences the Sass deprecation spam from Payload's own stylesheets, and ignores `pg-native` and
 * `cloudflare:sockets`, neither of which resolves here. Without it the build fails while resolving a
 * module nothing in this repository imports.
 *
 * It appends its own `headers()` entries to ours rather than replacing them, so the rules above survive.
 */
export default withPayload(config)
