/**
 * The admin session cookie: its name, its attributes, and how a path is read out of a request.
 *
 * ## Why this is a separate module from `session.ts`
 *
 * It imports nothing. That is the whole reason it exists, and it is not tidiness.
 *
 * `apps/web/proxy.ts` needs to know whether a request carries a session cookie, so that an admin path with
 * no cookie is refused before any route runs. `src/session.ts` — the module that resolves a cookie to a
 * principal — imports `@berelax/auth` for scrypt and TOTP and `@berelax/db` for the lookup, which means
 * `node:crypto` and `postgres.js`. Importing it from the proxy would pull a database driver and a native
 * crypto dependency into Next's middleware bundle, which is compiled for a constrained runtime and cannot
 * hold either.
 *
 * So the parts both sides need — a cookie name, a string parse, a path constant — live here with no
 * dependencies at all, and the parts that need a database live in `session.ts`, which re-exports these so
 * that a route has one import.
 *
 * A pure module is also what lets `apps/web/src/admin-guard.test.ts` assert the cookie's attributes without
 * a database or a server: the attributes are a string, and a string is testable.
 */

/**
 * The cookie the admin session travels in.
 *
 * `berelax_admin`, matching `berelax_book`'s convention in `src/book/flow.ts` — and an underscore rather
 * than the colon `berelax:theme` uses in `localStorage`, because RFC 6265 forbids a colon in a cookie name.
 * The two conventions differ by necessity and not by accident; this note is why the next person should not
 * tidy it.
 *
 * ## The `__Host-` prefix: asked for, measured, and NOT taken (H-HARD-01)
 *
 * H-HARD-01's acceptance line asks for session cookies that are *"HttpOnly, Secure, SameSite=Lax and
 * host-prefixed"*. The first three are below. The fourth was applied, driven at a real Chromium, and
 * reverted, and this paragraph is the measurement rather than a preference.
 *
 * `__Host-` is a name prefix a browser ENFORCES: it refuses to store such a cookie unless it carries
 * `Secure`, has `Path=/` and has no `Domain`. This cookie already does all three unconditionally, so the
 * prefix looked free — it would add no requirement and would move the enforcement from this file's care to
 * the browser's refusal, which is worth having: an edit that added `Domain=.berelax.ae` to share the
 * session with a subdomain would stop the cookie being STORED rather than quietly making it readable by
 * every subdomain, including one a third party runs.
 *
 * It is not free, and the reason is one hostname wide. `security-headers.itest.ts` serves this exact
 * header to Chromium at two spellings of the same server: at `http://localhost` the cookie is stored, the
 * prefixed version too; at `http://127.0.0.1` NEITHER is. The exception that permits a `Secure` cookie
 * over plain HTTP is written against the hostname `localhost` and not against the loopback address, and
 * `startWebServer` hands every integration suite the address. So the prefix is free the moment the harness
 * changes that one constant — a change to the origin twelve suites in other worktrees match on, which
 * H-HARD-01 proves rather than makes.
 *
 * ## The paragraph below about `Secure` is right, and its reason was wrong
 *
 * `Secure` is set unconditionally here, in `visitorCookie` and in `analyticsConsentCookie`, and all three
 * justify it by saying browsers treat `127.0.0.1` as a secure context so the suites need nothing dropped.
 * For cookies in Chromium that is false, as above. The DECISION survives unchanged and the argument for it
 * is now the measured one: no suite relies on a browser storing this cookie from a response.
 * `installAdminCookie` adds a `Cookie` request header, which no cookie rule governs; `installAdminBrowserCookie`
 * goes through `addCookies`, which reaches the jar over CDP and is not held to the scheme rule; and
 * `session.itest.ts` asserts the `Set-Cookie` header rather than a browser's acceptance of it. A
 * `secure: boolean` parameter would still be a switch somebody eventually defaults the wrong way, and an
 * admin session cookie sent in clear text is still the whole estate on the wire.
 *
 * `berelax_consent`, `berelax_visitor`, `berelax_book` and the Google OAuth `state` cookie are not
 * prefixed either, each for its own stated reason — see `COOKIE_DECLARATIONS` in `src/security/cookies.ts`,
 * which is the one table of what every cookie in this app is allowed to be and why.
 */
export const ADMIN_SESSION_COOKIE = 'berelax_admin'

/** Where an unauthenticated admin request is sent, and where a successful login posts to. */
export const ADMIN_LOGIN_PATH = '/login'

/**
 * The query parameter the login screen remembers a destination in.
 *
 * A path, and validated as one before it is used — see {@link safeReturnTo}. An open redirect on a login
 * screen is the classic form of this bug: `?returnTo=https://evil.example` sends somebody who has just
 * typed a password to somebody else's page, and it is a *login* page, so they typed it because they
 * trusted the URL.
 */
export const RETURN_TO_PARAM = 'returnTo'

/**
 * The cookie value a request carries, or null.
 *
 * Parsed here so that two callers cannot parse it two ways, which is the same reason `bookSessionTokenFrom`
 * exists one directory along. The name is compared after trimming and by EQUALITY, not by prefix: a cookie
 * called `berelax_admin_theme` must not be read as this one, and a `startsWith` here is how that happens.
 */
export function adminSessionTokenFrom(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null
  for (const pair of cookieHeader.split(';')) {
    const index = pair.indexOf('=')
    if (index === -1) continue
    if (pair.slice(0, index).trim() !== ADMIN_SESSION_COOKIE) continue
    const value = pair.slice(index + 1).trim()
    return value === '' ? null : value
  }
  return null
}

/**
 * The cookie's attributes, assembled once.
 *
 * `HttpOnly` because the value is a bearer credential for the entire admin estate and nothing on the page
 * has any reason to read it — an `HttpOnly` cookie is the one thing that survives a cross-site scripting
 * hole on an admin screen.
 *
 * `SameSite=Lax` rather than `Strict`, and this is the one attribute that is a judgement. `Strict` drops
 * the cookie on any cross-site navigation, which breaks the Google OAuth round trip that
 * `/settings/integrations/google/connect` performs: the operator returns from Google's consent screen on a
 * cross-site navigation and would arrive logged out, mid-flow, having just granted access. `Lax` sends the
 * cookie on a top-level GET navigation and withholds it on a cross-site POST, which is the property that
 * matters — a form on another origin cannot post to an admin route with this cookie attached.
 *
 * `Secure` unconditionally, and NOT conditioned on the environment the way `bookSessionCookie` does it.
 * That is a deliberate difference from the booking cookie and it is worth the note: a browser will not send
 * a `Secure` cookie over `http://127.0.0.1`, so a suite driving `next start` cannot rely on a browser's own
 * cookie jar over plain HTTP — the integration suite sets the cookie through `context.addCookies` with
 * `secure: true` honoured for `localhost` (browsers treat loopback as a secure context) and through an
 * explicit `fetch` header, neither of which needs the attribute dropped. So nothing requires a
 * `secure: boolean` parameter, and such a parameter would be a switch that turns `Secure` off, defaulted by
 * some caller one day in the wrong direction. An admin session cookie sent in clear text is the whole
 * estate on the wire.
 */
export function adminSessionCookie(args: {
  readonly token: string
  readonly maxAgeSeconds: number
}): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${args.token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(args.maxAgeSeconds))}`,
  ].join('; ')
}

/** The `Set-Cookie` that ends a session in the browser. Same attributes, so it replaces the same cookie. */
export function clearedAdminSessionCookie(): string {
  return adminSessionCookie({ token: '', maxAgeSeconds: 0 })
}

/**
 * A validated `returnTo`, or the admin's own root.
 *
 * Only a path on this origin: it must begin with a single `/` and not `//`, and it must not be the login
 * screen itself. `//evil.example` is a protocol-relative URL that a browser resolves to another origin, and
 * it passes a naive `startsWith('/')` — which is how an open redirect gets onto a login page. A backslash is
 * refused for the same reason: several browsers normalise `/\evil.example` to a protocol-relative URL.
 * Refusing the login path stops the redirect loop where signing in sends somebody back to signing in.
 */
export function safeReturnTo(raw: string | null): string {
  if (raw === null || raw === '') return '/'
  if (!raw.startsWith('/')) return '/'
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  const path = raw.split('?')[0] ?? '/'
  if (path === ADMIN_LOGIN_PATH) return '/'
  return raw
}
