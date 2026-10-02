import type { Config } from '@berelax/config'
import { describe, expect, it } from 'vitest'
import {
  checkoutContentSecurityPolicy,
  HOSTED_FIELDS_FRAME_ORIGIN_KEY,
  HOSTED_FIELDS_SCRIPT_ORIGIN_KEY,
  hostedFieldsFrom,
  isHostedFieldsOrigin,
  permittedOrigins,
} from './hosted-fields.ts'

/**
 * The hosted-fields origins and the checkout's content-security policy (Y-PAY-03).
 *
 * The acceptance line is *"the checkout route's CSP allows only the gateway's frame-src and script-src
 * origins; adding a further origin fails the header test"*, so this file asserts the WHOLE policy string and
 * counts the origins in it. Both are needed: the string catches a directive that changed, and the count
 * catches an origin added to a directive nobody was looking at. Gate block 145 adds one and requires this file
 * to fail.
 *
 * No gateway is named anywhere here. The origins in these cases are `.test` hosts, which is the reserved TLD
 * for exactly this (RFC 2606) and cannot be mistaken for a vendor's domain.
 */

const FRAME = 'https://fields.example.test'
const SCRIPT = 'https://script.example.test'

type HostedConfig = Pick<
  Config,
  'APP_ENV' | 'PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN' | 'PAYMENT_HOSTED_FIELDS_SCRIPT_ORIGIN'
>

const config = (overrides: Partial<HostedConfig> = {}): HostedConfig => ({
  APP_ENV: 'test',
  PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN: FRAME,
  PAYMENT_HOSTED_FIELDS_SCRIPT_ORIGIN: SCRIPT,
  ...overrides,
})

describe('an origin is an origin and nothing else', () => {
  it('accepts a bare https origin, with and without a port', () => {
    expect(isHostedFieldsOrigin(FRAME)).toBe(true)
    expect(isHostedFieldsOrigin('https://fields.example.test:8443')).toBe(true)
  })

  it('accepts a loopback http origin, which is what makes the cross-origin proof possible', () => {
    // The integration suite stands a stand-in gateway origin up on a loopback port with no certificate.
    // Production is refused an http origin separately, where the environment is known.
    expect(isHostedFieldsOrigin('http://127.0.0.1:16800')).toBe(true)
  })

  it('refuses anything with a path, which is the mistake that silently widens a policy', () => {
    // `frame-src https://x/fields` is a valid CSP source that matches a PREFIX, so `…/fields-anything` is
    // permitted too: a policy that reads tighter than it is.
    expect(isHostedFieldsOrigin('https://fields.example.test/')).toBe(false)
    expect(isHostedFieldsOrigin('https://fields.example.test/fields')).toBe(false)
    expect(isHostedFieldsOrigin('https://fields.example.test?a=1')).toBe(false)
    expect(isHostedFieldsOrigin('https://fields.example.test#x')).toBe(false)
  })

  it('refuses credentials, a wildcard, a bare host and a non-http scheme', () => {
    expect(isHostedFieldsOrigin('https://user:pw@fields.example.test')).toBe(false)
    expect(isHostedFieldsOrigin('https://*.example.test')).toBe(false)
    expect(isHostedFieldsOrigin('fields.example.test')).toBe(false)
    expect(isHostedFieldsOrigin('javascript:alert(1)')).toBe(false)
    expect(isHostedFieldsOrigin('')).toBe(false)
  })
})

describe('the configuration', () => {
  it('reads both origins when both are set', () => {
    const hosted = hostedFieldsFrom(config())
    expect(hosted.kind).toBe('configured')
    if (hosted.kind !== 'configured') return
    expect(hosted.origins).toEqual({ frame: FRAME, script: SCRIPT })
  })

  it('is not configured when either is absent, and names the key', () => {
    const noFrame = hostedFieldsFrom(config({ PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN: undefined }))
    expect(noFrame.kind).toBe('not_configured')
    if (noFrame.kind !== 'not_configured') return
    expect(noFrame.missing.join(' ')).toContain(HOSTED_FIELDS_FRAME_ORIGIN_KEY)

    const noScript = hostedFieldsFrom(config({ PAYMENT_HOSTED_FIELDS_SCRIPT_ORIGIN: undefined }))
    expect(noScript.kind).toBe('not_configured')
    if (noScript.kind !== 'not_configured') return
    expect(noScript.missing.join(' ')).toContain(HOSTED_FIELDS_SCRIPT_ORIGIN_KEY)
  })

  it('never derives one origin from the other', () => {
    // Deriving would be a guess about a vendor's topology, and it is wrong for every integration that splits
    // the two — at which point the CSP permits the wrong origin and the frame fails to load with nothing on
    // the page saying why.
    const hosted = hostedFieldsFrom(config({ PAYMENT_HOSTED_FIELDS_SCRIPT_ORIGIN: undefined }))
    expect(hosted.kind).toBe('not_configured')
    expect(JSON.stringify(hosted)).not.toContain('script.example.test')
  })

  it('treats a malformed value as missing rather than throwing', () => {
    // A throw would take the whole checkout to a 503 that says nothing about the setting.
    const hosted = hostedFieldsFrom(
      config({ PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN: 'https://fields.example.test/fields' }),
    )
    expect(hosted.kind).toBe('not_configured')
    if (hosted.kind !== 'not_configured') return
    expect(hosted.missing.join(' ')).toContain('bare origin')
  })

  it('refuses a plaintext origin in production and permits it in test', () => {
    const plain = { PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN: 'http://127.0.0.1:16800' } as const
    expect(hostedFieldsFrom(config({ ...plain, APP_ENV: 'production' })).kind).toBe(
      'not_configured',
    )
    // The control: the same value in test is fine, so the refusal above is about production and not about
    // the value.
    expect(
      hostedFieldsFrom(
        config({ ...plain, PAYMENT_HOSTED_FIELDS_SCRIPT_ORIGIN: 'http://127.0.0.1:16800' }),
      ).kind,
    ).toBe('configured')
  })
})

describe('the content-security policy', () => {
  it('is exactly this string when the gateway is configured', () => {
    // The whole string, not a substring. A substring assertion cannot see a directive that was widened
    // somewhere else in the policy, which is the failure gate block 145 plants.
    expect(checkoutContentSecurityPolicy(hostedFieldsFrom(config()))).toBe(
      "default-src 'none'; " +
        `frame-src ${FRAME}; ` +
        `script-src ${SCRIPT}; ` +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self'; " +
        "font-src 'self'; " +
        "connect-src 'none'; " +
        "form-action 'self'; " +
        "base-uri 'none'; " +
        "object-src 'none'; " +
        "frame-ancestors 'none'",
    )
  })

  it('permits exactly the two gateway origins and no others', () => {
    const policy = checkoutContentSecurityPolicy(hostedFieldsFrom(config()))
    expect(permittedOrigins(policy)).toEqual([FRAME, SCRIPT].sort())
  })

  it('permits NO origin at all when the gateway is not configured', () => {
    const policy = checkoutContentSecurityPolicy(
      hostedFieldsFrom(config({ PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN: undefined })),
    )
    expect(policy).toContain("frame-src 'none'")
    expect(policy).toContain("script-src 'none'")
    expect(permittedOrigins(policy)).toEqual([])
  })

  it('never allows a first-party script', () => {
    // The one directive that is an argument rather than a default. `'self'` would permit an analytics snippet,
    // a form helper or a session recorder to read or overlay the card frame, and every one of them would look
    // like ordinary front-end work.
    const policy = checkoutContentSecurityPolicy(hostedFieldsFrom(config()))
    expect(policy).not.toMatch(/script-src[^;]*'self'/)
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/)
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-eval'/)
  })

  it('the control: the origin counter can see an origin that was added', () => {
    // Without this, "permits exactly two" is satisfied by a counter that finds none.
    const widened = `${checkoutContentSecurityPolicy(hostedFieldsFrom(config()))} https://extra.example.test`
    expect(permittedOrigins(widened)).toHaveLength(3)
  })
})
