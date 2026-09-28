import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_STANDALONE_PATHS,
  ADMIN_UNGUARDED_PATHS,
  isAdminPath,
  requiresAdminSession,
} from './routes/admin-routes.ts'
import { filesystemRoutes } from './routes/discover.ts'
import { routeByPath } from './routes/registry.ts'
import {
  ADMIN_LOGIN_PATH,
  ADMIN_SESSION_COOKIE,
  adminSessionCookie,
  adminSessionTokenFrom,
  clearedAdminSessionCookie,
  safeReturnTo,
} from './session-cookie.ts'

/**
 * W-SYS-11 — everything about the admin guard that is decidable without a server.
 *
 * The companion to `session.itest.ts`, which drives a real `next start` and asserts served bytes. The split
 * is the one `registry.test.ts` and `route-spine.itest.ts` already make: what can be decided from the source
 * is decided here, in about a second, and what is a claim about a RESPONSE needs the application running.
 *
 * Three things in particular belong here rather than there:
 *
 *   - **The cookie's attributes are a string.** Asserting `HttpOnly` needs no browser, and a unit test that
 *     fails in a second is the one somebody actually runs before committing.
 *   - **The claim set matching the filesystem** is a directory walk, not a request.
 *   - **`safeReturnTo`'s open-redirect refusals** are a pure function over strings, and the inputs that
 *     matter are the ones no integration suite would think to type.
 */

const APP_DIR = join(new URL('..', import.meta.url).pathname, 'app')

/** Every route under the `(admin)` group, from disk. */
function adminRoutesOnDisk(): readonly { path: string; file: string }[] {
  return filesystemRoutes(APP_DIR)
    .filter((route) => route.file.startsWith('(admin)/'))
    .map((route) => ({ path: route.path, file: route.file }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

describe('the admin claim set is in exact bijection with the (admin) directory', () => {
  it('finds the routes at all, so nothing below can pass over an empty set', () => {
    const onDisk = adminRoutesOnDisk()
    // A floor, not an exact count: a new admin route must not fail this line. Asserted at all because a
    // walk that found nothing would satisfy every `for` loop in this file — ADR 0002's whole subject.
    expect(onDisk.length).toBeGreaterThanOrEqual(26)
    expect(onDisk.map((route) => route.path)).toContain('/login')
    expect(onDisk.map((route) => route.path)).toContain('/calendar')
  })

  it('claims every route on disk', () => {
    for (const route of adminRoutesOnDisk()) {
      expect(
        isAdminPath(route.path),
        `app/(admin)/${route.file} serves ${route.path}, which isAdminPath does not claim. Add its ` +
          'prefix to ADMIN_GROUP_PREFIXES or its path to ADMIN_STANDALONE_PATHS.',
      ).toBe(true)
    }
  })

  it('guards every route on disk except the declared exemptions', () => {
    for (const route of adminRoutesOnDisk()) {
      const exempt = ADMIN_UNGUARDED_PATHS.includes(route.path)
      expect(requiresAdminSession(route.path), `${route.path} (app/(admin)/${route.file})`).toBe(
        !exempt,
      )
    }
  })

  it('declares no standalone path or exemption for a route that does not exist', () => {
    // The direction that would rot quietly: a prefix or path kept for a route somebody deleted makes the
    // predicate claim URLs nothing serves, and nothing else in the build would ever say so.
    const paths = new Set(adminRoutesOnDisk().map((route) => route.path))
    for (const declared of [...ADMIN_STANDALONE_PATHS, ...ADMIN_UNGUARDED_PATHS]) {
      expect(
        paths.has(declared),
        `${declared} is declared but no route under (admin) serves it`,
      ).toBe(true)
    }
  })

  it('exempts exactly one route, and it is the login screen', () => {
    // A second unguarded admin route must be a deliberate decision with a line of code behind it, not an
    // omission that looks identical to a route which forgot its guard.
    expect(ADMIN_UNGUARDED_PATHS).toEqual([ADMIN_LOGIN_PATH])
  })

  it('claims nothing outside the admin estate', () => {
    // The control. A predicate that answered true for everything would pass every case above.
    for (const path of [
      '/',
      '/about',
      '/book',
      '/treatments/thai-massage',
      '/robots.txt',
      '/api/facts',
    ]) {
      expect(isAdminPath(path), `${path} was claimed as admin`).toBe(false)
      expect(requiresAdminSession(path), `${path} was guarded`).toBe(false)
    }
  })

  it('matches a standalone path whole, never as a prefix', () => {
    // `/calendar` must not claim `/calendars` or a future public `/calendar-feed`: one is an admin diary
    // and the others are paths this application may serve to anybody.
    expect(isAdminPath('/calendar')).toBe(true)
    expect(isAdminPath('/calendars')).toBe(false)
    expect(isAdminPath('/calendar-feed')).toBe(false)
    // A prefix, by contrast, DOES claim what is under it — that is the point of the prefixes.
    expect(isAdminPath('/settings/anything/new')).toBe(true)
    expect(isAdminPath('/settingsful')).toBe(false)
  })

  it('has a registry entry for every admin route on disk', () => {
    // `registry.test.ts` asserts the bijection over the whole application; this narrows it to the admin
    // estate, because `session.itest.ts` drives one request per entry and a missing entry would silently
    // shorten that list rather than fail.
    for (const route of adminRoutesOnDisk()) {
      expect(routeByPath(route.path), `${route.path} has no registry entry`).toBeDefined()
    }
  })
})

describe('every admin handler calls the guard, and the login screen does not', () => {
  /**
   * A source scan, and the reason it is not redundant with the integration suite.
   *
   * `session.itest.ts` proves each route REFUSES an unauthenticated request. That is the stronger claim and
   * it is the one that matters — but it needs a built application and 90 seconds, so it runs in the
   * integration stage. This runs in the unit stage in milliseconds and fails the moment somebody deletes a
   * guard, which is the difference between catching it before a commit and catching it in CI.
   *
   * It matches the CALL, `await guardAdminRoute(request)` or `requireAdminPrincipal(`, and not the mere
   * presence of the identifier: an import left behind after the call was removed would otherwise satisfy it.
   */
  const GUARD_CALL = /await\s+(?:guardAdminRoute\(request\)|requireAdminPrincipal\()/
  // The same pattern, global, for COUNTING. Two constants rather than one because `matchAll` throws on a
  // non-global regexp and `test` on a global one carries `lastIndex` between calls — brief rule 20's
  // sibling defect, where half the checks in a loop pass without being made.
  const GUARD_CALLS = new RegExp(GUARD_CALL.source, 'g')

  it('finds a guard call in every guarded admin route file', () => {
    const routes = adminRoutesOnDisk().filter((route) => requiresAdminSession(route.path))
    expect(routes.length).toBeGreaterThanOrEqual(25)
    for (const route of routes) {
      const source = readFileSync(join(APP_DIR, route.file), 'utf8')
      expect(
        GUARD_CALL.test(source),
        `app/(admin)/${route.file} serves ${route.path} and never calls the session guard. Add ` +
          '`const authorised = await guardAdminRoute(request)` as its first statement.',
      ).toBe(true)
    }
  })

  it('finds one guard call per exported handler, so a second method is not left open', () => {
    // The defect this is written for: a route gains a POST beside its GET and only the GET is guarded. The
    // integration suite drives ONE method per route, so it would not see it.
    for (const route of adminRoutesOnDisk().filter((r) => requiresAdminSession(r.path))) {
      const source = readFileSync(join(APP_DIR, route.file), 'utf8')
      const handlers = [
        ...source.matchAll(/^export async function (?:GET|POST|PUT|PATCH|DELETE)\(/gm),
      ]
      const guards = [...source.matchAll(new RegExp(GUARD_CALLS.source, 'g'))]
      expect(
        guards.length,
        `app/(admin)/${route.file} exports ${handlers.length} handler(s) but calls the guard ` +
          `${guards.length} time(s) — every exported method needs its own call.`,
      ).toBeGreaterThanOrEqual(handlers.length)
    }
  })

  it('does not guard the login screen, which would be a loop', () => {
    const source = readFileSync(join(APP_DIR, '(admin)/login/route.ts'), 'utf8')
    expect(GUARD_CALL.test(source)).toBe(false)
  })
})

describe('the cookie carries a token and nothing else', () => {
  it('is HttpOnly, Secure, SameSite=Lax and scoped to the whole site', () => {
    const cookie = adminSessionCookie({ token: 'abc123', maxAgeSeconds: 1800 })
    expect(cookie).toContain(`${ADMIN_SESSION_COOKIE}=abc123`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=1800')
    expect(cookie).toContain('Path=/')
  })

  it('is never SameSite=Strict, which would break the Google consent round trip', () => {
    // `Strict` withholds the cookie on any cross-site navigation, so an operator returning from Google's
    // consent screen would arrive logged out mid-flow, having just granted access.
    expect(adminSessionCookie({ token: 't', maxAgeSeconds: 1 })).not.toContain('Strict')
  })

  it('has no Secure-off switch, because that switch is what gets defaulted wrongly', () => {
    // The booking cookie takes `secure: boolean` because the integration suite drives http://127.0.0.1 in a
    // browser. This one does not, deliberately: a parameter that turns `Secure` off is a parameter some
    // caller sets wrongly one day, and an admin session cookie in clear text is the whole estate on the wire.
    // Asserted structurally — the function's own source must not mention a secure flag.
    const source = readFileSync(
      join(new URL('.', import.meta.url).pathname, 'session-cookie.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/readonly\s+secure\s*[?]?\s*:/)
    expect(source).not.toMatch(/args\.secure/)
  })

  it('clears itself with the same attributes, so it replaces the same cookie', () => {
    const cleared = clearedAdminSessionCookie()
    expect(cleared).toContain('Max-Age=0')
    expect(cleared).toContain('HttpOnly')
    expect(cleared).toContain('Secure')
    expect(cleared).toContain('SameSite=Lax')
  })

  it('refuses a negative Max-Age rather than emitting one', () => {
    expect(adminSessionCookie({ token: 't', maxAgeSeconds: -5 })).toContain('Max-Age=0')
  })
})

describe('reading the cookie out of a request', () => {
  it('finds the token among other cookies, in any position', () => {
    expect(adminSessionTokenFrom(`${ADMIN_SESSION_COOKIE}=abc`)).toBe('abc')
    expect(adminSessionTokenFrom(`other=1; ${ADMIN_SESSION_COOKIE}=abc; third=2`)).toBe('abc')
    expect(adminSessionTokenFrom(`  ${ADMIN_SESSION_COOKIE}=abc  `)).toBe('abc')
  })

  it('returns null for absent, empty and malformed', () => {
    expect(adminSessionTokenFrom(null)).toBeNull()
    expect(adminSessionTokenFrom('')).toBeNull()
    expect(adminSessionTokenFrom('other=1')).toBeNull()
    expect(adminSessionTokenFrom(`${ADMIN_SESSION_COOKIE}=`)).toBeNull()
    expect(adminSessionTokenFrom(`${ADMIN_SESSION_COOKIE}`)).toBeNull()
  })

  it('matches the name by equality, not by prefix', () => {
    // A cookie whose name merely STARTS with this one's must not be read as it. A `startsWith` here is how
    // a page-set `berelax_admin_theme` comes to be resolved as a session token.
    expect(adminSessionTokenFrom(`${ADMIN_SESSION_COOKIE}_theme=dark`)).toBeNull()
    expect(adminSessionTokenFrom(`x${ADMIN_SESSION_COOKIE}=abc`)).toBeNull()
  })
})

describe('safeReturnTo refuses an open redirect', () => {
  it('keeps a path on this origin', () => {
    expect(safeReturnTo('/compliance')).toBe('/compliance')
    expect(safeReturnTo('/hr/rota?date=2026-01-01')).toBe('/hr/rota?date=2026-01-01')
  })

  it('refuses every off-origin shape', () => {
    // `//host` is a protocol-relative URL a browser resolves to another origin, and it passes a naive
    // `startsWith('/')`. `/\host` is normalised to the same thing by several browsers. An open redirect on a
    // LOGIN page is served to somebody who has just typed a password, because they trusted the URL.
    for (const hostile of [
      '//evil.example',
      '//evil.example/path',
      '/\\evil.example',
      'https://evil.example',
      'http://evil.example',
      'javascript:alert(1)',
      'evil.example',
      '',
    ]) {
      expect(safeReturnTo(hostile), `safeReturnTo accepted ${JSON.stringify(hostile)}`).toBe('/')
    }
    expect(safeReturnTo(null)).toBe('/')
  })

  it('refuses the login screen itself, which would be a loop', () => {
    expect(safeReturnTo(ADMIN_LOGIN_PATH)).toBe('/')
    expect(safeReturnTo(`${ADMIN_LOGIN_PATH}?returnTo=/x`)).toBe('/')
  })
})

/**
 * The repository-wide scan: nothing under `apps/web` reads a principal from the request.
 *
 * This is W-SYS-11's first acceptance line and the one that has to keep holding after the unit is done. The
 * whole estate was built around `?employee=` and `?role=`, so the way this regresses is not somebody
 * deliberately restoring a query parameter — it is a new admin screen copied from an old one, with the
 * pattern carried over because it was the shape every neighbour had.
 *
 * It is a SCAN over the directory rather than a list of files, because a list is the thing a new file is not
 * added to. Gate block 117 proves it fires by writing a fixture route that reintroduces one.
 */
const PRINCIPAL_PARAMS = ['employee', 'role', 'actor', 'principal', 'staff'] as const

/** Every `.ts`/`.tsx` under `apps/web`, excluding build output. */
function webSources(): readonly string[] {
  const root = new URL('..', import.meta.url).pathname
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue
        walk(full)
        continue
      }
      if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(full)
    }
  }
  walk(root)
  return found
}

/** This scan's own file names the parameters it forbids, which is not a read of one. */
const isScanItself = (file: string): boolean => file.endsWith('admin-guard.test.ts')

describe('no module under apps/web takes a principal from the request', () => {
  it('scans a non-trivial number of files, so an empty walk cannot pass', () => {
    // ADR 0002. A scan whose failure mode is "found nothing, reported success" is not a scan.
    expect(webSources().length).toBeGreaterThan(100)
  })

  it('finds no searchParams read of a principal, a role or a permission', () => {
    // The pattern matches the READ, not the word: `?role=` appears in prose all over this repository and
    // `role="status"` is an ARIA attribute on a dozen screens. What is forbidden is taking the value.
    const reads = new RegExp(
      String.raw`searchParams\s*\.\s*get\(\s*['"` +
        '`' +
        `](?:${PRINCIPAL_PARAMS.join('|')})['"` +
        '`' +
        `]`,
    )
    const offenders = webSources().filter(
      (file) => !isScanItself(file) && reads.test(readFileSync(file, 'utf8')),
    )
    expect(
      offenders,
      'a module under apps/web chooses a principal, a role or a permission from the query string. The ' +
        'reader comes from the session: use `guardAdminRoute(request)` and read `principal.role` and ' +
        '`principal.employeeId` off it.',
    ).toEqual([])
  })

  it('finds no `required(url, ...)` helper pulling an employee out of a URL', () => {
    // The specific shape the two clinical routes used before this unit. Matched separately because the read
    // went through a local helper, so scanning only for `searchParams.get` would have missed both of the
    // routes this unit actually changed — which is the whole reason the first scan is not enough.
    const helper = /required\(\s*url\s*,\s*['"](?:employee|role|actor|principal|staff)['"]/
    const offenders = webSources().filter(
      (file) => !isScanItself(file) && helper.test(readFileSync(file, 'utf8')),
    )
    expect(offenders, 'a route takes its reader from the URL through a helper').toEqual([])
  })
})

describe('the wiring is asserted, so deleting it fails rather than reverting quietly', () => {
  it('has at least one module under apps/web importing @berelax/auth', () => {
    // W-SYS-11's second acceptance line. Before this unit NOTHING in apps/web imported the package, and
    // that state was invisible: it is the absence of a line, and no test anywhere fails for an absence.
    // An IMPORT, not a mention — a comment naming the package does not count as wiring.
    const importers = webSources().filter((file) =>
      /from\s+'@berelax\/auth'/.test(readFileSync(file, 'utf8')),
    )
    expect(
      importers,
      'no module under apps/web imports @berelax/auth. The session primitives are unmounted again, ' +
        'which is the exact state W-SYS-11 was created to end.',
    ).not.toEqual([])
  })

  it('has at least one module reading a staff session', () => {
    const readers = webSources().filter((file) =>
      /readStaffSession/.test(readFileSync(file, 'utf8')),
    )
    expect(readers, 'nothing under apps/web resolves a session cookie to a row').not.toEqual([])
  })
})
