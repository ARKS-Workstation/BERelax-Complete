import { createHash, randomBytes } from 'node:crypto'
import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The admin session: mint a credential, resolve a cookie to a principal, end a session.
 *
 * W-SYS-11. The storage is migration 0090; the cookie and the guard are `apps/web/src/session.ts`.
 *
 * ## This module is the ONLY way a request learns who is reading
 *
 * Before it, every admin route took its reader from `?employee=` and `?role=`. Replacing that is not a
 * matter of reading a cookie instead of a query parameter — a cookie is just as much something the client
 * sends. What makes the difference is that the cookie's value is not information: it is an opaque 256-bit
 * token, and the role comes from a row the client cannot reach. {@link readStaffSession} performs that
 * lookup and returns a {@link StaffPrincipalRow}; nothing else in the application may construct one from a
 * request.
 *
 * ## Why the token is returned once and stored nowhere
 *
 * {@link startStaffSession} returns the plaintext token exactly once, to the caller that is about to put
 * it in a `Set-Cookie`. The row holds its SHA-256. A session token is a bearer credential for the whole
 * admin estate — the till, the salaries, the clinical flags — for as long as the row lives, so anything
 * that holds one is a credential store: a table, a log line, an audit row, a Sentry breadcrumb. The audit
 * rows below carry the session ID, never the token.
 *
 * SHA-256 rather than an HMAC under a per-row salt, the same deliberate difference from `hashOtpCode`
 * that `booking_session` states: a 256-bit random token has nothing to guess, and the lookup HAS to be by
 * hash — a per-row salt would make resolving a cookie a full-table scan. Fast on purpose, because no work
 * factor helps a value nobody can guess and 100 ms per request would be 100 ms on every admin page. The
 * PASSWORD is the value that needs a work factor and `hashPassword` gives it one (scrypt, N = 2^16).
 *
 * ## Why every instant is an argument
 *
 * Nothing here calls `now()` in SQL or reads the clock in JavaScript. Session expiry is the one behaviour
 * whose test would otherwise have to wait for it, which means in practice it would never be tested. The
 * caller passes the instant; the tests pass a frozen one.
 */

/** 32 bytes of CSPRNG. Hex-encoded rather than base64url, for two reasons that are both about other code. */
export const STAFF_SESSION_TOKEN_BYTES = 32

/**
 * How long an admin session lives, matching `SESSION_TTL.accessMs` in `@berelax/auth`.
 *
 * Thirty minutes of inactivity is not what this is — there is no touch-on-read, deliberately (see
 * {@link readStaffSession}) — so it is thirty minutes from sign-in, full stop. That is short for a
 * receptionist working a shift and it is the right trade for a screen standing unattended at a front desk
 * in a public reception area, which is the actual threat here rather than a stolen laptop.
 */
export const STAFF_SESSION_TTL_MS = 30 * 60 * 1000

/**
 * The digest stored for a token, as bytea.
 *
 * Hex-encoded input to a `digest()` returning a Buffer, and NOT `.digest('hex')`: the column is `bytea`
 * with `octet_length(token_hash) = 32`, and a 64-character hex string stored into it would be 64 octets
 * and refused. Exported so a test can assert the column holds this and not the token.
 */
export function hashStaffSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/**
 * A fresh session token.
 *
 * Hex rather than base64url, and the reason is not aesthetics. `issueSession` in `@berelax/auth` produces
 * base64url, which is 43 characters of single-encoding high-entropy text — exactly the shape
 * `scripts/check-secrets.mjs`'s `high-entropy-assigned-secret` rule is written for. A token that appears
 * in a test file, a log or a fixture as `token: '<43 chars>'` is a gate failure that costs a whole verify
 * run to diagnose. Hex is 64 characters and matches the same rule, so neither escapes it by shape — but
 * hex also needs no escaping in a cookie, a URL or a `psql` paste, which base64url's `-` and `_` do not
 * strictly need either but which reviewers keep quoting anyway. The rule this module actually relies on is
 * that no token is ever written into a file: they are generated at runtime, here.
 */
export function generateStaffSessionToken(): string {
  return randomBytes(STAFF_SESSION_TOKEN_BYTES).toString('hex')
}

/**
 * Who is making this request, as the DATABASE has it.
 *
 * Deliberately NOT constructible from anything a client sends: the only function that returns one is
 * {@link readStaffSession}, from a row. `employeeId` is here because it is what the clinical estate
 * authorises against — `clinical.step_up_grant` names an employee, and `resolveContraindicationAccess`
 * compares it against the assigned therapists — so a principal that carried only a role would still leave
 * those routes reading an employee id from the query string.
 *
 * ## `role` is a `string` here, and that is the module boundary rather than laziness
 *
 * `packages/db` may not import `packages/core` — the dependency runs the other way (brief rule 4), and
 * `Role` plus the matrix that gives it meaning both live in core. So this layer reports the column and
 * `apps/web/src/session.ts` narrows it, refusing a value the matrix has never heard of. That is where the
 * narrowing belongs anyway: `principalFrom` in `apps/web/src/payload/principal.ts` already does exactly
 * this for Payload's users and gives the reason — `can(role, …)` deciding on an unknown string is worse
 * than a refusal, and the check has to be at the boundary where the matrix is in scope.
 */
export interface StaffPrincipalRow {
  readonly sessionId: string
  readonly credentialId: string
  readonly employeeId: string
  /** The employment record's internal handle, for an audit label that names no person. */
  readonly staffReference: string
  /** Constrained by a CHECK to the eight `ROLES` declares; narrowed to `Role` by the web layer. */
  readonly role: string
}

/**
 * What a cookie resolved to.
 *
 * Four answers rather than a principal-or-null, because the four have different remedies and a caller that
 * cannot tell them apart shows the wrong screen. `expired` sends somebody to sign in again and is the
 * common case; `revoked` means they signed out, possibly on another device; `unknown` means the token
 * names no row at all, which is what a TAMPERED cookie produces and is the one worth counting.
 *
 * Collapsing `unknown` into `expired` would be the comfortable choice and it is wrong: it would tell an
 * attacker probing tokens the same thing it tells a receptionist whose session lapsed, and it would hide
 * the only signal that distinguishes the two.
 */
export type StaffSessionResolution =
  | { readonly kind: 'live'; readonly principal: StaffPrincipalRow; readonly expiresAtIso: string }
  | { readonly kind: 'expired'; readonly sessionId: string }
  | { readonly kind: 'revoked'; readonly sessionId: string }
  | { readonly kind: 'unknown' }

function instantOf(iso: string, field: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new AppError('validation', `${field} must be a parseable instant, received "${iso}"`)
  }
  return ms
}

/**
 * The session a cookie names, resolved to a principal.
 *
 * Takes an `Sql` rather than a `UnitOfWork`: this runs on every admin request and writes nothing,
 * including no `last_seen_at`. A touch column would make every page view a write on the hot path, and it
 * would also turn the TTL into an inactivity timeout, which is a different policy from the one
 * {@link STAFF_SESSION_TTL_MS} documents — a screen left open on a front desk would then never expire,
 * which is the case the TTL exists for.
 *
 * ## The expiry comparison is here and not in SQL
 *
 * `where expires_at > now()` would read the database's clock, and then no test could assert expiry without
 * waiting thirty minutes or moving the server's clock. The row is fetched and compared against the
 * injected instant, so `expired` is reachable in a test with a frozen clock — which is the only way it is
 * ever actually asserted.
 *
 * ## It reports the role column and does NOT vet it
 *
 * A live row here is "there is a session", not "this reader may do anything". The CHECK constraint makes
 * an unknown role unreachable through this repository, but a column is a column — a hand-edited database
 * or a future migration can hold anything — and `can(role, …)` deciding on a string the matrix has never
 * heard of is worse than a refusal. That refusal is `apps/web/src/session.ts`'s, because `Role` and the
 * matrix live in `packages/core` and `packages/db` may not import it (brief rule 4). One narrowing, at the
 * boundary where the matrix is in scope, exactly as `principalFrom` does for Payload's users.
 */
export async function readStaffSession(
  sql: Sql,
  token: string,
  nowIso: string,
): Promise<StaffSessionResolution> {
  const nowMs = instantOf(nowIso, 'nowIso')
  // Typed rows, per brief rule 28: `noPropertyAccessFromIndexSignature` makes an untyped postgres.js row
  // an error rather than a style question, and the annotation turns a renamed column into a type error
  // instead of an `undefined` at runtime.
  const [row] = await sql<
    {
      session_id: string
      credential_id: string
      employee_id: string
      staff_reference: string
      role: string
      expires_at: Date
      revoked_at: Date | null
    }[]
  >`
    select s.id            as session_id,
           s.credential_id as credential_id,
           c.employee_id   as employee_id,
           e.staff_reference as staff_reference,
           c.role          as role,
           s.expires_at    as expires_at,
           s.revoked_at    as revoked_at
      from staff_session s
      join staff_credential c on c.id = s.credential_id
      join employee e on e.id = c.employee_id
     where s.token_hash = ${hashStaffSessionToken(token)}
  `
  // No row: the token names nothing. This is what a tampered cookie produces, and it is the same answer
  // for a token that never existed and one whose credential has been revoked (the CASCADE removed the
  // session with it) — both of which are "you are not signed in".
  if (row === undefined) return { kind: 'unknown' }
  if (row.revoked_at !== null) return { kind: 'revoked', sessionId: row.session_id }
  if (row.expires_at.getTime() <= nowMs) return { kind: 'expired', sessionId: row.session_id }
  return {
    kind: 'live',
    expiresAtIso: row.expires_at.toISOString(),
    principal: {
      sessionId: row.session_id,
      credentialId: row.credential_id,
      employeeId: row.employee_id,
      staffReference: row.staff_reference,
      role: row.role,
    },
  }
}

/** What a login needs to know about a credential, found by the handle somebody types. */
export interface StaffCredentialRecord {
  readonly credentialId: string
  readonly employeeId: string
  readonly staffReference: string
  /** Constrained by a CHECK to the eight `ROLES` declares; narrowed to `Role` by the web layer. */
  readonly role: string
  readonly passwordHash: string
  /** Null means not enrolled, which `resolveLoginStage` treats as a distinct stage. */
  readonly totpSecret: string | null
  readonly totpLastCounter: number | null
}

/**
 * The credential for a staff reference, or null.
 *
 * `staff_reference` is the identifier somebody signs in with, and it is that rather than an email address
 * for a reason brief rule 15 makes for us: `employee` has no email column, the handover has supplied no
 * staff contact details (`Y8-staff`), and inventing an address to log in with would be inventing exactly
 * the kind of value that is indistinguishable from a configured one. The handle already exists, is UNIQUE,
 * is not a person's name (0030 refuses a display name on this column and ADR 0020 explains why), and is
 * what the rota and the scheduler already call somebody.
 *
 * Returns null for an unknown handle **and does no less work for one**: the caller must still verify a
 * password against something, or the response time tells an attacker which handles exist. `verifyPassword`
 * against a fixed dummy hash is how {@link apps/web/src/session.ts} does that; this function's job is only
 * to say whether there is a row.
 */
export async function readStaffCredentialByReference(
  sql: Sql,
  staffReference: string,
): Promise<StaffCredentialRecord | null> {
  const [row] = await sql<
    {
      credential_id: string
      employee_id: string
      staff_reference: string
      role: string
      password_hash: string
      totp_secret: string | null
      totp_last_counter: string | null
    }[]
  >`
    select c.id              as credential_id,
           c.employee_id     as employee_id,
           e.staff_reference as staff_reference,
           c.role            as role,
           c.password_hash   as password_hash,
           c.totp_secret     as totp_secret,
           c.totp_last_counter::text as totp_last_counter
      from staff_credential c
      join employee e on e.id = c.employee_id
     where e.staff_reference = ${staffReference}
  `
  if (row === undefined) return null
  return {
    credentialId: row.credential_id,
    employeeId: row.employee_id,
    staffReference: row.staff_reference,
    role: row.role,
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret,
    // `::text` then Number, rather than reading the bigint directly: postgres.js returns a bigint column
    // as a string, and `'60000000' <= '9'` is true — a string comparison would accept a replayed code.
    totpLastCounter: row.totp_last_counter === null ? null : Number(row.totp_last_counter),
  }
}

export interface StartedStaffSession {
  readonly sessionId: string
  /** Returned once, for the `Set-Cookie`. Never stored, never logged, never audited. */
  readonly token: string
  readonly expiresAtIso: string
}

/**
 * Mints a session for a credential whose password AND second factor have already been verified.
 *
 * This function does not check either, and that is deliberate rather than an omission: the login state
 * machine is `resolveLoginStage` in `@berelax/auth`, which is pure and exhaustively tested, and a second
 * copy of "may this become a session" here is a second policy to disagree with the first. What keeps the
 * two honest is that `apps/web/src/session.ts` is the only caller and calls `assertAuthenticated` — F07's
 * own throw-rather-than-return guard — immediately before this.
 *
 * Takes a {@link UnitOfWork} because the audit row must commit with the session. A session with no audit
 * row is a sign-in nobody can account for, and this is the table where that matters most.
 */
export async function startStaffSession(
  uow: UnitOfWork,
  input: {
    readonly credentialId: string
    readonly nowIso: string
    readonly ttlMs?: number
  },
): Promise<StartedStaffSession> {
  const nowMs = instantOf(input.nowIso, 'nowIso')
  const ttl = input.ttlMs ?? STAFF_SESSION_TTL_MS
  if (!Number.isInteger(ttl) || ttl < 60_000 || ttl > 12 * 60 * 60 * 1000) {
    throw new AppError(
      'validation',
      `An admin session lives between a minute and twelve hours, got ${ttl}ms. A longer one makes ` +
        'expiry a state nobody meets, which is the same as not having it.',
    )
  }
  const token = generateStaffSessionToken()
  const expiresAtIso = new Date(nowMs + ttl).toISOString()
  const [inserted] = await uow.sql<{ id: string }[]>`
    insert into staff_session (credential_id, token_hash, expires_at, created_at)
    values (${input.credentialId}::uuid, ${hashStaffSessionToken(token)},
            ${expiresAtIso}, ${input.nowIso})
    returning id
  `
  if (inserted === undefined) {
    throw new AppError('invariant_violated', 'Inserting a staff session returned no row.')
  }
  // The audit row names the session and the credential. It must NEVER carry the token: `audit_event` is
  // append-only (ADR 0008) and read by staff, so a token in it is a live credential that cannot be
  // redacted afterwards.
  await uow.audit.record({
    action: 'staff_session.started',
    entityType: 'staff_session',
    entityId: inserted.id,
    operation: 'login',
    after: { credential_id: input.credentialId, expires_at: expiresAtIso },
  })
  return { sessionId: inserted.id, token, expiresAtIso }
}

/**
 * Ends a session.
 *
 * An UPDATE rather than a DELETE, so that "you signed out" stays distinguishable from "that token never
 * existed" — see {@link StaffSessionResolution}. Idempotent: signing out twice is not an error, and
 * raising on the second would turn a double-submitted form into a 500.
 */
export async function revokeStaffSession(
  uow: UnitOfWork,
  token: string,
  nowIso: string,
): Promise<{ readonly revoked: boolean }> {
  instantOf(nowIso, 'nowIso')
  const rows = await uow.sql<{ id: string }[]>`
    update staff_session
       set revoked_at = ${nowIso}
     where token_hash = ${hashStaffSessionToken(token)}
       and revoked_at is null
    returning id
  `
  const row = rows[0]
  if (row === undefined) return { revoked: false }
  await uow.audit.record({
    action: 'staff_session.revoked',
    entityType: 'staff_session',
    entityId: row.id,
    operation: 'logout',
    after: { revoked_at: nowIso },
  })
  return { revoked: true }
}

/**
 * Records the TOTP counter a successful verification consumed, so the same code cannot be used twice.
 *
 * Separate from {@link startStaffSession} rather than folded into it, because it is a write against the
 * CREDENTIAL and that is a different row with a different lifetime — and because the counter must be
 * recorded even on a verification that does not go on to mint a session. Both happen in one transaction at
 * the call site, so a session cannot exist whose code was never burned.
 */
export async function recordTotpCounter(
  uow: UnitOfWork,
  credentialId: string,
  counter: number,
): Promise<void> {
  if (!Number.isInteger(counter) || counter < 0) {
    throw new AppError('validation', `A TOTP counter is a non-negative integer, got ${counter}.`)
  }
  // `greatest` rather than a bare assignment: `verifyTotp` accepts one step either side of the current
  // window, so a code from the previous window legitimately verifies with a counter BELOW one already
  // recorded. Assigning it would move the high-water mark backwards and re-open the code that was just
  // burned, which is the replay this column exists to refuse.
  await uow.sql`
    update staff_credential
       set totp_last_counter = greatest(coalesce(totp_last_counter, -1), ${counter}::bigint)
     where id = ${credentialId}::uuid
  `
}
