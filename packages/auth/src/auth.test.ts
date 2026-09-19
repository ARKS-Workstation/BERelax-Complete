import type { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { assertPasswordPolicy, hashPassword, verifyPassword } from './password.ts'
import {
  assertAuthenticated,
  hashToken,
  issueSession,
  type LoginInput,
  resolveLoginStage,
} from './session.ts'
import {
  base32Decode,
  base32Encode,
  generateSecret,
  TOTP_PERIOD_SECONDS,
  totpAt,
  totpEnrolmentUri,
  verifyTotp,
} from './totp.ts'

describe('password policy', () => {
  it('rejects a password that is too short or missing a class', () => {
    expect(() => assertPasswordPolicy('short1A')).toThrow(/at least 12/)
    expect(() => assertPasswordPolicy('alllowercase1')).toThrow(/uppercase/)
    expect(() => assertPasswordPolicy('ALLUPPERCASE1')).toThrow(/lowercase/)
    expect(() => assertPasswordPolicy('NoDigitsHere!')).toThrow(/digit/)
  })

  it('accepts a compliant password', () => {
    expect(() => assertPasswordPolicy('CorrectHorse1Battery')).not.toThrow()
  })

  it('marks the policy error as user-facing, since the user must act on it', () => {
    try {
      assertPasswordPolicy('weak')
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as AppError).userFacing).toBe(true)
    }
  })
})

/*
  An explicit timeout, because every test in here is deliberately expensive.

  `hashPassword` is scrypt at N=65536, r=8 — the cost is the point, and `verifyPassword` pays it again. The
  four derivations in "produces a different hash each time" take about 800ms on an idle machine, against
  vitest's default 5s: a margin of roughly six times, which several test suites running at once erase.
  Three units in a row have had a full `pnpm verify` fail here on nothing but load, and the failure is
  expensive to read because it surfaces through whichever gate was running the nested vitest.

  30s rather than a raised global default: the slowness is a property of these four tests and of nothing
  else in the repository, and a global timeout would also hide a genuine hang somewhere cheap.
*/
describe('password hashing', { timeout: 30_000 }, () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('CorrectHorse1Battery')
    expect(await verifyPassword('CorrectHorse1Battery', stored)).toBe(true)
    expect(await verifyPassword('CorrectHorse1Batterz', stored)).toBe(false)
  })

  it('produces a different hash each time, so identical passwords are not linkable', async () => {
    const a = await hashPassword('CorrectHorse1Battery')
    const b = await hashPassword('CorrectHorse1Battery')
    expect(a).not.toBe(b)
    expect(await verifyPassword('CorrectHorse1Battery', a)).toBe(true)
    expect(await verifyPassword('CorrectHorse1Battery', b)).toBe(true)
  })

  it('records its cost parameters in the stored string, so they can be raised later', async () => {
    const stored = await hashPassword('CorrectHorse1Battery')
    expect(stored.startsWith('scrypt$65536$8$1$')).toBe(true)
  })

  it('returns false for a malformed stored hash rather than throwing', async () => {
    // A corrupt row must be indistinguishable from a wrong password, by timing and by error.
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('anything', 'scrypt$1$2')).toBe(false)
    expect(await verifyPassword('anything', '')).toBe(false)
  })
})

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42, 17])
    expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes])
  })

  it('rejects an invalid character rather than decoding silently', () => {
    expect(() => base32Decode('ABC1')).toThrow(/Invalid base32/)
  })
})

describe('TOTP', () => {
  const secret = 'JBSWY3DPEHPK3PXP' // RFC 6238 style test secret

  it('generates a 6-digit code', () => {
    expect(totpAt(secret, 1_700_000_000_000)).toMatch(/^\d{6}$/)
  })

  it('is stable within a 30-second window and changes across it', () => {
    const base = 1_700_000_000_000
    const inSameWindow = base + (TOTP_PERIOD_SECONDS - 1) * 1000
    // Align to a window boundary to make the assertion deterministic.
    const aligned = Math.floor(base / 1000 / TOTP_PERIOD_SECONDS) * TOTP_PERIOD_SECONDS * 1000
    expect(totpAt(secret, aligned)).toBe(totpAt(secret, aligned + 29_000))
    expect(totpAt(secret, aligned)).not.toBe(totpAt(secret, aligned + 30_000))
    expect(inSameWindow).toBeGreaterThan(base)
  })

  it('accepts the current code', () => {
    const now = 1_700_000_000_000
    expect(verifyTotp(secret, totpAt(secret, now), now).valid).toBe(true)
  })

  it('accepts one window of clock drift in each direction, because phone clocks drift', () => {
    const now = 1_700_000_000_000
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), now).valid).toBe(true)
    expect(verifyTotp(secret, totpAt(secret, now + 30_000), now).valid).toBe(true)
  })

  it('rejects two windows of drift', () => {
    const now = 1_700_000_000_000
    expect(verifyTotp(secret, totpAt(secret, now - 90_000), now).valid).toBe(false)
  })

  it('rejects a malformed code without doing any crypto', () => {
    expect(verifyTotp(secret, '12345', 1_700_000_000_000)).toEqual({
      valid: false,
      reason: 'malformed',
    })
    expect(verifyTotp(secret, 'abcdef', 1_700_000_000_000).reason).toBe('malformed')
  })

  it('REJECTS a replayed code, which is most of the point of a second factor', () => {
    const now = 1_700_000_000_000
    const first = verifyTotp(secret, totpAt(secret, now), now)
    expect(first.valid).toBe(true)
    // Narrow before passing: exactOptionalPropertyTypes refuses an explicit undefined, which is
    // the right call here — "no counter recorded" and "counter 0" must not be conflated.
    const usedCounter = first.counter
    expect(usedCounter).toBeDefined()
    const replay = verifyTotp(secret, totpAt(secret, now), now, {
      lastUsedCounter: usedCounter as number,
    })
    expect(replay.valid).toBe(false)
    expect(replay.reason).toBe('replayed')
  })

  it('generates a secret that verifies against its own codes', () => {
    const generated = generateSecret()
    const now = 1_700_000_000_000
    expect(verifyTotp(generated, totpAt(generated, now), now).valid).toBe(true)
  })

  it('builds an otpauth URI with the issuer and period', () => {
    const uri = totpEnrolmentUri({
      secretBase32: secret,
      accountName: 'owner@berelax.ae',
      issuer: 'BeRelax',
    })
    expect(uri).toContain('otpauth://totp/BeRelax%3Aowner%40berelax.ae')
    expect(uri).toContain('period=30')
    expect(uri).toContain(`secret=${secret}`)
  })
})

describe('session tokens', () => {
  it('never stores the raw token', () => {
    const issued = issueSession(1_700_000_000_000)
    expect(issued.tokenHash).toBe(hashToken(issued.token))
    expect(issued.tokenHash).not.toBe(issued.token)
    expect(issued.tokenHash).toHaveLength(64)
  })

  it('issues a distinct token every time', () => {
    const a = issueSession(0)
    const b = issueSession(0)
    expect(a.token).not.toBe(b.token)
  })

  it('gives a refresh token a longer life than an access token', () => {
    const access = issueSession(0, 'access')
    const refresh = issueSession(0, 'refresh')
    expect(refresh.expiresAtMs).toBeGreaterThan(access.expiresAtMs)
  })
})

describe('login stage — TOTP is unrepresentable to skip', () => {
  const input = (overrides: Partial<LoginInput>): LoginInput => ({
    role: 'owner',
    passwordVerified: true,
    totpEnrolled: true,
    totpVerified: true,
    ...overrides,
  })

  for (const role of ['owner', 'manager', 'accountant', 'auditor'] as const) {
    it(`${role} CANNOT reach authenticated on password alone`, () => {
      const stage = resolveLoginStage(input({ role, totpVerified: false }))
      expect(stage.stage).toBe('totp_required')
      expect(() => assertAuthenticated(stage)).toThrow(/Login incomplete/)
    })

    it(`${role} is forced to ENROL in TOTP if they have not`, () => {
      const stage = resolveLoginStage(input({ role, totpEnrolled: false, totpVerified: false }))
      expect(stage.stage).toBe('totp_enrolment_required')
      expect(() => assertAuthenticated(stage)).toThrow()
    })

    it(`${role} reaches authenticated with password plus TOTP`, () => {
      expect(resolveLoginStage(input({ role })).stage).toBe('authenticated')
    })
  }

  it('a receptionist authenticates on password alone', () => {
    const stage = resolveLoginStage(
      input({ role: 'receptionist', totpEnrolled: false, totpVerified: false }),
    )
    expect(stage.stage).toBe('authenticated')
  })

  it('but a receptionist who HAS enrolled must still complete it', () => {
    const stage = resolveLoginStage(
      input({ role: 'receptionist', totpEnrolled: true, totpVerified: false }),
    )
    expect(stage.stage).toBe('totp_required')
  })

  it('an unverified password never reaches any other stage', () => {
    for (const role of ['owner', 'receptionist', 'therapist'] as const) {
      expect(resolveLoginStage(input({ role, passwordVerified: false })).stage).toBe(
        'password_required',
      )
    }
  })

  it('assertAuthenticated returns the role on success', () => {
    expect(assertAuthenticated(resolveLoginStage(input({ role: 'manager' })))).toEqual({
      role: 'manager',
    })
  })
})
