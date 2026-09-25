import { describe, expect, it } from 'vitest'
import type { UnitOfWork } from '../tx.ts'
import {
  BOOKING_TOKEN_AUDIT_ACTIONS,
  BOOKING_TOKEN_WRITE_REFUSALS,
  bookingTokenDigest,
  bookingTokenWriteRefusalOf,
  mintBookingManageGrant,
  redeemBookingManageToken,
} from './booking-token.ts'

/**
 * The manage-booking grant's fail-closed half, which needs no database.
 *
 * `cancel.test.ts` next door is the same shape and states the reason: a guard that refuses a MISSING
 * dependency can be proved without a row, and proving it here means the failure arrives on every commit
 * rather than only when the integration suite runs. Everything that needs a real PostgreSQL — the digest in
 * the column, the CHECK constraints, the revocation, the audit rows — is
 * `apps/web/src/manage-booking.itest.ts`'s.
 *
 * The unit of work is a stand-in that RAISES if anything reaches the database, which is the assertion: a
 * guard that let a call through would be caught by the throw rather than by a missing expectation.
 */

/** A unit of work nothing may use. Every member throws, naming what tried. */
const forbidden = (what: string): never => {
  throw new Error(`the guard let the call through: ${what} was reached`)
}

const NO_DATABASE = {
  get sql(): never {
    return forbidden('uow.sql')
  },
  get audit(): never {
    return forbidden('uow.audit')
  },
  publish: () => forbidden('uow.publish'),
} as unknown as UnitOfWork

describe('the digest', () => {
  it('is the sha256 of the token, as lower-case hex', () => {
    // A known vector, so the function is pinned to SHA-256 rather than to whatever it currently computes.
    // The empty string's sha256 is the most widely published one there is.
    expect(bookingTokenDigest('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    const token = '0123456789abcdef'.repeat(4)
    expect(bookingTokenDigest(token)).toMatch(/^[0-9a-f]{64}$/)
    // The control: a different token is a different digest, and one character is enough.
    expect(bookingTokenDigest(token)).not.toBe(bookingTokenDigest(`${token.slice(0, -1)}0`))
    // And it is not the token, which is the whole reason the column exists.
    expect(bookingTokenDigest(token)).not.toBe(token)
  })

  it('is stable across calls, because a lookup is by it', () => {
    const token = 'f'.repeat(64)
    expect(bookingTokenDigest(token)).toBe(bookingTokenDigest(token))
  })
})

describe('the mint fails closed', () => {
  it('refuses a grant that would be born dead, before touching the database', async () => {
    // The appointment has already finished, so `bookingTokenExpiry` answers an instant in the past. Refused
    // by NAME and before any statement: a grant written this way is a link that reads to a customer as
    // simply broken, and the refusal is what the worker's builder checks for rather than sending a blank.
    await expect(
      mintBookingManageGrant(NO_DATABASE, {
        bookingId: '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f',
        purpose: 'manage_booking',
        issuedAtIso: '2099-03-04T18:00:00.000Z',
        expiresAtIso: '2099-03-04T17:00:00.000Z',
      }),
    ).rejects.toThrow(/grant_expires_before_it_starts/)
  })

  it('refuses an expiry equal to the issue, which is the boundary', async () => {
    await expect(
      mintBookingManageGrant(NO_DATABASE, {
        bookingId: '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f',
        purpose: 'manage_booking',
        issuedAtIso: '2099-03-04T18:00:00.000Z',
        expiresAtIso: '2099-03-04T18:00:00.000Z',
      }),
    ).rejects.toThrow(/grant_expires_before_it_starts/)
  })

  it('reaches the database for an expiry that is legal, which is the control', async () => {
    // Without this the two cases above are satisfied by a function that refuses everything. The stand-in
    // throws on `uow.sql`, so "reached the database" is the assertion and the message is the evidence.
    await expect(
      mintBookingManageGrant(NO_DATABASE, {
        bookingId: '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f',
        purpose: 'manage_booking',
        issuedAtIso: '2099-03-04T18:00:00.000Z',
        expiresAtIso: '2099-03-05T18:00:00.000Z',
      }),
    ).rejects.toThrow(/the guard let the call through: uow.sql was reached/)
  })
})

describe('the redemption fails closed', () => {
  it('refuses to resolve a token with no access decision injected', async () => {
    // `packages/db` may not import `packages/core`, so the decision is a PORT. An absent one must not mean
    // "granted": it would mean a page served to whoever asked, and the permissive default is silent.
    await expect(
      redeemBookingManageToken(
        NO_DATABASE,
        { digestHex: 'a'.repeat(64), atIso: '2099-03-04T18:00:00.000Z', purpose: 'manage_booking' },
        {} as unknown as { decide: never },
      ),
    ).rejects.toThrow(/token_not_decided/)
  })

  it('reaches the database when a decision IS injected, which is the control', async () => {
    await expect(
      redeemBookingManageToken(
        NO_DATABASE,
        { digestHex: 'a'.repeat(64), atIso: '2099-03-04T18:00:00.000Z', purpose: 'manage_booking' },
        { decide: () => ({ kind: 'refused', reason: 'token_unknown', detail: 'never reached' }) },
      ),
    ).rejects.toThrow(/the guard let the call through: uow.sql was reached/)
  })
})

describe('the vocabulary', () => {
  it('translates its own refusals and nothing else', async () => {
    let raised: unknown
    try {
      await mintBookingManageGrant(NO_DATABASE, {
        bookingId: 'x',
        purpose: 'manage_booking',
        issuedAtIso: '2099-03-04T18:00:00.000Z',
        expiresAtIso: '2099-03-04T17:00:00.000Z',
      })
    } catch (error) {
      raised = error
    }
    expect(bookingTokenWriteRefusalOf(raised)).toBe('grant_expires_before_it_starts')
    // The control: an unrelated error carries no refusal, so a caller branching on the name cannot be
    // handed one by accident.
    expect(bookingTokenWriteRefusalOf(new Error('something else'))).toBeNull()
    expect(bookingTokenWriteRefusalOf(undefined)).toBeNull()
    for (const name of BOOKING_TOKEN_WRITE_REFUSALS) expect(name).toMatch(/^[a-z_]+$/)
  })

  it('namespaces every audit action, because AuditWriter refuses one that is not', () => {
    for (const action of Object.values(BOOKING_TOKEN_AUDIT_ACTIONS)) {
      expect(action, action).toContain('.')
      expect(action, action).toContain('booking_manage_grant')
    }
    // Four distinct actions: a mint, a redemption, a refusal and a revocation. Distinct because they answer
    // four different questions and a shared name would make the counts useless.
    expect(new Set(Object.values(BOOKING_TOKEN_AUDIT_ACTIONS)).size).toBe(4)
  })
})
