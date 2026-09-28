import {
  assertAuthenticated,
  hashPassword,
  type LoginStage,
  resolveLoginStage,
  verifyPassword,
  verifyTotp,
} from '@berelax/auth'
import { loadConfig } from '@berelax/config'
import { ROLES, type Role, requiresTotp } from '@berelax/core'
import {
  createConnection,
  readStaffCredentialByReference,
  readStaffSession,
  type Sql,
  STAFF_SESSION_TTL_MS,
  type StaffCredentialRecord,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import {
  ADMIN_LOGIN_PATH,
  ADMIN_SESSION_COOKIE,
  adminSessionCookie,
  adminSessionTokenFrom,
  clearedAdminSessionCookie,
  RETURN_TO_PARAM,
  safeReturnTo,
} from './session-cookie.ts'

/**
 * The admin session, at the web boundary — W-SYS-11.
 *
 * This module is the answer to a question 56 manifest references deferred to W-SYS-01, a unit that is
 * `status: done` and built the Next.js app shell: **how does an admin route know who is reading?** Until
 * now it did not. Every screen took `?employee=` and `?role=` from the query string and said so in a
 * comment, and `@berelax/auth` — F07's password, TOTP and session primitives — was imported by nothing in
 * this application at all.
 *
 * ## The one property everything else rests on
 *
 * **The cookie is not information.** It carries 32 random bytes: no role, no permission, no employee id,
 * no signature, no expiry claim — nothing an attacker could edit into something better. The role comes
 * from a row reached by joining a live `staff_session` to its `staff_credential`, which the client cannot
 * touch. Three consequences, and each is a thing that has gone wrong in other systems:
 *
 *   1. **A tampered cookie names no row**, so it is refused. It cannot assert a role, because there is no
 *      field in it to assert one in. Contrast a signed cookie carrying `{role}`: that is refused only for
 *      as long as the signature check is correct and present on every path.
 *   2. **A demotion takes effect on the next request.** A JWT's claims are a copy of the row taken at
 *      login, and changing somebody's role does not reach the copies — so the remedy is a revocation list,
 *      which is a session table with extra steps.
 *   3. **There is no state where a session's authority disagrees with its credential's**, because there is
 *      only one copy of the role and it is not in the session.
 *
 * ## `?role=` could only NARROW, and this must not turn that into a widening
 *
 * C-CRM-09 built `/clients/[id]/flags` so the claimed role was intersected with a receptionist ceiling in
 * `@berelax/core`, which holds `clinical_flags:read` and not `clinical_note:read`. That made `?role=` safe
 * to take from a query string: no value could unlock the detail behind a marker.
 *
 * Replacing a *claimed* role with an *authenticated* one removes the need for that ceiling — a therapist
 * assigned to the client legitimately holds `clinical_note:read`, and the ceiling would refuse them their
 * own permission for ever. But removing it is only safe because the role is no longer something the
 * request carries, so the narrowing is replaced by authentication rather than by nothing. The check that
 * says so is not "the ceiling is gone": it is that **a query parameter can no longer change the answer**.
 * `apps/web/src/session.itest.ts` asserts that appending `?role=owner&employee=<somebody else>` to an
 * authenticated receptionist's request changes not one byte of the response. That is the assertion that
 * would catch a re-introduction, and it is the one gate case 117 proves can fail.
 */

/**
 * The cookie's `Max-Age`, derived from the row's TTL rather than typed again.
 *
 * Derived because two numbers meaning one thing is a future disagreement, and the direction it would
 * disagree in is the bad one: a cookie outliving its row is a reader who appears signed in and is refused
 * by every screen, which presents as "the admin is broken" rather than as "your session expired".
 */
export const STAFF_SESSION_TTL_SECONDS = Math.floor(STAFF_SESSION_TTL_MS / 1000)

/**
 * Who is making this request. The web layer's principal, with a `role` the matrix knows.
 *
 * The only way to obtain one is {@link principalForRequest}, from a database row. There is deliberately no
 * constructor, no parser and no `fromHeaders` that trusts anything: a principal that could be built from
 * a request is a principal a request can claim.
 */
export interface AdminPrincipal {
  readonly sessionId: string
  readonly credentialId: string
  readonly employeeId: string
  /** The employment record's internal handle. An audit label that names no person (ADR 0020). */
  readonly staffReference: string
  readonly role: Role
}

/** Why a request has no principal. Distinct values because they are different screens. */
export type AdminRefusal = 'no_cookie' | 'unknown_session' | 'expired_session' | 'revoked_session'

export type AdminAuthOutcome =
  | { readonly kind: 'principal'; readonly principal: AdminPrincipal }
  | { readonly kind: 'refused'; readonly refusal: AdminRefusal }

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value)

/**
 * Who is making this request, from the session cookie alone.
 *
 * The narrowing of `role` happens here rather than in `@berelax/db`, because `Role` and the matrix that
 * gives it meaning live in `packages/core` and `packages/db` may not import it (brief rule 4). An
 * unrecognised role is treated as **no principal at all**, not as a role: the database CHECK makes that
 * unreachable through the repository, but a hand-edited row or a future migration can hold anything, and
 * `can(role, …)` deciding on a string the matrix has never heard of is worse than a refusal. Deny by
 * default, one path — the position `principalFrom` already takes for Payload's users.
 */
export async function principalForRequest(
  sql: Sql,
  request: Request,
  nowIso: string,
): Promise<AdminAuthOutcome> {
  const token = adminSessionTokenFrom(request.headers.get('cookie'))
  if (token === null) return { kind: 'refused', refusal: 'no_cookie' }

  const resolved = await readStaffSession(sql, token, nowIso)
  if (resolved.kind === 'unknown') return { kind: 'refused', refusal: 'unknown_session' }
  if (resolved.kind === 'expired') return { kind: 'refused', refusal: 'expired_session' }
  if (resolved.kind === 'revoked') return { kind: 'refused', refusal: 'revoked_session' }

  const { principal } = resolved
  if (!isRole(principal.role)) return { kind: 'refused', refusal: 'unknown_session' }
  return {
    kind: 'principal',
    principal: {
      sessionId: principal.sessionId,
      credentialId: principal.credentialId,
      employeeId: principal.employeeId,
      staffReference: principal.staffReference,
      role: principal.role,
    },
  }
}

/**
 * The response an unauthenticated admin request gets.
 *
 * **303 and not 401**, and the reason is that every admin surface in this application is a `route.ts`
 * answering `text/html` for a human at a front desk. A 401 with a body is a page an operator reads and
 * cannot act on; a 303 to the login screen with their destination remembered is the thing they wanted. The
 * status is asserted per route by `apps/web/src/session.itest.ts`, so this is a decision made once.
 *
 * 303 specifically, not 302: it forces the follower to use GET. An unauthenticated POST to
 * `/calendar` — a reschedule, say — must not be replayed as a POST to the login screen with the
 * reschedule's body attached.
 *
 * `cache-control: no-store` because a cached redirect to a login page is served to the next reader who is
 * already signed in, and `Vary: Cookie` because the same URL answers differently depending on the cookie —
 * without it a shared cache may serve this redirect to an authenticated request.
 */
export function adminLoginRedirect(request: Request): Response {
  const url = new URL(request.url)
  const destination = new URL(ADMIN_LOGIN_PATH, url.origin)
  const returnTo = `${url.pathname}${url.search}`
  if (returnTo !== ADMIN_LOGIN_PATH) {
    destination.searchParams.set(RETURN_TO_PARAM, returnTo)
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: destination.toString(),
      'cache-control': 'no-store',
      vary: 'Cookie',
    },
  })
}

/**
 * The guard every admin route calls, and the one shape a route may use.
 *
 * Returns the principal, or a `Response` the route must return unchanged. A `Response` rather than a throw,
 * because every one of these routes already has a `catch` that maps an error to a 400 or a 503 — throwing
 * here would be caught by it and turned into "the page could not be read", which is a different claim from
 * "you are not signed in" and sends the operator to look for an outage.
 *
 * ## Why this is not middleware alone
 *
 * `apps/web/proxy.ts` also refuses an admin path with no cookie, and that is what makes a route added later
 * refused BY DEFAULT rather than refused once somebody remembers. But the proxy is not the authentication
 * and must not be mistaken for it: it cannot reach the database, so it can only see whether a cookie is
 * present, not whether it names a live session. A present-but-forged cookie passes the proxy and is refused
 * *here*. That layering is asserted rather than assumed — `session.itest.ts` drives every admin route with
 * a syntactically valid cookie naming no row, which the proxy cannot refuse, and requires a refusal anyway.
 * Relying on middleware for authorisation is also how CVE-2025-29927 worked; the authoritative check being
 * in the handler is what makes a bypass of the edge uninteresting.
 */
export async function requireAdminPrincipal(
  sql: Sql,
  request: Request,
  nowIso: string,
): Promise<{ readonly principal: AdminPrincipal } | { readonly response: Response }> {
  const outcome = await principalForRequest(sql, request, nowIso)
  if (outcome.kind === 'principal') return { principal: outcome.principal }
  return { response: adminLoginRedirect(request) }
}

/**
 * The same guard, for a route with no connection in hand.
 *
 * {@link requireAdminPrincipal} is the right shape for a handler that already opens a pool and can resolve
 * the session inside it. Most admin routes are not that shape: several open their connection deep inside a
 * `withSql` closure after work this check has to precede, and three — the two revalidate endpoints and
 * `test-connection` — never touch the database at all. Threading a connection out to the top of each of
 * those was the alternative, and it would have meant restructuring twenty-odd handlers written by other
 * units to add a check, which is how a mechanical change acquires real defects.
 *
 * So this opens a connection of its own, resolves, and closes it. The cost is one short-lived connection
 * per admin request on the routes that also open one — `max: 1`, because it issues exactly one query. That
 * is a real cost and it is the right trade here: these are back-office screens used by a handful of staff,
 * and the alternative was a riskier diff across handlers this unit does not own.
 *
 * It takes the clock from `Date.now()` rather than an argument, which is the one thing in this module that
 * is not injected. Every route below it already reads the wall clock for its own `adminChromeFor` call, and
 * expiry under a FROZEN clock is asserted against `readStaffSession` directly — which does take the instant
 * — so nothing is made untestable by it.
 */
export async function guardAdminRoute(
  request: Request,
): Promise<{ readonly principal: AdminPrincipal } | { readonly response: Response }> {
  let sql: Sql | null = null
  try {
    const config = loadConfig()
    sql = createConnection({ url: config.DATABASE_URL, max: 1 })
    return await requireAdminPrincipal(sql, request, new Date().toISOString())
  } catch (error) {
    /*
      It FAILS CLOSED, and it never throws.

      Not throwing is what lets this be the first statement of a handler, before its own `try`. If it threw,
      every call site would have to be inside the route's existing `catch` — which maps an error to that
      route's own 400 or 503 and would report a failed session check as "the page could not be read".

      Failing closed is the part that matters. If the database is unreachable this cannot tell a live session
      from a forged one, and the only safe answer to "I cannot check" is "no". The tempting alternative — let
      the request through and rely on the route's own query failing — is how an outage becomes an
      authorisation bypass on the one route that happens not to need the database.

      503 and not the login redirect, because the two are different facts: a redirect tells an operator to
      sign in, and they would, and it would fail again. This says the check itself could not be made.
    */
    const detail = isAppError(error) || error instanceof Error ? error.message : 'Unexpected'
    return {
      response: new Response(
        `Your session could not be verified, so this page is refused: ${detail}\n`,
        {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        },
      ),
    }
  } finally {
    if (sql !== null) await sql.end({ timeout: 5 })
  }
}

/**
 * A password hash nobody's password matches, verified against when the handle is unknown.
 *
 * Computed once at module load and not per request: `hashPassword` is scrypt at N = 2^16 and takes tens of
 * milliseconds, which is the point for a real password and would be a denial-of-service vector if an
 * attacker could make the server do it by posting an unknown handle.
 *
 * The value it hashes is a literal in this file, which is safe to have here for two independent reasons and
 * both are worth stating because `scripts/check-secrets.mjs` is entitled to ask. It is not a credential:
 * no row holds this hash, so nothing can be signed in to with it. And it carries the placeholder
 * vocabulary that gate's `PLACEHOLDER` rule looks for, so it is exempt by shape as well as by fact.
 */
const UNKNOWN_HANDLE_HASH = hashPassword('fixture-unused-never-a-real-password-A1')

/**
 * What a login attempt produced.
 *
 * `stage` is F07's, unchanged: this function's job is to gather the four facts `resolveLoginStage` needs
 * and let it decide. The credential is returned alongside so the caller can mint a session for it without
 * looking it up twice, and `totpCounter` is the counter that must be burned — `null` when no code was
 * verified, which is every stage but `authenticated`.
 */
export interface LoginAttemptOutcome {
  readonly stage: LoginStage
  readonly credential: StaffCredentialRecord | null
  readonly totpCounter: number | null
}

/**
 * Resolves a login attempt against the database, without writing anything.
 *
 * ## Why the state machine is F07's and not re-implemented here
 *
 * `resolveLoginStage` already models "password verified but no second factor" as a distinct stage that is
 * not authenticated, which is what makes *logged in without TOTP* unrepresentable rather than merely
 * discouraged. Re-deriving that here with a few `if`s would be a second policy, and the second policy is
 * the one that disagrees. So this function's whole job is to answer the four booleans honestly and hand
 * them over.
 *
 * ## An unknown handle and a wrong password do the same work
 *
 * Both verify a password — an unknown handle against {@link UNKNOWN_HANDLE_HASH} — so the response time
 * does not say which handles exist. A member of staff's handle is not secret, but a login that answers
 * faster for a name that is not on the payroll enumerates the payroll, and `otp_challenge` (0019) made the
 * same argument for phone numbers.
 *
 * ## There is no fallback when there is no credential at all
 *
 * A deployment with an empty `staff_credential` table refuses every login, and this is where that is true:
 * an unknown handle is `password_required` and nothing else. No development bypass, no default owner, no
 * environment variable standing in for a row. A first credential is an operator's INSERT
 * (docs/runbooks/admin-access.md), which is deployment work with a record of who did it.
 */
export async function resolveLoginAttempt(
  sql: Sql,
  input: {
    readonly staffReference: string
    readonly password: string
    readonly totpCode: string | null
    readonly nowMs: number
  },
): Promise<LoginAttemptOutcome> {
  const credential = await readStaffCredentialByReference(sql, input.staffReference.trim())

  if (credential === null) {
    // Same work as a real attempt, so an unknown handle is not faster. The result is discarded.
    await verifyPassword(input.password, await UNKNOWN_HANDLE_HASH)
    return { stage: { stage: 'password_required' }, credential: null, totpCounter: null }
  }

  // An unrecognised role is no login at all, for `principalForRequest`'s reason: the matrix cannot decide
  // about a string it has never heard of, and a row with a bad role must not become a session.
  if (!isRole(credential.role)) {
    await verifyPassword(input.password, await UNKNOWN_HANDLE_HASH)
    return { stage: { stage: 'password_required' }, credential: null, totpCounter: null }
  }
  const role: Role = credential.role

  const passwordVerified = await verifyPassword(input.password, credential.passwordHash)
  if (!passwordVerified) {
    return { stage: { stage: 'password_required' }, credential, totpCounter: null }
  }

  const totpEnrolled = credential.totpSecret !== null
  let totpVerified = false
  let totpCounter: number | null = null
  if (totpEnrolled && credential.totpSecret !== null && input.totpCode !== null) {
    const result = verifyTotp(credential.totpSecret, input.totpCode, input.nowMs, {
      // The counter the credential has already consumed, so the same code inside one 30-second window is
      // answered `replayed` rather than `valid`. Without it the second factor stops being one for thirty
      // seconds after every login, which is long enough for somebody reading over a shoulder.
      ...(credential.totpLastCounter === null
        ? {}
        : { lastUsedCounter: credential.totpLastCounter }),
    })
    totpVerified = result.valid
    totpCounter = result.counter ?? null
  }

  const stage = resolveLoginStage({ role, passwordVerified, totpEnrolled, totpVerified })
  return { stage, credential, totpCounter: stage.stage === 'authenticated' ? totpCounter : null }
}

/**
 * F07's own guard, re-exported so a caller cannot be tempted to test `stage === 'authenticated'` itself.
 *
 * It throws rather than returning false, which is what a call site that must not proceed needs — and it is
 * the reason `resolveLoginAttempt` returns a stage rather than a boolean.
 */
/**
 * The pure cookie surface, re-exported so a route imports one module.
 *
 * It lives in `./session-cookie.ts` because `apps/web/proxy.ts` needs the parse and the path constants and
 * must NOT pull `@berelax/auth`'s `node:crypto` or `@berelax/db`'s `postgres.js` into Next's middleware
 * bundle. See that file's header.
 */
export {
  ADMIN_LOGIN_PATH,
  ADMIN_SESSION_COOKIE,
  adminSessionCookie,
  adminSessionTokenFrom,
  assertAuthenticated,
  clearedAdminSessionCookie,
  RETURN_TO_PARAM,
  requiresTotp,
  safeReturnTo,
}
