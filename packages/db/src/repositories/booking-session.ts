import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The public booking flow's session: mint, resolve, verify, attach.
 *
 * ## The token is returned once and stored nowhere
 *
 * {@link startBookingSession} returns the plaintext token exactly once, to the caller that is about to
 * put it in a `Set-Cookie`. The row holds its SHA-256. The reasoning is `otp_challenge`'s (0019) with one
 * number changed: a session token is a bearer credential for somebody's booking for as long as the row
 * lives, so anything holding it — a table, a log, a Sentry breadcrumb — is a credential store.
 *
 * SHA-256 rather than an HMAC under a per-row salt, and that is the one deliberate difference from
 * `hashOtpCode`. A six-digit code has a million values, so a salt is what stops two challenges sharing a
 * code from looking identical; a 256-bit random token has nothing to guess, and the lookup **has** to be
 * by hash — a per-row salt would make resolving a cookie a full-table scan. Fast on purpose for the reason
 * 0019 gives about the code hash: no work factor helps a value nobody can guess, and 100ms per request
 * would be 100ms on every page of the booking flow.
 *
 * ## Why every instant is an argument
 *
 * Nothing here calls `now()` in SQL or reads the clock in JavaScript. *Session expiry mid-flow* is one of
 * the nine edge states docs/09 §3 enumerates, and under a real clock it is provable only by waiting — which
 * means in practice it is never proved. The caller passes the instant; the tests pass a frozen one.
 *
 * ## Why expiry is decided here and not by the cookie
 *
 * A cookie's `Max-Age` is a request to the browser. A `exp` claim inside a signed value is checked by
 * whatever remembers to check it. {@link readBookingSession} compares `expires_at` on every resolution and
 * reports `expired` as a distinct answer from `unknown`, so the flow can tell *"your verification lapsed"*
 * from *"you have not started"* — two different panels with two different remedies, and collapsing them
 * would send a first-time reader to a message about something they never did.
 */

/** 32 bytes of CSPRNG, hex-encoded: 64 characters, which fits a cookie comfortably. */
export const BOOKING_SESSION_TOKEN_BYTES = 32

/**
 * How long a booking attempt lives.
 *
 * Twenty minutes, and the shape of the number is the argument rather than the number itself: it has to be
 * comfortably longer than the OTP's five-minute window plus a slow SMS plus somebody reading a consent
 * paragraph, and short enough that a phone left on a café table is not a booking anybody can make. Two
 * hours would make *session expiry mid-flow* a state nobody ever meets, which is the same as not having it.
 */
export const BOOKING_SESSION_TTL_MINUTES = 20

const MINUTE_MS = 60_000

/** The digest stored for a token. Exported so a test can assert the column holds this and not the token. */
export function hashBookingSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/** A fresh token. Hex rather than base64url so nothing has to be escaped in a cookie or a log. */
export function generateBookingSessionToken(): string {
  return randomBytes(BOOKING_SESSION_TOKEN_BYTES).toString('hex')
}

/**
 * Constant-time comparison of two digests.
 *
 * Used by {@link bookingSessionTokenMatches}, which nothing on the request path calls — the lookup is by
 * digest, so the database does the comparison. It is here because a caller holding a row and a token (a
 * test, a future admin tool) will otherwise write `===`, and the version of that function somebody writes
 * at 2am leaks how much of a guess was right. Same argument `hashesMatch` in `otp.ts` makes.
 */
export function bookingSessionTokenMatches(token: string, storedHash: Buffer): boolean {
  const candidate = hashBookingSessionToken(token)
  return candidate.length === storedHash.length && timingSafeEqual(candidate, storedHash)
}

export interface BookingSessionRow {
  readonly id: string
  readonly phoneE164: string
  readonly customerId: string | null
  readonly verifiedAtIso: string | null
  readonly expiresAtIso: string
  readonly bookingId: string | null
  readonly createdAtIso: string
}

/**
 * What resolving a cookie answers.
 *
 * Three outcomes and not two. `unknown` is a first arrival or a cookie from another deployment; `expired`
 * is the enumerated edge state. A function that returned `null` for both would make the page unable to say
 * which, and *"your session has expired"* shown to somebody who has not started one is worse than nothing.
 */
export type BookingSessionLookup =
  | { readonly kind: 'live'; readonly session: BookingSessionRow }
  | { readonly kind: 'expired'; readonly session: BookingSessionRow }
  | { readonly kind: 'unknown' }

interface RawRow {
  readonly id: string
  readonly phone_e164: string
  readonly customer_id: string | null
  readonly verified_at: Date | null
  readonly expires_at: Date
  readonly booking_id: string | null
  readonly created_at: Date
}

const COLUMNS = `
  id::text as id, phone_e164, customer_id::text as customer_id, verified_at, expires_at,
  booking_id::text as booking_id, created_at
`

const toRow = (row: RawRow): BookingSessionRow => ({
  id: row.id,
  phoneE164: row.phone_e164,
  customerId: row.customer_id,
  verifiedAtIso: row.verified_at === null ? null : row.verified_at.toISOString(),
  expiresAtIso: row.expires_at.toISOString(),
  bookingId: row.booking_id,
  createdAtIso: row.created_at.toISOString(),
})

function instantOf(iso: string, field: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new AppError('validation', `${field} must be a parseable instant, received "${iso}"`)
  }
  return ms
}

export interface StartBookingSessionInput {
  /** Canonical E.164, from `normalisePhone` in `@berelax/core`. Never a raw form value. */
  readonly phoneE164: string
  /** The instant of the request, from an injected clock. */
  readonly nowIso: string
  readonly ttlMinutes?: number
}

export interface StartedBookingSession {
  readonly session: BookingSessionRow
  /** Returned once, for the `Set-Cookie`. Never stored, never logged. */
  readonly token: string
}

/**
 * Starts an attempt, unverified.
 *
 * A row from the moment a code is requested rather than from the moment one is verified, and that is the
 * enumeration argument `otp_challenge` makes (0019): the row exists for any well-formed mobile number,
 * whether or not the business has ever seen it, so a known and an unknown number produce the same work,
 * the same response and the same cookie.
 *
 * Takes a {@link UnitOfWork} rather than a connection because the audit row must commit with it. A session
 * with no audit row is a verification nobody can account for.
 */
export async function startBookingSession(
  uow: UnitOfWork,
  input: StartBookingSessionInput,
): Promise<StartedBookingSession> {
  const nowMs = instantOf(input.nowIso, 'nowIso')
  const ttl = input.ttlMinutes ?? BOOKING_SESSION_TTL_MINUTES
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 120) {
    throw new AppError(
      'validation',
      `A booking session lives between 1 and 120 minutes, got ${ttl}. A longer one makes "session ` +
        'expiry mid-flow" a state nobody meets, which is the same as not having it.',
    )
  }
  const token = generateBookingSessionToken()
  const rows = await uow.sql<RawRow[]>`
    insert into booking_session (token_hash, phone_e164, expires_at, created_at)
    values (${hashBookingSessionToken(token)}, ${input.phoneE164},
            ${new Date(nowMs + ttl * MINUTE_MS).toISOString()}, ${input.nowIso})
    returning ${uow.sql.unsafe(COLUMNS)}
  `
  const inserted = rows[0]
  if (inserted === undefined) {
    throw new AppError('invariant_violated', 'Inserting a booking session returned no row.')
  }
  // The audit row carries the session and the number. It must never carry the token — `audit_event` is
  // append-only and read by staff, so a token in it is a credential that cannot be redacted.
  await uow.audit.record({
    action: 'booking_session.started',
    entityType: 'booking_session',
    entityId: inserted.id,
    operation: 'create',
    after: { phone_e164: inserted.phone_e164, expires_at: inserted.expires_at },
  })
  return { session: toRow(inserted), token }
}

/**
 * The session a cookie names, live, expired or unknown.
 *
 * Takes an `Sql` rather than a `UnitOfWork`: it is a read on every request of the flow and writes nothing,
 * including no `last_seen_at` — a touch column would make every page view a write on the hot path, and the
 * question this table answers is *has it expired*, which no touch changes.
 */
export async function readBookingSession(
  sql: Sql,
  args: { readonly token: string; readonly nowIso: string },
): Promise<BookingSessionLookup> {
  // A malformed cookie is `unknown` before a statement is issued: a token of the wrong shape cannot match
  // any digest, and hashing it to find that out is a query that answers nothing.
  if (!/^[0-9a-f]{64}$/.test(args.token)) return { kind: 'unknown' }
  const rows = await sql<RawRow[]>`
    select ${sql.unsafe(COLUMNS)} from booking_session
     where token_hash = ${hashBookingSessionToken(args.token)}
  `
  const row = rows[0]
  if (row === undefined) return { kind: 'unknown' }
  const session = toRow(row)
  const nowMs = instantOf(args.nowIso, 'nowIso')
  // `<=` and not `<`: `expires_at` is the instant it stops being valid, which is the same boundary
  // `decideBookingEdgeState` applies in `@berelax/core`. Two functions disagreeing by a millisecond about
  // whether a session is live is a flow that verifies and then refuses.
  return instantOf(session.expiresAtIso, 'expires_at') <= nowMs
    ? { kind: 'expired', session }
    : { kind: 'live', session }
}

/**
 * Marks the attempt verified as one customer, extending it to a fresh window.
 *
 * Extended rather than left alone, because the clock that matters from here is the one the reader is
 * actually working against: the code took some of the original window to arrive and be typed, and a
 * customer who then has four minutes to read a consent paragraph and confirm is a customer who meets
 * `session_expired` for no reason anybody could explain.
 *
 * Idempotent on a second call with the same customer: the flow's verify step can be submitted twice.
 * Refused for a DIFFERENT customer, which cannot happen through the flow and would mean one attempt had
 * proved two numbers — a state worth stopping rather than papering over.
 */
export async function verifyBookingSession(
  uow: UnitOfWork,
  args: {
    readonly sessionId: string
    readonly customerId: string
    readonly nowIso: string
    readonly ttlMinutes?: number
  },
): Promise<BookingSessionRow> {
  const nowMs = instantOf(args.nowIso, 'nowIso')
  const ttl = args.ttlMinutes ?? BOOKING_SESSION_TTL_MINUTES
  const rows = await uow.sql<RawRow[]>`
    update booking_session
       set customer_id = ${args.customerId},
           verified_at = coalesce(verified_at, ${args.nowIso}),
           expires_at = ${new Date(nowMs + ttl * MINUTE_MS).toISOString()}
     where id = ${args.sessionId}
       and (customer_id is null or customer_id = ${args.customerId})
    returning ${uow.sql.unsafe(COLUMNS)}
  `
  const updated = rows[0]
  if (updated === undefined) {
    throw new AppError(
      'conflict',
      `booking_session ${args.sessionId} is already verified as a different customer, or does not ` +
        'exist. One attempt proving two numbers would let a booking be taken for whichever of them the ' +
        'next statement happened to read.',
      { userFacing: false, details: { sessionId: args.sessionId } },
    )
  }
  await uow.audit.record({
    action: 'booking_session.verified',
    entityType: 'booking_session',
    entityId: updated.id,
    operation: 'update',
    before: { verified: false },
    after: { customer_id: updated.customer_id, phone_e164: updated.phone_e164 },
  })
  return toRow(updated)
}

/**
 * Records the booking this attempt produced.
 *
 * `coalesce` rather than an overwrite, so the FIRST booking wins: a double submission that raced to here
 * must not leave the second id on a row the confirmation is then read from, or a reader would be shown a
 * booking id that the idempotency claim does not agree with. The booking transaction already guarantees
 * one booking per key; this guarantees one id per attempt, which is the half this table owns.
 */
export async function attachBookingToSession(
  uow: UnitOfWork,
  args: { readonly sessionId: string; readonly bookingId: string },
): Promise<BookingSessionRow> {
  const rows = await uow.sql<RawRow[]>`
    update booking_session
       set booking_id = coalesce(booking_id, ${args.bookingId})
     where id = ${args.sessionId}
    returning ${uow.sql.unsafe(COLUMNS)}
  `
  const updated = rows[0]
  if (updated === undefined) {
    throw new AppError(
      'invariant_violated',
      `booking_session ${args.sessionId} vanished between the booking and the attachment.`,
    )
  }
  await uow.audit.record({
    action: 'booking_session.booking_attached',
    entityType: 'booking_session',
    entityId: updated.id,
    operation: 'update',
    after: { booking_id: updated.booking_id },
  })
  return toRow(updated)
}

/**
 * Ends the attempt now, whatever its expiry said.
 *
 * `expires_at = created_at + 1ms` rather than a delete, because the row is what the audit trail refers to
 * and because `booking_session_expires_after_it_starts` refuses an expiry at or before the start. A delete
 * would also make *session expiry mid-flow* indistinguishable from *unknown session*, which is the
 * distinction {@link readBookingSession} exists to keep.
 */
export async function endBookingSession(
  uow: UnitOfWork,
  args: { readonly sessionId: string },
): Promise<void> {
  await uow.sql`
    update booking_session set expires_at = created_at + interval '1 millisecond'
     where id = ${args.sessionId}
  `
  await uow.audit.record({
    action: 'booking_session.ended',
    entityType: 'booking_session',
    entityId: args.sessionId,
    operation: 'update',
    after: { ended: true },
  })
}
