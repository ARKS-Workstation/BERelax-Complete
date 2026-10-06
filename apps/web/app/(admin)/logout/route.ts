import { loadConfig } from '@berelax/config'
import { createConnection, revokeStaffSession, withUnitOfWork } from '@berelax/db'
import {
  ADMIN_LOGIN_PATH,
  adminSessionTokenFrom,
  clearedAdminSessionCookie,
  principalForRequest,
} from '../../../src/session.ts'

/**
 * `POST /logout` — ends the signed-in reader's session.
 *
 * ## Why this did not exist until the admin got a topbar
 *
 * Every piece of it did. `revokeStaffSession` is in `@berelax/db`, complete with the
 * `staff_session.revoked` audit row; `clearedAdminSessionCookie` is in `apps/web/src/session-cookie.ts`
 * and re-exported from `session.ts`. Neither had a caller anywhere in `apps/web/app`. The primitives were
 * written for a sign-out and no route was ever pointed at them, so a signed-in session could be waited out
 * and not ended — which is the one thing a shared front-desk terminal needs most.
 *
 * It surfaced because the shell has a topbar, and a topbar with no sign-out control is not a design
 * decision, it is a dead end. The alternative was a button pointing at nothing.
 *
 * ## POST, and never GET
 *
 * A GET that ends a session is a session anybody can end with an `<img src="/logout">` on any page the
 * reader happens to be looking at. There is no CSRF token to check here and none is needed: the method
 * is the defence, because a cross-site `<img>`, `<link>` or prefetch cannot issue a POST, and a
 * cross-site form POST cannot read the response — and the worst it could achieve is signing somebody out,
 * which is the safe direction for a forced action to point.
 *
 * `GET` answers **405** with an `Allow` header rather than redirecting, so a prefetcher that follows the
 * control gets told no instead of quietly logging the operator out.
 *
 * ## It is idempotent, and it never reports failure
 *
 * Three states reach here — a live session, an already-revoked one, and no cookie at all — and all three
 * end the same way: the cookie is cleared and the reader is at the login screen. `revoked: false` is not
 * an error to report; it means somebody signed out twice, or their session had already expired, and a page
 * saying "you were not signed in" would be a worse answer than the one they wanted. The audit row is
 * written by `revokeStaffSession` only when a row actually changed, which keeps the trail about sessions
 * that existed.
 *
 * The cookie is cleared even when the revoke fails for an unexpected reason. A reader who asked to sign
 * out and is left holding a valid cookie because the database was busy is the failure mode that matters;
 * the row is already expiring on its own clock, and the cookie is the half this response controls.
 */
export async function POST(request: Request): Promise<Response> {
  const token = adminSessionTokenFrom(request.headers.get('cookie'))

  if (token !== null) {
    try {
      const sql = createConnection({ url: loadConfig().DATABASE_URL, max: 1 })
      try {
        /*
         * The actor is resolved BEFORE the revoke, because resolving it afterwards would read a session
         * that no longer exists and the audit row would be attributed to nobody. A session this cannot
         * resolve is still revoked — the token is the key, not the principal — and the actor falls back to
         * the system label, which is the honest record of "a token was presented and we could not say
         * whose it was".
         */
        const resolved = await principalForRequest(sql, request, new Date().toISOString())
        const actor =
          resolved.kind === 'principal'
            ? {
                kind: 'staff' as const,
                id: resolved.principal.employeeId,
                label: `staff ${resolved.principal.staffReference}`,
              }
            : { kind: 'system' as const, label: 'admin sign-out' }
        await withUnitOfWork(sql, actor, async (uow) =>
          revokeStaffSession(uow, token, new Date().toISOString()),
        )
      } finally {
        await sql.end({ timeout: 5 })
      }
    } catch {
      // Deliberately swallowed. See the header: the cookie is cleared either way, and a reader who asked
      // to sign out must not be left holding a usable one because the database was slow.
    }
  }

  return new Response(null, {
    status: 303,
    headers: {
      location: ADMIN_LOGIN_PATH,
      'set-cookie': clearedAdminSessionCookie(),
      // The response is per-session and must never be stored, which matters most for the one that ends
      // one: a cached 303 with a clearing cookie would sign out whoever was served it next.
      'cache-control': 'no-store',
    },
  })
}

/** 405 rather than a redirect, so a prefetch of the control is refused instead of obeyed. */
export function GET(): Response {
  return new Response(
    'Sign out is a POST. A GET that ended a session could be triggered by any page.\n',
    {
      status: 405,
      headers: {
        allow: 'POST',
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  )
}
