import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The baseline scan, shown to find what is there and to find nothing where there is nothing.
 *
 * H-HARD-10's third acceptance line, which is ADR 0003 stated inside a unit: "proving the scan is not
 * passing on nothing". A scanner that reports no findings is indistinguishable from a scanner that does
 * not work, so it is pointed at two origins — one deliberately broken and one correct — and asserted to
 * tell them apart.
 *
 * ## Why the vulnerable route is a FIXTURE ORIGIN and not a route in `apps/web`
 *
 * An intentionally vulnerable route inside the application is a route that gets deployed. It would have
 * to bypass `guardAdminRoute`, which this repository's own admin-guard scan refuses, and it would be a
 * real hole the first time an environment check went the wrong way. A plain `node:http` origin serving
 * the same SHAPES — a 200 on an admin path with no cookie, a readable `/.env`, a document with no
 * security headers, a published source map, a versioned `Server` header — proves the same thing about
 * the scanner and cannot ship.
 *
 * `apps/web/src/checkout.itest.ts` already does exactly this for the gateway's card-entry origin.
 *
 * ## The port comes from the kernel
 *
 * `listen(0)`, for brief rule 18's reason and `checkout.itest.ts`'s: an ephemeral port cannot collide
 * with anything, and drawing one from a band would be arithmetic over a number this suite does not
 * need. No band is declared for this suite and none is used — a declared band nothing claims fails
 * `apps/web/src/test-ports.test.ts`, which is the other half of that rule.
 *
 * ## It starts no database and no application
 *
 * Nothing here reads a row. It is an `.itest.ts` rather than a unit test because it starts a server and
 * runs a real child process, which is what makes it part of `pnpm test:integration` — so the scan runs
 * in CI, on every commit, which is the acceptance line's "runs in CI" half.
 */
const run = promisify(execFile)

/** The admin path the vulnerable origin leaks. A real path from the registry, so the probe reaches it. */
const LEAKED_ADMIN_PATH = '/settings/integrations'

const SECURE_HEADERS = {
  'content-security-policy': "default-src 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
}

/**
 * An origin that does every one of the five things the scan looks for.
 *
 * Deliberately shaped like a plausible misconfiguration rather than like a test: the admin path answers
 * 200 with `text/html`, `noindex` and `no-store`, which is EXACTLY what a sign-in page answers — so a
 * scan asserting on the body rather than the status would pass against it.
 */
function vulnerableOrigin(): Server {
  return createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (path === LEAKED_ADMIN_PATH) {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-robots-tag': 'noindex',
        'cache-control': 'no-store',
      })
      response.end('<html><body><h1>Integrations</h1><p>Google: connected</p></body></html>')
      return
    }
    if (path === '/.env') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('DATABASE_URL=postgres://example\n')
      return
    }
    if (path === '/_next/static/chunks/main.js.map') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"version":3,"sources":[]}')
      return
    }
    if (path === '/') {
      // The home document: no security headers at all, and a Server header naming a version.
      response.writeHead(200, { 'content-type': 'text/html', server: 'nginx/1.25.3' })
      response.end('<html><body>home</body></html>')
      return
    }
    /*
      Everything else behaves CORRECTLY, and that is what makes the assertion in the first case an
      equality rather than a non-empty check. The first version of this origin answered 200 to every
      path, so every admin route in the registry leaked and both source-map paths were published — a
      fixture broken in nineteen ways proves only that the scanner reports something.
    */
    if (path?.startsWith('/.env') || path?.includes('.map') || path === '/.git/config') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    if (path === '/package.json') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    response.writeHead(303, { location: '/login' })
    response.end()
  })
}

/** An origin that does none of them: guarded admin, 404 on everything private, every header present. */
function guardedOrigin(): Server {
  return createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html', ...SECURE_HEADERS })
      response.end('<html><body>home</body></html>')
      return
    }
    if (path?.startsWith('/.env') || path?.includes('.map') || path === '/.git/config') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    if (path === '/package.json') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    // Every admin path redirects to the sign-in route, which is what `guardAdminRoute` does.
    response.writeHead(303, { location: '/login' })
    response.end()
  })
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}

const scan = async (target: string) => {
  try {
    const { stdout } = await run(
      'pnpm',
      ['exec', 'tsx', 'scripts/security-baseline-scan.mjs', '--target', target, '--json'],
      { maxBuffer: 16 * 1024 * 1024 },
    )
    return { failed: false, report: JSON.parse(stdout.slice(stdout.indexOf('{'))) }
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const at = stdout.indexOf('{')
    return {
      failed: true,
      report: at === -1 ? null : JSON.parse(stdout.slice(at)),
      output: `${stdout}${(error as { stderr?: string }).stderr ?? ''}`,
    }
  }
}

let vulnerable: Server
let guarded: Server
let vulnerableTarget: string
let guardedTarget: string

beforeAll(async () => {
  vulnerable = vulnerableOrigin()
  guarded = guardedOrigin()
  vulnerableTarget = await start(vulnerable)
  guardedTarget = await start(guarded)
}, 30_000)

afterAll(async () => {
  await new Promise<void>((resolve) => vulnerable.close(() => resolve()))
  await new Promise<void>((resolve) => guarded.close(() => resolve()))
})

describe('the baseline scan', () => {
  /*
    An explicit timeout, because this spawns `tsx` twice and loads the route registry each time. Brief
    rule 21: a correctness test must not carry an implicit performance budget, and vitest's default is
    5,000 ms.
  */
  it('finds the intentionally vulnerable origin and names each hole', async () => {
    const { failed, report } = await scan(vulnerableTarget)
    // Non-zero, because two of the findings are of blocking severity.
    expect(failed).toBe(true)
    const byKind = new Map(
      (report.findings as { kind: string; path: string; severity: string }[]).map((finding) => [
        `${finding.kind}:${finding.path}`,
        finding,
      ]),
    )
    expect([...byKind.keys()].sort()).toEqual([
      `admin_route_unauthenticated:${LEAKED_ADMIN_PATH}`,
      'secret_file_exposed:/.env',
      'security_headers_absent:/',
      'server_version_disclosed:/',
      'source_map_published:/_next/static/chunks/main.js.map',
    ])
    expect(byKind.get(`admin_route_unauthenticated:${LEAKED_ADMIN_PATH}`)?.severity).toBe(
      'critical',
    )
  }, 120_000)

  it('finds nothing on a guarded origin, which is what makes the case above a measurement', async () => {
    const { failed, report } = await scan(guardedTarget)
    expect(report.findings).toEqual([])
    expect(report.examinedNothing).toBe(false)
    expect(failed).toBe(false)
  }, 120_000)

  it('examines every guarded admin path the route registry declares, and more than a handful', async () => {
    const { report } = await scan(guardedTarget)
    // The floor, and the control for both cases above: a scan that probed nothing would report no
    // findings on the vulnerable origin too.
    expect(report.observations).toBeGreaterThan(10)
  }, 120_000)
})
