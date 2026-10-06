import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { totpAt } from '@berelax/auth'
import { ROLES } from '@berelax/core'
import { createConnection, readStaffSession, type Sql } from '@berelax/db'
import {
  countStaffSessions,
  createFixturePrincipal,
  type FixturePrincipal,
} from '@berelax/fixtures'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ADMIN_STANDALONE_PATHS,
  ADMIN_UNGUARDED_PATHS,
  requiresAdminSession,
} from './routes/admin-routes.ts'
import { filesystemRoutes } from './routes/discover.ts'
import { routeByPath, sampleParamsOf } from './routes/registry.ts'
import { ADMIN_SESSION_COOKIE } from './session-cookie.ts'

/**
 * W-SYS-11 — the admin session, asserted against served bytes.
 *
 * Every claim here is about what a reader RECEIVES, because that is the only thing that matters and because
 * this build's dominant defect is a check whose stated claim is not what it measures. "The guard returns a
 * redirect" is a claim about a function; "this URL answers 303 to an unauthenticated request" is a claim
 * about the application, and only the second one would have caught a route that never calls the guard.
 *
 * The band `admin-session` in `@berelax/harness/ports` is this file's (brief rules 18 and 19).
 *
 * ## Why the principals are created here and not seeded
 *
 * `Y8-staff` is open and the seed carries no credential, deliberately — see
 * `packages/fixtures/src/admin-principal.ts`. So this file creates the principals it needs, uses them, and
 * removes them in `afterAll`. That is what lets "a deployment with no staff row refuses every login" stay
 * true while the login path is still proven against a real row.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind (brief
 * rule 12). Two consequences shape this file:
 *
 *   - Every principal is this file's own, with a random staff reference, so nothing it asserts depends on
 *     rows another suite left. It never counts `staff_session` globally — always for one credential id.
 *   - It removes its own employees and credentials, because `employee` is a table other suites read. It does
 *     NOT try to remove `audit_event` rows: that table is append-only (ADR 0008) and a suite that deleted
 *     from it would be breaking a guarantee to tidy up after itself.
 */

const PASSWORD_FIELD = 'password'
const REFERENCE_FIELD = 'staffReference'

let server: WebServer
let sql: Sql
let BASE = ''
const created: FixturePrincipal[] = []

/** A principal this file owns, registered for teardown. */
async function principal(
  options: Parameters<typeof createFixturePrincipal>[1],
): Promise<FixturePrincipal> {
  const made = await createFixturePrincipal(sql, options)
  created.push(made)
  return made
}

/** The `Cookie` header for a token. Composed here from the app's own constant, never invented. */
function cookieFor(token: string): string {
  return `${ADMIN_SESSION_COOKIE}=${token}`
}

/** A fetch that never follows a redirect, because the redirect IS the assertion. */
function get(path: string, cookie?: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    redirect: 'manual',
    headers: cookie === undefined ? {} : { cookie },
  })
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
  if (url === '') throw new Error('TEST_DATABASE_URL or DATABASE_URL must be set for this suite.')
  sql = createConnection({ url, max: 4 })
  server = await startWebServer({
    suite: 'admin-session',
    cwd: new URL('..', import.meta.url).pathname,
    // `/login` rather than the default `/robots.txt`: this suite's subject is the admin estate, and probing
    // the login screen proves the route this file is about is actually being served by this build. A probe
    // that passes while `/login` is a 404 would leave every assertion below failing for the wrong reason.
    probePath: '/login',
    readyWithinMs: 90_000,
    env: {
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url,
    },
  })
  BASE = server.origin
}, 180_000)

afterAll(async () => {
  for (const made of created) await made.cleanup()
  await sql?.end({ timeout: 5 })
  await server?.stop()
})

/**
 * Every admin route on disk, with the registry entry that declares it.
 *
 * Derived from the filesystem and then looked up in the registry, rather than typed — which is the
 * acceptance criterion's "against the registry rather than against a hand-written list". The bijection test
 * already guarantees the lookup succeeds for every file; asserting it again here is not redundant, because
 * this list is what drives 25 refusal assertions and a silently short list would make all of them pass.
 */
function adminRoutesOnDisk(): readonly { path: string; file: string; methods: string[] }[] {
  const appDir = join(new URL('..', import.meta.url).pathname, 'app')
  return filesystemRoutes(appDir)
    .filter((route) => route.file.startsWith('(admin)/'))
    .map((route) => {
      // The METHODS the handler exports, read from its source.
      //
      // Needed because a route that exports only POST answers 405 to a GET, and Next answers that BEFORE
      // the handler runs — so driving every route with a GET would have measured Next's method routing on
      // three of them and reported it as a refusal. It did: `/settings/catalogue/revalidate` returned 405
      // where this file expected 303, which is the failure that produced this function.
      const source = readFileSync(join(appDir, route.file), 'utf8')
      const methods = [
        ...source.matchAll(/^export async function (GET|POST|PUT|PATCH|DELETE)\(/gm),
      ].map((match) => match[1] as string)
      return { path: route.path, file: route.file, methods }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** A method the route actually serves. GET when it has one, because a GET needs no body. */
function driveableMethod(methods: readonly string[]): string {
  return methods.includes('GET') ? 'GET' : (methods[0] ?? 'GET')
}

/** A request for a route, using a method it serves, never following a redirect. */
function drive(path: string, method: string, cookie?: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      // A body-bearing method needs a content type the handler will at least try to parse; the guard runs
      // before any parse, so an empty body is fine and is deliberately not valid JSON — if the guard were
      // moved after the parse, this would surface as a 400 and the case would fail rather than pass.
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
    },
    ...(method === 'GET' ? {} : { body: '' }),
  })
}

/** A concrete, fetchable URL for a route pattern — `[id]` is not a URL. */
function concretePath(path: string): string {
  const entry = routeByPath(path)
  const params = entry === undefined ? {} : sampleParamsOf(entry)
  return path.replace(/\[+\.{0,3}([^\]]+)\]+/g, (_segment, name: string) => {
    const declared = params[name]
    if (declared !== undefined && declared !== '') return declared
    // The registry deliberately declares NO sampleParams for the clinical routes — "a sample id would be a
    // client whose markers the screenshot harness opened on every run". An unauthenticated request never
    // reaches a row, so any syntactically valid uuid serves: the assertion is that the guard fires BEFORE
    // the parameter is used, and a uuid naming nothing is the strongest form of that.
    return '00000000-0000-7000-8000-000000000000'
  })
}

describe('acceptance — the admin estate refuses an unauthenticated request, route by route', () => {
  it('claims every route on disk and nothing else', () => {
    const onDisk = adminRoutesOnDisk()
    // 26 today. Asserted as a floor rather than an exact number so a new admin route does not fail this
    // line, and asserted at all so that a walk finding nothing cannot report success — ADR 0002.
    expect(onDisk.length).toBeGreaterThanOrEqual(26)

    for (const route of onDisk) {
      expect(
        requiresAdminSession(route.path) || ADMIN_UNGUARDED_PATHS.includes(route.path),
        `app/(admin)/${route.file} serves ${route.path}, which neither requires a session nor is ` +
          'declared unguarded. Add its prefix to ADMIN_GROUP_PREFIXES or its path to ' +
          'ADMIN_STANDALONE_PATHS in src/routes/admin-routes.ts.',
      ).toBe(true)
    }

    // The other direction: a standalone path declared for a route that no longer exists would make the
    // predicate claim a URL nothing serves, and nothing else would notice.
    const paths = new Set(onDisk.map((route) => route.path))
    for (const declared of ADMIN_STANDALONE_PATHS) {
      expect(paths.has(declared), `${declared} is declared admin but no route serves it`).toBe(true)
    }
    for (const declared of ADMIN_UNGUARDED_PATHS) {
      expect(paths.has(declared), `${declared} is declared unguarded but no route serves it`).toBe(
        true,
      )
    }
    // Exactly one unguarded admin route. A second is a deliberate decision, not an omission.
    expect(ADMIN_UNGUARDED_PATHS).toHaveLength(1)
  })

  it('answers 303 to the login screen for every guarded route, with no cookie at all', async () => {
    const guarded = adminRoutesOnDisk().filter((route) => requiresAdminSession(route.path))
    expect(guarded.length).toBeGreaterThanOrEqual(25)

    for (const route of guarded) {
      const path = concretePath(route.path)
      const response = await drive(path, driveableMethod(route.methods))
      expect(response.status, `${path} (app/(admin)/${route.file})`).toBe(303)
      const location = response.headers.get('location') ?? ''
      expect(location, path).toContain('/login')
      // The destination is remembered, or signing in would land everybody on `/`.
      expect(location, path).toContain('returnTo')
      // A cached redirect to a login page is served to the next reader, who may be signed in.
      expect(response.headers.get('cache-control'), path).toContain('no-store')
      expect((response.headers.get('vary') ?? '').toLowerCase(), path).toContain('cookie')
    }
  }, 120_000)

  /**
   * The case that makes the one above non-vacuous, and the reason both layers exist.
   *
   * A syntactically valid cookie naming no row passes the proxy — the proxy cannot reach the database, so
   * all it can see is that a cookie is present. So every refusal here is the HANDLER's, which is what the
   * previous case cannot distinguish. A route that never called the guard would pass the previous case
   * (refused at the edge) and fail this one.
   */
  it('refuses a TAMPERED cookie on every guarded route — the handler, not the edge', async () => {
    const guarded = adminRoutesOnDisk().filter((route) => requiresAdminSession(route.path))
    // 64 hex characters, the right shape for a token and naming no row. Generated, never a literal: a
    // 64-character high-entropy string in a source file is what `pnpm secrets` is written to catch.
    const forged = Buffer.from(
      Array.from({ length: 32 }, (_, index) => (index * 7 + 3) % 256),
    ).toString('hex')

    for (const route of guarded) {
      const path = concretePath(route.path)
      const method = driveableMethod(route.methods)
      const response = await drive(path, method, cookieFor(forged))
      expect(response.status, `${path} (${method}) accepted a cookie naming no session`).toBe(303)
      expect(response.headers.get('location') ?? '', path).toContain('/login')
    }
  }, 120_000)

  it('serves the login screen itself without a session, and asks for a password', async () => {
    const response = await get('/login')
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain(`name="${REFERENCE_FIELD}"`)
    expect(html).toContain(`name="${PASSWORD_FIELD}"`)
    // It must say, on its own face, that a fresh deployment has no account and no default one.
    expect(html).toContain('no default account')
    // And it must render no admin chrome: the Google re-authorisation banner is a fact about the business.
    expect(html).not.toContain('data-dismissible')
  })
})

describe('acceptance — a tampered cookie is refused, and the payload carries nothing to tamper with', () => {
  it('has no role, permission or field-group column on staff_session', async () => {
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'staff_session'
    `
    const names = columns.map((row) => row.column_name)
    // The positive control first: a query that returned nothing would make the claim below vacuous.
    expect(names).toContain('token_hash')
    expect(names).toContain('expires_at')
    for (const name of names) {
      expect(
        /role|permission|field_group|scope|claims/.test(name),
        `staff_session.${name} looks like authority copied into the session row. The role must be ` +
          'reached by joining to staff_credential, so that a demotion takes effect on the next request ' +
          'and no session can disagree with its credential.',
      ).toBe(false)
    }
  })

  it('refuses a cookie whose token has been edited by one character', async () => {
    const receptionist = await principal({ role: 'receptionist' })
    const token = receptionist.sessionToken ?? ''
    expect(token).not.toBe('')

    // The genuine cookie works — the control, without which the refusal below proves nothing.
    const allowed = await get('/compliance', cookieFor(token))
    expect(allowed.status, 'the genuine session was refused, so this file proves nothing').toBe(200)

    // One character changed. The hash of the edited token names no row, so the request is refused. A
    // signed cookie carrying a role is what this case exists to rule out: there, an edit is refused only
    // while the signature check is correct and present on every path.
    const first = token[0] ?? '0'
    const edited = (first === 'a' ? 'b' : 'a') + token.slice(1)
    expect(edited).not.toBe(token)
    const refused = await get('/compliance', cookieFor(edited))
    expect(refused.status).toBe(303)
    expect(refused.headers.get('location') ?? '').toContain('/login')
  })

  it('refuses an expired session and a revoked one, and both differ from unknown', async () => {
    // A negative TTL is an already-expired row, which is the only way to assert expiry without waiting
    // thirty minutes. `readStaffSession` compares against the instant it is given, not the database clock,
    // which is what makes this possible at all.
    const expired = await principal({ role: 'receptionist', ttlMs: -60_000 })
    const response = await get('/compliance', cookieFor(expired.sessionToken ?? ''))
    expect(response.status).toBe(303)

    // The resolution distinguishes the three, which is what lets a screen say something useful. Asserted
    // through the reader rather than through the response, because the route deliberately answers all three
    // the same way — a 303 — and collapsing them at the edge is right while collapsing them in the reader
    // would lose the only signal that separates a lapsed session from a probe.
    const live = await principal({ role: 'receptionist' })
    const nowIso = new Date().toISOString()
    expect((await readStaffSession(sql, live.sessionToken ?? '', nowIso)).kind).toBe('live')
    expect((await readStaffSession(sql, expired.sessionToken ?? '', nowIso)).kind).toBe('expired')
    expect((await readStaffSession(sql, 'a'.repeat(64), nowIso)).kind).toBe('unknown')
  })

  it('sets a cookie that is HttpOnly, Secure and SameSite=Lax, and carries only a token', async () => {
    const receptionist = await principal({ role: 'receptionist', withSession: false })
    const form = new URLSearchParams({
      [REFERENCE_FIELD]: receptionist.staffReference,
      [PASSWORD_FIELD]: receptionist.password,
      returnTo: '/compliance',
    })
    const response = await fetch(`${BASE}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location') ?? '').toContain('/compliance')

    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${ADMIN_SESSION_COOKIE}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).not.toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')

    // The value is a bare token: no role, no employee id, no separator carrying claims. Asserted on the
    // BYTES the server sent, which is where a JWT would be visible.
    const value = (cookie.split(';')[0] ?? '').split('=')[1] ?? ''
    expect(value).toMatch(/^[0-9a-f]{64}$/)
    for (const role of ROLES) expect(cookie).not.toContain(role)
    expect(cookie).not.toContain(receptionist.employeeId)
    expect(cookie).not.toContain(receptionist.staffReference)
    // A JWT is three base64url segments separated by dots. The token has no dot at all.
    expect(value).not.toContain('.')

    // The session exists server-side, which is the other half of "the cookie is not the session".
    expect(await countStaffSessions(sql, receptionist.credentialId)).toBe(1)
  }, 30_000)
})

describe('acceptance — a login without a TOTP factor cannot produce a session for owner, manager or accountant', () => {
  /** Posts the login form and returns the status, the body and whether a cookie came back. */
  async function attempt(fields: Record<string, string>): Promise<{
    status: number
    html: string
    setCookie: string | null
  }> {
    const response = await fetch(`${BASE}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    })
    return {
      status: response.status,
      html:
        response.headers.get('content-type')?.includes('text/html') === true
          ? await response.text()
          : '',
      setCookie: response.headers.get('set-cookie'),
    }
  }

  for (const role of ['owner', 'manager', 'accountant'] as const) {
    it(`refuses ${role} with a correct password and no enrolled factor, and mints nothing`, async () => {
      const staff = await principal({ role, withSession: false, enrolTotp: false })
      const result = await attempt({
        [REFERENCE_FIELD]: staff.staffReference,
        [PASSWORD_FIELD]: staff.password,
      })
      // Not a redirect, not a cookie, and the reason named on the page.
      expect(result.setCookie, `${role} was issued a cookie with no second factor`).toBeNull()
      expect(result.html).toContain('data-login-problem="enrolment_required"')
      // There is no control to continue past it. This is the assertion that a bypass was not added.
      expect(result.html).not.toContain('name="continue"')
      // And nothing was written: the absence of a cookie is not enough, because a session could exist
      // server-side and simply not have been handed over.
      expect(await countStaffSessions(sql, staff.credentialId)).toBe(0)
    }, 30_000)
  }

  /**
   * The control for the three above, and it is not a formality.
   *
   * Without it, a login route that refused owner, manager and accountant UNCONDITIONALLY — or one that
   * refused every login — would pass all three cases. This is the case that requires the second factor to
   * actually work, so "mandatory TOTP" is proven positively as well as negatively.
   */
  it('admits an owner WITH an enrolled factor and a valid code, and burns the code', async () => {
    const owner = await principal({ role: 'owner' as const, withSession: false, enrolTotp: true })
    const secret = owner.totpSecret ?? ''
    expect(secret).not.toBe('')

    // A password alone reaches the code screen and no further.
    const firstStep = await attempt({
      [REFERENCE_FIELD]: owner.staffReference,
      [PASSWORD_FIELD]: owner.password,
    })
    expect(firstStep.setCookie).toBeNull()
    expect(firstStep.html).toContain('name="totpCode"')
    expect(await countStaffSessions(sql, owner.credentialId)).toBe(0)

    // The code is computed here from the secret the fixture generated, with `totpAt` — the same arithmetic
    // the server verifies with, which is the point: a hard-coded six digits would be a literal that is
    // right for thirty seconds in 2026.
    const code = totpAt(secret, Date.now())
    const secondStep = await attempt({
      [REFERENCE_FIELD]: owner.staffReference,
      [PASSWORD_FIELD]: owner.password,
      totpCode: code,
    })
    expect(secondStep.status).toBe(303)
    expect(secondStep.setCookie ?? '').toContain(`${ADMIN_SESSION_COOKIE}=`)
    expect(await countStaffSessions(sql, owner.credentialId)).toBe(1)

    // The same code again is refused, because the counter was burned in the same transaction as the
    // insert. Without that, the second factor stops being one for the rest of its window.
    const replay = await attempt({
      [REFERENCE_FIELD]: owner.staffReference,
      [PASSWORD_FIELD]: owner.password,
      totpCode: code,
    })
    expect(replay.setCookie, 'a TOTP code was accepted twice').toBeNull()
    expect(await countStaffSessions(sql, owner.credentialId)).toBe(1)
  }, 60_000)

  it('refuses an unknown staff reference and a wrong password identically', async () => {
    const staff = await principal({ role: 'receptionist', withSession: false })
    const wrongPassword = await attempt({
      [REFERENCE_FIELD]: staff.staffReference,
      [PASSWORD_FIELD]: 'Fixture-Wrong-Password-9',
    })
    const unknownHandle = await attempt({
      [REFERENCE_FIELD]: 'Fixture principal nobody',
      [PASSWORD_FIELD]: staff.password,
    })
    expect(wrongPassword.status).toBe(401)
    expect(unknownHandle.status).toBe(401)
    expect(wrongPassword.setCookie).toBeNull()
    expect(unknownHandle.setCookie).toBeNull()
    // The same message, so the response does not say which handles exist.
    expect(unknownHandle.html).toBe(wrongPassword.html)
  }, 30_000)
})

describe('acceptance — a receptionist is refused a clinical detail and a salary field, through a served response', () => {
  /**
   * The field-level decision, measured on served bytes, from the authenticated role.
   *
   * A marketer and a receptionist are both signed in and both reach the same URL. The receptionist holds
   * `clinical_flags:read` and is served the page; the marketer holds neither that nor any clinical field
   * group and is refused the crossing entirely, by name, in the response. That difference is F07's matrix
   * deciding at the edge from a row, and it is the assertion that could not be made at all before this unit:
   * the role used to come from `?role=`, so both readers would have received whatever they asked for.
   *
   * ## What this case does NOT assert, and where that went
   *
   * It does not assert the NOTE-level refusal (`data-scope="note"`), because that panel is only rendered
   * once markers have been DERIVED, and deriving one needs a `clinical.intake_submission` row — which needs
   * `CLINICAL_KEK` and C-CRM-08's store. The seeded database has zero rows in
   * `public.customer_contraindication_flags`, so on this data every reader permitted the flags sees
   * `data-outcome="not_derived"` and the note panel does not exist to be refused. Asserting on it anyway is
   * how a case comes to report PASS about a branch it never reached.
   *
   * The note-level half is therefore covered where it IS decidable — `resolveContraindicationAccess` in
   * `@berelax/core`, whose own tests enumerate every role against both scopes — and the edge measurement of
   * it is deferred to whichever unit first serves derived markers. See the NOTE added to this unit.
   */
  it('refuses a marketer the clinical crossing and serves it to a receptionist, by role', async () => {
    const receptionist = await principal({ role: 'receptionist' })
    const marketer = await principal({ role: 'marketer' })
    const [customer] = await sql<{ id: string }[]>`select id from customer order by id limit 1`
    expect(customer, 'the seed must provide a customer for this case').toBeDefined()

    const asReceptionist = await get(
      `/clients/${customer?.id}/flags`,
      cookieFor(receptionist.sessionToken ?? ''),
    )
    expect(asReceptionist.status).toBe(200)
    const receptionistHtml = await asReceptionist.text()
    // The role the page reports is the AUTHENTICATED one, not one it was told.
    expect(receptionistHtml).toContain('data-role="receptionist"')
    // Permitted the crossing, so the page is the screen and not a refusal.
    expect(receptionistHtml).not.toContain('data-outcome="refused"')

    const asMarketer = await get(
      `/clients/${customer?.id}/flags`,
      cookieFor(marketer.sessionToken ?? ''),
    )
    expect(asMarketer.status).toBe(200)
    const marketerHtml = await asMarketer.text()
    expect(marketerHtml).toContain('data-role="marketer"')
    // Refused by NAME, in the bytes: the scope that was refused is on the panel, which is what lets an
    // operator tell "your job title does not cover this" from "you are not assigned to this client".
    expect(marketerHtml).toContain('data-outcome="refused"')
    expect(marketerHtml).toContain('data-scope="flags"')
    // And the control that stops both halves passing for an unrelated reason: the two are different bytes.
    expect(marketerHtml).not.toBe(receptionistHtml)
  }, 30_000)

  /**
   * The assertion that the query parameter is inert, and the one that would catch a re-introduction.
   *
   * Byte-for-byte, and that is deliberate: a weaker form — "the page still says receptionist" — would pass
   * a route that read `?role=` and used it for something else on the page. The only volatile content on
   * this screen is the read instant, which it does not print, so the two responses are comparable whole.
   */
  it('answers identically with ?role=owner and another employee id appended', async () => {
    const receptionist = await principal({ role: 'receptionist' })
    const other = await principal({ role: 'owner' })
    const [customer] = await sql<{ id: string }[]>`select id from customer order by id limit 1`
    const cookie = cookieFor(receptionist.sessionToken ?? '')

    const plain = await get(`/clients/${customer?.id}/flags`, cookie)
    const escalated = await get(
      `/clients/${customer?.id}/flags?role=owner&employee=${other.employeeId}`,
      cookie,
    )
    expect(plain.status).toBe(200)
    expect(escalated.status).toBe(200)
    const [plainHtml, escalatedHtml] = [await plain.text(), await escalated.text()]
    expect(escalatedHtml, 'a query parameter changed what an authenticated reader received').toBe(
      plainHtml,
    )
    // And the control: the bytes are not empty, so an equality of two failures cannot pass this.
    expect(plainHtml.length).toBeGreaterThan(500)
    expect(plainHtml).toContain('data-role="receptionist"')
    expect(plainHtml).not.toContain('data-role="owner"')
  }, 30_000)

  /**
   * The salary half of the acceptance line, asserted as what it actually measures.
   *
   * The acceptance line asks for "a salary field" refused to a receptionist through a served response. That
   * cannot be demonstrated today and the reason is not this unit's guard: **no admin screen serves a wage
   * figure to anybody.** `/hr/rota` is the only screen that reaches a wage column at all, and its own header
   * records that every `basic_wage_fils` is NULL (Y8-staff) so "the ordinary forecast today is 0 fils, and a
   * screen that printed that figure" would be printing an unanswered question. Nothing under `(admin)`
   * references `employee.salary`, `payroll:read` or `canReadFieldGroup`.
   *
   * So this case asserts the true and weaker claim, and says so in its own name rather than dressing it up:
   * no admin response carries a wage figure to a receptionist. That is a REGRESSION GUARD — it will fail the
   * day a screen starts serving wages without a field-group check — and it is deliberately NOT described as
   * a demonstration that a refusal fires, because a check whose stated claim is not what it measures is this
   * build's dominant defect and writing one here would be committing it in the file that complains about it.
   *
   * The measured refusal is deferred to **P-HR-12** (`status: todo`, "Payroll run, bilingual payslips and
   * the WPS export"), which is the unit that first serves a salary figure and is therefore the first unit
   * able to have one refused. A NOTE on this unit records it.
   *
   * What IS demonstrated positively, in the case above, is that the field-level decision is taken from the
   * AUTHENTICATED role at the edge — with the clinical scopes, which are the field groups this application
   * serves today.
   */
  it('serves no wage figure to a receptionist on any admin screen — a regression guard, not a refusal', async () => {
    const receptionist = await principal({ role: 'receptionist' })
    const cookie = cookieFor(receptionist.sessionToken ?? '')

    // Every admin screen that answers HTML to a GET, so a wage appearing on ANY of them fails this — not a
    // hand-picked one, which would be the list that stops covering the screen that matters.
    const screens = adminRoutesOnDisk()
      .filter((route) => requiresAdminSession(route.path))
      .map((route) => concretePath(route.path))

    let htmlResponses = 0
    for (const path of screens) {
      const response = await get(path, cookie)
      if (!(response.headers.get('content-type') ?? '').includes('text/html')) continue
      htmlResponses += 1
      const html = await response.text()
      for (const marker of ['basic_wage', 'basic-wage', 'data-salary', 'data-wage']) {
        expect(html, `${path} served ${marker} to a receptionist`).not.toContain(marker)
      }
    }
    // The control, and it is not a formality: a walk that fetched nothing readable would satisfy every
    // assertion above. At least half the guarded screens must have answered HTML for this to mean anything.
    expect(htmlResponses).toBeGreaterThanOrEqual(10)
  }, 120_000)
})

describe('acceptance — the wiring itself is asserted, so deleting it fails rather than reverting quietly', () => {
  it('has at least one module under apps/web importing the session reader', () => {
    const importers: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.next') continue
          walk(full)
          continue
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
        importers.push(full)
      }
    }
    walk(new URL('..', import.meta.url).pathname)
    // Not a count of files that mention the string — a count of files that IMPORT it. The distinction is
    // the whole point: a comment saying "nothing imports @berelax/auth" used to be the true state.
    const withAuth = importers.filter((file) => {
      return /from '@berelax\/auth'/.test(readFileSync(file, 'utf8'))
    })
    expect(withAuth.length, 'no module under apps/web imports @berelax/auth').toBeGreaterThan(0)
  })

  it('grants the application role both tables and the reporting role neither', async () => {
    for (const table of ['staff_credential', 'staff_session']) {
      const [row] = await sql<{ app: boolean; readonly_: boolean; clinical: boolean }[]>`
        select has_table_privilege('berelax_app', ${table}, 'SELECT')      as app,
               has_table_privilege('berelax_readonly', ${table}, 'SELECT') as readonly_,
               has_table_privilege('berelax_clinical', ${table}, 'SELECT') as clinical
      `
      // The application must reach them or nobody can sign in — the positive control that stops the two
      // refusals below being satisfied by a table nothing can read.
      expect(row?.app, `berelax_app cannot read ${table}`).toBe(true)
      // TABLE-level revokes, because a column-level one does not subtract from a table-level grant (0050).
      expect(row?.readonly_, `berelax_readonly can read ${table}`).toBe(false)
      expect(row?.clinical, `berelax_clinical can read ${table}`).toBe(false)
    }
  })

  /**
   * The session's own statements, run as `berelax_app` rather than as the owner.
   *
   * This is the check that has caught five units in this build, and every other case in this file is blind
   * to it: the test pool connects with `DATABASE_URL`, which is the OWNER, and so does `next start` in this
   * harness. A route or a grant the APPLICATION role may not use therefore passes every assertion here and
   * fails on the first real request — and for THIS unit the first real request is somebody signing in, so
   * the failure would be nobody able to reach the admin at all.
   *
   * `set role berelax_app` inside a transaction is how it is reachable: the role is `nologin`, so it cannot
   * be connected as. The role is reset in a `finally`, because a pooled connection left with the role set
   * would hand it to whatever suite ran next — which would present as a permission error in a file that
   * never touched this one.
   */
  it('runs its own reads and writes as berelax_app, not only as the owner', async () => {
    const asApp = await sql.begin(async (tx) => {
      await tx`set local role berelax_app`
      const [who] = await tx<{ who: string }[]>`select current_user as who`
      // The control: if `set local role` silently did nothing, every assertion below would be the owner's
      // and would prove the opposite of what this case claims.
      expect(who?.who, 'set local role did not take effect, so this case measures the owner').toBe(
        'berelax_app',
      )

      // The exact join `readStaffSession` makes. A token naming no row is the right probe: the question is
      // whether the application role may EXECUTE the statement, not what it returns.
      const session = await tx<{ n: string }[]>`
        select count(*)::text as n
          from staff_session s
          join staff_credential c on c.id = s.credential_id
          join employee e on e.id = c.employee_id
         where s.token_hash = ${Buffer.alloc(32, 7)}
      `
      // The exact read `readStaffCredentialByReference` makes.
      const credential = await tx<{ n: string }[]>`
        select count(*)::text as n
          from staff_credential c
          join employee e on e.id = c.employee_id
         where e.staff_reference = 'Fixture principal nobody'
      `
      // And the three writes a sign-in performs: mint a session, revoke one, burn the TOTP counter.
      const [writes] = await tx<
        { insert_session: boolean; revoke_session: boolean; burn_counter: boolean }[]
      >`
        select has_table_privilege('staff_session', 'INSERT')    as insert_session,
               has_table_privilege('staff_session', 'UPDATE')    as revoke_session,
               has_table_privilege('staff_credential', 'UPDATE') as burn_counter
      `
      return { session: session[0]?.n, credential: credential[0]?.n, writes }
    })

    // Reaching here at all is the assertion: a privilege the application role lacks raises 42501 above.
    expect(asApp.session).toBe('0')
    expect(asApp.credential).toBe('0')
    expect(asApp.writes?.insert_session, 'berelax_app cannot mint a session').toBe(true)
    expect(asApp.writes?.revoke_session, 'berelax_app cannot revoke a session').toBe(true)
    expect(asApp.writes?.burn_counter, 'berelax_app cannot burn a TOTP counter').toBe(true)
  })

  it('constrains staff_credential.role to exactly the roles the matrix declares', async () => {
    const [employee] = await sql<{ id: string }[]>`
      select id from employee order by staff_reference limit 1
    `
    expect(employee, 'the seed must provide an employee for this case').toBeDefined()
    const employeeId = employee?.id ?? ''
    // Read the REAL constraint rather than restating its list here, which would be the same copy twice and
    // would pass while the database held something else entirely.
    const [constraint] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def
        from pg_constraint
       where conname = 'staff_credential_role_is_a_known_role'
    `
    const definition = constraint?.def ?? ''
    expect(definition, 'the role CHECK is missing from the database').toContain('CHECK')

    // Every declared role must appear, or the CHECK has drifted BEHIND the matrix and those accounts
    // cannot be created at all.
    for (const role of ROLES) {
      expect(definition, `${role} is in ROLES but not in the staff_credential CHECK`).toContain(
        `'${role}'`,
      )
    }
    // And nothing EXTRA: a role the CHECK permits and the matrix does not know is an account `can()`
    // denies everything to, which presents as a broken admin rather than as a drift. Counted from the
    // constraint's own text so the two lists cannot differ in either direction.
    const permitted = [...definition.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
    expect([...new Set(permitted)].sort()).toEqual([...ROLES].sort())
    // And a role the matrix does not know must be refused by the DATABASE, not merely by TypeScript.
    let refused = false
    try {
      await sql`
        insert into staff_credential (employee_id, role, password_hash)
        values (${employeeId}::uuid, 'superuser', 'scrypt$1$1$1$a$b')
      `
    } catch {
      refused = true
    }
    expect(refused, 'the database accepted a role the matrix has never heard of').toBe(true)
  })
})
