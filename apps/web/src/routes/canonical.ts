/**
 * One URL per page: the normalisation rules, as pure functions.
 *
 * docs/09 §"Technical SEO" asks for canonicalisation with trailing-slash and case normalisation. The
 * cost of not having it is not theoretical: `/Treatments/`, `/treatments/` and `/treatments` are three
 * URLs serving one page, they split inbound links between them, and Search Console reports the whole
 * set as "Duplicate without user-selected canonical" months after launch.
 *
 * The rules, in the order they are applied:
 *
 * 1. **Collapse repeated slashes.** `/treatments//x` is a real shape — it is what string concatenation
 *    produces when one half already ends in a slash — and Next serves it as a 404 rather than as the
 *    page, because the empty segment is a segment.
 * 2. **Lowercase the path, leave percent-escapes uppercase.** Route folders are lowercase slugs, so an
 *    uppercase request can only be a mistyped or mis-copied link. `%D8%A7` is left as hex in upper case
 *    (RFC 3986 §6.2.2.1) rather than lowercased with the letters around it, because changing the
 *    encoding of an Arabic slug changes bytes nobody asked to change.
 * 3. **Strip the trailing slash**, except on the root, where it is the path.
 *
 * ## Why one function and not three redirects
 *
 * Because the acceptance criterion is "exactly one 301 hop to a 200, with zero chains and zero loops",
 * and a chain is what you get from three rules that each redirect: `/Treatments/` → `/treatments/` →
 * `/treatments`. Every extra hop is a round trip on a phone and a diluted signal, and Google gives up
 * after five. So the rules compose into one output and the caller redirects once.
 *
 * `canonicalPath` is idempotent by construction and `registry.test.ts` asserts that over generated
 * paths: `canonicalPath(canonicalPath(p)) === canonicalPath(p)` is the property that makes a loop
 * impossible, and it is checked rather than asserted in prose.
 */
import { CMS_ROUTE_PREFIXES } from '@berelax/cms'

/**
 * 301, not 308.
 *
 * Both are permanent. 308 preserves the method, which sounds safer and is the wrong choice here: this
 * redirect only ever applies to a document request, every consumer of the moved URL is a crawler or a
 * bookmark, and 301 is the status those two have understood for twenty-five years. Next's own
 * trailing-slash handling emits 308; it never sees these paths, because the proxy normalises them
 * first — which is also how the hop count stays at one.
 */
export const CANONICAL_REDIRECT_STATUS = 301

/**
 * 308, for the paths the proxy otherwise leaves alone.
 *
 * `POST /api/v1/otp/` has to keep working. Next's own trailing-slash redirect — the one
 * `skipTrailingSlashRedirect` turns off so that a public page needs one hop instead of two — was a 308,
 * which preserves the method; a 301 there would deliver the OTP request as a GET with no body, and the
 * failure would be a code that never arrives rather than an error anybody sees.
 */
export const METHOD_PRESERVING_REDIRECT_STATUS = 308

/** A path with its trailing slash removed, except on the root, where the slash is the path. */
export function withoutTrailingSlash(pathname: string): string {
  if (pathname === '/' || !pathname.endsWith('/')) return pathname
  return pathname.replace(/\/+$/, '') || '/'
}

/** The application's own API namespace. `/api/facts` is a documented public endpoint (docs/09 §4). */
export const API_PREFIX = '/api'

/** Next's build output. Nothing under it is a page and nothing under it may be rewritten. */
export const BUILD_OUTPUT_PREFIX = '/_next'

/**
 * Prefixes the proxy passes through untouched, and why each one is here.
 *
 * - **The CMS** (`/admin`, `/cms-api`) — read from `@berelax/cms` rather than typed again, because
 *   W-SYS-08 owns where the admin lives and a second copy of the list is the one that stops matching
 *   the day it moves. Payload's REST paths carry document ids, and lowercasing an id is a 404 on a row
 *   that exists; its admin already carries `x-robots-tag` from `next.config.ts`.
 * - **`/api`** — a POST endpoint. A 301 turns a POST into a GET in most clients and drops the body,
 *   so an OTP request that arrived at a path this function would have normalised must fail loudly
 *   rather than be silently downgraded.
 * - **`/_next`** — build output, content-addressed, never a page.
 */
export const PROXY_EXEMPT_PREFIXES: readonly string[] = [
  ...CMS_ROUTE_PREFIXES,
  API_PREFIX,
  BUILD_OUTPUT_PREFIX,
]

/**
 * True when the proxy must not touch this path.
 *
 * Matched **case-insensitively**, which is the whole point: the exemption exists so that nothing under
 * these prefixes is rewritten, and a request that arrives as `/Admin` or `/CMS-API/pages/AbC` is
 * exactly the request a case-normalising redirect would quietly send somewhere else. `/Admin` is
 * therefore a 404 from Next's own routing rather than a 301 into the admin, and
 * `route-spine.itest.ts` asserts that against a live response with `/Kitchen-Sink` as the control.
 *
 * A final segment containing a dot is a file — `favicon.ico`, `robots.txt`, a font — and is left alone
 * for the same reason: its name is its identity, not a slug.
 */
export function isProxyExempt(pathname: string): boolean {
  const lower = pathname.toLowerCase()
  for (const prefix of PROXY_EXEMPT_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) return true
  }
  const lastSegment = lower.slice(lower.lastIndexOf('/') + 1)
  return lastSegment.includes('.')
}

/**
 * Lowercases the path without touching its percent-escapes.
 *
 * `%D8%A7`.toLowerCase() is `%d8%a7`: still the same octet, still a valid URL, and a different string —
 * so a path that came back lowercased would never equal the canonical one and the redirect would loop.
 * The escapes are normalised to upper case instead, which is what RFC 3986 §6.2.2.1 recommends and what
 * makes the function idempotent on Arabic slugs.
 */
function lowercasePreservingEscapes(pathname: string): string {
  return pathname.replaceAll(/%[0-9A-Fa-f]{2}|[^%]+/g, (part) =>
    part.startsWith('%') ? part.toUpperCase() : part.toLowerCase(),
  )
}

/**
 * The one canonical spelling of a pathname.
 *
 * Takes and returns a pathname only — no query, no fragment, no origin. The query belongs to the
 * caller: the proxy carries it across unchanged, because dropping a UTM parameter on a redirect loses
 * the attribution the analytics unit is built on (A-FIRST-*).
 */
export function canonicalPath(pathname: string): string {
  const withLeadingSlash = pathname.startsWith('/') ? pathname : `/${pathname}`
  const collapsed = withLeadingSlash.replaceAll(/\/{2,}/g, '/')
  return withoutTrailingSlash(lowercasePreservingEscapes(collapsed))
}

/** True when a request for this path has to be redirected to reach its canonical URL. */
export function needsCanonicalRedirect(pathname: string): boolean {
  return !isProxyExempt(pathname) && canonicalPath(pathname) !== pathname
}
