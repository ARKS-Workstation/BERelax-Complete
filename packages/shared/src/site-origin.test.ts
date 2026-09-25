import { describe, expect, it } from 'vitest'
import {
  MANAGE_BOOKING_PATH_PREFIX,
  manageBookingLink,
  manageBookingPath,
  SITE_ORIGIN_ENV,
  SITE_ORIGIN_FALLBACK,
  siteOriginFrom,
} from './site-origin.ts'

/**
 * The origin rule, where both readers of it can be held to the same answer.
 *
 * `apps/web/src/routes/registry.test.ts` asserts the same three behaviours through `siteOrigin()`, which
 * now delegates here. That duplication is the point rather than an oversight: that file proves the WEB
 * reader still behaves as W-SITE-01 specified, and this one proves the rule holds for the worker's reader
 * too — and the worker's is the one whose output goes in an SMS.
 */
describe('the site origin', () => {
  it('falls back to the live domain when the environment says nothing', () => {
    for (const absent of [undefined, '', '   ']) {
      expect(siteOriginFrom(absent), String(absent)).toBe(SITE_ORIGIN_FALLBACK)
    }
  })

  it('takes an override, without its trailing slash', () => {
    expect(siteOriginFrom('https://staging.berelaxmassage.com/')).toBe(
      'https://staging.berelaxmassage.com',
    )
    expect(siteOriginFrom('  http://127.0.0.1:3000  ')).toBe('http://127.0.0.1:3000')
    // The control: the override really is used, so the fallback case above is not satisfied by a function
    // that ignores its argument.
    expect(siteOriginFrom('https://example.test')).not.toBe(SITE_ORIGIN_FALLBACK)
  })

  it('throws on a value that is not an origin, naming the variable', () => {
    for (const bad of [
      'berelaxmassage.com',
      '//berelaxmassage.com',
      'ftp://x.example',
      'https://x/p',
      'https://x/?q=1',
      'https://x/#a',
    ]) {
      expect(() => siteOriginFrom(bad), bad).toThrow(new RegExp(SITE_ORIGIN_ENV))
    }
  })
})

describe('the manage-booking link', () => {
  const TOKEN = '0123456789abcdef'.repeat(4)

  it('is the prefix and the token, with no trailing slash and no query', () => {
    expect(manageBookingPath(TOKEN)).toBe(`/booking/${TOKEN}`)
    expect(manageBookingLink('https://berelaxmassage.com', TOKEN)).toBe(
      `https://berelaxmassage.com/booking/${TOKEN}`,
    )
    // A trailing slash would be 301'd away by the site's own canonicalisation, and a redirect in a link a
    // customer taps is a request they pay for twice.
    expect(manageBookingPath(TOKEN).endsWith('/')).toBe(false)
    expect(manageBookingPath(TOKEN)).not.toContain('?')
  })

  it('spells the prefix once, and the registry pattern is built from the same letters', () => {
    // The half that can be checked without the registry: the prefix is the constant, not a literal inside
    // the builder. `apps/web/src/manage-booking.itest.ts` asserts the registry's `/booking/[token]` entry
    // against this prefix, which is the half that needs the registry.
    expect(MANAGE_BOOKING_PATH_PREFIX).toBe('/booking/')
    expect(manageBookingPath('x').startsWith(MANAGE_BOOKING_PATH_PREFIX)).toBe(true)
  })
})
