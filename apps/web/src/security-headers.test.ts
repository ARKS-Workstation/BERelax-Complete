import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ANALYTICS_CONSENT_COOKIE } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { CONSENT_NO_SIGNALS_TOKEN } from '../app/(public)/_components/consent-banner.tsx'
import { VISITOR_COOKIE, visitorCookie } from '../app/api/collect/ingest.ts'
import { analyticsConsentCookie } from '../app/api/v1/consent/analytics/handler.ts'
import { proxy } from '../proxy.ts'
import { BOOK_SESSION_COOKIE, bookSessionCookie } from './book/flow.ts'
import { isAdminPath } from './routes/admin-routes.ts'
import { registryPaths, routePaths } from './routes/registry.ts'
import {
  COOKIE_DECLARATIONS,
  COOKIE_HOST_PREFIX,
  cookieAttributesOf,
  cookieDeclarationProblems,
  cookieFlagsOf,
  cookieTableProblems,
} from './security/cookies.ts'
import {
  CSP_HEADER,
  CSP_NONCE_HEADER,
  cspFor,
  cspPermitsInlineScript,
  HSTS_VALUE,
  mintCspNonce,
  PERMISSIONS_POLICY,
  PUBLIC_CSP_OPEN_QUESTION,
  PUBLIC_SCRIPT_SRC,
  REFERRER_POLICY,
  SECURITY_HEADER_NAMES,
  SECURITY_ROUTE_GROUPS,
  securityGroupFor,
  securityHeaders,
} from './security/headers.ts'
import {
  ADMIN_SESSION_COOKIE,
  adminSessionCookie,
  clearedAdminSessionCookie,
} from './session-cookie.ts'

/**
 * The header set, the policy, and the cookies — everything about H-HARD-01 that is a string.
 *
 * ## What is here and what is next door
 *
 * Three suites divide this unit, and the division is by what each claim NEEDS rather than by subject:
 *
 *   - this file for everything provable from a string: the header set is total over the three groups, the
 *     values are exact, the policy says what it means, and every cookie builder's output matches its row
 *     in `COOKIE_DECLARATIONS`. It drives the REAL `proxy()` over the REAL registry, which is what makes
 *     acceptance line 1's *"asserted route by route"* literal rather than a sample;
 *   - `security-headers.itest.ts` for the one claim a string cannot make — that a browser REFUSES an
 *     un-nonced inline script under this policy. A policy nothing enforces is a policy, and the
 *     difference is only visible to something that runs scripts;
 *   - `scripts/check-headers.mjs` for the claims about SETS THAT GROW: every inline script, every
 *     unauthenticated endpoint, every cookie. A test asserts something about today's members; the member
 *     the claim is about is the one added next month.
 *
 * ## Why `proxy()` is called directly
 *
 * Because it is a pure function of a `NextRequest` and the alternative is a build. `route-spine.itest.ts`
 * drives the same file through `next start` and asserts the redirects; this asserts the header set on
 * every registry path, which is 200-odd requests and would be an unreasonable thing to do to a server
 * for a claim about six header values.
 */

/** A request the proxy will pass through rather than redirect, carrying a session cookie. */
function requestFor(path: string, method = 'GET'): Request {
  return new Request(`https://berelax.test${path}`, {
    method,
    // Present, not valid. The proxy can only see presence — it cannot reach the database — and what is
    // being asserted here is the header set, which must be on the refusal too.
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=presented-but-not-resolved` },
  })
}

describe('the header set', () => {
  it('is total over the three route groups, with no blank value', () => {
    for (const group of SECURITY_ROUTE_GROUPS) {
      const headers = securityHeaders({ group, nonce: 'n0nce' })
      expect(Object.keys(headers).sort()).toEqual([...SECURITY_HEADER_NAMES].sort())
      for (const [name, value] of Object.entries(headers)) {
        expect(value, `${group}/${name} is blank`).not.toBe('')
      }
    }
  })

  it('carries the exact values the acceptance line names', () => {
    const headers = securityHeaders({ group: 'admin', nonce: 'n0nce' })
    // HSTS *with preload*, which is the half that is a decision: it asks browser vendors to ship the
    // domain in a list and is effectively irreversible.
    expect(headers['strict-transport-security']).toBe(HSTS_VALUE)
    expect(HSTS_VALUE).toContain('preload')
    expect(HSTS_VALUE).toContain('includeSubDomains')
    expect(HSTS_VALUE).toContain('max-age=63072000')
    expect(headers['referrer-policy']).toBe(REFERRER_POLICY)
    expect(REFERRER_POLICY).toBe('no-referrer')
    expect(headers['permissions-policy']).toBe(PERMISSIONS_POLICY)
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-frame-options']).toBe('DENY')
  })

  it('is ENFORCED and never report-only', () => {
    // The header NAME is the whole difference between a control and a mailing list. A constant cannot be
    // misspelt, and `scripts/check-headers.mjs` asserts the report-only spelling appears nowhere.
    expect(CSP_HEADER).toBe('content-security-policy')
    for (const group of SECURITY_ROUTE_GROUPS) {
      expect(Object.keys(securityHeaders({ group, nonce: 'n' }))).not.toContain(
        'content-security-policy-report-only',
      )
    }
  })

  it('denies every powerful feature by name rather than by default', () => {
    // Named rather than defaulted, because a default is what changes under you. `payment=()` included:
    // the Payment Request API is a browser-mediated checkout and this build's card entry is a gateway's
    // own frame, so a page here asking for it would be a page doing something nobody designed.
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial']) {
      expect(PERMISSIONS_POLICY).toContain(`${feature}=()`)
    }
  })
})

describe('the policy', () => {
  it('refuses to frame, to be framed, and to load anything unnamed, in every group', () => {
    for (const group of SECURITY_ROUTE_GROUPS) {
      const csp = cspFor(group, 'n0nce')
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("base-uri 'none'")
    }
  })

  it('permits nothing at all on the api group', () => {
    // JSON and bytes: nothing is loaded, nothing is framed, nothing is a document. The strictest
    // statement available, and it costs nothing to make.
    const csp = cspFor('api', 'n0nce')
    expect(csp).toContain("form-action 'none'")
    expect(csp).not.toContain('script-src')
    expect(csp).not.toContain('unsafe-inline')
  })

  it('names the nonce on the admin group and permits no inline script beside it', () => {
    const csp = cspFor('admin', 'abc123')
    expect(csp).toContain("script-src 'nonce-abc123'")
    // The asymmetry with `style-src` is the house position: every document emits its stylesheet inline,
    // and CSS can only exfiltrate a same-origin input's value through attribute selectors — which
    // `img-src 'self'` leaves nowhere to send.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    const scriptSrc = csp.split(';').find((part) => part.trim().startsWith('script-src')) ?? ''
    expect(scriptSrc).not.toContain('unsafe-inline')
  })

  it('refuses an un-nonced inline script and permits a nonced one, on the admin group', () => {
    const csp = cspFor('admin', 'abc123')
    expect(cspPermitsInlineScript(csp, null)).toBe(false)
    expect(cspPermitsInlineScript(csp, 'abc123')).toBe(true)
    // The nonce has to MATCH. An injected script that carried yesterday's value would otherwise run.
    expect(cspPermitsInlineScript(csp, 'def456')).toBe(false)
  })

  it('keeps the public group permissive, and the open question is a row somebody can read', () => {
    /*
     * The honest half of this unit. `script-src 'self' 'unsafe-inline'` is what the build already served
     * and it is not what it should be: Next's App Router emits an un-nonced inline bootstrap into every
     * rendered page, so a nonce there makes `'unsafe-inline'` ignored and takes the framework's own
     * script down with it. Tightening it needs Next's nonce integration plus a build and a browser.
     *
     * The assertion that matters is the last one: the open question is a ROW in the register, so the
     * deferral is something a reader can find rather than a comment in a file nobody opens. A `report-only`
     * header shipped here to look complete is exactly what this unit refuses.
     */
    const csp = cspFor('public', 'n0nce')
    expect(csp).toContain(`script-src ${PUBLIC_SCRIPT_SRC}`)
    expect(cspPermitsInlineScript(csp, null)).toBe(true)
    const register = readFileSync(
      join(import.meta.dirname, '../../../docs/OPEN-QUESTIONS.md'),
      'utf8',
    )
    expect(register).toContain(`| ${PUBLIC_CSP_OPEN_QUESTION} |`)
  })

  it('mints a fresh 128-bit nonce every time', () => {
    const minted = new Set(Array.from({ length: 50 }, () => mintCspNonce()))
    expect(minted.size).toBe(50)
    // 16 bytes base64 is 24 characters with one pad. A shorter value would be a guessable nonce, which is
    // not a nonce.
    for (const nonce of minted) expect(nonce).toHaveLength(24)
  })
})

describe('securityGroupFor', () => {
  it('reads the group out of the path and not out of a list of routes', () => {
    expect(securityGroupFor('/api/v1/book', isAdminPath)).toBe('api')
    expect(securityGroupFor('/api', isAdminPath)).toBe('api')
    expect(securityGroupFor('/cms-api/graphql', isAdminPath)).toBe('api')
    expect(securityGroupFor('/quick-book', isAdminPath)).toBe('admin')
    expect(securityGroupFor('/settings/messages', isAdminPath)).toBe('admin')
    expect(securityGroupFor('/treatments', isAdminPath)).toBe('public')
    expect(securityGroupFor('/ar/treatments', isAdminPath)).toBe('public')
  })

  it('matches /api on a boundary, so /apiary is not an API', () => {
    // A bare `startsWith('/api')` would put a public document under the policy that permits no script and
    // no style, and the page would render as unstyled text with nothing saying why.
    expect(securityGroupFor('/apiary', isAdminPath)).toBe('public')
    expect(securityGroupFor('/cms-apiary', isAdminPath)).toBe('public')
  })
})

describe('the proxy, route by route over the whole registry', () => {
  it('puts the full header set on every path the registry claims', async () => {
    const paths = registryPaths()
    // A FLOOR and not a count: the registry grows, and a case that had to be edited every time a route
    // was added would be edited without being read. What it guards against is the registry answering an
    // empty list, which would make every assertion below pass against nothing.
    expect(paths.length).toBeGreaterThan(80)
    const missing: string[] = []
    for (const path of paths) {
      // Parameterised paths carry a `[id]` segment that no browser would send; the spelling is still a
      // path the proxy must answer, and the header set does not depend on the segment's value.
      const response = proxy(requestFor(path) as never)
      for (const name of SECURITY_HEADER_NAMES) {
        if ((response.headers.get(name) ?? '') === '') missing.push(`${path} is missing ${name}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('gives each path the policy its group calls for', () => {
    const wrong: string[] = []
    for (const { path } of routePaths()) {
      const group = securityGroupFor(path, isAdminPath)
      const csp = proxy(requestFor(path) as never).headers.get(CSP_HEADER) ?? ''
      // The nonce differs per response, so the comparison is on the SHAPE: an admin path names a nonce
      // and an api path permits nothing. Comparing the whole string would need the nonce back out of it,
      // which is what the next case does.
      if (group === 'admin' && !csp.includes("script-src 'nonce-")) wrong.push(`${path}: ${csp}`)
      if (group === 'api' && csp.includes('script-src')) wrong.push(`${path}: ${csp}`)
      if (group === 'public' && !csp.includes(`script-src ${PUBLIC_SCRIPT_SRC}`)) {
        wrong.push(`${path}: ${csp}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('names in the policy the same nonce it hands the route', () => {
    /*
     * The join that makes the whole arrangement work, and the one that would fail silently: the proxy
     * mints a nonce, puts it in the header and forwards it to the route on a REQUEST header, and
     * `adminChromeFor` reads it there. Two different values would produce a document whose scripts are
     * all refused — a dead admin screen with a console message as its only symptom.
     */
    const response = proxy(requestFor('/quick-book') as never)
    const forwarded = response.headers.get('x-middleware-override-headers')
    expect(forwarded).toContain(CSP_NONCE_HEADER)
    const handed = response.headers.get(`x-middleware-request-${CSP_NONCE_HEADER}`)
    expect(handed).not.toBeNull()
    const csp = response.headers.get(CSP_HEADER) ?? ''
    expect(csp).toContain(`script-src 'nonce-${handed}'`)
    expect(cspPermitsInlineScript(csp, handed)).toBe(true)
  })

  it('puts the header set on a redirect and on the login refusal too', () => {
    // A 301 and a 303 are responses a browser acts on. An HSTS header missing from the redirect that
    // sends a first-time visitor from `http://` is the one place it would have mattered.
    const canonical = proxy(new Request('https://berelax.test/Treatments') as never)
    expect(canonical.status).toBe(301)
    const login = proxy(new Request('https://berelax.test/settings/messages') as never)
    expect(login.status).toBe(303)
    for (const response of [canonical, login]) {
      for (const name of SECURITY_HEADER_NAMES) {
        expect(response.headers.get(name), `${response.status} is missing ${name}`).not.toBeNull()
      }
    }
    // And the admin refusal gets the ADMIN policy, from the canonical path rather than the requested
    // spelling — the group is decided by where the request was going.
    expect(login.headers.get(CSP_HEADER)).toContain("script-src 'nonce-")
  })
})

describe('the cookies', () => {
  it('declares a well-formed table: every flag claimed or excepted with an argument', () => {
    expect(cookieTableProblems()).toEqual([])
    expect(COOKIE_DECLARATIONS.length).toBeGreaterThanOrEqual(5)
  })

  it('holds the admin session cookie to all four flags, and to what the prefix would enforce', () => {
    /*
      The prefix itself is not taken — `security-headers.itest.ts` measured why, and it is one hostname
      wide — so the three properties `__Host-` would have ENFORCED are asserted directly here instead.
      The absence of `Domain` is the one that matters most: a `Domain` cookie is readable by every
      subdomain, including one a third party runs.
    */
    const cookie = adminSessionCookie({ token: 'abc123', maxAgeSeconds: 1800 })
    expect(cookieFlagsOf(cookie)).toEqual(['httpOnly', 'secure', 'sameSiteLax', 'pathRoot'])
    expect(ADMIN_SESSION_COOKIE.startsWith(COOKIE_HOST_PREFIX)).toBe(false)
    const attributes = cookieAttributesOf(cookie)
    expect(attributes.domain).toBeNull()
    expect(attributes.path).toBe('/')
    expect(attributes.secure).toBe(true)
    expect(attributes.httpOnly).toBe(true)
  })

  it('clears the session with the same attributes, so it replaces the same cookie', () => {
    const cleared = clearedAdminSessionCookie()
    expect(cookieFlagsOf(cleared)).toEqual(
      cookieFlagsOf(adminSessionCookie({ token: 't', maxAgeSeconds: 1 })),
    )
    expect(cookieAttributesOf(cleared).maxAge).toBe(0)
    expect(cookieAttributesOf(cleared).value).toBe('')
  })

  it('matches every builder against its declaration, in both directions', () => {
    /*
     * The claim the acceptance line actually makes — *"no cookie in the app escapes those flags"* — and
     * the reason it is one case over a table rather than five cases: the sixth cookie is the one the claim
     * is about, and `scripts/check-headers.mjs` is what refuses one that arrives undeclared.
     *
     * The booking cookie is built with `secure: false`, which is the DEVELOPMENT path and therefore a real
     * path. Its declaration excepts `secure` with the reason, so the worst case this builder can produce
     * is what is held against the table. The next case asserts the parameter still does something.
     */
    const built: Readonly<Record<string, string>> = {
      [ADMIN_SESSION_COOKIE]: adminSessionCookie({ token: 'tok', maxAgeSeconds: 1800 }),
      [BOOK_SESSION_COOKIE]: bookSessionCookie({
        token: 'tok',
        maxAgeSeconds: 1200,
        secure: false,
      }),
      [VISITOR_COOKIE]: visitorCookie('11111111-1111-4111-8111-111111111111'),
      [ANALYTICS_CONSENT_COOKIE]: analyticsConsentCookie([]),
    }
    const problems: string[] = []
    for (const declaration of COOKIE_DECLARATIONS) {
      const header = built[declaration.cookieName]
      // The Google OAuth state cookie is built inside a route handler and is not exported; its flags are
      // asserted by its own suite. What is asserted here is that its ROW is well-formed, which the table
      // case above does for every row.
      if (header === undefined) continue
      problems.push(...cookieDeclarationProblems(declaration, header))
    }
    expect(problems).toEqual([])
    // Four of the five builders are reachable from here, which is the vacuity guard: a rename that broke
    // the lookup would make this case pass against nothing.
    expect(Object.keys(built)).toHaveLength(4)
  })

  it('still adds Secure to the booking cookie when it is asked to', () => {
    // So the exception in the table is about a PARAMETER somebody defaults, not about a builder that
    // cannot carry the flag at all.
    expect(
      cookieFlagsOf(bookSessionCookie({ token: 't', maxAgeSeconds: 1, secure: true })),
    ).toContain('secure')
  })

  it('keeps HttpOnly OFF the consent cookie, because the browser has to read it', () => {
    // The one deliberate absence, asserted in the direction that keeps it absent: the banner writes this
    // value and the gate that decides whether a tag loads reads it, both in the browser.
    const cookie = analyticsConsentCookie([])
    expect(cookieAttributesOf(cookie).httpOnly).toBe(false)
    expect(cookieAttributesOf(cookie).value).toBe(CONSENT_NO_SIGNALS_TOKEN)
    expect(cookieFlagsOf(cookie)).toContain('secure')
  })

  it('reads attributes case-insensitively on the attribute and not on the name', () => {
    // RFC 6265: `httponly` and `HttpOnly` are the same attribute; `berelax_admin` and `BERELAX_ADMIN` are
    // different cookies.
    const parsed = cookieAttributesOf('a=b; path=/; httponly; SECURE; samesite=lax; Max-Age=60')
    expect(parsed).toMatchObject({
      cookieName: 'a',
      value: 'b',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60,
    })
    expect(cookieFlagsOf('__Host-a=b; Path=/; Secure; SameSite=Lax; HttpOnly')).toContain(
      'hostPrefix',
    )
    // A name that CLAIMS the prefix without the attributes a browser demands does not carry it: such a
    // cookie is not stored at all, and reporting it as host-prefixed would report the opposite.
    expect(cookieFlagsOf('__Host-a=b; Path=/; SameSite=Lax; HttpOnly')).not.toContain('hostPrefix')
    expect(cookieFlagsOf('__Host-a=b; Path=/; Secure; Domain=example.test')).not.toContain(
      'hostPrefix',
    )
  })
})
