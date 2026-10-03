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
 * 0. **A retired legacy URL is redirected once, 301, query string and locale prefix intact.** W-SITE-09.
 *    After canonicalisation, because the map stores one spelling and `canonicalPath` is what produces it
 *    — asking before would mean a row per casing. See the block below.
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
 * ## Why the legacy map is resolved from a committed MODULE and not from `redirect_map`
 *
 * This file cannot reach a database — it is pure by construction, for the reason `src/session-cookie.ts`
 * records — so a redirect that has to see the request has to be resolvable without one. W-SITE-05's
 * treatment page predicted this layer in so many words: *"a redirect that has to see the request belongs
 * in a layer that always does — `proxy.ts` with a snapshot of `redirect_map`, or a CDN rule generated
 * from the same table, both of which preserve the query by default. W-SITE-09 imports the legacy
 * WooCommerce URLs into that table and is where that layer belongs."*
 *
 * So the legacy baseline is `LEGACY_BASELINE` in `@berelax/core` and the importer writes the same rows
 * into `redirect_map` for everything that CAN read it. That is one fact in two places, and
 * `public-site.itest.ts` holds them equal by asserting every committed row is in the table with the same
 * target. The SLUG-change and therapist-archival redirects are not here and must not be: they are rows
 * nothing commits, and the pages that own those paths resolve them against the table themselves.
 *
 * `next.config.ts` already carries the CMS's `x-robots-tag`, and its `headers()` takes literal source
 * patterns — which is the right shape for two fixed prefixes and the wrong shape for this one. The
 * `(admin)` route group contributes nothing to the URL, so its routes are top-level paths that share no
 * prefix (`/analytics`, `/settings/...`): a `headers()` rule per admin route is a list that a new admin
 * page can be added without touching, and the page would be indexable until somebody noticed. Here the
 * list is derived from the registry and the admin prefixes, so the default is noindex and the exception
 * is explicit.
 */
import { resolveLegacyRedirect } from '@berelax/core'
import { type NextRequest, NextResponse } from 'next/server'
import { localeOf, localisedPath, neutralPath } from './src/i18n/locales.ts'
import { requiresAdminSession } from './src/routes/admin-routes.ts'
import {
  CANONICAL_REDIRECT_STATUS,
  canonicalPath,
  isProxyExempt,
  METHOD_PRESERVING_REDIRECT_STATUS,
  withoutTrailingSlash,
} from './src/routes/canonical.ts'
import { ROBOTS_HEADER, robotsTagFor } from './src/routes/registry.ts'
import { ADMIN_LOGIN_PATH, adminSessionTokenFrom, RETURN_TO_PARAM } from './src/session.ts'

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

  /*
    The legacy WooCommerce URLs (W-SITE-09).

    Asked AFTER canonicalisation and only of a canonical path, which is what keeps the hop count at one:
    `/Product-Category/Arabic-Massage-Abu-Dhabi/` takes the 301 above to its canonical spelling and then
    this one to its destination — two permanent hops, both of which `route-spine.itest.ts` already asserts
    for the doubled-slash case, and the acceptance criterion's "exactly one 301 hop" is about the
    canonical URL a crawler holds. Asking before canonicalisation would mean a row per casing.

    The LOCALE PREFIX is preserved by construction rather than by a rule: the map is keyed on the neutral
    path, so `/ar/product/x` resolves the same row as `/product/x` and `localisedPath` puts the prefix
    back. A map with both spellings would be two rows to keep in step, and the one that goes stale is the
    Arabic one.

    The QUERY STRING survives because `redirectTo` replaces the pathname of the URL that arrived. A
    campaign parameter is how traffic on a retired URL is attributed, and dropping it turns a tracked
    visit into direct traffic silently — the loss W-SITE-05's treatment page had to accept and recorded
    for this layer to fix.
  */
  if (REDIRECTABLE_METHODS.has(request.method)) {
    const locale = localeOf(canonical)
    const retired = resolveLegacyRedirect(neutralPath(canonical))
    if (retired !== null) {
      return redirectTo(requested, localisedPath(retired.target, locale), CANONICAL_REDIRECT_STATUS)
    }
  }

  /*
    The admin estate's default deny (W-SYS-11).

    This runs after canonicalisation, so the path compared is the one a route would actually be reached at
    — comparing the requested spelling would let `/Settings/messages` past a check for `/settings`, and the
    301 that follows would then deliver it.

    ## What this is, and what it deliberately is not

    It is NOT the authentication. The proxy cannot reach the database: `requiresAdminSession` and
    `adminSessionTokenFrom` are pure, and this file must stay that way — see `src/session-cookie.ts` for
    why a database driver cannot be imported here. So all this can see is whether a cookie is PRESENT, and
    a syntactically valid cookie naming no row sails straight past it.

    What it is, is the reason a route added later is refused BY DEFAULT. `requiresAdminSession` is a
    predicate over the registry's own admin prefixes, so a new screen under `/hr` or `/settings` is refused
    from the commit that creates it rather than from the commit that remembers to add a guard — and
    `admin-guard.test.ts` proves the predicate matches the `(admin)` directory exactly, in both directions.

    The authoritative check is `requireAdminPrincipal` in each handler, which resolves the cookie against a
    row. Both layers exist because middleware-only authorisation is how CVE-2025-29927 worked; with the real
    decision in the handler, a bypass of this edge reaches a route that refuses it anyway.
    `session.itest.ts` asserts exactly that by driving every admin route with a forged-but-present cookie,
    which this cannot refuse and the handler must.
  */
  if (
    requiresAdminSession(canonical) &&
    adminSessionTokenFrom(request.headers.get('cookie')) === null
  ) {
    const destination = new URL(ADMIN_LOGIN_PATH, requested.origin)
    const returnTo = `${canonical}${requested.search}`
    destination.searchParams.set(RETURN_TO_PARAM, returnTo)
    // 303 rather than 307, so an unauthenticated POST to an admin route is not replayed as a POST to the
    // login screen carrying the original body. `NextResponse.redirect` defaults to 307, which preserves the
    // method — right for a canonicalisation and wrong here.
    const redirect = NextResponse.redirect(destination, 303)
    // A cached redirect to the login page would be served to the next reader, who may be signed in; and
    // the same URL answers differently depending on the cookie, which is what `Vary` says.
    redirect.headers.set('cache-control', 'no-store')
    redirect.headers.set('vary', 'Cookie')
    return redirect
  }

  const response = NextResponse.next()
  const robots = robotsTagFor(canonical)
  if (robots !== null) response.headers.set(ROBOTS_HEADER, robots)
  return response
}
