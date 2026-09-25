import { createHash, randomBytes } from 'node:crypto'
import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The manage-booking token's impure half (B-UI-05): the CSPRNG, the digest, the row.
 *
 * The pure half — the shape, the expiry rule, what a presented token grants, and the one frozen 404 every
 * refusal answers — is `packages/core/src/identity/booking-token.ts`. The split is the boundary rule:
 * `packages/db` may never import `packages/core`, so the decision arrives as an injected PORT and the
 * composition happens at the route, which may import both. It is the same seam
 * `packages/db/src/repositories/suppression.ts` takes for `decideOptOutAccess`.
 *
 * ## The audit actions, and why the MINT is audited
 *
 * A link nobody ever follows still leaves a trace, for `issueOptOutGrant`'s reason: *"was this customer
 * ever sent a way to manage their booking"* is a different question from *"did they use it"*, and the
 * first is the one asked when a customer says the reminder was useless. The redemption is audited too,
 * and so is a REFUSED redemption — which is the acceptance criterion's *"altering one character … writes
 * an audit_event"*. That row is the only place the reason for the refusal is ever written down, because
 * the response cannot carry one.
 *
 * ## The token is never in an audit row, a log line or an error message
 *
 * Every function here handles either the token or the digest, never both in something it writes. An audit
 * trail carrying the credential would be a second copy of it in a partitioned table several roles may
 * read, and a `console.error` carrying it would put it in a log aggregator for ever. The digest is in the
 * row; the token is returned once, to the caller that is about to put it in a URL.
 */

/** Every reason a booking-token write is refused. Callers branch on these, never on prose. */
export const BOOKING_TOKEN_WRITE_REFUSALS = [
  /** The grant would be born already dead: the expiry is at or before the issue. */
  'grant_expires_before_it_starts',
  /** No booking with that id, so there is nothing for the link to manage. */
  'booking_not_found',
  /** The access decision was not injected, so nothing judged the token. Fail closed. */
  'token_not_decided',
] as const
export type BookingTokenWriteRefusal = (typeof BOOKING_TOKEN_WRITE_REFUSALS)[number]

const refuse = (
  kind: 'conflict' | 'validation' | 'invariant_violated' | 'not_found',
  name: BookingTokenWriteRefusal,
  message: string,
  extra: Record<string, unknown> = {},
): AppError =>
  new AppError(kind, `${name}: ${message}`, {
    userFacing: true,
    details: { refusal: name, ...extra },
  })

/** The refusal an error carries, or `null`. Lets a caller branch without matching on the message. */
export function bookingTokenWriteRefusalOf(err: unknown): BookingTokenWriteRefusal | null {
  const name = err instanceof AppError ? err.details['refusal'] : undefined
  return BOOKING_TOKEN_WRITE_REFUSALS.includes(name as BookingTokenWriteRefusal)
    ? (name as BookingTokenWriteRefusal)
    : null
}

/** The audit actions this repository writes. Namespaced, and named once. */
export const BOOKING_TOKEN_AUDIT_ACTIONS = {
  minted: 'booking_manage_grant.minted',
  redeemed: 'booking_manage_grant.redeemed',
  /** A presented token that granted nothing. The only record of WHY, because the response cannot say. */
  refused: 'booking_manage_grant.refused',
  revoked: 'booking_manage_grant.revoked',
} as const

/**
 * The sha256 of a token, lower-case hex. The only representation of one that is ever stored.
 *
 * `'utf8'` is stated rather than left to the default, because the same call without it hashes the
 * platform's default encoding — and a digest that depended on that would be a lookup that failed on one
 * deployment and worked on another.
 */
export const bookingTokenDigest = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex')

export interface MintedBookingGrant {
  readonly grantId: string
  /** The token. Returned once, never stored, and never written to an audit row or a log. */
  readonly token: string
  readonly expiresAtIso: string
}

/**
 * Mints a manage-booking link for one booking.
 *
 * `randomBytes(32).toString('hex')` — 256 bits, in the only alphabet a PATH segment can carry through
 * this site's canonicalisation (see the core module's header on why base64url is wrong here).
 * `randomBytes` rather than `Math.random` for `generateOtpCode`'s reason: the second is seeded from
 * something an attacker can often predict, and a predictable capability is not a capability.
 *
 * `expiresAtIso` is an ARGUMENT and is not computed here. It is `bookingTokenExpiry(endsAtMs)` from
 * `@berelax/core` — the appointment's end plus 24 hours — and this package may not import that function,
 * so the alternative would be re-deriving the rule in SQL. A second copy of a TTL rule is a second answer
 * to "when does the link die", and the one in the database would be the one nobody tested under a frozen
 * clock.
 *
 * The booking is checked to exist before the insert, although the foreign key would refuse it anyway. The
 * difference is the message: a `23503` from the driver names a constraint, and a route that mints a link
 * for a booking that has been erased needs to know that rather than to report a database error.
 */
export async function mintBookingManageGrant(
  uow: UnitOfWork,
  args: {
    readonly bookingId: string
    readonly purpose: string
    readonly issuedAtIso: string
    readonly expiresAtIso: string
  },
): Promise<MintedBookingGrant> {
  if (Date.parse(args.expiresAtIso) <= Date.parse(args.issuedAtIso)) {
    throw refuse(
      'validation',
      'grant_expires_before_it_starts',
      `a grant issued at ${args.issuedAtIso} and expiring at ${args.expiresAtIso} is born dead, which ` +
        'reads to a customer as a broken link. The expiry is the appointment end plus 24 hours, so this ' +
        'is what an appointment that has already finished produces — mint nothing for it instead.',
      { issuedAtIso: args.issuedAtIso, expiresAtIso: args.expiresAtIso },
    )
  }
  const [booking] = await uow.sql<{ id: string }[]>`
    select id::text as id from booking where id = ${args.bookingId}::uuid
  `
  if (booking === undefined) {
    throw refuse('not_found', 'booking_not_found', `no booking with id ${args.bookingId}`, {
      bookingId: args.bookingId,
    })
  }

  const token = randomBytes(32).toString('hex')
  const [row] = await uow.sql<{ id: string; expires_at: Date }[]>`
    insert into booking_manage_grant (token_sha256, booking_id, purpose, issued_at, expires_at)
    values (
      ${bookingTokenDigest(token)}, ${args.bookingId}::uuid, ${args.purpose},
      ${args.issuedAtIso}::timestamptz, ${args.expiresAtIso}::timestamptz
    )
    returning id::text as id, expires_at
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'The manage-booking grant was not written and did not raise.',
    )
  }
  await uow.audit.record({
    action: BOOKING_TOKEN_AUDIT_ACTIONS.minted,
    entityType: 'booking_manage_grant',
    entityId: row.id,
    operation: 'create',
    // The token is deliberately absent; see the header.
    after: {
      booking_id: args.bookingId,
      purpose: args.purpose,
      expires_at: row.expires_at,
    },
  })
  return { grantId: row.id, token, expiresAtIso: row.expires_at.toISOString() }
}

/**
 * The grant a digest resolves to, as the pure decision needs it, or `null`.
 *
 * Epoch milliseconds rather than a `Date`, because the port the decision is declared as is spelled in
 * primitives — `StoredBookingGrant` in `@berelax/core` says why. Selected by digest and never by token:
 * there is no column holding one.
 */
export interface StoredBookingGrantRow {
  readonly grantId: string
  readonly tokenSha256Hex: string
  readonly bookingId: string
  readonly purpose: string
  readonly expiresAt: number
}

export async function readBookingManageGrant(
  sql: Sql,
  digestHex: string,
): Promise<StoredBookingGrantRow | null> {
  const [row] = await sql<
    {
      id: string
      token_sha256: string
      booking_id: string
      purpose: string
      expires_at: Date
    }[]
  >`
    select id::text as id, token_sha256, booking_id::text as booking_id, purpose, expires_at
      from booking_manage_grant
     where token_sha256 = ${digestHex}
  `
  if (row === undefined) return null
  return {
    grantId: row.id,
    tokenSha256Hex: row.token_sha256,
    bookingId: row.booking_id,
    purpose: row.purpose,
    expiresAt: row.expires_at.getTime(),
  }
}

/**
 * Revokes every live grant on a booking, and answers how many went.
 *
 * This is the acceptance criterion's *"revoked on cancellation"*, and it is a DELETE rather than a
 * `revoked_at` column for the reason 0064 gives: the row goes and the `audit_event` for the minting stays,
 * because that table is append-only. A `revoked_at` would be a second thing every reader has to remember
 * to filter on, and the reader that forgets serves the page.
 *
 * EVERY grant on the booking, not the one that was presented. A reminder mints a link per send, so a
 * booking with a 24-hour and a 2-hour reminder has two live links and revoking one would leave the other
 * working — which is the whole failure, because the customer who cancelled by telephone would still be
 * able to reschedule from the older SMS.
 *
 * Called from inside the cancellation's transaction rather than injected, and that is deliberate: it is a
 * write in the same package as the cancellation, and a dependency a caller may omit is a link that stays
 * live whenever somebody forgets. `cancelAppointment` calls it directly, so the revocation commits with
 * the status change or not at all.
 */
export async function revokeBookingManageGrants(
  uow: UnitOfWork,
  args: { readonly bookingId: string; readonly reason: string },
): Promise<number> {
  const rows = await uow.sql<{ id: string }[]>`
    delete from booking_manage_grant
     where booking_id = ${args.bookingId}::uuid
    returning id::text as id
  `
  const first = rows[0]
  if (first === undefined) return 0
  await uow.audit.record({
    action: BOOKING_TOKEN_AUDIT_ACTIONS.revoked,
    entityType: 'booking_manage_grant',
    // The first of the set, because `audit_event.entity_id` is one column and a revocation may remove
    // several rows at once. Every id is in `before.grant_ids`, so nothing is lost by the choice.
    entityId: first.id,
    operation: 'delete',
    before: { booking_id: args.bookingId, grant_ids: rows.map((row) => row.id) },
    after: { revoked: rows.length, reason: args.reason },
  })
  return rows.length
}

/**
 * `decideBookingTokenAccess` from `@berelax/core`, injected.
 *
 * A function rather than an import because `packages/db` must never import `packages/core`. Required and
 * not optional: a token resolved without the decision is a page served to whoever asked, and the
 * permissive default is silent.
 */
export type BookingTokenDecider = (input: {
  readonly grant: StoredBookingGrantRow | null
  readonly presentedDigestHex: string
  readonly expectedPurpose: 'manage_booking'
  readonly at: number
}) =>
  | { readonly kind: 'granted'; readonly grantId: string; readonly bookingId: string }
  | { readonly kind: 'refused'; readonly reason: string; readonly detail: string }

/** What a redemption resolved to. `refused` carries no booking, by construction rather than by care. */
export type RedeemedBookingToken =
  | { readonly kind: 'granted'; readonly grantId: string; readonly bookingId: string }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Resolves a presented token and records the attempt, whichever way it went.
 *
 * One function for both outcomes, because the audit row is the thing that must not be forgettable: the
 * acceptance criterion requires a refused redemption to write an `audit_event`, and a route that resolved
 * the token itself and audited afterwards would have two paths and one of them would be the early return.
 *
 * `entityId` is the grant on a grant that exists and is ABSENT on one that does not — never the digest.
 * An `audit_event` keyed on the digest of an unknown token would be a table of lookup keys for links that
 * do not exist, which is the second copy of a credential this file otherwise refuses to make.
 */
export async function redeemBookingManageToken(
  uow: UnitOfWork,
  args: {
    readonly digestHex: string
    readonly atIso: string
    readonly purpose: 'manage_booking'
  },
  deps: { readonly decide: BookingTokenDecider },
): Promise<RedeemedBookingToken> {
  if (typeof deps?.decide !== 'function') {
    throw refuse(
      'invariant_violated',
      'token_not_decided',
      'no access decision was injected, so nothing judged the token. `packages/db` may not import ' +
        '`packages/core`, so the decision is a port and the route composes it — an absent one would ' +
        'mean a page served to whoever asked.',
    )
  }
  const grant = await readBookingManageGrant(uow.sql, args.digestHex)
  const verdict = deps.decide({
    grant,
    presentedDigestHex: args.digestHex,
    expectedPurpose: args.purpose,
    at: Date.parse(args.atIso),
  })
  if (verdict.kind === 'refused') {
    await uow.audit.record({
      action: BOOKING_TOKEN_AUDIT_ACTIONS.refused,
      entityType: 'booking_manage_grant',
      ...(grant === null ? {} : { entityId: grant.grantId }),
      operation: 'denied',
      after: {
        reason: verdict.reason,
        detail: verdict.detail,
        // Whether a row was found at all, which is the one fact about the token worth recording and is
        // not the token. `grant_present: false` is every mistyped, forged and swept link at once.
        grant_present: grant !== null,
        at: args.atIso,
      },
    })
    return { kind: 'refused', reason: verdict.reason }
  }
  await uow.audit.record({
    action: BOOKING_TOKEN_AUDIT_ACTIONS.redeemed,
    entityType: 'booking_manage_grant',
    entityId: verdict.grantId,
    operation: 'read',
    after: { booking_id: verdict.bookingId, at: args.atIso },
  })
  return { kind: 'granted', grantId: verdict.grantId, bookingId: verdict.bookingId }
}
