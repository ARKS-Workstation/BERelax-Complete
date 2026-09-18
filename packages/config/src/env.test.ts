import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { parseConfig } from './env.ts'

const base = {
  APP_ENV: 'development',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
}

describe('parseConfig', () => {
  it('fails loudly and names every missing key at once', () => {
    try {
      parseConfig({})
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      const err = e as AppError
      expect(err.kind).toBe('validation')
      // Both problems reported together, not one at a time on successive boots.
      expect(err.message).toContain('APP_ENV')
      expect(err.message).toContain('DATABASE_URL')
      expect(err.message).toMatch(/2 problem\(s\)/)
    }
  })

  it('rejects an unknown APP_ENV rather than defaulting to something', () => {
    expect(() => parseConfig({ ...base, APP_ENV: 'prod' })).toThrow(AppError)
  })

  it('defaults every provider to fake and the timezone to Asia/Dubai', () => {
    const cfg = parseConfig(base)
    expect(cfg.SMS_PROVIDER).toBe('fake')
    expect(cfg.EMAIL_PROVIDER).toBe('fake')
    expect(cfg.GOOGLE_PROVIDER).toBe('fake')
    expect(cfg.PAYMENT_PROVIDER).toBe('fake')
    expect(cfg.MEDIA_STORAGE).toBe('fake')
    expect(cfg.BUSINESS_TIMEZONE).toBe('Asia/Dubai')
  })

  it('returns a frozen object, so configuration cannot be mutated at runtime', () => {
    const cfg = parseConfig(base)
    expect(Object.isFrozen(cfg)).toBe(true)
  })

  describe('real providers outside production', () => {
    for (const env of ['development', 'test', 'preview', 'staging'] as const) {
      it(`REFUSES SMS_PROVIDER=real when APP_ENV=${env}`, () => {
        expect(() => parseConfig({ ...base, APP_ENV: env, SMS_PROVIDER: 'real' })).toThrow(
          /SMS_PROVIDER=real is refused/,
        )
      })

      it(`REFUSES GOOGLE_PROVIDER=real when APP_ENV=${env} — protects real refresh tokens`, () => {
        expect(() => parseConfig({ ...base, APP_ENV: env, GOOGLE_PROVIDER: 'real' })).toThrow(
          /GOOGLE_PROVIDER=real is refused/,
        )
      })

      // The private bucket holds nineteen full-resolution photographs of real employees whose
      // photography consent is not on record. A staging run writing those to the real bucket is the
      // failure this refusal exists for.
      it(`REFUSES MEDIA_STORAGE=real when APP_ENV=${env}`, () => {
        expect(() => parseConfig({ ...base, APP_ENV: env, MEDIA_STORAGE: 'real' })).toThrow(
          /MEDIA_STORAGE=real is refused/,
        )
      })
    }

    it('reports every offending provider in one error, not just the first', () => {
      try {
        parseConfig({
          ...base,
          APP_ENV: 'staging',
          SMS_PROVIDER: 'real',
          EMAIL_PROVIDER: 'real',
          PAYMENT_PROVIDER: 'real',
        })
        expect.unreachable('should have thrown')
      } catch (e) {
        const msg = (e as AppError).message
        expect(msg).toContain('SMS_PROVIDER')
        expect(msg).toContain('EMAIL_PROVIDER')
        expect(msg).toContain('PAYMENT_PROVIDER')
      }
    })

    it('permits real providers in production', () => {
      const cfg = parseConfig({
        ...base,
        APP_ENV: 'production',
        SMS_PROVIDER: 'real',
        EMAIL_PROVIDER: 'real',
        MEDIA_STORAGE: 'real',
      })
      expect(cfg.SMS_PROVIDER).toBe('real')
      // The control for the refusals above: a rule that rejected `real` everywhere would pass all of
      // them while making the flag useless.
      expect(cfg.MEDIA_STORAGE).toBe('real')
    })
  })

  describe('Google credentials', () => {
    it('requires client id and secret when the real provider is selected', () => {
      try {
        parseConfig({ ...base, APP_ENV: 'production', GOOGLE_PROVIDER: 'real' })
        expect.unreachable('should have thrown')
      } catch (e) {
        const msg = (e as AppError).message
        expect(msg).toContain('GOOGLE_OAUTH_CLIENT_ID')
        expect(msg).toContain('GOOGLE_OAUTH_CLIENT_SECRET')
      }
    })

    it('does not require them for the fake provider', () => {
      expect(() => parseConfig({ ...base, GOOGLE_PROVIDER: 'fake' })).not.toThrow()
    })
  })

  describe('OUTBOUND_ALLOWLIST', () => {
    it('parses a comma-separated list and trims entries', () => {
      const cfg = parseConfig({ ...base, OUTBOUND_ALLOWLIST: ' +971500000001 , dev@example.com ' })
      expect(cfg.OUTBOUND_ALLOWLIST).toEqual(['+971500000001', 'dev@example.com'])
    })

    it('must be empty in production, where it would silently restrict delivery', () => {
      expect(() =>
        parseConfig({ ...base, APP_ENV: 'production', OUTBOUND_ALLOWLIST: '+971500000001' }),
      ).toThrow(/must be empty in production/)
    })
  })
})
