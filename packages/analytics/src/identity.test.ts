import { describe, expect, it } from 'vitest'
import {
  EMAIL_HASHING_VECTORS,
  emailSha256,
  hashedUserData,
  normaliseEmailForMatching,
  PHONE_HASHING_VECTORS,
  phoneDigitsForMatching,
  phoneSha256,
  sha256Lower,
} from './identity.ts'

/**
 * The committed hashing vectors (A-MEAS-03's second acceptance line).
 *
 * Every equality here is paired with a control that must FAIL, because "they agree" is satisfied
 * perfectly by three functions that all return the empty string, by three that all return the digest of
 * the empty string, and by three that return the digest of their own raw input. All three of those are
 * asserted against.
 */
describe('the phone vectors', () => {
  it('reduces all three committed spellings to one digest', () => {
    const digests = new Set(
      PHONE_HASHING_VECTORS.map((raw) => {
        const hashed = phoneSha256(raw)
        expect(hashed.sha256, `${raw} must normalise`).not.toBeNull()
        return hashed.sha256
      }),
    )
    expect(digests.size, `one digest for ${PHONE_HASHING_VECTORS.join(', ')}`).toBe(1)
  })

  it('does NOT hash the raw spelling, which is what makes the equality above mean something', () => {
    // The control. Three functions that hashed their input verbatim would fail this and pass the case
    // above only for the one spelling that is already normalised — so this is the case that distinguishes
    // "normalised then hashed" from "hashed".
    const [spaced, plus] = PHONE_HASHING_VECTORS
    expect(phoneSha256(spaced ?? '').sha256).not.toBe(sha256Lower(spaced ?? ''))
    // And the E.164 spelling's digest is not the digest of the string WITH the plus, which is the one
    // transformation this module adds on top of the core normaliser.
    expect(phoneSha256(plus ?? '').sha256).not.toBe(sha256Lower(plus ?? ''))
  })

  it('normalises to digits with the country code and no punctuation', () => {
    const key = phoneDigitsForMatching(PHONE_HASHING_VECTORS[0])
    expect(key.ok).toBe(true)
    if (!key.ok) return
    expect(key.digits).toMatch(/^\d+$/)
    expect(key.digits.startsWith('971')).toBe(true)
  })

  it('refuses a number this build cannot normalise rather than hashing it', () => {
    // A landline is refused by the core normaliser. A digest of an unnormalised string is a match key
    // that matches nothing and is indistinguishable on the wire from one that should have matched.
    const landline = phoneSha256('02 123 4567')
    expect(landline.sha256).toBeNull()
    expect(phoneSha256('').sha256).toBeNull()
  })

  it('is not the digest of the empty string, for any vector', () => {
    const empty = sha256Lower('')
    for (const raw of PHONE_HASHING_VECTORS) {
      expect(phoneSha256(raw).sha256).not.toBe(empty)
    }
  })
})

describe('the email vector', () => {
  it('matches the normalised address, trim and case folded', () => {
    for (const { raw, normalisesTo } of EMAIL_HASHING_VECTORS) {
      expect(normaliseEmailForMatching(raw)).toBe(normalisesTo)
      expect(emailSha256(raw)).toBe(sha256Lower(normalisesTo))
      // The control: not the digest of the raw string, which carries two spaces and three capitals.
      expect(emailSha256(raw)).not.toBe(sha256Lower(raw))
    }
  })

  it("does NOT strip dots or plus tags, which are one provider's delivery rules and not a normalisation", () => {
    // `a.b@example.com` and `ab@example.com` are the same mailbox at one provider and two different
    // people at another, so folding them would merge two customers into one conversion.
    expect(emailSha256('a.b@example.com')).not.toBe(emailSha256('ab@example.com'))
    expect(emailSha256('a+tag@example.com')).not.toBe(emailSha256('a@example.com'))
  })
})

describe('the digest itself', () => {
  it('is 64 lowercase hex characters', () => {
    expect(sha256Lower('name@example.com')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs for inputs that differ, which no shared constant would', () => {
    expect(sha256Lower('a')).not.toBe(sha256Lower('b'))
  })
})

describe('the match set a dispatch carries', () => {
  it('omits an absent field rather than carrying it as null', () => {
    const { userData, omitted } = hashedUserData({})
    // `exactOptionalPropertyTypes` keeps the two apart at the type level; this is the runtime half.
    expect(Object.hasOwn(userData, 'phoneSha256')).toBe(false)
    expect(Object.hasOwn(userData, 'emailSha256')).toBe(false)
    expect(omitted).toEqual({ phone: 'absent', email: 'absent' })
  })

  it('names an unnormalisable field differently from an absent one', () => {
    const { userData, omitted } = hashedUserData({ phone: '02 123 4567', email: 'not-an-address' })
    expect(userData).toEqual({})
    expect(omitted).toEqual({ phone: 'unnormalisable', email: 'unnormalisable' })
  })

  it('forwards fbp and fbc verbatim and does not hash them', () => {
    const fbp = 'fb.1.1700000000000.1234567890'
    const { userData } = hashedUserData({ fbp, fbc: ' fbclid-value ' })
    // Unhashed, because they are Meta's own cookie values: hashing them makes them unmatchable, and they
    // are the only thing that joins a server-side conversion to the click that produced it.
    expect(userData.fbp).toBe(fbp)
    expect(userData.fbp).not.toBe(sha256Lower(fbp))
    // Trimmed, and a blank one is dropped rather than forwarded as an empty match key.
    expect(userData.fbc).toBe('fbclid-value')
    expect(Object.hasOwn(hashedUserData({ fbc: '   ' }).userData, 'fbc')).toBe(false)
  })

  it('hashes what it can and omits what it cannot, in one call', () => {
    const { userData, omitted } = hashedUserData({
      phone: PHONE_HASHING_VECTORS[0],
      email: 'not-an-address',
    })
    expect(userData.phoneSha256).toBe(phoneSha256(PHONE_HASHING_VECTORS[0]).sha256)
    expect(omitted).toEqual({ email: 'unnormalisable' })
    // The control on the control: `phone` must not appear in `omitted` when it WAS hashed, because a
    // consumer counting omissions reads the keys.
    expect(Object.hasOwn(omitted, 'phone')).toBe(false)
  })
})
