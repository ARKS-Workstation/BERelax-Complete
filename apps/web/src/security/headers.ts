import { randomBytes } from 'node:crypto'

/**
 * The ONE security header policy, per route group (H-HARD-01).
 *
 * ## Why a group and not a route
 *
 * The three groups answer different things to different callers and need different policies, and there
 * are exactly three because there are exactly three shapes of response in this application:
 *
 *   - `public` is a document a stranger loads and a crawler indexes;
 *   - `admin` is a document served to somebody holding a session, hand-rendered by this repository;
 *   - `api` is JSON, or bytes, for a program.
 *
 * A per-ROUTE policy would be a list that a new route is added without touching, which is
 * `ADMIN_GROUP_PREFIXES`' argument one layer up: the default has to be the strict one and the exception
 * has to be explicit. {@link securityGroupFor} derives the group from the path, so a route added tomorrow
 * gets a policy on the commit that creates it.
 *
 * ## The headers, and why each one is not left to a default
 *
 * **`strict-transport-security` with `preload`.** `max-age` is two years and `includeSubDomains` is on.
 * Preload is the half that is a decision rather than a default: it asks browser vendors to ship the
 * domain in a list, so a first-ever visit over `http:` is refused before any request leaves the machine —
 * and it is effectively irreversible, which is why it is written here with the number rather than copied
 * from a tutorial. The consequence somebody will have to live with: every subdomain of the apex must
 * serve HTTPS for ever, including ones nobody has created yet.
 *
 * **`content-security-policy`, enforced.** The header name is a constant and there is no code path in
 * this module that can emit `content-security-policy-report-only` — see {@link CSP_HEADER} and the gate
 * that asserts it. A report-only policy is a log of violations nobody reads; the unit's whole claim is
 * that a violation is REFUSED.
 *
 * **`frame-ancestors 'none'` on admin, and `x-frame-options: DENY` beside it.** Two statements of one
 * rule, deliberately: `frame-ancestors` is the one that is current and `X-Frame-Options` is the one older
 * proxies and scanners read. They are generated from the same branch here, so they cannot disagree.
 *
 * **`referrer-policy: no-referrer`.** Not `strict-origin-when-cross-origin`, which is the usual choice.
 * An admin URL in this estate carries a booking id, an employee's screen or a document reference in its
 * path, and the destination of a link out of it is a third party — so the whole URL is the thing that
 * must not travel, and `no-referrer` is the only value that says so.
 *
 * **`permissions-policy`.** Every powerful feature denied, naming them rather than relying on a default,
 * because a default is what changes under you. A massage centre's booking page has no business asking for
 * a camera, a microphone or a location, and the checkout's card frame belongs to the gateway.
 *
 * **`x-content-type-options: nosniff`.** The one that matters most on the `api` group: a JSON response
 * sniffed as HTML is a stored-XSS vector through a field somebody echoed.
 *
 * ## What is NOT changed here, and why that is stated rather than hidden
 *
 * The `public` group's CSP keeps the permissive script policy this build already had. Next's App Router
 * emits an inline bootstrap script for the RSC payload on every rendered page, so a nonce for the public
 * group has to come from Next's own integration — and the only way to know whether it works is
 * `next build` plus a browser. That is recorded on the unit rather than guessed at: a strict policy
 * shipped unverified would take the public site down, and a `report-only` one shipped to look complete is
 * exactly the thing this unit refuses. `PUBLIC_SCRIPT_SRC` carries the open question.
 *
 * The `admin` group is different in the one way that matters: every admin document is rendered by code in
 * this repository, so every inline script in it is one of ours and can carry the nonce. That is where the
 * strict policy goes and where the enforcement is proved —
 * `apps/web/src/security-headers.itest.ts` serves the real policy to a real Chromium and asserts an
 * un-nonced inline script does not run.
 */

/** The groups, in the order the policy is strictest. */
export const SECURITY_ROUTE_GROUPS = ['api', 'admin', 'public'] as const

export type SecurityRouteGroup = (typeof SECURITY_ROUTE_GROUPS)[number]

/**
 * The header name, as a constant, so the report-only spelling is unreachable from this module.
 *
 * A report-only header is not enforcement: it produces a stream of violation reports and refuses nothing.
 * `scripts/check-headers.mjs` asserts the string `content-security-policy-report-only` appears nowhere in
 * `apps/web`, which is the half a constant cannot make.
 */
export const CSP_HEADER = 'content-security-policy' as const

/** Two years, subdomains included, and in the preload list. See the module header on irreversibility. */
export const HSTS_VALUE = 'max-age=63072000; includeSubDomains; preload' as const

/** The whole URL must not travel. See the module header on why not `strict-origin-when-cross-origin`. */
export const REFERRER_POLICY = 'no-referrer' as const

/**
 * Every powerful feature denied by name.
 *
 * `payment=()` as well, which looks odd on a system that takes payments and is right: the Payment Request
 * API is a browser-mediated checkout and this build's card entry is a gateway's own frame, so a page here
 * asking for it would be a page doing something nobody designed.
 */
export const PERMISSIONS_POLICY =
  'accelerometer=(), ambient-light-sensor=(), autoplay=(), battery=(), camera=(), ' +
  'display-capture=(), document-domain=(), encrypted-media=(), fullscreen=(), geolocation=(), ' +
  'gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), ' +
  'publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()'

/**
 * The public group's `script-src`, unchanged by this unit and carrying its open question.
 *
 * `'self' 'unsafe-inline'` is what the build already served. It is not what it should be, and the reason
 * it is still here is stated in the module header: Next emits an un-nonced inline bootstrap on every
 * rendered page, so tightening it needs `next build` plus a browser to know whether the site still works.
 * `Y13-public-csp` is the open question and W-SITE is the estate that owns the public documents.
 */
export const PUBLIC_SCRIPT_SRC = "'self' 'unsafe-inline'" as const

/** The open question the public group's script policy is held against. */
export const PUBLIC_CSP_OPEN_QUESTION = 'Y13-public-csp' as const

/** Every header name this module emits, for a test that must not miss one. */
export const SECURITY_HEADER_NAMES: readonly string[] = Object.freeze([
  'strict-transport-security',
  CSP_HEADER,
  'referrer-policy',
  'permissions-policy',
  'x-content-type-options',
  'x-frame-options',
])

/**
 * A fresh nonce: 128 bits, base64.
 *
 * `randomBytes` and not a counter, a hash of the path or an id taken from the request: a nonce that can
 * be predicted is a nonce an injected script can carry. Sixteen bytes is the floor the CSP specification
 * names, and base64 because that is the encoding the directive is compared in.
 */
export function mintCspNonce(): string {
  return randomBytes(16).toString('base64')
}

/** The request header the proxy hands the nonce to the route on. */
export const CSP_NONCE_HEADER = 'x-berelax-csp-nonce' as const

/**
 * The policy for a group.
 *
 * Built as a list of directives and joined, so a directive cannot be lost to a string concatenation that
 * forgot a semicolon — which is the way a CSP silently becomes two directives, one of which is ignored.
 *
 * `default-src 'none'` on every group, with each permitted source then named. The opposite reading —
 * `default-src 'self'` and a list of exceptions — is how a directive nobody thought about ends up
 * permitting a connection: `connect-src` falls back to `default-src`, so `'self'` there quietly allows
 * every fetch the page could make.
 *
 * `style-src` allows `'unsafe-inline'` on the document groups, and the asymmetry with `script-src` is the
 * position `packages/payments/src/hosted-fields.ts` argues at length: every document in this build emits
 * its stylesheet in a `<style>` element and the token layer is delivered that way, while CSS can only
 * exfiltrate the value of a SAME-ORIGIN input through attribute selectors — and `img-src 'self'` leaves
 * it nowhere to send anything. A script needs neither.
 */
export function cspFor(group: SecurityRouteGroup, nonce: string): string {
  if (group === 'api') {
    // JSON and bytes. Nothing is loaded, nothing is framed, nothing is a document — so nothing is
    // permitted, which is also the strictest statement available and costs nothing to make.
    return [
      "default-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ')
  }
  const scriptSrc = group === 'admin' ? `'nonce-${nonce}'` : PUBLIC_SCRIPT_SRC
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    // `'self'` and not `'none'`: a `<form method="post">` posting to its own path is every write in this
    // build, and `form-action` has no fallback to `default-src`, so leaving it out permits every origin.
    "form-action 'self'",
    "connect-src 'self'",
    // The admin estate is never framed; the public site is never framed either, and saying so costs a
    // directive. `frame-src` is the other direction — what this page may embed — and the checkout's own
    // policy widens it for the gateway's card frame, which is why that route keeps its own header.
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ')
}

/** Which group a path belongs to. Derived from the path, never from a list of routes. */
export function securityGroupFor(
  pathname: string,
  isAdminPath: (path: string) => boolean,
): SecurityRouteGroup {
  // `/api` and the CMS's `/cms-api` are programs' surfaces. Matched as a prefix with a boundary, so
  // `/apiary` is not an API.
  if (pathname === '/api' || pathname.startsWith('/api/')) return 'api'
  if (pathname === '/cms-api' || pathname.startsWith('/cms-api/')) return 'api'
  if (isAdminPath(pathname)) return 'admin'
  return 'public'
}

/**
 * Every security header for a group, as a map the caller sets on a response.
 *
 * A map and not a mutation of a `Headers`, so the whole set is one value a test can compare and a gate
 * can read. `apps/web/src/security-headers.test.ts` asserts the set is total over the groups.
 */
export function securityHeaders(args: {
  readonly group: SecurityRouteGroup
  readonly nonce: string
}): Readonly<Record<string, string>> {
  return Object.freeze({
    'strict-transport-security': HSTS_VALUE,
    [CSP_HEADER]: cspFor(args.group, args.nonce),
    'referrer-policy': REFERRER_POLICY,
    'permissions-policy': PERMISSIONS_POLICY,
    'x-content-type-options': 'nosniff',
    // The second statement of `frame-ancestors 'none'`, for the older readers. Generated from the same
    // call so the two cannot disagree — see the module header.
    'x-frame-options': 'DENY',
  })
}

/**
 * Would this policy permit an inline `<script>` carrying `nonce`?
 *
 * The evaluator the gate and the browser test are both held against, and it exists so the claim "the
 * policy refuses an un-nonced inline script" is a function somebody can read rather than a sentence.
 * It is deliberately NOT a general CSP implementation: it answers one question about `script-src`, which
 * is the only question this unit makes a claim about.
 *
 * A browser is the authority and `security-headers.itest.ts` asks one. This is here so a failure in that
 * suite can be told apart from a failure of the policy to say what it meant.
 */
export function cspPermitsInlineScript(csp: string, nonce: string | null): boolean {
  const directive = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src'))
  // No `script-src` means the fallback is `default-src`, which every policy here sets to `'none'`.
  if (directive === undefined) return false
  const sources = directive.slice('script-src'.length).trim().split(/\s+/)
  // A nonce, when present, makes `'unsafe-inline'` ignored — which is the whole point of the pattern and
  // is what makes a nonce policy strict rather than decorative.
  const hasNonce = sources.some((source) => source.startsWith("'nonce-"))
  if (hasNonce) {
    return nonce !== null && sources.includes(`'nonce-${nonce}'`)
  }
  return sources.includes("'unsafe-inline'")
}
