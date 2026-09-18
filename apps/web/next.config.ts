import type { NextConfig } from 'next'

/**
 * Next.js configuration.
 *
 * Server components by default, which is the decision in ADR 0013: the public site renders on the
 * server so HTML arrives complete, with content and structured data in the first response. Googlebot
 * executes JavaScript on its own schedule; almost nothing else does, and the crawlers behind AI
 * answers read HTML and stop.
 */
const config: NextConfig = {
  reactStrictMode: true,
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
    '@berelax/db',
    '@berelax/messaging',
    '@berelax/providers',
    '@berelax/shared',
  ],
  typedRoutes: true,
  experimental: {
    // Font and image optimisation write into .next; nothing else needs to.
    optimizePackageImports: ['@berelax/ui'],
  },
  poweredByHeader: false,
}

export default config
