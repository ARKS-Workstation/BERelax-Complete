/**
 * The edge of the URL space: one canonical spelling per page, and `x-robots-tag` on everything private.
 *
 * ## Why this file is `proxy.ts` and not `middleware.ts`
 *
 * They are the same thing. Next 16.3 renamed the convention: `middleware.ts` still runs and prints
 * `The "middleware" file convention is deprecated. Please use "proxy" instead.` on every build, and a
 * file whose name the framework is walking away from is not where a route spine should live. The export
 * has to be named `proxy` (or default) — Next's entry template picks `mod.proxy` for `/proxy` and
 * `mod.middleware` for `/middleware`, and getting it wrong is a runtime error, not a type error.
 *
 * ## What it does, in this order
 *
 * 1. **Exempt paths keep their spelling.** `/admin`, `/cms-api`, `/api` and `/_next`, matched
 *    case-insensitively — see `isProxyExempt`. This runs on *every* request, including the admin's, and
 *    an unconditional normalisation here would lowercase a Payload document id and 404 a row that exists.
 *    They do get their trailing slash trimmed, with a **308**, because that is the redirect Next itself
 *    issues when `skipTrailingSlashRedirect` is off and `POST /api/v1/otp/` has to keep working: 308
 *    preserves the method, 301 turns the code request into a GET with no body.
 * 2. **A non-canonical public path is redirected once**, 301, query string intact.
 * 3. **Everything else is passed through with the robots header the registry says it carries.**
 *
 * ## Why `skipTrailingSlashRedirect` is on in `next.config.ts`
 *
 * Because without it there are two redirects for the commonest shape there is. Next's own internal
 * `/:path+/ → /:path+` rule has `priority: true`, so it runs *before* this file: `/Kitchen-Sink/` became a
 * 308 to `/Kitchen-Sink` and then a 301 from here to `/kitchen-sink` — a two-hop chain, which is exactly
 * what the acceptance criterion forbids. With the rule off, this file applies every normalisation at once
 * and the hop count is one.
 *
 * One normalisation still happens before any application code and cannot be turned off:
 * `resolve-routes.js` collapses repeated slashes (and backslashes) with an unconditional 308 the moment
 * `req.url` matches `/(\\|\/\/)/`. So `/treatments//x` arrives here already collapsed, and a path that has
 * a doubled slash *and* wrong case takes Next's 308 followed by this file's 301. Both are permanent, the
 * destination is the canonical URL, and there is no loop — `route-spine.itest.ts` asserts that shape
 * rather than pretending it is one hop.
 *
 * ## Why the header is set here rather than in `next.config.ts`
 *
 * `next.config.ts` already carries the CMS's `x-robots-tag`, and its `headers()` takes literal source
 * patterns — which is the right shape for two fixed prefixes and the wrong shape for this one. The
 * `(admin)` route group contributes nothing to the URL, so its routes are top-level paths that share no
 * prefix (`/analytics`, `/settings/...`): a `headers()` rule per admin route is a list that a new admin
 * page can be added without touching, and the page would be indexable until somebody noticed. Here the
 * list is derived from the registry and the admin prefixes, so the default is noindex and the exception
 * is explicit.
 */
import { type NextRequest, NextResponse } from 'next/server'
import {
  CANONICAL_REDIRECT_STATUS,
  canonicalPath,
  isProxyExempt,
  METHOD_PRESERVING_REDIRECT_STATUS,
  withoutTrailingSlash,
} from './src/routes/canonical.ts'
import { ROBOTS_HEADER, robotsTagFor } from './src/routes/registry.ts'

/**
 * Everything except Next's build output.
 *
 * The matcher has to be a literal Next can read out of this file at build time, so it cannot be derived
 * from `CMS_ROUTE_PREFIXES` — and a hand-typed copy of that list here is the copy that stops matching the
 * day the admin moves. So the matcher excludes only `/_next`, which is build output by definition and can
 * never be a page, and every other exemption is `isProxyExempt`'s: one list, in one place, unit-tested,
 * and asserted against a live response.
 */
export const config = {
  matcher: ['/((?!_next/).*)'],
}

/**
 * Methods that may be redirected.
 *
 * A 301 on a POST is downgraded to a GET by most clients and the body is dropped, so a mistyped path on
 * a write would silently become a read of another URL. `/api` is exempt anyway; this is the guard that
 * keeps that true when a server action — which posts to the page's own URL — arrives on a page path.
 */
const REDIRECTABLE_METHODS = new Set(['GET', 'HEAD'])

/**
 * A redirect to the same URL with the pathname replaced, keeping the query string.
 *
 * A plain `URL` built from `request.url`, **not** `request.nextUrl.clone()`. `NextURL` remembers whether
 * the URL it was parsed from had a trailing slash (`analyze()` stores `info.trailingSlash`) and
 * `formatPathname()` puts it back when the URL is serialised — so assigning a slash-free pathname to a
 * cloned `NextURL` produced a `Location` of `/kitchen-sink/` for a request to `/kitchen-sink/`, which is a
 * redirect loop rather than a normalisation. A `URL` formats what it is given.
 */
function redirectTo(requested: URL, pathname: string, status: number): NextResponse {
  const destination = new URL(requested)
  destination.pathname = pathname
  return NextResponse.redirect(destination, status)
}

export function proxy(request: NextRequest): NextResponse {
  // The path as it arrived, read from `request.url` rather than from `request.nextUrl` for the same
  // reason: `NextURL` analyses what it is handed, and the input to a canonicalisation has to be the input.
  const requested = new URL(request.url)
  const pathname = requested.pathname
  if (isProxyExempt(pathname)) {
    const trimmed = withoutTrailingSlash(pathname)
    return trimmed === pathname
      ? NextResponse.next()
      : redirectTo(requested, trimmed, METHOD_PRESERVING_REDIRECT_STATUS)
  }

  const canonical = canonicalPath(pathname)
  if (canonical !== pathname && REDIRECTABLE_METHODS.has(request.method)) {
    // One hop, because `canonicalPath` applies every rule at once and is idempotent: the destination
    // cannot itself need normalising, so there is no chain and no loop.
    return redirectTo(requested, canonical, CANONICAL_REDIRECT_STATUS)
  }

  const response = NextResponse.next()
  const robots = robotsTagFor(canonical)
  if (robots !== null) response.headers.set(ROBOTS_HEADER, robots)
  return response
}
