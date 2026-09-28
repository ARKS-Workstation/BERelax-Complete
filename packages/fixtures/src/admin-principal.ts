import { randomBytes } from 'node:crypto'
import { generateSecret, hashPassword } from '@berelax/auth'
import type { Role } from '@berelax/core'
import {
  generateStaffSessionToken,
  hashStaffSessionToken,
  type Sql,
  STAFF_SESSION_TTL_MS,
} from '@berelax/db'

/**
 * A staff principal a SUITE creates, for W-SYS-11's admin session.
 *
 * ## Why this exists at all, rather than a seeded admin account
 *
 * `Y8-staff` is open. The handover has supplied a headcount and nineteen photographs and nothing else — no
 * names, no contact details, no credentials — so `packages/db/src/seed` creates no `staff_credential` row
 * and migration 0090 seeds none. Brief rule 15 is the argument: a plausible admin account is
 * indistinguishable from a configured one, and an account nobody configured is an account nobody rotates.
 *
 * That leaves a real problem, which this module is the answer to: the login path and every guarded route
 * still have to be PROVEN against a real credential and a real session. So the suite creates its own, uses
 * it, and removes it. The consequence is the acceptance criterion rather than a limitation — a deployment
 * with no staff row refuses every login, and nothing in this file runs outside a test.
 *
 * ## It lives in `packages/fixtures` because that is the package allowed to reach both sides
 *
 * It needs `@berelax/auth` to hash a password and mint a TOTP secret, and `@berelax/db` to insert the rows.
 * `packages/fixtures` may depend on both (brief rule 4), which makes it the right home — and it keeps the
 * hashing out of `packages/db`, which may not import the matrix.
 *
 * ## Nothing here is a literal credential
 *
 * The password is a fixed string carrying the word `fixture`, which is deliberate twice over: it is
 * unmistakably not a real password to a reader, and `scripts/check-secrets.mjs`'s `PLACEHOLDER` rule exempts
 * it by shape as well. The TOTP secret and the session token are GENERATED at runtime and never written
 * down. That last point is not fussiness — `issueSession` produces 43 characters of base64url and
 * `generateStaffSessionToken` 64 of hex, both of which are exactly the shape the
 * `high-entropy-assigned-secret` rule is written for, and a token pasted into a test file as a literal has
 * already cost this build a whole verify run.
 */

/** Satisfies `assertPasswordPolicy` (12+, lower, upper, digit) and trips no secret-scanner rule. */
export const FIXTURE_PRINCIPAL_PASSWORD = 'Fixture-Principal-1'

/**
 * The prefix every fixture principal's staff reference carries.
 *
 * Exported so a cleanup can find strays by it, the way `packages/hr/src/employee.itest.ts` finds its own
 * with a `PREFIX` — and so that the 19 seeded therapists, whose references this must never collide with,
 * are distinguishable by a `like` in one place rather than by eye.
 */
export const FIXTURE_PRINCIPAL_REFERENCE_PREFIX = 'Fixture principal'

export interface FixturePrincipal {
  readonly employeeId: string
  readonly credentialId: string
  readonly staffReference: string
  readonly role: Role
  /** The plaintext, so a suite can POST it to the login form. */
  readonly password: string
  /** Base32, or null when this principal has no second factor enrolled. */
  readonly totpSecret: string | null
  /**
   * The raw session token, or null when `withSession: false`.
   *
   * The COOKIE is not built here on purpose: its name lives in `apps/web/src/session-cookie.ts`, and
   * `packages/fixtures` importing from `apps/web` would be a dependency running the wrong way. The suite
   * composes the header from `ADMIN_SESSION_COOKIE` and this, which also means a test cannot accidentally
   * assert against a cookie name this package invented.
   */
  readonly sessionToken: string | null
  /** Removes the rows this created, in foreign-key order. Safe to call twice. */
  readonly cleanup: () => Promise<void>
}

export interface CreateFixturePrincipalOptions {
  readonly role: Role
  /**
   * Enrol a TOTP factor. Required for a role `requiresTotp` answers true for, and the suite proves both
   * halves: enrolled reaches a session, absent reaches `totp_enrolment_required` and stops.
   */
  readonly enrolTotp?: boolean
  /** Mint a live session too. `false` leaves the credential alone, for driving the login form. */
  readonly withSession?: boolean
  /** The instant the session starts from. Defaults to now; a frozen one makes expiry assertable. */
  readonly nowIso?: string
  /** Session lifetime. A negative value produces an ALREADY-EXPIRED session, which is the point. */
  readonly ttlMs?: number
}

/**
 * Creates an employment record, a credential and (by default) a live session.
 *
 * A fresh `employee` row rather than a credential attached to one of the nineteen seeded therapists, and
 * the reason is brief rule 12: the integration suite runs sequentially against one database, and two suites
 * both claiming "the first seeded therapist" would collide on `staff_credential`'s UNIQUE constraint — a
 * failure whose message would name neither suite. A fresh row per call cannot collide.
 *
 * Creating employee rows is safe and already anticipated: `packages/hr/src/employee.itest.ts` asserts the
 * seeded nineteen by KEY-SET equality against their own references, saying in a comment that "other
 * integration files create their own employees in this shared database", precisely so that a
 * `count(*) from employee` is nobody's number.
 */
export async function createFixturePrincipal(
  sql: Sql,
  options: CreateFixturePrincipalOptions,
): Promise<FixturePrincipal> {
  const nowIso = options.nowIso ?? new Date().toISOString()
  const withSession = options.withSession ?? true
  // Random rather than a counter: a counter is per-process, and several suites share one database.
  const suffix = randomBytes(6).toString('hex')
  const staffReference = `${FIXTURE_PRINCIPAL_REFERENCE_PREFIX} ${suffix}`

  const [employee] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from)
    values (${staffReference}, ${nowIso}::date)
    returning id
  `
  if (employee === undefined) {
    throw new Error('Inserting a fixture employee returned no row.')
  }

  const totpSecret = options.enrolTotp === true ? generateSecret() : null
  const passwordHash = await hashPassword(FIXTURE_PRINCIPAL_PASSWORD)
  const [credential] = await sql<{ id: string }[]>`
    insert into staff_credential (employee_id, role, password_hash, totp_secret)
    values (${employee.id}::uuid, ${options.role}, ${passwordHash}, ${totpSecret})
    returning id
  `
  if (credential === undefined) {
    throw new Error('Inserting a fixture staff credential returned no row.')
  }

  let sessionToken: string | null = null
  if (withSession) {
    // Inserted directly rather than through `startStaffSession`, and deliberately: that function takes a
    // UnitOfWork and writes an audit row, which is right for a real sign-in and wrong for a fixture — every
    // suite that asserts an `audit_event` DELTA would see this one's rows. It also lets `ttlMs` go negative
    // to produce an already-expired session, which the real function refuses.
    sessionToken = generateStaffSessionToken()
    const ttlMs = options.ttlMs ?? STAFF_SESSION_TTL_MS
    const baseMs = Date.parse(nowIso)
    /*
      An already-expired session is made by BACKDATING creation, not by a negative lifetime.

      `staff_session_expires_after_it_starts` is `check (expires_at > created_at)`, so
      `created_at = now, expires_at = now - 60s` is refused by the database — which is correct, and the
      first version of this helper hit it. A row whose expiry precedes its creation is not an expired
      session, it is a nonsense one, and a fixture that needed the constraint relaxed to exist would have
      been a fixture arguing the schema should be weaker.

      So for a non-positive `ttlMs` the row is placed wholly in the past: created at `now + 2 * ttl`,
      expiring at `now + ttl`. The span between them is `-ttl`, which is positive, so the constraint holds
      and the row is genuinely expired relative to `nowIso`.
    */
    const createdMs = ttlMs > 0 ? baseMs : baseMs + 2 * ttlMs
    const expiresMs = baseMs + ttlMs
    await sql`
      insert into staff_session (credential_id, token_hash, expires_at, created_at)
      values (${credential.id}::uuid, ${hashStaffSessionToken(sessionToken)},
              ${new Date(expiresMs).toISOString()}, ${new Date(createdMs).toISOString()})
    `
  }

  return {
    employeeId: employee.id,
    credentialId: credential.id,
    staffReference,
    role: options.role,
    password: FIXTURE_PRINCIPAL_PASSWORD,
    totpSecret,
    sessionToken,
    cleanup: async () => {
      // Foreign-key order, and it is not the obvious one. `staff_session.credential_id` is ON DELETE
      // CASCADE so the sessions go with the credential, but `staff_credential.employee_id` is ON DELETE
      // RESTRICT — deleting the employee first RAISES. The migration chose RESTRICT so that removing an
      // employment record cannot silently take the record of their access with it.
      await sql`delete from staff_credential where id = ${credential.id}::uuid`
      await sql`delete from employee where id = ${employee.id}::uuid`
    },
  }
}

/**
 * The `staff_session` row count for a credential, live or not. For a suite asserting a session was created.
 *
 * Counted in SQL rather than read through a capped list, which is `settings-store.itest.ts`'s lesson
 * (brief rule 12): a limit is right for a panel and wrong for a count.
 */
export async function countStaffSessions(sql: Sql, credentialId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from staff_session where credential_id = ${credentialId}::uuid
  `
  return Number(row?.n ?? '0')
}
