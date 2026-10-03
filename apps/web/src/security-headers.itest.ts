import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { adminCookieForBrowser } from '@berelax/harness/admin-session'
import { testPort } from '@berelax/harness/ports'
import { type Browser, chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CSP_HEADER, cspFor, mintCspNonce, securityHeaders } from './security/headers.ts'
import { inlineScriptTag } from './security/inline-script.ts'
import { ADMIN_SESSION_COOKIE, adminSessionCookie } from './session-cookie.ts'

/**
 * The CSP is only real if a violation is REFUSED, and the `__Host-` prefix only works if a browser stores
 * it (H-HARD-01).
 *
 * The band `security-headers` in `@berelax/harness/ports` is this file's (brief rules 18 and 19).
 *
 * ## Why this suite exists, and why it does NOT drive `next start`
 *
 * Everything else about this unit is a string, and `security-headers.test.ts` asserts it as one. This file
 * is for the two claims a string cannot make, and both of them are claims about a BROWSER:
 *
 * **A violation is refused.** `cspPermitsInlineScript` is this repository's reading of its own policy, and
 * a reading is not an enforcement. The difference between `content-security-policy` and
 * `content-security-policy-report-only` is invisible to every assertion that looks at a header value and
 * is the entire question — one refuses the script, the other runs it and posts a note. So the suite serves
 * the real `securityHeaders()` output to a real Chromium and asks whether the script ran, and it serves
 * the report-only spelling beside it as the CONTROL: that case asserts the un-nonced script DOES run,
 * which is what makes "a report-only header is not enforcement" a measurement rather than an opinion.
 *
 * **What the session cookie can and cannot be.** The acceptance line asks for a `__Host-` prefixed session
 * cookie. The prefix was applied, driven at a real Chromium, refused, and reverted — and the reason is
 * narrower and more useful than "loopback": Chromium stores NEITHER a `Secure` cookie nor a prefixed one
 * from a `Set-Cookie` at `http://127.0.0.1`, and stores BOTH at `http://localhost`. The exception that
 * permits a `Secure` cookie over plain HTTP is written against the HOSTNAME, not against the address, and
 * `startWebServer` hands every suite the address. So the prefix is free the moment the harness changes one
 * constant, and that is a change to the origin twelve suites in other worktrees match on — which this unit
 * proves rather than makes. Three files in this repository say `127.0.0.1` is treated as a secure context
 * for cookies; it is not, and the cases below are what that sentence should have said.
 *
 * A bare `node:http` server and not `next start`, deliberately. The document under test is four lines of
 * HTML; the subject is the header above it. A build would add minutes and a megabyte of framework script
 * to a claim about one directive, and it would make the claim WEAKER — the policy would be whatever Next
 * and this unit's proxy agreed on, rather than exactly what `securityHeaders()` returns.
 */

const PORT = testPort('security-headers')
/** The origin `startWebServer` hands every suite, and therefore the one that decides what is possible. */
const BASE = `http://127.0.0.1:${String(PORT)}`
/** The SAME server by its hostname. Chromium treats the two differently, which is this file's finding. */
const BY_NAME = `http://localhost:${String(PORT)}`

/** What a document sets when its script runs. Read back with `page.evaluate`. */
const BARE_FLAG = '__berelaxBareScriptRan'
const NONCED_FLAG = '__berelaxNoncedScriptRan'

/**
 * A document with one nonced inline script and one un-nonced one.
 *
 * Both in the same document on purpose: the nonced one is the control for the un-nonced one. A suite that
 * only asserted "the bare script did not run" would pass against a page that failed to load at all, which
 * is the way this kind of test quietly stops measuring anything.
 */
function documentFor(nonce: string): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CSP fixture</title></head>',
    '<body>',
    // The known-bad fixture, inline and un-nonced. Under the enforced policy a browser must refuse it.
    `<script>window.${BARE_FLAG} = true</script>`,
    inlineScriptTag(nonce, `window.${NONCED_FLAG} = true`),
    '</body></html>',
  ].join('')
}

/** A document that frames the one above, for the `frame-ancestors 'none'` claim. */
const FRAMER = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Framer</title></head>',
  '<body><iframe src="/admin" title="framed"></iframe></body></html>',
].join('')

/** A document whose script reports to its parent that it loaded. Same origin, so the write is permitted. */
function framedDocumentFor(nonce: string): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Framed</title></head>',
    '<body>',
    inlineScriptTag(nonce, 'window.parent.__berelaxFramedLoaded = true'),
    '</body></html>',
  ].join('')
}

let server: Server
let browser: Browser
/** The nonce the last `/admin` response named, so a case can replay it against a different response. */
let lastAdminNonce = ''

function handle(request: IncomingMessage, response: ServerResponse): void {
  const path = (request.url ?? '/').split('?')[0] ?? '/'
  const nonce = mintCspNonce()
  const html = (body: string, headers: Record<string, string>): void => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    })
    response.end(body)
  }

  if (path === '/admin') {
    lastAdminNonce = nonce
    html(documentFor(nonce), securityHeaders({ group: 'admin', nonce }))
    return
  }
  if (path === '/admin-framed') {
    html(framedDocumentFor(nonce), securityHeaders({ group: 'admin', nonce }))
    return
  }
  if (path === '/framer') {
    // No policy of its own: the question is whether the FRAMED document's `frame-ancestors` refuses it,
    // not whether this one's `frame-src` does.
    html(FRAMER, {})
    return
  }
  if (path === '/report-only') {
    /*
      The control, and the reason it is here rather than in a comment.

      This serves the identical document under the identical policy, on the report-only header name. If a
      browser refused the bare script here too, the enforced case above would prove nothing — it would be
      consistent with the browser refusing inline scripts for some other reason entirely. The assertion is
      therefore that the script RUNS, which is the sentence "a report-only header is not enforcement" in
      the only form that can fail.
    */
    const { [CSP_HEADER]: _enforced, ...rest } = securityHeaders({ group: 'admin', nonce })
    html(documentFor(nonce), {
      ...rest,
      'content-security-policy-report-only': cspFor('admin', nonce),
    })
    return
  }
  if (path === '/public') {
    html(documentFor(nonce), securityHeaders({ group: 'public', nonce }))
    return
  }
  if (path === '/sign-in') {
    // A real `Set-Cookie`, from the real builder, with nothing relaxed for the test.
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': adminSessionCookie({
        token: 'presented-but-not-resolved',
        maxAgeSeconds: 1800,
      }),
    })
    response.end('<!doctype html><html lang="en"><body>signed in</body></html>')
    return
  }
  if (path === '/sign-in-prefixed') {
    // The same builder's output with the prefix on the name, which is exactly what the reverted edit
    // produced. Nothing else is relaxed: `Secure`, `Path=/` and no `Domain` are all present, so the only
    // reason a browser can have for refusing it is the prefix rule itself.
    const prefixed = adminSessionCookie({ token: 'prefixed', maxAgeSeconds: 1800 }).replace(
      `${ADMIN_SESSION_COOKIE}=`,
      `__Host-${ADMIN_SESSION_COOKIE}=`,
    )
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': prefixed,
    })
    response.end('<!doctype html><html lang="en"><body>prefixed</body></html>')
    return
  }
  if (path === '/echo-cookie') {
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(request.headers.cookie ?? '')
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('not found')
}

beforeAll(async () => {
  server = createServer(handle)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, '127.0.0.1', resolve)
  })
  browser = await chromium.launch()
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => {
    if (server === undefined) return resolve()
    server.close(() => resolve())
  })
})

describe('the enforced policy, in a browser', () => {
  it('refuses the un-nonced inline script and runs the nonced one', async () => {
    const page = await browser.newPage()
    const violations: string[] = []
    // The browser's own account of what it refused, which is the half that tells "the script was blocked"
    // apart from "the script had a typo and threw".
    await page.exposeFunction(
      '__berelaxViolation',
      (directive: string) => void violations.push(directive),
    )
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        void (window as unknown as { __berelaxViolation: (d: string) => void }).__berelaxViolation(
          (event as SecurityPolicyViolationEvent).violatedDirective,
        )
      })
    })
    await page.goto(`${BASE}/admin`, { waitUntil: 'load' })

    const ran = await page.evaluate(
      ([bare, nonced]) => ({
        bare: (window as unknown as Record<string, unknown>)[bare as string] === true,
        nonced: (window as unknown as Record<string, unknown>)[nonced as string] === true,
      }),
      [BARE_FLAG, NONCED_FLAG],
    )
    // The claim, both halves. The second is what keeps the first from being a page that failed to load.
    expect(ran.bare, 'an un-nonced inline script RAN under the enforced policy').toBe(false)
    expect(ran.nonced, 'the nonced inline script did not run, so the policy is too strict').toBe(
      true,
    )
    /*
      `script-src-elem` and not `script-src`, and the difference is worth the line it costs: an inline
      `<script>` ELEMENT is governed by `script-src-elem`, which falls back to `script-src` when it is not
      set — so a browser refusing the element reports the directive it actually applied. Asserting the
      fallback's name would have been asserting a spelling this build never emits.
    */
    expect(violations, 'the browser reported no script-src violation').toContain('script-src-elem')
    await page.close()
  }, 60_000)

  it("does not run a script carrying another response's nonce", async () => {
    /*
      The replay. A nonce minted per RESPONSE is the whole reason the pattern is strict — a value reused
      across responses would be readable by an injected script on one page and usable on the next — and
      this is that property as a measurement: the document below carries a valid nonce for a DIFFERENT
      response, and the browser must refuse it.
    */
    const first = await browser.newPage()
    await first.goto(`${BASE}/admin`)
    const stolen = lastAdminNonce
    await first.close()
    expect(stolen).not.toBe('')

    const page = await browser.newPage()
    await page.route(`${BASE}/replay`, async (route) => {
      const nonce = mintCspNonce()
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          ...securityHeaders({ group: 'admin', nonce }),
        },
        // The script carries the STOLEN nonce; the header names the fresh one.
        body: `<!doctype html><html lang="en"><body>${inlineScriptTag(stolen, `window.${BARE_FLAG} = true`)}</body></html>`,
      })
    })
    await page.goto(`${BASE}/replay`, { waitUntil: 'load' })
    expect(
      await page.evaluate(
        (flag) => (window as unknown as Record<string, unknown>)[flag] === true,
        BARE_FLAG,
      ),
      'a script carrying a different response’s nonce ran',
    ).toBe(false)
    await page.close()
  }, 60_000)

  it('refuses to be framed, because frame-ancestors is none', async () => {
    const page = await browser.newPage()
    await page.goto(`${BASE}/framer`, { waitUntil: 'load' })
    // The framed document's own script writes to `window.parent`, which is permitted here because the two
    // are same-origin — so the flag's absence means the document never loaded rather than that it could
    // not reach up.
    await page.waitForTimeout(250)
    expect(
      await page.evaluate(
        () => (window as unknown as Record<string, unknown>)['__berelaxFramedLoaded'] === true,
      ),
      'an admin document loaded inside a frame',
    ).toBe(false)
    await page.close()
  }, 60_000)
})

describe('the policies that deliberately permit it', () => {
  it('RUNS the un-nonced script under the report-only spelling', async () => {
    // The control for the enforced case, and the acceptance line's own sentence in a form that can fail:
    // a report-only header is not enforcement.
    const page = await browser.newPage()
    await page.goto(`${BASE}/report-only`, { waitUntil: 'load' })
    expect(
      await page.evaluate(
        (flag) => (window as unknown as Record<string, unknown>)[flag] === true,
        BARE_FLAG,
      ),
      'a report-only policy refused the script, so the enforced case proves nothing',
    ).toBe(true)
    await page.close()
  }, 60_000)

  it('RUNS it on the public group too, which is the deferral observed rather than claimed', async () => {
    /*
      `Y13-public-csp`, in a browser. The public group's `script-src` is `'self' 'unsafe-inline'` because
      Next's App Router emits an un-nonced inline bootstrap into every rendered page, so tightening it
      needs Next's own nonce integration plus a build. This case asserts the CURRENT state rather than the
      intended one, and it is the honest shape: the day somebody tightens the public policy, this case
      fails and the open question's row is where they look.
    */
    const page = await browser.newPage()
    await page.goto(`${BASE}/public`, { waitUntil: 'load' })
    expect(
      await page.evaluate(
        (flag) => (window as unknown as Record<string, unknown>)[flag] === true,
        BARE_FLAG,
      ),
      'the public policy refused an inline script — if this is intentional, Y13-public-csp is resolved',
    ).toBe(true)
    await page.close()
  }, 60_000)
})

describe('the session cookie, in a browser, over loopback', () => {
  /** The prefixed name the acceptance line asked for, built exactly as the real one is. */
  const PREFIXED = `__Host-${ADMIN_SESSION_COOKIE}`

  it('is NOT stored from a Set-Cookie at 127.0.0.1, which is the origin every suite drives', async () => {
    /*
      The finding, and it corrects a sentence written in three files in this repository.

      `session-cookie.ts`, `collect/ingest.ts` and the consent handler all set `Secure` unconditionally and
      justify it the same way: *"browsers treat `127.0.0.1` as a secure context, so the integration suite
      needs nothing dropped"*. For COOKIES in Chromium that is false. The exception that lets a `Secure`
      cookie be set over plain HTTP is written against the HOSTNAME `localhost`, not against the literal
      address — so at `http://127.0.0.1` Chromium accepts the response and silently drops the cookie.

      Nothing is broken by it today, and that is worth being precise about rather than alarmed: the twelve
      admin suites acquire their session through `installAdminCookie` (a `Cookie` request header, which no
      cookie rule governs) or `installAdminBrowserCookie` (`addCookies`, which goes through CDP and sets
      the jar directly), and `session.itest.ts` asserts the `Set-Cookie` HEADER rather than a browser's
      acceptance of it. What would break is a browser-driven test of the LOGIN FLOW itself at this origin,
      and there is none — so this case exists to make that a known shape rather than a surprise.
    */
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${BASE}/sign-in`)
    expect(
      (await context.cookies(BASE)).map((cookie) => cookie.name),
      'Chromium now stores a Secure cookie set over http://127.0.0.1 — three files say it always did',
    ).not.toContain(ADMIN_SESSION_COOKIE)
    await context.close()
  }, 60_000)

  it('IS stored from the same Set-Cookie at localhost, prefix and all', async () => {
    /*
      The same server, the same header, the same browser — one hostname apart. Both the plain `Secure`
      cookie and the `__Host-` prefixed one are stored and returned here, which is what makes the previous
      case a statement about an ORIGIN rather than about loopback, about HTTP, or about this build.

      It is also the remedy, measured: `__Host-` is free the moment `startWebServer` hands suites
      `http://localhost` instead of `http://127.0.0.1`. That is a one-constant change in
      `packages/harness/src/ports.ts`' neighbour and a change to the origin twelve suites in other
      worktrees match on, so H-HARD-01 does not make it — it proves it would work and says so.
    */
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${BY_NAME}/sign-in`)
    await page.goto(`${BY_NAME}/sign-in-prefixed`)
    const names = (await context.cookies(BY_NAME)).map((cookie) => cookie.name)
    expect(names).toContain(ADMIN_SESSION_COOKIE)
    expect(names, 'the __Host- prefix is refused even at localhost').toContain(PREFIXED)
    const echoed = await (await context.request.get(`${BY_NAME}/echo-cookie`)).text()
    expect(echoed).toContain(`${ADMIN_SESSION_COOKIE}=presented-but-not-resolved`)
    await context.close()
  }, 60_000)

  it('still satisfies every requirement the prefix would have enforced', async () => {
    /*
      Which is the point of not taking the prefix: the PROPERTY is held directly rather than delegated to
      a name. `Secure`, `Path=/` and the absence of `Domain` are the three things `__Host-` demands, read
      back off the cookie a browser actually stored rather than off the header this repository wrote.
    */
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${BY_NAME}/sign-in`)
    const cookie = (await context.cookies(BY_NAME)).find((c) => c.name === ADMIN_SESSION_COOKIE)
    expect(cookie).toBeDefined()
    expect(cookie?.secure).toBe(true)
    expect(cookie?.path).toBe('/')
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite).toBe('Lax')
    // Host-only: Chromium spells a host-only cookie's domain as the bare host and a `Domain` cookie's with
    // a leading dot, so the absence of the dot is the absence of the attribute.
    expect(cookie?.domain).toBe('localhost')
    await context.close()
  }, 60_000)

  it('is accepted through adminCookieForBrowser at 127.0.0.1, which is how every admin suite works', async () => {
    /*
      And this is why nothing is broken. `addCookies` reaches the jar through CDP, which sets the cookie
      directly and does not apply the scheme rule a `Set-Cookie` is held to — so the harness's route works
      at `127.0.0.1` although the response's own header would not. Asserted here because it is the load-
      bearing half of the arrangement and nothing else states it.
    */
    const context = await browser.newContext()
    await context.addCookies([
      ...adminCookieForBrowser({
        origin: BASE,
        name: ADMIN_SESSION_COOKIE,
        token: 'from-the-harness',
      }),
    ])
    const echoed = await (await context.request.get(`${BASE}/echo-cookie`)).text()
    expect(echoed).toContain(`${ADMIN_SESSION_COOKIE}=from-the-harness`)
    await context.close()
  }, 60_000)
})
