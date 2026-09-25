import { describe, expect, it } from 'vitest'
import { OPT_OUT_TOKEN_LENGTH } from '../consent/optout-token.ts'
import {
  BOOKING_TOKEN_BYTES,
  BOOKING_TOKEN_GRACE_SECONDS,
  BOOKING_TOKEN_LENGTH,
  BOOKING_TOKEN_NOT_FOUND,
  BOOKING_TOKEN_PURPOSES,
  BOOKING_TOKEN_REFUSALS,
  type BookingTokenRefusal,
  bookingTokenExpiry,
  bookingTokenShape,
  CLINICAL_FIELD_MARKERS,
  decideBookingTokenAccess,
  MANAGE_BOOKING_FIELDS,
  type StoredBookingGrant,
} from './booking-token.ts'

/**
 * B-UI-05 — the manage-booking token's pure half.
 *
 * Every assertion here is paired with a control that must fail, because every one of them is about a
 * refusal and a refusal is the easy thing to get accidentally right: a decision function that answered
 * `refused` for everything would satisfy each expiry, purpose and unknown-token case on its own.
 *
 * What is NOT here: the digest, the random bytes and the row. `packages/core` mints nothing and hashes
 * nothing (`pnpm purity` forbids it reading any ambient source), so the minting, the SHA-256 and the
 * revocation are proved against a real PostgreSQL by `apps/web/src/manage-booking.itest.ts`.
 */

/** 2099 so no seeded or fixture row shares it, and a round instant so the arithmetic is readable. */
const ENDS_AT = Date.parse('2099-03-04T18:00:00.000Z')
const EXPIRES_AT = bookingTokenExpiry(ENDS_AT)

const DIGEST = 'a'.repeat(64)

const grantWith = (overrides: Partial<StoredBookingGrant> = {}): StoredBookingGrant => ({
  grantId: '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f',
  tokenSha256Hex: DIGEST,
  bookingId: '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e20',
  purpose: 'manage_booking',
  expiresAt: EXPIRES_AT,
  ...overrides,
})

const decide = (
  overrides: Partial<Parameters<typeof decideBookingTokenAccess>[0]> = {},
): ReturnType<typeof decideBookingTokenAccess> =>
  decideBookingTokenAccess({
    grant: grantWith(),
    presentedDigestHex: DIGEST,
    expectedPurpose: 'manage_booking',
    at: ENDS_AT,
    ...overrides,
  })

describe('the token shape', () => {
  it('is 32 bytes as 64 lower-case hex characters', () => {
    expect(BOOKING_TOKEN_BYTES).toBe(32)
    expect(BOOKING_TOKEN_LENGTH).toBe(BOOKING_TOKEN_BYTES * 2)
    const token = '0123456789abcdef'.repeat(4)
    expect(token).toHaveLength(BOOKING_TOKEN_LENGTH)
    expect(bookingTokenShape(token)).toEqual({ ok: true, token })
  })

  it('is deliberately NOT the opt-out token shape', () => {
    // The one assertion that says the difference is a decision rather than an oversight. Base64url is 43
    // characters and mixed case; a mixed-case token in a PATH segment is lower-cased by the site's own
    // canonical redirect, so the reader follows an ordinary 301 onto a token that no longer matches.
    expect(BOOKING_TOKEN_LENGTH).not.toBe(OPT_OUT_TOKEN_LENGTH)
    expect(bookingTokenShape('AbCd'.repeat(16)).ok).toBe(false)
    // And the control, so the case above is not satisfied by a shape test that refuses everything: the
    // same 64 characters lower-cased is accepted.
    expect(bookingTokenShape('abcd'.repeat(16)).ok).toBe(true)
  })

  it('names an absent token apart from a malformed one', () => {
    for (const absent of [null, undefined, '', '   ']) {
      expect(bookingTokenShape(absent), String(absent)).toEqual({
        ok: false,
        reason: 'token_absent',
      })
    }
    for (const malformed of [
      '0123456789abcde', // 15 — short
      '0'.repeat(63), // one short of the exact length
      '0'.repeat(65), // one over
      `${'0'.repeat(63)}g`, // not hex
      `${'0'.repeat(63)} `, // a trailing space, never trimmed away
      '0123456789abcdef'.repeat(4).replace('a', 'A'), // one upper-case digit
    ]) {
      expect(bookingTokenShape(malformed), malformed).toEqual({
        ok: false,
        reason: 'token_malformed',
      })
    }
  })

  it('refuses a truncated paste rather than accepting a prefix', () => {
    // The reason the length is exact rather than a minimum: a truncated token that was looked up would
    // miss, and a miss is indistinguishable from a forgery in the log.
    const token = '0123456789abcdef'.repeat(4)
    expect(bookingTokenShape(token.slice(0, 60)).ok).toBe(false)
    expect(bookingTokenShape(`${token}00`).ok).toBe(false)
    expect(bookingTokenShape(token).ok).toBe(true)
  })
})

describe('when the link dies', () => {
  it('is 24 hours after the appointment ENDS', () => {
    expect(BOOKING_TOKEN_GRACE_SECONDS).toBe(86_400)
    expect(bookingTokenExpiry(ENDS_AT)).toBe(ENDS_AT + 86_400_000)
    // The control, and it is the mistake this rule exists to refuse: anchoring to the START would give a
    // token that dies before a 90-minute treatment is over on the day it is used.
    expect(bookingTokenExpiry(ENDS_AT)).not.toBe(ENDS_AT)
    expect(bookingTokenExpiry(ENDS_AT)).toBeGreaterThan(ENDS_AT)
  })

  it('is later for a later appointment, by exactly the same grace', () => {
    const later = ENDS_AT + 7 * 24 * 60 * 60 * 1000
    expect(bookingTokenExpiry(later) - bookingTokenExpiry(ENDS_AT)).toBe(later - ENDS_AT)
  })
})

describe('what a presented token grants', () => {
  it('grants the booking on the grant, and only the booking on the grant', () => {
    const granted = decide()
    expect(granted.kind).toBe('granted')
    if (granted.kind !== 'granted') return
    expect(granted.bookingId).toBe(grantWith().bookingId)
    expect(granted.grantId).toBe(grantWith().grantId)
    expect(granted.expiresAtIso).toBe(new Date(EXPIRES_AT).toISOString())
    // The control: a DIFFERENT grant grants a different booking. Without it, "grants exactly one booking"
    // would be satisfied by a decision that always answered with the same hard-coded id.
    const other = decide({ grant: grantWith({ bookingId: 'other-booking' }) })
    expect(other.kind === 'granted' && other.bookingId).toBe('other-booking')
  })

  it('refuses a digest no grant holds', () => {
    const refused = decide({ grant: null })
    expect(refused).toMatchObject({ kind: 'refused', reason: 'token_unknown' })
  })

  it('refuses a grant whose stored digest is not the one presented', () => {
    // The lookup matched and the comparison did not, which means the query and this decision disagree
    // about equality. Refused as unknown so the requester learns nothing from the disagreement.
    const refused = decide({ presentedDigestHex: 'b'.repeat(64) })
    expect(refused).toMatchObject({ kind: 'refused', reason: 'token_unknown' })
    expect(refused.kind === 'refused' && refused.detail).toContain('different one')
  })

  it('treats expiry as inclusive of the boundary, at the boundary and either side of it', () => {
    expect(decide({ at: EXPIRES_AT - 1 }).kind).toBe('granted')
    expect(decide({ at: EXPIRES_AT })).toMatchObject({ kind: 'refused', reason: 'token_expired' })
    expect(decide({ at: EXPIRES_AT + 1 })).toMatchObject({
      kind: 'refused',
      reason: 'token_expired',
    })
  })

  it('grants right up to the grace and not past it, from the appointment end', () => {
    // The acceptance criterion's "expire at appointment end + 24h", under the frozen clock, from both
    // sides: one millisecond before the grace runs out it is alive, and at it, it is dead.
    expect(decide({ at: ENDS_AT + BOOKING_TOKEN_GRACE_SECONDS * 1000 - 1 }).kind).toBe('granted')
    expect(decide({ at: ENDS_AT + BOOKING_TOKEN_GRACE_SECONDS * 1000 }).kind).toBe('refused')
  })

  it('refuses a grant minted for another purpose', () => {
    const refused = decide({ grant: grantWith({ purpose: 'clinical_intake' }) })
    expect(refused).toMatchObject({ kind: 'refused', reason: 'token_not_for_this_purpose' })
    // The control: the purpose the grant WAS minted for is accepted, so the case above is about the
    // mismatch rather than about a decision that refuses every purpose.
    expect(decide({ grant: grantWith({ purpose: 'manage_booking' }) }).kind).toBe('granted')
  })

  it('declares one purpose, and it is the one the decision expects', () => {
    expect([...BOOKING_TOKEN_PURPOSES]).toEqual(['manage_booking'])
  })
})

describe('every refusal answers the same body', () => {
  it('serves one frozen 404 with no variant', () => {
    expect(BOOKING_TOKEN_NOT_FOUND.status).toBe(404)
    expect(BOOKING_TOKEN_NOT_FOUND.body).toEqual({ error: 'not_found' })
    expect(Object.isFrozen(BOOKING_TOKEN_NOT_FOUND)).toBe(true)
    expect(Object.isFrozen(BOOKING_TOKEN_NOT_FOUND.body)).toBe(true)
  })

  it('names every refusal it can produce, and produces no name it has not declared', () => {
    const produced = new Set<BookingTokenRefusal>()
    for (const result of [
      decide({ grant: null }),
      decide({ presentedDigestHex: 'c'.repeat(64) }),
      decide({ at: EXPIRES_AT }),
      decide({ grant: grantWith({ purpose: 'something_else' }) }),
    ]) {
      if (result.kind === 'refused') produced.add(result.reason)
    }
    for (const reason of produced) {
      expect([...BOOKING_TOKEN_REFUSALS], reason).toContain(reason)
    }
    // Four of the six, and the two that are missing are missing because they are not this function's:
    // the shape refusals are decided before a lookup, and `booking_not_manageable` is decided after one
    // by the repository. Asserted by name so the list cannot drift into a vocabulary nothing raises.
    expect([...produced].sort()).toEqual([
      'token_expired',
      'token_not_for_this_purpose',
      'token_unknown',
    ])
    expect(bookingTokenShape(null).ok).toBe(false)
    expect([...BOOKING_TOKEN_REFUSALS]).toContain('token_absent')
    expect([...BOOKING_TOKEN_REFUSALS]).toContain('token_malformed')
    expect([...BOOKING_TOKEN_REFUSALS]).toContain('booking_not_manageable')
  })

  it('carries the reason in the detail and never in the body', () => {
    // The oracle assertion, and the acceptance criterion's "a response body identical to a genuinely
    // unknown token": the detail differs per reason because the SERVER's log needs it, and the body does
    // not exist per reason at all — there is one.
    const expired = decide({ at: EXPIRES_AT })
    const unknown = decide({ grant: null })
    expect(expired.kind === 'refused' && expired.detail).not.toBe(
      unknown.kind === 'refused' && unknown.detail,
    )
    expect(JSON.stringify(BOOKING_TOKEN_NOT_FOUND.body)).not.toContain('expired')
    expect(JSON.stringify(BOOKING_TOKEN_NOT_FOUND.body)).not.toContain('unknown')
  })
})

describe('the field allowlist', () => {
  it('declares what the page may print, and nothing clinical is on it', () => {
    expect(MANAGE_BOOKING_FIELDS.length).toBeGreaterThan(5)
    for (const field of MANAGE_BOOKING_FIELDS) {
      for (const marker of CLINICAL_FIELD_MARKERS) {
        expect(
          field.toLowerCase(),
          `${field} matches the forbidden marker ${marker}`,
        ).not.toContain(marker)
      }
    }
    // The control on the marker list itself: it has to be able to match something, or the sweep above is
    // a loop over words that never fire and the response-body assertion in the itest is decoration.
    expect(CLINICAL_FIELD_MARKERS.some((marker) => 'contraindication_flag'.includes(marker))).toBe(
      true,
    )
    expect(
      CLINICAL_FIELD_MARKERS.some((marker) => 'intakeAnswers'.toLowerCase().includes(marker)),
    ).toBe(true)
  })

  it('names no person and no price', () => {
    // Three absences, asserted rather than implied. A name would be invented (ADR 0020, brief rule 10)
    // and a price printed here would be the quote rather than the bill. `serviceName` is on the list and
    // is not a person, which is why the forbidden spellings are the PERSON-shaped ones rather than the
    // substring `name` — a sweep that banned that would have banned the treatment.
    for (const forbidden of [
      'customername',
      'displayname',
      'phone',
      'price',
      'fils',
      'therapist',
    ]) {
      expect(
        MANAGE_BOOKING_FIELDS.filter((field) => field.toLowerCase().includes(forbidden)),
        forbidden,
      ).toEqual([])
    }
  })

  it('has unique entries', () => {
    expect(new Set(MANAGE_BOOKING_FIELDS).size).toBe(MANAGE_BOOKING_FIELDS.length)
    expect(new Set(CLINICAL_FIELD_MARKERS).size).toBe(CLINICAL_FIELD_MARKERS.length)
  })
})
