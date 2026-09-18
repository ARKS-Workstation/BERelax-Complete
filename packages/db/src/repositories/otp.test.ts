import { describe, expect, it } from 'vitest'
import {
  generateOtpCode,
  hashOtpCode,
  OTP_CODE_DIGITS,
  OTP_LOCK_MINUTES,
  OTP_MAX_FAILED_ATTEMPTS,
  OTP_TTL_MINUTES,
} from './otp.ts'

/**
 * The two halves of the OTP module that need no database.
 *
 * Everything else about an OTP is a claim about rows — that the code is not in one, that a second
 * verification finds the challenge consumed, that the attempt counter survived a resend — and those
 * live in `otp.itest.ts` against a real PostgreSQL. What is left here is the code generator and the
 * hash, and both are worth their own test: they are the two functions whose failure is silent.
 */

/** Enough draws that "no code ever starts with zero" would be seen. */
const DRAWS = 2_000

describe('generateOtpCode', () => {
  it('is always the declared number of digits, leading zeros included', () => {
    const codes = Array.from({ length: DRAWS }, () => generateOtpCode())
    const shaped = new RegExp(`^\\d{${OTP_CODE_DIGITS}}$`)
    for (const code of codes) expect(code).toMatch(shaped)

    // A generator that formatted the integer without padding would quietly emit five-digit codes one
    // time in ten, and the symptom would be a customer whose code "does not work" — because the SMS
    // said 42917 and the input expects six characters.
    expect(codes.some((code) => code.startsWith('0'))).toBe(true)
  })

  it('does not return the same code twice in a row', () => {
    // The control for the test above, which a constant generator would also pass. With a million
    // values, 2,000 draws containing fewer than 1,900 distinct ones is not chance.
    const distinct = new Set(Array.from({ length: DRAWS }, () => generateOtpCode()))
    expect(distinct.size).toBeGreaterThan(DRAWS * 0.95)
  })
})

describe('hashOtpCode', () => {
  const salt = Buffer.from('0123456789abcdef', 'utf8')
  const otherSalt = Buffer.from('fedcba9876543210', 'utf8')

  it('is a 32-byte digest, deterministic for one code and salt', () => {
    expect(hashOtpCode('042917', salt)).toHaveLength(32)
    expect(hashOtpCode('042917', salt).equals(hashOtpCode('042917', salt))).toBe(true)
  })

  it('separates a different code and a different salt', () => {
    // Different code, same salt: the property verification depends on.
    expect(hashOtpCode('042917', salt).equals(hashOtpCode('042918', salt))).toBe(false)
    // Same code, different salt: the property that stops two challenges sharing a code from looking
    // identical in the table, which would let somebody who knows one code recognise the other.
    expect(hashOtpCode('042917', salt).equals(hashOtpCode('042917', otherSalt))).toBe(false)
  })
})

describe('the declared policy', () => {
  it('is the policy docs/06 and ADR 0014 describe', () => {
    // These four numbers are quoted in the migration, in the API response and in the acceptance
    // criteria. Pinning them here means changing one is a visible decision rather than a typo.
    expect(OTP_CODE_DIGITS).toBe(6)
    expect(OTP_TTL_MINUTES).toBe(5)
    expect(OTP_MAX_FAILED_ATTEMPTS).toBe(5)
    expect(OTP_LOCK_MINUTES).toBe(15)
  })
})
