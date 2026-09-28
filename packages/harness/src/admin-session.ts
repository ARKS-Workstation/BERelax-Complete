import type { Browser, BrowserContext, BrowserType } from 'playwright'

/**
 * Let an integration suite drive the ADMIN estate now that it is behind a session (W-SYS-11).
 *
 * ## The problem this exists for
 *
 * Twelve integration suites drive admin screens against a real `next start`, and every one of them was
 * written when those screens were unauthenticated — so each makes bare `fetch(`${BASE}/quick-book`)` calls
 * and opens Playwright contexts with no cookie. W-SYS-11 put a guard on all 25 of them, so every one of
 * those requests now answers 303 to `/login`.
 *
 * Fixing that by editing each call site means touching several dozen `fetch` calls across twelve files
 * written by other units, and a mechanical edit at that scale is where real defects come from — the wrong
 * argument gets the cookie, or one call in a loop is missed and the failure reads as a flake.
 *
 * ## What it does instead
 *
 * {@link installAdminCookie} replaces `globalThis.fetch` for the duration of the suite, adding a `Cookie`
 * header to requests aimed at ONE origin and leaving everything else alone. One edit per suite, in
 * `beforeAll`, and a restore function for `afterAll`.
 *
 * ## Why patching a global is acceptable HERE and would not be in application code
 *
 * It is scoped three ways, and the third is the one that matters: it applies only to the suite's own
 * server origin, so a request to anything else — a fake provider, a fixture endpoint, the loopback probe
 * `startWebServer` makes — is untouched; it is restored by the returned function; and it adds a header
 * rather than changing a method, a body or a URL, so no assertion about what was SENT can be affected
 * except by gaining the cookie the suite asked for.
 *
 * It deliberately does NOT overwrite an existing `Cookie` header. A suite that sets its own — the booking
 * flow's `berelax_book`, say — keeps it, and the admin cookie is appended. A wrapper that clobbered it
 * would break the one suite that drives both estates.
 */

/** The shape of the `fetch` this patches, kept narrow so the restore cannot change the binding. */
type FetchLike = typeof globalThis.fetch

/**
 * Adds a `Cookie` header to every request this process makes to `origin`, until the returned function runs.
 *
 * `origin` must be the exact origin `startWebServer` returned — `http://127.0.0.1:12744`, with no trailing
 * slash. Matching is on the resolved URL's origin rather than on a string prefix, so a request to
 * `http://127.0.0.1:1274` (a different port that happens to share the prefix) is not given the cookie.
 */
export function installAdminCookie(args: {
  readonly origin: string
  readonly cookie: string
}): () => void {
  const target = new URL(args.origin).origin
  const original: FetchLike = globalThis.fetch

  const patched: FetchLike = async (input, init) => {
    // `Request` first: a suite that builds one carries its own headers, and reading `.url` off a string or
    // a `URL` would throw. Everything here is read-only on the caller's value.
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    let sameOrigin = false
    try {
      sameOrigin = new URL(url).origin === target
    } catch {
      // A relative URL cannot be resolved without a base and cannot reach the suite's server, so it is
      // left alone rather than guessed at.
      sameOrigin = false
    }
    if (!sameOrigin) return original(input, init)

    const headers = new Headers(
      init?.headers ??
        (typeof input === 'object' && 'headers' in input ? input.headers : undefined),
    )
    // Appended, never replaced: a suite driving both the public booking flow and an admin screen has its
    // own cookie on the request and must keep it.
    const existing = headers.get('cookie')
    headers.set('cookie', existing === null ? args.cookie : `${existing}; ${args.cookie}`)
    return original(input, { ...init, headers })
  }

  globalThis.fetch = patched
  return () => {
    // Restored only if nothing else has patched it since. Replacing another wrapper's patch with the
    // original would silently un-patch theirs, and a suite that failed for that reason would name neither.
    if (globalThis.fetch === patched) globalThis.fetch = original
  }
}

/**
 * The cookie a Playwright `BrowserContext` needs, as `addCookies` takes it.
 *
 * Separate from the fetch patch because a browser has its own jar and never goes through `globalThis.fetch`.
 * A suite that drives both — most of them do, asserting the HTML with `fetch` and the behaviour with a page
 * — needs both, from the same token.
 *
 * `secure: true` and a loopback URL together are deliberate and they work: browsers treat `127.0.0.1` as a
 * secure context, so a `Secure` cookie is accepted and sent over plain HTTP to loopback. That is what lets
 * the application set `Secure` unconditionally — see `apps/web/src/session-cookie.ts`, which explains why a
 * `secure: boolean` parameter was refused there.
 */
export function adminCookieForBrowser(args: {
  readonly origin: string
  readonly name: string
  readonly token: string
}): readonly {
  name: string
  value: string
  url: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'Lax'
}[] {
  return [
    {
      name: args.name,
      value: args.token,
      url: args.origin,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]
}

/**
 * Gives every browser context the suite opens the admin session cookie, from now on.
 *
 * Patches the BROWSER TYPE's `launch` rather than a launched browser's `newContext`, and the reason is the
 * call sites: the nine suites that drive admin screens open contexts in helpers, in loops and inside
 * `describe` bodies — `route-spine.itest.ts` has five — so patching each one means five edits in a file
 * written by another unit, with the one inside a loop being the easiest to miss and the failure reading as a
 * flake. Patching `launch` covers every context any browser it returns will ever open, including the ones
 * added after this.
 *
 * It is installed BEFORE `chromium.launch` is called, which is why it takes the browser type and not a
 * browser: a suite's `beforeAll` sets `BASE` before it launches, so there is exactly one place the cookie's
 * URL is known and the browser is not yet made.
 *
 * Restored by the returned function. Like {@link installAdminCookie} it declines to restore if something
 * else has patched over it since, because replacing another wrapper with the original silently un-patches
 * theirs.
 */
export function installAdminBrowserCookie(
  browserType: BrowserType,
  args: { readonly origin: string; readonly name: string; readonly token: string },
): () => void {
  const cookies = adminCookieForBrowser(args)
  const originalLaunch = browserType.launch.bind(browserType)

  const patchedLaunch = async (
    options?: Parameters<BrowserType['launch']>[0],
  ): Promise<Browser> => {
    const browser = await originalLaunch(options)
    const originalNewContext = browser.newContext.bind(browser)
    const patchedNewContext = async (
      contextOptions?: Parameters<Browser['newContext']>[0],
    ): Promise<BrowserContext> => {
      const context = await originalNewContext(contextOptions)
      // Added to the context rather than passed as `storageState`, so a suite that supplies its own
      // `storageState` keeps it. `addCookies` merges.
      await context.addCookies([...cookies])
      return context
    }
    // Playwright declares `newContext` on an interface, so assigning to it needs the object widened. The
    // cast is on the ASSIGNMENT TARGET and not on the value, which is the narrow form: the replacement is
    // fully typed against `Browser['newContext']` above, so a signature change in Playwright is still a
    // compile error here rather than something this hides.
    ;(browser as { newContext: typeof patchedNewContext }).newContext = patchedNewContext
    return browser
  }

  browserType.launch = patchedLaunch
  return () => {
    if (browserType.launch === patchedLaunch) browserType.launch = originalLaunch
  }
}
