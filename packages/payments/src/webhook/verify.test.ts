import type { Instant } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  parseWebhookDelivery,
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_REFUSAL_STATUS,
  WEBHOOK_REFUSALS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  WebhookDeliveryMalformed,
  type WebhookVerification,
  webhookSigningSecretFrom,
} from './verify.ts'

/**
 * Y-PAY-04's first claim: **a webhook is an unauthenticated request until its signature verifies.**
 *
 * Every case here is about the ORDER and about what a refusal does NOT carry. The acceptance line asks
 * for absent, malformed and wrong-key to be asserted individually, and each one is paired with the
 * control that stops it passing vacuously: the same delivery, correctly signed, must be accepted. Without
 * that pairing, every case below is satisfied by a verifier that refuses everything.
 *
 * The secret here is this file's own string and is not a credential: no gateway has been chosen
 * (OPEN-QUESTIONS `Y7-gateway`), so there is nothing to leak and nothing configured anywhere to match.
 */

const SECRET = 'y-pay-04-test-secret-not-a-credential'
const configured = webhookSigningSecretFrom({ PAYMENT_WEBHOOK_SIGNING_SECRET: SECRET })
const NOW = 1_900_000_000_000 as Instant
const TIMESTAMP = String(Math.floor(NOW / 1000))

const BODY = JSON.stringify({
  eventId: 'evt-0001',
  eventType: 'captured',
  gatewayIntentId: 'gw-0001',
  occurredAt: '2099-12-01T15:00:00.000Z',
  amountFils: 21_000,
})

const headersFor = (signature: string | null, timestamp: string | null): Headers => {
  const headers = new Headers()
  if (signature !== null) headers.set(WEBHOOK_SIGNATURE_HEADER, signature)
  if (timestamp !== null) headers.set(WEBHOOK_TIMESTAMP_HEADER, timestamp)
  return headers
}

const verify = (input: {
  readonly body?: string
  readonly signature?: string | null
  readonly timestamp?: string | null
  readonly secret?: typeof configured
  readonly now?: Instant
}): WebhookVerification => {
  const body = input.body ?? BODY
  const timestamp = input.timestamp === undefined ? TIMESTAMP : input.timestamp
  const signature =
    input.signature === undefined
      ? signWebhookPayload(SECRET, timestamp ?? TIMESTAMP, body)
      : input.signature
  return verifyWebhookSignature({
    rawBody: body,
    headers: headersFor(signature, timestamp),
    secret: input.secret ?? configured,
    now: input.now ?? NOW,
  })
}

describe('the refusal table', () => {
  it('gives every refusal a status, and only the unconfigured one is 503', () => {
    for (const refusal of WEBHOOK_REFUSALS) {
      expect([401, 503]).toContain(WEBHOOK_REFUSAL_STATUS[refusal])
    }
    // The distinction the module note argues for: 401 says "your signature is wrong" and the truth for an
    // absent secret is "we cannot check it" — and a gateway retries a 503 while a 401 makes it give up.
    expect(WEBHOOK_REFUSAL_STATUS.secret_not_configured).toBe(503)
    const fourOhOnes = WEBHOOK_REFUSALS.filter((refusal) => WEBHOOK_REFUSAL_STATUS[refusal] === 401)
    expect(fourOhOnes).toEqual([
      'signature_absent',
      'signature_malformed',
      'signature_invalid',
      'timestamp_outside_tolerance',
    ])
  })
})

describe('the configured secret', () => {
  it('is absent by default, and a blank one is absent too', () => {
    expect(webhookSigningSecretFrom({}).kind).toBe('not_configured')
    expect(webhookSigningSecretFrom({ PAYMENT_WEBHOOK_SIGNING_SECRET: '' }).kind).toBe(
      'not_configured',
    )
    // Whitespace, which is what an environment variable set to nothing looks like. An empty string is a
    // perfectly valid HMAC key and would verify a signature anybody could compute.
    expect(webhookSigningSecretFrom({ PAYMENT_WEBHOOK_SIGNING_SECRET: '   ' }).kind).toBe(
      'not_configured',
    )
    expect(webhookSigningSecretFrom({ PAYMENT_WEBHOOK_SIGNING_SECRET: SECRET })).toEqual({
      kind: 'configured',
      secret: SECRET,
    })
  })

  it('refuses every delivery when it is absent, naming the key and never 401', () => {
    const refused = verify({ secret: webhookSigningSecretFrom({}) })
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') return
    expect(refused.reason).toBe('secret_not_configured')
    expect(refused.status).toBe(503)
    expect(refused.missing).toEqual(['PAYMENT_WEBHOOK_SIGNING_SECRET'])
    // The whole point: a CORRECTLY SIGNED delivery is refused too. There is no fall-back to trusting the
    // body on a machine where somebody forgot the environment variable.
    expect(verify({ secret: configured }).kind).toBe('verified')
  })
})

describe('the three refusals the acceptance names', () => {
  it('refuses an ABSENT signature', () => {
    const refused = verify({ signature: null, timestamp: null })
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') return
    expect(refused.reason).toBe('signature_absent')
    expect(refused.status).toBe(401)
  })

  it.each([
    ['one header without the other', 'deadbeef'.repeat(8), null],
    ['a signature that is not 64 hex characters', 'not-a-signature', TIMESTAMP],
    ['an upper-case digest, which is not the shape we emit', 'DEADBEEF'.repeat(8), TIMESTAMP],
    ['a timestamp that is an ISO instant', 'deadbeef'.repeat(8), '2099-12-01T15:00:00Z'],
    ['a negative timestamp', 'deadbeef'.repeat(8), '-1'],
  ])('refuses a MALFORMED signature: %s', (_name, signature, timestamp) => {
    const refused = verify({ signature, timestamp })
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') return
    expect(refused.reason).toBe('signature_malformed')
    expect(refused.status).toBe(401)
  })

  it('refuses a WRONG-KEY signature', () => {
    const wrongKey = signWebhookPayload('another-secret-entirely', TIMESTAMP, BODY)
    const refused = verify({ signature: wrongKey })
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') return
    expect(refused.reason).toBe('signature_invalid')
    expect(refused.status).toBe(401)
  })

  it('refuses a signature over a DIFFERENT body, which is the same refusal', () => {
    // A valid signature pointed at another payload. One refusal for this and for a wrong key, and that
    // is deliberate: the two are indistinguishable from here by construction, and a scheme that could
    // tell them apart would be leaking which half of the check failed.
    const signedForSomethingElse = signWebhookPayload(SECRET, TIMESTAMP, '{"eventId":"evt-9999"}')
    const refused = verify({ signature: signedForSomethingElse })
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') return
    expect(refused.reason).toBe('signature_invalid')
  })

  it('refuses a signature over a different TIMESTAMP, so the timestamp cannot be edited', () => {
    // The timestamp is INSIDE the signed payload. Without that, a stale delivery could be presented with
    // a fresh timestamp and the tolerance would pass it.
    const signature = signWebhookPayload(SECRET, TIMESTAMP, BODY)
    const refused = verify({ signature, timestamp: String(Number(TIMESTAMP) + 1) })
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') return
    expect(refused.reason).toBe('signature_invalid')
  })

  it('accepts a correctly signed delivery, which is the control for all of the above', () => {
    const verified = verify({})
    expect(verified.kind).toBe('verified')
    if (verified.kind !== 'verified') return
    expect(verified.body).toBe(BODY)
    expect(verified.signedAtEpochSeconds).toBe(Number(TIMESTAMP))
  })
})

describe('the timestamp tolerance', () => {
  it('accepts a delivery at the edge of the window, in both directions', () => {
    for (const offset of [
      -WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
      WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    ]) {
      const timestamp = String(Number(TIMESTAMP) + offset)
      expect(verify({ timestamp }).kind, `offset ${offset} was refused`).toBe('verified')
    }
  })

  it('rejects a correctly signed delivery outside the window as a REPLAY', () => {
    const stale = String(Number(TIMESTAMP) - WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 1)
    const refused = verify({ timestamp: stale })
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') return
    // Not `signature_invalid`: this delivery WAS genuine. That is what makes the refusal a replay rather
    // than a forgery, and it is only true because the tolerance is checked AFTER the MAC.
    expect(refused.reason).toBe('timestamp_outside_tolerance')
    expect(refused.status).toBe(401)
  })

  it('rejects a FORGED stale delivery as invalid, not as a replay', () => {
    // The control for the ordering. A forged body with a stale timestamp must not be reported as a
    // replay: checked first, the tolerance would answer the same thing for the gateway's own retry and
    // for an attacker, and the log could not tell them apart.
    const stale = String(Number(TIMESTAMP) - WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 1)
    const refused = verify({ timestamp: stale, signature: 'deadbeef'.repeat(8) })
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') return
    expect(refused.reason).toBe('signature_invalid')
  })

  it('is this build’s own policy, stated once, and a caller may narrow it', () => {
    expect(WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS).toBeGreaterThan(0)
    const narrowed = verifyWebhookSignature({
      rawBody: BODY,
      headers: headersFor(signWebhookPayload(SECRET, TIMESTAMP, BODY), TIMESTAMP),
      secret: configured,
      now: (NOW + 10_000) as Instant,
      toleranceSeconds: 5,
    })
    expect(narrowed.kind).toBe('refused')
    // And the control: the default window would have accepted the same delivery.
    expect(verify({ now: (NOW + 10_000) as Instant }).kind).toBe('verified')
  })
})

describe('a refusal carries no part of the body', () => {
  it('returns only a reason, a status and the missing key names', () => {
    const marker = 'A-STRING-THAT-MUST-NOT-ESCAPE-4111111111111111'
    for (const refused of [
      verify({ body: marker, signature: null, timestamp: null }),
      verify({ body: marker, signature: 'nope' }),
      verify({ body: marker, signature: signWebhookPayload('other', TIMESTAMP, marker) }),
      verify({ body: marker, secret: webhookSigningSecretFrom({}) }),
    ]) {
      expect(refused.kind).toBe('refused')
      // Serialised whole, so a field added to `RefusedWebhook` later cannot smuggle the body through.
      const serialised = JSON.stringify(refused)
      expect(serialised, 'a refusal carried part of the body').not.toContain(marker)
      expect(serialised).not.toContain('4111')
    }
    // The control: the VERIFIED branch does carry it, so the assertion above is about the refusals and
    // not about a marker that never reached the function.
    const verified = verify({ body: marker })
    expect(verified.kind).toBe('verified')
    expect(JSON.stringify(verified)).toContain(marker)
  })
})

describe('parsing, which happens only after verification', () => {
  it('reads the fields the lifecycle needs and ignores the rest', () => {
    const verified = verify({
      body: JSON.stringify({
        eventId: 'evt-0002',
        eventType: 'authorised',
        gatewayIntentId: 'gw-0002',
        occurredAt: '2099-12-01T15:00:00.000Z',
        amountFils: 1_000,
        // A field this build has never heard of. Accepted and ignored: a refusal on an unknown key would
        // make every one of the vendor's future additions an outage.
        livemode: true,
      }),
    })
    if (verified.kind !== 'verified') throw new Error('the fixture did not verify')
    expect(parseWebhookDelivery(verified)).toEqual({
      eventId: 'evt-0002',
      eventType: 'authorised',
      gatewayIntentId: 'gw-0002',
      occurredAt: '2099-12-01T15:00:00.000Z',
      amountFils: 1_000,
    })
  })

  it.each([
    ['not JSON at all', 'not json'],
    ['a JSON array', '[]'],
    [
      'a missing eventId',
      '{"eventType":"captured","gatewayIntentId":"g","occurredAt":"2099-01-01"}',
    ],
    [
      'a blank gatewayIntentId',
      '{"eventId":"e","eventType":"captured","gatewayIntentId":" ","occurredAt":"2099-01-01"}',
    ],
    [
      'a fractional amount',
      '{"eventId":"e","eventType":"captured","gatewayIntentId":"g","occurredAt":"2099-01-01","amountFils":1.5}',
    ],
    [
      'an occurredAt nothing can order by',
      '{"eventId":"e","eventType":"captured","gatewayIntentId":"g","occurredAt":"soon"}',
    ],
  ])('refuses %s, naming the field and not the body', (_name, body) => {
    const verified = verify({ body })
    if (verified.kind !== 'verified') throw new Error('the fixture did not verify')
    let thrown: unknown
    try {
      parseWebhookDelivery(verified)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WebhookDeliveryMalformed)
    // The message carries no part of the body, even though it verified: a log line is read by more people
    // than the database is, and under SAQ-A this body is the one place a misconfigured gateway could put
    // card data (ADR 0067).
    expect((thrown as Error).message).not.toContain(body)
  })
})
