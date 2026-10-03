import { loadConfig } from '@berelax/config'
import {
  createConnection,
  recordTotpCounter,
  type Sql,
  startStaffSession,
  withUnitOfWork,
} from '@berelax/db'
import { isAppError, STAFF_SESSION_REFUSED_ACTION } from '@berelax/shared'
import {
  adminSessionCookie,
  assertAuthenticated,
  type LoginAttemptOutcome,
  RETURN_TO_PARAM,
  resolveLoginAttempt,
  STAFF_SESSION_TTL_SECONDS,
  safeReturnTo,
} from '../../../src/session.ts'
import { type LoginProblem, type LoginView, renderLoginPageHtml } from './render.ts'

/**
 * `GET|POST /login` — the admin sign-in screen (W-SYS-11).
 *
 * The one route in the `(admin)` group that is NOT behind the guard, for the obvious reason, which is why
 * `ADMIN_UNGUARDED_PATHS` in `apps/web/src/routes/admin-routes.ts` names it explicitly rather than the
 * guard's absence here being indistinguishable from a route that forgot it. That list has exactly one
 * entry and `session.itest.ts` asserts its length, so adding a second unguarded admin route is a failing
 * test rather than a quiet hole.
 *
 * ## Why a `route.ts` and not a `page.tsx`
 *
 * The reason every admin surface in this application gives, and it applies here unchanged:
 * `apps/web/src/routes/registry.ts` is in exact bijection with the filesystem and requires every
 * *document* to be served in **both** locales, so a `page.tsx` would need an Arabic admin document and a
 * root layout to render it — and it would join a screenshot matrix whose RTL half has to be a real Arabic
 * route. Three units have now found this and reached the same shape: `route.ts` plus `render.ts`. The
 * admin estate is deliberately English-only.
 *
 * ## What a POST does, in order, and why the order matters
 *
 * 1. Read the form. A missing field is `incomplete` and never an empty-string password, because an empty
 *    password compared against a real hash is a comparison that should never be reached at all.
 * 2. `resolveLoginAttempt` — one credential read, one scrypt verification, and `verifyTotp` when a code
 *    was supplied. It writes nothing.
 * 3. `assertAuthenticated(stage)` — F07's own guard, which throws for every stage but `authenticated`.
 *    The stage is not compared here: `stage.stage === 'authenticated'` written at a call site is the
 *    second copy of the policy, and the second copy is the one that gets a `|| stage === 'totp_required'`
 *    added to it during a demo.
 * 4. In ONE transaction: burn the TOTP counter, then mint the session. Both or neither — a session whose
 *    code was never burned is a code that can be replayed, and a burned code with no session is a login
 *    somebody has to retry, so the atomicity is load-bearing in both directions.
 *
 * ## Why the redirect is 303 and carries the cookie
 *
 * A successful POST answers 303 to the remembered destination with the `Set-Cookie` attached, rather than
 * rendering the destination itself. That is post/redirect/get: it means a refresh after signing in does
 * not re-post the password, and the back button does not land on a document containing it.
 */
export const dynamic = 'force-dynamic'

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** The headers every response from this route carries. */
function noStore(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    // A sign-in page must never be cached: a stored copy is served to the next person at the terminal,
    // and a stored copy of the POST response would be served with somebody else's session in it.
    'cache-control': 'no-store',
    // The same URL answers differently depending on the cookie, so a shared cache must not reuse one
    // reader's response for another's request.
    vary: 'Cookie',
    ...extra,
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const returnTo = safeReturnTo(url.searchParams.get(RETURN_TO_PARAM))
  return new Response(renderLoginPageHtml({ kind: 'credentials', problem: null }, returnTo), {
    headers: noStore(),
  })
}

/** A trimmed form field, or null when it is absent or blank. */
function fieldOf(form: FormData, name: string): string | null {
  const raw = form.get(name)
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value === '' ? null : value
}

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData()
    const staffReference = fieldOf(form, 'staffReference')
    const password = fieldOf(form, 'password')
    const totpCode = fieldOf(form, 'totpCode')
    const returnTo = safeReturnTo(fieldOf(form, 'returnTo'))

    if (staffReference === null || password === null) {
      return new Response(
        renderLoginPageHtml({ kind: 'credentials', problem: 'incomplete' }, returnTo),
        { status: 400, headers: noStore() },
      )
    }

    const nowMs = Date.now()
    const outcome = await withSql(async (sql) =>
      resolveLoginAttempt(sql, { staffReference, password, totpCode, nowMs }),
    )

    // Every stage but `authenticated` renders a page. None of them is a redirect and none is a 401: the
    // reader is standing at a terminal and needs the form again, with the reason on it.
    if (outcome.stage.stage !== 'authenticated') {
      await recordRefusedSignIn(outcome, totpCode)
      const view = viewFor(outcome.stage.stage, staffReference, totpCode)
      // 401 for a refused attempt and 200 for one that is merely incomplete-so-far. `totp_required` is
      // NOT a failure — the password was right and the next factor is being asked for — so answering 401
      // there would have a correct password logged as an authentication failure by every proxy in front
      // of this application.
      const status = outcome.stage.stage === 'password_required' ? 401 : 200
      return new Response(renderLoginPageHtml(view, returnTo), { status, headers: noStore() })
    }

    // Throws for anything but `authenticated`, which the branch above has already handled — so this is
    // unreachable today and is exactly the line that must stay. It is F07's guard, and it is what makes
    // the branch above a rendering decision rather than the security decision.
    assertAuthenticated(outcome.stage)
    const credential = outcome.credential
    if (credential === null) {
      // Unreachable: `authenticated` is only produced from a credential. A throw rather than a `!`, so
      // that a future change which broke the invariant surfaces as a 503 and not as a session for nobody.
      throw new Error('An authenticated login stage arrived with no credential.')
    }

    const session = await withSql(async (sql) =>
      withUnitOfWork(
        sql,
        // The actor is the credential's own employment record, labelled by its internal handle. Not a
        // person's name: `employee` holds none until an admin sets one with a photography consent
        // (ADR 0020, Y12-names), and an audit label is not the place to invent one.
        { kind: 'staff', id: credential.employeeId, label: `staff ${credential.staffReference}` },
        async (uow) => {
          // Burned FIRST, inside the same transaction as the insert. If this failed after the session
          // existed, the code would remain usable for the rest of its window.
          if (outcome.totpCounter !== null) {
            await recordTotpCounter(uow, credential.credentialId, outcome.totpCounter)
          }
          return startStaffSession(uow, {
            credentialId: credential.credentialId,
            nowIso: new Date(nowMs).toISOString(),
          })
        },
      ),
    )

    return new Response(null, {
      status: 303,
      headers: {
        location: new URL(returnTo, new URL(request.url).origin).toString(),
        'set-cookie': adminSessionCookie({
          token: session.token,
          maxAgeSeconds: STAFF_SESSION_TTL_SECONDS,
        }),
        'cache-control': 'no-store',
        vary: 'Cookie',
      },
    })
  } catch (error) {
    // A failed sign-in is never reported as a refusal: the two mean opposite things about whether the
    // password was right, and an operator told "that does not match" will type it again while the real
    // fault is a database that is down.
    const message = isAppError(error) || error instanceof Error ? error.message : 'Unexpected'
    return new Response(`Signing in could not be completed: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}

/**
 * Records a refused sign-in, so H-HARD-05's `repeated_auth_failure` alert has something to count.
 *
 * Before this, a refused attempt wrote NOTHING: a credential could be guessed indefinitely and the only
 * evidence was the absence of a `staff_session.started` row, which is also what a quiet night looks like.
 * `operation: 'denied'` is one of `ALWAYS_AUDITED` in `@berelax/db` precisely for this class of fact.
 *
 * Three decisions in nine lines, each of which is the reason the row is shaped the way it is.
 *
 * **The actor is `system` and not `staff`.** A refused attempt has no authenticated principal by
 * definition, so naming the account holder as the actor would attribute somebody else's guess to them in
 * an append-only table that cannot be corrected (ADR 0008). The label names the SURFACE, which is what
 * the diary, the pipeline board and the quick-book screen already correctly record when they have no
 * session to read (0128's ledger note says so). The credential is the ENTITY — the thing acted upon —
 * which is also what makes "repeated failures on one account" a `group by entity_id`.
 *
 * **Nothing is written when the staff reference does not resolve.** `resolveLoginAttempt` returns a
 * credential whenever the handle existed, even for a wrong password, so this covers every attempt
 * against a real account. An unknown handle writes no row, and that is deliberate twice over: there is
 * no account to alert anybody about, and the alternative would be putting arbitrary unauthenticated
 * input into the trail as an entity id.
 *
 * **`totp_required` with no code supplied is not a refusal.** The password was right and the second
 * factor is being asked for. Counting it would make every ordinary two-step sign-in a refused attempt,
 * which is the same mistake the 401-versus-200 decision above avoids — and the alert would fire on
 * normal use within a day.
 */
async function recordRefusedSignIn(
  outcome: LoginAttemptOutcome,
  totpCode: string | null,
): Promise<void> {
  const credential = outcome.credential
  if (credential === null) return
  const stage = outcome.stage.stage
  const refused = stage === 'password_required' || (stage === 'totp_required' && totpCode !== null)
  if (!refused) return
  await withSql(async (sql) =>
    withUnitOfWork(sql, { kind: 'system', label: 'admin sign-in' }, async (uow) => {
      await uow.audit.record({
        action: STAFF_SESSION_REFUSED_ACTION,
        entityType: 'staff_credential',
        entityId: credential.credentialId,
        operation: 'denied',
        // The STAGE and nothing else. Never the handle that was typed, never the password's length, and
        // never whether the password or the code was the part that failed for a reader who is not the
        // account holder: `audit_event` is append-only and is read by staff.
        after: { stage },
      })
    }),
  )
}

/** Which screen a non-authenticated stage renders. */
function viewFor(
  stage: 'password_required' | 'totp_required' | 'totp_enrolment_required',
  staffReference: string,
  totpCode: string | null,
): LoginView {
  if (stage === 'totp_enrolment_required') {
    return { kind: 'enrolment_required', staffReference }
  }
  if (stage === 'totp_required') {
    // A code was supplied and was not accepted, versus none supplied yet. The two are different messages
    // and collapsing them would tell somebody who has not been asked for a code that theirs was wrong.
    const problem: LoginProblem | null = totpCode === null ? null : 'totp_refused'
    return { kind: 'totp', staffReference, problem }
  }
  return { kind: 'credentials', problem: 'refused' }
}
